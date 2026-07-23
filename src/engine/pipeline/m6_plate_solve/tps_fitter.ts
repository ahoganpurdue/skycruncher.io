// ═══════════════════════════════════════════════════════════════════════════
// THIN-PLATE SPLINE (TPS) DISTORTION FITTER — COORDINATE ledger
// ═══════════════════════════════════════════════════════════════════════════
//
// Fits a regularized thin-plate spline to the matched-star residual field — a
// richer, non-polynomial companion to the SIP fitter (residual_analyzer.ts). Both
// model the SAME quantity (detected − linear-WCS-predicted pixel displacement);
// SIP is a low-order global polynomial, TPS is a smoothing spline that follows
// local optical distortion the polynomial cannot (the standard GWCS distortion
// representation is a lookup table precisely because a spline has no polynomial
// nodes — that is the ASDF carry-through this fitter enables).
//
// TWO-LEDGER LAW: this is a COORDINATE-space fit over sparse matched POINTS. It
// reads the already-solved pairs and returns a distortion FUNCTION appended to
// the receipt (solution.astrometry.tps). It NEVER resamples pixels, NEVER mutates
// the WCS / matched_stars / solve confidence, and NEVER feeds solve/verify/
// acceptance. Because it only observes, wiring it costs ZERO change to the sacred
// solve — both e2e's stay byte-identical for free.
//
// CONVENTION (mirrors residual_analyzer.ts EXACTLY — single source of truth via
// ResidualAnalyzer.skyToLinearPixel):
//   per pair:  u = detected.x − crpix[0],  v = detected.y − crpix[1]
//              dx = detected.x − expX,     dy = detected.y − expY
//   where (expX,expY) = linear-WCS projection of the catalog star. Planet
//   sentinels (residual_arcsec ≥ 999, gaia_id 'planet_*') are filtered — they
//   would inject huge outliers into the spline.
//
// MATH (regularized TPS; solved separately for the dx and dy component fields):
//   f(p) = a0 + a1·ũ + a2·ṽ + Σ_i w_i · U(‖p̃ − p̃_i‖),   U(r) = r²·ln r, U(0)=0
//   subject to Σ w_i = 0, Σ w_i ũ_i = 0, Σ w_i ṽ_i = 0.
//   Linear system  [ K+λI  P ] [w]   [z]
//                  [ Pᵀ    0 ] [a] = [0]   ,  K_ij = U(‖p̃_i−p̃_j‖),  P = [1 ũ ṽ]
//   λ = SOLVER_TPS_LAMBDA (recorded in the output block). Coordinates are
//   NORMALIZED (p̃ = (u,v)/scale, scale = max control radius) so K is O(1) and λ
//   trades meaningfully; the displacement values z stay in PIXELS, so f outputs a
//   pixel displacement directly. λ→∞ ⇒ w→0 ⇒ affine-only (the sanity limit).

import type { PlateSolution } from '../../types/Main_types';
import { ResidualAnalyzer } from '../m7_astrometry/residual_analyzer';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { tpsKernel, evalTpsField } from './tps_eval';

// Re-export the shared evaluator under its historical name (the ASDF writer bakes
// its lookup table from tps_eval directly; tests import it from here).
export { evalTpsField as evalField } from './tps_eval';

// ─── fitter-own discipline thresholds (module-local, NOT solver sigma gates) ───
// These decide whether the sample can HONESTLY support a spline; below them the
// fitter refuses (returns null → honest-absent) rather than laundering a coverage
// hole into a wildly-extrapolating spline. Mirrors the BC-refit coverage style.
const TPS = {
    /** Minimum control points to attempt the fit (above the 20-match SIP fire bar
     *  — a spline needs a denser, better-conditioned sample than a low-order poly). */
    MIN_CONTROL: 25,
    /** Octant coverage: ≥ MIN_OCTANTS of 8 azimuthal octants must each hold
     *  ≥ OCTANT_MIN control points, else the azimuth is too lopsided to fit a
     *  2-D spline without pathological extrapolation. */
    MIN_OCTANTS: 5,
    OCTANT_MIN: 3,
    /** Prune to a spatially-distributed subset above this — keeps K well-
     *  conditioned and stops dense clusters from dominating the spline. */
    MAX_CONTROL: 120,
} as const;

