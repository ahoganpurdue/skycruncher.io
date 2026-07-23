import { describe, it, expect } from 'vitest';
import { resolveWizardHints, type CallerTargetHint } from '../pipeline/stages/solve';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';
import type { HardMetadata } from '../types/schema';

/**
 * ITEM 2 (ROADMAP:39) — the previously-DEAD upload target-hint wire.
 *
 * `resolveWizardHints` used to hard-code the caller-hints rung to `undefined`,
 * so no user/scraped hint could reach the resolver ladder. These tests pin the
 * new behaviour AND the sacred guarantee: with NO caller hint the resolver
 * output is byte-identical to the historical FITS-header → zenith → blind path.
 *
 * Cases are chosen to exercise ONLY the CONFIG / FITS_HEADER / BLIND rungs — the
 * ZENITH rung would pull in the real Alt/Az math (TimeService), which is covered
 * by m6_hint_resolution.test.ts instead.
 */

function makeHard(overrides: Partial<HardMetadata> = {}): HardMetadata {
    return {
        camera_model: 'ZWO Seestar S30 Pro',
        lens_model: 'Seestar S30 Pro',
        focal_length: 160,
        aperture: 5,
        iso_gain: 200,
        exposure_time: 60,
        timestamp: '2026-05-16T06:47:36.000Z',
        // No GPS → the ZENITH rung stays inert (no Alt/Az math in these tests).
        gps_lat: null as unknown as number,
        gps_lon: null as unknown as number,
        timestamp_source: 'FITS',
        gps_source: 'DEFAULT',
        ...overrides,
    };
}

const SAMPLE_RA_HOURS = 170.425 / 15; // SeeStar-style header RA
const SAMPLE_DEC_DEG = 12.842;

describe('resolveWizardHints — upload target-hint forwarding (ITEM 2)', () => {

    // ── The sacred guarantee: default path (no hint) unchanged ──────────────
    it('SACRED: no caller hint → BLIND (null metadata), byte-identical to historical', () => {
        const r = resolveWizardHints(null, false, false);
        expect(r).toEqual({ hints: { radius_deg: 180 }, source: 'BLIND' });
    });

    it('SACRED: no caller hint → FITS_HEADER when the header carries a pointing', () => {
        const r = resolveWizardHints(makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }), false, true);
        expect(r.source).toBe('FITS_HEADER');
        expect(r.hints.ra_hours).toBe(SAMPLE_RA_HOURS);
        expect(r.hints.dec_degrees).toBe(SAMPLE_DEC_DEG);
        expect(r.hints.trusted).toBe(true);
        expect(r.hints.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_FITS_HEADER_RADIUS);
    });

    it('SACRED: adding the callerHint param (null / undefined) changes NOTHING', () => {
        const base = resolveWizardHints(makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }), false, true);
        const withNull = resolveWizardHints(makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }), false, true, null);
        const withUndef = resolveWizardHints(makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }), false, true, undefined);
        expect(withNull).toEqual(base);
        expect(withUndef).toEqual(base);

        const blindBase = resolveWizardHints(null, false, false);
        expect(resolveWizardHints(null, false, false, null)).toEqual(blindBase);
    });

    // ── The new wire: explicit user target hint → CONFIG rung ───────────────
    it('coordinate hint enters the CONFIG rung (trusted, coordinate-hint radius)', () => {
        const hint: CallerTargetHint = { ra: 5.5, dec: -10, label: 'Manual Hint' };
        const r = resolveWizardHints(null, false, false, hint);
        expect(r.source).toBe('CONFIG');
        expect(r.hints.ra_hours).toBe(5.5);
        expect(r.hints.dec_degrees).toBe(-10);
        expect(r.hints.trusted).toBe(true);
        expect(r.hints.radius_deg).toBe(PIPELINE_CONSTANTS.HINT_COORDINATE_RADIUS);
    });

    it('coordinate hint WINS over a FITS header pointing (explicit caller hints always win)', () => {
        const r = resolveWizardHints(
            makeHard({ ra_hint: SAMPLE_RA_HOURS, dec_hint: SAMPLE_DEC_DEG }),
            false, true,
            { ra: 0.712, dec: 41.26, label: 'Andromeda (M31)' }
        );
        expect(r.source).toBe('CONFIG');
        expect(r.hints.ra_hours).toBe(0.712);
        expect(r.hints.dec_degrees).toBe(41.26);
    });

    // ── The guard: azimuth-mode sentinel (ra === -1) is NOT a coordinate ────
    it('azimuth-mode sentinel (ra === -1) is NOT forwarded as a literal RA', () => {
        const r = resolveWizardHints(null, false, false, { ra: -1, dec: 90, label: 'Looking E' });
        expect(r.source).not.toBe('CONFIG');
        expect(r.source).toBe('BLIND');
        expect(r.hints.ra_hours).toBeUndefined();
    });

    it('non-finite hint values are rejected (never poison the search center)', () => {
        expect(resolveWizardHints(null, false, false, { ra: NaN, dec: 5, label: 'x' }).source).toBe('BLIND');
        expect(resolveWizardHints(null, false, false, { ra: 5, dec: Infinity, label: 'x' }).source).toBe('BLIND');
    });
});
