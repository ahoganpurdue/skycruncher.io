import { describe, it, expect } from 'vitest';
import { evaluateDetectionDensity } from '../pipeline/m4_signal_detect/detection_guard';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

/**
 * M4 detection fast-fail guard — calibration lock.
 *
 * The guard must NEVER trip on the richest verified real field, and MUST trip on
 * a pathological one. These numbers are the measured Carina 60Da evidence
 * (extract_blobs count>=2): 43,197 deep candidates over a 2596x1731 (4.49 MP)
 * binned frame = 9,613/MP; 14,194 vanguard. This test locks that a future edit
 * cannot silently lower the threshold below the real frame.
 */

// Carina binned detection dimensions (5192x3463 native -> floor(/2)).
const CAR_W = 2596, CAR_H = 1731;
const CAR_DEEP = 43197, CAR_VAN = 14194;

describe('M4 fast-fail density guard', () => {
    it('does NOT trip on real Carina 60Da (below the absolute floor AND the density)', () => {
        const r = evaluateDetectionDensity(CAR_DEEP, CAR_VAN, CAR_W, CAR_H);
        expect(r).toBeNull();
    });

    it('does NOT trip even on the no-min-area Carina upper bound (density floor protects it)', () => {
        // With extract_blobs min-area=1 the CC count is 83,475 (18,576/MP) — above
        // the 50k absolute floor, but still well under the density threshold.
        const r = evaluateDetectionDensity(83475, 31039, CAR_W, CAR_H);
        expect(r).toBeNull();
    });

    it('TRIPS on a pathological dense frame (~4.5x Carina density) with a structured diagnostic', () => {
        const r = evaluateDetectionDensity(200000, 90000, CAR_W, CAR_H);
        expect(r).not.toBeNull();
        expect(r!.reason).toBe('DETECTION_DENSITY_FAST_FAIL');
        expect(r!.deepCandidates).toBe(200000);
        expect(r!.vanguardCandidates).toBe(90000);
        expect(r!.deepDensityPerMP).toBeGreaterThanOrEqual(PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP);
        expect(r!.detectionDims).toBe(`${CAR_W}x${CAR_H}`);
        expect(r!.estDedupOps).toBe(200000 * 90000);
    });

    it('the absolute floor protects a SMALL high-density frame (below the count floor)', () => {
        // 45k deep over 0.5 MP = 90,000/MP (very high density) but 45k < 50k floor.
        const r = evaluateDetectionDensity(45000, 20000, 1000, 500);
        expect(r).toBeNull();
    });

    it('calibration invariant: threshold stays safely above the measured Carina density', () => {
        const carinaDensity = CAR_DEEP / ((CAR_W * CAR_H) / 1e6); // ~9,613/MP
        // At least ~3x headroom over the richest verified real field.
        expect(PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP).toBeGreaterThan(carinaDensity * 3);
        // And the absolute floor sits above Carina's real deep-candidate count.
        expect(PIPELINE_CONSTANTS.DETECT_MIN_CANDIDATES_FOR_GUARD).toBeGreaterThan(CAR_DEEP);
    });
});
