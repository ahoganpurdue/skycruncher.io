// ═══════════════════════════════════════════════════════════════════════════
// DSLR CR2 DECODE SMOKE TEST — Phase B triage (headless Node, no browser)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/dslr/decode_cr2_smoke.mjs [--file <path>] [--verbose]
//
// Answers, against the bundled sample (public/demo/sample_observation.cr2):
//   1. Does libraw-wasm load + decode in plain Node at all? (It is a browser
//      Worker-based binding — we bridge via the repo's worker_shim.js.)
//   2. EXIF ground truth via exifr (same tags parseExif reads): camera body,
//      LensModel/LensInfo presence (the dummy-50mm trust-ladder question),
//      focal length, ISO, exposure, GPS.
//   3. RAW geometry: active width/height vs raw_width/raw_height, stride
//      (raw_pitch), optical-black margin — the exact fields
//      metadata_reaper.extractRawSensorData depends on.
//   4. CFA value statistics (median/p95/p99/max) — settles whether LibRaw
//      outputs 14-bit-native (0..16383, matching DEFAULT_DEMOSAIC_PARAMS
//      2048/16383) or 16-bit-expanded values (matching PhotometryManager's
//      8192/61440 default profile). These two app constants disagree.
//   5. Star-count estimate: 2x2 CFA binning -> luminance -> gamma-quantized
//      preview transform -> wasm_compute.extract_blobs (mirrors the
//      extractStars pattern in tools/corpus/run_corpus.mjs).
//
// If libraw-wasm cannot run in Node, the failing API surface + error are
// reported precisely (that decides whether DSLR corpus triage needs the
// browser). Exit 0 = decoded + stats printed; exit 1 = decode failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', 'public/demo/sample_observation.cr2'));
const VERBOSE = args.includes('--verbose');
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const summary = { file: path.relative(ROOT, FILE), node: process.version, libraw_loads_in_node: false };
const STAGE_TIMEOUT_MS = 180_000;
const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS / 1000}s`)), STAGE_TIMEOUT_MS).unref?.())
]);

// ── 1. Browser-Worker bridge (libraw-wasm spawns `new Worker(url,{type:module})`)
// Reuses src/engine/core/worker_shim.js: it shims self/window/fetch(file://)
// inside a worker_threads context and then imports the real worker script.
// (node_worker_polyfill.ts does the same but forces `--import tsx`; the shim
// itself is plain ESM .js, so we bridge directly — no tsx dependency.)
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
            else console.error('[smoke] worker error:', err);
        });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { /* not needed for this smoke */ }
}

async function main() {
    if (!fs.existsSync(FILE)) {
        console.error(`[smoke] FILE NOT FOUND: ${FILE}`);
        return 1;
    }
    const fileBuf = fs.readFileSync(FILE);
    console.log(`[smoke] ${summary.file} (${(fileBuf.length / 1024 / 1024).toFixed(1)} MB), Node ${process.version}`);

    // Magic bytes (mirrors detectMagicFormatSync: II/MM + CR at offset 8)
    const magicCR2 = (fileBuf[0] === 0x49 && fileBuf[1] === 0x49 && fileBuf[8] === 0x43 && fileBuf[9] === 0x52);
    console.log(`[smoke] Magic-byte CR2 detection: ${magicCR2 ? 'PASS' : 'FAIL'}`);
    summary.magic_cr2 = magicCR2;

    // ── 2. EXIF via exifr (same call shape as metadata_reaper.parseExif) ──
    try {
        const exifr = (await import('exifr')).default;
        const tags = await exifr.parse(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength), {
            tiff: true, xmp: true, icc: false, ifd1: false,
            mergeOutput: true, reviveValues: true, sanitize: true,
        }) || {};
        const pick = (k) => tags[k] === undefined ? '<absent>' : JSON.stringify(tags[k] instanceof Date ? tags[k].toISOString() : tags[k]);
        console.log('\n── EXIF (exifr, parseExif-equivalent options) ──');
        for (const k of ['Make', 'Model', 'LensModel', 'LensInfo', 'FocalLength', 'FNumber', 'ISO', 'ExposureTime', 'DateTimeOriginal', 'Orientation', 'latitude', 'longitude']) {
            console.log(`  ${k.padEnd(18)} ${pick(k)}`);
        }
        summary.exif = {
            model: tags.Model ?? null,
            lens_model_tag: tags.LensModel ?? null,
            lens_info_tag: tags.LensInfo ?? null,
            focal_length: tags.FocalLength ?? null,
            iso: tags.ISO ?? null,
            exposure_s: tags.ExposureTime ?? null,
            date: tags.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.toISOString() : (tags.DateTimeOriginal ?? null),
            gps: (typeof tags.latitude === 'number') ? [tags.latitude, tags.longitude] : null,
        };
        // Trust-ladder replica: what parseExif would store as lens_model, and
        // whether OpticsManager.getEffectiveFocalLength's dummy-50mm override
        // (`fl === 50 && !metadata.lens_model`) can ever fire on this file.
        let storedLens;
        if (typeof tags.LensModel === 'string' && tags.LensModel.trim()) storedLens = tags.LensModel.trim();
        else if (Array.isArray(tags.LensInfo) && tags.LensInfo[0] > 0) storedLens = `${tags.LensInfo[0]}mm Lens (from LensInfo)`;
        else storedLens = 'Unknown Lens';
        const fl = Number(tags.FocalLength);
        const overrideFires = (fl === 50 && !storedLens); // storedLens is always truthy -> never fires
        console.log(`  parseExif would store lens_model = ${JSON.stringify(storedLens)}`);
        console.log(`  dummy-50mm override (fl===50 && !lens_model) fires: ${overrideFires} ${overrideFires ? '' : ' <-- trust ladder resolves FL=' + fl + 'mm, NOT 14mm'}`);
        summary.stored_lens_model = storedLens;
        summary.dummy_override_fires = overrideFires;
        const PITCH_UM = 4.30; // SENSOR_DB Canon 18MP APS-C
        summary.scale_at_50mm = +(206.265 * PITCH_UM / 50).toFixed(2);
        summary.scale_at_14mm = +(206.265 * PITCH_UM / 14).toFixed(2);
        console.log(`  pixel scale @50mm: ${summary.scale_at_50mm}"/px   @14mm: ${summary.scale_at_14mm}"/px (pitch ${PITCH_UM}um)`);
    } catch (err) {
        console.error('[smoke] exifr parse FAILED:', err.message);
        summary.exif_error = err.message;
    }

    // ── 3. libraw-wasm decode (the actual smoke) ──
    globalThis.Worker = BrowserWorkerOnNode;
    let raw = null;
    let meta = null;
    let rawData = null;
    try {
        console.log('\n── libraw-wasm (Node, worker_shim bridge) ──');
        // Mirrors metadata_reaper.extractRawSensorData exactly:
        const LibRawModule = await import('libraw-wasm');
        const LibRaw = LibRawModule.default || LibRawModule;
        raw = new LibRaw();
        console.log('  import + construct: OK (worker spawned)');

        await withTimeout('open()', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
            noInterpolation: true, // 'Document Mode' — native Bayer, no demosaic
            outputBps: 16,         // 16-bit linear integers
            noAutoBright: true,    // preserve photometry
            useCameraWb: false,    // RAW values only
            useAutoWb: false
        }));
        console.log('  open(): OK');

        meta = await withTimeout('metadata()', raw.metadata());
        console.log('  metadata(): OK — keys:', Object.keys(meta ?? {}).sort().join(', '));
        vlog('  metadata dump:', JSON.stringify(meta, (_, v) => typeof v === 'bigint' ? String(v) : v, 2));

        rawData = await withTimeout('imageData()', raw.imageData());
        console.log(`  imageData(): OK — type=${rawData?.constructor?.name}, length=${rawData?.length}, byteLength=${rawData?.byteLength}`);
        summary.libraw_loads_in_node = true;
    } catch (err) {
        console.error(`[smoke] libraw-wasm FAILED in Node: ${err.message}`);
        console.error('        (API surface: browser Worker + fetch(file://) via worker_shim bridge)');
        summary.libraw_error = err.message;
        finish(1);
        return 1;
    }

    // ── 4. Geometry: the exact fields metadata_reaper reads ──
    const width = meta?.width || meta?.raw_width || meta?.imageSize?.width || 0;
    const height = meta?.height || meta?.raw_height || meta?.imageSize?.height || 0;
    const rawWidth = meta?.raw_width || width;
    const rawHeight = meta?.raw_height || height;
    const stride = meta?.raw_pitch ? (meta.raw_pitch / 2) : rawWidth;
    console.log('\n── RAW geometry (metadata_reaper field contract) ──');
    console.log(`  meta.width x meta.height     : ${meta?.width} x ${meta?.height}   (active area; expect 5184x3456)`);
    console.log(`  meta.raw_width x raw_height  : ${meta?.raw_width} x ${meta?.raw_height} (with optical-black padding)`);
    console.log(`  meta.raw_pitch               : ${meta?.raw_pitch} bytes -> element stride ${stride}`);
    console.log(`  optical-black right margin   : ${rawWidth > width ? (rawWidth - width) + 'px (calibrationStrip WILL be harvested)' : 'none (calibrationStrip skipped)'}`);
    summary.geometry = { width, height, rawWidth, rawHeight, stride, activeAreaOk: width === 5184 && height === 3456 };

    // CFA element buffer, cast exactly like extractRawSensorData step 4
    let cfa;
    if (ArrayBuffer.isView(rawData) && rawData instanceof Uint16Array) cfa = rawData;
    else if (rawData?.data instanceof Uint16Array) cfa = rawData.data;
    else {
        const src = rawData?.buffer || rawData;
        cfa = new Uint16Array(src, rawData?.byteOffset || 0, (rawData?.length && rawData.BYTES_PER_ELEMENT === 2) ? rawData.length : Math.floor((rawData.byteLength ?? src.byteLength) / 2));
    }
    const expectCfa = stride * height;
    const expectRgb3 = width * height * 3;
    console.log(`  u16 element count            : ${cfa.length} (CFA stride*h=${expectCfa}; RGB16 w*h*3=${expectRgb3})`);
    const layout = cfa.length >= expectCfa && cfa.length < expectCfa * 1.5 ? 'CFA_MOSAIC'
        : (Math.abs(cfa.length - expectRgb3) < width * 3 ? 'RGB_INTERLEAVED_16' : 'UNEXPECTED');
    console.log(`  inferred payload layout      : ${layout}${layout !== 'CFA_MOSAIC' ? '  <-- extractRawSensorData assumes CFA; VERIFY' : ''}`);
    summary.payload_layout = layout;
    summary.cfa_elements = cfa.length;
    // CFA pattern: LibRaw 'filters'/'cdesc' if exposed; Canon bodies are RGGB.
    summary.cfa_pattern_fields = { filters: meta?.filters ?? null, cdesc: meta?.cdesc ?? null, cfa: meta?.cfa ?? null };
    console.log(`  CFA pattern fields           : filters=${meta?.filters ?? '<absent>'} cdesc=${meta?.cdesc ?? '<absent>'} (Canon default assumption: RGGB)`);
    const blackMeta = meta?.black ?? meta?.blackLevel ?? null;
    const maximumMeta = meta?.maximum ?? meta?.white ?? null;
    console.log(`  black/maximum from metadata  : black=${blackMeta ?? '<absent>'} maximum=${maximumMeta ?? '<absent>'}`);

    // ── 5. CFA value statistics (14-bit vs 16-bit question) ──
    const activeSamples = [];
    const stepY = Math.max(1, Math.floor(height / 400));
    for (let y = 0; y < height; y += stepY) {
        const rowStart = y * stride;
        for (let x = (y % 7); x < width; x += 13) activeSamples.push(cfa[rowStart + x]);
    }
    activeSamples.sort((a, b) => a - b);
    const q = (p) => activeSamples[Math.min(activeSamples.length - 1, Math.floor(activeSamples.length * p))];
    const stats = { min: activeSamples[0], median: q(0.5), p95: q(0.95), p99: q(0.99), max: activeSamples[activeSamples.length - 1] };
    console.log('\n── CFA statistics (active area sample) ──');
    console.log(`  min=${stats.min} median=${stats.median} p95=${stats.p95} p99=${stats.p99} max=${stats.max}`);
    const bitScale = stats.max > 20000 ? '16-BIT-EXPANDED (PhotometryManager 8192/61440 profile matches; demosaic 2048/16383 defaults DO NOT)'
        : '14-BIT-NATIVE (demosaic 2048/16383 defaults match; PhotometryManager 8192/61440 default DOES NOT)';
    console.log(`  verdict: ${bitScale}`);
    summary.cfa_stats = stats;
    summary.value_scale_verdict = stats.max > 20000 ? '16bit_expanded' : '14bit_native';
    if (rawWidth > width) {
        let obSum = 0, obN = 0;
        for (let y = 0; y < height; y += stepY) {
            for (let x = width; x < Math.min(rawWidth, width + 64); x += 3) { obSum += cfa[y * stride + x]; obN++; }
        }
        summary.optical_black_mean = +(obSum / Math.max(1, obN)).toFixed(1);
        console.log(`  optical-black strip mean     : ${summary.optical_black_mean} (true sensor pedestal)`);
    }

    // ── 6. Luminance (2x2 CFA binning, DemosaicEngine.binBayerToluminance port) ──
    const black = blackMeta ?? summary.optical_black_mean ?? 2048;
    const white = maximumMeta ?? (summary.value_scale_verdict === '16bit_expanded' ? 61440 : 16383);
    const bw = Math.floor(width / 2), bh = Math.floor(height / 2);
    const lum = new Float32Array(bw * bh);
    const range = Math.max(1, white - black);
    for (let y = 0; y < bh; y++) {
        const r0 = (2 * y) * stride, r1 = (2 * y + 1) * stride;
        for (let x = 0; x < bw; x++) {
            const c = 2 * x;
            const v = (cfa[r0 + c] + cfa[r0 + c + 1] + cfa[r1 + c] + cfa[r1 + c + 1]) * 0.25;
            const n = (v - black) / range;
            lum[y * bw + x] = n < 0 ? 0 : (n > 1 ? 1 : n);
        }
    }
    console.log(`\n── Luminance (2x2 bin ${bw}x${bh}, black=${black}, white=${white}) ──`);

    // ── 7. Star extraction (extractStars pattern from tools/corpus/run_corpus.mjs) ──
    let stars = [];
    try {
        const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
        w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
        const g = new Float32Array(lum.length);
        for (let i = 0; i < lum.length; i++) g[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, lum[i]), 1 / 2.2) * 255))) / 255;
        const sample = [];
        for (let i = 0; i < g.length; i += 997) { if (g[i] > 0) sample.push(g[i]); }
        if (sample.length < 100) for (let i = 0; i < g.length; i += 997) sample.push(g[i]);
        sample.sort((a, b) => a - b);
        const bg = sample[Math.floor(sample.length / 2)];
        const sigma = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
        const flat = w.extract_blobs(g, bw, bh, bg + 3.5 * sigma, bg);
        const rawBlobs = [];
        for (let i = 0; i < flat.length; i += 10) rawBlobs.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4] });
        rawBlobs.sort((a, b) => b.flux - a.flux);
        const margin = 24;
        for (const s of rawBlobs) {
            if (s.x < margin || s.y < margin || s.x > bw - margin || s.y > bh - margin) continue;
            if (stars.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
            stars.push(s);
        }
        console.log(`  extract_blobs: ${rawBlobs.length} raw blobs -> ${stars.length} stars after edge/dedup hygiene (bg=${bg.toFixed(4)}, sigma=${sigma.toFixed(4)})`);
        console.log(`  top8: ${stars.slice(0, 8).map(s => `(${s.x.toFixed(0)},${s.y.toFixed(0)} f=${s.flux.toExponential(1)})`).join(' ')}`);
        summary.detection = { raw_blobs: rawBlobs.length, stars: stars.length, bg: +bg.toFixed(4), sigma: +sigma.toFixed(4) };
    } catch (err) {
        console.error('[smoke] star extraction FAILED:', err.message);
        summary.detection_error = err.message;
    }

    finish(0);
    return 0;
}

function finish(code) {
    const outDir = path.join(ROOT, 'test_results');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'dslr_smoke.json'), JSON.stringify(summary, null, 2));
        console.log(`\n[smoke] summary -> test_results/dslr_smoke.json (exit ${code})`);
    } catch { /* summary write is best-effort */ }
    for (const w of liveWorkers) w.terminate().catch(() => { });
}

const code = await main();
// Worker threads keep the loop alive; explicit exit after cleanup.
setTimeout(() => process.exit(code), 250);
