// ═══════════════════════════════════════════════════════════════════════════
// SOLVE_FAILURE_DIAGNOSTICS (default OFF) — every refusal a learning artifact
// ═══════════════════════════════════════════════════════════════════════════
// Covers the pure builder `buildFailureDiagnosticsBlock` + its emission in the
// NO-SOLVE failure receipt:
//   1. best_sweep_sigma extraction — top sub-threshold anchored-sweep σ + center
//      from the RETAINED per-candidate forensics (pure, no new instrumentation).
//   2. near_miss MEASURED bc — a verified-but-dropped candidate carries REAL
//      matched pairs, so bc_measure recovers the KNOWN synthetic distortion.
//   3. honest-absent — null when nothing near-missed; null solveDiagnostics ⇒ null.
//   4. buildFailureReceipt emits failure_diagnostics (or null when the flag is OFF).

import { describe, it, expect } from 'vitest';
import {
    buildFailureDiagnosticsBlock,
    buildFailureReceipt,
    type FailureReceiptInputs,
} from '@/engine/pipeline/stages/package';
import type { SolveDiagnostics } from '@/engine/types/Main_types';
import { SkyTransform } from '@/engine/core/SkyTransform';
import { makeBrownConradyDistortion } from '@/engine/pipeline/m2_hardware/lens_distortion';

// ─── synthetic near-miss solution (WCS-consistent, KNOWN distortion) ──────────
const W = 1200, H = 900;
const CRPIX: [number, number] = [(W - 1) / 2, (H - 1) / 2];
const CRVAL: [number, number] = [6.0, 20.0]; // ra hours, dec deg
const S = 0.004;                              // deg/px
const CD: [[number, number], [number, number]] = [[-S, 0], [0, S]];
const WCS = { crpix: CRPIX, crval: CRVAL, cd: CD };

/** Replicates lens_distortion_refit.projectUndistorted (sky → pixel via CD inverse). */
function skyToPixel(raH: number, decD: number): { x: number; y: number } {
    const cdDet = CD[0][0] * CD[1][1] - CD[0][1] * CD[1][0];
    const inv = [
        [CD[1][1] / cdDet, -CD[0][1] / cdDet],
        [-CD[1][0] / cdDet, CD[0][0] / cdDet],
    ];
    const { xi, eta } = SkyTransform.gnomonicProject(raH, decD, CRVAL[0], CRVAL[1]);
    return { x: CRPIX[0] + inv[0][0] * xi + inv[0][1] * eta, y: CRPIX[1] + inv[1][0] * xi + inv[1][1] * eta };
}

/** A dropped-but-verified near-miss whose detected positions are the WCS
 *  projection warped by a KNOWN Brown-Conrady (k1,k2) — so bc_measure recovers it. */
function makeNearMissSolution(k1: number, k2: number): any {
    const warp = makeBrownConradyDistortion(k1, k2, W, H);
    const out: [number, number] = [0, 0];
    const cosd = Math.cos((CRVAL[1] * Math.PI) / 180);
    const matched: any[] = [];
    for (let i = -6; i <= 6; i++) {
        for (let j = -5; j <= 5; j++) {
            const raH = CRVAL[0] + (i * 0.4) / cosd / 15;
            const decD = CRVAL[1] + j * 0.4;
            const pred = skyToPixel(raH, decD);
            if (pred.x < 40 || pred.x > W - 40 || pred.y < 40 || pred.y > H - 40) continue;
            warp.toNative(pred.x, pred.y, out);
            matched.push({
                catalog: { gaia_id: `g${i}_${j}`, ra_hours: raH, dec_degrees: decD, ra: raH * 15, dec: decD, mag: 10, band: 'GaiaG' },
                detected: { x: out[0], y: out[1], fwhm: 2.2, flux: 500 },
                residual_arcsec: 0.5,
            });
        }
    }
    return { ra_hours: CRVAL[0], dec_degrees: CRVAL[1], pixel_scale: S * 3600, confidence: 0.2, matched_stars: matched, wcs: WCS };
}

function diag(over: Partial<SolveDiagnostics> = {}): SolveDiagnostics {
    return {
        solve_time_ms: 1000, quads_detected: 0, quads_catalog: 0, matches_found: 0,
        verified_clusters: 0, peak_background_ratio: 0, rejection_reasons: [],
        ...over,
    } as SolveDiagnostics;
}

