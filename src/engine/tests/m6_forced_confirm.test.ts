import { describe, it, expect } from 'vitest';
import { forcedMeasure, mulberry32, type ForcedMeasurement, type ForcedPosition } from '../pipeline/m6_plate_solve/deep_verify';
import {
    confirmForcedStar, confirmForcedSet, shapeConsistency, perStarLocalNull,
    neighborSeparation, DEFAULT_CONFIRM_CONFIG,
    type FramePsfRef, type StarContext,
} from '../pipeline/m6_plate_solve/forced_confirm';

/**
 * M6 forced-confirm — per-star + set-level promotion of CATALOG_FORCED
 * candidates (FP wave C). Locks: real injected stars confirm and clear the
 * SET-LEVEL family-wise gate; a wrong-position / pure-noise pool COLLAPSES to
 * zero (the ensemble control — junk does not get stamped CONFIRMED); hot
 * pixels, cosmics, structured background, blends reject per-star; determinism;
 * honest-or-absent (undersampled/low-SNR shape → NOT_MEASURED; too few
 * candidates → NOT MEASURED). Mirrors the TRUE-vs-JUNK separation in
 * m6_deep_verify.test.ts.
 */

const W = 256, H = 256, BG = 0.125, SIGMA = 0.004;
const PSF_SIGMA = 1.5;
const FRAME_FWHM = 2.355 * PSF_SIGMA;

function noiseFrame(seed = 42): Float32Array {
    const rnd = mulberry32(seed);
    const L = new Float32Array(W * H);
    for (let i = 0; i < L.length; i++) {
        L[i] = BG + SIGMA * ((rnd() + rnd() + rnd() + rnd()) - 2) * Math.sqrt(3);
    }
    return L;
}

function injectStar(L: Float32Array, x: number, y: number, amp = 0.09, psfSigma = PSF_SIGMA): void {
    const cx = Math.round(x), cy = Math.round(y);
    for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || X >= W || Y < 0 || Y >= H) continue;
            L[Y * W + X] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * psfSigma * psfSigma));
        }
    }
}

function grid(n: number, spacing: number, offset: number): ForcedPosition[] {
    const out: ForcedPosition[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ x: offset + (i % 5) * spacing, y: offset + Math.floor(i / 5) * spacing, mag: 8, gaia_id: `g${i}` });
    }
    return out;
}

function measureAll(L: Float32Array, positions: ForcedPosition[], fwhmPx = FRAME_FWHM): ForcedMeasurement[] {
    return forcedMeasure({ L, w: W, h: H, positions, fwhmPx, sigmaPix: SIGMA, snrThreshold: 2 }).results;
}

const FRAME_PSF: FramePsfRef = { fwhmPx: FRAME_FWHM, ellipticity: 0.1, source: 'WASM_LM_GAUSSIAN', undersampled: false };

function ctxFor(m: ForcedMeasurement, opts: Partial<StarContext> = {}): StarContext {
    return {
        L: opts.L ?? new Float32Array(W * H),
        w: W, h: H,
        rApPx: opts.rApPx ?? Math.max(2, 0.68 * FRAME_FWHM),
        sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
        framePsf: opts.framePsf ?? FRAME_PSF,
        neighborSepPx: opts.neighborSepPx ?? 40,
        approximate: opts.approximate ?? false,
        color: opts.color,
        config: opts.config ?? DEFAULT_CONFIRM_CONFIG,
        seed: opts.seed ?? 1234,
    };
}

