# UETK GIS database structure

> **Still not a substitute for `pg_dump --schema-only`.** Column types,
> constraints and indexes are not recorded here. But the layer, column and
> filter inventory below is extracted from the QGIS project files, and the
> schema inventory is now confirmed against the production database.

**Sources:** `AplinkosMinisterija/biip-qgis-server` → `projects/uetk_*.qgs`,
plus a [`diagnostics-report.sql`](./diagnostics-report.sql) run against
production `uetk_gis` on 2026-08-24 (PostgreSQL 17.5, PostGIS 3.5.2, pg_cron 1.6).

**Coordinate system:** EPSG:3346 (LKS-94 / Lithuania TM).
**Postgres service name:** the QGIS projects connect via `pg_service` entry `uetk`.

## What is still missing

Column data types and lengths, nullability, primary and foreign key
definitions, index definitions, and the bodies of the 42 stored functions.
All of it comes out of one `pg_dump --schema-only`, which has not been run yet
because it needs a Postgres 17 client.

## Schema overview

Database total **7 427 MB**, of which roughly **1.2 GB is irreplaceable** — the
rest is either derived from external sources or a materialized view that can be
rebuilt with `REFRESH`.

| Schema | Size | Contents | Must be migrated |
| --- | ---: | --- | --- |
| `import` | 4 824 MB | Registrų centras parcels, GRPK hydrography, forest cadastre — **plus** a one-off 2023 import of the legacy UETK data | **Partly.** ~4 700 MB re-syncs from source; ~122 MB is the 2023 legacy import and has no upstream |
| `szns` | 1 582 MB | `uetk_szns` (811 MB, 101 470 rows) is the **authoritative** protection-zone table; `uetk_szns_old` (772 MB) is a superseded copy | **Yes** for `uetk_szns`; `uetk_szns_old` is a candidate for dropping |
| `szns_publishing` | 712 MB | 4 materialized views over `szns.uetk_szns` — this is what the WMS reads | No — `REFRESH` |
| `uetk` | 156 MB | Cadastre objects, edited directly through QGIS Desktop. 14 tables, 7 views, 4 materialized views | **Yes**, ~145 MB of tables |
| `archive` | 92 MB | `edit_history_*` per cadastre layer, written by the audit trigger | **Yes** — audit trail |
| `publishing` | 25 MB | 3 materialized views: `uetk_merged`, `uetk_alis`, `uetk_zuvinimas` | No — `REFRESH` |
| `sources` | 11 MB | Municipalities, counties, grid squares, runoff modulus | **Yes** |
| `public` | 7 MB | PostGIS plus **42 PL/pgSQL functions that hold the business logic** | **Yes** — the functions |
| `szns_sources` | 3 MB | Country border, loop restrictions, clipping lines | **Yes** |
| `administration` | 456 kB | 12 classifier and bookkeeping tables | **Yes** |
| `szns_processing` | 96 kB | Intermediate tables for zone generation | Working state |
| `szns_administration` | 48 kB | Zone creation and parcel-stat bookkeeping | **Yes** |
| `cron` | 40 kB | pg_cron catalogue | Job definitions must be recreated |

## Confirmed against production

### `publishing.*` and `szns_publishing.*` are materialized views

This closes the biggest open question. Nothing in either schema needs to be
copied — only the view definitions and a refresh schedule.

| Materialized view | Size | Rows | Read by |
| --- | ---: | ---: | --- |
| `publishing.uetk_merged` | 21 MB | 11 972 | `biip-uetk-api` `objects.service.ts`, vector tiles |
| `publishing.uetk_alis` | 2 184 kB | 9 343 | ALIS |
| `publishing.uetk_zuvinimas` | 1 584 kB | 9 342 | žuvinimas, žvejyba |
| `szns_publishing.uetk_szns_map` | 630 MB | 101 551 | `uetk_szns` WMS |
| `szns_publishing.uetk_szns_map_border_250k` | 33 MB | 51 525 | extent layer |
| `szns_publishing.uetk_szns_map_border_1mln` | 25 MB | 51 525 | extent layer |
| `szns_publishing.uetk_szns_map_border_3mln` | 23 MB | 51 525 | extent layer |

`uetk.upiu_baseinai`, `uetk.upiu_baseinu_rajonai`,
`uetk.naujinimas_grpk_upes_nesutapimai` and
`uetk.naujinimas_grpk_ezerai_tvenkiniai_nesutapimai` are materialized views too.

Refreshes are driven by `public.uetk_cron_refresh_materialized_view()` under
pg_cron. That schedule is part of the handover.

### The protection-zone source table is `szns.uetk_szns`, not `szns_publishing`

The QGIS project reads `szns_publishing.uetk_szns_map`, so the reconstruction
from the project files stopped there. The table actually being edited is
`szns.uetk_szns` — 811 MB, 101 470 rows, 101 551 inserts and 203 102 updates
since the counters were last reset, with an `uetk_szns_track_changes` trigger on
it. `szns_publishing.uetk_szns_map` is the published projection of it.

### The business logic lives in the database, not in `biip-uetk-api`

