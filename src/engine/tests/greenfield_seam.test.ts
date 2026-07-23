import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
    mapGreenfieldSolution,
    buildGreenfieldDiagnostics,
    isGreenfieldSolverEnabled,
    isScaleHintEnabled,
    resolveScaleHint,
    SCALE_HINT_MARGIN,
    SCALE_HINT_MIN_ARCSEC,
    SCALE_HINT_MAX_ARCSEC,
    SCALE_HINT_CLASS_THRESHOLD_ARCSEC,
    type GreenfieldResponse,
    type GfSolvedResult,
    type GfReceipt,
    type GfHydratedMatch,
    type ScaleHintInput,
} from '../pipeline/stages/greenfield_seam';
import type { DetectedStar } from '../types/Main_types';

// M66 SeeStar pinned reference solve (PINNED_REFERENCE_SOLVES.json / M66_seestar receipt).
const M66_RA_DEG = 170.11844356557404;
const M66_DEC_DEG = 13.048758677673888;
const M66_SCALE = 3.679184978895153;
const BANKED_RECEIPT =
    'D:/AstroLogic/test_artifacts/greenfield_solver/m6/receipts/M66_seestar.receipt.json';

function mkDet(x: number, y: number): DetectedStar {
    return { x, y, rawX: x, rawY: y, flux: 1000, fwhm: 3 };
}

function synthSolved(): GfSolvedResult {
    return {
        wcs: {
            crval: { ra: M66_RA_DEG, dec: M66_DEC_DEG },
            crpix: { x: 1080, y: 1920 },
            cd: [
                [-0.001, 0],
                [0, -0.001],
            ],
        },
        scale_arcsec_px: M66_SCALE,
        parity_sign: 1,
        final_verify: { log_odds: 825.4, n_matched: 265 },
        band: 4,
        rung: 0,
        hypothesis_seq: 0,
        matches: [],
    };
}

function synthReceipt(solved: GfSolvedResult | null, state = 'Solved'): GfReceipt {
    return {
        decision: {
            result: { state, solved, search_truncated: true },
            search: { per_band: {} },
        },
        decision_digest: 'synthetic',
        telemetry: { wall_ms: 100 },
    };
}

function synthHydrated(): GfHydratedMatch[] {
    return [
        { det_id: 0, star_row: 10, ra: 170.1, dec: 13.02, gmag: 11.2, residual_x: 0.3, residual_y: -0.2 },
        { det_id: 1, star_row: 20, ra: 170.3, dec: 13.1, gmag: 12.7, residual_x: -0.1, residual_y: 0.4 },
    ];
}

