# Migrating the UETK databases

How the data actually moves. Reconciles the assessment from the GIS specialist
who built the system with what the production diagnostics and a set of local
experiments show.

## The specialist's assessment

Paraphrased from 2026-08-25:

> The main parts of UETK and SŽNS are:
>
> - **PostgreSQL database.** It holds all the data and the logic for maintaining
>   it, processing it and the cron jobs. Should move without difficulty — a dump
>   of this database and a restore on the other infrastructure ought to be enough.
> - **QGIS Server** — just bring the Docker container up on the other
>   infrastructure, delete the surplus services, keep only uetk and szns.
> - **Web map** — an open-source project; if UETK gets its own infrastructure,
>   all that is needed there is to run the build against a different nginx.
> - **Web part (extracts, website)** — cannot comment.

This is right about the shape of the work, and it is a simpler framing than
"carve UETK out of the shared components". Three of the four parts really are
lift-and-shift. The corrections below are about specifics, not about the
approach.

## Full dump and restore is the right primary strategy

A single `pg_dump -Fc` carries, in one operation: tables and their data, all 42
PL/pgSQL functions, all 42 triggers, indexes, the 31 foreign keys, sequence
values, and materialized view definitions together with a refresh.

The alternative — logical replication — needs `wal_level = logical`, which only
takes effect after restarting Postgres, and that is the **whole shared BĮIP
cluster**, not just UETK. It also does not replicate sequences or materialized
views, so both have to be handled by hand.

`uetk_gis` is edited by a handful of specialists during working hours, not by
hundreds of users around the clock. A weekend window is realistic, so the
simpler path wins. Keep logical replication in reserve for the case where the
measured window turns out to be unacceptable.

### Measure before committing to a window

Run a trial `pg_dump -Fc` and `pg_restore -j 4` into a scratch environment and
time three things separately:

1. the dump,
2. the data load,
3. **the materialized view refreshes** — `szns_publishing.uetk_szns_map` is
   630 MB and gets refreshed at the end of the restore. This can take longer
   than everything else combined.

Without that third number the window cannot be planned.

If it comes out too long, `--exclude-schema=import` drops 4.7 GB of
re-syncable data and shortens the restore by roughly two thirds — at the cost of
re-running the sync jobs and then `szns_update_stats_for_parcels()` over 2.5
million parcels afterwards.

## Triggers during the load: what actually happens

An earlier draft of the handover notes claimed `pg_restore` would fire the
triggers and corrupt the data. That was too broad. Tested against a table with a
trigger that both derives a column and writes an audit row — the same shape as
`uetk_calc_*_attr()` plus `uetk_auditing_edits()`:

| Method | Result |
| --- | --- |
| One full `pg_dump -Fc` → `pg_restore` | **Safe.** Triggers live in the post-data section and are created after `COPY`. Derived values and audit rows come across unchanged |
| `--schema-only`, then `--data-only` | **Breaks.** The trigger fires during `COPY`, the audit sequence has not been advanced yet, the insert collides on the primary key, and the `COPY` aborts — leaving the table empty |
| `pg_restore --data-only --disable-triggers` | **Safe.** Fixes the split case |

So the specialist's single-dump route has no trigger problem. The failure mode
only appears if schema and data are moved separately, which is easy to do by
accident — and when it happens it fails loudly rather than silently, which is
the better outcome.

## What a database dump does not carry

These are the gaps in "a dump of this database and a restore ought to be
enough". Each needs its own step.

| Not carried | What to do |
| --- | --- |
| **Login roles and passwords** | `pg_dumpall --roles-only`. Worth using the opportunity to create per-user roles instead of the single shared `postgres` account (see below) |
| **pg_cron job rows** | `cron.job` is owned by the extension, so `pg_dump` skips its contents. The table is currently empty, but confirm before relying on the dump: `SELECT extname, extconfig FROM pg_extension WHERE extname = 'pg_cron';` — a NULL `extconfig` means the rows are not dumped |
| **Server configuration** | `shared_preload_libraries`, `cron.database_name`, `max_connections`, `pg_hba.conf` — by hand |
| **The second database** | The `uetk` application database is separate and needs its own dump |
| **Object storage and the WordPress database** | `mc mirror` for the two MinIO buckets, `mysqldump` for `uetkHive` |
| **The QGIS Desktop project, as a file** | It travels inside the dump as a row in `uetk.qgis_projects`, but it still has to be exported to a `.qgz` and committed, because right now the database is its only copy |

