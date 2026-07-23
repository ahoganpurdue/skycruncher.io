/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ADAPTIVE DETECTOR — fast, config-injectable, detection-only harness (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * Incubator law (CLAUDE.md LAW 4): this lives ONLY in tools/. It touches no
 * live constant and no live code path. It is the per-image knob optimizer's
 * inner loop — it must run detection MANY times per frame (a knob grid), so it
 * is detection-ONLY (no solve, no metrology, no MW/horizon/ephemeris/photometry
 * refinement). Every actual detection COMPUTATION here is a shipped engine
 * function; only the glue that threads injected knobs through them is local.
 *
 * WHAT IT REUSES (never reimplements):
 *   - StatisticsProvider.calculateStats        (frame mean/stdDev, engine fn)
 *   - removeThermalArtifacts (hot_pixel_map)   (thermal pre-pass, injectable opts)
 *   - wasm extract_blobs (wasm_compute)        (THE real blob-extraction kernel)
 *   - computeBlobShapeStats (detection_cuts)   (SExtractor shape stats, engine fn)
 *   - evaluateBlobCuts (detection_cuts)        (§7 thermal cuts, injectable thresholds)
 *
 * FAITHFULNESS NOTE (honest-or-absent): this reproduces the EXTRACTION +
 * THERMAL-CUT + DEDUP spine of SignalProcessor.analyzeWithMasking — the exact
 * stage the tuned knobs govern. It deliberately does NOT run the downstream
 * FIXED culls (morphological filter, planet/satellite/glow heuristics), which
 * are not knobs. So the detection list here is "post-extraction candidates",
 * a slight superset of the pipeline's final clean_stars. That is fine and
 * honest: the optimizer compares knob settings against each other on the SAME
 * spine (apples-to-apples), and the fixed downstream culls would only trim a
 * few edge blobs equally across settings.
 *
 * The knobs mirror the live pipeline's detection controls (pipeline_config
 * DETECT_* + the two hard-coded sigmas). baselineKnobs() reproduces the exact
 * live defaults so "current pipeline" is a point in the search space.
 */

import * as wasm from '@/engine/wasm_compute/pkg/wasm_compute';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StatisticsProvider } from '@/engine/core/StatisticsProvider';
import { removeThermalArtifacts } from '@/engine/pipeline/m4_signal_detect/hot_pixel_map';
import { computeBlobShapeStats, evaluateBlobCuts } from '@/engine/pipeline/m4_signal_detect/detection_cuts';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_BG_PATH = path.join(REPO_ROOT, 'src', 'engine', 'wasm_compute', 'pkg', 'wasm_compute_bg.wasm');

let _wasmBooted = false;
/** Boot the REAL compiled wasm once (idempotent). Mirrors tools/api bootRealWasm. */
export function bootWasm(): void {
    if (_wasmBooted) return;
    wasm.initSync({ module: fs.readFileSync(WASM_BG_PATH) as any });
    const sep = wasm.calculate_angular_separation(0, 0, 0, Math.PI / 2);
    if (!(Math.abs(sep - Math.PI / 2) < 1e-12)) {
        throw new Error(`[adaptive] wasm post-boot sentinel failed: got ${sep}`);
    }
    _wasmBooted = true;
}

/**
 * The tunable detection knobs. Every field maps 1:1 to a live pipeline control;
 * baselineKnobs() below fills them with the exact shipped defaults so the
 * "current pipeline" configuration is a single point in the optimizer's grid.
 */
