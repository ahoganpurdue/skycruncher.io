/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DETECTION CUTS — per-blob thermal-noise discriminators (M4)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL (reads the detection luminance grid; never touches WCS).
 *
 * Uncooled high-ISO DSLR frames (the 5D3 class: ISO6400 / 15 s / 43 °C) fill
 * the blob extractor with thermal junk — hot pixels, dark-current spikes,
 * hot-pixel clusters — that survives the existing FWHM hygiene because the
 * WASM fwhm field is measurement-clamped near ~1.5 px for tiny blobs (measured:
 * the clean bundled CR2 and the 5D3 have near-identical WASM-fwhm
 * distributions, p50 ≈ 1.59 px both). These SExtractor-style shape statistics
 * are measured TS-side from a small luminance stamp around each centroid, so
 * they stay honest where the WASM field saturates:
 *
 *   SHARPNESS          peak/flux ratio from the existing per-blob fields — a
 *                      lone hot pixel concentrates all flux in one pixel
 *                      (ratio → ~1); a real PSF spreads it (ratio ≪ 1).
 *   MOMENT FWHM        2.355 · geometric-mean σ from background-subtracted
 *                      2nd moments on an 11×11 stamp. A sub-pixel spike has
 *                      near-zero spatial variance; a real (even undersampled)
 *                      PSF cannot fall below ~1 px.
 *   MOMENT ELLIPTICITY 1 − σ_minor/σ_major from the same moments. Real stars
 *                      ≈ round; hot-pixel clusters and readout artifacts are
 *                      irregular/elongated.
 *
 * CALIBRATION CONSTRAINT (the whole game): the thresholds in
 * PIPELINE_CONSTANTS.DETECT_* are set OUTSIDE the measured distributions of
 * the clean reference frames (SeeStar M66 FITS + bundled CR2) so the cuts are
 * a NO-OP there — verified byte-identical by both sacred e2e scenarios. The
 * 5D3's thermal junk is what gets cut. Gates are never lowered; this module
 * only ever ADDS evidence against a blob.
 *
 * Consumers (cuts applied at BOTH stride-10 unpack lanes):
 *   - signal_processor.ts  extractBlobs → analyzeWithMasking (wizard lane;
 *     tally() counts every cut at assignment time — counters stay MEASURED)
 *   - source_extractor.ts  detectSources (auto path + solver re-extraction;
 *     measured counts logged)
 *
 * This is deliberately NOT the whole-frame fast-fail guard (detection_guard.ts
 * — a pre-pass density bail). These are per-blob verdicts; the two never
 * double-count.
 */

import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import type { CullingReason } from '../../types/Main_types';

/** Half-width of the moment stamp (11×11). Sized to hold any real PSF core
 *  on the detection grid while staying cheap for tens of thousands of blobs. */
const STAMP_R = 5;

export interface BlobShapeStats {
    /** peak / flux ratio (existing per-blob fields). null when flux ≤ 0. */
    sharpness: number | null;
    /** 2.355 · sqrt(σ_major·σ_minor) from stamp 2nd moments, px on the
     *  DETECTION grid. null when the stamp holds no positive signal. */
    momentFwhmPx: number | null;
    /** 1 − σ_minor/σ_major. null when moments are degenerate. */
    momentEllipticity: number | null;
}

/**
 * Measure background-subtracted 2nd-moment shape statistics on an 11×11
 * luminance stamp centred on the blob centroid. Pure pixel-lane measurement:
 * no thresholds applied here.
 */
export function computeBlobShapeStats(
    lum: Float32Array,
    width: number,
    height: number,
    cx: number,
    cy: number,
    background: number,
    peak?: number,
    flux?: number
): BlobShapeStats {
    const sharpness = (flux !== undefined && peak !== undefined && flux > 0)
        ? peak / flux
        : null;

    const icx = Math.round(cx);
    const icy = Math.round(cy);
    const x0 = Math.max(0, icx - STAMP_R);
    const x1 = Math.min(width - 1, icx + STAMP_R);
    const y0 = Math.max(0, icy - STAMP_R);
    const y1 = Math.min(height - 1, icy + STAMP_R);

    // First pass: weighted centroid inside the stamp (weights = signal above
    // background, negatives clipped — noise below bg carries no shape info).
    let wSum = 0, mx = 0, my = 0;
    for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
            const v = lum[row + x] - background;
            if (v <= 0) continue;
            wSum += v;
            mx += v * x;
            my += v * y;
        }
    }
    if (wSum <= 0) return { sharpness, momentFwhmPx: null, momentEllipticity: null };
    mx /= wSum;
    my /= wSum;

    // Second pass: central 2nd moments about the measured centroid.
    let mxx = 0, myy = 0, mxy = 0;
    for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
            const v = lum[row + x] - background;
            if (v <= 0) continue;
            const dx = x - mx;
            const dy = y - my;
            mxx += v * dx * dx;
            myy += v * dy * dy;
            mxy += v * dx * dy;
        }
    }
    mxx /= wSum;
    myy /= wSum;
    mxy /= wSum;

    // Principal-axis variances (eigenvalues of the moment matrix).
    const tr2 = (mxx + myy) / 2;
    const det = Math.sqrt(Math.max(0, ((mxx - myy) / 2) ** 2 + mxy * mxy));
    const lMaj = Math.max(0, tr2 + det);
    const lMin = Math.max(0, tr2 - det);
    const sigMaj = Math.sqrt(lMaj);
    const sigMin = Math.sqrt(lMin);

    // Geometric-mean σ → FWHM. A single-pixel spike measures ~0 (its variance
    // is sub-pixel); a real PSF cannot (PSF wings always spread ≥ ~1 px).
    const momentFwhmPx = 2.355 * Math.sqrt(Math.max(0, sigMaj * sigMin));
    const momentEllipticity = sigMaj > 0 ? 1 - sigMin / sigMaj : null;

    return { sharpness, momentFwhmPx, momentEllipticity };
}

