// ═══════════════════════════════════════════════════════════════════════════
// tools/atmosphere/lib — star_table.ts : shared forced-photometry star table
// ═══════════════════════════════════════════════════════════════════════════
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md. This is the CANONICAL per-star
// measurement kernel (decode → catalog → geometry recovery → mutual-NN match →
// saturation cut → forced photometry per channel → raw Δm rows), extracted so
// increment 2's fit_vertical.runspec.ts consumes the SAME table increment 1's
// measure_sigma_star.runspec.ts computes — rather than re-measuring differently.
//
// It is a VERBATIM port of measure_sigma_star.runspec.ts §1–8 (byte-identical
// method, same imported engine `forcedMeasure`, same engineering constants),
// with two ADDITIVE fields the fit needs and inc 1 did not persist:
//   • catalog unit-vector inputs raH (HOURS) / decD (deg) per matched star
//   • per-channel snr per star
// It also returns sigma_by_mag / zeropoints so the fit is self-contained.
//
// CONSOLIDATION (Law 4 — police code in two places): DONE 2026-07-21 (orchestrator-
// gated grant). measure_sigma_star.runspec.ts NO LONGER carries an inline §1–8 copy —
// it imports buildStarTable() from here, so this is the ONE measurement implementation.
// Both consumers verified byte-identical post-consolidation (inc-1 sigma_star_cr2.json
// md5 d79bd703; inc-2 fit_vertical verdict md5 c29065eb). Three additive meta fields
// (geometry_tight_matches, rAp_px, counts.usable_before_photometry) surface diagnostics
// inc-1's receipt reports — inc-2's verdict is unaffected (uses only meta.frame +
// meta.engineering_values).
//
// TWO LEDGERS (Law 1): COORDINATE — catalog RA (HOURS) → gnomonic TAN about the
// solved anchor → anchored rotation/parity → NATIVE px. PIXEL — forced aperture
// photometry on the decoded R/G/B planes (native grid, no resample).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forcedMeasure } from '@/engine/pipeline/m6_plate_solve/deep_verify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS ingest helpers from the existing PSF lane (no .d.ts)
import { detectPattern, demosaicBilinear, splitRGB } from '../../psf/decode_cr2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const D2R = Math.PI / 180, H2R = Math.PI / 12;

// ── Initial engineering values (inc-1 README table; Law 2 — flag, don't tune) ──
const MATCH_TIGHT_PX = 12.0;
const GEOM_TIGHT_PX = 8.0;
const GEOM_MAG = 6.0;
const GEOM_ANCHOR_K = 8;
const SAT_FRAC = 0.70;
const MAD_K = 1.4826;
const MIN_BIN_N = 8;
const SNR_MIN = 3;
const FETCH_DEG = 22.7;

export type Band = 'GaiaG' | 'JohnsonV';
// Per-row colour PROVENANCE (never silently approximated — LAW 3):
//   'bp_rp_measured'          — Gaia BP−RP read straight from the catalog row.
//   'bt_vt_derived_APPROXIMATE' — RESERVED: an APPROXIMATE BP−RP derived from Tycho
//                                 BT−VT via a cited relation (see the colour block in
//                                 buildStarTable; not emitted until a relation lands).
//   'NOT_MEASURED'            — no measured colour available (colour is null).
export type ColorProvenance = 'bp_rp_measured' | 'bt_vt_derived_APPROXIMATE' | 'NOT_MEASURED';
export interface StarRow {
  id: string;
  band: Band;
  mag: number;         // catalog mag (Gaia G or Johnson V, per band)
  color: number | null;            // catalog colour index = Gaia BP−RP (measured); null when NOT_MEASURED
  colorProvenance: ColorProvenance; // how `color` was obtained (HYG B−V path retired at the Gaia cutover)
  raH: number;         // catalog RA in HOURS (coordinate ledger)
  decD: number;        // catalog Dec in DEG
  x: number;           // matched detection centroid, NATIVE px
  y: number;
  parity: number;      // row parity (y&1) — CFA checkerboard split
  dm: Record<'R' | 'G' | 'B', number | null>;   // raw m_inst − m_cat per channel (pre-ZP)
  snr: Record<'R' | 'G' | 'B', number | null>;
}
export interface StarTable {
  meta: {
    frame: string; decode_source: string;
    w: number; h: number;
    ra0H: number; dec0D: number; scale_arcsec_px: number;
    theta_deg: number; parity: number; anchor_px: [number, number];
    anchor_rank: number; fwhmPx: number;
    geometry_tight_matches: number; rAp_px: number;
    engineering_values: Record<string, number>;
    counts: { detections: number; footprint: number; matched: number; chance: number; purity: number; saturation_cut: number; usable: number; usable_before_photometry: number };
    band: { GaiaG: number; JohnsonV: number };
    // colour-axis coverage over the usable star rows (Gaia BP−RP; HYG B−V retired)
    color_coverage: { source: 'Gaia BP−RP'; bp_rp_measured: number; bt_vt_derived_APPROXIMATE: number; NOT_MEASURED: number };
  };
  stars: StarRow[];
  zeropoints: Record<Band, Record<'R' | 'G' | 'B', number>>;
  sigma_by_mag: any[];
}

