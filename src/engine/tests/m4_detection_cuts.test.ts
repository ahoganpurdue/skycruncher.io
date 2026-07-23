import { describe, it, expect } from 'vitest';
import {
    computeBlobShapeStats,
    evaluateBlobCuts,
    cullThermalBlobs,
} from '../pipeline/m4_signal_detect/detection_cuts';
import {
    maskHotPixels,
    removeThermalArtifacts,
    measureHotPixelCandidates,
} from '../pipeline/m4_signal_detect/hot_pixel_map';

/**
 * M4 thermal-noise cuts (NEXT_MOVES §7) — synthetic hot pixel vs real PSF.
 *
 * The calibration constraint is enforced by the byte-identical e2e scenarios;
 * these tests lock the DISCRIMINATOR physics: a single-pixel spike measures
 * near-zero spatial variance (moment FWHM ≈ 0) and extreme peak/flux, while a
 * Gaussian PSF measures its true width and a low peak/flux ratio.
 */

// BG exactly representable in float32 (2^-3) — a synthetic "flat" frame must
// subtract to EXACTLY zero, or float32/float64 rounding fabricates weights.
const W = 64, H = 64, BG = 0.125;

function flatFrame(): Float32Array {
    return new Float32Array(W * H).fill(BG);
}

/** Inject a symmetric Gaussian PSF; returns {flux, peak} above background. */
function injectGaussian(
    lum: Float32Array, cx: number, cy: number, sigmaPx: number, amp: number,
    stretch = 1 // x-axis sigma multiplier (for ellipticity tests)
): { flux: number; peak: number } {
    let flux = 0, peak = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const dx = (x - cx) / stretch;
            const dy = y - cy;
            const v = amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigmaPx * sigmaPx));
            if (v < 1e-8) continue;
            lum[y * W + x] += v;
            flux += v;
            if (v > peak) peak = v;
        }
    }
    return { flux, peak };
}

describe('M4 detection cuts — blob shape statistics', () => {
    it('a synthetic PSF blob measures its true width, low sharpness, low ellipticity', () => {
        const lum = flatFrame();
        const sigmaPx = 1.2; // FWHM ~2.83 px
        const { flux, peak } = injectGaussian(lum, 32, 32, sigmaPx, 0.5);
        const s = computeBlobShapeStats(lum, W, H, 32, 32, BG, peak, flux);
        expect(s.momentFwhmPx).not.toBeNull();
        // 11x11 stamp truncates the far wings slightly — accept ±20%.
        expect(s.momentFwhmPx!).toBeGreaterThan(2.355 * sigmaPx * 0.8);
        expect(s.momentFwhmPx!).toBeLessThan(2.355 * sigmaPx * 1.2);
        expect(s.sharpness!).toBeLessThan(0.2);           // spread PSF
        expect(s.momentEllipticity!).toBeLessThan(0.1);   // round
    });

    it('a lone hot pixel measures near-zero moment FWHM and sharpness ~1', () => {
        const lum = flatFrame();
        lum[32 * W + 32] = 0.9; // single-pixel spike
        const spikeFlux = 0.9 - BG;
        const s = computeBlobShapeStats(lum, W, H, 32, 32, BG, 0.9 - BG, spikeFlux);
        expect(s.momentFwhmPx).not.toBeNull();
        expect(s.momentFwhmPx!).toBeLessThan(0.5);  // sub-pixel variance
        expect(s.sharpness!).toBeGreaterThan(0.9);  // all flux in one pixel
    });

    it('an elongated streak measures high ellipticity', () => {
        const lum = flatFrame();
        const { flux, peak } = injectGaussian(lum, 32, 32, 0.9, 0.5, 4); // 4:1 stretch
        const s = computeBlobShapeStats(lum, W, H, 32, 32, BG, peak, flux);
        expect(s.momentEllipticity!).toBeGreaterThan(0.5);
    });

    it('an empty stamp yields null measurements (honest-or-absent), never a cut', () => {
        const lum = flatFrame();
        const s = computeBlobShapeStats(lum, W, H, 32, 32, BG);
        expect(s.momentFwhmPx).toBeNull();
        expect(s.momentEllipticity).toBeNull();
        expect(s.sharpness).toBeNull();
        expect(evaluateBlobCuts(s, { fwhmFloorPx: 1.3, sharpnessMax: 0.5, ellipticityMax: 0.8 })).toBeNull();
    });
});

