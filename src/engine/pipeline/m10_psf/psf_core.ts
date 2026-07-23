/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF — measurement primitives (ported from tools/psf/psf.mjs, verified
 * headless lane 2026-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Every measurement happens on the NATIVE untouched pixel
 * grid — coordinate corrections (distortion) are functions applied to
 * POSITIONS elsewhere, never to the pixels measured here (owner architecture
 * law: coordinate/pixel separation).
 *
 * Port fidelity: algorithm and thresholds are byte-for-byte the tools/psf
 * lane (moment-based FWHM, border-median local background, 1.5-sigma moment
 * gate, sigma-clipped empirical kernel). Only the module system and types
 * changed.
 */

export interface PsfPeak { x: number; y: number; v: number; }

export interface PsfStarMeasure {
    cx: number; cy: number;
    bgLoc: number;
    peak: number;
    peakAboveBg: number;
    flux: number;
    fwhmMaj: number;
    fwhmMin: number;
    ellipticity: number;
    thetaDeg: number;
}

/** Bilinear sample with edge clamp (pixel lane; used by kernel registration). */
export function bilinearSample(L: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
    let sx = x, sy = y;
    if (sx < 0) sx = 0; if (sx > w - 1) sx = w - 1;
    if (sy < 0) sy = 0; if (sy > h - 1) sy = h - 1;
    const x0 = Math.min(w - 2, Math.floor(sx)), fx = sx - x0;
    const y0 = Math.min(h - 2, Math.floor(sy)), fy = sy - y0;
    const r0 = y0 * w, r1 = (y0 + 1) * w;
    return L[r0 + x0] * (1 - fx) * (1 - fy) + L[r0 + x0 + 1] * fx * (1 - fy)
        + L[r1 + x0] * (1 - fx) * fy + L[r1 + x0 + 1] * fx * fy;
}

/** Robust stats: median + MAD-sigma over a stride-sampled copy. */
export function robustStats(data: ArrayLike<number>, maxN = 200000): { med: number; sigma: number } {
    const step = Math.max(1, Math.floor(data.length / maxN));
    const sample: number[] = [];
    for (let i = 0; i < data.length; i += step) sample.push(data[i]);
    sample.sort((a, b) => a - b);
    const med = sample[sample.length >> 1] ?? 0;
    const dev = sample.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return { med, sigma: 1.4826 * (dev[dev.length >> 1] ?? 0) };
}

/** Pixel-to-pixel noise sigma via horizontal-difference MAD (structure-immune). */
export function pixelNoiseSigma(L: ArrayLike<number>, maxN = 200000): number {
    const step = Math.max(1, Math.floor(L.length / maxN));
    const d: number[] = [];
    for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i]));
    d.sort((a, b) => a - b);
    return Math.max(1e-8, 1.4826 * (d[d.length >> 1] ?? 0) / Math.SQRT2);
}

/** Local maxima above `thresh`, brightest first, capped. */
export function findMaxima(L: ArrayLike<number>, w: number, h: number, thresh: number, cap = 60000, margin = 8): PsfPeak[] {
    const out: PsfPeak[] = [];
    for (let y = margin; y < h - margin; y++) {
        const row = y * w;
        for (let x = margin; x < w - margin; x++) {
            const v = L[row + x];
            if (v <= thresh) continue;
            if (v > L[row + x - 1] && v >= L[row + x + 1]
                && v > L[row - w + x] && v >= L[row + w + x]
                && v > L[row - w + x - 1] && v > L[row - w + x + 1]
                && v >= L[row + w + x - 1] && v >= L[row + w + x + 1]) {
                out.push({ x, y, v });
            }
        }
    }
    out.sort((a, b) => b.v - a.v);
    return out.length > cap ? out.slice(0, cap) : out;
}

/** Spatial hash for neighbor queries. */
export interface NeighborIndex {
    map: Map<number, number[]>;
    cellSize: number;
    points: { x: number; y: number }[];
}

export function buildNeighborIndex(points: { x: number; y: number }[], cellSize: number): NeighborIndex {
    const map = new Map<number, number[]>();
    for (let i = 0; i < points.length; i++) {
        const key = (points[i].x / cellSize | 0) * 100000 + (points[i].y / cellSize | 0);
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(i);
    }
    return { map, cellSize, points };
}

