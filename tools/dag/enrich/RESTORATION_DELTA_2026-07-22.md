# Restoration delta — 2026-07-22 DAG main adoption

The interactive DAG program (`tools/dag/`) was authored on the `rest/*` restoration
branch family (merge-base with main: 2026-07-14). When it was adopted onto **main**
(owner-ordered content merge, not a branch merge — see the adoption commit), the
mechanical base (`dag_base.json`) was regenerated against main's tree, and the
semantic overlay (`enrich/enrichment.json`) was rebuilt from the fragments.

Main and restoration have diverged by tens of thousands of lines since 2026-07-14.
As a result the enrichment overlay referenced **32 distinct ids that are genuinely
absent on main** (verified via `git ls-files` and `src/engine/contracts/binary_layouts.ts`).
Every structural reference to them (node declarations, edges, and review rows that
flip those edges) was removed so the overlay describes only nodes that exist on main
— honest-or-absent is owner law, and the DAG's own edge taxonomy is built on it.
**Nothing is lost:** the full restoration-flavored graph is retained in `rest/*`
git history and in the rest-integration checkout that serves `dag.skycruncher.io`.

## What was removed (structure only)

| Metric | Before | After | Removed |
|---|---|---|---|
| enrichment.json node entries | 166 | 146 | 20 (distinct ids) |
| enrichment.json edges | 302 | 263 | 39 |
| review rows (across `review_*.json`) | 272 | 238 | 34 |
| fragment-level node-declaration removals | — | — | 29 (the 20 distinct ids, several declared in two fragments) |

Removals span **8 restoration-only subsystem families**. Per family: the member ids,
what the subsystem is, the element counts removed (node-decls / data-edges / review-rows),
and the RETURN TRIGGER (when it lands on main, restore this section from `rest/*` history
and drop its `NON_BASE_ANCHORS` exemption in `tools/dag/steps/validate_steps.mjs` so the
validator re-binds it).

### 1. Gaia-cells atlas subsystem — removed 3 node-decls · 6 edges · 6 review-rows
- `boundary:atlas_gaia_cells`
- `tools/atlas/build_gaia_cells.mjs`
- `tools/atlas/verify_gaia_cells.mjs`
- `src/engine/pipeline/m6_plate_solve/gaia_cell_source.ts`

Restoration's Gaia HEALPix-cell atlas (Arrow-IPC-per-cell producer + verifier + engine
`CellSource` consumer, plus a `binary_layouts` `atlas_gaia_cells` enumeration). **Main went
Gaia-pure sectors + a monolithic `g15u` `stars.arrow` instead** (owner ruling 2026-07-22);
this cells subsystem does not exist on main.
RETURN TRIGGER: a Gaia-cells atlas landing on main (new `atlas_gaia_cells` boundary +
producer/consumer files).

### 2. GPU quad-scoring subsystem — removed 3 node-decls · 8 edges · 5 review-rows
- `boundary:gpu_quad_scoring`
- `src/engine/pipeline/m6_plate_solve/gpu_quads/quad_build.ts`
- `src/engine/pipeline/m6_plate_solve/gpu_quads/quad_finalize.ts`
- `src/engine/pipeline/m6_plate_solve/gpu_quads/quad_scoring_backend.ts`
- `src/engine/pipeline/m6_plate_solve/gpu_quads/gpu_quads_flag.ts`
- `src/engine/pipeline/m6_plate_solve/gpu_quads/gpu_quad_backend.ts`

Restoration's GPU quad-scoring backend. The entire `src/engine/pipeline/m6_plate_solve/gpu_quads/`
directory is absent on main, and `gpu_quad_scoring` is not enumerated in main's `binary_layouts.ts`.
RETURN TRIGGER: the `gpu_quads/` dir + `gpu_quad_scoring` boundary landing on main.

### 3. Receipt-identity & reproducibility stages — removed 12 node-decls · 2 edges · 2 review-rows
- `stage:build_identity`, `stage:reproducibility`, `stage:wasm_identity`, `stage:rematch_invalidation`, `stage:receipt_schema`
- `src/engine/pipeline/stages/build_identity.ts`
- `src/engine/pipeline/stages/rematch_invalidation.ts`
- `src/engine/pipeline/stages/receipt_schema.ts`

