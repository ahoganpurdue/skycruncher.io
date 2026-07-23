// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — QUAD-WALK PLANNER (goal-directed A* mesh cascade, LAW-4 incubator)
// ═══════════════════════════════════════════════════════════════════════════
// Owner-designed (2026-07-22). Turns the blind mesh cascade (mesh_finder.mjs)
// into a GOAL-DIRECTED A* over a catalog-precomputed quad graph, targeting
// PERIMETER-COVERAGE cells, with a RADIUS-ADAPTIVE quad-size schedule s_max(r).
//
// RESEARCH INCUBATOR (tools/ only, banked data only). NOTHING here feeds a
// solve. Every completion is a CATALOG_FORCED forced-photometry verification at
// a LOCAL-AFFINE-predicted position (never a blind discovery, never a solve
// input). ASSISTED-ORACLE grading: false-completion is scored against an EXTERNAL
// a.net SIP .wcs (the oracle truth). Results are labelled oracle-assisted and are
// NEVER pooled with blind-solve statistics.
//
// PIPELINE (owner spec):
//  1. 18-cell perimeter coverage map: outer annulus r_norm[0.75,1.0] in 12x30deg,
//     mid annulus [0.45,0.75] in 6x60deg. Per cell: (N verified, reach, precision)
//     -> GREEN (N>=10 AND reach>=0.9) / AMBER-thin (reached, under-sampled) /
//     RED (sky-visible, unwalked) / GREY (occluded; hard-coded all-sky on M66).
//  2. s_max(r) from the frame's own distortion prior (receipt BC k1/k2): budget =
//     affine-nonabsorbable curvature across one quad stays under tolCurv. s_min
//     from quad-geometry conditioning (cites mesh_finder degeneracy guard).
//  3. A*: nodes=catalog stars above the frame floor; edges=quads in [s_min,s_max(r)];
//     hop cost = risk (catalog confusion + predicted-SNR shortfall + conditioning);
//     heuristic = tangent distance to nearest unfilled goal. Plan corridors OFFLINE
//     (pure catalog), then EXECUTE with forced measurement + re-anchor per hop.
//  4. Grade on M66 vs oracle truth: per-goal-cell reached/N/reach/precision, false-
//     completion rate ON THE PLANNED CORRIDORS vs blind-BFS baseline (2.7%/20.5%).
//
//   node tools/mesh/quad_walk_planner.mjs --frame M66 \
//     --meta   D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json \
//     --buffer D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32 \
//     --oracle-wcs D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/oracle_m66/m66.wcs \
//     --blind-matches D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/M66_mesh_matches.json

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, forcedMeasure } from '../psf/forced_detect.mjs';
import { makeStretch, downscaleRGB, plotPoint, drawPolyline, writePNG } from '../psf/imaging.mjs';
import { attachTangent, fitLocalAffine } from './mesh_finder.mjs';

const D2R = Math.PI / 180;
const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const AN = (k, d) => { const v = A(k, null); return v == null ? d : parseFloat(v); };
const HAS = (k) => args.includes(k);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── oracle a.net SIP .wcs parse + sky->pixel (VERBATIM from grade_oracle.mjs so
//    grading is byte-for-byte the banked blind-BFS grader) ─────────────────────
function parseAnetWcs(wcsPath) {
  const buf = fs.readFileSync(wcsPath); const c = {};
  for (let o = 0; o + 80 <= buf.length; o += 80) {
    const card = buf.toString('latin1', o, o + 80); const k = card.slice(0, 8).trim();
    if (k === 'END') break;
    if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; }
  }
  const order = (p) => (Number.isFinite(c[`${p}_ORDER`]) ? c[`${p}_ORDER`] : 0);
  const coefMat = (p) => { const n = order(p); const m = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)); for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const key = `${p}_${i}_${j}`; if (Number.isFinite(c[key])) m[i][j] = c[key]; } return m; };
  return { crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2], cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]], A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'), a_order: order('A'), ap_order: order('AP') };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }
function makeSkyToPixel(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0]; const useInv = w.ap_order >= 2;
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

// ── pixel helpers (verbatim copies of the mesh_finder verify leaves so the
//    corridor executor's acceptance is IDENTICAL to runCascade's) ─────────────
function pixelNoiseSigma(L, maxN = 200000) { const step = Math.max(1, Math.floor(L.length / maxN)); const d = []; for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i])); d.sort((a, b) => a - b); return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2); }
function localBg(L, w, h, cx, cy) { const vals = []; const x0 = Math.round(cx), y0 = Math.round(cy); for (let r = 8; r <= 12; r += 2) for (let t = -r; t <= r; t += 2) for (const [X, Y] of [[x0 + t, y0 - r], [x0 + t, y0 + r], [x0 - r, y0 + t], [x0 + r, y0 + t]]) if (X >= 0 && Y >= 0 && X < w && Y < h) vals.push(L[Y * w + X]); if (vals.length < 8) return null; vals.sort((a, b) => a - b); return vals[vals.length >> 1]; }
function fluxCentroid(L, w, h, cx, cy, bg, sigma, R = 6) { let sw = 0, sx = 0, sy = 0; const x0 = Math.round(cx), y0 = Math.round(cy); for (let dy = -R; dy <= R; dy++) { const Y = y0 + dy; if (Y < 1 || Y >= h - 1) continue; for (let dx = -R; dx <= R; dx++) { const X = x0 + dx; if (X < 1 || X >= w - 1) continue; const v = L[Y * w + X] - bg; if (v > 1.5 * sigma) { sw += v; sx += v * X; sy += v * Y; } } } return sw > 0 ? { x: sx / sw, y: sy / sw } : null; }
function applyAffine(Af, xi, eta) { return [Af.ax * xi + Af.bx * eta + Af.cx, Af.ay * xi + Af.by * eta + Af.cy]; }

// ── tangent grid for kNN (tangent-plane deg) ────────────────────────────────
function buildTanGrid(items, cellDeg) { const map = new Map(); for (let i = 0; i < items.length; i++) { const gx = Math.floor(items[i].xi / cellDeg); const gy = Math.floor(items[i].eta / cellDeg); const k = gx * 1000003 + gy; let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); } return { map, cell: cellDeg, items }; }
function kNearest(grid, xi, eta, want, maxReach = 16) { const { map, cell, items } = grid; const gx = Math.floor(xi / cell), gy = Math.floor(eta / cell); const found = []; let reach = 1; while (reach <= maxReach) { found.length = 0; for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) { const a = map.get((gx + dx) * 1000003 + (gy + dy)); if (!a) continue; for (const pi of a) { const it = items[pi]; const d2 = (it.xi - xi) ** 2 + (it.eta - eta) ** 2; found.push({ idx: pi, d2 }); } } if (found.length >= want || reach === maxReach) break; reach++; } found.sort((a, b) => a.d2 - b.d2); return found.slice(0, want); }

// ── binary min-heap for A* ──────────────────────────────────────────────────
class MinHeap { constructor() { this.a = []; } get size() { return this.a.length; } push(item) { const a = this.a; a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } } pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, s = i; if (l < a.length && a[l].f < a[s].f) s = l; if (r < a.length && a[r].f < a[s].f) s = r; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; } }

