import { describe, it, expect } from 'vitest';
import {
    forcedMeasure,
    projectCatalogToPixels,
    luminanceFromImageData,
    scrambledPositions,
    mulberry32,
    deepVerifyEscalation,
} from '../pipeline/m6_plate_solve/deep_verify';
import type { WCSTransform } from '../types/Main_types';

/**
 * M6 deep verify — catalog-forced photometry (NEXT_MOVES §7·5).
 *
 * Locks the §7 acceptance behaviors: forced detection at injected synthetic
 * positions recovers them; the scrambled on-frame null stays flat; the
 * escalation excess separates truth from junk; everything is deterministic
 * (the scrambled null must not wobble a calibrated gate run-to-run).
 */

const W = 256, H = 256, BG = 0.125, SIGMA = 0.004;

/** Noise frame with deterministic pseudo-noise + injected Gaussian stars. */
function makeFrame(starPositions: { x: number; y: number }[], amp = 0.08, psfSigma = 1.5): Float32Array {
    const rnd = mulberry32(42);
    const L = new Float32Array(W * H);
    for (let i = 0; i < L.length; i++) {
        // approx-gaussian noise: sum of 4 uniforms, centred
        L[i] = BG + SIGMA * ((rnd() + rnd() + rnd() + rnd()) - 2) * Math.sqrt(3);
    }
    for (const p of starPositions) {
        for (let dy = -6; dy <= 6; dy++) {
            for (let dx = -6; dx <= 6; dx++) {
                const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
                if (x < 0 || x >= W || y < 0 || y >= H) continue;
                L[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * psfSigma * psfSigma));
            }
        }
    }
    return L;
}

function grid(n: number, spacing: number, offset: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            x: offset + (i % 5) * spacing,
            y: offset + Math.floor(i / 5) * spacing,
        });
    }
    return out;
}

describe('M6 forced photometry (engine port of tools/psf/forced_detect.mjs)', () => {
    it('recovers injected synthetic stars at predicted positions (>= 2σ each)', () => {
        const stars = grid(25, 40, 30);
        const L = makeFrame(stars);
        const { results, rApPx } = forcedMeasure({
            L, w: W, h: H, positions: stars, fwhmPx: 2.355 * 1.5, sigmaPix: SIGMA,
        });
        expect(rApPx).toBeGreaterThanOrEqual(2);
        expect(results.length).toBe(25);
        const accepted = results.filter(r => r.accepted).length;
        expect(accepted).toBe(25); // every injected star recovered
        for (const r of results) expect(r.provenance).toBe('CATALOG_FORCED');
    });

    it('the scrambled null stays flat on the same frame', () => {
        const stars = grid(25, 40, 30);
        const L = makeFrame(stars);
        const nullPos = scrambledPositions({ n: 200, w: W, h: H, seed: 7 });
        const { results } = forcedMeasure({
            L, w: W, h: H, positions: nullPos, fwhmPx: 2.355 * 1.5, sigmaPix: SIGMA,
        });
        const frac = results.filter(r => r.accepted).length / results.length;
        // 25 stars cover ~25·π·(2.4)²/256² ≈ 0.7% of the frame; chance 2σ
        // acceptances add a few % — the null must stay far below the 100%
        // predicted-position recovery.
        expect(frac).toBeLessThan(0.15);
    });

    it('structured background (annulus scatter >> frame noise) can never accept', () => {
        const L = makeFrame([]);
        // paint violent structure around one position
        const cx = 128, cy = 128;
        const rnd = mulberry32(99);
        for (let dy = -14; dy <= 14; dy++) {
            for (let dx = -14; dx <= 14; dx++) {
                L[(cy + dy) * W + cx + dx] = BG + (rnd() - 0.5) * 0.4; // huge scatter
            }
        }
        const { results } = forcedMeasure({
            L, w: W, h: H, positions: [{ x: cx, y: cy }], fwhmPx: 3.5, sigmaPix: SIGMA,
        });
        expect(results.length).toBe(1);
        expect(results[0].structured).toBe(true);
        expect(results[0].accepted).toBe(false);
    });

    it('is deterministic: identical inputs => identical outputs (calibrated-gate law)', () => {
        const stars = grid(15, 40, 40);
        const L = makeFrame(stars);
        const a = deepVerifyEscalation({ L, w: W, h: H, predicted: stars, fwhmPx: 3.5, sigmaPix: SIGMA });
        const b = deepVerifyEscalation({ L, w: W, h: H, predicted: stars, fwhmPx: 3.5, sigmaPix: SIGMA });
        expect(a).not.toBeNull();
        expect(b).toEqual(a);
    });
});