export interface KnobConfig {
    /** hot_pixel_map: N·σ spike over 8-neighbour median (DETECT_HOTPIXEL_NSIGMA). */
    hotpixNSigma: number;
    /** hot_pixel_map: "neighbours at background" ceiling (DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA). */
    hotpixNeighborBgSigma: number;
    /** hot_pixel_map: apply mask only above this flagged density (DETECT_HOTPIXEL_MIN_DENSITY_PER_MP). */
    hotpixMinDensityPerMP: number;
    /** vanguard extraction threshold = mean + stdDev·vanguardSigma (analyzeWithMasking, FL-scaled default). */
    vanguardSigma: number;
    /** deep extraction threshold = mean + stdDev·deepSigma (analyzeWithMasking hard-codes 1.0). */
    deepSigma: number;
    /** §7 cut: reject momentFwhm < floor (DETECT_FWHM_FLOOR_PX; ≤0 disables). */
    fwhmFloorPx: number;
    /** §7 cut: reject sharpness (peak/flux) > max (DETECT_SHARPNESS_MAX; ≥∞ disables). */
    sharpnessMax: number;
    /** §7 cut: reject momentEllipticity > max (DETECT_ELLIPTICITY_MAX; ≥1 disables). */
    ellipticityMax: number;
}

/** FL-scaling of the vanguard sigma, copied verbatim from analyzeWithMasking. */
export function vanguardSigmaForFL(focalLengthMm?: number): number {
    let sigmaCurrent = 3.0;
    if (focalLengthMm) {
        const flFactor = 1.0 + Math.log10(focalLengthMm / 50 + 1);
        sigmaCurrent *= Math.max(0.6, Math.min(2.0, flFactor));
    }
    return sigmaCurrent;
}

/** The exact live pipeline defaults, as a point in knob-space. */
export function baselineKnobs(focalLengthMm?: number): KnobConfig {
    return {
        hotpixNSigma: PIPELINE_CONSTANTS.DETECT_HOTPIXEL_NSIGMA,
        hotpixNeighborBgSigma: PIPELINE_CONSTANTS.DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA,
        hotpixMinDensityPerMP: PIPELINE_CONSTANTS.DETECT_HOTPIXEL_MIN_DENSITY_PER_MP,
        vanguardSigma: vanguardSigmaForFL(focalLengthMm),
        deepSigma: 1.0,
        fwhmFloorPx: PIPELINE_CONSTANTS.DETECT_FWHM_FLOOR_PX,
        sharpnessMax: PIPELINE_CONSTANTS.DETECT_SHARPNESS_MAX,
        ellipticityMax: PIPELINE_CONSTANTS.DETECT_ELLIPTICITY_MAX,
    };
}

export interface Detection {
    x: number;
    y: number;
    flux: number;
    peak: number;
    fwhm: number;            // WASM fwhm field (measurement-clamped for tiny blobs)
    circularity: number;
    ellipticity: number;
    theta: number;
    snr: number;
    sharpness: number | null;
    momentFwhmPx: number | null;
    momentEllipticity: number | null;
    pass: 'vanguard' | 'deep';
}

export interface DetectionRun {
    detections: Detection[];
    /** frame stats (mean/stdDev) the thresholds were built from. */
    mean: number;
    stdDev: number;
    /** hot-pixel pre-pass outcome (how many spikes flagged, whether masked). */
    hotpixFlagged: number;
    hotpixApplied: boolean;
    /** raw blob counts before §7 cuts (extractor output), per pass. */
    rawVanguard: number;
    rawDeep: number;
    /** §7 cut tally by reason (FWHM_FLOOR / SHARPNESS / ELLIPTICITY). */
    cutCounts: Record<string, number>;
    /** wall-clock of this run (ms) — for the "fast enough for a grid" claim. */
    ms: number;
}

/** stride-10 WASM blob record → structured, with TS-side shape stats.
 *  Exported so the mesh_detector variant (same lane) reuses the EXACT unpack
 *  contract instead of duplicating it (LAW 4: no code living in two places). */
