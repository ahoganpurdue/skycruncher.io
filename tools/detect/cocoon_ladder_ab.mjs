// ═══════════════════════════════════════════════════════════════════════════
// COCOON CR2 — DECODE A/B via the MATCH LADDER (rawler clean vs libraw baseline)
// ═══════════════════════════════════════════════════════════════════════════
// Runs the SAME match-ladder instrument (tools/solverkit/match_ladder) on the
// Cocoon L_0020 CR2 detections produced by the CLEAN rawler decode lane
// (tools/detect/decode_plane_rawler → *.rawler.dets.json), then compares the
// per-rung verdict + metrics against the banked libraw-arm baseline
// (test_results/match_ladder_cocoon_cr2_2026-07-12/run/…ladder.json).
//
// TRUTH (honest-or-absent): L_0020 does NOT blind-solve (population receipt
// kind=failure). Its confirmed pointing is the assisted/hinted solve
// (center RA 21.848…h · Dec 47.360° · scale 2.00574"/px). The rawler decode is a
// DIFFERENT pixel frame (5202×3465 LANDSCAPE) from libraw (3464×5202 PORTRAIT),
// so the camera ROTATION (1 DOF) + PARITY (2-way) are RE-RECOVERED here for the
// rawler frame by the IDENTICAL coincidence-max method gen_cocoon_manifest.mjs
// used for the libraw frame — each decoder graded in its own native frame against
// an equally-valid per-frame truth. Only the DECODE differs; catalog, center,
// scale, ladder config are held fixed → the A/B isolates decode quality.
//
//   node tools/detect/cocoon_ladder_ab.mjs \
//        --dets test_results/cr2_dets_rawler/<base>/<base>.rawler.dets.json \
//        --before test_results/match_ladder_cocoon_cr2_2026-07-12/run/<…>.ladder.json \
//        --out test_results/cocoon_decode_ab_<date>
//
// Two ledgers (LAW 1): COORDINATE math only past decode (WCS, projection, quads).
// src/ READ-ONLY; no calibrated constant authored (GATE.* imported read-only).
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DETS = path.resolve(ROOT, val('--dets', ''));
const BEFORE = val('--before', 'test_results/match_ladder_cocoon_cr2_2026-07-12/run/Sample_Files_corpus_cocoon_60da_lights_L_0020_ISO800_240s__18C.CR2.ladder.json');
const OUT = path.resolve(ROOT, val('--out', path.join('test_results', 'cocoon_decode_ab')));

// confirmed pointing (assisted/hinted solve — same constants as gen_cocoon_manifest)
const RA_HOURS = 21.84828759635201;
const RA_DEG = RA_HOURS * 15;
const DEC_DEG = 47.359708599725664;
const SCALE = 2.005744765367906;       // "/px
const RADIUS_DEG = 3, MAG_LIMIT = 13;  // ladder catalog depth (matches before-run manifest)

