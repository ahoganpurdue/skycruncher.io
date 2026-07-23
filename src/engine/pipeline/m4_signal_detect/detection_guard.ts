/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DETECTION FAST-FAIL GUARD (dense / non-converging frame)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL. Pure predicate — no buffers, no WASM, deterministic.
 *
 * The star-detection back half is O(deep x vanguard) (the dedup existence scan)
 * plus fwhm^2-scaled per-star window measurements. On a pathological frame (pure
 * noise, a mis-binned mosaic, an unsupported sensor) the candidate count explodes
 * and those passes grind for MINUTES — the ~470 s Carina-class SILENT hang. This
 * guard runs the instant both candidate counts are known (before any of that
 * work) and converts a silent timeout into a LOUD + FAST structured diagnostic.
 *
 * Calibration lives in PIPELINE_CONSTANTS.DETECT_* and is anchored to the real
 * Carina 60Da frame (extract_blobs count>=2): 43,197 deep candidates = 9,613/MP
 * over 4.49 MP. The trigger requires BOTH a pathological density AND an absolute
 * floor, so Carina (and any smaller frame) is double-protected.
 */

import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';

export interface DetectionFastFailDiagnostic {
    reason: 'DETECTION_DENSITY_FAST_FAIL';
    message: string;
    deepCandidates: number;
    vanguardCandidates: number;
    deepDensityPerMP: number;
    thresholdPerMP: number;
    detectionDims: string;
    megapixels: number;
    /** Estimated cost of the O(deep x vanguard) dedup pass that would follow. */
    estDedupOps: number;
}

const FAST_FAIL_MESSAGE =
    'Candidate density is pathological — the frame is not a resolvable star field ' +
    '(pure noise, a mis-binned mosaic, or an unsupported sensor). Detection bailed ' +
    'before the O(n^2) dedup/measurement passes to avoid a multi-minute silent hang.';

/**
 * Returns a structured diagnostic when detection should bail LOUD + FAST, else
 * null. Trips only when deep-candidate count exceeds the absolute floor AND the
 * per-megapixel density exceeds the pathological threshold.
 */
export function evaluateDetectionDensity(
    deepCount: number,
    vanguardCount: number,
    width: number,
    height: number
): DetectionFastFailDiagnostic | null {
    const megapixels = (width * height) / 1e6;
    const deepDensity = megapixels > 0 ? deepCount / megapixels : 0;
    if (
        deepCount < PIPELINE_CONSTANTS.DETECT_MIN_CANDIDATES_FOR_GUARD ||
        deepDensity < PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP
    ) {
        return null;
    }
    return {
        reason: 'DETECTION_DENSITY_FAST_FAIL',
        message: FAST_FAIL_MESSAGE,
        deepCandidates: deepCount,
        vanguardCandidates: vanguardCount,
        deepDensityPerMP: Math.round(deepDensity),
        thresholdPerMP: PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP,
        detectionDims: `${width}x${height}`,
        megapixels: +megapixels.toFixed(2),
        estDedupOps: vanguardCount * deepCount,
    };
}

/**
 * CAP-mode target count: the number of deep candidates that sits the frame
 * EXACTLY at the pathological-density boundary (density threshold × MP). When
 * DETECT_DENSITY_GUARD_MODE=1, the caller keeps the top-N-by-flux deep
 * candidates and drops the rest instead of throwing — the O(deep × vanguard)
 * work is bounded to this N. Reads the SAME calibrated constant the guard
 * trips on (single source of truth); never moves it. Always ≥ 1.
 */
export function densityCapCount(width: number, height: number): number {
    const megapixels = (width * height) / 1e6;
    return Math.max(1, Math.floor(PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP * megapixels));
}

export interface DensityCapResult<T> {
    /** The top-N-by-flux candidates that survive the cap (processing continues on these). */
    kept: T[];
    /** The faint tail dropped at the boundary (caller stamps them HIGH_DENSITY). */
    dropped: T[];
    /** Cap target N (the density-boundary count). */
    n: number;
    /** Original candidate count M. */
    m: number;
}

/**
 * CAP-mode selection (DETECT_DENSITY_GUARD_MODE=1): keep the top-N-by-flux deep
 * candidates at the density-guard boundary (N = densityCapCount) instead of
 * throwing. Returns kept (brightest N) + dropped (the faint remainder). When
 * M ≤ N nothing is dropped. Pure + deterministic (flux-descending sort), so the
 * O(deep × vanguard) work downstream is bounded to N without moving any
 * calibrated constant.
 */
export function applyDensityCap<T extends { flux: number }>(
    candidates: T[],
    width: number,
    height: number
): DensityCapResult<T> {
    const n = densityCapCount(width, height);
    const m = candidates.length;
    if (m <= n) return { kept: candidates, dropped: [], n, m };
    const sorted = candidates.slice().sort((a, b) => b.flux - a.flux);
    return { kept: sorted.slice(0, n), dropped: sorted.slice(n), n, m };
}
