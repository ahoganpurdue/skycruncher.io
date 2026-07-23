// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — RADIAL OFF-NESS + BRIGHT CENSUS (banked-data only, LAW-4 incubator)
// ═══════════════════════════════════════════════════════════════════════════
// Owner hypothesis (①): on the beach (86° CR2 field) bright-star MATCH failure
// grows with radius because the solve's GLOBAL-LINEAR WCS strands edge stars —
// distortion (and pointing/scale error) displaces the linear-predicted position
// away from the star's TRUE (oracle) position by more than the match tolerance.
//
// ASSISTED-ORACLE regime: the a.net SIP .wcs is the TRUTH (oracle-truth pixel of
// every catalog star). The solve's global-linear WCS (capture-meta receipt wcs)
// is the PREDICTOR being graded. Off-ness = |linear-predicted - oracle-truth| px.
// NEVER pooled with blind-solve statistics.
//
// For bright catalog stars (G<=cut) binned by r_norm we report, per bin:
//   catalog   : g15u stars with oracle-truth position in-frame
//   detected  : a frame detection (beach.xy.fits) within 2*FWHM of oracle-truth
//   matched   : a frame detection within 2*FWHM of the LINEAR-predicted position
//               (= the global-linear match the solver's anchor step would make)
//   matched_correct : that linear-matched detection IS the star's own detection
//   median_offness_px : median |linear-pred - oracle-truth| (THE off-ness curve)
// Plus a fine r_norm curve to locate the radius where median off-ness crosses
// 2*FWHM (beyond which global-linear matching MUST fail).
//
//   node tools/mesh/radial_offness.mjs --frame beach \
//     --dims <WxH json> --meta <capture_meta.json w/ .wcs linear> \
//     --oracle-wcs <a.net .wcs SIP> --dets <xylist.fits> --stars stars.arrow \
//     --fwhm 7.29 --cuts 11,13 --out <dir>

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward } from '../psf/forced_detect.mjs';
import { plotPoint, drawPolyline, writePNG } from '../psf/imaging.mjs';

const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D2R = Math.PI / 180;

// ── a.net SIP .wcs parse (verbatim from grade_oracle.mjs) ──
function parseAnetWcs(wcsPath) {
  const buf = fs.readFileSync(wcsPath);
  const c = {};
  for (let o = 0; o + 80 <= buf.length; o += 80) {
    const card = buf.toString('latin1', o, o + 80);
    const k = card.slice(0, 8).trim();
    if (k === 'END') break;
    if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; }
  }
  const order = (p) => (Number.isFinite(c[`${p}_ORDER`]) ? c[`${p}_ORDER`] : 0);
  const coefMat = (p) => { const n = order(p); const m = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)); for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const key = `${p}_${i}_${j}`; if (Number.isFinite(c[key])) m[i][j] = c[key]; } return m; };
  return { crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2], cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]], A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'), a_order: order('A'), ap_order: order('AP') };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }
