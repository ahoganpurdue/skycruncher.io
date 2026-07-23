// Unit tests for the UW fit-tight-reverify escalation tier (COORDINATE ledger).
// Pure functions only — no wasm, no atlas, no I/O. Covers: trigger logic,
// degenerate-fit fall-through, and the tight-sigma math (end-to-end synthetic).
import { describe, it, expect } from 'vitest';
import { SkyTransform } from '../core/SkyTransform';
import {
    shouldAttemptTightReverify,
    excessSigma,
    runUwTightReverify,
    deepWideMatch,
    type UwTightReverifyConfig,
} from '../pipeline/m6_plate_solve/uw_tight_reverify';
import type { WCSTransform, MatchedStar, DetectedStar } from '../types/Main_types';
import type { StandardStar } from '../pipeline/m6_plate_solve/standard_stars';

const IMG_W = 1000;
const IMG_H = 1000;
const SCALE_ARCSEC = 100; // arcsec/px

function mkWCS(): WCSTransform {
    const scaleDeg = SCALE_ARCSEC / 3600;
    return { crpix: [500, 500], crval: [10, 20], cd: [[-scaleDeg, 0], [0, scaleDeg]] };
}

function mkStar(px: number, py: number, i: number, mag = 4.0): StandardStar {
    const sky = SkyTransform.pixelToSky(px, py, mkWCS());
    return {
        name: `syn_${i}`,
        gaia_id: `SYN-${i}`,
        ra_hours: sky.ra_hours,
        dec_degrees: sky.dec_degrees,
        magnitude_V: mag,
        color_index_BV: 0.5,
        band: 'JohnsonV',
        spectral_type: 'G2V',
        temperature_K: 5800,
        expected_xy: { x: 0.31, y: 0.32 },
        pmra: 0,
        pmdec: 0,
    } as any as StandardStar;
}

function mkMatch(px: number, py: number, star: StandardStar): MatchedStar {
    const det = { x: px, y: py, flux: 1000, fwhm: 2 } as any as DetectedStar;
    return {
        detected: det,
        catalog: {
            ra: star.ra_hours * 15,
            dec: star.dec_degrees,
            mag: star.magnitude_V,
            bv: star.color_index_BV,
            ra_hours: star.ra_hours,
            dec_degrees: star.dec_degrees,
            name: star.name,
            gaia_id: star.gaia_id,
            magnitude_V: star.magnitude_V,
            band: star.band,
        } as any,
        residual_arcsec: 0,
        residual: { dx: 0, dy: 0 },
    };
}

/** A grid of N in-frame pixel points (avoids the extreme edges). */
function gridPoints(n: number): Array<[number, number]> {
    const pts: Array<[number, number]> = [];
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const px = 120 + (c * (IMG_W - 240)) / Math.max(1, cols - 1);
        const py = 120 + (r * (IMG_H - 240)) / Math.max(1, cols - 1);
        pts.push([px, py]);
    }
    return pts;
}

const CFG: UwTightReverifyConfig = {
    tightNetPx: 3.0,
    acceptSigma: 5,
    minUnique: 5,
    magLimit: 6.0,
    verifyCatCap: 500,
};

describe('shouldAttemptTightReverify — trigger logic', () => {
    it('fires only when enabled AND wide sigma >= floor (inclusive)', () => {
        expect(shouldAttemptTightReverify(true, 3.0, 2.5)).toBe(true);
        expect(shouldAttemptTightReverify(true, 2.5, 2.5)).toBe(true); // boundary inclusive
        expect(shouldAttemptTightReverify(true, 2.4, 2.5)).toBe(false);
    });
    it('is off when the flag is off, regardless of sigma', () => {
        expect(shouldAttemptTightReverify(false, 100, 2.5)).toBe(false);
    });
    it('declines non-finite sigma', () => {
        expect(shouldAttemptTightReverify(true, NaN, 2.5)).toBe(false);
        expect(shouldAttemptTightReverify(true, Infinity, 2.5)).toBe(false); // not finite -> declined
    });
});

describe('excessSigma — tight-sigma math', () => {
    it('computes (obs - expected)/sqrt(var)', () => {
        expect(excessSigma(20, 5, 9)).toBeCloseTo(5, 10);      // 15/3
        expect(excessSigma(5, 2, 0.01)).toBeCloseTo(3, 10);    // variance floored at 1 -> 3/1
    });
    it('floors variance at 1 (never divides by <1)', () => {
        expect(excessSigma(10, 0, 0)).toBeCloseTo(10, 10);     // 10/max(1,0)
    });
    it('returns 0 at chance (obs == expected)', () => {
        expect(excessSigma(10, 10, 25)).toBeCloseTo(0, 10);
    });
});

describe('runUwTightReverify — degenerate-fit fall-through', () => {
    it('declines a non-invertible CD (candidate stays rejected)', () => {
        const r = runUwTightReverify({
            wcs: { crpix: [500, 500], crval: [10, 20], cd: [[0, 0], [0, 0]] },
            catalogStars: [], detected: [], imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches: [], config: CFG,
        });
        expect(r.declined).toBe(true);
        expect(r.accepted).toBe(false);
        expect(r.declineReason).toMatch(/degenerate CD/i);
        expect(r.matches).toHaveLength(0);
    });

    it('declines when too few matched pairs to fit Brown-Conrady', () => {
        const wcs = mkWCS();
        const pts = gridPoints(4); // < MIN_PAIRS (10)
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const wideMatches = pts.map(([x, y], i) => mkMatch(x, y, stars[i]));
        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected: [], imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches, config: CFG,
        });
        expect(r.declined).toBe(true);
        expect(r.accepted).toBe(false);
        expect(r.declineReason).toMatch(/fit declined/i);
    });
});

