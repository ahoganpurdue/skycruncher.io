/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DETECTION-PLANE FLATTENING — frame-measured background/vignette removal for
 * the DETECTION-luminance copy ONLY.
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL. Pure array math — no WASM, no buffers shared with science.
 *
 * OWNER TWO-PLANE INVARIANTS (verbatim intent, 2026-07-12):
 *   "things like vignette happen twice — once for star detection, and once for
 *    the render layer."
 *   1. TWO COPIES, TWO APPLICATIONS. Everything here operates on a NEW buffer
 *      (never in-place on the input). The caller feeds it the detection copy
 *      (`detectLum`); the render layer applies its OWN vignette flatten on a
 *      separate copy (tools/rawlab/aesthetic_render.mjs). Same physics,
 *      independent applications, separate copies — that is CORRECT, not
 *      doubling.
 *   2. NO CROSS-PLANE LEAKAGE. The corrected buffer this module returns must
 *      only reach detection thresholds + blob extraction. It must NEVER feed
 *      photometry (pool.refineStars), the receipt's science measurements, Mie
 *      / Rayleigh, or any render input — those keep NATIVE pixels. This mirrors
 *      the lens-distortion prior's split (matching coords corrected, photometry
 *      native; solver_entry.ts).
 *   3. FIT ONCE, RECORD. The fitted a2/a4 are returned so the caller can LOG
 *      them (and, when a receipt seam exists, record them frame-measured /
 *      APPROXIMATE). Detection-side and render-side measure the SAME physical
 *      falloff — recording now makes a future fit-once-consume-thrice
 *      unification possible without re-fitting.
 *
 * PROVENANCE: the a2/a4 grid-fit is an engine-side port of
 * tools/psf/corrections.mjs:115 `fitVignetteFromFrame` (LAW 4 graduation:
 * prototype in tools/, port behind the module seam). The SAME gain law
 * `1 + a2 r² + a4 r⁴` is fit render-side in tools/rawlab/aesthetic_render.mjs —
 * three consumers of one quantity; cite here so a unification pass finds all
 * three.
 */

export interface VignetteFrameFit {
    /** r² coefficient of gain(r) = 1 + a2 r² + a4 r⁴ (r normalized to half-diagonal). */
    a2: number;
    /** r⁴ coefficient. */
    a4: number;
    /** Clipped-plane RMS at the best (a2, a4). */
    fitRms: number;
    /** corner/center sky-median ratio BEFORE correction (< 1 ⇒ dimmer corners). */
    cornerCenterRatioBefore: number;
    /** corner/center sky-median ratio AFTER the fitted gain (target ≈ 1). */
    cornerCenterRatioAfter: number;
    /** true when the fit hit the (a2,a4) grid ceiling — treat as APPROXIMATE / suspect. */
    atGridBound: boolean;
    /** usable grid cells the fit consumed (fewer ⇒ weaker fit). */
    cells: number;
}

/** gain(r) = 1 + a2 r² + a4 r⁴, r² already normalized to the half-diagonal. */
export function vignetteGain(a2: number, a4: number): (r2: number) => number {
    return (r2: number) => 1 + a2 * r2 + a4 * r2 * r2;
}

/**
 * Robust grid-cell medians of a Float32 luminance buffer. Splits the frame
 * into gridW×gridH cells and takes a subsampled median per cell (subsampling
 * keeps it cheap on large frames while staying robust to stars/hot pixels).
 * Cells with too few finite samples are dropped.
 */
function gridCellMedians(
    lum: Float32Array,
    w: number,
    h: number,
    gridW: number,
    gridH: number
): { cx: number[]; cy: number[]; med: number[] } {
    const cellW = w / gridW;
    const cellH = h / gridH;
    // sample stride: aim for ≲ ~256 samples/cell regardless of frame size.
    const sx = Math.max(1, Math.floor(cellW / 16));
    const sy = Math.max(1, Math.floor(cellH / 16));
    const cx: number[] = [];
    const cy: number[] = [];
    const med: number[] = [];
    for (let gy = 0; gy < gridH; gy++) {
        const y0 = Math.floor(gy * cellH);
        const y1 = Math.min(h, Math.floor((gy + 1) * cellH));
        for (let gx = 0; gx < gridW; gx++) {
            const x0 = Math.floor(gx * cellW);
            const x1 = Math.min(w, Math.floor((gx + 1) * cellW));
            const vals: number[] = [];
            for (let y = y0; y < y1; y += sy) {
                const row = y * w;
                for (let x = x0; x < x1; x += sx) {
                    const v = lum[row + x];
                    if (Number.isFinite(v)) vals.push(v);
                }
            }
            if (vals.length < 8) continue;
            vals.sort((a, b) => a - b);
            cx.push(x0 + (x1 - x0) / 2);
            cy.push(y0 + (y1 - y0) / 2);
            med.push(vals[vals.length >> 1]);
        }
    }
    return { cx, cy, med };
}

/**
 * Fit gain(r) = 1 + a2 r² + a4 r⁴ against the frame's own sky:
 * observed_cell_median ≈ plane(x,y) / gain(r). Grid-search (a2, a4); for each
 * candidate multiply cell medians by gain and fit a robust least-squares plane
 * (one 2.5σ reclip); minimize the clipped RMS. The linear plane absorbs the
 * light-pollution gradient so it is not mistaken for radial falloff.
 *
 * Returns null when the frame yields too few usable cells to fit honestly
 * (caller must skip the correction — honest-or-absent, no fabricated gain).
 *
 * Direct port of tools/psf/corrections.mjs:115 (fitVignetteFromFrame) adapted
 * to take cell medians computed from a Float32 luminance buffer here.
 */
