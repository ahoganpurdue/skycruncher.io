// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — OCCLUSION-MASK STACK (admission-controls wave, LAW-4, tools/ only)
// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH INCUBATOR (banked data only; nothing feeds a solve). Builds the mask
// stack that tells the completion gate WHERE NOT to trust mesh completions:
// extended-object footprints, confusion-limited density cells, bright-star
// bloom halos, and frame-derived structured background (terrain/foliage/nebular
// filaments). Output = a cell/region mask + per-region reason codes for
// receipts (OCCLUDED:<reason>). Motivating cases (mesh_gate3 GATE3_VERDICT
// admission_controls_motivation; row 530): the beach nightscape's central Milky
// Way + the IMG_1757 rotated-vertical terrain frame-left.
//
// LAYERS:
//  (a) DSO_FOOTPRINT  — Messier/NGC/IC + the bundled offline DSO catalog
//      (src/engine/data/hyg-database/.../dso.csv.gz, r1 semi-major arcmin;
//      loaded read-only the same way tools/theses/pdgp_gazetteer_prior.mjs does)
//      projected through the frame WCS -> extent disks.
//  (b) GAIA_DENSITY   — g15u catalog stars/beam per cell over a confusion
//      threshold (prior art tools/mesh/density_metric.mjs verdict >0.5).
//  (c) BRIGHT_HALO    — catalog-mag -> bloom-radius disks (cite the depth-guard
//      'structured' saturation work: bright cores clip and bloom).
//  (d) STRUCTURE      — frame-derived: per-cell robust sigma >> global sky sigma
//      (the SAME 'structured' guard forced_detect.forcedMeasure applies). Simple
//      by design; labelled APPROXIMATE.
//
//   node tools/mesh/occlusion_mask.mjs --frame IMG_1757 \
//     --meta   D:/.../IMG_1757_capture_meta.json \
//     --buffer D:/.../IMG_1757.f32 --dims D:/.../IMG_1757.dims.json \
//     [--matches ... --oracle-wcs ...  (adds the unmasked-false-rate validation)]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward } from '../psf/forced_detect.mjs';
import { robustStats, makeStretch, downscaleRGB, plotPoint, writePNG } from '../psf/imaging.mjs';
import { MESSIER, EXTRAS } from '../priors/bright_objects.mjs';

const D2R = Math.PI / 180;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');

// ── offline DSO gazetteer (read-only reuse of the pdgp loader shape) ──────────
// dso.csv columns: ra(HOURS),dec(deg),type,const,mag,name,...,r1(arcmin),...
export function loadDsoCatalog(p = path.join(ROOT, 'src', 'engine', 'data', 'hyg-database', 'data', 'misc', 'dso.csv.gz')) {
  const txt = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
  const lines = txt.split('\n').filter((l) => l.trim());
  const H = lines[0].split(',');
  const ix = Object.fromEntries(H.map((h, i) => [h, i]));
  const parse = (line) => { const out = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const r = parse(lines[i]);
    const raH = parseFloat(r[ix.ra]), decD = parseFloat(r[ix.dec]);
    if (!Number.isFinite(raH) || !Number.isFinite(decD)) continue;
    const r1 = parseFloat(r[ix.r1]);
    const mag = parseFloat(r[ix.mag]);
    rows.push({ ra_deg: raH * 15, dec_deg: decD, r1_arcmin: Number.isFinite(r1) ? r1 : null, mag: Number.isFinite(mag) ? mag : null, name: r[ix.name] || '', cat: (r[ix.cat1] || '') + (r[ix.id1] || '') });
  }
  return rows;
}

