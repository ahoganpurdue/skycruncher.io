/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MESH DETECTOR — local-background thresholding variant of the m4 extraction
 * gate (SANDBOX, tools/adaptive incubator — CLAUDE.md LAW 4)
 * ═══════════════════════════════════════════════════════════════════════════
 * Implements THESIS-2026-07-11-mesh-recall-m4 EXACTLY per the frozen sketch
 * (test_results/theses/drafts/proposals_wave2_2026-07-11/mesh-background-recall-m4.md).
 *
 * MECHANISM: replace the BINDING GLOBAL deep-scan floor
 *   T_global = mean_frame + k·stdDev_frame           (deepSigma k=1.0,
 *                                                      signal_processor.ts:463-464)
 * with a spatially-varying LOCAL-background surface, at the SAME baseline k:
 *   T_local(x,y) = B(x,y) + k·σ(x,y)                  (SExtractor BACK/BACKRMS)
 * The vanguard pass is left at its GLOBAL threshold — the thesis and the task
 * scope the change to the *binding* deep-scan floor; the vanguard/analyze()
 * threshold is documented NON-binding, so localizing it would inject an
 * untested confound (mesh-construction choice, deviations_log #A).
 *
 * NO LIVE-PATH CHANGE. This file lives only in tools/. It moves no calibrated
 * constant (k is held at baseline), touches no live code, and never feeds
 * solve/verify. It is a RECOMMENDER artifact for the recall harness.
 *
 * WHAT IT REUSES (never reimplements):
 *   - StatisticsProvider.calculateStats     (frame mean/stdDev, engine fn)
 *   - removeThermalArtifacts (hot_pixel_map) (thermal pre-pass, injectable opts)
 *   - wasm extract_blobs (wasm_compute)      (THE real blob-extraction kernel)
 *   - unpackBlobs / applyCuts (detect_harness) (EXACT shape-stat + §7-cut spine)
 *
 * PRE-MASK (why + how). `extract_blobs` is scalar-threshold-only (verified
 * src/engine/wasm_compute/src/lib.rs internal_extract_blobs: it flood-fills
 * 4-connected on `lum[i] > thresh`, NO internal blur, deterministic row-major
 * seed order). To apply a per-pixel threshold with no WASM change, the deep
 * pass runs on a TS-side pre-masked buffer:
 *   masked[i] = detectLum[i]   if detectLum[i] > T_local(i)   (kept, ORIGINAL value)
 *   masked[i] = sentinel       otherwise                      (excluded)
 * then extract_blobs(masked, w, h, tMask, mean) with a global scalar tMask set
 * BELOW every real pixel (frameMin − 1) and sentinel below tMask (frameMin − 2),
 * so the kernel's `> tMask` inclusion test reproduces the per-pixel decision
 * EXACTLY. Shape stats are always measured on the ORIGINAL detectLum (never the
 * masked buffer), so flux/SNR/shape are uncorrupted.
 *
 * P9 FLAT-SURFACE IDENTITY (bit-for-bit). With a FLAT surface (B ≡ mean,
 * σ ≡ stdDev) T_local(i) collapses to Math.fround(mean + k·stdDev) = the kernel's
 * f32 cast of the incumbent deepThresh, so the pre-mask's kept-pixel SET equals
 * the incumbent kernel's included set, the flood-fill traversal order is
 * identical (same seeds, same neighbour order), the f64 moment accumulations run
 * in the identical order, and the deep blob records are BIT-IDENTICAL to
 * runDetection. `runMeshDetection(..., { flat: true })` is that control.
 */

import * as wasm from '@/engine/wasm_compute/pkg/wasm_compute';
import { StatisticsProvider } from '@/engine/core/StatisticsProvider';
import { removeThermalArtifacts } from '@/engine/pipeline/m4_signal_detect/hot_pixel_map';
import {
    unpackBlobs,
    applyCuts,
    type KnobConfig,
    type Detection,
    type DetectionRun,
} from './detect_harness';

// ── mesh construction parameters (frozen defaults = SExtractor standard) ──────
export interface MeshParams {
    /** mesh tile side, px. Selected TRUTH-BLIND by the harness per frame from
     *  {32,64,128}; this module ACCEPTS it (no metric search here). */
    m: number;
    /** tile-grid median-filter window, tiles (thesis: f = 3, frozen). */
    f: number;
    /** κ-σ clip level for tile background/noise (thesis: κ = 3.0, frozen). */
    kappa: number;
    /** κ-σ clip iterations (thesis: N_iter = 3, frozen). */
    nIter: number;
}

/** Thesis-frozen defaults; m defaults to 64 (mid of {32,64,128}) but the harness
 *  supplies the truth-blind per-frame value — this default is for unit tests. */
export const DEFAULT_MESH: MeshParams = { m: 64, f: 3, kappa: 3.0, nIter: 3 };

// ── per-detection binding annotation (P1 scoring seam, harness-pinned) ────────
export interface DetectionBinding {
    /** deep-pass local threshold T_local = B(x,y)+k·σ(x,y) at this detection's centroid. */
    localThreshold: number;
    /** would this detection have cleared the incumbent GLOBAL deep floor
     *  (peak > mean + k·stdDev)? If false, the global gate would have rejected it. */
    wouldPassGlobalDeep: boolean;
    /** true iff the LOCAL surface (not an unreached higher floor) was the deciding
     *  constraint for this acceptance — i.e. admitted here but would NOT pass the
     *  global deep floor (== !wouldPassGlobalDeep). The per-detection P1 flag. */
    tLocalBinding: boolean;
}

export interface MeshDetection extends Detection {
    /** deep-pass binding decision (present only on deep-pass mesh detections). */
    binding?: DetectionBinding;
}

export interface MeshDetectionRun extends Omit<DetectionRun, 'detections'> {
    detections: MeshDetection[];
    /** incumbent T_global = mean + stdDev·deepSigma (deep-scan floor). */
    deepGlobalFloor: number;
    /** surviving (post-cut, post-dedup) deep-pass detections in the merged list. */
    deepSurvivorCount: number;
    /** of those, how many were admitted ONLY by the local surface (peak ≤ T_global). */
    deepLocalBindingCount: number;
    /** P1 T_local_binding_fraction = deepLocalBindingCount / deepSurvivorCount
     *  (null when there are no surviving deep detections — honest absence). */
    tLocalBindingFraction: number | null;
    /** the mesh construction actually used. */
    meshParams: MeshParams;
    /** true when run with a FLAT surface (the P9 identity control). */
    flat: boolean;
    /** the local-background surfaces (per-tile + bilinear samplers) for the
     *  harness's dark/bright split (P5) and gradient checks. */
    surfaces: MeshSurfaces;
}

// ── local-background surfaces ─────────────────────────────────────────────────
export interface MeshSurfaces {
    m: number;
    nTilesX: number;
    nTilesY: number;
    width: number;
    height: number;
    flat: boolean;
    frameMean: number;
    frameStdDev: number;
    /** per-tile background AFTER the f×f median filter, length nTilesX·nTilesY. */
    tileB: Float64Array;
    /** per-tile RMS AFTER the f×f median filter. */
    tileSigma: Float64Array;
    /** per-tile background BEFORE the median filter (transparency / debugging). */
    rawTileB: Float64Array;
    /** per-tile RMS BEFORE the median filter. */
    rawTileSigma: Float64Array;
    /** bilinear background sample at pixel (x,y). */
    sampleB(x: number, y: number): number;
    /** bilinear RMS sample at pixel (x,y). */
    sampleSigma(x: number, y: number): number;
}

// ── deterministic robust statistics (no RNG) ──────────────────────────────────

/** Lower-median of a numeric array (sorted[len>>1]), matching the deterministic
 *  convention already used in image_conditions.blockGradientSigma. Mutates a copy. */
function median(vals: number[]): number {
    if (vals.length === 0) return 0;
    const s = vals.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
}

/** 1.4826·MAD(vals) about a supplied centre (robust σ estimate). */
function madSigma(vals: number[], centre: number): number {
    if (vals.length === 0) return 0;
    const dev = new Array<number>(vals.length);
    for (let i = 0; i < vals.length; i++) dev[i] = Math.abs(vals[i] - centre);
    return 1.4826 * median(dev);
}

/**
 * κ-σ clipped background/noise for a set of tile pixels (SExtractor BACK/BACKRMS):
 * N_iter rounds of rejecting pixels outside [med − κσ, med + κσ], then
 * B = median(survivors), σ = 1.4826·MAD(survivors). Deterministic; falls back to
 * the raw median/σ when a round would empty the survivor set.
 */
function kappaSigmaBackground(pixels: number[], kappa: number, nIter: number): { B: number; sigma: number } {
    let survivors = pixels;
    let med = median(survivors);
    let sig = madSigma(survivors, med);
    for (let iter = 0; iter < nIter; iter++) {
        if (sig <= 0) break; // no spread → nothing to clip
        const lo = med - kappa * sig;
        const hi = med + kappa * sig;
        const next: number[] = [];
        for (let i = 0; i < survivors.length; i++) {
            const v = survivors[i];
            if (v >= lo && v <= hi) next.push(v);
        }
        if (next.length === 0 || next.length === survivors.length) break; // empty or converged
        survivors = next;
        med = median(survivors);
        sig = madSigma(survivors, med);
    }
    return { B: med, sigma: sig };
}

/**
 * Build the local-background surfaces for `lum`. With `flat`, skips the mesh and
 * fills every tile with (frameMean, frameStdDev) — the P9 identity control.
 */
export function computeMeshSurfaces(
    lum: Float32Array,
    w: number,
    h: number,
    params: MeshParams,
    opts: { flat?: boolean; frameMean: number; frameStdDev: number }
): MeshSurfaces {
    const { m, f, kappa, nIter } = params;
    const flat = opts.flat === true;
    const nTilesX = Math.max(1, Math.ceil(w / m));
    const nTilesY = Math.max(1, Math.ceil(h / m));
    const nTiles = nTilesX * nTilesY;

    const rawTileB = new Float64Array(nTiles);
    const rawTileSigma = new Float64Array(nTiles);

    if (flat) {
        rawTileB.fill(opts.frameMean);
        rawTileSigma.fill(opts.frameStdDev);
    } else {
        for (let ty = 0; ty < nTilesY; ty++) {
            const y0 = ty * m;
            const y1 = Math.min((ty + 1) * m, h);
            for (let tx = 0; tx < nTilesX; tx++) {
                const x0 = tx * m;
                const x1 = Math.min((tx + 1) * m, w);
                const px: number[] = [];
                for (let y = y0; y < y1; y++) {
                    const row = y * w;
                    for (let x = x0; x < x1; x++) px.push(lum[row + x]);
                }
                const { B, sigma } = kappaSigmaBackground(px, kappa, nIter);
                const ti = ty * nTilesX + tx;
                rawTileB[ti] = B;
                rawTileSigma[ti] = sigma;
            }
        }
    }

    // ── f×f median filter over the tile grid (replicate edges) ────────────────
    const tileB = new Float64Array(nTiles);
    const tileSigma = new Float64Array(nTiles);
    if (flat || f <= 1) {
        tileB.set(rawTileB);
        tileSigma.set(rawTileSigma);
    } else {
        const half = Math.floor(f / 2);
        for (let ty = 0; ty < nTilesY; ty++) {
            for (let tx = 0; tx < nTilesX; tx++) {
                const winB: number[] = [];
                const winS: number[] = [];
                for (let dy = -half; dy <= half; dy++) {
                    const sy = Math.min(nTilesY - 1, Math.max(0, ty + dy));
                    for (let dx = -half; dx <= half; dx++) {
                        const sx = Math.min(nTilesX - 1, Math.max(0, tx + dx));
                        const si = sy * nTilesX + sx;
                        winB.push(rawTileB[si]);
                        winS.push(rawTileSigma[si]);
                    }
                }
                const ti = ty * nTilesX + tx;
                tileB[ti] = median(winB);
                tileSigma[ti] = median(winS);
            }
        }
    }

    // ── bilinear samplers: nodes at tile centres ((tx+0.5)·m, (ty+0.5)·m),
    //    replicate (clamp) beyond the node grid ─────────────────────────────────
    const sampleGrid = (grid: Float64Array, x: number, y: number): number => {
        if (flat) return grid[0]; // constant surface
        // position in node-index space
        const fx = x / m - 0.5;
        const fy = y / m - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const cx0 = Math.min(nTilesX - 1, Math.max(0, x0));
        const cy0 = Math.min(nTilesY - 1, Math.max(0, y0));
        const cx1 = Math.min(nTilesX - 1, Math.max(0, x0 + 1));
        const cy1 = Math.min(nTilesY - 1, Math.max(0, y0 + 1));
        const wx = Math.min(1, Math.max(0, fx - x0));
        const wy = Math.min(1, Math.max(0, fy - y0));
        const v00 = grid[cy0 * nTilesX + cx0];
        const v10 = grid[cy0 * nTilesX + cx1];
        const v01 = grid[cy1 * nTilesX + cx0];
        const v11 = grid[cy1 * nTilesX + cx1];
        const top = v00 + (v10 - v00) * wx;
        const bot = v01 + (v11 - v01) * wx;
        return top + (bot - top) * wy;
    };

    return {
        m, nTilesX, nTilesY, width: w, height: h, flat,
        frameMean: opts.frameMean, frameStdDev: opts.frameStdDev,
        tileB, tileSigma, rawTileB, rawTileSigma,
        sampleB: (x, y) => (flat ? opts.frameMean : sampleGrid(tileB, x, y)),
        sampleSigma: (x, y) => (flat ? opts.frameStdDev : sampleGrid(tileSigma, x, y)),
    };
}

/**
 * Build the deep-pass pre-mask. Keeps pixels above their per-pixel local
 * threshold at their ORIGINAL value; sentinels the rest. The scalar `tMask`
 * (below every real pixel) makes the kernel's `> tMask` test reproduce the
 * per-pixel decision. The per-pixel threshold is f32-cast (Math.fround) to
 * mirror the kernel's f32 comparison exactly, which is what makes the FLAT
 * surface reduce bit-for-bit to the incumbent deep pass (P9).
 */
function buildDeepPreMask(
    detectLum: Float32Array,
    w: number,
    h: number,
    surfaces: MeshSurfaces,
    deepSigma: number
): { masked: Float32Array; tMask: number } {
    const n = w * h;
    let lo = Infinity;
    for (let i = 0; i < n; i++) if (detectLum[i] < lo) lo = detectLum[i];
    // normalized luminance is 0..1 (UNIT trap); a −1/−2 offset is safely below
    // every real pixel and above nothing real.
    const tMask = Math.fround(lo - 1.0);
    const sentinel = Math.fround(lo - 2.0);

    const masked = new Float32Array(n);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const i = row + x;
            const tl = Math.fround(surfaces.sampleB(x, y) + deepSigma * surfaces.sampleSigma(x, y));
            masked[i] = detectLum[i] > tl ? detectLum[i] : sentinel;
        }
    }
    return { masked, tMask };
}

