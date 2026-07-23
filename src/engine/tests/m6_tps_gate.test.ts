// Unit tests for the TPS OUT-OF-SAMPLE EMISSION GATE
// (src/engine/pipeline/m6_plate_solve/tps_fitter.ts fitTpsGatedCore). Pure —
// operates on TpsPair[] (u,v,dx,dy) directly, NO wasm/atlas/IO. Proves:
//   1. DETERMINISM — folds are a hash of quantized (u,v), never Math.random, so
//      two runs on the same input return bit-identical rms_oos + verdict.
//   2. M66 REFUSAL — the real SeeStar/M66 residual field (fixture reconstructed
//      from test_results/deep_cones/m66.receipt.json) is REFUSED: its interpolating
//      spline (in-sample ≈3", OOS ≈35") does not generalize, so tps === null and a
//      populated tps_gate verdict records why. This is the measured-broken case.
//   3. SYNTHETIC ADMIT — a field warped by a KNOWN smooth displacement generalizes
//      out-of-sample and is ADMITTED (tps emitted, reason ADMITTED).
//   4. COVERAGE — too few control points ⇒ refused with reason COVERAGE.
//   5. EVIDENCE — GCV λ is chosen from the grid; hull + physics ceiling recorded.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTpsGatedCore, type TpsPair } from '../pipeline/m6_plate_solve/tps_fitter';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The measured-broken M66/SeeStar residual field (real receipt reconstruction).
//    { pairs:[{u,v,dx,dy}], pixel_scale, crpix } — see tools/_probe/tps_probe.mts.
const M66 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'm66_tps_pairs.json'), 'utf8')) as {
    pairs: TpsPair[]; pixel_scale: number; crpix: [number, number];
};

// A smooth injected displacement field — the kind of low-order optical distortion a
// spline SHOULD reproduce and generalize (mirrors m6_tps_fitter.test.ts warp).
const R = 500;
const warpDx = (u: number, v: number) => 2.0 + 0.004 * u + 6 * (u * u + v * v) / (R * R);
const warpDy = (u: number, v: number) => -1.5 + 0.003 * v - 4 * (u * v) / (R * R);
function syntheticPairs(): TpsPair[] {
    const out: TpsPair[] = [];
    for (let i = 0; i <= 25; i++) {
        for (let j = 0; j <= 20; j++) {
            const u = -480 + (960 * i) / 25, v = -380 + (760 * j) / 20;
            out.push({ u, v, dx: warpDx(u, v), dy: warpDy(u, v) });
        }
    }
    return out;
}
const SYNTH_PXSCALE = 3.6776147325019153;
const SYNTH_CRPIX: [number, number] = [500, 400];

describe('M6 TPS emission gate — deterministic k-fold CV (no RNG)', () => {
    it('two runs on the same input return bit-identical OOS + verdict', () => {
        const a = fitTpsGatedCore(M66.pairs, M66.pixel_scale, M66.crpix);
        const b = fitTpsGatedCore(M66.pairs, M66.pixel_scale, M66.crpix);
        expect(a.gate.rms_oos_arcsec).toBe(b.gate.rms_oos_arcsec);     // IEEE-identical
        expect(a.gate.rms_insample_arcsec).toBe(b.gate.rms_insample_arcsec);
        expect(a.gate.lambda_selected).toBe(b.gate.lambda_selected);
        expect(a.gate.reason).toBe(b.gate.reason);
        expect(a.gate.admitted).toBe(b.gate.admitted);
        expect(a.gate.cv_folds).toBe(PIPELINE_CONSTANTS.SOLVER_TPS_CV_FOLDS);
    });
});

describe('M6 TPS emission gate — REFUSES the measured-broken M66 field', () => {
    const { tps, gate } = fitTpsGatedCore(M66.pairs, M66.pixel_scale, M66.crpix);

    it('refuses emission → tps is null (honest-absent, not a laundered 3")', () => {
        expect(tps).toBeNull();
        expect(gate.admitted).toBe(false);
    });

    it('the out-of-sample rms is far worse than the laundered in-sample rms', () => {
        // The receipt claimed rms_after ≈ 3.15"; the CV shows it does NOT generalize.
        expect(gate.rms_insample_arcsec!).toBeLessThan(21);      // heavily-smoothed in-sample
        expect(gate.rms_oos_arcsec!).toBeGreaterThan(25);        // measured OOS ~28"
        // The spline is WORSE out-of-sample than doing nothing (the depth-study finding).
        expect(gate.rms_oos_arcsec!).toBeGreaterThanOrEqual(gate.rms_linear_arcsec!);
        expect(gate.reason).toBe('OOS_WORSE_THAN_LINEAR');
    });

    it('records full honest evidence (GCV grid, hull, physics ceiling)', () => {
        const grid = PIPELINE_CONSTANTS.SOLVER_TPS_LAMBDA_GRID;
        expect(gate.lambda_grid.length).toBe(grid.length);
        expect(grid).toContain(gate.lambda_selected);            // chosen from the grid
        expect(gate.hull_radius_px).toBeGreaterThan(0);          // extrapolation limit recorded
        expect(gate.physics_ceiling_arcsec).toBeGreaterThan(0);
        expect(gate.field_span_deg).toBeGreaterThan(0);
        expect(gate.effective_dof).toBeGreaterThan(0);
        expect(gate.out_of_hull_fraction).toBeGreaterThanOrEqual(0);
    });
});

describe('M6 TPS emission gate — ADMITS a well-conditioned smooth field', () => {
    const { tps, gate } = fitTpsGatedCore(syntheticPairs(), SYNTH_PXSCALE, SYNTH_CRPIX);

    it('a spline that generalizes out-of-sample is emitted', () => {
        expect(gate.reason).toBe('ADMITTED');
        expect(gate.admitted).toBe(true);
        expect(tps).toBeTruthy();
        expect(tps!.control_count).toBeGreaterThanOrEqual(25); // ≥ MIN_CONTROL after prune
    });

    it('out-of-sample rms is small and within the admit threshold', () => {
        expect(gate.rms_oos_arcsec!).toBeLessThanOrEqual(gate.oos_threshold_arcsec!);
        expect(gate.rms_oos_arcsec!).toBeLessThan(gate.rms_linear_arcsec!); // beats no-correction
        // The emitted model records the (GCV-selected) λ used.
        expect(tps!.lambda).toBe(gate.lambda_selected);
        expect(tps!.scale).toBe(gate.hull_radius_px);
    });
});

describe('M6 TPS emission gate — coverage refusal (honest-absent)', () => {
    it('too few control points ⇒ reason COVERAGE, tps null', () => {
        const few: TpsPair[] = Array.from({ length: 10 }, (_, i) => ({ u: i * 30, v: i * 20, dx: 1, dy: 1 }));
        const { tps, gate } = fitTpsGatedCore(few, SYNTH_PXSCALE, SYNTH_CRPIX);
        expect(tps).toBeNull();
        expect(gate.reason).toBe('COVERAGE');
        expect(gate.admitted).toBe(false);
    });
});
