# Render-Loop Closure Plan (REFERENCE, task #7 — planned 2026-07-09, seams verified)

**Framing law.** There is ONE displacement field `D(x,y)=observed−ideal`. SIP (`solution.astrometry.sip`), TPS (`.tps`), and measured-BC (`lens_distortion_measured`) are three *estimators* of that one field — **never summed**. There is ONE measured optic PSF (`psfField` from `psf_characterize.ts`); `rl_deconv.ts` today ignores it and uses a global stacked `buildEmpiricalKernel`, discarding its output into `PsfDeconvReport.tiles[].after` (panel only). Closure = feed measured optics into (a) the single render warp and (b) a measured-kernel deconv, each flag-gated, byte-identical when off, each guarded by `deep_verify.forcedMeasure` preservation. Warp seam is `ImageProcessor.applySipUndistort` → `orchestrator_session.ts:926-966` (call at `:957`; the doc-authorship `:844-869` pin drifted via later `withStage` instrumentation); the render buffer is `previewFloat32` (RGB), the measurement grid is `scienceBuffer` (luminance) — the two-ledger split (LAW 1).

## Increment I1 — Unify the warp (SIP∪TPS∪BC → one displacement, one resample)
- Generalize `applySipUndistort` into `applyRenderWarp(float32,w,h,warp,crpix,coordScale)` where `warp` yields per-output-pixel `(dx,dy)` from **exactly one** arbitrated model. **Selection, not composition:** prefer the model with the strictly-lowest post-fit residual (`tps.rms_after_arcsec` vs SIP fit RMS); BC (`lens_distortion_measured`) is fallback-only when neither SIP nor TPS present. BC and the densification it drove were **consumed by matching** (`bc_rematch`) and the final SIP/TPS were re-fit against the linear WCS on the densified set — so SIP/TPS **already carry the total residual**; adding BC on top double-corrects. Encode that as an assert, not a comment.
- **Pixel-ledger:** measurement stays upstream (native grid, untouched); warp is render-side resample of `previewFloat32` only; TPS coords are normalized `(px−crpix)/scale` — reuse the stored `scale`/`crpix`, never re-derive.
- **Integrity gate:** run `forcedMeasure` at catalog positions on the pre- and post-warp luminance; warp must not drop confirmed forced detections (positions move, flux is preserved).
- **Exit:** flag off ⇒ byte-identical `previewUrl` (same array-ref no-op path preserved); flag on with SIP-only ⇒ identical to the merged `RENDER_APPLY_SIP`; TPS-present frame ⇒ warp chosen by measured RMS, logged with source. Touches: new `RENDER_WARP_SOURCE` const (envIntOverride, default 0), reuses `sip_render_warp.test.ts` + adds TPS/BC-select cases.

## Increment I2 — measured `psf_field` → spatially-varying deconv kernel
- New `psf_field.ts` export: build the RL kernel per 3×3 region from the **measured** `regions[].fwhmMedianPx / ellipticityMedian / orientationMedianDeg` (an elliptical Gaussian per tile), replacing the global `buildEmpiricalKernel` when a measured field exists; fall back to the empirical stack (honest-or-absent) when `method==='MOMENT_FALLBACK'` or `nFit<20`.
- `rl_deconv` stays windowed/native/nebulosity-protected; the only change is the injected kernel now varies by the window's region. **Pixel-ledger:** kernel is measured upstream on native grid; deconv still runs on native luminance windows.
- **Integrity gate (the "did deconv invent stars" check):** `forcedMeasure` z-statistic on the deconvolved luminance must not exceed the native-frame acceptance beyond the on-frame scrambled base rate — deconv may sharpen real flux, never manufacture accepted detections at scrambled positions.
- **Exit:** deconv off ⇒ `psfField`/render untouched; on ⇒ receipt records `kernel.source: MEASURED_FIELD | EMPIRICAL_FALLBACK`, per-region FWHM-after ≤ FWHM-before, forced-photometry z non-inflated.

