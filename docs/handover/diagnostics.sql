-- ============================================================================
-- UETK handover diagnostics — READ ONLY
-- ============================================================================
-- Fills the gaps in ./uetk-gis-structure.md that cannot be reconstructed from
-- the QGIS project files, and answers the open questions in the handover plan.
--
-- Nothing here writes, locks or blocks. Safe to run on production.
--
-- Plain SQL only — no psql backslash commands — so it runs unchanged in
-- DBeaver, pgAdmin, DataGrip, psql or anything else. Section headers are
-- SELECT statements, so in a GUI client each one opens its own result tab.
--
-- Run against BOTH databases and keep the output:
--
--   GUI client : open the file, "Execute script" (DBeaver: Alt+X), export all
--                result tabs. Turn on "ignore errors" if the client offers it.
--   psql       : psql -P pager=off -d "$CONN" -f diagnostics.sql > out.txt
--
-- Section 13 (pg_cron) only exists in uetk_gis. On the uetk application
-- database it raises "relation cron.job does not exist" — that is expected,
-- it is the last section on purpose, and everything above it has already run.
-- ============================================================================


SELECT '=== 1. Server, database, extensions ===' AS section;

SELECT version() AS server_version;

SELECT current_database() AS database,
       pg_size_pretty(pg_database_size(current_database())) AS size;

SELECT extname AS extension, extversion AS version
FROM pg_extension
ORDER BY extname;


SELECT '=== 2. Replication readiness ===' AS section;

-- wal_level must be `logical` before logical replication can be set up.
-- Changing it requires a Postgres RESTART, which affects the whole BIIP cluster.
SELECT name, setting
FROM pg_settings
WHERE name IN ('wal_level','max_wal_senders','max_replication_slots',
               'max_worker_processes','shared_preload_libraries')
ORDER BY name;

SELECT slot_name, plugin, slot_type, database, active
FROM pg_replication_slots;


SELECT '=== 3. Schemas and their total size ===' AS section;

SELECT n.nspname AS schema,
       count(*) FILTER (WHERE c.relkind = 'r') AS tables,
       count(*) FILTER (WHERE c.relkind = 'v') AS views,
       count(*) FILTER (WHERE c.relkind = 'm') AS matviews,
       pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND c.relkind IN ('r','v','m','p')
GROUP BY n.nspname
ORDER BY sum(pg_total_relation_size(c.oid)) DESC NULLS LAST;


SELECT '=== 4. Relation kind: table vs view vs materialized view ===' AS section;

-- Decides what actually has to be migrated. Plain views cost nothing to
-- recreate; materialized views need a refresh strategy; tables need replication.
SELECT n.nspname AS schema,
       c.relname AS relation,
       CASE c.relkind WHEN 'r' THEN 'table'
                      WHEN 'p' THEN 'partitioned table'
                      WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'materialized view'
                      WHEN 'f' THEN 'foreign table' END AS kind,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       CASE WHEN c.relkind IN ('r','p','m')
            THEN to_char(c.reltuples, 'FM999999999') END AS est_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND c.relkind IN ('r','p','v','m','f')
ORDER BY n.nspname, c.relname;


SELECT '=== 5. Tables WITHOUT a primary key ===' AS section;

-- Logical replication silently drops UPDATE and DELETE on these unless
-- REPLICA IDENTITY FULL is set. Anything listed here is a migration blocker.
SELECT n.nspname AS schema,
       c.relname AS relation,
       CASE c.relreplident WHEN 'd' THEN 'default'
                           WHEN 'f' THEN 'full'
                           WHEN 'i' THEN 'index'
                           WHEN 'n' THEN 'nothing' END AS replica_identity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','cron')
  AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = 'p')
ORDER BY n.nspname, c.relname;


SELECT '=== 6. Geometry columns and SRID ===' AS section;

-- Everything is expected to be EPSG:3346 (LKS-94). Anything else needs a look.
SELECT f_table_schema AS schema,
       f_table_name AS relation,
       f_geometry_column AS geom_column,
       srid, type, coord_dimension
