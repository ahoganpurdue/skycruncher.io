// SeeStar corpus sweep — headless triage of every FITS under Sample Files/corpus/
// (plus the root M66 sample as a control). Real WASM extraction + matcher +
// verification against the real atlas; per-file verdict table + JSON report.
//
//   node tools/corpus/run_corpus.mjs [--dir "Sample Files/corpus"] [--limit N] [--verbose]
//
// PASS heuristic: verified solve whose center is within CENTER_TOL_DEG of the
// header pointing (headers store the OBJECT, not the frame center — M66's true
// offset is 0.36 deg) and whose scale is within SCALE_TOL of header optics.
// This is TRIAGE tooling: the wizard/Playwright path is the full-fidelity test.
//
// CR2 (Canon DSLR) files are also swept: libraw-wasm decode (Node worker-shim
// bridge, same pattern as tools/dslr/decode_cr2_smoke.mjs), EXIF optics via
// exifr, then the SAME extractStars + solve/verify/consensus machinery — but
// DSLR frames carry no pointing, so the hint becomes a bounded all-sky tangent-
// point sweep. Lens trust guard: without a LensModel/LensInfo tag the EXIF
// focal length is UNTRUSTED (the bundled sample stores a dummy 50mm on a real
// 14mm lens) and the file runs the headerless lane (no scale gate, doubled
// consensus bar); a present+consistent lens tag runs the scale-gated lane.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CORPUS_DIR = path.resolve(ROOT, argVal('--dir', 'Sample Files/corpus'));
const LIMIT = parseInt(argVal('--limit', '999'), 10);
const VERBOSE = args.includes('--verbose');
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const CENTER_TOL_DEG = 1.5;   // header = object pos, not frame center
const SCALE_TOL = 0.25;       // matches the solver's own gate ballpark
const DET_BUDGET = 30, CAT_BUDGET = 50;

// ── WASM + atlas ────────────────────────────────────────────────────────────
const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });

const D2R = Math.PI / 180;
// Atlas rows come in TWO shapes (level_3 sector files mix both): Gaia rows
// (mag_g/source_id) store ra in DEGREES; HYG rows (mag/spect) store ra in
// HOURS. The Gaia rows in level_3 sectors only start at mag_g ~10 — every
// star brighter than that is an hour-based HYG row. Parsing those as degrees
// (ra/15) scattered all mag<10 stars ~150 deg away, so the brightest-50
// catalog slice shared at most 1 star with the top-30 detections and no true
// quad could ever form (M66 FAIL_NO_LOCK). Same discriminator as repro_fits_e2e.
const norm = s => (s.mag_g !== undefined || s.source_id !== undefined)
    ? { raH: s.ra / 15, dec: s.dec, mag: s.mag_g ?? 99 }
    : { raH: s.ra, dec: s.dec, mag: s.mag ?? 99 };
const L12 = [
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/level_1_anchors.json'), 'utf8')),
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/level_2_pattern.json'), 'utf8')),
].map(norm);
const sectorCache = new Map();
function loadSector(id) {
    if (!sectorCache.has(id)) {
        const p = path.join(ROOT, `public/atlas/sectors/level_3_sector_${id}.json`);
        sectorCache.set(id, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).map(norm) : []);
    }
    return sectorCache.get(id);
}
const sectorId = (raH, dec) => Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30)) * 6 + Math.min(5, Math.floor(((raH % 24) + 24) % 24 / 4));
function regionStars(raH, dec, radiusDeg) {
    // hint sector + sectors of 4 offset probes (dedupe) — cheap border coverage
    const ids = new Set([[0, 0], [radiusDeg, 0], [-radiusDeg, 0], [0, radiusDeg], [0, -radiusDeg]]
        .map(([dr, dd]) => sectorId(raH + dr / 15 / Math.max(0.2, Math.cos((dec) * D2R)), Math.max(-89.9, Math.min(89.9, dec + dd)))));
    const deep = [...ids].flatMap(loadSector);
    const all = [...L12, ...deep];
    return all.filter(s => angSep(s.raH, s.dec, raH, dec) < radiusDeg);
}
function angSep(ra1h, dec1, ra2h, dec2) {
    const a1 = ra1h * 15 * D2R, a2 = ra2h * 15 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2))) / D2R;
}
function gnomonic(raH, dec, ra0H, dec0) {
    const a = raH * 15 * D2R, a0 = ra0H * 15 * D2R, d = dec * D2R, d0 = dec0 * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    if (c <= 1e-9) return { xi: NaN, eta: NaN };
    return { xi: Math.cos(d) * Math.sin(a - a0) / c / D2R, eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R };
}
function inverseGnomonic(xi, eta, ra0H, dec0) {
    const x = xi * D2R, y = eta * D2R, a0 = ra0H * 15 * D2R, d0 = dec0 * D2R;
    const rho = Math.hypot(x, y), c = Math.atan(rho);
    if (rho < 1e-12) return { raH: ra0H, dec: dec0 };
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (y * Math.sin(c) * Math.cos(d0)) / rho) / D2R;
    const ra = (a0 + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c))) / D2R / 15;
    return { raH: ((ra % 24) + 24) % 24, dec };
}
// Centroid-referenced CD fit + crval recovery (mirrors SkyTransform.fitWCS).
function fitWCS(pix, sky, crpix, ra0H, dec0) {
    const n = pix.length;
    if (n < 3 || sky.length !== n) return null;
    let mx = 0, my = 0, mxi = 0, meta = 0;
    for (let i = 0; i < n; i++) { mx += pix[i].x; my += pix[i].y; mxi += sky[i].xi; meta += sky[i].eta; }
    mx /= n; my /= n; mxi /= n; meta /= n;
    const px = new Float64Array(n), py = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = pix[i].x; py[i] = pix[i].y; sx[i] = sky[i].xi - mxi; sy[i] = sky[i].eta - meta; }
    const cd = w.fit_wcs_bulk(px, py, sx, sy, mx, my);
    if (!cd || cd.length < 4) return null;
    const dxc = crpix[0] - mx, dyc = crpix[1] - my;
    const xiC = mxi + cd[0] * dxc + cd[1] * dyc, etaC = meta + cd[2] * dxc + cd[3] * dyc;
    const center = inverseGnomonic(xiC, etaC, ra0H, dec0);
    return { cd: [cd[0], cd[1], cd[2], cd[3]], crpix, crval: [center.raH, center.dec] };
}
const scaleOf = cd => Math.sqrt(Math.abs(cd[0] * cd[3] - cd[1] * cd[2])) * 3600;

