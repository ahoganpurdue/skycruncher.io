// ═══════════════════════════════════════════════════════════════════════════
// CR2 → CLEAN NATIVE RGB/LUMINANCE PLANE dumper (RAWLER decode, headless)
// ═══════════════════════════════════════════════════════════════════════════
// The rawler-decode TWIN of tools/detect/decode_plane.mjs (which decodes via the
// libraw COLD path — checkerboard-prone CFA-weighted luma, see memory
// cr2-cfa-luminance-artifact). Post-cutover (2026-07-11) the SHIPPED default
// decoder is rawler (src/engine/pipeline/m1_ingestion/rawler_decoder.ts). This
// lane decodes a Cocoon (Canon 60Da) CR2 through the SAME rawler wasm artifact
// (tools/calib/decode_util.decodeCfa) + the SAME integer-bilinear demosaic
// (tools/calib/demosaic.demosaicActiveRGB) the calibration lane uses, then runs
// the SAME detection rung the match-ladder CR2 arm runs
// (solverkit/common.extractDetectionsFromPlanes). Only the DECODE differs from the
// ladder's libraw arm, so a before/after ladder comparison isolates decode quality.
//
//   node tools/detect/decode_plane_rawler.mjs --file <cr2> [--out-dir <dir>]
//        [--sigma 3.5] [--crop <N>]
//
// Emits (under test_results/cr2_dets_rawler/<base>/ by default):
//   <base>.rawler.dets.json     full detection list (inline-manifest ready)
//   <base>.rawler.meta.json     dims/decoder/cfa/levels/n_det/checkerboard index
//   <base>.thumb.png            downsampled full-frame luma (eyes-on overview)
//   <base>.center.png           native-res center crop (star shapes)
//   <base>.bg.png               native-res background patch (CHECKERBOARD check)
//
// TWO-LEDGER LAW: PIXEL ledger only (decode + demosaic + detection). No calibrated
// constant is authored; extract_blobs is the shipped m4 core. src/ READ-ONLY.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', ''));
const SIGMA = parseFloat(argVal('--sigma', '3.5'));   // matches extractDetectionsFromPlanes internal thr
const CROP = parseInt(argVal('--crop', '512'), 10);
const BASE = argVal('--out-base', FILE ? path.basename(FILE).replace(/\.[^.]+$/, '') : '');
const OUT_DIR = path.resolve(ROOT, argVal('--out-dir',
    path.join('test_results', 'cr2_dets_rawler', BASE)));

// ── minimal PNG (8-bit grayscale) encoder, node zlib, no dependency ──────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}
/** Encode a W*H Uint8 grayscale buffer to a PNG Buffer. */
function encodePngGray(gray, w, h) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit grayscale
    const raw = Buffer.alloc(h * (w + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w + 1)] = 0;                        // filter: none
        gray.subarray(y * w, y * w + w).forEach((v, x) => { raw[y * (w + 1) + 1 + x] = v; });
    }
    const idat = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── luma quantise helpers ────────────────────────────────────────────────────
/** percentile-window autoscale a Float32 luma crop → Uint8 (asinh-ish contrast). */
function autoscaleU8(vals) {
    const s = Float32Array.from(vals).filter(Number.isFinite).sort();
    const lo = s[Math.floor(s.length * 0.02)] ?? 0;
    const hi = s[Math.floor(s.length * 0.995)] ?? 1;
    const span = (hi - lo) || 1e-6;
    const out = new Uint8Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
        let t = (vals[i] - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
        // mild asinh stretch so faint stars are visible without blowing highlights
        t = Math.asinh(t * 8) / Math.asinh(8);
        out[i] = Math.round(t * 255);
    }
    return out;
}
function cropLuma(luma, W, H, cx, cy, n) {
    const x0 = Math.max(0, Math.min(W - n, cx - (n >> 1)));
    const y0 = Math.max(0, Math.min(H - n, cy - (n >> 1)));
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = luma[(y0 + y) * W + (x0 + x)];
    return { crop: out, x0, y0 };
}
/** period-2 checkerboard index on a crop: mean |L - mean(4-neighbour)| high-freq
 *  energy expressed relative to local RMS. A clean demosaic → low; a residual
 *  2px CFA checkerboard → elevated. Also reports per-phase mean spread. */
