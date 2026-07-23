// truth_fixture_extract.mjs — M4a truth fixture for the CSM30799 desk-check (plan rev 2).
//
// At the EXACT a.net oracle pose (TAN-SIP .wcs incl. AP/BP inverse), for bands 7-14 of the
// g15u release: unique truth 4-sets (all members in-frame, 16 px margin) with star rows +
// per-member nearest VALID detection + distance (radial tol 10 + 0.01*r, as m1_measure.mjs)
// + member class. Writes crates/solver-core/tests/fixtures/truth_csm30799.json.
//
// DET ID CONVENTION (load-bearing): the source file's `id` field is NON-UNIQUE (3,669
// duplicated ids with different positions, measured 2026-07-20). The fixture and the Rust
// contract therefore use the 0-based ARRAY INDEX into the file's detections[] as the
// detection id. The Rust desk-check test loads detections the same way.
//
// FIXTURE FLOATS: load-bearing floats travel as IEEE-754 f64 bit-pattern hex (u64 bits,
// big-endian hex string); decimals alongside are for humans only.
//
// Also prints (diagnostic only, NOT a gate input): the bands>=10 in-pool counts under the
// clean per-detection UNION policy (the Rust prep semantics), next to the M-1 frozen table
// (8 @100, 20 @200, 56 @400) whose JS simulation keyed rank maps by the non-unique raw id.
//
// READ-ONLY on all inputs. Adapted from m1_measure.mjs / m1_policy.mjs (same WCS parse,
// same truth extraction, same matching rule).
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const arrow = require2('apache-arrow');

const REL = process.env.SOLVER_TEST_RELEASE_DIR
  || 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u';
const WCS_PATH = 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/CSM30799.wcs';
const DET_PATH = 'D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_CSM30799.CR2_16792.json';
const OUT = new URL('../solver-core/tests/fixtures/truth_csm30799.json', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1'); // windows drive-letter path from file URL
const D2R = Math.PI / 180;
const MARGIN = 16;

function f64hex(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return b.readBigUInt64LE(0).toString(16).padStart(16, '0');
}

// ---------- FITS header cards ----------
function parseFitsHeader(path) {
  const buf = readFileSync(path);
  const h = {};
  for (let off = 0; off + 80 <= buf.length; off += 80) {
    const card = buf.toString('latin1', off, off + 80);
    const key = card.slice(0, 8).trim();
    if (key === 'END') break;
    if (!key || card[8] !== '=') continue;
    const val = card.slice(10).split('/')[0].trim();
    h[key] = val.startsWith("'") ? val.replace(/'/g, '').trim() : parseFloat(val);
  }
  return h;
}
const hdr = parseFitsHeader(WCS_PATH);
const W = hdr.IMAGEW, H = hdr.IMAGEH;
if (W !== 5796 || H !== 3870) throw new Error(`unexpected frame dims ${W}x${H}`);
const cd = [[hdr.CD1_1, hdr.CD1_2], [hdr.CD2_1, hdr.CD2_2]];
const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
const cdInv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
function sipPoly(prefix, order) {
  const terms = [];
  for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) {
    const v = hdr[`${prefix}_${i}_${j}`];
    if (v !== undefined && v !== 0) terms.push([i, j, v]);
  }
  return (u, v) => { let s = 0; for (const [i, j, c] of terms) s += c * u ** i * v ** j; return s; };
}
const AP = hdr.AP_ORDER ? sipPoly('AP', hdr.AP_ORDER) : null;
const BP = hdr.BP_ORDER ? sipPoly('BP', hdr.BP_ORDER) : null;
function sky2pix(raDeg, decDeg) { // -> 0-based detection-convention pixels
  const a0 = hdr.CRVAL1 * D2R, d0 = hdr.CRVAL2 * D2R, a = raDeg * D2R, d = decDeg * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 1e-4) return null;
  const xi = (Math.cos(d) * Math.sin(a - a0) / cosc) / D2R;
  const eta = ((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc) / D2R;
  const U = cdInv[0][0] * xi + cdInv[0][1] * eta, V = cdInv[1][0] * xi + cdInv[1][1] * eta;
  const u = AP ? U + AP(U, V) : U, v = BP ? V + BP(U, V) : V;
  return [u + hdr.CRPIX1 - 1, v + hdr.CRPIX2 - 1];
}

// ---------- stars + truth sets (bands 7-14) ----------
const manifest = JSON.parse(readFileSync(`${REL}/manifest.json`, 'utf8'));
const st = arrow.tableFromIPC(readFileSync(`${REL}/stars.arrow`));
const sra = st.getChild('ra_deg').toArray(), sdec = st.getChild('dec_deg').toArray(), sg = st.getChild('g_mag').toArray();
const DEPTH_MAX = Math.max(...manifest.depths.slice(7)) + 1e-6;
const px = new Float64Array(sg.length).fill(NaN), py = new Float64Array(sg.length).fill(NaN);
for (let i = 0; i < sg.length; i++) {
  if (sg[i] > DEPTH_MAX) continue;
  const p = sky2pix(sra[i], sdec[i]); if (!p) continue;
  if (p[0] < MARGIN || p[0] > W - MARGIN || p[1] < MARGIN || p[1] > H - MARGIN) continue;
  px[i] = p[0]; py[i] = p[1];
}
const bands = [];
for (let b = 7; b <= 14; b++) {
  const t = arrow.tableFromIPC(readFileSync(`${REL}/band_${b}.arrow`));
  const s0 = t.getChild('star0').toArray(), s1 = t.getChild('star1').toArray(),
        s2 = t.getChild('star2').toArray(), s3 = t.getChild('star3').toArray();
  const sets = new Map();
  for (let r = 0; r < s0.length; r++) {
    const a = s0[r], bb = s1[r], c = s2[r], d = s3[r];
    if (Number.isNaN(px[a]) || Number.isNaN(px[bb]) || Number.isNaN(px[c]) || Number.isNaN(px[d])) continue;
    const k = [a, bb, c, d].sort((x, y) => x - y).join(',');
    if (!sets.has(k)) sets.set(k, [a, bb, c, d].sort((x, y) => x - y));
  }
  bands.push({ band: b, lo: manifest.edges[b], hi: manifest.edges[b + 1], depth: manifest.depths[b],
               fileRows: s0.length, sets: [...sets.values()] });
  console.log(`band ${b}: ${s0.length} rows, ${sets.size} unique in-frame truth 4-sets`);
}

// ---------- detections (id = ARRAY INDEX; raw ids are non-unique) ----------
const dj = JSON.parse(readFileSync(DET_PATH, 'utf8'));
const raw = dj.detections;
const valid = []; // {idx, x, y, flux, peak}
for (let i = 0; i < raw.length; i++) {
  const d = raw[i];
  if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.flux)) continue;
  if (!(d.flux > 0)) continue;
  if (d.x < 0 || d.x >= W || d.y < 0 || d.y >= H) continue;
  valid.push({ idx: i, x: d.x, y: d.y, flux: d.flux, peak: d.peak_value });
}
console.log(`detections: raw ${raw.length}, valid ${valid.length}`);

