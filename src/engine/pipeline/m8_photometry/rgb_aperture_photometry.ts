/**
 * RGB APERTURE PHOTOMETRY — M8 Scientific Photometry (SPCC support)
 * ═════════════════════════════════════════════════════════════════════════
 * [Module: M8] [Domain: PhotometricSolution]
 *
 * Per-channel aperture photometry on the full-resolution interleaved RGB
 * science buffer (normalized 0..1 Float32, 3 floats per pixel).
 *
 * Geometry mirrors AnnulusMetrology (aperture / dead-zone / sky-ring) but:
 *  - operates on 3 interleaved channels instead of a luminance plane
 *  - uses a MEDIAN annulus background per channel (robust to star wings
 *    and hot pixels leaking into the sky ring)
 *
 * AnnulusMetrology itself is not reused — it is single-channel,
 * electron-domain, and coupled to the PhotometryManager profile.
 */

export interface RgbApertureMeasurement {
    /** Background-subtracted aperture sums per channel (normalized units) */
    flux_r: number;
    flux_g: number;
    flux_b: number;
    /** Median annulus background per pixel per channel (normalized units) */
    bg_r: number;
    bg_g: number;
    bg_b: number;
    /** Number of pixels inside the aperture */
    n_aperture: number;
    /** Number of pixels sampled in the sky annulus */
    n_annulus: number;
    /** Peak normalized value observed inside the aperture (any channel) */
    peak_norm: number;
    /** True when any aperture pixel exceeds the saturation threshold */
    saturated: boolean;
}

/** Normalized saturation threshold (0..1). */
const SATURATION_NORM = 0.97;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measure per-channel aperture photometry around (cx, cy).
 *
 * @param rgb    Interleaved RGB Float32 buffer (w*h*3, normalized 0..1)
 * @param w      Image width (pixels)
 * @param h      Image height (pixels)
 * @param cx     Star centroid x (native pixels)
 * @param cy     Star centroid y (native pixels)
 * @param fwhmPx Star FWHM in pixels (drives default aperture size)
 * @param r1     Aperture radius (default: max(3.5, 1.5×FWHM))
 * @param r2     Inner sky-ring radius / dead-zone end (default: r1 + 1.5)
 * @param r3     Outer sky-ring radius (default: r2 + 3.0)
 */
export function measureApertureRGB(
    rgb: Float32Array,
    w: number,
    h: number,
    cx: number,
    cy: number,
    fwhmPx: number,
    r1?: number,
    r2?: number,
    r3?: number
): RgbApertureMeasurement {
    const ap = r1 ?? Math.max(3.5, 1.5 * (fwhmPx || 3.0));
    const inner = r2 ?? ap + 1.5;
    const outer = r3 ?? inner + 3.0;

    const apSq = ap * ap;
    const innerSq = inner * inner;
    const outerSq = outer * outer;

    const startX = Math.max(0, Math.floor(cx - outer));
    const endX = Math.min(w - 1, Math.ceil(cx + outer));
    const startY = Math.max(0, Math.floor(cy - outer));
    const endY = Math.min(h - 1, Math.ceil(cy + outer));

    let sumR = 0, sumG = 0, sumB = 0;
    let nAperture = 0;
    let peakNorm = 0;
    let saturated = false;

    const skyR: number[] = [];
    const skyG: number[] = [];
    const skyB: number[] = [];

    for (let y = startY; y <= endY; y++) {
        const dy = y - cy;
        for (let x = startX; x <= endX; x++) {
            const dx = x - cx;
            const dist2 = dx * dx + dy * dy;
            if (dist2 > outerSq) continue;

            const idx = (y * w + x) * 3;
            const r = rgb[idx];
            const g = rgb[idx + 1];
            const b = rgb[idx + 2];

            if (dist2 <= apSq) {
                sumR += r;
                sumG += g;
                sumB += b;
                nAperture++;
                const peak = Math.max(r, g, b);
                if (peak > peakNorm) peakNorm = peak;
                if (peak > SATURATION_NORM) saturated = true;
            } else if (dist2 >= innerSq) {
                // Sky ring (r2..r3); the dead zone (r1..r2) is skipped
                skyR.push(r);
                skyG.push(g);
                skyB.push(b);
            }
        }
    }

    const bgR = median(skyR);
    const bgG = median(skyG);
    const bgB = median(skyB);

    return {
        flux_r: sumR - bgR * nAperture,
        flux_g: sumG - bgG * nAperture,
        flux_b: sumB - bgB * nAperture,
        bg_r: bgR,
        bg_g: bgG,
        bg_b: bgB,
        n_aperture: nAperture,
        n_annulus: skyR.length,
        peak_norm: peakNorm,
        saturated,
    };
}
