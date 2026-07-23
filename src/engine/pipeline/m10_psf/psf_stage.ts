/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF — optional post-solve PSF measurement + deconvolution stage
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Consumes the luminance science buffer on its own grid;
 * measures the PSF on NATIVE pixels; deconvolves bounded LOCAL WINDOWS.
 * No WCS, no coordinate functions — positions are reported in buffer pixels
 * and downstream consumers apply coordinate corrections as functions (owner
 * separation law; see tools/psf/ for the reference lane).
 *
 * STRICTLY OPTIONAL: nothing in the pipeline calls this stage unless the
 * user asks for PSF diagnostics. Its absence changes no scenario.
 *
 * Performance contract (owner directive):
 *   - measurement pass is cheap (sub-second on wizard-sized buffers) and
 *     powers the text stats;
 *   - deconvolution runs per-target on padded windows with event-loop yields
 *     (never full-frame, never in a step's hot path);
 *   - iteration snapshots are a cheap opt-in flag (`captureSnapshots`) —
 *     bounded crops, captured only during the run because they do not exist
 *     afterwards.
 *
 * Typed input/output; event bus injected (never imported from a singleton).
 */

import {
    findMaxima, buildNeighborIndex, hasNeighborWithin, measureStar,
    buildEmpiricalKernel, truncateKernel, regionGrid3x3, medianOf,
    pixelNoiseSigma, robustStats, REGION_NAMES,
    PsfStarMeasure, PsfKernel, NeighborIndex
} from './psf_core';
import { richardsonLucyWindowProtected, dilateMask } from './rl_deconv';
import type { PipelineEventBus } from '../../events/pipeline_events';

// ─── contracts ──────────────────────────────────────────────────────────────

export interface PsfStageOptions {
    /** RL iterations (default 12 — the verified tools/psf default). */
    iters?: number;
    /** Star tiles per category (brightest / most smeared). Default 6. */
    tileCount?: number;
    /** RL window half-size around each tile target (default 80 → 161² window). */
    windowRadius?: number;
    /** RL window half-size for the stage-strip showcase target (default 96). */
    stripWindowRadius?: number;
    /** Run the deconvolution lane at all (measurement pass always runs). */
    deconvolve?: boolean;
    /** Capture RL iteration snapshots for the stage strip (owner directive: ON manual, OFF auto). */
    captureSnapshots?: boolean;
    /** Iterations to snapshot (1-based, in addition to the final iteration). */
    snapshotIters?: number[];
    onProgress?: (msg: string) => void;
}

export interface PsfCrop { data: Float32Array; w: number; h: number; }

export interface PsfDeconvTarget {
    kind: 'bright' | 'smeared';
    cx: number; cy: number;
    region: string;
    fwhmBefore: number;
    fwhmAfter: number | null;
    ellipticityBefore: number;
    peakAboveBg: number;
    before: PsfCrop;
    after: PsfCrop | null;
}

export interface PsfStripStage {
    label: string;
    iter: number | null;
    crop: PsfCrop;
    fwhm: number | null;
}

export interface PsfDeconvReport {
    itersRun: number;
    kernelSize: number;
    windowRadius: number;
    strip: { cx: number; cy: number; region: string; stages: PsfStripStage[] } | null;
    tiles: PsfDeconvTarget[];
    /** Median FWHM after RL — over the processed windows only (labeled in UI). */
    fwhmMedianAfterPx: number | null;
    improved: number;
    remeasured: number;
}

export interface PsfReport {
    ledger: 'PIXEL';
    /** Which pixel grid the buffer lives on (set by the session caller). FWHM is in THESE pixels. */
    grid?: 'SCIENCE_NATIVE' | 'SCIENCE_BINNED2X';
    width: number;
    height: number;
    pedestal: number;
    sigmaPixel: number;
    satLevel: number;
    nPeaks5Sigma: number;
    nMeasured: number;
    rejected: Record<string, number>;
    boxR: number;
    fwhmMedianPx: number;
    ellipticityMedian: number | null;
    /** 3x3 median FWHM(maj) grid, row-major top-left -> bottom-right. */
    regionFwhm: { n: number; median: number | null }[];
    kernel: { size: number; nStars: number } | null;
    deconv: PsfDeconvReport | null;
    /** Every approximation in this report, spelled out (UI must label them APPROXIMATE). */
    approximate: string[];
    timings: Record<string, number>;
}

export interface PsfStageInput {
    /** Luminance science buffer (w*h), pixel ledger, whatever grid the session solved on. */
    lum: Float32Array;
    width: number;
    height: number;
    options?: PsfStageOptions;
    /** Injected event bus (emission inside the stage — consolidation law). */
    events?: PipelineEventBus;
}

// ─── internals ──────────────────────────────────────────────────────────────

/** Neighbor check that tolerates the point's own entry in the index. */
function hasNeighborWithinSelfTolerant(idx: NeighborIndex, x: number, y: number, r: number): boolean {
    const { map, cellSize, points } = idx;
    const gx = x / cellSize | 0, gy = y / cellSize | 0;
    const reach = Math.ceil(r / cellSize);
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const arr = map.get((gx + dx) * 100000 + (gy + dy));
            if (!arr) continue;
            for (const i of arr) {
                const p = points[i];
                const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
                if (d2 < r * r && d2 > 2.25) return true; // >1.5px: not our own peak
            }
        }
    }
    return false;
}

