// ═══════════════════════════════════════════════════════════════════════════
// A/B PRE-STAGE — rawler full-frame vs libraw active-area (decoder-cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//   RAWLER_PROBE_EXE=<path/to/probe.exe> node tools/rawlab/ab_prestage.mjs
//
// Drives BOTH decoders on a diverse CR2 set and persists the side-by-side the
// cutover needs. NEVER loads raw pixel bytes into an LLM context — it only spawns
// the two decoders and merges their JSON:
//   * RAWLER arm  = the committed `rawler_probe` native binary (--parity): FULL
//     frame, raw ADU, per-channel black/white, active-area origin, OB areas,
//     black-subtracted period-2 parity before/after the integer demosaic.
//   * LIBRAW arm  = the existing `demosaic_reference.mjs` (libraw-wasm mem_image):
//     ACTIVE area, black-subtracted+scaled, shipped-mosaic vs integer-demosaic
//     parity. (Reused, not reimplemented — LAW 4.)
//
// Measures + labels MEASURED vs APPROXIMATE: framing offsets (active-area crop
// origin vs full frame), value-domain deltas (raw-ADU vs black-subtracted+scaled),
// period-2 checker power before/after demosaic (both arms), OB-border first look.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTDIR = path.resolve(ROOT, 'test_results/decoder_prestage');
fs.mkdirSync(OUTDIR, { recursive: true });

const PROBE = process.env.RAWLER_PROBE_EXE
    || 'C:/Users/ahoga/AppData/Local/Temp/claude/K--Coding-Projects-Newtonian-Color-Engine-SKYCRUNCHER-DEPLOY/95806d71-3db4-45b1-9cb2-0df6b0c25019/scratchpad/rawler_probe_target/release/probe.exe';

// Diverse set: bundled + 5 diverse T6 frames + a DIFFERENT camera (5D MkIII) + demo.
// (The astrobackyard 60Da intake corpus is NOT present on this box -> data-blocked;
//  recorded as a cutover-session inheritance note, not a failure.)
const FILES = [
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1653.CR2', // bundled sacred
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1238.CR2',
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1757.CR2', // oracle-confirmed TP
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1802.CR2',
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1414.CR2',
    'Sample Files/rotating/CSM30803_5DMkIII_iso6400_15s.CR2',                       // 2nd camera model
    'public/demo/sample_observation.cr2',                                          // demo
];

