// ═══════════════════════════════════════════════════════════════════════════
// CFA-LUMINANCE PARITY PROBE (headless, no browser)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/dslr/cfa_parity_probe.mjs [--file <path>]
//
// Decodes the bundled CR2 exactly as metadata_reaper.extractRawSensorData does
// (libraw noInterpolation -> interleaved RGB16 document-mode mem_image), then
// characterizes the 2px CFA-luminance checkerboard:
//   1. cross-leak: median (2nd-max / max) channel ratio per pixel — settles
//      whether the mem_image is TRUE one-hot (ratio~0) or dominant-channel leak.
//   2. period-2 parity amplitude of the DETECTION luminance under:
//        (a) Rec.709 weights 0.2126R+0.7152G+0.0722B  (current computeLuminance)
//        (b) equal-weight    (R+G+B)/3                 (the parity fix)
//      Parity = |mean( lum * (-1)^(x+y) )| / mean(lum)  (Nyquist checkerboard).
//      Also reports the 4 RGGB 2x2-phase-class means.
//
// This is the MEASURED artifact A/B: (a)=before, (b)=after. No app state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', 'public/demo/sample_observation.cr2'));

const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null; onerror = null;
    constructor(url) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); else console.error('[probe] worker error:', err); });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() {}
}

const withTimeout = (label, p, ms = 180000) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms).unref?.())
]);

// Period-2 checkerboard parity amplitude + RGGB phase means over the full frame.
function parityMetrics(lum, w, h) {
    let sum = 0, signed = 0, n = 0;
    const cls = [0, 0, 0, 0], clsN = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = lum[y * w + x];
            if (!Number.isFinite(v)) continue;
            sum += v; n++;
            signed += ((x + y) & 1) ? -v : v;
            const c = (x & 1) | ((y & 1) << 1); // 0=(0,0)R 1=(1,0)G 2=(0,1)G 3=(1,1)B for RGGB
            cls[c] += v; clsN[c]++;
        }
    }
    const mean = sum / Math.max(1, n);
    const parity = Math.abs(signed / Math.max(1, n)) / Math.max(1e-9, mean);
    const phase = cls.map((s, i) => s / Math.max(1, clsN[i]));
    return { mean, parity, phase };
}