function regionNameFor(cx: number, cy: number, w: number, h: number): string {
    const gx = Math.min(2, Math.floor(cx / (w / 3)));
    const gy = Math.min(2, Math.floor(cy / (h / 3)));
    return REGION_NAMES[gy * 3 + gx];
}

function cropFrom(src: ArrayLike<number>, w: number, h: number, cx: number, cy: number, radius: number): PsfCrop {
    const size = 2 * radius + 1;
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
        const sy = Math.min(h - 1, Math.max(0, cy - radius + j));
        for (let i = 0; i < size; i++) {
            const sx = Math.min(w - 1, Math.max(0, cx - radius + i));
            out[j * size + i] = src[sy * w + sx];
        }
    }
    return { data: out, w: size, h: size };
}

/**
 * Least-squares plane fit over the border ring of a window; returns the
 * window with (plane - borderMedian) subtracted — local background flatten
 * that preserves the pedestal (RL input stays non-negative in practice).
 */
function flattenWindowPlane(win: Float32Array, w: number, h: number): Float32Array {
    let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0;
    const border: number[] = [];
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            if (j !== 0 && j !== h - 1 && i !== 0 && i !== w - 1) continue;
            const v = win[j * w + i];
            border.push(v);
            const X = i / w - 0.5, Y = j / h - 0.5;
            s0++; sx += X; sy += Y; sxx += X * X; sxy += X * Y; syy += Y * Y;
            sv += v; svx += v * X; svy += v * Y;
        }
    }
    border.sort((a, b) => a - b);
    const ped = border[border.length >> 1] ?? 0;
    // solve 3x3 normal equations for c0 + c1 X + c2 Y
    const A = [s0, sx, sy, sx, sxx, sxy, sy, sxy, syy];
    const det = (M: number[]) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    const D = det(A);
    const out = new Float32Array(win.length);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-12) { out.set(win); return out; }
    const rep = (M: number[], col: number, vec: number[]) => { const C = M.slice(); C[col] = vec[0]; C[col + 3] = vec[1]; C[col + 6] = vec[2]; return C; };
    const b = [sv, svx, svy];
    const c0 = det(rep(A, 0, b)) / D, c1 = det(rep(A, 1, b)) / D, c2 = det(rep(A, 2, b)) / D;
    for (let j = 0; j < h; j++) {
        const Y = j / h - 0.5;
        for (let i = 0; i < w; i++) {
            const X = i / w - 0.5;
            const plane = c0 + c1 * X + c2 * Y;
            const v = win[j * w + i] - (plane - ped);
            out[j * w + i] = v < 0 ? 0 : v;
        }
    }
    return out;
}

/** Re-find the local max near the window center and re-measure FWHM. */
function remeasureAt(L: Float32Array, w: number, h: number, cx: number, cy: number, sigma: number, boxR: number): PsfStarMeasure | null {
    let bx = Math.round(cx), by = Math.round(cy), bv = -Infinity;
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            const X = Math.round(cx) + dx, Y = Math.round(cy) + dy;
            if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
            const v = L[Y * w + X];
            if (v > bv) { bv = v; bx = X; by = Y; }
        }
    }
    return measureStar(L, w, h, bx, by, sigma, boxR);
}

