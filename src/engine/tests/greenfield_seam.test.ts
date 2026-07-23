import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
    mapGreenfieldSolution,
    buildGreenfieldDiagnostics,
    isGreenfieldSolverEnabled,
    type GreenfieldResponse,
    type GfSolvedResult,
    type GfReceipt,
    type GfHydratedMatch,
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
