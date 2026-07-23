// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — mesh leg-B: forced-photometry harvest + Rokinon known-answer test
// ═══════════════════════════════════════════════════════════════════════════
// SHADOW incubator (LAW-4, tools/ only). Banked greenfield poses only; nothing
// feeds a solve. Every derived threshold is PROVISIONAL and labeled.
//
// MEASURED REALITY (galactic-plane 14mm frames): g15u (Gaia G<15) projects
// ~10^5-10^6 stars in-frame at 62"/px; mean nearest-neighbour spacing (~2-3 px)
// approaches the FWHM and the chance-match radius, so the field is CONFUSION-
// LIMITED: nearest-neighbour cross-matching and tight forced photometry cannot
// isolate individual faint stars. The anchor is therefore built on BRIGHT
// (sparse) stars where a coincidence is far above chance, and the faint forced
// harvest is reported against an ISOLATION criterion so the confusion limit is
// measured, not laundered into a fake depth extension.
//
// PIPELINE:
//   1. Adapter: receipt object-WCS {crval{ra,dec},crpix{x,y},cd} -> array-form
//      astrometry JSON (refit_distortion/corrections consume it). crval DEGREES.
//   2. Catalog = g15u stars.arrow (regionStars) — PURE Gaia DEGREES.
//   3. Anchor: project bright g15u (projectStars — CD encodes parity, NO hand-
//      flip), cross-match to bright detections by proximity; the CORRECT
//      orientation yields significantly more coincidences than a y-FLIPPED
//      projection and than chance -> pose reproduced. Confusion metrics + coarse
//      scatter reported. Receipt matches keyed BY .id (det_id = detection.id).
//   4. Harvest: g15u in (floor, floor+2]; floor = detection-equivalent depth
//      (PROVISIONAL). forced_detect.forcedMeasure at predicted positions; report
//      isolated-subset recovery vs full-band recovery -> the confusion limit.
//   5. Profile: refit_distortion.mjs driven SEPARATELY via the astrometry JSON +
//      PSF2 cache this writes; plus a supplement k1 (fitRadialOdd) on flux-
//      weighted centroids of ISOLATED harvest stars (even/odd holdout).
//
// REUSE: projectStars/forcedMeasure/angSepDeg (forced_detect); decodeCR2/detect
//   Pattern/demosaicBilinear/splitRGB (decode_cr2); fitRadialOdd (solution_to_
//   astrometry); regionStars/loadG15uTable (g15u_stars, new loader). WRITTEN:
//   adapter, confusion/bright-anchor, L<->det reconcile, harvest orchestration,
//   centroid, PSF2 cache writer, report.

import fs from 'node:fs';
import path from 'node:path';

import { projectStars, forcedMeasure } from './forced_detect.mjs';
import { decodeCR2, terminateDecodeWorkers, detectPattern, demosaicBilinear, splitRGB } from './decode_cr2.mjs';
import { fitRadialOdd } from './solution_to_astrometry.mjs';
import { regionStars } from './g15u_stars.mjs';

const D2R = Math.PI / 180;
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const hasFlag = (k) => args.includes(k);
const STARS_ARROW = argVal('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');