// ── FITS decode (SeeStar shapes: NAXIS=3 RGB cube, NAXIS=2 CFA) ────────────
function decodeFits(buf) {
    let hdrEnd = 0; const cards = {};
    outer: for (let b = 0; b < buf.length; b += 2880) {
        for (let i = b; i < b + 2880; i += 80) {
            const card = buf.subarray(i, i + 80).toString('latin1');
            const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^\/]+)/);
            if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
            if (card.startsWith('END')) { hdrEnd = b + 2880; break outer; }
        }
    }
    const W = +cards.NAXIS1, H = +cards.NAXIS2, NP = +(cards.NAXIS3 ?? 1), BZERO = +(cards.BZERO ?? 0);
    const BITPIX = +(cards.BITPIX ?? 16);
    if (!W || !H) throw new Error('bad NAXIS');
    const npix = W * H;
    // Payload sanity: layouts we don't speak (multi-HDU extensions, unexpected
    // plane counts) must classify cleanly, not throw Buffer range errors.
    const bytesPer = BITPIX === -32 ? 4 : 2;
    const expected = hdrEnd + npix * (NP === 3 ? 3 : 1) * bytesPer;
    if (expected > buf.length) {
        throw new Error(`DECODE_UNSUPPORTED: payload ${buf.length - hdrEnd}B < expected ${expected - hdrEnd}B for ${W}x${H}x${NP} bitpix=${BITPIX} (multi-HDU or exotic layout)`);
    }
    const lum = new Float32Array(npix);
    if (BITPIX === -32) {
        // Float FITS (Siril/community stacks): normalize by observed range.
        // Reading these as int16 previously produced ~45k noise "detections".
        const total = npix * (NP === 3 ? 3 : 1);
        let lo = Infinity, hi = -Infinity;
        const stride = Math.max(1, Math.floor(total / 200_000));
        for (let i = 0; i < total; i += stride) {
            const v = buf.readFloatBE(hdrEnd + i * 4);
            if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        if (!Number.isFinite(lo) || hi - lo <= 0) throw new Error('degenerate float data');
        const inv = 1 / (hi - lo);
        const rd = (idx) => {
            const v = buf.readFloatBE(hdrEnd + idx * 4);
            if (!Number.isFinite(v)) return 0;
            const t = (v - lo) * inv;
            return t < 0 ? 0 : (t > 1 ? 1 : t);
        };
        if (NP === 3) {
            for (let i = 0; i < npix; i++) lum[i] = 0.2126 * rd(i) + 0.7152 * rd(npix + i) + 0.0722 * rd(2 * npix + i);
        } else {
            for (let i = 0; i < npix; i++) lum[i] = rd(i);
        }
    } else if (NP === 3) {
        for (let i = 0; i < npix; i++) {
            const r = (buf.readInt16BE(hdrEnd + i * 2) + BZERO) / 65535;
            const g = (buf.readInt16BE(hdrEnd + (npix + i) * 2) + BZERO) / 65535;
            const b = (buf.readInt16BE(hdrEnd + (2 * npix + i) * 2) + BZERO) / 65535;
            lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
    } else {
        // Sub-frame CFA: undebayered luminance is fine for bright-star triage.
        for (let i = 0; i < npix; i++) lum[i] = (buf.readInt16BE(hdrEnd + i * 2) + BZERO) / 65535;
    }
    return { W, H, NP, cards, lum };
}

// ── STREAMED decode+bin for monsters beyond Node's Buffer ceiling (2^32-1
// bytes — a 4.49GB community stack physically cannot readFileSync). Reads
// the header with positional reads, then streams k source rows per plane
// through a small window buffer, accumulating the binned luminance directly.
// Peak memory: one window (W×k×bytesPer) + the binned output — file size
// becomes irrelevant.
const STREAM_THRESHOLD_BYTES = 1_500_000_000;
function decodeFitsStreamedBinned(file) {
    const fd = fs.openSync(file, 'r');
    try {
        // Header: read 2880-byte blocks until END.
        const cards = {};
        let hdrEnd = 0;
        const block = Buffer.alloc(2880);
        outer: for (let b = 0; b < 1024; b++) {
            fs.readSync(fd, block, 0, 2880, b * 2880);
            for (let i = 0; i < 2880; i += 80) {
                const card = block.subarray(i, i + 80).toString('latin1');
                const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^\/]+)/);
                if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
                if (card.startsWith('END')) { hdrEnd = (b + 1) * 2880; break outer; }
            }
        }
        if (!hdrEnd) throw new Error('END not found');
        const W = +cards.NAXIS1, H = +cards.NAXIS2, NP = +(cards.NAXIS3 ?? 1), BZERO = +(cards.BZERO ?? 0);
        const BITPIX = +(cards.BITPIX ?? 16);
        if (!W || !H) throw new Error('bad NAXIS');
        if (BITPIX !== 16 && BITPIX !== -32) throw new Error(`DECODE_UNSUPPORTED: streamed bitpix=${BITPIX}`);
        const bytesPer = BITPIX === -32 ? 4 : 2;

        const k = Math.max(1, Math.ceil(Math.sqrt((W * H) / BIN_BUDGET_PX)));
        const bw = Math.floor(W / k), bh = Math.floor(H / k);
        const lum = new Float32Array(bw * bh);
        const lumW = NP === 3 ? [0.2126, 0.7152, 0.0722] : [1];
        const win = Buffer.alloc(W * k * bytesPer);

        // Float normalization needs a range estimate first: sample rows.
        let lo = 0, hi = 1;
        if (BITPIX === -32) {
            lo = Infinity; hi = -Infinity;
            const srow = Buffer.alloc(W * 4);
            const planes = NP === 3 ? 3 : 1;
            for (let p = 0; p < planes; p++) {
                for (let y = 0; y < H; y += Math.max(1, Math.floor(H / 40))) {
                    fs.readSync(fd, srow, 0, W * 4, hdrEnd + (p * W * H + y * W) * 4);
                    for (let x = 0; x < W; x += 13) {
                        const v = srow.readFloatBE(x * 4);
                        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
                    }
                }
            }
            if (!Number.isFinite(lo) || hi - lo <= 0) throw new Error('degenerate float data');
        }
        const inv = BITPIX === -32 ? 1 / (hi - lo) : 1;

        for (let p = 0; p < (NP === 3 ? 3 : 1); p++) {
            const wgt = lumW[p];
            for (let by = 0; by < bh; by++) {
                const srcRow = by * k;
                fs.readSync(fd, win, 0, W * k * bytesPer, hdrEnd + (p * W * H + srcRow * W) * bytesPer);
                for (let bx = 0; bx < bw; bx++) {
                    let s = 0;
                    for (let yy = 0; yy < k; yy++) {
                        const rowOff = (yy * W + bx * k) * bytesPer;
                        for (let xx = 0; xx < k; xx++) {
                            if (BITPIX === -32) {
                                const v = win.readFloatBE(rowOff + xx * 4);
                                s += Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) * inv)) : 0;
                            } else {
                                s += (win.readInt16BE(rowOff + xx * 2) + BZERO) / 65535;
                            }
                        }
                    }
                    lum[by * bw + bx] += (s / (k * k)) * wgt;
                }
            }
        }
        return { W: bw, H: bh, NP, cards, lum, binK: k, nativeW: W, nativeH: H };
    } finally {
        fs.closeSync(fd);
    }
}