describe('greenfield_seam', () => {
    it('flag is DEFAULT ON (desktop) and reads VITE_SOLVER_GREENFIELD (disabled only by =0)', () => {
        const prev = process.env.VITE_SOLVER_GREENFIELD;
        // unset ⇒ ENABLED (default-on, same polarity family as the rawler decoder flag)
        delete process.env.VITE_SOLVER_GREENFIELD;
        expect(isGreenfieldSolverEnabled()).toBe(true);
        // '1' ⇒ enabled
        process.env.VITE_SOLVER_GREENFIELD = '1';
        expect(isGreenfieldSolverEnabled()).toBe(true);
        // '0' ⇒ disabled (the desktop cold path)
        process.env.VITE_SOLVER_GREENFIELD = '0';
        expect(isGreenfieldSolverEnabled()).toBe(false);
        if (prev === undefined) delete process.env.VITE_SOLVER_GREENFIELD;
        else process.env.VITE_SOLVER_GREENFIELD = prev;
    });

    it('maps a SOLVED response to the legacy PlateSolution', () => {
        const solved = synthSolved();
        const resp: GreenfieldResponse = {
            receipt: synthReceipt(solved),
            solved,
            hydrated_matches: synthHydrated(),
        };
        const dets = [mkDet(100, 200), mkDet(300, 400)];
        const sol = mapGreenfieldSolution(resp, dets, 2160, 3840);
        expect(sol).not.toBeNull();

        // crval[0] hours ≈ ra_deg/15 (the #1 unit trap)
        expect(sol!.wcs.crval[0]).toBeCloseTo(M66_RA_DEG / 15, 9);
        expect(sol!.ra_hours).toBeCloseTo(M66_RA_DEG / 15, 9);
        // top-level ra = DEGREES (legacy convention)
        expect(sol!.ra).toBeCloseTo(M66_RA_DEG, 6);
        // dec passthrough (degrees)
        expect(sol!.dec_degrees).toBeCloseTo(M66_DEC_DEG, 9);
        expect(sol!.wcs.crval[1]).toBeCloseTo(M66_DEC_DEG, 9);
        expect(sol!.dec).toBeCloseTo(M66_DEC_DEG, 9);
        // scale + parity mapping
        expect(sol!.pixel_scale).toBe(M66_SCALE);
        expect(sol!.parity).toBe(1);
        // provenance + honest posterior
        expect(sol!.solved_via).toBe('greenfield_rust');
        expect(sol!.greenfield_log_odds).toBe(825.4);
        expect(sol!.confidence).toBeGreaterThan(0.99);
        expect(sol!.greenfield_receipt).toBeTruthy();
        // fov derived from dims × scale
        expect(sol!.fov_width_deg).toBeCloseTo((2160 * M66_SCALE) / 3600, 9);
        expect(sol!.fov_height_deg).toBeCloseTo((3840 * M66_SCALE) / 3600, 9);

        // matched_stars carry finite catalog ra/dec/mag (step-6 charts hard-require these)
        expect(sol!.matched_stars!.length).toBe(2);
        for (const m of sol!.matched_stars!) {
            expect(Number.isFinite(m.catalog.ra)).toBe(true);
            expect(Number.isFinite(m.catalog.dec)).toBe(true);
            expect(Number.isFinite(m.catalog.mag)).toBe(true);
            // residual_arcsec = |residual|_px × scale (residuals are native pixels)
            expect(Number.isFinite(m.residual_arcsec)).toBe(true);
        }
        // det pixel positions recovered by det_id (array index)
        expect(sol!.matched_stars![0].detected.x).toBe(100);
        expect(sol!.matched_stars![1].detected.x).toBe(300);
    });

    it('returns null for a non-Solved terminal state (→ existing failure path)', () => {
        const resp: GreenfieldResponse = {
            receipt: synthReceipt(null, 'NoMatch'),
            solved: null,
            hydrated_matches: [],
        };
        expect(mapGreenfieldSolution(resp, [], 2160, 3840)).toBeNull();
        const diag = buildGreenfieldDiagnostics(resp, null);
        expect(diag.verified_clusters).toBe(0);
        expect(diag.rejection_reasons.length).toBeGreaterThan(0);
        // Honest-or-absent: greenfield runs no background model — the field is
        // ABSENT (NOT MEASURED), never a plausible fake 0.
        expect('peak_background_ratio' in diag).toBe(false);
    });

    it('maps the banked M66 receipt fixture (real wcs/scale/parity) when present', () => {
        if (!existsSync(BANKED_RECEIPT)) return; // hermetic pass without the D: fixture (not a skip)
        const receipt = JSON.parse(readFileSync(BANKED_RECEIPT, 'utf8')) as GfReceipt;
        const solved = receipt.decision.result.solved;
        expect(solved).toBeTruthy();
        // The banked receipt carries star_row-only matches (ra/dec/gmag come from the Rust
        // hydration step, absent in a bare receipt) — synthesize hydration to exercise the
        // catalog-field mapping against the REAL wcs/scale/parity.
        const resp: GreenfieldResponse = { receipt, solved, hydrated_matches: synthHydrated() };
        const dets = [mkDet(100, 200), mkDet(300, 400)];
        const sol = mapGreenfieldSolution(resp, dets, 2160, 3840)!;
        expect(sol).not.toBeNull();
        expect(sol.wcs.crval[0]).toBeCloseTo(solved!.wcs.crval.ra / 15, 9);
        expect(sol.dec_degrees).toBeCloseTo(solved!.wcs.crval.dec, 9);
        expect(sol.pixel_scale).toBe(solved!.scale_arcsec_px);
        expect(sol.parity).toBe(solved!.parity_sign);
        for (const m of sol.matched_stars!) {
            expect(Number.isFinite(m.catalog.ra)).toBe(true);
            expect(Number.isFinite(m.catalog.dec)).toBe(true);
            expect(Number.isFinite(m.catalog.mag)).toBe(true);
        }
    });
});