FROM geometry_columns
ORDER BY 1, 2;


SELECT '=== 7. Sequences and their current values ===' AS section;

-- Logical replication does NOT replicate sequences. These values must be
-- carried over manually at cutover, or the first inserts fail on duplicate key.
SELECT schemaname AS schema, sequencename AS sequence, last_value
FROM pg_sequences
WHERE schemaname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2;


SELECT '=== 8. Stored functions ===' AS section;

-- Includes uetk_grpk_source_update(), called by the GRPK sync job.
SELECT n.nspname AS schema,
       p.proname AS function,
       pg_get_function_identity_arguments(p.oid) AS args,
       l.lanname AS language
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND l.lanname NOT IN ('c','internal')
  -- exclude everything installed by an extension (postgis, pg_cron, ...)
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY 1, 2;

-- Full source bodies, so they can be pasted straight into version control.
SELECT n.nspname AS schema,
       p.proname AS function,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND l.lanname NOT IN ('c','internal')
  AND p.prokind = 'f'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY 1, 2;


SELECT '=== 9. Triggers ===' AS section;

SELECT n.nspname AS schema,
       c.relname AS relation,
       t.tgname AS trigger,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2, 3;


SELECT '=== 10. Roles that can reach this database ===' AS section;

SELECT r.rolname AS role,
       r.rolcanlogin AS can_login,
       r.rolsuper AS superuser,
       r.rolvaliduntil AS valid_until,
       ARRAY(SELECT b.rolname FROM pg_auth_members m
             JOIN pg_roles b ON b.oid = m.roleid
             WHERE m.member = r.oid) AS member_of
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\_%'
ORDER BY r.rolcanlogin DESC, r.rolname;

SELECT datname AS database, datacl AS grants
FROM pg_database
WHERE datname = current_database();


SELECT '=== 11. Who is connected right now ===' AS section;

-- Identifies the QGIS Desktop editors that must be disconnected at cutover.
SELECT usename AS role, application_name, client_addr, state,
       count(*) AS connections,
       max(now() - state_change) AS idle_for
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2, 3, 4
ORDER BY connections DESC;


SELECT '=== 12. Write activity and relation sizes ===' AS section;

-- Distinguishes tables that are actually edited from ones that only get
-- truncate-and-reload treatment by the sync jobs.
SELECT schemaname AS schema, relname AS relation,
       n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes,
       last_autovacuum, last_analyze
FROM pg_stat_user_tables
WHERE n_tup_ins + n_tup_upd + n_tup_del > 0
ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC
LIMIT 40;

-- Feeds the dump/restore time estimate.
SELECT schemaname AS schema, relname AS relation,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       pg_size_pretty(pg_indexes_size(relid)) AS indexes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;


-- ============================================================================
-- Section 13 — uetk_gis ONLY.
-- On the uetk application database these two queries raise
-- "relation cron.job does not exist". That is expected: pg_cron is configured
-- with cron.database_name = 'uetk_gis'. Everything above has already run.
-- ============================================================================

SELECT '=== 13. pg_cron jobs (uetk_gis only) ===' AS section;

-- These exist nowhere in version control. Capture them before anything else.
SELECT jobid, schedule, jobname, nodename, database, username, active, command
FROM cron.job
ORDER BY jobid;

SELECT jobid, status, start_time, end_time,
       left(coalesce(return_message,''), 120) AS message
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;


-- ============================================================================
-- DONE
--
-- Next, capture the real schema. The client must be version 17 or newer —
-- pg_dump 16 refuses to dump a Postgres 17 server:
--
--   pg_dump --schema-only --no-owner --no-privileges \
--           -d "$UETK_GIS_CONNECTION" > uetk_gis-schema.sql
--   pg_dump --schema-only --no-owner --no-privileges \
--           -d "$UETK_CONNECTION"     > uetk-schema.sql
--
-- Commit both next to this file, then replace uetk-gis-structure.md with a
-- pointer to the real dump.
-- ============================================================================
