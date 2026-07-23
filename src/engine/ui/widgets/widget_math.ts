/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIDGET MATH — pure render-side helpers (Phase 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger note: some helpers here EVALUATE stored COORDINATE functions (SIP /
 * TPS / Brown-Conrady) purely for DISPLAY — they read already-fitted
 * coefficients out of the receipt and sample the modeled displacement on a
 * reference grid. This is render-side evaluation, NOT solving: nothing is
 * fitted, no WCS/matched_stars is mutated, the sacred solve is untouched. Each
 * evaluator mirrors an EXISTING engine convention (cited inline) so the surface
 * a widget draws matches what the pipeline actually applies (LAW 4 — the TPS
 * kernel is imported from the pipeline's single pure implementation, not
 * re-derived).
 *
 * All functions are pure (Math only, plus the pure `tps_eval` /`chart_math`
 * leaves), so they are node-unit-testable without a DOM.
 */

import { evalTpsField } from '../../pipeline/m6_plate_solve/tps_eval';
import { distortionShiftPx } from '../calibration/chart_math';

export const finite = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

// ─── color temperature (catalog B−V → Kelvin) ──────────────────────────────

/**
 * Ballesteros (2012) B−V → effective temperature (K). A published closed form,
 * APPROXIMATE for real stars but a legitimate temperature locus for a
 * color–color plot. Returns null on a non-finite / out-of-domain B−V.
 */
export function bvToKelvin(bv: number | null): number | null {
    if (bv == null || !Number.isFinite(bv)) return null;
    const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
    return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Measured "instrumental B−V"-like index from a linear peak-RGB triple, honest
 * about being a proxy: −2.5·log10(B/R) (blue over red). Larger ⇒ redder. Null
 * when R or B is non-positive (can't take the log honestly).
 */
export function rgbColorIndex(rgb: readonly number[] | null | undefined): number | null {
    if (!rgb || rgb.length < 3) return null;
    const r = rgb[0], b = rgb[2];
    if (!(r > 0) || !(b > 0)) return null;
    const idx = -2.5 * Math.log10(b / r);
    return Number.isFinite(idx) ? idx : null;
}

// ─── distortion-model evaluation (render-side; stored coefficients) ─────────

/**
 * Radial (nominal / library-prior) distortion magnitude in px at a pixel that
 * sits `rPx` off the optical center, normalized against `rRefPx`. Reuses the
 * step-6 shared `distortionShiftPx` (chart_math) — no duplicated numeric logic.
 */
export function nominalRadialShiftPx(
    rPx: number, k1: number, k2: number, k3: number, rRefPx: number,
): number {
    if (!(rRefPx > 0)) return 0;
    return Math.abs(distortionShiftPx(rPx / rRefPx, k1, k2, k3, rRefPx));
}

/**
 * MEASURED Brown-Conrady displacement magnitude (px) at pixel (x,y), using the
 * EXACT basis from `lens_distortion_refit.pairBasis`: normalized coords
 * xn=(x−cx)/hd, yn=(y−cy)/hd, r²=xn²+yn², and the LENS terms only —
 *   k1:(xn·r²)  k2:(xn·r⁴)  k3:(xn·r⁶)  p1:(r²+2xn²)  p2:(2xn·yn)  (y analogous)
 * — i.e. the nonlinear distortion, EXCLUDING the bulk {tx,ty,rot,a} similarity
 * so the surface shows the lens signature, not a uniform shift. `coeffs` is the
 * receipt's `lens_distortion_measured.coefficients` map ({value,sigma} each).
 */
export function measuredBcShiftPx(
    x: number, y: number,
    coeffs: Record<string, { value: number } | undefined> | null | undefined,
    cx: number, cy: number, halfDiagPx: number,
): number {
    if (!coeffs || !(halfDiagPx > 0)) return 0;
    const xn = (x - cx) / halfDiagPx, yn = (y - cy) / halfDiagPx;
    const r2 = xn * xn + yn * yn;
    const c = (k: string) => (coeffs[k]?.value ?? 0);
    const k1 = c('k1'), k2 = c('k2'), k3 = c('k3'), p1 = c('p1'), p2 = c('p2');
    const dxn =
        k1 * xn * r2 + k2 * xn * r2 * r2 + k3 * xn * r2 * r2 * r2 +
        p1 * (r2 + 2 * xn * xn) + p2 * (2 * xn * yn);
    const dyn =
        k1 * yn * r2 + k2 * yn * r2 * r2 + k3 * yn * r2 * r2 * r2 +
        p1 * (2 * xn * yn) + p2 * (r2 + 2 * yn * yn);
    return Math.hypot(dxn, dyn) * halfDiagPx;
}

/**
 * SIP displacement magnitude (px) at pixel (x,y). Mirrors
 * `ImageProcessor.applySipUndistort`: u=(x−crpixX)/s, v=(y−crpixY)/s, then
 * dx=s·Σ a[p][q]·u^p·v^q, dy=s·Σ b[p][q]·u^p·v^q. `s` (coordScale) defaults to
 * 1, the engine default for the receipt-carried SIP.
 */
export function sipShiftPx(
    x: number, y: number,
    a: number[][] | null | undefined, b: number[][] | null | undefined,
    crpixX: number, crpixY: number, coordScale = 1,
): number {
    if (!a || !b) return 0;
    const s = coordScale > 0 ? coordScale : 1;
    const u = (x - crpixX) / s, v = (y - crpixY) / s;
    const poly = (coeff: number[][]): number => {
        let acc = 0;
        for (let p = 0; p < coeff.length; p++) {
            const row = coeff[p];
            if (!row) continue;
            const up = Math.pow(u, p);
            for (let q = 0; q < row.length; q++) {
                const co = row[q];
                if (co) acc += co * up * Math.pow(v, q);
            }
        }
        return acc;
    };
    return Math.hypot(s * poly(a), s * poly(b));
}

/** The receipt's TPS block shape (only the fields this evaluator reads). */
export interface TpsBlock {
    scale: number;
    crpix: [number, number];
    control_points: number[][];
    weights_x: number[];
    weights_y: number[];
    affine: { dx: [number, number, number]; dy: [number, number, number] };
}

/**
 * TPS displacement magnitude (px) at pixel (x,y). Normalizes to the fitted
 * (crpix, scale) and calls the pipeline's single pure `evalTpsField` for each
 * axis — the identical evaluator the fitter and the ASDF serializer use.
 */
export function tpsShiftPx(x: number, y: number, tps: TpsBlock | null | undefined): number {
    if (!tps || !Array.isArray(tps.control_points) || tps.control_points.length === 0) return 0;
    const s = tps.scale > 0 ? tps.scale : 1;
    const u = (x - tps.crpix[0]) / s, v = (y - tps.crpix[1]) / s;
    const un = tps.control_points.map(p => p[0]);
    const vn = tps.control_points.map(p => p[1]);
    const dx = evalTpsField(u, v, un, vn, tps.weights_x, tps.affine.dx);
    const dy = evalTpsField(u, v, un, vn, tps.weights_y, tps.affine.dy);
    return Math.hypot(dx, dy);
}

// ─── binning / histograms (pure) ────────────────────────────────────────────

/** Log10-spaced histogram of positive values → {edges, counts}. Empty ⇒ null. */
export function logHistogram(
    values: number[], nbins: number,
): { edges: number[]; counts: number[]; lo: number; hi: number } | null {
    const pos = values.filter(v => Number.isFinite(v) && v > 0);
    if (pos.length === 0 || nbins < 1) return null;
    let lo = Math.min(...pos), hi = Math.max(...pos);
    if (!(hi > lo)) { hi = lo * 1.0001 + 1e-9; }        // degenerate: single value
    const lLo = Math.log10(lo), lHi = Math.log10(hi);
    const edges = Array.from({ length: nbins + 1 }, (_, i) => lLo + (lHi - lLo) * i / nbins);
    const counts = new Array(nbins).fill(0);
    for (const v of pos) {
        let bi = Math.floor((Math.log10(v) - lLo) / (lHi - lLo) * nbins);
        if (bi < 0) bi = 0; if (bi >= nbins) bi = nbins - 1;
        counts[bi]++;
    }
    return { edges: edges.map(e => Math.pow(10, e)), counts, lo, hi };
}

/**
 * Bin points into a gx×gy spatial grid over [0,w]×[0,h]. Returns row-major
 * counts (length gx·gy). Points outside the frame are clamped into the edge cell.
 */
export function binGrid(
    points: readonly { x: number; y: number }[], w: number, h: number, gx: number, gy: number,
): number[] {
    const counts = new Array(gx * gy).fill(0);
    if (!(w > 0) || !(h > 0) || gx < 1 || gy < 1) return counts;
    for (const p of points) {
        let cx = Math.floor(p.x / w * gx); if (cx < 0) cx = 0; if (cx >= gx) cx = gx - 1;
        let cy = Math.floor(p.y / h * gy); if (cy < 0) cy = 0; if (cy >= gy) cy = gy - 1;
        counts[cy * gx + cx]++;
    }
    return counts;
}
