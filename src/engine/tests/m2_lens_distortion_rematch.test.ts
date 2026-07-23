// Unit tests for the SECONDARY BC-informed re-match rung — edge-star recovery
// (src/engine/pipeline/m2_hardware/lens_distortion_rematch.ts).
//
// MECHANISM PROOF (synthetic, deterministic): a field warped by a KNOWN
// Brown-Conrady is detected at its DISTORTED positions. A native-space
// (undistorted-prediction) match — the center-only baseline — recovers the
// centre but MISSES the edge stars (their true positions are displaced tens-to-
// hundreds of px by the lens). Distorting the predictions with the CORRECT
// measured BC recovers those edge stars at their real positions; the WRONG-sign
// BC does NOT (the false-match guard). The real-CR2 densification is the A/B.

import { describe, it, expect } from 'vitest';
import { measureEdgeRecovery, type DetPoint, type PredPoint } from '../pipeline/m2_hardware/lens_distortion_rematch';
import { makeBrownConradyDistortion } from '../pipeline/m2_hardware/lens_distortion';

const W = 5202;
const H = 3465;
const CX = (W - 1) / 2;
const CY = (H - 1) / 2;
const HD = Math.hypot(CX, CY);

// Deterministic tiny jitter so recovered residuals are small-but-nonzero.
function jitter(seed: number): number {
    const s = Math.sin(seed * 12.9898) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * 1.0; // ±0.5 px
}

describe('measureEdgeRecovery — BC recovers edge stars the baseline misses', () => {
    it('recovers edge stars under the correct BC; wrong-sign BC does not (guard passes)', () => {
        const K1 = -0.12, K2 = 0.05;
        const warp = makeBrownConradyDistortion(K1, K2, W, H);
        const out: [number, number] = [0, 0];

        const predUndistorted: PredPoint[] = [];
        const detected: DetPoint[] = [];
        let n = 0;
        for (let uy = 100; uy < H - 100; uy += 150) {
            for (let ux = 100; ux < W - 100; ux += 190) {
                predUndistorted.push({ x: ux, y: uy });   // catalog (undistorted)
                warp.toNative(ux, uy, out);                // detected (native/distorted)
                detected.push({ x: out[0] + jitter(n * 2), y: out[1] + jitter(n * 2 + 1) });
                n++;
            }
        }
        expect(predUndistorted.length).toBeGreaterThan(200);

        const tolPx = 20; // matches centre within tol; edge warp (≫100px) exceeds it
        const r = measureEdgeRecovery(detected, predUndistorted, K1, K2, W, H, tolPx, 0.6);

        // Baseline is center-biased: it misses most edge stars.
        expect(r.baseline.edge_matched).toBeLessThan(r.bc.edge_matched);
        // BC recovers a substantial number of edge stars...
        expect(r.edge_recovered).toBeGreaterThan(20);
        // ...at their correct positions (tight residual, well under the tol net).
        expect(r.residual_rms_recovered_px).toBeLessThan(2);
        // False-match guard: the wrong-sign BC recovers far fewer edge stars.
        expect(r.false_guard.wrong_bc_edge_matched).toBeLessThan(r.bc.edge_matched);
        expect(r.false_guard.passes).toBe(true);
    });

    it('an undistorted (identity) field recovers ~nothing extra — no phantom densification', () => {
        // No lens: detected == undistorted. Baseline already matches everything;
        // applying a (measured-as-~zero) BC must not invent edge matches.
        const predUndistorted: PredPoint[] = [];
        const detected: DetPoint[] = [];
        let n = 0;
        for (let uy = 100; uy < H - 100; uy += 150) {
            for (let ux = 100; ux < W - 100; ux += 190) {
                predUndistorted.push({ x: ux, y: uy });
                detected.push({ x: ux + jitter(n * 2), y: uy + jitter(n * 2 + 1) });
                n++;
            }
        }
        const r = measureEdgeRecovery(detected, predUndistorted, 0, 0, W, H, 20, 0.6);
        expect(r.baseline.edge_matched).toBe(r.bc.edge_matched); // BC(0,0) == identity
        expect(r.edge_recovered).toBe(0);
        expect(r.false_guard.passes).toBe(false); // nothing to recover → guard not asserted
    });
});
