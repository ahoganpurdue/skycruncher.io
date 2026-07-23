// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — ENGINE-PATH raw decode (CR2 + Fuji X-Trans RAF), decode-only
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: the shared tools decode `tools/psf/decode_cr2.mjs` opens
// libraw in DOCUMENT MODE (noInterpolation:true) and hands consumers a
// dominant-channel Bayer MOSAIC to demosaic themselves (detectPattern +
// demosaicBilinear). That is correct for a 2×2 Bayer CFA, but on a Fuji
// X-Trans (6×6) sensor the 2×2 assumption CHECKERBOARDS the frame — which is
// why the mesh-graduation and census lanes could not process the contributed X-T4/X-T5
// DSCF*.RAF frames. This module gives the tools lanes a route through the
// ENGINE decode path (the same decode the live wizard + headless driver use),
// so X-Trans comes out checkerboard-free.
//
// ENGINE ARM SELECTION (faithful mirror of the engine's decode gate in
// src/engine/pipeline/m1_ingestion/metadata_reaper.ts `extractRawSensorData` +
// rawler_decoder.ts):
//   • RAF / Fuji X-Trans  → LIBRAW arm with FULL Markesteijn demosaic
//     (noInterpolation:FALSE). The rawler wasm rail hardcodes a 2×2 Bayer tile
//     (src/engine/wasm_decode/src/lib.rs `pat:[usize;4]`) and has NO X-Trans
//     support, so a RAF MUST decode on libraw's full-demosaic arm — libraw
//     auto-selects the CFA-appropriate algorithm (Markesteijn for X-Trans).
//     This is exactly metadata_reaper's `NEEDS_FULL_DEMOSAIC = magic==='RAF'`
//     + `forceLibrawArm` per-format override.
//   • CR2 / Bayer (default) → RAWLER wasm rail (`decode_raw().rgb16_active()`),
//     the SHIPPED default decoder since the 2026-07-11 cutover — the exact
//     u16 demosaiced-active payload `decodeRawlerForPipeline` feeds the pipeline
//     (minus its /65535 Float32 normalization). Pedestal INCLUDED, NOT
//     black-subtracted, NOT white-scaled (LAW 2: no calibration decision here).
//
// OUTPUT CONTRACT (superset of decode_cr2.mjs's `{ w, h, rgb16, meta }`):
//   { w, h, rgb16, meta, demosaiced:true, arm, rawler? }
//   rgb16 = Uint16Array, interleaved RGB, length w·h·3, ALREADY DEMOSAICED.
//
// HONEST DELTA vs decodeCR2 (consumers MUST know):
//   • decodeCR2's rgb16 is a dominant-channel one-hot MOSAIC that the consumer
//     demosaics; decodeEngine's rgb16 is ALREADY a genuine demosaiced RGB
//     interleave (identical shape to `tools/psf/decode_fits.mjs`). The standard
//     consumer chain `const layout = detectPattern(rgb16,w,h);
//     layout.oneHot ? demosaicBilinear(...) : splitRGB(...)` lands in the
//     splitRGB branch BY CONSTRUCTION (a demosaiced payload is not a one-hot
//     CFA), so existing consumers work unchanged — swap `decodeCR2` for
//     `decodeEngine` and drop the manual demosaic.
//   • VALUE DOMAIN differs by arm and is NOT byte-identical to decodeCR2
//     (byte-identity is not expected across decoders — the engine arm is the
//     reference). rawler arm = raw-ADU pedestal-included /1 (u16); libraw arm =
//     libraw's demosaiced 16-bit output. Absolute luminance levels therefore
//     differ from decodeCR2's libraw-document-mode black-subtracted mosaic.
//
// LEDGER: PIXEL (decode + demosaic; no coordinate math). LAW 4 incubator: a
// thin Node driver over the SHIPPED wasm/libraw decode — NOT a second decoder.
// The rawler loader is reused from tools/calib/decode_util.mjs; the demosaic
// itself lives in the wasm crate (rawler arm) / libraw (RAF arm) — single source.
// LAW 7: pure CONSUMER of the `rawler_cfa` boundary (rgb16_active) — no stride/
// index/unit is defined or changed here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

import { candidateDims, inferDims, strideCoherence } from './decode_cr2.mjs';
import { loadDecoder } from '../calib/decode_util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');

// ── libraw Node bridge (RAF arm) — same worker_shim mechanism decode_cr2.mjs /
// headless_driver.ts / decode_raf_smoke.mjs use. libraw decodes inside a browser
// Worker; Node has none, so bridge worker_threads → the browser Worker API. ──
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
            else console.error('[decode_engine] worker error:', err);
        });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() { /* workers torn down at process exit */ }
}

