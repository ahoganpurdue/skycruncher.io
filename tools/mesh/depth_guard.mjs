// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — forced-harvest DEPTH extension × catalog DENSITY GUARD (paired)
// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH INCUBATOR (LAW-4, tools/ only, banked data only — nothing feeds a
// solve, no engine wiring, no constants moved). ASSISTED-ORACLE regime: the
// a.net SIP .wcs is used BOTH to PREDICT catalog positions and as the GRADING
// TRUTH. That isolates the phenomena the two levers target (depth-driven
// CONFUSION + low-SNR centroid drift) from WCS pointing error — the centroid is
// measured from ACTUAL PIXELS, independent of the WCS, so "did we grab the right
// star's flux" stays a real pixel-driven test. NEVER pooled with blind stats.
//
// LEVER A (depth): sweep catalog depth past the engine's current forced-harvest
//   floor (SOLVER_DEEP_HARVEST_MAG_MAX = G<=12.5, src/engine/pipeline/constants/
//   pipeline_config.ts:358). Per mag-step: targets · SNR>=floor measurable ·
//   oracle-graded false-attribution rate · cumulative real per-star products.
// LEVER B v1 (binary density guard): beam radius = detection FWHM px (scale-
//   aware); catalog multiplicity>1 inside the beam => REFUSE (NOT-ATTRIBUTABLE).
// LEVER B v2 (catalog-informed contamination budget — owner mid-flight spec):
//   per beam, fit the frame photometric zero point (catalog G vs measured
//   instrumental mag on bright isolated stars) -> convert the beam's local noise
//   into a limiting mag -> split beam members above/below floor -> attribute with
//   a dominance rule + contamination bound, refuse only unresolvable blends.
//
// GRADE (all arms, identical): a SNR-accepted forced measurement claiming star X
//   (predicted at oracle-truth (px,py)) is graded by the flux-weighted centroid
//   drift d = |centroid - (px,py)|. TRUE if d <= 2*FWHM, else FALSE. This is the
//   SAME definition as grade_oracle.mjs false_completion_2fwhm — so numbers are
//   directly comparable to the banked ~3% (M66 inner) / 64% (beach) baselines.
//
//   node tools/mesh/depth_guard.mjs --frame M66 \
//     --buffer <native f32 w*h> --dims <WxH json or W H> --wcs <a.net .wcs> \
//     --stars stars.arrow --fwhm 2.3 --floor 12.5 --depths 12.5,13.5,14.5,15 \
//     [--measure-cap 40000] [--one-step 13.5] [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, forcedMeasure } from '../psf/forced_detect.mjs';
import { makeStretch, downscaleRGB, plotPoint, writePNG } from '../psf/imaging.mjs';

const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const D2R = Math.PI / 180;
const SNR_FLOOR = 2; // matches SOLVER_DEEP_HARVEST_SNR_THRESHOLD

// ── a.net SIP .wcs parse + sky->pixel (COPIED verbatim from grade_oracle.mjs so
//    the prediction/grading projection is BYTE-for-byte the banked oracle grader) ──
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
  return { crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2], cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]], A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'), a_order: order('A'), ap_order: order('AP'), imagew: c.IMAGEW, imageh: c.IMAGEH };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }
function makeSkyToPixel(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
  const useInv = w.ap_order >= 2;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]);
    if (!p) return null;
    const U = (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det;
    const V = (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    let x, y;
    if (useInv) { x = w.crpix[0] + U + poly(w.AP, U, V); y = w.crpix[1] + V + poly(w.BP, U, V); }
    else { let ox = U, oy = V; for (let it = 0; it < 12; it++) { const nx = U - poly(w.A, ox, oy), ny = V - poly(w.B, ox, oy); if (Math.abs(nx - ox) < 1e-3 && Math.abs(ny - oy) < 1e-3) { ox = nx; oy = ny; break; } ox = nx; oy = ny; } x = w.crpix[0] + ox; y = w.crpix[1] + oy; }
    return { x, y };
  };
}

