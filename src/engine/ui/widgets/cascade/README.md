# Flattening Cascade — 3D displacement widgets (phase-2)

Two render-layer widgets that visualise a receipt's fitted **coordinate**
functions as rotatable, zoomable, ramp-coloured WebGL surfaces. Pure render (UI
ledger) — they read already-collected receipt blocks and assert nothing about
pixels or the solve.

| File | Role |
|---|---|
| `cascade_math.ts` | PURE displacement evaluators (SIP / TPS / Brown-Conrady) + N×N grid + stats. TPS forward is IMPORTED from the engine's shared `tps_eval` (no duplicated logic); BC via the engine `makeBrownConradyDistortion`; SIP polynomial transcribed + pinned by the unit test. |
| `cascade_data.ts` | `selectCascade` (cheap pure selector, receipt→5 stage specs, present/absent) + `buildStageField` (single source of the per-stage grid, used by the component AND the harness). |
| `tokens.ts` | Reads the design-system CSS vars (sequential ramp `--chart-seq-1…5`, palette) into WebGL RGB, live + theme-aware. No hardcoded hex. |
| `webgl_surface.ts` | Hand-rolled **WebGL2** surface engine: orbit / zoom, GPU morph between two fields, derivative-shaded, ramp-coloured. Shared by both widgets. |
| `CascadeExplorer.tsx` | Stages Original → nominal BC → measured BC → SIP → TPS; stage tabs (greyed ∅ for NOT MEASURED), animated morph on step, real max/rms labels. |
| `LensProfile3D.tsx` | Same engine; FWHM / ellipticity / vignette field surfaces from `psf_field` + `hardware.vignette_v1`; greyed future "Defects" slot. |

Unit tests: `src/engine/tests/cascade_math.test.ts` (pure math + selector; the
node-suite include glob only picks up `src/engine/tests/**`).

Standalone harness + screenshots: `tools/widgets/capture_cascade.mjs` →
`test_results/widget_review/cascade/*.png` (carries a plain-JS MIRROR of the
`cascade_math` formulas — no bundler/tsx exists to import the TS into the inline
HTML; keep the two in sync, anchored by the unit test).

## Honest-or-absent

For a telescope frame (e.g. SeeStar M66) the nominal + measured Brown-Conrady
stages are **absent** (no lens prior resolves) — the widget greys those tabs and
shows `NOT MEASURED`. SIP + TPS are the real fitted models. No stage is ever
fabricated to look "flattened".

## Registry wiring (landed)

Both widgets are registered in `src/engine/ui/widgets/registry.ts`:
imports at `:41-42`, WIDGETS entries at `:209-210`
(`cascadeExplorerWidget` id `flattening_cascade`, `lensProfile3dWidget` id
`lens_profile_3d`, both `weightTier:'heavy'`).

Both expose the standard `WidgetManifest` contract (`id`, `title`,
`dataSelector`, `weightTier`, `render`); the dock's frame-level NOT MEASURED
state already covers a null selector (no receipt geometry / no psf_field).
