// ═══════════════════════════════════════════════════════════════════════════
// MEASURED PER-CAPTURE BROWN-CONRADY REFIT (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// NEXT_MOVES §8 follow-up: the DEFERRED "per-copy LM/SIP refit from real matched
// pairs" now ported into the engine, behind a module seam.
//
// TWO-LEDGER LAW: this is a COORDINATE-space measurement over sparse matched
// POINTS — it fits a distortion FUNCTION to the (detected − rectilinear-predicted)
// displacement field. It NEVER resamples pixels and NEVER mutates the WCS,
// matched_stars, or the solve confidence. It is a pure OBSERVATION appended to
// the receipt (`lens_distortion_measured`). Because it only reads the already-
// solved pairs and writes a new receipt block, wiring it costs ZERO change to
// the sacred solve — both e2e's stay byte-identical for free.
//
// DISTINCT FROM THE NOMINAL PRIOR (`lens_distortion.ts`): that module carries an
// APPROXIMATE library prior (LENS_DB k1/k2), applied to matching BEFORE the
// solve when a trusted-EXIF lens resolves. THIS module carries the MEASURED
// coefficients fitted from THIS capture's own matched stars, labeled
// `provenance:'MEASURED'`. The two are NEVER conflated (the retired Rust ASDF
// path shipped a hardcoded prior mislabeled as measured — this seam exists so
// that can never recur: measured is measured, prior is APPROXIMATE).
//
// DELIBERATE INCUBATOR DUPLICATION (CLAUDE.md LAW 4): the fit math (weighted
// robust LS, Brown-Conrady basis, coverage-discipline gates, mustache verdict)
// is a faithful port of the verified prototype `tools/psf/refit_distortion.mjs`.
// The tool lane stays the fast-iteration incubator + its OWN value is EXPANDED
// coverage via forced re-detection (it re-decodes the frame and pairs ~10× more
// stars); THIS engine seam does the LIGHT version — it fits the SAME model on
// the pairs the solver ALREADY verified, needing no decode/atlas. Keep the two
// in sync when the model changes.
//
// MODEL (all terms LINEAR in parameters; 2 equations per pair):
//   normalized undistorted coords x' = (xu−cx)/hd, y' = (yu−cy)/hd, r² = x'²+y'²;
//   observed displacement d = (detected − rectilinear-predicted)/hd.
//     WCS-residual absorbers (imperfect linear solution, NOT lens terms):
//       tx,ty : translation (crpix error) · rot : field rotation · a : radial scale
//     Lens terms:  k1,k2,k3 : Brown-Conrady radial · p1,p2 : decentering
//   Weighted least squares on 2N equations, covariance = (XᵀWX)⁻¹ inflated by
//   reduced χ²; two 3σ reclips on |2D residual|.
//
// COVERAGE DISCIPLINE (faithful port — same honesty rules as the tool). These
// are the fitter's OWN admit-a-term thresholds; they are NOT solver sigma gates
// and NOT GATES.md numbers — they decide which higher-order terms the sample can
// honestly support, and refuse the rest rather than laundering a coverage hole
// into fake lens physics.

import type { PlateSolution, WCSTransform } from '../../types/Main_types';
import { SkyTransform } from '../../core/SkyTransform';

// ─── coverage-discipline thresholds (ported verbatim from refit_distortion.mjs) ─
const COV = {
    /** k2 (r⁵) only when the sample reaches the corners AND has body out there. */
    K2_RMAX: 0.8,
    K2_MIN_BEYOND_0_6: 30,
    /** k3 (r⁷) only for near-full-corner coverage. */
    K3_RMAX: 0.95,
    K3_MIN_BEYOND_0_85: 25,
    /** p1/p2 (decentering) only when the azimuth is well-filled. */
    TANGENTIAL_MIN_OCTANTS: 5,
    OCTANT_OCCUPANCY: 15,
    /** Minimum matched pairs to attempt even the base {tx,ty,rot,a,k1} fit (2·k). */
    MIN_PAIRS: 10,
} as const;

const OCTANT_LABELS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;