const OCTANT_COUNT = 8;

// ─── output block (all plain number arrays — NEVER typed arrays; the save_packet
//     replacer silently strips Float32Array/Float64Array from receipts) ─────────
export interface TpsModel {
    /** Regularization λ used (SOLVER_TPS_LAMBDA), recorded for reproducibility. */
    lambda: number;
    /** Normalization scale s (px): p̃ = (pixel − crpix)/s. Companion to control_points. */
    scale: number;
    /** crpix the offsets are measured from ([cx,cy] px) — self-describes the frame. */
    crpix: [number, number];
    /** Control points in NORMALIZED offset space [[ũ,ṽ], …]. length = control_count. */
    control_points: number[][];
    /** Spline weights w_i for the dx field. length = control_count. */
    weights_x: number[];
    /** Spline weights w_i for the dy field. length = control_count. */
    weights_y: number[];
    /** Affine (polynomial) part [a0,a1,a2] for each field, on NORMALIZED coords. */
    affine: { dx: [number, number, number]; dy: [number, number, number] };
    /** RMS residual over the control set BEFORE the spline (raw), arcsec. */
    rms_before_arcsec: number;
    /** RMS residual over the control set AFTER subtracting the spline, arcsec
     *  (== the IN-SAMPLE fit rms — laundered on its own; read tps_gate for OOS). */
    rms_after_arcsec: number;
    control_count: number;
}

/**
 * The out-of-sample EMISSION-GATE verdict (tps_fitter.ts fitTpsGated), always
 * recorded on the receipt (solution.astrometry.tps_gate) whenever the TPS fire
 * gate fired — honest-or-absent visibility into WHY a TPS was or was not emitted.
 * When `admitted` is false, solution.astrometry.tps is null; the numbers here say
 * why. All plain numbers/strings (survives the receipt replacer).
 */
export interface TpsGateVerdict {
    /** Did the spline pass every gate → emitted as solution.astrometry.tps? */
    admitted: boolean;
    /** Machine-readable refusal/admission reason. */
    reason:
        | 'ADMITTED'
        | 'COVERAGE'          // prepareControl refused (too few / lopsided control points)
        | 'SINGULAR'          // linear system singular at the selected λ
        | 'OOS_OVERFIT'       // rms_oos exceeded max(mult·insample, mult·floor)
        | 'OOS_WORSE_THAN_LINEAR' // rms_oos ≥ the no-correction (linear-WCS) residual
        | 'PHYSICS_CEILING';  // peak displacement exceeds the physical budget
    /** k used for the deterministic cross-validation. */
    cv_folds: number;
    /** Control points the fit/CV ran over (post-prune). */
    control_count: number;
    /** In-sample rms_after at the selected λ (arcsec) — the laundered number. */
    rms_insample_arcsec: number | null;
    /** MEASURED out-of-sample rms from k-fold CV (arcsec) — the honest number. */
    rms_oos_arcsec: number | null;
    /** The admit ceiling rms_oos was tested against (arcsec). */
    oos_threshold_arcsec: number | null;
    /** Linear-WCS (no-distortion) residual rms over the control set (arcsec). */
    rms_linear_arcsec: number | null;
    /** λ chosen by GCV over the grid (records the actual smoothing used). */
    lambda_selected: number | null;
    /** The GCV grid scored: {lambda, gcv} per candidate (reproducibility). */
    lambda_grid: { lambda: number; gcv: number }[];
    /** Effective degrees of freedom (trace of the smoother) at the selected λ. */
    effective_dof: number | null;
    /** Max control-point radius in PIXELS (== tps.scale) — the extrapolation hull
     *  limit; consumers must refuse evaluation beyond it. */
    hull_radius_px: number | null;
    /** Fraction of CV test points that fell outside the training fold's hull and
     *  were excluded from the OOS rms (extrapolation honesty). */
    out_of_hull_fraction: number | null;
    /** Peak fitted spline displacement over the control set (arcsec). */
    displacement_amplitude_arcsec: number | null;
    /** Physical displacement ceiling (arcsec) the amplitude was tested against. */
    physics_ceiling_arcsec: number | null;
    /** Field span used for the physics budget (deg, from the control hull). */
    field_span_deg: number | null;
}