42 PL/pgSQL functions in `public`, wired up by 42 triggers. This is the single
most important thing the reconstruction missed: `biip-uetk-api` is a thin read
and workflow layer, while the cadastre rules run inside Postgres.

**Cadastre object logic**

- `uetk_generate_cadastral_id(layer_name, category, related_obj_id)` — issues cadastre identifiers
- `uetk_generate_guid()`
- `uetk_calc_upes_l_attr()`, `uetk_calc_ezerai_tvenkiniai_attr()`, and six more `uetk_calc_*_attr()` — derive attributes on every edit
- `uetk_get_parent_river_by_geom()`, `uetk_get_lake_by_geom()`, `uetk_get_municipality_by_geom()`, `uetk_get_distance_to_parent_river_end()`, `uetk_calc_river_length_from_lake()` — spatial resolution of relationships
- `uetk_update_parent_objects()`, `uetk_update_itekancios_istekancios()`, `uetk_update_savivaldybes()`, `uetk_update_baseinai_rajonai_geom()`
- `uetk_update_st_area()`, `uetk_update_st_length()`, `uetk_update_st_perimeter()`
- `uetk_auditing_edits()`, `uetk_update_editing_info()` — write `archive.edit_history_*`
- `uetk_grpk_source_update()`, `uetk_update_layer_geom_from_grpk()`, `uetk_update_object_geom_from_grpk()` — GRPK reconciliation
- `uetk_cron_refresh_materialized_view()`

**Protection-zone generation (SŽNS)**

- `szns_create_by_uetk_id()`, `szns_update_territory_by_id()`, `szns_manage_change_status()`
- `szns_process_generate_river_zones()` / `_river_bands()`, `_lake_zones()` / `_lake_bands()`, `_curonian_zones()` / `_curonian_bands()` — the actual zone and shoreline-strip geometry generation, per water body type
- `szns_process_grpk_hidro_p()`, `szns_process_grpk_hidro_p_km_segments()`, `szns_process_grpk_lines_km_segments()`
- `szns_prepare_for_publishing()` — builds the `szns_publishing` projection
- `szns_update_stats_for_parcels()` — writes zone and strip areas back into `import.rc_sklypai`
- `import.szns_track_last_editing()`

### `import.rc_sklypai` is derived *and* enriched

2 569 589 inserts but 5 139 181 updates. The sync job loads the parcels, then
`szns_update_stats_for_parcels()` writes the protection-zone and shoreline-strip
areas back onto each parcel row — those are the columns the SŽNS map shows when
a parcel is clicked. Re-running the sync alone does not restore them; the stats
function has to run afterwards over 2.5 million parcels.

### Primary keys are fine

Only `public.basin_code` and `public.v_count_new_in_basin` lack a primary key,
and neither is part of the cadastre. Logical replication is viable for
everything that matters.

### SRID anomalies worth checking

Everything is EPSG:3346 except:

| Relation | Reported SRID | Likely reason |
| --- | --- | --- |
| `import.upes_l` | 0 | A **table** with no SRID constraint — from the 2023 legacy import. Worth fixing |
| `publishing.uetk_merged` (`geom`, `geom_centroid`) | 0 | Materialized view — PostGIS loses the type modifier |
| `szns_publishing.uetk_szns_map_border_*` | 0 | Same |
| `uetk.upiu_baseinai`, `uetk.upiu_baseinu_rajonai` | 0 | Same |

Only the first one is a real defect; the rest is normal for materialized views,
though it does mean WMS clients get no SRID declaration from the metadata.

### QGIS projects are also stored in the database

`uetk.qgis_projects` holds one row, 344 kB. At least one QGIS project is loaded
from the database rather than from `biip-qgis-server/projects/`. Which one, and
whether it is still in use, needs checking before the QGIS projects are handed
over.

## QGIS projects

| Project | Size | QGIS version | Last saved | Layers |
| --- | ---: | --- | --- | ---: |
| `uetk_public.qgs` | 914 KB | 3.44.10-Solothurn | 2026-06-30 | 18 |
| `uetk_print.qgs` | 836 KB | 3.44.10-Solothurn | 2026-06-22 | 18 |
| `uetk_geoportal.qgs` | 953 KB | 3.38.1-Grenoble | 2026-01-07 | 18 |
| `uetk_szns.qgs` | 413 KB | 3.44.10-Solothurn | 2026-06-16 | 10 |
| `uetk_szns_parcels.qgs` | 262 KB | 3.38.1-Grenoble | 2026-01-14 | 4 |
| `uetk_zuvinimas.qgs` | 299 KB | 3.34.9-Prizren | 2024-09-09 | 5 |
| `uetk_grpk_pastabos.qgs` | 169 KB | 3.36.0-Maidenhead | 2024-07-22 | 2 |

All seven are published through `gis.biip.lt/qgisserver/<project name without .qgs>`.

### `uetk_public.qgs`

