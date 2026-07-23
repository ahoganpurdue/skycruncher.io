import { describe, it, expect, beforeEach } from 'vitest';
import { measureApertureRGB } from '../pipeline/m8_photometry/rgb_aperture_photometry';
import { fitColorRegression, fitZeroPoint, computeSpccCalibration } from '../pipeline/m8_photometry/spcc_calibrator';
import { PhotometryManager } from '../pipeline/m8_photometry/photometry_manager';

// SeeStar-like 16-bit profile: BIAS pedestal 1109, full-well 65535
const TEST_PROFILE = { gain_e_adu: 0.0406, read_noise_e: 2.0, black_level: 1109, white_level: 65535, bit_depth: 16, pixel_size_um: 2.9 };

/** Build a flat-background interleaved RGB frame with optional disc "stars". */
function makeFrame(w: number, h: number, bg: [number, number, number]) {
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
        rgb[i * 3] = bg[0];
        rgb[i * 3 + 1] = bg[1];
        rgb[i * 3 + 2] = bg[2];
    }
    return rgb;
}

/** Add a hard-edged disc star; returns injected flux per channel. */
function addStar(rgb: Float32Array, w: number, cx: number, cy: number, radius: number, amp: [number, number, number]) {
    let n = 0;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
        for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= radius * radius) {
                const idx = (y * w + x) * 3;
                rgb[idx] += amp[0];
                rgb[idx + 1] += amp[1];
                rgb[idx + 2] += amp[2];
                n++;
            }
        }
    }
    return { flux: [amp[0] * n, amp[1] * n, amp[2] * n], n };
}

describe('M8 SPCC — RGB Aperture Photometry', () => {
    it('recovers injected per-channel flux within 2% on a flat background', () => {
        const w = 64, h = 64;
        const rgb = makeFrame(w, h, [0.1, 0.12, 0.08]);
        const injected = addStar(rgb, w, 32, 32, 2, [0.3, 0.5, 0.2]);

        const m = measureApertureRGB(rgb, w, h, 32, 32, 3.0);

        expect(m.n_aperture).toBeGreaterThan(injected.n);
        expect(m.n_annulus).toBeGreaterThan(8);
        expect(Math.abs(m.flux_r - injected.flux[0]) / injected.flux[0]).toBeLessThan(0.02);
        expect(Math.abs(m.flux_g - injected.flux[1]) / injected.flux[1]).toBeLessThan(0.02);
        expect(Math.abs(m.flux_b - injected.flux[2]) / injected.flux[2]).toBeLessThan(0.02);
        // Median annulus background per channel
        expect(m.bg_r).toBeCloseTo(0.1, 6);
        expect(m.bg_g).toBeCloseTo(0.12, 6);
        expect(m.bg_b).toBeCloseTo(0.08, 6);
        expect(m.saturated).toBe(false);
    });

    it('flags saturated stars (peak > 0.97)', () => {
        const w = 32, h = 32;
        const rgb = makeFrame(w, h, [0.05, 0.05, 0.05]);
        addStar(rgb, w, 16, 16, 1.5, [0.0, 0.95, 0.0]); // 0.05 + 0.95 = 1.0 > 0.97

        const m = measureApertureRGB(rgb, w, h, 16, 16, 3.0);
        expect(m.saturated).toBe(true);
        expect(m.peak_norm).toBeGreaterThan(0.97);
    });
});