function receiptToAstrometry(receipt, w, h) {
    const s = receipt.decision.result.solved;
    return {
        wcs: { crpix: [s.wcs.crpix.x, s.wcs.crpix.y], crval: [s.wcs.crval.ra, s.wcs.crval.dec], cd: s.wcs.cd },
        distortion: { model: 'none', k1: 0, k2: 0 },
        provenance: { image_dims: [w, h], source: 'greenfield m6 receipt', scale_arcsec_px: s.scale_arcsec_px, parity_sign: s.parity_sign },
    };
}
function frameConeRadiusDeg(wcs, w, h) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy);
    const scaleDeg = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0]));
    return Math.min(89, Math.atan(hd * scaleDeg * D2R) / D2R + 2);
}
function buildGrid(pts, cell) {
    const map = new Map();
    for (let i = 0; i < pts.length; i++) { const k = (pts[i].x / cell | 0) * 100003 + (pts[i].y / cell | 0); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); }
    return { map, cell, pts };
}
function nearest(grid, x, y, radius) {
    const { map, cell, pts } = grid; const reach = Math.ceil(radius / cell); const gx = x / cell | 0, gy = y / cell | 0;
    let best = -1, bd = radius * radius;
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue;
        for (const pi of a) { const d2 = (pts[pi].x - x) ** 2 + (pts[pi].y - y) ** 2; if (d2 < bd) { bd = d2; best = pi; } }
    }
    return { idx: best, dist: best >= 0 ? Math.sqrt(bd) : Infinity };
}
function countWithin(grid, x, y, radius, excludeSelf = true) {
    const { map, cell, pts } = grid; const reach = Math.ceil(radius / cell); const gx = x / cell | 0, gy = y / cell | 0; const r2 = radius * radius;
    let n = 0;
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue;
        for (const pi of a) { const d2 = (pts[pi].x - x) ** 2 + (pts[pi].y - y) ** 2; if (d2 <= r2) { if (excludeSelf && d2 < 1e-9) continue; n++; } }
    }
    return n;
}
const rmsOf = (vs) => Math.sqrt(vs.reduce((s, v) => s + v * v, 0) / Math.max(1, vs.length));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function percentile(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; }

function fluxCentroid(L, w, h, cx, cy, bg, sigma, R = 6) {
    let sw = 0, sx = 0, sy = 0; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let dy = -R; dy <= R; dy++) { const Y = y0 + dy; if (Y < 1 || Y >= h - 1) continue; for (let dx = -R; dx <= R; dx++) { const X = x0 + dx; if (X < 1 || X >= w - 1) continue; const t = L[Y * w + X] - bg; if (t > 1.5 * sigma) { sw += t; sx += t * X; sy += t * Y; } } }
    return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}
function localBg(L, w, h, cx, cy) {
    const vals = []; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let r = 8; r <= 12; r += 2) for (let t = -r; t <= r; t += 2) for (const [X, Y] of [[x0 + t, y0 - r], [x0 + t, y0 + r], [x0 - r, y0 + t], [x0 + r, y0 + t]]) if (X >= 0 && Y >= 0 && X < w && Y < h) vals.push(L[Y * w + X]);
    if (vals.length < 8) return null; vals.sort((a, b) => a - b); return vals[vals.length >> 1];
}
function pixelNoiseSigma(L, maxN = 200000) {
    const step = Math.max(1, Math.floor(L.length / maxN)); const d = [];
    for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i]));
    d.sort((a, b) => a - b); return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2);
}
// physically flip an interleaved RGB16 buffer (so the CFA cache lands in the
// WCS/detection frame under IDENTITY — refit_distortion has no flip option).
function applyFlipRGB(buf, w, h, flip) {
    if (flip === 'identity') return buf;
    const out = new Uint16Array(buf.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const X = (flip === 'xflip' || flip === 'rot180') ? (w - 1 - x) : x;
        const Y = (flip === 'yflip' || flip === 'rot180') ? (h - 1 - y) : y;
        const s = (y * w + x) * 3, dxi = (Y * w + X) * 3;
        out[dxi] = buf[s]; out[dxi + 1] = buf[s + 1]; out[dxi + 2] = buf[s + 2];
    }
    return out;
}
function luminance709(rgb16, w, h) {
    const layout = detectPattern(rgb16, w, h);
    const chans = layout.oneHot ? demosaicBilinear(rgb16, w, h, layout.pat) : splitRGB(rgb16, w, h);
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = 0.2126 * chans[0][i] + 0.7152 * chans[1][i] + 0.0722 * chans[2][i];
    return L;
}

