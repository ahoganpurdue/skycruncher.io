/**
 * M10 PSF ATTRIBUTION — physics decomposition of the MEASURED PSF field.
 *
 * Pins the new stage `psf_attribution.runPsfAttribution` + the pure physics
 * predictors `psf_physics`:
 *  1. sidereal-drift + diffraction formulas produce the KNOWN closed-form value;
 *  2. the RA-axis (drift) direction from a CD matrix is correct + parity-aware;
 *  3. honest-absent: no psf_field / no solution / missing EXIF → NOT_MEASURED
 *     blocks, never a fabricated number;
 *  4. test-then-trust: a measured elongation that matches the calculated drift
 *     (magnitude AND direction) is CONFIRMED_PRESENT and decomposed exactly;
 *     a round PSF against a large calculated drift infers TRACKED;
 *  5. the coma 1-parameter fit recovers a planted radial-growth field (FITTED),
 *     and refuses an inconsistent field (never a fabricated coefficient);
 *  6. the stage NEVER mutates the input psf_field (read-only arbiter).
 */
import { describe, it, expect } from 'vitest';
import {
    siderealTrailArcsec, diffractionFwhmArcsec, SIDEREAL_RATE_ARCSEC_PER_SEC,
    raAxisPaDeg, raAxisDirectionDeg, decAxisDirectionDeg, synthesizeCd,
    fitComaCoefficient, driftPsfKernel, foldPa180, lineAngleSepDeg, type Cd2x2,
} from '../pipeline/m10_psf/psf_physics';
import {
    runPsfAttribution, serializePsfAttributionBlock, type PsfAttributionInput,
} from '../pipeline/stages/psf_attribution';
import type { PsfFieldReport, PsfFieldRegion } from '../pipeline/m10_psf/psf_field';
import type { PlateSolution } from '../types/Main_types';
import type { HardMetadata } from '../types/schema';

// ── builders ────────────────────────────────────────────────────────────────

function makeRegions(spec?: Partial<PsfFieldRegion>[]): PsfFieldRegion[] {
    return Array.from({ length: 9 }, (_, i) => ({
        n: 5, fwhmMedianPx: 3, ellipticityMedian: 0.1, orientationMedianDeg: 0,
        ...(spec?.[i] ?? {}),
    }));
}

function makePsfField(over?: Partial<PsfFieldReport>): PsfFieldReport {
    return {
        ledger: 'PIXEL', grid: 'SCIENCE_NATIVE', width: 1000, height: 800,
        method: 'WASM_LM_GAUSSIAN', stampSize: 17, nInput: 100, nFit: 80, nLm: 80, nMoment: 0,
        rejected: {}, fwhmMedianMajPx: 3.0, fwhmMedianMinPx: 3.0, ellipticityMedian: 0.0,
        orientationMedianDeg: 0, regions: makeRegions(), fits: [], approximate: [], timings: {},
        ...over,
    };
}

// A typical sky WCS: RA decreases with +x, Dec increases with +y (no roll).
function cdNoRoll(scaleArcsec: number): Cd2x2 {
    const s = scaleArcsec / 3600;
    return [[-s, 0], [0, s]];
}

function makeSolution(over?: Partial<PlateSolution>): PlateSolution {
    return {
        ra: 260, dec: 20, ra_hours: 17.3333, dec_degrees: 20, pixel_scale: 2.0,
        rotation: 0, rotation_deg: 0, fov_width_deg: 1, fov_height_deg: 0.8, parity: 1,
        spatial_hash: 'x', confidence: 0.9, num_stars: 80,
        wcs: { crpix: [500, 400], crval: [17.3333, 20], cd: cdNoRoll(2.0) },
        ...over,
    } as PlateSolution;
}

