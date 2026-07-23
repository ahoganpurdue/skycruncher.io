/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CELL ② — PER-BAND VIGNETTE / TRANSMISSION MAP (PSF-measurement calibration)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (the FIT reads native pixels), but the PRODUCT is a per-star
 * MEASUREMENT-CALIBRATION divisor — a physical map applied to the EXTRACTED
 * FLUX at a star's position, NEVER a buffer pre-warp (MULTILAYER_MATRIX §4
 * doctrine). One physical falloff, applied per-band where COLOR is the product.
 *
 * Model (ported + extended from tools/psf/corrections.mjs `fitVignetteFromFrame`,
 * LAW-4 incubator→engine): gain(r) = 1 + a2·r² + a4·r⁴ with r² normalized to the
 * half-diagonal from the FRAME CENTER. The frame's own sky is fit against
 * plane(x,y)/gain(r) via a grid search over (a2,a4) minimizing a robust-plane
 * clipped RMS (the linear plane absorbs the light-pollution gradient so it is not
 * mistaken for optical falloff).
 *
 * CHROMATICITY (the whole point): a SINGLE achromatic radial gain CANCELS in the
 * flux_b/flux_r color ratio and corrects only magnitude/zero-point. To correct
 * COLOR the map MUST be fit PER BAND — a2/a4 differ between R/G/B because the
 * optics + sensor QE have chromatic falloff. This module fits all of R, G, B AND
 * a luminance band; the color consumers (SPCC) use the per-band gains, the
 * luminance-only consumers (psf_field amp, forced photometry) use `luma`.
 *
 * APPLICATION: corrected_flux = measured_flux · gainAt(x,y,band)  (equivalently
 * measured_flux / transmissionAt, transmission = 1/gain ∈ (0,1]). APPROXIMATE —
 * fit uncertainty (fitRms) is a fractional flux-uncertainty term the consumers
 * propagate honestly. Everything is DEFAULT-OFF at the consumer gate
 * (PSF_FLUX_VIGNETTE_CORRECT); this module has no side effects.
 */

/** A fitted single-band radial gain: gain(r)=1+a2·r²+a4·r⁴ (r² over half-diag). */
export interface VignetteBandFit {
    a2: number;
    a4: number;
    /** Robust-plane clipped RMS of the fit residual (fractional flux uncertainty). */
    fitRms: number;
    /** True when the grid search hit the a2/a4 boundary (fit under-constrained). */
    atGridBound: boolean;
    /** Corner/center sky-median ratio before/after correction (diagnostic). */
    cornerCenterRatioBefore: number;
    cornerCenterRatioAfter: number;
}

/** A per-band vignette map: one physical falloff, fit per channel + luminance. */
export interface VignetteMap {
    /** Frame center (px) the radial model is measured from. */
    center: { cx: number; cy: number };
    /** Half-diagonal (px) — the r² normalization length. */
    halfDiagPx: number;
    width: number;
    height: number;
    /** Bin grid used for the fit (gridN × gridN cells). */
    gridN: number;
    r: VignetteBandFit;
    g: VignetteBandFit;
    b: VignetteBandFit;
    /** Achromatic luminance band — for luminance-only consumers. */
    luma: VignetteBandFit;
    approximate: string[];
}

export type VignetteBand = 'r' | 'g' | 'b' | 'luma';

// ─── binning (star-robust: per-cell median) ────────────────────────────────────

interface Cells { med: number[]; cx: number[]; cy: number[]; }

/**
 * Bin one interleaved-RGB channel (or a synthesized luma) into gridN×gridN cells,
 * taking the MEDIAN per cell (star-robust) + the cell CENTROID. `pick(i)` reads
 * the scalar value for pixel index i.
 */
function binChannel(w: number, h: number, gridN: number, pick: (pixelIdx: number) => number): Cells {
    const med: number[] = [], cx: number[] = [], cy: number[] = [];
    const cw = Math.max(1, Math.floor(w / gridN));
    const ch = Math.max(1, Math.floor(h / gridN));
    for (let gy = 0; gy < gridN; gy++) {
        const y0 = gy * ch, y1 = gy === gridN - 1 ? h : Math.min(h, y0 + ch);
        for (let gx = 0; gx < gridN; gx++) {
            const x0 = gx * cw, x1 = gx === gridN - 1 ? w : Math.min(w, x0 + cw);
            const vals: number[] = [];
            // Subsample within the cell (cap work on large frames).
            const stepX = Math.max(1, Math.floor((x1 - x0) / 24));
            const stepY = Math.max(1, Math.floor((y1 - y0) / 24));
            for (let y = y0; y < y1; y += stepY) {
                const row = y * w;
                for (let x = x0; x < x1; x += stepX) {
                    const v = pick(row + x);
                    if (Number.isFinite(v)) vals.push(v);
                }
            }
            if (vals.length < 4) continue;
            vals.sort((a, b) => a - b);
            med.push(vals[vals.length >> 1]);
            cx.push((x0 + x1) / 2);
            cy.push((y0 + y1) / 2);
        }
    }
    return { med, cx, cy };
}