/**
 * Per-blob verdict against the calibrated DETECT_* thresholds. Returns the
 * culling reason, or null when the blob passes. Threshold semantics:
 *   DETECT_FWHM_FLOOR_PX     ≤ 0 disables; else momentFwhm below it rejects
 *   DETECT_SHARPNESS_MAX     ≥ Infinity disables; else sharpness above rejects
 *   DETECT_ELLIPTICITY_MAX   ≥ 1 disables; else ellipticity above rejects
 * A null statistic never rejects (honest-or-absent: no measurement, no cut).
 */
export function evaluateBlobCuts(
    stats: BlobShapeStats,
    thresholds: {
        fwhmFloorPx?: number;
        sharpnessMax?: number;
        ellipticityMax?: number;
    } = {}
): CullingReason | null {
    const floor = thresholds.fwhmFloorPx ?? PIPELINE_CONSTANTS.DETECT_FWHM_FLOOR_PX;
    const shMax = thresholds.sharpnessMax ?? PIPELINE_CONSTANTS.DETECT_SHARPNESS_MAX;
    const elMax = thresholds.ellipticityMax ?? PIPELINE_CONSTANTS.DETECT_ELLIPTICITY_MAX;

    if (floor > 0 && stats.momentFwhmPx !== null && stats.momentFwhmPx < floor) {
        return 'FWHM_FLOOR';
    }
    if (stats.sharpness !== null && stats.sharpness > shMax) {
        return 'SHARPNESS';
    }
    if (stats.momentEllipticity !== null && stats.momentEllipticity > elMax) {
        return 'ELLIPTICITY';
    }
    return null;
}

/** Blob shape fields as attached to SignalPoint / DetectedStar. */
export interface ShapeCarrier {
    sharpness?: number;
    moment_fwhm_px?: number;
    moment_ellipticity?: number;
    culling_reason?: CullingReason;
}

/** True when every thermal cut is disabled (the inert/sentinel state). */
export function thermalCutsActive(): boolean {
    return PIPELINE_CONSTANTS.DETECT_FWHM_FLOOR_PX > 0
        || PIPELINE_CONSTANTS.DETECT_SHARPNESS_MAX < Infinity
        || PIPELINE_CONSTANTS.DETECT_ELLIPTICITY_MAX < 1;
}

/**
 * Apply the thermal cuts to a blob list (shared by both extraction lanes).
 * Returns the surviving blobs; each cut blob gets its culling_reason set and
 * `onCut` fires (assignment-time counting — callers keep counters MEASURED).
 * When all cuts are disabled the input array is returned unchanged.
 */
export function cullThermalBlobs<T extends ShapeCarrier>(
    blobs: T[],
    onCut?: (reason: CullingReason, blob: T) => void
): T[] {
    if (!thermalCutsActive()) return blobs;
    const kept: T[] = [];
    for (const b of blobs) {
        const reason = evaluateBlobCuts({
            sharpness: b.sharpness ?? null,
            momentFwhmPx: b.moment_fwhm_px ?? null,
            momentEllipticity: b.moment_ellipticity ?? null,
        });
        if (reason) {
            b.culling_reason = reason;
            onCut?.(reason, b);
        } else {
            kept.push(b);
        }
    }
    return kept;
}

// ── instrumentation (calibration evidence, log-only) ─────────────────────────

const PCTS = [0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1];

function pctLine(values: number[]): string {
    if (values.length === 0) return 'n=0';
    const v = [...values].sort((a, b) => a - b);
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return PCTS.map(p => `p${Math.round(p * 100)}=${q(p).toFixed(4)}`).join(' ');
}

/**
 * Log the measured shape-statistic distributions for one extraction site.
 * Pure diagnostics — this is the calibration instrument that sets the
 * DETECT_* thresholds from real clean-frame data (see module header).
 */
export function logShapeDistributions(
    site: string,
    stats: BlobShapeStats[],
    wasmFwhms?: number[]
): void {
    const sharp = stats.map(s => s.sharpness).filter((v): v is number => v !== null);
    const mfw = stats.map(s => s.momentFwhmPx).filter((v): v is number => v !== null);
    const ell = stats.map(s => s.momentEllipticity).filter((v): v is number => v !== null);
    console.log(`[DetectionCuts] site=${site} n=${stats.length}`);
    console.log(`[DetectionCuts]   sharpness    ${pctLine(sharp)}`);
    console.log(`[DetectionCuts]   momentFwhmPx ${pctLine(mfw)}`);
    console.log(`[DetectionCuts]   ellipticity  ${pctLine(ell)}`);
    if (wasmFwhms && wasmFwhms.length) {
        console.log(`[DetectionCuts]   wasmFwhmPx   ${pctLine(wasmFwhms)}`);
    }
}
