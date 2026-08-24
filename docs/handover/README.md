# UETK handover

Working notes for separating UETK from the shared BĮIP platform and transferring
it to another institution. Written down here rather than living in chat, because
most of what follows is not derivable from this repository alone.

| File | What it is |
| --- | --- |
| [`uetk-gis-structure.md`](./uetk-gis-structure.md) | `uetk_gis` structure reconstructed from the QGIS project files — a stopgap until a real schema dump exists |
| [`diagnostics-report.sql`](./diagnostics-report.sql) | **Start here.** Same checks as below, but returned as one text column so the output can be copied in a single selection |
| [`diagnostics.sql`](./diagnostics.sql) | The same checks as separate queries — easier to read and to run one at a time, but produces ~25 result tabs |

Both are read-only, take no locks, and are safe to run on production. Run them
against **both** `uetk` and `uetk_gis`; the `pg_cron` section only applies to
`uetk_gis` and is deliberately last so it cannot cut the rest short.

## Why this exists

UETK is not a self-contained system. Three repositories transfer cleanly, but
roughly half the functionality lives inside shared BĮIP components, and the most
important data has no schema definition under version control.

## What transfers as-is

- `biip-uetk-api` — this repository
- `biip-uetk-web` — internal application at `uetk.biip.lt/app`
- `biip-uetk-public` — public WordPress site

None of the three build without extra work at the receiving end: they depend on
`AplinkosMinisterija/reusable-workflows`, on `ghcr.io/aplinkosministerija/*`
images, and on the private `@aplinkosministerija/*` npm packages.

## What has to be carved out of shared components

| Component | UETK footprint |
| --- | --- |
| `biip-admin-web` | `src/modules/uetk/` — 34 files, ~6 200 lines, plus entries in `src/utils/router.ts` and `src/utils/texts.ts` |
| `biip-maps-web` | `src/routes/uetk.vue`, `src/routes/szns/uetk.vue`, five layer definitions in `src/utils/layers/theme.ts`, `uetkMergedCentroidServiceVT`, two feature accordions |
| `biip-qgis-server` | seven `uetk_*.qgs` projects |
| `biip-tools` | screenshot, pdf, gdb and reproject services — the extract pipeline does not work without them |
| `biip-auth-api` | UETK app registration, groups, e-vartai (VIISP) login |
| `biip-infra` | four compose services, Caddy routes on five hostnames, three periodic jobs, `uetk_gis` creation and `pg_hba` entries |

## Reverse dependencies — what breaks in BĮIP

These must be resolved **before** cutover, not after:

- **`biip-zvejyba-api`** — `fishings.uetkCadastralId` references UETK cadastre
  codes; water body selection calls `UETK_URL/objects` and `uetk_public` WMS.
- **`biip-zuvinimas-api`** — `/uetk/objects`, `/uetk/search`, and the
  `uetk_zuvinimas` WFS layers; mandatory locations are seeded from UETK.
- **ALIS** — `uetkService` layer filtered by `kadastro_id`; `publishing.uetk_alis`.
- **`biip-maps-web`** — the shared `municipalities` layer used across BĮIP is
  served by `uetk_zuvinimas.qgs`. It needs to move to `boundaries` first.

The public API actions `GET /objects`, `GET /search` and
`GET /public/statistics` have to stay reachable after the transfer, under a
written service-level agreement.

## Data migration in one paragraph

`pg_dump` does not lose data — it takes a consistent snapshot. Data is lost in
the gap between the dump and the cutover, when people keep writing to the old
database. The recommended approach is logical replication (the cluster runs
Postgres 17) with a short read-only window at the end. Note that `import.*` is
fully derived from the Registrų centras, GRPK and forest cadastre sync jobs and
should be re-created rather than migrated, and that `wal_level = logical`
requires a restart of the whole shared cluster.

The single largest risk is not the dump. It is a QGIS Desktop editor with an
open project saving into the old database *after* cutover — silently, and
unnoticed for weeks. Blocking those connections in `pg_hba.conf` and terminating
open sessions is a mandatory cutover step, not a nicety.

## Known issues found while writing this up

- **`uetk_gis` has no DDL in version control.** No migrations, no function
  bodies, no `pg_cron` definitions. Fixing this is a prerequisite for the
  handover and is worth doing regardless of it.
- **No WAL archiving or point-in-time recovery.** The only backup is a nightly
  `pg_dumpall`, so the recovery point objective is 24 hours for a register that
  six people edit daily.
- **Environment variable mismatch.** This service reads
  `process.env.AUTH_FREELANCERS_GROUP_ID` (`types/constants.ts`), while
  `biip-infra` sets `FREELANCER_GROUP_ID` for the `uetk-api` container in all
  three environments. If that is confirmed in production, `defaultGroupId` is
  never passed on e-vartai login and the freelancer group is not filtered out of
  tenant creation. Needs a live check before it is either fixed or dismissed.
- **`uetk_zuvinimas.qgs` is shared.** It serves žuvinimas, žvejyba and ALIS, and
  owns the cross-system `municipalities` layer.
- **The sync jobs have no schedule.** All three are `workflow_dispatch` only, so
  the imported layers do not refresh on their own.

## Open questions

Answered by running [`diagnostics.sql`](./diagnostics.sql):

1. Are `publishing.*` and `szns_publishing.*` tables, views or materialized views?
2. Which `pg_cron` jobs run in `uetk_gis`?
3. Do all tables have a real primary key?
4. How large are the two databases, and how long will a dump and restore take?
5. Which roles are actually writing, and from where?

Needing a decision or a conversation instead:

6. Is the whole of UETK transferring, or only the protection-zone (SŽNS) part?
7. Does the administration UI become a standalone application, or move into
   `biip-uetk-web`?
8. Is `szns_publishing` hand-edited, or derived from something upstream?
9. Does the production `pg_service` entry `uetk` point at `uetk_gis` or at `uetk`?

## Next steps

1. Run `diagnostics.sql` against both databases and commit the output.
2. Commit real `pg_dump --schema-only` output for both databases.
3. Enable WAL archiving and point-in-time recovery.
4. Decide on scope and on the administration UI.
5. Start the VIISP registration for the receiving institution — it is the
   longest lead time in the project and nothing technical can shorten it.