// ── Auto-binning: giant frames (mosaic canvases, drizzle monsters) bin down
// to a triage budget — integer k×k mean bin; effective pixel scale ×= k.
// Solve geometry is unaffected (crval identical); reported scale is binned.
const BIN_BUDGET_PX = 34_000_000;
function autoBin(lum, W, H) {
    const k = Math.ceil(Math.sqrt((W * H) / BIN_BUDGET_PX));
    if (k <= 1) return { lum, W, H, k: 1 };
    const bw = Math.floor(W / k), bh = Math.floor(H / k);
    const out = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            let s = 0;
            for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) s += lum[(y * k + yy) * W + (x * k + xx)];
            out[y * bw + x] = s / (k * k);
        }
    }
    return { lum: out, W: bw, H: bh, k };
}

// ── App-equivalent preview transform + extraction ──────────────────────────
function extractStars(lum, W, H) {
    const g = new Float32Array(lum.length);
    for (let i = 0; i < lum.length; i++) g[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, lum[i]), 1 / 2.2) * 255))) / 255;
    // Stats over NONZERO pixels: mosaic "maxcanvas" exports park the image in
    // a sea of exact-zero canvas, which drags the global median/sigma to
    // nonsense and starves detection (observed: 36 stars on a 170MP mosaic).
    const sample = [];
    for (let i = 0; i < g.length; i += 997) { if (g[i] > 0) sample.push(g[i]); }
    if (sample.length < 100) for (let i = 0; i < g.length; i += 997) sample.push(g[i]);
    sample.sort((a, b) => a - b);
    const bg = sample[Math.floor(sample.length / 2)];
    const sigma = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
    const flat = w.extract_blobs(g, W, H, bg + 3.5 * sigma, bg);
    const raw = [];
    for (let i = 0; i < flat.length; i += 10) raw.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4] });
    raw.sort((a, b) => b.flux - a.flux);
    // Minimal hygiene standing in for the app's morphology pass: edge
    // artifacts routinely top the raw flux ranking (M66's #1 blob sat at
    // x=18) and poison the quad selection; near-duplicates dilute it.
    const margin = 24;
    const stars = [];
    for (const s of raw) {
        if (s.x < margin || s.y < margin || s.x > W - margin || s.y > H - margin) continue;
        if (stars.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
        stars.push(s);
    }
    return stars;
}

