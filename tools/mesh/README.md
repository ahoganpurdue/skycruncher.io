# tools/mesh — quad-mesh cascade finder (research incubator, LAW-4)

Prototype of the owner **quad-mesh cascade detection** idea
(memory: `quad-mesh-cascade-detection-idea`). Research lane, `tools/` only,
**banked data only, zero engine wiring** — nothing here feeds a solve.

## What it does

After an anchored accept, a catalog star whose *local neighbourhood* is already
matched can have its image position **predicted from local geometry** (≥3 matched
neighbours ⇒ a local affine, 6 DOF, which absorbs local shear/distortion — the
memory's fidelity tier). Verify the prediction by **forced photometry on the
native buffer**; accept ⇒ add to the matched set ⇒ the frontier grows. BFS from
the anchors. The lane **MEASURES** the one question that matters: *does that
cascade actually multiply verified matches on real frames?*

This **consumes** the mesh_legB primitives — it does not duplicate the harvest
leg. Leg-B does a *global-WCS* forced harvest; this lane adds the
*local-geometry* prediction layer leg-B does not have.

## Honesty contract (why the measurement is trustworthy)

- The cascade **never consults the global WCS to predict a position** — only the
  seed anchors tie it to image space; every other position propagates through the
  mesh via local affine. That makes it a real test of "grow from anchors", not a
  re-run of global forced harvest.
- Every mesh match is **CATALOG_FORCED** forced photometry at a predicted
  position — never a blind discovery, never fed to a solve.
- Accuracy is scored against **two independent banked references** (never the
  mesh's own re-anchor): the iterbc densified harvest (center-cropped r_norm≲0.44)
  and a full-field WCS+measured-Brown-Conrady forced path (a *different* predictor,
  so agreement is real cross-validation). Both references' limits are reported so
  we never call "outside a reference's coverage" the same as "false".

## Files

| file | role |
|---|---|
| `mesh_finder.mjs` | core library: `attachTangent`, `fitLocalAffine`, `runCascade`, `scoreAgainstReference`. Pure Math + the forced_detect/imaging leaves. |
| `run_mesh.mjs` | thin CLI driver: loads a banked capture (f32 buffer + fitted WCS + anchors), runs the cascade, scores vs references, writes JSON + overlay PNG. |
| `quad_walk_planner.mjs` | **GOAL-DIRECTED** cascade (owner design 2026-07-22): turns the blind BFS into A* over a catalog quad graph targeting an 18-cell PERIMETER-COVERAGE map, with a radius-adaptive quad-size schedule `s_max(r)` and a risk-gated executor. |

## quad_walk_planner (goal-directed A* + perimeter coverage)

Extends the cascade with four pieces (owner spec):
- **18-cell perimeter map**: outer annulus r_norm[0.75,1.0] × 12×30°, mid [0.45,0.75] × 6×60°.
  Per cell: **(N verified, reach = max-r_norm ÷ in-frame ceiling, precision = 0.6mag/√N)** →
  GREEN (N≥10 & reach≥0.9) · AMBER-thin (reached, under-sampled) · RED (sky, unwalked) ·
  GREY (occluded hook) · OUT_OF_FRAME (portrait/landscape sensor: sector never enters the annulus).
- **`s_max(r)`** from the frame's own BC prior: `L_max = √(8·tolCurv/|D″(ρ)|)`,
  `D(ρ)=k1·ρ³/hd²+k2·ρ⁵/hd⁴`. `s_min` = conditioning floor (cites `fitLocalAffine` degeneracy guard).
- **A*** nodes=catalog stars, edges=quads in [s_min,s_max(r)], hop cost=risk (catalog-density
  confusion + predicted-SNR shortfall + affine conditioning), heuristic=tangent-dist to nearest
  goal. Plans corridors OFFLINE, then executes forced-verify + re-anchor per hop (mirrors runCascade
  exactly — validated by `--validate-flood` reproducing the banked blind count).
- **Grade vs oracle** (a.net SIP): corridor false-completion by radial bin vs blind-BFS baseline.

    node tools/mesh/quad_walk_planner.mjs --frame M66            # default risk-pct 0.6
    node tools/mesh/quad_walk_planner.mjs --frame M66 --validate-flood   # blind self-check
    node tools/mesh/quad_walk_planner.mjs --risk-pct 0.45        # tighter gate = lower false rate

Knobs: `--risk-pct` (gate percentile), `--bc-source receipt|ledger`, `--bc-k1/--bc-k2` (wide-frame
override), `--tol-curv`, `--s-min-px`, `--knear/--kmin/--snr`, `--grey-mask '{"bottomFrac":0.33}'`.
Outputs → `D:/AstroLogic/test_artifacts/quad_walk_2026-07-22/`: `<frame>_quad_walk.json`,
`_corridors.json`, `_risk_gate_sweep.json`, `_perimeter_wheel.png`, `_corridor_overlay.png`.

### Measured verdict (M66, 2026-07-22)
Risk-gated corridors **reach all 8 in-frame outer cells** (M66 is portrait → 4 outer sectors are
OUT_OF_FRAME, so "10/12" is geometrically impossible; 8/8 is the real ceiling) with an outer
(0.70–0.85) false-completion rate **MONOTONE in the gate**: 0.161 (τ@45%) · 0.189 (τ@60%) · 0.208
(τ@75%) vs the **blind-BFS baseline 0.205** — i.e. routing through low-risk hops cuts the outer
false rate up to ~21% (16.1% vs 20.5%), trading photometric depth (4 GREEN/4 AMBER vs flood 6/2).
Pre-registration **MET** at τ≤0.60. `s_max(r)` **never binds on M66** (gentle distortion); on beach
(fitted from the banked distfloor) it shrinks toward the corner (2711→1156px) but stays a **slack
safety rail** — the ~17px kNN-8 patch at real catalog density is far below s_max, so conditioning +
risk are the practical governors, not distortion curvature. Beach execution is NOT MEASURED.

## Inputs (banked)

- `--meta`   iterbc capture meta (`wcs`, `matched_stars` anchors, `width/height`, `mean_fwhm_px`).
- `--buffer` native luminance buffer (`float32-le`, `w*h`, single channel).
- `--reference` iterbc `loop_render.json` (independent densified truth; optional).
- `--bc-ledger` iterbc `loop_ledger.json` (`final_bc` k1/k2 for the full-field truth; auto-derived from `--reference`).
- `--stars` g15u `stars.arrow` (Gaia G<15, degrees) — the completion-target catalog.

## Run (M66, defaults point at the banked iterbc capture)

    node tools/mesh/run_mesh.mjs --frame M66
    node tools/mesh/run_mesh.mjs --frame M66_central015 --seed-mode central:0.15

`--seed-mode`: `all` (default) · `brightest:N` · `frac:F` · `central:R` (r_norm<R,
tests BFS crawl outward) · `corner:R`. Other knobs: `--snr`, `--knear`, `--kmin`,
`--cent-tol`, `--max-reanchor`, `--ref-tol`, `--bc-tol`, `--mag-limit`.

## Outputs → `D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/`

`<frame>_mesh_summary.json` (measured metrics), `<frame>_mesh_matches.json`
(per-match rows), `<frame>_mesh_overlay.png` (blue=seed, green=corroborated,
magenta=uncorroborated-by-iterbc).

## Measured verdict (M66, 2026-07-22) — see `_mesh_summary.json`

**The cascade multiplies matches — robustly.** Full anchor seed 236 → 1146 matched
(4.86×, 88% of the in-frame catalog); a *tiny central seed of 11* → 889 (**80.8×**)
over **11 genuine outward-crawling BFS rounds**. Out to r_norm 0.7 the completions
are **94–100% corroborated** by both independent references (extending trust well
beyond iterbc's 0.44 crop; in-coverage vs iterbc 318/323 = 98.5% with the full seed).
**Open/negative:** the *distortion-absorption* advantage is **not demonstrated here** —
the only region with clean truth (inner field) has too little distortion to separate
local-affine from global-linear (affine adds fitting noise where there is nothing to
absorb), and the corners (r_norm>0.7), where affine *should* win, have no trustworthy
truth (the only corner model — extrapolated Brown-Conrady — is itself ~8px off). That
claim needs a **wide, genuinely distorted frame with corner truth** (14mm + oracle).
