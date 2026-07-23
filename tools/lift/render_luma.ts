/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LUMA RENDER HELPERS (tools lane) — pure math for the nebulosity-lift eyes-on
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns a single-channel luminance Float32 buffer into a downsampled, robustly
 * auto-scaled 8-bit grayscale raster for VISUAL inspection (the one-frame law:
 * SEE the lifted band before trusting the lift). No PNG dependency lives here —
 * the caller encodes the returned RGBA bytes (pngjs) — so this stays fully typed.
 */

export interface DownsampledLuma { data: Float32Array; width: number; height: number; }

/** Box-average downsample so the whole frame fits within `maxDim` on its long side. */
export function downsampleLuma(luma: Float32Array, w: number, h: number, maxDim: number): DownsampledLuma {
    const factor = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
    if (factor === 1) return { data: luma, width: w, height: h };
    const dw = Math.max(1, Math.floor(w / factor));
    const dh = Math.max(1, Math.floor(h / factor));
    const out = new Float32Array(dw * dh);
    for (let dy = 0; dy < dh; dy++) {
        for (let dx = 0; dx < dw; dx++) {
            let sum = 0, n = 0;
            const y0 = dy * factor, x0 = dx * factor;
            for (let y = y0; y < Math.min(h, y0 + factor); y++) {
                const row = y * w;
                for (let x = x0; x < Math.min(w, x0 + factor); x++) {
                    const v = luma[row + x];
                    if (Number.isFinite(v)) { sum += v; n++; }
                }
            }
            out[dy * dw + dx] = n > 0 ? sum / n : 0;
        }
    }
    return { data: out, width: dw, height: dh };
}

/** Robust percentile of a Float32 buffer (copies + sorts a subsample of ≤ n). */
export function robustPercentile(a: Float32Array, q: number, maxN = 200000): number {
    const step = Math.max(1, Math.floor(a.length / maxN));
    const s: number[] = [];
    for (let i = 0; i < a.length; i += step) { const v = a[i]; if (Number.isFinite(v)) s.push(v); }
    if (s.length === 0) return 0;
    s.sort((x, y) => x - y);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[idx];
}

export interface AutoscaleOptions {
    /** Black-point percentile (default 0.10 — clip the sky floor). */
    loPct?: number;
    /** White-point percentile (default 0.999 — keep bright stars from clipping the window). */
    hiPct?: number;
    /** Display gamma (default 1/2.2). */
    gamma?: number;
}

/**
 * Map a luma buffer to 8-bit gray via a robust [loPct, hiPct] window + gamma.
 * Returns { gray: Uint8Array(w*h), lo, hi } so the same window can be reused
 * across before/after frames for a fair side-by-side comparison.
 */
export function autoscaleToGray8(
    luma: Float32Array,
    opts: AutoscaleOptions = {},
    fixedLo?: number,
    fixedHi?: number,
): { gray: Uint8Array; lo: number; hi: number } {
    const gamma = opts.gamma ?? 1 / 2.2;
    const lo = fixedLo ?? robustPercentile(luma, opts.loPct ?? 0.10);
    const hi = fixedHi ?? robustPercentile(luma, opts.hiPct ?? 0.999);
    const span = hi - lo > 1e-9 ? hi - lo : 1;
    const gray = new Uint8Array(luma.length);
    for (let i = 0; i < luma.length; i++) {
        let t = (luma[i] - lo) / span;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        gray[i] = Math.round(Math.pow(t, gamma) * 255);
    }
    return { gray, lo, hi };
}

/** Expand a gray8 buffer to RGBA bytes (w*h*4) for a PNG encoder. */
export function gray8ToRgba(gray: Uint8Array): Uint8Array {
    const rgba = new Uint8Array(gray.length * 4);
    for (let i = 0; i < gray.length; i++) {
        const g = gray[i];
        rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

export interface Peak { x: number; y: number; value: number; }

/**
 * Greedy top-N local maxima with a minimum separation — a cheap PROXY for the
 * detector's flux ranking (the real detector runs downstream). Used by the
 * eyes-on to check the coordinator's success criterion: after the lift, do the
 * brightest peaks spread across the field (real stars) instead of clustering on
 * the band? Scans a downsampled buffer for speed.
 */
export function topLocalMaxima(luma: Float32Array, w: number, h: number, n: number, minSep: number): Peak[] {
    const cands: Peak[] = [];
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const v = luma[y * w + x];
            if (!Number.isFinite(v)) continue;
            // 8-neighbour local max
            if (
                v >= luma[(y - 1) * w + x] && v >= luma[(y + 1) * w + x] &&
                v >= luma[y * w + x - 1] && v >= luma[y * w + x + 1] &&
                v >= luma[(y - 1) * w + x - 1] && v >= luma[(y - 1) * w + x + 1] &&
                v >= luma[(y + 1) * w + x - 1] && v >= luma[(y + 1) * w + x + 1]
            ) cands.push({ x, y, value: v });
        }
    }
    cands.sort((a, b) => b.value - a.value);
    const picked: Peak[] = [];
    const sep2 = minSep * minSep;
    for (const c of cands) {
        if (picked.length >= n) break;
        let ok = true;
        for (const p of picked) {
            const dx = p.x - c.x, dy = p.y - c.y;
            if (dx * dx + dy * dy < sep2) { ok = false; break; }
        }
        if (ok) picked.push(c);
    }
    return picked;
}

/** Spatial spread (stddev of x + stddev of y, in px) of a peak set — band-clustered ⇒ small. */
export function peakSpread(peaks: Peak[], w: number, h: number): { sx: number; sy: number; sxNorm: number; syNorm: number } {
    if (peaks.length === 0) return { sx: 0, sy: 0, sxNorm: 0, syNorm: 0 };
    const mx = peaks.reduce((s, p) => s + p.x, 0) / peaks.length;
    const my = peaks.reduce((s, p) => s + p.y, 0) / peaks.length;
    const vx = peaks.reduce((s, p) => s + (p.x - mx) ** 2, 0) / peaks.length;
    const vy = peaks.reduce((s, p) => s + (p.y - my) ** 2, 0) / peaks.length;
    const sx = Math.sqrt(vx), sy = Math.sqrt(vy);
    return { sx, sy, sxNorm: sx / w, syNorm: sy / h };
}