async function main() {
    if (!fs.existsSync(FILE)) { console.error(`[probe] FILE NOT FOUND: ${FILE}`); return 1; }
    const fileBuf = fs.readFileSync(FILE);
    console.log(`[probe] ${path.relative(ROOT, FILE)} (${(fileBuf.length / 1024 / 1024).toFixed(1)} MB)`);

    globalThis.Worker = BrowserWorkerOnNode;
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    // EXACT metadata_reaper.extractRawSensorData open() params:
    await withTimeout('open', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
        noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false
    }));
    const meta = await withTimeout('metadata', raw.metadata());
    const rawData = await withTimeout('imageData', raw.imageData());
    const width = meta?.width || meta?.raw_width || 0;
    const height = meta?.height || meta?.raw_height || 0;

    let mem;
    if (ArrayBuffer.isView(rawData) && rawData instanceof Uint16Array) mem = rawData;
    else if (rawData?.data instanceof Uint16Array) mem = rawData.data;
    else { const src = rawData?.buffer || rawData; mem = new Uint16Array(src, rawData?.byteOffset || 0, (rawData.byteLength ?? src.byteLength) / 2); }

    console.log(`[probe] active ${width}x${height}, mem elements=${mem.length}, expect w*h*3=${width * height * 3} (RGB16 interleaved: ${mem.length === width * height * 3})`);
    if (mem.length !== width * height * 3) { console.error('[probe] NOT the w*h*3 mem_image layout — abort.'); return 1; }

    const pixelCount = width * height;

    // ── cross-leak: replicate convertMemImageToRgb one-hot probe + measure ratio
    let multiChannel = 0, probed = 0;
    let ratioSum = 0, ratioN = 0, litOne = 0;
    const ratios = [];
    for (let p = 0; p < pixelCount; p += 997) {
        const i = p * 3;
        const a = mem[i], b = mem[i + 1], c = mem[i + 2];
        const lit = (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0) + (c > 0 ? 1 : 0);
        if (lit >= 2) multiChannel++;
        if (lit === 1) litOne++;
        probed++;
        const mx = Math.max(a, b, c);
        if (mx > 0) {
            const sorted = [a, b, c].sort((x, y) => y - x);
            const r = sorted[1] / mx; // second-largest / largest
            ratioSum += r; ratioN++; ratios.push(r);
        }
    }
    ratios.sort((x, y) => x - y);
    const medRatio = ratios.length ? ratios[ratios.length >> 1] : 0;
    const isDocumentMode = probed > 0 && (multiChannel / probed) < 0.02;
    console.log(`\n── cross-leak probe (${probed} sampled px) ──`);
    console.log(`  multiChannel(>=2 lit) frac = ${(multiChannel / probed).toFixed(4)}  -> existing isDocumentMode = ${isDocumentMode}`);
    console.log(`  exactly-1-lit frac         = ${(litOne / probed).toFixed(4)}`);
    console.log(`  median (2nd-max/max) ratio = ${medRatio.toFixed(4)}  mean = ${(ratioSum / Math.max(1, ratioN)).toFixed(4)}`);
    console.log(`  (ratio ~0 => one-hot; small ~0.04-0.07 => dominant-channel leak; large => genuine RGB)`);

    // ── build fullRGB EXACTLY as convertMemImageToRgb else-branch (straight copy /65535)
    const inv = 1 / 65535;
    const rec709 = new Float32Array(pixelCount);
    const equal = new Float32Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
        const i = p * 3;
        const r = mem[i] * inv, g = mem[i + 1] * inv, b = mem[i + 2] * inv;
        rec709[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        equal[p] = (r + g + b) * (1 / 3);
    }

    const A = parityMetrics(rec709, width, height); // before
    const B = parityMetrics(equal, width, height);   // after
    console.log(`\n── period-2 parity amplitude (checkerboard) ──`);
    console.log(`  (a) Rec.709 luma  parity=${A.parity.toExponential(3)}  mean=${A.mean.toExponential(3)}  phaseRGGB=[${A.phase.map(v => v.toExponential(2)).join(', ')}]`);
    console.log(`  (b) equal-weight  parity=${B.parity.toExponential(3)}  mean=${B.mean.toExponential(3)}  phaseRGGB=[${B.phase.map(v => v.toExponential(2)).join(', ')}]`);
    const reduction = A.parity > 0 ? (1 - B.parity / A.parity) * 100 : 0;
    console.log(`  parity reduction (a->b) = ${reduction.toFixed(1)}%`);

    // ── detection-count A/B: identical extract_blobs recipe on both lumas
    // (gamma-quantized transform + median/sigma threshold — the pattern from
    // tools/dslr/decode_cr2_smoke.mjs §7 / tools/corpus extractStars). A
    // detection-count PROXY for the m4 pipeline: same recipe both arms, so the
    // Δ isolates the luminance weighting.
    try {
        const wasm = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
        wasm.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
        const detect = (lum, label) => {
            const g = new Float32Array(lum.length);
            for (let i = 0; i < lum.length; i++) g[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, lum[i]), 1 / 2.2) * 255))) / 255;
            const sample = [];
            for (let i = 0; i < g.length; i += 997) sample.push(g[i]);
            sample.sort((x, y) => x - y);
            const bg = sample[sample.length >> 1];
            const sigma = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
            const flat = wasm.extract_blobs(g, width, height, bg + 3.5 * sigma, bg);
            const rawBlobs = [];
            for (let i = 0; i < flat.length; i += 10) rawBlobs.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4] });
            rawBlobs.sort((x, y) => y.flux - x.flux);
            const margin = 24, stars = [];
            for (const s of rawBlobs) {
                if (s.x < margin || s.y < margin || s.x > width - margin || s.y > height - margin) continue;
                if (stars.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
                stars.push(s);
            }
            console.log(`  ${label}: raw_blobs=${rawBlobs.length} stars=${stars.length} (bg=${bg.toFixed(4)} sigma=${sigma.toFixed(4)} thr=${(bg + 3.5 * sigma).toFixed(4)})`);
            return { raw: rawBlobs.length, stars: stars.length };
        };
        console.log(`\n── detection-count A/B (extract_blobs, same recipe both arms) ──`);
        const dA = detect(rec709, '(a) Rec.709 luma ');
        const dB = detect(equal, '(b) equal-weight ');
        console.log(`  Δ stars = ${dB.stars - dA.stars} (${dA.stars} -> ${dB.stars}), Δ raw blobs = ${dB.raw - dA.raw}`);
    } catch (err) {
        console.error('[probe] detection A/B FAILED:', err.message);
    }

    for (const w of liveWorkers) w.terminate().catch(() => {});
    return 0;
}
const code = await main().catch(e => { console.error('[probe] FAILED:', e); return 1; });
setTimeout(() => process.exit(code), 250);