QGIS project name: `UETK`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `Hidroelektrinės` | `uetk.hidroelektrines` | `id` | — |
| `Vandens matavimo stotys` | `uetk.vandens_matavimo_stotys` | `id` | — |
| `Vandens pertekliaus pralaidos` | `uetk.vandens_pertekliaus_pralaidos` | `id` | — |
| `Vandens tyrimų vietos` | `uetk.vandens_tyrimu_vietos` | `id` | — |
| `Žemių užtvankos` | `uetk.zemiu_uztvankos` | `id` | — |
| `Žuvų pralaidos` | `uetk.zuvu_pralaidos` | `id` | — |
| `classificator_he_types` | `administration.classificator_he_types` | `id` | — |
| `classificator_river_types` | `administration.classificator_river_types` | `id` | — |
| `classificator_uetk_categories` | `administration.classificator_uetk_categories` | `id` | — |
| `classificator_uetk_river_bank` | `administration.classificator_uetk_river_bank` | `id` | — |
| `classificator_uetk_status` | `administration.classificator_uetk_status` | `id` | — |
| `classificator_vpp_types` | `administration.classificator_vpp_types` | `id` | — |
| `classificator_zp_types` | `administration.classificator_zp_types` | `id` | — |
| `Ežerai ir tvenkiniai` | `uetk.ezerai_tvenkiniai` | `id` | — |
| `Upės` | `uetk.upes_l` | `id` | — |
| `Upių baseinai` | `uetk.upiu_baseinai` | `baseino_id` | — |
| `Upių baseinų rajonai` | `uetk.upiu_baseinu_rajonai` | `baseino_raj_id` | — |
| `Upių pabaseiniai` | `uetk.upiu_pabaseiniai` | `id` | — |

### `uetk_print.qgs`

QGIS project name: `UETK`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `Hidroelektrinės` | `uetk.hidroelektrines` | `id` | — |
| `Vandens matavimo stotys` | `uetk.vandens_matavimo_stotys` | `id` | — |
| `Vandens pertekliaus pralaidos` | `uetk.vandens_pertekliaus_pralaidos` | `id` | — |
| `Vandens tyrimų vietos` | `uetk.vandens_tyrimu_vietos` | `id` | — |
| `Žemių užtvankos` | `uetk.zemiu_uztvankos` | `id` | — |
| `Žuvų pralaidos` | `uetk.zuvu_pralaidos` | `id` | — |
| `classificator_he_types` | `administration.classificator_he_types` | `id` | — |
| `classificator_river_types` | `administration.classificator_river_types` | `id` | — |
| `classificator_uetk_categories` | `administration.classificator_uetk_categories` | `id` | — |
| `classificator_uetk_river_bank` | `administration.classificator_uetk_river_bank` | `id` | — |
| `classificator_uetk_status` | `administration.classificator_uetk_status` | `id` | — |
| `classificator_vpp_types` | `administration.classificator_vpp_types` | `id` | — |
| `classificator_zp_types` | `administration.classificator_zp_types` | `id` | — |
| `Ežerai ir tvenkiniai` | `uetk.ezerai_tvenkiniai` | `id` | — |
| `Upės` | `uetk.upes_l` | `id` | — |
| `Upių baseinai` | `uetk.upiu_baseinai` | `baseino_id` | — |
| `Upių baseinų rajonai` | `uetk.upiu_baseinu_rajonai` | `baseino_raj_id` | — |
| `Upių pabaseiniai` | `uetk.upiu_pabaseiniai` | `id` | — |

### `uetk_geoportal.qgs`

QGIS project name: `UETK geoportal`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `Hidroelektrinės` | `uetk.hidroelektrines` | `id` | — |
| `Vandens matavimo stotys` | `uetk.vandens_matavimo_stotys` | `id` | — |
| `Vandens pertekliaus pralaidos` | `uetk.vandens_pertekliaus_pralaidos` | `id` | — |
| `Vandens tyrimų vietos` | `uetk.vandens_tyrimu_vietos` | `id` | — |
| `Žemių užtvankos` | `uetk.zemiu_uztvankos` | `id` | — |
| `Žuvų pralaidos` | `uetk.zuvu_pralaidos` | `id` | — |
| `classificator_he_types` | `administration.classificator_he_types` | `id` | — |
| `classificator_river_types` | `administration.classificator_river_types` | `id` | — |
| `classificator_uetk_categories` | `administration.classificator_uetk_categories` | `id` | — |
| `classificator_uetk_river_bank` | `administration.classificator_uetk_river_bank` | `id` | — |
| `classificator_uetk_status` | `administration.classificator_uetk_status` | `id` | — |
| `classificator_vpp_types` | `administration.classificator_vpp_types` | `id` | — |
| `classificator_zp_types` | `administration.classificator_zp_types` | `id` | — |
| `Ežerai ir tvenkiniai` | `uetk.ezerai_tvenkiniai` | `id` | — |
| `Upės` | `uetk.upes_l` | `id` | — |
| `Upių baseinai` | `uetk.upiu_baseinai` | `baseino_id` | — |
| `Upių baseinų rajonai` | `uetk.upiu_baseinu_rajonai` | `baseino_raj_id` | — |
| `Upių pabaseiniai` | `uetk.upiu_pabaseiniai` | `id` | — |

