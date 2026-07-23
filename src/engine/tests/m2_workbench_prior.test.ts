// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL WORKBENCH — RUNG-3 READ-BACK: pooled solve prior (SOLVER_WORKBENCH_PRIOR)
// ═══════════════════════════════════════════════════════════════════════════
// Covers the pure read-seam `poolWorkbenchPrior`: the conservative sign+magnitude
// agreement gate, latest-epoch-only pooling, median k1/k2, and the end-to-end
// unit-level demonstration that ≥3 agreeing same-rig deposits produce a
// WORKBENCH_POOLED LensDistortionResolution that flows through buildSolveContext
// (the exact seam the session injects on the SolveContext). Default OFF in prod;
// this proves the machinery engages when a rig qualifies.

import { describe, it, expect } from 'vitest';
import {
    poolWorkbenchPrior,
    WORKBENCH_PRIOR_MIN_DEPOSITS,
    WORKBENCH_PRIOR_MAX_REL_DISPERSION,
    type ObservationDeposit,
} from '@/engine/pipeline/m2_hardware/workbench_store';
import { buildSolveContext } from '@/engine/pipeline/stages/solve_context';
import type { LensDistortionResolution } from '@/engine/pipeline/m2_hardware/lens_distortion';

/** Minimal measured-BC deposit for the pooling gate (k1 required, k2 optional). */
function mkDeposit(k1: number, opts: { k2?: number | null; epoch?: number; measured?: boolean } = {}): ObservationDeposit {
    return {
        schema: '1.0.0', rig_key: 'BODY|LENS', key_quality: 'MODEL_ONLY',
        body: 'BODY', lens: 'LENS', body_serial: null, epoch: opts.epoch ?? 0,
        captured_at: null, timestamp_trusted: true, deposited_at: 'now',
        receipt_hash: `r53_${k1}_${opts.epoch ?? 0}`,
        aperture: null, focal_length_mm: null, pixel_scale_arcsec: null, stars_matched: null,
        bc: {
            measured: opts.measured ?? true,
            k1: (opts.measured === false) ? null : k1,
            k2: opts.k2 === undefined ? null : opts.k2,
            k1_sigma: 1e-3, k2_sigma: null, n_pairs: 100, n_used: 100, r_max_sampled: 0.9,
            octant_counts: [1, 1, 1, 1, 1, 1, 1, 1], coverage_refused: null,
            mustache_verdict: null, not_measured: null,
        },
        sip: { present: false, a_order: null, b_order: null, rms_arcsec: null },
        tps: { present: false, control_count: null, rms_after_arcsec: null },
        psf: { measured: false, fwhm_median_maj_px: null, fwhm_median_min_px: null, ellipticity_median: null, n_fit: null, method: null },
        zero_point: null, zero_point_rmse: null,
        bc_rematch: { present: false, guard: null, applied: null, matched_before: null, matched_after: null, edge_before: null, edge_after: null },
    };
}

describe('poolWorkbenchPrior — conservative rung-3 agreement gate', () => {
    it('returns null below the minimum deposit count', () => {
        expect(WORKBENCH_PRIOR_MIN_DEPOSITS).toBe(3);
        expect(poolWorkbenchPrior([])).toBeNull();
        expect(poolWorkbenchPrior([mkDeposit(-0.12), mkDeposit(-0.11)])).toBeNull();
    });

    it('pools the MEDIAN k1 across ≥3 agreeing deposits (unanimous sign, tight magnitude)', () => {
        const pooled = poolWorkbenchPrior([mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(-0.13)]);
        expect(pooled).not.toBeNull();
        expect(pooled!.k1).toBeCloseTo(-0.12, 6); // median of {-0.13,-0.12,-0.11}
        expect(pooled!.n).toBe(3);
        expect(pooled!.epoch).toBe(0);
        expect(pooled!.k1_rel_dispersion).toBeLessThanOrEqual(WORKBENCH_PRIOR_MAX_REL_DISPERSION);
        expect(pooled!.receipt_hashes).toHaveLength(3);
    });

    it('VETOES on a single opposite-sign fit (barrel vs pincushion is not agreement)', () => {
        // two barrel (−) + one pincushion (+) → not unanimous → null even though N≥3.
        expect(poolWorkbenchPrior([mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(0.12)])).toBeNull();
    });

    it('VETOES when magnitude dispersion exceeds the conservative bound', () => {
        // unanimous sign but wildly scattered magnitudes (σ/|median| > 0.5).
        expect(poolWorkbenchPrior([mkDeposit(-0.02), mkDeposit(-0.12), mkDeposit(-0.30)])).toBeNull();
    });

    it('pools ONLY the latest epoch (drift-forked epochs are never mixed)', () => {
        const deposits = [
            // older epoch 0: 3 agreeing — but superseded
            mkDeposit(-0.12, { epoch: 0 }), mkDeposit(-0.11, { epoch: 0 }), mkDeposit(-0.13, { epoch: 0 }),
            // latest epoch 1: only 2 → below the floor → null overall
            mkDeposit(0.05, { epoch: 1 }), mkDeposit(0.06, { epoch: 1 }),
        ];
        expect(poolWorkbenchPrior(deposits)).toBeNull();
    });

    it('pools MEDIAN k2 only over the k2-fitted subset (radial k1-only otherwise)', () => {
        const noK2 = poolWorkbenchPrior([mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(-0.13)]);
        expect(noK2!.k2_fitted).toBe(false);
        expect(noK2!.k2).toBe(0);

        const withK2 = poolWorkbenchPrior([
            mkDeposit(-0.12, { k2: 0.04 }), mkDeposit(-0.11, { k2: 0.05 }), mkDeposit(-0.13, { k2: 0.06 }),
        ]);
        expect(withK2!.k2_fitted).toBe(true);
        expect(withK2!.k2).toBeCloseTo(0.05, 6); // median of {0.04,0.05,0.06}
    });

    it('ignores unmeasured-BC deposits when counting agreement', () => {
        expect(poolWorkbenchPrior([
            mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(0, { measured: false }),
        ])).toBeNull(); // only 2 measured → below floor
    });
});

describe('WORKBENCH_POOLED prior flows through the SolveContext seam (rung-3 engagement)', () => {
    it('a qualifying rig produces a WORKBENCH_POOLED resolution that buildSolveContext carries', () => {
        const pooled = poolWorkbenchPrior([mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(-0.13)]);
        expect(pooled).not.toBeNull();

        // Session constructs the resolution exactly as maybeBuildWorkbenchPrior does.
        const resolution: LensDistortionResolution = {
            k1: pooled!.k1, k2: pooled!.k2,
            coeffs: { k1: pooled!.k1, k2: pooled!.k2, k3: 0, p1: 0, p2: 0 },
            provenance: 'WORKBENCH_POOLED',
            lensKey: 'WORKBENCH_POOLED',
            lensModel: 'ROKINON 14mm', focalLength: 14,
        };

        const ctx = buildSolveContext({ basePixelScale: 60, lensDistortionResolution: resolution });
        expect(ctx.lensDistortionResolution).toBeTruthy();
        expect(ctx.lensDistortionResolution!.provenance).toBe('WORKBENCH_POOLED');
        expect(ctx.lensDistortionResolution!.k1).toBeCloseTo(-0.12, 6);
    });

    it('absent injection ⇒ context carries no resolution (byte-identical to resolver-only)', () => {
        const ctx = buildSolveContext({ basePixelScale: 60 });
        expect(ctx.lensDistortionResolution).toBeUndefined();
    });
});