// ── build the mask stack ─────────────────────────────────────────────────────
// Returns { grid, isMasked(x,y), summary } where grid is nx*ny cells with a
// dominant reason each. Disk layers (DSO/bright halo) are ALSO kept as region
// records so receipts can carry OCCLUDED:<reason> per region.
export function buildOcclusionMask({ meta, dims, L, starsPath, P = {} }) {
  const params = {
    cellPx: 96,
    dsoMagMax: 12, dsoR1MinArcmin: 2.0, dsoFloorFwhmMult: 3, dsoMargin: 1.2,
    densMagLimit: 15, densBeamFwhmMult: 1.0, densThreshPerBeam: 0.5,
    haloMag: 6.0, haloBasePx: 8, haloPerMagPx: 10, haloCapPx: 400,
    structMult: 3.0, structGradMult: 3.5, structSkyPct: 0.30,
    ...P,
  };
  const W = (dims && dims.width) || meta.width, H = (dims && dims.height) || meta.height;
  const wcs = meta.wcs; const crval = [wcs.CRVAL1, wcs.CRVAL2], crpix = [wcs.CRPIX1, wcs.CRPIX2];
  const cd = [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const scaleDeg = Math.sqrt(Math.abs(det)), scaleArcsec = scaleDeg * 3600;
  const FWHM = meta.mean_fwhm_px || 2.3;
  const hd = Math.hypot((W - 1) / 2, (H - 1) / 2);
  const coneR = Math.min(89, Math.atan(hd * scaleDeg * D2R) / D2R + 2);
  const sky2pix = (raDeg, decDeg) => { const p = tanForward(raDeg, decDeg, crval[0], crval[1]); if (!p) return null; return { x: crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det, y: crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det }; };

  const nx = Math.ceil(W / params.cellPx), ny = Math.ceil(H / params.cellPx);
  const nCells = nx * ny;
  // per-cell reason bitset (dominant reason recorded) + per-layer cell flags
  const reason = new Array(nCells).fill(null);
  const layerFlags = { DSO_FOOTPRINT: new Uint8Array(nCells), GAIA_DENSITY: new Uint8Array(nCells), BRIGHT_HALO: new Uint8Array(nCells), STRUCTURE: new Uint8Array(nCells) };
  const cellOf = (x, y) => { const gx = Math.min(nx - 1, Math.max(0, Math.floor(x / params.cellPx))); const gy = Math.min(ny - 1, Math.max(0, Math.floor(y / params.cellPx))); return gy * nx + gx; };
  const stampDisk = (cx, cy, r, layer) => { const gx0 = Math.max(0, Math.floor((cx - r) / params.cellPx)), gx1 = Math.min(nx - 1, Math.floor((cx + r) / params.cellPx)); const gy0 = Math.max(0, Math.floor((cy - r) / params.cellPx)), gy1 = Math.min(ny - 1, Math.floor((cy + r) / params.cellPx)); for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) { const ccx = (gx + 0.5) * params.cellPx, ccy = (gy + 0.5) * params.cellPx; if (Math.hypot(ccx - cx, ccy - cy) <= r + params.cellPx * 0.5) layerFlags[layer][gy * nx + gx] = 1; } };

  const regions = []; // disk regions for receipts

  // ── (a) DSO footprints ──
  const named = []; // Messier/EXTRAS
  for (const [k, v] of Object.entries(MESSIER)) named.push({ id: 'M' + k, ra_deg: v.ra, dec_deg: v.dec, r1_arcmin: null, name: v.name });
  for (const [k, v] of Object.entries(EXTRAS)) named.push({ id: k, ra_deg: v.ra, dec_deg: v.dec, r1_arcmin: null, name: v.name });
  const dso = loadDsoCatalog();
  const dsoFloorPx = params.dsoFloorFwhmMult * FWHM;
  let dsoStamped = 0;
  const considerDso = (o, src) => {
    const p = sky2pix(o.ra_deg, o.dec_deg); if (!p) return;
    // extent radius in px (r1 semi-major arcmin -> px), floored to a min footprint
    const rPx = Math.max(dsoFloorPx, (o.r1_arcmin ? o.r1_arcmin * 60 / scaleArcsec : dsoFloorPx));
    if (p.x < -rPx * params.dsoMargin || p.y < -rPx * params.dsoMargin || p.x >= W + rPx * params.dsoMargin || p.y >= H + rPx * params.dsoMargin) return;
    stampDisk(p.x, p.y, rPx, 'DSO_FOOTPRINT'); dsoStamped++;
    regions.push({ reason: 'DSO_FOOTPRINT', src, id: o.id || o.cat || null, name: o.name || null, x: +p.x.toFixed(1), y: +p.y.toFixed(1), r_px: +rPx.toFixed(1), r1_arcmin: o.r1_arcmin ?? null, mag: o.mag ?? null });
  };
  for (const o of named) considerDso(o, 'messier_ngc_ic');
  for (const o of dso) { if ((o.r1_arcmin != null && o.r1_arcmin >= params.dsoR1MinArcmin) || (o.mag != null && o.mag <= params.dsoMagMax)) considerDso(o, 'dso_catalog'); }

  // ── catalog for (b) density + (c) halos ──
  const g15 = regionStars({ starsArrowPath: starsPath, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit: params.densMagLimit });
  const catPix = [];
  for (const s of g15) { const p = sky2pix(s.ra_deg, s.dec_deg); if (!p) continue; if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) continue; catPix.push({ x: p.x, y: p.y, mag: s.mag }); }

  // ── (b) Gaia density per cell ──
  const beamR = params.densBeamFwhmMult * FWHM; const beamArea = Math.PI * beamR * beamR;
  const cellArea = params.cellPx * params.cellPx;
  const cellCount = new Float64Array(nCells);
  for (const s of catPix) cellCount[cellOf(s.x, s.y)]++;
  const cellDensPerBeam = new Float64Array(nCells);
  let densMasked = 0;
  for (let i = 0; i < nCells; i++) { const perBeam = cellCount[i] * beamArea / cellArea; cellDensPerBeam[i] = perBeam; if (perBeam > params.densThreshPerBeam) { layerFlags.GAIA_DENSITY[i] = 1; densMasked++; } }

  // ── (c) bright-star bloom halos ──
  let haloStamped = 0;
  for (const s of catPix) { if (s.mag > params.haloMag) continue; const rPx = Math.min(params.haloCapPx, params.haloBasePx + params.haloPerMagPx * (params.haloMag - s.mag)); stampDisk(s.x, s.y, rPx, 'BRIGHT_HALO'); haloStamped++; regions.push({ reason: 'BRIGHT_HALO', src: 'g15u', mag: +s.mag.toFixed(2), x: +s.x.toFixed(1), y: +s.y.toFixed(1), r_px: +rPx.toFixed(1) }); }

  // ── (d) frame-derived structure mask (APPROXIMATE) ──
  // global sky sigma (robust), then per-cell robust sigma; a cell whose robust
  // sigma exceeds structMult * global sigma is STRUCTURED (terrain/foliage/
  // nebular filaments) — identical criterion to forcedMeasure's 'structured'
  // guard (sig > 3*sigmaPix). APPROXIMATE: coarse-cell, no star masking first.
  let structMasked = 0, globalSigma = null, skySigma = null, skyGrad = null;
  if (L) {
    // Two APPROXIMATE frame-derived signals, OR-combined:
    //  (i) per-cell robust sigma (the forcedMeasure 'structured' guard) — catches
    //      bright structured background (Milky Way, nebular filaments);
    //  (ii) per-cell mean |gradient| ENERGY — catches high-frequency foreground
    //      (foliage/tree-branch edges) that a smooth-dark silhouette misses on
    //      variance alone. Both are keyed off a SKY floor estimated from the
    //      quietest cells (low percentile), because a whole-frame statistic is
    //      inflated by the very structure we want to flag (IMG_1757 global MAD
    //      is ~10x the true sky sigma).
    // Known gap (honest): a smooth solid-dark silhouette (low variance AND low
    // gradient interior) is only caught at its edges — full horizon-fill needs a
    // horizon/terrain model, not a per-cell texture statistic.
    const cellSig = new Float64Array(nCells).fill(NaN);
    const cellGrad = new Float64Array(nCells).fill(NaN);
    for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
      const x0 = gx * params.cellPx, y0 = gy * params.cellPx;
      const x1 = Math.min(W, x0 + params.cellPx), y1 = Math.min(H, y0 + params.cellPx);
      const buf = []; let gsum = 0, gn = 0;
      for (let y = y0; y < y1; y += 2) { const row = y * W; for (let x = x0; x < x1; x += 2) { buf.push(L[row + x]); if (x + 1 < x1 && y + 1 < y1) { gsum += Math.abs(L[row + x + 1] - L[row + x]) + Math.abs(L[row + W + x] - L[row + x]); gn++; } } }
      if (buf.length < 16) continue;
      buf.sort((a, b) => a - b); const med = buf[buf.length >> 1];
      const dev = buf.map((v) => Math.abs(v - med)).sort((a, b) => a - b); cellSig[gy * nx + gx] = 1.4826 * dev[dev.length >> 1];
      cellGrad[gy * nx + gx] = gn ? gsum / gn : NaN;
    }
    globalSigma = robustStats(L, 300000).sigma;
    const finiteSig = [...cellSig].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const finiteGrad = [...cellGrad].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    skySigma = finiteSig.length ? finiteSig[Math.floor(finiteSig.length * params.structSkyPct)] : globalSigma;
    skyGrad = finiteGrad.length ? finiteGrad[Math.floor(finiteGrad.length * params.structSkyPct)] : null;
    const thrSig = params.structMult * (skySigma || 1e-6);
    const thrGrad = skyGrad != null ? params.structGradMult * (skyGrad || 1e-6) : Infinity;
    for (let i = 0; i < nCells; i++) { const sBad = Number.isFinite(cellSig[i]) && cellSig[i] > thrSig; const gBad = Number.isFinite(cellGrad[i]) && cellGrad[i] > thrGrad; if (sBad || gBad) { layerFlags.STRUCTURE[i] = 1; structMasked++; } }
  }

  // ── combine: dominant reason per cell (priority order) ──
  const priority = ['STRUCTURE', 'DSO_FOOTPRINT', 'GAIA_DENSITY', 'BRIGHT_HALO'];
  const maskedCell = new Uint8Array(nCells);
  const perReasonCells = { STRUCTURE: 0, DSO_FOOTPRINT: 0, GAIA_DENSITY: 0, BRIGHT_HALO: 0 };
  for (let i = 0; i < nCells; i++) { for (const r of priority) if (layerFlags[r][i]) { reason[i] = r; maskedCell[i] = 1; perReasonCells[r]++; break; } }
  const maskedN = maskedCell.reduce((a, b) => a + b, 0);

  const isMasked = (x, y) => { const gx = Math.floor(x / params.cellPx), gy = Math.floor(y / params.cellPx); if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return null; const i = gy * nx + gx; return maskedCell[i] ? reason[i] : null; };

  const summary = {
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: +FWHM.toFixed(3) },
    grid: { cell_px: params.cellPx, nx, ny, n_cells: nCells },
    params,
    global_mad_sigma: globalSigma == null ? null : +globalSigma.toFixed(5),
    sky_sigma_est: skySigma == null ? null : +skySigma.toFixed(5),
    masked_fraction: +(maskedN / nCells).toFixed(4),
    masked_cells: maskedN,
    per_reason_cells: perReasonCells,
    per_reason_fraction: Object.fromEntries(Object.entries(perReasonCells).map(([k, v]) => [k, +(v / nCells).toFixed(4)])),
    layers: {
      DSO_FOOTPRINT: { disks_stamped: dsoStamped, cells: layerFlags.DSO_FOOTPRINT.reduce((a, b) => a + b, 0) },
      GAIA_DENSITY: { thresh_per_beam: params.densThreshPerBeam, beam_radius_px: +beamR.toFixed(2), cells: densMasked },
      BRIGHT_HALO: { halo_mag: params.haloMag, disks_stamped: haloStamped, cells: layerFlags.BRIGHT_HALO.reduce((a, b) => a + b, 0) },
      STRUCTURE: { struct_mult: params.structMult, struct_grad_mult: params.structGradMult, sky_grad_est: skyGrad == null ? null : +skyGrad.toFixed(4), approximate: true, cells: structMasked },
    },
    region_count: regions.length,
  };
  return { grid: { nx, ny, cellPx: params.cellPx, maskedCell, reason }, layerFlags, cellDensPerBeam, isMasked, regions, summary, W, H, FWHM, catPix };
}

