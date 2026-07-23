// ═══════════════════════════════════════════════════════════════════════════
// SIP COMPARISON — OUR fitted distortion vs astrometry.net's SIP (measurer,
// one-shot, comparison-only — adopts nothing, changes nothing).
//
//   node tools/dslr/sip_oracle_compare.mjs
//
// Inputs (hardcoded to this run's artifacts — a throwaway one-shot lane tool):
//   test_results/sip_comparison_2026-07-15/our_receipt_extract.json
//   test_results/sip_comparison_2026-07-15/oracle_wcs_extract.json
//   test_results/sip_comparison_2026-07-15/oracle/corr.json
//
// SIGN CONVENTION: our receipt's solution.astrometry.sip is the INTERNAL
// convention (dx = OBSERVED − IDEAL, src/engine/pipeline/export/sip_convention.ts).
// astrometry.net's A/B (forward) are FITS-standard (u' = u + A(u,v) = IDEAL).
// We do NOT compare coefficients; we evaluate both as pixel→sky on a common
// grid and diff the sky positions (the convention-proof approach).
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'test_results/sip_comparison_2026-07-15';
const ours = JSON.parse(fs.readFileSync(path.join(BASE, 'our_receipt_extract.json'), 'utf8'));
const oracle = JSON.parse(fs.readFileSync(path.join(BASE, 'oracle_wcs_extract.json'), 'utf8'));
const corr = JSON.parse(fs.readFileSync(path.join(BASE, 'oracle', 'corr.json'), 'utf8'));

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ── polynomial eval: sum mat[p][q] * u^p * v^q ──
function evalPoly(mat, u, v) {
  let s = 0;
  for (let p = 0; p < mat.length; p++) {
    const row = mat[p];
    if (!row) continue;
    let vpow = 1;
    for (let q = 0; q < row.length; q++) {
      const c = row[q];
      if (c) s += c * Math.pow(u, p) * vpow;
      vpow *= v;
    }
  }
  return s;
}

// ── TAN (gnomonic) deprojection: (xi,eta) deg tangent-plane offsets, tangent
// point (ra0,dec0) deg → (ra,dec) deg. Standard formula (Calabretta & Greisen
// 2002 / classical "standard coordinates" inversion), valid to large field angles.
function tanDeproject(xiDeg, etaDeg, ra0Deg, dec0Deg) {
  const xi = xiDeg * D2R, eta = etaDeg * D2R;
  const ra0 = ra0Deg * D2R, dec0 = dec0Deg * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho < 1e-15) return { ra: ra0Deg, dec: dec0Deg };
  const c = Math.atan(rho);
  const sinc = Math.sin(c), cosc = Math.cos(c);
  const dec = Math.asin(cosc * Math.sin(dec0) + (eta * sinc * Math.cos(dec0)) / rho);
  const ra = ra0 + Math.atan2(xi * sinc, rho * Math.cos(dec0) * cosc - eta * Math.sin(dec0) * sinc);
  let raDeg = ra * R2D;
  raDeg = ((raDeg % 360) + 360) % 360;
  return { ra: raDeg, dec: dec * R2D };
}

// ── angular separation (haversine, deg → arcsec) ──
function angSepArcsec(ra1, dec1, ra2, dec2) {
  const r1 = ra1 * D2R, d1 = dec1 * D2R, r2 = ra2 * D2R, d2 = dec2 * D2R;
  const sdlat = Math.sin((d2 - d1) / 2), sdlon = Math.sin((r2 - r1) / 2);
  const a = sdlat * sdlat + Math.cos(d1) * Math.cos(d2) * sdlon * sdlon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return c * R2D * 3600;
}

// ── OUR model: pixel (x0based,y0based) → sky, internal SIP convention ──
function oursPixelToSky(x, y) {
  const u = x - ours.wcs.CRPIX1, v = y - ours.wcs.CRPIX2;
  const du = evalPoly(ours.sip.a, u, v), dv = evalPoly(ours.sip.b, u, v);
  const uIdeal = u - du, vIdeal = v - dv; // internal convention: dx=OBS-IDEAL ⇒ IDEAL=OBS-dx
  const xi = ours.wcs.CD1_1 * uIdeal + ours.wcs.CD1_2 * vIdeal;
  const eta = ours.wcs.CD2_1 * uIdeal + ours.wcs.CD2_2 * vIdeal;
  return tanDeproject(xi, eta, ours.wcs.CRVAL1, ours.wcs.CRVAL2);
}