/** A residual pair in pixel-offset space: u,v = detected − crpix; dx,dy =
 *  detected − linear-WCS-predicted. The input contract for fitTpsCore (both the
 *  solution adapter fitTps and the CR2 evidence rig build these). */
export interface TpsPair { u: number; v: number; dx: number; dy: number; }

interface Pair extends TpsPair { resPx: number; }

/**
 * Build the TPS input pairs (u,v,dx,dy in pixel-offset space) from a solved
 * plate's matched stars — the SHARED front-end of both fitTps and fitTpsGated
 * (single source of the filter + skyToLinearPixel convention). Returns null when
 * unsolved or too few refinable matches to even attempt. `crpix` is the frame
 * origin the offsets are measured from.
 */
function buildTpsInput(solution: PlateSolution): { input: TpsPair[]; crpix: [number, number] } | null {
    const wcs = solution.wcs;
    if (!wcs) return null;

    // Same filter + convention as the SIP fitter (planet sentinels excluded).
    const matches = (solution.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) &&
        m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_')
    );
    if (matches.length < TPS.MIN_CONTROL) return null;

    const crpix: [number, number] = [wcs.crpix[0], wcs.crpix[1]];
    const input: TpsPair[] = [];
    for (const m of matches) {
        const { x: expX, y: expY } = ResidualAnalyzer.skyToLinearPixel(m.catalog.ra, m.catalog.dec, wcs);
        const dx = m.detected.x - expX;
        const dy = m.detected.y - expY;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        input.push({ u: m.detected.x - crpix[0], v: m.detected.y - crpix[1], dx, dy });
    }
    return { input, crpix };
}

/**
 * Fit a regularized TPS to a solved plate's matched-star residual field.
 * Returns null (honest-absent) when there is no WCS, or the coverage gate refuses
 * the sample, or the linear system is singular. Pure — no wasm/atlas/DOM.
 *
 * NOTE: this is the UNGATED geometric fit (fixed λ). The pipeline emits through
 * fitTpsGated (out-of-sample CV + GCV λ + physics ceiling); fitTps stays as the
 * bare fit for tools/tests that pass an explicit λ and want the raw spline.
 */
export function fitTps(solution: PlateSolution, lambda = PIPELINE_CONSTANTS.SOLVER_TPS_LAMBDA): TpsModel | null {
    const built = buildTpsInput(solution);
    if (!built) return null;
    return fitTpsCore(built.input, solution.pixel_scale, built.crpix, lambda);
}

/**
 * The pure TPS fit core over residual pairs (u,v,dx,dy) already in pixel-offset
 * space. Applies the coverage discipline (min-count + octant + pruning),
 * normalizes, solves the regularized system for the dx/dy fields, and returns the
 * model — or null (honest-absent) when coverage refuses the sample or the system
 * is singular. The solution adapter (fitTps) and the CR2 evidence rig share this.
 *
 * @param crpix  the frame origin the offsets are measured from (recorded in the
 *               model; self-describes the tabular grid the ASDF writer bakes).
 */
export function fitTpsCore(
    input: TpsPair[],
    pixelScale: number,
    crpix: [number, number],
    lambda = PIPELINE_CONSTANTS.SOLVER_TPS_LAMBDA,
): TpsModel | null {
    const prep = prepareControl(input);
    if (!prep) return null;
    const { pairs, scale } = prep;
    const fit = assembleAndSolve(pairs, scale, lambda);
    if (!fit) return null; // singular → honest-absent

    const n = pairs.length;
    const un = pairs.map(p => p.u / scale);
    const vn = pairs.map(p => p.v / scale);

    // RMS before (raw residuals) and after (residuals minus the fitted spline).
    let sumBefore = 0, sumAfter = 0;
    for (let i = 0; i < n; i++) {
        sumBefore += pairs[i].resPx * pairs[i].resPx;
        const fx = evalTpsField(un[i], vn[i], un, vn, fit.weights_x, fit.affine.dx);
        const fy = evalTpsField(un[i], vn[i], un, vn, fit.weights_y, fit.affine.dy);
        const rx = pairs[i].dx - fx, ry = pairs[i].dy - fy;
        sumAfter += rx * rx + ry * ry;
    }
    const rms_before_arcsec = Math.sqrt(sumBefore / n) * pixelScale;
    const rms_after_arcsec = Math.sqrt(sumAfter / n) * pixelScale;

    // control_points in normalized space, paired with weights, all plain arrays.
    const control_points = un.map((u, i) => [u, vn[i]]);

    return {
        lambda, scale, crpix,
        control_points, weights_x: fit.weights_x, weights_y: fit.weights_y, affine: fit.affine,
        rms_before_arcsec, rms_after_arcsec, control_count: n,
    };
}