// oracle sky->pixel (SIP-corrected TRUTH)
function makeSkyToPixel(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  const useInv = w.ap_order >= 2;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]); if (!p) return null;
    const U = (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det;
    const V = (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    let x, y;
    if (useInv) { x = w.crpix[0] + U + poly(w.AP, U, V); y = w.crpix[1] + V + poly(w.BP, U, V); }
    else { let ox = U, oy = V; for (let it = 0; it < 12; it++) { const nx = U - poly(w.A, ox, oy), ny = V - poly(w.B, ox, oy); if (Math.abs(nx - ox) < 1e-3 && Math.abs(ny - oy) < 1e-3) { ox = nx; oy = ny; break; } ox = nx; oy = ny; } x = w.crpix[0] + ox; y = w.crpix[1] + oy; }
    return { x, y };
  };
}
// solve global-linear sky->pixel (capture-meta receipt wcs, no SIP)
function makeLinearSky2Pix(w) {
  const det = w.CD1_1 * w.CD2_2 - w.CD1_2 * w.CD2_1;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.CRVAL1, w.CRVAL2); if (!p) return null;
    const x = w.CRPIX1 + (w.CD2_2 * p.xi - w.CD1_2 * p.eta) / det;
    const y = w.CRPIX2 + (-w.CD2_1 * p.xi + w.CD1_1 * p.eta) / det;
    return { x, y };
  };
}
// oracle-LINEAR sky->pixel: same crval/crpix/CD as the oracle SIP, but SIP OFF.
// = the BEST-POSSIBLE global-linear fit; its residual vs the SIP truth is the
// PURE lens-distortion floor (what ANY global-linear must miss regardless of
// pointing quality). Where THIS crosses 2*FWHM = the fundamental wall.
function makeOracleLinearSky2Pix(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]); if (!p) return null;
    const x = w.crpix[0] + (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det;
    const y = w.crpix[1] + (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    return { x, y };
  };
}
// read a.net xylist FITS BINTABLE (X,Y float32-BE) -> [{x,y}]
function readXyFits(p) {
  const buf = fs.readFileSync(p);
  let o = 0; const rd = () => { const c = {}; for (; o + 80 <= buf.length; o += 80) { const card = buf.toString('latin1', o, o + 80); const k = card.slice(0, 8).trim(); if (k === 'END') { o += 80; break; } if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; } } o = Math.ceil(o / 2880) * 2880; return c; };
  rd(); const ext = rd();
  const nrows = ext.NAXIS2, rowbytes = ext.NAXIS1;
  const out = [];
  for (let r = 0; r < nrows; r++) { const base = o + r * rowbytes; out.push({ x: buf.readFloatBE(base), y: buf.readFloatBE(base + 4) }); }
  return out;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── minimal 3x5 bitmap font (digits, '.', '-', a few letters) for chart labels ──
const FONT = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'], '-': ['000', '000', '111', '000', '000'],
  ' ': ['000', '000', '000', '000', '000'], 'r': ['000', '000', '110', '100', '100'],
  'F': ['111', '100', '110', '100', '100'], 'W': ['101', '101', '101', '111', '101'],
  'H': ['101', '101', '111', '101', '101'], 'M': ['101', '111', '111', '101', '101'],
  'p': ['000', '110', '101', '110', '100'], 'x': ['000', '101', '010', '101', '000'],
  'o': ['000', '010', '101', '101', '010'], 'f': ['011', '100', '110', '100', '100'],
  'n': ['000', '110', '101', '101', '101'], 's': ['000', '011', '110', '011', '110'],
  '2': ['111', '001', '111', '100', '111'], 'G': ['111', '100', '101', '101', '111'],
  '=': ['000', '111', '000', '111', '000'], 'L': ['100', '100', '100', '100', '111'],
  'I': ['111', '010', '010', '010', '111'], 'N': ['101', '111', '111', '111', '101'],
  'E': ['111', '100', '110', '100', '111'], 'A': ['111', '101', '111', '101', '101'],
  'R': ['110', '101', '110', '101', '101'], 'O': ['111', '101', '101', '101', '111'],
  'C': ['111', '100', '100', '100', '111'], 'T': ['111', '010', '010', '010', '010'],
  'U': ['101', '101', '101', '101', '111'], 'D': ['110', '101', '101', '101', '110'],
  'S': ['111', '100', '111', '001', '111'], 'l': ['100', '100', '100', '100', '100'],
  'e': ['000', '111', '110', '100', '111'], 'i': ['010', '000', '010', '010', '010'],
  'a': ['000', '111', '101', '101', '111'], 'd': ['001', '001', '111', '101', '111'],
};
function drawText(bytes, W, H, x, y, str, rgb, scale = 2) {
  let cx = x;
  for (const ch of str) { const g = FONT[ch] || FONT[' ']; for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (g[row][col] === '1') for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const px = cx + col * scale + sx, py = y + row * scale + sy; if (px >= 0 && py >= 0 && px < W && py < H) { const o = (py * W + px) * 3; bytes[o] = rgb[0]; bytes[o + 1] = rgb[1]; bytes[o + 2] = rgb[2]; } } cx += 4 * scale; }
}