// ── spatial grid (id-tagged) for multiplicity + nearest-catalog attribution ──
function buildGrid(pts, cell) { const map = new Map(); for (let i = 0; i < pts.length; i++) { const k = (pts[i].x / cell | 0) * 100003 + (pts[i].y / cell | 0); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); } return { map, cell, pts }; }
function nearest(grid, x, y, radius) { const { map, cell, pts } = grid; const reach = Math.ceil(radius / cell); const gx = x / cell | 0, gy = y / cell | 0; let best = -1, bd = radius * radius; for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const pi of a) { const d2 = (pts[pi].x - x) ** 2 + (pts[pi].y - y) ** 2; if (d2 < bd) { bd = d2; best = pi; } } } return { idx: best, dist: best >= 0 ? Math.sqrt(bd) : Infinity }; }
// members within radius (returns indices), self detected by |d|<1e-6
function membersWithin(grid, x, y, radius) { const { map, cell, pts } = grid; const reach = Math.ceil(radius / cell); const gx = x / cell | 0, gy = y / cell | 0; const r2 = radius * radius; const out = []; for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const pi of a) { const d2 = (pts[pi].x - x) ** 2 + (pts[pi].y - y) ** 2; if (d2 <= r2) out.push(pi); } } return out; }

// ── pixel helpers (mirror mesh_legB.mjs primitives) ──
function pixelNoiseSigma(L, maxN = 200000) { const step = Math.max(1, Math.floor(L.length / maxN)); const d = []; for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i])); d.sort((a, b) => a - b); return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2); }
// flux-weighted centroid in box +-R about (cx,cy), bg-subtracted, thr=1.5*sigma.
function fluxCentroid(L, w, h, cx, cy, bg, sigma, R) { let sw = 0, sx = 0, sy = 0; const x0 = Math.round(cx), y0 = Math.round(cy); for (let dy = -R; dy <= R; dy++) { const Y = y0 + dy; if (Y < 1 || Y >= h - 1) continue; for (let dx = -R; dx <= R; dx++) { const X = x0 + dx; if (X < 1 || X >= w - 1) continue; const t = L[Y * w + X] - bg; if (t > 1.5 * sigma) { sw += t; sx += t * X; sy += t * Y; } } } return sw > 0 ? { x: sx / sw, y: sy / sw } : null; }

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
// robust linear fit y = a + b*x with one 3-sigma clip round (least squares)
function robustLinFit(xs, ys) {
  const fit = (idx) => { let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; for (const i of idx) { n++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; } const d = n * sxx - sx * sx; if (Math.abs(d) < 1e-12) return null; const b = (n * sxy - sx * sy) / d, a = (sy - b * sx) / n; return { a, b, n }; };
  let idx = xs.map((_, i) => i);
  let f = fit(idx); if (!f) return null;
  const res = idx.map((i) => ys[i] - (f.a + f.b * xs[i]));
  const ar = res.map(Math.abs).sort((p, q) => p - q); const mad = 1.4826 * ar[ar.length >> 1] || 1e-6;
  idx = idx.filter((i) => Math.abs(ys[i] - (f.a + f.b * xs[i])) <= 3 * mad);
  const f2 = fit(idx) || f;
  let ss = 0; for (const i of idx) { const r = ys[i] - (f2.a + f2.b * xs[i]); ss += r * r; }
  return { a: f2.a, b: f2.b, n: f2.n, rms: Math.sqrt(ss / Math.max(1, idx.length)) };
}
// mulberry32 seeded RNG (reproducible subsample)
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// LINEAR sky->pixel from a capture-meta wcs object {CRVAL1,CRVAL2,CRPIX1,CRPIX2,
// CD1_1..CD2_2}. This is the SOLVE-side predictor the engine's deep harvest would
// use post-solve (no SIP — realistic coarse pointing). Same pixel frame as the
// buffer + the oracle (all solved the same detection xylist).
function makeLinearSky2Pix(w) {
  const det = w.CD1_1 * w.CD2_2 - w.CD1_2 * w.CD2_1;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.CRVAL1, w.CRVAL2);
    if (!p) return null;
    const x = w.CRPIX1 + (w.CD2_2 * p.xi - w.CD1_2 * p.eta) / det;
    const y = w.CRPIX2 + (-w.CD2_1 * p.xi + w.CD1_1 * p.eta) / det;
    return { x, y };
  };
}