### `uetk_szns.qgs`

QGIS project name: `szns_vandens_juostos_zonos`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `apsaugos_zonos_patvirtintos` | `szns_publishing.uetk_szns_map` | `TER_GLOBID` | `"GKODAS" = 'Paviršinio vandens telkinio apsaugos zona' and "tvirtinimo_statusas" = 3` |
| `apsaugos_juostos_patvirtintos` | `szns_publishing.uetk_szns_map` | `TER_GLOBID` | `"GKODAS" = 'Paviršinio vandens telkinio pakrantės apsaugos juosta' and "tvirtinimo_stat…` |
| `apsaugos_zonos_tvirtinamos` | `szns_publishing.uetk_szns_map` | `TER_GLOBID` | `"GKODAS" = 'Paviršinio vandens telkinio apsaugos zona' and "tvirtinimo_statusas" = 2` |
| `uetk_szns_map_border_1mln_patvirtintos` | `szns_publishing.uetk_szns_map_border_1mln` | `id` | `"tvirtinimo_statusas" = 3` |
| `uetk_szns_map_border_1mln_tvirtinamos` | `szns_publishing.uetk_szns_map_border_1mln` | `id` | `"tvirtinimo_statusas" = 2` |
| `uetk_szns_map_border_250k_tvirtinamos` | `szns_publishing.uetk_szns_map_border_250k` | `id` | `"tvirtinimo_statusas" = 2` |
| `uetk_szns_map_border_250k_patvirtintos` | `szns_publishing.uetk_szns_map_border_250k` | `id` | `"tvirtinimo_statusas" = 3` |
| `uetk_szns_map_border_3mln_tvirtinamos` | `szns_publishing.uetk_szns_map_border_3mln` | `id` | `"tvirtinimo_statusas" = 2` |
| `uetk_szns_map_border_3mln_patvirtintos` | `szns_publishing.uetk_szns_map_border_3mln` | `id` | `"tvirtinimo_statusas" = 3` |
| `apsaugos_juostos_tvirtinamos` | `szns_publishing.uetk_szns_map` | `TER_GLOBID` | `"GKODAS" = 'Paviršinio vandens telkinio pakrantės apsaugos juosta' and "tvirtinimo_stat…` |

### `uetk_szns_parcels.qgs`

QGIS project name: `szns_vandens_juostos_zonos`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `Apskritys` | `import.rc_apskritys` | `id` | — |
| `Savivaldybės` | `import.rc_savivaldybes` | `id` | — |
| `Seniūnijos` | `import.rc_seniunijos` | `id` | — |
| `Žemės sklypai` | `import.rc_sklypai` | `id` | — |

### `uetk_zuvinimas.qgs`

QGIS project name: `UETK_zuvinimas`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `lakes_ponds` | `uetk.ezerai_tvenkiniai` | `id` | — |
| `municipalities` | `sources.savivaldybes` | `id` | — |
| `uetk_alis` | `publishing.uetk_alis` | `id` | — |
| `uetk_zuvinimas_info` | `publishing.uetk_zuvinimas` | `cadastral_id` | — |
| `rivers` | `uetk.upes_l` | `id` | — |

### `uetk_grpk_pastabos.qgs`

| Layer | Source table | Key column | Filter |
| --- | --- | --- | --- |
| `ezerai_tvenkiniai` | `uetk.ezerai_tvenkiniai` | `id` | `"geom_redagavimas" = true` |
| `upes_l` | `uetk.upes_l` | `id` | `"geom_redagavimas" = true` |

## Protection zones — how the layers are split

`uetk_szns.qgs` serves ten layers out of four tables. Approval state is not a
separate table but the `tvirtinimo_statusas` column:

| `tvirtinimo_statusas` | Meaning | Layer suffix |
| ---: | --- | --- |
| `2` | Being approved — draft, not yet legally in force | `_tvirtinamos` |
| `3` | Approved and in force | `_patvirtintos` |

Feature type is the `GKODAS` column:

| `GKODAS` value | Layer |
| --- | --- |
| `Paviršinio vandens telkinio apsaugos zona` | `apsaugos_zonos_*` |
| `Paviršinio vandens telkinio pakrantės apsaugos juosta` | `apsaugos_juostos_*` |

The WMS layer tree groups the extent layers under names that clients request
directly — `biip-maps-web` asks for `apreptis_patvirtintos` and
`apreptis_tvirtinamos`, which are **groups**, not tables:

```
patvirtintos_teritorijos
├── apreptis_patvirtintos          (group)
│   ├── uetk_szns_map_border_250k_patvirtintos
│   ├── uetk_szns_map_border_1mln_patvirtintos
│   └── uetk_szns_map_border_3mln_patvirtintos
├── apsaugos_juostos_patvirtintos
└── apsaugos_zonos_patvirtintos

ruosiamos_tvirtinimui_teritorijos
├── apreptis_tvirtinamos           (group)
│   ├── uetk_szns_map_border_250k_tvirtinamos
│   ├── uetk_szns_map_border_1mln_tvirtinamos
│   └── uetk_szns_map_border_3mln_tvirtinamos
├── apsaugos_juostos_tvirtinamos
└── apsaugos_zonos_tvirtinamos
```

