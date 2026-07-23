#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ab_live.mjs — decoder-rail A/B driver (rail #14): SAME frame through BOTH arms
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/rawlab/ab_live.mjs [--file <raw>] [--out <dir>] [--decode-only]
//
// Arms:
//   libraw (control, the LIVE default)  vs  rawler (the flag-selected rail)
//
// Levels:
//   1. DECODE     — direct: wasm_decode pkg (rawler) vs libraw-wasm (via the
//                   audited tools/psf/decode_cr2.mjs rails). Framing / value-
//                   domain / OB diffs + golden-manifest md5 conformance when the
//                   input IS the golden frame (IMG_1653).
//   2. DETECTION  — the REAL wizard pipeline per arm (spawned under vitest via
//                   ab_pipeline.config.ts + ab_pipeline.labspec.ts, the proven
//                   tools/api/run.mjs mechanism): clean-star counts, culling
//                   tally, flux/FWHM distributions.
//   3. SOLVE      — per-arm solve outcome + solution numbers.
//
// HONESTY (stated up front, mission rule): flag-ON detections are EXPECTED to
// explode vs libraw (thresholds were implicitly calibrated to the libraw CFA-
// luminance artifact — the measured 2227→21,636 effect). That is a MEASUREMENT
// this driver records, not a failure. NO thresholds are changed anywhere; the
// single recal spend happens against rawler output at flip time.
//
// The flag-ON arm runs ONLY here — never in any gate (each arm is a fresh
// spawned process, so VITE_DECODER_RAWLER never leaks). Exit code: nonzero only
// if the driver itself or the CONTROL (libraw) arm breaks; a rawler-arm honest
// failure is recorded and exits 0.
//
// Output: test_results/decoder_ab/<base>_<ts>/report.json (+ per-arm records).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeCR2, terminateDecodeWorkers } from '../psf/decode_cr2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const FILE = path.resolve(argVal('--file') ?? path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'));
const DECODE_ONLY = args.includes('--decode-only');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve(argVal('--out') ?? path.join(ROOT, 'test_results', 'decoder_ab'), `${path.basename(FILE).replace(/\W+/g, '_')}_${TS}`);
const GOLDEN_MANIFEST = path.join(ROOT, 'test_results', 'decoder_prestage', 'golden', 'IMG_1653.CR2.golden_manifest.json');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const PKG_DIR = path.join(ROOT, 'src', 'engine', 'wasm_decode', 'pkg');

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const log = (...a) => console.log('[ab_live]', ...a);
function die(msg) { console.error('[ab_live] FATAL:', msg); process.exit(1); }

function stats(arrLike, sampleStep = 1) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < arrLike.length; i += sampleStep) {
        const v = arrLike[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v; n++;
    }
    if (n === 0) return null;
    // percentile pass on a bounded sample
    const cap = 2_000_000;
    const step = Math.max(sampleStep, Math.ceil(arrLike.length / cap));
    const sample = [];
    for (let i = 0; i < arrLike.length; i += step) sample.push(arrLike[i]);
    sample.sort((a, b) => a - b);
    const q = (p) => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))];
    return { n, min, max, mean: sum / n, p01: q(0.01), p50: q(0.5), p99: q(0.99), sampled: step > 1 ? `1/${step}` : 'full' };
}