/** Terminate any libraw decode workers spawned by the RAF arm (mirror decode_cr2). */
export function terminateEngineDecodeWorkers() {
    for (const w of liveWorkers) w.terminate().catch(() => { });
}

const STAGE_TIMEOUT_MS = 240_000;
const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(
        () => rej(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS / 1000}s`)),
        STAGE_TIMEOUT_MS,
    ).unref?.()),
]);

/**
 * Sniff the raw container from magic bytes (same discriminators the engine and
 * decode_raf_smoke.mjs use). Returns:
 *   'FITS' — pure-TS decoder territory (use tools/psf/decode_fits.mjs; NOT raw)
 *   'RAF'  — Fuji ("FUJIFILMCCD-RAW" @0) → libraw full-demosaic (X-Trans safe)
 *   'RAW'  — anything else (Canon CR2 / TIFF-based Bayer) → rawler wasm rail
 */
export function sniffRawFormat(buffer) {
    const u8 = new Uint8Array(buffer, 0, Math.min(32, buffer.byteLength));
    const ascii = (off, len) => {
        let s = '';
        for (let i = off; i < off + len && i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
    };
    if (ascii(0, 6) === 'SIMPLE') return 'FITS';
    if (ascii(0, 15) === 'FUJIFILMCCD-RAW') return 'RAF';
    return 'RAW';
}

/**
 * Resolve interleaved-RGB (w·h·3) dims: trust meta first, fall back to the
 * shared decode_cr2 factorization helpers (candidate enumeration + stride-
 * coherence tie-break, the 60Da-shear-safe rule) so a padded/ambiguous frame
 * cannot silently shear.
 */
function resolveDemosaicedDims(len, meta) {
    if (len % 3 !== 0) throw new Error(`engine payload length ${len} not divisible by 3 — not interleaved RGB`);
    const n = len / 3;
    const w = Math.round(meta?.width || meta?.raw_width || meta?.imageSize?.width || 0);
    const h = Math.round(meta?.height || meta?.raw_height || meta?.imageSize?.height || 0);
    if (w > 0 && h > 0 && w * h === n) return { w, h };
    // ambiguous / padded — reuse the shared 60Da-safe inference
    const cands = candidateDims(len, meta);
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
        // strideCoherence expects the interleaved rgb16 buffer; caller re-checks
        // the invariant. Pick the lowest-shear candidate.
        return cands;
    }
    return inferDims(len, meta);
}

/**
 * RAF / Fuji X-Trans arm: libraw with FULL demosaic (noInterpolation:false).
 * libraw auto-picks Markesteijn for X-Trans → a genuine demosaiced interleaved
 * RGB16 mem_image (all channels populated), NOT a 6×6 CFA grid. This is the
 * engine's `NEEDS_FULL_DEMOSAIC` per-format override.
 */
async function decodeRafLibraw(fileBuf) {
    globalThis.Worker = BrowserWorkerOnNode;
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    await withTimeout('open()', raw.open(
        new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength),
        {
            noInterpolation: false, // FULL demosaic — Markesteijn for X-Trans (engine arm)
            outputBps: 16,
            noAutoBright: true,
            useCameraWb: false,
            useAutoWb: false,
        },
    ));
    const meta = await withTimeout('metadata()', raw.metadata());
    const rawData = await withTimeout('imageData()', raw.imageData());

    let rgb16;
    if (rawData instanceof Uint16Array) rgb16 = rawData;
    else if (rawData?.data instanceof Uint16Array) rgb16 = rawData.data;
    else {
        const src = rawData?.buffer || rawData;
        rgb16 = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength) / 2));
    }
    if (rgb16.length === 0) throw new Error('libraw RAF decode produced an empty buffer');

    let dims = resolveDemosaicedDims(rgb16.length, meta);
    if (Array.isArray(dims)) {
        // multiple factorizations — break the tie by stride coherence
        let best = null;
        for (const c of dims) {
            const score = strideCoherence(rgb16, c.w, c.h);
            if (!best || score < best.score) best = { ...c, score };
        }
        dims = { w: best.w, h: best.h };
    }
    const { w, h } = dims;
    if (w * h * 3 !== rgb16.length) {
        throw new Error(`RAF payload contract violated: ${rgb16.length} !== ${w}x${h}x3 (meta ${meta?.width}x${meta?.height})`);
    }
    return { w, h, rgb16, meta, arm: 'libraw-fulldemosaic' };
}

/**
 * CR2 / Bayer arm: the rawler wasm rail — the SHIPPED default decoder. Emits the
 * exact `rgb16_active()` u16 demosaiced-active payload the engine's
 * `decodeRawlerForPipeline` feeds the pipeline (pedestal-included raw-ADU domain).
 * Reuses the shared wasm_decode Node loader from tools/calib/decode_util.mjs.
 */
async function decodeRawler(fileBuf) {
    const mod = await loadDecoder();
    const dec = mod.decode_raw(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength));
    try {
        const meta = JSON.parse(dec.meta_json());
        const w = dec.active_w;
        const h = dec.active_h;
        // rgb16_active() copies out of wasm linear memory; copy once more to be
        // defensive against view aliasing after free().
        const src = dec.rgb16_active();
        if (src.length !== w * h * 3) {
            throw new Error(`rgb16_active length ${src.length} != ${w}x${h}x3`);
        }
        const rgb16 = new Uint16Array(src.length);
        rgb16.set(src);
        return { w, h, rgb16, meta, arm: 'rawler', rawler: {
            decoder: meta.decoder,
            fullWidth: meta.width,
            fullHeight: meta.height,
            pattern: meta.cfa_pattern_full,
            patternActive: meta.cfa_pattern_active,
            blacklevelBayer: meta.blacklevel_bayer,
            whitelevel: meta.whitelevel,
            activeArea: meta.active_area,
            valueDomain: 'raw_adu_pedestal_over_65535',
        } };
    } finally {
        dec.free();
    }
}

/**
 * Decode ANY supported raw (CR2/RAF) through the ENGINE decode path, DECODE-ONLY
 * (no solve). Returns the demosaiced `{ w, h, rgb16, meta, demosaiced, arm }`
 * contract (see file header). `opts.arm` ('rawler'|'libraw') forces an arm,
 * bypassing the magic sniff (e.g. to A/B a Bayer frame across both decoders);
 * default = engine-faithful per-format selection.
 */
export async function decodeEngine(filePath, opts = {}) {
    const fileBuf = fs.readFileSync(filePath);
    const ab = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
    const fmt = opts.arm ? null : sniffRawFormat(ab);
    if (fmt === 'FITS') {
        throw new Error('decodeEngine: FITS is not a raw sensor format — use tools/psf/decode_fits.mjs');
    }
    const useLibraw = opts.arm === 'libraw' || (!opts.arm && fmt === 'RAF');
    const out = useLibraw ? await decodeRafLibraw(fileBuf) : await decodeRawler(fileBuf);
    return { ...out, demosaiced: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// THIN CLI (LAW 4) — self-proving driver. Decode --file through the engine arm,
// print the contract summary + a background-patch CHECKERBOARD index (objective:
// a clean demosaic → low; a residual 2px CFA checkerboard → elevated), and write
// a stretched luma preview PNG for eyes-on. `node decode_engine.mjs --file <raw>
// [--out <dir>] [--arm rawler|libraw]`.
// ─────────────────────────────────────────────────────────────────────────────

function luma709FromRgb16(rgb16, w, h) {
    const n = w * h;
    const lum = new Float32Array(n);
    const inv = 1 / 65535;
    for (let i = 0; i < n; i++) {
        const b = i * 3;
        lum[i] = (0.2126 * rgb16[b] + 0.7152 * rgb16[b + 1] + 0.0722 * rgb16[b + 2]) * inv;
    }
    return lum;
}

/** period-2 checkerboard metric on an interior crop (mirrors decode_plane_rawler). */
function checkerboardIndex(luma, w, h, cx, cy, n) {
    const x0 = Math.max(0, Math.min(w - n, cx - (n >> 1)));
    const y0 = Math.max(0, Math.min(h - n, cy - (n >> 1)));
    let hf = 0, cnt = 0, sum = 0, sum2 = 0;
    const phaseSum = [0, 0, 0, 0], phaseCnt = [0, 0, 0, 0];
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const v = luma[(y0 + y) * w + (x0 + x)];
        const nb = 0.25 * (
            luma[(y0 + y - 1) * w + (x0 + x)] + luma[(y0 + y + 1) * w + (x0 + x)] +
            luma[(y0 + y) * w + (x0 + x - 1)] + luma[(y0 + y) * w + (x0 + x + 1)]);
        hf += Math.abs(v - nb); cnt++;
        sum += v; sum2 += v * v;
        const p = ((y & 1) << 1) | (x & 1); phaseSum[p] += v; phaseCnt[p]++;
    }
    const mean = sum / cnt, rms = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
    const phaseMean = phaseSum.map((s, i) => s / (phaseCnt[i] || 1));
    return {
        at: { x: x0, y: y0, n },
        hf_over_rms: +(hf / cnt / (rms || 1e-6)).toFixed(4),
        phase_spread_over_rms: +((Math.max(...phaseMean) - Math.min(...phaseMean)) / (rms || 1e-6)).toFixed(4),
        phase_means: phaseMean.map((v) => +v.toFixed(6)),
        local_rms: +rms.toFixed(6), local_mean: +mean.toFixed(6),
    };
}

