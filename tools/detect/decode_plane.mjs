// ═══════════════════════════════════════════════════════════════════════════
// CR2 → NATIVE LUMINANCE PLANE dumper (headless, no browser, no vite).
// ═══════════════════════════════════════════════════════════════════════════
// Reuses the EXACT decode path of tools/dslr/dump_cr2_solveframe.mjs (libraw-wasm
// via the repo worker_shim, dominant-channel gray = (r+g+b)/65535 at FULL native
// resolution — metadata_reaper.convertMemImageToRgb contract). Emits the linear
// luminance plane the MF detection front-end consumes, plus the CURRENT detector's
// baseline count on that SAME plane (extract_blobs @ SIGMA on linear gray, the m4
// SourceExtractor core) so the count-explosion gate is self-consistent.
//
//   node tools/detect/decode_plane.mjs --file <cr2> [--sigma 3.0] [--out-base <name>]
//
// Writes test_results/cr2_dets/<base>.detplane.f32  (Float32 W*H, native)
//        test_results/cr2_dets/<base>.detplane.json (meta + baseline count + medFWHM)
//
// TWO-LEDGER LAW: this is a decode utility only. No calibrated constant is
// authored; extract_blobs is the shipped, verified m4 core. Read-only w.r.t. src/.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', ''));
const SIGMA = parseFloat(argVal('--sigma', '3.0'));          // dump_cr2_solveframe CR2 threshold
const OUT_BASE = argVal('--out-base', FILE ? path.basename(FILE).replace(/\.[^.]+$/, '') : '');

// ── Browser-Worker bridge for libraw-wasm (identical shim to dump_cr2_solveframe) ──
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null;
    onerror = null;
    constructor(url) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); else console.error('[plane] worker error:', err); });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { }
}