// nearest-match grid over VALID detections
const mgrid = new Map(); const nx = Math.ceil(W / 64);
for (const d of valid) { const k = Math.floor(d.x / 64) + Math.floor(d.y / 64) * nx; if (!mgrid.has(k)) mgrid.set(k, []); mgrid.get(k).push(d); }
function nearest(x, y, tol) {
  let best = null, bd = tol * tol;
  for (let yy = Math.max(0, Math.floor((y - tol) / 64)); yy <= Math.floor((y + tol) / 64); yy++)
    for (let xx = Math.max(0, Math.floor((x - tol) / 64)); xx <= Math.floor((x + tol) / 64); xx++) {
      const lst = mgrid.get(xx + yy * nx); if (!lst) continue;
      for (const d of lst) { const dd = (d.x - x) ** 2 + (d.y - y) ** 2; if (dd < bd) { bd = dd; best = d; } }
    }
  return best ? { d: best, r: Math.sqrt(bd) } : null;
}

// ---------- member table (unique star rows across bands 7-14 truth sets) ----------
const members = new Map(); // star row -> record
for (const b of bands) for (const s4 of b.sets) for (const s of s4) {
  if (members.has(s)) continue;
  const rr = Math.hypot(px[s] - (hdr.CRPIX1 - 1), py[s] - (hdr.CRPIX2 - 1));
  const tol = 10 + 0.01 * rr; // m1_measure matching rule
  const hit = nearest(px[s], py[s], tol);
  members.set(s, {
    star: s,
    det: hit ? hit.d.idx : -1,          // ARRAY-INDEX id, -1 = ABSENT
    cls: hit ? 'MATCHED' : 'ABSENT',
    dist: hit ? hit.r : null,
    dist_hex: hit ? f64hex(hit.r) : null,
    px: Math.round(px[s] * 1000) / 1000, // diagnostic only
    py: Math.round(py[s] * 1000) / 1000,
    g: Math.round(sg[s] * 10000) / 10000,
  });
}
const clsCounts = {};
for (const m of members.values()) clsCounts[m.cls] = (clsCounts[m.cls] || 0) + 1;
console.log(`unique members: ${members.size}`, JSON.stringify(clsCounts));