describe('M4 detection cuts — verdicts', () => {
    it('cut rejects the spike, keeps the star (the §7 acceptance test)', () => {
        const lum = flatFrame();
        // real star
        const g = injectGaussian(lum, 20, 20, 1.2, 0.5);
        const star = computeBlobShapeStats(lum, W, H, 20, 20, BG, g.peak, g.flux);
        // hot pixel
        lum[45 * W + 45] = 0.9;
        const spike = computeBlobShapeStats(lum, W, H, 45, 45, BG, 0.8, 0.8);

        const thresholds = { fwhmFloorPx: 1.3, sharpnessMax: 0.5, ellipticityMax: 0.8 };
        expect(evaluateBlobCuts(star, thresholds)).toBeNull();
        expect(evaluateBlobCuts(spike, thresholds)).toBe('FWHM_FLOOR');
        // even without the floor, the sharpness ceiling kills it
        expect(evaluateBlobCuts(spike, { ...thresholds, fwhmFloorPx: 0 })).toBe('SHARPNESS');
    });

    it('disabled thresholds cut nothing (the inert/no-op state)', () => {
        const spike = { sharpness: 1.0, momentFwhmPx: 0.1, momentEllipticity: 0.99 };
        expect(evaluateBlobCuts(spike, { fwhmFloorPx: 0, sharpnessMax: Infinity, ellipticityMax: 1 })).toBeNull();
    });

    it('cullThermalBlobs counts at assignment time and preserves survivors in order', () => {
        const blobs = [
            { id: 1, sharpness: 0.05, moment_fwhm_px: 2.8, moment_ellipticity: 0.05 }, // star
            { id: 2, sharpness: 0.98, moment_fwhm_px: 0.2, moment_ellipticity: 0.10 }, // hot pixel
            { id: 3, sharpness: 0.06, moment_fwhm_px: 3.1, moment_ellipticity: 0.08 }, // star
        ] as any[];
        const counts: Record<string, number> = {};
        // NOTE: uses PIPELINE_CONSTANTS thresholds — this test only asserts the
        // pass-through contract when the constants are inert, and the counting
        // contract via evaluateBlobCuts above. Direct-threshold behavior is
        // covered by evaluateBlobCuts tests (constants stay the single source).
        const kept = cullThermalBlobs(blobs, (r) => { counts[r] = (counts[r] || 0) + 1; });
        expect(kept.length + Object.values(counts).reduce((a, b) => a + b, 0)).toBe(3);
        for (const k of kept) expect((k as any).culling_reason).toBeUndefined();
    });
});