describe('buildFailureDiagnosticsBlock — the closest a refused solve came', () => {
    it('returns null for null diagnostics and for an empty/near-miss-free run', () => {
        expect(buildFailureDiagnosticsBlock(null, W, H)).toBeNull();
        expect(buildFailureDiagnosticsBlock(diag(), W, H)).toBeNull();
    });

    it('extracts the MAX sub-threshold sweep σ + its center from the retained forensics', () => {
        const d = diag({
            forensics: [
                { status: 'UW_SWEEP_PEAK', uw_peak: { z: 3.2, ra0: 5.9, dec0: 19.5 } },
                { status: 'UW_SWEEP_PEAK', uw_peak: { z: 4.1, ra0: 6.1, dec0: 20.2 } },
                { status: 'UW_ESCALATION', uw_escalation: { sweepZ: 3.8, ra0: 6.05, dec0: 20.0 } },
            ],
        });
        const block = buildFailureDiagnosticsBlock(d, W, H)!;
        expect(block).not.toBeNull();
        expect(block.best_sweep_sigma).toBeCloseTo(4.1, 6);
        expect(block.best_sweep_source).toBe('UW_SWEEP_PEAK');
        expect(block.best_sweep_center).toEqual({ ra_hours: 6.1, dec_deg: 20.2 });
        expect(block.near_miss).toBeNull(); // no verified-but-dropped candidate
    });

    it('runs a MEASURED bc_measure on a verified-but-dropped near-miss and recovers k1/k2', () => {
        const K1 = -0.12, K2 = 0.05;
        const d = diag({
            best_near_miss: { confidence: 0.2, matched: 60, solution: makeNearMissSolution(K1, K2) },
        });
        const block = buildFailureDiagnosticsBlock(d, W, H)!;
        expect(block.near_miss).not.toBeNull();
        expect(block.near_miss.confidence).toBe(0.2);
        expect(block.near_miss.matched).toBe(60);
        // WCS summarized (never the full solution embedded)
        expect(block.near_miss.wcs_summary).toMatchObject({ ra_hours: CRVAL[0], dec_deg: CRVAL[1] });
        // Real MEASURED distortion recovered from the near-miss's own matched pairs.
        expect(block.near_miss.bc_measured).not.toBeNull();
        expect(block.near_miss.bc_measured.provenance).toBe('MEASURED');
        expect(block.near_miss.bc_measured.k1).toBeCloseTo(K1, 2);
        expect(block.near_miss.bc_not_measured).toBeNull();
    });

    it('is honest-absent (bc_not_measured string) when the near-miss has no fittable pairs', () => {
        const thin: any = { ra_hours: 6, dec_degrees: 20, wcs: WCS, matched_stars: [] };
        const d = diag({ best_near_miss: { confidence: 0.2, matched: 0, solution: thin } });
        const block = buildFailureDiagnosticsBlock(d, W, H)!;
        expect(block.near_miss).not.toBeNull();
        expect(block.near_miss.bc_measured).toBeNull();
        expect(typeof block.near_miss.bc_not_measured).toBe('string');
    });
});

// ─── minimal FailureReceiptInputs ─────────────────────────────────────────────
function inputs(over: Partial<FailureReceiptInputs> = {}): FailureReceiptInputs {
    return {
        metadata: null, signal: null, solveDiagnostics: null, stageTimings: null,
        stageReached: 'solve', stageOfDeath: 'solve', failReason: 'no lock',
        frameSha256: null, sourceFormat: 'CR2', warnings: [], timestampTrusted: false,
        decoderArm: null, imageWidth: W, imageHeight: H, ...over,
    };
}

describe('buildFailureReceipt — emits failure_diagnostics additively', () => {
    it('carries the block when supplied, and stays a no_solve record', () => {
        const block = { best_sweep_sigma: 4.1, near_miss: null, note: 'x', best_sweep_source: 'UW_SWEEP_PEAK', best_sweep_center: null };
        const r = buildFailureReceipt(inputs({ failureDiagnostics: block }));
        expect(r.kind).toBe('no_solve');
        expect(r.solution).toBeNull();
        expect(r.failure_diagnostics).toEqual(block);
    });

    it('is null when the flag is OFF (no block supplied) — byte-identical no-solve receipt', () => {
        const r = buildFailureReceipt(inputs());
        expect(r.failure_diagnostics).toBeNull();
    });
});
