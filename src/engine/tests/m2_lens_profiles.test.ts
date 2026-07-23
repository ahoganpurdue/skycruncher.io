/**
 * M2 lens_profiles — shared-state hygiene (ultracode G3, 2026-07-10).
 *
 * Regression guard for the CODE_ROT_REPORT finding at lens_profiles.ts:204:
 * `interpolateVignette` used to call `.sort()` IN PLACE on
 * `profile.focal_lengths`, a live reference straight out of the exported
 * LENS_DB (findLensByModel returns the DB object uncopied). Every DB entry
 * happens to be ascending today, so the mutation was latent — these tests
 * pin the contract that the helper never writes back into the profile.
 */
import { describe, it, expect } from 'vitest';
import {
    LENS_DB,
    findLensByModel,
    interpolateVignette,
    type LensProfile,
} from '../pipeline/m2_hardware/lens_profiles';

/** A profile with DELIBERATELY unsorted focal_lengths — the case the old
 *  in-place sort visibly corrupts (it would reorder to [15, 24, 35]). */
function makeUnsortedProfile(): LensProfile {
    return {
        model: 'Test Zoom 15-35mm',
        manufacturer: 'Test',
        focal_lengths: [35, 15, 24],
        image_circle_mm: 43.3,
        max_aperture: { 15: 2.8, 24: 2.8, 35: 2.8 },
        vignette: {
            15: { k1: -0.45, k2: 0.25, k3: -0.08 },
            24: { k1: -0.28, k2: 0.12, k3: -0.03 },
            35: { k1: -0.18, k2: 0.05, k3: -0.01 },
        },
        distortion: {
            15: { k1: -0.035, k2: 0.008, p1: 0, p2: 0 },
            24: { k1: -0.008, k2: 0.001, p1: 0, p2: 0 },
            35: { k1: 0.001, k2: 0.0, p1: 0, p2: 0 },
        },
    };
}

describe('M2 interpolateVignette — no shared-state mutation (G3)', () => {
    it('does not reorder profile.focal_lengths (unsorted fixture)', () => {
        const profile = makeUnsortedProfile();
        interpolateVignette(profile, 20);
        expect(profile.focal_lengths).toEqual([35, 15, 24]);
    });

    it('still interpolates correctly when focal_lengths arrive unsorted', () => {
        const profile = makeUnsortedProfile();
        // 20mm sits between 15 and 24: t = (20-15)/(24-15) = 5/9
        const t = 5 / 9;
        const a = profile.vignette[15];
        const b = profile.vignette[24];
        const v = interpolateVignette(profile, 20);
        expect(v.k1).toBeCloseTo(a.k1 + t * (b.k1 - a.k1), 12);
        expect(v.k2).toBeCloseTo(a.k2 + t * (b.k2 - a.k2), 12);
        expect(v.k3).toBeCloseTo(a.k3 + t * (b.k3 - a.k3), 12);
    });

    it('leaves the live LENS_DB entry untouched (same reference, same contents)', () => {
        const profile = findLensByModel('RF 15-35mm f/2.8L IS USM');
        expect(profile).not.toBeNull();
        // findLensByModel returns the LIVE DB object — that is exactly why the
        // in-place sort was a shared-state hazard.
        expect(profile).toBe(LENS_DB['CANON_RF_15_35']);
        const before = [...profile!.focal_lengths];
        const beforeRef = profile!.focal_lengths;
        interpolateVignette(profile!, 22);
        expect(profile!.focal_lengths).toBe(beforeRef); // no replacement either
        expect(profile!.focal_lengths).toEqual(before); // …and no reorder
    });
});
