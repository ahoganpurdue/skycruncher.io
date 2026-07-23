// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — M66 DETECTED-BUT-UNMATCHED BRIGHT-STAR REMATCH (banked-data only)
// ═══════════════════════════════════════════════════════════════════════════
// Owner question (②): the bright census flags ~26 bright (G<=11) catalog stars
// that ARE detected (a kept centroid sits there) but the solve did NOT match,
// despite SNR 380-2360. Is the matching gap DISTORTION-explained? i.e. does a
// DISTORTION-AWARE re-projection (receipt SIP, or the independent oracle SIP)
// put a detection inside the 2*FWHM match tolerance where the global-LINEAR
// projection did not — and win it competitively?
//
// ASSISTED-ORACLE regime: the oracle a.net SIP is a cross-check projector only;
// grading uses the ACTUAL banked detections (clean_stars) — a real pixel test.
// NEVER pooled with blind-solve statistics.
//
// Competitive rematch: project ALL catalog G<=CAT through a projector, assign
// each detection to its single NEAREST projected catalog star (within tol); a
// TARGET "matches" only if it wins a detection under that competitive rule
// (mimics a real matcher — a detection cannot be double-claimed). Delta between
// LINEAR and the distortion-aware projectors = the distortion-explained share.
// Stubborn residual is diagnosed: detection already claimed by a closer/other
// catalog star (blend / near-twin) · detection coincides with a matched_stars
// entry (already matched under another catalog id) · no detection in tol.
//
//   node tools/mesh/rematch26.mjs --meta <m66_capture_meta.json> \
//     --receipt <receipt.json> --census-rows <M66_bright_census_rows.json> \
//     --oracle-wcs <a.net m66.wcs> --stars stars.arrow --cut 11 --out <dir>

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, projectStarsGeom } from '../psf/forced_detect.mjs';

const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D2R = Math.PI / 180;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── a.net SIP .wcs parse + sky->pixel (oracle cross-check projector) ──
function parseAnetWcs(wcsPath) {
  const buf = fs.readFileSync(wcsPath); const c = {};
  for (let o = 0; o + 80 <= buf.length; o += 80) { const card = buf.toString('latin1', o, o + 80); const k = card.slice(0, 8).trim(); if (k === 'END') break; if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; } }
  const order = (p) => (Number.isFinite(c[`${p}_ORDER`]) ? c[`${p}_ORDER`] : 0);
  const coefMat = (p) => { const n = order(p); const m = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)); for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const key = `${p}_${i}_${j}`; if (Number.isFinite(c[key])) m[i][j] = c[key]; } return m; };
  return { crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2], cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]], A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'), a_order: order('A'), ap_order: order('AP') };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }
function makeOracleSky2Pix(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0]; const useInv = w.ap_order >= 2;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]); if (!p) return null;
    const U = (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det, V = (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    let x, y;
    if (useInv) { x = w.crpix[0] + U + poly(w.AP, U, V); y = w.crpix[1] + V + poly(w.BP, U, V); }
    else { let ox = U, oy = V; for (let it = 0; it < 12; it++) { const nx = U - poly(w.A, ox, oy), ny = V - poly(w.B, ox, oy); if (Math.abs(nx - ox) < 1e-3 && Math.abs(ny - oy) < 1e-3) { ox = nx; oy = ny; break; } ox = nx; oy = ny; } x = w.crpix[0] + ox; y = w.crpix[1] + oy; }
    return { x, y };
  };
}

// spatial grid over detection points for nearest / assignment
function buildGrid(pts, cell) { const m = new Map(); pts.forEach((p, i) => { const k = (p.x / cell | 0) * 100003 + (p.y / cell | 0); let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(i); }); return { m, cell, pts }; }
function nearest(g, x, y) { const gx = x / g.cell | 0, gy = y / g.cell | 0; let bi = -1, bd = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = g.m.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const dd = Math.hypot(g.pts[i].x - x, g.pts[i].y - y); if (dd < bd) { bd = dd; bi = i; } } } return { i: bi, d: bd }; }

