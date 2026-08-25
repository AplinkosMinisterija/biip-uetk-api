# UETK handover

Working notes for separating UETK from the shared BĮIP platform and transferring
it to another institution. Written down here rather than living in chat, because
most of what follows is not derivable from this repository alone.

| File | What it is |
| --- | --- |
| [`migration.md`](./migration.md) | How the data moves — strategy, load order, and what a dump does not carry. Reconciled with the assessment from the specialist who built the system |
| [`uetk-gis-structure.md`](./uetk-gis-structure.md) | `uetk_gis` structure reconstructed from the QGIS project files — a stopgap until a real schema dump exists |
| [`diagnostics-report.sql`](./diagnostics-report.sql) | **Start here.** Same checks as below, but returned as one text column so the output can be copied in a single selection |
| [`diagnostics-prod.sql`](./diagnostics-prod.sql) | The environment-specific subset — scheduled jobs, roles, connections, write counters, server settings. Only meaningful on **production** |
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

A single full `pg_dump -Fc` and restore, with a weekend read-only window. That
carries the data, the 42 functions, the 42 triggers, the sequences and the
materialized view definitions in one operation, and avoids needing
`wal_level = logical` — which would mean restarting the whole shared BĮIP
cluster. Logical replication stays in reserve for the case where the measured
window proves too long. Details, load order and the gaps a dump leaves are in
[`migration.md`](./migration.md).

The largest risk is not the dump. It is a QGIS Desktop editor with an open
project saving into the old database *after* cutover — silently, and unnoticed
for weeks. And it cannot be prevented with `pg_hba.conf`, because every client
connects as `postgres`: the only levers are putting the database into
`default_transaction_read_only`, terminating the sessions, and telling the
specialists directly.

## Known issues found while writing this up

- **`uetk_gis` has no DDL in version control.** No migrations, no function
  bodies, no `pg_cron` definitions. Fixing this is a prerequisite for the
  handover and is worth doing regardless of it. The production run on
  2026-08-24 showed the scale of what is unrecorded: **42 PL/pgSQL functions
  wired up by 42 triggers**, holding the cadastre identifier generation,
  attribute derivation, parent-object resolution and the entire SŽNS zone and
  shoreline-strip generation pipeline. `biip-uetk-api` is a thin read layer over
  logic that lives in Postgres.
- **In development, everyone connects as `postgres`.** That environment has five
  login roles — `postgres`, `postgres_exporter`, `spinta`, `medziokle_ro` and one
  named developer account — and none of the per-user `uetk_*` roles listed in
  `biip-infra/postgres/.../20_cron.sh`. **Not yet checked on production**, where
  those roles may well exist. It matters for the cutover plan: if production also
  has every client authenticating as the superuser, individual QGIS Desktop
  editors cannot be blocked through `pg_hba.conf` and there is no database-level
  audit of who changed what, only the application-level `archive.edit_history_*`
  tables.
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

Answered by the 2026-08-24 run against **development** — see
[`uetk-gis-structure.md`](./uetk-gis-structure.md). These are schema facts,
deployed identically across environments, so they hold:

1. ~~Are `publishing.*` and `szns_publishing.*` tables or views?~~ All
   materialized views. Nothing to migrate, only definitions and a refresh schedule.
2. ~~Do all tables have a real primary key?~~ Yes, apart from two irrelevant
   `public` tables. Logical replication is viable.
3. ~~How large is `uetk_gis`?~~ 7 427 MB, of which roughly 1.2 GB is
   irreplaceable; the rest re-syncs or refreshes.
4. ~~Is `szns_publishing` hand-edited or derived?~~ Derived. The edited table is
   `szns.uetk_szns`.

Environment-specific and **not** answered, because the run was against
development — scheduled jobs, login roles, connected clients, write-activity
counters and server settings all differ per environment. A production run of
[`diagnostics-report.sql`](./diagnostics-report.sql) is still needed.

Still open, and now more urgent:

5. **What runs the SŽNS pipeline and the materialized-view refreshes?**
   `cron.job` is empty, no trigger calls the generation functions, and neither
   `biip-uetk-api` nor the QGIS server projects reference any of them. The most
   likely answer is a QGIS Desktop project. `uetk.qgis_projects` holds exactly
   one, `uetk_duomenu_administravimo_zemelapis` ("UETK data administration
   map"), last modified 2023-10-11 — in no repository, and not backed up
   anywhere outside the database. **This is now the single biggest gap in the
   handover:** without it, the receiving institution cannot produce or publish
   protection zones at all. Export it and check whether it references
   `tvirtinimo_statusas`; if not, the live editing project is a file on someone's
   laptop.
6. **What do the 42 functions actually do?** Their bodies need to be dumped and
   committed before anything is handed over.
7. **Can `szns.uetk_szns_old` (772 MB) be dropped?** It looks superseded, and
   dropping it removes 40% of the real migration payload.
8. **Which QGIS project is stored in `uetk.qgis_projects`, and is it live?**
9. **Does `import.rc_sklypai` need a full `szns_update_stats_for_parcels()` run
   after a re-sync,** and how long does that take over 2.5 million parcels?

Needing a decision or a conversation instead:

10. Is the whole of UETK transferring, or only the protection-zone (SŽNS) part?
11. Does the administration UI become a standalone application, or move into
    `biip-uetk-web`?

## Next steps

1. Run `diagnostics.sql` against both databases and commit the output.
2. Commit real `pg_dump --schema-only` output for both databases.
3. Enable WAL archiving and point-in-time recovery.
4. Decide on scope and on the administration UI.
5. Start the VIISP registration for the receiving institution — it is the
   longest lead time in the project and nothing technical can shorten it.
