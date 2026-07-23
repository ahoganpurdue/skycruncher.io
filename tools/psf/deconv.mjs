// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — damped Richardson-Lucy deconvolution with a worker-pool conv
// ═══════════════════════════════════════════════════════════════════════════
// RL runs on the LUMINANCE of the cleaned NATIVE-grid image (no coordinate
// warp has touched these pixels). The frame is undersampled, so the estimate
// is optionally computed on a 2x bilinear-upsampled grid and box-downsampled
// afterwards so tightening below ~2 px FWHM is expressible.
//
// Regularization:
//   - damped updates: where |obs - conv| < 1.5 * noise sigma the
//     multiplicative correction is smoothly pulled toward 1 (no noise pump);
//   - ratio clamp [0.25, 4];
//   - saturated-core freeze: masked pixels are reset to the observed value
//     every iteration (kills the classic ringing around blown star cores).

import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class ConvPool {
    constructor(n = Math.max(1, Math.min(10, os.cpus().length - 2))) {
        this.workers = [];
        this.pending = new Map();
        this.jobSeq = 0;
        for (let i = 0; i < n; i++) {
            const wk = new Worker(path.join(HERE, 'conv_worker.mjs'));
            wk.on('message', (m) => {
                const res = this.pending.get(m.jobId);
                if (res) { this.pending.delete(m.jobId); res(); }
            });
            this.workers.push(wk);
        }
    }

    get size() { return this.workers.length; }

    runBand(wk, msg) {
        return new Promise((resolve) => {
            this.pending.set(msg.jobId, resolve);
            wk.postMessage(msg);
        });
    }

    /** dst = src (*) kernel, clamp-to-edge; both are SharedArrayBuffers. */
    async conv(sabIn, sabOut, w, h, k, kw, kh) {
        const bands = this.workers.length;
        const rows = Math.ceil(h / bands);
        const ps = [];
        for (let b = 0; b < bands; b++) {
            const y0 = b * rows, y1 = Math.min(h, y0 + rows);
            if (y0 >= y1) break;
            ps.push(this.runBand(this.workers[b], {
                jobId: ++this.jobSeq, sabIn, sabOut, w, h, y0, y1, kw, kh, k: Float32Array.from(k),
            }));
        }
        await Promise.all(ps);
    }

    async destroy() {
        await Promise.all(this.workers.map((w) => w.terminate()));
        this.workers = [];
    }
}

export function sabFloat32(n) {
    return new Float32Array(new SharedArrayBuffer(n * 4));
}

/** Bilinear 2x upsample into a SAB-backed Float32Array. */
export function upsample2x(src, w, h) {
    const W = w * 2, H = h * 2;
    const out = sabFloat32(W * H);
    for (let y = 0; y < H; y++) {
        let sy = (y + 0.5) / 2 - 0.5;
        if (sy < 0) sy = 0; if (sy > h - 1) sy = h - 1;
        const y0 = Math.min(h - 2, Math.floor(sy)), fy = sy - y0;
        const r0 = y0 * w, r1 = (y0 + 1) * w, orow = y * W;
        for (let x = 0; x < W; x++) {
            let sx = (x + 0.5) / 2 - 0.5;
            if (sx < 0) sx = 0; if (sx > w - 1) sx = w - 1;
            const x0 = Math.min(w - 2, Math.floor(sx)), fx = sx - x0;
            out[orow + x] = src[r0 + x0] * (1 - fx) * (1 - fy) + src[r0 + x0 + 1] * fx * (1 - fy)
                + src[r1 + x0] * (1 - fx) * fy + src[r1 + x0 + 1] * fx * fy;
        }
    }
    return { arr: out, w: W, h: H };
}

/** 2x2 box downsample. */
export function downsample2x(src, W, H) {
    const w = W >> 1, h = H >> 1;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const r0 = (2 * y) * W, r1 = (2 * y + 1) * W, orow = y * w;
        for (let x = 0; x < w; x++) {
            const c = 2 * x;
            out[orow + x] = 0.25 * (src[r0 + c] + src[r0 + c + 1] + src[r1 + c] + src[r1 + c + 1]);
        }
    }
    return out;
}

/**
 * Damped Richardson-Lucy.
 * @param {Float32Array} obs   SAB-backed observed image (>= 0)
 * @param {Uint8Array|null} mask  freeze mask (saturated cores, dilated)
 * @returns {Float32Array} estimate (SAB-backed)
 */
export async function richardsonLucy({ obs, w, h, kernel, iters, sigmaDamp, mask, pool, log = () => { } }) {
    const n = w * h;
    const est = sabFloat32(n);
    const tmp1 = sabFloat32(n);
    const tmp2 = sabFloat32(n);
    est.set(obs);
    const K = kernel.k, ks = kernel.size;
    const Km = new Float64Array(ks * ks);
    for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) Km[j * ks + i] = K[(ks - 1 - j) * ks + (ks - 1 - i)];

    const eps = 1e-8;
    const dampLim = 1.5 * sigmaDamp;
    for (let it = 0; it < iters; it++) {
        const t0 = Date.now();
        await pool.conv(est.buffer, tmp1.buffer, w, h, K, ks, ks);
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
        await pool.conv(tmp1.buffer, tmp2.buffer, w, h, Km, ks, ks);
        if (mask) {
            for (let i = 0; i < n; i++) {
                let v = est[i] * tmp2[i];
                if (v < 0) v = 0;
                est[i] = mask[i] ? obs[i] : v;
            }
        } else {
            for (let i = 0; i < n; i++) {
                let v = est[i] * tmp2[i];
                est[i] = v < 0 ? 0 : v;
            }
        }
        log(`    RL iter ${it + 1}/${iters} (${Date.now() - t0} ms)`);
    }
    return est;
}

/** Chebyshev (square) dilation of a 0/1 mask by `r` px via separable max. */
export function dilateMask(mask, w, h, r) {
    const tmp = new Uint8Array(mask.length);
    // horizontal
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
