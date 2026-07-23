// ═══════════════════════════════════════════════════════════════════════════
// SEXTANT TERRAIN rung-1 — DTM MATCH + geometry regime (IMG_1653)
// ═══════════════════════════════════════════════════════════════════════════
// Consumes silhouette.json. Does three things, all EVIDENCE-ONLY:
//  (1) GEOMETRY REGIME: fit the tower axes to a vanishing point (image of the
//      zenith, since broadcast towers are plumb) → the frame-center ALTITUDE.
//      This tells us whether any terrain horizon is even inside the field.
//  (2) MEASURED SKYLINE: convert the per-column envelope to an angular profile
//      alt(az_offset) via a rectilinear pinhole model (APPROXIMATE — the Rokinon
//      14mm has barrel distortion; absolute az/alt/roll are UNKNOWN fit params).
//  (3) DTM MATCH: for a grid of candidate observer locations, predict the terrain
//      horizon and score its SHAPE agreement (NCC — invariant to the unknown
//      vertical pointing offset & scale) with the measured skyline, optimizing
//      over absolute azimuth AZ0. Negative controls: az-shuffled measured profile
//      + an ocean/flat observer. A verdict is only "measured" if the real match
//      beats BOTH controls decisively; otherwise NOT_MEASURED with the predicate.
//
// USAGE: node tools/sextant/terrain/match_dtm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { predictHorizon } from '../../dtm/horizon_predict.mjs';
import { elevationAt } from '../../dtm/dtm_sampler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(ROOT, 'test_results', 'sextant_terrain');
const sil = JSON.parse(fs.readFileSync(path.join(OUT, 'silhouette.json'), 'utf8'));
const W = sil.width, H = sil.height;

// ── rig / optics (APPROXIMATE angular model) ────────────────────────────────
// Canon T6 (1300D): 22.3mm sensor / 5184 px → 4.30 µm pitch. Rokinon 14mm real
// (EXIF lies 50mm). Native f_px = 14mm/4.30µm = 3255. Preview is W/5184 of native.
const SENSOR_W_MM = 22.3, NATIVE_W_PX = 5184;
const PITCH_MM = SENSOR_W_MM / NATIVE_W_PX;       // 0.004302 mm = 4.302 µm
const PIX_PITCH_UM = PITCH_MM * 1000;             // 4.302 µm
const F_NATIVE_PX = 14.0 / PITCH_MM;              // 14 mm / pitch → 3254.6 px
const F_PX = F_NATIVE_PX * (W / NATIVE_W_PX);     // preview focal length in px ≈ 466
const CX = (W - 1) / 2, CY = (H - 1) / 2;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const HFOV_rect = 2 * Math.atan((W / 2) / F_PX) * R2D;
const VFOV_rect = 2 * Math.atan((H / 2) / F_PX) * R2D;
const MT_WILSON = { lat: 34.2257, lon: -118.0625, name: 'Mt Wilson antenna farm' };

// ── (1) vanishing point from tower axes ─────────────────────────────────────
// Each near-vertical elongated component is a plumb tower; its image axis passes
// through the zenith projection. LS-intersect the lines (perpendicular residual).
function vanishingPoint(components) {
  const towers = components.filter((c) => c.elongation > 2.5 && c.vext > 40);
  // normal equations Σ nnᵀ p = Σ n(n·c),  n = unit normal to axis dir (dx,dy)
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const c of towers) {
    const nx = -c.dy, ny = c.dx;                  // normal to axis
    const nc = nx * c.cx + ny * c.cy;
    a11 += nx * nx; a12 += nx * ny; a22 += ny * ny; b1 += nx * nc; b2 += ny * nc;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return null;
  const vx = (b1 * a22 - b2 * a12) / det;
  const vy = (a11 * b2 - a12 * b1) / det;
  // spread of residuals (how well the towers agree on one point)
  let res = 0;
  for (const c of towers) { const nx = -c.dy, ny = c.dx; const d = nx * (vx - c.cx) + ny * (vy - c.cy); res += d * d; }
  return { vx, vy, n_towers: towers.length, rms_residual_px: Math.sqrt(res / towers.length) };
}

// rectilinear pixel → angle from optical axis
const angFromAxisDeg = (dxpx, dypx) => Math.atan(Math.hypot(dxpx, dypx) / F_PX) * R2D;

