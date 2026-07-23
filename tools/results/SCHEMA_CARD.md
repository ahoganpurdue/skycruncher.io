# Results query surface — SCHEMA CARD (`query_results`)

**Tier: TEST/DEV — the schema is UNLOCKED. Results are NON-CITABLE until the
post-recal schema lock** (standing ruling, owner 2026-07-16: "results query
surface = R2-DIRECT DuckDB-over-parquet, TEST/DEV until post-recal schema lock").
Every `query_results.mjs` invocation prints this banner on stderr:

    [query_results v0-testdev] schemas unlocked — results non-citable until post-recal schema lock

This card is the librarian-facing map of the READ surface built by
`tools/results/query_results.mjs` over the six parquet tables produced by the ETL
lane (`etl_receipts.mjs` full load, `drain_to_r2.mjs` incremental). The
receipt-field → column provenance is in `tools/results/README.md` (the single
source of truth for the flatten); this card is the query-surface view of the same
columns plus the tool contract, canned queries, and unit traps.

Column dtypes/names come from `tools/results/lib/flatten.mjs` (`FRAME_COLS`,
`STAR_COLS`, `DETECTION_COLS`, `CRASH_COLS`, `QUAD_VERDICT_COLS`,
`QUAD_CLUSTER_COLS` — the generative source shared by the ETL, the drain, and this
card). If they drift, `lib/flatten.mjs` wins.

---

## The tool

    node tools/results/query_results.mjs <command> [flags]
    node tools/results/query_results.mjs --sql "SELECT ... FROM quad_clusters ..." [flags]
    (npm run query -- <command>)

Six DuckDB VIEWS are registered: `frames`, `stars`, `detections`, `crashes`,
`quad_verdicts`, `quad_clusters`.

**Sources**
- LOCAL (default): globs the `D:/AstroLogic/test_artifacts/results_etl_*` roots,
  newest-first. Dedup is **newest-root-wins per receipt** — when a receipt appears
  in more than one root, ALL of its child rows (stars/detections/clusters) come
  from the newest root as a unit. This never double-counts and never silently
  drops a receipt unique to an older root. (A per-child-row dedup would be WRONG:
  `detection_index` is not unique within a receipt — it resets between the kept
  and anomaly groups.) `tables` shows the resolved roots + row counts.
- R2 (`--r2`): reads `s3://<bucket>/<prefix>/<table>/**/*.parquet` via httpfs;
  creds from `src/engine/ui/dashboard/.env.r2` (values never printed). Bucket
  `community-database`, prefix `results/v0-testdev/`. A table not yet uploaded
  (e.g. the quad_gen backfill) reports **NOT MEASURED**, never a silent empty.

**Safety rails (read surface — no writes)**
- SELECT-only: the query must be a single `SELECT` / `WITH…SELECT`. Any
  `INSERT / UPDATE / DELETE / COPY / ATTACH / PRAGMA / CREATE / DROP / ALTER /
  INSTALL / LOAD / SET / CALL / EXPORT / IMPORT / VACUUM` token, or a second
  statement, is rejected **before execution** (comment-stripped first).
- Row cap: `--limit N` (default 1000) with an explicit truncation notice.
- Query timeout: `--timeout-ms N` (default 30000).

**Flags**: `--sql` · `--r2` · `--json` · `--limit N` · `--timeout-ms N` ·
`--roots a,b` · `--labels <glob>` · `--sql-only` · `--bucket`/`--prefix`/`--env`.

**Canned queries** (each prints its SQL to stderr for transparency):

| command | grain | notes |
|---|---|---|
| `odds-separation` | quad_clusters × oracle labels | truth/false signed-`oddsV2` separation over the two `arm_fullstack_*` arms. **Reproduces the drain sanity EXACTLY**: false n=1231 max=`199.22359881965082`; truth n=23 min=`1959.6022951183534`. Needs the local oracle-label glob (default `D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/*.label.json`). |
| `verdicts-by-frame` | quad_verdicts | per-frame quad-gen verdict summary |
| `gap-classes` | frames (unsolved) | failure-stage/reason distribution (v0 schema has no dedicated gap_class column; this is the honest proxy) |
| `frames-summary` | frames | solved/unsolved rollup by rig |
| `tables` | meta | registered views + resolved source(s) + row count |
| `schema <table>` | meta | `DESCRIBE` column list + dtype |

**MCP**: registered as tool `query_results` in `tools/mcp/server.mjs` (params
`{ canned | sql, r2, limit, labels }`, same rails; spawns the CLI as a child).

---

## UNIT / FORMAT TRAPS (each cost hours once)

- `quad_clusters.foot_ra_deg` / `crval_ra_deg` = **DEGREES**. But
  `quad_verdicts.acceptance_verify_ra_hours` = **HOURS**. `frames.ra_hours` = HOURS,
  `frames.crval1_deg` = DEGREES.
- `parity` = raw ±1, **sign not asserted** (image-space y-down convention).
- `odds` = clamped `SOLVER_QUAD_GEN_ODDS` shadow; `odds_v2` = SIGNED V2 shadow;
  `odds_v3` = a.net-complete V3 (conditional ⇒ often NULL). NULL when the flag is off.
- Honest-NULL everywhere: a missing receipt field is `NULL`, never fabricated.
  `pose_present=false` ⇒ crval/crpix/cd NULL. `acceptance_present=false` (shadow-only)
  ⇒ all `acceptance_*` NULL.

---

## Tables + columns

Hive-partitioned by `schema_version` (= receipt `version`), except `crashes` (flat).

### `frames` — one row per distinct receipt (dedup on `receipt_sha256`)
`receipt_sha256`, `schema_version`, `receipt_kind`, `source_root`, `receipt_path`,
`receipt_basename`, `receipt_bytes` (BIGINT), `input_basename`, `frame_sha256`,
`identity_basis`, `frame_identity_fallback`, `engine_version`,
`engine_build_identity`, `effective_config_hash`, `solved` (BOOL), `solved_via`,
`source_format`, `decoder_arm`, `atlas_id`, `ra_hours` (DOUBLE, **HOURS**),
`dec_degrees`, `pixel_scale_arcsec_px`, `roll_degrees`, `parity`, `confidence`,
`stars_matched` (INT), `fov_width_deg`, `fov_height_deg`, `mean_fwhm_px`,
`mean_residual_arcsec`, `solve_time_ms`, `crval1_deg`, `crval2_deg` (**DEGREES**),
`confirm_status`, `confirm_set_excess_z`, `confirm_n_targets`, `confirm_confirmed`,
`confirm_set_gate_z`, `deep_examined`, `deep_confirmed_n`, `deep_set_excess_z`,
`deep_set_gate_passed` (BOOL), `camera_model`, `lens_model`, `focal_length`,
`iso_gain`, `exposure_time`, `pixel_scale_meta`, `image_width`, `image_height`,
`gps_lat`, `gps_lon`, `obs_timestamp`, `rig`, `inferred_lens`, `experimental`
(BOOL), `config_overrides_present` (BOOL), `config_overrides_sha256`,
`failure_stage`, `failure_reason`, `run_timestamp`, `n_matched_stars_rows`,
`n_photometry_rows`, `n_confirmed_rows`, `duplicate_path_count`, `background_level`,
`noise_floor`, `background_level_top`, `background_level_bottom`,
`background_gradient`, `culling_tally_json`, `cfa_verdict_json`, `cfa_klass`,
`milky_way_present` (BOOL), `milky_way_n_hotspots`, `grid_w`, `grid_h`, `cell_size`,
`n_clean_detections`, `n_anomaly_detections`.

### `stars` — one row per catalog-grade per-star product (`matched`|`photometry`|`confirmed`)
`receipt_sha256`, `schema_version`, `frame_sha256`, `star_role`, `star_index`,
`catalog_id`, `name`, `ra_deg`, `dec_deg`, `x_px`, `y_px`, `flux`, `flux_err`,
`fwhm_px`, `mag_catalog`, `mag_measured`, `mag_instrumental`, `cat_band`, `bv`,
`measured_bv`, `snr`, `calibrated_mag_err`, `calibrated_status`, `provenance`,
`residual_arcsec`, `dx_px`, `dy_px`, `dra_arcsec`, `ddec_arcsec`, `airmass`,
`alt_deg`, `confidence`, `sigma_e`, `detected_native` (BOOL), `peak_rgb_json`,
`tests_json`.

### `detections` — one row per raw pre-match detection (`clean_stars` KEPT + `anomalies` REJECTED)
`receipt_sha256`, `schema_version`, `frame_sha256`, `detection_index`,
`detection_id`, `x`, `y`, `raw_x`, `raw_y`, `flux`, `peak`, `peak_value`, `fwhm`,
`snr`, `sharpness`, `circularity`, `ellipticity`, `theta`, `moment_fwhm_px`,
`moment_ellipticity`, `measured_bv`, `mie_index`, `rayleigh_index`, `peak_rgb_json`,
`kept` (BOOL — `true`=clean_stars, `false`=anomalies), `culling_reason`, `matched`
(BOOL — anomalies always `false`).
Note: `detection_index` is NOT unique within a receipt (resets between the
kept/anomaly groups) — never treat it as a per-receipt PK.

### `crashes` — one row per crash record (flat; keyed on `crash_sha256`)
`crash_sha256`, `source_root`, `crash_path`, `crash_basename`, `kind`, `schema`,
`input`, `receipt_expected`, `status` (INT), `signal`, `error_code`, `timed_out`
(BOOL), `stderr_first_error`, `stderr_tail_full` (≤4000 chars), `timestamp`.

### `quad_verdicts` — one row per receipt with a `quad_gen` block (schema 2.29.0+)
`receipt_sha256`, `schema_version`, `frame_sha256`, `source_root`, `receipt_path`
(carries the A/B arm dir), `receipt_basename`, `input_basename`, `decoder_arm`,
`atlas_id`, `rig`, `effective_config_hash`, `config_overrides_present` (BOOL),
`config_overrides_sha256`, `solved` (BOOL), `solved_via`, `qg_pass`
(`hint`|`full`), `qg_capture_mode` (`full`|`slim`), `verdict_accept` (BOOL —
SHADOW verdict), `verdict_reason`, `verdict_mode`, `verdict_top_anchored`,
`verdict_second_anchored`, `verdict_margin`, `verdict_k`, `verdict_m`,
`verdict_unopposed_floor`, `verdict_n_distinct`, `hint_fallthrough_reason`,
`hint_fallthrough_top_anchored`, `acceptance_present` (BOOL — false under
shadow-only), `acceptance_attempted`, `acceptance_accepted`, `acceptance_reason`,
`acceptance_arbiter`, `acceptance_verify_matched`, `acceptance_verify_confidence`,
`acceptance_verify_ra_hours` (**HOURS**), `acceptance_verify_dec_degrees`,
`acceptance_verify_pixel_scale`, `acceptance_sanity_ok` (BOOL),
`acceptance_sanity_fail`, `acceptance_sanity_scale`,
`acceptance_sanity_foot_drift_deg`, `index_release`, `index_bands`, `index_stars`,
`index_quads`, `budget_spent_ms`, `budget_limit_ms`, `budget_truncated` (BOOL),
`n_clusters`.

### `quad_clusters` — one row per judged cluster (absent block ⇒ no row, honest absence)
`receipt_sha256`, `schema_version`, `frame_sha256`, `source_root`, `receipt_path`,
`input_basename`, `decoder_arm`, `effective_config_hash`, `rig`, `qg_pass`,
`verdict_accept` (BOOL, denormalized), `verdict_reason`, `cluster_index`,
`foot_ra_deg` (**DEGREES**), `foot_dec_deg` (**DEGREES**), `parity` (raw ±1),
`scale` (arcsec/px), `votes`, `anchored`, `pose_present` (BOOL), `crval_ra_deg`
(**DEGREES**), `crval_dec_deg`, `crpix_x`, `crpix_y`, `cd_json` (2×2 CD as JSON),
`odds` (clamped shadow), `odds_v2` (signed shadow), `odds_v3` (a.net-complete,
conditional ⇒ NULL).

---

## Reproduction sanity (why the numbers are trustworthy to IEEE precision)

`odds-separation` restricts `quad_clusters` to the two `arm_fullstack_*` arms,
joins each cluster to its frame's oracle label (`w5_oracle_labels_2026-07-18`),
and replays the w5 footprint classification — a cluster is TRUTH iff the angular
separation of its foot from the oracle center is ≤ `0.1 × (fov_diag/2)` AND the
scale ratio is in `[0.8, 1.25]`. Over the drained parquet this yields **1254
clusters (23 truth / 1231 false)**, `max(false odds_v2)` = `199.22359881965082`,
`min(truth odds_v2)` = `1959.6022951183534` — byte-for-byte the desk study
(`test_results/w5_proper_2026-07-18/odds_v2_probe.json`, matured arms). Same query
twice ⇒ identical rows (deterministic).