// ═════════════════════════════════════════════════════════════════════════
// CR2 (Canon DSLR) lane — ADDITIVE: nothing above or below this block changes
// for FITS files. Decode via libraw-wasm (browser-Worker binding bridged onto
// worker_threads with src/engine/core/worker_shim.js — the exact pattern from
// tools/dslr/decode_cr2_smoke.mjs), EXIF via exifr, then the same
// extract/solve/verify/consensus machinery over a bounded all-sky hint sweep
// (DSLRs have no RA/DEC pointing to hint from).
// ═════════════════════════════════════════════════════════════════════════
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const cr2LiveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null;
    onerror = null;
    constructor(url, _options) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        cr2LiveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => {
            if (this.onerror) this.onerror(err);
            else console.error('[cr2] worker error:', err);
        });
        this.on('exit', () => cr2LiveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { /* not needed */ }
}
const CR2_STAGE_TIMEOUT_MS = 120_000;
const cr2Timeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${CR2_STAGE_TIMEOUT_MS / 1000}s`)), CR2_STAGE_TIMEOUT_MS).unref?.())
]);

// Pixel pitch (µm) by EXIF Model — mirrors sensor_db.ts body lists.
// A table lookup is only the SECOND resolution rung; see cr2PitchUm below — the
// pitch is usually IN the file (EXIF FocalPlaneResolution) and is derived from
// there first. This table covers common bodies; the honest fallback handles the
// rest. NO silent APS-C assumption: a full-frame body must never inherit 4.30.
const CR2_PITCH_DEFAULT_UM = 4.30;
const CR2_PITCH_UM = {
    // APS-C 18MP (22.3mm / 5184px)
    'Canon EOS Rebel T6': 4.30, 'Canon EOS 1300D': 4.30,
    'Canon EOS Rebel T7': 4.30, 'Canon EOS 2000D': 4.30,
    'Canon EOS Rebel T5i': 4.30, 'Canon EOS 700D': 4.30,
    'Canon EOS Rebel T6i': 4.30, 'Canon EOS 750D': 4.30,
    'Canon EOS Rebel T6s': 4.30, 'Canon EOS 760D': 4.30,
    'Canon EOS Rebel T5': 4.30, 'Canon EOS 1200D': 4.30,
    // Full-frame mirrorless BSI (R5/Ra family)
    'Canon EOS R5': 4.39, 'Canon EOS Ra': 4.39, 'Canon EOS R6 II': 4.39,
    // Full-frame DSLR (36mm wide) — the classic astro bodies, per-body pitch
    'Canon EOS 5D Mark III': 6.25, 'Canon EOS 5D Mark IV': 5.36,
    'Canon EOS 5D Mark II': 6.41, 'Canon EOS 5DS': 4.14, 'Canon EOS 5DS R': 4.14,
    'Canon EOS 6D': 6.55, 'Canon EOS 6D Mark II': 5.76,
    'Canon EOS-1D X': 6.95, 'Canon EOS-1D X Mark II': 6.60,
};

// Honest pixel-pitch resolution order — never a silent APS-C assumption:
//   1. EXIF FocalPlaneResolution — Canon writes px-per-unit against the TRUE
//      sensor width, so pitch is MEASURED from the file: exact, camera-DB-free,
//      and correct even for bodies we've never seen. (unit 2=in, 3=cm, 4=mm)
//   2. Body table above — a known-sensor lookup.
//   3. Last resort — the APS-C default, but FLAGGED assumed (never silent), so a
//      full-frame body can't masquerade as APS-C and pin the sweep ~45% off.
// An ASSUMED pitch is a working prior only; it is barred from gating (see below).
function cr2PitchUm(tags) {
    const fpx = Number(tags.FocalPlaneXResolution);
    const unit = Number(tags.FocalPlaneResolutionUnit); // 2=in, 3=cm, 4=mm
    if (fpx > 0 && (unit === 2 || unit === 3 || unit === 4)) {
        const perUnitUm = unit === 2 ? 25400 : unit === 3 ? 10000 : 1000;
        const p = perUnitUm / fpx;
        if (p > 1 && p < 20) return { pitch: +p.toFixed(3), source: 'exif-focalplane', assumed: false };
    }
    const t = CR2_PITCH_UM[tags.Model];
    if (t > 0) return { pitch: t, source: 'body-table', assumed: false };
    return { pitch: CR2_PITCH_DEFAULT_UM, source: 'assumed-apsc', assumed: true };
}

const isCr2File = (f) => /\.cr2$/i.test(f);
const isCr2Magic = (buf) => buf.length > 9 && buf[0] === 0x49 && buf[1] === 0x49 && buf[8] === 0x43 && buf[9] === 0x52;

// TRUST GUARD: EXIF FocalLength alone is not evidence — the bundled sample
// carries a dummy 50mm on an actually-14mm lens with NO lens tag. Only a
// present LensModel (or numeric LensInfo consistent with FocalLength) earns
// the scale-gated lane; otherwise the EXIF scale is a working prior only.
function cr2LensTrust(tags) {
    const lm = (typeof tags.LensModel === 'string' && tags.LensModel.trim()) ? tags.LensModel.trim() : null;
    const li = (Array.isArray(tags.LensInfo) && Number.isFinite(tags.LensInfo[0]) && tags.LensInfo[0] > 0) ? tags.LensInfo : null;
    if (!lm && !li) return { trusted: false, why: 'no LensModel/LensInfo tag' };
    const fl = Number(tags.FocalLength);
    if (!(fl > 0)) return { trusted: false, why: 'lens tag present but no FocalLength' };
    if (li) {
        const lo = li[0], hi = (Number.isFinite(li[1]) && li[1] > 0) ? li[1] : li[0];
        if (fl < lo * 0.9 || fl > hi * 1.1) return { trusted: false, why: `FocalLength ${fl}mm outside LensInfo ${lo}-${hi}mm` };
    }
    return { trusted: true, why: lm ?? `LensInfo ${li[0]}${li[1] > li[0] ? '-' + li[1] : ''}mm` };
}

// libraw-wasm payload contract (verified by tools/dslr/decode_cr2_smoke.mjs):
// imageData() returns INTERLEAVED RGB16 — meta.width*meta.height*3 Uint16
// elements, row stride width*3, values 0..65535 — NOT a CFA mosaic, even with
// noInterpolation. Luminance for detection = (R+G+B)/3 normalized to [0,1].
async function decodeCr2(file) {
    const buf = fs.readFileSync(file);
    if (!isCr2Magic(buf)) vlog(`  [cr2] WARNING: ${path.basename(file)} lacks CR2 magic bytes (II + "CR"@8) — attempting decode anyway`);

    const exifr = (await import('exifr')).default;
    const tags = await exifr.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
        tiff: true, xmp: true, icc: false, ifd1: false,
        mergeOutput: true, reviveValues: true, sanitize: true,
    }) || {};

    if (!globalThis.Worker) globalThis.Worker = BrowserWorkerOnNode;
    try {
        const LibRawModule = await import('libraw-wasm');
        const LibRaw = LibRawModule.default || LibRawModule;
        const raw = new LibRaw();
        await cr2Timeout('open()', raw.open(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
            noInterpolation: true, // 'Document Mode' — but output is still interleaved RGB16 (see contract above)
            outputBps: 16,
            noAutoBright: true,
            useCameraWb: false,
            useAutoWb: false,
        }));
        const meta = await cr2Timeout('metadata()', raw.metadata());
        const rgb = await cr2Timeout('imageData()', raw.imageData());
        const W = meta?.width || 0, H = meta?.height || 0;
        if (!W || !H) throw new Error(`DECODE_UNSUPPORTED: no width/height in libraw metadata`);
        let u16;
        if (rgb instanceof Uint16Array) u16 = rgb;
        else if (rgb?.data instanceof Uint16Array) u16 = rgb.data;
        else {
            const src = rgb?.buffer || rgb;
            u16 = new Uint16Array(src, rgb?.byteOffset || 0, Math.floor((rgb?.byteLength ?? src.byteLength) / 2));
        }
        if (u16.length !== W * H * 3) {
            console.error(`  [cr2] PAYLOAD CONTRACT VIOLATION: imageData() gave ${u16.length} u16 elements, expected ${W}x${H}x3=${W * H * 3} (interleaved RGB16)`);
            throw new Error(`DECODE_UNSUPPORTED: CR2 payload ${u16.length} != ${W}x${H}x3`);
        }
        const npix = W * H;
        const lum = new Float32Array(npix);
        const inv = 1 / (3 * 65535);
        for (let i = 0; i < npix; i++) {
            const o = i * 3;
            lum[i] = (u16[o] + u16[o + 1] + u16[o + 2]) * inv;
        }
        return { W, H, lum, tags };
    } finally {
        // One LibRaw instance (= one worker thread) per file; reap it so a big
        // corpus doesn't accumulate threads. Buffers are already copied out.
        for (const wk of cr2LiveWorkers) wk.terminate().catch(() => { });
        cr2LiveWorkers.clear();
    }
}

// Bounded all-sky tangent-point grid: rings spaced ~1.2 half-diagonals so
// neighbouring FOVs overlap; a frame centered anywhere lies within one hint.
const CR2_MAX_HINTS = 160;
function cr2HintGrid(halfDiagDeg) {
    const step = Math.max(12, halfDiagDeg * 1.2);
    const hints = [[0, 90], [0, -90]];
    let ring = 0;
    for (let dec = -90 + step; dec < 90 - step / 2; dec += step, ring++) {
        const n = Math.max(1, Math.ceil(360 * Math.cos(dec * D2R) / step));
        for (let i = 0; i < n; i++) hints.push([((i + (ring % 2) * 0.5) * 24 / n) % 24, dec]);
    }
    return hints.slice(0, CR2_MAX_HINTS);
}

// Per-hint solve: the SAME region→project→solve_planar_local→fitWCS→scale-
// gate→verify→consensus sequence as the FITS lane, with bounded-cost caps
// (the FITS lane runs this block once per file; the blind sweep runs it up to
// CR2_MAX_HINTS times, so verification is capped to the top candidates by
// quad error and the brightest region/detection subsets).
const CR2_CAND_CAP = 12, CR2_VERIFY_DET_CAP = 500, CR2_VERIFY_CAT_CAP = 3000;
function cr2SolveAtHint(det, W, H, ra0, dec0, workScale, gateScale, vDetX, vDetY) {
    const halfDiagDeg = Math.hypot(W, H) / 2 * workScale / 3600;
    const region = regionStars(ra0, dec0, Math.max(1.5, halfDiagDeg * 2.5));
    if (region.length < 8) return null;
    const degPerPx = workScale / 3600;
    const catPix = region
        .map(s => ({ s, g: gnomonic(s.raH, s.dec, ra0, dec0) }))
        .filter(o => Number.isFinite(o.g.xi))
        .map(o => ({ x: W / 2 + o.g.xi / degPerPx, y: H / 2 - o.g.eta / degPerPx, xi: o.g.xi, eta: o.g.eta, mag: o.s.mag }));
    const catSub = catPix
        .filter(p => Math.hypot(p.x - W / 2, p.y - H / 2) <= Math.hypot(W, H) / 2 * 1.2)
        .sort((a, b) => a.mag - b.mag).slice(0, CAT_BUDGET);
    if (catSub.length < 8) return null;

    const detTop = det.slice(0, DET_BUDGET);
    const res = w.solve_planar_local(
        new Float64Array(detTop.map(p => p.x)), new Float64Array(detTop.map(p => p.y)),
        new Float64Array(detTop.map((_, i) => i)),
        new Float64Array(catSub.map(p => p.x)), new Float64Array(catSub.map(p => p.y)),
        new Float64Array(catSub.map((_, i) => i)),
        new Float64Array([0.02, 0.05, 0.08, 0.1]), 50, undefined);

    const stats = [];
    for (let c = 0; c < res.length / 9; c++) {
        const o = c * 9;
        const pix = [], sky = [];
        for (let k = 0; k < 4; k++) {
            const d = detTop[res[o + k]], q = catSub[res[o + 4 + k]];
            if (!d || !q) break;
            pix.push(d); sky.push({ xi: q.xi, eta: q.eta });
        }
        if (pix.length !== 4) continue;
        const wcs = fitWCS(pix, sky, [W / 2, H / 2], ra0, dec0);
        if (!wcs) continue;
        const s = scaleOf(wcs.cd);
        const gated = Number.isFinite(gateScale) && Math.abs(s - gateScale) / gateScale > SCALE_TOL;
        stats.push({ c, err: res[o + 8], scale: s, gated, wcs, matches: 0 });
    }
    const open = stats.filter(k => !k.gated).sort((a, b) => a.err - b.err).slice(0, CR2_CAND_CAP);
    if (!open.length) return { best: null, consensus: 0, region: region.length, gatedN: stats.filter(k => k.gated).length };

    const vCat = [...region].sort((a, b) => a.mag - b.mag).slice(0, CR2_VERIFY_CAT_CAP);
    const catRa = new Float64Array(vCat.map(s => s.raH)), catDec = new Float64Array(vCat.map(s => s.dec));
    let best = null;
    for (const k of open) {
        const v = w.verify_astrometric_lock(vDetX, vDetY, catRa, catDec,
            new Float64Array(k.wcs.cd), new Float64Array(k.wcs.crval), new Float64Array(k.wcs.crpix),
            Math.max(60, k.scale * 10) / 3600);
        k.matches = Math.round(v[2]);
        k.crval = k.wcs.crval;
        k.resid = +v[3].toFixed(2);
        if (!best || k.matches > best.matches) best = { wcs: k.wcs, scale: k.scale, matches: k.matches, resid: k.resid, cand: k.c };
    }
    // Consensus (scale-gated lane only, mirroring the FITS lane's rule): true
    // solutions cluster on one crval/scale; coincidences scatter.
    let consensus = 0;
    if (best && Number.isFinite(gateScale)) {
        const top = [...open].sort((a, b) => b.matches - a.matches).slice(0, 10);
        consensus = top.filter(t =>
            t.crval &&
            Math.abs(t.scale - best.scale) / best.scale < 0.03 &&
            angSep(t.crval[0], t.crval[1], best.wcs.crval[0], best.wcs.crval[1]) < 0.1
        ).length;
    }
    return { best, consensus, region: region.length, gatedN: stats.filter(k => k.gated).length };
}

const CR2_SWEEP_BUDGET_MS = 10 * 60 * 1000; // honest bound: no hangs
async function triageCr2(file) {
    const t0 = Date.now();
    const row = { file: path.relative(ROOT, file), fmt: 'CR2', status: 'ERROR', ms: 0 };
    try {
        const d = await decodeCr2(file);
        const tags = d.tags;
        const binned = autoBin(d.lum, d.W, d.H);
        const { lum, W, H, k: binK } = binned;
        Object.assign(row, {
            dims: `${d.W}x${d.H}x3`, creator: tags.Model ?? '?',
            exp: tags.ExposureTime ?? '?',
            date: tags.DateTimeOriginal instanceof Date
                ? tags.DateTimeOriginal.toISOString().slice(0, 19)
                : String(tags.DateTimeOriginal ?? '?').slice(0, 19),
        });
        if (binK > 1) { row.binned = `${binK}x`; vlog(`  [v] binned ${binK}x -> ${W}x${H}`); }

        const { pitch, source: pitchSource, assumed: pitchAssumed } = cr2PitchUm(tags);
        row.pitch = pitch; row.pitchSource = pitchSource;
        const focal = Number(tags.FocalLength);
        const exifScale = focal > 0 ? 206.265 * pitch / focal * binK : NaN;
        const trust = cr2LensTrust(tags);
        // Lane selection — trusted lens tag AND a NON-assumed pitch => scale-gated
        // lane (headerScale finite, same semantics as FITS header optics);
        // otherwise headerless lane (no scale gate, doubled bar). A pitch we only
        // ASSUMED (unknown body, no EXIF FocalPlaneResolution) must never gate: it
        // was exactly this — a full-frame body silently pinned to the APS-C 4.30 —
        // that projected the catalog ~45% off and manufactured a noise-floor fail.
        // The EXIF scale still serves as the WORKING prior for catalog projection
        // either way: it is the best available geometry guess, it just isn't
        // trusted enough to gate on when the lens OR the pitch is a guess.
        const headerScale = (trust.trusted && !pitchAssumed && Number.isFinite(exifScale)) ? exifScale : NaN;
        row.lane = Number.isFinite(headerScale) ? 'SCALE_GATED' : 'UNTRUSTED_BLIND';
        row.headerScale = Number.isFinite(headerScale) ? +headerScale.toFixed(3) : null;
        console.log(`  [cr2] ${path.basename(file)}: decoded ${d.W}x${d.H} RGB16, model=${tags.Model ?? '?'} fl=${focal > 0 ? focal + 'mm' : '?'} pitch=${pitch}um (${pitchSource}${pitchAssumed ? ' — ASSUMED, will not gate' : ''}) exifScale=${Number.isFinite(exifScale) ? exifScale.toFixed(2) + '"/px' : '?'}`);
        console.log(`  [cr2] lens trust: ${trust.trusted ? 'TRUSTED' : 'UNTRUSTED'} (${trust.why}) -> ${row.lane} lane`);

        const det = extractStars(lum, W, H);
        row.stars = det.length;
        console.log(`  [cr2] stars=${det.length}`);
        if (det.length < 8) { row.status = 'FAIL_FEW_STARS'; return row; }
        vlog(`  [v] det=${det.length}, top8: ${det.slice(0, 8).map(s => `(${s.x.toFixed(1)},${s.y.toFixed(1)} f=${s.flux.toExponential(1)})`).join(' ')}`);

        const workScale = Number.isFinite(exifScale) ? exifScale : 17.7 * binK; // 50mm kit @4.30um fallback
        const vDet = det.slice(0, CR2_VERIFY_DET_CAP);
        const vDetX = new Float64Array(vDet.map(p => p.x)), vDetY = new Float64Array(vDet.map(p => p.y));
        const baseBar = Math.max(25, Math.round(vDet.length * 0.12));

        const hints = cr2HintGrid(Math.hypot(W, H) / 2 * workScale / 3600);
        row.hints = hints.length;
        vlog(`  [v] blind sweep: ${hints.length} tangent points (workScale=${workScale.toFixed(2)}"/px)`);
        let best = null, bestConsensus = 0, bestHint = null;
        for (let hi = 0; hi < hints.length; hi++) {
            if (Date.now() - t0 > CR2_SWEEP_BUDGET_MS) {
                row.sweepTruncated = `${hi}/${hints.length} hints`;
                console.log(`  [cr2] sweep budget exhausted at hint ${hi}/${hints.length} — reporting best so far honestly`);
                break;
            }
            const [ra0, dec0] = hints[hi];
            const r = cr2SolveAtHint(det, W, H, ra0, dec0, workScale, headerScale, vDetX, vDetY);
            if (VERBOSE && hi % 16 === 0) vlog(`  [v] hint ${hi}/${hints.length} (${ra0.toFixed(2)}h,${dec0.toFixed(1)}) region=${r?.region ?? 0} best-so-far=${best?.matches ?? 0}`);
            if (!r || !r.best) continue;
            if (!best || r.best.matches > best.matches) {
                best = r.best; bestConsensus = r.consensus; bestHint = [ra0, dec0];
                vlog(`  [v] new best @(${ra0.toFixed(2)}h,${dec0.toFixed(1)}): matches=${best.matches} scale=${best.scale.toFixed(2)} crval=${best.wcs.crval[0].toFixed(3)}h,${best.wcs.crval[1].toFixed(2)}`);
            }
            const earlyBar = Number.isFinite(headerScale) ? ((r.consensus >= 5) ? 20 : baseBar) : baseBar * 2;
            if (best === r.best && best.matches >= earlyBar) { vlog(`  [v] bar-clearing lock at hint ${hi} — stopping sweep`); break; }
        }
        row.consensus = bestConsensus;
        // Same acceptance ladder as the FITS lane: consensus-relaxed floor for
        // the scale-gated lane, DOUBLED bar for the untrusted/headerless lane.
        const gatedBar = (bestConsensus >= 5) ? 20 : baseBar;
        const lockBar = Number.isFinite(headerScale) ? gatedBar : baseBar * 2;
        row.ms = Date.now() - t0;
        if (!best || best.matches < lockBar) { row.status = 'FAIL_NO_LOCK'; row.bestMatches = best?.matches ?? 0; row.lockBar = lockBar; return row; }
        // PHYSICAL SCALE BOUNDS (untrusted lane): even with unknown glass the
        // sensor pitch bounds plausible scale — 4.3um over 8-800mm focal
        // lengths spans ~1.1-111"/px. IMG_1286 chance-cleared the doubled bar
        // with 62 coincidence matches at 226"/px (a 3.9mm "lens" that does
        // not exist for this mount). Physics outranks coincidence.
        const DSLR_SCALE_MIN = 1.0, DSLR_SCALE_MAX = 120;
        if (best.scale < DSLR_SCALE_MIN || best.scale > DSLR_SCALE_MAX) {
            console.log(`  [cr2] REJECT physically-implausible scale ${best.scale.toFixed(1)}"/px (plausible ${DSLR_SCALE_MIN}-${DSLR_SCALE_MAX} for this sensor class) despite ${best.matches} matches`);
            row.status = 'FAIL_IMPLAUSIBLE_SCALE'; row.bestMatches = best.matches; row.rejectedScale = +best.scale.toFixed(2);
            return row;
        }
        // No header pointing exists to check the center against — PASS here
        // means "verified lock cleared the lane's bar", offsetDeg is not
        // computable for DSLR frames.
        Object.assign(row, {
            status: 'PASS',
            solved: `${best.wcs.crval[0].toFixed(3)}h ${best.wcs.crval[1] >= 0 ? '+' : ''}${best.wcs.crval[1].toFixed(2)}`,
            scale: +best.scale.toFixed(3), matches: best.matches, residArcsec: best.resid,
            candidate: best.cand, hintUsed: bestHint ? `${bestHint[0].toFixed(2)}h ${bestHint[1].toFixed(1)}` : null,
        });
        return row;
    } catch (e) {
        row.error = String(e.message || e); return row;
    } finally { row.ms = row.ms || (Date.now() - t0); }
}