// ── (2) measured angular skyline from the envelope (foreground columns) ──────
function measuredProfile() {
  const pts = [];
  for (let x = 0; x < W; x++) {
    const yr = sil.envelope_row[x];
    if (yr < 0) continue;                          // pure-sky column: skyline is BELOW frame (unseen)
    const azOff = Math.atan((x - CX) / F_PX) * R2D;         // horizontal angle from axis
    const altRel = Math.atan(-(yr - CY) / F_PX) * R2D;      // vertical angle above axis (y-up)
    pts.push({ x, azOff, altRel, cls: sil.col_class[x] });
  }
  return pts;
}

// ── NCC over paired samples ─────────────────────────────────────────────────
function ncc(a, b) {
  const n = a.length; if (n < 8) return -2;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  if (sa < 1e-9 || sb < 1e-9) return -2;
  return sab / Math.sqrt(sa * sb);
}

// horizon lookup: interpolate DTM horizon alt at an absolute azimuth
function horizonAlt(hz, azStep, azAbs) {
  let a = ((azAbs % 360) + 360) % 360;
  const i0 = Math.floor(a / azStep), f = (a - i0 * azStep) / azStep;
  const n = hz.length;
  const p0 = hz[i0 % n], p1 = hz[(i0 + 1) % n];
  if (p0 == null || p1 == null) return null;
  return p0 * (1 - f) + p1 * f;
}

// best NCC over absolute azimuth AZ0 for one location's horizon
function matchLocation(meas, hzArr, azStep, az0Step = 2) {
  const azOffs = meas.map((p) => p.azOff);
  const measAlt = meas.map((p) => p.altRel);
  let best = { ncc: -2, az0: null };
  for (let az0 = 0; az0 < 360; az0 += az0Step) {
    const pred = [], obs = [];
    for (let j = 0; j < azOffs.length; j++) {
      const h = horizonAlt(hzArr, azStep, az0 + azOffs[j]);
      if (h == null) continue;
      pred.push(h); obs.push(measAlt[j]);
    }
    if (pred.length < meas.length * 0.6) continue;   // need most samples covered
    const s = ncc(obs, pred);
    if (s > best.ncc) best = { ncc: s, az0, covered: pred.length };
  }
  return best;
}

function predictArr(lat, lon, { maxKm = 60, azStep = 1, stepKm = 0.05 } = {}) {
  try {
    const r = predictHorizon({ lat, lon, heightAgl: 2, azStepDeg: azStep, maxKm, stepKm });
    return { arr: r.horizon.map((p) => p.alt_deg), azStep, obs: r.observer };
  } catch (e) { return null; }
}

