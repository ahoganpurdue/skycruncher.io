// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — COMMON PLUMBING (data root, WASM, geometry, loaders)
// ═══════════════════════════════════════════════════════════════════════════
// Reuses the LIVE primitives — the WASM kernels and the tools/psf atlas +
// projection helpers — so the toolchest never re-implements gnomonic/quad math
// (CLAUDE.md LAW 4: police code living in two places). The only geometry
// authored here is the pieces the kit needs that don't exist elsewhere as a
// headless export: a robust affine/similarity fit and CD<->angle helpers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    loadAtlasRegion, projectStars, tanForward, angSepDeg,
} from '../psf/forced_detect.mjs';

export { loadAtlasRegion, projectStars, tanForward, angSepDeg };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const D2R = Math.PI / 180;

/** Robust "am I the entry script?" check (case-insensitive, Windows-safe). */
export function isMain(metaUrl) {
    const a = metaUrl.toLowerCase();
    const b = pathToFileURL(process.argv[1] || '').href.toLowerCase();
    return a === b;
}

// ── DATA ROOT (self-healing) ────────────────────────────────────────────────
// Atlas sectors + test_results are gitignored/local (CLAUDE.md) — absent from a
// fresh worktree. Resolution order:
//   1. env SOLVERKIT_DATA_ROOT
//   2. the repo two levels up from this file (works once relocated to MAIN's
//      tools/solverkit/, where atlas+test_results live)
//   3. the repo root derived from this file's location (env override:
//      SOLVERKIT_DATA_ROOT — candidate 1)
// The tool CODE lives wherever it is invoked; only DATA is sourced from here.
const MAIN_DEPLOY = path.resolve(__dirname, '..', '..');
function resolveDataRoot() {
    const cand = [];
    if (process.env.SOLVERKIT_DATA_ROOT) cand.push(process.env.SOLVERKIT_DATA_ROOT);
    cand.push(path.resolve(__dirname, '..', '..'));
    cand.push(MAIN_DEPLOY);
    for (const c of cand) {
        if (fs.existsSync(path.join(c, 'test_results', 'cr2_dets')) ||
            fs.existsSync(path.join(c, 'public', 'atlas', 'sectors'))) return c;
    }
    return MAIN_DEPLOY;
}
export const DATA_ROOT = resolveDataRoot();

// ── WASM (single init, shared by every tool) ────────────────────────────────
let _wasm = null;
export async function loadWasm() {
    if (_wasm) return _wasm;
    const pkg = path.join(DATA_ROOT, 'src', 'engine', 'wasm_compute', 'pkg');
    const w = await import(`file:///${path.join(pkg, 'wasm_compute.js').replace(/\\/g, '/')}`);
    w.initSync({ module: fs.readFileSync(path.join(pkg, 'wasm_compute_bg.wasm')) });
    w.init_pipeline();
    _wasm = w;
    return w;
}

// ── detections ──────────────────────────────────────────────────────────────
/** Load an app-captured detection dump (test_results/cr2_dets/<name>.app.json). */
export function loadDetections(name) {
    const p = name.endsWith('.json') ? name
        : path.join(DATA_ROOT, 'test_results', 'cr2_dets', `${name}.app.json`);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const det = (d.detections || d.stars || d.clean_stars || [])
        .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y))
        .map((s) => ({ x: s.x, y: s.y, flux: s.flux ?? 0, fwhm: s.fwhm ?? 0 }));
    return {
        name: path.basename(p).replace(/\.app\.json$|\.json$/, ''),
        width: d.width, height: d.height,
        scaleArcsecPerPx: d.scaleArcsecPerPx ?? null,
        planets: d.planets || [],
        gps: d.gps || null, timestamp: d.timestamp || null,
        det,
    };
}