async function main() {
    const FRAME = argVal('--frame', 'IMG_1410');
    const RECEIPT = argVal('--receipt', null), DETECTIONS = argVal('--detections', null), CR2 = argVal('--cr2', null);
    const W = parseInt(argVal('--w', '5202'), 10), H = parseInt(argVal('--h', '3465'), 10);
    const OUT_DIR = argVal('--out-dir', 'D:/AstroLogic/test_artifacts/greenfield_solver/mesh_legB');
    const ANCHOR_ONLY = hasFlag('--anchor-only'), HARVEST_CAP = parseInt(argVal('--cap', '500'), 10);
    if (!RECEIPT || !DETECTIONS) { console.error('need --receipt and --detections'); return 1; }
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const t0 = Date.now();
    const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
    const astro = receiptToAstrometry(receipt, W, H);
    const wcs = astro.wcs, solved = receipt.decision.result.solved;
    fs.writeFileSync(path.join(OUT_DIR, `${FRAME}.astrometry.json`), JSON.stringify(astro, null, 2));
    const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
    const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

    // detections indexed BY .id (NOT array index — verified trap)
    const detDoc = JSON.parse(fs.readFileSync(DETECTIONS, 'utf8'));
    const detArr = Array.isArray(detDoc) ? detDoc : (detDoc.detections || detDoc.stars || detDoc.sources || []);
    const detById = new Map(detArr.map((d) => [d.id, d]));
    const detPts = detArr.map((d) => ({ x: d.x, y: d.y, id: d.id, flux: d.flux, snr: d.snr }));
    const detGrid = buildGrid(detPts, 64);

    // ── project ALL in-frame g15u once (G<15) ──
    const coneR = frameConeRadiusDeg(wcs, W, H);
    const allStars = regionStars({ starsArrowPath: STARS_ARROW, raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg: coneR, magLimit: 15 });
    const allProj = projectStars({ stars: allStars, wcs, w: W, h: H, margin: 0 });
    const densPerPx = allProj.length / (W * H);
    const meanSpacingPx = 0.5 / Math.sqrt(densPerPx);
    const gAsc = allProj.map((s) => s.mag).sort((a, b) => a - b);
    const equivDepthG = gAsc[Math.min(gAsc.length - 1, detArr.length - 1)]; // G at cumulative count == n detections
    const allGrid = buildGrid(allProj.map((s) => ({ x: s.x, y: s.y })), 8);

    // ── BRIGHT-STAR ANCHOR (confusion-robust): correct vs y-flipped vs chance ──
    const brightDet = [...detPts].sort((a, b) => b.flux - a.flux).slice(0, 1500);
    const RAD = 15; // pose scatter ~ a few px on top of the coarse linear solve
    function orientStats(magLim, flip) {
        const set = allProj.filter((s) => s.mag <= magLim).map((s) => ({ x: s.x, y: flip ? (H - 1) - s.y : s.y }));
        const g = buildGrid(set, 64); let matched = 0, sumSep = 0;
        for (const d of brightDet) { const q = nearest(g, d.x, d.y, RAD); if (q.idx >= 0) { matched++; sumSep += q.dist; } }
        const dens = set.length / (W * H); const chancePerStar = 1 - Math.exp(-dens * Math.PI * RAD * RAD);
        return { in_frame: set.length, matched, avg_sep_px: matched ? +(sumSep / matched).toFixed(2) : null, expected_by_chance: +(chancePerStar * brightDet.length).toFixed(0) };
    }
    const anchorMag = parseFloat(argVal('--anchor-mag', '7'));
    const correct = orientStats(anchorMag, false), flipped = orientStats(anchorMag, true);
    const excessCorrect = correct.matched - correct.expected_by_chance;
    const excessFlipped = flipped.matched - flipped.expected_by_chance;
    const sigChance = Math.max(5, Math.sqrt(correct.expected_by_chance));
    // matched population for the floor cross-check: bright catalog with a bright detection within RAD
    const brightGrid = buildGrid(brightDet, 64);
    const brightMatchedG = allProj.filter((s) => s.mag <= anchorMag && nearest(brightGrid, s.x, s.y, RAD).idx >= 0).map((s) => s.mag);
    const floorBrightG90 = percentile(brightMatchedG, 0.90);

    // receipt near-center residuals (coarse-solve quality, keyed by .id)
    const recNear = solved.matches.map((m) => { const d = detById.get(m.det_id); return d ? { rn: rNorm(d.x, d.y), rx: m.residual_x, ry: m.residual_y } : null; }).filter((r) => r && r.rn < 0.15);
    const recNearRms = rmsOf(recNear.flatMap((r) => [r.rx, r.ry]));
    const recAllRms = rmsOf(solved.matches.flatMap((m) => [m.residual_x, m.residual_y]));

    // correct orientation must exceed chance by >3σ AND beat the y-flipped excess by >3σ
    const posePass = excessCorrect > 3 * sigChance && (excessCorrect - excessFlipped) > 3 * sigChance;
    const floor = equivDepthG; // PROVISIONAL primary floor
    const anchor = {
        frame: FRAME, cone_radius_deg: +coneR.toFixed(2),
        confusion: {
            in_frame_g15u: allProj.length, density_per_px2: +densPerPx.toExponential(3), mean_spacing_px: +meanSpacingPx.toFixed(2),
            detections: detArr.length, catalog_over_detection_ratio: +(allProj.length / detArr.length).toFixed(1),
            note: 'mean_spacing_px approaching FWHM/chance-radius = CONFUSION-LIMITED; nearest-neighbour cross-match and tight forced photometry cannot isolate faint stars here.',
        },
        bright_anchor: {
            anchor_mag_limit: anchorMag, bright_detections_probed: brightDet.length, match_radius_px: RAD,
            correct_orientation: correct, y_flipped_orientation: flipped,
            excess_over_chance_correct: excessCorrect, excess_over_chance_flipped: excessFlipped,
            correct_excess_sigma: +(excessCorrect / sigChance).toFixed(1), correct_minus_flipped_sigma: +((excessCorrect - excessFlipped) / sigChance).toFixed(1),
            VERDICT: posePass ? 'POSE_REPRODUCED' : 'INCONCLUSIVE',
            note: 'PASS = correct-orientation coincidences exceed chance by >3σ AND exceed the y-flipped count by >30% -> adapter+projectStars reproduce the pose (no flip, correct crval/CD). avg_sep_px = coarse-solve position scatter.',
        },
        receipt_solve_quality: { near_center_matches: recNear.length, near_center_residual_rms_px: +recNearRms.toFixed(2), all_match_residual_rms_px: +recAllRms.toFixed(2), note: 'the greenfield linear solve is coarse (~several px RMS, ~flat vs radius); this is solve quality, not projection error.' },
        floor_provisional: { detection_equivalent_depth_G: +equivDepthG.toFixed(2), bright_matched_G90: floorBrightG90 != null ? +floorBrightG90.toFixed(2) : null, used_floor_G: +floor.toFixed(2), note: 'detection-equivalent depth = G at which cumulative in-frame g15u count equals the detection count. PROVISIONAL.' },
    };
    console.log(`[${FRAME}] confusion: ${allProj.length} g15u in-frame, spacing ${meanSpacingPx.toFixed(2)}px, ${(allProj.length / detArr.length).toFixed(0)}x detections`);
    console.log(`[${FRAME}] bright-anchor G<=${anchorMag}: correct ${correct.matched} (chance ${correct.expected_by_chance}, avgSep ${correct.avg_sep_px}px) vs flipped ${flipped.matched} -> ${anchor.bright_anchor.VERDICT}`);
    console.log(`[${FRAME}] floor(equiv-depth) G ${equivDepthG.toFixed(2)}; receipt near-ctr RMS ${recNearRms.toFixed(1)}px all ${recAllRms.toFixed(1)}px`);
    fs.writeFileSync(path.join(OUT_DIR, `${FRAME}.anchor.json`), JSON.stringify(anchor, null, 2));
    if (ANCHOR_ONLY) { console.log(`[${FRAME}] anchor-only ${((Date.now() - t0) / 1000).toFixed(1)}s`); return 0; }

    // ── decode -> L ──
    console.log(`[${FRAME}] decoding ${CR2} (libraw)…`);
    const tDec = Date.now();
    const dec = await decodeCR2(CR2); let wDec = dec.w, hDec = dec.h, rgb16 = dec.rgb16;
    // TRANSPOSE trap: some frames (e.g. IMG_1757) decode PORTRAIT while the WCS/
    // detections live in the transposed LANDSCAPE frame (m6_config "oracle
    // orientation transposed"). Transpose the CFA mosaic to the receipt frame so
    // the L buffer + refit cache align with the WCS. Bayer parity is preserved
    // under transpose (G-diagonal -> G-diagonal); detectPattern re-votes.
    let transposed = false;
    if (wDec !== W && Math.abs(hDec - W) <= 3 && Math.abs(wDec - H) <= 3) {
        const out = new Uint16Array(wDec * hDec * 3);
        for (let r = 0; r < hDec; r++) for (let c = 0; c < wDec; c++) { const src = (r * wDec + c) * 3, dst = (c * hDec + r) * 3; out[dst] = rgb16[src]; out[dst + 1] = rgb16[src + 1]; out[dst + 2] = rgb16[src + 2]; }
        rgb16 = out; const nw = hDec, nh = wDec; wDec = nw; hDec = nh; transposed = true;
    }
    console.log(`[${FRAME}] decoded ${dec.w}x${dec.h}${transposed ? ` -> transposed to ${wDec}x${hDec}` : ''} (receipt ${W}x${H}) ${((Date.now() - tDec) / 1000).toFixed(1)}s`);
    // ── reconcile decode-buffer <-> detection/WCS frame (bright-flux alignment) ──
    // Probe which flip lands the decoded bright pixels on the bright detections,
    // then PHYSICALLY apply that flip so the buffer (and its refit cache) sit in
    // the WCS frame under identity. Positions downstream need no transform.
    let L = luminance709(rgb16, wDec, hDec);
    const brightDetForRecon = [...detPts].sort((a, b) => b.flux - a.flux).slice(0, 300);
    const sample3 = (buf, x, y) => { const X = Math.round(x), Y = Math.round(y); let m = -Infinity; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = X + dx, yy = Y + dy; if (xx >= 0 && yy >= 0 && xx < wDec && yy < hDec) { const v = buf[yy * wDec + xx]; if (v > m) m = v; } } return m === -Infinity ? 0 : m; };
    const flipMap = { identity: (x, y) => [x, y], yflip: (x, y) => [x, (hDec - 1) - y], xflip: (x, y) => [(wDec - 1) - x, y], rot180: (x, y) => [(wDec - 1) - x, (hDec - 1) - y] };
    let bestFlip = 'identity', bestScore = -Infinity; const tScores = {};
    for (const [nm, fn] of Object.entries(flipMap)) { let s = 0; for (const d of brightDetForRecon) { const [x, y] = fn(d.x, d.y); s += sample3(L, x, y); } tScores[nm] = +(s / brightDetForRecon.length).toExponential(3); if (s > bestScore) { bestScore = s; bestFlip = nm; } }
    if (bestFlip !== 'identity') { rgb16 = applyFlipRGB(rgb16, wDec, hDec, bestFlip); L = luminance709(rgb16, wDec, hDec); }
    const orientation = (transposed ? 'transpose+' : '') + bestFlip;
    console.log(`[${FRAME}] buffer orient ${JSON.stringify(tScores)} -> ${orientation} (buffer now WCS-frame identity)`);
    const bestT = 'identity', T = (x, y) => [x, y];
    const sigmaPix = pixelNoiseSigma(L);
    // write PSF2 cache (buffer is now in the WCS/detection frame; refit reads it directly)
    const cachePath = path.join(OUT_DIR, `${FRAME}.psf2cache.bin`);
    { const hdr = Buffer.alloc(12); hdr.writeUInt32LE(0x50534632, 0); hdr.writeUInt32LE(wDec, 4); hdr.writeUInt32LE(hDec, 8); fs.writeFileSync(cachePath, Buffer.concat([hdr, Buffer.from(rgb16.buffer, rgb16.byteOffset, rgb16.byteLength)])); }

    // ── HARVEST band (floor, floor+2] + ISOLATION (the confusion measurement) ──
    const band = allProj.filter((s) => s.mag > floor && s.mag <= floor + 2 && s.x > 12 && s.y > 12 && s.x < W - 12 && s.y < H - 12);
    const APER = 5, ISO = 10;
    const bandNoDet = band.filter((s) => nearest(detGrid, s.x, s.y, 4).idx < 0); // exclude existing detections within 4px
    const isolated = bandNoDet.filter((s) => countWithin(allGrid, s.x, s.y, ISO) === 0);
    const isoFrac = bandNoDet.length ? isolated.length / bandNoDet.length : 0;
    // subsample to cap, mag-stratified
    const pick = (arr) => { if (arr.length <= HARVEST_CAP) return arr; const out = []; for (let i = 0; i < HARVEST_CAP; i++) out.push(arr[Math.floor(i * arr.length / HARVEST_CAP)]); return out; };
    const fullSample = pick([...bandNoDet].sort((a, b) => a.mag - b.mag));
    const isoSample = pick([...isolated].sort((a, b) => a.mag - b.mag));

    function harvest(set) {
        const positions = set.map((s) => { const [lx, ly] = T(s.x, s.y); return { x: lx, y: ly, mag: s.mag, gaia_id: s.gaia_id, _px: s.x, _py: s.y }; });
        const fm = forcedMeasure({ L, w: wDec, h: hDec, positions, fwhmPx: 7, posRmsPx: 0, snrThreshold: 2, sigmaPix });
        const rows = fm.results.map((r) => ({ gaia_id: r.gaia_id, G: r.mag, pred_x: +(r._px ?? r.x).toFixed(2), pred_y: +(r._py ?? r.y).toFixed(2), L_x: +r.x.toFixed(2), L_y: +r.y.toFixed(2), r_norm: +rNorm(r._px ?? r.x, r._py ?? r.y).toFixed(3), flux: +r.flux.toFixed(2), snr: +r.snr.toFixed(2), structured: r.structured, accepted: r.accepted }));
        const acc = rows.filter((r) => r.accepted);
        const bySnr = { '2-3': acc.filter((r) => r.snr >= 2 && r.snr < 3).length, '3-5': acc.filter((r) => r.snr >= 3 && r.snr < 5).length, '5-10': acc.filter((r) => r.snr >= 5 && r.snr < 10).length, '10+': acc.filter((r) => r.snr >= 10).length };
        return { rApPx: fm.rApPx, probed: rows.length, accepted: acc.length, accepted_frac: rows.length ? +(acc.length / rows.length).toFixed(3) : null, by_snr: bySnr, rows };
    }
    const fullH = harvest(fullSample), isoH = harvest(isoSample);
    console.log(`[${FRAME}] harvest band (${floor.toFixed(2)},${(floor + 2).toFixed(2)}]: isolated ${isolated.length}/${bandNoDet.length} (${(isoFrac * 100).toFixed(1)}%). full accepted ${fullH.accepted}/${fullH.probed} (${(fullH.accepted_frac * 100).toFixed(0)}%); ISOLATED accepted ${isoH.accepted}/${isoH.probed}`);

    // ── SUPPLEMENT k1: centroids of ISOLATED accepted harvest -> even/odd holdout ──
    const centroidPairs = [];
    for (const r of isoH.rows.filter((x) => x.accepted)) {
        const [lx, ly] = T(r.pred_x, r.pred_y); const bg = localBg(L, wDec, hDec, lx, ly); if (bg == null) continue;
        const cen = fluxCentroid(L, wDec, hDec, lx, ly, bg, sigmaPix, 6); if (!cen) continue;
        let dxf = cen.x, dyf = cen.y;
        if (bestT === 'yflip') dyf = (H - 1) - cen.y; else if (bestT === 'xflip') dxf = (W - 1) - cen.x; else if (bestT === 'rot180') { dxf = (W - 1) - cen.x; dyf = (H - 1) - cen.y; }
        const rU = Math.hypot(r.pred_x - cx, r.pred_y - cy) / hd, rD = Math.hypot(dxf - cx, dyf - cy) / hd;
        if (Math.hypot(dxf - r.pred_x, dyf - r.pred_y) > 8) continue; // near the linear prediction (inner-field)
        centroidPairs.push({ rU, delta: rD - rU });
    }
    let supplementK1 = { n_pairs: centroidPairs.length, status: 'UNDETERMINED' };
    if (centroidPairs.length >= 12) {
        const allR = centroidPairs.map((p) => p.rU), allD = centroidPairs.map((p) => p.delta);
        const evenR = [], evenD = [], oddR = [], oddD = [];
        centroidPairs.forEach((p, i) => { (i % 2 ? oddR : evenR).push(p.rU); (i % 2 ? oddD : evenD).push(p.delta); });
        const full = fitRadialOdd(allR, allD, [1, 3]), evenFit = fitRadialOdd(evenR, evenD, [1, 3]);
        let ho = 0, hoN = 0; if (evenFit) for (let i = 0; i < oddR.length; i++) { const p = evenFit.coef[0] * oddR[i] + evenFit.coef[1] * oddR[i] ** 3; ho += (oddD[i] - p) ** 2; hoN++; }
        supplementK1 = { n_pairs: centroidPairs.length, status: 'MEASURED', r_max: +Math.max(...allR).toFixed(3), k1_full: full ? +full.coef[1].toFixed(5) : null, a_full: full ? +full.coef[0].toFixed(5) : null, k1_even: evenFit ? +evenFit.coef[1].toFixed(5) : null, holdout_rms_px: hoN ? +(Math.sqrt(ho / hoN) * hd).toFixed(2) : null, note: 'PROVISIONAL faint-isolated-sample cross-check; linear-WCS positions -> inner-field only. k1 = half-diagonal-normalized Brown-Conrady (same units as refit & the -0.145/-0.12 known answer).' };
    }
    console.log(`[${FRAME}] supplement k1 (${supplementK1.status}) n=${centroidPairs.length}` + (supplementK1.k1_full != null ? ` k1=${supplementK1.k1_full}` : ''));

    // ── write ──
    fs.writeFileSync(path.join(OUT_DIR, `${FRAME}.harvest.json`), JSON.stringify({
        frame: FRAME, generated: new Date().toISOString(), decoder_arm: 'LIBRAW (decode_cr2.mjs)', catalog: 'g15u stars.arrow (Gaia DR3 G<15, DEGREES)',
        decoded_native_dims: [dec.w, dec.h], decode_transposed_to_landscape: transposed, working_dims: [wDec, hDec], receipt_dims: [W, H], buffer_orientation: orientation, transform_scores: tScores,
        floor_provisional_G: +floor.toFixed(2), harvest_band: [+floor.toFixed(2), +(floor + 2).toFixed(2)], aperture_r_px: fullH.rApPx, sigma_pix: sigmaPix,
        confusion: { band_stars: band.length, band_excl_existing_det: bandNoDet.length, isolated: isolated.length, isolated_frac: +isoFrac.toFixed(4), isolation_radius_px: ISO },
        full_band_harvest: { probed: fullH.probed, accepted: fullH.accepted, accepted_frac: fullH.accepted_frac, by_snr: fullH.by_snr, caveat: 'CONFUSION-DOMINATED: apertures contain neighbour flux; acceptance is NOT clean depth recovery.' },
        isolated_harvest: { probed: isoH.probed, accepted: isoH.accepted, accepted_frac: isoH.accepted_frac, by_snr: isoH.by_snr, caveat: 'the only clean forced measurements; count reflects how few catalog stars are isolated at this pixel scale.' },
        rows_isolated: isoH.rows, rows_full_sample: fullH.rows.slice(0, 200),
    }, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `${FRAME}.profile_partial.json`), JSON.stringify({
        frame: FRAME, cache_for_refit: cachePath, astrometry_json: path.join(OUT_DIR, `${FRAME}.astrometry.json`),
        supplement_k1_faint_isolated: supplementK1,
        known_answer: { rokinon_14mm_k1_measured: -0.145, rokinon_14mm_k1_book: -0.12, units: 'Brown-Conrady k1, radius normalized to half-diagonal' },
    }, null, 2));
    console.log(`[${FRAME}] done ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT_DIR}`);
    return 0;
}
const code = await main().catch((e) => { console.error('FATAL:', (e && e.stack) || e); return 1; });
terminateDecodeWorkers();
setTimeout(() => process.exit(code), 250);
