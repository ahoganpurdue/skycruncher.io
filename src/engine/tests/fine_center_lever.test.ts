// Unit tests for the ultra-wide FINE-CENTER LEVER pure helpers
// (src/engine/pipeline/m6_plate_solve/fine_center_lever.ts).
//
// These are the coordinate-ledger primitives behind the lever + its two
// false-positive backstops. They are pure (no wasm/IO), so they are tested
// directly and deterministically here — the end-to-end conversion (IMG_1410
// 5.03σ no-verify → +12.2σ verify) is measured through the real solver_entry
// path by the tools/dslr UW harness.

import { describe, it, expect } from 'vitest';
import {
    angularSepDeg,
    buildFineCenters,
    dedupeAnchors,
    fineGridAround,
    isSunVetoed,
    orientationDominance,
    type AnchorCenter,
} from '../pipeline/m6_plate_solve/fine_center_lever';

describe('angularSepDeg', () => {
    it('is zero for identical points', () => {
        expect(angularSepDeg(17.3, -22.5, 17.3, -22.5)).toBeCloseTo(0, 6);
    });
    it('is 90° for 6h of RA on the equator', () => {
        expect(angularSepDeg(0, 0, 6, 0)).toBeCloseTo(90, 4);
    });
    it('handles the RA wrap (23h vs 1h = 30°)', () => {
        expect(angularSepDeg(23, 0, 1, 0)).toBeCloseTo(30, 4);
    });
});

describe('fineGridAround', () => {
    const anchor: AnchorCenter = { ra: 17.3, dec: -22.5, name: 'jupiter' };
    const grid = fineGridAround(anchor, 1.5, 0.3);
    it('lays an 11×11 grid for ±1.5° at 0.3°', () => {
        expect(grid.length).toBe(11 * 11);
    });
    it('orders center-out: the first point is the anchor itself', () => {
        expect(grid[0].ra).toBeCloseTo(anchor.ra, 6);
        expect(grid[0].dec).toBeCloseTo(anchor.dec, 6);
    });
    it('keeps every point local to the anchor (within the ±1.5° box + spherical curvature)', () => {
        for (const g of grid) {
            // Dec offset is bounded exactly; the great-circle distance may exceed
            // the planar box diagonal slightly due to sphere curvature — still local.
            expect(Math.abs(g.dec - anchor.dec)).toBeLessThanOrEqual(1.5 + 1e-6);
            expect(angularSepDeg(anchor.ra, anchor.dec, g.ra, g.dec)).toBeLessThanOrEqual(2.2);
        }
    });
    it('tags every point as a lever center', () => {
        expect(grid.every(g => g.lever === true && g.name === 'jupiter~fine')).toBe(true);
    });
});

describe('dedupeAnchors', () => {
    it('collapses anchors within the dedup radius, keeping the higher-priority one', () => {
        const anchors: AnchorCenter[] = [
            { ra: 17.30, dec: -22.5, name: 'A', priority: 0 },
            { ra: 17.32, dec: -22.4, name: 'B', priority: 1 }, // ~0.3° from A → collapse
            { ra: 4.60, dec: 16.5, name: 'C', priority: 2 },  // far → kept
        ];
        const kept = dedupeAnchors(anchors, 1.0);
        expect(kept.map(k => k.name).sort()).toEqual(['A', 'C']);
    });
});

describe('buildFineCenters', () => {
    it('grids a single anchor into a full center-out set', () => {
        const centers = buildFineCenters([{ ra: 17.3, dec: -22.5 }], 1.5, 0.3, 400, 1.0);
        expect(centers.length).toBe(121);
    });
    it('respects the total cap (planets/brightest first)', () => {
        const anchors: AnchorCenter[] = [
            { ra: 1, dec: 0, priority: 0 }, { ra: 5, dec: 10, priority: 1 },
            { ra: 9, dec: 20, priority: 2 }, { ra: 13, dec: -20, priority: 3 },
        ];
        const centers = buildFineCenters(anchors, 1.5, 0.3, 150, 1.0);
        expect(centers.length).toBe(150);
    });
    it('a pre-injected dense grid does not explode (dedup collapses it)', () => {
        // Simulate the harness planet-grid: 25 near-identical priors around one point.
        const dense: AnchorCenter[] = [];
        for (let i = 0; i < 25; i++) dense.push({ ra: 17.3 + i * 0.001, dec: -22.5, priority: 1 });
        const centers = buildFineCenters(dense, 1.5, 0.3, 400, 1.0);
        expect(centers.length).toBe(121); // one anchor's worth, not 25×121
    });
});

