# tools/results — banked-receipt ETL → partitioned parquet → R2

First data load of the ruled **DuckDB-over-R2 results query surface** (owner
2026-07-16). This lane flattens every banked solve/crash receipt into **six**
columnar parquet tables and publishes them to R2 so the results surface can query
the whole banked population with DuckDB `read_parquet('s3://…')`.

The `quad_verdicts` / `quad_clusters` tier (per-cluster odds evidence) landed
2026-07-18 to close the collection gap where the `quad_gen` block (schema 2.29.0+)
was banked in receipts but never drained — the multi-field bar-recalibration
dataset and diskless mining agents can now query the day's most valuable evidence.

The `detections` tier (raw pre-match detections) landed 2026-07-17 as the v1 rider
pre-scoped when v0 excluded raw detections — its purpose is light-pollution,
nebulosity, sensor-issue, and star-vs-noise separability analysis. `frames` was
additively enriched with per-frame sky-condition columns in the same pass.

**Tier: TEST/DEV. The schema is NOT locked.** Column choices here are a v0
proposal, not doctrine — expect a rebaseline after the post-recal schema lock.

Incubator-pattern lane (CLAUDE.md LAW 4): lane-local `package.json` +
`node_modules` (one dependency, `@duckdb/node-api`, used for both parquet writing
and the R2 round-trip verification). **Never** installs into the root
`node_modules`; never imports from the vite app bundle.

Shared logic lives in `lib/` (CLAUDE.md LAW 4 — no code in two places):
- `lib/flatten.mjs` — the receipt/crash → column flatten (single source of truth),
  imported by `etl_receipts.mjs` (full load) AND `drain_to_r2.mjs` (incremental).
- `lib/r2.mjs` — the SigV4 S3 client + credential loading, imported by
  `upload_r2.mjs` AND `drain_to_r2.mjs`.

## Evidence-only (LAW 3)

Every column is either **MEASURED** from a receipt field or **honest-NULL**.
Nothing is fabricated. Unknown/missing fields are `NULL`. This file is the single
source of truth for the receipt-field → column mapping.

## Query surface (`query_results.mjs`)

The READ side of the lane (ruled DuckDB-over-parquet results surface, owner
2026-07-16). Registers the six tables as DuckDB views and runs **SELECT-only**
queries — canned shortcuts or an arbitrary `--sql`. Full column/dtype/unit map is
in **`SCHEMA_CARD.md`** (the librarian-facing card); this is the quick contract.

```
node query_results.mjs tables                # views + resolved source + row count   (npm run query -- tables)
node query_results.mjs odds-separation       # truth/false oddsV2 separation (repro sanity)
node query_results.mjs frames-summary        # solved/unsolved rollup by rig
node query_results.mjs gap-classes           # failure-stage/reason over unsolved frames
node query_results.mjs verdicts-by-frame     # per-frame quad-gen verdicts
node query_results.mjs --sql "SELECT ... FROM quad_clusters ..." [--json --limit N]
node query_results.mjs schema <table>        # DESCRIBE a view
```

- **Sources**: local `D:/AstroLogic/test_artifacts/results_etl_*` roots by default
  (newest root wins per receipt — no double-count, no silent drop); `--r2` reads the
  R2 parquet (tables not yet uploaded ⇒ honest NOT MEASURED, never a silent empty).
- **Rails**: SELECT-only (any write/DDL/multi-statement rejected before execution),
  `--limit` row cap (default 1000) + truncation notice, `--timeout-ms` (default 30000).
- **Tier: TEST/DEV** — schema unlocked, results non-citable until the post-recal
  schema lock (banner on every run).
- `odds-separation` reproduces the drain sanity EXACTLY (false n=1231
  max=`199.22359881965082`; truth n=23 min=`1959.6022951183534`) — see SCHEMA_CARD.
- **MCP**: exposed as tool `query_results` in `tools/mcp/server.mjs`.

## Pipeline

```
node --max-old-space-size=8192 etl_receipts.mjs   # FULL rebuild: discover → flatten → parquet  (npm run etl)
node upload_r2.mjs                                # full parquet tree → R2                       (npm run upload)
node verify_r2.mjs                                # round-trip proof over R2                      (npm run verify)
node drain_to_r2.mjs [--roots <dir>]             # INCREMENTAL: new receipts → append → R2       (npm run drain)
node query_results.mjs <cmd|--sql …>             # READ: DuckDB SELECT-only over the parquet     (npm run query)
```

