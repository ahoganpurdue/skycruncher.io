#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// arw_smoke.mjs — Sony ARW decode smoke via the rawler rail (decoder cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/rawlab/arw_smoke.mjs [--dir <sony_arw_dir>] [--golden]
//
// Purpose: probe whether the rawler wasm crate (built for CR2) decodes Sony ARW,
// and if so characterize it — WITHOUT touching any gate, constant, or the flag.
// A rawler REJECTION of ARW is a VALID finding (confirms the per-format-scoped
// flip), reported honestly. Reuses the SAME wasm pkg + decode_raw entry that
// ab_live.mjs drives (no fork).
//
// Per file: (1) decode; (2) determinism (decode TWICE, byte-identical CFA md5);
// (3) sanity — pattern/dims/black/white/make/model vs EXIF-declared expectations;
// (4) OB border rects + stats; (5) golden manifest (same format as the IMG_1653
// golden). Same-scene pair (14bit-uncompressed vs 12bit-compressed): per-pixel
// demosaic delta stats. m4 detection is run SEPARATELY via tools/recal/dump_detections.mjs.
//
// Memory: ARW frames are up to 42MP → rgb16_active ~253MB each. Files are
// processed sequentially and handles freed promptly; the same-scene pair retains
// two rgb16 buffers only for the diff. Raw pixels NEVER enter an LLM context —
// only md5s / stats / rects are emitted.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const WRITE_GOLDEN = args.includes('--golden');
const ARW_DIR = path.resolve(argVal('--dir')
    ?? path.join(ROOT, '..', 'ASTROLOGIC_DEPLOY', 'Sample Files', 'sony_arw'));
const GOLDEN_DIR = path.join(ROOT, 'test_results', 'decoder_prestage', 'golden');
const PKG_DIR = path.join(ROOT, 'src', 'engine', 'wasm_decode', 'pkg');

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const log = (...a) => console.log('[arw_smoke]', ...a);

// EXIF-declared expectations (from filename + documented Sony sensor specs; the
// rawler-reported values are the MEASURED authority — mismatches are flagged).
const EXPECT = {
    'ILCE-7RM3_14bit_uncompressed.ARW': { model: 'ILCE-7RM3', mp_approx: 42.4, bits: 14, note: 'A7R III, full-frame 42MP, uncompressed 14-bit' },
    'ILCE-7RM3_12bit_compressed.ARW': { model: 'ILCE-7RM3', mp_approx: 42.4, bits: 12, note: 'A7R III, full-frame 42MP, lossy-compressed 12-bit (same scene as uncompressed)' },
    'ILCE-6300_AST05226.ARW': { model: 'ILCE-6300', mp_approx: 24.2, bits: 14, note: 'A6300, APS-C 24MP' },
};

function stats(arrLike, step = 1) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < arrLike.length; i += step) {
        const v = arrLike[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v; n++;
    }
    if (n === 0) return null;
    const cap = 2_000_000;
    const s2 = Math.max(step, Math.ceil(arrLike.length / cap));
    const sample = [];
    for (let i = 0; i < arrLike.length; i += s2) sample.push(arrLike[i]);
    sample.sort((a, b) => a - b);
    const q = (p) => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))];
    return { n, min, max, mean: +(sum / n).toFixed(2), p01: q(0.01), p50: q(0.5), p99: q(0.99) };
}

let wasmMod = null;
function initWasm() {
    if (wasmMod) return wasmMod;
    if (!fs.existsSync(path.join(PKG_DIR, 'wasm_decode.js'))) {
        throw new Error(`wasm_decode pkg not built at ${PKG_DIR} — run: cd src/engine/wasm_decode && wasm-pack build --target web`);
    }
    return null; // async import handled in main
}

// Decode one file; returns { ok, meta, cfaMd5, lumaMd5, obAreas, rgb16?, error }.
function decodeFile(mod, file, { keepRgb = false } = {}) {
    let dec = null;
    try {
        const bytes = fs.readFileSync(file);
        dec = mod.decode_raw(new Uint8Array(bytes));
        const meta = JSON.parse(dec.meta_json());
        const cfaMd5 = md5(Buffer.from(dec.cfa_full_le()));
        const lumaMd5 = md5(Buffer.from(dec.demosaic_luma_full_le()));
        const obAreas = [];
        for (let i = 0; i < dec.ob_area_count(); i++) {
            const px = dec.ob_pixels(i);
            obAreas.push({ rect: meta.black_areas?.[i] ?? null, ...stats(px) });
        }
        const active = meta.active_area ?? { x: 0, y: 0, w: meta.width, h: meta.height };
        let rgb16 = null;
        if (keepRgb) rgb16 = dec.rgb16_active();   // Uint16Array copy (interleaved RGB)
        return { ok: true, meta, cfaMd5, lumaMd5, obAreas, active, rgb16 };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    } finally {
        dec?.free();
    }
}

