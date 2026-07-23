// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — ORACLE grading harness (astrometry.net SIP = corner-valid truth)
// ═══════════════════════════════════════════════════════════════════════════
// ASSISTED-ORACLE REGIME: everything here is graded against an EXTERNAL a.net
// solve (SIP). Results are a GRADING harness — labelled oracle-assisted, NEVER
// pooled with blind-solve statistics. banked-data-first: consumes a banked mesh
// run + a banked a.net .wcs; runs zero solves.
//
//   node tools/mesh/grade_oracle.mjs \
//     --matches <frame>_mesh_matches.json  --meta <capture_meta.json> \
//     --wcs <a.net .wcs>  --corr <a.net .corr>  --frame beach  [--fwhm 7.3]
//     [--stars stars.arrow]  [--out <dir>]
//
// Produces: <frame>_oracle_grade.json  (false-completion by radial bin; gate-③
// affine-vs-linear prediction RMS by radial bin; PSF-coupling density preview).
import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward } from '../psf/forced_detect.mjs';

const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D2R = Math.PI / 180;

// ── parse an a.net FITS .wcs header (SIP: A/B forward + AP/BP inverse) ────────
function parseAnetWcs(wcsPath) {
  const buf = fs.readFileSync(wcsPath);
  const c = {};
  for (let o = 0; o + 80 <= buf.length; o += 80) {
    const card = buf.toString('latin1', o, o + 80);
    const k = card.slice(0, 8).trim();
    if (k === 'END') break;
    if (card[8] === '=') {
      let v = card.slice(9).split('/')[0].trim();
      if (v.startsWith("'")) v = v.replace(/'/g, '').trim();
      else v = Number(v);
      c[k] = v;
    }
  }
  const order = (p) => (Number.isFinite(c[`${p}_ORDER`]) ? c[`${p}_ORDER`] : 0);
  const coefMat = (p) => {
    const n = order(p);
    const m = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const key = `${p}_${i}_${j}`; if (Number.isFinite(c[key])) m[i][j] = c[key]; }
    return m;
  };
  return {
    crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2],
    cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]],
    A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'),
    a_order: order('A'), ap_order: order('AP'),
    imagew: c.IMAGEW, imageh: c.IMAGEH,
  };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }

// sky (ra,dec deg) -> pixel (a.net FITS convention, the coord space of the xylist
// we fed = greenfield detection coords). Returns { x, y, xlin, ylin } where
// (x,y) is the FULL SIP prediction and (xlin,ylin) is the LINEAR-only prediction.
function makeSkyToPixel(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  const useInv = w.ap_order >= 2; // AP/BP inverse available
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]); // xi,eta deg
    if (!p) return null;
    // [xi,eta] = CD . [U,V]  ->  [U,V] = CD^-1 . [xi,eta]  (SIP-corrected offsets)
    const U = (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det;
    const V = (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    const xlin = w.crpix[0] + U, ylin = w.crpix[1] + V;
    let x, y;
    if (useInv) { x = w.crpix[0] + U + poly(w.AP, U, V); y = w.crpix[1] + V + poly(w.BP, U, V); }
    else {
      // no inverse coeffs: fixed-point invert forward A/B
      let ox = U, oy = V;
      for (let it = 0; it < 12; it++) { const nx = U - poly(w.A, ox, oy), ny = V - poly(w.B, ox, oy); if (Math.abs(nx - ox) < 1e-3 && Math.abs(ny - oy) < 1e-3) { ox = nx; oy = ny; break; } ox = nx; oy = ny; }
      x = w.crpix[0] + ox; y = w.crpix[1] + oy;
    }
    return { x, y, xlin, ylin };
  };
}

// read a.net .corr FITS bintable → [{field_x, field_y, index_ra, index_dec}]
function readCorr(corrPath) {
  const buf = fs.readFileSync(corrPath);
  // find BINTABLE header block(s): parse 2nd HDU header
  let o = 0; const rd = () => { const c = {}; for (; o + 80 <= buf.length; o += 80) { const card = buf.toString('latin1', o, o + 80); const k = card.slice(0, 8).trim(); if (k === 'END') { o += 80; break; } if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; } } o = Math.ceil(o / 2880) * 2880; return c; };
  const prim = rd(); // primary
  const ext = rd(); // bintable header
  if (ext.XTENSION !== 'BINTABLE') return null;
  const nrows = ext.NAXIS2, rowbytes = ext.NAXIS1, tfields = ext.TFIELDS;
  const cols = []; let off = 0;
  for (let i = 1; i <= tfields; i++) { const name = String(ext[`TTYPE${i}`] || '').trim(); const form = String(ext[`TFORM${i}`] || '').trim(); const type = form.replace(/[0-9]/g, ''); const sz = type === 'D' ? 8 : type === 'E' ? 4 : type === 'J' ? 4 : type === 'I' ? 2 : 8; cols.push({ name, type, off, sz }); off += sz; }
  const rows = [];
  for (let r = 0; r < nrows; r++) { const base = o + r * rowbytes; const rec = {}; for (const col of cols) { const p = base + col.off; rec[col.name] = col.type === 'D' ? buf.readDoubleBE(p) : col.type === 'E' ? buf.readFloatBE(p) : col.type === 'J' ? buf.readInt32BE(p) : buf.readDoubleBE(p); } rows.push(rec); }
  return rows;
}

