/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOT-PIXEL MAP — statistical single-pixel spike masking (M4, pre-extraction)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL. Detection-support only — the masked buffer is a COPY used
 * for blob extraction; the science buffer that feeds photometry/PSF work is
 * never mutated (native-grid measurement law).
 *
 * DISCRIMINATOR (the physics): a real star elevates its neighbours through
 * the PSF — even a heavily undersampled stellar core leaks signal into the
 * 8-neighbour ring. A hot pixel / dark-current spike does not: its neighbours
 * sit at background. A pixel is flagged iff BOTH hold:
 *
 *   (1) spike:            lum[i] > median8(i) + N·σ        (N = DETECT_HOTPIXEL_NSIGMA)
 *   (2) neighbours at bg: median8(i) < bg + K·σ            (K = DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA)
 *
 * Flagged pixels are replaced by their 8-neighbour median BEFORE blob
 * extraction, so spikes can neither seed blobs nor drag centroids.
 *
 * NO-OP-ON-CLEAN-FRAMES CONSTRAINT: when zero pixels are flagged the ORIGINAL
 * buffer is returned untouched (copy-on-flag) — clean frames are byte-identical
 * BY CONSTRUCTION, verified by both sacred e2e scenarios. N/K are calibrated
 * so the clean reference frames flag ~0 pixels (measured; see constants).
 *
 * MASTER DARK: when SensorCalibrationManager.getMasterDark() supplies a frame
 * of matching geometry, dark subtraction is the physically-correct removal and
 * is preferred; this statistical map is the no-dark fallback. (The dark hook
 * is currently a stub with zero producers — the preference is wired and
 * unit-tested so real darks slot in without new plumbing.)
 */

import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';

export interface HotPixelResult {
    /** Buffer to run extraction on. === input when the mask was not applied. */
    data: Float32Array;
    /** Number of spike pixels the discriminator flagged (measured, always). */
    flagged: number;
    /**
     * Whether the mask was actually APPLIED. The flagged count alone does not
     * decide: a clean DSLR frame carries a handful of real hot pixels
     * (measured: bundled CR2 = 35 px = 1.75/MP) whose masking perturbs the
     * calibrated solve in the 5th decimal — while a thermal-noise-dominated
     * frame flags hundreds per MP (measured: 5D3 = 8,474 px = 378/MP). The
     * two populations separate ~200x in DENSITY space, not in sigma space, so
     * application is gated on DETECT_HOTPIXEL_MIN_DENSITY_PER_MP: below it
     * the original buffer is returned untouched (clean frames byte-identical
     * BY CONSTRUCTION), above it the frame is measurably thermal-dominated
     * and masking is the honest correction. Same measured-evidence-gate
     * pattern as the fast-fail density guard.
     */
    applied: boolean;
    /** Which removal path ran: darks (preferred), statistical map, or none. */
    method: 'MASTER_DARK' | 'STATISTICAL' | 'NONE';
}

/** In-place 8-neighbour median of the 3×3 ring around (x,y), edges excluded
 *  by the caller. Insertion sort on ≤8 elements — branch-cheap. */
function median8(lum: Float32Array, width: number, i: number): number {
    const vals = [
        lum[i - width - 1], lum[i - width], lum[i - width + 1],
        lum[i - 1], lum[i + 1],
        lum[i + width - 1], lum[i + width], lum[i + width + 1],
    ];
    vals.sort((a, b) => a - b);
    return (vals[3] + vals[4]) / 2;
}

/**
 * Statistical hot-pixel masking (copy-on-flag). `bg`/`sigma` are the frame
 * background statistics the caller already measured — the SAME numbers the
 * extraction thresholds use, so the two stay consistent.
 *
 * Cost control: only pixels that could matter to detection are examined —
 * a spike below bg + 1σ can never seed or join a blob (the deepest extraction
 * threshold in the pipeline is bg + 1σ), so the neighbour work runs on the
 * tiny fraction above that floor.
 */