## Column inventory

Columns as QGIS sees them, with the label shown to end users. Columns with no
label are internal and not published through WMS `GetFeatureInfo`. Data types
are **not** recorded in the project files — that gap only closes with a real
schema dump.

### `uetk.upes_l`

Upės · published as `upes` · 36 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Kadastro identifikavimo kodas |
| `pavadinimas` | 1. Pavadinimas |
| `kategorija` | 3. Kategorija |
| `statusas` | Objekto registravimo statusas |
| `registravimo_data` | Kadastro objekto registravimo data |
| `registravo_vartotojas` | — |
| `redagavimo_data` | 5. Kadastro objekto redagavimo data |
| `redagavo_vartotojas` | — |
| `iregistravimo_pagrindas` | — |
| `upiu_pabas_id` | 4. Upės pabaseinis |
| `vyr_upes_id` | 7. Vyresnioji upė |
| `vyr_ezero_tvenkinio_id` | 8. Vyr. vandens telkinys |
| `ziociu_x` | Žiočių X koordinatė (LKS-94), m |
| `ziociu_y` | Žiočių Y koordinatė (LKS-94), m |
| `atstumas_iki_vyr_upes_zioc` | — |
| `itekejimo_vyr_upes_krantas` | 11. Įtekėjimo į vyresniąją upę krantas |
| `itekejimo_eile_jura` | 12. Įtekėjimo eiliškumas upės, įtekančios į Baltijos jūrą ar Kuršių marias, atžvilgiu |
| `ilgis_jurid` | — |
| `ilgis_uetk` | Ilgis, km |
| `ilgis_uzsienis` | — |
| `vand_surinkimo_ploto_id` | — |
| `vand_surinkimo_plotas` | — |
| `hidromodulis` | Nuotėkio modulis iš grido, l/(skm²) |
| `vid_debitas` | 14. Vid. debitas, skaičiuotas pagal qGRID'ą, m³/s |
| `pastabos` | — |
| `kiti_duomenys` | 9. Kita informacija |
| `st_length` | — |
| `geom_redagavimas` | — |
| `geom_redagavimas_pastaba` | — |
| `istakos_uzsienis` | — |
| `st_length_km` | 13. Upės ilgis geografinis Lietuvos teritorijoje, km |
| `ziociu_x_public` | 5. Žiočių X koordinatė (LKS-94), m |
| `ziociu_y_public` | 6. Žiočių Y koordinatė (LKS-94), m |
| `ilgis_uetk_public` | 7. Ilgis, km |
| `registravimo_data_public` | 8. Kadastro objekto registravimo data |

### `uetk.ezerai_tvenkiniai`

Ežerai ir tvenkiniai · published as `ezerai_tvenkiniai` · 41 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Kadastro identifikavimo kodas |
| `pavadinimas` | 1. Pavadinimas |
| `kategorija` | 3. Kategorija |
| `statusas` | Objekto registravimo statusas |
| `registravimo_data` | Kadastro objekto registravimo data |
| `registravo_vartotojas` | — |
| `redagavimo_data` | 5. Kadastro objekto redagavimo data |
| `redagavo_vartotojas` | — |
| `iregistravimo_pagrindas` | — |
| `upiu_pabas_id` | 4. Upės pabaseinis |
| `ezero_kvadrato_nr` | 9. Ežero kvadrato numeris |
| `ezero_nr_kvadrate` | 10. Ežero numeris kvadrate |
| `objekto_x` | Centro X koordinatė (LKS-94), m |
| `objekto_y` | Centro Y koordinatė (LKS-94), m |
| `vand_surinkimo_ploto_id` | — |
| `vand_surinkimo_plotas` | — |
| `vand_pav_plotas_jurid` | — |
| `vand_pav_plotas_lt_jurid` | — |
| `vand_lygis` | — |
| `npl` | Normalusis patvankos lygis, m |
| `vand_lygis_las07` | — |
| `npl_las07` | — |
| `max_gylis` | — |
| `vid_gylis` | — |
| `vand_turis` | — |
| `naud_vand_turis` | — |
| `ilgis` | 11. Ežero, tvenkinio ilgis, km |
| `vid_plotis` | 12. Ežero, tvenkinio vidutinis plotis, km |
| `kranto_linijos_ilgis` | Kranto linijos igis, km |
| `pastabos` | — |
| `kiti_duomenys` | 10. Kita informacija |
| `st_perimeter` | — |
| `st_area` | — |
| `geom_redagavimas` | — |
| `geom_redagavimas_pastaba` | — |
| `st_area_he` | 7. Vandens paviršiaus be salų plotas, ha |
| `objekto_x_public` | 5. Centro X koordinatė (LKS-94), m |
| `objekto_y_public` | 6. Centro Y koordinatė (LKS-94), m |
| `kranto_linijos_ilgis_public` | 8. Kranto linijos ilgis, km |
| `registravimo_data_public` | 9. Kadastro objekto registravimo data |