describe('forced-confirm — per-star discriminators', () => {
    it('confirms a real injected star (snr + shape + local null + neighbor all clean)', () => {
        const L = noiseFrame();
        const pos = { x: 128, y: 128, mag: 8, gaia_id: 'real' };
        injectStar(L, pos.x, pos.y);
        const [m] = measureAll(L, [pos]);
        const res = confirmForcedStar(m, ctxFor(m, { L, neighborSepPx: 40 }));
        expect(res.confirmed).toBe(true);
        expect(res.tests.snr).toBe('PASS');
        expect(res.tests.shape).toBe('PASS');
        expect(res.tests.localNull).toBe('PASS');
        expect(res.tests.neighbor).toBe('PASS');
        expect(res.confidence).toBeGreaterThan(0.5);
    });

    it('rejects a single-pixel hot pixel on a clean stamp (shape FAIL: momentFwhm ≈ 0)', () => {
        // Clean (flat) local stamp: the spike is the ONLY positive-above-bg
        // pixel → momentFwhm ≈ 0, unambiguously non-stellar. (On a noisy stamp
        // the moment is noise-driven and shape has low power — that residual is
        // bounded by the SET-LEVEL gate, per the module header, not per-star.)
        const L = new Float32Array(W * H).fill(BG);
        L[128 * W + 128] = BG + 0.6; // lone spike
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        const verdict = shapeConsistency(m, ctxFor(m, { L }));
        expect(verdict).toBe('FAIL');
        const res = confirmForcedStar(m, ctxFor(m, { L, neighborSepPx: 40 }));
        expect(res.confirmed).toBe(false);
    });

    it('rejects a structured-background position (never confirms)', () => {
        const L = noiseFrame();
        const rnd = mulberry32(99);
        for (let dy = -14; dy <= 14; dy++) {
            for (let dx = -14; dx <= 14; dx++) L[(128 + dy) * W + 128 + dx] = BG + (rnd() - 0.5) * 0.5;
        }
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        expect(m.structured).toBe(true);
        const res = confirmForcedStar(m, ctxFor(m, { L, neighborSepPx: 40 }));
        expect(res.confirmed).toBe(false);
        expect(res.tests.snr).toBe('FAIL'); // structured folds into the snr gate
    });

    it('vetoes a blended neighbor (neighbor within k·r_ap)', () => {
        const L = noiseFrame();
        injectStar(L, 128, 128);
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        const res = confirmForcedStar(m, ctxFor(m, { L, neighborSepPx: 2 })); // ~1 px blend
        expect(res.tests.neighbor).toBe('FAIL');
        expect(res.confirmed).toBe(false);
    });

    it('rejects a broad extended source (shape FAIL: momentFwhm ≫ frame PSF)', () => {
        const L = noiseFrame();
        // smooth broad blob (low scatter → not "structured", but wrong shape)
        for (let dy = -40; dy <= 40; dy++) {
            for (let dx = -40; dx <= 40; dx++) {
                const X = 128 + dx, Y = 128 + dy;
                if (X < 0 || X >= W || Y < 0 || Y >= H) continue;
                L[Y * W + X] += 0.05 * Math.exp(-(dx * dx + dy * dy) / (2 * 25 * 25));
            }
        }
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        const res = confirmForcedStar(m, ctxFor(m, { L, neighborSepPx: 40 }));
        expect(res.confirmed).toBe(false);
    });

    it('shape is NOT_MEASURED on an undersampled frame (honest — no rubber-stamp)', () => {
        const L = noiseFrame();
        injectStar(L, 128, 128);
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        const under: FramePsfRef = { ...FRAME_PSF, undersampled: true };
        expect(shapeConsistency(m, ctxFor(m, { L, framePsf: under }))).toBe('NOT_MEASURED');
    });

    it('shape is NOT_MEASURED when the frame PSF was not measured', () => {
        const L = noiseFrame();
        injectStar(L, 128, 128);
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        const none: FramePsfRef = { fwhmPx: null, source: 'NOT_MEASURED' };
        expect(shapeConsistency(m, ctxFor(m, { L, framePsf: none }))).toBe('NOT_MEASURED');
    });

    it('local null is NOT_MEASURED when too few decoys are available (honest-or-absent)', () => {
        const L = noiseFrame();
        injectStar(L, 128, 128, 0.2);
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        expect(m).toBeDefined();
        // Demand more in-frame decoys than K can supply → NOT_MEASURED, never a
        // silent pass (the honest-or-absent branch of the local null).
        const cfg = { ...DEFAULT_CONFIRM_CONFIG, localNullK: 6, localNullMinDecoys: 999 };
        expect(perStarLocalNull(m, ctxFor(m, { L, config: cfg }))).toBe('NOT_MEASURED');
    });

    it('a star that survives snr+neighbor but has NO active discriminator is not confirmed', () => {
        const L = noiseFrame();
        injectStar(L, 128, 128);
        const [m] = measureAll(L, [{ x: 128, y: 128 }]);
        // Force shape NOT_MEASURED (undersampled) AND local null NOT_MEASURED
        // (K=0 decoys) → both inactive → must NOT confirm on snr+neighbor alone.
        const cfg = { ...DEFAULT_CONFIRM_CONFIG, localNullK: 0, localNullMinDecoys: 8 };
        const res = confirmForcedStar(m, ctxFor(m, { L, framePsf: { ...FRAME_PSF, undersampled: true }, config: cfg }));
        expect(res.tests.shape).toBe('NOT_MEASURED');
        expect(res.tests.localNull).toBe('NOT_MEASURED');
        expect(res.confirmed).toBe(false);
    });

    it('neighborSeparation ignores the self position and finds the nearest', () => {
        const cat: ForcedPosition[] = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 200, y: 200 }];
        expect(neighborSeparation(100, 100, cat)).toBeCloseTo(10, 6);
        expect(neighborSeparation(100.0000001, 100, cat)).toBeCloseTo(10, 3);
    });
});

