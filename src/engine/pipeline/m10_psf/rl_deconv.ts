/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF — damped Richardson-Lucy deconvolution (windowed, browser-safe)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. RL runs on LUMINANCE windows of the NATIVE-grid science
 * buffer (no coordinate warp has touched these pixels).
 *
 * Port of tools/psf/deconv.mjs regularization, adapted from the Node
 * worker-pool/SharedArrayBuffer full-frame lane to bounded LOCAL WINDOWS so
 * it can run inside the wizard without freezing the tab:
 *   - damped updates: where |obs - conv| < 1.5 * noise sigma the
 *     multiplicative correction is smoothly pulled toward 1 (no noise pump);
 *   - ratio clamp [0.25, 4];
 *   - saturated-core freeze: masked pixels are reset to the observed value
 *     every iteration (kills ringing around blown cores).
 *
 * APPROXIMATE (labeled through PsfReport.approximate): windowed RL with
 * clamp-to-edge convolution differs from full-frame RL within ~one kernel
 * radius per iteration of the window border. Windows are padded so the
 * central measurement region is unaffected for the iteration counts used.
 */

import { PsfKernel } from './psf_core';

/** dst = src (*) kernel, clamp-to-edge. Direct convolution (window-sized inputs). */
export function convolve2d(
    src: Float32Array, dst: Float32Array, w: number, h: number,
    k: ArrayLike<number>, ks: number
): void {
    const R = (ks - 1) / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let j = 0; j < ks; j++) {
                let sy = y + j - R;
                if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
                const srow = sy * w, krow = j * ks;
                for (let i = 0; i < ks; i++) {
                    let sx = x + i - R;
                    if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
                    acc += src[srow + sx] * (k[krow + i] as number);
                }
            }
            dst[y * w + x] = acc;
        }
    }
}

/** Chebyshev (square) dilation of a 0/1 mask by `r` px via separable max. */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const tmp = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let m = 0;
            const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
            for (let i = x0; i <= x1; i++) if (mask[row + i]) { m = 1; break; }
            tmp[row + x] = m;
        }
    }
    const out = new Uint8Array(mask.length);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let m = 0;
            const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
            for (let j = y0; j <= y1; j++) if (tmp[j * w + x]) { m = 1; break; }
            out[y * w + x] = m;
        }
    }
    return out;
}

export interface RlSnapshot {
    /** RL iteration this snapshot was taken AFTER (1-based). */
    iter: number;
    data: Float32Array;
}

export interface RlWindowParams {
    obs: Float32Array;          // observed window (>= 0 recommended)
    w: number; h: number;
    kernel: PsfKernel;
    iters: number;
    sigmaDamp: number;          // pixel noise sigma driving the damping band
    mask?: Uint8Array | null;   // saturated-core freeze mask (1 = frozen)
    /** Capture a copy of the estimate after these iterations (cheap opt-in — owner directive). */
    snapshotIters?: number[];
    /** Yield to the event loop between iterations (keeps the wizard tab alive). */
    yieldBetweenIters?: boolean;
}

export interface RlWindowResult {
    estimate: Float32Array;
    snapshots: RlSnapshot[];
    itersRun: number;
}

/**
 * Separable box-mean blur, clamp-to-edge (O(1)/px running sums). Used to
 * estimate the EXTENDED diffuse component of a window (nebulosity/gradient) at
 * a scale >> the PSF — a compact star's flux is diluted across the box and
 * contributes negligibly, so the estimate is essentially the diffuse floor.
 */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
    if (r < 1) return Float32Array.from(src);
    const tmp = new Float32Array(w * h);
    const win = 2 * r + 1;
    // horizontal
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, i))];
        for (let x = 0; x < w; x++) {
            tmp[row + x] = acc / win;
            const xOut = Math.max(0, Math.min(w - 1, x - r));
            const xIn = Math.max(0, Math.min(w - 1, x + r + 1));
            acc += src[row + xIn] - src[row + xOut];
        }
    }
    // vertical
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += tmp[Math.min(h - 1, Math.max(0, j)) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc / win;
            const yOut = Math.max(0, Math.min(h - 1, y - r));
            const yIn = Math.max(0, Math.min(h - 1, y + r + 1));
            acc += tmp[yIn * w + x] - tmp[yOut * w + x];
        }
    }
    return out;
}

export interface RlProtectedResult extends RlWindowResult {
    /** The extended/diffuse component preserved verbatim (added back post-RL). */
    diffuse: Float32Array;
    /** Box-blur radius used for the diffuse split. */
    diffuseRadius: number;
}