### `uetk.hidroelektrines`

Hidroelektrinės · published as `hidroelektrines` · 25 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Hidrotechninio statinio kodas |
| `pavadinimas` | 1. Pavadinimas |
| `he_tipas` | 8. Hidroelektrinės tipas |
| `he_pastatymo_metai` | 6. Pastatymo metai |
| `he_galia` | 9. Hidroelektrinės galia, kW |
| `max_slegio_aukstis` | 7. Maksimalus patvankos slėgio aukštis, m |
| `sav_kodas` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `objekto_x` | — |
| `objekto_y` | — |
| `statusas` | Objekto registravimo statusas |
| `pastabos` | — |
| `kiti_duomenys` | Kiti duomenys |
| `saltinis` | — |
| `iregistravimo_pagrindas` | — |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | — |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 3. Centro X koordinatė (LKS-94), m |
| `objekto_y_public` | 4. Centro Y koordinatė (LKS-94), m |
| `registravimo_data_public` | 5. Įrašymo data |

### `uetk.vandens_matavimo_stotys`

Vandens matavimo stotys · published as `vandens_matavimo_stotys` · 26 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | — |
| `pavadinimas` | 1. Pavadinimas |
| `objekto_x` | — |
| `objekto_y` | — |
| `altitude` | — |
| `stebima_nuo` | — |
| `bas_plotas` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `sav_kodas` | — |
| `statusas` | — |
| `pastabos` | — |
| `kiti_duomenys` | — |
| `saltinis` | 8. Duomenų teikėjas |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | — |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 2. Taško X koordinatė (LKS-94), m |
| `objekto_y_public` | 3. Taško Y koordinatė (LKS-94), m |
| `bas_plotas_public` | 4. Upės baseino plotas ties stotimi, km² |
| `atstumas_iki_ziociu_public` | 6. Atstumas nuo upės, kanalo žiočių, km |
| `stebima_nuo_public` | 7. Hidrometrinių stebėjimų laikotarpio pradžios data |
| `altitude_public` | 5. Stoties atskaitos nulinė altitudė |

### `uetk.vandens_pertekliaus_pralaidos`

Vandens pertekliaus pralaidos · published as `vandens_pertekliaus_pralaida` · 33 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Hidrotechninio statinio kodas |
| `pavadinimas` | 1. Pavadinimas |
| `hs_tipas` | 8. Vandens pertekliaus pralaidos tipas |
| `hs_pastatymo_metai` | 7. Pastatymo metai |
| `objekto_x` | — |
| `objekto_y` | — |
| `max_patvankos_aukstis` | 15. Maksimalus patvankos slėgio aukštis, m |
| `vid_daug_metis_debitas` | 14. Vidutinis daugiametis debitas, m³/s |
| `vid_daug_metis_debitas_95` | 10. Vidutinis daugiametis debitas 95 %, m³/s |
| `pavas_potv_debitas_1` | 9. Pavasario potvynio (lietaus poplūdžio) 1 % debitas, m³/s |
| `pavas_potv_debitas_5` | 11. Pavasario potvynio (lietaus poplūdžio) 5% debitas, m³/s |
| `min_vid_debitas_95` | — |
| `gamtosaug_debitas` | 12. Gamtosauginis debitas, m³/s |
| `max_debitas` | 13. Didžiausias debitas m³/s pagal skaičiuotiną % tikimybę |
| `min_vid_debitas` | — |
| `min_vid_debitas_80` | — |
| `sav_kodas` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `statusas` | Objekto registravimo statusas |
| `pastabos` | — |
| `kiti_duomenys` | Kiti duomenys |
| `saltinis` | — |
| `iregistravimo_pagrindas` | — |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | 4. Kadastro objekto redagavimo data |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 3. Centro X koordinatė (LKS-94), m |
| `objekto_y_public` | 4. Centro Y koordinatė (LKS-94), m |
| `registravimo_data_public` | 5. Įrašymo data |

### `uetk.vandens_tyrimu_vietos`

Vandens tyrimų vietos · published as `vandens_tyrimu_vietos` · 20 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | — |
| `pavadinimas` | 1. Pavadinimas |
| `objekto_x` | — |
| `objekto_y` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `sav_kodas` | — |
| `statusas` | — |
| `pastabos` | — |
| `kiti_duomenys` | — |
| `saltinis` | 5. Duomenų teikėjas |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | — |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 2. Taško X koordinatė (LKS-94), m |
| `objekto_y_public` | 3. Taško Y koordinatė (LKS-94), m |
| `atstumas_iki_ziociu_public` | 4. Atstumas nuo upės, kanalo žiočių, km |

### `uetk.zemiu_uztvankos`