function main() {
  const t0 = Date.now();
  const FRAME = A('--frame', 'M66');
  const META = A('--meta', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json');
  const BUFFER = A('--buffer', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32');
  const ORACLE_WCS = A('--oracle-wcs', 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/oracle_m66/m66.wcs');
  const BLIND_MATCHES = A('--blind-matches', 'D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/M66_mesh_matches.json');
  const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const OUT = A('--out', 'D:/AstroLogic/test_artifacts/quad_walk_2026-07-22');
  const MAG_LIMIT = AN('--mag-limit', 15);
  const BC_SOURCE = A('--bc-source', 'receipt'); // receipt (meta.bc_measured) | ledger (loop_ledger.final_bc)
  const TOL_CURV = AN('--tol-curv', null); // per-quad curvature budget px; default = FWHM
  const SMAX_CAP_RNORM = AN('--smax-cap-rnorm', 0.5); // cap s_max at this fraction of half-diagonal
  const KNEAR = AN('--knear', 8), KMIN = AN('--kmin', 3), SNR = AN('--snr', 5);
  const CENT_TOL = AN('--cent-tol', 4), MAX_REANCHOR = AN('--max-reanchor', 6), POS_RMS_FLOOR = AN('--pos-rms-floor', 1.5);
  const GOALS_PER_CELL = AN('--goals-per-cell', 1);
  const GREY_MASK = A('--grey-mask', null); // optional JSON {bottomFrac:F} horizon mask for beach STRETCH
  const W_CONF = AN('--w-conf', 1), W_SNR = AN('--w-snr', 1), W_COND = AN('--w-cond', 1);
  const RISK_PCT = AN('--risk-pct', 0.6); // risk-gate percentile: interior members harvested only if risk<=tau
  const VALIDATE_FLOOD = HAS('--validate-flood'); // unrestricted flood (=blind BFS) self-check arm
  const PER_STAR_SCATTER_MAG = AN('--per-star-scatter-mag', 0.6); // owner-given ~0.6 mag
  fs.mkdirSync(OUT, { recursive: true });

  // ── frame + WCS ──
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const W = meta.width, H = meta.height;
  const wcs = meta.wcs;
  const crval = [wcs.CRVAL1, wcs.CRVAL2], crpix = [wcs.CRPIX1, wcs.CRPIX2];
  const cd = [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const scaleDegPerPx = Math.sqrt(Math.abs(det));
  const scaleArcsec = scaleDegPerPx * 3600;
  const FWHM = meta.mean_fwhm_px || 2.3;
  const tolCurv = TOL_CURV != null ? TOL_CURV : FWHM;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;
  const anchors = meta.matched_stars;

  // ── distortion prior -> s_max(r) schedule ──
  let k1, k2, bcSrcNote;
  const BC_K1 = A('--bc-k1', null), BC_K2 = A('--bc-k2', null); // direct override (e.g. beach, fitted from distfloor)
  if (BC_K1 != null || BC_K2 != null) { k1 = parseFloat(BC_K1 || '0'); k2 = parseFloat(BC_K2 || '0'); bcSrcNote = `CLI override --bc-k1/--bc-k2 (k1=${k1}, k2=${k2})`; }
  else if (BC_SOURCE === 'ledger') {
    const ledPath = META.replace('capture_meta', 'loop_ledger');
    const led = fs.existsSync(ledPath) ? JSON.parse(fs.readFileSync(ledPath, 'utf8')) : null;
    k1 = led?.final_bc?.k1 ?? meta.bc_measured?.k1 ?? 0; k2 = led?.final_bc?.k2 ?? meta.bc_measured?.k2 ?? 0;
    bcSrcNote = `loop_ledger.final_bc (${ledPath})`;
  } else { k1 = meta.bc_measured?.k1 ?? 0; k2 = meta.bc_measured?.k2 ?? 0; bcSrcNote = 'meta.bc_measured (receipt single-pass BC)'; }
  // radial displacement (px) of the BC model from linear: D(rho)= (k1 r^2 + k2 r^4)*rho, r=rho/hd.
  //   -> D(rho) = k1*rho^3/hd^2 + k2*rho^5/hd^4.  A local affine (6 DOF) absorbs constant+linear
  //   displacement across a quad; the residual it CANNOT absorb is the curvature term, ~
  //   0.5*|D''(rho)|*(L/2)^2 for a quad of side L px.  Budget: keep that <= tolCurv:
  //     0.5*|D''|*(L/2)^2 <= tolCurv  =>  L <= sqrt(8*tolCurv/|D''|).
  //   D''(rho) = 6*k1*rho/hd^2 + 20*k2*rho^3/hd^4.
  const dSecond = (rho) => 6 * k1 * rho / (hd * hd) + 20 * k2 * rho * rho * rho / (hd * hd * hd * hd);
  const smaxCapPx = SMAX_CAP_RNORM * hd;
  const sMaxPx = (rn) => { const rho = rn * hd; const dd = Math.abs(dSecond(rho)); const L = dd > 1e-15 ? Math.sqrt(8 * tolCurv / dd) : Infinity; return Math.min(L, smaxCapPx); };
  const sMaxDeg = (rn) => sMaxPx(rn) * scaleDegPerPx;
  // s_min: quad-geometry conditioning floor. mesh_finder.fitLocalAffine returns null on a
  // singular normal matrix (solveLinear) -> the existing degeneracy guard. We add an explicit
  // numeric floor so near-collinear / sub-baseline neighbour patches are excluded before that:
  // neighbours must span >= sMinPx so ~1-2px centroid noise on them does not dominate the affine.
  const sMinPx = AN('--s-min-px', 4 * FWHM);
  const sMinDeg = sMinPx * scaleDegPerPx;

  const schedule = [];
  for (let rn = 0.05; rn <= 1.001; rn += 0.05) schedule.push({ r_norm: +rn.toFixed(2), bc_shift_px: +(Math.abs(k1 * rn * rn + k2 * rn * rn * rn * rn) * rn * hd).toFixed(2), s_max_px: sMaxPx(rn) === Infinity ? null : +sMaxPx(rn).toFixed(0), s_max_deg: +sMaxDeg(rn).toFixed(4), s_max_binds: sMaxPx(rn) < smaxCapPx });

  // ── catalog (g15u in-frame) + global anchor affine for predicted pixels ──
  const coneR = Math.min(89, Math.atan(hd * scaleDegPerPx * D2R) / D2R + 2);
  const g15 = regionStars({ starsArrowPath: STARS, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit: MAG_LIMIT });
  // anchors: tangent + measured pixels -> fit ONE global affine (tangent deg -> pixel) that
  // absorbs the receipt pointing/scale offset (receipt crval is ~0.5deg off oracle; the anchors'
  // measured positions are truth). Used ONLY to place catalog stars into perimeter cells / pick
  // goals; execution re-anchors on measured pixels, never on this global affine.
  const anchTan = attachTangent(anchors.map((a) => ({ id: a.gaia_id, ra_deg: a.ra_deg, dec_deg: a.dec_deg, mag: a.mag, x: a.x, y: a.y })), crval[0], crval[1]);
  const gAff = fitLocalAffine(anchTan, anchTan.map((a) => ({ x: a.x, y: a.y })), anchTan.map(() => 1));
  const predPix = (xi, eta) => { const [px, py] = applyAffine(gAff.A, xi, eta); return { x: px, y: py }; };
  // build catalog with predicted pixels; keep in-frame (generous margin)
  const catAll = attachTangent(g15.map((s) => ({ id: s.gaia_id, ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag })), crval[0], crval[1]);
  const catalog = [];
  for (const c of catAll) { const p = predPix(c.xi, c.eta); if (p.x < -30 || p.y < -30 || p.x >= W + 30 || p.y >= H + 30) continue; catalog.push({ ...c, px: p.x, py: p.y, r_norm: +rNorm(p.x, p.y).toFixed(4) }); }
  const byId = new Map(catalog.map((c) => [c.id, c]));
  // seed set: union anchors onto catalog ids (nearest tangent within ~1.5px), else append.
  const pxTolDeg = 1.5 * scaleDegPerPx; const seed = new Map(); let appended = 0;
  const catGridTan = buildTanGrid(catalog, 0.02);
  for (const a of anchTan) { const kn = kNearest(catGridTan, a.xi, a.eta, 1); const best = kn.length ? catalog[kn[0].idx] : null; if (best && Math.sqrt(kn[0].d2) < pxTolDeg) { if (!seed.has(best.id)) seed.set(best.id, { id: best.id, x: a.x, y: a.y, mag: a.mag }); } else { const nid = a.id; if (!byId.has(nid)) { const nc = { id: nid, ra_deg: a.ra_deg, dec_deg: a.dec_deg, mag: a.mag, xi: a.xi, eta: a.eta, px: a.x, py: a.y, r_norm: +rNorm(a.x, a.y).toFixed(4) }; catalog.push(nc); byId.set(nid, nc); appended++; } seed.set(nid, { id: nid, x: a.x, y: a.y, mag: a.mag }); } }

  // ── 18-cell perimeter map geometry ──
  const angOf = (x, y) => { let d = Math.atan2(y - cy, x - cx) / D2R; if (d < 0) d += 360; return d; };
  // ray from center at angle theta(deg): max in-frame r_norm along the ray (frame rectangle).
  const ceilAlongRay = (thetaDeg) => { const c = Math.cos(thetaDeg * D2R), s = Math.sin(thetaDeg * D2R); let tmax = Infinity; if (c > 1e-9) tmax = Math.min(tmax, (W - 1 - cx) / c); else if (c < -1e-9) tmax = Math.min(tmax, (0 - cx) / c); if (s > 1e-9) tmax = Math.min(tmax, (H - 1 - cy) / s); else if (s < -1e-9) tmax = Math.min(tmax, (0 - cy) / s); return tmax / hd; };
  // occlusion hook (GREY): default all-sky. beach STRETCH may pass {bottomFrac:F}.
  let greyCfg = null; if (GREY_MASK) { try { greyCfg = JSON.parse(fs.readFileSync(GREY_MASK, 'utf8')); } catch { greyCfg = JSON.parse(GREY_MASK); } }
  const isOccluded = (x, y) => greyCfg && greyCfg.bottomFrac ? (y >= (1 - greyCfg.bottomFrac) * H) : false;

  const cells = [];
  // outer annulus 12 x 30deg
  for (let s = 0; s < 12; s++) { const a0 = s * 30, a1 = a0 + 30; let ceil = 0; for (let a = a0; a <= a1 + 1e-6; a += 1) ceil = Math.max(ceil, ceilAlongRay(a)); ceil = Math.min(ceil, 1.0); const acen = a0 + 15; const extR = Math.min(ceil, 1.0); cells.push({ id: `OUT_${s}`, ring: 'outer', a0, a1, r_in: 0.75, r_out: 1.0, ceil: +ceil.toFixed(4), acen, ext: { x: cx + Math.cos(acen * D2R) * extR * hd, y: cy + Math.sin(acen * D2R) * extR * hd, r_norm: +extR.toFixed(4) } }); }
  // mid annulus 6 x 60deg
  for (let s = 0; s < 6; s++) { const a0 = s * 60, a1 = a0 + 60; let ceil = 0; for (let a = a0; a <= a1 + 1e-6; a += 1) ceil = Math.max(ceil, ceilAlongRay(a)); ceil = Math.min(ceil, 0.75); const acen = a0 + 30; const extR = Math.min(ceil, 0.75); cells.push({ id: `MID_${s}`, ring: 'mid', a0, a1, r_in: 0.45, r_out: 0.75, ceil: +ceil.toFixed(4), acen, ext: { x: cx + Math.cos(acen * D2R) * extR * hd, y: cy + Math.sin(acen * D2R) * extR * hd, r_norm: +extR.toFixed(4) } }); }
  const cellOf = (x, y) => { const rn = rNorm(x, y); const th = angOf(x, y); if (rn >= 0.75 && rn <= 1.0001) return `OUT_${Math.min(11, Math.floor(th / 30))}`; if (rn >= 0.45 && rn < 0.75) return `MID_${Math.min(5, Math.floor(th / 60))}`; return null; };
  const cellById = new Map(cells.map((c) => [c.id, c]));

  // ── assign catalog + seed to cells; classify sky-visibility ──
  for (const c of cells) { c.catalog = []; c.occluded_all = true; }
  for (const s of catalog) { const cid = cellOf(s.px, s.py); if (!cid) continue; const c = cellById.get(cid); c.catalog.push(s); if (!isOccluded(s.px, s.py)) c.occluded_all = false; }
  const seedIds = new Set(seed.keys());

  // ── goal selection: brightest catalog members nearest the cell OUTER extremity ──
  for (const c of cells) {
    if (c.ceil < c.r_in - 1e-3) { c.goals = []; c.out_of_frame = true; continue; } // no sky in this sector
    if (!c.catalog.length) { c.goals = []; continue; }
    const sky = c.catalog.filter((s) => !isOccluded(s.px, s.py));
    const pool = sky.length ? sky : [];
    // rank by distance to the cell extremity (push to the far edge), brightness tiebreak
    const ranked = [...pool].sort((p, q) => { const dp = Math.hypot(p.px - c.ext.x, p.py - c.ext.y), dq = Math.hypot(q.px - c.ext.x, q.py - c.ext.y); if (Math.abs(dp - dq) > 3) return dp - dq; return p.mag - q.mag; });
    c.goals = ranked.slice(0, Math.max(1, GOALS_PER_CELL)).map((s) => s.id);
  }

  // ── risk model (offline, catalog geometry) ──
  const beamR = Math.max(FWHM, 3); // confusion beam radius px
  // predicted-SNR proxy from magnitude: anchors span the bright regime; risk rises toward the
  // faint frame floor. clamp((mag - p50_anchor)/(magFloor - p50_anchor),0,1).
  const anchorMags = anchTan.map((a) => a.mag).sort((x, y) => x - y);
  const magP50 = anchorMags[anchorMags.length >> 1];
  const magFloor = MAG_LIMIT;
  const snrShortfall = (mag) => Math.max(0, Math.min(1, (mag - magP50) / Math.max(0.5, magFloor - magP50)));
  // catalog pixel grid for confusion counts
  const pxGrid = new Map(); const PXCELL = Math.max(8, Math.ceil(beamR)); for (let i = 0; i < catalog.length; i++) { const k = (catalog[i].px / PXCELL | 0) * 100003 + (catalog[i].py / PXCELL | 0); let a = pxGrid.get(k); if (!a) { a = []; pxGrid.set(k, a); } a.push(i); }
  const confusionCount = (x, y, selfId) => { const gx = x / PXCELL | 0, gy = y / PXCELL | 0; let n = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = pxGrid.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { if (catalog[i].id === selfId) continue; if (Math.hypot(catalog[i].px - x, catalog[i].py - y) <= beamR) n++; } } return n; };
  // conditioning: eigen-ratio of the tangent scatter of a node's kNear catalog neighbours.
  const condPenalty = (node) => { const kn = kNearest(catGridTan, node.xi, node.eta, KNEAR); if (kn.length < KMIN) return 1; let mx = 0, my = 0; const pts = kn.map((k) => catalog[k.idx]); for (const p of pts) { mx += p.xi; my += p.eta; } mx /= pts.length; my /= pts.length; let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const ex = p.xi - mx, ey = p.eta - my; sxx += ex * ex; syy += ey * ey; sxy += ex * ey; } const tr = sxx + syy, dt = sxx * syy - sxy * sxy; const disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt)); const l1 = tr / 2 + disc, l2 = tr / 2 - disc; return l1 > 1e-18 ? 1 - Math.sqrt(Math.max(0, l2 / l1)) : 1; };
  const riskOf = (node) => { const conf = confusionCount(node.px, node.py, node.id); const ss = snrShortfall(node.mag); const cp = condPenalty(node); return { risk: W_CONF * conf + W_SNR * (3 * ss) + W_COND * (2 * cp), conf, snr_short: +ss.toFixed(3), cond: +cp.toFixed(3) }; };
  // precompute risk per catalog node
  const riskCache = new Map(); for (const s of catalog) riskCache.set(s.id, riskOf(s));

  // ── static quad adjacency (edges within [s_min, s_max(r_v)]) ──
  // For each node v, neighbours = catalog stars within s_max(r_v) tangent-deg (capped to 14
  // nearest), excluding those closer than s_min. A* steps u->v across such an edge.
  const adjacency = new Map();
  for (const v of catalog) { const smax = sMaxDeg(rNorm(v.px, v.py)); const smaxG = Math.min(smax, sMaxDeg(1.0) === Infinity ? smax : smax); const kn = kNearest(catGridTan, v.xi, v.eta, 16); const nb = []; for (const k of kn) { const u = catalog[k.idx]; if (u.id === v.id) continue; const d = Math.sqrt(k.d2); if (d < sMinDeg || d > smax) continue; nb.push(u.id); if (nb.length >= 14) break; } adjacency.set(v.id, nb); }

  // ── A* corridor planning (OFFLINE, pure catalog) ──
  const tPlan = Date.now();
  const corridorStars = new Set(); const corridorPaths = {}; let goalsPlanned = 0, goalsReachablePlan = 0;
  const sMaxTypDeg = sMaxDeg(0.75); const baseHop = 0.3; // ε-admissible weighted heuristic scale (cost units per hop)
  for (const c of cells) {
    for (const gid of c.goals) {
      const goal = byId.get(gid); if (!goal) continue; goalsPlanned++;
      // multi-source A* from anchors to this goal
      const gScore = new Map(); const came = new Map(); const open = new MinHeap(); const closed = new Set();
      const hOf = (n) => (Math.hypot(n.xi - goal.xi, n.eta - goal.eta) / Math.max(1e-6, sMaxTypDeg)) * baseHop;
      for (const sid of seedIds) { const sn = byId.get(sid); if (!sn) continue; gScore.set(sid, 0); open.push({ id: sid, f: hOf(sn) }); }
      let found = null;
      while (open.size) { const cur = open.pop(); if (closed.has(cur.id)) continue; closed.add(cur.id); if (cur.id === gid) { found = cur.id; break; } const g0 = gScore.get(cur.id); const nb = adjacency.get(cur.id) || []; for (const nid of nb) { if (closed.has(nid)) continue; const nn = byId.get(nid); const step = seedIds.has(nid) ? 0 : (riskCache.get(nid)?.risk ?? 5); const ng = g0 + step + 0.05; if (ng < (gScore.get(nid) ?? Infinity)) { gScore.set(nid, ng); came.set(nid, cur.id); open.push({ id: nid, f: ng + hOf(nn) }); } } }
      if (found) { goalsReachablePlan++; const pathIds = []; let cur = gid; while (cur != null) { pathIds.push(cur); if (seedIds.has(cur)) break; cur = came.get(cur); } pathIds.reverse(); for (const pid of pathIds) if (!seedIds.has(pid)) corridorStars.add(pid); corridorPaths[gid] = { cell: c.id, hops: pathIds.length - 1, path: pathIds }; }
      else corridorPaths[gid] = { cell: c.id, reachable: false };
    }
  }
  const planMs = Date.now() - tPlan;

  // ── EXECUTION: forced-verify corridor stars in dependency order (mirrors runCascade) ──
  // acceptance block is a faithful copy of mesh_finder.runCascade so completions are identical
  // to the blind cascade for the SAME candidate given the SAME neighbour support.
  const raw = fs.readFileSync(BUFFER); const L = new Float32Array(raw.buffer, raw.byteOffset, W * H);
  const sigmaPix = pixelNoiseSigma(L);
  // risk gate: interior members are harvested only when their predicted risk <= tau (the
  // "confusion guard" that stops the walk); corridor path stars are ALWAYS attempted (pre-vetted
  // as necessary to punch out to a goal). This is the operational form of "route through low-risk
  // hops". VALIDATE_FLOOD disables the gate (=blind BFS) as the self-check / blind arm.
  const riskSorted = catalog.filter((s) => !seedIds.has(s.id)).map((s) => riskCache.get(s.id).risk).sort((a, b) => a - b);
  const riskTau = riskSorted.length ? riskSorted[Math.min(riskSorted.length - 1, Math.floor(riskSorted.length * RISK_PCT))] : Infinity;
  const executeSet = VALIDATE_FLOOD
    ? new Set(catalog.filter((s) => !seedIds.has(s.id)).map((s) => s.id))
    : new Set(catalog.filter((s) => !seedIds.has(s.id) && (corridorStars.has(s.id) || riskCache.get(s.id).risk <= riskTau)).map((s) => s.id));
  const tExec = Date.now();
  // matched map: id -> {id,mag,xi,eta,x,y,source,r_norm,...}
  const matched = new Map();
  for (const [id, sd] of seed) { const c = byId.get(id); if (!c) continue; matched.set(id, { id, mag: c.mag, xi: c.xi, eta: c.eta, x: sd.x, y: sd.y, source: 'seed', r_norm: +rNorm(sd.x, sd.y).toFixed(4) }); }
  const execRows = []; let rounds = 0; let rejGate = 0, rejCent = 0, rejAff = 0;
  const pending = new Set(executeSet);
  for (let iter = 1; iter <= 24; iter++) {
    const matchedArr = [...matched.values()]; const mGrid = buildTanGrid(matchedArr, 0.04);
    const added = []; let considered = 0;
    for (const id of pending) {
      const cand = byId.get(id); if (!cand || matched.has(id)) continue;
      const smax = sMaxDeg(rNorm(cand.px, cand.py));
      const knn = kNearest(mGrid, cand.xi, cand.eta, KNEAR);
      const near = knn.filter((k) => Math.sqrt(k.d2) <= smax && Math.sqrt(k.d2) >= sMinDeg);
      if (near.length < KMIN) continue; // support not yet available (or out of schedule window)
      considered++;
      const src = near.map((k) => matchedArr[k.idx]); const dst = src.map((s) => ({ x: s.x, y: s.y })); const wts = near.map((k) => 1 / (k.d2 + 1e-9));
      const aff = fitLocalAffine(src, dst, wts);
      if (!aff) { rejAff++; continue; }
      const [px, py] = applyAffine(aff.A, cand.xi, cand.eta);
      const posRms = Math.max(POS_RMS_FLOOR, aff.rms);
      const fm = forcedMeasure({ L, w: W, h: H, positions: [{ x: px, y: py, mag: cand.mag, gaia_id: cand.id }], fwhmPx: 4, posRmsPx: posRms, snrThreshold: SNR, sigmaPix });
      const r = fm.results[0];
      if (!r || !r.accepted) { rejGate++; continue; }
      const bg = localBg(L, W, H, px, py); const cen = bg == null ? null : fluxCentroid(L, W, H, px, py, bg, sigmaPix, Math.ceil(posRms) + 2);
      if (!cen) { rejCent++; continue; }
      const reanchor = Math.hypot(cen.x - px, cen.y - py);
      if (reanchor > Math.min(MAX_REANCHOR, posRms + CENT_TOL)) { rejCent++; continue; }
      added.push({ id: cand.id, mag: cand.mag, xi: cand.xi, eta: cand.eta, x: cen.x, y: cen.y, source: 'mesh', iter, pred_x: +px.toFixed(2), pred_y: +py.toFixed(2), snr: +r.snr.toFixed(2), r_norm: +rNorm(cen.x, cen.y).toFixed(4) });
    }
    for (const a of added) { matched.set(a.id, a); pending.delete(a.id); execRows.push(a); }
    rounds = iter;
    if (added.length === 0) break;
  }
  const execMs = Date.now() - tExec;
  const meshDone = execRows;

  // ── ORACLE grading (false-completion vs a.net SIP truth; identical def to grade_oracle) ──
  const owcs = parseAnetWcs(ORACLE_WCS); const sky2truth = makeSkyToPixel(owcs);
  const tol2 = 2 * FWHM;
  const gradeSet = (rows) => { const inn = { n: 0, f: 0 }, out78 = { n: 0, f: 0 }, out85 = { n: 0, f: 0 }; let noOra = 0; for (const m of rows) { const c = byId.get(m.id); if (!c) { noOra++; continue; } const t = sky2truth(c.ra_deg, c.dec_deg); if (!t) { noOra++; continue; } const d = Math.hypot(m.x - t.x, m.y - t.y); const isFalse = d > tol2; const rn = m.r_norm; const bucket = rn < 0.7 ? inn : (rn < 0.85 ? out78 : out85); bucket.n++; if (isFalse) bucket.f++; } return { inner_lt070: { n: inn.n, false_rate: inn.n ? +(inn.f / inn.n).toFixed(3) : null }, outer_070_085: { n: out78.n, false_rate: out78.n ? +(out78.f / out78.n).toFixed(3) : null }, outer_085_100: { n: out85.n, false_rate: out85.n ? +(out85.f / out85.n).toFixed(3) : null }, no_oracle: noOra, total: rows.length }; };
  const corridorGrade = gradeSet(meshDone);
  // blind-BFS baseline: grade the banked blind matches with the SAME grader (apples-to-apples)
  let blindGrade = null, blindMeshRows = null;
  if (fs.existsSync(BLIND_MATCHES)) { const bm = JSON.parse(fs.readFileSync(BLIND_MATCHES, 'utf8')).matches; blindMeshRows = bm.filter((m) => m.source === 'mesh'); blindGrade = gradeSet(blindMeshRows); }

  // ── per-cell grading (N, reach, precision) + grade ──
  const doneById = new Map(meshDone.map((m) => [m.id, m]));
  const cellRows = cells.map((c) => {
    const skyCat = c.catalog.filter((s) => !isOccluded(s.px, s.py));
    const occluded = c.catalog.length > 0 && skyCat.length === 0;
    // verified = seed anchors + executed completions falling in this cell (by measured pos)
    const verified = [];
    for (const s of c.catalog) { if (seedIds.has(s.id)) { verified.push({ id: s.id, x: s.px, y: s.py, r_norm: rNorm(s.px, s.py), src: 'seed' }); } }
    for (const m of meshDone) { const cid = cellOf(m.x, m.y); if (cid === c.id) verified.push({ id: m.id, x: m.x, y: m.y, r_norm: m.r_norm, src: 'mesh' }); }
    const N = verified.length;
    const maxR = N ? Math.max(...verified.map((v) => v.r_norm)) : 0;
    const reach = c.ceil > 1e-6 ? +(maxR / c.ceil).toFixed(3) : null;
    const precision = N ? +(PER_STAR_SCATTER_MAG / Math.sqrt(N)).toFixed(3) : null;
    let grade;
    // OUT_OF_FRAME: the frame rectangle never enters this annular sector (ceil < inner radius) —
    // a non-square-sensor geometric fact (M66 portrait short-edge sectors), NOT "unwalked".
    if (c.ceil < c.r_in - 1e-3) grade = 'OUT_OF_FRAME';
    else if (occluded) grade = 'GREY';
    else if (N === 0) grade = 'RED';
    else if (N >= 10 && reach != null && reach >= 0.9) grade = 'GREEN';
    else grade = 'AMBER_THIN';
    // corner reach for corner-containing outer cells: nearest frame corner distance of farthest star
    let cornerReach = null;
    if (c.ring === 'outer' && c.ceil >= 0.999 && N) { const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]; const inSector = corners.filter((cc) => { const a = angOf(cc[0], cc[1]); return a >= c.a0 && a < c.a1; }); if (inSector.length) { const far = verified.reduce((b, v) => v.r_norm > b.r_norm ? v : b, verified[0]); const cc = inSector[0]; cornerReach = +(1 - Math.hypot(far.x - cc[0], far.y - cc[1]) / hd).toFixed(3); } }
    return { cell: c.id, ring: c.ring, a0: c.a0, a1: c.a1, ceil_r_norm: c.ceil, catalog_stars: c.catalog.length, sky_visible: skyCat.length, N, reach, max_r_norm: +maxR.toFixed(3), corner_reach: cornerReach, precision_mag: precision, photometric_ge3: N >= 3, grade, reached: N > 0, goals: c.goals, corridor_reached_plan: c.goals.every((g) => corridorPaths[g] && corridorPaths[g].path) };
  });
  const outerRows = cellRows.filter((c) => c.ring === 'outer');
  const midRows = cellRows.filter((c) => c.ring === 'mid');
  const cnt = (rows, pred) => rows.filter(pred).length;
  const outerInFrame = outerRows.filter((c) => c.grade !== 'OUT_OF_FRAME');
  const midInFrame = midRows.filter((c) => c.grade !== 'OUT_OF_FRAME');
  const summaryCells = {
    outer: { nominal: 12, in_frame: outerInFrame.length, out_of_frame: cnt(outerRows, (c) => c.grade === 'OUT_OF_FRAME'), reached: cnt(outerInFrame, (c) => c.reached), green: cnt(outerRows, (c) => c.grade === 'GREEN'), amber: cnt(outerRows, (c) => c.grade === 'AMBER_THIN'), red: cnt(outerRows, (c) => c.grade === 'RED'), grey: cnt(outerRows, (c) => c.grade === 'GREY') },
    mid: { nominal: 6, in_frame: midInFrame.length, out_of_frame: cnt(midRows, (c) => c.grade === 'OUT_OF_FRAME'), reached: cnt(midInFrame, (c) => c.reached), green: cnt(midRows, (c) => c.grade === 'GREEN'), amber: cnt(midRows, (c) => c.grade === 'AMBER_THIN'), red: cnt(midRows, (c) => c.grade === 'RED'), grey: cnt(midRows, (c) => c.grade === 'GREY') },
  };

  // ── PRE-REGISTRATION verdict ──
  // NOTE: the pre-reg "10/12 outer cells" assumed a frame that fills all 12 sectors. M66 is a
  // PORTRAIT sensor (2160x3840): 4 outer sectors along the short edges never enter r_norm>=0.75,
  // so only 8 outer cells contain sky. We adjust the reach denominator to IN-FRAME outer cells and
  // report both. The false-rate half of the pre-reg is unchanged.
  const outerReached = summaryCells.outer.reached;
  const outerInFrameN = summaryCells.outer.in_frame;
  const corridorOuterFalse = corridorGrade.outer_070_085.false_rate;
  const blindOuterFalse = blindGrade ? blindGrade.outer_070_085.false_rate : null;
  const reachMet = outerInFrameN >= 10 ? outerReached >= 10 : outerReached >= Math.min(outerInFrameN, 8); // all in-frame outer cells
  const falseMet = (corridorOuterFalse != null && blindOuterFalse != null) ? corridorOuterFalse < blindOuterFalse : null;
  const prereg = {
    expectation: 'planned corridors reach >=10/12 outer cells AND corridor outer(0.70-0.85) false-rate < blind-BFS outer (0.205)',
    frame_geometry_note: `portrait sensor: ${summaryCells.outer.out_of_frame} of 12 outer sectors are OUT_OF_FRAME (frame never reaches r_norm 0.75 there); in-frame outer cells = ${outerInFrameN}`,
    outer_cells_reached: `${outerReached}/${outerInFrameN} in-frame (of 12 nominal)`,
    reach_adjusted_met: reachMet,
    corridor_outer_false_rate: corridorOuterFalse,
    blind_outer_false_rate: blindOuterFalse,
    false_rate_met: falseMet,
    verdict: (reachMet && falseMet === true) ? 'PRE-REGISTRATION MET (reach on in-frame cells; false-rate strictly below blind)'
      : (reachMet && falseMet === false) ? 'PARTIAL: reach met, false-rate NOT below blind (honest negative)'
        : 'PRE-REGISTRATION NOT MET (honest negative)',
  };

  // ══ RENDER 1: 18-cell wheel (green/amber/red/grey) ══
  renderWheel(path.join(OUT, `${FRAME}_perimeter_wheel.png`), cells, cellRows, cellById, W, H, cx, cy, hd, FRAME);
  // ══ RENDER 2: corridor overlay on the frame ══
  renderCorridors(path.join(OUT, `${FRAME}_corridor_overlay.png`), L, W, H, seed, meshDone, corridorPaths, byId, cells, cellRows, cx, cy, hd);

  // ── write JSON ──
  const summary = {
    frame: FRAME, generated: new Date().toISOString(), lane: 'tools/mesh/quad_walk_planner.mjs (research incubator, LAW-4, banked-data only)',
    regime: 'ASSISTED-ORACLE (a.net SIP = oracle-truth for false-completion grading; NEVER pooled with blind-solve stats)',
    inputs: { meta: META, buffer: BUFFER, oracle_wcs: ORACLE_WCS, blind_matches: BLIND_MATCHES, stars: STARS },
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: +FWHM.toFixed(3), tol_2fwhm_px: +tol2.toFixed(2), half_diag_px: +hd.toFixed(1), sigma_pix: sigmaPix },
    catalog: { g15u_in_frame: catalog.length, appended_anchors: appended, seed_anchors: seed.size, mag_limit: MAG_LIMIT, cone_radius_deg: +coneR.toFixed(2) },
    distortion_prior: { bc_source: bcSrcNote, k1, k2, tol_curv_px: +tolCurv.toFixed(3), s_min_px: +sMinPx.toFixed(2), s_max_cap_r_norm: SMAX_CAP_RNORM, s_max_cap_px: +smaxCapPx.toFixed(0), formula: 'L_max = sqrt(8*tolCurv/|D\'\'(rho)|); D(rho)=k1*rho^3/hd^2+k2*rho^5/hd^4; D\'\'=6k1*rho/hd^2+20k2*rho^3/hd^4; s_max=min(L_max, cap)', schedule },
    s_max_binds_anywhere: schedule.some((r) => r.s_max_binds),
    planner: { nodes: catalog.length, goals_planned: goalsPlanned, goals_reachable_plan: goalsReachablePlan, corridor_stars: corridorStars.size, plan_wall_ms: planMs, risk_weights: { confusion: W_CONF, snr_shortfall: W_SNR, conditioning: W_COND }, heuristic: 'weighted A* (epsilon-admissible): f=g(risk)+ (dist_to_goal/s_max_typ)*baseHop', k_near: KNEAR, k_min: KMIN },
    execution: { mode: VALIDATE_FLOOD ? 'VALIDATE_FLOOD (unrestricted = blind BFS self-check)' : 'risk-gated corridor', risk_pct: RISK_PCT, risk_tau: VALIDATE_FLOOD ? null : +riskTau.toFixed(3), attempted: executeSet.size, completed: meshDone.length, rounds, rej_gate: rejGate, rej_centroid: rejCent, rej_affine: rejAff, exec_wall_ms: execMs, reach_r_norm_max: meshDone.length ? +Math.max(...meshDone.map((m) => m.r_norm)).toFixed(3) : null },
    perimeter_map: { cells_summary: summaryCells, cells: cellRows },
    oracle_grade_false_completion: { corridor: corridorGrade, blind_bfs_baseline: blindGrade, blind_bfs_n_mesh: blindMeshRows ? blindMeshRows.length : null, definition: 'false = measured centroid drifts > 2*FWHM from the CLAIMED catalog id oracle-SIP truth (identical to grade_oracle.mjs false_completion_2fwhm); banked blind-BFS baseline 2.7% inner / 20.5% outer(0.70-0.85)' },
    pre_registration: prereg,
    wall_total_ms: Date.now() - t0,
    outputs: { wheel_png: path.join(OUT, `${FRAME}_perimeter_wheel.png`), corridor_png: path.join(OUT, `${FRAME}_corridor_overlay.png`) },
    provenance_notes: [
      'Every completion is CATALOG_FORCED forced photometry at a LOCAL-AFFINE-predicted position; never a blind discovery, never a solve input.',
      'The executor never predicts from the global WCS: seed anchors + local affine on measured neighbour pixels only (pointing-error immune; the global anchor affine is used ONLY for coarse cell assignment / goal picking).',
      'false-completion is graded vs an EXTERNAL a.net SIP oracle; oracle-assisted, never pooled with blind-solve stats.',
      'per-cell precision = per-star photometric scatter (~0.6 mag, owner-given) / sqrt(N); a magic N is NOT hard-coded.',
    ],
  };
  const jsonPath = path.join(OUT, `${FRAME}_quad_walk.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, `${FRAME}_quad_walk_corridors.json`), JSON.stringify({ frame: FRAME, corridors: corridorPaths }, null, 2));

  // ── console report ──
  console.log(`\n[${FRAME}] ${W}x${H} scale ${scaleArcsec.toFixed(2)}"/px FWHM ${FWHM.toFixed(2)} tol2 ${tol2.toFixed(2)}px | catalog ${catalog.length} seed ${seed.size}`);
  console.log(`[${FRAME}] s_max(r) BC ${BC_SOURCE} k1=${k1} k2=${k2} tolCurv=${tolCurv.toFixed(2)}px cap=${smaxCapPx.toFixed(0)}px | binds anywhere: ${summary.s_max_binds_anywhere}`);
  console.log(`   s_max(0.5)=${sMaxPx(0.5) === Infinity ? 'inf' : sMaxPx(0.5).toFixed(0)}px  s_max(0.75)=${sMaxPx(0.75).toFixed(0)}px  s_max(1.0)=${sMaxPx(1.0).toFixed(0)}px  s_min=${sMinPx.toFixed(1)}px`);
  console.log(`[${FRAME}] PLAN: ${goalsReachablePlan}/${goalsPlanned} goals reachable, ${corridorStars.size} corridor stars, ${planMs}ms`);
  console.log(`[${FRAME}] EXEC (${summary.execution.mode}, tau=${VALIDATE_FLOOD ? 'inf' : riskTau.toFixed(2)}): ${meshDone.length} completed / ${executeSet.size} attempted, ${rounds} rounds, ${execMs}ms  [rejgate ${rejGate} rejcent ${rejCent}]`);
  console.log(`[${FRAME}] CELLS outer ${summaryCells.outer.reached}/${summaryCells.outer.in_frame} in-frame reached (${summaryCells.outer.green}G/${summaryCells.outer.amber}A/${summaryCells.outer.red}R/${summaryCells.outer.out_of_frame}OOF) | mid ${summaryCells.mid.reached}/${summaryCells.mid.in_frame} (${summaryCells.mid.green}G/${summaryCells.mid.amber}A/${summaryCells.mid.red}R)`);
  console.log(`  cell     ring   N   reach  prec   grade      ceil`);
  for (const c of cellRows) console.log(`  ${c.cell.padEnd(8)} ${c.ring.padEnd(5)} ${String(c.N).padStart(3)}  ${String(c.reach ?? '-').padStart(5)}  ${String(c.precision_mag ?? '-').padStart(5)}  ${c.grade.padEnd(10)} ${c.ceil_r_norm}`);
  console.log(`[${FRAME}] FALSE-COMPLETION vs oracle:`);
  console.log(`   corridor : inner<0.70 ${corridorGrade.inner_lt070.false_rate} (n${corridorGrade.inner_lt070.n}) | outer0.70-0.85 ${corridorGrade.outer_070_085.false_rate} (n${corridorGrade.outer_070_085.n}) | 0.85-1.0 ${corridorGrade.outer_085_100.false_rate} (n${corridorGrade.outer_085_100.n})`);
  if (blindGrade) console.log(`   blind-BFS: inner<0.70 ${blindGrade.inner_lt070.false_rate} (n${blindGrade.inner_lt070.n}) | outer0.70-0.85 ${blindGrade.outer_070_085.false_rate} (n${blindGrade.outer_070_085.n}) | 0.85-1.0 ${blindGrade.outer_085_100.false_rate} (n${blindGrade.outer_085_100.n})`);
  console.log(`[${FRAME}] PRE-REG: ${prereg.verdict} (outer reached ${outerReached}/12, corridor outer false ${corridorOuterFalse} vs blind ${blindOuterFalse})`);
  console.log(`[${FRAME}] -> ${jsonPath}\n`);
}

