// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — BRIGHT-STAR CENSUS on the M66 SeeStar frame (banked data only)
// ═══════════════════════════════════════════════════════════════════════════
// Question (owner): the mesh overlay shows many BRIGHT stars with no marker.
// Separate three explanations with numbers — saturation-culled vs simply-not-in-
// the-drawn-population vs truly-missed. For every g15u catalog star in-frame we
// classify against BANKED products:
//   MATCHED   : in the solve's matched_stars (receipt.solution.matched_stars)
//   DETECTED  : a KEPT detection (receipt.signal.clean_stars) sits at its position
//   CULLED    : a culled detection sits there — DEDUP (receipt.signal.anomalies,
//               positions banked) or SATURATED (flat-topped blob present, no kept
//               centroid → the CIRCULARITY/dedup path; culling_tally counts only)
//   MESH-MARKED : id ∈ the mesh overlay's 1146 crosses (M66_mesh_matches.json)
//   ABSENT    : nothing there — measured forced flux + peak both null
// Saturation is assessed in the banked NORMALIZED-luminance buffer (0..ceiling),
// NOT raw ADU (raw FITS not re-decoded here) — ceiling measured, reported.
//
// Reuses the mesh machinery verbatim: g15u regionStars + the same linear-WCS
// projection run_mesh.mjs uses. NO live solve, NO engine writes.

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, forcedMeasure } from '../psf/forced_detect.mjs';
import { makeStretch, downscaleRGB, plotPoint, writePNG } from '../psf/imaging.mjs';

