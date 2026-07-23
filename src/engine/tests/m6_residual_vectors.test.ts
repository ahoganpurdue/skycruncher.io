/**
 * SCHEMA A (ATMOSPHERE_SEXTANT_SPEC inc 3) — per-star 2D residual vectors.
 *
 * Guards that buildReceipt surfaces the real 2D residual vector each matched
 * star carries (MatchedStar.residual, populated at verify time) as pixel-space
 * dx_px/dy_px PLUS the tangent-plane sky residual dRA_arcsec/dDec_arcsec derived
 * through the FITTED CD — parity carried by the CD signs, never asserted. Also
 * pins honest-absence (no vector → null fields) and the UW-path magnitude
 * invariant (hypot(dx,dy)·scale == residual_arcsec). The solver-side invariant on
 * REAL data lives in the CR2 (UW) + SeeStar (WASM) api-smoke specs.
 */
import { describe, it, expect } from 'vitest';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import type { MatchedStar, PlateSolution } from '../types/Main_types';

const SCALE = 3.6776147325019153;            // "/px
const S_DEG = SCALE / 3600;                  // deg/px

/** Minimal ReceiptInputs wrapper around a solution (all other slots null/empty). */
function receiptFor(solution: PlateSolution): any {
    const i: ReceiptInputs = {
        metadata: null,
        signal: null,
        solution,
        planets: [],
        hardware: null,
        forensics: null,
        scales: null,
        warnings: [],
        timestampTrusted: false,
        spcc: undefined,
        imageWidth: 1000,
        imageHeight: 1000,
    };
    return buildReceipt(i);
}

function solutionWith(
    matched: MatchedStar[],
    cd: [[number, number], [number, number]],
    extra: Partial<PlateSolution> = {},
): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20,
        pixel_scale: SCALE, rotation: 0, fov_width_deg: 1, fov_height_deg: 1,
        parity: 1, spatial_hash: 'x', confidence: 0.9,
        num_stars: matched.length, matched_stars: matched,
        wcs: { crpix: [500, 500], crval: [10, 20], cd },
        ...extra,
    } as PlateSolution;
}

function matchedStar(dx: number, dy: number, residualArcsec: number): MatchedStar {
    return {
        detected: { x: 600, y: 400, flux: 1000, fwhm: 2.5 } as any,
        catalog: { ra: 150, dec: 20, mag: 9, bv: 0.6, ra_hours: 10, dec_degrees: 20, gaia_id: 'Gaia_1' } as any,
        residual: { dx, dy },
        residual_arcsec: residualArcsec,
    };
}