Žemių užtvankos · published as `zemiu_uztvanka` · 25 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Hidrotechninio statinio kodas |
| `pavadinimas` | 1. Pavadinimas |
| `hs_pastatymo_metai` | 9. Pastatymo metai |
| `zu_ilgis` | 7. Žemių užtvankos ilgis, m |
| `zu_plotis` | 8. Žemių užtvankos ilgis, m |
| `zu_max_patvankos_aukstis` | 10. Maksimalus patvankos slėgio aukštis, m |
| `objekto_x` | — |
| `objekto_y` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `sav_kodas` | — |
| `statusas` | Objekto registravimo statusas |
| `pastabos` | — |
| `kiti_duomenys` | Kiti duomenys |
| `saltinis` | — |
| `iregistravimo_pagrindas` | — |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | 4. Kadastro objekto redagavimo data |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 3. Centro X koordinatė (LKS-94), m |
| `objekto_y_public` | 4. Centro Y koordinatė (LKS-94), m |
| `registravimo_data_public` | 5. Įrašymo data |

### `uetk.zuvu_pralaidos`

Žuvų pralaidos · published as `zuvu_pralaida` · 24 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `kadastro_id` | 2. Hidrotechninio statinio kodas |
| `pavadinimas` | 1. Pavadinimas |
| `hs_tipas` | 6. Žuvų pralaidos tipas |
| `hs_pastatymo_metai` | 8. Pastatymo metai |
| `objekto_x` | — |
| `objekto_y` | — |
| `proj_debitas` | 7. Žuvų pralaidos projektinis debitas, m³/s |
| `sav_kodas` | — |
| `atstumas_iki_ziociu` | — |
| `kadastro_id_upes` | — |
| `kadastro_id_ezerai_tvenkiniai` | — |
| `statusas` | Objekto registravimo statusas |
| `pastabos` | — |
| `kiti_duomenys` | Kiti duomenys |
| `saltinis` | — |
| `iregistravimo_pagrindas` | — |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | — |
| `redagavo_vartotojas` | — |
| `objekto_x_public` | 3. Centro X koordinatė (LKS-94), m |
| `objekto_y_public` | 4. Centro Y koordinatė (LKS-94), m |
| `registravimo_data_public` | 5. Įrašymo data |

### `uetk.upiu_pabaseiniai`

Upių pabaseiniai · published as `upiu_pabaseiniai` · 16 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `pavadinimas` | 1. Pavadinimas |
| `saltinis` | — |
| `baseino_id` | — |
| `baseino_pavadinimas` | — |
| `baseino_raj_id` | — |
| `baseino_raj_pavadinimas` | — |
| `registravimo_data` | — |
| `registravo_vartotojas` | — |
| `redagavimo_data` | — |
| `redagavo_vartotojas` | — |
| `pastabos` | — |
| `st_perimeter` | — |
| `st_area` | 3. Pabaseinio plotas |
| `pabaseinio_id` | 2. Pabaseinio kodas |
| `baseino_kodas` | — |

### `uetk.upiu_baseinai`

Upių baseinai · published as `upiu_baseinai` · 3 columns

| Column | Label |
| --- | --- |
| `baseino_id` | 2. Baseino kodas |
| `baseino_pavadinimas` | 1. Pavadinimas |
| `plotas_kv_km` | 3. Plotas (kv. km) |

### `uetk.upiu_baseinu_rajonai`

Upių baseinų rajonai · published as `upiu_baseinu_rajonai` · 3 columns

| Column | Label |
| --- | --- |
| `baseino_raj_id` | 2. Baseino rajono kodas |
| `baseino_raj_pavadinimas` | 1. Pavadinimas |
| `plotas_kv_km` | 3. Plotas (kv. km) |

### `administration.*` classifiers

Seven lookup tables, three columns each, keyed on `id`. Referenced by the
cadastre layers through QGIS value-relation widgets.

- `administration.classificator_he_types`
- `administration.classificator_river_types`
- `administration.classificator_uetk_categories`
- `administration.classificator_uetk_river_bank`
- `administration.classificator_uetk_status`
- `administration.classificator_vpp_types`
- `administration.classificator_zp_types`

### `szns_publishing.uetk_szns_map`

Protection zones and shoreline strips · published as `apsaugos_zonos_patvirtintos` · 9 columns

One table backs all four zone/strip layers; see the filter table above.

| Column | Label |
| --- | --- |
| `TER_GLOBID` | SŽNS teritorijos ID |
| `UNIK_NR` | Unikalus numeris Nekilnojamojo turto registre |
| `PLOTAS` | Specialiosios sąlygos plotas (ha) |
| `OB_GLOBID` | Paviršinio vandens telkinio UETK kodas |
| `PAVADINIM` | Paviršinio vandens telkinio pavadinimas |
| `GKODAS` | Specialioji sąlyga |
| `INFO_URL` | Papildoma informacija |
| `tvirtinimo_statusas` | Tvirtinimo statusas |
| `teritorijos_statusas` | Teritorijos statusas |

### `import.rc_sklypai`