describe('runUwTightReverify — tight-net recovery (end-to-end synthetic)', () => {
    it('recovers a clean synthetic field at high tight sigma and accepts at the +5 bar', () => {
        const wcs = mkWCS();
        const pts = gridPoints(16); // >= MIN_PAIRS
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const wideMatches = pts.map(([x, y], i) => mkMatch(x, y, stars[i]));
        const detected = pts.map(([x, y]) => ({ x, y, flux: 1000, fwhm: 2 } as any as DetectedStar));

        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected, imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches, config: CFG,
        });

        expect(r.declined).toBe(false);
        expect(Number.isFinite(r.tightSigma)).toBe(true);
        expect(r.tightMatches).toBeGreaterThanOrEqual(12);
        expect(r.tightUnique).toBeGreaterThanOrEqual(CFG.minUnique);
        expect(r.tightSigma).toBeGreaterThanOrEqual(CFG.acceptSigma);
        expect(r.accepted).toBe(true);
        // Adopted match set carries the exact downstream shape (catalog identity + residual).
        expect(r.matches.length).toBe(r.tightMatches);
        expect(r.matches[0].catalog.ra_hours).toBeDefined();
        expect(Number.isFinite(r.matches[0].residual_arcsec)).toBe(true);
    });

    it('does NOT accept when the uniqueness floor is not met (bar unchanged, evidence insufficient)', () => {
        const wcs = mkWCS();
        const pts = gridPoints(16);
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const wideMatches = pts.map(([x, y], i) => mkMatch(x, y, stars[i]));
        const detected = pts.map(([x, y]) => ({ x, y, flux: 1000, fwhm: 2 } as any as DetectedStar));

        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected, imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches,
            config: { ...CFG, minUnique: 9999 }, // impossible uniqueness floor
        });
        expect(r.declined).toBe(false);
        expect(r.accepted).toBe(false); // high sigma, but floor not met -> no accept
    });

    it('reports mode=bc_tight on the fitted (full-frame) path', () => {
        const wcs = mkWCS();
        const pts = gridPoints(16);
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const wideMatches = pts.map(([x, y], i) => mkMatch(x, y, stars[i]));
        const detected = pts.map(([x, y]) => ({ x, y, flux: 1000, fwhm: 2 } as any as DetectedStar));
        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected, imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches, config: CFG,
        });
        expect(r.mode).toBe('bc_tight');
        expect(r.innerFracUsed).toBeNull();
    });
});

describe('runUwTightReverify — variant B inner-region pinhole-tight fallback', () => {
    it('falls back to inner_pinhole when the fit declines but innerFrac is set', () => {
        const wcs = mkWCS();
        const pts = gridPoints(16); // spread across the frame; ~4 land inside 0.4*halfDiag
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const detected = pts.map(([x, y]) => ({ x, y, flux: 1000, fwhm: 2 } as any as DetectedStar));
        const wideMatches = pts.slice(0, 4).map(([x, y], i) => mkMatch(x, y, stars[i])); // < MIN_PAIRS -> fit declines
        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected, imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches,
            config: { ...CFG, minUnique: 1, innerFrac: 0.4 },
        });
        expect(r.declined).toBe(false);
        expect(r.mode).toBe('inner_pinhole');
        expect(r.innerFracUsed).toBeCloseTo(0.4, 10);
        expect(r.k1).toBe(0); // pinhole — no fit applied
        expect(r.tightMatches).toBeGreaterThanOrEqual(1); // inner-region center stars match tight
    });

    it('still declines (no inner fallback) when innerFrac is absent and pairs are too few', () => {
        const wcs = mkWCS();
        const pts = gridPoints(4);
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const wideMatches = pts.map(([x, y], i) => mkMatch(x, y, stars[i]));
        const r = runUwTightReverify({
            wcs, catalogStars: stars, detected: [], imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, wideMatches, config: CFG, // no innerFrac
        });
        expect(r.declined).toBe(true);
        expect(r.mode).toBe('declined');
    });
});

describe('deepWideMatch — deep evidence matcher', () => {
    it('matches a clean synthetic field at the wide net', () => {
        const wcs = mkWCS();
        const pts = gridPoints(16);
        const stars = pts.map(([x, y], i) => mkStar(x, y, i));
        const detected = pts.map(([x, y]) => ({ x, y, flux: 1000, fwhm: 2 } as any as DetectedStar));
        const matches = deepWideMatch({
            wcs, catalog: stars, detected, imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, baseNetPx: 5, wideSlope: 0.035,
            opticalCenterX: (IMG_W - 1) / 2, opticalCenterY: (IMG_H - 1) / 2,
        });
        expect(matches.length).toBeGreaterThanOrEqual(12);
        expect(matches[0].catalog.ra_hours).toBeDefined();
    });

    it('returns no matches under a degenerate CD', () => {
        const matches = deepWideMatch({
            wcs: { crpix: [500, 500], crval: [10, 20], cd: [[0, 0], [0, 0]] },
            catalog: [], detected: [], imageW: IMG_W, imageH: IMG_H,
            safeScale: SCALE_ARCSEC, baseNetPx: 5, wideSlope: 0.035,
            opticalCenterX: 500, opticalCenterY: 500,
        });
        expect(matches).toHaveLength(0);
    });
});