`etl_receipts.mjs` + `upload_r2.mjs` do the initial full load (rewrites every
partition). `drain_to_r2.mjs` is the **ongoing incremental** path — it appends only
new receipts as new parquet files without rewriting existing partitions (see
[Incremental drain](#incremental-drain-drain_to_r2mjs) below). After the drain era
begins, prefer the drain; a full ETL re-run is a reconciliation event (see caveat).

Sources (LOCAL-ONLY — verify presence, never assume in a clone):

- `D:/AstroLogic/test_artifacts/**/*.receipt.json` + `*.crash.json`
- `<repo>/test_results/**` (main checkout)
- `<rest-integration>/test_results/**` (restoration-branch checkout)

All intermediates + output parquet land in
`D:/AstroLogic/test_artifacts/results_etl_2026-07-17/` (K:-drive storage law — no
bulk on K:). Parquet artifacts and `.env.r2` are **uncommitted**; only the lane
tools are tracked.

## Tables (parquet, hive-partitioned by `schema_version` = receipt `version`)

| table | grain | partition |
|---|---|---|
| `frames` | one row per **distinct** receipt (dedup on `receipt_sha256`) | `schema_version=<version>` |
| `stars` | one row per **catalog-grade per-star product** (`matched` \| `photometry` \| `confirmed`) | `schema_version=<version>` |
| `detections` | one row per **raw pre-match detection** (`clean_stars` KEPT + `anomalies` REJECTED) | `schema_version=<version>` |
| `quad_verdicts` | one row per receipt carrying a **`quad_gen` block** (LEVER-2 blind generate→judge verdict + W4 acceptance + index + budget) | `schema_version=<version>` |
| `quad_clusters` | one row per **judged quad-gen cluster** (FULL capture mode; per-cluster odds / footprint / pose) | `schema_version=<version>` |
| `crashes` | one row per `*.crash.json` forensics record | none (single file) |

Partition value `none` = receipts with no top-level `version` (calibration /
render-wiring shapes).

## Dedup semantics

- `receipt_sha256` = SHA-256 of the receipt file **bytes** = primary key. The
  same receipt content appearing under multiple paths collapses to ONE row;
  `duplicate_path_count` records how many paths carried it. (10 of 221 discovered
  receipts were exact-duplicate files → 211 distinct.)
- Receipts are IEEE bit-identical for identical frame+engine+config, so this dedup
  is **exact** for re-runs.
- `frame_sha256` groups distinct receipts that share the same input frame. A frame
  with >1 distinct `receipt_sha256` = the same frame re-run under a different
  engine/config (see the CR2 variant family: 7 receipts, same `frame_sha256`,
  distinct `effective_config_hash`).

## Frame identity (`identity_basis`)

- `receipt_stamped` (110/211) — the receipt carries an engine-computed
  `frame_sha256`. Authoritative (this is exactly what the engine used); preferred.
- `path+size` (101/211) — no stamped hash and no reliable input-file path inside
  the receipt (older schemas, calibration/fixture/render-wiring shapes).
  `frame_sha256` = `NULL`, `frame_identity_fallback` = `"<receipt_path>|<bytes>"`.
  File-recompute was **not** attempted for these: the receipt does not name its
  input, and a basename-guess hunt across corpus binaries risks a WRONG identity
  (honest-NULL beats misidentification).

## Receipt-field → column mapping

### `frames`

| column | source field | notes |
|---|---|---|
| `receipt_sha256` | sha256(receipt bytes) | PK |
| `schema_version` | `version` (string) or `'none'` | partition key |
| `receipt_kind` | classifier | `solve` \| `no_solve` \| `render_fixture` \| `calibration` \| `render_wiring` \| `unknown` |
| `source_root` | discovery | `D_artifacts` \| `Kmain` \| `Krest` |
| `receipt_path` / `receipt_basename` / `receipt_bytes` | file | path relative to root |
| `input_basename` | receipt basename minus `.receipt.json` / `.blind`/`.baseline`/`.native` | |
| `frame_sha256` / `identity_basis` / `frame_identity_fallback` | `frame_sha256` | see Frame identity |
| `engine_version` | `reproducibility.engine_version` | |
| `engine_build_identity` | `reproducibility.build_identity` | JSON text |
| `effective_config_hash` | `reproducibility.effective_config_hash` | distinguishes same-frame config variants |
| `solved` | `solution.ra_hours` finite AND kind≠`no_solve` | BOOLEAN |
| `solved_via` | `solve_provenance.solved_via` | e.g. `blind` |
| `source_format` | `source_format` / `metadata.source_format` | CR2/FITS/… |
| `decoder_arm` | `pipeline_provenance.decoder_arm` / `reproducibility.decoder_arm` | |
| `atlas_id` | `pipeline_provenance.atlas_id` | |
| `ra_hours` | `solution.ra_hours` (fallback `solve.ra_hours`) | **UNIT: HOURS** (internal) |
| `dec_degrees` | `solution.dec_degrees` (fallback `solve.dec_degrees`) | degrees |
| `pixel_scale_arcsec_px` | `solution.pixel_scale` (fallback `solve.pixel_scale`) | arcsec/px |
| `roll_degrees` | `solution.roll_degrees` | |
| `parity` | `solution.parity` | **VARCHAR — sign NOT asserted** |
| `confidence` | `solution.confidence` (fallback `solve.confidence`) | |
| `stars_matched` | `solution.stars_matched` (fallback `solve.stars_matched`) | |
| `fov_width_deg` / `fov_height_deg` | `solution.fov_*_deg` | |
| `mean_fwhm_px` / `mean_residual_arcsec` / `solve_time_ms` | `solution.*` | |
| `crval1_deg` / `crval2_deg` | `wcs.CRVAL1` / `wcs.CRVAL2` | **UNIT: DEGREES** (FITS boundary) |
| `confirm_status` | `confirm_status.status` (fallback `solve.confirm_status`) | e.g. CONFIRMED / INSUFFICIENT_TARGETS |
| `confirm_set_excess_z` | `confirm_status.setExcessZ` (fallback `solve.setExcessZ`) | |
| `confirm_n_targets` / `confirm_confirmed` / `confirm_set_gate_z` | `confirm_status.{nTargets,confirmed,setGateZ}` | |
| `deep_examined` / `deep_confirmed_n` / `deep_set_excess_z` / `deep_set_gate_passed` | `deep_confirmed.{examined,confirmed,setExcessZ,setGatePassed}` | |
| `camera_model` / `lens_model` / `focal_length` / `iso_gain` / `exposure_time` / `pixel_scale_meta` / `gps_lat` / `gps_lon` / `obs_timestamp` | `metadata.*` | |
| `image_width` / `image_height` | `metadata.width/height` or top-level `image_width/height` | |
| `rig` | `metadata.camera_model` → `hardware.inferred_lens` → `rig` | rig proxy for group-bys |
| `inferred_lens` | `hardware.inferred_lens` | |
| `experimental` | `experimental` (fixtures forced true) | |
| `config_overrides_present` / `config_overrides_sha256` | `config_overrides` (stable-stringify → sha256) | |
| `failure_stage` / `failure_reason` | `failure.{stage_of_death\|stage_reached, reason}` | |
| `run_timestamp` | `export_date` / `produced_at` | |
| `n_matched_stars_rows` / `n_photometry_rows` / `n_confirmed_rows` | count of extracted star rows | |
| `duplicate_path_count` | dedup | # of file paths that carried this receipt content |
| `n_clean_detections` / `n_anomaly_detections` | count of extracted detection rows | # kept / rejected raw detections (FK to `detections`) |

**Frame sky-condition columns (ADDITIVE 2026-07-17)** — the per-frame context the
`detections` tier is correlated against. Source block is `signal` on solve
receipts (full detector output) or the `detection` SUMMARY block on no-solve
receipts (which carries only `background_level` / `noise_floor` / `culling_tally`
— its `clean_stars`/`anomalies` are COUNTS, not arrays). Fields absent from the
detection block are honest-NULL.

| column | source field | notes |
|---|---|---|
| `background_level` | `signal.background_level` ?? `detection.background_level` | DOUBLE |
| `noise_floor` | `signal.noise_floor` ?? `detection.noise_floor` | DOUBLE |
| `background_level_top` / `background_level_bottom` | `signal.background_level_{top,bottom}` | signal-only; the LP vertical-gradient endpoints |
| `background_gradient` | `top − bottom` | MEASURED-derived; null if either endpoint null |
| `culling_tally_json` | `signal.culling_tally` ?? `detection.culling_tally` | JSON text; **full cull budget by reason** — a SUPERSET of the persisted `anomalies[]` (e.g. TOPOGRAPHY/LOW_SNR culls are tallied here but never persisted as anomaly rows) |
| `cfa_verdict_json` | `signal.cfa_verdict` | JSON text; `{klass,supported,phaseSpread…}` — 35 receipts, else null |
| `cfa_klass` | `signal.cfa_verdict.klass` | e.g. `mono` — sensor-mosaic verdict (sensor-issue signal) |
| `milky_way_present` | `signal.milky_way` | BOOLEAN present flag = `length>0` (the field is an ARRAY of `{x,y,brilliance}` hotspots); null when not measured |
| `milky_way_n_hotspots` | `signal.milky_way.length` | # detected milky-way hotspots |
| `grid_w` / `grid_h` / `cell_size` | `signal.grid_w` / `grid_h` / `cell_size` | detector background grid; signal-only |

### `stars` (long — role-tagged union)

`star_role` ∈ {`matched`, `photometry`, `confirmed`}. Per-role source of each
unified column:

| column | `matched` (`solution.matched_stars`) | `photometry` (`solution.photometry.stars`) | `confirmed` (`deep_confirmed.confirmed_stars`) |
|---|---|---|---|
| `catalog_id` | `gaia_id` | `gaia_id` | `gaia_id` |
| `name` | `name` | — | — |
| `ra_deg` / `dec_deg` | `ra_deg` / `dec_deg` | — | — |
| `x_px` / `y_px` | `x` / `y` | `x` / `y` | `x` / `y` |
| `flux` | `flux` | `flux` | `flux` |
| `flux_err` | — | `flux_err` | — |
| `fwhm_px` | `fwhm` | — | — |
| `mag_catalog` | `mag` | `cat_mag` | — |
| `mag_measured` | — | `calibrated_mag` | `mag` |
| `mag_instrumental` | — | `m_inst` | — |
| `cat_band` | `cat_band` | `cat_band` | — |
| `bv` | `bv` | `cat_bp_rp` | — |
| `measured_bv` | `measured_bv` | `measured_bv` | — |
| `snr` | — | `snr` | `snr` |
| `calibrated_mag_err` / `calibrated_status` | — | `calibrated_mag_err` / `calibrated_status` | — |
| `provenance` | — | `provenance` | — |
| `residual_arcsec` / `dx_px` / `dy_px` / `dra_arcsec` / `ddec_arcsec` | `residual_arcsec` / `dx_px` / `dy_px` / `dRA_arcsec` / `dDec_arcsec` | — | — |
| `airmass` / `alt_deg` | — | `airmass` / `alt_deg` | — |
| `confidence` / `sigma_e` | — | — | `confidence` / `sigma_e` |
| `detected_native` | `detected_native` | — | — |
| `peak_rgb_json` | `peak_rgb` (JSON) | — | — |
| `tests_json` | — | — | `tests` (JSON) |

`frame_sha256` is denormalized onto each star row (the cross-frame per-star join
key — the supernova-lab time-series model).

### `detections` (raw pre-match detections)

One row per `signal.clean_stars` entry (KEPT, `kept=true`) and per
`signal.anomalies` entry (REJECTED, `kept=false`) across all receipts that carry
the full detector arrays (129 receipts in the current corpus; the ~74 no-solve
receipts carry only a `detection` COUNT block and contribute zero detection rows —
honest absence). Fixtures/calibration receipts have no detector output. The
analytical core is `matched`: the candidate light-pollution / nebulosity / noise /
transient population is the **kept-but-unmatched** set.

| column | source field | notes |
|---|---|---|
| `receipt_sha256` | sha256(receipt bytes) | FK to `frames` |
| `schema_version` | `version` | partition key |
| `frame_sha256` | `frame_sha256` | denormalized frame identity (cross-frame join key; null when frame identity is path+size fallback) |
| `detection_index` | array position | index within its role array (clean or anomaly) |
| `detection_id` | `id` | receipt-native detection id (VARCHAR) |
| `x` / `y` | `x` / `y` | detection centroid, native pixels |
| `raw_x` / `raw_y` | `rawX` / `rawY` | pre-refinement raw centroid |
| `flux` / `peak` / `peak_value` | `flux` / `peak` / `peak_value` | `peak` = raw peak, `peak_value` = detector peak metric (both carried) |
| `fwhm` / `snr` / `sharpness` | `fwhm` / `snr` / `sharpness` | |
| `circularity` / `ellipticity` / `theta` | `circularity` / `ellipticity` / `theta` | shape metrics |
| `moment_fwhm_px` / `moment_ellipticity` | `moment_fwhm_px` / `moment_ellipticity` | second-moment shape |
| `measured_bv` | `measured_bv` | per-detection color index |
| `mie_index` / `rayleigh_index` | `mie_index` / `rayleigh_index` | scatter proxies (KEPT only; anomalies lack them → null) |
| `peak_rgb_json` | `peak_rgb` | JSON text `[r,g,b]` |
| `kept` | classifier | BOOLEAN — `true`=clean_stars, `false`=anomalies |
| `culling_reason` | `culling_reason` | WHY culled (anomalies only; null when `kept`) |
| `matched` | positional join | BOOLEAN — see below |

**`matched` derivation.** A kept detection is `matched=true` iff a
`solution.matched_stars` entry sits within **`DETECTION_MATCH_TOL_PX = 1.0` px**
(Euclidean) of its `(x,y)`. Tolerance chosen from a measured 6-frame / 6-rig
sample where the nearest-neighbour distance from each matched star to its clean
detection was **< 0.1 px** (`matched_stars` carry the exact detection centroid) —
so 1.0 px is a ~10× safety margin. Anomalies are always `matched=false`. The join
is per-receipt via a spatial hash. `matched=false & kept=true` = the candidate
non-catalog population.

**`culling_tally` vs `anomalies[]` (important).** `frames.culling_tally_json` is
the FULL cull budget by reason and is a strict SUPERSET of the persisted anomaly
rows: in this corpus the `anomalies[]` array is dominated by `DEDUPLICATION`
(44,998) with a few `CIRCULARITY` (12), while `culling_tally` also counts
`TOPOGRAPHY`, `LOW_SNR`, `SHARPNESS`, `ELLIPTICITY`, `FWHM_FLOOR`, `PLANET`,
`SATELLITE` culls that were never serialized as individual anomaly detections. Use
`detections` for per-detection analysis and `frames.culling_tally_json` for the
aggregate rejection budget.

### `quad_verdicts` (frame-level quad-gen verdict)

One row per receipt that carries a `quad_gen` block (the schema-2.29.0 [QUAD-GEN]
forensics SUMMARY of the LEVER-2 blind generate→judge rung — `package.ts`
`buildQuadGenBlock`). Receipts WITHOUT the block produce **no row** (honest
absence, logged as a count by the ETL/drain: 321/406 in the current backfill).
Provenance columns (`decoder_arm` / `effective_config_hash` / `config_overrides_*`
/ `solved` / `solved_via` / `rig` / `atlas_id`) are reused from the frame flatten;
`receipt_path` carries the A/B **arm** directory (e.g. `arm_fullstack_uw/…`).

| column | source field | notes |
|---|---|---|
| `receipt_sha256` | sha256(receipt bytes) | FK to `frames` |
| `schema_version` | `version` | partition key (all quad_gen ≥ `2.29.0`) |
| `frame_sha256` | `frame_sha256` | denormalized frame identity |
| `source_root` / `receipt_path` / `receipt_basename` / `input_basename` | discovery | `receipt_path` carries the **arm** dir |
| `decoder_arm` / `atlas_id` / `rig` / `effective_config_hash` / `config_overrides_present` / `config_overrides_sha256` / `solved` / `solved_via` | frame flatten | config/arm provenance where recorded |
| `qg_pass` | `quad_gen.pass` | `hint` \| `full` |
| `qg_capture_mode` | `quad_gen.capture.mode` | `full` \| `slim` (slim ⇒ `n_clusters`=0, no cluster rows) |
| `verdict_accept` | `verdict.accept` | SHADOW verdict (W4-apply lives in `acceptance_*`) |
| `verdict_reason` / `verdict_mode` | `verdict.reason` / `verdict.mode` | e.g. `BUDGET_TRUNCATED` / `truncated` |
| `verdict_top_anchored` / `verdict_second_anchored` / `verdict_margin` | `verdict.{top_anchored,second_anchored,margin}` | nullable |
| `verdict_k` / `verdict_m` / `verdict_unopposed_floor` / `verdict_n_distinct` | `verdict.{K,M,unopposed_floor,n_distinct}` | |
| `hint_fallthrough_reason` / `hint_fallthrough_top_anchored` | `verdict.hintFallthrough.{reason,top_anchored}` | present only on hint→full fallthrough |
| `acceptance_present` | `acceptance != null` | BOOLEAN — false under shadow-only |
| `acceptance_attempted` / `acceptance_accepted` / `acceptance_reason` / `acceptance_arbiter` | `acceptance.{attempted,accepted,reason,arbiter}` | nullable |
| `acceptance_verify_matched` / `_confidence` / `_ra_hours` / `_dec_degrees` / `_pixel_scale` | `acceptance.verify.*` | **`ra_hours` = HOURS** |
| `acceptance_sanity_ok` / `_fail` / `_scale` / `_foot_drift_deg` | `acceptance.sanity.{ok,fail,scale,footDriftDeg}` | Option-A geometric-sanity detail |
| `index_release` / `index_bands` / `index_stars` / `index_quads` | `index.*` | quad-index provenance |
| `budget_spent_ms` / `budget_limit_ms` / `budget_truncated` | `budget.*` | |
| `n_clusters` | `quad_gen.clusters.length` | # judged clusters captured (0 in slim mode) |

### `quad_clusters` (per judged cluster — the odds evidence)

One row per judged cluster (`quad_gen.clusters[]`, FULL capture mode only). The
`odds` / `odds_v2` / `odds_v3` shadows ride only when their `SOLVER_QUAD_GEN_ODDS*`
flags are on and are **honest-NULL** otherwise (in the backfill: 2813/2813 carry
`odds`, 1307 carry `odds_v2`, 0 carry `odds_v3`). Frame-verdict context
(`qg_pass` / `verdict_accept` / `verdict_reason`) is denormalized for per-cluster
filtering without a join.

| column | source field | notes |
|---|---|---|
| `receipt_sha256` | sha256(receipt bytes) | FK to `frames` / `quad_verdicts` |
| `schema_version` | `version` | partition key |
| `frame_sha256` | `frame_sha256` | denormalized frame identity |
| `source_root` / `receipt_path` / `input_basename` | discovery | `receipt_path` carries the **arm** dir |
| `decoder_arm` / `effective_config_hash` / `rig` | frame flatten | config/arm provenance |
| `qg_pass` / `verdict_accept` / `verdict_reason` | frame verdict | denormalized context |
| `cluster_index` | array position | position within `clusters[]` |
| `foot_ra_deg` / `foot_dec_deg` | `foot_ra_deg` / `foot_dec_deg` | **UNIT: DEGREES** (quad-gen deg-space) |
| `parity` | `parity` | **INTEGER raw ±1 — sign NOT asserted** |
| `scale` | `scale` | arcsec/px |
| `votes` / `anchored` | `votes` / `anchored` | |
| `pose_present` | `pose != null` | BOOLEAN — false when the cluster did not refine |
| `crval_ra_deg` / `crval_dec_deg` | `pose.crval[0]` / `[1]` | **UNIT: DEGREES**; null when `pose` null |
| `crpix_x` / `crpix_y` | `pose.crpix[0]` / `[1]` | null when `pose` null |
| `cd_json` | `pose.cd` | 2×2 CD matrix as JSON text |
| `odds` | `odds` | `SOLVER_QUAD_GEN_ODDS` shadow (null when flag off) |
| `odds_v2` | `oddsV2` | SIGNED V2 shadow (predicted-but-missing catalog stars subtract) |
| `odds_v3` | `oddsV3` | a.net-COMPLETE V3 shadow (conditional ⇒ null) |

**Sanity (bar-recalibration reproduction).** Restricting `quad_clusters` to the two
`arm_fullstack_*` arms and replaying the w5 oracle-label footprint classification
reproduces the desk study EXACTLY: 1254 clusters (23 truth / 1231 false),
`max(false odds_v2)` = **199.22359881965082**, `min(truth odds_v2)` = 1959.60,
signed gap 1760.38 — i.e. the parquet carries the odds evidence to full IEEE
precision.

### `crashes`

`crash_sha256`, `source_root`, `crash_path`, `crash_basename`, `kind`, `schema`,
`input`, `receipt_expected`, `status`, `signal`, `error_code`, `timed_out`,
`stderr_first_error` (first error-ish line, ANSI-stripped), `stderr_tail_full`
(ANSI-stripped, ≤4000 chars), `timestamp` — direct from the `crash_record/1` shape.

## Flatten judgment calls / fields that resisted flattening

- **`psf_field` is NOT per-star** in the current schema — it carries binned
  `regions` aggregates (`n`, `fwhmMedianPx`, `ellipticityMedian`,
  `orientationMedianDeg`), not per-star rows. Per-star PSF info lives in
  `matched_stars.fwhm` (captured as `stars.fwhm_px`). `psf_field.regions` is left
  as receipt-level aggregate, not forced into the star table.
- **Raw detections split into their own tier (2026-07-17).** `signal.clean_stars`
  / `signal.anomalies` (the source of the multi-MB blind receipts) are raw
  pre-match detections, not catalog-grade per-star products — they stay OUT of
  `stars` (which remains the catalog product model) and instead populate the
  dedicated `detections` table. On no-solve receipts these arrays degrade to a
  `detection` COUNT block (`detection.clean_stars` is a NUMBER, not an array), so
  those receipts contribute zero detection rows — honest-absent, never fabricated.
- **`peak_rgb` / `mie_index` / `rayleigh_index` on detections.** `peak_rgb` kept
  as JSON text; `mie_index`/`rayleigh_index` exist only on kept detections
  (`clean_stars`), never on anomalies → null there.
- **`config_overrides` is null even for genuine config variants.** The CR2 variant
  family (vign on/off, iterBC pins) has `config_overrides_present=false` yet
  distinct `effective_config_hash` — the config distinction was carried in
  `effective_config_hash` / env flags, not the top-level `config_overrides` object.
  Both are captured; use `effective_config_hash` to tell same-frame variants apart.
- **`peak_rgb` / `tests`** are kept as JSON text (`peak_rgb_json`, `tests_json`)
  rather than exploded into columns.
- **`render_wiring`** receipts have no self-solve; `solved=false` even though
  `ra_hours`/`confirm_status` columns are populated from their referenced `solve`
  block (honest — the render check did not itself solve).

## R2 target

- Bucket `community-database` (owner-approved, NON-public), prefix
  `results/v0-testdev/`.
- Credentials read from `src/engine/ui/dashboard/.env.r2` (gitignored):
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. **Values are never
  printed, logged, or written to any artifact** — `upload_manifest.json` and the
  drain's `exported.json` record only shas / keys / bytes / sha256, never secrets.
- SigV4 S3 signing + HEAD-before-PUT idempotency is lifted from
  `tools/starplates/publish_r2.mjs` (attribution in-file). Difference: this data is
  mutable TEST/DEV, so a HEAD sha mismatch is a logged overwrite, not a hard error.

## Incremental drain (`drain_to_r2.mjs`)

Ongoing auto-flow of NEW solve receipts to R2 (owner 2026-07-17) — incremental,
no full rebuild, no rewrite of existing partitions, no per-frame network coupling.

**Mechanism (partition-append).** A local **export manifest**
(`<out>/exported.json`) tracks which `receipt_sha256` / `crash_sha256` are already
in R2. Each run:
1. **Bootstraps** the exported set from R2's current contents on first run (manifest
   absent) or `--reconcile` — so the receipts the full ETL already uploaded are
   never re-exported. R2 is the source of truth; the manifest is the durable cache.
2. Enumerates receipt **roots** (`--roots <p1,p2,…>` extends the defaults: the three
   standard roots + `held149_levered_2026-07-17`), selects receipts **not** in the
   exported set, flattens them via `lib/flatten.mjs`.
3. Writes the new rows as NEW parquet files **`<table>/schema_version=<v>/data_<batchId>.parquet`**
   (and `crashes/data_<batchId>.parquet`) — a filename suffix INSIDE the existing
   partition dir. DuckDB globs `<table>/**/*.parquet` as one table, so new files =
   appended rows, **zero rewrite** of `data_0.parquet`. (The batch id is a filename
   suffix, **not** a `batch=<stamp>/` directory — a `key=value` path segment would
   inject a spurious hive `batch` column and desync the schema against the ETL's
   files. Verified: multi-file hive partitions read cleanly.)
4. Uploads ONLY the new objects (SigV4 HEAD-before-PUT), then persists the manifest.

**Idempotency.** (a) Manifest skip — already-exported receipts are not re-drained;
a re-run with no new receipts is a clean no-op. (b) `batchId` = content-hash of the
new receipt/crash sha set, so a crashed run that uploaded but failed to persist the
manifest re-produces the SAME file and the HEAD sha match skips the PUT. The
manifest persists the FULL exported set (bootstrap + prior + new) so a later
no-bootstrap run still knows the bootstrapped receipts are present.

**Two trigger layers = "all new solves flow".**
- `tools/api/harvest.mjs` spawns the drain at batch DONE (`--roots <out-dir>`),
  **NEVER-FATAL** — a drain failure (missing creds, network) is logged as
  `DRAIN_SKIPPED` and never changes the batch exit code or solve byte-behavior (the
  drain runs strictly after the solve loop; the exit code is computed before it).
  Disable with `RESULTS_DRAIN_DISABLE=1`.
- Standalone catch-all: `node drain_to_r2.mjs` over ALL default roots covers any
  receipt produced by any path (ad-hoc `run.mjs`, other checkouts) without per-frame
  coupling. Branch-agnostic regardless of where solves run.

**Full-rebuild caveat.** The full `etl_receipts.mjs` overwrites `data_0.parquet`
locally but `upload_r2.mjs` does not DELETE the drain's batch files from R2 — so
after the drain era begins, a full ETL re-run + upload would leave stale batch
files (double-count). Reconciliation: after any full ETL, delete the drain
`data_<batchId>.parquet` objects (or clear the prefix) and re-run the drain with
`--reconcile`. At current scale the drain is the ongoing path; full rebuilds are
rare reconciliation events.

**Future rider (NOT built): small-file compaction.** Partition-append accumulates
many small parquet files over time; standard lakehouse maintenance periodically
merges them per partition. Trivial at current scale; lands cleaner post-recal
schema lock.

## Reading it back (query surface)

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET r2 (TYPE s3, KEY_ID '…', SECRET '…',
  ENDPOINT '<account>.r2.cloudflarestorage.com', REGION 'auto', URL_STYLE 'path');
SELECT rig, count(*) FILTER (WHERE confirm_status='CONFIRMED') AS confirmed
FROM read_parquet('s3://community-database/results/v0-testdev/frames/**/*.parquet', hive_partitioning=1)
GROUP BY 1 ORDER BY confirmed DESC;
```

Detections tier — the candidate non-catalog (LP / nebulosity / noise) population by
scatter proxy:

```sql
SELECT CASE WHEN mie_index >= 0.8 THEN 'high_scatter' ELSE 'low_scatter' END AS band,
       count(*) FILTER (WHERE matched)     AS matched,
       count(*) FILTER (WHERE NOT matched) AS unmatched   -- candidate LP/nebulosity/noise
FROM read_parquet('s3://community-database/results/v0-testdev/detections/**/*.parquet', hive_partitioning=1)
WHERE kept GROUP BY 1;
```

Quad-gen tier — per-cluster odds spread by arm (the multi-field bar-recalibration
input; oracle truth/false labelling is applied downstream, not stored here):

```sql
SELECT regexp_extract(receipt_path, 'arm_[a-z_]+', 0) AS arm,
       count(*) AS clusters,
       max(odds_v2) AS max_odds_v2, min(odds_v2) AS min_odds_v2
FROM read_parquet('s3://community-database/results/v0-testdev/quad_clusters/**/*.parquet', hive_partitioning=1)
WHERE odds_v2 IS NOT NULL GROUP BY 1 ORDER BY clusters DESC;
```

Joined against per-frame conditions (LP gradient, background) for correlation:

```sql
SELECT f.rig, avg(f.background_gradient) AS mean_lp_gradient,
       count(*) FILTER (WHERE NOT d.matched)::DOUBLE / count(*) AS unmatched_frac
FROM read_parquet('s3://community-database/results/v0-testdev/detections/**/*.parquet', hive_partitioning=1) d
JOIN read_parquet('s3://community-database/results/v0-testdev/frames/**/*.parquet', hive_partitioning=1) f
  USING (receipt_sha256)
WHERE d.kept GROUP BY 1 ORDER BY 2 DESC;
```