function main() {
  const FRAME = A('--frame', 'beach');
  const matches = JSON.parse(fs.readFileSync(A('--matches'), 'utf8')).matches;
  const meta = JSON.parse(fs.readFileSync(A('--meta'), 'utf8'));
  const W = meta.width, H = meta.height;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;
  const wcs = parseAnetWcs(A('--wcs'));
  const sky2pix = makeSkyToPixel(wcs);
  const FWHM = Number(A('--fwhm', meta.mean_fwhm_px || 7.3));
  const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const OUT = A('--out', 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22');

  // ── validate SIP parse vs a.net's own matched correspondences (.corr) ──
  let corrValidation = null;
  const corrPath = A('--corr');
  if (corrPath && fs.existsSync(corrPath)) {
    const corr = readCorr(corrPath);
    if (corr && corr.length) {
      const fxk = corr[0].field_x !== undefined ? 'field_x' : (corr[0].FIELD_X !== undefined ? 'FIELD_X' : 'x');
      const fyk = corr[0].field_y !== undefined ? 'field_y' : (corr[0].FIELD_Y !== undefined ? 'FIELD_Y' : 'y');
      const rak = corr[0].index_ra !== undefined ? 'index_ra' : (corr[0].RA !== undefined ? 'RA' : 'ra');
      const dek = corr[0].index_dec !== undefined ? 'index_dec' : (corr[0].DEC !== undefined ? 'DEC' : 'dec');
      let se = 0, n = 0, mx = 0; const rr = [];
      for (const c of corr) { const q = sky2pix(c[rak], c[dek]); if (!q) continue; const d = Math.hypot(q.x - c[fxk], q.y - c[fyk]); se += d * d; n++; if (d > mx) mx = d; rr.push(rNorm(c[fxk], c[fyk])); }
      corrValidation = { n_corr: corr.length, n_checked: n, sip_reproj_rms_px: n ? +Math.sqrt(se / n).toFixed(3) : null, sip_reproj_max_px: +mx.toFixed(2), corr_r_norm_max: rr.length ? +Math.max(...rr).toFixed(3) : null, keys: { fxk, fyk, rak, dek } };
    }
  }

  // ── catalog: id -> {ra,dec,mag}. cone from oracle crval, wide. ──
  const coneR = Math.min(89, 55);
  const g = regionStars({ starsArrowPath: STARS, raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg: coneR, magLimit: 15 });
  const byId = new Map(g.map((s) => [s.gaia_id, s]));

  const meshOnly = matches.filter((m) => m.source === 'mesh');
  const seed = matches.filter((m) => m.source === 'seed');

  // radial-bin helpers
  const coarseBins = [[0, 0.7], [0.7, 0.85], [0.85, 1.01]];
  const binLabel = (lo, hi) => `${lo.toFixed(2)}-${hi >= 1.0 ? '1.0' : hi.toFixed(2)}`;
  const fineBinKey = (r) => { const b = Math.min(9, Math.floor(r * 10)); return `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`; };

  // ── FALSE-COMPLETION (measured centroid vs oracle-truth of CLAIMED id) ──
  const tol1 = FWHM, tol2 = 2 * FWHM;
  const falseCoarse = coarseBins.map(([lo, hi]) => ({ bin: binLabel(lo, hi), lo, hi, n: 0, true1: 0, true2: 0, no_oracle: 0, dists: [] }));
  const gateFine = {}; // r -> { n, linSq, affSq, recLinSq }
  const receiptWcs = meta.wcs; // coarse greenfield linear (the "receipt non-SIP WCS")
  const rdet = receiptWcs.CD1_1 * receiptWcs.CD2_2 - receiptWcs.CD1_2 * receiptWcs.CD2_1;
  const receiptLinPred = (ra, dec) => { const p = tanForward(ra, dec, receiptWcs.CRVAL1, receiptWcs.CRVAL2); if (!p) return null; const x = receiptWcs.CRPIX1 + (receiptWcs.CD2_2 * p.xi - receiptWcs.CD1_2 * p.eta) / rdet; const y = receiptWcs.CRPIX2 + (-receiptWcs.CD2_1 * p.xi + receiptWcs.CD1_1 * p.eta) / rdet; return { x, y }; };

  let noOracleCat = 0;
  for (const m of meshOnly) {
    const cat = byId.get(m.id);
    if (!cat) { noOracleCat++; continue; }
    const t = sky2pix(cat.ra_deg, cat.dec_deg);
    if (!t) { noOracleCat++; continue; }
    // false-completion: measured centroid vs claimed-id oracle truth
    const dMeas = Math.hypot(m.x - t.x, m.y - t.y);
    for (const b of falseCoarse) if (m.r_norm >= b.lo && m.r_norm < b.hi) { b.n++; if (dMeas <= tol1) b.true1++; if (dMeas <= tol2) b.true2++; b.dists.push(dMeas); }
    // gate-③: prediction accuracy vs oracle truth, per fine bin
    if (m.pred_x != null) {
      const affErr = Math.hypot(m.pred_x - t.x, m.pred_y - t.y);
      const linErr = Math.hypot(t.xlin - t.x, t.ylin - t.y); // oracle-linear vs oracle-SIP truth (the pure distortion)
      const rl = receiptLinPred(cat.ra_deg, cat.dec_deg);
      const recLinErr = rl ? Math.hypot(rl.x - t.x, rl.y - t.y) : null;
      const key = fineBinKey(m.r_norm);
      if (!gateFine[key]) gateFine[key] = { n: 0, affSq: 0, linSq: 0, recLinSq: 0, recN: 0, affList: [], linList: [] };
      const G = gateFine[key]; G.n++; G.affSq += affErr * affErr; G.linSq += linErr * linErr; if (recLinErr != null) { G.recLinSq += recLinErr * recLinErr; G.recN++; }
      G.affList.push(affErr); G.linList.push(linErr);
    }
  }
  const falseByBin = falseCoarse.map((b) => { b.dists.sort((a, z) => a - z); return { bin: b.bin, n: b.n, true_at_1fwhm: b.true1, true_at_2fwhm: b.true2, false_rate_1fwhm: b.n ? +(1 - b.true1 / b.n).toFixed(3) : null, false_rate_2fwhm: b.n ? +(1 - b.true2 / b.n).toFixed(3) : null, median_dist_px: b.n ? +b.dists[b.dists.length >> 1].toFixed(2) : null }; });
  const gateByBin = Object.entries(gateFine).sort().map(([k, G]) => ({ r_norm: k, n: G.n, rms_affine_pred_px: +Math.sqrt(G.affSq / G.n).toFixed(2), rms_linear_pred_px: +Math.sqrt(G.linSq / G.n).toFixed(2), rms_receipt_linear_pred_px: G.recN ? +Math.sqrt(G.recLinSq / G.recN).toFixed(2) : null, median_affine_px: +median(G.affList).toFixed(2), median_linear_px: +median(G.linList).toFixed(2), affine_beats_linear: G.affSq < G.linSq }));

  // ── PSF-coupling density preview ──
  // completions SNR-sufficient for a shape (LM) fit. Report at floors 10 & 20.
  const snrFloors = [10, 20];
  const psf = {};
  for (const fl of snrFloors) {
    const sub = meshOnly.filter((m) => (m.snr || 0) >= fl);
    psf[`snr_ge_${fl}`] = { n: sub.length, r_norm_max: sub.length ? +Math.max(...sub.map((m) => m.r_norm)).toFixed(3) : null, r_norm_median: sub.length ? +median(sub.map((m) => m.r_norm)).toFixed(3) : null, frac_outer_gt_0p7: sub.length ? +(sub.filter((m) => m.r_norm > 0.7).length / sub.length).toFixed(3) : null };
  }
  const anchorSpread = { n: seed.length, r_norm_max: seed.length ? +Math.max(...seed.map((m) => m.r_norm)).toFixed(3) : null, r_norm_median: seed.length ? +median(seed.map((m) => m.r_norm)).toFixed(3) : null };
  const psfDensity = { anchors_current_grid: anchorSpread, mesh_snr_sufficient: psf, note: 'PSF field grid density = SNR-sufficient mesh completions added to the current anchor grid. Counts only; NO LM fits run.' };

  const summary = {
    frame: FRAME, generated: new Date().toISOString(), regime: 'ASSISTED-ORACLE (a.net SIP grading harness; NEVER pooled with blind-solve stats)',
    oracle: { wcs: A('--wcs'), sip_order: wcs.a_order, ap_order: wcs.ap_order, crval_deg: wcs.crval, scale_arcsec_px: +(Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0])) * 3600).toFixed(3) },
    sip_parse_validation_vs_corr: corrValidation,
    match_tolerance: { fwhm_px: FWHM, tol_1fwhm_px: +tol1.toFixed(2), tol_2fwhm_px: +tol2.toFixed(2), rationale: 'scale-aware; centroid precision ~1-2px on FWHM~7px stars, so 1-2 FWHM brackets a real vs confusion completion' },
    counts: { mesh_completions: meshOnly.length, graded: meshOnly.length - noOracleCat, no_oracle_catalog_match: noOracleCat, seed_anchors: seed.length },
    false_completion_by_radial_bin: falseByBin,
    gate3_prediction_rms_by_radius: gateByBin,
    gate3_note: 'linear = oracle crval+CD (best global-linear) vs oracle-SIP truth = the pure distortion residual; receipt_linear = the coarse greenfield receipt WCS. affine = mesh local-affine prediction. affine<linear in outer bins ⇒ local geometry absorbs distortion (gate-③ claim).',
    psf_coupling_preview: psfDensity,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const outPath = path.join(OUT, `${FRAME}_oracle_grade.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ corrValidation, false_completion_by_radial_bin: falseByBin, gate3_prediction_rms_by_radius: gateByBin, psf: psfDensity, counts: summary.counts, out: outPath }, null, 2));
}
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
main();
