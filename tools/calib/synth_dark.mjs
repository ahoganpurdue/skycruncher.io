// ═══════════════════════════════════════════════════════════════════════════
// SYNTHETIC DARK via fixed-pattern decorrelation  (D11 sub-test 7, tools-lane)
// ═══════════════════════════════════════════════════════════════════════════
// Register N same-camera LIGHT frames, per NATIVE SENSOR PIXEL cross-frame
// median. The sky (dithered/rotated between subs) is DIFFERENT at any given
// sensor pixel per frame → the median rejects it. FPN + dark current + hot
// pixels + amp glow are PIXEL-LOCKED to the sensor → survive as the estimate.
//
// TWO-LEDGER LAW (owner): a dark lives in the PIXEL ledger on the NATIVE grid.
// We therefore DO NOT register-to-sky or resample: aligning the sky would MOVE
// the sensor pattern and destroy exactly what we want to keep. "Register the
// sky OUT" = reject the moving sky via the per-native-pixel median; keep the
// sensor-fixed pattern. No WCS, no warp, no calibrated constant authored.
//
// Decode path = the EXACT decode tools/detect/decode_plane.mjs uses (libraw-wasm
// via worker_shim, noInterpolation, dominant-channel gray (r+g+b)/65535 at FULL
// native resolution — the metadata_reaper.convertMemImageToRgb contract). The
// plane operated on is stated explicitly in every emitted receipt.
//
//   node tools/calib/synth_dark.mjs \
//       [--lights-dir D:/AstroLogic/intake/astrobackyard/cocoon_singles] \
//       [--light-prefix B_] [--dark-prefix D_] \
//       [--out test_results/overnight_run_2026-07-10/synth_dark] \
//       [--holdout 1]           # lights held OUT of the synth dark for residual test
//       [--exif-only]           # F1 preflight: read shutter/iso/temp only, no decode
//       [--limit N]             # cap frame count (debug)
//
// FROZEN BARS (sub-test 7):
//   per-pixel Pearson r (synth vs real master): SUCCESS >=0.60 · KILL <0.30
//   hot-pixel recall @ precision >=0.70:        SUCCESS >=0.80 · KILL <0.50
//   held-out light residual sigma ratio synth/real: SUCCESS <=1.10 · KILL >=1.50
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';
// INCUBATOR PORT (LAW 4): the FPN median producer + validation metrics are now
// single-sourced in the engine. This CLI is the thin recon driver over them
// (decode + IO + verdict presentation). Node type-strips the .ts at call time.
import {
    combineNativeMedian,
    evaluateSynthDark,
    medianSorted,
} from '../../src/engine/pipeline/m8_photometry/synth_dark.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LIGHTS_DIR = argVal('--lights-dir', 'D:/AstroLogic/intake/astrobackyard/cocoon_singles');
const LIGHT_PREFIX = argVal('--light-prefix', 'B_');
const DARK_PREFIX = argVal('--dark-prefix', 'D_');
const OUT = path.resolve(ROOT, argVal('--out', 'test_results/overnight_run_2026-07-10/synth_dark'));
const HOLDOUT = parseInt(argVal('--holdout', '1'), 10);
const EXIF_ONLY = args.includes('--exif-only');
const LIMIT = parseInt(argVal('--limit', '0'), 10);

// ── Browser-Worker bridge for libraw-wasm (identical shim to decode_plane) ──
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null; onerror = null;
    constructor(url) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); else console.error('[synth] worker error:', err); });
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
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), STAGE_TIMEOUT_MS).unref?.())
]);

function listFrames() {
    if (!fs.existsSync(LIGHTS_DIR)) { console.error(`[synth] DIR ABSENT: ${LIGHTS_DIR}`); process.exit(3); }
    const all = fs.readdirSync(LIGHTS_DIR).filter(f => /\.cr2$/i.test(f)).sort();
    const lights = all.filter(f => f.startsWith(LIGHT_PREFIX)).map(f => path.join(LIGHTS_DIR, f));
    const darks = all.filter(f => f.startsWith(DARK_PREFIX)).map(f => path.join(LIGHTS_DIR, f));
    return {
        lights: LIMIT ? lights.slice(0, LIMIT) : lights,
        darks: LIMIT ? darks.slice(0, LIMIT) : darks,
    };
}