// ── overlay PNG: stretched frame + per-reason mask tint (+ optional completions)
export function renderMaskOverlay(outPath, L, mask, W, H, { outW = 1200, completions = null, labels = null } = {}) {
  const stretch = makeStretch([L]); stretch.lo = [stretch.lo[0], stretch.lo[0], stretch.lo[0]]; stretch.hi = [stretch.hi[0], stretch.hi[0], stretch.hi[0]];
  const ds = downscaleRGB(L, L, L, W, H, outW, stretch); const sc = ds.scale;
  const tint = { STRUCTURE: [180, 90, 40], DSO_FOOTPRINT: [150, 60, 200], GAIA_DENSITY: [40, 120, 200], BRIGHT_HALO: [210, 190, 40] };
  // tint masked cells (blend)
  const { nx, ny, cellPx, maskedCell, reason } = mask.grid;
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) { const i = gy * nx + gx; if (!maskedCell[i]) continue; const rgb = tint[reason[i]] || [120, 120, 120]; const x0 = Math.floor(gx * cellPx * sc), x1 = Math.ceil((gx + 1) * cellPx * sc), y0 = Math.floor(gy * cellPx * sc), y1 = Math.ceil((gy + 1) * cellPx * sc); for (let y = y0; y < y1 && y < ds.oh; y++) for (let x = x0; x < x1 && x < ds.ow; x++) { const o = (y * ds.ow + x) * 3; for (let c = 0; c < 3; c++) ds.bytes[o + c] = Math.round(ds.bytes[o + c] * 0.72 + rgb[c] * 0.28); } }
  // completions: green=unmasked-true, magenta=unmasked-false, dim=masked
  if (completions) {
    const mark = (x, y, rgb, rad = 2) => { for (let dx = -rad; dx <= rad; dx++) { plotPoint(ds.bytes, ds.ow, ds.oh, x + dx, y, rgb, 0.95); plotPoint(ds.bytes, ds.ow, ds.oh, x, y + dx, rgb, 0.95); } };
    for (const c of completions) { const masked = mask.isMasked(c.x, c.y); const lab = labels ? labels.get(c.id) : null; const isFalse = lab ? lab.isFalse : null; let rgb; if (masked) rgb = [90, 90, 90]; else if (isFalse === true) rgb = [255, 60, 200]; else if (isFalse === false) rgb = [60, 230, 90]; else rgb = [200, 200, 60]; mark(c.x * sc, c.y * sc, rgb, masked ? 1 : 2); } }
  return writePNG(outPath, ds.bytes, ds.ow, ds.oh);
}

