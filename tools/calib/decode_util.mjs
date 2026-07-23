// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/decode_util.mjs — shared CFA-grid decode + Bayer-phase helpers
// ═══════════════════════════════════════════════════════════════════════════
//
// The 4-class calibration lane (decoder cutover #14) decodes every calibration
// frame on the FULL-frame CFA grid via the SAME rawler wasm artifact that the
// engine seam `decodeCfaContract()` wraps (src/engine/pipeline/m1_ingestion/
// rawler_decoder.ts). This is the incubator pattern: a thin Node driver over the
// shipped wasm decode — NOT a second decoder.
//
// Ledger: PIXEL (decode + CFA arithmetic; no coordinate math here).
//
// Every master/calibration op lives on the FULL-frame CFA grid (index = y*W + x,
// cpp=1, raw ADU + black pedestal). CFA phase is read from ABSOLUTE full-frame
// coordinates so the pattern is phase-correct everywhere.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_DIR = path.join(ROOT, 'src', 'engine', 'wasm_decode', 'pkg');

// STORAGE (owner directive 2026-07-10): K: is a thin virtual disk backed by a
// nearly-full C:, so ALL large binary artifacts (.bin masters + calibrated CFA)
// live on D:. Small artifacts (manifests/JSON/ATTRIBUTION) stay under
// test_results/ with their paths pointing at the D: locations. Override via env.
export const BIN_DIR = process.env.CALIB_BIN_DIR
    ? path.resolve(process.env.CALIB_BIN_DIR)
    : path.resolve('D:/AstroLogic/test_artifacts/calib_cocoon');
export const JSON_DIR = process.env.CALIB_JSON_DIR
    ? path.resolve(process.env.CALIB_JSON_DIR)
    : path.join(ROOT, 'test_results', 'calib_cocoon');

let _wasmMod = null;

/** Init the wasm_decode pkg once (Node initSync path — the ab_live.mjs pattern). */
export async function loadDecoder() {
    if (_wasmMod) return _wasmMod;
    if (!fs.existsSync(path.join(PKG_DIR, 'wasm_decode.js'))) {
        throw new Error(`wasm_decode pkg not built at ${PKG_DIR} — run: cd src/engine/wasm_decode && wasm-pack build --target web`);
    }
    const mod = await import(pathToFileURL(path.join(PKG_DIR, 'wasm_decode.js')).href);
    mod.initSync({ module: fs.readFileSync(path.join(PKG_DIR, 'wasm_decode_bg.wasm')) });
    _wasmMod = mod;
    return mod;
}

/**
 * Decode one RAW frame to the full-frame CFA contract.
 * Returns a STANDALONE Uint16Array (copied out of wasm; handle freed) + meta.
 * The CFA is the FULL frame incl. optical-black borders — masters are built on
 * this grid so per-pixel geometry is identical across every class + the lights.
 */
export async function decodeCfa(filePath) {
    const mod = await loadDecoder();
    const bytes = fs.readFileSync(filePath);
    const t0 = Date.now();
    const dec = mod.decode_raw(new Uint8Array(bytes));
    try {
        const meta = JSON.parse(dec.meta_json());
        // cfa_full() copies out of wasm linear memory into a fresh JS Uint16Array,
        // so it survives dec.free(); copy once more to be defensive against any
        // view aliasing, then release wasm memory immediately (bounded footprint).
        const src = dec.cfa_full();
        const cfa = new Uint16Array(src.length);
        cfa.set(src);
        // OB harvest (record-only per DARK_CALIBRATION_POLICY §1 Reading B).
        const obAreas = [];
        for (let i = 0; i < dec.ob_area_count(); i++) {
            const px = dec.ob_pixels(i);
            const s = quickStats(px);
            obAreas.push({ rect: meta.black_areas?.[i] ?? null, ...s });
        }
        return {
            cfa,
            width: meta.width,
            height: meta.height,
            pattern: meta.cfa_pattern_full,
            patternActive: meta.cfa_pattern_active,
            blacklevelBayer: meta.blacklevel_bayer,
            whitelevel: meta.whitelevel,
            wb: meta.wb_coeffs,
            activeArea: meta.active_area,
            cropArea: meta.crop_area,
            obAreas,
            decodeMs: Date.now() - t0,
            fileBytes: bytes.byteLength,
            decoder: meta.decoder,
            model: meta.clean_model ?? meta.model,
        };
    } finally {
        dec.free();
    }
}