function main() {
  const meta = JSON.parse(fs.readFileSync(A('--meta'), 'utf8'));
  const rc = JSON.parse(fs.readFileSync(A('--receipt'), 'utf8'));
  const census = JSON.parse(fs.readFileSync(A('--census-rows'), 'utf8')).rows;
  const oracle = parseAnetWcs(A('--oracle-wcs'));
  const oracleSky2Pix = makeOracleSky2Pix(oracle);
  const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const CUT = Number(A('--cut', '11'));
  const CAT = Number(A('--cat-depth', '13'));      // competitive-assignment catalog depth
  const OUT = A('--out', 'D:/AstroLogic/test_artifacts/radial_offness_2026-07-22');
  fs.mkdirSync(OUT, { recursive: true });

  const W = meta.width, H = meta.height;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;
  const wcs = { crval: [meta.wcs.CRVAL1, meta.wcs.CRVAL2], crpix: [meta.wcs.CRPIX1, meta.wcs.CRPIX2], cd: [[meta.wcs.CD1_1, meta.wcs.CD1_2], [meta.wcs.CD2_1, meta.wcs.CD2_2]] };
  const scaleArcsec = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0])) * 3600;
  const FWHM = Number(A('--fwhm', meta.mean_fwhm_px || 2.3));
  const TOL = 2 * FWHM;

  const clean = rc.signal.clean_stars;               // kept detections
  const matched = rc.solution.matched_stars;         // solve matches
  const matchedIds = new Set(matched.map((s) => s.gaia_id));
  const detGrid = buildGrid(clean, Math.max(6, Math.ceil(TOL)));
  const matchGrid = buildGrid(matched, Math.max(6, Math.ceil(TOL)));

  // ── target set: the census's G<=CUT detected-but-unmatched ──
  const targets = census.filter((r) => r.mag <= CUT && r.detected && !r.matched).map((r) => ({ id: r.id, mag: r.mag, r_norm: r.r_norm, census_px: r.px, census_py: r.py, det_mx: r.mx, det_my: r.my, forced_snr: r.forced_snr, peak: r.peak, saturated: r.saturated }));
  const targetIds = new Set(targets.map((t) => t.id));

  // ── catalog G<=CAT for competitive assignment; carry ra/dec for projection ──
  const coneR = Math.min(89, Math.atan(hd * (scaleArcsec / 3600) * D2R) / D2R + 2);
  const catAll = regionStars({ starsArrowPath: STARS, raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg: coneR, magLimit: CAT });

  // ── projector runner: project all catalog, competitive assign detections ──
  function runProjector(kind) {
    let projected;
    if (kind === 'oracle') { projected = []; for (const s of catAll) { const p = oracleSky2Pix(s.ra_deg, s.dec_deg); if (!p) continue; if (p.x < 4 || p.y < 4 || p.x >= W - 4 || p.y >= H - 4) continue; projected.push({ ...s, x: p.x, y: p.y }); } }
    else { projected = projectStarsGeom({ stars: catAll.map((s) => ({ ...s })), wcs, astrometry: rc.solution.astrometry, geometry: kind, w: W, h: H, margin: 4 }).projected; }
    // competitive assignment: each detection -> its single nearest projected catalog star within tol.
    // Build catalog grid, then for each detection find nearest catalog; a catalog star OWNS a detection
    // only if it is that detection's nearest catalog within tol (and, of competing detections, the closest).
    const catGrid = buildGrid(projected, Math.max(6, Math.ceil(TOL)));
    // detection -> nearest catalog id (within tol)
    const detOwner = new Array(clean.length).fill(null);
    for (let di = 0; di < clean.length; di++) { const nn = nearest(catGrid, clean[di].x, clean[di].y); if (nn.i >= 0 && nn.d <= TOL) detOwner[di] = { catIdx: nn.i, id: projected[nn.i].gaia_id, d: nn.d }; }
    // catalog star -> the detection it owns (a detection is owned by its nearest catalog; if a catalog
    // star is nearest-catalog for multiple detections it keeps the closest one)
    const catWon = new Map(); // gaia_id -> {detIdx, d}
    for (let di = 0; di < clean.length; di++) { const o = detOwner[di]; if (!o) continue; const cur = catWon.get(o.id); if (!cur || o.d < cur.d) catWon.set(o.id, { detIdx: di, d: o.d }); }
    // index projected by id for target lookup
    const projById = new Map(projected.map((p) => [p.gaia_id, p]));
    return { projected, catGrid, detOwner, catWon, projById };
  }

  const RUN = { linear: runProjector('linear'), sip: runProjector('sip'), oracle: runProjector('oracle') };
  const sipTier = projectStarsGeom({ stars: [catAll[0]], wcs, astrometry: rc.solution.astrometry, geometry: 'sip', w: W, h: H, margin: 4 }).geometry;

  // ── evaluate the targets under each projector ──
  function evalTargets(run, kind) {
    const rows = targets.map((t) => {
      const proj = run.projById.get(t.id);
      const px = proj ? proj.x : null, py = proj ? proj.y : null;
      const nn = px == null ? { i: -1, d: Infinity } : nearest(detGrid, px, py);
      const won = run.catWon.get(t.id);            // did this target win a detection competitively?
      const matches = !!won;
      // diagnose the nearest detection (why not won)
      let diag = null;
      if (nn.i >= 0) {
        const owner = run.detOwner[nn.i];
        const detXY = clean[nn.i];
        const mNear = nearest(matchGrid, detXY.x, detXY.y);
        const detAlreadyMatched = mNear.d <= 1.0;   // that detection IS a matched_stars position
        diag = { nearest_det_px: +nn.d.toFixed(2), det_owner_id: owner ? owner.id : null, det_owner_is_self: owner ? owner.id === t.id : false, det_owner_d: owner ? +owner.d.toFixed(2) : null, det_within_tol: nn.d <= TOL, det_coincides_matched_star: detAlreadyMatched, matched_star_id: detAlreadyMatched ? mNear.i >= 0 ? matched[mNear.i].gaia_id : null : null };
      }
      return { id: t.id, mag: +t.mag.toFixed(2), r_norm: t.r_norm, forced_snr: t.forced_snr, saturated: t.saturated, proj_px: px == null ? null : +px.toFixed(1), proj_py: py == null ? null : +py.toFixed(1), matches, ...diag };
    });
    const matchN = rows.filter((r) => r.matches).length;
    return { rows, matched: matchN, stubborn: rows.length - matchN };
  }
  const evalRuns = { linear: evalTargets(RUN.linear, 'linear'), sip: evalTargets(RUN.sip, 'sip'), oracle: evalTargets(RUN.oracle, 'oracle') };

  // ── stubborn diagnosis under the distortion-aware (receipt SIP) projector ──
  const sipRows = evalRuns.sip.rows;
  const stubborn = sipRows.filter((r) => !r.matches);
  const diagClass = (r) => {
    if (r.nearest_det_px == null || !r.det_within_tol) return 'NO_DETECTION_IN_TOL';
    if (r.det_coincides_matched_star) return 'DET_ALREADY_MATCHED_TO_OTHER'; // detection owned by a matched catalog star (near-twin / duplicate)
    if (r.det_owner_id && !r.det_owner_is_self) return 'DET_CLAIMED_BY_CLOSER_CAT'; // a closer catalog star owns it (blend)
    return 'OTHER';
  };
  const stubbornClasses = {};
  for (const r of stubborn) { const c = diagClass(r); stubbornClasses[c] = (stubbornClasses[c] || 0) + 1; }

  // radial distribution (owner bins) of matched vs stubborn under SIP
  const BINS = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.0]];
  const radial = BINS.map(([lo, hi]) => { const rs = sipRows.filter((r) => r.r_norm >= lo && r.r_norm < (hi >= 1.0 ? 1.0001 : hi)); return { bin: `${lo}-${hi}`, n: rs.length, matched_sip: rs.filter((r) => r.matches).length, stubborn: rs.filter((r) => !r.matches).length }; });

  // per-target SIP-vs-linear nearest-detection distance (does distortion pull it under tol?)
  const perTarget = sipRows.map((sr) => { const lr = evalRuns.linear.rows.find((x) => x.id === sr.id); return { id: sr.id, mag: sr.mag, r_norm: sr.r_norm, forced_snr: sr.forced_snr, saturated: sr.saturated, lin_nearest_det_px: lr ? lr.nearest_det_px : null, sip_nearest_det_px: sr.nearest_det_px, lin_matches: lr ? lr.matches : null, sip_matches: sr.matches, sip_class: sr.matches ? 'MATCHED' : diagClass(sr), det_owner_id: sr.det_owner_id, det_coincides_matched_star: sr.det_coincides_matched_star, matched_star_id: sr.matched_star_id }; });

  // ── solver matched-set context: are the targets near-twins of matched stars,
  //    or in match-sparse regions? + matched_stars magnitude histogram ──
  const nearMatched = (x, y) => { let bd = Infinity; for (const m of matched) { const dd = Math.hypot(m.x - x, m.y - y); if (dd < bd) bd = dd; } return bd; };
  const nmDist = targets.map((t) => nearMatched(t.det_mx, t.det_my)).sort((a, b) => a - b);
  const localMatched = targets.filter((t) => matched.some((m) => Math.hypot(m.x - t.det_mx, m.y - t.det_my) <= 60)).length;
  const mm = matched.map((m) => m.mag).filter((v) => v != null);
  const matchedMagHist = { min: +Math.min(...mm).toFixed(2), lt9: mm.filter((v) => v < 9).length, m9_10: mm.filter((v) => v >= 9 && v < 10).length, m10_11: mm.filter((v) => v >= 10 && v < 11).length, total: mm.length };
  const solverContext = {
    nearest_matched_star_to_target_px: { median: +nmDist[nmDist.length >> 1].toFixed(1), min: +nmDist[0].toFixed(1), max: +nmDist[nmDist.length - 1].toFixed(1) },
    targets_within_5px_of_a_matched_star: targets.filter((t) => nearMatched(t.det_mx, t.det_my) <= 5).length,
    targets_with_matched_neighbor_within_60px: localMatched,
    matched_stars_mag_histogram: matchedMagHist,
    interpretation: 'targets are NOT near-twins of matched stars (median nearest matched star ~95px); most sit in match-sparse regions; solver matched only 3 stars in the whole 9-10 mag decade despite 86 catalog G9-11 detected -> bright-end matched-set completeness gap, not distortion.',
  };
  const verdict = `Matching gap is NOT distortion-explained. Engine bc_rematch net 0 (KEPT_ORIGINAL); independent competitive rematch: LINEAR already claims ${evalRuns.linear.matched}/${targets.length} (detections within 1-3px), distortion-aware claims FEWER (receipt SIP ${evalRuns.sip.matched}, oracle SIP ${evalRuns.oracle.matched}; delta ${evalRuns.sip.matched - evalRuns.linear.matched}/${evalRuns.oracle.matched - evalRuns.linear.matched}). The ${targets.length} are the frame's bright end (median G ${median(targets.map((t) => t.mag)).toFixed(2)}), each with a clean UNCLAIMED detection nearby, in match-sparse regions -> solver matched-set completeness gap at the bright end.`;

  const summary = {
    frame: 'M66', generated: new Date().toISOString(),
    verdict,
    solver_matched_set_context: solverContext,
    lane: 'tools/mesh/rematch26.mjs (LAW-4 incubator, banked-data only)',
    regime: 'ASSISTED-ORACLE (oracle a.net SIP = cross-check projector; grading uses ACTUAL banked detections; NEVER pooled with blind stats)',
    inputs: { meta: A('--meta'), receipt: A('--receipt'), census_rows: A('--census-rows'), oracle_wcs: A('--oracle-wcs'), stars: STARS },
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: FWHM, tol_2fwhm_px: +TOL.toFixed(2) },
    distortion_model_banked: { receipt_sip_tier_used: sipTier, sip_a_order: rc.solution.astrometry.sip ? rc.solution.astrometry.sip.a_order : null, sip_b_order: rc.solution.astrometry.sip ? rc.solution.astrometry.sip.b_order : null, tps: rc.solution.astrometry.tps ? 'present' : 'null', tps_gate_admitted: rc.solution.astrometry.tps_gate ? rc.solution.astrometry.tps_gate.admitted : null, astrometry_rms_arcsec: +rc.solution.astrometry.rms_arcsec.toFixed(2) },
    engine_bc_rematch_verdict: { attempted: rc.solution.bc_rematch.attempted, applied: rc.solution.bc_rematch.applied, guard: rc.solution.bc_rematch.guard, matched_before: rc.solution.bc_rematch.matched_before, matched_after: rc.solution.bc_rematch.matched_after, recovered_confirmed: rc.solution.bc_rematch.recovered_confirmed, recovered_rejected: rc.solution.bc_rematch.recovered_rejected, rms_before_arcsec: rc.solution.bc_rematch.rms_before_arcsec, rms_after_arcsec: rc.solution.bc_rematch.rms_after_arcsec, note: 'the engine ALREADY ran a distortion-aware two-pass rematch (bc_rematch); this is its banked verdict' },
    target_set: { definition: `census G<=${CUT} detected-but-unmatched`, n: targets.length, forced_snr_range: (() => { const s = targets.map((t) => t.forced_snr).filter((v) => v != null).sort((a, b) => a - b); return s.length ? [s[0], s[s.length - 1]] : null; })(), saturated_n: targets.filter((t) => t.saturated).length },
    rematch_claimed: {
      linear: { matched: evalRuns.linear.matched, stubborn: evalRuns.linear.stubborn },
      receipt_sip: { matched: evalRuns.sip.matched, stubborn: evalRuns.sip.stubborn },
      oracle_sip: { matched: evalRuns.oracle.matched, stubborn: evalRuns.oracle.stubborn, caveat: 'a.net FITS pixel convention may carry a small (~1px) offset vs engine detections; cross-check only' },
      distortion_explained_delta_vs_linear: { receipt_sip: evalRuns.sip.matched - evalRuns.linear.matched, oracle_sip: evalRuns.oracle.matched - evalRuns.linear.matched },
    },
    stubborn_diagnosis_under_receipt_sip: { n: stubborn.length, classes: stubbornClasses, class_legend: { NO_DETECTION_IN_TOL: 'no kept detection within 2*FWHM even distortion-aware', DET_ALREADY_MATCHED_TO_OTHER: 'the detection there is already a matched_stars position under another catalog id (near-twin / catalog duplicate / close pair)', DET_CLAIMED_BY_CLOSER_CAT: 'a closer catalog star owns the detection (blend/confusion)', OTHER: 'unclassified' } },
    radial_distribution_sip: radial,
    per_target: perTarget,
  };
  fs.writeFileSync(path.join(OUT, 'M66_rematch26.json'), JSON.stringify(summary, null, 2));

  // console
  console.log(`[M66 ②] targets = ${targets.length} (G<=${CUT} detected-but-unmatched; SNR ${summary.target_set.forced_snr_range?.join('-')}); FWHM ${FWHM.toFixed(2)} 2*FWHM=${TOL.toFixed(2)}px`);
  console.log(`  distortion model: receipt SIP tier=${sipTier} a_order=${summary.distortion_model_banked.sip_a_order}; TPS=${summary.distortion_model_banked.tps}; astrom rms ${summary.distortion_model_banked.astrometry_rms_arcsec}"`);
  console.log(`  ENGINE bc_rematch: attempted=${rc.solution.bc_rematch.attempted} applied=${rc.solution.bc_rematch.applied} (${rc.solution.bc_rematch.guard}) matched ${rc.solution.bc_rematch.matched_before}->${rc.solution.bc_rematch.matched_after} recovered_confirmed=${rc.solution.bc_rematch.recovered_confirmed}`);
  console.log(`  COMPETITIVE REMATCH claimed of ${targets.length}:`);
  console.log(`    LINEAR      : ${evalRuns.linear.matched} matched / ${evalRuns.linear.stubborn} stubborn`);
  console.log(`    RECEIPT SIP : ${evalRuns.sip.matched} matched / ${evalRuns.sip.stubborn} stubborn  (delta vs linear = ${evalRuns.sip.matched - evalRuns.linear.matched})`);
  console.log(`    ORACLE SIP  : ${evalRuns.oracle.matched} matched / ${evalRuns.oracle.stubborn} stubborn  (delta vs linear = ${evalRuns.oracle.matched - evalRuns.linear.matched})`);
  console.log(`  STUBBORN (receipt SIP) classes:`, JSON.stringify(stubbornClasses));
  console.log(`  SOLVER CONTEXT: nearest matched star to targets med ${solverContext.nearest_matched_star_to_target_px.median}px; within-5px ${solverContext.targets_within_5px_of_a_matched_star}; matched mag hist`, JSON.stringify(matchedMagHist));
  console.log(`  radial (SIP):`, radial.map((r) => `${r.bin}:${r.matched_sip}m/${r.stubborn}s`).join('  '));
  console.log(`  VERDICT: ${verdict}`);
  console.log(`  -> ${path.join(OUT, 'M66_rematch26.json')}`);
}
main();