// ── COORDINATE ledger: standard TAN gnomonic, xi/eta in DEGREES ──
function gnomonic(raH: number, decD: number, ra0H: number, dec0D: number) {
  const ra = raH * H2R, dec = decD * D2R, r0 = ra0H * H2R, d0 = dec0D * D2R;
  const dra = ra - r0;
  const cosc = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dra);
  if (cosc <= 0) return { xi: NaN, eta: NaN };
  const xi = Math.cos(dec) * Math.sin(dra) / cosc;
  const eta = (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dra)) / cosc;
  return { xi: xi / D2R, eta: eta / D2R };
}
function angSep(raH: number, decD: number, ra0H: number, dec0D: number) {
  const a = decD * D2R, b = dec0D * D2R, d = (raH - ra0H) * H2R;
  return Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d))) / D2R;
}
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mad = (a: number[]) => { const m = median(a); return MAD_K * median(a.map(v => Math.abs(v - m))); };

export interface BuildOpts {
  ra0H?: number; dec0D?: number; theta?: number; parity?: number; scale?: number;
  cache?: string; dump?: string; atlasRoot?: string; magLimit?: number;
}

export async function buildStarTable(opts: BuildOpts = {}): Promise<StarTable> {
  const RA0 = opts.ra0H ?? Number(process.env.ATM_RA0 ?? 17.264);
  const DEC0 = opts.dec0D ?? Number(process.env.ATM_DEC0 ?? -22.5);
  const THETA = opts.theta ?? Number(process.env.ATM_THETA ?? 157.7);
  const PARITY = opts.parity ?? Number(process.env.ATM_PARITY ?? 1);
  const SCALE = opts.scale ?? Number(process.env.ATM_SCALE ?? 63.352821428571424);
  const MAG_LIMIT = opts.magLimit ?? Number(process.env.ATM_MAGLIMIT ?? 7.0);
  const CACHE = opts.cache ?? process.env.ATM_CACHE
    ?? path.join(ROOT, 'test_results/psf/beach_measured/.decode_cache_sample_observation.cr2.bin');
  const DUMP = opts.dump ?? process.env.ATM_DUMP ?? path.join(ROOT, 'test_results/cr2_dets/sample_observation.app.json');
  const ATLAS_ROOT = opts.atlasRoot ?? process.env.ATM_ATLAS_ROOT ?? path.join(ROOT, 'public');

  // ── 1. decode cache → rgb16 mem_image → native R/G/B planes ──
  if (!fs.existsSync(CACHE)) throw new Error(`decode cache absent: ${CACHE}`);
  const cbuf = fs.readFileSync(CACHE);
  const CACHE_MAGIC = 0x50534632; // 'PSF2'
  if (cbuf.length <= 12 || cbuf.readUInt32LE(0) !== CACHE_MAGIC) throw new Error('decode cache: bad PSF2 magic');
  const w = cbuf.readUInt32LE(4), h = cbuf.readUInt32LE(8);
  if (w * h * 3 * 2 !== cbuf.length - 12) throw new Error(`decode cache dims mismatch: ${w}x${h}x3x2 != ${cbuf.length - 12}`);
  const rgb16 = new Uint16Array(cbuf.buffer.slice(cbuf.byteOffset + 12, cbuf.byteOffset + cbuf.length), 0, w * h * 3);
  const layout = detectPattern(rgb16, w, h);
  const [R, G, B] = layout.oneHot ? demosaicBilinear(rgb16, w, h, layout.pat) : splitRGB(rgb16, w, h);
  const planes: Record<string, Float32Array> = { R, G, B };
  const planeMax: Record<string, number> = {};
  for (const ch of ['R', 'G', 'B']) { let mx = 0; const p = planes[ch]; for (let i = 0; i < p.length; i++) if (p[i] > mx) mx = p[i]; planeMax[ch] = mx; }

  // ── 2. detections (NATIVE coords) ──
  const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  const W = dump.width, H = dump.height;
  if (W !== w || H !== h) throw new Error(`detection dump ${W}x${H} != decode cache ${w}x${h}`);
  const dets: { x: number; y: number; flux: number }[] = dump.detections.map((d: any) => ({ x: d.x, y: d.y, flux: d.flux }));
  const degPerPx = SCALE / 3600;
  const fwhms = dump.detections.map((d: any) => d.fwhm ?? d.fwhm_px ?? d.sigma_px * 2.3548 ?? null).filter((v: any) => Number.isFinite(v) && v > 0);
  const fwhmPx = Math.max(1.6, fwhms.length ? median(fwhms as number[]) : 2.5);

  const CELL = 128, GW = Math.ceil(W / CELL);
  const grid = new Map<number, { x: number; y: number }[]>();
  for (const d of dets) { const k = Math.floor(d.y / CELL) * GW + Math.floor(d.x / CELL); const b = grid.get(k) ?? (grid.set(k, []).get(k) as any); b.push(d); }
  function nearestDet(px: number, py: number) {
    const cr = 3, gx = Math.floor(px / CELL), gy = Math.floor(py / CELL);
    let best = Infinity, bestD: { x: number; y: number } | null = null;
    for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
      const b = grid.get((gy + dy) * GW + gx + dx); if (!b) continue;
      for (const d of b) { const r = Math.hypot(d.x - px, d.y - py); if (r < best) { best = r; bestD = d; } }
    }
    return { dist: best, det: bestD };
  }

  // ── 3. catalog enumeration (band per-row; NEVER pooled) ──
  function loadAtlasJson(rel: string): any[] {
    const p = path.join(ATLAS_ROOT, 'atlas', rel);
    if (!fs.existsSync(p)) return [];
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  }
  function sectorId(raH: number, decD: number) {
    const r = ((raH % 24) + 24) % 24, d = Math.max(-90, Math.min(90, decD));
    return Math.min(5, Math.floor((d + 90) / 30)) * 6 + Math.min(5, Math.floor(r / 4));
  }
  const secIds = new Set<number>();
  for (let dd = -FETCH_DEG; dd <= FETCH_DEG; dd += 4)
    for (let dh = -1.7; dh <= 1.7; dh += 0.25) secIds.add(sectorId(RA0 + dh, DEC0 + dd));
  const rawRows: any[] = [];
  for (const f of ['level_1_anchors.json', 'level_2_pattern.json']) for (const r of loadAtlasJson(f)) rawRows.push(r);
  for (const id of secIds) { const rows = loadAtlasJson(`sectors/level_3_sector_${id}.json`); for (const r of rows) rawRows.push(r); }

  type Cat = { raH: number; decD: number; mag: number; band: Band; color: number | null; colorProvenance: ColorProvenance; id: string };
  const seen = new Set<string>();
  const cat: Cat[] = [];
  for (const s of rawRows) {
    if (s.id === 0 && s.source_id === undefined) continue;
    const isGaia = s.source_id !== undefined || s.mag_g !== undefined;
    const mag = s.mag_g !== undefined ? s.mag_g : s.mag;
    if (!(mag < MAG_LIMIT)) continue;
    const raH = s.ra_deg !== undefined ? s.ra_deg / 15 : (isGaia ? s.ra / 15 : s.ra);
    const decD = s.dec_deg !== undefined ? s.dec_deg : s.dec;
    if (!Number.isFinite(raH) || !Number.isFinite(decD)) continue;
    const id = s.source_id ? `Gaia_${s.source_id}` : `HYG_${s.id}`;
    if (seen.has(id)) continue; seen.add(id);
    // ── COLOUR AXIS = Gaia BP−RP (measured). The legacy HYG B−V read
    //    (s.ci ?? s.bv) is DELETED at the Gaia cutover (owner GO 2026-07-21); HYG rows
    //    ship a spectral type only, and a spectral-type→colour guess is a silent
    //    approximation forbidden by LAW 3. A row with no measured BP−RP is colour
    //    NOT_MEASURED, never fabricated. (Forward-compat: the Gaia-pure regen may add a
    //    `mag_system` tag and Tycho `bt_vt` on non-Gaia rows — both are accepted here;
    //    `mag_system` is ignored, `bt_vt` is handled below.)
    let color: number | null = null;
    let colorProvenance: ColorProvenance = 'NOT_MEASURED';
    if (Number.isFinite(s.bp_rp)) {
      color = s.bp_rp; colorProvenance = 'bp_rp_measured';
    } else if (Number.isFinite(s.bt_vt)) {
      // Tycho BT−VT present but no Gaia BP−RP. A BT−VT→BP−RP conversion is APPROXIMATE;
      // no single-hop citable relation is folded in here, so per LAW 3 we emit
      // NOT_MEASURED rather than fabricate. Drop a cited conversion in THIS branch and
      // set colorProvenance = 'bt_vt_derived_APPROXIMATE' when one lands (regen wave).
      color = null; colorProvenance = 'NOT_MEASURED';
    }
    cat.push({ raH, decD, mag, band: isGaia ? 'GaiaG' : 'JohnsonV', color, colorProvenance, id });
  }
  const bandCount = { GaiaG: cat.filter(c => c.band === 'GaiaG').length, JohnsonV: cat.filter(c => c.band === 'JohnsonV').length };

  // ── 4. recover solved geometry (anchor, θ, parity) at FIXED (ra0,dec0,scale) ──
  function xyOf(s: Cat) { return gnomonic(s.raH, s.decD, RA0, DEC0); }
  function projXY(xy: { xi: number; eta: number }, ax: number, ay: number, th: number, par: number) {
    const cT = Math.cos(th * D2R), sT = Math.sin(th * D2R), ey = xy.eta * par;
    return { px: ax + (xy.xi * cT - ey * sT) / degPerPx, py: ay + (xy.xi * sT + ey * cT) / degPerPx };
  }
  const byFlux = [...dets].sort((a, b) => b.flux - a.flux);
  const geomCat = cat.filter(s => s.mag < GEOM_MAG && angSep(s.raH, s.decD, RA0, DEC0) <= FETCH_DEG)
    .map(s => ({ xy: xyOf(s) })).filter(s => Number.isFinite(s.xy.xi));
  function tightCount(ax: number, ay: number, th: number, par: number, tol: number) {
    let m = 0, inf = 0;
    for (const s of geomCat) { const p = projXY(s.xy, ax, ay, th, par); if (p.px < 0 || p.px >= W || p.py < 0 || p.py >= H) continue; inf++; if (nearestDet(p.px, p.py).dist <= tol) m++; }
    return { m, inf };
  }
  let geo = { m: -1, ax: byFlux[0].x, ay: byFlux[0].y, th: THETA, par: PARITY, ai: 0 };
  for (let ai = 0; ai < Math.min(GEOM_ANCHOR_K, byFlux.length); ai++) {
    const a = byFlux[ai];
    for (const par of [1, -1]) for (let th = 0; th < 360; th += 0.5) {
      const c = tightCount(a.x, a.y, th, par, GEOM_TIGHT_PX);
      if (c.m > geo.m) geo = { m: c.m, ax: a.x, ay: a.y, th, par, ai };
    }
  }
  const AX = geo.ax, AY = geo.ay, TH = geo.th, PAR = geo.par;

  // ── 5. mutual-NN tight match → forced position = detection centroid ──
  const fpAll = cat.filter(s => angSep(s.raH, s.decD, RA0, DEC0) <= FETCH_DEG)
    .map(s => { const xy = xyOf(s); return { s, xy }; })
    .filter(o => Number.isFinite(o.xy.xi))
    .map(o => { const p = projXY(o.xy, AX, AY, TH, PAR); return { ...o.s, px: p.px, py: p.py }; })
    .filter(o => o.px >= 0 && o.px < W && o.py >= 0 && o.py < H) as (Cat & { px: number; py: number; det?: any; ddist?: number })[];
  for (const o of fpAll) { const nd = nearestDet(o.px, o.py); o.det = nd.det; o.ddist = nd.dist; }
  const detBest = new Map<string, any>();
  for (const o of fpAll) { if (!o.det) continue; const k = `${o.det.x},${o.det.y}`; const cur = detBest.get(k); if (!cur || (o.ddist as number) < cur.ddist) detBest.set(k, o); }
  type M = { id: string; band: Band; mag: number; color: number | null; colorProvenance: ColorProvenance; raH: number; decD: number; x: number; y: number };
  const matched: M[] = [];
  for (const o of fpAll) {
    if (!o.det) continue; const k = `${o.det.x},${o.det.y}`;
    if ((o.ddist as number) <= MATCH_TIGHT_PX && detBest.get(k) === o)
      matched.push({ id: o.id, band: o.band, mag: o.mag, color: o.color, colorProvenance: o.colorProvenance, raH: o.raH, decD: o.decD, x: o.det.x, y: o.det.y });
  }
  let chance = 0; const NSCR = fpAll.length; let rs = 987654321;
  const rand = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  for (let i = 0; i < NSCR; i++) if (nearestDet(rand() * W, rand() * H).dist <= MATCH_TIGHT_PX) chance++;
  const purity = matched.length ? Math.max(0, 1 - chance / matched.length) : 0;

  // ── 6. saturation cut ──
  const rAp = Math.max(2, 0.68 * fwhmPx);
  const RApc = Math.ceil(rAp);
  function aperturePeak(plane: Float32Array, cx: number, cy: number) {
    let pk = 0; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let dy = -RApc; dy <= RApc; dy++) for (let dx = -RApc; dx <= RApc; dx++) {
      if (dx * dx + dy * dy > rAp * rAp) continue;
      const X = x0 + dx, Y = y0 + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const v = plane[Y * w + X]; if (v > pk) pk = v;
    }
    return pk;
  }
  const unsat: M[] = []; let nSat = 0;
  for (const st of matched) {
    let sat = false;
    for (const ch of ['R', 'G', 'B']) if (aperturePeak(planes[ch], st.x, st.y) > SAT_FRAC * planeMax[ch]) { sat = true; break; }
    if (sat) nSat++; else unsat.push(st);
  }

  // ── 7. forced photometry per channel (PIXEL ledger, native grid) ──
  const positions = unsat.map(st => ({ x: st.x, y: st.y, mag: st.mag, gaia_id: st.id }));
  const perCh: Record<string, Map<string, any>> = {};
  for (const ch of ['R', 'G', 'B']) {
    const res = forcedMeasure({ L: planes[ch], w, h, positions, fwhmPx, snrThreshold: SNR_MIN });
    const m = new Map<string, any>();
    for (const r of res.results) m.set(r.gaia_id, r);
    perCh[ch] = m;
  }

  // ── 8. raw Δm rows (per-channel independent inclusion) ──
  const stars: StarRow[] = [];
  for (const st of unsat) {
    const dm: Record<'R' | 'G' | 'B', number | null> = { R: null, G: null, B: null };
    const snr: Record<'R' | 'G' | 'B', number | null> = { R: null, G: null, B: null };
    let any = false;
    for (const ch of ['R', 'G', 'B'] as const) {
      const r = perCh[ch].get(st.id);
      if (r && r.flux > 0 && r.snr >= SNR_MIN) { dm[ch] = -2.5 * Math.log10(r.flux) - st.mag; snr[ch] = r.snr; any = true; }
    }
    if (any) stars.push({ id: st.id, band: st.band, mag: st.mag, color: st.color, colorProvenance: st.colorProvenance, raH: st.raH, decD: st.decD, x: st.x, y: st.y, parity: Math.round(st.y) & 1, dm, snr });
  }

  // per (band, channel) robust ZP + σ(mag) table (inc-1 method, for weighting)
  const bands: Band[] = ['GaiaG', 'JohnsonV'];
  const chs = ['R', 'G', 'B'] as const;
  const vals = (subset: StarRow[], ch: 'R' | 'G' | 'B') => subset.map(r => r.dm[ch]).filter((v): v is number => Number.isFinite(v as number));
  const zp: Record<Band, Record<'R' | 'G' | 'B', number>> = { GaiaG: { R: NaN, G: NaN, B: NaN }, JohnsonV: { R: NaN, G: NaN, B: NaN } };
  for (const bd of bands) { const br = stars.filter(r => r.band === bd); for (const ch of chs) zp[bd][ch] = median(vals(br, ch)); }
  const sigmaByMag: any[] = [];
  for (const bd of bands) {
    const br = stars.filter(r => r.band === bd);
    if (!br.length) continue;
    const mags = br.map(r => Math.floor(r.mag));
    for (let mb = Math.min(...mags); mb <= Math.max(...mags); mb++) {
      const bin = br.filter(r => Math.floor(r.mag) === mb);
      if (!bin.length) continue;
      const entry: any = { band: bd, mag_bin: `${mb}-${mb + 1}`, n: bin.length, sparse: bin.length < MIN_BIN_N };
      for (const ch of chs) {
        const resid = vals(bin, ch).map(v => v - zp[bd][ch]);
        entry[`sigma_${ch}`] = resid.length ? +mad(resid).toFixed(4) : null;
        entry[`n_${ch}`] = resid.length;
      }
      sigmaByMag.push(entry);
    }
  }

  return {
    meta: {
      frame: 'public/demo/sample_observation.cr2 (Canon T6 + Rokinon 14mm; LYING 50mm EXIF)',
      decode_source: path.relative(ROOT, CACHE),
      w, h, ra0H: RA0, dec0D: DEC0, scale_arcsec_px: SCALE,
      theta_deg: TH, parity: PAR, anchor_px: [AX, AY], anchor_rank: geo.ai, fwhmPx: +fwhmPx.toFixed(3),
      geometry_tight_matches: geo.m, rAp_px: +rAp.toFixed(3),
      engineering_values: { MATCH_TIGHT_PX, GEOM_TIGHT_PX, GEOM_MAG, GEOM_ANCHOR_K, SAT_FRAC, MAD_K, MIN_BIN_N, SNR_MIN, FETCH_DEG, MAG_LIMIT },
      counts: { detections: dets.length, footprint: fpAll.length, matched: matched.length, chance, purity: +purity.toFixed(3), saturation_cut: nSat, usable: stars.length, usable_before_photometry: unsat.length },
      band: bandCount,
      color_coverage: {
        source: 'Gaia BP−RP',
        bp_rp_measured: stars.filter(s => s.colorProvenance === 'bp_rp_measured').length,
        bt_vt_derived_APPROXIMATE: stars.filter(s => s.colorProvenance === 'bt_vt_derived_APPROXIMATE').length,
        NOT_MEASURED: stars.filter(s => s.colorProvenance === 'NOT_MEASURED').length,
      },
    },
    stars, zeropoints: zp, sigma_by_mag: sigmaByMag,
  };
}

// gnomonic INVERSE (deg ξ,η about ra0,dec0 → RA hours / Dec deg) — for boresight.
export function gnomonicInverse(xiDeg: number, etaDeg: number, ra0H: number, dec0D: number) {
  const xi = xiDeg * D2R, eta = etaDeg * D2R;
  const rho = Math.hypot(xi, eta);
  const d0 = dec0D * D2R, r0 = ra0H * H2R;
  if (rho < 1e-12) return { raH: ra0H, decD: dec0D };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + eta * Math.sin(c) * Math.cos(d0) / rho);
  const ra = r0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { raH: ((ra / H2R) % 24 + 24) % 24, decD: dec / D2R };
}