/**
 * SHARED DETECTION RUNG (LAW 4, single-source): Float32 image planes in [0,1] ->
 * luminance -> WASM extract_blobs -> flux-sorted {x,y,flux,fwhm} detections. This
 * is the SAME extraction both the FITS arm (loadFitsDetections) and the CR2/RAW
 * arm (loadCr2Detections) run, so the match ladder compares like with like: only
 * the DECODE differs between arms, never the detection recipe. Byte-identical to
 * the recipe that lived inline in loadFitsDetections before it was factored out.
 *   - >=3 planes: BT.709 luminance + 1/2.2 gamma quantised to 8-bit (SeeStar/DSLR).
 *   - 1 plane: used verbatim (already a luminance-like plane).
 * @param planes array of 1 or 3 Float32Array planes (length W*H, values in [0,1])
 * @param W,H frame dimensions
 * @param wasm the initialised wasm module (from loadWasm)
 */
export function extractDetectionsFromPlanes(planes, W, H, wasm) {
    const npix = W * H;
    const lum = new Float32Array(npix);
    if (planes.length >= 3) {
        const [R, G, B] = planes;
        for (let i = 0; i < npix; i++) {
            const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
            lum[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, l), 1 / 2.2) * 255))) / 255;
        }
    } else lum.set(planes[0]);
    const sample = []; for (let i = 0; i < npix; i += 997) sample.push(lum[i]);
    sample.sort((a, b) => a - b);
    const bg = sample[Math.floor(sample.length / 2)], sg = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
    const flat = wasm.extract_blobs(lum, W, H, bg + 3.5 * sg, bg);
    const det = [];
    for (let i = 0; i < flat.length; i += 10) det.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], fwhm: flat[i + 5] ?? 0 });
    det.sort((a, b) => b.flux - a.flux);
    return det;
}

/**
 * Extract detections from a 3-plane int16 FITS (SeeStar/narrow lane), reusing
 * the tools/repro/find_true_wcs.mjs extraction verbatim (header scan -> RGB16BE
 * planes -> luminance -> WASM extract_blobs). Returns detections + the header
 * pointing so the quad generator has a center. Requires loadWasm() first.
 * @param relPath path relative to DATA_ROOT (or absolute)
 */
export async function loadFitsDetections(relPath) {
    const w = await loadWasm();
    const p = path.isAbsolute(relPath) ? relPath : path.join(DATA_ROOT, relPath);
    const fit = fs.readFileSync(p);
    // header
    let hdrEnd = 0, hdr = {};
    outer: for (let b = 0; ; b += 2880) {
        for (let i = b; i < b + 2880; i += 80) {
            const card = fit.subarray(i, i + 80).toString('latin1');
            const m = card.match(/^(\w+)\s*=\s*([^/]+)/);
            if (m) hdr[m[1]] = m[2].trim();
            if (card.startsWith('END')) { hdrEnd = b + 2880; break outer; }
        }
    }
    const W = +hdr.NAXIS1, H = +hdr.NAXIS2, nplanes = +hdr.NAXIS3 || 1, npix = W * H;
    const plane = (k) => {
        const out = new Float32Array(npix), off = hdrEnd + k * npix * 2;
        for (let i = 0; i < npix; i++) out[i] = (fit.readInt16BE(off + i * 2) + 32768) / 65535;
        return out;
    };
    const planes = nplanes >= 3 ? [plane(0), plane(1), plane(2)] : [plane(0)];
    const det = extractDetectionsFromPlanes(planes, W, H, w);
    return {
        name: path.basename(p).replace(/\.(fit|fits)$/i, ''),
        width: W, height: H, det,
        scaleArcsecPerPx: null,       // not in header; quad recovers it (scale-invariant)
        headerCenter: (hdr.RA && hdr.DEC) ? { raDeg: +hdr.RA, decDeg: +hdr.DEC, name: 'header' } : null,
    };
}

/** Raw-file extensions the CR2/RAW arm recognises (libraw-wasm decodable). */
export const RAW_EXT_RE = /\.(cr2|cr3|nef|arw|raf|dng|orf|rw2|pef|srw)$/i;