// ─── single-band grid fit (faithful port of corrections.mjs) ───────────────────

function fitBand(cells: Cells, w: number, h: number): VignetteBandFit {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const hd2 = cx * cx + cy * cy || 1;
    const n = cells.med.length;
    if (n < 6) {
        return { a2: 0, a4: 0, fitRms: Infinity, atGridBound: false, cornerCenterRatioBefore: NaN, cornerCenterRatioAfter: NaN };
    }
    const r2 = new Float64Array(n), xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dx = cells.cx[i] - cx, dy = cells.cy[i] - cy;
        r2[i] = (dx * dx + dy * dy) / hd2;
        xs[i] = dx / (cx || 1); ys[i] = dy / (cy || 1);
    }

    const planeRms = (v: Float64Array): { rms: number; coef: number[] } => {
        const use = new Uint8Array(n).fill(1);
        let coef: number[] = [0, 0, 0];
        for (let pass = 0; pass < 2; pass++) {
            let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0, m = 0;
            for (let i = 0; i < n; i++) {
                if (!use[i]) continue;
                s0++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
                sv += v[i]; svx += v[i] * xs[i]; svy += v[i] * ys[i]; m++;
            }
            const A = [s0, sx, sy, sx, sxx, sxy, sy, sxy, syy];
            const b = [sv, svx, svy];
            const det = (M: number[]) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
            const D = det(A);
            if (Math.abs(D) < 1e-12) return { rms: Infinity, coef: [0, 0, 0] };
            const rep = (M: number[], col: number, vec: number[]) => { const C = M.slice(); C[col] = vec[0]; C[col + 3] = vec[1]; C[col + 6] = vec[2]; return C; };
            coef = [det(rep(A, 0, b)) / D, det(rep(A, 1, b)) / D, det(rep(A, 2, b)) / D];
            let ss = 0;
            const res = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                res[i] = v[i] - (coef[0] + coef[1] * xs[i] + coef[2] * ys[i]);
                if (use[i]) ss += res[i] * res[i];
            }
            const sigma = Math.sqrt(ss / Math.max(1, m));
            if (pass === 0) { for (let i = 0; i < n; i++) use[i] = Math.abs(res[i]) <= 2.5 * sigma ? 1 : 0; }
            else return { rms: sigma, coef };
        }
        return { rms: Infinity, coef };
    };

    const v = new Float64Array(n);
    const evalCand = (a2: number, a4: number) => {
        for (let i = 0; i < n; i++) v[i] = cells.med[i] * (1 + a2 * r2[i] + a4 * r2[i] * r2[i]);
        return planeRms(v);
    };
    let best = { a2: 0, a4: 0, rms: Infinity };
    for (let a2 = 0; a2 <= 1.6001; a2 += 0.08) {
        for (let a4 = 0; a4 <= 1.6001; a4 += 0.08) {
            const { rms } = evalCand(a2, a4);
            if (rms < best.rms) best = { a2: +a2.toFixed(2), a4: +a4.toFixed(2), rms };
        }
    }
    // corner/center diagnostic
    const gBest = (rr: number) => 1 + best.a2 * rr + best.a4 * rr * rr;
    const centerVals: number[] = [], cornerVals: number[] = [], cornerCorr: number[] = [];
    for (let i = 0; i < n; i++) {
        if (r2[i] < 0.04) centerVals.push(cells.med[i]);
        if (r2[i] > 0.72) { cornerVals.push(cells.med[i]); cornerCorr.push(cells.med[i] * gBest(r2[i])); }
    }
    const med = (a: number[]) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    const c0 = med(centerVals), cB = med(cornerVals), cA = med(cornerCorr);
    return {
        a2: best.a2, a4: best.a4, fitRms: +best.rms.toFixed(6),
        atGridBound: best.a2 >= 1.6 || best.a4 >= 1.6,
        cornerCenterRatioBefore: +(cB / c0).toFixed(4),
        cornerCenterRatioAfter: +(cA / c0).toFixed(4),
    };
}

// ─── producers ─────────────────────────────────────────────────────────────────

export interface FitVignetteOptions {
    /** Bin grid edge (default 16 → 256 cells). */
    gridN?: number;
}

