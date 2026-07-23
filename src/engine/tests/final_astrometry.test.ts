import { describe, it, expect } from 'vitest';
import {
    runFinalAstrometry, serializeFinalAstrometryBlock, type FinalAstrometryInput,
} from '../pipeline/stages/final_astrometry';
import { ResidualAnalyzer } from '../pipeline/m7_astrometry/residual_analyzer';
import type { PlateSolution, MatchedStar } from '../types/Main_types';
import type { PsfFieldReport, PsfFieldFit } from '../pipeline/m10_psf/psf_field';

// ── synthetic distorted field: a linear WCS + a KNOWN quadratic distortion an
//    order-3 SIP must recover. crval[0] is HOURS (engine convention). ──
const CRPIX: [number, number] = [500, 500];
const CRVAL: [number, number] = [10.0, 40.0]; // 10h RA, 40° Dec
const SCALE_ARCSEC = 2.0;
const S = SCALE_ARCSEC / 3600; // deg/px
const WCS = { crpix: CRPIX, crval: CRVAL, cd: [[-S, 0], [0, S]] as [[number, number], [number, number]] };

// quadratic distortion coeffs (a few px at the edge)
const A20 = 2e-5, A11 = 1e-5, A02 = -1.5e-5;
const B20 = -1.2e-5, B11 = 2e-5, B02 = 1e-5;
function distort(u: number, v: number): [number, number] {
    return [A20 * u * u + A11 * u * v + A02 * v * v, B20 * u * u + B11 * u * v + B02 * v * v];
}

function buildScene(opts: { nGrid?: number; fitOffset?: number; withAmp?: boolean } = {}) {
    const nGrid = opts.nGrid ?? 7;
    const matched: MatchedStar[] = [];
    const fits: PsfFieldFit[] = [];
    for (let i = 0; i < nGrid; i++) {
        for (let j = 0; j < nGrid; j++) {
            const raDeg = 150 + (i - (nGrid - 1) / 2) * 0.08;
            const decDeg = 40 + (j - (nGrid - 1) / 2) * 0.08;
            const lp = ResidualAnalyzer.skyToLinearPixel(raDeg, decDeg, WCS);
            if (!Number.isFinite(lp.x) || !Number.isFinite(lp.y)) continue;
            if (lp.x < 20 || lp.y < 20 || lp.x > 980 || lp.y > 980) continue;
            const u = lp.x - CRPIX[0], v = lp.y - CRPIX[1];
            const [dx, dy] = distort(u, v);
            const detX = lp.x + dx, detY = lp.y + dy;
            const resPx = Math.hypot(dx, dy);
            matched.push({
                detected: { x: detX, y: detY, rawX: detX, rawY: detY, flux: 1000, fwhm: 2.5 },
                catalog: { ra: raDeg, dec: decDeg, mag: 10, ra_hours: raDeg / 15, dec_degrees: decDeg, gaia_id: `Gaia_${i}_${j}` },
                residual_arcsec: resPx * SCALE_ARCSEC,
            });
            const off = opts.fitOffset ?? 0;
            fits.push({
                x: detX + off, y: detY + off, amp: opts.withAmp === false ? NaN : (500 + (i * nGrid + j) * 10),
                sigmaMajPx: 1.1, sigmaMinPx: 1.0, fwhmMajPx: 2.6, fwhmMinPx: 2.4,
                ellipticity: 0.08, orientationDeg: 30, source: 'lm',
            });
        }
    }
    const solution = {
        ra: 150, dec: 40, ra_hours: 10.0, dec_degrees: 40,
        pixel_scale: SCALE_ARCSEC, rotation: 0, rotation_deg: 0,
        fov_width_deg: 0.5, fov_height_deg: 0.5, parity: 1, spatial_hash: 'x',
        confidence: 0.9, num_stars: matched.length, matched_stars: matched, wcs: WCS,
    } as unknown as PlateSolution;
    const psfField: PsfFieldReport = {
        ledger: 'PIXEL', grid: 'SCIENCE_NATIVE', width: 1000, height: 1000,
        method: 'WASM_LM_GAUSSIAN', stampSize: 17, nInput: fits.length, nFit: fits.length,
        nLm: fits.length, nMoment: 0, rejected: {}, fwhmMedianMajPx: 2.6, fwhmMedianMinPx: 2.4,
        ellipticityMedian: 0.08, orientationMedianDeg: 30, regions: [], fits, approximate: [], timings: {},
    };
    return { solution, psfField, matched, fits };
}

function baseInput(over: Partial<FinalAstrometryInput> = {}): FinalAstrometryInput {
    const { solution, psfField } = buildScene();
    return {
        solution, psfField, metadata: null, timestampTrusted: false,
        imageWidth: 1000, imageHeight: 1000, ...over,
    };
}

