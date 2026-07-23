# tools/atmosphere — Atmospheric Measurement Core (lane)

Incubator (Law 4) for the **photometric extinction vertical** and its dependencies,
per `docs/ATMOSPHERE_SEXTANT_SPEC.md`. Everything here is a `tools/` measurement
lane — **zero `src/` diffs**. The engine port (a post-solve additive stage) is
increment 12, owner-gated, POST-GRADUATION only.

Ethos: **EVIDENCE-ONLY**. Every number is MEASURED from actual pixels/output or is
explicitly `NOT MEASURED` with its failed predicate named. No fabricated values.

---

## ⛔ NEVER-TOUCH QUARANTINE (the pre-existing FAKE Environmental Forensics layer)

The auto-path carries hardcoded/placeholder atmospheric fields that this lane must
**never read, write, reference, or overwrite**. The honest measured products land
in NEW lane JSON (and, at increment 12, a NEW additive receipt block) — the fake
`aerosol_optical_depth=0.1` is retired by a *separate* owner-gated cleanup, not here.

| File | Locus | What it is (quarantined) |
|---|---|---|
| `src/engine/pipeline/orchestrator.ts` | :1020, :1025 | environmental-forensics block (fake aerosol/skyglow assembly) — **FILE DELETED @5f76bdd** (auto path removed 2026-07-09); row kept for history, no live locus |
| `src/engine/types/schema.ts` | :355–361 | schema slots for the fake environmental fields |
| `src/engine/types/Main_types.ts` | :431 | `scattering_type` constant (`'RAYLEIGH'` hardcoded) |
| `src/ui/.../AnalysisPanel.tsx` | :388–404 | UI that renders the fake `0.10` AOD etc. as if measured |

**Rule:** the honest AOD (increment 6) is computed in this lane's own JSON and never
touches `aerosol_optical_depth`. Grep-checkable: this lane references none of the
above symbols.

---

## TWO LEDGERS (owner Law 1) — strictly separated in every tool here

- **COORDINATE ledger** (no pixels touched): catalog RA (**HOURS** internally) →
  gnomonic TAN about the solved anchor → anchored rotation/parity → NATIVE pixel;
  alt/az/airmass/zenith math. `crval[0]`/catalog RA = HOURS; degrees only at the
  FITS boundary.
- **PIXEL ledger** (native grid, no resample): forced matched-aperture photometry
  and local-annulus backgrounds on the decoded R/G/B planes. PSF/flux measured on
  the NATIVE grid — never resample before measurement.

Catalog **band is per-row** (Gaia G vs HYG Johnson V) and **never pooled** — a
G−V offset of 0.1–0.3 mag would masquerade as photometric scatter. Band is derived
from the adapter's `gaia_id` prefix (`Gaia_*` → `GaiaG`, `HYG_*` → `JohnsonV`;
`star_catalog_adapter.ts:313`).

---

## INITIAL ENGINEERING VALUES (Law 2 — flag, don't tune; change only by adding evidence)

Every threshold below is an **initial engineering value** recorded for grading. None
was tuned to make anything pass. Changing one requires *added evidence*, never a
convenience nudge.

| Constant | Value | Meaning / source |
|---|---|---|
| `MAG_LIMIT` | 7.0 | catalog magnitude ceiling enumerated in the footprint |
| `MATCH_BASE_PX` | 15.0 | widenet base match radius (solver `baseNetPx`) |
| `MATCH_SLOPE` | 0.035 | widenet radius growth per px-from-center (solver widenet) |
| `SAT_FRAC` | 0.70 | aperture-peak saturation cut, fraction of per-channel plane max |
| `EDGE_MARGIN_AP` | 1 | edge cut, in aperture radii (forcedMeasure already guards) |
| `MAD_K` | 1.4826 | MAD→σ (normal-consistent) |
| `MIN_BIN_N` | 8 | min stars/mag-bin to report a σ (else bin marked sparse) |
| `SNR_MIN` | 3 | forcedMeasure acceptance SNR (report is over the accepted set) |
| `FETCH_DEG` | 22.7 | catalog-fetch radius about the anchor (solver `[PATCH]` log) |