/**
 * Extract detections from a Canon CR2 (or any libraw-decodable RAW), reusing the
 * PROVEN tools/psf/decode_cr2.mjs decode + demosaic verbatim (CLAUDE.md LAW 4 —
 * no second decoder): libraw-wasm mem_image -> dominant-channel CFA repair +
 * bilinear demosaic -> Float32 R/G/B planes -> the SAME extractDetectionsFromPlanes
 * rung the FITS arm uses. Only the decode differs from the FITS arm; the detection
 * recipe is identical, so the ladder's rung comparisons stay apples-to-apples.
 * Requires loadWasm() first. Dynamic-imports the decoder so libraw-wasm never loads
 * on the FITS/synthetic paths.
 * @param relPath path relative to DATA_ROOT (or absolute)
 */
export async function loadCr2Detections(relPath) {
    const w = await loadWasm();
    const p = path.isAbsolute(relPath) ? relPath : path.join(DATA_ROOT, relPath);
    const dec = await import('../psf/decode_cr2.mjs');
    const { w: W, h: H, rgb16 } = await dec.decodeCR2(p);
    // dominant-channel mem_image (NOT strictly one-hot: ~4-7% cross-leak on the T6/
    // 60Da). detectPattern gates on leak<0.5 + a legal Bayer diagonal → the CFA
    // repair + demosaic path; a genuinely-demosaiced payload falls back to splitRGB.
    const pat = dec.detectPattern(rgb16, W, H);
    let planes;
    if (pat.oneHot) {
        const stats = dec.cfaChannelStats(rgb16, W, H, pat.pat);
        dec.fixHotPixelsCFA(rgb16, W, H, pat.pat, stats);
        planes = dec.demosaicBilinear(rgb16, W, H, pat.pat);
    } else {
        planes = dec.splitRGB(rgb16, W, H);
    }
    const det = extractDetectionsFromPlanes(planes, W, H, w);
    return {
        name: path.basename(p).replace(RAW_EXT_RE, ''),
        width: W, height: H, det,
        scaleArcsecPerPx: null,       // not in EXIF-trust here; quad recovers it (scale-invariant)
        headerCenter: null,           // truth arrives harness-side (manifest true_wcs/true_center)
        cfa: { oneHot: pat.oneHot, pat: pat.pat, leakFraction: pat.leakFraction },
    };
}

/** Terminate any libraw decode worker threads spawned by loadCr2Detections (so a
 *  Node process that decoded a RAW frame can exit cleanly). No-op if none ran. */
export async function terminateRawDecodeWorkers() {
    try {
        const dec = await import('../psf/decode_cr2.mjs');
        dec.terminateDecodeWorkers?.();
    } catch { /* decoder never loaded — nothing to terminate */ }
}

// ── catalog region (thin wrapper over the live loader) ──────────────────────
/** Load atlas stars within radiusDeg of (raDeg,decDeg), mag<=magLimit. */
export function loadCatalog({ raDeg, decDeg, radiusDeg, magLimit = Infinity }) {
    return loadAtlasRegion({ root: DATA_ROOT, raDeg, decDeg, radiusDeg, magLimit });
}

/**
 * All-sky BRIGHT atlas (L1 anchors + L2 pattern), mag<=magLimit, RA in DEGREES.
 * The all-sky bright set is what the scale-invariant triangle matcher
 * (WASM solve_blind) consumes — it needs no field center.
 */
export function loadBrightAtlas({ magLimit = 3.5 } = {}) {
    const dir = path.join(DATA_ROOT, 'public', 'atlas');
    const out = [];
    for (const f of ['level_1_anchors.json', 'level_2_pattern.json']) {
        const p = path.join(dir, f);
        if (!fs.existsSync(p)) continue;
        for (const s of JSON.parse(fs.readFileSync(p, 'utf8'))) {
            // L1/L2 are pure Gaia: ra in DEGREES, magnitude in mag_g.
            const mag = s.mag_g ?? s.mag ?? 99;
            if (mag <= magLimit) out.push({ ra_deg: s.ra, dec_deg: s.dec, mag });
        }
    }
    return out;
}