function main() {
  const FRAME = A('--frame', 'beach');
  const dimsP = A('--dims');
  const d = JSON.parse(fs.readFileSync(dimsP, 'utf8')); const W = d.width, H = d.height;
  const meta = JSON.parse(fs.readFileSync(A('--meta'), 'utf8'));
  const oracle = parseAnetWcs(A('--oracle-wcs'));
  const sky2truth = makeSkyToPixel(oracle);
  const lin2pix = makeLinearSky2Pix(meta.wcs);
  const oraclin2pix = makeOracleLinearSky2Pix(oracle);
  const dets = readXyFits(A('--dets'));
  const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const FWHM = Number(A('--fwhm', meta.mean_fwhm_px || 7.29));
  const TOL = 2 * FWHM;
  const CUTS = A('--cuts', '11,13').split(',').map(Number);
  const MAXCUT = Math.max(...CUTS);
  const OUT = A('--out', 'D:/AstroLogic/test_artifacts/radial_offness_2026-07-22');
  fs.mkdirSync(OUT, { recursive: true });

  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;
  const scaleArcsec = Math.sqrt(Math.abs(oracle.cd[0][0] * oracle.cd[1][1] - oracle.cd[0][1] * oracle.cd[1][0])) * 3600;

  // ── detection grid (in actual pixel frame) ──
  const CELL = Math.max(8, Math.ceil(TOL));
  const grid = new Map();
  dets.forEach((p, i) => { const k = (p.x / CELL | 0) * 100003 + (p.y / CELL | 0); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(i); });
  const nearestDet = (x, y) => { const gx = x / CELL | 0, gy = y / CELL | 0; let bi = -1, bd = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = grid.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const dd = Math.hypot(dets[i].x - x, dets[i].y - y); if (dd < bd) { bd = dd; bi = i; } } } return { i: bi, d: bd }; };

  // ── project bright catalog through oracle (truth) + linear (predictor) ──
  const coneR = Math.min(89, Math.atan(hd * (scaleArcsec / 3600) * D2R) / D2R + 2);
  const g = regionStars({ starsArrowPath: STARS, raDeg: oracle.crval[0], decDeg: oracle.crval[1], radiusDeg: coneR, magLimit: MAXCUT });
  const rows = [];
  for (const s of g) {
    const t = sky2truth(s.ra_deg, s.dec_deg); if (!t) continue;
    if (t.x < 4 || t.y < 4 || t.x >= W - 4 || t.y >= H - 4) continue;  // in-frame on TRUE position
    const l = lin2pix(s.ra_deg, s.dec_deg); if (!l) continue;
    const ol = oraclin2pix(s.ra_deg, s.dec_deg); if (!ol) continue;
    const offness = Math.hypot(l.x - t.x, l.y - t.y);          // receipt global-linear vs truth (actual)
    const offness_dist = Math.hypot(ol.x - t.x, ol.y - t.y);   // best global-linear vs truth (pure distortion floor)
    const dTrue = nearestDet(t.x, t.y);      // detection at true position?
    const dLin = nearestDet(l.x, l.y);       // detection at linear-predicted position?
    const detected = dTrue.d <= TOL;
    const matched = dLin.d <= TOL;
    const matched_correct = matched && detected && dLin.i === dTrue.i; // linear-matched IS the star's own detection
    rows.push({ id: s.gaia_id, mag: s.mag, tx: +t.x.toFixed(1), ty: +t.y.toFixed(1), lx: +l.x.toFixed(1), ly: +l.y.toFixed(1), r_norm: +rNorm(t.x, t.y).toFixed(4), offness_px: +offness.toFixed(2), offness_dist_px: +offness_dist.toFixed(2), detected, matched, matched_correct });
  }

  // ── radial bins (owner-specified) ──
  const BINS = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.0]];
  const tableFor = (cut) => BINS.map(([lo, hi]) => {
    const rs = rows.filter((r) => r.mag <= cut && r.r_norm >= lo && r.r_norm < (hi >= 1.0 ? 1.0001 : hi));
    const offs = rs.map((r) => r.offness_px);
    const offsD = rs.map((r) => r.offness_dist_px);
    return {
      bin: `${lo}-${hi}`, catalog: rs.length,
      detected: rs.filter((r) => r.detected).length,
      matched: rs.filter((r) => r.matched).length,
      matched_correct: rs.filter((r) => r.matched_correct).length,
      detected_frac: rs.length ? +(rs.filter((r) => r.detected).length / rs.length).toFixed(3) : null,
      matched_frac: rs.length ? +(rs.filter((r) => r.matched).length / rs.length).toFixed(3) : null,
      median_offness_px: median(offs) == null ? null : +median(offs).toFixed(2),
      p90_offness_px: offs.length ? +[...offs].sort((a, b) => a - b)[Math.floor(offs.length * 0.9)].toFixed(2) : null,
      median_offness_distfloor_px: median(offsD) == null ? null : +median(offsD).toFixed(2),
    };
  });

  // ── fine curve (0.05 r_norm steps) of median off-ness → crossing of 2*FWHM ──
  const fineFor = (cut) => {
    const out = [];
    for (let lo = 0; lo < 1.0; lo += 0.05) {
      const hi = lo + 0.05;
      const sub = rows.filter((r) => r.mag <= cut && r.r_norm >= lo && r.r_norm < hi);
      const offs = sub.map((r) => r.offness_px);
      const offsD = sub.map((r) => r.offness_dist_px);
      out.push({ r_lo: +lo.toFixed(2), r_hi: +hi.toFixed(2), r_mid: +(lo + 0.025).toFixed(3), n: offs.length, median_offness_px: median(offs) == null ? null : +median(offs).toFixed(2), median_offness_distfloor_px: median(offsD) == null ? null : +median(offsD).toFixed(2) });
    }
    return out;
  };
  const crossing = (fine, key) => {
    // first r_mid where median (key) rises above TOL (interpolate between bin centers)
    let prev = null;
    for (const f of fine) {
      if (f[key] == null) { prev = null; continue; }
      if (f[key] >= TOL) {
        if (prev && prev[key] < TOL) {
          const t = (TOL - prev[key]) / (f[key] - prev[key]);
          return +(prev.r_mid + t * (f.r_mid - prev.r_mid)).toFixed(3);
        }
        return f.r_mid; // already above at first populated bin
      }
      prev = f;
    }
    return null; // never crosses within frame
  };

  const results = {};
  for (const cut of CUTS) { const fine = fineFor(cut); results[`G<=${cut}`] = { table: tableFor(cut), fine_curve: fine, offness_crosses_2fwhm_at_r_norm: crossing(fine, 'median_offness_px'), distfloor_crosses_2fwhm_at_r_norm: crossing(fine, 'median_offness_distfloor_px') }; }

  // ── PLOT: off-ness (median px) vs r_norm for each cut, with 2*FWHM line ──
  const PW = 900, PH = 560, ML = 80, MR = 30, MT = 40, MB = 60;
  const plotW = PW - ML - MR, plotH = PH - MT - MB;
  const bytes = new Uint8Array(PW * PH * 3); bytes.fill(18); // dark bg
  // y-axis max: cap to a readable range but show crossing; use max median across cuts *1.1
  let ymax = TOL * 1.2;
  for (const cut of CUTS) for (const f of results[`G<=${cut}`].fine_curve) if (f.median_offness_px != null && f.median_offness_px > ymax) ymax = f.median_offness_px;
  ymax = Math.min(ymax, 260); // clamp so the crossing region is legible
  const X = (r) => ML + r * plotW;                       // r_norm 0..1
  const Y = (v) => MT + plotH - Math.min(v, ymax) / ymax * plotH;
  // axes
  drawPolyline(bytes, PW, PH, [[ML, MT], [ML, MT + plotH], [ML + plotW, MT + plotH]], [160, 160, 170], 1);
  // gridlines + y labels (drawn as tick marks; numeric labels omitted—values in JSON)
  for (let gy = 0; gy <= 4; gy++) { const v = ymax * gy / 4; const yy = Y(v); drawPolyline(bytes, PW, PH, [[ML - 5, yy], [ML, yy]], [120, 120, 130], 1); drawPolyline(bytes, PW, PH, [[ML, yy], [ML + plotW, yy]], [45, 45, 52], 0.6); }
  for (let gx = 0; gx <= 10; gx++) { const xx = X(gx / 10); drawPolyline(bytes, PW, PH, [[xx, MT + plotH], [xx, MT + plotH + 5]], [120, 120, 130], 1); }
  // 2*FWHM tolerance line (red dashed-ish)
  const tolY = Y(TOL);
  for (let xx = ML; xx < ML + plotW; xx += 12) drawPolyline(bytes, PW, PH, [[xx, tolY], [xx + 6, tolY]], [235, 70, 70], 0.95);
  // owner-bin boundaries (faint vertical)
  for (const rb of [0.3, 0.5, 0.7]) { const xx = X(rb); for (let yy = MT; yy < MT + plotH; yy += 10) plotPoint(bytes, PW, PH, xx, yy, [80, 80, 95], 0.5); }
  // curves: actual receipt global-linear off-ness (solid, bright) + pure-distortion floor (dim)
  const CURVE_COLORS = { 11: [80, 200, 255], 13: [255, 200, 70] };
  for (const cut of CUTS) {
    const rgb = CURVE_COLORS[cut] || [200, 200, 200];
    const dim = rgb.map((v) => Math.round(v * 0.5));
    // distortion floor first (dimmer, drawn under)
    const ptsD = results[`G<=${cut}`].fine_curve.filter((f) => f.median_offness_distfloor_px != null).map((f) => [X(f.r_mid), Y(f.median_offness_distfloor_px)]);
    drawPolyline(bytes, PW, PH, ptsD, dim, 0.9);
    // actual off-ness
    const pts = results[`G<=${cut}`].fine_curve.filter((f) => f.median_offness_px != null).map((f) => [X(f.r_mid), Y(f.median_offness_px)]);
    drawPolyline(bytes, PW, PH, pts, rgb, 0.95);
    for (const p of pts) { plotPoint(bytes, PW, PH, p[0], p[1], rgb, 1); plotPoint(bytes, PW, PH, p[0] + 1, p[1], rgb, 0.9); plotPoint(bytes, PW, PH, p[0], p[1] + 1, rgb, 0.9); }
  }
  // ── labels ──
  const WHITE = [210, 210, 218], GREY = [150, 150, 160];
  drawText(bytes, PW, PH, ML, 12, `${FRAME} global-linear off-ness vs r_norm`, WHITE, 2);
  // y-axis tick values
  for (let gy = 0; gy <= 4; gy++) { const v = ymax * gy / 4; const yy = Y(v); drawText(bytes, PW, PH, 8, yy - 5, String(Math.round(v)), GREY, 2); }
  // x-axis tick values
  for (const rv of [0, 0.3, 0.5, 0.7, 1.0]) drawText(bytes, PW, PH, X(rv) - 8, MT + plotH + 12, rv.toFixed(1), GREY, 2);
  drawText(bytes, PW, PH, ML + plotW / 2 - 30, PH - 14, 'r norm', GREY, 2);
  drawText(bytes, PW, PH, 6, MT - 26, 'median off px', GREY, 2);
  // tolerance label at the red line
  drawText(bytes, PW, PH, ML + plotW - 90, tolY - 14, `2xFWHM ${TOL.toFixed(1)}`, [235, 90, 90], 2);
  // legend
  let ly = MT + 6;
  for (const cut of CUTS) { const rgb = CURVE_COLORS[cut] || [200, 200, 200]; drawPolyline(bytes, PW, PH, [[ML + 12, ly + 4], [ML + 40, ly + 4]], rgb, 1); drawText(bytes, PW, PH, ML + 46, ly, `Gle${cut} actual`, rgb, 2); ly += 16; const dim = rgb.map((v) => Math.round(v * 0.5)); drawPolyline(bytes, PW, PH, [[ML + 12, ly + 4], [ML + 40, ly + 4]], dim, 1); drawText(bytes, PW, PH, ML + 46, ly, `Gle${cut} dist floor`, dim, 2); ly += 16; }
  const pngPath = path.join(OUT, `${FRAME}_offness_curve.png`);
  writePNG(pngPath, bytes, PW, PH);

  const summary = {
    frame: FRAME, generated: new Date().toISOString(),
    lane: 'tools/mesh/radial_offness.mjs (LAW-4 incubator, banked-data only)',
    regime: 'ASSISTED-ORACLE (a.net SIP = oracle-truth pixel; solve global-linear WCS = predictor graded; NEVER pooled with blind stats)',
    inputs: { dims: dimsP, meta: A('--meta'), oracle_wcs: A('--oracle-wcs'), dets: A('--dets'), stars: STARS },
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: FWHM, tol_2fwhm_px: +TOL.toFixed(2), n_detections: dets.length },
    predictor: { mode: 'solve global-linear (capture-meta receipt wcs, no SIP)', crval_deg: [meta.wcs.CRVAL1, meta.wcs.CRVAL2] },
    oracle: { crval_deg: oracle.crval, sip_order: oracle.a_order, ap_order: oracle.ap_order },
    catalog_bright_in_frame: { [`G<=${MAXCUT}`]: rows.length },
    plot_note: 'X = r_norm 0..1; Y = median off-ness px (clamped 260 for legibility); red dashed = 2*FWHM tolerance; vertical faint marks at owner bins 0.3/0.5/0.7. Bright curves = ACTUAL receipt global-linear off-ness (cyan G<=11, gold G<=13); dim curves = pure-distortion floor (best-possible global-linear).',
    curves_explained: { offness_px: 'ACTUAL: |receipt global-linear predicted pos - oracle SIP truth| = what the beach solve global-linear WCS actually strands (distortion + receipt pointing/scale error)', offness_distfloor_px: 'FLOOR: |oracle crval+CD linear (SIP off) - oracle SIP truth| = pure lens distortion; the residual ANY global-linear must miss regardless of pointing quality' },
    results,
    overlay_png: pngPath,
  };
  fs.writeFileSync(path.join(OUT, `${FRAME}_radial_offness.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, `${FRAME}_radial_offness_rows.json`), JSON.stringify({ frame: FRAME, tol_2fwhm_px: TOL, n: rows.length, rows }, null, 2));

  // console report
  console.log(`[${FRAME}] bright catalog in-frame (G<=${MAXCUT}): ${rows.length}; detections ${dets.length}; FWHM ${FWHM} 2*FWHM=${TOL.toFixed(2)}px scale ${scaleArcsec.toFixed(2)}"/px`);
  for (const cut of CUTS) {
    const R = results[`G<=${cut}`];
    console.log(`\n  === G<=${cut} ===  (ACTUAL off-ness crosses 2*FWHM at r_norm ${R.offness_crosses_2fwhm_at_r_norm}; pure-distortion FLOOR crosses at r_norm ${R.distfloor_crosses_2fwhm_at_r_norm})`);
    console.log('  r_norm     cat    det   match matchOK detFrac matchFrac medOff  p90Off  distFloor');
    for (const t of R.table) console.log(`  ${t.bin.padEnd(9)} ${String(t.catalog).padStart(6)} ${String(t.detected).padStart(5)} ${String(t.matched).padStart(5)} ${String(t.matched_correct).padStart(6)} ${String(t.detected_frac).padStart(7)} ${String(t.matched_frac).padStart(8)} ${String(t.median_offness_px).padStart(6)} ${String(t.p90_offness_px).padStart(6)} ${String(t.median_offness_distfloor_px).padStart(8)}`);
  }
  console.log(`\n  overlay -> ${pngPath}`);
}
main();