// ── RENDER: 18-cell perimeter wheel ─────────────────────────────────────────
function renderWheel(outPath, cells, cellRows, cellById, W, H, cx, cy, hd, frame) {
  const PW = 820, PH = 820; const bytes = new Uint8Array(PW * PH * 3); bytes.fill(16);
  const ox = PW / 2, oy = PH / 2, R = 360; // display radius = r_norm 1.0
  const D2R = Math.PI / 180;
  const rowById = new Map(cellRows.map((c) => [c.cell, c]));
  const gradeColor = { GREEN: [50, 200, 90], AMBER_THIN: [230, 165, 35], RED: [220, 60, 60], GREY: [110, 110, 120], OUT_OF_FRAME: [44, 46, 54] };
  // ── frame rectangle mapped into the SAME normalized polar space ───────────────
  // A frame pixel at image offset (X-cx, Y-cy) maps to display (ox+(X-cx)/hd*R, oy+(Y-cy)/hd*R).
  // The frame's 4 CORNERS sit at hypot(cx,cy)/hd = 1.0 (exactly the r_norm=1.0 ring); its edges are
  // the INSCRIBED rectangle. Half-extents in display px (from the ACTUAL frame dims, never hardcoded):
  // along ±x = (cx/hd)*R (portrait M66 short direction, r~0.49); along ±y = (cy/hd)*R (r~0.87).
  const rectHalfW = (cx / hd) * R, rectHalfH = (cy / hd) * R;
  const inFrameDisp = (dx, dy) => Math.abs(dx) <= rectHalfW && Math.abs(dy) <= rectHalfH;
  // per-pixel fill: classify each disk pixel by (r_norm, angle) -> cell -> grade colour (solid, no moire).
  // Pixels OUTSIDE the frame rectangle are dimmed + diagonally hatched so walkable-vs-out-of-frame is explicit.
  const angDeg = (dx, dy) => { let d = Math.atan2(dy, dx) / D2R; if (d < 0) d += 360; return d; };
  const cellAt = (rn, th) => { if (rn >= 0.75 && rn <= 1.0) return `OUT_${Math.min(11, Math.floor(th / 30))}`; if (rn >= 0.45 && rn < 0.75) return `MID_${Math.min(5, Math.floor(th / 60))}`; return null; };
  for (let py = 0; py < PH; py++) for (let px = 0; px < PW; px++) {
    const dx = px - ox, dy = py - oy; const rr = Math.hypot(dx, dy) / R;
    if (rr < 0.45 || rr > 1.0) continue;
    const cid = cellAt(rr, angDeg(dx, dy)); if (!cid) continue;
    const cr = rowById.get(cid); if (!cr) continue;
    let rgb = gradeColor[cr.grade] || [80, 80, 80];
    // dim + hatch the portion of GREEN/AMBER/RED cells lying BEYOND the frame rectangle (out of frame);
    // OUT_OF_FRAME cells keep their existing flat dark styling untouched.
    if (cr.grade !== 'OUT_OF_FRAME' && !inFrameDisp(dx, dy)) {
      const f = ((px + py) % 6 === 0) ? 0.16 : 0.34; // sparse diagonal hatch over a dim blend toward bg(16)
      rgb = [Math.round(rgb[0] * f + 16 * (1 - f)), Math.round(rgb[1] * f + 16 * (1 - f)), Math.round(rgb[2] * f + 16 * (1 - f))];
    }
    const o = (py * PW + px) * 3; bytes[o] = rgb[0]; bytes[o + 1] = rgb[1]; bytes[o + 2] = rgb[2];
  }
  // ring + spoke gridlines
  const ring = (rr, rgb) => { for (let a = 0; a < 360; a += 0.4) { const th = a * D2R; const x = ox + Math.cos(th) * rr * R, y = oy + Math.sin(th) * rr * R; plotPoint(bytes, PW, PH, x, y, rgb, 0.7); } };
  ring(0.45, [70, 70, 80]); ring(0.75, [90, 90, 100]); ring(1.0, [120, 120, 130]);
  for (let a = 0; a < 360; a += 30) { const th = a * D2R; drawPolyline(bytes, PW, PH, [[ox + Math.cos(th) * 0.45 * R, oy + Math.sin(th) * 0.45 * R], [ox + Math.cos(th) * 1.0 * R, oy + Math.sin(th) * 1.0 * R]], [55, 55, 65], 0.6); }
  for (let a = 0; a < 360; a += 60) { const th = a * D2R; drawPolyline(bytes, PW, PH, [[ox + Math.cos(th) * 0.45 * R, oy + Math.sin(th) * 0.45 * R], [ox + Math.cos(th) * 0.75 * R, oy + Math.sin(th) * 0.75 * R]], [80, 80, 90], 0.6); }
  // ── frame boundary rectangle outline (inscribed; the 4 corners land on the r=1.0 ring) ──
  const rectPts = [[ox - rectHalfW, oy - rectHalfH], [ox + rectHalfW, oy - rectHalfH], [ox + rectHalfW, oy + rectHalfH], [ox - rectHalfW, oy + rectHalfH], [ox - rectHalfW, oy - rectHalfH]];
  for (const off of [-1, 0, 1]) { drawPolyline(bytes, PW, PH, rectPts.map(([x, y]) => [x + off, y]), [240, 240, 250], 0.95); drawPolyline(bytes, PW, PH, rectPts.map(([x, y]) => [x, y + off]), [240, 240, 250], 0.95); }
  // corner emphasis: the 4 points where the rectangle meets r=1.0 (the image corners)
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = ox + sx * rectHalfW, y = oy + sy * rectHalfH; for (let d = -2; d <= 2; d++) { plotPoint(bytes, PW, PH, x + d, y, [255, 255, 255], 1); plotPoint(bytes, PW, PH, x, y + d, [255, 255, 255], 1); } }
  // label each cell with N at its centroid
  for (const c of cells) { const cr = rowById.get(c.id); const rr = (c.r_in + (c.ring === 'outer' ? 1.0 : 0.75)) / 2; const th = (c.acen) * D2R; const lx = ox + Math.cos(th) * rr * R - 6, ly = oy + Math.sin(th) * rr * R - 5; drawTiny(bytes, PW, PH, lx, ly, `${cr.N}`, [15, 15, 15]); }
  drawTiny(bytes, PW, PH, 8, 8, `${frame} perimeter coverage  G=${cellRows.filter((c) => c.grade === 'GREEN').length} A=${cellRows.filter((c) => c.grade === 'AMBER_THIN').length} R=${cellRows.filter((c) => c.grade.startsWith('RED')).length}`, [220, 220, 225]);
  drawTiny(bytes, PW, PH, 8, 20, `green N>=10 reach>=0.9  amber reached  red unwalked  (label=N)`, [150, 150, 160]);
  drawTiny(bytes, PW, PH, 8, 32, `outline=frame boundary  dimmed=outside frame  r=1.0=corner`, [150, 150, 160]);
  writePNG(outPath, bytes, PW, PH);
}
// ── RENDER: corridor overlay on the frame ───────────────────────────────────
function renderCorridors(outPath, L, W, H, seed, meshDone, corridorPaths, byId, cells, cellRows, cx, cy, hd) {
  const outW = 1080; const stretch = makeStretch([L]); stretch.lo = [stretch.lo[0], stretch.lo[0], stretch.lo[0]]; stretch.hi = [stretch.hi[0], stretch.hi[0], stretch.hi[0]];
  const ds = downscaleRGB(L, L, L, W, H, outW, stretch); const sc = ds.scale;
  const mark = (x, y, rgb, r = 2) => { for (let d = -r; d <= r; d++) { plotPoint(ds.bytes, ds.ow, ds.oh, x + d, y, rgb, 0.95); plotPoint(ds.bytes, ds.ow, ds.oh, x, y + d, rgb, 0.95); } };
  // annulus rings for context
  const D2R = Math.PI / 180; const cxs = cx * sc, cys = cy * sc;
  for (const rr of [0.45, 0.75, 1.0]) { const pts = []; for (let a = 0; a <= 360; a += 2) pts.push([cxs + Math.cos(a * D2R) * rr * hd * sc, cys + Math.sin(a * D2R) * rr * hd * sc]); drawPolyline(ds.bytes, ds.ow, ds.oh, pts, [70, 90, 120], 0.5); }
  // planned corridor polylines (catalog predicted positions) in dim cyan
  for (const gid of Object.keys(corridorPaths)) { const cp = corridorPaths[gid]; if (!cp.path) continue; const pts = cp.path.map((id) => { const n = byId.get(id); return n ? [n.px * sc, n.py * sc] : null; }).filter(Boolean); if (pts.length >= 2) drawPolyline(ds.bytes, ds.ow, ds.oh, pts, [40, 130, 160], 0.55); }
  // seed = blue, executed completions = green, goal endpoints = gold
  for (const [, sd] of seed) mark(sd.x * sc, sd.y * sc, [70, 150, 255], 1);
  for (const m of meshDone) mark(m.x * sc, m.y * sc, [60, 230, 90], 2);
  const goalIds = new Set(); for (const c of cells) for (const g of c.goals) goalIds.add(g);
  for (const gid of goalIds) { const n = byId.get(gid); if (n) mark(n.px * sc, n.py * sc, [255, 200, 40], 3); }
  drawTiny(ds.bytes, ds.ow, ds.oh, 8, 8, `corridors cyan  seed blue  completed green  goals gold`, [225, 225, 230]);
  writePNG(outPath, ds.bytes, ds.ow, ds.oh);
}
// minimal 3x5 digit/letter font (subset) for labels
const TF = { '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'], '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'], '.': ['000', '000', '000', '000', '010'], '=': ['000', '111', '000', '111', '000'], '>': ['100', '010', '001', '010', '100'], '<': ['001', '010', '100', '010', '001'], ' ': ['000', '000', '000', '000', '000'], G: ['111', '100', '101', '101', '111'], A: ['111', '101', '111', '101', '101'], R: ['110', '101', '110', '101', '101'], N: ['101', '111', '111', '111', '101'], '/': ['001', '001', '010', '100', '100'], e: ['000', '111', '110', '100', '111'], a: ['000', '111', '101', '101', '111'], c: ['000', '111', '100', '100', '111'], h: ['100', '100', '110', '101', '101'], r: ['000', '110', '100', '100', '100'], m: ['000', '111', '111', '101', '101'], i: ['010', '000', '010', '010', '010'], n: ['000', '110', '101', '101', '101'], o: ['000', '010', '101', '101', '010'], s: ['000', '011', '110', '011', '110'], l: ['100', '100', '100', '100', '100'], d: ['001', '001', '111', '101', '111'], g: ['000', '111', '101', '111', '001'], b: ['100', '100', '110', '101', '110'], u: ['000', '101', '101', '101', '111'], p: ['000', '110', '101', '110', '100'], t: ['010', '111', '010', '010', '010'], w: ['000', '101', '101', '111', '111'], y: ['000', '101', '101', '011', '110'], v: ['000', '101', '101', '010', '010'], k: ['100', '101', '110', '101', '101'], f: ['011', '100', '110', '100', '100'], x: ['000', '101', '010', '101', '000'] };
function drawTiny(bytes, W, H, x, y, str, rgb, scale = 2) { let cxp = x; for (const ch of str) { const g = TF[ch] || TF[' ']; for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (g[row][col] === '1') for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const px = cxp + col * scale + sx, py = y + row * scale + sy; if (px >= 0 && py >= 0 && px < W && py < H) { const o = (py * W + px) * 3; bytes[o] = rgb[0]; bytes[o + 1] = rgb[1]; bytes[o + 2] = rgb[2]; } } cxp += 4 * scale; } }

main();
