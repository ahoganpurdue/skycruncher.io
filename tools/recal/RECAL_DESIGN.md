<!-- REFERENCE · pre-registered protocol · owner: ahogan · decoder-cutover #14 -->
# Paired threshold-recal — pre-registered protocol (RECOMMENDER-ONLY)

The m4 detection thresholds were **implicitly calibrated against the libraw/CFA
artifact** (CLAUDE.md CFA note: *"thresholds were implicitly calibrated against the
artifact"* — flag-ON detections jumped 2227 → 21,636 on the raw CFA grid). Decoder
cutover #14 swaps libraw's dominant-channel demosaic for **rawler integer demosaic**,
which removes the 2px CFA checkerboard. Removing the artifact **moves the noise floor
and the shape distributions the thresholds were tuned against**, so the constants must
be **re-derived once against the artifact-free rawler grid**. This document is the
protocol the cutover session executes; `sweep_thresholds.mjs` is its runnable scaffold.

## 0. Owner constraints (binding)

- **Single spend.** The recal runs **ONCE**, at cutover #14, **against rawler output**,
  paired with **one rebaseline** of the pinned gates. (decoder-cutover-program memory:
  *"single recal vs rawler output + one rebaseline; no standalone recal"*.)
- **Never against libraw.** libraw's CFA artifact is exactly what is being removed;
  calibrating against it re-bakes the artifact. Rawler-decoded frames only.
- **Recommender-only.** This lane **NEVER edits a constant.** It emits a
  RECOMMENDATION (a constant-set + its evidence) or a **NULL** (keep current). The
  owner applies any change to `pipeline_config.ts` / `signal_processor.ts` by hand,
  under the usual calibrated-gate discipline. Mirrors `tools/adaptive` (recommender-only,
  never touches the gate).
- **Honest-or-absent.** No recall/precision number without truth labels. Unvalidated =
  `NOT MEASURED`. A candidate that cannot be shown to beat baseline under the frozen
  criteria yields **no recommendation** (an honest null), never a weakened bar.

## 1. Inputs

| Input | Today | At cutover |
|---|---|---|
| Decoded frame set | — (stubbed `DecodeSource`) | rawler integer-demosaic FULL frame + optical-black borders, N ≥ 5 |
| Detection dump | JSON dump per frame (`--dump`) | produced by re-running m4 on each rawler frame at each candidate sigma |
| Truth labels | JSON (`--truth`), `GroundTruthStar[]` + `limitingMag` | catalog-projected (min) / **forced-photometry-confirmed (preferred)** |

**Truth-label schema** (mirrors `tools/adaptive/ground_truth.ts` — honest AMBIGUOUS band):
```
{ "stars": [{ "x": <px>, "y": <px>, "mag": <number|null>, "gaia_id": <string|null> }],
  "limitingMag": <number|null>,   // unmatched detection BRIGHTER than this = confident FP;
                                  // FAINTER = AMBIGUOUS (catalog may not reach it), never a silent miss
  "source": "CATALOG_PROJECTED" | "FORCED_PHOTOMETRY_CONFIRMED" }
```

## 2. Constants swept (m4 detection)

Current values read **live** where leaf-loadable, else **mirrored with citation**.
`sweep_thresholds.mjs` imports the live block; the two literals below live in a
non-leaf module and are mirrored (kept in sync by hand — recal recommends, owner edits).

| Constant | Current | Source (live/mirror) | Role |
|---|---|---|---|
| `sigFactor` | **2.0** | MIRROR — `m4/signal_processor.ts:51` literal | primary analyze() threshold `mean + stdDev·sigFactor` |
| `sigmaCurrent` (vanguard base) | **3.0** | MIRROR — `signal_processor.ts:314` literal, FL-scaled by `flFactor` clamped `[0.6, 2.0]` (:317) | vanguard extraction threshold |
| `DETECT_HOTPIXEL_NSIGMA` | **6** | live — `PIPELINE_CONSTANTS` | hot-pixel spike vs 8-neighbour median |
| `DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA` | **3** | live | "neighbours at background" ceiling |
| `DETECT_HOTPIXEL_MIN_DENSITY_PER_MP` | **25** | live | apply mask only above this flagged density |
| `DETECT_MAX_CANDIDATE_DENSITY_PER_MP` | **40000** | live | fast-fail guard: deep candidates / MP |
| `DETECT_MIN_CANDIDATES_FOR_GUARD` | **50000** | live | absolute deep-count floor for the guard |
| `DETECT_FWHM_FLOOR_PX` | **1.3** | live | per-blob shape gate — sub-pixel spike floor |
| `DETECT_SHARPNESS_MAX` | **1.10** | live | per-blob shape gate — lone-pixel ratio ceiling |
| `DETECT_ELLIPTICITY_MAX` | **0.70** | live | per-blob shape gate — streak/cluster ceiling |

Per-blob **SNR** is the sigma thresholding itself (`sigFactor`/`sigmaCurrent`); the
per-blob **shape** gates are the three `DETECT_*` ceilings above, applied in
`m4/detection_cuts.ts` (`evaluateBlobCuts` / `cullThermalBlobs`, gated by
`thermalCutsActive()`). **Which threshold sweeps at cutover, and which stays pinned,
is a pre-registration decision** — sweep the ones the artifact-removal actually moved
(the sigma floors + shape ceilings); the density fast-fail guards are frame-safety
bounds, not recall levers, and should be swept only if a rawler frame trips them.

## 3. Frozen acceptance-criteria TEMPLATE (D10b style)

Freeze ALL of the following **before** running the sweep (fill the brackets from the
measured baseline distribution; do not guess a floor):

1. **N ≥ 5 frames**, diverse rigs preferred; **truth-labeled required** (catalog-projected
   is the floor, forced-photometry-confirmed preferred). N < 5 ⇒ NO RECOMMENDATION.
2. **Pre-registered single metric.** One joint metric fixed in advance — e.g.
   `F_β` with **β pre-registered** (recall-weighted, β > 1: the solver tolerates a false
   positive far better than a missed true star, so recall is the priority). Record β and
   why before any candidate is scored.
3. **Distribution-grounded floors.** Accept a candidate only if, across **every** frame,
   `recall ≥ baseline_recall − ε_r` **and** `precision ≥ baseline_precision − ε_p`, where
   `ε_r`, `ε_p` are set from the **measured baseline spread** (e.g. one baseline
   inter-frame stdev), not chosen by hand.
4. **Never-worse guard.** No per-frame recall or precision may fall below its
   current-constant baseline by more than the ε in (3) on **any** single frame — a mean
   gain that hides a per-frame regression is rejected (mirrors the solver's never-worse
   / one-rule-for-all guards).
5. **Explicit KILL BAR.** The candidate must beat baseline on the pre-registered metric
   on **≥ k of N** frames (pre-register k, e.g. `k = ceil(0.8·N)`) with **zero** frames
   below the floor. If no candidate clears this, recal emits **NO RECOMMENDATION** — the
   current constants stand. A tie does not promote.
6. **One rebaseline.** The single accepted recommendation (if any) is paired with exactly
   one gate rebaseline (pinned solves re-pinned against rawler output), per the
   single-spend rule. No iterative re-tune.

## 4. Procedure

1. Decode N frames with rawler (`DecodeSource` — stubbed today).
2. For each candidate constant-set, run m4 detection (DECODE mode) **or** re-threshold an
   existing detection dump on the dump-supported dimensions (DUMP mode, today's scaffold).
3. Match survivors to truth within `matchRadiusPx`; compute per-frame
   recall / precision with the AMBIGUOUS band excluded from the precision denominator.
4. Aggregate per-frame → apply the §3 frozen criteria → emit RECOMMENDATION or NULL.
5. Hand the recommendation (+ evidence table) to the owner. **Recal stops here — it never
   writes a constant.**

## 5. Scaffold status (honest)

`sweep_thresholds.mjs` today runs **DUMP mode** only and re-thresholds the dimensions a
static dump supports (shape gates + an SNR floor if the dump carries per-detection SNR);
pixel-level sigma sweeps need the live rawler decode behind `DecodeSource`, which is
**STUBBED / NOT MEASURED** until cutover. With no `--dump`/`--truth`, the scaffold reports
`NOT MEASURED` and recommends nothing — it never fabricates a recall/precision number.
