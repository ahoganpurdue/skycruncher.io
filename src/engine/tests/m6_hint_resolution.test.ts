import { describe, it, expect, vi } from 'vitest';
import { resolveEffectiveHints, type HintResolverDeps } from '../pipeline/m6_plate_solve/hint_resolver';
import { resolveVerifyThresholds } from '../pipeline/m6_plate_solve/solver_entry';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';
import { TrackingMount, FilterType } from '../types/schema';
import type { HardMetadata, SoftMetadata } from '../types/schema';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeHard(overrides: Partial<HardMetadata> = {}): HardMetadata {
    return {
        camera_model: 'ZWO Seestar S30 Pro',
        lens_model: 'Seestar S30 Pro',
        focal_length: 160,
        aperture: 5,
        iso_gain: 200,
        exposure_time: 60,
        timestamp: '2026-05-16T06:47:36.000Z',
        gps_lat: 34.05,
        gps_lon: -118.24,
        timestamp_source: 'FITS',
        gps_source: 'FITS',
        ...overrides,
    };
}

function makeSoft(overrides: Partial<SoftMetadata> = {}): SoftMetadata {
    return {
        is_stacked: true,
        stack_frame_count: 738,
        tracking_mount: TrackingMount.NONE,
        filter_type: FilterType.NONE,
        calibration_frames: [],
        bortle_class: 5,
        contribute_to_archive: false,
        ...overrides,
    };
}

function makeDeps(impl?: HintResolverDeps['computeRaDecFromAltAz']) {
    return {
        computeRaDecFromAltAz: vi.fn(impl ?? (() => ({ ra: 0, dec: 0 }))),
    };
}

// SeeStar sample header: RA=170.425 deg -> 11.3617h, DEC=+12.842 deg
const SAMPLE_RA_HOURS = 170.425 / 15;
const SAMPLE_DEC_DEG = 12.842;

// ─── Hint cascade priority ───────────────────────────────────────────────────

