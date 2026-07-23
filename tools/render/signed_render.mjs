// ═══════════════════════════════════════════════════════════════════════════
// SIGNED-DIVERGING RENDERER (RENDER plane · display-only · default-off)
// ═══════════════════════════════════════════════════════════════════════════
// row-545 remediation, item 3. The shipped STF v2 auto-stretch
// (core/ImageProcessor.float32ToImageDataAutoStretch) is built for strictly-
// POSITIVE astronomical signal: it clamps negatives to black. A SIGNED detail
// layer (nebulosity / residual, whose values straddle zero — the à-trous
// mexican-hat rings are NEGATIVE) therefore renders near-black, destroying the
// exact sign that reveals over-subtraction / cratering (the row-545 finding:
// "STF v2 renders sparse detail layers near-black — needs a signed-diverging
// renderer").
//
// This module is a pure RENDER-plane view: it emits display RGBA only, reads no
// science buffer in place, mutates nothing, and is never wired into the
// solve/receipt path. Default-off in the sense that it is a separate render path
// a consumer must explicitly call — the STF path is unchanged.
//
// LAW 1: this is the RENDER plane; it consumes a native-grid layer and produces
// pixels for display, feeding NEITHER ledger back.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * pct-th percentile of |v − center| over the FINITE entries — a robust symmetric
 * scale for a signed map (immune to a handful of saturated outliers).
 * @returns {number} the scale (0 only when there is no finite signal).
 */
export function robustSymmetricScale(mono, pct = 0.995, center = 0) {
    const abs = [];
    for (let i = 0; i < mono.length; i++) {
        const v = mono[i];
        if (Number.isFinite(v)) abs.push(Math.abs(v - center));
    }
    if (abs.length === 0) return 0;
    abs.sort((a, b) => a - b);
    const idx = Math.min(abs.length - 1, Math.max(0, Math.floor(abs.length * pct)));
    return abs[idx];
}

/**
 * Signed-diverging RGBA. Neutral point = `center` (default 0). Below center →
 * blue, at center → near-black ('black' style) or white ('white' style), above
 * center → red. Robust-normalized to the pct-th percentile of |value − center|
 * unless an explicit `scale` is supplied.
 *
 *   @param mono   ArrayLike<number> length w*h (the signed layer, native grid)
 *   @param opts   { pct?, style?: 'black'|'white', center?, scale? }
 *   @returns { rgba: Uint8ClampedArray(w*h*4), scale, center }
 */
export function signedDivergingRgba(mono, w, h, opts = {}) {
    const { pct = 0.995, style = 'black', center = 0 } = opts;
    const n = w * h;
    const scale = (opts.scale != null && opts.scale > 0)
        ? opts.scale
        : Math.max(1e-12, robustSymmetricScale(mono, pct, center));
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
        let t = (mono[i] - center) / scale;
        if (!Number.isFinite(t)) t = 0;
        else if (t < -1) t = -1;
        else if (t > 1) t = 1;
        const d = i << 2;
        if (style === 'white') {
            // diverging blue → white → red (white-centered)
            const a = Math.abs(t);
            if (t >= 0) { rgba[d] = 255; rgba[d + 1] = 255 * (1 - a); rgba[d + 2] = 255 * (1 - a); }
            else { rgba[d] = 255 * (1 - a); rgba[d + 1] = 255 * (1 - a); rgba[d + 2] = 255; }
        } else {
            // black-centered (matches the shipped starlet_evidence supplement): zero
            // signal stays dark, so a signed detail layer reads as a lit +/− structure
            // over black rather than being clamped invisible by the STF.
            if (t >= 0) { rgba[d] = 20 + t * 235; rgba[d + 1] = 20 * (1 - t); rgba[d + 2] = 20 * (1 - t); }
            else { const a = -t; rgba[d] = 20 * (1 - a); rgba[d + 1] = 40 * (1 - a); rgba[d + 2] = 40 + a * 215; }
        }
        rgba[d + 3] = 255;
    }
    return { rgba, scale, center };
}

/**
 * Median over a Float32/number ArrayLike (finite entries), used as the pedestal
 * center for a background-subtract DAMAGE view.
 */
export function medianOf(mono, maxN = 200000) {
    const step = Math.max(1, Math.floor(mono.length / maxN));
    const s = [];
    for (let i = 0; i < mono.length; i += step) { const v = mono[i]; if (Number.isFinite(v)) s.push(v); }
    if (s.length === 0) return 0;
    s.sort((a, b) => a - b);
    return s[s.length >> 1];
}

/**
 * BACKGROUND-SUBTRACT DAMAGE view: render `subtracted` (e.g. original − nebulosity)
 * as a signed-diverging map centered on the ORIGINAL's background pedestal. Pixels
 * driven BELOW the pedestal by the subtraction (star craters, over-subtracted MW
 * band) light up blue; pixels left above light up red. This is the honest picture
 * the STF hides — it clamps the sub-pedestal craters to black. Returns the RGBA +
 * the scale + the pedestal used (for an honest on-image legend).
 */
export function subtractionDamageRgba(subtracted, w, h, opts = {}) {
    const pedestal = (opts.pedestal != null && Number.isFinite(opts.pedestal))
        ? opts.pedestal : medianOf(subtracted);
    const { rgba, scale } = signedDivergingRgba(subtracted, w, h, { ...opts, center: pedestal });
    return { rgba, scale, pedestal };
}