if (!fs.existsSync(FILE)) die(`input not found: ${FILE}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = { file: FILE, file_bytes: fs.statSync(FILE).size, started_at: new Date().toISOString(), decode: {}, pipeline: null, notes: [] };

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL 1 — DECODE
// ─────────────────────────────────────────────────────────────────────────────
log(`decode level — ${path.basename(FILE)} through both arms…`);

// rawler arm (the shipped wasm artifact — NOT the native probe)
if (!fs.existsSync(path.join(PKG_DIR, 'wasm_decode.js'))) {
    die(`wasm_decode pkg not built at ${PKG_DIR} — run: cd src/engine/wasm_decode && wasm-pack build --target web`);
}
const wasmMod = await import(pathToFileURL(path.join(PKG_DIR, 'wasm_decode.js')).href);
wasmMod.initSync({ module: fs.readFileSync(path.join(PKG_DIR, 'wasm_decode_bg.wasm')) });

const fileBytes = fs.readFileSync(FILE);
let t0 = Date.now();
const dec = wasmMod.decode_raw(new Uint8Array(fileBytes));
const rawlerDecodeMs = Date.now() - t0;
const meta = JSON.parse(dec.meta_json());
const cfa = dec.cfa_full();
t0 = Date.now();
const rgb16 = dec.rgb16_active();
const rawlerDemosaicMs = Date.now() - t0;

const obAreas = [];
for (let i = 0; i < dec.ob_area_count(); i++) {
    const px = dec.ob_pixels(i);
    obAreas.push({ rect: meta.black_areas[i], ...stats(px) });
}

report.decode.rawler = {
    decoder: meta.decoder,
    decode_ms: rawlerDecodeMs,
    demosaic_active_ms: rawlerDemosaicMs,
    full_dims: `${meta.width}x${meta.height}`,
    active_area: meta.active_area,
    crop_area: meta.crop_area,
    cfa_pattern_full: meta.cfa_pattern_full,
    cfa_pattern_active: meta.cfa_pattern_active,
    blacklevel_bayer: meta.blacklevel_bayer,
    whitelevel: meta.whitelevel,
    wb_coeffs: meta.wb_coeffs,
    cfa_stats: stats(cfa),
    rgb16_active_stats: stats(rgb16, 7),
    ob_areas: obAreas,
    value_domain: 'raw ADU + black pedestal (NOT black-subtracted, NOT scaled)',
};

// golden conformance — only meaningful when the input IS the golden frame
if (fs.existsSync(GOLDEN_MANIFEST)) {
    const manifest = JSON.parse(fs.readFileSync(GOLDEN_MANIFEST, 'utf8'));
    if (path.basename(FILE) === manifest.file) {
        const cfaMd5 = md5(Buffer.from(dec.cfa_full_le()));
        const lumaMd5 = md5(Buffer.from(dec.demosaic_luma_full_le()));
        report.decode.golden = {
            cfa_md5: cfaMd5, cfa_expected: manifest.cfa.md5, cfa_match: cfaMd5 === manifest.cfa.md5,
            luma_md5: lumaMd5, luma_expected: manifest.demosaic_luma.md5, luma_match: lumaMd5 === manifest.demosaic_luma.md5,
        };
        if (!report.decode.golden.cfa_match || !report.decode.golden.luma_match) {
            die(`GOLDEN MISMATCH on ${manifest.file} — the wasm decode drifted from the committed manifest`);
        }
        log(`golden: CFA ${cfaMd5} MATCH · demosaic-luma ${lumaMd5} MATCH`);
    } else {
        report.decode.golden = { skipped: `input ${path.basename(FILE)} != golden frame ${manifest.file}` };
    }
}
dec.free();

// libraw arm (control — the audited decode rails)
t0 = Date.now();
const lr = await decodeCR2(FILE);
const librawDecodeMs = Date.now() - t0;
report.decode.libraw = {
    decode_ms: librawDecodeMs,
    dims: `${lr.w}x${lr.h}`,
    payload: 'dcraw_make_mem_image RGB16 interleaved (active area, black-subtracted, scaled)',
    rgb16_stats: stats(lr.rgb16, 7),
};
terminateDecodeWorkers();

// diffs
const act = meta.active_area ?? { x: 0, y: 0, w: meta.width, h: meta.height };
report.decode.diff = {
    framing: {
        rawler_full: `${meta.width}x${meta.height}`,
        rawler_active: `${act.w}x${act.h}@(${act.x},${act.y})`,
        libraw: `${lr.w}x${lr.h}`,
        ob_cols_rows_recovered: `${act.x} left cols + ${act.y} top rows of border libraw discards`,
        active_delta_vs_libraw: `${act.w - lr.w}x${act.h - lr.h}`,
    },
    value_domain: {
        rawler: 'raw ADU + pedestal',
        libraw: 'black-subtracted, scaled to [0,65535]',
        approx_scale_ratio_p99: (() => {
            const a = report.decode.libraw.rgb16_stats?.p99;
            const b = report.decode.rawler.cfa_stats?.p99;
            const black = meta.blacklevel_bayer?.[0] ?? 0;
            return a && b && b > black ? +(a / (b - black)).toFixed(3) : null;
        })(),
        note: 'APPROXIMATE ratio (p99 libraw / (p99 rawler − black)); md5 equality across arms impossible by construction',
    },
    ob: { rawler_areas: obAreas.length, libraw_areas: 0, note: 'libraw-wasm exposes NO OB (borders trimmed) — the dark-calibration unlock is rawler-only' },
};

log(`framing: rawler full ${report.decode.diff.framing.rawler_full}, active ${report.decode.diff.framing.rawler_active}, libraw ${report.decode.diff.framing.libraw}`);

// ─────────────────────────────────────────────────────────────────────────────
// LEVELS 2+3 — DETECTION + SOLVE (real wizard pipeline, one spawned arm at a time)
// ─────────────────────────────────────────────────────────────────────────────
if (!DECODE_ONLY) {
    const runArm = (arm) => {
        const outJson = path.join(OUT_DIR, `arm_${arm}.json`);
        const env = { ...process.env, RAWLAB_AB_FILE: FILE, RAWLAB_AB_OUT: outJson };
        // POST-CUTOVER (2026-07-11): flag ABSENT now selects RAWLER (the default
        // arm). The libraw control must select the cold path EXPLICITLY.
        env.VITE_DECODER_RAWLER = arm === 'rawler' ? '1' : '0';
        log(`pipeline arm '${arm}' — spawning wizard run (sequential; one heavy lane at a time)…`);
        const r = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', 'tools/rawlab/ab_pipeline.config.ts', 'tools/rawlab/ab_pipeline.labspec.ts'], {
            cwd: ROOT, env, encoding: 'utf8', timeout: 1_200_000,
        });
        const tail = (r.stdout ?? '').split('\n').slice(-12).join('\n');
        fs.writeFileSync(path.join(OUT_DIR, `arm_${arm}.vitest.log`), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
        if (!fs.existsSync(outJson)) {
            return { arm, spec_exit: r.status, record: null, error: `arm record missing (vitest tail):\n${tail}` };
        }
        return { arm, spec_exit: r.status, record: JSON.parse(fs.readFileSync(outJson, 'utf8')) };
    };

    const libArm = runArm('libraw');
    const rawArm = runArm('rawler');
    report.pipeline = { libraw: libArm, rawler: rawArm };

    if (!libArm.record) die(`CONTROL arm (libraw) produced no record — ${libArm.error}`);

    const d0 = libArm.record.detection, d1 = rawArm.record?.detection;
    const s0 = libArm.record.solve, s1 = rawArm.record?.solve;
    report.pipeline.summary = {
        detections_clean: { libraw: d0?.clean_stars ?? null, rawler: d1?.clean_stars ?? null },
        solve: { libraw: s0 ?? null, rawler: s1 ?? null },
        expectation_note: 'rawler-arm detection/solve divergence is the EXPECTED measurement (libraw-calibrated thresholds); recal is the flip session, not here',
    };
    log(`detections (clean): libraw=${d0?.clean_stars ?? 'N/A'} rawler=${d1?.clean_stars ?? 'N/A'}`);
    log(`solve: libraw=${s0?.solved ? `SOLVED ra=${s0.ra_hours} scale=${s0.pixel_scale} matched=${s0.matched}` : 'NOT SOLVED'} · rawler=${s1?.solved ? `SOLVED ra=${s1.ra_hours} scale=${s1.pixel_scale} matched=${s1.matched}` : 'NOT SOLVED'}`);
}

report.finished_at = new Date().toISOString();
const reportPath = path.join(OUT_DIR, 'report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
log(`report: ${reportPath}`);