function runRawler(absPath) {
    const out = execFileSync(PROBE, [absPath, '--parity'], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
}

function runLibraw(absPaths, outJson) {
    const args = [path.resolve(ROOT, 'tools/rawlab/demosaic_reference.mjs')];
    for (const p of absPaths) { args.push('--file', p); }
    args.push('--out', outJson);
    // demosaic_reference.mjs resolves relative to ROOT; give absolute paths.
    execFileSync('node', args, { cwd: ROOT, stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

async function main() {
    const present = FILES.filter(f => fs.existsSync(path.resolve(ROOT, f)));
    const absent = FILES.filter(f => !fs.existsSync(path.resolve(ROOT, f)));
    console.log(`[ab] ${present.length}/${FILES.length} files present; probe=${path.basename(PROBE)}`);

    // ── RAWLER arm ──────────────────────────────────────────────────────────
    const rawler = {};
    for (const rel of present) {
        const abs = path.resolve(ROOT, rel);
        try {
            console.log(`[ab] rawler decode ${path.basename(rel)} ...`);
            rawler[rel] = runRawler(abs);
        } catch (e) {
            console.error(`[ab] rawler FAILED ${rel}: ${e.message?.slice(0, 200)}`);
            rawler[rel] = { status: 'DECODE_FAILED', error: String(e.message || e).slice(0, 300) };
        }
    }

    // ── LIBRAW arm (reuse demosaic_reference.mjs) ───────────────────────────
    let libraw = { files: [] };
    try {
        console.log(`[ab] libraw arm via demosaic_reference.mjs (${present.length} files) ...`);
        const okAbs = present.map(r => path.resolve(ROOT, r));
        libraw = runLibraw(okAbs, path.resolve(OUTDIR, 'libraw_arm.json'));
    } catch (e) {
        console.error(`[ab] libraw arm FAILED: ${e.message?.slice(0, 300)}`);
    }
    const librawByBase = {};
    for (const f of (libraw.files || [])) { librawByBase[path.basename(f.file)] = f; }

    // ── MERGE + deltas ──────────────────────────────────────────────────────
    const rows = [];
    for (const rel of FILES) {
        const base = path.basename(rel);
        if (absent.includes(rel)) { rows.push({ file: rel, status: 'ABSENT' }); continue; }
        const R = rawler[rel];
        const L = librawByBase[base];
        if (R?.status === 'DECODE_FAILED') { rows.push({ file: rel, status: 'RAWLER_DECODE_FAILED', error: R.error }); continue; }

        const fullW = R.full_dims ? +R.full_dims.split('x')[0] : null;
        const fullH = R.full_dims ? +R.full_dims.split('x')[1] : null;
        const aa = R.active_area || null;
        const librawActive = L && L.status === 'OK' ? L.active : null;

        // framing offsets: full-frame -> active-area crop
        const framing = {
            rawler_full: R.full_dims,
            rawler_active: aa ? `${aa.w}x${aa.h}@(${aa.x},${aa.y})` : null,
            rawler_crop: R.crop_area ? `${R.crop_area.w}x${R.crop_area.h}@(${R.crop_area.x},${R.crop_area.y})` : null,
            libraw_delivered_active: librawActive ? `${librawActive.w}x${librawActive.h}` : (L ? L.status : 'n/a'),
            // MEASURED: how many rows/cols of OB border rawler keeps that libraw drops
            left_border_cols_MEASURED: aa ? aa.x : null,
            top_border_rows_MEASURED: aa ? aa.y : null,
            right_border_cols_MEASURED: (aa && fullW != null) ? fullW - (aa.x + aa.w) : null,
            bottom_border_rows_MEASURED: (aa && fullH != null) ? fullH - (aa.y + aa.h) : null,
            active_dim_delta_vs_libraw: (aa && librawActive) ? `${aa.w - librawActive.w} x ${aa.h - librawActive.h}` : null,
        };

        // value-domain deltas
        const valueDomain = {
            rawler_raw_adu_MEASURED: { min: R.data.min, max: R.data.max, mean: +R.data.mean.toFixed(2) },
            rawler_blacklevel: R.blacklevel.bayer,
            rawler_whitelevel: R.whitelevel,
            libraw_black_subtracted_scaled_MEASURED: L && L.levels_empirical ? { min: L.levels_empirical.min, max: L.levels_empirical.max, p50: L.levels_empirical.p50 } : null,
            implied_linear_scale_raw_to_libraw_APPROX: (R.whitelevel && R.whitelevel[0]) ? +(65535 / (R.whitelevel[0] - R.blacklevel.bayer[0])).toFixed(4) : null,
            note: 'rawler = raw ADU with ~black pedestal + OB borders; libraw = black-subtracted, scaled to full 16-bit, OB discarded. md5 bit-equality across the two is IMPOSSIBLE by construction.',
        };

        // period-2 parity before/after integer demosaic — BOTH arms
        const parity = {
            rawler_black_subtracted: R.parity ? {
                checker_before: R.parity.raw_cfa.checker, checker_after: R.parity.integer_demosaic_luma.checker,
                checker_reduction_pct: R.parity.checker_reduction_pct,
                rowParity_before: R.parity.raw_cfa.rowParity, rowParity_after: R.parity.integer_demosaic_luma.rowParity,
                rowParity_reduction_pct: R.parity.rowParity_reduction_pct,
            } : null,
            libraw_shipped_vs_reference: (L && L.parity) ? {
                checker_before: L.parity.shipped_cfa_mosaic.checker, checker_after: L.parity.integer_demosaic_reference.checker,
                checker_reduction_pct: L.parity.checker_reduction_pct,
                rowParity_before: L.parity.shipped_cfa_mosaic.rowParity, rowParity_after: L.parity.integer_demosaic_reference.rowParity,
                rowParity_reduction_pct: L.parity.rowParity_reduction_pct,
            } : null,
            note: 'Both arms: identical integer-bilinear + parity ALGORITHM (rawler arm is the Rust port of demosaic_reference.mjs). Domains differ (rawler black-subtracted raw vs libraw black-subtracted scaled); compare the REDUCTION %, not absolute magnitudes.',
        };

        // OB first look (rawler only — libraw discards OB borders, the cutover motivation)
        const ob = {
            rawler_black_areas: R.black_areas,
            rawler_black_area_stats_MEASURED: R.black_area_stats,
            libraw_OB_available: false,
            note: 'OB border = synthetic-dark anchor (DARK_CALIBRATION_POLICY.md Reading B). Present ONLY in the rawler full-frame arm; libraw delivers the trimmed active area so no per-frame dark reference survives.',
        };

        rows.push({
            file: rel, base, status: 'OK',
            camera: `${R.make} ${R.model}`.trim(),
            framing, value_domain: valueDomain, parity, optical_black: ob,
            cfa: R.cfa, cpp: R.cpp, bps: R.bps,
        });
    }

    const doc = {
        study: 'ab_prestage_rawler_vs_libraw',
        date: new Date().toISOString().slice(0, 10),
        probe_exe: PROBE,
        files_present: present.length, files_absent: absent,
        legend: {
            MEASURED: 'directly computed from a decode this run',
            APPROXIMATE: 'derived/estimated (e.g. implied linear scale); labeled APPROX',
        },
        rows,
    };
    const outPath = path.resolve(OUTDIR, 'ab_comparison.json');
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
    console.log(`[ab] wrote ${path.relative(ROOT, outPath)} (${rows.filter(r => r.status === 'OK').length} OK / ${rows.length})`);

    // compact console summary
    for (const r of rows) {
        if (r.status !== 'OK') { console.log(`  ${path.basename(r.file)}: ${r.status}`); continue; }
        const p = r.parity.rawler_black_subtracted;
        const ob0 = r.optical_black.rawler_black_area_stats_MEASURED[0];
        console.log(`  ${r.base}: ${r.cfa.name} full ${r.framing.rawler_full} active@(${r.framing.left_border_cols_MEASURED},${r.framing.top_border_rows_MEASURED}) `
            + `raw[min ${r.value_domain.rawler_raw_adu_MEASURED.min} mean ${r.value_domain.rawler_raw_adu_MEASURED.mean}] `
            + `checker ${p ? p.checker_before.toExponential(2) + '->' + p.checker_after.toExponential(2) + ' (-' + p.checker_reduction_pct + '%)' : 'n/a'} `
            + `OB[${r.optical_black.rawler_black_areas} area, mean ${ob0 ? ob0.mean.toFixed(1) : 'n/a'}]`);
    }
}

main().catch(e => { console.error('[ab] FATAL:', e); process.exit(1); });