// ─── shared fit primitives (ONE implementation; fitTpsCore + fitTpsGated both
//     consume these — LAW 4, no math living in two places) ─────────────────────

/**
 * Apply the coverage discipline (min-count + grid-prune + octant) and compute the
 * normalization scale. Returns the pruned control pairs + scale, or null when the
 * sample is too sparse / lopsided (honest-absent).
 */
function prepareControl(input: TpsPair[]): { pairs: Pair[]; scale: number } | null {
    let pairs: Pair[] = input.map(p => ({ ...p, resPx: Math.hypot(p.dx, p.dy) }));
    if (pairs.length < TPS.MIN_CONTROL) return null;
    // Spatially-distributed pruning above MAX_CONTROL (grid-bucket decimation).
    if (pairs.length > TPS.MAX_CONTROL) pairs = prune(pairs, TPS.MAX_CONTROL);
    // Coverage gate: octant occupancy (mirror BC-refit gating style).
    if (!octantCoverageOk(pairs)) return null;
    // Normalization: scale by the max control radius → normalized radii ≤ 1, so the
    // r²·ln r kernel entries are O(1) and λ trades against them meaningfully.
    let scale = 0;
    for (const p of pairs) scale = Math.max(scale, Math.hypot(p.u, p.v));
    if (!(scale > 0)) return null;
    return { pairs, scale };
}

/** Assemble the (n+3)×(n+3) TPS system  M·[w;a] = [z;0]  (shared K+P). */
function assembleM(un: number[], vn: number[], lambda: number): number[][] {
    const n = un.length, dim = n + 3;
    const M: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) M[i][j] = i === j ? lambda : tpsKernel(un[i] - un[j], vn[i] - vn[j]);
        M[i][n] = 1;      M[n][i] = 1;
        M[i][n + 1] = un[i]; M[n + 1][i] = un[i];
        M[i][n + 2] = vn[i]; M[n + 2][i] = vn[i];
    }
    return M;
}