const STAGE_TIMEOUT_MS = 300_000;
const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS / 1000}s`)), STAGE_TIMEOUT_MS).unref?.())
]);

function medianOf(arr) {
    const v = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : NaN;
}

async function main() {
    if (!FILE || !fs.existsSync(FILE)) { console.error(`[plane] FILE NOT FOUND: ${FILE}`); return 2; }
    const fileBuf = fs.readFileSync(FILE);
    console.log(`[plane] ${path.relative(ROOT, FILE)} (${(fileBuf.length / 1048576).toFixed(1)} MB) base=${OUT_BASE}`);

    // ── libraw-wasm decode (app open options — noInterpolation document mode) ──
    globalThis.Worker = BrowserWorkerOnNode;
    let meta, rawData;
    try {
        const LibRawModule = await import('libraw-wasm');
        const LibRaw = LibRawModule.default || LibRawModule;
        const raw = new LibRaw();
        await withTimeout('open()', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
            noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false,
        }));
        meta = await withTimeout('metadata()', raw.metadata());
        rawData = await withTimeout('imageData()', raw.imageData());
    } catch (err) { console.error(`[plane] libraw decode FAILED: ${err.message}`); finish(1); return 1; }

    const width = meta?.width || meta?.raw_width || 0;
    const height = meta?.height || meta?.raw_height || 0;
    if (!width || !height) { console.error('[plane] no dimensions from libraw'); finish(1); return 1; }

    let mem;
    if (rawData instanceof Uint16Array) mem = rawData;
    else if (rawData?.data instanceof Uint16Array) mem = rawData.data;
    else { const src = rawData?.buffer || rawData; mem = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength) / 2)); }
    const expectRgb3 = width * height * 3;
    console.log(`[plane] decoded ${width}x${height}, mem u16 len=${mem.length} (expect w*h*3=${expectRgb3})`);
    if (Math.abs(mem.length - expectRgb3) > width * 3) { console.error(`[plane] payload layout unexpected, aborting`); finish(1); return 1; }

    // ── dominant-channel gray, FULL RES (metadata_reaper.convertMemImageToRgb) ──
    const npix = width * height;
    const gray = new Float32Array(npix);
    for (let p = 0; p < npix; p++) { const i = p * 3; let v = (mem[i] + mem[i + 1] + mem[i + 2]) / 65535; gray[p] = v > 1 ? 1 : v; }

    // ── CURRENT detector baseline on the SAME linear gray plane (m4 extract_blobs) ──
    let baseline_raw_blobs = null, baseline_kept = null, medFwhm = null, bg = 0, sigma = 0;
    try {
        const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
        w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
        const sample = [];
        for (let i = 0; i < gray.length; i += 331) sample.push(gray[i]);
        sample.sort((a, b) => a - b);
        bg = sample[Math.floor(sample.length / 2)];
        const dev = sample.map(v => Math.abs(v - bg)).sort((a, b) => a - b);
        sigma = (1.4826 * dev[Math.floor(dev.length / 2)]) || 1e-4;
        const flat = w.extract_blobs(gray, width, height, bg + SIGMA * sigma, bg);
        const rawBlobs = [];
        for (let i = 0; i < flat.length; i += 10) rawBlobs.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], fwhm: flat[i + 6] });
        baseline_raw_blobs = rawBlobs.length;
        // LP-density cull + edge/dedup hygiene (mirror dump_cr2_solveframe), UNCAPPED count.
        const CELL = 64, gw = Math.ceil(width / CELL), dens = new Map();
        for (const s of rawBlobs) { const c = Math.floor(s.y / CELL) * gw + Math.floor(s.x / CELL); dens.set(c, (dens.get(c) ?? 0) + 1); }
        const LP_CULL = 150;
        const cleaned = rawBlobs.filter(s => (dens.get(Math.floor(s.y / CELL) * gw + Math.floor(s.x / CELL)) ?? 0) <= LP_CULL);
        cleaned.sort((a, b) => b.flux - a.flux);
        const margin = 24, kept = [];
        for (const s of cleaned) {
            if (s.x < margin || s.y < margin || s.x > width - margin || s.y > height - margin) continue;
            if (kept.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
            kept.push(s);
        }
        baseline_kept = kept.length;
        medFwhm = medianOf(kept.map(s => s.fwhm));
        console.log(`[plane] extract_blobs baseline: raw=${baseline_raw_blobs} kept(uncapped)=${baseline_kept} medFWHM=${medFwhm?.toFixed(2)} (bg=${bg.toFixed(4)} σ=${sigma.toFixed(4)} thr=${SIGMA}σ)`);
    } catch (err) { console.error('[plane] baseline extract FAILED:', err.message); }

    const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
    fs.mkdirSync(outDir, { recursive: true });
    const rawPath = path.join(outDir, `${OUT_BASE}.detplane.f32`);
    fs.writeFileSync(rawPath, Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength));
    const metaOut = {
        base: OUT_BASE, file: path.relative(ROOT, FILE).replace(/\\/g, '/'),
        width, height, length: npix, byteLength: gray.byteLength,
        convention: 'dominant_channel_gray_(r+g+b)/65535_linear',
        baseline_detector: 'extract_blobs (m4 core) on linear gray',
        baseline_sigma: SIGMA, baseline_bg: +bg.toFixed(6), baseline_noise: +sigma.toFixed(6),
        baseline_raw_blobs, baseline_kept_uncapped: baseline_kept,
        median_fwhm_px: Number.isFinite(medFwhm) ? +medFwhm.toFixed(3) : null,
        rawFile: path.basename(rawPath),
    };
    fs.writeFileSync(path.join(outDir, `${OUT_BASE}.detplane.json`), JSON.stringify(metaOut, null, 2));
    console.log(`[plane] -> ${path.relative(ROOT, rawPath)} (${(gray.byteLength / 1e6).toFixed(1)}MB) + meta`);
    finish(0); return 0;
}

function finish(code) { for (const w of liveWorkers) w.terminate().catch(() => { }); process.exitCode = code; }

const code = await main();
setTimeout(() => process.exit(code), 250);
