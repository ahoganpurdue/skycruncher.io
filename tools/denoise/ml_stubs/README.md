# ML plug-in stubs — render-layer, DEFAULT-OFF, ethos-typed seams

**solve/verify path stays ML-free; render-layer post-solve only.** These are
*real, type-correct, UNCALLED* stubs. Every op body throws
`NOT_IMPLEMENTED: ML variant — deterministic-first; gated by preservation proof; DEFAULT OFF`,
so an ML op can never silently run, and its signature forces it — at the type
level — to declare an epistemic type, carry provenance that traces to real
capture, and ship a machine-checkable `PreservationProof`.

They exist to make the future plug-in points explicit and to encode the ethos
in the type system now, so the deterministic-first discipline is enforced by the
compiler rather than by convention.

## The contract (`types.ts`)

| Type | Role |
|---|---|
| `EpistemicType` = `MEASURED \| VERIFIED_PRESERVING \| AESTHETIC` | PROVENANCE §2 layer typing of every pixel op |
| `PreservationProof` | flux_conservation · astrometric_invariance · reconvolution_residual · forced_photometry_recheck (PROVENANCE §4.2) |
| `MlProvenance` | model_hash · training_data_provenance · `traceable_to_real_capture: true` (REQUIRED) |
| `EnhancementOpResult` | `{ epistemic_type, params, preservation_proof, provenance?, label }` |
| `classifyEpistemic(proof)` | the single choke-point: **AESTHETIC unless every applicable proof metric passes → VERIFIED_PRESERVING** |

`classifyEpistemic` + `emptyProof` guarantee the default is AESTHETIC: an op that
has not proven preservation cannot wear a measurement-grade label.

## The three stubs → doc section → eventual ENGINE seam

| Stub | Research doc | Method (deterministic-first, ML as the gap-closer) | Plugs into (engine seam) |
|---|---|---|---|
| `denoise_ml.ts` | §5.2(1) | **Noise2Noise** on the user's own independent sub-frame pairs (no clean target); output + a deviation-map asserted noise-like (\|dev\| ≤ measured σ). Self2Self/TDR restoration-bound + ASTERIS noted. | **this lane, `tools/denoise/`** — ML arm beside the deterministic GAT+starlet default |
| `star_extract_ml.ts` | §4.2 | **Synthetic-injection U-Net** (PSF-model stars into REAL starless data = known ground truth); **L1/perceptual loss ONLY, NO adversarial**; outputs starless+stars; recombine via screen blend `1−(1−stars)(1−starless)`. | render-layer **`tools/starsep/`** (detection stays in `m4_signal_detect`) |
| `blur_ml.ts` | §3.2 | **PSF-conditioned unrolled deconvolution** (learned ADMM/ISTA); the MEASURED LM PSF field is an EXPLICIT input (not blind); **re-convolution residual gate mandatory**. | extend **`m10_psf/rl_deconv.ts`** / **`tools/psf/`** |

## Where these fit in the whole system

- **Deterministic first, always.** Each capability ships a deterministic,
  gated, fully-receipted op before its ML arm (research doc Recommendations,
  phased roadmap). The ML op only closes the residual quality gap and is always
  DEFAULT-OFF + labeled.
- **The preservation proof reuses existing engine machinery.** The
  `forced_photometry_recheck` metric is the existing
  `m6_plate_solve/deep_verify.ts` + `forced_confirm.ts` forced photometry run
  pre/post the op — **no new science needed**. (Caveat: that set-gate is
  N=1-calibrated / SeeStar-only today, so V-layer claims inherit that
  limitation until it is re-validated across instruments — PROVENANCE §8.6.)
- **The overnight loop is the OFFLINE factory**, not a live-solve dependency:
  it mints the training data (sub-frame pairs / real starless bases / synthetic
  degradations of the user's own high-SNR stacks) and runs the forced-photometry
  validation harness that gates promotion. It never sits in the solve path.

## Non-negotiables encoded here

- **DEFAULT-OFF** (`enabled` must be explicitly set; `DEFAULT_OFF = false`).
- **`epistemic_type` is AESTHETIC unless the `PreservationProof` passes.**
- **Provenance REQUIRED** for every ML op, and must trace to real capture.
- **Deviation-map / re-convolution-residual gate REQUIRED** before any
  measurement-grade label.
- **Measurement never runs on ML-altered pixels** — these are render-layer,
  post-solve ops; the two sacred regressions stay byte-identical by construction.