Restoration's dedicated receipt-identity / reproducibility pipeline stages. **On main the
receipt version authority is the `RECEIPT_SCHEMA_VERSION` const in
`src/engine/pipeline/stages/schema_versions.ts` (a module, not a stage)**, and there are no
`build_identity` / `reproducibility` / `wasm_identity` / `rematch_invalidation` / `receipt_schema`
stage files. (12 declaration removals because the 5 stage ids are declared in both
`copy_f.json` and `why_d.json`, plus the 2 stage files in `wave2_stages.json`.)
RETURN TRIGGER: any of these stages landing under `src/engine/pipeline/stages/` on main.

### 4. Variance/noise + FITS-NaN LAW-7 boundaries — removed 4 node-decls · 9 edges · 9 review-rows
- `boundary:variance_map`
- `boundary:fits_nan_mask`
- `src/engine/types/frame_product.ts`
- `src/engine/pipeline/m8_photometry/noise_profile.ts`

Restoration's per-pixel variance-map and FITS-NaN-mask LAW-7 boundaries (plus the
`frame_product` type and `noise_profile` producer that carry them). **Neither boundary is
enumerated in main's `binary_layouts.ts`** — main's FITS writer preserves NaN (I1-I5) but the
mask is not a declared binary boundary, and there is no variance-map boundary.
RETURN TRIGGER: `variance_map` / `fits_nan_mask` being added to `binary_layouts.ts` on main.

### 5. Calibration & coordinate core — removed 2 node-decls · 3 edges · 3 review-rows
- `src/engine/core/master_calibration.ts`
- `src/engine/core/apparent_place.ts`
- `src/engine/pipeline/frame_context.ts`

Restoration's master-calibration + apparent-place (IAU 2006/2000B) + frame-context core
modules. None are tracked on main.
RETURN TRIGGER: these core modules landing on main.

### 6. Ingest trust splits (time / location) — removed 2 node-decls · 5 edges · 3 review-rows
- `src/engine/pipeline/m1_ingestion/time_trust.ts`
- `src/engine/pipeline/m1_ingestion/location_trust.ts`

Restoration split timestamp/site trust into dedicated stage files. **On main the equivalent
lives inline — `timestampTrusted` forensics inside `stages/ingest`, and site claims gated
inline.**
RETURN TRIGGER: dedicated `time_trust.ts` / `location_trust.ts` landing on main.

### 7. Legacy atlas generator — removed 0 node-decls · 1 edge · 1 review-row
- `tools/generate_star_atlas.ts`

The legacy star-atlas generator. **`CLAUDE.md` confirms it no longer exists on main
(verified gone 2026-07-22); main's atlas build tooling is `tools/atlas/*`.** This is a
delete, not a branch-only file.
RETURN TRIGGER: n/a (deleted, will not return); keep exempt.

### 8. Assorted restoration-only pipeline modules — removed 3 node-decls · 5 edges · 5 review-rows
- `src/engine/pipeline/m4_signal_detect/masked_background.ts` — main's live background = the deg-2 model in `signal_processor`.
- `src/engine/events/stage_records.ts` — restoration event-records module; not on main.
- `src/engine/pipeline/m10_psf/psf_physics_provider.ts` — restoration PSF-physics provider (+ its `external:prysm_sidecar` data-flow edge); not on main.
- `src/engine/pipeline/m7_astrometry/sip_gate.ts` — main's SIP/TPS gate lives in the `@252eccb` train + `src/engine/pipeline/export/sip_convention.ts`.

RETURN TRIGGER: each file landing on main under its path.

## IMPORTANT — scope of this trim (read before trusting the overlay on main)

This adoption made the graph **STRUCTURE** honest on main: every node id and edge endpoint
in `dag_base.json` + `enrichment.json` now resolves to a node that exists on main.

It did **NOT** re-verify the surviving **annotation layer**. The `why` / `how` / `copy` prose,
the `cite` paths and their **line numbers**, and the `VERIFIED` review verdicts on the ~260
surviving edges were authored and measured against the `rest/*` tree at `rest/*` line numbers.
They are carried over as-is and are **NOT re-verified against main**. Consequently some
surviving prose/cites still describe or point at restoration-tree detail — for example, the
`stages/package.ts -> binary_layouts.ts` edge's `how`/`why` still describe an
`activeAtlasGolden` selection of `atlas_gaia_cells` "default since the 2026-07-15 cutover",
whereas main reads the `atlas_rows` boundary `goldenVector` directly (no `atlas_gaia_cells`,
no `VITE_ATLAS_GAIA`). A full annotation re-verification against main is a separate audit
(registered in `docs/UNWIRED_DEBT.md`). None of this affects the drift / validate / rebuild
gates, which check structure and cite-presence, not cite-accuracy.