/**
 * NEBULOSITY-PROTECTED damped Richardson-Lucy (owner rule: Hα/OIII/dust ARE
 * signal — deconvolution must never flatten or ring real astronomical color).
 *
 * THE LIVE VARIANT: psf_stage's deconv lane (DEFAULT-OFF) calls THIS, not the
 * raw `richardsonLucyWindow` (wired 2026-07-10, ultracode HELD #21 — the raw
 * variant is now the inner engine here plus tools/test lanes only). The
 * preserved `diffuse` component doubles as the nebulosity-LAYER stub for the
 * render layer system (owner layers ruling 2026-07-10).
 *
 * Splits the window into an EXTENDED diffuse component (box blur at a scale
 * >> PSF) and a COMPACT residual (stars, = obs − diffuse, clamped ≥ 0). RL
 * sharpens ONLY the compact residual; the diffuse floor is added back
 * UNTOUCHED. In a star-free region compact ≈ 0, so the output ≈ the input
 * diffuse — nebulosity passes through by construction (this is the render-law
 * star/background separation applied to the deconvolution window).
 */
export async function richardsonLucyWindowProtected(
    p: RlWindowParams & { diffuseRadius?: number }
): Promise<RlProtectedResult> {
    const { obs, w, h } = p;
    const kR = (p.kernel.size - 1) / 2;
    // Diffuse scale must be >> PSF so a star barely perturbs the estimate.
    const dR = Math.max(8, Math.round(p.diffuseRadius ?? 4 * kR));
    const diffuse = boxBlur(obs, w, h, dR);
    const compact = new Float32Array(obs.length);
    for (let i = 0; i < obs.length; i++) {
        const c = obs[i] - diffuse[i];
        compact[i] = c > 0 ? c : 0; // RL needs non-negative; stars sit above the diffuse floor
    }
    const rl = await richardsonLucyWindow({ ...p, obs: compact });
    const estimate = new Float32Array(obs.length);
    for (let i = 0; i < obs.length; i++) estimate[i] = rl.estimate[i] + diffuse[i];
    // Recombine snapshots too, so any strip visualization stays honest.
    const snapshots = rl.snapshots.map(s => {
        const d = new Float32Array(s.data.length);
        for (let i = 0; i < d.length; i++) d[i] = s.data[i] + diffuse[i];
        return { iter: s.iter, data: d };
    });
    return { estimate, snapshots, itersRun: rl.itersRun, diffuse, diffuseRadius: dR };
}

/**
 * Damped Richardson-Lucy on one window — the RAW/UNPROTECTED inner engine.
 * NOT the live wizard path: psf_stage uses `richardsonLucyWindowProtected`
 * (which wraps this after the diffuse/compact split). Direct callers are the
 * protected wrapper, unit tests, and the tools/deblur research lane.
 */
export async function richardsonLucyWindow(p: RlWindowParams): Promise<RlWindowResult> {
    const { obs, w, h, kernel, iters, sigmaDamp, mask } = p;
    const wantSnap = new Set(p.snapshotIters ?? []);
    const n = w * h;
    const est = new Float32Array(n);
    const tmp1 = new Float32Array(n);
    const tmp2 = new Float32Array(n);
    est.set(obs);
    const K = kernel.k, ks = kernel.size;
    // mirrored kernel for the correlation step
    const Km = new Float64Array(ks * ks);
    for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) Km[j * ks + i] = K[(ks - 1 - j) * ks + (ks - 1 - i)];

    const eps = 1e-8;
    const dampLim = 1.5 * sigmaDamp;
    const snapshots: RlSnapshot[] = [];

    for (let it = 0; it < iters; it++) {
        convolve2d(est, tmp1, w, h, K, ks);
        // ratio + damping in place on tmp1
        for (let i = 0; i < n; i++) {
            const c = tmp1[i];
            const o = obs[i];
            let ratio = o / (c > eps ? c : eps);
            const ad = Math.abs(o - c);
            if (ad < dampLim) {
                const t = ad / dampLim;
                const s = t * t * (3 - 2 * t);
                ratio = 1 + (ratio - 1) * s;
            }
            if (ratio < 0.25) ratio = 0.25; else if (ratio > 4) ratio = 4;
            tmp1[i] = ratio;
        }
        convolve2d(tmp1, tmp2, w, h, Km, ks);
        if (mask) {
            for (let i = 0; i < n; i++) {
                let v = est[i] * tmp2[i];
                if (v < 0) v = 0;
                est[i] = mask[i] ? obs[i] : v;
            }
        } else {
            for (let i = 0; i < n; i++) {
                const v = est[i] * tmp2[i];
                est[i] = v < 0 ? 0 : v;
            }
        }
        if (wantSnap.has(it + 1)) snapshots.push({ iter: it + 1, data: Float32Array.from(est) });
        if (p.yieldBetweenIters) await new Promise<void>(r => setTimeout(r, 0));
    }
    return { estimate: est, snapshots, itersRun: iters };
}