function pairDelta(a, b) {
    // a, b = interleaved RGB16 Uint16Array of the SAME active dims. Per-element abs delta.
    if (!a || !b || a.length !== b.length) {
        return { status: 'NOT MEASURED', reason: `active RGB length mismatch (${a?.length ?? 'n/a'} vs ${b?.length ?? 'n/a'}) — cannot align same-scene pixels` };
    }
    let sum = 0, max = 0, nz = 0;
    const n = a.length;
    // full pass for sum/max/nonzero; percentile on a bounded sample of the deltas
    const cap = 2_000_000;
    const step = Math.max(1, Math.ceil(n / cap));
    const sample = [];
    for (let i = 0; i < n; i++) {
        const d = Math.abs(a[i] - b[i]);
        sum += d; if (d > max) max = d; if (d !== 0) nz++;
        if (i % step === 0) sample.push(d);
    }
    sample.sort((x, y) => x - y);
    const q = (p) => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))];
    return {
        status: 'MEASURED',
        elements: n,
        mean_abs_delta: +(sum / n).toFixed(4),
        max_abs_delta: max,
        nonzero_fraction: +(nz / n).toFixed(6),
        p50_abs_delta: q(0.5), p99_abs_delta: q(0.99), p999_abs_delta: q(0.999),
        note: '14bit-uncompressed vs 12bit-compressed, integer demosaic (active area). Domains identical (both raw ADU + pedestal); delta = the lossy-compression cost, in ADU. Both decodes are deterministic (compression is lossy-but-DETERMINISTIC).',
    };
}

