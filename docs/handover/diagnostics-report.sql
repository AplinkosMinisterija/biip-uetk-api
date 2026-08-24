-- ============================================================================
-- UETK handover diagnostics — SINGLE REPORT — READ ONLY
-- ============================================================================
-- Same information as diagnostics.sql, but returned as ONE text column so the
-- whole thing can be selected and copied in one go instead of exporting 25
-- separate result tabs.
--
-- Nothing here writes, locks or blocks. Safe to run on production.
--
-- Three statements, so three result tabs:
--   1. the report          — run on BOTH uetk and uetk_gis
--   2. function bodies     — run on BOTH
--   3. pg_cron jobs        — uetk_gis only, errors on uetk (expected)
--
-- In DBeaver: Alt+X to run the script, then in each tab Ctrl+A, Ctrl+C.
-- ============================================================================


-- ── STATEMENT 1 — the report ────────────────────────────────────────────────
WITH lines AS (

  SELECT 100 AS ord, 0 AS sub, '=== 1. SERVER, DATABASE, EXTENSIONS ===' AS line
  UNION ALL SELECT 100, 1, 'server     : ' || version()
  UNION ALL SELECT 100, 2, 'database   : ' || current_database()
                           || '  (' || pg_size_pretty(pg_database_size(current_database())) || ')'
  UNION ALL SELECT 100, 3, 'captured   : ' || now()::text
  UNION ALL SELECT 100, 4, ''
  UNION ALL SELECT 101, row_number() OVER (ORDER BY extname)::int,
                   'extension  : ' || rpad(extname, 22) || ' ' || extversion
            FROM pg_extension
  UNION ALL SELECT 102, 0, ''

  UNION ALL SELECT 200, 0, '=== 2. REPLICATION READINESS ==='
  UNION ALL SELECT 201, row_number() OVER (ORDER BY name)::int,
                   rpad(name, 26) || ' = ' || setting
            FROM pg_settings
            WHERE name IN ('wal_level','max_wal_senders','max_replication_slots',
                           'max_worker_processes','shared_preload_libraries',
                           'server_version','data_directory')
  UNION ALL SELECT 203, row_number() OVER (ORDER BY slot_name)::int,
                   'slot       : ' || slot_name || '  plugin=' || coalesce(plugin,'-')
                   || '  db=' || coalesce(database,'-') || '  active=' || active::text
            FROM pg_replication_slots
  UNION ALL SELECT 204, 0, ''

  UNION ALL SELECT 300, 0, '=== 3. SCHEMA SIZES ==='
  UNION ALL SELECT 300, 1, rpad('schema', 24) || rpad('tables', 8) || rpad('views', 7)
                           || rpad('matviews', 10) || 'total'
  UNION ALL SELECT 301, row_number() OVER (ORDER BY sum(pg_total_relation_size(c.oid)) DESC)::int,
                   rpad(n.nspname, 24)
                   || rpad(count(*) FILTER (WHERE c.relkind IN ('r','p'))::text, 8)
                   || rpad(count(*) FILTER (WHERE c.relkind = 'v')::text, 7)
                   || rpad(count(*) FILTER (WHERE c.relkind = 'm')::text, 10)
                   || pg_size_pretty(sum(pg_total_relation_size(c.oid)))
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
              AND c.relkind IN ('r','v','m','p')
            GROUP BY n.nspname
  UNION ALL SELECT 302, 0, ''

  UNION ALL SELECT 400, 0, '=== 4. RELATIONS: table / view / matview, size, est. rows ==='
  UNION ALL SELECT 401, row_number() OVER (ORDER BY n.nspname, c.relname)::int,
                   rpad(n.nspname || '.' || c.relname, 46)
                   || rpad(CASE c.relkind WHEN 'r' THEN 'table'
                                          WHEN 'p' THEN 'part.table'
                                          WHEN 'v' THEN 'VIEW'
                                          WHEN 'm' THEN 'MATVIEW'
                                          WHEN 'f' THEN 'foreign' END, 12)
                   || rpad(pg_size_pretty(pg_total_relation_size(c.oid)), 12)
                   || CASE WHEN c.reltuples < 0 THEN '(not analyzed)'
                           ELSE to_char(c.reltuples, 'FM999999999') END
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
              AND c.relkind IN ('r','p','v','m','f')
  UNION ALL SELECT 402, 0, ''

  UNION ALL SELECT 500, 0, '=== 5. TABLES WITHOUT A PRIMARY KEY (logical replication blockers) ==='
  UNION ALL SELECT 501, row_number() OVER (ORDER BY n.nspname, c.relname)::int,
                   rpad(n.nspname || '.' || c.relname, 46)
                   || 'replica_identity=' || CASE c.relreplident
                        WHEN 'd' THEN 'default' WHEN 'f' THEN 'full'
                        WHEN 'i' THEN 'index'   WHEN 'n' THEN 'nothing' END
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','cron')
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                              WHERE k.conrelid = c.oid AND k.contype = 'p')
  UNION ALL SELECT 502, 0, ''

  UNION ALL SELECT 600, 0, '=== 6. GEOMETRY COLUMNS (expect SRID 3346 everywhere) ==='
  UNION ALL SELECT 601, row_number() OVER (ORDER BY f_table_schema, f_table_name)::int,
                   rpad(f_table_schema || '.' || f_table_name, 46)
                   || rpad(f_geometry_column, 12)
                   || rpad('srid=' || srid::text, 12) || type
            FROM geometry_columns
  UNION ALL SELECT 602, 0, ''

  UNION ALL SELECT 700, 0, '=== 7. SEQUENCES (NOT replicated — carry these over at cutover) ==='
  UNION ALL SELECT 701, row_number() OVER (ORDER BY schemaname, sequencename)::int,
                   rpad(schemaname || '.' || sequencename, 56)
                   || coalesce(last_value::text, 'never used')
            FROM pg_sequences
            WHERE schemaname NOT IN ('pg_catalog','information_schema')
  UNION ALL SELECT 702, 0, ''

  UNION ALL SELECT 800, 0, '=== 8. FUNCTIONS (bodies in statement 2) ==='
  UNION ALL SELECT 801, row_number() OVER (ORDER BY n.nspname, p.proname)::int,
                   rpad(n.nspname || '.' || p.proname, 46)
                   || rpad(l.lanname, 12)
                   || '(' || pg_get_function_identity_arguments(p.oid) || ')'
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_language l ON l.oid = p.prolang
            WHERE n.nspname NOT IN ('pg_catalog','information_schema')
              AND l.lanname NOT IN ('c','internal')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                              WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 802, 0, ''

  UNION ALL SELECT 900, 0, '=== 9. TRIGGERS ==='
  UNION ALL SELECT 901, row_number() OVER (ORDER BY n.nspname, c.relname, t.tgname)::int,
                   rpad(n.nspname || '.' || c.relname, 40) || t.tgname
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT t.tgisinternal
              AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL SELECT 902, 0, ''

  UNION ALL SELECT 1000, 0, '=== 10. LOGIN ROLES ==='
  UNION ALL SELECT 1001, row_number() OVER (ORDER BY r.rolname)::int,
                   rpad(r.rolname, 36)
                   || rpad(CASE WHEN r.rolsuper THEN 'SUPERUSER' ELSE '' END, 12)
                   || coalesce('expires=' || r.rolvaliduntil::text, '')
            FROM pg_roles r
            WHERE r.rolcanlogin
              AND r.rolname NOT LIKE 'pg\_%'
  UNION ALL SELECT 1002, 0, ''

  UNION ALL SELECT 1100, 0, '=== 11. CURRENT CONNECTIONS (who must be disconnected at cutover) ==='
  UNION ALL SELECT 1101, row_number() OVER (ORDER BY count(*) DESC)::int,
                   rpad(usename, 34)
                   || rpad(coalesce(application_name,'-'), 26)
                   || rpad(coalesce(host(client_addr),'local'), 18)
                   || rpad(state, 12) || count(*)::text || ' conn'
            FROM pg_stat_activity
            WHERE datname = current_database()
            GROUP BY usename, application_name, client_addr, state
  UNION ALL SELECT 1102, 0, ''

  UNION ALL SELECT 1200, 0, '=== 12. WRITE ACTIVITY (edited vs truncate-and-reload) ==='
  UNION ALL SELECT 1200, 1, rpad('relation', 46) || rpad('ins', 12) || rpad('upd', 12) || 'del'
  UNION ALL SELECT 1201, row_number() OVER (ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC)::int,
                   rpad(schemaname || '.' || relname, 46)
                   || rpad(n_tup_ins::text, 12) || rpad(n_tup_upd::text, 12) || n_tup_del::text
            FROM pg_stat_user_tables
            WHERE n_tup_ins + n_tup_upd + n_tup_del > 0
  UNION ALL SELECT 1202, 0, ''

  UNION ALL SELECT 1300, 0, '=== 13. LARGEST RELATIONS (dump/restore time estimate) ==='
  UNION ALL SELECT 1301, row_number() OVER (ORDER BY pg_total_relation_size(relid) DESC)::int,
                   rpad(schemaname || '.' || relname, 46)
                   || rpad(pg_size_pretty(pg_total_relation_size(relid)), 14)
                   || 'indexes ' || pg_size_pretty(pg_indexes_size(relid))
            FROM pg_stat_user_tables
  UNION ALL SELECT 1302, 0, ''
  UNION ALL SELECT 1303, 0, '=== END OF REPORT ==='
)
SELECT line AS uetk_diagnostics
FROM lines
ORDER BY ord, sub;


-- ── STATEMENT 2 — function bodies ───────────────────────────────────────────
-- On uetk_gis this is where uetk_grpk_source_update() lives. Copy the whole
-- definition column into version control.
SELECT pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND l.lanname NOT IN ('c','internal')
  AND p.prokind = 'f'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY n.nspname, p.proname;


-- ── STATEMENT 3 — pg_cron jobs, uetk_gis ONLY ───────────────────────────────
-- Raises "relation cron.job does not exist" on the uetk application database.
-- That is expected — pg_cron is configured with cron.database_name = 'uetk_gis'.
SELECT rpad(jobid::text, 8)
       || rpad(schedule, 18)
       || rpad(coalesce(jobname,'-'), 24)
       || rpad(database, 12)
       || rpad(username, 20)
       || rpad(active::text, 8)
       || command AS cron_jobs
FROM cron.job
ORDER BY jobid;
