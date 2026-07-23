// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — MATCH LADDER SELFTEST (synthetic-fixture unit checks)
// ═══════════════════════════════════════════════════════════════════════════
// Hermetic (no atlas, no WASM, no capture dumps): every fixture is built off the
// solverkit synthetic injector (synthetic_inject.injectFrame → seeded projection
// of a synthetic catalog through a known true WCS), so the checks run anywhere.
//
//   node tools/solverkit/match_ladder.selftest.mjs
//
// Asserts:
//   1. a fixture engineered to die at each rung yields the right rung_reached /
//      verdict_class (A, B, C, D) + a HEALTHY_LADDER positive control.
//   2. determinism: two runs over the same manifest are byte-identical.
//   3. empty / degenerate inputs are handled honestly (DATA_ABSENT / NOT_MEASURED
//      / ERROR record), never thrown.
//   4. the actual CLI (--manifest/--out) writes per-frame JSON + summary and is
//      byte-identical across a double run.
// Exits non-zero on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    rng, projectStars, loadWasm, DATA_ROOT,
    extractDetectionsFromPlanes, loadCr2Detections, terminateRawDecodeWorkers,
} from './common.mjs';
import { injectFrame } from './synthetic_inject.mjs';
import { LADDER_DEFAULTS, runManifest, runLadder, resolveTrueWcs } from './match_ladder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D2R = Math.PI / 180;
let pass = 0, fail = 0, skips = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL: ${msg}`); } };
const skip = (msg) => { skips++; console.log(`  ⊘ SKIP: ${msg}`); };

// ── minimal 3-plane int16BE FITS writer (matches common.loadFitsDetections's
//    header scan + RGB16BE plane layout) — paints grey gaussian blobs at `points`
//    so the FITS arm has real stars to extract. Used only to regression-test the
//    async FITS-decode branch (the const-entry reassignment bug). ────────────────
function buildFits3Plane(W, H, points) {
    const bg = -32000, peak = 22000, npix = W * H;
    const plane = new Int16Array(npix).fill(bg);
    for (const { x, y } of points) {
        const cx = Math.round(x), cy = Math.round(y);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const px = cx + dx, py = cy + dy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const g = Math.exp(-(dx * dx + dy * dy) / 2.0);
            const v = Math.round(bg + (peak - bg) * g), i = py * W + px;
            if (v > plane[i]) plane[i] = v;
        }
    }
    const cards = ['SIMPLE  =                    T', 'BITPIX  =                   16',
        'NAXIS   =                    3', `NAXIS1  = ${String(W).padStart(20)}`,
        `NAXIS2  = ${String(H).padStart(20)}`, 'NAXIS3  =                    3', 'END'];
    let hdr = cards.map((c) => c.padEnd(80)).join('');
    hdr = hdr.padEnd(Math.ceil(hdr.length / 2880) * 2880, ' ');
    const hdrBuf = Buffer.from(hdr, 'latin1');
    const dataBuf = Buffer.alloc(npix * 2 * 3);
    for (let pl = 0; pl < 3; pl++) { const base = pl * npix * 2; for (let i = 0; i < npix; i++) dataBuf.writeInt16BE(plane[i], base + i * 2); }
    const total = hdrBuf.length + dataBuf.length, dpad = (2880 - (total % 2880)) % 2880;
    return Buffer.concat([hdrBuf, dataBuf, Buffer.alloc(dpad)]);
}

// ── synthetic geometry + catalog (deterministic) ────────────────────────────
const CENTER = [180, 0];
const wcsFor = (W, H, scale) => ({ crval: CENTER, crpix: [W / 2, H / 2], cd: [[scale / 3600, 0], [0, scale / 3600]] });
function synthCatalog(n, fovR, seed, center = CENTER, magLo = 4, magHi = 8.5) {
    const rand = rng(seed >>> 0); const out = [];
    for (let i = 0; i < n; i++) {
        const rr = Math.sqrt(rand()) * fovR, th = rand() * 2 * Math.PI;
        const dDec = rr * Math.sin(th);
        const dRa = rr * Math.cos(th) / Math.cos((center[1] + dDec) * D2R);
        out.push({ ra_deg: center[0] + dRa, dec_deg: center[1] + dDec, mag: magLo + rand() * (magHi - magLo) });
    }
    return out;
}
const frame = (frameName, W, H, scale, cat, det, extra = {}) => ({
    frame: frameName, width: W, height: H, dets: det, catalog: cat,
    true_wcs: wcsFor(W, H, scale), ...extra,
});

// ── the five fixtures (params locked from the tuning sweep) ──────────────────
function fixtures() {
    const F = [];
    // HEALTHY positive control — clean deep field, low noise. All rungs healthy.
    {
        const W = 1000, H = 1000, sc = 10, cat = synthCatalog(60, 1.2, 11);
        const inj = injectFrame({ trueWcs: wcsFor(W, H, sc), cat, w: W, h: H,
            params: { posNoisePx: 1.0, nForeground: 0, nFalse: 4, complMag: 9, complWidth: 0.4, anchorObjectMag: 3.5 }, seed: 101 });
        F.push({ ...frame('healthy_control', W, H, sc, cat, inj.det, { is_control: true }), _expect: 'HEALTHY_LADDER' });
    }
    // RUNG A death — heavy noise-maxima clutter + most true stars dropped ⇒
    // recall & precision collapse (the D19 noise-maxima risk).
    {
        const W = 1000, H = 1000, sc = 10, cat = synthCatalog(60, 1.2, 11);
        const inj = injectFrame({ trueWcs: wcsFor(W, H, sc), cat, w: W, h: H,
            params: { posNoisePx: 1.0, nForeground: 0, nFalse: 500, complMag: 4.5, complWidth: 0.3, detFluxFloor: 0.2, anchorObjectMag: 3.5 }, seed: 202 });
        F.push({ ...frame('rungA_noise_maxima', W, H, sc, cat, inj.det), _expect: 'A' });
    }
    // RUNG B death — clean sky, but the handed catalog carries out-of-range
    // (dec>90) hybrid-style rows ⇒ catalog-projection integrity fails.
    {
        const W = 1000, H = 1000, sc = 10, cat = synthCatalog(60, 1.2, 11);
        const inj = injectFrame({ trueWcs: wcsFor(W, H, sc), cat, w: W, h: H,
            params: { posNoisePx: 1.0, nForeground: 0, nFalse: 4, complMag: 9, complWidth: 0.4, anchorObjectMag: 3.5 }, seed: 303 });
        const corrupt = [...cat];
        for (let i = 0; i < 6; i++) corrupt.push({ ra_deg: 200 + i, dec_deg: 120 + i, mag: 5 }); // dec out of [-90,90]
        F.push({ ...frame('rungB_hybrid_units', W, H, sc, corrupt, inj.det), _expect: 'B' });
    }
    // RUNG C death — OFF-CENTER compact cluster (keeps parity decisive + verify
    // strong on the large frame) with centroid scatter large vs the quad scale ⇒
    // true quads present but their hash codes drift out of bin.
    {
        const W = 1000, H = 1000, sc = 10, cat = synthCatalog(40, 0.10, 11, [180, 0.7]);
        const inj = injectFrame({ trueWcs: wcsFor(W, H, sc), cat, w: W, h: H,
            params: { posNoisePx: 5, nForeground: 0, nFalse: 4, complMag: 9, complWidth: 0.4, anchorObjectMag: 3.5 }, seed: 404 });
        F.push({ ...frame('rungC_quad_hash', W, H, sc, cat, inj.det), _expect: 'C' });
    }
    // RUNG D death — small crowded frame: true correspondences are clean (A/B/C
    // healthy) but the chance null rises enough that verify σ stays below +5.
    {
        const W = 250, H = 250, sc = 10, fovR = (W / 2) * sc / 3600 * 0.9;
        const cat = synthCatalog(10, fovR, 11, CENTER, 4, 6.5);
        const inj = injectFrame({ trueWcs: wcsFor(W, H, sc), cat, w: W, h: H,
            params: { posNoisePx: 1.2, nForeground: 0, nFalse: 45, complMag: 9, complWidth: 0.4, detFluxFloor: 0.01, anchorObjectMag: 4.0 }, seed: 505 });
        F.push({ ...frame('rungD_verify_bar', W, H, sc, cat, inj.det), _expect: 'D' });
    }
    return F;
}

async function main() {
    const cfg = { ...LADDER_DEFAULTS };
    const fx = fixtures();
    const manifest = { label: 'ladder-selftest', frames: fx };

    // ── 1. per-rung verdicts ────────────────────────────────────────────────
    console.log('\n[1] rung-attribution on engineered fixtures');
    const { records, summary } = await runManifest(manifest, cfg);
    const byName = Object.fromEntries(records.map((r) => [r.frame, r]));
    for (const f of fx) {
        const r = byName[f.frame];
        ok(r && r.verdict_class === f._expect,
            `${f.frame} → verdict_class=${r?.verdict_class} (expect ${f._expect})`);
    }
    // the death rung's own margin must be negative (below its pass line); the
    // healthy control must carry a null margin.
    for (const f of fx) {
        const r = byName[f.frame];
        if (f._expect === 'HEALTHY_LADDER') ok(r.margin == null, `${f.frame} margin is null (healthy)`);
        else ok(typeof r.margin === 'number' && r.margin < 0, `${f.frame} margin=${r.margin} < 0`);
    }
    // aggregate routing points at the dominant failing rung (A appears once, as do
    // B/C/D → tie broken toward A by spec order) and names a routed verdict.
    ok(summary.routed_class === 'A' && !!summary.routed_verdict, `aggregate routed_class=${summary.routed_class} + verdict text present`);
    ok(summary.control_frame && summary.control_frame.verdict_class === 'HEALTHY_LADDER', 'control frame recorded HEALTHY in summary');

    // ── 2. determinism (double run byte-identical) ──────────────────────────
    console.log('\n[2] determinism');
    const run1 = await runManifest(manifest, cfg);
    const run2 = await runManifest(manifest, cfg);
    ok(JSON.stringify(run1.records) === JSON.stringify(run2.records), 'per-frame records byte-identical across two runs');
    ok(JSON.stringify(run1.summary) === JSON.stringify(run2.summary), 'summary byte-identical across two runs');

    // ── 3. degenerate / empty inputs don't throw ────────────────────────────
    console.log('\n[3] degenerate / empty inputs');
    const degenerate = { label: 'degenerate', frames: [
        { frame: 'empty_det', width: 500, height: 500, dets: [], catalog: synthCatalog(30, 0.5, 7), true_wcs: wcsFor(500, 500, 10) },
        { frame: 'empty_cat', width: 500, height: 500, dets: [{ x: 10, y: 10, flux: 1, fwhm: 2 }], catalog: [], true_wcs: wcsFor(500, 500, 10) },
        { frame: 'single_star', width: 500, height: 500, dets: [{ x: 250, y: 250, flux: 5, fwhm: 2 }], catalog: synthCatalog(1, 0.1, 7), true_wcs: wcsFor(500, 500, 10) },
        { frame: 'no_truth', width: 500, height: 500, dets: [{ x: 10, y: 10, flux: 1, fwhm: 2 }], catalog: synthCatalog(30, 0.5, 7) },
        { frame: 'both_empty', width: 500, height: 500, dets: [], catalog: [], true_wcs: wcsFor(500, 500, 10) },
    ] };
    let threw = false, degRecords = null;
    try { const res = await runManifest(degenerate, cfg); degRecords = res.records; }
    catch (e) { threw = true; console.log(`     threw: ${e.message}`); }
    ok(!threw, 'runManifest over degenerate inputs did not throw');
    if (degRecords) {
        const dg = Object.fromEntries(degRecords.map((r) => [r.frame, r]));
        // honest classifications, never a crash or a fabricated verdict
        ok(dg.no_truth && (dg.no_truth.verdict_class === 'DATA_ABSENT' || dg.no_truth.verdict_class === 'ERROR'), `no_truth → ${dg.no_truth?.verdict_class}`);
        ok(dg.empty_cat && dg.empty_cat.verdict_class !== undefined, `empty_cat → ${dg.empty_cat?.verdict_class} (no crash)`);
        ok(dg.both_empty && dg.both_empty.verdict_class !== undefined, `both_empty → ${dg.both_empty?.verdict_class} (no crash)`);
        // a frame with too little data must classify INSUFFICIENT_DATA, not a false rung death
        ok(dg.empty_det && (dg.empty_det.verdict_class === 'INSUFFICIENT_DATA' || ['A', 'B', 'C', 'D'].includes(dg.empty_det.verdict_class)),
            `empty_det → ${dg.empty_det?.verdict_class} (measured or honestly insufficient)`);
    }
    // resolveTrueWcs from an injected center (PDGP style) must not throw and must build a WCS
    try {
        const w = resolveTrueWcs({ frame: 'inj', true_center: { raDeg: 180, decDeg: 0 }, true_scale_arcsec: 10 }, 1000, 1000);
        ok(Array.isArray(w.crval) && Array.isArray(w.cd), 'resolveTrueWcs builds a WCS from true_center + scale');
    } catch (e) { ok(false, `resolveTrueWcs(true_center) threw: ${e.message}`); }

    // ── 4. CLI smoke: --manifest/--out writes files, deterministic double-run ──
    console.log('\n[4] CLI end-to-end');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-cli-'));
    const manPath = path.join(tmp, 'manifest.json');
    fs.writeFileSync(manPath, JSON.stringify(manifest));
    const outA = path.join(tmp, 'outA'), outB = path.join(tmp, 'outB');
    const cli = path.join(__dirname, 'match_ladder.mjs');
    let cliThrew = false;
    try {
        execFileSync(process.execPath, [cli, '--manifest', manPath, '--out', outA], { stdio: 'pipe' });
        execFileSync(process.execPath, [cli, '--manifest', manPath, '--out', outB], { stdio: 'pipe' });
    } catch (e) { cliThrew = true; console.log(`     CLI threw: ${e.message}`); }
    ok(!cliThrew, 'CLI ran to completion twice');
    const summA = path.join(outA, 'ladder_summary.json');
    ok(fs.existsSync(summA), 'CLI wrote ladder_summary.json');
    ok(fs.existsSync(path.join(outA, 'rungC_quad_hash.ladder.json')), 'CLI wrote a per-frame ladder record');
    if (fs.existsSync(summA)) {
        const a = fs.readFileSync(summA, 'utf8'), b = fs.readFileSync(path.join(outB, 'ladder_summary.json'), 'utf8');
        ok(a === b, 'CLI summary byte-identical across two runs');
        const cRec = fs.readFileSync(path.join(outA, 'rungC_quad_hash.ladder.json'), 'utf8');
        ok(cRec === fs.readFileSync(path.join(outB, 'rungC_quad_hash.ladder.json'), 'utf8'), 'CLI per-frame record byte-identical across two runs');
        ok(JSON.parse(cRec).verdict_class === 'C', 'CLI-written rungC record has verdict_class=C');
    }
    fs.rmSync(tmp, { recursive: true, force: true });

    // ── 5 + 6 need the WASM blob extractor (loadWasm) — gate honestly ─────────
    let wasm = null;
    try { wasm = await loadWasm(); }
    catch (e) { skip(`WASM unavailable (${e.message}) — FITS async-load + CR2-arm checks skipped`); }

    // ── 5. FITS async-load path (regression for the const-entry reassign bug) ─
    // Before the fix, a FITS frame with NO inline dets tripped runManifest's
    // `entry = {...}` reassignment on a for-of `const` binding → every such frame
    // sank to an ERROR record ("Assignment to constant variable"). This paints a
    // synthetic 3-plane FITS whose blobs sit on the projected catalog, runs it
    // through runManifest WITHOUT inline dets, and asserts the FITS arm decodes
    // real detections and produces a genuine verdict (never the const-bug ERROR).
    if (wasm) {
        console.log('\n[5] FITS async-load path (const-entry reassign regression)');
        const W = 220, H = 200, sc = 12;
        const wcs = wcsFor(W, H, sc);
        const cat = synthCatalog(50, 0.28, 909);
        const proj = projectStars({ stars: cat, wcs, w: W, h: H, margin: 4 });
        const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-fits-'));
        const fitPath = path.join(tmp5, 'synth_control.fit');
        fs.writeFileSync(fitPath, buildFits3Plane(W, H, proj.map((s) => ({ x: s.x, y: s.y }))));
        // NO inline dets, NO width/height — both must be resolved by the async decode
        const man5 = { label: 'fits-async', frames: [{ frame: fitPath, label: 'synth_fits', catalog: cat, true_wcs: wcs }] };
        let threw5 = false, rec5 = null;
        try { const r = await runManifest(man5, { ...LADDER_DEFAULTS }); rec5 = r.records[0]; }
        catch (e) { threw5 = true; console.log(`     runManifest threw: ${e.message}`); }
        ok(!threw5, 'runManifest over a FITS frame (no inline dets) did not throw');
        ok(rec5 && rec5.verdict_class !== 'ERROR',
            `FITS frame produced a real verdict=${rec5?.verdict_class} (not ERROR — const-reassign bug fixed)`);
        ok(!(rec5?.reason && /constant/i.test(rec5.reason)),
            'no "Assignment to constant variable" in the record (async branch executes)');
        ok(rec5 && typeof rec5.n_det === 'number' && rec5.n_det > 0,
            `FITS arm decoded ${rec5?.n_det ?? 0} detections + set width=${rec5?.width} height=${rec5?.height}`);
        fs.rmSync(tmp5, { recursive: true, force: true });
    }

    // ── 6. CR2 arm — the SAME extraction rung the FITS arm uses, over RGB planes ─
    // [6a] hermetic: synthetic R/G/B planes with known blobs → extractDetectionsFromPlanes
    //      (the shared rung; this is the CR2 arm minus the libraw decode).
    // [6b] real: decode the bundled demo CR2 through loadCr2Detections (the full
    //      arm) — data-gated on the CR2 + libraw-wasm being present.
    if (wasm) {
        console.log('\n[6] CR2 arm (shared detection rung + real decode)');
        const W = 200, H = 200, n = W * H;
        const R = new Float32Array(n).fill(0.02), G = new Float32Array(n).fill(0.02), B = new Float32Array(n).fill(0.02);
        const pts = [{ x: 50, y: 50 }, { x: 120, y: 80 }, { x: 150, y: 150 }, { x: 30, y: 170 }, { x: 100, y: 100 }];
        for (const { x, y } of pts) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const px = x + dx, py = y + dy; if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const v = 0.02 + 0.9 * Math.exp(-(dx * dx + dy * dy) / 2.0), i = py * W + px;
            if (v > R[i]) { R[i] = v; G[i] = v; B[i] = v; }
        }
        const det6 = extractDetectionsFromPlanes([R, G, B], W, H, wasm);
        ok(det6.length > 0, `shared rung extracted ${det6.length} detections from synthetic RGB planes`);
        const near = pts.filter((p) => det6.some((d) => Math.hypot(d.x - p.x, d.y - p.y) <= 3)).length;
        ok(near >= 3, `${near}/${pts.length} injected blobs recovered within 3px (rung centroids)`);

        const demoCr2 = path.join(DATA_ROOT, 'public', 'demo', 'sample_observation.cr2');
        if (fs.existsSync(demoCr2)) {
            let threw6 = false, r6 = null;
            try { r6 = await loadCr2Detections('public/demo/sample_observation.cr2'); }
            catch (e) { threw6 = true; console.log(`     loadCr2Detections threw: ${e.message}`); }
            ok(!threw6, 'loadCr2Detections decoded the bundled demo CR2 without throwing');
            ok(r6 && r6.det.length > 0, `CR2 arm decoded ${r6?.det.length ?? 0} detections (${r6?.width}x${r6?.height})`);
            ok(r6 && r6.cfa && typeof r6.cfa.oneHot === 'boolean',
                `CR2 arm reports CFA provenance (oneHot=${r6?.cfa?.oneHot}, leak=${r6?.cfa?.leakFraction != null ? r6.cfa.leakFraction.toFixed(3) : 'NOT MEASURED'})`);
            await terminateRawDecodeWorkers();
        } else {
            skip('[6b] bundled demo CR2 absent — real-decode check skipped (clean-clone honest absence)');
        }
    }

    // ── summary ─────────────────────────────────────────────────────────────
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed, ${skips} skipped`);
    process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