const D2R = Math.PI / 180;
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const META = argVal('--meta', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json');
const BUFFER = argVal('--buffer', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32');
const RECEIPT = argVal('--receipt', 'test_results/e2e/seestar_2026-07-22T07-32-00-667Z/receipt.json');
const MESH = argVal('--mesh', 'D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/M66_mesh_matches.json');
const STARS_ARROW = argVal('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
const OUT_DIR = argVal('--out-dir', 'D:/AstroLogic/test_artifacts/bright_census_2026-07-22');
const TOL = parseFloat(argVal('--tol', '6'));     // px join tolerance (distortion-aware)
const MAG_LIMIT = 15;

function frameConeRadiusDeg(cd, w, h) {
    const hd = Math.hypot((w - 1) / 2, (h - 1) / 2);
    const scaleDeg = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]));
    return Math.min(89, Math.atan(hd * scaleDeg * D2R) / D2R + 2);
}

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    const W = meta.width, H = meta.height;
    const wcs = meta.wcs;
    const crval = [wcs.CRVAL1, wcs.CRVAL2], crpix = [wcs.CRPIX1, wcs.CRPIX2];
    const cd = [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    const scaleArcsec = Math.sqrt(Math.abs(det)) * 3600;
    const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
    const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

    // ── buffer (normalized luminance) ──
    const b = fs.readFileSync(BUFFER);
    const L = new Float32Array(b.buffer, b.byteOffset, W * H);
    let ceil = -Infinity; for (let i = 0; i < L.length; i++) if (L[i] > ceil) ceil = L[i];
    const SAT = 0.75 * ceil; // plateau threshold (unsaturated stars peak well below; measured below)

    // ── receipt products ──
    const rc = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
    const clean = rc.signal.clean_stars;            // KEPT detections
    const matched = rc.solution.matched_stars;      // solve matches (subset of clean)
    const anomalies = rc.signal.anomalies || [];    // DEDUP-culled detections (positions banked)
    const cullTally = rc.signal.culling_tally || {};

    // ── mesh overlay set (1146) keyed by EXACT arrow id ──
    const meshRows = JSON.parse(fs.readFileSync(MESH, 'utf8')).matches;
    const meshById = new Map(meshRows.map((m) => [m.id, m.source]));

    // ── g15u catalog in-frame (same path as run_mesh) ──
    const coneR = frameConeRadiusDeg(cd, W, H);
    const g15 = regionStars({ starsArrowPath: STARS_ARROW, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit: MAG_LIMIT });
    const cat = [];
    for (const s of g15) {
        const p = tanForward(s.ra_deg, s.dec_deg, crval[0], crval[1]); if (!p) continue;
        const x = crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det;
        const y = crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det;
        if (x < -40 || y < -40 || x >= W + 40 || y >= H + 40) continue;
        cat.push({ id: s.gaia_id, mag: s.mag, px: x, py: y });
    }

    // ── spatial grid over clean / matched / anomaly positions for fast nearest ──
    const CELL = 32;
    const gridOf = (pts) => { const m = new Map(); pts.forEach((p, i) => { const k = (Math.floor(p.x / CELL)) * 100003 + Math.floor(p.y / CELL); let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(i); }); return m; };
    const cleanG = gridOf(clean), matchG = gridOf(matched), anomG = gridOf(anomalies);
    const nearest = (pts, grid, x, y) => {
        const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); let bi = -1, bd = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = grid.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const d = Math.hypot(pts[i].x - x, pts[i].y - y); if (d < bd) { bd = d; bi = i; } } }
        return { i: bi, d: bd };
    };

    // saturation / peak helpers
    const peakAt = (x, y, r = 2) => { const X = Math.round(x), Y = Math.round(y); let p = -Infinity, n = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = X + dx, yy = Y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const v = L[yy * W + xx]; if (v > p) p = v; n++; } return n ? p : null; };
    const flatTop = (x, y, peak) => { const X = Math.round(x), Y = Math.round(y); let n = 0; const thr = 0.95 * peak; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = X + dx, yy = Y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; if (L[yy * W + xx] >= thr) n++; } return n; };

    const fwhm = meta.mean_fwhm_px || 3;
    const rows = [];
    for (const c of cat) {
        const offFrame = c.px < 4 || c.py < 4 || c.px >= W - 4 || c.py >= H - 4;
        const mNear = nearest(matched, matchG, c.px, c.py);
        const cNear = nearest(clean, cleanG, c.px, c.py);
        const aNear = nearest(anomalies, anomG, c.px, c.py);
        const isMatched = mNear.d <= TOL;
        const isDetected = cNear.d <= TOL;         // KEPT detection near
        const isDedup = !isDetected && aNear.d <= TOL;
        const meshSource = meshById.get(c.id) || null; // 'seed' | 'mesh' | null
        const isMesh = meshSource != null;

        // measurement position: prefer the actual detection centroid
        const mx = isMatched ? matched[mNear.i].x : isDetected ? clean[cNear.i].x : isDedup ? anomalies[aNear.i].x : c.px;
        const my = isMatched ? matched[mNear.i].y : isDetected ? clean[cNear.i].y : isDedup ? anomalies[aNear.i].y : c.py;
        const peak = offFrame ? null : peakAt(mx, my, 2);
        const nflat = (peak != null && peak >= 0.5) ? flatTop(mx, my, peak) : 0;
        const saturated = peak != null && peak >= SAT && nflat >= 8; // plateau, not a sharp peak
        // forced flux presence (independent of detection list)
        let fSnr = null, fAcc = false;
        if (!offFrame) {
            const fm = forcedMeasure({ L, w: W, h: H, positions: [{ x: mx, y: my, mag: c.mag, gaia_id: c.id }], fwhmPx: fwhm, posRmsPx: 2, snrThreshold: 5, sigmaPix: null });
            if (fm.results[0]) { fSnr = fm.results[0].snr; fAcc = fm.results[0].accepted; }
        }

        // single-label class (priority)
        let klass;
        if (offFrame) klass = 'OFF_FRAME';
        else if (isMatched) klass = 'MATCHED';
        else if (isDetected) klass = 'DETECTED_UNMATCHED';
        else if (isDedup) klass = 'CULLED_DEDUP';
        else if (saturated) klass = 'CULLED_SATURATED';
        else if (fAcc) klass = 'PRESENT_UNMARKED';
        else klass = 'ABSENT';

        rows.push({ id: c.id, mag: c.mag, px: +c.px.toFixed(1), py: +c.py.toFixed(1), mx: +mx.toFixed(1), my: +my.toFixed(1), r_norm: +rNorm(c.px, c.py).toFixed(3), matched: isMatched, detected: isDetected, dedup: isDedup, mesh: isMesh, mesh_source: meshSource, peak: peak == null ? null : +peak.toFixed(4), nflat, saturated, forced_snr: fSnr == null ? null : +fSnr.toFixed(1), forced_accepted: fAcc, klass });
    }

    // ── bin by G-mag ──
    const bins = [
        { name: '<=9', lo: -Infinity, hi: 9 },
        { name: '9-11', lo: 9, hi: 11 },
        { name: '11-13', lo: 11, hi: 13 },
        { name: '13-15', lo: 13, hi: 15 },
    ];
    const table = bins.map((bn) => {
        const rs = rows.filter((r) => r.mag > bn.lo && r.mag <= bn.hi);
        const n = rs.length;
        const cnt = (f) => rs.filter(f).length;
        return {
            bin: bn.name, catalog: n,
            off_frame: cnt((r) => r.klass === 'OFF_FRAME'),
            detected: cnt((r) => r.detected),
            matched: cnt((r) => r.matched),
            mesh_marked: cnt((r) => r.mesh),
            culled_dedup: cnt((r) => r.klass === 'CULLED_DEDUP'),
            culled_saturated: cnt((r) => r.klass === 'CULLED_SATURATED'),
            present_unmarked: cnt((r) => r.klass === 'PRESENT_UNMARKED'),
            absent: cnt((r) => r.klass === 'ABSENT'),
        };
    });

    // cumulative bright subsets (the owner's "bright stars")
    const bright = (cut) => {
        const rs = rows.filter((r) => r.mag <= cut && r.klass !== 'OFF_FRAME');
        const cnt = (f) => rs.filter(f).length;
        const unmarked = rs.filter((r) => !r.mesh);
        const cntU = (f) => unmarked.filter(f).length;
        return {
            cut, catalog_on_frame: rs.length,
            mesh_marked: cnt((r) => r.mesh), matched: cnt((r) => r.matched), detected: cnt((r) => r.detected),
            unmarked_total: unmarked.length,
            unmarked_saturated_culled: cntU((r) => r.klass === 'CULLED_SATURATED'),
            unmarked_dedup_culled: cntU((r) => r.klass === 'CULLED_DEDUP'),
            unmarked_detected_notmesh: cntU((r) => r.detected),           // present, in solve detection list, mesh didn't draw
            unmarked_present_notmesh: cntU((r) => r.klass === 'PRESENT_UNMARKED'),
            unmarked_absent: cntU((r) => r.klass === 'ABSENT'),
        };
    };

    // peak-vs-mag (justifies the saturation threshold) — median peak per 1-mag bin
    const peakByMag = [];
    for (let m = 4; m <= 14; m++) { const ps = rows.filter((r) => r.peak != null && r.mag > m && r.mag <= m + 1).map((r) => r.peak).sort((a, x) => a - x); if (ps.length) peakByMag.push({ mag: `${m}-${m + 1}`, n: ps.length, median_peak: +ps[ps.length >> 1].toFixed(4), max_peak: +ps[ps.length - 1].toFixed(4) }); }

    // ── overlay PNG: mark G<=11 by class ──
    const outW = 1080; const st = makeStretch([L]); st.lo = [st.lo[0], st.lo[0], st.lo[0]]; st.hi = [st.hi[0], st.hi[0], st.hi[0]];
    const ds = downscaleRGB(L, L, L, W, H, outW, st); const sc = ds.scale;
    const COLORS = { MATCHED: [60, 230, 90], DETECTED_UNMATCHED: [255, 235, 40], CULLED_DEDUP: [255, 140, 0], CULLED_SATURATED: [255, 40, 40], PRESENT_UNMARKED: [255, 90, 210], ABSENT: [180, 60, 255], OFF_FRAME: [120, 120, 120] };
    const drawCircle = (bytes, ow, oh, x, y, rgb, rad) => { for (let a = 0; a < 360; a += 12) { const rx = x + rad * Math.cos(a * D2R), ry = y + rad * Math.sin(a * D2R); plotPoint(bytes, ow, oh, rx, ry, rgb, 0.95); plotPoint(bytes, ow, oh, rx + 1, ry, rgb, 0.8); } };
    for (const r of rows) { if (r.mag > 11) continue; const rgb = COLORS[r.klass] || [255, 255, 255]; const rad = r.mag <= 7 ? 9 : r.mag <= 9 ? 7 : 5; drawCircle(ds.bytes, ds.ow, ds.oh, r.mx * sc, r.my * sc, rgb, rad); }
    const pngPath = path.join(OUT_DIR, 'M66_bright_census_overlay.png');
    writePNG(pngPath, ds.bytes, ds.ow, ds.oh);

    const summary = {
        frame: 'M66', generated: new Date().toISOString(), lane: 'tools/mesh bright_census (LAW-4 incubator, banked-data-only)',
        inputs: { meta: META, buffer: BUFFER, receipt: RECEIPT, mesh: MESH, stars_arrow: STARS_ARROW },
        image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), buffer_ceiling_normalized: +ceil.toFixed(6), saturation_threshold_used: +SAT.toFixed(4), sat_note: 'normalized-luminance buffer, NOT raw ADU; ceiling is the brightest-star plateau; saturated = peak>=0.75*ceiling AND >=8 flat-top px' },
        catalog_in_frame: cat.length, detection_totals: { clean_kept: clean.length, matched: matched.length, dedup_anomalies: anomalies.length, culling_tally: cullTally }, mesh_marked_total: meshRows.length,
        join_tol_px: TOL,
        table_by_magbin: table,
        bright_subset: { 'G<=9': bright(9), 'G<=11': bright(11) },
        peak_vs_mag_median: peakByMag,
        overlay_png: pngPath,
        legend: 'circles G<=11: green=matched  yellow=detected-not-matched  orange=dedup-culled  red=saturated-culled  pink=present-unmarked  purple=absent',
    };
    fs.writeFileSync(path.join(OUT_DIR, 'M66_bright_census.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'M66_bright_census_rows.json'), JSON.stringify({ rows }, null, 2));

    // console report
    console.log(`[M66] catalog in-frame ${cat.length} (G<${MAG_LIMIT}); ceiling ${ceil.toFixed(4)} SAT>=${SAT.toFixed(3)}`);
    console.log(`  detection: ${clean.length} kept, ${matched.length} matched, ${anomalies.length} dedup-anom; cull ${JSON.stringify(cullTally)}; mesh-marked ${meshRows.length}`);
    console.log('  peak-vs-mag (median|max):', peakByMag.map((p) => `${p.mag}:${p.median_peak}|${p.max_peak}`).join('  '));
    console.log('\n  TABLE by G-mag bin:');
    console.log('  bin      cat  det  match mesh  dedupC satC  presU abs  off');
    for (const t of table) console.log(`  ${t.bin.padEnd(7)} ${String(t.catalog).padStart(4)} ${String(t.detected).padStart(4)} ${String(t.matched).padStart(5)} ${String(t.mesh_marked).padStart(4)} ${String(t.culled_dedup).padStart(6)} ${String(t.culled_saturated).padStart(4)} ${String(t.present_unmarked).padStart(5)} ${String(t.absent).padStart(4)} ${String(t.off_frame).padStart(4)}`);
    for (const cut of [9, 11]) { const bsub = bright(cut); console.log(`\n  BRIGHT G<=${cut} (on-frame ${bsub.catalog_on_frame}): mesh-marked ${bsub.mesh_marked}, matched ${bsub.matched}, detected ${bsub.detected}`); console.log(`    UNMARKED ${bsub.unmarked_total}: satCulled ${bsub.unmarked_saturated_culled}, dedupCulled ${bsub.unmarked_dedup_culled}, detected-not-drawn ${bsub.unmarked_detected_notmesh}, present-not-drawn ${bsub.unmarked_present_notmesh}, absent ${bsub.unmarked_absent}`); }
    console.log(`\n  overlay -> ${pngPath}`);
    console.log(`  summary -> ${path.join(OUT_DIR, 'M66_bright_census.json')}`);
}
main();