Registrų centra open data — Žemės sklypai · published as `sklypai` · 20 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `unikalus_nr` | Unikalus ID |
| `kadastro_nr` | Kadastro Nr. |
| `sav_kodas` | — |
| `sav_pavadinimas` | Savivaldybė |
| `seniunijos_kodas` | — |
| `seniunijos_pavad` | Seniūnija |
| `pask_tipas` | Paskirties tipas |
| `osta_statusas` | Objekto  statusas |
| `skl_plotas` | NTR įregistruoto žemės sklypo plotas (ha) |
| `data_rk` | Sklypo ribos koregavimo data |
| `formavimo_data` | Duomenų formavimo data |
| `SHAPE_Length` | Perimetras (geometrinis) |
| `SHAPE_Area` | Plotas (geometrinis) |
| `szns_az29_rengiama` | Rengiamų paviršinių vandens telkinių apsaugos zonos plotas (ha) |
| `szns_az30_rengiama` | Rengiamų paviršinių vandens telkinių pakrančių apsaugos juostos plotas (ha) |
| `szns_az29_tvirtinama` | Tvirtinamų paviršinių vandens telkinių apsaugos zonų plotas (ha) |
| `szns_az30_tvirtinama` | Tvirtinamų paviršinių vandens telkinių pakrančių apsaugos juostų plotas (ha) |
| `szns_az29_patvirtinta` | Patvirtintų paviršinių vandens telkinių apsaugos zonų plotas (ha) |
| `szns_az30_patvirtinta` | Patvirtintų paviršinių vandens telkinių pakrančių apsaugos juostų plotas (ha) |

### `import.rc_savivaldybes`

Registrų centra open data — Savivaldybės · published as `savivaldybes` · 8 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `SAV_KODAS` | Savivaldybės kodas |
| `SAV_PAV` | Savivaldybės pavadinimas |
| `SAV_PLOTAS` | — |
| `SAV_R` | — |
| `APS_KODAS` | — |
| `SHAPE_Length` | — |
| `SHAPE_Area` | — |

### `import.rc_seniunijos`

Registrų centra open data — Seniūnijos · published as `seniunijos` · 8 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `SEN_KODAS` | Seniūnijos kodas |
| `SEN_PAV` | Seniūnijos pavadinimas |
| `SEN_PLOTAS` | — |
| `SEN_R` | — |
| `SAV_KODAS` | — |
| `SHAPE_Length` | — |
| `SHAPE_Area` | — |

### `import.rc_apskritys`

Registrų centra open data — Apskritys · published as `apskritys` · 7 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `APS_KODAS` | Apskrities kodas |
| `APS_PAV` | Apskrities pavadinimas |
| `APS_PLOTAS` | — |
| `APS_R` | — |
| `SHAPE_Length` | — |
| `SHAPE_Area` | — |

### `sources.savivaldybes`

Consumed by žuvinimas / žvejyba / ALIS · 4 columns

| Column | Label |
| --- | --- |
| `id` | id |
| `kodas` | sav_kodas |
| `pavadinimas` | sav_pav |
| `apskritis_kodas` | aps_kodas |

### `publishing.uetk_alis`

Consumed by žuvinimas / žvejyba / ALIS · 10 columns

| Column | Label |
| --- | --- |
| `id` | — |
| `cadastral_id` | — |
| `name` | — |
| `category` | — |
| `area` | — |
| `length` | — |
| `municipality_main` | — |
| `municipalities_list` | — |
| `lat` | — |
| `lon` | — |

### `publishing.uetk_zuvinimas`

Consumed by žuvinimas / žvejyba / ALIS · 7 columns

| Column | Label |
| --- | --- |
| `cadastral_id` | — |
| `name` | — |
| `category` | — |
| `municipality` | — |
| `area` | — |
| `lat` | — |
| `lon` | — |

## Who reads what

| Consumer | Reads |
| --- | --- |
| `biip-uetk-api` → `objects.service.ts` | `publishing.uetkMerged` over `GIS_DB_CONNECTION` |
| `biip-uetk-api` → `search.service.ts` | `uetk_zuvinimas` WFS layer `uetk_zuvinimas_info` |
| `biip-maps-web` | `uetk_public`, `uetk_print`, `uetk_szns`, `uetk_szns_parcels`, `uetk_zuvinimas` WMS |
| `biip-maps-web` vector tiles | `uetk.uetk_merged.1` via `vector-tiles-uetk` |
| `biip-zuvinimas-api` | `uetk_zuvinimas` WFS — `municipalities`, `rivers`, `lakes` |
| `biip-zvejyba-api` | `uetk_zuvinimas` WFS and `uetk_public` WMS `GetFeatureInfo` |
| Geoportal.lt | `uetk_geoportal` WMS |
| Public — legally published service | `uetk_szns` WMS |

> `uetk_zuvinimas.qgs` is **not** a UETK-only project. It serves žuvinimas,
> žvejyba and ALIS, and it is where the shared `municipalities` layer used
> across BĮIP comes from. Splitting it is a prerequisite for handing UETK over.

## Regenerating this document

The project files are XML. To re-extract after they change:

```bash
cd biip-qgis-server/projects
for f in uetk_*.qgs; do
  echo "== $f"
  grep -oE "table=\"[^\"]+\".\"[^\"]+\"" "$f" | sort -u
done
```