// ── geometry the kit owns (affine/similarity fit + CD helpers) ──────────────

/** Deterministic small PRNG (mulberry32) so every run is byte-reproducible. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Least-squares full 2x3 affine mapping pixel -> tangent-plane (xi,eta) [deg]:
 *   xi  = a0*x + a1*y + a2
 *   eta = b0*x + b1*y + b2
 * Solves two independent 3x3 normal systems. Returns null if degenerate.
 * A full affine (not a locked similarity) lets parity/shear fall out of the
 * data — the same reason the app builds CD directly instead of via a rotation.
 */
export function fitAffine(corr) {
    if (corr.length < 3) return null;
    // normal equations for [x,y,1] design
    let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, S1 = 0;
    let Txi_x = 0, Txi_y = 0, Txi_1 = 0, Teta_x = 0, Teta_y = 0, Teta_1 = 0;
    for (const c of corr) {
        const { x, y, xi, eta } = c;
        Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y; S1 += 1;
        Txi_x += x * xi; Txi_y += y * xi; Txi_1 += xi;
        Teta_x += x * eta; Teta_y += y * eta; Teta_1 += eta;
    }
    const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, S1]];
    const a = solve3(M, [Txi_x, Txi_y, Txi_1]);
    const b = solve3(M, [Teta_x, Teta_y, Teta_1]);
    if (!a || !b) return null;
    return { a, b }; // a=[a0,a1,a2], b=[b0,b1,b2]
}

/** Solve 3x3 M·s=r by Cramer's rule. null if |M| ~ 0. */
function solve3(M, r) {
    const d = det3(M);
    if (Math.abs(d) < 1e-12) return null;
    const c0 = det3([[r[0], M[0][1], M[0][2]], [r[1], M[1][1], M[1][2]], [r[2], M[2][1], M[2][2]]]);
    const c1 = det3([[M[0][0], r[0], M[0][2]], [M[1][0], r[1], M[1][2]], [M[2][0], r[2], M[2][2]]]);
    const c2 = det3([[M[0][0], M[0][1], r[0]], [M[1][0], M[1][1], r[1]], [M[2][0], M[2][1], r[2]]]);
    return [c0 / d, c1 / d, c2 / d];
}
function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/**
 * Convert an affine fit (about tangent point crvalDeg) into a solverkit WCS.
 *   xi = CD·(pix - crpix)  with  CD=[[a0,a1],[b0,b1]]  and intercept = -CD·crpix
 *   => crpix = -CD^-1 · [a2, b2]
 */
export function affineToWcs(fit, crvalDeg) {
    const cd = [[fit.a[0], fit.a[1]], [fit.b[0], fit.b[1]]];
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (Math.abs(det) < 1e-18) return null;
    const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
    const crpixX = -(inv[0][0] * fit.a[2] + inv[0][1] * fit.b[2]);
    const crpixY = -(inv[1][0] * fit.a[2] + inv[1][1] * fit.b[2]);
    return { crval: [crvalDeg[0], crvalDeg[1]], crpix: [crpixX, crpixY], cd };
}

/** Pixel scale ("/px) and rotation (deg) implied by a CD matrix. */
export function cdMetrics(cd) {
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    const scale = Math.sqrt(Math.abs(det)) * 3600;      // "/px
    const rotation = Math.atan2(cd[0][1], cd[0][0]) / D2R;
    const parity = det < 0 ? -1 : 1;
    return { scale, rotation, parity };
}