## Increment I3 — promote deconv output to REACH the render (not discarded)
- Add a wired stage that writes the per-window RL estimate back into a **render-only** copy of `previewFloat32` (star/background separation already lives in `richardsonLucyWindowProtected` — diffuse added back verbatim), composited after I1's warp so there is still **one geometric warp** then a photometric sharpen (LAW 1: "one warp max" is geometric; deconv is a PSF inverse, not a coordinate warp — keep them ordered and separately flagged).
- **Pixel-ledger:** science/measurement buffers never overwritten; only the preview render copy is sharpened.
- **Exit:** flag off ⇒ byte-identical render; on ⇒ `deep_confirmed`/forced-photometry survivor count non-decreasing, before/after FWHM logged. Touches: new `RENDER_APPLY_DECONV` const; `psf_stage.ts` gains a "commit to render" path distinct from the panel path.

## Increment I4 — pooled (rung-3) graduation
- Pixel-touching ops (I1 warp from a **pooled** model, I2 pooled-PSF kernel) graduate only at **rung 3** per `OPTICAL_WORKBENCH_SCHEMA.md`: self-measured (rung 2) may drive COORDINATE matching but pixels graduate last. Per-cell activation as per-cell variance drops.

## Sequencing vs the ladder
- **Per-frame-safe now (rung 2, this frame's own measurement):** I1 SIP/TPS/BC warp select; I2 measured-field kernel; I3 deconv-to-render. All use *this frame's* fits — no pool.
- **Pooled-tier gated (rung 3):** any warp/kernel seeded from the *rig pool* — deferred behind the Workbench persist layer + the coverage/`N_min` promotion gate. Do not ship pooled pixels before rung-3.

## Named calibrated-constant temptations → evidence path instead
1. **SIP-vs-TPS-vs-BC preference** → arbitrate by stored `rms_after_arcsec`, never a hardcoded model rank.
2. **A "sharpening strength" / iteration knob for render deconv** → bound by the `forcedMeasure` preservation z, not a fixed `iters`. Existing `iters=12`, damp `1.5σ`, ratio clamp `[0.25,4]`, `diffuseRadius=4·kR`, truncate `0.002`, kernel-star window `0.35`, `satLevel=0.85·max` are tools-verified — inherit, don't re-tune for render.
3. **Kernel FWHM/ellipticity** → from measured `psf_field.regions`, never a nominal seeing constant.
4. **`coordScale`** → `previewW/solveW` (measured), never assumed 1.
5. **`N_min` for rung-3 pooled promotion** → EVIDENCE-SET from the 2026-07-09 cross-frame convergence experiment, never vibes-set; coverage-gated, not count-gated.
6. **Deconv "trust" threshold** → the scrambled-position on-frame null in `deep_verify`, not a fixed SNR.

## Critical files
`core/ImageProcessor.ts` · `orchestrator_session.ts` · `m10_psf/rl_deconv.ts` · `m10_psf/psf_field.ts` · `m10_psf/psf_stage.ts` · `m6_plate_solve/deep_verify.ts` · `stages/psf_characterize.ts` · `types/Main_types.ts` · `constants/pipeline_config.ts` (`RENDER_APPLY_SIP` + new flags) · `docs/OPTICAL_WORKBENCH_SCHEMA.md` (rung-3 law).

## Related
- [Optical Workbench Schema](../OPTICAL_WORKBENCH_SCHEMA.md) — defines the rung-3 pooled-promotion gate this plan's Increment I4 waits on
- [Color Math Program](../COLOR_MATH_PROGRAM.md) — sibling render-loop-closure program, same "measured, stored, then applied" pattern for color
- [CARD: Photometry & Statistics](../reference/CARD_PHOTOMETRY_STATS.md) — the LM PSF fit and RL deconv math this plan's Increment I2/I3 wire into render
- [CARD: Astrometry & WCS](../reference/CARD_ASTROMETRY_WCS.md) — SIP/Brown-Conrady math this plan's Increment I1 arbitrates between