// ---------- diagnostic: clean per-detection UNION policy (Rust prep semantics) ----------
// rank_flux: flux desc, ties raw-id asc then idx asc; rank_peak: peak desc, flux desc, raw-id
// asc, idx asc; priority = min(rank_flux, 2*rank_peak); dedup 4 px strict in priority order;
// uniformize 10x10 round-robin. Mirrors prep.rs exactly (per-DETECTION ranks; the M-1 policy
// script keyed ranks by the non-unique raw id, which demotes ~3.7k bright twins).
{
  const rawId = (v) => raw[v.idx].id;
  const byFlux = [...valid].sort((a, b) => (b.flux - a.flux) || (rawId(a) - rawId(b)) || (a.idx - b.idx));
  const byPeak = [...valid].sort((a, b) => {
    const ap = Number.isFinite(a.peak) ? a.peak : -Infinity, bp = Number.isFinite(b.peak) ? b.peak : -Infinity;
    return (bp - ap) || (b.flux - a.flux) || (rawId(a) - rawId(b)) || (a.idx - b.idx);
  });
  const prio = new Map();
  byFlux.forEach((d, i) => prio.set(d.idx, i));
  byPeak.forEach((d, i) => { const p = 2 * i; if (p < prio.get(d.idx)) prio.set(d.idx, p); });
  const cmp = (a, b) => (prio.get(a.idx) - prio.get(b.idx)) || (rawId(a) - rawId(b)) || (a.idx - b.idx);
  const ordered = [...valid].sort(cmp);
  const CS = 16, NXd = Math.ceil(W / CS);
  const dgrid = new Map(); const kept = []; const survivor = new Map();
  for (const d of ordered) {
    const cx = Math.floor(d.x / CS), cy = Math.floor(d.y / CS);
    let sup = null;
    outer: for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) {
      const lst = dgrid.get(xx + yy * NXd); if (!lst) continue;
      for (const e of lst) if ((e.x - d.x) ** 2 + (e.y - d.y) ** 2 < 16) { sup = e; break outer; }
    }
    if (sup) { survivor.set(d.idx, sup.idx); continue; }
    const k = cx + cy * NXd;
    if (!dgrid.has(k)) dgrid.set(k, []);
    dgrid.get(k).push(d);
    kept.push(d);
  }
  const GX = 10, GY = 10;
  const cells = Array.from({ length: GX * GY }, () => []);
  for (const d of kept) cells[Math.min(GY - 1, Math.floor(d.y / H * GY)) * GX + Math.min(GX - 1, Math.floor(d.x / W * GX))].push(d);
  for (const c of cells) c.sort(cmp);
  const ur = new Map(); let rank = 0, k = 0;
  for (;;) {
    const pass = [];
    for (const c of cells) if (c[k]) pass.push(c[k]);
    if (!pass.length) break;
    pass.sort(cmp);
    for (const d of pass) ur.set(d.idx, ++rank);
    k++;
  }
  console.log(`clean-policy pool: kept ${kept.length}, dropped ${survivor.size}`);
  for (const R of [100, 200, 400]) {
    let n10 = 0; const perBand = [];
    for (const b of bands) {
      let c = 0;
      for (const s4 of b.sets) {
        let ok = true, mx = 0;
        for (const s of s4) {
          let di = members.get(s).det;
          if (di < 0) { ok = false; break; }
          if (survivor.has(di)) di = survivor.get(di);
          const r = ur.get(di);
          if (r === undefined) { ok = false; break; }
          mx = Math.max(mx, r);
        }
        if (ok && mx <= R) c++;
      }
      perBand.push(`${b.band}:${c}`);
      if (b.band >= 10) n10 += c;
    }
    console.log(`clean-policy in-pool @<=${R}: bands>=10 total ${n10}  (per band ${perBand.join(' ')})`);
  }
  console.log('M-1 frozen table (raw-id-keyed JS sim) bands>=10: 8 @100, 20 @200, 56 @400');
}

// ---------- write fixture ----------
const fixture = {
  schema: 'greenfield-solver.truth-fixture/1.0.0',
  generated: new Date().toISOString(),
  frame: 'CSM30799',
  width: W, height: H,
  release: manifest.release,
  wcs_path: WCS_PATH,
  det_path: DET_PATH,
  det_count_raw: raw.length,
  det_count_valid: valid.length,
  det_id_convention: '0-based ARRAY INDEX into detections[] of the source JSON (raw `id` field is NON-unique: 3,669 duplicate ids). The Rust desk-check builds Detection.id the same way.',
  margin_px: MARGIN,
  match_rule: 'nearest VALID detection within radial tol 10 + 0.01*r px (r = dist from CRPIX-1), per m1_measure.mjs',
  float_transport: 'load-bearing floats as IEEE-754 f64 bit-pattern hex (big-endian u64 hex); px/py/g decimals are diagnostic only',
  members: [...members.values()].sort((a, b) => a.star - b.star),
  bands: bands.map(b => ({
    band: b.band,
    lo_deg: b.lo, lo_hex: f64hex(b.lo),
    hi_deg: b.hi, hi_hex: f64hex(b.hi),
    depth_g: b.depth,
    file_rows: b.fileRows,
    sets: b.sets, // each = 4 star rows, ascending
  })),
};
writeFileSync(OUT, JSON.stringify(fixture));
console.log(`wrote ${OUT} (${(JSON.stringify(fixture).length / 1e6).toFixed(2)} MB, ${members.size} members, ${bands.reduce((s, b) => s + b.sets.length, 0)} sets)`);
