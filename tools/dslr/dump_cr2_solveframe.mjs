// ═══════════════════════════════════════════════════════════════════════════
// CR2 SOLVE-FRAME DUMP — headless decode → full-res detections + EXIF/scale
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/dslr/dump_cr2_solveframe.mjs [--file <path>] [--topN 800] [--sigma 3.5]
//
// Stage A of the ultra-wide CR2 debugging harness. Decodes a Canon CR2 exactly
// like the app's m1 ingestion (libraw-wasm document mode, dominant-channel gray
// per metadata_reaper.convertMemImageToRgb), extracts star detections at FULL
// NATIVE RESOLUTION (the resolution the wizard's m4 detector and the ultra-wide
// anchored sweep operate in — decode_cr2_smoke bins 2×2, which halves the scale
// and would desync the sweep geometry), and writes a compact solve-frame JSON:
//
//   test_results/cr2_dets/<basename>.json
//     { file, width, height, scaleArcsecPerPx, focalLengthMm, pitchUm,
//       timestamp, gps, exif, detections: [{x, y, flux}] (top-N by flux) }
//
// Stage B (the vitest solve harness) loads this and drives the REAL solver_entry
// ultra-wide path — no re-extraction, so solve iteration runs at test speed while
// the slow libraw decode happens once per frame here.
//
// SCALE: the Rokinon 14mm is manual (no electronic contacts) so EXIF FocalLength
// is a dummy (bundled sample = 50mm). The app's trust ladder overrides to the
// real 14mm; we mirror that (206.265 * pitch_um / 14) and also record the raw
// EXIF FL for transparency. Canon Rebel T6 (1300D) pitch = 4.30µm (SENSOR_DB).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';
import { computePlanets } from './ephem.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', 'public/demo/sample_observation.cr2'));
// Keep enough sources that the dense LP-noise field survives (the anchor-ID
// density cap keys on per-cell counts over ALL detections — truncating to the
// brightest few hundred would defeat the LP-dome rejection). The app forwards
// ~2000+ curated stars on these frames.
const TOP_N = parseInt(argVal('--topN', '3000'), 10);
const SIGMA = parseFloat(argVal('--sigma', '3.0'));
const ASSUMED_FL_MM = parseFloat(argVal('--fl', '14'));   // Rokinon 14mm override
const PITCH_UM = parseFloat(argVal('--pitch', '4.30'));   // Canon T6 / 1300D APS-C