describe('SCHEMA A — per-star residual vectors in the receipt', () => {
    it('emits dx_px/dy_px verbatim from the matched star vector', () => {
        const sol = solutionWith([matchedStar(3, -4, 5 * SCALE)], [[-S_DEG, 0], [0, S_DEG]]);
        const r = receiptFor(sol);
        const m = r.solution.matched_stars[0];
        expect(m.dx_px).toBe(3);
        expect(m.dy_px).toBe(-4);
    });

    it('UW-path magnitude invariant: hypot(dx,dy)·pixel_scale === residual_arcsec (1e-9)', () => {
        // The UW verify sets residual_arcsec = hypot(dx,dy)·safeScale by construction.
        const sol = solutionWith([matchedStar(3, -4, 5 * SCALE)], [[-S_DEG, 0], [0, S_DEG]]);
        const r = receiptFor(sol);
        const m = r.solution.matched_stars[0];
        const mag = Math.hypot(m.dx_px, m.dy_px) * r.solution.pixel_scale;
        expect(Math.abs(mag - m.residual_arcsec)).toBeLessThan(1e-9);
    });

    it('derives dRA/dDec through the CD (magnitude ≈ residual for a scaled-rotation CD)', () => {
        const sol = solutionWith([matchedStar(3, -4, 5 * SCALE)], [[-S_DEG, 0], [0, S_DEG]]);
        const r = receiptFor(sol);
        const m = r.solution.matched_stars[0];
        // CD is a pure scale here → |CD·v|·3600 == |v|·scale == residual_arcsec.
        const skyMag = Math.hypot(m.dRA_arcsec, m.dDec_arcsec);
        expect(Math.abs(skyMag - m.residual_arcsec)).toBeLessThan(1e-9);
        // dRA = cd[0][0]·dx·3600 = (-S_DEG)(+3)·3600 < 0.
        expect(m.dRA_arcsec).toBeLessThan(0);
        // dDec = cd[1][1]·dy·3600 = (+S_DEG)(-4)·3600 < 0.
        expect(m.dDec_arcsec).toBeLessThan(0);
    });

    it('parity: flipping the CD RA sign flips the derived dRA sky direction', () => {
        const vec: [number, number] = [3, -4];
        const normalCd: [[number, number], [number, number]] = [[-S_DEG, 0], [0, S_DEG]];
        const mirroredCd: [[number, number], [number, number]] = [[S_DEG, 0], [0, S_DEG]];
        const a = receiptFor(solutionWith([matchedStar(vec[0], vec[1], 5 * SCALE)], normalCd)).solution.matched_stars[0];
        const b = receiptFor(solutionWith([matchedStar(vec[0], vec[1], 5 * SCALE)], mirroredCd)).solution.matched_stars[0];
        // Same pixel residual, opposite RA parity → opposite dRA sign, same |dRA|.
        expect(Math.sign(a.dRA_arcsec)).toBe(-Math.sign(b.dRA_arcsec));
        expect(a.dRA_arcsec).toBeCloseTo(-b.dRA_arcsec, 12);
        // Dec axis unchanged by the RA-parity flip.
        expect(a.dDec_arcsec).toBeCloseTo(b.dDec_arcsec, 12);
    });

    it('honest-absent: a matched star with no residual vector emits null fields', () => {
        const bare: MatchedStar = {
            detected: { x: 100, y: 100, flux: 500, fwhm: 3 } as any,
            catalog: { ra: 150, dec: 20, mag: 10, ra_hours: 10, dec_degrees: 20, gaia_id: 'Gaia_2' } as any,
            residual_arcsec: 1.2,
        };
        const r = receiptFor(solutionWith([bare], [[-S_DEG, 0], [0, S_DEG]]));
        const m = r.solution.matched_stars[0];
        expect(m.dx_px).toBeNull();
        expect(m.dy_px).toBeNull();
        expect(m.dRA_arcsec).toBeNull();
        expect(m.dDec_arcsec).toBeNull();
        expect(m.residual_arcsec).toBe(1.2); // scalar untouched
    });

    it('dRA/dDec null when the solution has no fitted CD (honest-absent)', () => {
        const sol = solutionWith([matchedStar(3, -4, 5 * SCALE)], [[-S_DEG, 0], [0, S_DEG]]);
        (sol as any).wcs = undefined; // no fitted matrix
        const r = receiptFor(sol);
        const m = r.solution.matched_stars[0];
        expect(m.dx_px).toBe(3);       // pixel vector still present
        expect(m.dRA_arcsec).toBeNull(); // sky derivation needs the CD
        expect(m.dDec_arcsec).toBeNull();
    });

    it('rig_correction_applied mirrors bc_rematch.applied', () => {
        const applied = solutionWith([matchedStar(1, 1, 1)], [[-S_DEG, 0], [0, S_DEG]], {
            bc_rematch: { applied: true, guard: 'APPLIED' } as any,
        });
        const kept = solutionWith([matchedStar(1, 1, 1)], [[-S_DEG, 0], [0, S_DEG]]);
        expect(receiptFor(applied).solution.rig_correction_applied).toBe(true);
        expect(receiptFor(kept).solution.rig_correction_applied).toBe(false);
    });

    it('residual-vector fields are plain numbers that survive the save_packet replacer', () => {
        const sol = solutionWith([matchedStar(3, -4, 5 * SCALE)], [[-S_DEG, 0], [0, S_DEG]]);
        const json = serializeReceipt(receiptFor(sol));
        const round = JSON.parse(json);
        const m = round.solution.matched_stars[0];
        expect(typeof m.dx_px).toBe('number');
        expect(m.dx_px).toBe(3);
        expect(typeof m.dRA_arcsec).toBe('number');
    });
});
