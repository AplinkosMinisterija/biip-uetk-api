# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

BĮIP UETK API — a Moleculer microservices backend for managing Lithuanian water body data (Aplinkos Ministerija). Node 18, TypeScript, Postgres + PostGIS, Redis, MinIO. Most domain enums and user-facing strings are in Lithuanian.

## Common commands

- `yarn dc:up` — start Postgres (PostGIS), Redis, and MinIO via docker-compose. Run before `yarn dev`.
- `yarn dc:down` / `yarn dc:logs` — stop / tail container logs.
- `yarn dev` — runs `moleculer-runner` with `--hot --repl --env`, loading `services/**/*.service.ts` via `ts-node`. Migrations run automatically on broker start (see `moleculer.config.ts` `started()`), then `seed.run` is called.
- `yarn build` — `tsc` to `dist/`.
- `yarn start` — production runner against `dist/`.
- `yarn lint` — ESLint over `.js,.ts`.
- `yarn test` — Jest (`*.spec.(ts|js)`). Single test: `yarn jest path/to/file.spec.ts -t "name pattern"`.
- API base URL in dev: `http://localhost:3000/uetk`. Health: `GET /uetk/ping`. Prometheus metrics on `:3030/metrics`.

## Architecture

### Moleculer service layout (`services/*.service.ts`)

Each file is one service, auto-loaded by the runner. Services use `moleculer-decorators` (`@Service`, `@Action`, `@Method`, `@Event`) and inter-service communication is via `ctx.call('serviceName.action', params)` — there are no direct imports between service business logic.

The HTTP layer is `api.service.ts` (moleculer-web). It uses **`autoAliases: true`**, so REST endpoints are declared on each service action via `rest: 'GET /...'` rather than centrally. There are two routes: `/uetk/auth/*` (unauthenticated whitelist) and `/uetk/*` (authenticated). Auth flows through `authenticate` → calls `auth.users.resolveToken` → `users.resolveByAuthUser`, populating `ctx.meta.user`, `ctx.meta.profile` (tenant), `ctx.meta.app`, `ctx.meta.authToken`. Mark public actions with `auth: AuthType.PUBLIC`.

Domain services:
- `objects.service.ts` — read-only view over the `publishing.uetkMerged` GIS table (uses `gisConfig`, separate `GIS_DB_CONNECTION`). `UETKObjectType` enum lists the 12 water-body categories with Lithuanian translations.
- `requests.service.ts` — user requests for UETK data extracts; statuses CREATED/SUBMITTED/REJECTED/RETURNED/APPROVED. Approved requests trigger PDF/file generation jobs.
- `forms.service.ts` — proposed object additions/edits/removals (NEW/EDIT/REMOVE) with the same status state machine.
- `*.histories.service.ts` — append-only audit logs for the corresponding entity, written via entity-changed hooks.
- `jobs.service.ts` + `jobs.requests.service.ts` — background work using BullMQ (`mixins/bullmq.mixin.ts`) backed by Redis. Mark an action `queue: true` to run it as a queued job; the mixin auto-creates a `Worker`, `Queue`, and `QueueEvents` named after the service.
- `tools.service.ts` — proxies to external `TOOLS_HOST` for screenshot/PDF rendering.
- `minio.service.ts` — file storage via `moleculer-minio`, bucket from `MINIO_BUCKET`.
- `search.service.ts` — public GIS search hitting external sources.
- `auth.service.ts`, `users.service.ts`, `tenants.service.ts`, `tenantUsers.service.ts` — wrap `biip-auth-nodejs` and `@aplinkosministerija/moleculer-accounts`. Auth/tenants live in a separate external `AUTH_HOST` service.
- `seed.service.ts` — runs once on boot after migrations.

### Database mixin pattern

`mixins/database.mixin.ts` wraps `@moleculer/database` (Knex adapter) with `DeepQueryMixin`, `moleculer-knex-filters`, and a `filterFn` hook so a service field can declare `filterFn: ({ value, query }) => ...` for custom query rewriting. Soft delete is the default — every entity gets `COMMON_FIELDS` (createdBy/At, updatedBy/At, deletedBy/At) and `COMMON_SCOPES` (`notDeleted` is on by default; `deleted` opts in). The API layer rewrites `?scope=deleted` → the deleted scopes list and **strips any other scope from inbound queries** for security.

`TENANT_FIELD` auto-fills `tenantId` from `ctx.meta.profile?.id` on create — apply it to any tenant-owned entity.

`USER_PUBLIC_GET` / `USER_PUBLIC_POPULATE` redact non-admin user identities for non-authorized viewers (returns "UETK Administratorius" placeholder). Reuse these for any field referencing a user.

### Database

Two Postgres connections (often the same host in dev): `DB_CONNECTION` for app tables (migrations in `database/migrations/*.js`, knex with `knexSnakeCaseMappers`), and `GIS_DB_CONNECTION` for the read-only PostGIS `publishing.*` schema consumed by `objects.service.ts`. Use snake_case in DB, camelCase in code — Objection's `knexSnakeCaseMappers` handles the conversion. SRID is **3346** (LKS-94 Lithuania) everywhere `PostgisMixin` is used.

### Endpoint authorization

Actions can declare `types: [EndpointType.ADMIN, ...]` (and routes can too). `api.service.authorize` calls `auth.validateType` to check the user has at least one matching type. `EndpointType` values: `ADMIN`, `USER`, `TENANT_ADMIN`, `TENANT_USER`, `SELF`.

### Templates & emails

`templates/*.ejs` are EJS templates for generated PDFs/HTML (request output). `utils/mails.ts` uses Postmark — gated by `emailCanBeSent` (won't send in non-production unless explicitly allowed).

## Conventions

- TypeScript with decorators (`experimentalDecorators`, `emitDecoratorMetadata`). Target ES6, CommonJS modules.
- Always use `throwBadRequestError`/`throwUnauthorizedError`/`throwNotFoundError`/`throwValidationError` from `types/index.ts` instead of constructing Moleculer errors directly.
- For new entities: create a Knex migration in `database/migrations/`, a `*.service.ts` using `DbConnection({ collection: 'table_name' })`, and (if user-visible state changes) a paired `*.histories.service.ts`.
- The repo is deployed via GitHub Actions: pushing to `main` deploys to staging; creating a GitHub release deploys to production; the `Deploy to Development` workflow is manual.