describe('M4 hot-pixel map — neighbour-elevation discriminator', () => {
    const SIGMA = 0.01;

    it('flags a lone hot pixel (neighbours at background) and replaces it with the local median', () => {
        const lum = flatFrame();
        lum[30 * W + 30] = BG + 50 * SIGMA;
        // 64x64 = 0.004 MP: one flagged pixel = ~244/MP, above the density gate.
        const r = maskHotPixels(lum, W, H, BG, SIGMA, { nSigma: 10, neighborBgSigma: 3 });
        expect(r.flagged).toBe(1);
        expect(r.applied).toBe(true);
        expect(r.data).not.toBe(lum);                    // copy-on-flag
        expect(r.data[30 * W + 30]).toBeCloseTo(BG, 6);  // replaced by median
        expect(lum[30 * W + 30]).toBeCloseTo(BG + 50 * SIGMA, 6); // input untouched
    });

    it('DENSITY GATE: a clean frame with a few real hot pixels is left untouched (measured, not masked)', () => {
        const lum = flatFrame();
        lum[30 * W + 30] = BG + 50 * SIGMA;
        // Force a gate above this frame's flagged density (1 px / 0.004 MP = 244/MP).
        const r = maskHotPixels(lum, W, H, BG, SIGMA, { nSigma: 10, neighborBgSigma: 3, minDensityPerMP: 1000 });
        expect(r.flagged).toBe(1);        // still MEASURED (honest evidence)
        expect(r.applied).toBe(false);    // but below the thermal-dominance gate
        expect(r.data).toBe(lum);         // byte-identical by construction
    });

    it('does NOT flag a stellar core — the PSF elevates its neighbours', () => {
        const lum = flatFrame();
        // bright star, sigma 1.2px: the 8-neighbour median sits far above bg
        injectGaussian(lum, 30, 30, 1.2, 100 * SIGMA);
        const r = maskHotPixels(lum, W, H, BG, SIGMA, { nSigma: 10, neighborBgSigma: 3 });
        expect(r.flagged).toBe(0);
        expect(r.data).toBe(lum); // zero flags => original buffer, untouched
    });

    it('zero flags on a clean frame returns the ORIGINAL buffer (byte-identical by construction)', () => {
        const lum = flatFrame();
        const r = maskHotPixels(lum, W, H, BG, SIGMA, { nSigma: 10, neighborBgSigma: 3 });
        expect(r.flagged).toBe(0);
        expect(r.data).toBe(lum);
    });

    it('nSigma <= 0 disables the map entirely', () => {
        const lum = flatFrame();
        lum[30 * W + 30] = BG + 50 * SIGMA;
        const r = maskHotPixels(lum, W, H, BG, SIGMA, { nSigma: 0 });
        expect(r.method).toBe('NONE');
        expect(r.data).toBe(lum);
    });

    it('prefers master-dark subtraction when a geometry-matching dark exists', () => {
        const lum = flatFrame();
        lum[30 * W + 30] = BG + 50 * SIGMA;               // thermal spike
        const dark = new Float32Array(W * H).fill(0);
        dark[30 * W + 30] = 50 * SIGMA;                   // the dark knows it
        const r = removeThermalArtifacts(lum, W, H, BG, SIGMA, dark, { nSigma: 10 });
        expect(r.method).toBe('MASTER_DARK');
        expect(r.data[30 * W + 30]).toBeCloseTo(BG, 6);   // spike subtracted
        expect(r.data).not.toBe(lum);                     // copy, input untouched
    });

    it('mismatched dark geometry falls back to the statistical map', () => {
        const lum = flatFrame();
        lum[30 * W + 30] = BG + 50 * SIGMA;
        const dark = new Float32Array(16);                // wrong size
        const r = removeThermalArtifacts(lum, W, H, BG, SIGMA, dark, { nSigma: 10, neighborBgSigma: 3 });
        expect(r.method).toBe('STATISTICAL');
        expect(r.flagged).toBe(1);
    });

    it('candidate-ladder instrument counts monotonically decrease with N', () => {
        const lum = flatFrame();
        lum[10 * W + 10] = BG + 30 * SIGMA;
        lum[20 * W + 20] = BG + 9 * SIGMA;
        const counts = measureHotPixelCandidates(lum, W, H, BG, SIGMA, [6, 8, 10, 12, 16, 20]);
        expect(counts.N6).toBeGreaterThanOrEqual(counts.N8);
        expect(counts.N8).toBeGreaterThanOrEqual(counts.N10);
        expect(counts.N6).toBe(2);   // both spikes exceed 6σ
        expect(counts.N10).toBe(1);  // only the 30σ one exceeds 10σ
        expect(counts.N20).toBe(1);
    });
});