/**
 * Run detection with the LOCAL-background mesh deep gate. Mirrors
 * detect_harness.runDetection (same hot-pixel pre-pass → global vanguard pass →
 * deep pass → §7 cuts → 4px dedup), swapping ONLY the deep-pass threshold for the
 * per-pixel mesh surface. Requires bootWasm() (from detect_harness) first.
 *
 * `opts.flat` runs the P9 identity control (flat surface ⇒ bit-identical to
 * runDetection on the deep records).
 */
export function runMeshDetection(
    lum: Float32Array,
    w: number,
    h: number,
    knobs: KnobConfig,
    params: MeshParams = DEFAULT_MESH,
    opts: { flat?: boolean } = {}
): MeshDetectionRun {
    const t0 = Date.now();
    const { mean, stdDev } = StatisticsProvider.calculateStats(lum);

    // ── thermal-artifact pre-pass (identical to runDetection) ─────────────────
    const hot = removeThermalArtifacts(lum, w, h, mean, stdDev, null, {
        nSigma: knobs.hotpixNSigma,
        neighborBgSigma: knobs.hotpixNeighborBgSigma,
        minDensityPerMP: knobs.hotpixMinDensityPerMP,
    });
    const detectLum = hot.data;

    // ── vanguard pass: GLOBAL threshold (unchanged; scoped to the binding deep floor) ──
    let vanguardThresh = mean + stdDev * knobs.vanguardSigma;
    if (vanguardThresh > 0.95) vanguardThresh = 0.95;
    const rawV = wasm.extract_blobs(detectLum, w, h, vanguardThresh, mean);

    // ── deep pass: LOCAL mesh surface via TS-side pre-mask ────────────────────
    const surfaces = computeMeshSurfaces(detectLum, w, h, params, {
        flat: opts.flat, frameMean: mean, frameStdDev: stdDev,
    });
    const deepGlobalFloor = mean + stdDev * knobs.deepSigma; // incumbent T_global
    // Photometric reference for the deep pass. The kernel drops any blob with
    // sum_flux ≤ 0 (net over `bg`); the incumbent is safe because its threshold
    // mean+kσ ≥ mean = bg, so every seeded pixel exceeds bg. The mesh LOWERS the
    // threshold in dark regions (T_local < mean), so a locally-admitted faint
    // source whose peak sits below the global mean would net to 0 and be dropped.
    // Referencing flux to bgFloor = min(local B) — which is ≤ every T_local since
    // T_local = B + kσ ≥ B ≥ min(B) — guarantees positive net flux for every
    // locally-admitted pixel, so no admitted source is silently discarded.
    // In the FLAT case min(B) = mean, so this reduces to the incumbent bg (P9).
    // (Mesh-construction choice, deviations_log #B: flux is measured over the
    // global-minimum local background rather than each detection's own local B —
    // a scalar the kernel accepts; slightly over-counts flux for sources outside
    // the darkest region, always positive, never drops an admitted source.)
    let bgFloor = surfaces.tileB.length ? surfaces.tileB[0] : mean;
    for (let i = 1; i < surfaces.tileB.length; i++) if (surfaces.tileB[i] < bgFloor) bgFloor = surfaces.tileB[i];
    const { masked, tMask } = buildDeepPreMask(detectLum, w, h, surfaces, knobs.deepSigma);
    const rawD = wasm.extract_blobs(masked, w, h, tMask, bgFloor);

    // ── §7 cuts (shape stats measured on the ORIGINAL detectLum, not the mask) ──
    const cutCounts: Record<string, number> = {};
    const vanguard = applyCuts(unpackBlobs(rawV, detectLum, w, h, mean, 'vanguard'), knobs, cutCounts);
    const deep = applyCuts(unpackBlobs(rawD, detectLum, w, h, bgFloor, 'deep'), knobs, cutCounts) as MeshDetection[];

    // annotate deep detections with the P1 binding decision (harness scoring seam)
    for (const d of deep) {
        const localThreshold = surfaces.sampleB(d.x, d.y) + knobs.deepSigma * surfaces.sampleSigma(d.x, d.y);
        const wouldPassGlobalDeep = d.peak > deepGlobalFloor;
        d.binding = { localThreshold, wouldPassGlobalDeep, tLocalBinding: !wouldPassGlobalDeep };
    }

    // ── 4px dedup of deep against surviving vanguard (matches runDetection) ────
    const merged: MeshDetection[] = [...vanguard];
    const survivingDeep: MeshDetection[] = [];
    for (const d of deep) {
        const dup = vanguard.some(v => Math.abs(v.x - d.x) < 4 && Math.abs(v.y - d.y) < 4);
        if (!dup) {
            merged.push(d);
            survivingDeep.push(d);
        }
    }

    const deepSurvivorCount = survivingDeep.length;
    const deepLocalBindingCount = survivingDeep.reduce((a, d) => a + (d.binding?.tLocalBinding ? 1 : 0), 0);

    return {
        detections: merged,
        mean, stdDev,
        hotpixFlagged: hot.flagged,
        hotpixApplied: hot.applied,
        rawVanguard: rawV.length / 10,
        rawDeep: rawD.length / 10,
        cutCounts,
        ms: Date.now() - t0,
        deepGlobalFloor,
        deepSurvivorCount,
        deepLocalBindingCount,
        tLocalBindingFraction: deepSurvivorCount > 0 ? deepLocalBindingCount / deepSurvivorCount : null,
        meshParams: params,
        flat: opts.flat === true,
        surfaces,
    };
}
