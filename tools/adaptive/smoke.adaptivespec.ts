/**
 * Increment-1 smoke: the detection harness boots the REAL wasm and finds
 * synthetic stars on a synthetic luminance frame, and injected knobs actually
 * change the outcome (proving config-injectability). Pure-synthetic, fast,
 * deterministic — no frame files, no solve.
 */
import { describe, it, expect } from 'vitest';
import { bootWasm, runDetection, baselineKnobs, type KnobConfig } from './detect_harness';

/**
 * Deterministic synthetic frame: flat bg + gaussian stars + 2px "junk clumps"
 * (the undersampled-thermal analog — bright, but sub-PSF momentFwhm, so a real
 * blob that the §7 fwhm-floor cut is designed to reject).
 */
function synthFrame(
    w: number, h: number,
    stars: { x: number; y: number; amp: number; fwhm: number }[],
    junk: { x: number; y: number; amp: number }[]
) {
    const lum = new Float32Array(w * h);
    const bg = 0.10;
    // deterministic low-amplitude texture (no RNG — reproducible)
    for (let i = 0; i < lum.length; i++) lum[i] = bg + 0.002 * Math.sin(i * 0.013);
    for (const s of stars) {
        const sigma = s.fwhm / 2.355;
        const r = Math.ceil(sigma * 4);
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const x = Math.round(s.x) + dx, y = Math.round(s.y) + dy;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                lum[y * w + x] += s.amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
            }
        }
    }
    // 2px horizontal clump — connected (forms a blob) but near-zero spatial
    // variance → tiny momentFwhm → exactly what the fwhm-floor cut targets.
    for (const p of junk) {
        if (p.x < 0 || p.y < 0 || p.x + 1 >= w || p.y >= h) continue;
        lum[p.y * w + p.x] += p.amp;
        lum[p.y * w + p.x + 1] += p.amp * 0.9;
    }
    return lum;
}

describe('adaptive detect_harness (increment 1)', () => {
    const W = 512, H = 512;
    const stars = [
        { x: 100, y: 120, amp: 0.6, fwhm: 3.0 },
        { x: 250, y: 300, amp: 0.5, fwhm: 3.5 },
        { x: 400, y: 150, amp: 0.7, fwhm: 2.8 },
        { x: 180, y: 420, amp: 0.4, fwhm: 3.2 },
        { x: 330, y: 80, amp: 0.55, fwhm: 3.0 },
    ];
    // 2px junk clumps spread across the frame (sub-PSF momentFwhm blobs).
    const junk = Array.from({ length: 12 }, (_, k) => ({ x: 40 + k * 35, y: 470, amp: 0.8 }));

    it('boots real wasm and detects the synthetic stars', () => {
        bootWasm();
        const lum = synthFrame(W, H, stars, junk);
        const run = runDetection(lum, W, H, baselineKnobs(135 /* oversampled-ish FL */));
        // every planted star should surface as a detection (within 3px)
        for (const s of stars) {
            const hit = run.detections.some(d => Math.hypot(d.x - s.x, d.y - s.y) < 3);
            expect(hit, `star at (${s.x},${s.y}) detected`).toBe(true);
        }
        expect(run.detections.length).toBeGreaterThanOrEqual(stars.length);
        expect(run.ms).toBeLessThan(5000); // fast enough for a grid
    });

    it('injected shape-cut knobs change the outcome (config-injectability)', () => {
        bootWasm();
        const lum = synthFrame(W, H, stars, junk);
        // Masking OFF (isolate the shape cut, not the hot-pixel pre-pass).
        const noMask = Number.POSITIVE_INFINITY;
        const loose: KnobConfig = { ...baselineKnobs(135), hotpixMinDensityPerMP: noMask, fwhmFloorPx: 0, sharpnessMax: Infinity, ellipticityMax: 1 };
        const strict: KnobConfig = { ...baselineKnobs(135), hotpixMinDensityPerMP: noMask, fwhmFloorPx: 2.0, sharpnessMax: Infinity, ellipticityMax: 1 };
        const rLoose = runDetection(lum, W, H, loose);
        const rStrict = runDetection(lum, W, H, strict);
        // the fwhm-floor cut removes the sub-PSF junk clumps but keeps the stars
        expect(rStrict.detections.length).toBeLessThan(rLoose.detections.length);
        expect(Object.keys(rLoose.cutCounts).length).toBe(0); // loose cuts nothing
        expect(rStrict.cutCounts['FWHM_FLOOR']).toBeGreaterThan(0); // strict cuts junk
        for (const s of stars) {
            expect(rStrict.detections.some(d => Math.hypot(d.x - s.x, d.y - s.y) < 3)).toBe(true);
        }
    });

    it('hot-pixel density knob gates the thermal pre-pass', () => {
        bootWasm();
        const lum = synthFrame(W, H, stars, junk);
        const maskOff = runDetection(lum, W, H, { ...baselineKnobs(135), hotpixMinDensityPerMP: Infinity });
        const maskOn = runDetection(lum, W, H, { ...baselineKnobs(135), hotpixMinDensityPerMP: 0 });
        // Same flagged spikes both ways, but the density knob decides APPLICATION.
        expect(maskOff.hotpixApplied).toBe(false);            // never applies above any real density
        expect(maskOn.hotpixFlagged).toBeGreaterThan(0);      // clumps register as spikes
        expect(maskOn.hotpixApplied).toBe(true);              // density>=0 => mask applies
        expect(maskOff.detections.length).toBeGreaterThanOrEqual(stars.length);
    });

    it('deep sigma knob controls faint-candidate count', () => {
        bootWasm();
        const lum = synthFrame(W, H, stars, junk);
        const shallow = runDetection(lum, W, H, { ...baselineKnobs(135), deepSigma: 4.0 });
        const deep = runDetection(lum, W, H, { ...baselineKnobs(135), deepSigma: 0.5 });
        expect(deep.rawDeep).toBeGreaterThanOrEqual(shallow.rawDeep);
    });
});