// ─── a normalized matched pair (undistorted-predicted + detected, about center) ─
export interface DistortionPair {
    /** normalized undistorted-predicted coords (about frame center / half-diag). */
    xn: number;
    yn: number;
    /** normalized displacement (detected − undistorted-predicted). */
    dx: number;
    dy: number;
    /** normalized radius of the undistorted position (for coverage gating). */
    ru: number;
    /** fit weight (inverse variance); default 1 for solver-verified pairs. */
    w: number;
}

export interface MeasuredDistortion {
    provenance: 'MEASURED';
    model: 'brown-conrady';
    /** Exported/consumed radial coefficients (k1/k2 only — the applied contract). */
    k1: number;
    /** null when the coverage gate refused the quintic term. */
    k2: number | null;
    /** Full measured coefficient record (k3/p1/p2 measured for the RECORD, NOT applied). */
    coefficients: Record<string, { value: number; sigma: number }>;
    terms: string[];
    n_pairs: number;
    n_used: number;
    rms_2d_px: number;
    radial_residual_rms_px: number;
    tangential_residual_rms_px: number;
    /** SAME pairs, lens terms zeroed (tx/ty/rot/a absorbers only) — the honest "before". */
    baseline_rms_2d_px: number | null;
    r_max_sampled: number;
    octant_counts: number[];
    octant_labels: readonly string[];
    /** Which higher-order terms the coverage gate REFUSED (honest-absent, not silent). */
    coverage_refused: { k2: boolean; k3: boolean; tangential: boolean };
    decentering_confound_warning: string | null;
    mustache: MustacheVerdict;
    frame_center: [number, number];
    half_diag_px: number;
    /** Set (with numeric fields null/0) when coverage genuinely could not fit even k1. */
    not_measured?: string;
}

export interface MustacheVerdict {
    verdict:
        | 'MUSTACHE MEASURED'
        | 'SIGN FLIP PRESENT BUT NOT SIGNIFICANT'
        | 'NO SIGN FLIP MEASURED'
        | 'UNDETERMINED';
    reason?: string;
    sign_flip_r?: number;
    inner_lobe_sigma?: number;
    outer_lobe_sigma?: number;
}

// ════════════════════════════════ FIT CORE ═════════════════════════════════
// Pure, wasm-free, atlas-free — testable directly with synthetic pairs.