// ── unmasked-region false-rate validation (needs matches + oracle labels) ─────
export function validateMaskAgainstLabels(mask, completions, labels) {
  const bin = (r) => (r < 0.70 ? '0.00-0.70' : (r < 0.85 ? '0.70-0.85' : '0.85-1.00'));
  const acc = { all: { n: 0, false: 0 }, unmasked: { n: 0, false: 0 }, masked: { n: 0, false: 0 } };
  const byReason = {}; const byBand = {};
  for (const c of completions) {
    const lab = labels.get(c.id); if (!lab) continue;
    const isF = lab.isFalse ? 1 : 0;
    const m = mask.isMasked(c.x, c.y);
    acc.all.n++; acc.all.false += isF;
    const b = bin(c.r_norm);
    byBand[b] = byBand[b] || { all: { n: 0, false: 0 }, unmasked: { n: 0, false: 0 } };
    byBand[b].all.n++; byBand[b].all.false += isF;
    if (m) { acc.masked.n++; acc.masked.false += isF; byReason[m] = byReason[m] || { n: 0, false: 0 }; byReason[m].n++; byReason[m].false += isF; }
    else { acc.unmasked.n++; acc.unmasked.false += isF; byBand[b].unmasked.n++; byBand[b].unmasked.false += isF; }
  }
  const rate = (o) => o.n ? +(o.false / o.n).toFixed(3) : null;
  return {
    completions_total: acc.all.n,
    masked_completion_fraction: acc.all.n ? +(acc.masked.n / acc.all.n).toFixed(3) : null,
    false_rate_all: rate(acc.all), false_rate_unmasked: rate(acc.unmasked), false_rate_masked: rate(acc.masked),
    unmasked_n: acc.unmasked.n, masked_n: acc.masked.n,
    per_reason_masked: Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, { n: v.n, false_rate: rate(v) }])),
    per_band: Object.fromEntries(Object.entries(byBand).map(([k, v]) => [k, { all: { n: v.all.n, false_rate: rate(v.all) }, unmasked: { n: v.unmasked.n, false_rate: rate(v.unmasked) } }])),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const IS_MAIN = process.argv[1] && (() => { try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch { return false; } })();
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const frame = A('--frame', 'frame');
  const meta = JSON.parse(fs.readFileSync(A('--meta'), 'utf8'));
  let dims = null; const dp = A('--dims', null); if (dp) dims = JSON.parse(fs.readFileSync(dp, 'utf8'));
  const W = (dims && dims.width) || meta.width, H = (dims && dims.height) || meta.height;
  const bufPath = A('--buffer', null);
  let L = null; if (bufPath) { const raw = fs.readFileSync(bufPath); L = new Float32Array(raw.buffer, raw.byteOffset, W * H); }
  const starsPath = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
  const out = A('--out', 'D:/AstroLogic/test_artifacts/admission_controls_2026-07-22');
  fs.mkdirSync(out, { recursive: true });
  const P = {};
  for (const [flag, key] of [['--dens-mag-limit', 'densMagLimit'], ['--dens-thresh', 'densThreshPerBeam'], ['--struct-mult', 'structMult'], ['--halo-mag', 'haloMag'], ['--cell-px', 'cellPx']]) { const v = A(flag, null); if (v != null) P[key] = parseFloat(v); }

  const mask = buildOcclusionMask({ meta, dims, L, starsPath, P });
  let validation = null, completions = null, labels = null;
  const matchesPath = A('--matches', null), oracleWcs = A('--oracle-wcs', null);
  if (matchesPath && oracleWcs) {
    const gate = await import('./completion_gate.mjs');
    const owcs = gate.parseAnetWcs(oracleWcs); const sky2truth = gate.makeSkyToPixel(owcs);
    const crval = [meta.wcs.CRVAL1, meta.wcs.CRVAL2]; const FWHM = meta.mean_fwhm_px || 2.3; const tol2 = 2 * FWHM;
    const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
    const all = JSON.parse(fs.readFileSync(matchesPath, 'utf8')).matches;
    completions = all.filter((m) => m.source === 'mesh').map((m) => ({ ...m, r_norm: m.r_norm ?? Math.hypot(m.x - cx, m.y - cy) / hd }));
    labels = new Map();
    for (const c of completions) { const rd = gate.invTangent(c.xi, c.eta, crval[0], crval[1]); const t = sky2truth(rd.ra_deg, rd.dec_deg); if (!t) continue; labels.set(c.id, { isFalse: Math.hypot(c.x - t.x, c.y - t.y) > tol2 }); }
    validation = validateMaskAgainstLabels(mask, completions, labels);
  }
  if (L) renderMaskOverlay(path.join(out, `${frame}_occlusion_overlay.png`), L, mask, W, H, { completions, labels });
  const summary = { frame, generated: new Date().toISOString(), lane: 'tools/mesh/occlusion_mask.mjs (admission-controls incubator, LAW-4)', ...mask.summary, mask_validation_vs_oracle: validation, outputs: { overlay_png: L ? path.join(out, `${frame}_occlusion_overlay.png`) : null } };
  fs.writeFileSync(path.join(out, `${frame}_occlusion_mask.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(out, `${frame}_occlusion_regions.json`), JSON.stringify({ frame, n: mask.regions.length, regions: mask.regions }, null, 2));
  console.log(JSON.stringify({ frame, image: mask.summary.image, masked_fraction: mask.summary.masked_fraction, per_reason_fraction: mask.summary.per_reason_fraction, layers: mask.summary.layers, mask_validation_vs_oracle: validation }, null, 2));
}