/** Build a CD from scale("/px), rotation(deg), parity(+-1). */
export function cdFrom(scaleArcsec, rotDeg, parity) {
    const dpp = scaleArcsec / 3600, t = rotDeg * D2R;
    return [[dpp * Math.cos(t), dpp * Math.sin(t)],
    [-dpp * parity * Math.sin(t), dpp * parity * Math.cos(t)]];
}

/**
 * Compact anchor candidates, brightest first (fwhm-gated). Edge detections are
 * demoted, not dropped: a hot pixel / vignette artifact at the frame border can
 * out-flux the true celestial anchor (measured on the bundled CR2 — a 221px-edge
 * blob tied Jupiter), so an anchor sweep should try the top-K, not just #1.
 */
export function compactAnchors(det, { maxFwhm = 40, w = Infinity, h = Infinity, edge = 150, k = 8 } = {}) {
    const inField = [], border = [];
    for (const d of det) {
        if (d.fwhm > 0 && d.fwhm > maxFwhm) continue;
        (d.x < edge || d.y < edge || d.x > w - edge || d.y > h - edge ? border : inField).push(d);
    }
    inField.sort((a, b) => b.flux - a.flux);
    border.sort((a, b) => b.flux - a.flux);
    return [...inField, ...border].slice(0, k);
}
/** Single brightest compact (interior-preferred) — convenience. */
export function brightestCompact(det, maxFwhm = 40, w = Infinity, h = Infinity) {
    return compactAnchors(det, { maxFwhm, w, h, k: 1 })[0] ?? null;
}

// ── detection spatial index + WCS match counting (shared by all validators) ──
export function buildDetGrid(det, cell = 128) {
    let maxX = 0, maxY = 0;
    for (const d of det) { if (d.x > maxX) maxX = d.x; if (d.y > maxY) maxY = d.y; }
    const gw = Math.ceil((maxX + cell) / cell) + 1;
    const g = new Map();
    for (const d of det) {
        const k = Math.floor(d.y / cell) * gw + Math.floor(d.x / cell);
        let b = g.get(k); if (!b) { b = []; g.set(k, b); } b.push(d);
    }
    return { g, gw, cell };
}
export function nearestDet(grid, px, py, tol) {
    const { g, gw, cell } = grid;
    const cr = Math.max(1, Math.ceil(tol / cell));
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let best = null, bd = tol * tol;
    for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
        const b = g.get((gy + dy) * gw + gx + dx); if (!b) continue;
        for (const d of b) {
            const r2 = (d.x - px) ** 2 + (d.y - py) ** 2;
            if (r2 <= bd) { bd = r2; best = d; }
        }
    }
    return best ? { d: best, r: Math.sqrt(bd) } : null;
}
/** Radius-scaled match net (mirrors verifyWCS ultra-wide net: base + slope*r). */
export const tolAt = (r, o) => Math.max(o.tolBasePx, o.tolSlope * r);

/**
 * Count catalog stars that land on a detection under a WCS (one det per star).
 * Returns { matched, pairs:[{d, star, r}] }. Uses exact gnomonic projection
 * (projectStars) — the coordinate nonlinearity is in ra/dec->xi/eta, so the
 * linear CD is only ever asked to model the (correct) tangent->pixel map.
 */
export function countCatMatches(wcs, cat, grid, o) {
    const proj = projectStars({ stars: cat, wcs, w: o.w, h: o.h, margin: 2 });
    const pairs = []; const used = new Set();
    for (const s of proj) {
        const r = Math.hypot(s.x - o.ocx, s.y - o.ocy);
        const hit = nearestDet(grid, s.x, s.y, tolAt(r, o));
        if (!hit) continue;
        const key = ((hit.d.x * 131071) | 0) ^ ((hit.d.y * 8191) | 0);
        if (used.has(key)) continue;
        used.add(key);
        pairs.push({ d: hit.d, star: s, r: hit.r });
    }
    return { matched: pairs.length, pairs };
}

export function fmt(x, n = 2) { return x == null || !Number.isFinite(x) ? 'NOT MEASURED' : x.toFixed(n); }