describe('final_astrometry — terminal WCS refit (COORDINATE ledger)', () => {
    it('produces a provenance-tagged refined WCS + refined SIP that lowers the residual', () => {
        const r = runFinalAstrometry(baseInput());
        expect(r).not.toBeNull();
        expect(r!.provenance).toBe('REFINED_FINAL_ASTROMETRY');
        expect(r!.ledger).toBe('COORDINATE');
        expect(r!.nStars).toBeGreaterThanOrEqual(20);
        expect(r!.sip).not.toBeNull();
        expect(r!.wcs).not.toBeNull();
        // linear terms are the solve's (never a linear refit) — identical CD/crval.
        expect(r!.wcs!.crval).toEqual(CRVAL);
        expect(r!.wcs!.cd).toEqual(WCS.cd);
        // the order-3 SIP recovers the known quadratic distortion → residual collapses.
        expect(r!.rms.linearArcsec!).toBeGreaterThan(0.5);
        expect(r!.rms.refinedArcsec!).toBeLessThan(r!.rms.linearArcsec! * 0.05);
        expect(r!.improved).toBe(true);
    });

    it('adopts the PSF-fit centroids for every matched star within tolerance', () => {
        const r = runFinalAstrometry(baseInput());
        expect(r!.nPsfCentroids).toBe(r!.nStars);
        expect(r!.psfCentroidSource).toBe('WASM_LM_GAUSSIAN');
    });

    it('keeps the raw centroid (honest fallback) when no PSF fit is within tolerance', () => {
        const { solution, psfField } = buildScene({ fitOffset: 50 }); // fits far from detections
        const r = runFinalAstrometry({
            solution, psfField, metadata: null, timestampTrusted: false, imageWidth: 1000, imageHeight: 1000,
        });
        expect(r).not.toBeNull();
        expect(r!.nPsfCentroids).toBe(0);
        expect(r!.approximate.some(a => /kept their raw solve centroid/.test(a))).toBe(true);
    });

    it('uses SNR-honest PSF-amplitude weighting when amplitudes exist, else UNIFORM', () => {
        expect(runFinalAstrometry(baseInput())!.weighting.method).toBe('PSF_AMPLITUDE');
        const { solution, psfField } = buildScene({ withAmp: false });
        const r = runFinalAstrometry({ solution, psfField, metadata: null, timestampTrusted: false, imageWidth: 1000, imageHeight: 1000 });
        expect(r!.weighting.method).toBe('UNIFORM');
    });

    it('honest-skips differential refraction on an untrusted clock', () => {
        const r = runFinalAstrometry(baseInput({ timestampTrusted: false }));
        expect(r!.refraction.applied).toBe(false);
        expect(r!.refraction.tier).toBe('NOT_MEASURED');
        expect(r!.refraction.notApplied).toMatch(/clock|Timestamp/);
    });

    it('honest-skips differential refraction when GPS is absent even with a trusted clock', () => {
        const r = runFinalAstrometry(baseInput({
            timestampTrusted: true,
            metadata: { timestamp_source: 'EXIF', timestamp: '2026-01-01T08:00:00Z' } as any,
        }));
        expect(r!.refraction.applied).toBe(false);
        expect(r!.refraction.notApplied).toMatch(/GPS/);
    });

    it('applies differential refraction at coordinate level when clock AND site are real', () => {
        const r = runFinalAstrometry(baseInput({
            timestampTrusted: true,
            metadata: {
                timestamp_source: 'EXIF', timestamp: '2026-01-01T08:00:00Z',
                gps_source: 'EXIF', gps_lat: 34.2, gps_lon: -118.1,
            } as any,
        }));
        expect(r!.refraction.applied).toBe(true);
        expect(r!.refraction.tier).toBe('APPROXIMATE');
        expect(r!.refraction.siteLatDeg).toBe(34.2);
        expect(r!.refraction.fieldCenterAltDeg).not.toBeNull();
        expect(r!.refraction.medianDisplacementPx).not.toBeNull();
        expect(r!.refraction.zenithPaImageDeg).not.toBeNull();
    });

    it('returns null (honest-absent) on missing solution / PSF field / too-few stars', () => {
        expect(runFinalAstrometry(baseInput({ solution: null }))).toBeNull();
        expect(runFinalAstrometry(baseInput({ psfField: null }))).toBeNull();
        const { solution, psfField } = buildScene({ nGrid: 4 }); // 16 stars < MIN_STARS(20)
        expect(runFinalAstrometry({ solution, psfField, metadata: null, timestampTrusted: false, imageWidth: 1000, imageHeight: 1000 })).toBeNull();
    });

    it('never mutates the input solution (product-only; solve WCS untouched)', () => {
        const inp = baseInput();
        const wcsBefore = JSON.stringify(inp.solution!.wcs);
        const detBefore = JSON.stringify(inp.solution!.matched_stars!.map(m => [m.detected.x, m.detected.y]));
        runFinalAstrometry(inp);
        expect(JSON.stringify(inp.solution!.wcs)).toBe(wcsBefore);
        expect(JSON.stringify(inp.solution!.matched_stars!.map(m => [m.detected.x, m.detected.y]))).toBe(detBefore);
        expect((inp.solution as any).astrometry).toBeUndefined();
    });

    it('serializes an additive, null-safe receipt block', () => {
        const b = serializeFinalAstrometryBlock(runFinalAstrometry(baseInput())!);
        expect(b.provenance).toBe('REFINED_FINAL_ASTROMETRY');
        expect(b.not_measured).toBeNull();
        expect(b.sip).toHaveProperty('a');
        expect(b.wcs).toHaveProperty('crpix');
        expect(b.rms).toHaveProperty('refinedArcsec');
    });
});

describe('ResidualAnalyzer.fitSip — weighted extension (LAW 4, byte-identical unweighted path)', () => {
    const pts = Array.from({ length: 40 }, (_, k) => {
        const u = (k % 8) * 25 - 100, v = Math.floor(k / 8) * 40 - 100;
        return { u, v, dx: 1e-5 * u * u - 3e-6 * v * v, dy: 2e-5 * u * v };
    });

    it('unweighted fitSip === fitSip with uniform weights (IEEE byte-identical)', () => {
        const a = ResidualAnalyzer.fitSip(pts, 3);
        const b = ResidualAnalyzer.fitSip(pts, 3, pts.map(() => 1));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('non-uniform weights change the fit', () => {
        const a = ResidualAnalyzer.fitSip(pts, 3);
        const w = ResidualAnalyzer.fitSip(pts, 3, pts.map((_, k) => 1 + k));
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(w));
    });
});
