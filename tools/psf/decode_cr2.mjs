// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — CR2 decode (libraw-wasm via worker-shim bridge) + CFA handling
// ═══════════════════════════════════════════════════════════════════════════
// Contract (verified 2026-07-05 audit + this session's byte probe): with
// { noInterpolation, outputBps:16, noAutoBright, useCameraWb:false,
// useAutoWb:false } libraw-wasm imageData() returns the ACTIVE-AREA
// (5202x3464 on the T6, not 5184x3456) as a 3-channel interleaved Uint16
// mem_image, DOMINANT-CHANNEL mosaic: G sites are pure [0,G,0]; R/B sites
// hold the photosite value in their own channel plus a small (~4-7%)
// deterministic cross-leak in the other non-G channel. Black-subtracted,
// 16-bit-scaled. We therefore: (1) infer true dims from the element count
// with a stride-coherence tie-break, (2) repair hot pixels at the CFA level
// (before any interpolation can smear them), and (3) bilinear-demosaic the
// dominant channels ourselves so the data stays linear and camera-native.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');

const liveWorkers = new Set();

class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null;
    onerror = null;
    constructor(url, _options) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => {
            if (this.onerror) this.onerror(err);
            else console.error('[decode] worker error:', err);
        });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { /* not needed */ }
}

export function terminateDecodeWorkers() {
    for (const w of liveWorkers) w.terminate().catch(() => { });
}