// ─── the stage ──────────────────────────────────────────────────────────────

export async function runPsfStage(input: PsfStageInput): Promise<PsfReport> {
    const { lum, width: w, height: h, events } = input;
    const o = input.options ?? {};
    const iters = o.iters ?? 12;
    const tileCount = o.tileCount ?? 6;
    const windowRadius = o.windowRadius ?? 80;
    const stripWindowRadius = o.stripWindowRadius ?? 96;
    const deconvolve = o.deconvolve ?? true;
    const captureSnapshots = o.captureSnapshots ?? true;
    const snapshotIters = (o.snapshotIters ?? [1, 3, 8]).filter(i => i >= 1 && i < iters);
    const progress = o.onProgress ?? (() => { /* silent */ });
    const timings: Record<string, number> = {};
    const approximate: string[] = [];
    let t0 = Date.now();

    if (lum.length !== w * h) throw new Error(`PSF stage: buffer length ${lum.length} != ${w}x${h}`);

    // ── measurement pass (cheap; powers the text stats) ──
    progress('PSF: measuring frame statistics...');
    const { med: pedestal } = robustStats(lum);
    const sigmaPixel = pixelNoiseSigma(lum);

    let globalMax = 0;
    for (let i = 0; i < lum.length; i += 7) if (lum[i] > globalMax) globalMax = lum[i];
    const satLevel = 0.85 * globalMax;

    const peaks5 = findMaxima(lum, w, h, pedestal + 5 * sigmaPixel, 60000, 8);
    const peaks3 = findMaxima(lum, w, h, pedestal + 3 * sigmaPixel, 150000, 8);
    const nIdx = buildNeighborIndex(peaks3, 12);
    timings.stats_and_maxima_ms = Date.now() - t0; t0 = Date.now();

    progress(`PSF: measuring stars (${peaks5.length} candidate maxima)...`);
    let rejected: Record<string, number> = {};
    const measureSet = (boxR: number, fwhmCap: number): PsfStarMeasure[] => {
        const out: PsfStarMeasure[] = [];
        rejected = { crowded: 0, saturated: 0, fwhmRange: 0, faint: 0, edge: 0, failed: 0 };
        const margin = boxR + 13;
        for (const p of peaks5) {
            if (out.length >= 300) break;
            if (p.x < margin || p.y < margin || p.x >= w - margin || p.y >= h - margin) { rejected.edge++; continue; }
            let sat = false;
            for (let dy = -1; dy <= 1 && !sat; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (lum[(p.y + dy) * w + p.x + dx] >= satLevel) { sat = true; break; }
                }
            }
            if (sat) { rejected.saturated++; continue; }
            if (hasNeighborWithinSelfTolerant(nIdx, p.x, p.y, 12)) { rejected.crowded++; continue; }
            const m = measureStar(lum, w, h, p.x, p.y, sigmaPixel, boxR);
            if (!m) { rejected.failed++; continue; }
            if (m.peakAboveBg < 8 * sigmaPixel) { rejected.faint++; continue; }
            if (m.fwhmMaj < 1.5 || m.fwhmMaj > fwhmCap || m.fwhmMin < 1.0) { rejected.fwhmRange++; continue; }
            out.push(m);
        }
        return out;
    };

    // Adaptive measurement window (verified tools/psf behavior): a 15x15
    // cutout truncates the moments once FWHM exceeds ~4.5 px.
    let boxR = 7;
    let measured = measureSet(boxR, 8);
    let fwhmMed = measured.length ? medianOf(measured.map(s => s.fwhmMaj))! : 0;
    if (measured.length >= 20 && fwhmMed > 4.5) {
        boxR = 9;
        measured = measureSet(boxR, 12);
        fwhmMed = medianOf(measured.map(s => s.fwhmMaj))!;
    }
    timings.measure_ms = Date.now() - t0; t0 = Date.now();

    const regionFwhm = regionGrid3x3(measured, w, h, 'fwhmMaj');
    const ellipticityMedian = measured.length ? medianOf(measured.map(s => s.ellipticity)) : null;

    const base: PsfReport = {
        ledger: 'PIXEL',
        width: w, height: h,
        pedestal, sigmaPixel, satLevel,
        nPeaks5Sigma: peaks5.length,
        nMeasured: measured.length,
        rejected,
        boxR,
        fwhmMedianPx: fwhmMed,
        ellipticityMedian,
        regionFwhm,
        kernel: null,
        deconv: null,
        approximate,
        timings
    };

    events?.emit({
        kind: 'finding',
        finding: { kind: 'psf_measured', nStars: measured.length, fwhmMedianPx: +fwhmMed.toFixed(3) }
    });

    if (measured.length < 20) {
        approximate.push(`Only ${measured.length} usable stars (<20): deconvolution lane skipped — no kernel is trustworthy.`);
        return base;
    }

    // ── empirical kernel ──
    progress('PSF: stacking empirical kernel...');
    const kSize = 2 * boxR + 1;
    const kernelStars = measured.filter(s => Math.abs(s.fwhmMaj - fwhmMed) < 0.35 * fwhmMed).slice(0, 50);
    const kernelEmp = buildEmpiricalKernel(lum, w, h, kernelStars, kSize);
    if (!kernelEmp) {
        approximate.push('Kernel stack failed (<5 registerable stars) — deconvolution lane skipped.');
        return base;
    }
    const rlKernel: PsfKernel = truncateKernel(kernelEmp.k, kSize, 0.002);
    base.kernel = { size: rlKernel.size, nStars: kernelEmp.nStars ?? kernelStars.length };
    timings.kernel_ms = Date.now() - t0; t0 = Date.now();

    if (!deconvolve) return base;

    if (fwhmMed < 3.2) {
        approximate.push('RL runs at native resolution here; sub-2px tightening on undersampled frames needs the 2x-grid lane (tools/psf) and is not expressible in this panel.');
    }
    approximate.push(`RL computed on local ${2 * windowRadius + 1}px windows (clamp-to-edge), not full-frame — results differ near window borders; central measurements are unaffected at ${iters} iterations.`);

    // ── target selection: N brightest unsaturated + N worst-FWHM ──
    const byPeak = [...measured].sort((a, b) => b.peakAboveBg - a.peakAboveBg);
    const bright = byPeak.slice(0, tileCount);
    const brightSet = new Set(bright);
    const smeared = [...measured].sort((a, b) => b.fwhmMaj - a.fwhmMaj).filter(s => !brightSet.has(s)).slice(0, tileCount);
    const stripTarget = bright[0];

    const tiles: PsfDeconvTarget[] = [];
    let strip: PsfDeconvReport['strip'] = null;
    const afterFwhms: number[] = [];
    let improved = 0, remeasured = 0;

    const processTarget = async (
        s: PsfStarMeasure, kind: 'bright' | 'smeared', winR: number, wantStrip: boolean
    ): Promise<void> => {
        const cx = Math.round(s.cx), cy = Math.round(s.cy);
        const x0 = Math.max(0, cx - winR), y0 = Math.max(0, cy - winR);
        const x1 = Math.min(w, cx + winR + 1), y1 = Math.min(h, cy + winR + 1);
        const ww = x1 - x0, wh = y1 - y0;
        const win = new Float32Array(ww * wh);
        for (let j = 0; j < wh; j++) {
            win.set(lum.subarray((y0 + j) * w + x0, (y0 + j) * w + x1), j * ww);
        }
        const flat = flattenWindowPlane(win, ww, wh);
        // saturated-core freeze mask (neighbors in the window can be saturated)
        let mask: Uint8Array | null = null;
        let nSat = 0;
        const rawMask = new Uint8Array(ww * wh);
        for (let i = 0; i < win.length; i++) if (win[i] >= satLevel) { rawMask[i] = 1; nSat++; }
        if (nSat > 0) mask = dilateMask(rawMask, ww, wh, 4);

        const sigmaWin = pixelNoiseSigma(flat);
        // NEBULOSITY-PROTECTED RL (owner layers ruling 2026-07-10; ultracode
        // HELD #21): the plane flatten above removes the planar background,
        // but CURVED in-window diffuse structure (Hα/OIII/dust) survives it —
        // the protected variant splits that residual diffuse floor out via a
        // box blur at >>PSF scale, RL-sharpens only the compact component,
        // and adds the diffuse back VERBATIM. This is the nebulosity-LAYER
        // stub: when the render layer system lands, the preserved `diffuse`
        // component is the nebulosity layer feed. Deconv remains DEFAULT-OFF.
        const { estimate, snapshots, itersRun } = await richardsonLucyWindowProtected({
            obs: flat, w: ww, h: wh, kernel: rlKernel, iters,
            sigmaDamp: sigmaWin, mask,
            snapshotIters: wantStrip && captureSnapshots ? snapshotIters : [],
            yieldBetweenIters: true
        });

        const lcx = cx - x0, lcy = cy - y0;
        const after = remeasureAt(estimate, ww, wh, lcx, lcy, pixelNoiseSigma(estimate), boxR);
        remeasured++;
        if (after) {
            afterFwhms.push(after.fwhmMaj);
            if (after.fwhmMaj < s.fwhmMaj) improved++;
        }

        // tile crops (before from the NATIVE window, after from the estimate)
        const tileR = Math.max(12, Math.ceil(2.5 * fwhmMed));
        tiles.push({
            kind,
            cx: s.cx, cy: s.cy,
            region: regionNameFor(s.cx, s.cy, w, h),
            fwhmBefore: s.fwhmMaj,
            fwhmAfter: after ? after.fwhmMaj : null,
            ellipticityBefore: s.ellipticity,
            peakAboveBg: s.peakAboveBg,
            before: cropFrom(win, ww, wh, lcx, lcy, tileR),
            after: cropFrom(estimate, ww, wh, lcx, lcy, tileR)
        });

        if (wantStrip && captureSnapshots) {
            const stripR = Math.min(48, winR - 2);
            const stages: PsfStripStage[] = [];
            stages.push({
                label: 'NATIVE', iter: null,
                crop: cropFrom(win, ww, wh, lcx, lcy, stripR),
                fwhm: s.fwhmMaj
            });
            const flatM = remeasureAt(flat, ww, wh, lcx, lcy, sigmaWin, boxR);
            stages.push({
                label: 'BG-FLATTENED', iter: null,
                crop: cropFrom(flat, ww, wh, lcx, lcy, stripR),
                fwhm: flatM ? flatM.fwhmMaj : null
            });
            for (const snap of snapshots) {
                const m = remeasureAt(snap.data, ww, wh, lcx, lcy, pixelNoiseSigma(snap.data), boxR);
                stages.push({
                    label: `RL ${snap.iter}`, iter: snap.iter,
                    crop: cropFrom(snap.data, ww, wh, lcx, lcy, stripR),
                    fwhm: m ? m.fwhmMaj : null
                });
            }
            stages.push({
                label: `RL ${itersRun} (FINAL)`, iter: itersRun,
                crop: cropFrom(estimate, ww, wh, lcx, lcy, stripR),
                fwhm: after ? after.fwhmMaj : null
            });
            strip = { cx: s.cx, cy: s.cy, region: regionNameFor(s.cx, s.cy, w, h), stages };
        }
    };

    let done = 0;
    const total = bright.length + smeared.length;
    for (const s of bright) {
        progress(`PSF: deconvolving window ${++done}/${total} (bright)...`);
        await processTarget(s, 'bright', s === stripTarget ? stripWindowRadius : windowRadius, s === stripTarget);
    }
    for (const s of smeared) {
        progress(`PSF: deconvolving window ${++done}/${total} (smeared)...`);
        await processTarget(s, 'smeared', windowRadius, false);
    }
    timings.deconv_ms = Date.now() - t0;

    base.deconv = {
        itersRun: iters,
        kernelSize: rlKernel.size,
        windowRadius,
        strip,
        tiles,
        fwhmMedianAfterPx: afterFwhms.length ? medianOf(afterFwhms) : null,
        improved,
        remeasured
    };

    events?.emit({
        kind: 'finding',
        finding: {
            kind: 'psf_deconvolved',
            fwhmBeforePx: +fwhmMed.toFixed(3),
            fwhmAfterPx: base.deconv.fwhmMedianAfterPx != null ? +base.deconv.fwhmMedianAfterPx.toFixed(3) : null,
            itersRun: iters,
            windows: remeasured
        }
    });

    return base;
}