async function main() {
    if (!DETS || !fs.existsSync(DETS)) { console.error(`[ab] rawler dets NOT FOUND: ${DETS}`); return 2; }
    fs.mkdirSync(OUT, { recursive: true });
    const common = await import(pathToFileURL(path.join(ROOT, 'tools/solverkit/common.mjs')).href);
    const ladder = await import(pathToFileURL(path.join(ROOT, 'tools/solverkit/match_ladder.mjs')).href);
    const { loadWasm, loadCatalog, projectStars, buildDetGrid, nearestDet } = common;
    await loadWasm();

    const dj = JSON.parse(fs.readFileSync(DETS, 'utf8'));
    const det = dj.dets, W = dj.width, H = dj.height;
    console.log(`[ab] rawler dets: ${det.length} on ${W}x${H} (decoder=${dj.decoder})`);

    // ── recover rotation + parity for the RAWLER frame (gen_cocoon_manifest method) ──
    const catSearch = loadCatalog({ raDeg: RA_DEG, decDeg: DEC_DEG, radiusDeg: RADIUS_DEG, magLimit: 12 }).stars;
    const grid = buildDetGrid(det, 128);
    const dpp = SCALE / 3600;
    function coincAt(rotDeg, parity, tau) {
        const t = rotDeg * Math.PI / 180;
        const cd = [[dpp * Math.cos(t), dpp * Math.sin(t)], [-dpp * parity * Math.sin(t), dpp * parity * Math.cos(t)]];
        const wcs = { crval: [RA_DEG, DEC_DEG], crpix: [W / 2, H / 2], cd };
        const proj = projectStars({ stars: catSearch, wcs, w: W, h: H, margin: 4 });
        let n = 0; const used = new Set();
        for (const s of proj) {
            const hit = nearestDet(grid, s.x, s.y, tau);
            if (!hit) continue;
            const k = ((hit.d.x * 131071) | 0) ^ ((hit.d.y * 8191) | 0);
            if (used.has(k)) continue; used.add(k); n++;
        }
        return n;
    }
    let best = { n: -1, deg: 0, parity: 1 };
    for (const parity of [1, -1]) for (let deg = -180; deg < 180; deg += 0.5) {
        const n = coincAt(deg, parity, 20);
        if (n > best.n) best = { n, deg: +deg.toFixed(2), parity };
    }
    let fine = { n: -1, deg: best.deg, parity: best.parity };
    for (let deg = best.deg - 0.6; deg <= best.deg + 0.6 + 1e-9; deg += 0.02) {
        const n = coincAt(+deg.toFixed(2), best.parity, 6);
        if (n > fine.n) fine = { n, deg: +deg.toFixed(2), parity: best.parity };
    }
    best = fine;
    console.log(`[ab] recovered rotation=${best.deg}deg parity=${best.parity} (coincidences=${best.n}/${catSearch.length} @tau6px)`);

    // ── run the ladder on an INLINE-dets manifest (no re-decode) ────────────
    const manifest = {
        label: 'cocoon-60da-cr2-RAWLER', defaults: { magLimit: MAG_LIMIT },
        frames: [{
            frame: dj.frame, label: 'Cocoon_60Da_L_0020_CR2_rawler',
            dets: det, width: W, height: H,
            radiusDeg: RADIUS_DEG, magLimit: MAG_LIMIT,
            true_center: { ra_hours: RA_HOURS, dec_degrees: DEC_DEG },
            true_scale_arcsec: SCALE, true_rot_deg: best.deg, true_parity: best.parity,
        }],
    };
    const cfg = { ...ladder.LADDER_DEFAULTS, ...(manifest.defaults ?? {}) };
    const { records } = await ladder.runManifest(manifest, cfg);
    const after = records[0];
    fs.writeFileSync(path.join(OUT, 'L_0020_rawler.ladder.json'), JSON.stringify(after, null, 2));
    fs.writeFileSync(path.join(OUT, 'manifest_rawler.json'), JSON.stringify(manifest, (k, v) => k === 'dets' ? `[${v.length} inline dets omitted]` : v, 1));

    // ── load the banked libraw "before" + compare ──────────────────────────
    const beforePath = path.resolve(ROOT, BEFORE);
    const before = fs.existsSync(beforePath) ? JSON.parse(fs.readFileSync(beforePath, 'utf8')) : null;

    const rungMetric = (rec, r) => {
        const R = rec?.rungs?.[r]; if (!R) return null;
        return { status: R.status, healthy: R.healthy, margin: R.margin ?? null, metrics: R.metrics };
    };
    const cmp = {
        frame: 'L_0020_ISO800_240s__18C.CR2',
        truth: { ra_hours: RA_HOURS, dec_degrees: DEC_DEG, scale_arcsec: SCALE,
            rawler_rot_deg: best.deg, rawler_parity: best.parity, rawler_recovery_coinc: best.n,
            note: 'rot/parity re-recovered per-frame; center+scale = confirmed hinted solve (shared).' },
        before_libraw: before ? {
            source: path.relative(ROOT, beforePath).replace(/\\/g, '/'),
            width: before.width, height: before.height, n_det: before.n_det, n_cat: before.n_cat,
            verdict_class: before.verdict_class, margin: before.margin, rung_reached: before.rung_reached,
            rungA: rungMetric(before, 'A'), rungD: rungMetric(before, 'D'),
        } : { source: 'ABSENT', note: `before ladder.json not found at ${BEFORE}` },
        after_rawler: {
            width: after.width, height: after.height, n_det: after.n_det, n_cat: after.n_cat,
            verdict_class: after.verdict_class, margin: after.margin, rung_reached: after.rung_reached,
            rungA: rungMetric(after, 'A'), rungD: rungMetric(after, 'D'),
        },
        decode_delta: before ? {
            n_det: after.n_det - before.n_det,
            rungA_recall_maxtau: {
                before: before?.rungs?.A?.metrics?.recallAtMaxTau ?? null,
                after: after?.rungs?.A?.metrics?.recallAtMaxTau ?? null,
            },
            rungA_precision_maxtau: {
                before: before?.rungs?.A?.metrics?.precisionAtMaxTau ?? null,
                after: after?.rungs?.A?.metrics?.precisionAtMaxTau ?? null,
            },
            rungD_sigma: {
                before: before?.rungs?.D?.metrics?.sigma ?? null,
                after: after?.rungs?.D?.metrics?.sigma ?? null,
            },
            verdict: { before: before.verdict_class, after: after.verdict_class },
        } : null,
    };
    fs.writeFileSync(path.join(OUT, 'decode_ab_compare.json'), JSON.stringify(cmp, null, 2));

    // ── console table ───────────────────────────────────────────────────────
    const A = (rec) => rec?.rungs?.A?.metrics ?? {};
    const D = (rec) => rec?.rungs?.D?.metrics ?? {};
    console.log('\n┌─ COCOON L_0020 decode A/B (match ladder) ' + '─'.repeat(30));
    console.log('│ arm      dims        n_det  verdict  A.recall@8 A.prec@8 D.sigma');
    if (before) console.log(`│ libraw   ${String(before.width + 'x' + before.height).padEnd(11)} ${String(before.n_det).padEnd(6)} ${String(before.verdict_class).padEnd(8)} ${String(A(before).recallAtMaxTau).padEnd(10)} ${String(A(before).precisionAtMaxTau).padEnd(8)} ${D(before).sigma}`);
    console.log(`│ rawler   ${String(after.width + 'x' + after.height).padEnd(11)} ${String(after.n_det).padEnd(6)} ${String(after.verdict_class).padEnd(8)} ${String(A(after).recallAtMaxTau).padEnd(10)} ${String(A(after).precisionAtMaxTau).padEnd(8)} ${D(after).sigma}`);
    console.log('└' + '─'.repeat(72));
    console.log(`[ab] wrote → ${path.relative(ROOT, OUT)} (rawler ladder + compare + manifest)`);

    await common.terminateRawDecodeWorkers?.();
    return 0;
}

const code = await main();
process.exitCode = code;
setTimeout(() => process.exit(code), 200);