/** In-place Gauss-Jordan inverse of a small k×k matrix; null if singular. */
function invertSmall(A: number[][]): number[][] | null {
    const k = A.length;
    const M = A.map((row, i) => {
        const r = new Float64Array(2 * k);
        r.set(row); r[k + i] = 1;
        return r;
    });
    for (let col = 0; col < k; col++) {
        let piv = col;
        for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-18) return null;
        [M[col], M[piv]] = [M[piv], M[col]];
        const d = M[col][col];
        for (let c = 0; c < 2 * k; c++) M[col][c] /= d;
        for (let r = 0; r < k; r++) {
            if (r === col) continue;
            const f = M[r][col];
            for (let c = 0; c < 2 * k; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map((row) => Array.from(row.slice(k)));
}

interface FitRow { basis: Float64Array; obs: number; w: number; }
interface WeightedSolution { coef: number[]; cov: number[][]; coefSigma: number[]; chi2red: number; }

/** Weighted LS over rows (each pair contributes two rows sharing its weight). */
function solveWeighted(rows: FitRow[], k: number): WeightedSolution | null {
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const b = new Float64Array(k);
    let m = 0;
    for (const row of rows) {
        if (!(row.w > 0)) continue;
        for (let i = 0; i < k; i++) {
            b[i] += row.w * row.obs * row.basis[i];
            for (let j = 0; j < k; j++) A[i][j] += row.w * row.basis[i] * row.basis[j];
        }
        m++;
    }
    if (m < 2 * k) return null;
    const Ainv = invertSmall(A.map((r) => Array.from(r)));
    if (!Ainv) return null;
    const coef = Ainv.map((r) => r.reduce((s, v, j) => s + v * b[j], 0));
    let chi2 = 0;
    for (const row of rows) {
        if (!(row.w > 0)) continue;
        let pred = 0;
        for (let i = 0; i < k; i++) pred += coef[i] * row.basis[i];
        chi2 += row.w * (row.obs - pred) ** 2;
    }
    const chi2red = m > k ? chi2 / (m - k) : 1;
    const infl = Math.max(1, chi2red);
    const cov = Ainv.map((r) => r.map((v) => v * infl));
    const coefSigma = cov.map((r, i) => Math.sqrt(Math.max(0, r[i])));
    return { coef, cov, coefSigma, chi2red };
}

/** Basis vectors {bx, by} for one pair at normalized (xn, yn) over the term set. */
function pairBasis(xn: number, yn: number, terms: string[]): { bx: Float64Array; by: Float64Array } {
    const r2 = xn * xn + yn * yn;
    const bx = new Float64Array(terms.length);
    const by = new Float64Array(terms.length);
    terms.forEach((t, i) => {
        switch (t) {
            case 'tx': bx[i] = 1; by[i] = 0; break;
            case 'ty': bx[i] = 0; by[i] = 1; break;
            case 'rot': bx[i] = -yn; by[i] = xn; break;
            case 'a': bx[i] = xn; by[i] = yn; break;
            case 'k1': bx[i] = xn * r2; by[i] = yn * r2; break;
            case 'k2': bx[i] = xn * r2 * r2; by[i] = yn * r2 * r2; break;
            case 'k3': bx[i] = xn * r2 * r2 * r2; by[i] = yn * r2 * r2 * r2; break;
            case 'p1': bx[i] = r2 + 2 * xn * xn; by[i] = 2 * xn * yn; break;
            case 'p2': bx[i] = 2 * xn * yn; by[i] = r2 + 2 * yn * yn; break;
            default: throw new Error(`unknown term ${t}`);
        }
    });
    return { bx, by };
}

interface ModelFit extends WeightedSolution {
    terms: string[];
    rms2D: number;
    nUsed: number;
    used: boolean[];
}

/** Robust (2 reclip rounds on |2D residual|) weighted fit of the term set. */
function fitModel(pairs: DistortionPair[], terms: string[]): ModelFit | null {
    const k = terms.length;
    let use = pairs.map(() => true);
    let result: ModelFit | null = null;
    for (let pass = 0; pass < 3; pass++) {
        const rows: FitRow[] = [];
        pairs.forEach((p, i) => {
            if (!use[i]) return;
            const { bx, by } = pairBasis(p.xn, p.yn, terms);
            rows.push({ basis: bx, obs: p.dx, w: p.w });
            rows.push({ basis: by, obs: p.dy, w: p.w });
        });
        const sol = solveWeighted(rows, k);
        if (!sol) return null;
        let ssw = 0, sw = 0, nUsed = 0;
        const resMag = pairs.map((p) => {
            const { bx, by } = pairBasis(p.xn, p.yn, terms);
            let px = 0, py = 0;
            for (let i = 0; i < k; i++) { px += sol.coef[i] * bx[i]; py += sol.coef[i] * by[i]; }
            return Math.hypot(p.dx - px, p.dy - py);
        });
        pairs.forEach((p, i) => {
            if (use[i]) { ssw += p.w * resMag[i] * resMag[i]; sw += p.w; nUsed++; }
        });
        const rms = Math.sqrt(ssw / Math.max(1e-12, sw));
        result = { ...sol, terms, rms2D: rms, nUsed, used: use };
        if (pass < 2) {
            const next = pairs.map((_, i) => resMag[i] <= 3 * rms);
            if (next.filter(Boolean).length >= 2 * k) use = next;
        }
    }
    return result;
}

/** Octant counts about the frame center (image convention, y-down). */
function octantCounts(pairs: DistortionPair[], hd: number): number[] {
    const counts = new Array(8).fill(0);
    for (const p of pairs) {
        let a = Math.atan2(p.yn * hd, p.xn * hd);
        if (a < 0) a += 2 * Math.PI;
        counts[Math.min(7, Math.floor(a / (Math.PI / 4)))]++;
    }
    return counts;
}

/**
 * Fit the Brown-Conrady distortion (+ WCS absorbers) to normalized matched
 * pairs, applying the coverage-discipline gates. Pure — no wasm/atlas. This is
 * the ported CORE; the solution adapter below builds the pairs from a solve.
 *
 * @param frameCenter  [cx, cy] px (for the receipt record).
 * @param halfDiagPx   half-diagonal px (the radial normalization length).
 */
export function fitBrownConrady(
    pairs: DistortionPair[],
    frameCenter: [number, number],
    halfDiagPx: number,
): MeasuredDistortion {
    const base = {
        provenance: 'MEASURED' as const,
        model: 'brown-conrady' as const,
        frame_center: frameCenter,
        half_diag_px: halfDiagPx,
        octant_labels: OCTANT_LABELS,
    };
    const honestAbsent = (reason: string): MeasuredDistortion => ({
        ...base,
        k1: 0, k2: null, coefficients: {}, terms: [],
        n_pairs: pairs.length, n_used: 0,
        rms_2d_px: 0, radial_residual_rms_px: 0, tangential_residual_rms_px: 0,
        baseline_rms_2d_px: null, r_max_sampled: 0,
        octant_counts: octantCounts(pairs, halfDiagPx),
        coverage_refused: { k2: true, k3: true, tangential: true },
        decentering_confound_warning: null,
        mustache: { verdict: 'UNDETERMINED', reason },
        not_measured: reason,
    });

    if (pairs.length < COV.MIN_PAIRS) {
        return honestAbsent(`insufficient matched pairs (N=${pairs.length} < ${COV.MIN_PAIRS}) for a Brown-Conrady k1 fit`);
    }

    // ── coverage gates (on the actual sample) ──
    const rs = pairs.map((p) => p.ru);
    const rMax = Math.max(...rs);
    const nBeyond06 = rs.filter((r) => r > 0.6).length;
    const nBeyond085 = rs.filter((r) => r > 0.85).length;
    const oct = octantCounts(pairs, halfDiagPx);
    const octOccupied = oct.filter((c) => c >= COV.OCTANT_OCCUPANCY).length;

    const terms = ['tx', 'ty', 'rot', 'a', 'k1'];
    const k2Refused = !(rMax >= COV.K2_RMAX && nBeyond06 >= COV.K2_MIN_BEYOND_0_6);
    const k3Refused = !(rMax >= COV.K3_RMAX && nBeyond085 >= COV.K3_MIN_BEYOND_0_85);
    const tangRefused = !(octOccupied >= COV.TANGENTIAL_MIN_OCTANTS);
    if (!k2Refused) terms.push('k2');
    if (!k3Refused) terms.push('k3');
    if (!tangRefused) terms.push('p1', 'p2');

    const fit = fitModel(pairs, terms);
    if (!fit) return honestAbsent(`fit degenerate (N=${pairs.length}, terms ${terms.join(',')})`);

    const named: Record<string, { value: number; sigma: number }> = {};
    terms.forEach((t, i) => { named[t] = { value: fit.coef[i], sigma: fit.coefSigma[i] }; });

    // residual decomposition (radial vs tangential, px) on USED pairs
    let radSS = 0, tanSS = 0, nRes = 0;
    pairs.forEach((p, i) => {
        if (!fit.used[i]) return;
        const { bx, by } = pairBasis(p.xn, p.yn, terms);
        let px = 0, py = 0;
        for (let j = 0; j < terms.length; j++) { px += fit.coef[j] * bx[j]; py += fit.coef[j] * by[j]; }
        const rx = (p.dx - px) * halfDiagPx, ry = (p.dy - py) * halfDiagPx;
        const rr = Math.hypot(p.xn, p.yn);
        if (rr > 1e-6) {
            const ux = p.xn / rr, uy = p.yn / rr;
            const rad = rx * ux + ry * uy;
            const tan = -rx * uy + ry * ux;
            radSS += rad * rad; tanSS += tan * tan; nRes++;
        }
    });
    const radialResRms = Math.sqrt(radSS / Math.max(1, nRes));
    const tangentialResRms = Math.sqrt(tanSS / Math.max(1, nRes));

    // baseline: SAME pairs, NO lens terms (absorbers only) — the honest "before"
    const baseFit = fitModel(pairs, ['tx', 'ty', 'rot', 'a']);

    const k1 = named.k1?.value ?? 0;
    const k2 = named.k2?.value ?? 0;
    const k3v = named.k3?.value ?? 0;
    const rsUsed = pairs.filter((_, i) => fit.used[i]).map((p) => p.ru);
    const rMaxUsed = rsUsed.length ? Math.max(...rsUsed) : 0;

    // mustache (sign-flip) verdict — needs the quintic term to be measurable
    let mustache: MustacheVerdict;
    if (!named.k2) {
        mustache = { verdict: 'UNDETERMINED', reason: 'quintic term not fitted (coverage gate) — a sign flip cannot be measured with a cubic-only profile' };
    } else {
        const D = (r: number) => k1 * r * r + k2 * r ** 4 + k3v * r ** 6;
        let flipR: number | null = null;
        for (let r = 0.15; r < rMaxUsed - 1e-6; r += 0.005) {
            if (D(r) === 0 || (D(r) < 0) !== (D(r + 0.005) < 0)) { flipR = r + 0.0025; break; }
        }
        if (flipR == null) {
            mustache = { verdict: 'NO SIGN FLIP MEASURED', reason: `fitted profile keeps one sign over sampled r in [0, ${rMaxUsed.toFixed(3)}]` };
        } else {
            const idx = ['k1', 'k2', 'k3'].map((t) => terms.indexOf(t)).filter((i) => i >= 0);
            const sigD = (r: number) => {
                const g = [r * r, r ** 4, r ** 6].slice(0, named.k3 ? 3 : 2);
                let v = 0;
                for (let i = 0; i < idx.length; i++) for (let j = 0; j < idx.length; j++) v += g[i] * g[j] * fit.cov[idx[i]][idx[j]];
                return Math.sqrt(Math.max(0, v));
            };
            const rIn = Math.max(0.15, flipR / 2), rOut = rMaxUsed;
            const zIn = Math.abs(D(rIn)) / Math.max(1e-30, sigD(rIn));
            const zOut = Math.abs(D(rOut)) / Math.max(1e-30, sigD(rOut));
            const significant = zIn >= 2 && zOut >= 2;
            mustache = {
                verdict: significant ? 'MUSTACHE MEASURED' : 'SIGN FLIP PRESENT BUT NOT SIGNIFICANT',
                sign_flip_r: +flipR.toFixed(3),
                inner_lobe_sigma: +zIn.toFixed(1),
                outer_lobe_sigma: +zOut.toFixed(1),
            };
        }
    }

    const decentering_confound_warning = tangRefused
        ? `azimuthal coverage too lopsided for a joint radial+decentering fit (${octOccupied}/8 octants hold ≥${COV.OCTANT_OCCUPANCY} pairs) — the reported k1/k2 may absorb decentering; treat magnitudes as upper-bound-honest, signs as tentative`
        : null;

    return {
        ...base,
        k1: +k1.toFixed(6),
        k2: named.k2 ? +k2.toFixed(6) : null,
        coefficients: Object.fromEntries(terms.map((t) => [t, {
            value: +named[t].value.toExponential(6),
            sigma: +named[t].sigma.toExponential(4),
        }])),
        terms,
        n_pairs: pairs.length,
        n_used: fit.nUsed,
        rms_2d_px: +(fit.rms2D * halfDiagPx).toFixed(4),
        radial_residual_rms_px: +radialResRms.toFixed(4),
        tangential_residual_rms_px: +tangentialResRms.toFixed(4),
        baseline_rms_2d_px: baseFit ? +(baseFit.rms2D * halfDiagPx).toFixed(4) : null,
        r_max_sampled: +rMaxUsed.toFixed(4),
        octant_counts: oct,
        octant_labels: OCTANT_LABELS,
        coverage_refused: { k2: k2Refused, k3: k3Refused, tangential: tangRefused },
        decentering_confound_warning,
        mustache,
        frame_center: frameCenter,
        half_diag_px: halfDiagPx,
    };
}

// ═══════════════════════════ SOLUTION ADAPTER ══════════════════════════════

/** Rectilinear (undistorted) predicted pixel for a catalog star under the WCS. */
function projectUndistorted(
    raHours: number, decDeg: number, wcs: WCSTransform,
): { x: number; y: number } | null {
    const cdDet = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    if (Math.abs(cdDet) < 1e-18) return null;
    const inv = [
        [wcs.cd[1][1] / cdDet, -wcs.cd[0][1] / cdDet],
        [-wcs.cd[1][0] / cdDet, wcs.cd[0][0] / cdDet],
    ];
    const p = SkyTransform.gnomonicProject(raHours, decDeg, wcs.crval[0], wcs.crval[1]);
    if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) return null;
    return {
        x: wcs.crpix[0] + inv[0][0] * p.xi + inv[0][1] * p.eta,
        y: wcs.crpix[1] + inv[1][0] * p.xi + inv[1][1] * p.eta,
    };
}

/**
 * Build normalized Brown-Conrady pairs from a solve's matched stars. Each pair
 * is (detected native px) vs (rectilinear-predicted px from the linear WCS),
 * normalized about the frame center by the half-diagonal. Planetary-verification
 * sentinels and non-finite rows are excluded. Returns null if no usable WCS.
 */
export function pairsFromSolution(
    solution: PlateSolution,
    width: number,
    height: number,
): { pairs: DistortionPair[]; cx: number; cy: number; hd: number } | null {
    const wcs = solution.wcs as WCSTransform | undefined;
    if (!wcs || !wcs.crpix || !wcs.crval || !wcs.cd) return null;
    const cx = (width - 1) / 2, cy = (height - 1) / 2;
    const hd = Math.hypot(cx, cy);
    if (!(hd > 0)) return null;
    const invHd = 1 / hd;

    const pairs: DistortionPair[] = [];
    for (const m of solution.matched_stars ?? []) {
        const gaia = m.catalog?.gaia_id || '';
        if (gaia.startsWith('planet_')) continue;
        if (!(m.residual_arcsec < 999)) continue; // planetary/penalty sentinels
        const raH = m.catalog?.ra_hours ?? (Number.isFinite(m.catalog?.ra) ? (m.catalog!.ra as number) / 15 : NaN);
        const decD = m.catalog?.dec_degrees ?? m.catalog?.dec;
        const dx = m.detected?.x, dy = m.detected?.y;
        if (!Number.isFinite(raH) || !Number.isFinite(decD) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        const pred = projectUndistorted(raH as number, decD as number, wcs);
        if (!pred) continue;
        const xn = (pred.x - cx) * invHd;
        const yn = (pred.y - cy) * invHd;
        pairs.push({
            xn, yn,
            dx: (dx - pred.x) * invHd,
            dy: (dy - pred.y) * invHd,
            ru: Math.hypot(xn, yn),
            w: 1, // solver-verified pairs — already low false-match; uniform weight
        });
    }
    return { pairs, cx, cy, hd };
}

/**
 * ALWAYS-ON measured-BC observation: fit this capture's per-copy Brown-Conrady
 * from its own solver-verified matched stars. Pure observation — mutates
 * nothing on the solution; the caller appends the result to the receipt.
 * Returns null when there is no usable WCS (honest absence). When there IS a
 * WCS but coverage is too thin, returns a report with `not_measured` set.
 */
export function measureBrownConradyFromSolution(
    solution: PlateSolution | null,
    width: number,
    height: number,
): MeasuredDistortion | null {
    if (!solution) return null;
    const built = pairsFromSolution(solution, width, height);
    if (!built) return null;
    return fitBrownConrady(built.pairs, [built.cx, built.cy], built.hd);
}

/** Compact, JSON-ready receipt block. Labeled MEASURED; honest-or-null throughout. */
export function serializeMeasuredDistortionBlock(r: MeasuredDistortion): Record<string, any> {
    return {
        provenance: r.provenance,              // 'MEASURED' — NEVER the nominal 'APPROXIMATE' prior
        model: r.model,
        k1: r.not_measured ? null : r.k1,
        k2: r.k2,
        coefficients: r.coefficients,
        terms: r.terms,
        n_pairs: r.n_pairs,
        n_used: r.n_used,
        rms_2d_px: r.not_measured ? null : r.rms_2d_px,
        radial_residual_rms_px: r.not_measured ? null : r.radial_residual_rms_px,
        tangential_residual_rms_px: r.not_measured ? null : r.tangential_residual_rms_px,
        baseline_rms_2d_px: r.baseline_rms_2d_px,
        r_max_sampled: r.r_max_sampled,
        octant_counts: r.octant_counts,
        octant_labels: r.octant_labels,
        coverage_refused: r.coverage_refused,
        decentering_confound_warning: r.decentering_confound_warning,
        mustache: r.mustache,
        frame_center: r.frame_center,
        half_diag_px: +r.half_diag_px.toFixed(2),
        not_measured: r.not_measured ?? null,
    };
}