function main() {
  const t0 = Date.now();
  const comps = sil.components || [];
  const vp = vanishingPoint(comps);

  // frame-center altitude from the VP (VP = zenith image)
  let geom = { vanishing_point: vp };
  if (vp) {
    const angCenterToZenith = angFromAxisDeg(vp.vx - CX, vp.vy - CY);
    geom.center_altitude_deg = +(90 - angCenterToZenith).toFixed(2);
    geom.zenith_offset_from_center_deg = +angCenterToZenith.toFixed(2);
    geom.vp_inside_frame = vp.vx >= 0 && vp.vx < W && vp.vy >= 0 && vp.vy < H;
    // altitude of the frame BOTTOM-edge center column (lowest the frame can see)
    geom.bottom_edge_center_alt_deg = +(geom.center_altitude_deg - angFromAxisDeg(0, (H - 1) - CY)).toFixed(2);
  }

  const meas = measuredProfile();
  const measAlts = meas.map((p) => p.altRel);
  const measStats = {
    n_envelope_columns: meas.length,
    alt_min_deg: +Math.min(...measAlts).toFixed(2),
    alt_max_deg: +Math.max(...measAlts).toFixed(2),
    alt_median_deg: +measAlts.slice().sort((a, b) => a - b)[measAlts.length >> 1].toFixed(2),
    az_offset_span_deg: [+Math.min(...meas.map(p => p.azOff)).toFixed(2), +Math.max(...meas.map(p => p.azOff)).toFixed(2)],
    note: 'altRel = angle ABOVE optical axis; add the (unknown) center altitude for absolute alt',
  };

  // ── (3) DTM match over a location grid ──────────────────────────────────
  const grid = [];
  for (let lat = 33.6; lat <= 34.65 + 1e-9; lat += 0.15)
    for (let lon = -118.95; lon <= -117.55 + 1e-9; lon += 0.15)
      grid.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3) });
  grid.push({ lat: MT_WILSON.lat, lon: MT_WILSON.lon, tag: 'MT_WILSON' });

  const scored = [];
  for (const g of grid) {
    const pr = predictArr(g.lat, g.lon);
    if (!pr || pr.arr.every((v) => v == null)) { scored.push({ ...g, ncc: null, reason: 'no_dtm' }); continue; }
    const nValid = pr.arr.filter((v) => v != null).length;
    const m = matchLocation(meas, pr.arr, pr.azStep);
    scored.push({ ...g, ncc: +m.ncc.toFixed(4), az0: m.az0, dtm_valid_az: nValid, ground_m: pr.obs.ground_elev_m });
  }
  const ranked = scored.filter((s) => s.ncc != null).sort((a, b) => b.ncc - a.ncc);
  const best = ranked[0];
  const mtw = scored.find((s) => s.tag === 'MT_WILSON');

  // ── negative controls ─────────────────────────────────────────────────────
  // C1: az-shuffled measured profile vs the SAME best-location horizon
  const bestPr = best ? predictArr(best.lat, best.lon) : null;
  const shuffled = meas.map((p, i) => ({ ...p, altRel: meas[(i * 2654435761 % meas.length + meas.length) % meas.length].altRel }));
  const c1 = bestPr ? matchLocation(shuffled, bestPr.arr, bestPr.azStep) : { ncc: -2 };
  // C2: an offshore/flat observer (deep water — bathymetry-merged tiles), all-real profile
  const oceanPr = predictArr(33.65, -118.85);
  const c2 = oceanPr && !oceanPr.arr.every((v) => v == null) ? matchLocation(meas, oceanPr.arr, oceanPr.azStep) : { ncc: -2 };

  // distance from best-fit to Mt Wilson
  const hav = (la1, lo1, la2, lo2) => {
    const R = 6371, dLa = (la2 - la1) * D2R, dLo = (lo2 - lo1) * D2R;
    const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const bestKmFromMtW = best ? +hav(best.lat, best.lon, MT_WILSON.lat, MT_WILSON.lon).toFixed(1) : null;

  // peak sharpness: how much the top score exceeds the grid mean/2nd (in σ units)
  const nccs = ranked.map((r) => r.ncc);
  const mean = nccs.reduce((a, b) => a + b, 0) / nccs.length;
  const sd = Math.sqrt(nccs.reduce((a, b) => a + (b - mean) ** 2, 0) / nccs.length);
  const peakZ = sd > 1e-6 ? +((best.ncc - mean) / sd).toFixed(2) : null;

  // verdict logic — must beat BOTH controls by a clear margin AND be a genuine match
  const beatsShuffle = best.ncc - c1.ncc;
  const beatsOcean = best.ncc - c2.ncc;
  const decisive = best.ncc > 0.6 && beatsShuffle > 0.25 && beatsOcean > 0.25 && peakZ > 3;

  const result = {
    experiment: 'sextant rung-1 terrain-match — IMG_1653 (radio towers, location-unknown)',
    timestamp_utc: new Date().toISOString(),
    optics: { rig: 'Canon T6 + Rokinon 14mm (real; EXIF lies 50mm)', pix_pitch_um: +PIX_PITCH_UM.toFixed(4),
      f_px_preview: +F_PX.toFixed(1), hfov_rect_deg: +HFOV_rect.toFixed(1), vfov_rect_deg: +VFOV_rect.toFixed(1),
      angular_model: 'rectilinear pinhole, distortion IGNORED — APPROXIMATE (14mm barrel distortion not corrected)',
      note: 'linear plate-scale (63.35"/px) extrapolates to ~91x61 deg; rectilinear pinhole gives ~78x56 deg; truth is between (barrel).' },
    geometry_regime: geom,
    measured_skyline: measStats,
    match: {
      grid_size: grid.length, grid_extent: 'lat[33.6,34.65] lon[-118.95,-117.55] step 0.15 + Mt Wilson',
      best_fit: best ? { lat: best.lat, lon: best.lon, ncc: best.ncc, az0_deg: best.az0, tag: best.tag || null } : null,
      best_km_from_mt_wilson: bestKmFromMtW,
      mt_wilson_score: mtw ? { ncc: mtw.ncc, az0_deg: mtw.az0 } : null,
      peak_sharpness_z: peakZ,
      grid_ncc_mean: +mean.toFixed(4), grid_ncc_sd: +sd.toFixed(4),
      top5: ranked.slice(0, 5).map((r) => ({ lat: r.lat, lon: r.lon, ncc: r.ncc, tag: r.tag || null })),
    },
    negative_controls: {
      shuffled_measured_vs_best: +c1.ncc.toFixed(4),
      'ocean_observer_33.65N_118.85W': +c2.ncc.toFixed(4),
      best_minus_shuffle: +beatsShuffle.toFixed(4),
      best_minus_ocean: +beatsOcean.toFixed(4),
    },
    verdict: decisive ? 'MATCH' : 'NOT_MEASURED',
    predicate: decisive ? 'real match beat both controls decisively'
      : 'best-fit NCC does not decisively beat the negative controls AND/OR the frame contains no ground-terrain skyline (see geometry_regime + measured_skyline): the sky-boundary silhouette is man-made towers + vegetation at high altitude, not a terrain ridge; the up-looking composition places any DTM horizon below the field of view.',
    runtime_s: +((Date.now() - t0) / 1000).toFixed(1),
  };

  fs.writeFileSync(path.join(OUT, 'MATCH_RESULT.json'), JSON.stringify(result, null, 2));

  // score-map PNG (NCC over the location grid)
  renderScoreMap(scored, best);

  console.log(JSON.stringify(result, null, 2));
}

