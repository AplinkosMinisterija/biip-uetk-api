-- ============================================================================
-- UETK diagnostics — PRODUCTION ONLY — READ ONLY
-- ============================================================================
-- The earlier diagnostics were run against development. Schema facts carry over
-- between environments; these do not. This script covers only what has to be
-- read on the live system:
--
--   scheduled jobs, login roles, connected clients, write-activity counters,
--   server settings, and the stored QGIS project.
--
-- Nothing here writes, locks or blocks.
--
-- Run against production uetk_gis. Statements 2-6 are small and independent —
-- if one errors, the rest still run.
-- ============================================================================


-- ── STATEMENT 1 — environment-specific report ───────────────────────────────
WITH lines AS (

  SELECT 100 AS ord, 0 AS sub, '=== WHICH ENVIRONMENT IS THIS ===' AS line
  UNION ALL SELECT 100, 1, 'database        : ' || current_database()
                           || '  (' || pg_size_pretty(pg_database_size(current_database())) || ')'
  UNION ALL SELECT 100, 2, 'server          : ' || version()
  UNION ALL SELECT 100, 3, 'inet_server_addr: ' || coalesce(inet_server_addr()::text, 'local socket')
  UNION ALL SELECT 100, 4, 'captured        : ' || now()::text
  UNION ALL SELECT 100, 5, ''

  UNION ALL SELECT 200, 0, '=== SERVER SETTINGS (not carried by pg_dump) ==='
  UNION ALL SELECT 201, row_number() OVER (ORDER BY name)::int,
                   rpad(name, 28) || ' = ' || setting
            FROM pg_settings
            WHERE name IN ('wal_level','shared_preload_libraries','cron.database_name',
                           'max_connections','max_wal_senders','max_replication_slots',
                           'archive_mode','archive_command')
  UNION ALL SELECT 202, 0, ''

  UNION ALL SELECT 300, 0, '=== PG_CRON: are the job rows dumpable? ==='
  UNION ALL SELECT 301, 1, 'pg_cron extconfig = '
                           || coalesce((SELECT extconfig::text FROM pg_extension
                                        WHERE extname='pg_cron'), 'NULL -> pg_dump SKIPS cron.job rows')
  UNION ALL SELECT 302, 0, ''

  UNION ALL SELECT 400, 0, '=== LOGIN ROLES ==='
  UNION ALL SELECT 401, row_number() OVER (ORDER BY r.rolname)::int,
                   rpad(r.rolname, 38)
                   || rpad(CASE WHEN r.rolsuper THEN 'SUPERUSER' ELSE '' END, 12)
                   || coalesce('expires=' || r.rolvaliduntil::text, '')
            FROM pg_roles r
            WHERE r.rolcanlogin AND r.rolname NOT LIKE 'pg\_%'
  UNION ALL SELECT 402, 0, ''

  UNION ALL SELECT 500, 0, '=== CURRENT CONNECTIONS (who edits, and from where) ==='
  UNION ALL SELECT 501, row_number() OVER (ORDER BY count(*) DESC)::int,
                   rpad(usename, 32)
                   || rpad(coalesce(application_name,'-'), 30)
                   || rpad(coalesce(host(client_addr),'local'), 18)
                   || rpad(state, 10) || count(*)::text || ' conn'
            FROM pg_stat_activity
            WHERE datname = current_database()
            GROUP BY usename, application_name, client_addr, state
  UNION ALL SELECT 502, 0, ''

  UNION ALL SELECT 600, 0, '=== WRITE ACTIVITY — top 25 (real editing patterns) ==='
  UNION ALL SELECT 600, 1, rpad('relation', 46) || rpad('ins', 14) || rpad('upd', 14) || 'del'
  UNION ALL SELECT 601, row_number() OVER (ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC)::int,
                   rpad(schemaname || '.' || relname, 46)
                   || rpad(n_tup_ins::text, 14) || rpad(n_tup_upd::text, 14) || n_tup_del::text
            FROM (SELECT * FROM pg_stat_user_tables
                  ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC LIMIT 25) t
  UNION ALL SELECT 602, 0, ''

  UNION ALL SELECT 700, 0, '=== STATS RESET — how far back the counters above reach ==='
  UNION ALL SELECT 701, 1, 'stats_reset : ' || coalesce(stats_reset::text, 'never')
            FROM pg_stat_database WHERE datname = current_database()
  UNION ALL SELECT 702, 0, ''
  UNION ALL SELECT 703, 0, '=== END ==='
)
SELECT line AS uetk_prod
FROM lines
ORDER BY ord, sub;


-- ── STATEMENT 2 — pg_cron jobs ──────────────────────────────────────────────
SELECT jobid, schedule, jobname, database, username, active, command
FROM cron.job
ORDER BY jobid;


-- ── STATEMENT 3 — recent pg_cron runs ───────────────────────────────────────
SELECT jobid, status, start_time, end_time,
       left(coalesce(return_message,''), 100) AS message
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 25;


-- ── STATEMENT 4 — the stored QGIS project ───────────────────────────────────
SELECT name, metadata::text AS metadata
FROM uetk.qgis_projects;


-- ── STATEMENTS 5-8 — bookkeeping tables that should record pipeline runs ────
SELECT * FROM administration.scheduled_tasks_info;

SELECT * FROM administration.grpk_source_update;

SELECT * FROM administration.uetk_update_by_grpk;

SELECT * FROM szns_administration.szns_parcels_stat_update_info;