async function main() {
    initWasm();
    wasmMod = await import(pathToFileURL(path.join(PKG_DIR, 'wasm_decode.js')).href);
    wasmMod.initSync({ module: fs.readFileSync(path.join(PKG_DIR, 'wasm_decode_bg.wasm')) });

    const files = ['ILCE-7RM3_14bit_uncompressed.ARW', 'ILCE-7RM3_12bit_compressed.ARW', 'ILCE-6300_AST05226.ARW']
        .map((n) => path.join(ARW_DIR, n)).filter((f) => fs.existsSync(f));
    log(`${files.length} ARW present in ${ARW_DIR}`);
    if (files.length === 0) { log('NO ARW files — nothing to smoke.'); process.exit(0); }

    const report = { study: 'arw_smoke_rawler', date: new Date().toISOString(), pkg: PKG_DIR, files: [] };
    const retained = {}; // basename → rgb16 for the same-scene pair

    for (const file of files) {
        const base = path.basename(file);
        const expect = EXPECT[base] ?? null;
        const isPairMember = base.startsWith('ILCE-7RM3_');
        log(`decode ${base} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB)…`);

        // pass 1 (retain rgb only for the 7RM3 pair members)
        const d1 = decodeFile(wasmMod, file, { keepRgb: isPairMember });
        if (!d1.ok) {
            log(`  REJECTED: ${d1.error}`);
            report.files.push({ file: base, status: 'RAWLER_REJECTED', error: d1.error, expect,
                finding: 'rawler wasm crate does NOT decode this ARW — VALID finding (confirms per-format-scoped flip; ARW is out of the CR2 rail scope until an ARW-capable decoder lands).' });
            continue;
        }
        // pass 2 (determinism) — no rgb retention
        const d2 = decodeFile(wasmMod, file, { keepRgb: false });
        const deterministic = d2.ok && d1.cfaMd5 === d2.cfaMd5 && d1.lumaMd5 === d2.lumaMd5;

        const m = d1.meta;
        const full = { width: m.width, height: m.height };
        const mp = +(full.width * full.height / 1e6).toFixed(2);
        const sanity = {
            make_model_measured: `${m.make ?? ''} ${m.model ?? ''}`.trim(),
            model_matches_filename: expect ? (String(m.model ?? '').includes(expect.model)) : null,
            full_dims: `${full.width}x${full.height}`,
            megapixels_measured: mp,
            megapixels_expected_approx: expect?.mp_approx ?? null,
            mp_within_10pct: expect ? (Math.abs(mp - expect.mp_approx) / expect.mp_approx < 0.10) : null,
            active_area: m.active_area, crop_area: m.crop_area,
            cfa_pattern_full: m.cfa_pattern_full, cfa_pattern_active: m.cfa_pattern_active,
            bps_measured: m.bps, bps_expected: expect?.bits ?? null,
            blacklevel_bayer: m.blacklevel_bayer, whitelevel: m.whitelevel,
            wb_coeffs: m.wb_coeffs, data_is_integer: m.data_is_integer,
        };

        const golden = {
            file: base,
            cfa: { dims: `${full.width}x${full.height}`, pattern: m.cfa_pattern_full, dtype: 'u16_le',
                len_bytes: full.width * full.height * 2, md5: d1.cfaMd5 },
            demosaic_luma: { dims: `${full.width}x${full.height}`, dtype: 'u32_le',
                len_bytes: full.width * full.height * 4, md5: d1.lumaMd5,
                formula: 'L=R+G+B, integer bilinear (rounded /2,/4 shifts) over full-frame raw CFA, no black-subtraction' },
            blacklevel_bayer: m.blacklevel_bayer, whitelevel: m.whitelevel,
            active_area: m.active_area, crop_area: m.crop_area,
            black_areas_count: d1.obAreas.length,
        };
        if (WRITE_GOLDEN) {
            fs.mkdirSync(GOLDEN_DIR, { recursive: true });
            fs.writeFileSync(path.join(GOLDEN_DIR, `${base}.golden_manifest.json`), JSON.stringify(golden, null, 2));
        }

        report.files.push({
            file: base, status: 'OK', expect,
            determinism: { cfa_md5: d1.cfaMd5, luma_md5: d1.lumaMd5, decoded_twice_byte_identical: deterministic,
                pass2_ok: d2.ok, pass2_error: d2.ok ? null : d2.error },
            sanity,
            optical_black: { areas: d1.obAreas.length, rects_and_stats: d1.obAreas,
                note: d1.obAreas.length ? 'OB border recovered (per-frame dark/bias anchor; record-only, no engine consumer wired).' : 'No OB areas reported by rawler for this model.' },
            golden_manifest: golden,
            golden_written: WRITE_GOLDEN,
        });
        log(`  OK: ${sanity.make_model_measured} · ${sanity.full_dims} (${mp}MP) · ${m.cfa_pattern_full} · bps=${m.bps} · black=${JSON.stringify(m.blacklevel_bayer)} white=${JSON.stringify(m.whitelevel)} · OB=${d1.obAreas.length} · deterministic=${deterministic}`);
        if (isPairMember && d1.rgb16) retained[base] = { rgb16: d1.rgb16, active: d1.active };
    }

    // ── same-scene pair: 14bit-uncompressed vs 12bit-compressed ──────────────
    const A = retained['ILCE-7RM3_14bit_uncompressed.ARW'];
    const B = retained['ILCE-7RM3_12bit_compressed.ARW'];
    if (A && B) {
        log('same-scene pair delta (14bit-uncompressed vs 12bit-compressed, active RGB16)…');
        report.pair_14bit_vs_12bit = {
            a: 'ILCE-7RM3_14bit_uncompressed.ARW', b: 'ILCE-7RM3_12bit_compressed.ARW',
            a_active: A.active, b_active: B.active,
            delta: pairDelta(A.rgb16, B.rgb16),
        };
        const dstat = report.pair_14bit_vs_12bit.delta;
        log(`  pair delta: ${dstat.status}${dstat.status === 'MEASURED' ? ` · mean|Δ|=${dstat.mean_abs_delta} ADU · max=${dstat.max_abs_delta} · nonzero=${(dstat.nonzero_fraction * 100).toFixed(2)}% · p99=${dstat.p99_abs_delta}` : ` · ${dstat.reason}`}`);
    } else {
        report.pair_14bit_vs_12bit = { status: 'NOT MEASURED', reason: 'one or both 7RM3 pair members missing or rejected' };
    }

    const outDir = path.join(ROOT, 'test_results', 'decoder_prestage');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'arw_smoke.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    log(`report: ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => { console.error('[arw_smoke] FATAL:', e); process.exit(1); });