function makeMeta(over?: Partial<HardMetadata>): HardMetadata {
    return {
        camera_model: 'Canon EOS 5D Mark III', lens_model: 'EF24mm', focal_length: 24,
        aperture: 2.8, iso_gain: 1600, exposure_time: 15, pixel_pitch_um: 6.25,
        timestamp: '2026-05-16T06:00:00Z', gps_lat: 34, gps_lon: -118,
        timestamp_source: 'EXIF', gps_source: 'EXIF',
        ...over,
    } as HardMetadata;
}

function baseInput(over?: Partial<PsfAttributionInput>): PsfAttributionInput {
    return {
        psfField: makePsfField(), solution: makeSolution(), metadata: makeMeta(),
        imageWidth: 1000, imageHeight: 800, timestampTrusted: true, ...over,
    };
}

// ── 1. closed-form physics ───────────────────────────────────────────────────

describe('psf_physics — closed-form predictors', () => {
    it('sidereal trail = 15.041″/s · cos(Dec) · t (exact at the equator)', () => {
        expect(siderealTrailArcsec(0, 1)).toBeCloseTo(SIDEREAL_RATE_ARCSEC_PER_SEC, 6);
        // Dec=60° halves the rate; 10s → 15.041·0.5·10 = 75.205″
        expect(siderealTrailArcsec(60, 10)).toBeCloseTo(75.205, 3);
        // At the pole a star does not drift.
        expect(siderealTrailArcsec(90, 100)).toBeCloseTo(0, 6);
    });

    it('diffraction FWHM = 1.028·λ/D in arcsec (100mm f/5, green)', () => {
        // D = 100/5 = 20mm; 1.028·0.55e-3/20 · 206264.8 ≈ 5.831″
        const v = diffractionFwhmArcsec(100, 5, 0.55);
        expect(v).toBeCloseTo(5.831, 2);
        // Chromatic: blue floor is tighter than red.
        expect(diffractionFwhmArcsec(100, 5, 0.47)).toBeLessThan(diffractionFwhmArcsec(100, 5, 0.62));
    });

    it('RA-axis (drift) direction is parity-aware; line PA folds to [0,180)', () => {
        // RA decreases with +x ⇒ +RA points −x ⇒ full direction 180°, line PA 0°.
        const cd = cdNoRoll(2.0);
        expect(raAxisDirectionDeg(cd)).toBeCloseTo(180, 4);
        expect(raAxisPaDeg(cd)).toBeCloseTo(0, 4);
        // Dec increases with +y ⇒ North points +y ⇒ 90°.
        expect(decAxisDirectionDeg(cd)).toBeCloseTo(90, 4);
        // A parity flip (RA increases with +x) flips the full direction by 180°.
        const flipped: Cd2x2 = [[2.0 / 3600, 0], [0, 2.0 / 3600]];
        expect(lineAngleSepDeg(raAxisDirectionDeg(flipped), raAxisDirectionDeg(cd))).toBeCloseTo(0, 3);
    });

    it('synthesizeCd rotates the RA-axis line PA by the roll magnitude (mod 180)', () => {
        // A 30° roll rotates the RA axis by 30° relative to the no-roll axis
        // (the roll SIGN is a fallback-only convention; the magnitude is the invariant).
        const rolled = raAxisPaDeg(synthesizeCd(2.0, 30, 1));
        const flat = raAxisPaDeg(synthesizeCd(2.0, 0, 1));
        expect(lineAngleSepDeg(rolled, flat)).toBeCloseTo(30, 3);
    });

    it('driftPsfKernel emits a labeled uniform-line kernel (drift-deblur seam)', () => {
        const k = driftPsfKernel(4.2, 210);
        expect(k.profile).toBe('UNIFORM_LINE');
        expect(k.lengthPx).toBeCloseTo(4.2, 4);
        expect(k.paDeg).toBeCloseTo(30, 3); // 210 folds to 30
        expect(k.note).toMatch(/drift-deblur/i);
    });

    it('coma fit recovers a planted radial-growth field, refuses an inconsistent one', () => {
        // Plant ellipticity = 0.4·r_norm oriented radially over a 3×3 grid.
        const W = 900, H = 900, cx0 = 450, cy0 = 450;
        const maxR = Math.hypot(cx0, cy0);
        const radial = Array.from({ length: 9 }, (_, idx) => {
            const col = idx % 3, row = Math.floor(idx / 3);
            const cx = (col + 0.5) * W / 3, cy = (row + 0.5) * H / 3;
            const r = Math.hypot(cx - cx0, cy - cy0) / maxR;
            const pa = Math.atan2(cy - cy0, cx - cx0) * 180 / Math.PI;
            return { cx, cy, ellipticity: +(0.4 * r).toFixed(4), orientationDeg: foldPa180(pa) };
        });
        const fit = fitComaCoefficient(radial, W, H);
        expect(fit.patternConsistent).toBe(true);
        expect(fit.coeffPerPx).toBeGreaterThan(0.3);
        expect(fit.coeffPerPx).toBeLessThan(0.5);
        expect(fit.rSquared).toBeGreaterThan(0.9);

        // Random orientations (not radial) ⇒ not consistent.
        const scrambled = radial.map((s, i) => ({ ...s, orientationDeg: (i * 47) % 180 }));
        expect(fitComaCoefficient(scrambled, W, H).patternConsistent).toBe(false);
    });
});

