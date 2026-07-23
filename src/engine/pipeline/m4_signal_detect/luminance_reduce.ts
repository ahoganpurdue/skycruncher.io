/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DETECTION LUMINANCE REDUCTION (PIXEL ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reduces an interleaved RGB frame to the single-channel luminance the star
 * detector operates on. Two weightings:
 *
 *   REC709  — perceptual weights (0.2126R + 0.7152G + 0.0722B). Correct for a
 *             genuinely demosaiced RGB frame (FITS RGB cubes, JPEG).
 *   EQUAL   — (R+G+B)/3. Used ONLY for a LibRaw CFA-mosaic "RGB" where each
 *             pixel carries one dominant CFA colour: the perceptual weights
 *             (0.72 on a green site vs 0.07 on a blue site) imprint a 2px
 *             period-2 checkerboard on the detection buffer; equal weights
 *             recover the smooth per-site value (see cfaMosaicLuma).
 *
 * Pure + allocation-reuse (`out` may be passed to avoid churn). NaN inputs
 * propagate as NaN (the caller counts them for its corruption guard).
 */

export interface LumaWeights { r: number; g: number; b: number; }

export const LUMA_REC709: LumaWeights = { r: 0.2126, g: 0.7152, b: 0.0722 };
/** Equal channel weights — parity-guarded reduction for CFA-mosaic frames. */
export const LUMA_EQUAL: LumaWeights = { r: 1 / 3, g: 1 / 3, b: 1 / 3 };

/**
 * Reduce interleaved RGB (length = pixelCount*3) to luminance under `w`.
 * Writes into `out` when supplied (must be length pixelCount), else allocates.
 */
export function reduceToLuminance(
    rgb: Float32Array,
    w: LumaWeights = LUMA_REC709,
    out?: Float32Array
): Float32Array {
    const pixelCount = (rgb.length / 3) | 0;
    const lum = out && out.length === pixelCount ? out : new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
        if (isNaN(r) || isNaN(g) || isNaN(b)) { lum[i] = NaN; continue; }
        lum[i] = w.r * r + w.g * g + w.b * b;
    }
    return lum;
}

/**
 * Period-2 (Nyquist) checkerboard amplitude of a luminance grid, normalized by
 * its mean: |mean(lum * (-1)^(x+y))| / mean(lum). ~0 for a smooth field; large
 * for a CFA per-site checkerboard. Diagnostic/test helper.
 */
export function period2ParityAmplitude(lum: Float32Array, width: number, height: number): number {
    let sum = 0, signed = 0, n = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = lum[y * width + x];
            if (!Number.isFinite(v)) continue;
            sum += v; n++;
            signed += ((x + y) & 1) ? -v : v;
        }
    }
    const mean = sum / Math.max(1, n);
    return Math.abs(signed / Math.max(1, n)) / Math.max(1e-9, mean);
}