function checkerboardIndex(crop, n) {
    let hf = 0, cnt = 0, sum = 0, sum2 = 0;
    const phaseSum = [0, 0, 0, 0], phaseCnt = [0, 0, 0, 0];
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const v = crop[y * n + x];
        const nb = 0.25 * (crop[(y - 1) * n + x] + crop[(y + 1) * n + x] + crop[y * n + x - 1] + crop[y * n + x + 1]);
        hf += Math.abs(v - nb); cnt++;
        sum += v; sum2 += v * v;
        const p = ((y & 1) << 1) | (x & 1); phaseSum[p] += v; phaseCnt[p]++;
    }
    const mean = sum / cnt, rms = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
    const phaseMean = phaseSum.map((s, i) => s / (phaseCnt[i] || 1));
    const pMin = Math.min(...phaseMean), pMax = Math.max(...phaseMean);
    return {
        hf_over_rms: +(hf / cnt / (rms || 1e-6)).toFixed(4),
        phase_means: phaseMean.map((v) => +v.toFixed(5)),
        phase_spread_over_rms: +((pMax - pMin) / (rms || 1e-6)).toFixed(4),
        local_rms: +rms.toFixed(5), local_mean: +mean.toFixed(5),
    };
}

async function main() {
    if (!FILE || !fs.existsSync(FILE)) { console.error(`[rawler-plane] FILE NOT FOUND: ${FILE}`); return 2; }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`[rawler-plane] ${path.relative(ROOT, FILE)} base=${BASE}`);

    // ── 1. rawler decode (shipped default decoder) ──────────────────────────
    const { decodeCfa } = await import(pathToFileURL(path.join(ROOT, 'tools/calib/decode_util.mjs')).href);
    const { demosaicActiveRGB } = await import(pathToFileURL(path.join(ROOT, 'tools/calib/demosaic.mjs')).href);
    const t0 = Date.now();
    const d = await decodeCfa(FILE);
    const fullW = d.width, fullH = d.height;
    const black = d.blacklevelBayer ?? [0, 0, 0, 0];
    const blackMean = black.reduce((s, v) => s + v, 0) / Math.max(1, black.length);
    const white = Array.isArray(d.whitelevel) ? d.whitelevel[0] : (d.whitelevel ?? 65535);
    const norm = Math.max(1, white - blackMean);
    console.log(`[rawler-plane] decoded full ${fullW}x${fullH} pat=${d.pattern} active=${JSON.stringify(d.activeArea)} `
        + `black~${blackMean.toFixed(1)} white~${white} decoder=${d.decoder} model=${d.model} (${d.decodeMs}ms)`);

    // ── 2. per-phase black-subtract on the full-frame CFA (abs coords) ──────
    const cfa = d.cfa;   // standalone Uint16Array (copied out of wasm by decodeCfa)
    const cfaSub = new Float32Array(cfa.length);
    for (let y = 0; y < fullH; y++) {
        const pr = (y & 1) << 1, row = y * fullW;
        for (let x = 0; x < fullW; x++) {
            const p = pr | (x & 1);
            const v = cfa[row + x] - black[p];
            cfaSub[row + x] = v > 0 ? v : 0;
        }
    }

    // ── 3. integer-bilinear demosaic over the active area (rgb16_active twin) ─
    const { rgb, width: W, height: H } = demosaicActiveRGB(cfaSub, fullW, fullH, d.activeArea, d.pattern);
    const npix = W * H;
    // split interleaved → R/G/B planes in [0,1] (matches libraw's black-sub + 16b-scale domain)
    const R = new Float32Array(npix), G = new Float32Array(npix), B = new Float32Array(npix);
    for (let i = 0; i < npix; i++) {
        R[i] = Math.min(1, rgb[i * 3] / norm);
        G[i] = Math.min(1, rgb[i * 3 + 1] / norm);
        B[i] = Math.min(1, rgb[i * 3 + 2] / norm);
    }

    // ── 4. detections — the SAME rung the ladder CR2 arm runs ───────────────
    const { extractDetectionsFromPlanes, loadWasm } = await import(pathToFileURL(path.join(ROOT, 'tools/solverkit/common.mjs')).href);
    const wasm = await loadWasm();
    const det = extractDetectionsFromPlanes([R, G, B], W, H, wasm);
    console.log(`[rawler-plane] detections=${det.length} on ${W}x${H} (extractDetectionsFromPlanes, same recipe as ladder CR2 arm)`);

    // ── 5. eyes-on luma plane (BT.709, linear) for crops + artifact metric ──
    const luma = new Float32Array(npix);
    for (let i = 0; i < npix; i++) luma[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];

    // thumbnail (~1200px long side, box-average downsample)
    const thumbLong = 1200;
    const step = Math.max(1, Math.round(Math.max(W, H) / thumbLong));
    const tw = Math.floor(W / step), th = Math.floor(H / step);
    const thumb = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        let s = 0; for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) s += luma[(y * step + dy) * W + (x * step + dx)];
        thumb[y * tw + x] = s / (step * step);
    }
    fs.writeFileSync(path.join(OUT_DIR, `${BASE}.thumb.png`), encodePngGray(autoscaleU8(thumb), tw, th));

    // native center crop (star shapes)
    const cc = cropLuma(luma, W, H, W >> 1, H >> 1, CROP);
    fs.writeFileSync(path.join(OUT_DIR, `${BASE}.center.png`), encodePngGray(autoscaleU8(cc.crop), CROP, CROP));

    // background patch for checkerboard check: pick a dim quadrant patch (upper-left interior)
    const bgN = 256;
    const bg = cropLuma(luma, W, H, Math.round(W * 0.25), Math.round(H * 0.25), bgN);
    fs.writeFileSync(path.join(OUT_DIR, `${BASE}.bg.png`), encodePngGray(autoscaleU8(bg.crop), bgN, bgN));
    const cb = checkerboardIndex(bg.crop, bgN);

    // ── 6. emit dets + meta (inline-manifest ready) ─────────────────────────
    const detsOut = { frame: path.relative(ROOT, FILE).replace(/\\/g, '/'), width: W, height: H,
        decoder: d.decoder, n_det: det.length, dets: det };
    fs.writeFileSync(path.join(OUT_DIR, `${BASE}.rawler.dets.json`), JSON.stringify(detsOut));
    const meta = {
        base: BASE, file: path.relative(ROOT, FILE).replace(/\\/g, '/'),
        decoder: d.decoder, model: d.model, decode_ms: d.decodeMs, total_ms: Date.now() - t0,
        full_dims: { w: fullW, h: fullH }, active_dims: { w: W, h: H },
        active_area: d.activeArea, cfa_pattern_full: d.pattern, cfa_pattern_active: d.patternActive,
        blacklevel_bayer: black, blacklevel_mean: +blackMean.toFixed(2), whitelevel: white,
        norm_divisor: +norm.toFixed(2), value_domain: '(raw-black)/(white-black) clamped [0,1] — matches libraw black-sub+16b-scale',
        n_det: det.length, detection_recipe: 'extractDetectionsFromPlanes (solverkit/common) — identical to ladder CR2 arm',
        checkerboard_bg_patch: { at: { x: bg.x0, y: bg.y0, n: bgN }, ...cb },
        artifacts: { thumb: `${BASE}.thumb.png`, center: `${BASE}.center.png`, bg: `${BASE}.bg.png`,
            dets: `${BASE}.rawler.dets.json` },
    };
    fs.writeFileSync(path.join(OUT_DIR, `${BASE}.rawler.meta.json`), JSON.stringify(meta, null, 2));
    console.log(`[rawler-plane] checkerboard bg patch: hf/rms=${cb.hf_over_rms} phase_spread/rms=${cb.phase_spread_over_rms} `
        + `phase_means=${JSON.stringify(cb.phase_means)}`);
    console.log(`[rawler-plane] wrote → ${path.relative(ROOT, OUT_DIR)} (thumb/center/bg PNG + dets + meta)`);
    return 0;
}

const code = await main();
process.exitCode = code;
setTimeout(() => process.exit(code), 200);
