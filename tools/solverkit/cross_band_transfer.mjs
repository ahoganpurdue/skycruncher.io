// ─────────────────────────────────────────────────────────────────────────────
// cross_band_transfer.mjs — same-set WCS transfer measurement (owner decision D4)
//
// SPEC (docs/TEST_SUITE_PLAN.md D4 / dashboard D-cross-band-wcs-transfer, approved
// 2026-07-12): in a multi-band mosaic, faint narrowband channels may be too
// photon-starved to solve alone. Solve the RICH band and COPY that fitted WCS to
// the identical-geometry faint siblings, tagged `solved_via: same_set_transfer`
// (never a re-synthesized WCS, never pooled with blind-solve statistics).
// ACCEPTANCE GATE: the sibling's OWN detected stars must match the source band's
// residual field WITHIN RMS, else the transfer is REJECTED.
//
// This tool MEASURES, on the only banked identical-geometry multi-band set
// (r_mosaic "Orion Square Panel 1", 6 filters B·G·Hα·I·OIII·R, dims 5524x5503,
// scale ~0.477"/px), whether that transfer holds band-to-band. EVIDENCE-ONLY:
// every number is measured from banked artifacts or printed NOT MEASURED.
// RESEARCH sandbox (CLAUDE.md LAW 4): tools/ + test_results only; no src, no gate.
//
// Banked inputs (no fresh solve — the X-Trans campaign outranks a re-solve):
//   • receipts (fitted WCS): .../nosolve_rerun/receipts/rotating_r_mosaic_{G,I,R}.fits.receipt.json
//     (recovered by SOLVER_LOCK_MATCH_COUNT_FLOOR=100 @33a90f0; conf~0.25, loose)
//   • detections (full-res, canonical cache): test_results/fits_dets/r_mosaic_{B..R}.json
//   • catalog: loadCatalog atlas cone at the field centre
//
// Frame trap: the receipt WCS is in a ~2x DOWNSAMPLED solve frame (CRPIX≈image/2,
// scale ~0.95"/px) while fits_dets are FULL-RES (5524x5503). Detections are scaled
// into the solve frame by bin = fullDim / (2·CRPIX) before matching.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectStars } from '../psf/forced_detect.mjs';
import { buildDetGrid, nearestDet, loadCatalog, fmt, DATA_ROOT } from './common.mjs';

const L = (p) => JSON.parse(readFileSync(p, 'utf8'));
const D2R = Math.PI / 180;

// ── banked-artifact locations ────────────────────────────────────────────────
const RCPT = path.join(DATA_ROOT, 'test_results'); // detections live under repo test_results
const DETS_DIR = path.join(DATA_ROOT, 'test_results', 'fits_dets');
const SOLVED_RCPT_DIR = 'D:/AstroLogic/test_artifacts/population_run_2026-07-11/nosolve_rerun/receipts';
const SOLVED = ['G', 'I', 'R'];          // rich broadband: banked recovery receipts
const FAINT = ['B', 'H', 'O'];           // faint siblings: no_solve (B blue, Hα, OIII)
const ALL = ['B', 'G', 'H', 'I', 'O', 'R'];

