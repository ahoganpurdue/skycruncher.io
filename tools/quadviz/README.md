# quadviz — per-iteration overlay PNGs

Owner directive 2026-07-18 (`docs/local/QUADVIZ_ITERATION_PNG_SPEC_2026-07-18.md`):
when the iterative quad-matching + forced-harvest loop runs, emit a **full-resolution
PNG per iteration** showing the harvested/verified stars (by class) + quad lines, so the
owner can **SEE when the harvest starts picking up noise** — human eyes-on as the
harvest-depth arbiter alongside the statistical gates. RENDER plane only (LAW 1):
overlays draw on the aesthetic STF render, never raw luma; this consumes banked records
and feeds nothing back.

## The two-half pipeline

1. **Emit** (write half) — `tools/quadviz/emit_iteration_records.mjs`
   *(lives on the `rest-integration` checkout; merges to main with the 2.29.0 branch).*
   Serializes the iterative-BC loop's per-pass `QuadvizIterationRecord`s
   (`src/engine/pipeline/stages/iterative_bc_record.ts`) into
   `<root>/quadviz_<runId>/manifest.json` + `iter_NNN.json`.

2. **Render** (read half) — `tools/quadviz/render_iterations.mjs` *(this checkout)*
   Consumes the emitter's `manifest.json` + `iter_NNN.json` and the source frame,
   produces one overlay PNG per iteration.

`render_overlay.mjs` is the earlier **single-frame** v0 (proves the visual language on
one banked record); `render_iterations.mjs` is the **multi-iteration** wiring of the
whole loop and supersedes it for loop runs.

## One-command invocation (drop-in for the future live run)

```sh
node tools/quadviz/render_iterations.mjs \
  --records <emitter-output>/manifest.json \
  --image   <source .fit/.fits/.cr2> \
  --wcs     <receipt.json> \
  --out     <run-dir>/render_iterations
```

- `--records` accepts the emitter `manifest.json`, the emitter **directory** (auto-finds
  `manifest.json`, else globs `iter_*.json`), or a bare records JSON (array /
  `iterQuadvizRecords` / `records` / `iterations`) — same tolerance as the emitter.
- `--image` decodes ONCE; every iteration re-bakes its canvas from the shared STF gray
  buffer (FITS via `readLuminanceNormalized`; CR2 via the Bayer decode lane).
- `--wcs` is optional — legend provenance (CRVAL/scale) + footer `SOLVE MATCHED` /
  `RESIDUAL RMS`. Absent ⇒ those read `NOT MEASURED`. Positions are always **recorded
  pixels, no reprojection** (sidesteps the crval-hours and y-down-parity traps).
- Outputs: `render_iter_NNN.png` + `render_iter_NNN.quadviz.json` (provenance sidecar) +
  `render_iter_render_manifest.json`. Big files land on `D:` per the K: thin-disk law.

## Overlay encoding

- **Stars by harvest class**: GOLD = new-this-iteration (+ a plus-marker spotlight,
  since new-at-low-bound is the noise/growth signal) · GREEN = redetected ·
  RED = below-bound (forced-tested, refused at this depth). Size scales with measured
  significance (global log10 range across passes so growth is comparable frame-to-frame;
  when SNR saturates, sizes go uniform and the footer says so — honest null).
- **Radial coverage** (owner's outward-growth metric, made visible): dim annulus grid at
  R 0.2…1.0 (half-diagonal-from-centre convention, matching the BC radial basis) + a
  BRIGHT CYAN ring at `maxNormRadius` — the outermost verified star that pass.
- **Footer**: pass N of M, bound, new/redet/below/total, max verified r_norm + expanding
  flag, per-annulus coverage, projection + significance model, stop reason, solve
  matched + residual rms, quad count. `NOT MEASURED` wherever a substrate is absent
  (quad lines are empty until the `quad_gen` receipt block lands with 2.29.0).

## Proven on (banked, byte-identical-content M66 run)

```sh
node tools/quadviz/render_iterations.mjs \
  --records "D:/AstroLogic/test_artifacts/quadviz_iterloop_m66_2026-07-18/manifest.json" \
  --image   "Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit" \
  --wcs     "D:/AstroLogic/test_artifacts/iterloop_m66_2026-07-18/receipt.json" \
  --out     "D:/AstroLogic/test_artifacts/iterloop_m66_2026-07-18/render_iterations"
```

4 iterations rendered in ~4 s (2160×3840). Pass 0 (bound 5σ) shows 4 GOLD new + 174
GREEN redetected, max-verified ring R=0.984; passes 1–3 (bound 4/3/2σ) show **zero
gold** — no new stars at lower bounds, `STOP: NO_NEW_HARVEST`. That flat null is
*honest*: `deep_forced`'s 8-bit-preview SNR saturates, so nothing new appears — the
sub-2σ forced probe (WIRED-NEXT) is what will make noise-onset actually visible on the
owner-gated live run, and this renderer drops straight into it.