export function fitVignetteFromDetectionLum(
    lum: Float32Array,
    w: number,
    h: number
): VignetteFrameFit | null {
    const cells = gridCellMedians(lum, w, h, 24, 16);
    const n = cells.med.length;
    if (n < 24) return null; // too sparse to fit an honest 3-DOF plane + 2 gain terms

    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const hd2 = cx * cx + cy * cy;
    const r2 = new Float64Array(n);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dx = cells.cx[i] - cx;
        const dy = cells.cy[i] - cy;
        r2[i] = hd2 > 0 ? (dx * dx + dy * dy) / hd2 : 0;
        xs[i] = cx > 0 ? dx / cx : 0;
        ys[i] = cy > 0 ? dy / cy : 0;
    }

    const v = new Float64Array(n);
    const planeRms = (): number => {
        const use = new Uint8Array(n).fill(1);
        let sigma = Infinity;
        for (let pass = 0; pass < 2; pass++) {
            let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0, m = 0;
            for (let i = 0; i < n; i++) {
                if (!use[i]) continue;
                s0++; sx += xs[i]; sy += ys[i];
                sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
                sv += v[i]; svx += v[i] * xs[i]; svy += v[i] * ys[i]; m++;
            }
            const A = [s0, sx, sy, sx, sxx, sxy, sy, sxy, syy];
            const b = [sv, svx, svy];
            const det = (M: number[]) =>
                M[0] * (M[4] * M[8] - M[5] * M[7]) -
                M[1] * (M[3] * M[8] - M[5] * M[6]) +
                M[2] * (M[3] * M[7] - M[4] * M[6]);
            const D = det(A);
            if (Math.abs(D) < 1e-12) return Infinity;
            const rep = (M: number[], col: number, vec: number[]) => {
                const C = M.slice();
                C[col] = vec[0]; C[col + 3] = vec[1]; C[col + 6] = vec[2];
                return C;
            };
            const coef = [det(rep(A, 0, b)) / D, det(rep(A, 1, b)) / D, det(rep(A, 2, b)) / D];
            let ss = 0;
            const res = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                res[i] = v[i] - (coef[0] + coef[1] * xs[i] + coef[2] * ys[i]);
                if (use[i]) ss += res[i] * res[i];
            }
            sigma = Math.sqrt(ss / Math.max(1, m));
            if (pass === 0) {
                for (let i = 0; i < n; i++) use[i] = Math.abs(res[i]) <= 2.5 * sigma ? 1 : 0;
            }
        }
        return sigma;
    };

    let best = { a2: 0, a4: 0, rms: Infinity };
    const evalCand = (a2: number, a4: number): number => {
        for (let i = 0; i < n; i++) v[i] = cells.med[i] * (1 + a2 * r2[i] + a4 * r2[i] * r2[i]);
        return planeRms();
    };
    for (let a2 = 0; a2 <= 1.6001; a2 += 0.08) {
        for (let a4 = 0; a4 <= 1.6001; a4 += 0.08) {
            const rms = evalCand(a2, a4);
            if (rms < best.rms) best = { a2: +a2.toFixed(2), a4: +a4.toFixed(2), rms };
        }
    }

    // corner/center sky medians (raw and corrected) for the honest report.
    const gBest = vignetteGain(best.a2, best.a4);
    const centerVals: number[] = [];
    const cornerVals: number[] = [];
    const cornerCorr: number[] = [];
    for (let i = 0; i < n; i++) {
        if (r2[i] < 0.04) centerVals.push(cells.med[i]);
        if (r2[i] > 0.72) { cornerVals.push(cells.med[i]); cornerCorr.push(cells.med[i] * gBest(r2[i])); }
    }
    const median = (a: number[]) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    const c0 = median(centerVals);
    const cB = median(cornerVals);
    const cA = median(cornerCorr);

    return {
        a2: best.a2,
        a4: best.a4,
        fitRms: best.rms,
        atGridBound: best.a2 >= 1.6 || best.a4 >= 1.6,
        cornerCenterRatioBefore: c0 ? cB / c0 : NaN,
        cornerCenterRatioAfter: c0 ? cA / c0 : NaN,
        cells: n,
    };
}

/**
 * Apply the radial vignette gain to a NEW copy of the detection luminance
 * (never mutates the input — invariant #1 above). r² is normalized to the
 * frame half-diagonal so gain(center)=1, gain(corner)=1+a2+a4.
 */
export function applyVignetteGainToLum(
    lum: Float32Array,
    w: number,
    h: number,
    a2: number,
    a4: number
): Float32Array {
    const out = new Float32Array(lum.length);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const invHd2 = 1 / Math.max(1e-9, cx * cx + cy * cy);
    for (let y = 0; y < h; y++) {
        const dy = y - cy;
        const dy2 = dy * dy;
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const r2 = (dx * dx + dy2) * invHd2;
            out[row + x] = lum[row + x] * (1 + a2 * r2 + a4 * r2 * r2);
        }
    }
    return out;
}

/**
 * Subtract a fitted background surface (deg-2, evaluated per pixel) from a NEW
 * copy of the detection luminance (never mutates the input — invariant #1).
 * `evaluate(x,y)` is the BackgroundSurfaceModeler's model; the result is a
 * flattened DETECTION buffer whose residual background sits near zero, so the
 * caller MUST recompute mean/σ on it before thresholding.
 */
export function subtractBackgroundSurface(
    lum: Float32Array,
    w: number,
    h: number,
    evaluate: (x: number, y: number) => number
): Float32Array {
    const out = new Float32Array(lum.length);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            out[row + x] = lum[row + x] - evaluate(x, y);
        }
    }
    return out;
}