describe('M8 SPCC — Color Regression', () => {
    it('recovers slope/intercept from 20 clean stars + 3 outliers (R² > 0.95)', () => {
        const SLOPE = 1.2, INTERCEPT = 0.3;
        const samples = [];
        for (let i = 0; i < 20; i++) {
            const x = -0.5 + i * 0.1; // instColor sweep
            const noise = 0.02 * Math.sin(i * 12.9898); // deterministic pseudo-noise
            samples.push({ instColor: x, catBpRp: SLOPE * x + INTERCEPT + noise });
        }
        // 3 gross outliers
        samples.push({ instColor: 0.0, catBpRp: 4.0 });
        samples.push({ instColor: 0.5, catBpRp: -3.0 });
        samples.push({ instColor: 1.0, catBpRp: 5.0 });

        const fit = fitColorRegression(samples);
        expect(fit.valid).toBe(true);
        expect(fit.slope).toBeCloseTo(SLOPE, 1);
        expect(fit.intercept).toBeCloseTo(INTERCEPT, 1);
        expect(fit.r2).toBeGreaterThan(0.95);
        expect(fit.n_used).toBeGreaterThanOrEqual(20);
    });

    it('returns invalid under minStars (8)', () => {
        const samples = Array.from({ length: 5 }, (_, i) => ({ instColor: i * 0.2, catBpRp: i * 0.2 }));
        const fit = fitColorRegression(samples);
        expect(fit.valid).toBe(false);
    });
});

describe('M8 SPCC — Zero Point', () => {
    it('recovers the zero point within ±0.05 despite an outlier', () => {
        const ZP = 21.5;
        const samples = [];
        for (let i = 0; i < 10; i++) {
            const mInst = -8 + i * 0.5;
            const noise = 0.02 * Math.cos(i * 7.1234);
            samples.push({ catG: mInst + ZP + noise, mInst });
        }
        samples.push({ catG: 30.0, mInst: -5.0 }); // gross outlier (diff = 35)

        const fit = fitZeroPoint(samples);
        expect(fit.valid).toBe(true);
        expect(Math.abs(fit.zeropoint - ZP)).toBeLessThan(0.05);
        expect(fit.rmse).toBeLessThan(0.1);
    });

    it('returns invalid under minStars (5)', () => {
        const fit = fitZeroPoint([{ catG: 12, mInst: -9 }, { catG: 13, mInst: -8 }]);
        expect(fit.valid).toBe(false);
    });
});

describe('M8 SPCC — End-to-end calibration', () => {
    beforeEach(() => {
        PhotometryManager.setProfile(TEST_PROFILE);
    });

    it('measures stars but reports valid:false with only 3 matched stars', () => {
        const w = 96, h = 96;
        const rgb = makeFrame(w, h, [0.05, 0.05, 0.05]);
        const positions: Array<[number, number]> = [[24, 24], [48, 60], [72, 30]];
        for (const [x, y] of positions) {
            addStar(rgb, w, x, y, 2, [0.2, 0.3, 0.15]);
        }

        const matched = positions.map(([x, y], i) => ({
            detected: { x, y, fwhm: 3.0 },
            catalog: { mag: 9 + i, bv: 0.8 },
        }));

        const cal = computeSpccCalibration(matched, { data: rgb, width: w, height: h }, null, 10);

        expect(cal.stars.length).toBe(3);
        expect(cal.n_usable).toBe(3);
        for (const s of cal.stars) {
            expect(s.measurement).not.toBeNull();
            expect(s.instColor).not.toBeNull();
            expect(s.mInst).not.toBeNull();
            expect(Number.isFinite(s.mInst!)).toBe(true);
        }
        // 3 < minStars for both fits → whole calibration invalid (UNCALIBRATED)
        expect(cal.colorFit.valid).toBe(false);
        expect(cal.zpFit.valid).toBe(false);
        expect(cal.valid).toBe(false);
    });

    it('excludes off-frame stars', () => {
        const w = 32, h = 32;
        const rgb = makeFrame(w, h, [0.05, 0.05, 0.05]);
        const matched = [{ detected: { x: 500, y: 500, fwhm: 3.0 }, catalog: { mag: 9, bv: 0.5 } }];
        const cal = computeSpccCalibration(matched, { data: rgb, width: w, height: h }, null, 1);
        expect(cal.stars[0].usable).toBe(false);
        expect(cal.stars[0].measurement).toBeNull();
        expect(cal.n_usable).toBe(0);
    });
});