// ── ORACLE model: pixel (x0based,y0based) → sky, FITS-standard forward SIP.
// x0based/y0based are 0-based array pixel coords; FITS pixel = +1. ──
function oraclePixelToSky(x0, y0) {
  const p1 = x0 + 1, p2 = y0 + 1;
  const u = p1 - oracle.CRPIX1, v = p2 - oracle.CRPIX2;
  const du = evalPoly(oracle.A, u, v), dv = evalPoly(oracle.B, u, v);
  const uIdeal = u + du, vIdeal = v + dv; // FITS forward: u' = u + A(u,v) = IDEAL
  const xi = oracle.CD1_1 * uIdeal + oracle.CD1_2 * vIdeal;
  const eta = oracle.CD2_1 * uIdeal + oracle.CD2_2 * vIdeal;
  return tanDeproject(xi, eta, oracle.CRVAL1, oracle.CRVAL2);
}

// ── local pixel scale (arcsec/px) from a CD matrix (determinant-based) ──
function localScaleArcsec(cd11, cd12, cd21, cd22) {
  return Math.sqrt(Math.abs(cd11 * cd22 - cd12 * cd21)) * 3600;
}

const W = ours.metadata.width, H = ours.metadata.height;
const cx = (W - 1) / 2, cy = (H - 1) / 2;
const halfDiag = Math.hypot(cx, cy);

// ═══ PART 1: common 20×20 grid + 4 corners + center — pure model-vs-model ═══
const gridPts = [];
const N = 20;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const x = (W - 1) * (i / (N - 1));
    const y = (H - 1) * (j / (N - 1));
    gridPts.push({ tag: 'grid', x, y });
  }
}
const named = [
  { tag: 'corner_TL', x: 0, y: 0 },
  { tag: 'corner_TR', x: W - 1, y: 0 },
  { tag: 'corner_BL', x: 0, y: H - 1 },
  { tag: 'corner_BR', x: W - 1, y: H - 1 },
  { tag: 'center', x: cx, y: cy },
];
const allPts = [...gridPts, ...named];

const gridResults = allPts.map((p) => {
  const a = oursPixelToSky(p.x, p.y);
  const b = oraclePixelToSky(p.x, p.y);
  const sepArcsec = angSepArcsec(a.ra, a.dec, b.ra, b.dec);
  const r = Math.hypot(p.x - cx, p.y - cy) / halfDiag; // 0=center,1=corner
  const localScale = localScaleArcsec(ours.wcs.CD1_1, ours.wcs.CD1_2, ours.wcs.CD2_1, ours.wcs.CD2_2);
  return { ...p, ours: a, oracle: b, sep_arcsec: sepArcsec, sep_px: sepArcsec / localScale, radius_frac: r };
});

function stats(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: pct(0.5), p95: pct(0.95), max: s[s.length - 1], min: s[0] };
}
const sepArcsecAll = gridResults.map((r) => r.sep_arcsec);
const sepPxAll = gridResults.map((r) => r.sep_px);
const overallStats = { arcsec: stats(sepArcsecAll), px: stats(sepPxAll) };

const bands = { center: [], mid: [], corner: [] };
for (const r of gridResults) {
  if (r.radius_frac < 0.33) bands.center.push(r.sep_arcsec);
  else if (r.radius_frac < 0.66) bands.mid.push(r.sep_arcsec);
  else bands.corner.push(r.sep_arcsec);
}
const bandStats = { center: stats(bands.center), mid: stats(bands.mid), corner: stats(bands.corner) };