const STAGE_TIMEOUT_MS = 240_000;
const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS / 1000}s`)), STAGE_TIMEOUT_MS).unref?.()),
]);

/** Infer (w,h) from element count: n = len/3 must factor as w*h near meta dims. */
export function inferDims(len, meta) {
    if (len % 3 !== 0) throw new Error(`imageData length ${len} not divisible by 3 — not interleaved RGB`);
    const n = len / 3;
    const candW = [];
    for (const c of [meta?.width, meta?.raw_width, meta?.imageSize?.width]) {
        if (Number.isFinite(c) && c > 0) candW.push(Math.round(c));
    }
    // Search OUTWARD from each candidate width (|d| = 0, 1, 2, ...): a near-miss
    // factorization (e.g. 5196x3468 vs the true 5202x3464 — both divide the
    // same element count) must never beat the exact meta match.
    for (const base of [...candW]) {
        for (let ad = 0; ad <= 96; ad++) {
            for (const d of ad === 0 ? [0] : [ad, -ad]) {
                const w = base + d;
                if (w > 16 && n % w === 0) {
                    const h = n / w;
                    const hRef = meta?.height || meta?.raw_height || h;
                    if (Math.abs(h - hRef) <= 96) return { w, h };
                }
            }
        }
    }
    // last resort: any factorization with ~3:2 landscape aspect
    for (let w = Math.floor(Math.sqrt(n * 1.5)); w > Math.sqrt(n); w--) {
        if (n % w === 0) {
            const h = n / w;
            const asp = w / h;
            if (asp > 1.2 && asp < 1.9) return { w, h };
        }
    }
    throw new Error(`could not infer dimensions from ${n} pixels (meta ${meta?.width}x${meta?.height})`);
}

/** All plausible (w, h) factorizations near the meta dims. */
export function candidateDims(len, meta) {
    if (len % 3 !== 0) throw new Error(`imageData length ${len} not divisible by 3 — not interleaved RGB`);
    const n = len / 3;
    const bases = [];
    for (const c of [meta?.width, meta?.raw_width, meta?.imageSize?.width]) {
        if (Number.isFinite(c) && c > 0 && !bases.includes(Math.round(c))) bases.push(Math.round(c));
    }
    const seen = new Set();
    const out = [];
    for (const base of bases) {
        for (let d = -96; d <= 96; d++) {
            const w = base + d;
            if (w > 16 && n % w === 0 && !seen.has(w)) {
                const h = n / w;
                const hRef = meta?.height || meta?.raw_height || h;
                if (Math.abs(h - hRef) <= 96) { seen.add(w); out.push({ w, h }); }
            }
        }
    }
    return out;
}

/**
 * Stride figure of merit: mean |v(y) - v(y+2)| over matching channel slots
 * (period 2 preserves Bayer parity). The TRUE row stride keeps sky smooth
 * (low score); a near-miss stride (5196x3468 vs the true 5202x3464 — BOTH
 * divide the same element count on the T6) shears the frame diagonally and
 * scores ~an order of magnitude worse. Proximity to meta.width alone cannot
 * disambiguate (5196 is nearer to meta's 5184 than the true 5202).
 */
export function strideCoherence(rgb16, w, h) {
    let acc = 0, m = 0;
    const y0 = Math.max(2, Math.floor(h * 0.3)), y1 = Math.min(h - 4, Math.floor(h * 0.7));
    for (let y = y0; y < y1; y += 13) {
        for (let x = 32; x < w - 32; x += 17) {
            const i = (y * w + x) * 3, j = ((y + 2) * w + x) * 3;
            for (let c = 0; c < 3; c++) {
                const a = rgb16[i + c], b = rgb16[j + c];
                if (a > 0 && b > 0) { acc += Math.abs(a - b); m++; }
            }
        }
    }
    return m ? acc / m : Infinity;
}

/** Decode a CR2 into { w, h, rgb16 (interleaved dominant-channel mosaic Uint16), meta }. */
export async function decodeCR2(filePath) {
    const fileBuf = fs.readFileSync(filePath);
    globalThis.Worker = BrowserWorkerOnNode;
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    await withTimeout('open()', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
        noInterpolation: true,
        outputBps: 16,
        noAutoBright: true,
        useCameraWb: false,
        useAutoWb: false,
    }));
    const meta = await withTimeout('metadata()', raw.metadata());
    const rawData = await withTimeout('imageData()', raw.imageData());

    let rgb16;
    if (rawData instanceof Uint16Array) rgb16 = rawData;
    else if (rawData?.data instanceof Uint16Array) rgb16 = rawData.data;
    else {
        const src = rawData?.buffer || rawData;
        rgb16 = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength) / 2));
    }
    // dims: enumerate candidate factorizations, break ties by stride coherence
    const cands = candidateDims(rgb16.length, meta);
    let w, h;
    if (cands.length === 0) {
        ({ w, h } = inferDims(rgb16.length, meta)); // aspect-ratio last resort
    } else if (cands.length === 1) {
        ({ w, h } = cands[0]);
    } else {
        let best = null;
        for (const c of cands) {
            const score = strideCoherence(rgb16, c.w, c.h);
            console.log(`  [decode] stride candidate ${c.w}x${c.h}: coherence ${score.toFixed(1)} (lower = true stride)`);
            if (!best || score < best.score) best = { ...c, score };
        }
        ({ w, h } = best);
    }
    if (w * h * 3 !== rgb16.length) throw new Error(`payload contract violated: ${rgb16.length} !== ${w}x${h}x3`);
    return { w, h, rgb16, meta };
}

// ── CFA layout detection ────────────────────────────────────────────────────

/**
 * Vote which channel is native at each Bayer parity by DOMINANCE (mean value
 * per channel per parity). Returns { oneHot, pat, leak } where
 * pat[(y&1)*2+(x&1)] = channel index (0=R,1=G,2=B).
 *
 * Empirical payload note (probed on the T6 corpus): libraw-wasm's document-
 * mode mem_image is not strictly one-hot — G sites are pure [0,G,0], but R/B
 * sites carry a small deterministic cross-leak in the other non-G channel
 * (e.g. [R, 0, 0.044*R]), an artifact of LibRaw's color-profile application.
 * The dominant channel is the actual photosite measurement (15-23x the
 * leak); consumers (cfaChannelStats / fixHotPixelsCFA / demosaicBilinear)
 * read ONLY the pattern channel, so the leak is discarded by construction.
 */
export function detectPattern(rgb16, w, h) {
    const sums = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const ns = [0, 0, 0, 0];
    const stepY = Math.max(1, Math.floor(h / 200)) | 1; // odd: visit both row parities
    for (let y = 8; y < h - 8; y += stepY) {
        for (let x = 8; x < w - 8; x += 17) {
            const p = (y & 1) * 2 + (x & 1);
            const i = (y * w + x) * 3;
            sums[p][0] += rgb16[i]; sums[p][1] += rgb16[i + 1]; sums[p][2] += rgb16[i + 2];
            ns[p]++;
        }
    }
    const pat = [];
    let maxLeak = 0, ok = true;
    for (let p = 0; p < 4; p++) {
        if (!ns[p]) { ok = false; pat.push(1); continue; }
        const m = sums[p].map((s) => s / ns[p]);
        const dom = m.indexOf(Math.max(...m));
        pat.push(dom);
        const others = m.filter((_, c) => c !== dom);
        const leak = Math.max(...others) / Math.max(1e-9, m[dom]);
        if (!(m[dom] > 0)) ok = false;
        if (leak > maxLeak) maxLeak = leak;
    }
    // legal Bayer arrangement: G on one diagonal, R and B on the other
    const gDiagonal = (pat[0] === 1 && pat[3] === 1 && pat[1] !== 1 && pat[2] !== 1 && pat[1] !== pat[2])
        || (pat[1] === 1 && pat[2] === 1 && pat[0] !== 1 && pat[3] !== 1 && pat[0] !== pat[3]);
    const oneHot = ok && gDiagonal && maxLeak < 0.5;
    return { oneHot, pat, leakFraction: maxLeak };
}

/**
 * Per-channel {med, sigma, diffSigma} from native CFA sites (sampled).
 *   med/sigma:  spatial median + MAD — includes real sky structure (gradient,
 *               Milky Way), so it is NOT a noise floor;
 *   diffSigma:  PIXEL-noise sigma from same-channel neighbour differences
 *               (x vs x+2 keeps Bayer parity) — structure-immune; this is the
 *               scale hot-pixel guards must use.
 */
export function cfaChannelStats(rgb16, w, h, pat) {
    const buf = [[], [], []];
    const dif = [[], [], []];
    // steps MUST be odd so both row and column parities are visited — an even
    // stepY samples a single Bayer row parity and starves one channel of stats
    // (NaN medians then fail every hot-pixel guard OPEN)
    const stepY = Math.max(1, Math.floor(h / 500)) | 1;
    for (let y = 4; y < h - 4; y += stepY) {
        for (let x = 4; x < w - 4; x += 11) {
            const c = pat[(y & 1) * 2 + (x & 1)];
            const v = rgb16[(y * w + x) * 3 + c];
            buf[c].push(v);
            dif[c].push(Math.abs(v - rgb16[(y * w + x + 2) * 3 + c]));
        }
    }
    return buf.map((a, c) => {
        if (a.length < 100) throw new Error(`cfaChannelStats: channel ${'RGB'[c]} starved (${a.length} samples) — parity sampling bug`);
        a.sort((x, y) => x - y);
        const med = a[a.length >> 1];
        const dev = a.map(v => Math.abs(v - med)).sort((x, y) => x - y);
        const dd = dif[c].sort((x, y) => x - y);
        return {
            med,
            sigma: Math.max(1, 1.4826 * dev[dev.length >> 1]),
            diffSigma: Math.max(1, 1.4826 * dd[dd.length >> 1] / Math.SQRT2),
        };
    });
}

const NB_RB = [[-2, -2], [-2, 0], [-2, 2], [0, -2], [0, 2], [2, -2], [2, 0], [2, 2]];
const NB_G = [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -2], [0, 2], [-2, 0], [2, 0]];
const NB_CROSS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/**
 * Hot-pixel repair on the one-hot CFA, BEFORE demosaic.
 * A site is hot when its pedestal-subtracted value exceeds 8x the max of its
 * 8 nearest SAME-channel neighbours (with a noise floor), is strongly above
 * background, and its 4 cross (other-channel) neighbours see no source — a
 * real star >= 1.5 px FWHM always spills into the cross sites, a single hot
 * photosite does not. Replaced with the same-channel neighbour median.
 */
export function fixHotPixelsCFA(rgb16, w, h, pat, stats) {
    const perChannel = [0, 0, 0];
    const nb = new Float64Array(8);
    for (let y = 2; y < h - 2; y++) {
        const pr = (y & 1) * 2;
        for (let x = 2; x < w - 2; x++) {
            const c = pat[pr + (x & 1)];
            const v = rgb16[(y * w + x) * 3 + c];
            const vs = v - stats[c].med;
            // floors use diffSigma (pixel noise), NOT the spatial MAD — the
            // spatial MAD is gradient/Milky-Way structure and would push the
            // hot bar to near-saturation
            if (vs < 10 * stats[c].diffSigma) continue;
            const offs = c === 1 ? NB_G : NB_RB;
            let nmax = -Infinity;
            for (let k = 0; k < 8; k++) {
                const nv = rgb16[((y + offs[k][0]) * w + (x + offs[k][1])) * 3 + c];
                nb[k] = nv;
                const ns = nv - stats[c].med;
                if (ns > nmax) nmax = ns;
            }
            if (vs <= 8 * Math.max(nmax, 3 * stats[c].diffSigma)) continue;
            // cross-site guard against tight star cores
            let crossMax = -Infinity;
            for (const [dy, dx] of NB_CROSS) {
                const cn = pat[((y + dy) & 1) * 2 + ((x + dx) & 1)];
                const cs = (rgb16[((y + dy) * w + (x + dx)) * 3 + cn] - stats[cn].med) / stats[cn].diffSigma;
                if (cs > crossMax) crossMax = cs;
            }
            if (crossMax >= Math.max(5, 0.1 * vs / stats[c].diffSigma)) continue;
            const sorted = Array.from(nb).sort((a, b) => a - b);
            rgb16[(y * w + x) * 3 + c] = Math.round((sorted[3] + sorted[4]) / 2);
            perChannel[c]++;
        }
    }
    return { count: perChannel[0] + perChannel[1] + perChannel[2], perChannel };
}

// ── demosaic ────────────────────────────────────────────────────────────────

/**
 * Bilinear demosaic of the one-hot mem_image into three Float32 planes [0,1].
 * Keeps everything linear; no white balance, no color matrix.
 */
export function demosaicBilinear(rgb16, w, h, pat) {
    const n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    const S = 1 / 65535;
    const planes = [R, G, B];
    // scatter native samples
    for (let y = 0; y < h; y++) {
        const row = y * w, pr = (y & 1) * 2;
        for (let x = 0; x < w; x++) {
            const c = pat[pr + (x & 1)];
            planes[c][row + x] = rgb16[(row + x) * 3 + c] * S;
        }
    }
    const pR = pat.indexOf(0), pB = pat.indexOf(2);
    const ry = pR >> 1, rx = pR & 1, by = pB >> 1, bx = pB & 1;
    const clx = (x) => x < 0 ? 0 : (x >= w ? w - 1 : x);
    const cly = (y) => y < 0 ? 0 : (y >= h ? h - 1 : y);

    for (let y = 0; y < h; y++) {
        const row = y * w;
        const yu = cly(y - 1) * w, yd = cly(y + 1) * w;
        const yp = y & 1;
        for (let x = 0; x < w; x++) {
            const xp = x & 1;
            const c = pat[yp * 2 + xp];
            const xl = clx(x - 1), xr = clx(x + 1);
            if (c !== 1) {
                // G at R/B site: 4-cross average (cross neighbours are all G)
                G[row + x] = 0.25 * (G[yu + x] + G[yd + x] + G[row + xl] + G[row + xr]);
            }
            // R plane
            if (!(yp === ry && xp === rx)) {
                if (yp === by && xp === bx) {
                    R[row + x] = 0.25 * (R[yu + clx(x - 1)] + R[yu + xr] + R[yd + clx(x - 1)] + R[yd + xr]);
                } else if (yp === ry) {
                    R[row + x] = 0.5 * (R[row + xl] + R[row + xr]);
                } else {
                    R[row + x] = 0.5 * (R[yu + x] + R[yd + x]);
                }
            }
            // B plane
            if (!(yp === by && xp === bx)) {
                if (yp === ry && xp === rx) {
                    B[row + x] = 0.25 * (B[yu + clx(x - 1)] + B[yu + xr] + B[yd + clx(x - 1)] + B[yd + xr]);
                } else if (yp === by) {
                    B[row + x] = 0.5 * (B[row + xl] + B[row + xr]);
                } else {
                    B[row + x] = 0.5 * (B[yu + x] + B[yd + x]);
                }
            }
        }
    }
    return [R, G, B];
}

/** Fallback for genuinely demosaiced payloads: split interleaved into planes. */
export function splitRGB(rgb16, w, h) {
    const n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    const S = 1 / 65535;
    for (let i = 0; i < n; i++) {
        R[i] = rgb16[i * 3] * S;
        G[i] = rgb16[i * 3 + 1] * S;
        B[i] = rgb16[i * 3 + 2] * S;
    }
    return [R, G, B];
}
