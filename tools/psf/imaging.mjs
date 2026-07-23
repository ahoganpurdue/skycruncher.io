// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — shared imaging primitives (stats, PNG, stretch, renders, poly fit)
// ═══════════════════════════════════════════════════════════════════════════
// All processing stays LINEAR; the display stretch here is applied only when
// baking bytes for output PNGs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ── statistics ──────────────────────────────────────────────────────────────

/** Sampled copy of arr (stride so that <= maxN samples), sorted ascending. */
export function sortedSample(arr, maxN = 300000) {
    const step = Math.max(1, Math.floor(arr.length / maxN));
    const out = new Float64Array(Math.ceil(arr.length / step));
    let k = 0;
    for (let i = 0; i < arr.length; i += step) out[k++] = arr[i];
    const s = out.subarray(0, k);
    s.sort();
    return s;
}

export function pctOf(sorted, p) {
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))];
}

/** Robust {med, sigma} via median + 1.4826*MAD on a sampled copy. */
export function robustStats(arr, maxN = 200000) {
    const s = sortedSample(arr, maxN);
    const med = pctOf(s, 0.5);
    const dev = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
    dev.sort();
    const sigma = 1.4826 * dev[dev.length >> 1];
    return { med, sigma: sigma > 0 ? sigma : 1e-6 };
}

export function bilinearSample(arr, w, h, x, y) {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0;
    if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 >= w - 1) { x0 = w - 2; fx = 1; }
    if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= h - 1) { y0 = h - 2; fy = 1; }
    const i = y0 * w + x0;
    return arr[i] * (1 - fx) * (1 - fy) + arr[i + 1] * fx * (1 - fy)
        + arr[i + w] * (1 - fx) * fy + arr[i + w + 1] * fx * fy;
}

// ── coarse cell medians (background / vignette measurement grid) ────────────

/** Median of sampled pixels per cell of size `cell` px. Returns cell centers too. */
export function cellMedians(chan, w, h, cell = 64, step = 3) {
    const nx = Math.floor(w / cell), ny = Math.floor(h / cell);
    const med = new Float64Array(nx * ny);
    const cx = new Float64Array(nx * ny), cy = new Float64Array(nx * ny);
    const buf = [];
    for (let gy = 0; gy < ny; gy++) {
        for (let gx = 0; gx < nx; gx++) {
            buf.length = 0;
            const x0 = gx * cell, y0 = gy * cell;
            for (let y = y0; y < y0 + cell; y += step) {
                const row = y * w;
                for (let x = x0; x < x0 + cell; x += step) buf.push(chan[row + x]);
            }
            buf.sort((a, b) => a - b);
            const g = gy * nx + gx;
            med[g] = buf[buf.length >> 1];
            cx[g] = x0 + cell / 2;
            cy[g] = y0 + cell / 2;
        }
    }
    return { nx, ny, med, cx, cy, cell };
}

// ── linear algebra: least squares 2D polynomial ─────────────────────────────

export function solveLinear(A, b, n) {
    // Gaussian elimination with partial pivoting; A row-major n*n, mutated.
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[piv * n + col])) piv = r;
        if (Math.abs(A[piv * n + col]) < 1e-12) return null;
        if (piv !== col) {
            for (let c = 0; c < n; c++) { const t = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = t; }
            const t = b[col]; b[col] = b[piv]; b[piv] = t;
        }
        const d = A[col * n + col];
        for (let r = col + 1; r < n; r++) {
            const f = A[r * n + col] / d;
            if (f === 0) continue;
            for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
            b[r] -= f * b[col];
        }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let s = b[r];
        for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
        x[r] = s / A[r * n + r];
    }
    return x;
}

/** Monomial exponent list for a total-degree-`deg` 2D polynomial. */
export function polyTerms2D(deg) {
    const t = [];
    for (let d = 0; d <= deg; d++) for (let ix = d; ix >= 0; ix--) t.push([ix, d - ix]);
    return t; // deg 3 -> 10 terms
}

/** Weighted least-squares fit v ~ poly(x, y). xs/ys expected pre-normalized ~[-1,1]. */
export function fitPoly2D(xs, ys, vs, use, deg) {
    const terms = polyTerms2D(deg);
    const n = terms.length;
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    const basis = new Float64Array(n);
    for (let i = 0; i < xs.length; i++) {
        if (use && !use[i]) continue;
        const x = xs[i], y = ys[i];
        for (let t = 0; t < n; t++) basis[t] = Math.pow(x, terms[t][0]) * Math.pow(y, terms[t][1]);
        for (let r = 0; r < n; r++) {
            b[r] += basis[r] * vs[i];
            for (let c = r; c < n; c++) A[r * n + c] += basis[r] * basis[c];
        }
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < r; c++) A[r * n + c] = A[c * n + r];
    const coef = solveLinear(A, b, n);
    return coef ? { coef, terms } : null;
}

export function evalPoly2D(fit, x, y) {
    let v = 0;
    for (let t = 0; t < fit.terms.length; t++) v += fit.coef[t] * Math.pow(x, fit.terms[t][0]) * Math.pow(y, fit.terms[t][1]);
    return v;
}

// ── display stretch + renders ───────────────────────────────────────────────