describe('M6 deep-verify escalation statistic', () => {
    it('TRUE candidate: predicted positions land on real stars => large positive excess', () => {
        const stars = grid(25, 40, 30);
        const L = makeFrame(stars);
        const r = deepVerifyEscalation({ L, w: W, h: H, predicted: stars, fwhmPx: 3.5, sigmaPix: SIGMA });
        expect(r).not.toBeNull();
        expect(r!.predFrac).toBe(1);            // all injected stars recovered
        expect(r!.nullFrac).toBeLessThan(0.15); // flat chance floor
        expect(r!.excessZ).toBeGreaterThan(10); // +10σ-class separation
    });

    it('JUNK candidate: predicted positions miss the stars => excess collapses', () => {
        const stars = grid(25, 40, 30);
        const L = makeFrame(stars);
        // wrong WCS hypothesis: predictions offset half a spacing — pure background
        const wrong = stars.map(s => ({ x: s.x + 20, y: s.y + 20 }));
        const r = deepVerifyEscalation({ L, w: W, h: H, predicted: wrong, fwhmPx: 3.5, sigmaPix: SIGMA });
        expect(r).not.toBeNull();
        expect(r!.excessZ).toBeLessThan(3); // nowhere near the +10σ-class gate
    });

    it('returns null (honest-or-absent) when there are too few probes for a statistic', () => {
        const L = makeFrame([]);
        const r = deepVerifyEscalation({ L, w: W, h: H, predicted: grid(5, 40, 30), fwhmPx: 3.5, sigmaPix: SIGMA });
        expect(r).toBeNull();
    });
});

describe('M6 catalog projection (position lane, engine conventions)', () => {
    it('projects crval-centred stars to crpix and respects the frame margin', () => {
        // 60"/px, north-up linear WCS; crval in HOURS (engine convention).
        const scaleDegPerPx = 60 / 3600;
        const wcs: WCSTransform = {
            crpix: [128, 128],
            crval: [12.0, 30.0],
            cd: [[-scaleDegPerPx, 0], [0, scaleDegPerPx]],
        };
        const stars = [
            { ra_hours: 12.0, dec_degrees: 30.0, magnitude_V: 5, gaia_id: 'center' },
            { ra_hours: 12.0, dec_degrees: 31.0, magnitude_V: 6, gaia_id: 'north-1deg' },
            { ra_hours: 12.0, dec_degrees: 80.0, magnitude_V: 6, gaia_id: 'far-out' },
        ];
        const pos = projectCatalogToPixels({ stars, wcs, w: W, h: H });
        const byId = Object.fromEntries(pos.map(p => [p.gaia_id, p]));
        expect(byId['center'].x).toBeCloseTo(128, 6);
        expect(byId['center'].y).toBeCloseTo(128, 6);
        // +1 deg dec = 60 px at 60"/px; eta/CD sign convention puts it at y+60
        expect(Math.abs(byId['north-1deg'].y - 128)).toBeCloseTo(60, 0);
        expect(byId['north-1deg'].x).toBeCloseTo(128, 0);
        expect(byId['far-out']).toBeUndefined(); // off-frame culled
    });

    it('luminanceFromImageData matches the 0.299/0.587/0.114 contract', () => {
        const data = new Uint8ClampedArray(8);
        data.set([255, 0, 0, 255, 0, 255, 0, 255]); // red px, green px
        const lum = luminanceFromImageData({ data, width: 2, height: 1 });
        expect(lum[0]).toBeCloseTo(0.299, 5);
        expect(lum[1]).toBeCloseTo(0.587, 5);
    });
});