/**
 * Fit a PER-BAND vignette map from an interleaved-RGB frame (Float32, w·h·3,
 * index=(y·w+x)·3+ch). Fits R, G, B independently + a luma band L=(R+G+B)/3.
 * Pure; no side effects. The frame is read NATIVE (never warped).
 */
export function fitVignettePerBand(
    rgb: Float32Array, w: number, h: number, opts?: FitVignetteOptions,
): VignetteMap {
    const gridN = Math.max(6, Math.floor(opts?.gridN ?? 16));
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const r = fitBand(binChannel(w, h, gridN, i => rgb[i * 3]), w, h);
    const g = fitBand(binChannel(w, h, gridN, i => rgb[i * 3 + 1]), w, h);
    const b = fitBand(binChannel(w, h, gridN, i => rgb[i * 3 + 2]), w, h);
    const luma = fitBand(binChannel(w, h, gridN, i => (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3), w, h);
    return {
        center: { cx, cy }, halfDiagPx: Math.hypot(cx, cy), width: w, height: h, gridN,
        r, g, b, luma,
        approximate: [
            'Vignette gain(r)=1+a2·r²+a4·r⁴ fit from the frame\'s own sky (plane absorbs LP gradient) — APPROXIMATE.',
            'Per-band a2/a4 fit independently so the correction is CHROMATIC (a single achromatic gain cancels in color ratios and would not correct color).',
        ],
    };
}

/**
 * Fit a LUMA-only vignette map from a single-channel luminance frame (Float32,
 * w·h). R/G/B are set equal to the luma fit (no color information available from
 * a luminance buffer — honest). For the luminance-only consumers (psf_field amp,
 * forced photometry) on non-FITS frames where no per-band buffer exists.
 */
export function fitVignetteLuma(
    lum: Float32Array, w: number, h: number, opts?: FitVignetteOptions,
): VignetteMap {
    const gridN = Math.max(6, Math.floor(opts?.gridN ?? 16));
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const luma = fitBand(binChannel(w, h, gridN, i => lum[i]), w, h);
    return {
        center: { cx, cy }, halfDiagPx: Math.hypot(cx, cy), width: w, height: h, gridN,
        r: luma, g: luma, b: luma, luma,
        approximate: [
            'Vignette gain(r)=1+a2·r²+a4·r⁴ fit from the frame\'s own sky — APPROXIMATE.',
            'LUMINANCE-only fit: no per-band color information available (single-channel buffer); R=G=B=luma (magnitude/zero-point correction only, NOT color).',
        ],
    };
}

// ─── evaluators ─────────────────────────────────────────────────────────────────

function bandFit(map: VignetteMap, band: VignetteBand): VignetteBandFit {
    return band === 'r' ? map.r : band === 'g' ? map.g : band === 'b' ? map.b : map.luma;
}

/** Multiplicative flux-recovery gain at (x,y) for a band: 1+a2·r²+a4·r⁴ (≥1 out). */
export function gainAt(map: VignetteMap, x: number, y: number, band: VignetteBand): number {
    const f = bandFit(map, band);
    if (!Number.isFinite(f.a2) || !Number.isFinite(f.a4)) return 1;
    const dx = x - map.center.cx, dy = y - map.center.cy;
    const r2 = (dx * dx + dy * dy) / (map.halfDiagPx * map.halfDiagPx || 1);
    return 1 + f.a2 * r2 + f.a4 * r2 * r2;
}

/** Transmission T=1/gain ∈ (0,1] — corrected_flux = measured_flux / T. */
export function transmissionAt(map: VignetteMap, x: number, y: number, band: VignetteBand): number {
    const g = gainAt(map, x, y, band);
    return g > 0 ? 1 / g : 1;
}

// ─── receipt serializer (additive, honest-or-absent) ───────────────────────────

export function serializeVignetteMap(map: VignetteMap | null): Record<string, unknown> | null {
    if (!map) return null;
    const band = (f: VignetteBandFit) => ({
        a2: f.a2, a4: f.a4, fit_rms: f.fitRms, at_grid_bound: f.atGridBound,
        corner_center_ratio_before: f.cornerCenterRatioBefore,
        corner_center_ratio_after: f.cornerCenterRatioAfter,
    });
    return {
        model: 'gain(r)=1+a2*r2+a4*r4 (r2 over half-diag from center)',
        tier: 'APPROXIMATE',
        center: map.center, half_diag_px: map.halfDiagPx, grid_n: map.gridN,
        r: band(map.r), g: band(map.g), b: band(map.b), luma: band(map.luma),
        approximate: map.approximate,
    };
}