function percentiles(luma, ps) {
    const s = Float32Array.from(luma).filter(Number.isFinite).sort();
    return ps.map((p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))] ?? 0);
}

async function cli() {
    const args = process.argv.slice(2);
    const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
    const FILE = argVal('--file', '');
    const OUT = argVal('--out', '');
    const ARM = argVal('--arm', '');
    if (!FILE) { console.error('usage: node decode_engine.mjs --file <raw> [--out <dir>] [--arm rawler|libraw]'); process.exit(2); }
    const t0 = Date.now();
    const dec = await decodeEngine(FILE, ARM ? { arm: ARM } : {});
    const { w, h, rgb16, arm } = dec;
    console.log(`[decode_engine] ${path.basename(FILE)} → arm=${arm} ${w}x${h} rgb16=${rgb16.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    const luma = luma709FromRgb16(rgb16, w, h);
    const [p1, p50, p99, p999] = percentiles(luma, [0.01, 0.5, 0.99, 0.999]);
    // checkerboard probe on a dim interior patch (upper-left quadrant) + center
    const cbBg = checkerboardIndex(luma, w, h, Math.round(w * 0.25), Math.round(h * 0.25), 256);
    const cbCenter = checkerboardIndex(luma, w, h, w >> 1, h >> 1, 256);
    console.log(`[decode_engine] luma pct 1%=${p1.toFixed(5)} 50%=${p50.toFixed(5)} 99%=${p99.toFixed(5)} 99.9%=${p999.toFixed(5)}`);
    console.log(`[decode_engine] checkerboard bg  patch: hf/rms=${cbBg.hf_over_rms} phase_spread/rms=${cbBg.phase_spread_over_rms}`);
    console.log(`[decode_engine] checkerboard ctr patch: hf/rms=${cbCenter.hf_over_rms} phase_spread/rms=${cbCenter.phase_spread_over_rms}`);

    if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        const base = path.basename(FILE).replace(/\.[^.]+$/, '');
        // stretched full-frame luma preview (~1600px long side, asinh)
        const targetLong = 1600;
        const ds = Math.max(1, Math.round(Math.max(w, h) / targetLong));
        const ow = Math.floor(w / ds), oh = Math.floor(h / ds);
        const lo = percentiles(luma, [0.30])[0];
        const hi = percentiles(luma, [0.9995])[0];
        const rng = Math.max(1e-6, hi - lo);
        try {
            const { PNG } = await import('pngjs');
            const png = new PNG({ width: ow, height: oh });
            for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
                const v = luma[(y * ds) * w + (x * ds)];
                let t = (v - lo) / rng; t = t < 0 ? 0 : t > 1 ? 1 : t;
                t = Math.asinh(t * 8) / Math.asinh(8); // mild asinh so faint stars show
                const px = Math.round(t * 255);
                const idx = (y * ow + x) << 2;
                png.data[idx] = px; png.data[idx + 1] = px; png.data[idx + 2] = px; png.data[idx + 3] = 255;
            }
            const pngPath = path.join(OUT, `${base}.engine_${arm}.preview.png`);
            await new Promise((res, rej) => png.pack().pipe(fs.createWriteStream(pngPath)).on('finish', res).on('error', rej));
            console.log(`[decode_engine] preview PNG → ${pngPath} (${ow}x${oh}, asinh, lo=${lo.toFixed(5)} hi=${hi.toFixed(5)})`);
            const sidecar = {
                file: FILE, arm, dims: { w, h }, preview_dims: [ow, oh],
                luma_pct: { p1, p50, p99, p999 },
                checkerboard: { bg: cbBg, center: cbCenter },
                rawler: dec.rawler ?? null, decode_s: +((Date.now() - t0) / 1000).toFixed(2),
            };
            fs.writeFileSync(path.join(OUT, `${base}.engine_${arm}.json`), JSON.stringify(sidecar, null, 2));
            console.log(`[decode_engine] sidecar → ${path.join(OUT, `${base}.engine_${arm}.json`)}`);
        } catch (err) {
            console.error('[decode_engine] preview PNG write failed:', err.message);
        }
    }
    terminateEngineDecodeWorkers();
    setTimeout(() => process.exit(0), 200);
}

// Run the CLI only when invoked directly (never on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    cli().catch((err) => { console.error('[decode_engine] FATAL:', err); process.exit(1); });
}