## Access, and why not to copy it as-is

In **development**, `uetk_gis` has five login roles, QGIS Server and the API both
authenticate as `postgres`, and none of the per-user `uetk_*` roles listed in
`biip-infra/postgres/.../20_cron.sh` exist. Production has not been checked yet,
and roles are exactly the kind of thing that differs between environments — so
confirm before acting on this section.

If production looks the same, two consequences for the migration:

- **Cutover cannot block individual editors through `pg_hba.conf`,** because
  they are indistinguishable. The only lever is putting the whole database into
  `default_transaction_read_only` and terminating the sessions — plus telling
  the specialists directly, since there is no technical guard.
- **There is no database-level audit** of who changed what. The only trail is
  `archive.edit_history_*`, written by `uetk_auditing_edits()`.

The receiving institution should fix this rather than reproduce it. Per-user
roles with appropriate rights are a natural part of standing the system up.

## Load order

31 foreign keys impose an order. A single `pg_restore` works this out on its
own; the order matters if any part of the load is done by hand.

1. `administration.*` — the classifiers everything else references
2. `sources.apskritys` → `sources.savivaldybes`
3. `uetk.upiu_pabaseiniai`, `uetk.vandens_surinkimo_plotai`
4. `uetk.upes_l` and `uetk.ezerai_tvenkiniai` — they reference each other, and
   `upes_l.vyr_upes_id` references `upes_l` itself, so constraints have to be
   deferred
5. Dependent objects — hydro plants, dams, culverts, fish passes, measurement
   and sampling sites. These reference `kadastro_id`, not the surrogate key
6. `szns.uetk_szns` — references the two SŽNS status classifiers
7. `archive.*` and `import.*` — no outbound references

## The other three parts

**QGIS Server** — as the specialist says, bring the container up elsewhere and
keep only the UETK and SŽNS projects. One caveat: `uetk_zuvinimas.qgs` is not a
UETK-only project. It serves žuvinimas, žvejyba and ALIS, and it is where the
cross-system `municipalities` layer comes from. Whichever side keeps it, the
other side needs a replacement or an agreement, because its data source is the
`uetk_gis` database that is leaving.

**Web map** — `biip-maps-web` is open source, so building a copy against the
receiving institution's nginx is genuinely all that is needed. Note that a plain
build ships every route, including ones pointing at BĮIP proxies the receiving
side will not have; trimming is cosmetic rather than necessary. Our own
`maps.biip.lt` keeps its copy, which is why the UETK WMS endpoints have to stay
reachable either way.

**Web part** — `biip-uetk-api`, `biip-uetk-web` and `biip-uetk-public` transfer
as repositories. Their dependencies are covered in [`README.md`](./README.md):
`biip-tools` for the extract pipeline, `biip-auth-api` and VIISP for login,
Postmark for mail, and the private `@aplinkosministerija/*` packages.

## Still unanswered

**What launches the SŽNS generation pipeline?** The eleven `szns_*` functions
are called by no trigger, by no code in `biip-uetk-api`, and by none of the QGIS
server projects. `cron.job` is empty. The specialist's phrase "the logic for
maintaining it, processing it and the cron jobs" suggests he knows — this is one
question to him, and it unblocks the largest remaining gap in the handover.

Worth asking at the same time:

- Is `uetk_duomenu_administravimo_zemelapis` in `uetk.qgis_projects` the live
  editing project, and does anything in it call the `szns_*` functions?
- How are the seven materialized views refreshed today, given that nothing in
  the database schedules it?
- Is `szns.uetk_szns_old` (772 MB) a required record of previously published
  state, or a backup from the refactor?