// ── 2. the stage: honest-absence ─────────────────────────────────────────────

describe('runPsfAttribution — honest absence', () => {
    it('no psf_field or no solution → fully NOT_MEASURED', () => {
        const a = runPsfAttribution(baseInput({ psfField: null }));
        expect(a.notMeasured).toBeTruthy();
        expect(a.drift.tier).toBe('NOT_MEASURED');
        expect(a.tracking.inference).toBe('NOT_MEASURED');

        const b = runPsfAttribution(baseInput({ solution: null }));
        expect(b.drift.calculatedPx).toBeNull();
    });

    it('missing exposure/aperture EXIF → drift + diffraction honest-absent, no fabricated px', () => {
        const meta = makeMeta({ exposure_time: 0, aperture: 0, focal_length: 0 });
        const a = runPsfAttribution(baseInput({ metadata: meta }));
        expect(a.drift.tier).toBe('NOT_MEASURED');
        expect(a.drift.calculatedPx).toBeNull();
        expect(a.drift.notMeasured).toMatch(/NOT CALCULABLE/);
        expect(a.diffraction.tier).toBe('NOT_MEASURED');
        expect(a.diffraction.floorPx).toBeNull();
        expect(a.tracking.inference).toBe('NOT_MEASURED');
    });

    it('refraction is GATED OFF on an untrusted clock (bogus clock ⇒ bogus geometry)', () => {
        const a = runPsfAttribution(baseInput({ timestampTrusted: false }));
        expect(a.refraction.tier).toBe('NOT_MEASURED');
        expect(a.refraction.notMeasured).toMatch(/untrusted|DEFAULT/i);
        // …but drift + diffraction (clock-independent) still compute.
        expect(a.drift.tier === 'CALCULATED' || a.drift.tier === 'CONFIRMED').toBe(true);
    });

    it('refraction is GATED OFF on DEFAULT GPS', () => {
        const a = runPsfAttribution(baseInput({ metadata: makeMeta({ gps_source: 'DEFAULT' }) }));
        expect(a.refraction.tier).toBe('NOT_MEASURED');
    });
});

// ── 3. test-then-trust decomposition + tracking inference ────────────────────

