// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — star detection, moment-based PSF measurement, empirical kernel
// ═══════════════════════════════════════════════════════════════════════════
// All measurements happen on the NATIVE untouched pixel grid (coordinate
// corrections are applied to positions only, never to the measured pixels).

import { bilinearSample } from './imaging.mjs';

/** Local maxima above `thresh`, brightest first, capped. */
export function findMaxima(L, w, h, thresh, cap = 60000, margin = 8) {
    const out = [];
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
export function buildNeighborIndex(points, cellSize) {
    const map = new Map();
    for (let i = 0; i < points.length; i++) {
        const key = (points[i].x / cellSize | 0) * 100000 + (points[i].y / cellSize | 0);
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(i);
    }
    return { map, cellSize, points };
}

export function hasNeighborWithin(idx, x, y, r, selfIndex) {
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
export function measureStar(L, w, h, px, py, sigmaN, boxR = 7) {
    if (px < boxR + 2 || py < boxR + 2 || px >= w - boxR - 2 || py >= h - boxR - 2) return null;
    const n = 2 * boxR + 1;
    const cut = new Float64Array(n * n);
    const border = [];
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

/**
 * Mean empirical PSF: subpixel-register the best stars' cutouts (bilinear
 * resample so the centroid lands on the center pixel), background-subtract,
 * flux-normalize, then per-pixel 3-sigma-clipped mean. Returns kernel with
 * sum = 1.
 */
export function buildEmpiricalKernel(L, w, h, stars, size = 15) {
    const R = (size - 1) / 2;
    const stack = [];
    for (const s of stars) {
        const cut = new Float64Array(size * size);
        const border = [];
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
export function truncateKernel(K, size, frac = 0.002) {
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

/** Bilinear 2x upsample of a centered kernel (size -> 2*size-1), sum = 1. */
export function upsampleKernel2x(K, size) {
    const ns = 2 * size - 1;
    const out = new Float64Array(ns * ns);
    let sum = 0;
    for (let j = 0; j < ns; j++) {
        const y = j / 2, y0 = Math.min(size - 2, Math.floor(y)), fy = y - y0;
        for (let i = 0; i < ns; i++) {
            const x = i / 2, x0 = Math.min(size - 2, Math.floor(x)), fx = x - x0;
            const v = K[y0 * size + x0] * (1 - fx) * (1 - fy) + K[y0 * size + x0 + 1] * fx * (1 - fy)
                + K[(y0 + 1) * size + x0] * (1 - fx) * fy + K[(y0 + 1) * size + x0 + 1] * fx * fy;
            out[j * ns + i] = v; sum += v;
        }
    }
    for (let k = 0; k < out.length; k++) out[k] /= sum;
    return { k: out, size: ns };
}

export function mirrorKernel(K, size) {
    const out = new Float64Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        out[j * size + i] = K[(size - 1 - j) * size + (size - 1 - i)];
    }
    return out;
}

/** 3x3 region grid of median statistics over a star list keyed by `field`. */
export function regionGrid3x3(stars, w, h, field) {
    const cells = Array.from({ length: 9 }, () => []);
    for (const s of stars) {
        if (!Number.isFinite(s[field])) continue;
        const gx = Math.min(2, Math.floor(s.cx / (w / 3)));
        const gy = Math.min(2, Math.floor(s.cy / (h / 3)));
        cells[gy * 3 + gx].push(s[field]);
    }
    return cells.map((c) => {
        if (!c.length) return { n: 0, median: null };
        c.sort((a, b) => a - b);
        return { n: c.length, median: +c[c.length >> 1].toFixed(3) };
    });
}

export function medianOf(list) {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    return s[s.length >> 1];
}