/** Percentile stretch parameters per channel, computed from the BEFORE image. */
export function makeStretch(channels, loP = 0.01, hiP = 0.998) {
    const lo = [], hi = [];
    for (const ch of channels) {
        const s = sortedSample(ch, 200000);
        lo.push(pctOf(s, loP));
        hi.push(Math.max(pctOf(s, hiP), pctOf(s, loP) + 1e-6));
    }
    return { lo, hi, loP, hiP, gamma: 2.2 };
}

function stretchByte(v, lo, hi, invGamma) {
    let s = (v - lo) / (hi - lo);
    if (s <= 0) return 0;
    if (s >= 1) return 255;
    return Math.round(255 * Math.pow(s, invGamma));
}

/** Box-downscale linear RGB planes to outW wide, then stretch to bytes. */
export function downscaleRGB(R, G, B, w, h, outW, stretch) {
    const scale = outW / w;
    const ow = outW, oh = Math.max(1, Math.round(h * scale));
    const accR = new Float64Array(ow * oh), accG = new Float64Array(ow * oh),
        accB = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
    for (let y = 0; y < h; y++) {
        const oy = Math.min(oh - 1, Math.floor(y * scale));
        const row = y * w, orow = oy * ow;
        for (let x = 0; x < w; x++) {
            const o = orow + Math.min(ow - 1, Math.floor(x * scale));
            accR[o] += R[row + x]; accG[o] += G[row + x]; accB[o] += B[row + x]; cnt[o]++;
        }
    }
    const bytes = new Uint8Array(ow * oh * 3);
    const ig = 1 / stretch.gamma;
    for (let i = 0; i < ow * oh; i++) {
        const c = cnt[i] || 1;
        bytes[i * 3] = stretchByte(accR[i] / c, stretch.lo[0], stretch.hi[0], ig);
        bytes[i * 3 + 1] = stretchByte(accG[i] / c, stretch.lo[1], stretch.hi[1], ig);
        bytes[i * 3 + 2] = stretchByte(accB[i] / c, stretch.lo[2], stretch.hi[2], ig);
    }
    return { bytes, ow, oh, scale };
}

/** 1:1 crop of linear RGB planes -> stretched bytes. */
export function cropRGB(R, G, B, w, h, x0, y0, size, stretch) {
    x0 = Math.max(0, Math.min(w - size, Math.round(x0)));
    y0 = Math.max(0, Math.min(h - size, Math.round(y0)));
    const bytes = new Uint8Array(size * size * 3);
    const ig = 1 / stretch.gamma;
    for (let y = 0; y < size; y++) {
        const row = (y0 + y) * w + x0;
        for (let x = 0; x < size; x++) {
            const i = row + x, o = (y * size + x) * 3;
            bytes[o] = stretchByte(R[i], stretch.lo[0], stretch.hi[0], ig);
            bytes[o + 1] = stretchByte(G[i], stretch.lo[1], stretch.hi[1], ig);
            bytes[o + 2] = stretchByte(B[i], stretch.lo[2], stretch.hi[2], ig);
        }
    }
    return { bytes, x0, y0, size };
}

/** Alpha-blend a plotted point onto an RGB byte canvas. */
export function plotPoint(bytes, ow, oh, x, y, rgb, alpha = 0.85) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= ow || yi >= oh) return;
    const o = (yi * ow + xi) * 3;
    for (let c = 0; c < 3; c++) bytes[o + c] = Math.round(bytes[o + c] * (1 - alpha) + rgb[c] * alpha);
}

/** Draw a polyline given as [[x,y]...] in canvas coordinates. */
export function drawPolyline(bytes, ow, oh, pts, rgb, alpha = 0.85) {
    for (let i = 0; i + 1 < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
        for (let s = 0; s <= n; s++) plotPoint(bytes, ow, oh, x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n, rgb, alpha);
    }
}

// ── minimal PNG encoder (pattern: tools/repro/render_fits.mjs) ──────────────

function crc32(buf) {
    let c;
    const t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    c = 0xFFFFFFFF;
    for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** Write 8-bit RGB PNG. */
export function writePNG(outPath, bytes, w, h) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit, color type 2 (RGB)
    const raw = Buffer.alloc(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        Buffer.from(bytes.buffer, bytes.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
    }
    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
    return png.length;
}

/** Write an 8-bit grayscale-as-RGB mask PNG from a Uint8 mask (0/1). */
export function writeMaskPNG(outPath, mask, w, h, outW) {
    const scale = outW / w;
    const ow = outW, oh = Math.max(1, Math.round(h * scale));
    const acc = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
    for (let y = 0; y < h; y++) {
        const oy = Math.min(oh - 1, Math.floor(y * scale));
        const row = y * w, orow = oy * ow;
        for (let x = 0; x < w; x++) {
            const o = orow + Math.min(ow - 1, Math.floor(x * scale));
            acc[o] += mask[row + x]; cnt[o]++;
        }
    }
    const bytes = new Uint8Array(ow * oh * 3);
    for (let i = 0; i < ow * oh; i++) {
        const v = Math.min(255, Math.round(255 * (acc[i] / (cnt[i] || 1)) * 4)); // 4x boost: sparse masks stay visible
        bytes[i * 3] = v; bytes[i * 3 + 1] = v; bytes[i * 3 + 2] = v;
    }
    return writePNG(outPath, bytes, ow, oh);
}