**σ_star exit interpretation (the number the whole atmospheric program rescales on):**
if σ_star lands ~0.10–0.20 mag the downstream Fisher/N budgets in the photometric
design hold; if it lands ≳0.3 mag, every downstream N requirement rescales *before*
increment 2 proceeds (spec increment-1 Risk clause).

---

## Solved WCS for the bundled CR2 (do NOT re-solve differently)

Bundled frame: `public/demo/sample_observation.cr2` (Canon EOS Rebel T6 + Rokinon
14mm, LYING 50mm EXIF → 14mm override). The sacred CR2 e2e solves it (RA 17.5858h
frame-center / 63.211"/px / 55 matched). The **internal anchor-based** representation
used by the ultra-wide solver (and reused here verbatim, NOT re-derived) is:

| param | value | provenance |
|---|---|---|
| `ra0` (anchor RA, HOURS) | 17.264 | `test_results/bc_profile_transfer/apply_sample_observation.json` best verify pass (17.264h/−22.5:+11.15σ, 63m) |
| `dec0` (anchor Dec, deg) | −22.5 | same |
| `scale` ("/px, native) | 63.352821428571424 | apply JSON `scale_arcsec_px` |
| `theta` (deg) | 157.7 | `test_results/uwh/ab_sample_observation.log:78` UW-sweep peak (θ=157.7, parity=1, 62/109 bright, +8.6σ) |
| `parity` | 1 | same (parity DERIVED by the solver, not asserted here) |
| anchor px | brightest detection | Jupiter (bloomed) — same anchor the solver uses |
| BC prior | k1=0.032894, k2=0.002014 | pooled beach-CR2 measured prior (apply JSON) |

`theta`/`parity` are additionally **recovered** by a self-search that maximizes
widenet detection-matches at the *fixed* (ra0,dec0,scale) — this reproduces the
solver's peak (validation), it is **not** a re-solve of position or scale.

### CR2 decode source (existing cache — no new decoder built)

Node-side CR2 decode exists (`tools/psf/decode_cr2.mjs`, libraw-wasm worker-shim),
but this lane consumes the **existing decode cache** from tonight's PSF runs:

- `test_results/psf/beach_measured/.decode_cache_sample_observation.cr2.bin`
  (`PSF2` magic + 12-byte header + interleaved **Uint16 RGB16 mem_image**,
  5202×3464×3; dominant-channel mosaic, ~4–7% cross-leak, NOT one-hot, NOT CFA-raw).

Demosaiced to native R/G/B Float32 planes via `tools/psf/decode_cr2.mjs`
`detectPattern` + `demosaicBilinear` (bilinear, linear camera-native, no WB/matrix).
Detections in `sample_observation.app.json` are in **native** 5202×3464 coords, so
plane index = `y*w + x` directly (no science-binning remap).

---

## Method (measure_sigma_star) and DELIBERATE DEVIATIONS from the spec letter

Procedure follows spec increment 1 (a)–(i). Deviations, each justified + documented:

1. **Localization to the matched-detection centroid before forced photometry.**
   Spec (d)/(e) reads as forced photometry at the *projected* catalog position. The
   14mm ultra-wide linear anchor-WCS has a **~11–15 px residual** (refit RMS,
   `refit_sample_observation_*.json`) — far larger than the ~2 px aperture — so a
   naive projected-position aperture would sample background for most stars and
   inflate Δm into projection noise (the exact corruption the orchestrator warned
   of). Each catalog star is therefore projected (anchor-WCS; the ~0.03 BC residual
   is absorbed by the widenet tolerance rather than applied explicitly — it only
   affects *which* detection matches, never the flux measured at its centroid),
   **widenet-matched** to the detection list, and forced photometry runs at the
   matched **detection centroid**.
   This is the same correspondence the solver's matched_stars encode; unmatched
   catalog stars are excluded and counted honestly. Per-channel flux is genuinely
   new (the dump carries only single luminance).
2. **forcedMeasure** is imported from the **real engine** function
   `src/engine/pipeline/m6_plate_solve/deep_verify.ts` (spec-named), driven through
   the `tools/api/run.mjs` TS-loader pattern (a `*.runspec.ts` under an isolated
   vitest config). `computeAirMass`/`computeAltAz` are imported to *code* the X-axis
   gate even though it resolves to NOT MEASURED here (see below).
3. **Catalog enumeration** replicates `star_catalog_adapter.ts:293–313` row-mapping
   (isGaiaFormat, RA-unit-per-row, gaia_id/band) reading the same atlas JSON assets
   the adapter fetches, rather than driving the async sector loader — faithful to the
   band-discrimination logic (the part that matters for the trap) without the wide-
   field sector-orchestration cost. Band split is preserved end to end.

### X-axis (airmass) — NOT MEASURED, predicate named

Per spec (h): per-star alt/X is computed **only if** the frame passes `timestampTrusted`
forensics **AND** carries EXIF-GPS. The bundled CR2 has a trusted EXIF time (June 2019)
but **NO GPS** (`run_wizard_cr2.mjs` header: "NO GPS (observer location absent — null,
no fabricated default)"), and its EXIF is otherwise a known liar (50mm lens). Therefore
**σ_star(X) is NOT MEASURED — failed predicate: EXIF-GPS absent** (a null/assumed location
cannot ground a real airmass without circularity). Only σ_star(mag) is emitted. `computeAirMass`/`computeAltAz`
remain wired for increment 2 (where a GPS-bearing frame or the fit's own zenith supplies X).

---

## Files

- `measure_sigma_star.mjs` — thin CLI (run.mjs-style): args → env → spawn runspec →
  project headline σ to stdout, full table to `test_results/atmosphere/`.
- `measure_sigma_star.runspec.ts` — the measurement kernel (imports the real engine
  `forcedMeasure`/`computeAirMass`/`computeAltAz`; decode-cache read, demosaic,
  projection, matching, per-channel/per-band/per-parity σ, JSON + SVG chart).
- `measure_sigma_star.config.ts` — isolated vitest config (`*.runspec.ts`; cleared
  wasm-mock setup), mirroring `tools/api/run.config.ts`. Collected by NO standing gate.

Outputs (gitignored): `test_results/atmosphere/sigma_star_cr2.json` +
`test_results/atmosphere/sigma_star_cr2.svg`.

---

## FIRST MEASURED RESULT — bundled CR2 (2026-07-09)

`node tools/atmosphere/measure_sigma_star.mjs` (tsc baseline 45 unchanged; no src diff).

Recovered geometry: anchor = detection **rank #3** (NOT the brightest — the #0 source
is a bloomed edge object), θ=156° (logged solve 157.7°), parity=1, 21 tight (≤8px)
mag<6 matches — reproduces the solve geometry.

- **N measured** = 47 usable rows (GaiaG 41 + JohnsonV 6), per channel. Purity upper-bound
  88% (chance ≈7/59). **N<200 exit target NOT met** — single-sub *extraction/exposure*
  limit (only ~59 of ~389 mag<7 footprint stars coincide with a detection within 12px;
  same limit the IMG_1410 forced-photometry study measured on this rig), compounded by
  the shipped catalog depth (L3 truncated ~mag 6.81). Not a tool limit; deeper N needs a
  **stack** or a deeper catalog, not a shape trick.
- **σ_star(mag) noise floor** — read at the bright, well-populated bin (the floor; faint
  bins are photon- + color-limited):

  | band | mag bin | n | σ_R | σ_G | σ_B |
  |---|---|---|---|---|---|
  | GaiaG | 4–5 | 11 | 0.238 | **0.148** | 0.217 |
  | GaiaG | 5–6 | 15 | 0.296 | 0.461 | 0.566 |
  | GaiaG | 6–7 | 15 | 0.216 | 0.494 | 0.670 |
  | JohnsonV | 6–7 | 6 | 0.362 | 0.373 | 0.137 |

  **Headline: σ_star ≈ 0.15–0.24 mag at the bright end** (G channel hits 0.148) —
  in the favorable ~0.10–0.20 band the photometric design hoped for, *not* ≳0.3. It
  degrades to 0.3–0.7 toward the catalog/detection limit (worst in B: color spread of a
  single-band ZP with no β term yet + lowest-SNR channel). The downstream Fisher/N budgets
  hold at the bright end; the color term (increment 2 β) is the next scatter reducer.
- **Row-parity (CFA 2px checkerboard) contribution** = |σ_even − σ_odd|: R 0.084 · G 0.158
  · B 0.313 mag, with a strong detection-count imbalance (even n=8 vs odd n=33 — the known
  period-2 CFA-luminance parity in detections). MEASURED here; the fix is separately queued.
- **σ_star(X)** = **NOT MEASURED** — predicate: EXIF-GPS absent (bundled CR2 has trusted
  EXIF time but no GPS; a default location cannot ground airmass without circularity).

---

## INCREMENT 2 — single-frame flux vertical: fit_vertical (ZP, k, β, ẑ)

`fit_vertical.mjs` (thin CLI) → `fit_vertical.config.ts` + `fit_vertical.runspec.ts`
(fit kernel) → consumes the shared **`lib/star_table.ts`** measurement (see below).
Model per star i, per channel: **Δm_i = ZP + k·X_KY(alt_i(ẑ)) + V(r_i) + β·color_i + ε**,
`alt_i(ẑ)=asin(ẑ·ŝ_i)`, `X_KY = AtmosphericManager.computeAirMass` (Kasten–Young),
`V(r)=a2·r²+a4·r⁴`. Outputs `fit_vertical_cr2.json` + residual-vs-alt SVG (both gitignored)
and appends `tools/atmosphere/validation_ledger.jsonl` (tracked; one row per run).

### Estimator + DELIBERATE DEVIATIONS from the spec letter (Law 2 — flag, don't tune)
1. **Separable LS (VarPro) instead of a 13-param joint LM.** The model is LINEAR in
   (ZP,k,a2,a4,β) for a fixed ẑ, so the nonlinear search is **2-D over ẑ only** (coarse
   5° unit-sphere grid → multi-start Nelder–Mead), with the linear block solved EXACTLY
   inside each evaluation. Mathematically equivalent to the spec's joint LM but far more
   robust on the vignette↔extinction ridge than a numeric-Jacobian 13-param LM. Tukey-
   biweight IRLS (c=4.685·MAD) wraps it. A method choice, not a threshold change.
2. **Predictor centering + r⁴⊥r² Gram–Schmidt.** X, r², r⁴ are centered and the r⁴ column
   is orthogonalised against r² (they are ~collinear over r∈[0,1]). Same model SPAN, no
   bias (raw a2,a4/ZP reconstructed after the solve) — without it the solve goes singular
   (constant-X near boresight) or a4 blows up and overfits noise.
3. **Whole-field-above-ALT_CUT admissibility.** A ẑ is evaluable only if the WHOLE field
   sits above `ALT_CUT_DEG` (`minAlt ≥ cut`). This is what makes the SSR **comparable
   across ẑ** — the in-fit star set is then fixed, so the fit cannot game the objective by
   moving ẑ to push hard stars below the horizon/cut and overfit the few retained (a real
   failure mode observed in development). It also enforces the v1 differential-refraction
   exclusion for the whole field and kills near-horizon airmass-cap spurious solutions.
4. **σ_k propagates the ẑ covariance.** The linear-fit σ_k grossly understates the truth
   when ẑ is loose (k trades off with ẑ): reported `σ_k = √(σ_k,lin² + gᵀ·Cov_ẑ·g)`.
   `sigma_linear_only` is kept in the JSON to show the gap.
5. **`lib/star_table.ts` is the SINGLE §1–8 measurement implementation** (imported
   engine `forcedMeasure`, same constants), with catalog unit-vector inputs (raH/decD)
   + per-channel snr the fit needs. **CONSOLIDATION DONE 2026-07-21** (orchestrator-gated
   grant): `measure_sigma_star.runspec.ts` was refactored from its inline §1–8 copy to
   import `buildStarTable()` — Law 4 satisfied, ONE measurement path. Verified
   byte-identical post-consolidation: inc-1 `sigma_star_cr2.json` md5 `d79bd703`, inc-2
   `fit_vertical_cr2.json` verdict md5 `c29065eb`, tsc unchanged (0 `error TS`). Three
   additive `meta` fields (`geometry_tight_matches`, `rAp_px`, `counts.usable_before_photometry`)
   surface diagnostics inc-1's receipt reports.

### INITIAL ENGINEERING VALUES (inc 2) — flag, don't tune; change only by adding evidence
| Constant | Value | Meaning |
|---|---|---|
| `DX_MIN` | 0.30 | in-frame airmass span floor; ΔX<0.30 ⇒ **k NOT MEASURED** (ZP↔k degenerate) |
| `BORESIGHT_MIN_DEG` | 20 | ẑ must sit ≥20° off boresight (else even-r vignette aliases k·X) |
| `ELLIPSE_MAX_DEG` | 15 | ẑ 1σ ellipse semi-major above this ⇒ **ẑ NOT MEASURED** (data's own σ refuses) |
| `ALT_CUT_DEG` | 20 | low-alt cut (differential refraction ~5px at 63"/px); also the admissibility floor |
| `N_MIN_HI` | 15 | min stars above ALT_CUT for a ẑ to be evaluable |
| `TUKEY_C` | 4.685 | Tukey biweight tuning (× MAD) |
| `IRLS_ITERS` | 8 | IRLS reweight iterations |
| `GRID_STEP_DEG` | 5 | coarse ẑ unit-sphere grid step |
| `RUNS_Z_FLAG` | 2.0 | |sign-runs z| above which residual-in-alt structure is flagged |

Additional REPORTED physical-validity check (not a tuned pass gate): the fitted extinction
must be **k≥0 and Rayleigh-ordered (R<G<B)**; a single-frame fit violating this has assigned
vignette+noise to k·X and is not recovering atmospheric physics → contributes to the ẑ
refusal predicate.

### MEASURED RESULT — bundled CR2 (2026-07-09), GaiaG band, N=41
- **Exit gate (1) — synthetic self-consistency PASSES:** injecting (k, ẑ, vignette) into a
  well-posed dense synthetic field (σ=0.03) recovers **ẑ to 1.4°**, k within ~1–3σ
  (0.088/0.140/0.248 vs true 0.10/0.16/0.26), vignette a2=1.13/a4=0.50 (true 1.10/0.55) —
  the estimator MATH is validated (legitimate: synthetic, not tuned).
- **Real frame — HONEST REFUSAL (the product):** the single 41-star ultra-wide frame with a
  free vignette at the σ≈0.15–0.5 floor cannot constrain the geometry. **ẑ = NOT MEASURED**,
  predicate: *fitted extinction unphysical* (k_RGB = −2.40/−2.71/−2.74; requires k≥0, R<G<B)
  — the free vignette + sparse stars absorbed the extinction signal. ẑ 1σ ellipse = 13.9°.
  **k reported with ẑ-propagated σ ≈ 1.75–1.92** (spanning zero) — transparently non-significant.
  **β colour term = NOT MEASURED** — GaiaG rows carry `mag_g` only (no BP-RP); the designed
  B-channel-scatter fix: UNBLOCKED 2026-07-22 (ledger row 526) — the colour axis is
  LIVE on Gaia BP−RP (star_table colorProvenance; β_R/G/B = 0.284/0.461/0.682, σ_B
  0.754→0.330 mag at n=41). The old "DATA-BLOCKED on the atlas colour column" state
  is retired. ΔX=1.434 (≥0.30).
  This refusal-with-named-predicates IS the increment-2 product; a trusted estimate needs the
  inc-5 pooled vignette (held FIXED), the inc-10 colour gate, and inc-11 grading.
- Ledger: `validation_ledger.jsonl` records the run (verdict `ZENITH_REFUSED`, truth=null —
  no EXIF-GPS on this frame to score against; **no GPS-truth corpus frame present** to append
  an error-vs-truth row, so exit-gate (3) is recorded as a DATA GAP, not a fabricated score).

---

## INCREMENT 5 — pooled per-rig vignette profile (the dominant-confound separator)

`pool_vignette.mjs` — **self-contained plain node** (NO engine/wasm/atlas/solve). The
pooled vignette fit is pure math on BANKED per-star forced photometry; it consumes only
Δm and r_norm (r_norm is bin-invariant → valid on the superpixel plane). Model (magnitude
space, consistent with inc-2 `V(r)=a2 r²+a4 r⁴`):

> **Δm_{f,i} = ZP_f + gx_f·xn_i + gy_f·yn_i + a2·r² + a4·r⁴**
> shared across frames: **a2,a4** (rig-fixed vignette) · per-frame nuisances: **ZP_f, gx_f, gy_f**
> (zero-point + linear pixel gradient — APPROXIMATE proxy for the per-frame atmosphere/sky;
> the true alt-gradient is not computable without trusted GPS+time). Robust Tukey-IRLS WLS.
> Optical-center offset fit as a weakly-identified **diagnostic**, not a primary param (an
> even vignette under limited coverage barely constrains it — the selftest confirmed a2/a4
> recover accurately while the center wandered on noise; forcing it free would overfit).

```
node tools/atmosphere/pool_vignette.mjs            # fit the X-T4 rig
node tools/atmosphere/pool_vignette.mjs --selftest # synthetic self-consistency (a2/a4 recovery)
```

### BANKED-DATA CENSUS (spec:58 data dependency — the xtrans field library)
The library is **8 RAF frames, one lens (XF23mmF2 R WR @23mm, an f/2 prime — NOT the "14mm"
of the working record), TWO bodies**. Rig-keyed by (camera, lens, FL, aperture) — the
increment's own contamination guard:

| Rig | Body | Frames | Verdict |
|---|---|---|---|
| **A** | Fujifilm X-T5 | 4954, 4965, 4981 (**3**) | sub-threshold alone; used as the cross-body CHECK only |
| **B** | **Fujifilm X-T4** | 5182, 5921, 5949, 6219, 6235 (**5**) | **MEETS spec:58** — ≥5, one rig, varied pointing |

X-T4 pointings vary widely (Dec −34°→+44°, RA 14.9–21.0h) + roll varies (2 landscape, 3
portrait). Input = **banked CONTROL forced photometry** (astrometry.net oracle WCS on our
superpixel plane — instrument-validation artifacts, never a solve claim): **217 stars total**
{x,y,flux,cat_mag,gaia_id}, pooled radial coverage to **r_norm≈0.82**.

### INITIAL ENGINEERING VALUES (inc 5) — flag, don't tune; change only by adding evidence
| Constant | Value | Meaning |
|---|---|---|
| `VIGN_ORDER` | 4 | vignette polynomial max degree (a2 r² + a4 r⁴) |
| `TUKEY_C` | 4.685 | Tukey biweight tuning × MAD (inc-1/2 + wasm LM family) |
| `IRLS_ITERS` | 8 | IRLS reweight iterations |
| `CENTER_HALF` / `CENTER_STEP` | 0.05 / 0.01 | center-offset diagnostic search (normalized to half-diag) |
| `R_CORNER` | 0.82 | documented coverage ceiling (reported; not a cut) |

### MEASURED RESULT — X-T4 rig (banked, N=5), and the HONEST VERDICT
`node tools/atmosphere/pool_vignette.mjs` (tsc 0 unchanged; **zero src/ diffs**; profile +
SVG → gitignored `test_results/atmosphere/rig_profiles/`).

- **Estimator VALIDATED** — `--selftest` recovers injected a2=0.9/a4=0.6 to |Δa2|=0.069,
  |Δa4|=0.084 (tol .08/.12) → **PASS** (legitimate: synthetic, not tuned).
- **Pooled fit runs on 5 real varied-pointing frames** — a2=1.56, a4=**−0.87**, robust RMS
  **0.62 mag**, amplitude V(0.82)≈0.66 mag.
- **LOO stability + held-out RMS (exit-gate item 2, numbers):** max|ΔV| across folds =
  **1.11 mag** (> the profile's own amplitude — **LOO-unstable**, DSCF5182-dominated);
  held-out-frame RMS 0.53–0.76 vs own-free-V RMS 0.45–0.63.
- **Binned Δm-vs-r (per-frame ZP removed):** medians scatter −0.26→+0.16 with **no monotonic
  radial ramp** — over the measured domain the ~0.62 mag per-star scatter (inc-1 σ_star
  faint-end 0.3–0.7; confirmed-star mix down to SNR~7) is not sub-dominant to the vignette.
- **Degeneracy-break (exit-gate item 4, in-lane honest form):** a single sparse frame
  (DSCF5921) with a **free** V absorbs radial structure into a2/a4 (residual trend |z|≈0);
  with the **pooled V held FIXED** (fit on the other 4 frames) the residual radial trend is
  |z|=**0.60** (below inc-2's `RUNS_Z_FLAG`=2.0) — the mechanism works. The full inc-2
  `fit_vertical` ẑ/k re-run with V FIXED **is documented as data-gated, not run**: the contributed
  frames carry no trusted GPS+time to ground alt→X or score ẑ (inc-11), and coverage stops
  at r_norm≈0.82 so corner ẑ-leverage is absent.
- **Cross-body CHECK (X-T5, same lens — NEVER pooled):** X-T5 residual under the X-T4 V
  (0.6214 mag) ≈ X-T5 own-free-V (0.6222 mag) — the lens-dominant vignette transfers across
  bodies; consistent with a body-independent component, but at the ~0.62 mag floor the test
  is weak-signal (not a strong pass).

**DEPOSIT-QUALITY VERDICT: `NOT_TRUSTED_DEPOSIT` — coverage/stability limited.** Reasons:
(1) LOO max|ΔV| 1.11 mag exceeds the profile amplitude — not stable to leave-one-out; (2)
coverage stops at r_norm≈0.82, the a4 term is unpinned (turns over) so the corner falloff
(r_norm→1, where a wide-open 23mm dims 1.5–2.5 mag) is **UNMEASURED — not extrapolated**;
(3) robust RMS ≈ vignette amplitude over the measured domain. **Path to a trusted deposit:**
corner-reaching forced photometry (decode the 5 RAF frames + forced-measure ALL footprint
catalog positions to the field edge, not just the bright confirmed subset) or deeper stacks,
then re-pool — inc-1/2 machinery on the X-T4 rig, a heavier compute step (RAF decode ×5),
flagged as the DATA/compute gate rather than fabricated.

**QUALIFICATIONS carried on every product (verbatim, per the honest-or-absent law):**
N=5 (the spec:58 floor; LOO folds thin — the LOO/held-out numbers are self-diagnosis, not a
pass gate) · **aperture ASSUMED f/2** (XF23mmF2 wide-open, astro default; shooting f-number
ABSENT from banked EXIF — the LOO guard is the empirical catch) · **corners beyond r_norm≈0.82
UNDER-CONSTRAINED** (do not extrapolate; the reported valid domain is r_norm≤0.82).

The pooled profile is NOT appended to `validation_ledger.jsonl` — that ledger's schema is the
ẑ-vs-truth record for the sextant verticals (inc 2/8/9); the inc-5 record is the profile JSON.

### OWNER-CAPTURE NAG (spec:58 / inc-11 data ask — remains OUTSTANDING)
The spec's owner-capture request for a **TRUE ultra-wide, varied-pointing set** (spec:57–58
names a 14mm wide-open corner falloff) is **still outstanding as a separate item**: this
library is 23mm (narrower FOV, smaller corner falloff) and its banked photometry is
coverage-limited to r_norm≈0.82. A trusted pooled vignette wants either (a) corner-reaching
forced photometry on these X-T4 frames, or (b) a genuinely ultra-wide (≤14mm) varied-pointing
≥5-frame single-body set with corner star coverage.