/** Solve the two field systems (dx, dy) for weights + affine, or null if singular. */
function assembleAndSolve(pairs: Pair[], scale: number, lambda: number):
    { weights_x: number[]; weights_y: number[]; affine: { dx: [number, number, number]; dy: [number, number, number] } } | null {
    const n = pairs.length;
    const un = pairs.map(p => p.u / scale);
    const vn = pairs.map(p => p.v / scale);
    const M = assembleM(un, vn, lambda);
    const zx = pairs.map(p => p.dx).concat([0, 0, 0]);
    const zy = pairs.map(p => p.dy).concat([0, 0, 0]);
    const solX = solveLinear(cloneMatrix(M), zx.slice());
    const solY = solveLinear(cloneMatrix(M), zy.slice());
    if (!solX || !solY) return null;
    return {
        weights_x: solX.slice(0, n),
        weights_y: solY.slice(0, n),
        affine: {
            dx: [solX[n], solX[n + 1], solX[n + 2]] as [number, number, number],
            dy: [solY[n], solY[n + 1], solY[n + 2]] as [number, number, number],
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// OUT-OF-SAMPLE EMISSION GATE (fitTpsGated) — the honest-or-absent producer
// ═══════════════════════════════════════════════════════════════════════════
//
// The plain in-sample rms_after is laundered: a ~100-knot spline interpolates its
// control points (rms_after ≈ 3") while predicting non-knot stars ~10× worse
// (measured 35.7" out-of-sample on the SeeStar/M66 frame — the depth study's
// forced-photometry recovery DROPPED 1403→1136 when this TPS was applied). This
// producer emits the TPS block ONLY when MEASURED generalization admits it:
//   1. GCV λ selection over a (capped) grid — no fixed constant (part 2).
//   2. Deterministic k-fold CV → rms_oos; admit iff rms_oos ≤ mult·max(insample,
//      floor) AND rms_oos < the linear (no-correction) residual (part 1, PRIMARY).
//   3. Control-hull radius recorded + out-of-hull CV fraction reported (part 3).
//   4. Physics ceiling on peak displacement (refraction budget × margin) (part 4).
// Refusal returns tps:null + a fully-populated TpsGateVerdict (WHY it was refused).
//
// The gate constants (SOLVER_TPS_CV_FOLDS/…/WORST_SEC2_ZENITH) live in
// pipeline_config.ts with citations. This is a COORDINATE-ledger POST-solve
// observation: it never touches the WCS / matched_stars / confidence, so gating it
// can never move a sacred solve number (both e2e stay byte-identical on solve
// fields; only the honest TPS emission changes).

const EMPTY_GATE: Omit<TpsGateVerdict, 'admitted' | 'reason' | 'cv_folds'> = {
    control_count: 0, rms_insample_arcsec: null, rms_oos_arcsec: null, oos_threshold_arcsec: null,
    rms_linear_arcsec: null, lambda_selected: null, lambda_grid: [], effective_dof: null,
    hull_radius_px: null, out_of_hull_fraction: null, displacement_amplitude_arcsec: null,
    physics_ceiling_arcsec: null, field_span_deg: null,
};

/**
 * The GATED TPS producer — the pipeline's single emission entry (calibrate.ts).
 * Returns the model to emit (or null) PLUS the always-recorded gate verdict.
 * Pure — no wasm/atlas/DOM beyond the shared skyToLinearPixel the fit already uses.
 */
export function fitTpsGated(solution: PlateSolution): { tps: TpsModel | null; gate: TpsGateVerdict } {
    const built = buildTpsInput(solution);
    if (!built) return { tps: null, gate: refusedGate('COVERAGE') };
    return fitTpsGatedCore(built.input, solution.pixel_scale, built.crpix);
}

/** Refusal verdict with the empty-metrics shell (used before the fit succeeds). */
function refusedGate(reason: TpsGateVerdict['reason'], extra: Partial<TpsGateVerdict> = {}): TpsGateVerdict {
    return { admitted: false, reason, cv_folds: PIPELINE_CONSTANTS.SOLVER_TPS_CV_FOLDS, ...EMPTY_GATE, ...extra };
}

/**
 * The pure GATE core over residual pairs (u,v,dx,dy) already in pixel-offset
 * space — GCV λ + out-of-sample k-fold CV + hull + physics ceiling. fitTpsGated
 * (via skyToLinearPixel) and the unit tests (raw synthetic/receipt pairs, no wasm)
 * share this. Returns the model to emit (or null) + the always-populated verdict.
 */
export function fitTpsGatedCore(
    input: TpsPair[],
    pixelScale: number,
    crpix: [number, number],
): { tps: TpsModel | null; gate: TpsGateVerdict } {
    const CV = PIPELINE_CONSTANTS.SOLVER_TPS_CV_FOLDS;
    const refuse = (reason: TpsGateVerdict['reason'], extra: Partial<TpsGateVerdict> = {}):
        { tps: null; gate: TpsGateVerdict } => ({ tps: null, gate: refusedGate(reason, extra) });

    const prep = prepareControl(input);
    if (!prep) return refuse('COVERAGE');

    const { pairs, scale } = prep;
    const pxScale = pixelScale;
    const n = pairs.length;
    const un = pairs.map(p => p.u / scale);
    const vn = pairs.map(p => p.v / scale);

    // Linear (no-correction) residual rms over the control set — the baseline the
    // spline must beat out-of-sample to be worth carrying.
    let sumLin = 0;
    for (const p of pairs) sumLin += p.resPx * p.resPx;
    const rms_linear = Math.sqrt(sumLin / n) * pxScale;

    // (2) GCV λ selection over the grid.
    const grid = PIPELINE_CONSTANTS.SOLVER_TPS_LAMBDA_GRID;
    const lambda_grid: { lambda: number; gcv: number }[] = [];
    let best = { lambda: grid[0], gcv: Infinity, dof: NaN };
    for (const l of grid) {
        const s = gcvScore(pairs, un, vn, scale, l);
        lambda_grid.push({ lambda: l, gcv: s.gcv });
        if (s.gcv < best.gcv) best = { lambda: l, gcv: s.gcv, dof: s.dof };
    }
    const lambda = best.lambda;

    // Fit at the selected λ.
    const fit = assembleAndSolve(pairs, scale, lambda);
    if (!fit) return refuse('SINGULAR', { control_count: n, rms_linear_arcsec: rms_linear, lambda_selected: lambda, lambda_grid, effective_dof: best.dof });

    // In-sample rms + peak displacement (both from the fitted spline on control pts).
    let sumAfter = 0, maxDisp2 = 0;
    for (let i = 0; i < n; i++) {
        const fx = evalTpsField(un[i], vn[i], un, vn, fit.weights_x, fit.affine.dx);
        const fy = evalTpsField(un[i], vn[i], un, vn, fit.weights_y, fit.affine.dy);
        const rx = pairs[i].dx - fx, ry = pairs[i].dy - fy;
        sumAfter += rx * rx + ry * ry;
        maxDisp2 = Math.max(maxDisp2, fx * fx + fy * fy);
    }
    const rms_insample = Math.sqrt(sumAfter / n) * pxScale;
    const displacement_amplitude = Math.sqrt(maxDisp2) * pxScale;

    const model: TpsModel = {
        lambda, scale, crpix,
        control_points: un.map((u, i) => [u, vn[i]]),
        weights_x: fit.weights_x, weights_y: fit.weights_y, affine: fit.affine,
        rms_before_arcsec: rms_linear, rms_after_arcsec: rms_insample, control_count: n,
    };

    // (1) Out-of-sample k-fold CV.
    const oos = kfoldOos(pairs, scale, pxScale, lambda, CV);

    // (4) Physics ceiling: field span from the control hull → refraction budget.
    const field_span_deg = 2 * scale * pxScale / 3600;
    const physics_ceiling = PIPELINE_CONSTANTS.SOLVER_TPS_PHYSICS_MARGIN *
        PIPELINE_CONSTANTS.SOLVER_TPS_REFRACTION_ARCSEC_PER_DEG *
        PIPELINE_CONSTANTS.SOLVER_TPS_WORST_SEC2_ZENITH * field_span_deg;

    // Emission inequality (part 1): rms_oos ≤ mult·max(insample, floor).
    const oos_threshold = PIPELINE_CONSTANTS.SOLVER_TPS_OOS_INSAMPLE_MULT *
        Math.max(rms_insample, PIPELINE_CONSTANTS.SOLVER_TPS_OOS_FLOOR_ARCSEC);

    const gate: TpsGateVerdict = {
        admitted: false, reason: 'ADMITTED', cv_folds: CV, control_count: n,
        rms_insample_arcsec: rms_insample, rms_oos_arcsec: Number.isFinite(oos.rms_oos) ? oos.rms_oos : null,
        oos_threshold_arcsec: oos_threshold, rms_linear_arcsec: rms_linear,
        lambda_selected: lambda, lambda_grid, effective_dof: best.dof,
        hull_radius_px: scale, out_of_hull_fraction: oos.out_of_hull_fraction,
        displacement_amplitude_arcsec: displacement_amplitude,
        physics_ceiling_arcsec: physics_ceiling, field_span_deg,
    };

    let reason: TpsGateVerdict['reason'] = 'ADMITTED';
    if (!(oos.rms_oos <= oos_threshold)) reason = 'OOS_OVERFIT';
    else if (!(oos.rms_oos < rms_linear)) reason = 'OOS_WORSE_THAN_LINEAR';
    else if (!(displacement_amplitude <= physics_ceiling)) reason = 'PHYSICS_CEILING';

    const admitted = reason === 'ADMITTED';
    return { tps: admitted ? model : null, gate: { ...gate, admitted, reason } };
}

/**
 * Deterministic fold assignment: FNV-1a-style integer hash of the quantized
 * pixel-offset coordinates → fold index. NO Math.random — the same plate always
 * folds identically (reproducible CV, byte-stable verdict).
 */
function foldOf(p: TpsPair, k: number): number {
    const qu = Math.round(p.u * 4) | 0, qv = Math.round(p.v * 4) | 0;
    let h = 2166136261 >>> 0;
    h = Math.imul(h ^ (qu & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ (qv & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ ((qu >> 16) & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ ((qv >> 16) & 0xffff), 16777619) >>> 0;
    return h % k;
}

/**
 * k-fold out-of-sample rms: refit the spline on each training fold, evaluate on
 * the held-out fold, accumulate squared error over IN-HULL test points only (a
 * test point outside the training fold's radius is extrapolation — excluded and
 * counted toward out_of_hull_fraction, honest). Returns rms_oos (arcsec) and the
 * out-of-hull fraction. Deterministic (foldOf, no RNG).
 */
function kfoldOos(control: Pair[], scale: number, pxScale: number, lambda: number, k: number):
    { rms_oos: number; out_of_hull_fraction: number } {
    let sumSq = 0, count = 0, outHull = 0;
    for (let f = 0; f < k; f++) {
        const train = control.filter(p => foldOf(p, k) !== f);
        const test = control.filter(p => foldOf(p, k) === f);
        if (train.length < 10 || test.length === 0) continue;
        const m = assembleAndSolve(train, scale, lambda);
        if (!m) continue;
        const un = train.map(p => p.u / scale), vn = train.map(p => p.v / scale);
        let trMaxR = 0;
        for (const p of train) trMaxR = Math.max(trMaxR, Math.hypot(p.u, p.v) / scale);
        for (const p of test) {
            const u = p.u / scale, v = p.v / scale;
            if (Math.hypot(u, v) > trMaxR) { outHull++; continue; } // extrapolation → exclude
            const fx = evalTpsField(u, v, un, vn, m.weights_x, m.affine.dx);
            const fy = evalTpsField(u, v, un, vn, m.weights_y, m.affine.dy);
            sumSq += (p.dx - fx) ** 2 + (p.dy - fy) ** 2;
            count++;
        }
    }
    const rms_oos = count > 0 ? Math.sqrt(sumSq / count) * pxScale : Infinity;
    return { rms_oos, out_of_hull_fraction: control.length ? outHull / control.length : 0 };
}

/**
 * Generalized Cross-Validation score for one λ: GCV = RSS / (1 − tr(S)/n)²,
 * where S is the smoother mapping the residual field z → fitted ŷ at the control
 * points (S = [K|P]·M⁻¹·[I;0], K the PURE kernel — diagonal 0, no λ). tr(S) is the
 * effective degrees of freedom. Lower GCV = better predicted generalization; the
 * selected λ = argmin over the grid. Returns Infinity when M is singular.
 */
function gcvScore(pairs: Pair[], un: number[], vn: number[], scale: number, lambda: number):
    { gcv: number; dof: number } {
    const n = pairs.length;
    const M = assembleM(un, vn, lambda);
    const Minv = invertMatrix(cloneMatrix(M));
    if (!Minv) return { gcv: Infinity, dof: NaN };
    let trS = 0;
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let a = 0; a < n; a++) {
            const kp = a === i ? 0 : tpsKernel(un[i] - un[a], vn[i] - vn[a]);
            acc += kp * Minv[a][i];
        }
        acc += Minv[n][i] + un[i] * Minv[n + 1][i] + vn[i] * Minv[n + 2][i];
        trS += acc;
    }
    const fit = assembleAndSolve(pairs, scale, lambda);
    if (!fit) return { gcv: Infinity, dof: trS };
    let rss = 0;
    for (let i = 0; i < n; i++) {
        const fx = evalTpsField(un[i], vn[i], un, vn, fit.weights_x, fit.affine.dx);
        const fy = evalTpsField(un[i], vn[i], un, vn, fit.weights_y, fit.affine.dy);
        rss += (pairs[i].dx - fx) ** 2 + (pairs[i].dy - fy) ** 2;
    }
    const denom = 1 - trS / n;
    return { gcv: rss / (denom * denom || 1e-9), dof: trS };
}

// ─── control-point pruning (grid-bucket decimation) ────────────────────────────

/**
 * Reduce to ≤ target spatially-distributed control points: partition the pair
 * bounding box into an ≈√target × √target uniform cell grid and keep, per occupied
 * cell, the pair NEAREST that cell's centre. Nearest-centre (not lowest-residual)
 * is deliberate: it samples the distortion field UNIFORMLY without biasing toward
 * low-distortion points — a residual-ranked prune would preferentially DROP the
 * high-distortion edge stars the spline most needs (and would bias rms_before
 * low). De-clusters dense regions so no local knot-pileup dominates the spline or
 * ill-conditions K, while preserving frame-wide coverage.
 */
function prune(pairs: Pair[], target: number): Pair[] {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of pairs) {
        uMin = Math.min(uMin, p.u); uMax = Math.max(uMax, p.u);
        vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v);
    }
    const g = Math.max(1, Math.round(Math.sqrt(target)));
    const uSpan = (uMax - uMin) || 1, vSpan = (vMax - vMin) || 1;
    const best = new Map<number, { p: Pair; d: number }>();
    for (const p of pairs) {
        const gi = Math.min(g - 1, Math.floor(((p.u - uMin) / uSpan) * g));
        const gj = Math.min(g - 1, Math.floor(((p.v - vMin) / vSpan) * g));
        const cu = uMin + (gi + 0.5) * (uSpan / g);
        const cv = vMin + (gj + 0.5) * (vSpan / g);
        const d = (p.u - cu) * (p.u - cu) + (p.v - cv) * (p.v - cv);
        const key = gi * g + gj;
        const cur = best.get(key);
        if (!cur || d < cur.d) best.set(key, { p, d });
    }
    return Array.from(best.values()).map(e => e.p);
}

// ─── octant coverage gate (mirror BC-refit) ────────────────────────────────────

function octantCoverageOk(pairs: Pair[]): boolean {
    const counts = new Array(OCTANT_COUNT).fill(0);
    for (const p of pairs) {
        let a = Math.atan2(p.v, p.u);
        if (a < 0) a += 2 * Math.PI;
        counts[Math.min(OCTANT_COUNT - 1, Math.floor(a / (Math.PI / 4)))]++;
    }
    const occupied = counts.filter(c => c >= TPS.OCTANT_MIN).length;
    return occupied >= TPS.MIN_OCTANTS;
}

// ─── small dense linear solver (Gaussian elimination, partial pivoting) ────────

function cloneMatrix(A: number[][]): number[][] { return A.map(r => r.slice()); }

/** Solve A·x = b in place; returns x, or null if (near-)singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
    const n = b.length;
    for (let col = 0; col < n; col++) {
        let piv = col, max = Math.abs(A[col][col]);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(A[r][col]);
            if (v > max) { max = v; piv = r; }
        }
        if (max < 1e-12) return null; // singular
        if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
        const inv = 1 / A[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = A[r][col] * inv;
            if (f === 0) continue;
            for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
            b[r] -= f * b[col];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let s = b[i];
        for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
    }
    return x;
}

/**
 * Full matrix inverse via Gauss-Jordan with partial pivoting; returns A⁻¹ or null
 * if (near-)singular. Used ONLY by the GCV score (smoother-trace = effective DoF);
 * NOT on the fit's byte path (the fit uses solveLinear). n ≤ MAX_CONTROL+3 ≈ 123,
 * so the O(n³) inverse is cheap and runs once per grid λ in the post-solve stage.
 */
function invertMatrix(A: number[][]): number[][] | null {
    const n = A.length;
    const M: number[][] = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let col = 0; col < n; col++) {
        let piv = col, max = Math.abs(M[col][col]);
        for (let r = col + 1; r < n; r++) { const v = Math.abs(M[r][col]); if (v > max) { max = v; piv = r; } }
        if (max < 1e-12) return null;
        if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
        const inv = 1 / M[col][col];
        for (let c = 0; c < 2 * n; c++) M[col][c] *= inv;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            if (f === 0) continue;
            for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map(r => r.slice(n));
}