export function unpackBlobs(
    raw: Float64Array | number[],
    lum: Float32Array,
    w: number,
    h: number,
    bg: number,
    pass: 'vanguard' | 'deep'
): Detection[] {
    const out: Detection[] = [];
    // Format: [x, y, rawX, rawY, flux, peak, fwhm, circularity, theta, snr]
    for (let i = 0; i + 9 < raw.length; i += 10) {
        const x = raw[i], y = raw[i + 1];
        const flux = raw[i + 4], peak = raw[i + 5];
        const shape = computeBlobShapeStats(lum, w, h, x, y, bg, peak, flux);
        out.push({
            x, y, flux, peak,
            fwhm: raw[i + 6],
            circularity: raw[i + 7],
            ellipticity: 1.0 - raw[i + 7],
            theta: raw[i + 8],
            snr: raw[i + 9],
            sharpness: shape.sharpness,
            momentFwhmPx: shape.momentFwhmPx,
            momentEllipticity: shape.momentEllipticity,
            pass,
        });
    }
    return out;
}

/** Apply the injected §7 thermal cuts to a blob list; tally reasons.
 *  Exported for mesh_detector reuse (LAW 4: shared cut contract, one source). */
export function applyCuts(blobs: Detection[], knobs: KnobConfig, cutCounts: Record<string, number>): Detection[] {
    const kept: Detection[] = [];
    for (const b of blobs) {
        const reason = evaluateBlobCuts(
            { sharpness: b.sharpness, momentFwhmPx: b.momentFwhmPx, momentEllipticity: b.momentEllipticity },
            { fwhmFloorPx: knobs.fwhmFloorPx, sharpnessMax: knobs.sharpnessMax, ellipticityMax: knobs.ellipticityMax }
        );
        if (reason) {
            cutCounts[reason] = (cutCounts[reason] || 0) + 1;
        } else {
            kept.push(b);
        }
    }
    return kept;
}

/**
 * Run detection under an injected knob config. Reproduces the analyzeWithMasking
 * extraction spine (hot-pixel pre-pass → vanguard + deep threshold extraction on
 * the cleaned buffer → §7 shape cuts → 4px dedup of deep against vanguard).
 * Requires bootWasm() to have run.
 */
export function runDetection(lum: Float32Array, w: number, h: number, knobs: KnobConfig): DetectionRun {
    const t0 = Date.now();
    const { mean, stdDev } = StatisticsProvider.calculateStats(lum);

    // ── thermal-artifact pre-pass (real fn, injected opts) ────────────────────
    const hot = removeThermalArtifacts(lum, w, h, mean, stdDev, null, {
        nSigma: knobs.hotpixNSigma,
        neighborBgSigma: knobs.hotpixNeighborBgSigma,
        minDensityPerMP: knobs.hotpixMinDensityPerMP,
    });
    const detectLum = hot.data;

    // ── vanguard threshold (clamped ≤0.95, exactly like the pipeline) ─────────
    let vanguardThresh = mean + stdDev * knobs.vanguardSigma;
    if (vanguardThresh > 0.95) vanguardThresh = 0.95;
    const deepThresh = mean + stdDev * knobs.deepSigma;

    // ── real WASM extraction kernel on the cleaned detection buffer ───────────
    const rawV = wasm.extract_blobs(detectLum, w, h, vanguardThresh, mean);
    const rawD = wasm.extract_blobs(detectLum, w, h, deepThresh, mean);

    const cutCounts: Record<string, number> = {};
    const vanguard = applyCuts(unpackBlobs(rawV, detectLum, w, h, mean, 'vanguard'), knobs, cutCounts);
    const deep = applyCuts(unpackBlobs(rawD, detectLum, w, h, mean, 'deep'), knobs, cutCounts);

    // ── 4px dedup of deep against surviving vanguard (matches pipeline) ───────
    const merged: Detection[] = [...vanguard];
    for (const d of deep) {
        const dup = vanguard.some(v => Math.abs(v.x - d.x) < 4 && Math.abs(v.y - d.y) < 4);
        if (!dup) merged.push(d);
    }

    return {
        detections: merged,
        mean, stdDev,
        hotpixFlagged: hot.flagged,
        hotpixApplied: hot.applied,
        rawVanguard: rawV.length / 10,
        rawDeep: rawD.length / 10,
        cutCounts,
        ms: Date.now() - t0,
    };
}