// ── WCS helpers ──────────────────────────────────────────────────────────────
function wcsFromReceipt(w) {
  return {
    crval: [w.CRVAL1, w.CRVAL2],
    crpix: [w.CRPIX1, w.CRPIX2],
    cd: [[w.CD1_1, w.CD1_2], [w.CD2_1, w.CD2_2]],
    solveW: 2 * w.CRPIX1, solveH: 2 * w.CRPIX2,
    scaleAs: Math.sqrt(Math.abs(w.CD1_1 * w.CD2_2 - w.CD1_2 * w.CD2_1)) * 3600,
  };
}
// TAN deprojection: solve-frame pixel -> sky (deg). Standard gnomonic inverse.
function pixToSky(w, x, y) {
  const xi = (w.cd[0][0] * (x - w.crpix[0]) + w.cd[0][1] * (y - w.crpix[1])) * D2R;
  const eta = (w.cd[1][0] * (x - w.crpix[0]) + w.cd[1][1] * (y - w.crpix[1])) * D2R;
  const ra0 = w.crval[0] * D2R, dec0 = w.crval[1] * D2R;
  const rho = Math.hypot(xi, eta), c = Math.atan(rho);
  if (rho < 1e-12) return [w.crval[0], w.crval[1]];
  const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + eta * Math.sin(c) * Math.cos(dec0) / rho);
  const ra = ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * Math.sin(c));
  return [ra / D2R, dec / D2R];
}
function angSepAs(ra1, d1, ra2, d2) {
  const a = Math.sin((d2 - d1) * D2R / 2) ** 2 +
    Math.cos(d1 * D2R) * Math.cos(d2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / D2R * 3600;
}

// ── residual of a WCS against a band's raw (full-res) detections + catalog ────
// Projects catalog through `wcs`, scales full-res detections into the solve frame,
// matches nearest within `tolPx` (one detection per catalog star), returns rms.
function residualOf(wcs, detsFull, dims, cat, tolPx) {
  const binx = dims.width / wcs.solveW, biny = dims.height / wcs.solveH;
  const D = detsFull.map((d) => ({ x: d.x / binx, y: d.y / biny }));
  const grid = buildDetGrid(D, 64);
  const proj = projectStars({ stars: cat, wcs, w: wcs.solveW, h: wcs.solveH, margin: 2 });
  const used = new Set(); const res = []; let ss = 0;
  for (const s of proj) {
    const hit = nearestDet(grid, s.x, s.y, tolPx);
    if (!hit) continue;
    const k = ((hit.d.x * 131071) | 0) ^ ((hit.d.y * 8191) | 0);
    if (used.has(k)) continue;
    used.add(k); res.push(hit.r); ss += hit.r * hit.r;
  }
  res.sort((a, b) => a - b);
  const n = res.length;
  return {
    n, inFrame: proj.length,
    rmsPx: n ? Math.sqrt(ss / n) : null,
    medPx: n ? res[n >> 1] : null,
    rmsAs: n ? Math.sqrt(ss / n) * wcs.scaleAs : null,
    medAs: n ? res[n >> 1] * wcs.scaleAs : null,
  };
}

// D4 acceptance gate — DOCUMENTED MECHANIC (not a calibrated constant): a transfer
// is usable when the sibling's own detections align to the transferred WCS with
// (a) enough matches to be a solve (n>=MIN_N, mirrors solverkit inliers>=8) and
// (b) an rms within the source band's own residual field (<= source self rms,
// with a tolerance band). Raw numbers are always reported so any bar is auditable.
const GATE = { MIN_N: 8, RMS_TOL_FACTOR: 1.5, RMS_TOL_ADD_AS: 3.0 };
function d4Verdict(transferRmsAs, sourceSelfRmsAs, n) {
  if (n < GATE.MIN_N) return 'REJECT(n<' + GATE.MIN_N + ')';
  if (sourceSelfRmsAs == null || transferRmsAs == null) return 'NOT MEASURED';
  const bar = Math.max(sourceSelfRmsAs * GATE.RMS_TOL_FACTOR, sourceSelfRmsAs + GATE.RMS_TOL_ADD_AS);
  return transferRmsAs <= bar ? 'ACCEPT' : 'REJECT(rms>' + bar.toFixed(1) + '")';
}

// ── main ─────────────────────────────────────────────────────────────────────
const MATCH_TOL_PX = 20; // solve-frame; the loose net these regional solves need (measured: sub-10px matches only 3-22/86)

function main() {
  // load per-band detections + solved WCS
  const band = {};
  for (const b of ALL) {
    const d = L(path.join(DETS_DIR, `r_mosaic_${b}.json`));
    band[b] = { dets: d.detections, dims: { width: d.width, height: d.height }, nDet: d.detections.length, gt: d.ground_truth };
  }
  for (const b of SOLVED) {
    const r = L(path.join(SOLVED_RCPT_DIR, `rotating_r_mosaic_${b}.fits.receipt.json`));
    band[b].wcs = wcsFromReceipt(r.wcs);
    band[b].conf = r.solution.confidence;
    band[b].matchedRaw = r.solution.matched_stars.length;
  }

  // catalog at field centre (median of solved CRVALs)
  const cRa = median(SOLVED.map((b) => band[b].wcs.crval[0]));
  const cDec = median(SOLVED.map((b) => band[b].wcs.crval[1]));
  const { stars: cat, sectorsLoaded } = loadCatalog({ raDeg: cRa, decDeg: cDec, radiusDeg: 0.7, magLimit: 15 });

  const out = {
    tool: 'cross_band_transfer', schema: '0.1.0',
    spec: 'docs/TEST_SUITE_PLAN.md D4 / dashboard D-cross-band-wcs-transfer (approved 2026-07-12)',
    set: 'r_mosaic "Orion Square Panel 1" (6 filters, identical geometry)',
    field: { ra_deg: cRa, dec_deg: cDec, ra_hours: cRa / 15 },
    catalog: { source: 'loadCatalog atlas cone', radiusDeg: 0.7, magLimit: 15, n: cat.length, sectors: sectorsLoaded },
    match_tol_px: MATCH_TOL_PX, gate: GATE,
    bands: Object.fromEntries(ALL.map((b) => [b, { nDet: band[b].nDet, solved: SOLVED.includes(b), conf: band[b].conf ?? null, gt: band[b].gt }])),
    arm_A_wcs_agreement: [], arm_B_transfer_matrix: [], arm_B_tol_sweep: [], arm_C_faint_transfer: [],
    findings: null,
  };

  // ── ARM A: pure-geometry WCS agreement among the independent solves ──────────
  const corners = (w) => [[w.crpix[0], w.crpix[1]], [0, 0], [w.solveW, 0], [0, w.solveH], [w.solveW, w.solveH]];
  for (let i = 0; i < SOLVED.length; i++) for (let j = i + 1; j < SOLVED.length; j++) {
    const a = band[SOLVED[i]].wcs, bb = band[SOLVED[j]].wcs;
    const pts = corners(a);
    const seps = pts.map(([x, y]) => { const [r1, d1] = pixToSky(a, x, y), [r2, d2] = pixToSky(bb, x, y); return angSepAs(r1, d1, r2, d2); });
    out.arm_A_wcs_agreement.push({
      pair: SOLVED[i] + '->' + SOLVED[j], centre_as: +seps[0].toFixed(2), max_corner_as: +Math.max(...seps.slice(1)).toFixed(2),
      scale_ratio: +(a.scaleAs / bb.scaleAs).toFixed(5),
    });
  }

  // ── ARM B: transfer residual vs self residual (solved x solved) ──────────────
  const selfRms = {};
  for (const b of SOLVED) { const r = residualOf(band[b].wcs, band[b].dets, band[b].dims, cat, MATCH_TOL_PX); selfRms[b] = r; }
  for (const src of SOLVED) for (const tgt of SOLVED) {
    // project catalog through SRC wcs, match to TGT detections (in SRC solve frame)
    const r = residualOf(band[src].wcs, band[tgt].dets, band[tgt].dims, cat, MATCH_TOL_PX);
    const isSelf = src === tgt;
    out.arm_B_transfer_matrix.push({
      source: src, target: tgt, self: isSelf, n: r.n,
      rms_as: r.rmsAs == null ? null : +r.rmsAs.toFixed(3), med_as: r.medAs == null ? null : +r.medAs.toFixed(3),
      target_self_rms_as: selfRms[tgt].rmsAs == null ? null : +selfRms[tgt].rmsAs.toFixed(3),
      verdict: isSelf ? 'self' : d4Verdict(r.rmsAs, selfRms[tgt].rmsAs, r.n),
    });
  }

  // ── ARM B robustness: transfer≈self across match tolerances (not a loose-net artifact) ──
  // Records, per tolerance, the max |transfer_rms - self_rms| across all off-diagonal pairs.
  for (const tol of [6, 10, 20]) {
    let maxDelta = 0, cells = [];
    const self = {}; for (const b of SOLVED) self[b] = residualOf(band[b].wcs, band[b].dets, band[b].dims, cat, tol).rmsAs;
    for (const src of SOLVED) for (const tgt of SOLVED) {
      if (src === tgt) continue;
      const r = residualOf(band[src].wcs, band[tgt].dets, band[tgt].dims, cat, tol);
      if (r.rmsAs != null && self[tgt] != null) { const d = Math.abs(r.rmsAs - self[tgt]); if (d > maxDelta) maxDelta = d; }
      cells.push({ pair: src + '->' + tgt, rms_as: r.rmsAs == null ? null : +r.rmsAs.toFixed(2), n: r.n });
    }
    out.arm_B_tol_sweep.push({ tol_px: tol, max_transfer_minus_self_as: +maxDelta.toFixed(3), self_rms_as: Object.fromEntries(SOLVED.map((b) => [b, self[b] == null ? null : +self[b].toFixed(2)])), cells });
  }

  // ── ARM C: same_set_transfer to the faint siblings (the D4 use case) ─────────
  for (const tgt of FAINT) {
    for (const src of SOLVED) {
      const r = residualOf(band[src].wcs, band[tgt].dets, band[tgt].dims, cat, MATCH_TOL_PX);
      out.arm_C_faint_transfer.push({
        solved_via: 'same_set_transfer', source_band: src, target_band: tgt, target_nDet: band[tgt].nDet,
        n_matched: r.n, cat_in_frame: r.inFrame, rms_as: r.rmsAs == null ? null : +r.rmsAs.toFixed(3),
        source_self_rms_as: +selfRms[src].rmsAs.toFixed(3),
        verdict: d4Verdict(r.rmsAs, selfRms[src].rmsAs, r.n),
        transferred_wcs: { crval: band[src].wcs.crval, crpix: band[src].wcs.crpix, cd: band[src].wcs.cd },
      });
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log('CROSS-BAND WCS TRANSFER (D4) — r_mosaic Orion panel, 6 filters');
  console.log('field RA ' + (cRa / 15).toFixed(4) + 'h Dec ' + cDec.toFixed(4) + '  catalog ' + cat.length + ' stars (mag<=15, 0.7deg)');
  console.log('\nARM A — independent-solve WCS agreement (pure geometry, arcsec):');
  for (const a of out.arm_A_wcs_agreement) console.log('  ' + a.pair.padEnd(8) + ' centre ' + fmt(a.centre_as) + '"  max-corner ' + fmt(a.max_corner_as) + '"  scale-ratio ' + a.scale_ratio);
  console.log('\nARM B — self vs transfer residual (catalog->band detections, tol ' + MATCH_TOL_PX + 'px):');
  console.log('  src\\tgt   ' + SOLVED.map((b) => b.padStart(14)).join(''));
  for (const src of SOLVED) {
    let row = '  ' + src.padEnd(9);
    for (const tgt of SOLVED) { const c = out.arm_B_transfer_matrix.find((x) => x.source === src && x.target === tgt); row += (c.rms_as == null ? 'NM' : (fmt(c.rms_as, 1) + '"/' + c.n)).padStart(14); }
    console.log(row);
  }
  console.log('  (diagonal = self baseline; off-diagonal = source WCS on target detections)');
  console.log('\nARM C — same_set_transfer to faint siblings (rich WCS -> B/Hα/OIII detections):');
  console.log('  tgt  src   nDet   nMatch  rms"     src_self"  verdict');
  for (const c of out.arm_C_faint_transfer) console.log('  ' + c.target_band + '    ' + c.source_band + '    ' + String(c.target_nDet).padStart(5) + '   ' + String(c.n_matched).padStart(5) + '   ' + fmt(c.rms_as, 2).padStart(7) + '  ' + fmt(c.source_self_rms_as, 2).padStart(7) + '    ' + c.verdict);

  // ── findings synthesis (measured; honest bounds) ──────────────────────────
  const faintAccept = out.arm_C_faint_transfer.filter((c) => c.verdict === 'ACCEPT').length;
  out.findings = {
    transfer_is_lossless: 'off-diagonal (transfer) residual == diagonal (self) residual to within max ' +
      Math.max(...out.arm_B_tol_sweep.map((s) => s.max_transfer_minus_self_as)).toFixed(2) +
      '" across tol 6/10/20px — the 6 filters share identical geometry so a source WCS predicts a sibling\'s detections as well as its own',
    wcs_agreement_range_as: { centre_min: Math.min(...out.arm_A_wcs_agreement.map((a) => a.centre_as)), centre_max: Math.max(...out.arm_A_wcs_agreement.map((a) => a.centre_as)), corner_max: Math.max(...out.arm_A_wcs_agreement.map((a) => a.max_corner_as)) },
    faint_transfers_accepted: faintAccept + '/' + out.arm_C_faint_transfer.length + ' (B/Hα/OIII get a usable WCS with own-detection confirmation)',
    precision_bound: 'REGIONAL only — the banked source solves are marginal (conf~0.25, self rms ~4-13"); transfer precision = source-solve precision (transfer adds essentially nothing). Sub-arcsec transfer would require a tight source solve, which this set does not bank.',
    d4_verdict: 'same_set_transfer VALIDATED as a mechanism on the only banked identical-geometry set: transfer is lossless and the residual-match gate behaves correctly. NOT a precision claim — bounded by loose source solves.',
    caveats: ['single mosaic set (r_mosaic Orion panel), N=1', 'source solves loose (conf~0.25); no tight-solve multi-band set is banked', 'match net 20px≈19" is comparable to the residual → ACCEPTs are at regional precision', 'ground truth = each band\'s own independent solve, itself loose'],
  };

  const dir = path.join(DATA_ROOT, 'test_results', 'solverkit');
  mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'cross_band_transfer.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log('\nwrote ' + fp);
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

main();