// ── Per-file solve triage (planar, hinted) ──────────────────────────────────
function triage(file) {
    const t0 = Date.now();
    const row = { file: path.relative(ROOT, file), status: 'ERROR', ms: 0 };
    try {
        // Siril sidecar products: *_rejmap.fit files are per-pixel sigma-clip
        // REJECTION STATISTICS, not sky images — classify, don't solve.
        // (Ledger note: these are future Phase-K/S artifact-intelligence
        // inputs — a rejection map IS a satellite-trail detector.)
        if (/_rejmap\.\w+$/i.test(file) || /_rej(ection)?_?map/i.test(file)) {
            row.status = 'ARTIFACT_MAP';
            return row;
        }
        const fileSize = fs.statSync(file).size;
        let lum, W, H, binK, NP, cards, nativeW, nativeH;
        if (fileSize > STREAM_THRESHOLD_BYTES) {
            // Beyond (or near) Node's Buffer ceiling: stream + bin on the fly.
            const s = decodeFitsStreamedBinned(file);
            ({ lum, W, H, NP, cards, binK, nativeW, nativeH } = s);
            row.streamed = true;
        } else {
            const buf = fs.readFileSync(file);
            const decoded = decodeFits(buf);
            NP = decoded.NP; cards = decoded.cards; nativeW = decoded.W; nativeH = decoded.H;
            // Giant frames bin down to the triage budget; scale scales with k.
            const binned = autoBin(decoded.lum, decoded.W, decoded.H);
            ({ lum, W, H, k: binK } = binned);
        }
        Object.assign(row, {
            dims: `${nativeW}x${nativeH}x${NP}`, creator: cards.CREATOR ?? cards.INSTRUME ?? '?',
            exp: cards.EXPTIME ?? '?', date: (cards['DATE-OBS'] ?? '?').slice(0, 19),
        });
        if (binK > 1) { row.binned = `${binK}x${row.streamed ? ' (streamed)' : ''}`; vlog(`  [v] binned ${binK}x -> ${W}x${H}${row.streamed ? ' via stream' : ''}`); }
        const focal = +cards.FOCALLEN, pixsz = +cards.XPIXSZ;
        const headerScale = (focal > 0 && pixsz > 0 ? 206.265 * pixsz / focal : NaN) * binK;
        row.headerScale = Number.isFinite(headerScale) ? +headerScale.toFixed(3) : null;
        if (cards.RA === undefined || cards.DEC === undefined) { row.status = 'SKIP_NO_HINT'; return row; }
        const ra0 = +cards.RA / 15, dec0 = +cards.DEC;
        row.hint = `${ra0.toFixed(3)}h ${dec0 >= 0 ? '+' : ''}${dec0.toFixed(2)}`;

        const det = extractStars(lum, W, H);
        row.stars = det.length;
        if (det.length < 8) { row.status = 'FAIL_FEW_STARS'; return row; }
        vlog(`  [v] det=${det.length}, top8: ${det.slice(0, 8).map(s => `(${s.x.toFixed(1)},${s.y.toFixed(1)} f=${s.flux.toExponential(1)})`).join(' ')}`);

        const scale = Number.isFinite(headerScale) ? headerScale : 3.74;
        const halfDiagDeg = Math.hypot(W, H) / 2 * scale / 3600;
        const region = regionStars(ra0, dec0, Math.max(1.5, halfDiagDeg * 2.5));
        row.catalog = region.length;
        const degPerPx = scale / 3600;
        const catPix = region
            .map(s => ({ s, g: gnomonic(s.raH, s.dec, ra0, dec0) }))
            .filter(o => Number.isFinite(o.g.xi))
            .map(o => ({ x: W / 2 + o.g.xi / degPerPx, y: H / 2 - o.g.eta / degPerPx, xi: o.g.xi, eta: o.g.eta, mag: o.s.mag }));
        const catSub = catPix
            .filter(p => Math.hypot(p.x - W / 2, p.y - H / 2) <= Math.hypot(W, H) / 2 * 1.2)
            .sort((a, b) => a.mag - b.mag).slice(0, CAT_BUDGET);
        if (catSub.length < 8) { row.status = 'FAIL_FEW_CATALOG'; return row; }
        vlog(`  [v] region=${region.length}, catSub=${catSub.length} (mag ${catSub[0].mag.toFixed(2)}..${catSub[catSub.length - 1].mag.toFixed(2)})`);

        const detTop = det.slice(0, DET_BUDGET);
        const res = w.solve_planar_local(
            new Float64Array(detTop.map(p => p.x)), new Float64Array(detTop.map(p => p.y)),
            new Float64Array(detTop.map((_, i) => i)),
            new Float64Array(catSub.map(p => p.x)), new Float64Array(catSub.map(p => p.y)),
            new Float64Array(catSub.map((_, i) => i)),
            new Float64Array([0.02, 0.05, 0.08, 0.1]), 50, undefined);

        const catRa = new Float64Array(region.map(s => s.raH)), catDec = new Float64Array(region.map(s => s.dec));
        const allDetX = new Float64Array(det.map(p => p.x)), allDetY = new Float64Array(det.map(p => p.y));
        let best = null;
        // Always collected (<=200 entries): consensus scoring needs it; verbose printing reads it too.
        const candStats = [];
        for (let c = 0; c < res.length / 9; c++) {
            const o = c * 9;
            const pix = [], sky = [];
            for (let k = 0; k < 4; k++) {
                const d = detTop[res[o + k]], q = catSub[res[o + 4 + k]];
                if (!d || !q) { break; }
                pix.push(d); sky.push({ xi: q.xi, eta: q.eta });
            }
            if (pix.length !== 4) continue;
            const wcs = fitWCS(pix, sky, [W / 2, H / 2], ra0, dec0);
            if (!wcs) continue;
            const s = scaleOf(wcs.cd);
            if (Number.isFinite(headerScale) && Math.abs(s - headerScale) / headerScale > SCALE_TOL) {
                candStats?.push({ c, err: res[o + 8], scale: s, gated: true, matches: 0 });
                continue;
            }
            // Tight verify radius: coincidence matches scale with r^2. At
            // ~10px equivalent a TRUE lock matches ~40% of detections while
            // coincidences sit in single digits.
            const v = w.verify_astrometric_lock(allDetX, allDetY, catRa, catDec,
                new Float64Array(wcs.cd), new Float64Array(wcs.crval), new Float64Array(wcs.crpix),
                Math.max(60, s * 10) / 3600);
            const matches = Math.round(v[2]);
            candStats?.push({ c, err: res[o + 8], scale: s, gated: false, matches, crval: wcs.crval });
            if (!best || matches > best.matches) best = { wcs, scale: s, matches, resid: +v[3].toFixed(2), cand: c };
        }
        if (VERBOSE) {
            const top = [...candStats].sort((a, b) => b.matches - a.matches).slice(0, 10);
            vlog(`  [v] ${res.length / 9} raw candidates, ${candStats.filter(k => k.gated).length} scale-gated; top-10 by matches:`);
            for (const k of top) {
                vlog(`  [v]   cand#${k.c} err=${k.err.toExponential(1)} scale=${k.scale.toFixed(3)}${k.gated ? ' GATED' : ` matches=${k.matches} crval=${k.crval[0].toFixed(4)}h,${k.crval[1].toFixed(3)} off=${angSep(k.crval[0], k.crval[1], ra0, dec0).toFixed(3)}`}`);
            }
        }
        row.ms = Date.now() - t0;
        // Acceptance must clear the coincidence floor: require matches to beat
        // max(25, 12% of detections). A true lock lands 35-45% of detections.
        // HEADERLESS files get a DOUBLED bar: without a header scale there is
        // no scale gate, and coincidence candidates at wild scales (observed:
        // 58 matches at 21.9"/px on a 0.79"/px field) can clear the base floor.
        //
        // CONSENSUS RELAXATION (scale-gated files only): deep drizzled frames
        // detect far past the catalog limit, so percent-of-detections punishes
        // them (observed: TRUE solution with 37 matches vs bar 39 on a 328-det
        // frame — all top-10 candidates agreeing on one crval/scale). True
        // solutions form a consensus cluster; coincidences scatter. When >=5
        // of the top candidates agree with the best (crval within 0.1 deg,
        // scale within 3%), the floor drops to an absolute 20. NOT applied to
        // headerless files — repeated false geometry can also self-agree, and
        // without a scale gate that's unsafe.
        let consensus = 0;
        if (best && Number.isFinite(headerScale)) {
            const top = candStats.filter(k => !k.gated).sort((a, b) => b.matches - a.matches).slice(0, 10);
            consensus = top.filter(t =>
                t.crval &&
                Math.abs(t.scale - best.scale) / best.scale < 0.03 &&
                angSep(t.crval[0], t.crval[1], best.wcs.crval[0], best.wcs.crval[1]) < 0.1
            ).length;
        }
        const baseBar = Math.max(25, Math.round(det.length * 0.12));
        const gatedBar = (consensus >= 5) ? 20 : baseBar;
        const lockBar = Number.isFinite(headerScale) ? gatedBar : baseBar * 2;
        row.consensus = consensus;
        if (!best || best.matches < lockBar) { row.status = 'FAIL_NO_LOCK'; row.bestMatches = best?.matches ?? 0; row.lockBar = lockBar; return row; }
        const off = angSep(best.wcs.crval[0], best.wcs.crval[1], ra0, dec0);
        // Center tolerance scales with FOV: on a 15-deg mosaic canvas the
        // "center" header can legitimately sit many degrees from the solved
        // frame center (image floats in the canvas). Fixed 1.5 deg only
        // makes sense for telescope-FOV frames.
        const fovHalfDiagDeg = Math.hypot(W, H) / 2 * (best.scale) / 3600;
        const centerTol = Math.max(CENTER_TOL_DEG, fovHalfDiagDeg * 0.75);
        Object.assign(row, {
            status: off <= centerTol ? 'PASS' : 'SOLVED_OFF_HINT',
            solved: `${best.wcs.crval[0].toFixed(3)}h ${best.wcs.crval[1] >= 0 ? '+' : ''}${best.wcs.crval[1].toFixed(2)}`,
            scale: +best.scale.toFixed(3), matches: best.matches, residArcsec: best.resid,
            offsetDeg: +off.toFixed(3), candidate: best.cand,
        });
        return row;
    } catch (e) {
        row.error = String(e.message || e); return row;
    } finally { row.ms = row.ms || (Date.now() - t0); }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const files = [];
function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.fits?$/i.test(e.name)) files.push(p);
        else if (isCr2File(e.name)) files.push(p);
    }
}
walk(CORPUS_DIR);
const control = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
if (fs.existsSync(control) && !files.includes(control)) files.unshift(control);