export function hasNeighborWithin(idx: NeighborIndex, x: number, y: number, r: number, selfIndex: number): boolean {
    const { map, cellSize, points } = idx;
    const gx = x / cellSize | 0, gy = y / cellSize | 0;
    const reach = Math.ceil(r / cellSize);
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const arr = map.get((gx + dx) * 100000 + (gy + dy));
            if (!arr) continue;
            for (const i of arr) {
                if (i === selfIndex) continue;
                const p = points[i];
                if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < r * r) return true;
            }
        }
    }
    return false;
}

/**
 * Moment-based PSF measurement on a (2*boxR+1)^2 cutout centered on an
 * integer peak. Local background = median of the cutout border ring; pixels
 * below 1.5 sigma are excluded from the moments (noise-bias control).
 * FWHM along principal axes from the eigenvalues of the second-moment matrix.
 */
export function measureStar(L: ArrayLike<number>, w: number, h: number, px: number, py: number, sigmaN: number, boxR = 7): PsfStarMeasure | null {
    if (px < boxR + 2 || py < boxR + 2 || px >= w - boxR - 2 || py >= h - boxR - 2) return null;
    const n = 2 * boxR + 1;
    const cut = new Float64Array(n * n);
    const border: number[] = [];
    let peak = -Infinity;
    for (let j = 0; j < n; j++) {
        const src = (py + j - boxR) * w + px - boxR;
        for (let i = 0; i < n; i++) {
            const v = L[src + i];
            cut[j * n + i] = v;
            if (v > peak) peak = v;
            if (j === 0 || j === n - 1 || i === 0 || i === n - 1) border.push(v);
        }
    }
    border.sort((a, b) => a - b);
    const bgLoc = border[border.length >> 1];
    const thr = 1.5 * sigmaN;

    let sw = 0, sx = 0, sy = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const t = cut[j * n + i] - bgLoc;
        if (t > thr) { sw += t; sx += t * i; sy += t * j; }
    }
    if (sw <= 0) return null;
    const cxl = sx / sw, cyl = sy / sw;
    if (Math.abs(cxl - boxR) > 2.5 || Math.abs(cyl - boxR) > 2.5) return null; // centroid ran away: blended/garbage

    let mxx = 0, myy = 0, mxy = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const t = cut[j * n + i] - bgLoc;
        if (t > thr) {
            const dx = i - cxl, dy = j - cyl;
            mxx += t * dx * dx; myy += t * dy * dy; mxy += t * dx * dy;
        }
    }
    mxx /= sw; myy /= sw; mxy /= sw;
    const disc = Math.sqrt(Math.max(0, (mxx - myy) * (mxx - myy) / 4 + mxy * mxy));
    const l1 = (mxx + myy) / 2 + disc, l2 = (mxx + myy) / 2 - disc;
    if (!(l1 > 0) || !(l2 > 0)) return null;
    const FW = 2 * Math.sqrt(2 * Math.log(2)); // 2.3548
    const fwhmMaj = FW * Math.sqrt(l1), fwhmMin = FW * Math.sqrt(l2);
    const theta = 0.5 * Math.atan2(2 * mxy, mxx - myy);

    let flux = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const dx = i - cxl, dy = j - cyl;
        if (dx * dx + dy * dy <= 25) {
            const t = cut[j * n + i] - bgLoc;
            if (t > 0) flux += t;
        }
    }
    return {
        cx: px - boxR + cxl, cy: py - boxR + cyl,
        bgLoc, peak, peakAboveBg: peak - bgLoc, flux,
        fwhmMaj, fwhmMin, ellipticity: 1 - fwhmMin / fwhmMaj, thetaDeg: theta * 180 / Math.PI,
    };
}

export interface PsfKernel {
    k: Float64Array;
    size: number;
    nStars?: number;
}

/**
 * Mean empirical PSF: subpixel-register the best stars' cutouts (bilinear
 * resample so the centroid lands on the center pixel), background-subtract,
 * flux-normalize, then per-pixel 3-sigma-clipped mean. Returns kernel with
 * sum = 1, or null when fewer than 5 usable stars stack.
 */