function main() {
  const FRAME = A('--frame', 'frame');
  const BUFFER = A('--buffer');
  const WCSP = A('--wcs');
  const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const FLOOR = Number(A('--floor', '12.5'));
  const DEPTHS = A('--depths', '12.5,13.5,14.5,15').split(',').map(Number).sort((a, b) => a - b);
  const MAXD = DEPTHS[DEPTHS.length - 1];
  const MEASURE_CAP = parseInt(A('--measure-cap', '40000'), 10);
  const ONE_STEP = A('--one-step', null) ? Number(A('--one-step')) : null; // one-frame-first: harvest a SINGLE cumulative depth
  const OUT = A('--out', 'D:/AstroLogic/test_artifacts/depth_guard_2026-07-22');
  fs.mkdirSync(OUT, { recursive: true });

  // dims
  let W, H; const dimsArg = A('--dims');
  if (dimsArg && fs.existsSync(dimsArg)) { const d = JSON.parse(fs.readFileSync(dimsArg, 'utf8')); W = d.width; H = d.height; }
  else if (dimsArg) { const [a, b] = dimsArg.split('x').map(Number); W = a; H = b; }
  else { W = parseInt(A('--w'), 10); H = parseInt(A('--h'), 10); }

  const wcs = parseAnetWcs(WCSP);          // ORACLE (a.net SIP) — the GRADING truth
  const sky2pix = makeSkyToPixel(wcs);     // sky -> oracle-truth pixel
  const scaleArcsec = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0])) * 3600;
  // SOLVE-side predictor: the realistic post-solve WCS the engine harvest uses.
  // Pass a capture-meta JSON (its .wcs object). Omit -> fall back to the oracle
  // (best-case reference arm, isolates pure confusion from pointing error).
  const SOLVEP = A('--solve-wcs', null);
  let solve2pix = sky2pix, predictor = 'ORACLE (best-case reference)';
  if (SOLVEP) { const sw = JSON.parse(fs.readFileSync(SOLVEP, 'utf8')).wcs; solve2pix = makeLinearSky2Pix(sw); predictor = `SOLVE linear WCS (${path.basename(SOLVEP)})`; }
  const FWHM = Number(A('--fwhm', '2.3'));
  const tol2 = 2 * FWHM;              // grading tolerance
  const beamR = FWHM;                 // Lever B beam radius = detection FWHM (scale-aware)
  const Rcen = Math.max(4, Math.ceil(2.5 * FWHM)); // centroid box (> tol2 so drift can exceed tolerance)
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

  // ── load buffer ──
  const raw = fs.readFileSync(BUFFER);
  const L = new Float32Array(raw.buffer, raw.byteOffset, W * H);
  if (L.length !== W * H) throw new Error(`buffer ${L.length} != W*H ${W * H}`);
  const sigmaPix = pixelNoiseSigma(L);

  // ── project ALL g15u <= MAXD: predicted (SOLVE) + oracle-truth (GRADER) ──
  // in-frame filter is on the PREDICTED position (where the harvest measures).
  // x,y = predicted (solve) pixel; ox,oy = oracle-truth pixel.
  const coneR = Math.min(89, Math.atan(hd * (scaleArcsec / 3600) * D2R) / D2R + 2);
  const allStars = regionStars({ starsArrowPath: STARS, raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg: coneR, magLimit: MAXD });
  const proj = [];
  for (const s of allStars) {
    const p = solve2pix(s.ra_deg, s.dec_deg); if (!p) continue;
    if (p.x < 10 || p.y < 10 || p.x >= W - 10 || p.y >= H - 10) continue; // in-frame on PREDICTED
    const o = sky2pix(s.ra_deg, s.dec_deg); if (!o) continue;
    proj.push({ id: s.gaia_id, mag: s.mag, x: p.x, y: p.y, ox: o.x, oy: o.y });
  }
  const catGrid = buildGrid(proj, Math.max(8, Math.ceil(beamR))); // catalog grid in PREDICTED space
  const inFrame = proj.length;
  const densPerPx = inFrame / (W * H);
  const perBeamExpected = densPerPx * Math.PI * beamR * beamR; // mean catalog stars in a beam
  // predictor accuracy vs oracle (median pointing error of the solve WCS)
  const predErr = proj.map((s) => Math.hypot(s.x - s.ox, s.y - s.oy));
  const predErrMed = median(predErr), predErrP90 = predErr.length ? [...predErr].sort((a, b) => a - b)[Math.floor(predErr.length * 0.9)] : null;

  // ── PHOTOMETRIC ZERO POINT (v2): bright isolated catalog stars, G vs instmag ──
  // Saturation guard: bright-star cores clip in stacked frames, flattening the
  // bright end (slope << 1). Estimate a ceiling and drop ZP stars whose local
  // peak is clipped, so the fit reflects the LINEAR photometric regime.
  const ceilSamp = []; { const step = Math.max(1, Math.floor(L.length / 300000)); for (let i = 0; i < L.length; i += step) ceilSamp.push(L[i]); ceilSamp.sort((a, b) => a - b); }
  const bufCeil = ceilSamp[Math.floor(ceilSamp.length * 0.99995)];
  const peakAt = (x, y, R = 3) => { let m = -Infinity; const x0 = Math.round(x), y0 = Math.round(y); for (let dy = -R; dy <= R; dy++) { const Y = y0 + dy; if (Y < 0 || Y >= H) continue; for (let dx = -R; dx <= R; dx++) { const X = x0 + dx; if (X < 0 || X >= W) continue; const v = L[Y * W + X]; if (v > m) m = v; } } return m; };
  // These stacked/luminance buffers are photometrically NON-LINEAR (saturated
  // bright cores + noisy faint fluxes), so a linear G-vs-instmag ZP mis-fits.
  // Instead build a MONOTONIC flux<->mag calibration: bin clean isolated stars by
  // G, median log-flux per bin, isotonic (pool-adjacent-violators) so log-flux is
  // non-increasing in G. Robust to any monotonic buffer response.
  // Calibration stars span the FULL harvest range (isolated, unsaturated),
  // anchoring bright AND faint ends so limiting-mag interpolates within-range.
  // snr>=3 (not 5) keeps faint bins populated; median-per-bin smooths noise.
  const zpStars = proj.filter((s) => s.mag <= MAXD - 0.25);
  const zpPairs = []; let zpSaturated = 0, zpProbed = 0;
  for (const s of zpStars) {
    const mult = membersWithin(catGrid, s.x, s.y, beamR).length; // incl self
    if (mult > 1) continue; // isolated only
    zpProbed++;
    if (peakAt(s.ox, s.oy) >= 0.92 * bufCeil) { zpSaturated++; continue; } // clipped core
    const fm = forcedMeasure({ L, w: W, h: H, positions: [{ x: s.ox, y: s.oy }], fwhmPx: FWHM, snrThreshold: 0, sigmaPix });
    const r = fm.results[0]; if (!r || !(r.flux > 0) || r.snr < 3) continue;
    zpPairs.push({ G: s.mag, lf: Math.log10(r.flux) });
  }
  // bin by 0.5 mag, median log-flux, require >=3
  const zbin = new Map();
  for (const p of zpPairs) { const b = Math.round(p.G / 0.5) * 0.5; let a = zbin.get(b); if (!a) { a = []; zbin.set(b, a); } a.push(p.lf); }
  let calib = [...zbin.entries()].filter(([, a]) => a.length >= 3).map(([G, a]) => ({ G, lf: median(a) })).sort((a, b) => a.G - b.G);
  // isotonic: log-flux non-increasing in G (pool adjacent violators, weight=1)
  for (let pass = 0; pass < calib.length; pass++) { let ok = true; for (let i = 1; i < calib.length; i++) { if (calib[i].lf > calib[i - 1].lf) { const m = (calib[i].lf + calib[i - 1].lf) / 2; calib[i].lf = m; calib[i - 1].lf = m; ok = false; } } if (ok) break; }
  const calibOK = calib.length >= 3;
  const interp = (xs, ys, x) => { if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1); return ys[i - 1] + t * (ys[i] - ys[i - 1]); } return ys[ys.length - 1]; };
  const gArr = calibOK ? calib.map((c) => c.G) : null, lfArr = calibOK ? calib.map((c) => c.lf) : null;
  const lfDesc = calibOK ? [...lfArr].reverse() : null, gDescByLf = calibOK ? [...gArr].reverse() : null; // lf ascending for interp on flux
  const fluxOfMag = calibOK ? (m) => Math.pow(10, interp(gArr, lfArr, m)) : null;         // G -> flux
  const magOfFlux = calibOK ? (F) => interp(lfDesc, gDescByLf, Math.log10(F)) : null;      // flux -> G
  const zp = calibOK ? { mode: 'isotonic_binned', n_bins: calib.length, G_range: [calib[0].G, calib[calib.length - 1].G], n_pairs: zpPairs.length, saturated_excluded: zpSaturated, probed_isolated: zpProbed } : null;

  // ── target set: harvest depths. One-step mode measures ONE cumulative depth. ──
  const targetsAll = ONE_STEP != null ? proj.filter((s) => s.mag <= ONE_STEP) : proj;
  // subsample to cap (seeded), preserving per-mag proportions in expectation
  let targets = targetsAll;
  let sampled = false, sampleFrac = 1;
  if (targetsAll.length > MEASURE_CAP) { const rng = mulberry32(0x5c9a); sampleFrac = MEASURE_CAP / targetsAll.length; targets = targetsAll.filter(() => rng() < sampleFrac); sampled = true; }

  // ── measure + grade + guard every target ──
  const recs = [];
  for (const s of targets) {
    const fm = forcedMeasure({ L, w: W, h: H, positions: [{ x: s.x, y: s.y }], fwhmPx: FWHM, snrThreshold: SNR_FLOOR, sigmaPix });
    const r = fm.results[0]; if (!r) continue;
    const accepted = r.accepted;
    const noise = r.snr !== 0 ? Math.abs(r.flux / r.snr) : Infinity;
    // guard v1: multiplicity within beam (incl self)
    const beamMembers = membersWithin(catGrid, s.x, s.y, beamR);
    const mult = beamMembers.length;
    const v1_pass = mult <= 1;
    // guard v2: catalog-informed contamination budget — TARGET-CENTRIC. The
    // question is "can THIS target s own the measured flux?" -> attribute to s
    // only when s is the (co-)dominant beam member; refuse if a brighter member
    // dominates (the flux is the neighbour's, not s's).
    let v2 = { decision: 'INVALID', reason: 'no_zp', m_lim: null, n_above: null, n_below: null, dm: null, f: null };
    if (zp && fluxOfMag) {
      const Flim = SNR_FLOOR * noise; const mLim = magOfFlux(Flim);
      const mem = beamMembers.map((i) => proj[i]).sort((a, b) => a.mag - b.mag); // brightest first
      const above = mem.filter((m) => m.mag <= mLim);
      const below = mem.filter((m) => m.mag > mLim);
      const sumSub = below.reduce((a, m) => a + fluxOfMag(m.mag), 0);
      const fS = fluxOfMag(s.mag);
      const othersFlux = mem.filter((m) => m.id !== s.id).reduce((a, m) => a + fluxOfMag(m.mag), 0);
      const sAbove = s.mag <= mLim;
      const sIsBrightest = mem.length && mem[0].id === s.id;
      const dmTop = mem.length >= 2 ? mem[1].mag - mem[0].mag : Infinity; // gap top-two
      const base = { m_lim: +mLim.toFixed(2), n_above: above.length, n_below: below.length, dm: Number.isFinite(dmTop) ? +dmTop.toFixed(2) : null, f: +(othersFlux / Math.max(fS, 1e-9)).toFixed(4) };
      if (!sAbove) v2 = { decision: 'REFUSE', reason: 'target_below_beam_floor', ...base };
      else if (above.length === 1) { // s is the sole above-floor member
        v2 = (sumSub < noise) ? { decision: 'ATTRIBUTE', to: s.id, reason: 'sole_above_subfloor_quiet', ...base } : { decision: 'REFUSE', reason: 'subfloor_flux_exceeds_noise', ...base };
      } else { // multiple above floor
        if (sIsBrightest && dmTop >= 2.5) v2 = { decision: 'ATTRIBUTE', to: s.id, reason: 'target_dominant', ...base };
        else v2 = { decision: 'REFUSE', reason: sIsBrightest ? 'unresolvable_blend' : 'brighter_member_dominates', ...base };
      }
      // validity: frame limiting mag deeper than catalog depth
      if (mLim > MAXD + 0.01) v2.invalid_catalog_shallower = true;
    }
    // grade (accepted only): measure at PREDICTED (s.x,s.y); centroid there; drift
    // vs the star's ORACLE-truth position (s.ox,s.oy). TRUE if drift <= 2*FWHM.
    let mx = null, my = null, dTrue = null, trueAttr = null, nearId = null, attrMatch = null, mLimForValidity = v2.m_lim;
    if (accepted) {
      const cen = fluxCentroid(L, W, H, s.x, s.y, r.bg, r.sigma_local, Rcen);
      if (cen) { mx = cen.x; my = cen.y; dTrue = Math.hypot(mx - s.ox, my - s.oy); trueAttr = dTrue <= tol2; const nn = nearest(catGrid, mx, my, tol2); nearId = nn.idx >= 0 ? proj[nn.idx].id : null; attrMatch = nearId === s.id; }
      else { trueAttr = false; attrMatch = false; } // accepted but uncentroidable -> conservative FALSE
    }
    recs.push({ id: s.id, mag: s.mag, x: +s.x.toFixed(2), y: +s.y.toFixed(2), ox: +s.ox.toFixed(2), oy: +s.oy.toFixed(2), r_norm: +rNorm(s.x, s.y).toFixed(3), pred_err_px: +Math.hypot(s.x - s.ox, s.y - s.oy).toFixed(2), snr: +r.snr.toFixed(2), flux: +r.flux.toFixed(2), noise: +noise.toFixed(3), structured: r.structured, accepted, mult, v1_pass, v2, mx: mx == null ? null : +mx.toFixed(2), my: my == null ? null : +my.toFixed(2), dTrue: dTrue == null ? null : +dTrue.toFixed(2), trueAttr, attrMatch, mLim: mLimForValidity });
  }

  // ── LEVER A: per cumulative-depth stats (ungated) ──
  const depthRows = DEPTHS.map((D, i) => {
    const lo = i === 0 ? -Infinity : DEPTHS[i - 1];
    const band = recs.filter((r) => r.mag > lo && r.mag <= D);       // incremental band
    const cum = recs.filter((r) => r.mag <= D);                      // cumulative
    const measB = band.filter((r) => r.accepted), measC = cum.filter((r) => r.accepted);
    const falseB = measB.filter((r) => r.trueAttr === false).length;
    const falseC = measC.filter((r) => r.trueAttr === false).length;
    const realC = measC.filter((r) => r.trueAttr === true).length;   // cumulative real per-star products
    return {
      cumulative_depth_G: D, band: `${lo === -Infinity ? '<=' : '(' + lo.toFixed(1) + ','}${lo === -Infinity ? D.toFixed(1) : D.toFixed(1) + ']'}`,
      band_targets: band.length, band_measurable: measB.length, band_measurable_frac: band.length ? +(measB.length / band.length).toFixed(3) : null,
      band_false_rate: measB.length ? +(falseB / measB.length).toFixed(3) : null,
      cum_targets: cum.length, cum_measurable: measC.length, cum_false_rate: measC.length ? +(falseC / measC.length).toFixed(3) : null,
      cum_real_products: realC,
    };
  });

  // ── LEVER B: guard comparison among MEASURABLE (at full MAXD or ONE_STEP depth) ──
  // TWO grades: POSITION (trueAttr; centroid within 2*FWHM of oracle truth — the
  // campaign convention) and ATTRIBUTION (attrMatch; centroid's nearest catalog
  // star IS the claimed one — the blend-contamination test the density guard
  // actually targets; meaningful under the ORACLE predictor where centroid≈truth).
  const meas = recs.filter((r) => r.accepted);
  const rate = (arr) => arr.length ? +(arr.filter((r) => r.trueAttr === false).length / arr.length).toFixed(3) : null;       // POSITION false rate
  const rateA = (arr) => arr.length ? +(arr.filter((r) => r.attrMatch === false).length / arr.length).toFixed(3) : null;     // ATTRIBUTION false rate
  const v1pass = meas.filter((r) => r.v1_pass), v1ref = meas.filter((r) => !r.v1_pass);
  const v2att = meas.filter((r) => r.v2.decision === 'ATTRIBUTE'), v2ref = meas.filter((r) => r.v2.decision === 'REFUSE');
  const v2recovered = meas.filter((r) => r.v2.decision === 'ATTRIBUTE' && !r.v1_pass); // v1 would refuse, v2 attributes
  const guard = {
    ungated: { n: meas.length, false_rate_position: rate(meas), false_rate_attribution: rateA(meas) },
    v1_binary: { passed_n: v1pass.length, passed_false_rate_position: rate(v1pass), passed_false_rate_attribution: rateA(v1pass), refused_n: v1ref.length, refused_false_rate_position: rate(v1ref), refused_false_rate_attribution: rateA(v1ref), refused_frac: meas.length ? +(v1ref.length / meas.length).toFixed(3) : null },
    v2_contamination: { attributed_n: v2att.length, attributed_false_rate_position: rate(v2att), attributed_false_rate_attribution: rateA(v2att), refused_n: v2ref.length, refused_false_rate_position: rate(v2ref), refused_false_rate_attribution: rateA(v2ref), refused_frac: meas.length ? +(v2ref.length / meas.length).toFixed(3) : null, invalid_n: meas.filter((r) => r.v2.decision === 'INVALID').length },
    v2_recovered_vs_v1: { n: v2recovered.length, false_rate_position: rate(v2recovered), false_rate_attribution: rateA(v2recovered), note: 'beams v1 REFUSED (mult>1) that v2 ATTRIBUTED; the payoff/cost of the dominance rule' },
  };

  // ── validity + limiting-mag margin ──
  const mLims = meas.map((r) => r.mLim).filter((v) => v != null);
  const validity = { photometric_calibration: zp ? { ...zp, G_range: zp.G_range.map((v) => +v.toFixed(2)), note: 'monotonic isotonic flux<->mag calibration (robust to non-linear buffer response); v2 limiting-mag interpolates this' } : { mode: 'FAILED', note: 'too few clean isolated bright stars for a calibration -> v2 arm INVALID on this frame' }, median_beam_limiting_mag: mLims.length ? +median(mLims).toFixed(2) : null, catalog_depth_G: MAXD, invalid_catalog_shallower_frac: meas.length ? +(meas.filter((r) => r.v2.invalid_catalog_shallower).length / meas.length).toFixed(3) : null };

  // ── OVERLAY PNG: guard-refused / passed-true / passed-false / v2-recovered ──
  const outW = 1200; const stretch = makeStretch([L]); stretch.lo = [stretch.lo[0], stretch.lo[0], stretch.lo[0]]; stretch.hi = [stretch.hi[0], stretch.hi[0], stretch.hi[0]];
  const ds = downscaleRGB(L, L, L, W, H, outW, stretch); const sc = ds.scale;
  const mark = (x, y, rgb, rad = 2) => { for (let dx = -rad; dx <= rad; dx++) { plotPoint(ds.bytes, ds.ow, ds.oh, x + dx, y, rgb); plotPoint(ds.bytes, ds.ow, ds.oh, x, y + dx, rgb); } };
  // draw order: refused (dim red-brown) < passed-false (magenta) < passed-true (green) < v2-recovered (cyan)
  for (const r of meas) if (!r.v1_pass && !(r.v2.decision === 'ATTRIBUTE')) mark(r.x * sc, r.y * sc, [120, 70, 40], 1); // guard-refused (both) = brown
  for (const r of meas) if (r.v1_pass && r.trueAttr === false) mark(r.x * sc, r.y * sc, [255, 60, 200], 2); // passed-false = magenta
  for (const r of meas) if (r.v1_pass && r.trueAttr === true) mark(r.x * sc, r.y * sc, [60, 230, 90], 2); // passed-true = green
  for (const r of meas) if (r.v2.decision === 'ATTRIBUTE' && !r.v1_pass) mark(r.x * sc, r.y * sc, [40, 210, 230], 2); // v2-recovered = cyan
  const pngPath = path.join(OUT, `${FRAME}_depth_guard_overlay.png`);
  writePNG(pngPath, ds.bytes, ds.ow, ds.oh);

  const summary = {
    frame: FRAME, generated: new Date().toISOString(), lane: 'tools/mesh/depth_guard.mjs (research incubator, LAW-4)',
    regime: 'ASSISTED-ORACLE (a.net SIP predicts AND grades; NEVER pooled with blind-solve stats)',
    inputs: { buffer: BUFFER, oracle_wcs: WCSP, solve_wcs: SOLVEP, stars: STARS },
    predictor: { mode: predictor, note: 'catalog positions PREDICTED via this WCS (where the harvest measures); graded vs the a.net SIP oracle. Solve-WCS = realistic post-solve pointing the engine harvest would have.', median_pred_err_px: predErrMed == null ? null : +predErrMed.toFixed(2), p90_pred_err_px: predErrP90 == null ? null : +predErrP90.toFixed(2) },
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: FWHM, tol_2fwhm_px: +tol2.toFixed(2), beam_radius_px: +beamR.toFixed(2), centroid_box_px: Rcen, sigma_pix: +sigmaPix.toFixed(4) },
    baseline_floor: { engine_harvest_mag_max_G: FLOOR, source: 'src/engine/pipeline/constants/pipeline_config.ts:358 (SOLVER_DEEP_HARVEST_MAG_MAX)', cap: 'SOLVER_DEEP_HARVEST_MAX_POSITIONS=500 brightest-first', snr_floor: SNR_FLOOR },
    catalog: { g15u_in_frame_le_maxD: inFrame, cone_radius_deg: +coneR.toFixed(2), max_depth_G: MAXD, density_per_px2: +densPerPx.toExponential(3), mean_catalog_stars_per_beam: +perBeamExpected.toFixed(3) },
    measurement: { one_step_depth: ONE_STEP, targets_total: targetsAll.length, targets_measured: targets.length, subsampled: sampled, sample_frac: +sampleFrac.toFixed(4), measure_cap: MEASURE_CAP },
    leverA_depth: depthRows,
    leverB_guards: guard,
    validity,
    overlay_png: pngPath,
    overlay_legend: { brown: 'guard-refused (v1 AND v2 refuse)', magenta: 'v1-passed but FALSE attribution', green: 'v1-passed and TRUE attribution', cyan: 'v2-recovered (v1 refused, v2 attributed)' },
    provenance_notes: [
      'Every measurement is CATALOG_FORCED forced photometry at oracle-predicted positions; NEVER a blind discovery, NEVER fed to a solve.',
      'Prediction and grading share the a.net SIP oracle: the centroid is pixel-derived, so false-attribution measures CONFUSION/SNR drift, not WCS error (isolated by design).',
      'false_rate = fraction of SNR-accepted measurements whose flux-weighted centroid drifts > 2*FWHM from the claimed star (identical definition to grade_oracle.mjs false_completion_2fwhm; comparable to banked ~3% M66 / 64% beach).',
    ],
  };
  const outPath = path.join(OUT, `${FRAME}_depth_guard.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, `${FRAME}_depth_guard_rows.json`), JSON.stringify({ frame: FRAME, n: recs.length, rows: recs }, null, 2));
  console.log(JSON.stringify({ frame: FRAME, image: summary.image, catalog: summary.catalog, measurement: summary.measurement, leverA_depth: depthRows, leverB_guards: guard, validity, overlay_png: pngPath, out: outPath }, null, 2));
}
main();