// ── libraw open + (optional) full decode. Returns {meta, gray?, width, height} ──
// Frees the libraw instance + any worker spawned during THIS decode so 32
// sequential decodes do not accumulate wasm heaps (box-load safety w/ B1 build).
async function openFrame(FILE, withPixels) {
    const before = new Set(liveWorkers);
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    try {
        const fileBuf = fs.readFileSync(FILE);
        await withTimeout('open()', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
            noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false,
        }));
        const meta = await withTimeout('metadata()', raw.metadata());
        const width = meta?.width || meta?.raw_width || 0;
        const height = meta?.height || meta?.raw_height || 0;
        if (!withPixels) return { meta, width, height };
        const rawData = await withTimeout('imageData()', raw.imageData());
        let mem;
        if (rawData instanceof Uint16Array) mem = rawData;
        else if (rawData?.data instanceof Uint16Array) mem = rawData.data;
        else { const src = rawData?.buffer || rawData; mem = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength) / 2)); }
        const expectRgb3 = width * height * 3;
        if (Math.abs(mem.length - expectRgb3) > width * 3) throw new Error(`payload layout unexpected len=${mem.length} expect=${expectRgb3}`);
        const npix = width * height;
        const gray = new Float32Array(npix);
        for (let p = 0; p < npix; p++) { const i = p * 3; let v = (mem[i] + mem[i + 1] + mem[i + 2]) / 65535; gray[p] = v > 1 ? 1 : v; }
        return { meta, gray, width, height };
    } finally {
        try { await raw.recycle?.(); } catch { }
        try { await raw.close?.(); } catch { }
        // terminate any worker this decode spawned
        for (const w of liveWorkers) if (!before.has(w)) { try { w.terminate(); } catch { } }
    }
}

// exposure/iso/temp from libraw meta (+ filename fallback for temp)
function exifOf(FILE, meta) {
    const base = path.basename(FILE);
    const mTemp = base.match(/_(\d+)C\./i);          // ..._20C.CR2
    const mExp = base.match(/_(\d+)s_/);              // D_..._240s__16C
    return {
        file: base,
        shutter_s: Number.isFinite(+meta?.shutter) ? +meta.shutter : null,
        iso: Number.isFinite(+meta?.iso_speed) ? +meta.iso_speed : (Number.isFinite(+meta?.iso) ? +meta.iso : null),
        timestamp: meta?.timestamp ?? null,
        temp_meta_C: Number.isFinite(+meta?.temperature) ? +meta.temperature : (Number.isFinite(+meta?.CameraTemperature) ? +meta.CameraTemperature : null),
        temp_fname_C: mTemp ? +mTemp[1] : null,
        exp_fname_s: mExp ? +mExp[1] : null,
        make: meta?.make ?? null, model: meta?.model ?? null,
        width: meta?.width, height: meta?.height,
    };
}

function finish(code) { for (const w of liveWorkers) w.terminate().catch(() => { }); process.exitCode = code; setTimeout(() => process.exit(code), 250); }