function renderScoreMap(scored, best) {
  const lats = [...new Set(scored.filter(s => !s.tag).map(s => s.lat))].sort((a, b) => a - b);
  const lons = [...new Set(scored.filter(s => !s.tag).map(s => s.lon))].sort((a, b) => a - b);
  const cell = 46, pad = 60;
  const Wp = pad * 2 + lons.length * cell, Hp = pad * 2 + lats.length * cell;
  const png = new PNG({ width: Wp, height: Hp, fill: true });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = png.data[i + 1] = png.data[i + 2] = 245; png.data[i + 3] = 255; }
  const vals = scored.filter(s => s.ncc != null).map(s => s.ncc);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const put = (x, y, r, g, b) => { if (x < 0 || x >= Wp || y < 0 || y >= Hp) return; const i = (y * Wp + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; };
  for (const s of scored) {
    if (s.tag || s.ncc == null) continue;
    const ci = lons.indexOf(s.lon), ri = lats.length - 1 - lats.indexOf(s.lat);
    const t = (s.ncc - lo) / Math.max(1e-6, hi - lo);
    const r = Math.round(30 + 225 * t), g = Math.round(30 + 120 * t), b = Math.round(120 - 90 * t);
    for (let dy = 0; dy < cell - 2; dy++) for (let dx = 0; dx < cell - 2; dx++) put(pad + ci * cell + dx, pad + ri * cell + dy, r, g, b);
  }
  // mark Mt Wilson + best with a ring outline
  const mark = (lat, lon, col) => {
    // nearest grid cell
    let bi = 0, bd = Infinity; const cells = scored.filter(s => !s.tag);
    cells.forEach((s, k) => { const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2; if (d < bd) { bd = d; bi = k; } });
    const s = cells[bi]; const ci = lons.indexOf(s.lon), ri = lats.length - 1 - lats.indexOf(s.lat);
    for (let d = 0; d < cell - 2; d++) { put(pad + ci * cell + d, pad + ri * cell, ...col); put(pad + ci * cell + d, pad + ri * cell + cell - 3, ...col); put(pad + ci * cell, pad + ri * cell + d, ...col); put(pad + ci * cell + cell - 3, pad + ri * cell + d, ...col); }
  };
  mark(MT_WILSON.lat, MT_WILSON.lon, [255, 255, 0]);      // Mt Wilson = yellow ring
  if (best && !best.tag) mark(best.lat, best.lon, [0, 255, 255]); // best = cyan ring
  fs.writeFileSync(path.join(OUT, 'score_map.png'), PNG.sync.write(png));
}

main();