console.log(`Corpus sweep: ${files.length} file(s) (dir: ${CORPUS_DIR})\n`);
const rows = [];
for (const f of files.slice(0, LIMIT)) {
    const r = isCr2File(f) ? await triageCr2(f) : triage(f);
    rows.push(r);
    const tag = r.status === 'PASS' ? '✓' : r.status.startsWith('SOLVED') ? '~' : '✗';
    // CR2 rows carry an extra format tag + lane; FITS lines stay byte-identical.
    const cr2Info = r.fmt ? `${r.fmt} ` : '';
    const cr2Lane = r.lane ? ` lane=${r.lane}` : '';
    console.log(`${tag} ${r.status.padEnd(16)} ${cr2Info}${path.basename(r.file).slice(0, 44).padEnd(46)} ${String(r.dims ?? '').padEnd(12)} stars=${String(r.stars ?? '-').padEnd(5)} scale=${r.scale ?? r.headerScale ?? '-'} matches=${r.matches ?? '-'} off=${r.offsetDeg ?? '-'} ${r.ms}ms ${r.error ?? ''}${cr2Lane}`);
}
const summary = {
    when: new Date().toISOString(),
    total: rows.length,
    byStatus: rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    rows,
};
fs.mkdirSync(path.join(ROOT, 'test_results'), { recursive: true });
const out = path.join(ROOT, 'test_results', 'corpus_report.json');
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\nSummary: ${JSON.stringify(summary.byStatus)}  →  ${path.relative(ROOT, out)}`);
// Append this sweep's per-frame results to the cumulative corpus ledger — the
// history the overwritten report throws away. Never let ledger I/O break the sweep.
try { const { ingestReport } = await import('./ledger.mjs'); ingestReport(out); }
catch (e) { console.warn('[ledger] append skipped:', e.message); }
process.exit(rows.every(r => r.status === 'PASS' || r.status.startsWith('SKIP')) ? 0 : 1);
