// IMG_1410 forced-position radial analysis.
// Discriminates: bright-catalog-match deficit = EXTRACTION (stars never detected)
// vs MATCHING/DISTORTION (detected but mispredicted off-axis through linear WCS).
//
// Faithful reproduction of the UW sweep projection (solver_entry.ts:1034-1047):
//   px = aCx + (xi*cT - eta*par*sT)/degPerPx
//   py = aCy + (xi*sT + eta*par*cT)/degPerPx
// with xi/eta = standard TAN gnomonic in DEGREES (SkyTransform.gnomonicProject),
// verified against wasm known-answer (wasm_core.test.ts:85-92).
//
// Usage: node tools/dslr/img1410_forced_radial.mjs RA0h DEC0deg THETAdeg PARITY
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DUMP = 'test_results/cr2_dets/IMG_1410.app.json';
const MAG_LIMIT = 6.0;               // SOLVER_UW_VERIFY_MAG_LIMIT
const SCALE = 63.352821428571424;    // arcsec/px (from dump)
const argv = process.argv.slice(2);
const ra0 = parseFloat(argv[0]);     // hours
const dec0 = parseFloat(argv[1]);    // deg
const thetaDeg = parseFloat(argv[2]);
const parity = parseInt(argv[3], 10);
const SELFSEARCH = argv.includes('--selfsearch');

const D2R = Math.PI / 180, H2R = Math.PI / 12;

// standard TAN gnomonic; returns {xi,eta} in DEGREES (matches wasm known-answer)
function gnomonic(raH, decD, ra0H, dec0D) {
  const ra = raH * H2R, dec = decD * D2R, r0 = ra0H * H2R, d0 = dec0D * D2R;
  const dra = ra - r0;
  const cosc = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dra);
  if (cosc <= 0) return { xi: NaN, eta: NaN }; // behind tangent plane
  const xi = Math.cos(dec) * Math.sin(dra) / cosc;
  const eta = (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dra)) / cosc;
  return { xi: xi / D2R, eta: eta / D2R };
}

// ── load frame ──
const dump = JSON.parse(fs.readFileSync(path.join(ROOT, DUMP), 'utf8'));
const W = dump.width, H = dump.height;
const dets = dump.detections.map(d => ({ x: d.x, y: d.y }));
const bright = [...dump.detections].sort((a, b) => b.flux - a.flux)[0];
const aCx = bright.x, aCy = bright.y; // anchor = brightest detection (bloomed Jupiter)
const degPerPx = SCALE / 3600;
const ocx = W / 2, ocy = H / 2;

// ── detection lookup grid (128px cells) ──
const CELL = 128, GW = Math.ceil(W / CELL);
const grid = new Map();
for (const d of dets) {
  const k = Math.floor(d.y / CELL) * GW + Math.floor(d.x / CELL);
  (grid.get(k) || grid.set(k, []).get(k)).push(d);
}
function nearestDet(px, py) {
  const cr = 3, gx = Math.floor(px / CELL), gy = Math.floor(py / CELL);
  let best = Infinity;
  for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
    const b = grid.get((gy + dy) * GW + gx + dx);
    if (!b) continue;
    for (const d of b) { const r = Math.hypot(d.x - px, d.y - py); if (r < best) best = r; }
  }
  return best; // px to nearest detection (searches up to ~3 cells = 384px)
}

