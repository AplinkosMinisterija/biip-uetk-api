-- ============================================================================
-- UETK handover diagnostics — READ ONLY
-- ============================================================================
-- Fills the gaps in ./uetk-gis-structure.md that cannot be reconstructed from
-- the QGIS project files, and answers the open questions in the handover plan.
--
-- Nothing here writes, locks or blocks. Safe to run on production.
--
-- Run once against EACH database and keep the output:
--
--   psql "$UETK_GIS_CONNECTION" -f diagnostics.sql > uetk_gis-diagnostics.txt
--   psql "$UETK_CONNECTION"     -f diagnostics.sql > uetk-diagnostics.txt
--
-- Sections 8 and 9 only return rows on uetk_gis (pg_cron lives there).
-- ============================================================================

\pset pager off
\pset border 2
\timing off

\echo ''
\echo '=== 1. Server, database, extensions ========================================'
SELECT version();
SELECT current_database() AS database,
       pg_size_pretty(pg_database_size(current_database())) AS size;
SELECT extname, extversion FROM pg_extension ORDER BY extname;

\echo ''
\echo '=== 2. Replication readiness ==============================================='
-- wal_level must be `logical` before logical replication can be set up.
-- Changing it requires a Postgres RESTART, which affects the whole BIIP cluster.
SELECT name, setting
FROM pg_settings
WHERE name IN ('wal_level','max_wal_senders','max_replication_slots',
               'max_worker_processes','shared_preload_libraries')
ORDER BY name;

SELECT slot_name, plugin, slot_type, database, active
FROM pg_replication_slots;

\echo ''
\echo '=== 3. Schemas and their total size ========================================'
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

\echo ''
\echo '=== 4. Relation kind: table vs view vs materialized view ==================='
-- Decides what actually has to be migrated. Plain views cost nothing to
-- recreate; materialized views need a refresh strategy; tables need replication.
SELECT n.nspname AS schema,
       c.relname AS name,
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

\echo ''
\echo '=== 5. Tables WITHOUT a primary key ========================================'
-- Logical replication silently drops UPDATE and DELETE on these unless
-- REPLICA IDENTITY FULL is set. Anything listed here is a migration blocker.
SELECT n.nspname AS schema,
       c.relname AS "table",
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

\echo ''
\echo '=== 6. Geometry columns and SRID ==========================================='
-- Everything is expected to be EPSG:3346 (LKS-94). Anything else needs a look.
SELECT f_table_schema AS schema, f_table_name AS "table",
       f_geometry_column AS "column", srid, type, coord_dimension
FROM geometry_columns
ORDER BY 1, 2;

\echo ''
\echo '=== 7. Sequences and their current values =================================='
-- Logical replication does NOT replicate sequences. These values must be
-- carried over manually at cutover, or the first inserts fail on duplicate key.
SELECT schemaname AS schema, sequencename AS sequence, last_value
FROM pg_sequences
WHERE schemaname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2;

\echo ''
\echo '=== 8. pg_cron jobs (uetk_gis only) ========================================'
-- These exist nowhere in version control. Capture them before anything else.
SELECT jobid, schedule, jobname, nodename, database, username, active,
       command
FROM cron.job
ORDER BY jobid;

\echo ''
\echo '--- last 20 pg_cron runs ---'
SELECT jobid, status, start_time, end_time,
       left(coalesce(return_message,''), 120) AS message
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;

\echo ''
\echo '=== 9. Stored functions ===================================================='
-- Includes uetk_grpk_source_update(), called by the GRPK sync job.
-- Source bodies are printed separately below so they can be pasted into git.
SELECT n.nspname AS schema, p.proname AS function,
       pg_get_function_identity_arguments(p.oid) AS args,
       l.lanname AS language
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND l.lanname NOT IN ('c','internal')
ORDER BY 1, 2;

\echo ''
\echo '=== 10. Triggers ==========================================================='
SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS trigger,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2, 3;

\echo ''
\echo '=== 11. Roles that can reach this database ================================='
SELECT r.rolname AS role, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
       r.rolvaliduntil AS valid_until,
       ARRAY(SELECT b.rolname FROM pg_auth_members m
             JOIN pg_roles b ON b.oid = m.roleid
             WHERE m.member = r.oid) AS member_of
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\_%'
ORDER BY r.rolcanlogin DESC, r.rolname;

\echo ''
\echo '--- explicit per-database GRANTs ---'
SELECT datname, datacl FROM pg_database WHERE datname = current_database();

\echo ''
\echo '=== 12. Who is connected right now ========================================='
-- Identifies the QGIS Desktop editors that must be disconnected at cutover.
SELECT usename AS role, application_name, client_addr, state,
       count(*) AS connections,
       max(now() - state_change) AS idle_for
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2, 3, 4
ORDER BY connections DESC;

\echo ''
\echo '=== 13. Write activity per table ==========================================='
-- Distinguishes tables that are actually edited from ones that only get
-- truncate-and-reload treatment by the sync jobs.
SELECT schemaname AS schema, relname AS "table",
       n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes,
       last_autovacuum, last_analyze
FROM pg_stat_user_tables
WHERE n_tup_ins + n_tup_upd + n_tup_del > 0
ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC
LIMIT 40;

\echo ''
\echo '=== 14. Largest relations ================================================='
-- Feeds the dump/restore time estimate.
SELECT schemaname AS schema, relname AS "table",
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       pg_size_pretty(pg_indexes_size(relid)) AS indexes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;

\echo ''
\echo '=== DONE =================================================================='
\echo ''
\echo 'Next, capture the real schema. The client must be version 17 or newer —'
\echo 'pg_dump 16 refuses to dump a Postgres 17 server:'
\echo ''
\echo '  pg_dump --schema-only --no-owner --no-privileges \'
\echo '          -d "$UETK_GIS_CONNECTION" > uetk_gis-schema.sql'
\echo '  pg_dump --schema-only --no-owner --no-privileges \'
\echo '          -d "$UETK_CONNECTION"     > uetk-schema.sql'
\echo ''
\echo 'Commit both next to this file, then replace uetk-gis-structure.md'
\echo 'with a pointer to the real dump.'
\echo ''