// ─── two-flow scale hint (VITE_SOLVER_SCALE_HINT, DEFAULT OFF) ────────────────────

describe('greenfield_seam scale hint', () => {
    // A physically consistent NARROW prior: implied = 206.265·pitch/focal, native ratio 1.
    const NARROW: ScaleHintInput = {
        focalLengthMm: 200,
        pixelPitchUm: 4.0, // implied ≈ 4.125 ″/px
        solveScaleArcsecPx: 4.125,
        lensModel: 'Canon EF 200mm f/2.8',
    };
    // A physically consistent WIDE prior (the 14mm ultrawide class), native ratio 1.
    const WIDE: ScaleHintInput = {
        focalLengthMm: 14,
        pixelPitchUm: 4.3, // implied ≈ 63.35 ″/px
        solveScaleArcsecPx: 63.35,
        lensModel: 'Rokinon 14mm F2.8',
    };

    it('flag is DEFAULT OFF and reads VITE_SOLVER_SCALE_HINT (enabled only by 1/true)', () => {
        const prev = process.env.VITE_SOLVER_SCALE_HINT;
        delete process.env.VITE_SOLVER_SCALE_HINT;
        expect(isScaleHintEnabled()).toBe(false); // unset ⇒ OFF (safe default)
        process.env.VITE_SOLVER_SCALE_HINT = '1';
        expect(isScaleHintEnabled()).toBe(true);
        process.env.VITE_SOLVER_SCALE_HINT = 'true';
        expect(isScaleHintEnabled()).toBe(true);
        process.env.VITE_SOLVER_SCALE_HINT = '0';
        expect(isScaleHintEnabled()).toBe(false);
        process.env.VITE_SOLVER_SCALE_HINT = 'yes'; // any other value ⇒ OFF
        expect(isScaleHintEnabled()).toBe(false);
        if (prev === undefined) delete process.env.VITE_SOLVER_SCALE_HINT;
        else process.env.VITE_SOLVER_SCALE_HINT = prev;
    });

    it('classifies a NARROW prior fine-first and windows to low scale (coarse bands excluded)', () => {
        const h = resolveScaleHint(NARROW)!;
        expect(h).not.toBeNull();
        expect(h.fieldClass).toBe('narrow');
        expect(h.priorScaleArcsecPx).toBe(4.125);
        expect(h.scaleLoAsec).toBeCloseTo(4.125 / SCALE_HINT_MARGIN, 9);
        expect(h.scaleHiAsec).toBeCloseTo(4.125 * SCALE_HINT_MARGIN, 9);
        // the wide accepting bands (≥~28 ″/px) are OUTSIDE the window ⇒ excluded
        expect(h.scaleHiAsec).toBeLessThan(28);
    });

    it('classifies a WIDE prior coarse-first and windows to high scale (fine bands excluded)', () => {
        const h = resolveScaleHint(WIDE)!;
        expect(h).not.toBeNull();
        expect(h.fieldClass).toBe('wide');
        expect(h.scaleLoAsec).toBeCloseTo(63.35 / SCALE_HINT_MARGIN, 9);
        expect(h.scaleHiAsec).toBeCloseTo(63.35 * SCALE_HINT_MARGIN, 9);
        // the narrow accepting bands (≤~4 ″/px) are OUTSIDE the window ⇒ excluded
        expect(h.scaleLoAsec).toBeGreaterThan(4);
    });

    it('classification splits at the bimodal-gap threshold', () => {
        // just below the threshold → narrow; at/above → wide (consistent optics each).
        const belowFocal = (206.265 * 4.3) / (SCALE_HINT_CLASS_THRESHOLD_ARCSEC - 0.5);
        const below = resolveScaleHint({
            focalLengthMm: belowFocal, pixelPitchUm: 4.3,
            solveScaleArcsecPx: SCALE_HINT_CLASS_THRESHOLD_ARCSEC - 0.5, lensModel: 'X',
        })!;
        expect(below.fieldClass).toBe('narrow');
        const aboveFocal = (206.265 * 4.3) / (SCALE_HINT_CLASS_THRESHOLD_ARCSEC + 0.5);
        const above = resolveScaleHint({
            focalLengthMm: aboveFocal, pixelPitchUm: 4.3,
            solveScaleArcsecPx: SCALE_HINT_CLASS_THRESHOLD_ARCSEC + 0.5, lensModel: 'X',
        })!;
        expect(above.fieldClass).toBe('wide');
    });

    it('clamps the window into the solver blind-window bounds', () => {
        // ultrawide fisheye: hi would exceed MAX ⇒ clamped; and a very-narrow prior
        // whose lo would fall below MIN ⇒ clamped.
        const wide = resolveScaleHint({
            focalLengthMm: (206.265 * 6) / 280, pixelPitchUm: 6, solveScaleArcsecPx: 280, lensModel: 'Fisheye 8mm',
        })!;
        expect(wide.scaleHiAsec).toBe(SCALE_HINT_MAX_ARCSEC); // 280·4 > 300 → clamp
        const narrow = resolveScaleHint({
            focalLengthMm: 206.265, pixelPitchUm: 1, solveScaleArcsecPx: 1, lensModel: 'Scope',
        })!;
        expect(narrow.scaleLoAsec).toBe(SCALE_HINT_MIN_ARCSEC); // 1/4 < 0.5 → clamp
    });

    it('TRUST: rejects a placeholder / lying lens (the CR2 fake-50mm class)', () => {
        expect(resolveScaleHint({ ...WIDE, lensModel: 'Unknown Lens' })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, lensModel: 'Unknown' })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, lensModel: '' })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, lensModel: undefined })).toBeNull();
    });

    it('TRUST: requires focal, pitch and solve-scale (no optics ⇒ no hint)', () => {
        expect(resolveScaleHint({ ...WIDE, focalLengthMm: undefined })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, focalLengthMm: 0 })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, pixelPitchUm: undefined })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, solveScaleArcsecPx: undefined })).toBeNull();
        expect(resolveScaleHint({ ...WIDE, solveScaleArcsecPx: NaN })).toBeNull();
    });

    it('TRUST: rejects a scale inconsistent with the optics (the 2.0 ″/px blind fallback)', () => {
        // wide optics (implied ≈ 63 ″/px) but the buffer scale is the 2.0 fallback ⇒
        // ratio ≪ 0.5 ⇒ not optics-sourced ⇒ no hint (never window around a guess).
        expect(resolveScaleHint({ ...WIDE, solveScaleArcsecPx: 2.0 })).toBeNull();
    });

    it('TRUST: accepts a bin-multiple solve scale (science 2× / preview downscale)', () => {
        // native optics implied ≈ 63.35; a 2× science buffer scale = 126.7 (ratio 2) is
        // consistent and still WIDE.
        const h = resolveScaleHint({ ...WIDE, solveScaleArcsecPx: 63.35 * 2 })!;
        expect(h).not.toBeNull();
        expect(h.fieldClass).toBe('wide');
        expect(h.priorScaleArcsecPx).toBe(63.35 * 2);
    });

    it('resolveScaleHint is FLAG-INDEPENDENT (the caller applies the flag)', () => {
        const prev = process.env.VITE_SOLVER_SCALE_HINT;
        delete process.env.VITE_SOLVER_SCALE_HINT; // flag OFF
        expect(isScaleHintEnabled()).toBe(false);
        // the pure resolver still computes a hint — the seam gates it behind the flag.
        expect(resolveScaleHint(WIDE)).not.toBeNull();
        if (prev === undefined) delete process.env.VITE_SOLVER_SCALE_HINT;
        else process.env.VITE_SOLVER_SCALE_HINT = prev;
    });
});