describe('runPsfAttribution — test-then-trust + tracking inference', () => {
    it('measured elongation matching the calculated drift ⇒ CONFIRMED_PRESENT + UNTRACKED', () => {
        // Dec 0, 20s, scale 2″/px ⇒ drift = 15.041·20/2 = 150.4px. Way too big for
        // a real PSF; scale it down: use 0.02″/px? Simpler — pick numbers that land
        // a few px. Dec 89.9°, 20s, 2″/px ⇒ 15.041·cos(89.9)·20/2 ≈ 0.26px (too small).
        // Use exposure 0.8s, Dec 0, 2″/px ⇒ 15.041·0.8/2 = 6.02px.
        const sol = makeSolution({ dec_degrees: 0 });
        const meta = makeMeta({ exposure_time: 0.8 });
        const driftPx = SIDEREAL_RATE_ARCSEC_PER_SEC * 0.8 / 2; // 6.0164
        // Measured: round core 3px broadened along the drift axis (line PA 0°):
        // major = sqrt(3² + drift²), minor = 3, orientation = 0 (along RA axis).
        const maj = Math.sqrt(9 + driftPx * driftPx);
        const psf = makePsfField({
            fwhmMedianMajPx: maj, fwhmMedianMinPx: 3.0,
            ellipticityMedian: 1 - 3 / maj, orientationMedianDeg: 0,
        });
        const a = runPsfAttribution(baseInput({ solution: sol, metadata: meta, psfField: psf }));
        expect(a.drift.presence).toBe('CONFIRMED_PRESENT');
        expect(a.drift.tier).toBe('CONFIRMED');
        expect(a.drift.calculatedPx).toBeCloseTo(driftPx, 2);
        // Exact decomposition: residual core = sqrt(maj² − drift²) ≈ the 3px core.
        expect(a.drift.residualCorePx).toBeCloseTo(3.0, 1);
        expect(a.decomposition.explainedDriftPx).toBeCloseTo(driftPx, 2);
        expect(a.tracking.inference).toBe('UNTRACKED');
        expect(a.tracking.tier).toBe('INFERRED');
    });

    it('round PSF against a large calculated drift ⇒ NOT_CONFIRMED + TRACKED', () => {
        const sol = makeSolution({ dec_degrees: 0 });
        const meta = makeMeta({ exposure_time: 0.8 }); // drift ≈ 6px
        // Measured PSF is round (no elongation) despite the big predicted drift.
        const psf = makePsfField({ fwhmMedianMajPx: 3.0, fwhmMedianMinPx: 3.0, ellipticityMedian: 0.0, orientationMedianDeg: 0 });
        const a = runPsfAttribution(baseInput({ solution: sol, metadata: meta, psfField: psf }));
        expect(a.drift.presence).toBe('NOT_CONFIRMED');
        expect(a.tracking.inference).toBe('TRACKED');
    });

    it('a below-floor drift ⇒ NEGLIGIBLE + INDETERMINATE tracking', () => {
        // Dec 0, 0.02s ⇒ drift = 15.041·0.02/2 = 0.15px < 0.5px floor.
        const sol = makeSolution({ dec_degrees: 0 });
        const meta = makeMeta({ exposure_time: 0.02 });
        const a = runPsfAttribution(baseInput({ solution: sol, metadata: meta }));
        expect(a.drift.presence).toBe('NEGLIGIBLE');
        expect(a.tracking.inference).toBe('INDETERMINATE');
    });

    it('serializer round-trips a JSON-safe additive block with all tiers labeled', () => {
        const a = runPsfAttribution(baseInput());
        const block = serializePsfAttributionBlock(a);
        expect(() => JSON.stringify(block)).not.toThrow();
        expect(block.drift.tier).toBeTruthy();
        expect(block.diffraction.tier).toBeTruthy();
        expect(block.field_rotation.tier).toBe('NOT_MEASURED'); // deferred, honest
        expect(block.ledger).toBe('PIXEL');
    });
});

// ── 4. read-only guarantee (physics never overrides the measurement) ─────────

describe('runPsfAttribution — read-only w.r.t. the measured psf_field', () => {
    it('does not mutate the input psf_field (the arbiter is untouched)', () => {
        const psf = makePsfField({ fwhmMedianMajPx: 4.2, fwhmMedianMinPx: 3.1, ellipticityMedian: 0.26, orientationMedianDeg: 12 });
        const snapshot = JSON.stringify(psf);
        runPsfAttribution(baseInput({ psfField: psf }));
        expect(JSON.stringify(psf)).toBe(snapshot);
    });
});