const STAGE_TIMEOUT_MS = 240_000;
const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS / 1000}s`)), STAGE_TIMEOUT_MS).unref?.())
]);

// ── Browser-Worker bridge for libraw-wasm (same shim as decode_cr2_smoke) ──
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null;
    onerror = null;
    constructor(url) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); else console.error('[dump] worker error:', err); });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { }
}

async function main() {
    if (!fs.existsSync(FILE)) { console.error(`[dump] FILE NOT FOUND: ${FILE}`); return 1; }
    const fileBuf = fs.readFileSync(FILE);
    const base = path.basename(FILE).replace(/\.[^.]+$/, '');
    console.log(`[dump] ${path.relative(ROOT, FILE)} (${(fileBuf.length / 1048576).toFixed(1)} MB)`);

    // ── EXIF (exifr, same tags parseExif reads) ──
    let exif = {};
    try {
        const exifr = (await import('exifr')).default;
        const tags = await exifr.parse(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength), {
            tiff: true, xmp: true, icc: false, ifd1: false, mergeOutput: true, reviveValues: true, sanitize: true,
        }) || {};
        exif = {
            model: tags.Model ?? null,
            lens_model: tags.LensModel ?? null,
            lens_info: tags.LensInfo ?? null,
            focal_length_exif: (typeof tags.FocalLength === 'number') ? tags.FocalLength : null,
            iso: tags.ISO ?? null,
            exposure_s: tags.ExposureTime ?? null,
            date: tags.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.toISOString() : (tags.DateTimeOriginal ?? null),
            gps: (typeof tags.latitude === 'number') ? [tags.latitude, tags.longitude] : null,
            orientation: tags.Orientation ?? null,
        };
        console.log(`[dump] EXIF: ${exif.model} FL_exif=${exif.focal_length_exif} ISO${exif.iso} ${exif.exposure_s}s date=${exif.date} gps=${exif.gps ? exif.gps.map(v => v.toFixed(3)) : 'none'}`);
    } catch (err) { console.error('[dump] exifr FAILED:', err.message); exif.error = err.message; }

    // ── libraw-wasm decode (app open options) ──
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
    } catch (err) {
        console.error(`[dump] libraw decode FAILED: ${err.message}`);
        finish(1); return 1;
    }

    const width = meta?.width || meta?.raw_width || 0;
    const height = meta?.height || meta?.raw_height || 0;
    if (!width || !height) { console.error('[dump] no dimensions from libraw'); finish(1); return 1; }

    // mem_image = active-area interleaved RGB16, w*h*3 (metadata_reaper contract).
    let mem;
    if (rawData instanceof Uint16Array) mem = rawData;
    else if (rawData?.data instanceof Uint16Array) mem = rawData.data;
    else { const src = rawData?.buffer || rawData; mem = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength) / 2)); }
    const expectRgb3 = width * height * 3;
    console.log(`[dump] decoded ${width}x${height}, mem u16 len=${mem.length} (expect w*h*3=${expectRgb3})`);
    if (Math.abs(mem.length - expectRgb3) > width * 3) {
        console.error(`[dump] payload ${mem.length} != w*h*3 ${expectRgb3} — layout unexpected, aborting`);
        finish(1); return 1;
    }

    // ── dominant-channel gray, FULL RES (metadata_reaper.convertMemImageToRgb) ──
    // Document mode is one-hot; gray = (r+g+b)/65535 recovers the CFA site value
    // as a neutral, photometry-preserving luminance (no checkerboard weighting).
    const npix = width * height;
    const gray = new Float32Array(npix);
    for (let p = 0; p < npix; p++) {
        const i = p * 3;
        let v = (mem[i] + mem[i + 1] + mem[i + 2]) / 65535;
        gray[p] = v > 1 ? 1 : v;
    }

    // ── star extraction: extract_blobs on the FLOAT gray (full dynamic range) ──
    // extract on the linear float surface, NOT an 8-bit gamma preview: the app's
    // m4 detector runs on float RGB and finds ~2000+ sources on this frame. The
    // anchor-ID's LP-dome rejection keys on the DENSE noise field around the
    // light-pollution hotspot (its 3×3 cap scales with detected.length), so a
    // faithful density requires the full source count — an 8-bit preview
    // (bg=0.34, 193 dets) collapses that field and the anchor mis-lands.
    let detections = [];
    let bg = 0, sigma = 0, rawBlobCount = 0;
    try {
        const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
        w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
        // robust bg/σ via median + MAD on a linear-gray sample (nebulosity/LP-safe)
        const sample = [];
        for (let i = 0; i < gray.length; i += 331) sample.push(gray[i]);
        sample.sort((a, b) => a - b);
        bg = sample[Math.floor(sample.length / 2)];
        const dev = sample.map(v => Math.abs(v - bg)).sort((a, b) => a - b);
        sigma = (1.4826 * dev[Math.floor(dev.length / 2)]) || 1e-4;
        const flat = w.extract_blobs(gray, width, height, bg + SIGMA * sigma, bg);
        const rawBlobs = [];
        for (let i = 0; i < flat.length; i += 10) rawBlobs.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], fwhm: flat[i + 6] });
        rawBlobCount = rawBlobs.length;

        // LP-DENSITY CULL (mirrors SourceExtractor.cullAnomalies): remove blobs in
        // 64px cells that pack > LP_CULL sources — the light-pollution dome and
        // saturated-glow hotspots form pathologically dense clumps that otherwise
        // dominate a flux-ranked top-N and crowd out real faint stars. Genuine
        // Milky-Way-core density stays below this bar at 63"/px (64px ≈ 1.1°).
        const CELL = 64, gw = Math.ceil(width / CELL);
        const dens = new Map();
        for (const s of rawBlobs) { const c = Math.floor(s.y / CELL) * gw + Math.floor(s.x / CELL); dens.set(c, (dens.get(c) ?? 0) + 1); }
        const LP_CULL = 150;
        let culledLP = 0;
        const cleaned = rawBlobs.filter(s => {
            const c = Math.floor(s.y / CELL) * gw + Math.floor(s.x / CELL);
            if ((dens.get(c) ?? 0) > LP_CULL) { culledLP++; return false; }
            return true;
        });
        cleaned.sort((a, b) => b.flux - a.flux);
        // edge + dedup hygiene (mirrors run_corpus / decode_cr2_smoke)
        const margin = 24;
        const kept = [];
        for (const s of cleaned) {
            if (s.x < margin || s.y < margin || s.x > width - margin || s.y > height - margin) continue;
            if (kept.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
            kept.push(s);
            if (kept.length >= TOP_N) break;
        }
        detections = kept.map(s => ({ x: +s.x.toFixed(2), y: +s.y.toFixed(2), flux: +s.flux.toExponential(4), fwhm: +(s.fwhm ?? 0).toFixed(2) }));
        console.log(`[dump] extract_blobs: ${rawBlobCount} raw -> ${culledLP} LP-culled -> ${detections.length} detections (bg=${bg.toFixed(4)} sigma=${sigma.toFixed(4)} thr=${SIGMA}σ)`);
        console.log(`[dump] top6: ${detections.slice(0, 6).map(s => `(${s.x.toFixed(0)},${s.y.toFixed(0)} f=${(+s.flux).toExponential(1)})`).join(' ')}`);
    } catch (err) { console.error('[dump] extraction FAILED:', err.message, err.stack); finish(1); return 1; }

    // ── scale: 14mm override (mirrors app trust ladder), transparency on raw EXIF ──
    const scaleArcsecPerPx = +(206.265 * PITCH_UM / ASSUMED_FL_MM).toFixed(4);

    // ── planetary anchor centers for the frame's timestamp (correct ephemeris) ──
    let planets = [];
    if (exif.date) {
        try {
            planets = computePlanets(new Date(exif.date));
            console.log(`[dump] planets @${exif.date}: ${planets.map(p => `${p.name}=${p.ra_hours.toFixed(2)}h/${p.dec_degrees.toFixed(1)}° (m${p.mag})`).join('  ')}`);
        } catch (err) { console.error('[dump] ephemeris FAILED:', err.message); }
    }

    const out = {
        file: path.relative(ROOT, FILE).replace(/\\/g, '/'),
        width, height,
        scaleArcsecPerPx, focalLengthMm: ASSUMED_FL_MM, pitchUm: PITCH_UM,
        timestamp: exif.date ?? null,
        gps: exif.gps ?? null,
        exif,
        planets,
        detection: { raw_blobs: rawBlobCount, kept: detections.length, bg: +bg.toFixed(5), sigma: +sigma.toFixed(5), sigmaThreshold: SIGMA },
        detections,
    };
    const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${base}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log(`[dump] scale=${scaleArcsecPerPx}"/px @${ASSUMED_FL_MM}mm  FOV≈${(Math.hypot(width, height) * scaleArcsecPerPx / 3600).toFixed(0)}° diag`);
    console.log(`[dump] -> ${path.relative(ROOT, outPath)}  (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
    finish(0); return 0;
}

function finish(code) { for (const w of liveWorkers) w.terminate().catch(() => { }); process.exitCode = code; }

const code = await main();
setTimeout(() => process.exit(code), 250);