describe('isSunVetoed', () => {
    const sun = { ra_hours: 5.0, dec_degrees: 22.0 }; // e.g. late-May Sun in Taurus
    it('vetoes a center near the Sun', () => {
        expect(isSunVetoed(5.2, 20.0, sun, 40)).toBe(true);
    });
    it('does not veto a center on the opposite sky', () => {
        expect(isSunVetoed(17.3, -22.5, sun, 40)).toBe(false);
    });
    it('never vetoes without a Sun position (no trusted clock)', () => {
        expect(isSunVetoed(5.2, 20.0, null, 40)).toBe(false);
        expect(isSunVetoed(5.2, 20.0, undefined, 40)).toBe(false);
    });
    it('respects the veto radius boundary', () => {
        // Antisolar minus a hair: ~39.9° away → vetoed at 40°, not at 39°.
        const near = { ra_hours: 5.0, dec_degrees: 22.0 };
        const sep = angularSepDeg(5.0 + 39.9 / 15, 22.0, near.ra_hours, near.dec_degrees);
        expect(isSunVetoed(5.0 + 39.9 / 15, 22.0, near, 40)).toBe(sep < 40);
    });

    // ── DAYTIME BYPASS (add-only exception for confirmed daylight captures) ──
    it('NIGHT frame near the Sun is STILL vetoed — byte-identical to the pre-bypass call', () => {
        // The guardrail: the bypass must not weaken NIGHT protection. Absent a
        // positive daytime confirmation the 5-arg call must equal the 4-arg one.
        const legacy = isSunVetoed(5.2, 20.0, sun, 40);            // pre-bypass signature
        expect(legacy).toBe(true);
        expect(isSunVetoed(5.2, 20.0, sun, 40, undefined)).toBe(legacy); // not confirmed → armed
        expect(isSunVetoed(5.2, 20.0, sun, 40, false)).toBe(legacy);     // explicitly night → armed
    });
    it('DAYTIME-confirmed frame near the Sun is ALLOWED (bypass)', () => {
        // A genuine daylight/solar capture legitimately points near the Sun.
        expect(isSunVetoed(5.2, 20.0, sun, 40, true)).toBe(false);
    });
    it('opposite-sky center is allowed regardless of the daytime flag', () => {
        expect(isSunVetoed(17.3, -22.5, sun, 40, false)).toBe(false);
        expect(isSunVetoed(17.3, -22.5, sun, 40, true)).toBe(false);
    });
    it('untrusted clock (no Sun) never vetoes, with or without the daytime flag', () => {
        expect(isSunVetoed(5.2, 20.0, null, 40, false)).toBe(false);
        expect(isSunVetoed(5.2, 20.0, null, 40, true)).toBe(false);
        expect(isSunVetoed(5.2, 20.0, undefined, 40, false)).toBe(false);
    });
});

describe('orientationDominance (winner-dominance backstop)', () => {
    // Build a synthetic sweep score array with a REALISTIC noisy null (real
    // rotation sweeps scatter ~±2-5 chance matches per orientation — measured
    // nullStd on production frames), plus named peaks. A deterministic LCG keeps
    // it reproducible.
    const buildScores = (peaks: { theta: number; parity: number; m: number }[], nullLevel = 8, nullStd = 2) => {
        let seed = 1234567;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        // Box-Muller-ish: sum of two uniforms ≈ triangular, scaled to ~nullStd.
        const noise = () => (rnd() + rnd() - 1) * nullStd * 1.732;
        const scores: { theta: number; parity: number; m: number }[] = [];
        for (const par of [1, -1]) {
            for (let th = 0; th < 360; th += 0.5) {
                const hit = peaks.find(p => p.parity === par && Math.abs(p.theta - th) < 0.25);
                scores.push({ theta: th, parity: par, m: hit ? hit.m : Math.max(0, nullLevel + noise()) });
            }
        }
        const sum = scores.reduce((a, s) => a + s.m, 0);
        const mean = sum / scores.length;
        const std = Math.sqrt(scores.reduce((a, s) => a + (s.m - mean) ** 2, 0) / scores.length) || 1;
        const peak = scores.reduce((a, s) => (s.m > a.m ? s : a), scores[0]);
        return { scores, mean, std, peak };
    };

    it('ACCEPTS a single dominant peak (true anchored solve)', () => {
        const { scores, mean, std, peak } = buildScores([{ theta: 147.5, parity: 1, m: 40 }]);
        const dom = orientationDominance(scores, peak, mean, std, 20, 1.5);
        expect(dom.dominant).toBe(true);
    });

    it('REJECTS a flat spectrum with two comparable distant peaks (1576-class marginal)', () => {
        // Two similar-height orientations far apart → ambiguous, no true rotation.
        const { scores, mean, std, peak } = buildScores([
            { theta: 147.5, parity: 1, m: 18 },
            { theta: 40.0, parity: 1, m: 17 },
        ]);
        const dom = orientationDominance(scores, peak, mean, std, 20, 1.5);
        expect(dom.dominant).toBe(false);
        expect(dom.runnerUpZ).toBeGreaterThan(0);
    });

    it('ignores the peak\'s own lobe (near-peak angles do not count as runner-up)', () => {
        // A single peak plus a neighbour 1° away (same lobe) must still be dominant.
        const { scores, mean, std, peak } = buildScores([
            { theta: 147.5, parity: 1, m: 40 },
            { theta: 148.5, parity: 1, m: 38 },
        ]);
        const dom = orientationDominance(scores, peak, mean, std, 20, 1.5);
        expect(dom.dominant).toBe(true);
    });
});