// ═══ PART 2: real matched-star cross-check (astrometry.net's OWN 59 correspondences) ═══
// For each: OUR model @ (field_x,field_y) vs ORACLE model (field_ra/dec, already
// their SIP-corrected result) vs CATALOG truth (index_ra/dec, Gaia/2MASS match).
const starResults = corr.map((row) => {
  const x0 = row.field_x - 1, y0 = row.field_y - 1; // FITS 1-based → our 0-based
  const a = oursPixelToSky(x0, y0);
  const oracleSky = { ra: row.field_ra, dec: row.field_dec }; // their own corrected output
  const cat = { ra: row.index_ra, dec: row.index_dec };
  return {
    field_x: row.field_x, field_y: row.field_y,
    ours_ra: a.ra, ours_dec: a.dec,
    oracle_ra: oracleSky.ra, oracle_dec: oracleSky.dec,
    cat_ra: cat.ra, cat_dec: cat.dec,
    ours_vs_oracle_arcsec: angSepArcsec(a.ra, a.dec, oracleSky.ra, oracleSky.dec),
    ours_vs_cat_arcsec: angSepArcsec(a.ra, a.dec, cat.ra, cat.dec),
    oracle_vs_cat_arcsec: angSepArcsec(oracleSky.ra, oracleSky.dec, cat.ra, cat.dec),
  };
});
const starStats = {
  ours_vs_oracle: stats(starResults.map((r) => r.ours_vs_oracle_arcsec)),
  ours_vs_cat: stats(starResults.map((r) => r.ours_vs_cat_arcsec)),
  oracle_vs_cat: stats(starResults.map((r) => r.oracle_vs_cat_arcsec)),
};

// ═══ PART 3: CRVAL/CD/rotation/scale summary ═══
const scaleOurs = localScaleArcsec(ours.wcs.CD1_1, ours.wcs.CD1_2, ours.wcs.CD2_1, ours.wcs.CD2_2);
const scaleOracle = localScaleArcsec(oracle.CD1_1, oracle.CD1_2, oracle.CD2_1, oracle.CD2_2);
const rotOurs = Math.atan2(ours.wcs.CD2_1, ours.wcs.CD1_1) * R2D;
const rotOracle = Math.atan2(oracle.CD2_1, oracle.CD1_1) * R2D;
const centerSepDeg = angSepArcsec(ours.solution_summary.ra_hours * 15, ours.solution_summary.dec_degrees,
  263.903357, -33.702822) / 3600; // astrometry.net field-center from solve-field stdout

const summary = {
  frame: 'sample_observation.cr2 (bundled Canon EOS Rebel T6, Rokinon 14mm real / 50mm lying-EXIF, sky-only Milky-Way core field)',
  our_solve: { ...ours.solution_summary, solve_provenance: ours.solve_provenance, confirm_status: ours.confirm_status },
  our_sip: { a_order: ours.sip.a_order, b_order: ours.sip.b_order, convention: 'INTERNAL (dx=OBSERVED-IDEAL)' },
  our_tps: ours.tps, our_tps_gate: ours.tps_gate,
  oracle_solve: {
    tool: 'astrometry.net solve-field (local WSL Ubuntu-24.04, keyless, private)',
    field_center_ra_deg: 263.903357, field_center_dec_deg: -33.702822,
    field_size_deg: '75.03 x 55.43', rotation_deg: 155.144, parity: 'neg',
    matches_initial: 39, matches_after_tweak: corr.length,
    log_odds: 118.452, tweak_order: 3,
  },
  oracle_sip: { a_order: oracle.A_ORDER, b_order: oracle.B_ORDER, convention: 'FITS-standard (u\'=u+A(u,v)=IDEAL)' },
  crval_field_center_sep_deg: centerSepDeg,
  scale_arcsec_per_px: { ours: scaleOurs, oracle: scaleOracle, delta_pct: ((scaleOurs - scaleOracle) / scaleOracle) * 100 },
  rotation_deg_cd: { ours: rotOurs, oracle: rotOracle, delta_deg: rotOurs - rotOracle },
  grid_20x20_plus_corners: { n_points: allPts.length, overall: overallStats, by_radius_band: bandStats },
  matched_star_crosscheck: { n_stars: corr.length, stats: starStats },
};

fs.writeFileSync(path.join(BASE, 'grid_results.json'), JSON.stringify(gridResults, null, 1));
fs.writeFileSync(path.join(BASE, 'star_crosscheck.json'), JSON.stringify(starResults, null, 1));
fs.writeFileSync(path.join(BASE, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