describe('M6 hint resolution cascade', () => {

    it('config hints always win (beat FITS header and soft hints)', () => {
        const deps = makeDeps();
        const result = resolveEffectiveHints(
            { ra_hours: 5.5, dec_degrees: -10, radius_deg: 12 },
            makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }),
            makeSoft({ processing_hints: { ra: 1, dec: 2 } }),
            deps
        );
        expect(result).toBeDefined();
        expect(result!.source).toBe('CONFIG');
        expect(result!.ra_hours).toBe(5.5);
        expect(result!.dec_degrees).toBe(-10);
        expect(result!.radius_deg).toBe(12);
        expect(deps.computeRaDecFromAltAz).not.toHaveBeenCalled();
    });

    it('config hints without radius keep radius_deg undefined (existing semantics)', () => {
        const result = resolveEffectiveHints(
            { ra_hours: 5.5, dec_degrees: -10 },
            makeHard(),
            makeSoft(),
            makeDeps()
        );
        expect(result!.source).toBe('CONFIG');
        expect(result!.radius_deg).toBeUndefined();
    });

    it('FITS header hint beats soft hints and yields the SeeStar sample values', () => {
        const deps = makeDeps();
        const result = resolveEffectiveHints(
            undefined,
            makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }),
            makeSoft({ processing_hints: { ra: 1, dec: 2, azimuth: 270 } }),
            deps
        );
        expect(result).toBeDefined();
        expect(result!.source).toBe('FITS_HEADER');
        expect(result!.ra_hours).toBeCloseTo(11.3617, 4);
        expect(result!.dec_degrees).toBeCloseTo(12.842, 6);
        expect(result!.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_FITS_HEADER_RADIUS);
        expect(result!.radius_deg).toBe(4.0);
        expect(deps.computeRaDecFromAltAz).not.toHaveBeenCalled();
    });

    it('missing ra_hint falls through to the soft coordinate hint', () => {
        const result = resolveEffectiveHints(
            undefined,
            makeHard({ dec_hint: SAMPLE_DEC_DEG }), // ra_hint absent
            makeSoft({ processing_hints: { ra: 5.25, dec: 40 } }),
            makeDeps()
        );
        expect(result!.source).toBe('SOFT_COORD');
        expect(result!.ra_hours).toBe(5.25);
        expect(result!.dec_degrees).toBe(40);
        expect(result!.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_COORDINATE_RADIUS);
    });

    it('missing dec_hint also falls through (both header coordinates required)', () => {
        const result = resolveEffectiveHints(
            undefined,
            makeHard({ ra_hint: SAMPLE_RA_HOURS }), // dec_hint absent
            makeSoft({ processing_hints: { ra: 5.25, dec: 40 } }),
            makeDeps()
        );
        expect(result!.source).toBe('SOFT_COORD');
    });

    it('DSLR azimuth path invokes the injected Alt/Az dep with the pre-refactor arguments', () => {
        const hard = makeHard({ ra_hint: undefined, dec_hint: undefined, timestamp_source: 'EXIF', gps_source: 'EXIF' });
        const deps = makeDeps(() => ({ ra: 13.5, dec: 34 }));
        const result = resolveEffectiveHints(
            undefined,
            hard,
            makeSoft({ processing_hints: { azimuth: 180 } }),
            deps
        );
        expect(deps.computeRaDecFromAltAz).toHaveBeenCalledExactlyOnceWith(
            PIPELINE_CONSTANTS.HINT_ASSUMED_ALTITUDE, // 45 deg assumed altitude
            180,
            hard.gps_lat,
            hard.gps_lon,
            hard.timestamp
        );
        expect(result!.source).toBe('SOFT_AZIMUTH');
        expect(result!.ra_hours).toBe(13.5);
        expect(result!.dec_degrees).toBe(34);
        expect(result!.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_CARDINAL_RADIUS);
    });

    it('azimuth beats coordinates when both soft hints are present (else-if order preserved)', () => {
        const result = resolveEffectiveHints(
            undefined,
            makeHard(),
            makeSoft({ processing_hints: { azimuth: 90, ra: 1, dec: 2 } }),
            makeDeps(() => ({ ra: 6, dec: 20 }))
        );
        expect(result!.source).toBe('SOFT_AZIMUTH');
    });

    it('falls back to zenith when no hints exist (GPS + timestamp path)', () => {
        const hard = makeHard({ ra_hint: undefined, dec_hint: undefined });
        const deps = makeDeps(() => ({ ra: 2.2, dec: 34.05 }));
        const result = resolveEffectiveHints(undefined, hard, makeSoft(), deps);
        expect(deps.computeRaDecFromAltAz).toHaveBeenCalledExactlyOnceWith(
            90, 0, hard.gps_lat, hard.gps_lon, hard.timestamp
        );
        expect(result!.source).toBe('ZENITH');
        expect(result!.ra_hours).toBe(2.2);
        expect(result!.dec_degrees).toBe(34.05);
        expect(result!.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_ZENITH_RADIUS);
    });

    it('returns undefined when the zenith computation throws (pre-refactor catch)', () => {
        const deps = makeDeps(() => { throw new Error('bad timestamp'); });
        const result = resolveEffectiveHints(undefined, makeHard(), makeSoft(), deps);
        expect(result).toBeUndefined();
    });

    it('returns undefined without hard metadata (azimuth resolves null, zenith skipped)', () => {
        const deps = makeDeps();
        const result = resolveEffectiveHints(
            undefined,
            null,
            makeSoft({ processing_hints: { azimuth: 180 } }),
            deps
        );
        expect(result).toBeUndefined();
        expect(deps.computeRaDecFromAltAz).not.toHaveBeenCalled();
    });

    // ── Honest-or-absent: null observer location (no fabricated default) ──────
    it('absent GPS (null coords) skips the zenith fallback — no fabricated default location', () => {
        const deps = makeDeps();
        const hard = makeHard({
            ra_hint: undefined, dec_hint: undefined,
            gps_lat: null, gps_lon: null, gps_source: 'DEFAULT',
        });
        const result = resolveEffectiveHints(undefined, hard, makeSoft(), deps);
        expect(result).toBeUndefined();
        expect(deps.computeRaDecFromAltAz).not.toHaveBeenCalled();
    });

    it('absent GPS (null coords) cannot resolve a soft azimuth hint — dep never called', () => {
        const deps = makeDeps(() => ({ ra: 13.5, dec: 34 }));
        const hard = makeHard({
            ra_hint: undefined, dec_hint: undefined,
            gps_lat: null, gps_lon: null, gps_source: 'DEFAULT',
        });
        const result = resolveEffectiveHints(
            undefined,
            hard,
            makeSoft({ processing_hints: { azimuth: 180 } }),
            deps
        );
        // Azimuth rung yields null (no location); zenith rung is also skipped.
        expect(result).toBeUndefined();
        expect(deps.computeRaDecFromAltAz).not.toHaveBeenCalled();
    });
});