describe('forced-confirm — set-level family-wise gate', () => {
    it('TRUE set: real stars confirm and clear the set-level excess gate', () => {
        const L = noiseFrame();
        const stars = grid(25, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y);
        const rApPx = Math.max(2, 0.68 * FRAME_FWHM);
        const candidates = measureAll(L, stars).filter(r => r.accepted);
        const out = confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx, sigmaPix: SIGMA, fwhmPx: FRAME_FWHM, framePsf: FRAME_PSF,
            approximate: false, seed: 7,
        });
        expect(out.examined).toBeGreaterThanOrEqual(20);
        expect(out.setGatePassed).toBe(true);
        expect(out.confirmed).toBeGreaterThanOrEqual(20);
        expect(out.setExcessZ ?? 0).toBeGreaterThan(10);
        expect(out.confirmed_stars.length).toBe(out.confirmed);
    });

    it('JUNK set (wrong positions): whole set COLLAPSES to zero confirmed', () => {
        const L = noiseFrame();
        const stars = grid(25, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y);
        // WRONG WCS: every predicted position offset off the real stars — by
        // construction every "confirmation" here would be false.
        const wrong = stars.map(s => ({ x: s.x + 17, y: s.y + 13, mag: 8, gaia_id: s.gaia_id }));
        const rApPx = Math.max(2, 0.68 * FRAME_FWHM);
        // Feed the FULL wrong pool (mirrors a wrong-WCS harvest); the set gate,
        // not per-star selection, must drive confirmations to ~0.
        const candidates = measureAll(L, wrong);
        const out = confirmForcedSet({
            candidates, catalog: wrong, L, w: W, h: H,
            rApPx, sigmaPix: SIGMA, fwhmPx: FRAME_FWHM, framePsf: FRAME_PSF,
            approximate: false, seed: 7,
        });
        expect(out.setGatePassed).toBe(false);
        expect(out.confirmed).toBe(0);
        expect(out.confirmed_stars.length).toBe(0);
    });

    it('PURE-NOISE set: no real signal → set collapses (family-wise control)', () => {
        const L = noiseFrame(1234);
        // random "catalog" positions on a starless frame
        const rnd = mulberry32(555);
        const cat: ForcedPosition[] = [];
        for (let i = 0; i < 60; i++) cat.push({ x: 20 + rnd() * (W - 40), y: 20 + rnd() * (H - 40), mag: 9, gaia_id: `n${i}` });
        const candidates = measureAll(L, cat);
        const out = confirmForcedSet({
            candidates, catalog: cat, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: FRAME_PSF, approximate: false, seed: 3,
        });
        expect(out.confirmed).toBe(0);
    });

    it('is deterministic: identical inputs → identical result', () => {
        const L = noiseFrame();
        const stars = grid(25, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y);
        const candidates = measureAll(L, stars).filter(r => r.accepted);
        const args = {
            candidates, catalog: stars, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: FRAME_PSF, approximate: false, seed: 11,
        };
        const a = confirmForcedSet(args);
        const b = confirmForcedSet(args);
        expect(b.confirmed).toBe(a.confirmed);
        expect(b.setExcessZ).toBe(a.setExcessZ);
        expect(b.nullConfirmRate).toBe(a.nullConfirmRate);
    });

    it('too few candidates → NOT MEASURED (never confirms)', () => {
        const L = noiseFrame();
        const stars = grid(5, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y);
        const candidates = measureAll(L, stars).filter(r => r.accepted);
        const out = confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: FRAME_PSF, approximate: false,
        });
        expect(out.confirmed).toBe(0);
        expect(out.notMeasured).toMatch(/NOT MEASURED/i);
    });

    it('APPROXIMATE (8-bit): color is forced NOT_MEASURED on every confirmation', () => {
        const L = noiseFrame();
        const stars = grid(25, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y, 0.15); // bright enough to clear the 5σ approx floor
        const candidates = measureAll(L, stars).filter(r => r.accepted);
        const out = confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: FRAME_PSF, approximate: true, seed: 5,
            colors: candidates.map(() => 'PASS' as const), // even if provided…
        });
        for (const cs of out.confirmed_stars) expect(cs.result.tests.color).toBe('NOT_MEASURED'); // …8-bit forces it off
        expect(out.approximate).toBe(true);
    });
});