export function buildEmpiricalKernel(L: ArrayLike<number>, w: number, h: number, stars: { cx: number; cy: number }[], size = 15): PsfKernel | null {
    const R = (size - 1) / 2;
    const stack: Float64Array[] = [];
    for (const s of stars) {
        const cut = new Float64Array(size * size);
        const border: number[] = [];
        let ok = true;
        for (let j = 0; j < size && ok; j++) {
            for (let i = 0; i < size; i++) {
                const X = s.cx + i - R, Y = s.cy + j - R;
                if (X < 1 || Y < 1 || X >= w - 2 || Y >= h - 2) { ok = false; break; }
                const v = bilinearSample(L, w, h, X, Y);
                cut[j * size + i] = v;
                if (j === 0 || j === size - 1 || i === 0 || i === size - 1) border.push(v);
            }
        }
        if (!ok) continue;
        border.sort((a, b) => a - b);
        const bg = border[border.length >> 1];
        let sum = 0;
        for (let k = 0; k < cut.length; k++) { cut[k] = Math.max(0, cut[k] - bg); sum += cut[k]; }
        if (sum <= 0) continue;
        for (let k = 0; k < cut.length; k++) cut[k] /= sum;
        stack.push(cut);
    }
    if (stack.length < 5) return null;

    const K = new Float64Array(size * size);
    const vals = new Float64Array(stack.length);
    for (let k = 0; k < size * size; k++) {
        for (let s = 0; s < stack.length; s++) vals[s] = stack[s][k];
        const sorted = Float64Array.from(vals).sort();
        const med = sorted[sorted.length >> 1];
        const dev = Float64Array.from(sorted, (v) => Math.abs(v - med)).sort();
        const sig = 1.4826 * dev[dev.length >> 1] + 1e-12;
        let acc = 0, m = 0;
        for (let s = 0; s < stack.length; s++) {
            if (Math.abs(vals[s] - med) <= 3 * sig) { acc += vals[s]; m++; }
        }
        K[k] = m ? acc / m : med;
    }
    let sum = 0;
    for (let k = 0; k < K.length; k++) { K[k] = Math.max(0, K[k]); sum += K[k]; }
    for (let k = 0; k < K.length; k++) K[k] /= sum;
    return { k: K, size, nStars: stack.length };
}

/** Crop kernel to the smallest centered odd box holding taps >= frac*peak. */
export function truncateKernel(K: Float64Array, size: number, frac = 0.002): PsfKernel {
    const c = (size - 1) / 2;
    let peak = 0;
    for (const v of K) if (v > peak) peak = v;
    let R = 1;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        if (K[j * size + i] >= frac * peak) R = Math.max(R, Math.abs(i - c), Math.abs(j - c));
    }
    const ns = 2 * R + 1;
    if (ns >= size) return { k: Float64Array.from(K), size };
    const out = new Float64Array(ns * ns);
    let sum = 0;
    for (let j = 0; j < ns; j++) for (let i = 0; i < ns; i++) {
        const v = K[(j + c - R) * size + (i + c - R)];
        out[j * ns + i] = v; sum += v;
    }
    for (let k = 0; k < out.length; k++) out[k] /= sum;
    return { k: out, size: ns };
}

/** 3x3 region grid of median statistics over stars carrying `cx`/`cy` and a numeric field. */
export function regionGrid3x3<T extends { cx: number; cy: number }>(
    stars: T[], w: number, h: number, field: keyof T
): { n: number; median: number | null }[] {
    const cells: number[][] = Array.from({ length: 9 }, () => []);
    for (const s of stars) {
        const v = s[field] as unknown as number;
        if (!Number.isFinite(v)) continue;
        const gx = Math.min(2, Math.floor(s.cx / (w / 3)));
        const gy = Math.min(2, Math.floor(s.cy / (h / 3)));
        cells[gy * 3 + gx].push(v);
    }
    return cells.map((c) => {
        if (!c.length) return { n: 0, median: null };
        c.sort((a, b) => a - b);
        return { n: c.length, median: +c[c.length >> 1].toFixed(3) };
    });
}

export function medianOf(list: number[]): number | null {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    return s[s.length >> 1];
}

export const REGION_NAMES = [
    'top-left', 'top-center', 'top-right',
    'mid-left', 'center', 'mid-right',
    'bottom-left', 'bottom-center', 'bottom-right'
] as const;