// ── robust stats: medianSorted / madSigma / percentile are engine-single-sourced
//    (src/engine/pipeline/m8_photometry/synth_dark.ts). medianSorted imported. ──

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const planeDir = path.join(OUT, 'planes');
    fs.mkdirSync(planeDir, { recursive: true });
    globalThis.Worker = BrowserWorkerOnNode;
    const { lights, darks } = listFrames();
    console.log(`[synth] lights=${lights.length} darks=${darks.length} (dir ${LIGHTS_DIR})`);

    // ── F1 PREFLIGHT: EXIF-only ──
    if (EXIF_ONLY) {
        const exif = { lights: [], darks: [] };
        for (const [role, files] of [['lights', lights], ['darks', darks]]) {
            for (const f of files) {
                try { const { meta } = await openFrame(f, false); exif[role].push(exifOf(f, meta)); }
                catch (e) { exif[role].push({ file: path.basename(f), error: e.message }); }
                console.log(`  [exif] ${role} ${path.basename(f)} -> shutter=${exif[role][exif[role].length - 1].shutter_s}s iso=${exif[role][exif[role].length - 1].iso}`);
            }
        }
        // dump raw meta keys of the first light + first dark for discovery
        try { const { meta: mL } = await openFrame(lights[0], false); exif.sample_light_meta_keys = Object.keys(mL || {}); exif.sample_light_meta = mL; } catch { }
        try { const { meta: mD } = await openFrame(darks[0], false); exif.sample_dark_meta_keys = Object.keys(mD || {}); exif.sample_dark_meta = mD; } catch { }
        fs.writeFileSync(path.join(OUT, 'exif_preflight.json'), JSON.stringify(exif, null, 2));
        console.log(`[synth] -> ${path.relative(ROOT, path.join(OUT, 'exif_preflight.json'))}`);
        finish(0); return;
    }

    // ── PHASE A: decode every frame to a native gray f32 on disk + capture exif ──
    const exif = { lights: [], darks: [] };
    let W = 0, H = 0;
    const decodeAll = async (files, role) => {
        const out = [];
        for (const f of files) {
            const t0 = Date.now();
            const { meta, gray, width, height } = await openFrame(f, true);
            if (!W) { W = width; H = height; }
            if (width !== W || height !== H) throw new Error(`DIM MISMATCH ${path.basename(f)} ${width}x${height} != ${W}x${H}`);
            const p = path.join(planeDir, `${path.basename(f)}.gray.f32`);
            fs.writeFileSync(p, Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength));
            exif[role].push(exifOf(f, meta));
            out.push(p);
            console.log(`  [decode] ${role} ${path.basename(f)} ${width}x${height} shutter=${exif[role][exif[role].length - 1].shutter_s}s ${Date.now() - t0}ms`);
        }
        return out;
    };
    const lightPlanes = await decodeAll(lights, 'lights');
    const darkPlanes = await decodeAll(darks, 'darks');
    fs.writeFileSync(path.join(OUT, 'exif.json'), JSON.stringify(exif, null, 2));

    const NPIX = W * H;
    // held-out lights: last HOLDOUT lights are excluded from the synth dark
    const holdoutIdx = [];
    for (let i = Math.max(0, lightPlanes.length - HOLDOUT); i < lightPlanes.length; i++) holdoutIdx.push(i);
    const synthInputPlanes = lightPlanes.filter((_, i) => !holdoutIdx.includes(i));
    console.log(`[synth] synth-dark from ${synthInputPlanes.length} lights (held out ${holdoutIdx.length}: ${holdoutIdx.map(i => path.basename(lightPlanes[i])).join(',')})`);

    // ── PHASE B: tiled per-native-pixel median (memory-bounded) ──
    const BAND = 256; // rows per band
    const readBand = (file, y0, rows) => {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(rows * W * 4);
        fs.readSync(fd, buf, 0, buf.length, y0 * W * 4);
        fs.closeSync(fd);
        return new Float32Array(buf.buffer, buf.byteOffset, rows * W);
    };
    // Per streamed disk band, the per-native-pixel cross-frame median is the
    // engine producer combineNativeMedian (single source of the FPN math).
    const tiledMedian = (files, outPath) => {
        const outFd = fs.openSync(outPath, 'w');
        for (let y0 = 0; y0 < H; y0 += BAND) {
            const rows = Math.min(BAND, H - y0);
            const bands = files.map(f => readBand(f, y0, rows));
            const outBand = combineNativeMedian(bands);
            const b = Buffer.from(outBand.buffer, outBand.byteOffset, outBand.byteLength);
            fs.writeSync(outFd, b, 0, b.length, y0 * W * 4);
        }
        fs.closeSync(outFd);
    };
    const synthPath = path.join(OUT, 'synth_dark.f32');
    const realPath = path.join(OUT, 'real_master_dark.f32');
    console.log('[synth] combining synth dark (median of lights, native space)...');
    tiledMedian(synthInputPlanes, synthPath);
    console.log('[synth] combining real master dark (median of 9 D_ frames)...');
    tiledMedian(darkPlanes, realPath);

    const synth = new Float32Array(fs.readFileSync(synthPath).buffer);
    const real = new Float32Array(fs.readFileSync(realPath).buffer);

    // ── exposure-ratio adjustment (F1) ──
    const shut = (list) => list.map(e => e.shutter_s).filter(Number.isFinite);
    const lightShut = shut(exif.lights), darkShut = shut(exif.darks);
    const medL = lightShut.length ? medianSorted(lightShut) : null;
    const medD = darkShut.length ? medianSorted(darkShut) : null;
    const expRatio = (medL && medD) ? medL / medD : null; // light/dark; darks scaled by this for level metrics
    const expMatched = (medL != null && medD != null) ? Math.abs(medL - medD) / Math.max(medL, medD) < 0.02 : null;

    // ── VALIDATION METRICS — single-sourced through the engine producer's
    //    evaluateSynthDark (Pearson r · hot-pixel recall/precision · held-out
    //    residual sigma ratio · star-suppression contamination). This driver
    //    supplies decode/IO + verdict presentation only; every number below is
    //    reproduced by src/engine/pipeline/m8_photometry/synth_dark.ts (LAW 4). ──
    // exposure scale: the real master (e.g. 240s) is scaled to the light
    // exposure; the synth is already at the light exposure (built FROM lights).
    const realScale = (expRatio && Number.isFinite(expRatio)) ? expRatio : 1;
    const holdoutArr = holdoutIdx.length
        ? new Float32Array(fs.readFileSync(lightPlanes[holdoutIdx[0]]).buffer)
        : null;
    const m = evaluateSynthDark(synth, real, holdoutArr, realScale);

    const pearson = m.pearson.r;
    const HOT_PCTL = m.hotpixel.percentile;
    const { realHotCount, synthHotCount, truePositive: tp, recall, precision } = m.hotpixel;
    const residual = m.residual ? {
        holdout_frame: path.basename(lightPlanes[holdoutIdx[0]]),
        real_master_exposure_scale: +realScale.toFixed(4),
        exposure_scale_label: realScale === 1 ? 'NONE (exposure matched)' : 'APPROXIMATE (dark-current linear-in-exposure assumption)',
        sigma_residual_synth: +m.residual.sigmaResidualSynth.toPrecision(5),
        sigma_residual_real: +m.residual.sigmaResidualReal.toPrecision(5),
        sigma_ratio_synth_over_real: +m.residual.ratioSynthOverReal.toFixed(4),
    } : null;
    const K = m.starSuppression.kSigma;
    const contaminated = m.starSuppression.contaminatedPixels;
    const contamFrac = m.starSuppression.contaminatedFraction;

    // ── verdicts ──
    const verdict = (v, succ, kill, dir) => {
        if (dir === 'high') return v >= succ ? 'PASS' : (v < kill ? 'KILL' : 'DIRECTIONAL');
        return v <= succ ? 'PASS' : (v >= kill ? 'KILL' : 'DIRECTIONAL');
    };
    const result = {
        schema: 'skycruncher.d11.synth_dark/1',
        generated_at: new Date().toISOString(),
        plane_operated_on: 'dominant_channel_gray_(r+g+b)/65535_linear, FULL native resolution, libraw noInterpolation (decode_plane.mjs contract)',
        registration: 'NONE — per-native-sensor-pixel median, no WCS/warp/resample (register the sky OUT). Two-ledger: PIXEL ledger, native grid.',
        dims: { W, H, npix: NPIX },
        n_lights_total: lights.length, n_lights_in_synth: synthInputPlanes.length, n_darks: darks.length,
        holdout: residual ? [residual.holdout_frame] : [],
        exposure: {
            light_shutter_median_s: medL, dark_shutter_median_s: medD,
            light_shutters: lightShut, dark_shutters: darkShut,
            exposure_ratio_light_over_dark: expRatio != null ? +expRatio.toFixed(4) : null,
            exposure_matched: expMatched,
            f1_note: expMatched === true
                ? 'Exposure classes MATCH — no dark-current scaling needed; all three metrics valid at face value.'
                : 'Exposure classes MISMATCH — dark-current scaled by exposure ratio (APPROXIMATE); verdict weighted toward exposure-robust metrics (Pearson r + hot-pixel recall/precision) over the level-sensitive residual ratio.',
        },
        metrics: {
            pearson_r: { value: +pearson.toFixed(4), success: 0.60, kill: 0.30, verdict: verdict(pearson, 0.60, 0.30, 'high'), exposure_robust: true },
            hotpixel: {
                percentile: HOT_PCTL, real_hot_count: realHotCount, synth_hot_count: synthHotCount, true_positive: tp,
                recall: +recall.toFixed(4), precision: +precision.toFixed(4),
                success: 'recall>=0.80 @ precision>=0.70', kill: 'recall<0.50',
                verdict: (recall >= 0.80 && precision >= 0.70) ? 'PASS' : (recall < 0.50 ? 'KILL' : 'DIRECTIONAL'),
                exposure_robust: true,
            },
            residual_sigma_ratio: residual ? {
                ...residual, success: 0.60 <= 1.10 ? '<=1.10' : '<=1.10', kill: '>=1.50',
                verdict: verdict(residual.sigma_ratio_synth_over_real, 1.10, 1.50, 'low'),
                exposure_sensitive: true, f1_weight: 'DOWN-WEIGHTED when exposure mismatched',
            } : null,
        },
        star_suppression: {
            k_sigma: K, contaminated_pixels: contaminated, contaminated_fraction: +contamFrac.toExponential(4),
            note: 'fraction of synth-dark pixels with bright-tail excess vs the real master (>5σ) — residual sky/star flux that failed to decorrelate. Cocoon target IС5146 is a bright nebula; this is the proposal top-kill-risk metric.',
        },
        artifacts: {
            synth_dark: path.relative(ROOT, synthPath),
            real_master_dark: path.relative(ROOT, realPath),
            exif: path.relative(ROOT, path.join(OUT, 'exif.json')),
        },
    };
    fs.writeFileSync(path.join(OUT, 'synth_dark_result.json'), JSON.stringify(result, null, 2));
    console.log(`\n[synth] RESULT`);
    console.log(`  Pearson r          = ${result.metrics.pearson_r.value}  [${result.metrics.pearson_r.verdict}]  (succ>=0.60 kill<0.30)`);
    console.log(`  hot-pixel recall   = ${recall.toFixed(3)} @ precision ${precision.toFixed(3)}  [${result.metrics.hotpixel.verdict}]`);
    if (residual) console.log(`  residual sigma rat = ${residual.sigma_ratio_synth_over_real}  [${result.metrics.residual_sigma_ratio.verdict}]  (exp scale ${residual.real_master_exposure_scale})`);
    console.log(`  star contamination = ${contamFrac.toExponential(3)} of pixels (>${K}σ bright-tail excess)`);
    console.log(`  exposure: light ${medL}s vs dark ${medD}s (matched=${expMatched})`);
    console.log(`  -> ${path.relative(ROOT, path.join(OUT, 'synth_dark_result.json'))}`);
    finish(0);
}

main().catch(e => { console.error('[synth] FATAL:', e.stack || e.message); finish(1); });