// ─── verifyWCS threshold selection (verifyTuning forwarding target) ─────────

describe('M6 verifyWCS threshold resolution (verifyTuning)', () => {

    it('reproduces the historical wide-field defaults when no tuning is supplied', () => {
        // Dense field (>= 20 detections)
        expect(resolveVerifyThresholds(false, 30)).toEqual({ minAnchorMatches: 5, minConfidence: 0.6 });
        expect(resolveVerifyThresholds(false, 20)).toEqual({ minAnchorMatches: 5, minConfidence: 0.6 });
        // Sparse field (< 20 detections)
        expect(resolveVerifyThresholds(false, 19)).toEqual({ minAnchorMatches: 3, minConfidence: 0.4 });
        expect(resolveVerifyThresholds(false, 10)).toEqual({ minAnchorMatches: 3, minConfidence: 0.4 });
        // Quad lock always wins
        expect(resolveVerifyThresholds(true, 100)).toEqual({ minAnchorMatches: 4, minConfidence: 0.01 });
    });

    it('narrow-FOV tuning relaxes only the dense-field branch', () => {
        const tuning = { minAnchorMatches: 4, minConfidence: 0.45 };
        expect(resolveVerifyThresholds(false, 30, tuning)).toEqual({ minAnchorMatches: 4, minConfidence: 0.45 });
        // Sparse branch untouched
        expect(resolveVerifyThresholds(false, 10, tuning)).toEqual({ minAnchorMatches: 3, minConfidence: 0.4 });
        // Quad-lock branch untouched
        expect(resolveVerifyThresholds(true, 30, tuning)).toEqual({ minAnchorMatches: 4, minConfidence: 0.01 });
    });

    it('denseFieldCutoff moves the sparse/dense boundary', () => {
        // 17 detections: sparse under the default cutoff (20)...
        expect(resolveVerifyThresholds(false, 17)).toEqual({ minAnchorMatches: 3, minConfidence: 0.4 });
        // ...but dense once the cutoff is lowered to 15
        expect(resolveVerifyThresholds(false, 17, { denseFieldCutoff: 15 }))
            .toEqual({ minAnchorMatches: 5, minConfidence: 0.6 });
    });

    it('partial tuning falls back to defaults per field', () => {
        expect(resolveVerifyThresholds(false, 30, { minAnchorMatches: 4 }))
            .toEqual({ minAnchorMatches: 4, minConfidence: 0.6 });
        expect(resolveVerifyThresholds(false, 30, { minConfidence: 0.45 }))
            .toEqual({ minAnchorMatches: 5, minConfidence: 0.45 });
        // An all-undefined tuning object (what autoSolvePlate forwards when the
        // dynamic config carries no verify_* fields) == historical behavior.
        expect(resolveVerifyThresholds(false, 30, {}))
            .toEqual({ minAnchorMatches: 5, minConfidence: 0.6 });
    });
});