export function maskHotPixels(
    lum: Float32Array,
    width: number,
    height: number,
    bg: number,
    sigma: number,
    opts: { nSigma?: number; neighborBgSigma?: number; minDensityPerMP?: number } = {}
): HotPixelResult {
    const N = opts.nSigma ?? PIPELINE_CONSTANTS.DETECT_HOTPIXEL_NSIGMA;
    const K = opts.neighborBgSigma ?? PIPELINE_CONSTANTS.DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA;
    const minDensity = opts.minDensityPerMP ?? PIPELINE_CONSTANTS.DETECT_HOTPIXEL_MIN_DENSITY_PER_MP;
    if (!(N > 0) || !(sigma > 0)) return { data: lum, flagged: 0, applied: false, method: 'NONE' };

    const floor = bg + sigma;          // below this a pixel can't influence detection
    const bgCeil = bg + K * sigma;     // "neighbours at background" ceiling

    // Phase 1 — MEASURE: collect every spike pixel and its replacement.
    const flaggedIdx: number[] = [];
    const flaggedMed: number[] = [];
    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const i = row + x;
            const v = lum[i];
            if (v <= floor) continue;
            const med = median8(lum, width, i);
            if (med >= bgCeil) continue;           // neighbours elevated → PSF, keep
            if (v <= med + N * sigma) continue;    // not a spike
            flaggedIdx.push(i);
            flaggedMed.push(med);
        }
    }

    // Phase 2 — DECIDE: apply only on a measurably thermal-dominated frame
    // (see HotPixelResult.applied for the calibration evidence).
    const megapixels = (width * height) / 1e6;
    const density = megapixels > 0 ? flaggedIdx.length / megapixels : 0;
    if (flaggedIdx.length === 0 || density < minDensity) {
        return { data: lum, flagged: flaggedIdx.length, applied: false, method: 'STATISTICAL' };
    }
    const out = lum.slice();
    for (let k = 0; k < flaggedIdx.length; k++) out[flaggedIdx[k]] = flaggedMed[k];
    return { data: out, flagged: flaggedIdx.length, applied: true, method: 'STATISTICAL' };
}

/**
 * Preferred-path wrapper: master-dark subtraction when a geometry-matching
 * dark exists, statistical map otherwise. Dark subtraction also copies —
 * the input luminance is never mutated.
 */
export function removeThermalArtifacts(
    lum: Float32Array,
    width: number,
    height: number,
    bg: number,
    sigma: number,
    masterDark: Float32Array | null,
    opts: { nSigma?: number; neighborBgSigma?: number; minDensityPerMP?: number } = {}
): HotPixelResult {
    if (masterDark && masterDark.length === lum.length) {
        const out = new Float32Array(lum.length);
        for (let i = 0; i < lum.length; i++) {
            const v = lum[i] - masterDark[i];
            out[i] = v > 0 ? v : 0;
        }
        return { data: out, flagged: 0, applied: true, method: 'MASTER_DARK' };
    }
    return maskHotPixels(lum, width, height, bg, sigma, opts);
}

// ── instrumentation (calibration evidence, log-only) ─────────────────────────

/**
 * Measure how many pixels WOULD be flagged at a ladder of N values (fixed K).
 * Pure diagnostics — the calibration instrument that sets
 * DETECT_HOTPIXEL_NSIGMA from real clean-frame data. Does not modify anything.
 */
export function measureHotPixelCandidates(
    lum: Float32Array,
    width: number,
    height: number,
    bg: number,
    sigma: number,
    nLadder: number[] = [6, 8, 10, 12, 16, 20],
    neighborBgSigma: number = 3
): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const n of nLadder) counts[`N${n}`] = 0;
    if (!(sigma > 0)) return counts;
    const floor = bg + sigma;
    const bgCeil = bg + neighborBgSigma * sigma;
    const minN = Math.min(...nLadder);
    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const i = row + x;
            const v = lum[i];
            if (v <= floor) continue;
            const med = median8(lum, width, i);
            if (med >= bgCeil) continue;
            const excess = (v - med) / sigma;
            if (excess <= minN) continue;
            for (const n of nLadder) if (excess > n) counts[`N${n}`]++;
        }
    }
    return counts;
}