// ── Bayer-phase helpers ──────────────────────────────────────────────────────
// Phase index p = (y & 1) * 2 + (x & 1) ∈ {0,1,2,3}, the 2×2 tile position.
// The CFA colour at that phase is pattern[p] (pattern read at full-frame origin).
// Normalizing per PHASE (4 classes) treats the two greens independently, so a
// flat never introduces a colour/phase shift (mission convention).

export function phaseOf(x, y) { return ((y & 1) << 1) | (x & 1); }

/** Colour label ('R'|'G'|'B'|'E') for each of the 4 phases, from the pattern. */
export function phaseColors(pattern) {
    return [0, 1, 2, 3].map((p) => pattern[p] ?? '?');
}

/** Per-phase mean of a full-frame buffer (Uint16Array|Float32Array). */
export function perPhaseMean(buf, width, height) {
    const sum = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    for (let y = 0; y < height; y++) {
        const row = y * width;
        const pr = (y & 1) << 1;
        for (let x = 0; x < width; x++) {
            const p = pr | (x & 1);
            sum[p] += buf[row + x];
            cnt[p]++;
        }
    }
    return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
}

// ── small stats utilities ────────────────────────────────────────────────────

export function quickStats(arrLike) {
    let min = Infinity, max = -Infinity, sum = 0;
    const n = arrLike.length;
    for (let i = 0; i < n; i++) {
        const v = arrLike[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    const mean = n ? sum / n : 0;
    let varAcc = 0;
    for (let i = 0; i < n; i++) { const d = arrLike[i] - mean; varAcc += d * d; }
    return { n, min: n ? min : 0, max: n ? max : 0, mean, std: n ? Math.sqrt(varAcc / n) : 0 };
}

/** Population std of a full-frame buffer (single pass, Welford-safe enough here). */
export function stdOf(buf, mean) {
    let acc = 0;
    for (let i = 0; i < buf.length; i++) { const d = buf[i] - mean; acc += d * d; }
    return Math.sqrt(acc / buf.length);
}

/**
 * Per-pixel MEDIAN of N same-shaped frames → Float32Array master.
 * `frames` = array of {getAt?} — here just typed arrays of equal length.
 * `transform(px, i, frameIdx)` optionally maps each sample before the median
 * (used by the flat builder for on-the-fly bias-subtract + per-phase normalize).
 */
export function perPixelMedian(frames, len, transform) {
    const N = frames.length;
    const master = new Float32Array(len);
    const scratch = new Float64Array(N);
    for (let i = 0; i < len; i++) {
        for (let f = 0; f < N; f++) {
            const v = frames[f][i];
            scratch[f] = transform ? transform(v, i, f) : v;
        }
        // insertion sort (small N) → median
        for (let a = 1; a < N; a++) {
            const key = scratch[a];
            let b = a - 1;
            while (b >= 0 && scratch[b] > key) { scratch[b + 1] = scratch[b]; b--; }
            scratch[b + 1] = key;
        }
        master[i] = (N & 1) ? scratch[N >> 1] : 0.5 * (scratch[(N >> 1) - 1] + scratch[N >> 1]);
    }
    return master;
}

export function md5OfF32(f32) {
    return crypto.createHash('md5').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex');
}

export function listClass(corpusDir, cls) {
    const dir = path.join(corpusDir, cls);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /\.(cr2|arw|CR2|ARW)$/.test(f)).sort().map((f) => path.join(dir, f));
}