// ── load bright catalog from atlas sectors (Gaia: ra=deg, mag_g) ──
function sectorId(raH, decD) {
  const r = ((raH % 24) + 24) % 24, d = Math.max(-90, Math.min(90, decD));
  return Math.min(5, Math.floor((d + 90) / 30)) * 6 + Math.min(5, Math.floor(r / 4));
}
// Bright verify catalog (mag_g<6) lives in level_1/level_2 (Gaia anchors);
// the L3 sectors are truncated at mag 6.81 (fainter than the UW verify limit).
void sectorId;
let cat = [];
for (const f of ['level_1_anchors', 'level_2_pattern']) {
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, `public/atlas/${f}.json`), 'utf8'));
  for (const s of rows) {
    const mag = s.mag_g !== undefined ? s.mag_g : s.mag;
    if (!(mag < MAG_LIMIT)) continue;
    const raH = s.ra_deg !== undefined ? s.ra_deg / 15 : (s.source_id !== undefined || s.mag_g !== undefined ? s.ra / 15 : s.ra);
    const decD = s.dec_deg !== undefined ? s.dec_deg : s.dec;
    cat.push({ raH, decD, mag });
  }
}
// dedupe (sectors don't overlap, but guard)
const seen = new Set(); cat = cat.filter(s => { const k = `${s.raH.toFixed(4)},${s.decD.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; });

// ── optional: self-search theta/parity to VALIDATE the WCS (reproduce solver peak) ──
const FETCH_DEG = 22.7; // solver catalog-fetch radius (from [PATCH] log)
function angSep(raH, decD) { // great-circle deg from (ra0,dec0)
  const a = decD * D2R, b = dec0 * D2R, d = (raH - ra0) * H2R;
  return Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d))) / D2R;
}
function projectAll(th, par) {
  const cT = Math.cos(th * D2R), sT = Math.sin(th * D2R);
  const out = [];
  for (const s of cat) {
    if (angSep(s.raH, s.decD) > FETCH_DEG) continue; // match solver candidate set
    const { xi, eta } = gnomonic(s.raH, s.decD, ra0, dec0);
    if (Number.isNaN(xi)) continue;
    const ey = eta * par;
    const px = aCx + (xi * cT - ey * sT) / degPerPx;
    const py = aCy + (xi * sT + ey * cT) / degPerPx;
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    out.push({ px, py, mag: s.mag });
  }
  return out;
}
if (SELFSEARCH) {
  const base = 15.0; // baseNetPx
  let best = { m: -1, th: 0, par: 1 };
  for (const par of [1, -1]) for (let th = 0; th < 360; th += 0.5) {
    const proj = projectAll(th, par);
    let m = 0;
    for (const p of proj) { const tol = Math.max(base, 0.035 * Math.hypot(p.px - ocx, p.py - ocy)); if (nearestDet(p.px, p.py) <= tol) m++; }
    if (m > best.m) best = { m, th, par, inframe: proj.length };
  }
  console.log(`[SELFSEARCH] peak theta=${best.th} parity=${best.par} widenet-matches=${best.m}/${best.inframe} inframe (validates WCS vs harness)`);
}

// ── forced-position radial analysis at the given WCS ──
const proj = projectAll(thetaDeg, parity);
const rows = proj.map(p => ({
  r: Math.hypot(p.px - ocx, p.py - ocy),
  ra: Math.hypot(p.px - aCx, p.py - aCy), // radius from ANCHOR (tangent point)
  resid: nearestDet(p.px, p.py),
  mag: p.mag,
}));
const TOLS = [3, 5, 8];
// radial bins by fraction of max radius
const maxR = Math.hypot(W / 2, H / 2);
const NB = 6;
const bins = Array.from({ length: NB }, () => []);
for (const r of rows) bins[Math.min(NB - 1, Math.floor(r.r / maxR * NB))].push(r);
function med(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

console.log(`\n=== IMG_1410 forced-position radial analysis ===`);
console.log(`anchor(px)=${aCx.toFixed(1)},${aCy.toFixed(1)}  WCS: ra0=${ra0}h dec0=${dec0} theta=${thetaDeg} parity=${parity}`);
console.log(`bright cat (mag_g<${MAG_LIMIT}) loaded=${cat.length}, in-frame=${proj.length}, dets=${dets.length}, maxR=${maxR.toFixed(0)}px`);
// chance baseline: median nearest-detection dist for RANDOM in-frame points,
// AND detection count, per radial bin. resid≈chance => predicted pos lands in
// generic sky (no true counterpart nearby = EXTRACTION gap); resid<<chance =>
// a real correspondence (detected, possibly displaced = MATCHING/DISTORTION).
const RNG = 4000;
const chanceBin = Array.from({ length: NB }, () => []);
const detCountBin = new Array(NB).fill(0);
for (let k = 0; k < RNG; k++) {
  const px = Math.random() * W, py = Math.random() * H;
  const rr = Math.hypot(px - ocx, py - ocy);
  chanceBin[Math.min(NB - 1, Math.floor(rr / maxR * NB))].push(nearestDet(px, py));
}
for (const d of dets) { const rr = Math.hypot(d.x - ocx, d.y - ocy); detCountBin[Math.min(NB - 1, Math.floor(rr / maxR * NB))]++; }

console.log(`\nradiusBin(px)      n   presence@8px  medResid  chanceMed  detCount  verdict`);
for (let i = 0; i < NB; i++) {
  const b = bins[i];
  const lo = (i / NB * maxR).toFixed(0), hi = ((i + 1) / NB * maxR).toFixed(0);
  const cm = med(chanceBin[i]);
  if (!b.length) { console.log(`${(lo + '-' + hi).padEnd(14)} n=0                              chanceMed=${cm.toFixed(0)} dets=${detCountBin[i]}`); continue; }
  const mr = med(b.map(x => x.resid));
  const verdict = mr <= 8 ? 'ALIGNED' : (mr < cm * 0.6 ? 'DISPLACED(real,off-axis)' : 'NO-DET(extraction/coverage)');
  console.log(`${(lo + '-' + hi).padEnd(14)} ${String(b.length).padStart(4)}   ${((b.filter(x => x.resid <= 8).length / b.length * 100).toFixed(0) + '%').padStart(5)}     ${mr.toFixed(0).padStart(5)}     ${cm.toFixed(0).padStart(5)}     ${String(detCountBin[i]).padStart(5)}   ${verdict}`);
}
// overall
for (const t of TOLS) console.log(`OVERALL presence@${t}px = ${(rows.filter(x => x.resid <= t).length / rows.length * 100).toFixed(0)}% (${rows.filter(x => x.resid <= t).length}/${rows.length})`);
console.log(`OVERALL median residual = ${med(rows.map(x => x.resid)).toFixed(1)}px`);

// tolerance curve + wide-net (solver's own growing net) presence
const base = 15.0;
const wideMatched = rows.filter(x => x.resid <= Math.max(base, 0.035 * x.r));
console.log(`\ntolerance curve (fraction of ${rows.length} in-frame bright with a det within tol):`);
for (const t of [3, 8, 15, 30, 60, 120]) console.log(`  <=${String(t).padStart(3)}px: ${(rows.filter(x => x.resid <= t).length / rows.length * 100).toFixed(0)}%`);
console.log(`  <=WIDENET(15..0.035r): ${(wideMatched.length / rows.length * 100).toFixed(0)}% (${wideMatched.length}/${rows.length}) = solver's real+chance matches`);
console.log(`  => ${rows.length - wideMatched.length}/${rows.length} bright stars have NO det even at the wide net (up to ~${(0.035 * maxR).toFixed(0)}px at edge)`);

// distortion test: residual-vs-radius among ONLY the real (wide-net-matched) stars
console.log(`\n--- residual vs radius among WIDE-NET-MATCHED (real counterpart) stars ---`);
console.log(`radiusBin(px)   nMatched   medResid(px)  (growing resid = distortion signature)`);
const mbins = Array.from({ length: NB }, () => []);
for (const r of wideMatched) mbins[Math.min(NB - 1, Math.floor(r.r / maxR * NB))].push(r);
for (let i = 0; i < NB; i++) {
  const b = mbins[i]; const lo = (i / NB * maxR).toFixed(0), hi = ((i + 1) / NB * maxR).toFixed(0);
  if (!b.length) { console.log(`${(lo + '-' + hi).padEnd(14)} n=0`); continue; }
  console.log(`${(lo + '-' + hi).padEnd(14)} ${String(b.length).padStart(4)}       ${med(b.map(x => x.resid)).toFixed(1).padStart(6)}`);
}

// second view: binned by radius from the ANCHOR (tangent point) — isolates
// TAN-projection breakdown (grows from tangent point) from anything else.
const maxRA = Math.max(...rows.map(x => x.ra));
const abins = Array.from({ length: NB }, () => []);
for (const r of rows) abins[Math.min(NB - 1, Math.floor(r.ra / maxRA * NB))].push(r);
console.log(`\n--- binned by radius from ANCHOR/tangent point (max=${maxRA.toFixed(0)}px) ---`);
console.log(`anchorRadBin(px)   n   presence@8px   medResid(px)`);
for (let i = 0; i < NB; i++) {
  const b = abins[i]; const lo = (i / NB * maxRA).toFixed(0), hi = ((i + 1) / NB * maxRA).toFixed(0);
  if (!b.length) { console.log(`${lo}-${hi} n=0`); continue; }
  console.log(`${(lo + '-' + hi).padEnd(16)} ${String(b.length).padStart(4)}   ${((b.filter(x => x.resid <= 8).length / b.length * 100).toFixed(0) + '%').padStart(6)}       ${med(b.map(x => x.resid)).toFixed(1).padStart(6)}`);
}
