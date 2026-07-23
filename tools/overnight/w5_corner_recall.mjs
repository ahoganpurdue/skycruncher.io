#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// W5 CORNER-RECALL LEG — catalog-density vs oracle-existence in corner annuli
// ═══════════════════════════════════════════════════════════════════════════
// On the VIGNETTING-rig frames (Cocoon 60Da lights) that solved: does the sky
// actually HAVE catalog stars out in the vignetted corners, and did the oracle
// itself find/match stars there? (The "recall" denominator + an existence proof
// that corners are not dead.)
//
// For a bounded subset of solved cocoon frames we RE-SOLVE keeping the a.net
// byproducts, then bin every point-set by r_norm (radial distance from image
// centre, normalised so the CORNER = 1.0):
//   • CATALOG   = index/Gaia reference stars (.rdls RA/Dec) projected through the
//                 solve WCS via wcs-rd2xy  → "project the Gaia catalog through the
//                 a.net WCS" (the 4100 indexes are Gaia-derived).
//   • MATCHED   = a.net's own matched correspondences (.corr FIELD_X/FIELD_Y) →
//                 the strongest existence proof (real stars matched in the corner).
//   • DETECTED  = a.net's own simplexy detections (.axy X/Y) → supporting proof.
// OUR per-star detection lists are NOT recoverable (banked receipts carry counts
// only) → reported NOT MEASURABLE WITHOUT RE-EXTRACTION, per owner scoping.
//
//   node tools/overnight/w5_corner_recall.mjs --frames <file> [--out <dir>] [--limit N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECODE_CHILD = path.join(HERE, 'w5_decode_frame.mjs');
const WSL_DISTRO = 'Ubuntu-24.04';
const CFG = '/mnt/d/astrometry_indexes/astrometry_lite.cfg';
// annulus edges in r_norm (corner = 1.0). Highlight the 0.67-1.0 vignetted zone.
const EDGES = [0.0, 0.33, 0.67, 0.83, 1.0];

function parseArgs(argv) { const a = { _: [] }; for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) a[t.slice(2)] = argv[++i]; else a._.push(t); } return a; }
function toWsl(p) { const m = /^([A-Za-z]):[\\/](.*)$/.exec(p); return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/'); }
function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((res) => { const ch = spawn(cmd, args, { windowsHide: true }); let o = '', e = ''; let tm = null, k = false;
    if (timeoutMs) tm = setTimeout(() => { k = true; try { ch.kill('SIGKILL'); } catch {} }, timeoutMs);
    ch.stdout.on('data', d => o += d); ch.stderr.on('data', d => e += d);
    ch.on('error', er => { if (tm) clearTimeout(tm); res({ code: -1, stdout: o, stderr: String(er), killed: k }); });
    ch.on('close', c => { if (tm) clearTimeout(tm); res({ code: c, stdout: o, stderr: e, killed: k }); }); });
}
const wsl = (a, o) => run('wsl', ['-d', WSL_DISTRO, '-e', ...a], o);

// ── minimal FITS BINTABLE reader: returns named columns from the first BINTABLE HDU
function readBintable(file, wantCols) {
  const buf = fs.readFileSync(file);
  let off = 0;
  const readHeader = () => {
    const cards = {}; let end = false;
    for (; off < buf.length; off += 2880) {
      for (let c = 0; c < 2880; c += 80) {
        const card = buf.toString('latin1', off + c, off + c + 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') { end = true; }
        else if (card[8] === '=') { let v = card.slice(10).split('/')[0].trim(); v = v.replace(/^'|'$/g, '').trim(); cards[key] = v; }
      }
      if (end) { off += 2880; break; }
    }
    return cards;
  };
  // primary HDU
  let h = readHeader();
  const primNax = Number(h.NAXIS || 0);
  if (primNax > 0) { let n = Math.abs(Number(h.BITPIX)) / 8; for (let i = 1; i <= primNax; i++) n *= Number(h['NAXIS' + i]); off += Math.ceil(n / 2880) * 2880; }
  // extensions until BINTABLE
  while (off < buf.length) {
    h = readHeader();
    if ((h.XTENSION || '').toUpperCase() === 'BINTABLE') break;
    const nax = Number(h.NAXIS || 0); let n = Math.abs(Number(h.BITPIX)) / 8;
    for (let i = 1; i <= nax; i++) n *= Number(h['NAXIS' + i] || 1);
    off += Math.ceil(n / 2880) * 2880;
    if (!h.XTENSION) throw new Error('no BINTABLE HDU found');
  }
  const rowBytes = Number(h.NAXIS1), nrows = Number(h.NAXIS2), tf = Number(h.TFIELDS);
  // column layout
  const cols = []; let cursor = 0;
  const sz = { L: 1, B: 1, I: 2, J: 4, K: 8, E: 4, D: 8, A: 1 };
  for (let i = 1; i <= tf; i++) {
    const form = (h['TFORM' + i] || '').trim(); const m = form.match(/^(\d*)([A-Z])/); const rep = m[1] ? Number(m[1]) : 1; const code = m[2];
    const name = (h['TTYPE' + i] || '').trim().toUpperCase();
    cols.push({ name, code, rep, bytes: (sz[code] || 1) * rep, off: cursor }); cursor += (sz[code] || 1) * rep;
  }
  const out = {}; for (const w of wantCols) out[w] = new Float64Array(nrows);
  const readVal = (dv, p, code) => code === 'D' ? dv.getFloat64(p, false) : code === 'E' ? dv.getFloat32(p, false)
    : code === 'J' ? dv.getInt32(p, false) : code === 'I' ? dv.getInt16(p, false) : code === 'K' ? Number(dv.getBigInt64(p, false)) : dv.getUint8(p);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, rowBytes * nrows);
  for (let r = 0; r < nrows; r++) {
    for (const w of wantCols) { const col = cols.find(c => c.name === w); if (!col) continue; out[w][r] = readVal(dv, r * rowBytes + col.off, col.code); }
  }
  out._nrows = nrows; return out;
}

function binAnnuli(xs, ys, cx, cy, rMax) {
  const counts = new Array(EDGES.length - 1).fill(0); let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const rn = Math.hypot(xs[i] - cx, ys[i] - cy) / rMax;
    for (let b = 0; b < EDGES.length - 1; b++) { if (rn >= EDGES[b] && (rn < EDGES[b + 1] || (b === EDGES.length - 2 && rn <= 1.0001))) { counts[b]++; n++; break; } }
  }
  return { counts, n };
}
const g = (txt, k) => { const m = txt.match(new RegExp(`^${k}\\s+([-\\d.eE+]+)`, 'm')); return m ? Number(m[1]) : null; };

async function processFrame(frame, out) {
  const base = path.basename(frame).replace(/\.[^.]+$/, '');
  const tmp = path.join(out, '_cwork', base); fs.mkdirSync(tmp, { recursive: true });
  const tb = path.join(tmp, base);
  console.log(`[corner] ${base}: decode…`);
  const dec = await run(process.execPath, [DECODE_CHILD, frame, tb], { timeoutMs: 300000 });
  if (!/OK pgm/.test(dec.stdout)) return { base, error: 'DECODE', note: (dec.stderr || '').trim().split('\n').pop() };
  const conv = await wsl(['an-pnmtofits', toWsl(`${tb}.pgm`), toWsl(`${tb}.fits`)], { timeoutMs: 120000 });
  if (conv.code !== 0) return { base, error: 'PNM2FITS' };
  const wcs = `${tb}.wcs`, corr = `${tb}.corr`, rdls = `${tb}.rdls`, axy = `${tb}.axy`;
  const args = ['solve-field', toWsl(`${tb}.fits`), '--overwrite', '--no-plots', '--dir', toWsl(tmp),
    '--wcs', toWsl(wcs), '--corr', toWsl(corr), '--rdls', toWsl(rdls), '--axy', toWsl(axy),
    '--new-fits', 'none', '--match', 'none', '--index-xyls', 'none',
    '--downsample', '2', '--cpulimit', '120', '--config', CFG,
    '--scale-units', 'arcsecperpix', '--scale-low', '1.6', '--scale-high', '2.5'];
  console.log(`[corner] ${base}: solve (keep byproducts)…`);
  const sf = await wsl(args, { timeoutMs: 210000 });
  if (!fs.existsSync(wcs)) return { base, error: 'NO_SOLVE' };
  // project the reference (Gaia/index) rdls through the WCS → x/y pixel
  const refxy = `${tb}.refxy.fits`;
  await wsl(['wcs-rd2xy', '-w', toWsl(wcs), '-i', toWsl(rdls), '-o', toWsl(refxy)], { timeoutMs: 60000 });
  const wi = await wsl(['wcsinfo', toWsl(wcs)], { timeoutMs: 60000 });
  const W = g(wi.stdout, 'imagew'), H = g(wi.stdout, 'imageh');
  const cx = W / 2, cy = H / 2, rMax = Math.hypot(cx, cy);

  const detect = fs.existsSync(axy) ? readBintable(axy, ['X', 'Y']) : null;      // a.net detections
  const match = fs.existsSync(corr) ? readBintable(corr, ['FIELD_X', 'FIELD_Y']) : null; // matched
  const ref = fs.existsSync(refxy) ? readBintable(refxy, ['X', 'Y']) : null;     // catalog projected

  const res = { base, W, H, rMax: +rMax.toFixed(1) };
  res.catalog = ref ? binAnnuli(ref.X, ref.Y, cx, cy, rMax) : null;              // Gaia catalog
  res.matched = match ? binAnnuli(match.FIELD_X, match.FIELD_Y, cx, cy, rMax) : null;
  res.detected = detect ? binAnnuli(detect.X, detect.Y, cx, cy, rMax) : null;
  // per-annulus area (px^2) for density; annulus b spans r in [EDGES[b],EDGES[b+1]]*rMax
  res.annulus_area_px2 = [];
  for (let b = 0; b < EDGES.length - 1; b++) res.annulus_area_px2.push(+(Math.PI * ((EDGES[b + 1] * rMax) ** 2 - (EDGES[b] * rMax) ** 2)).toFixed(0));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[corner] ${base}: catalog=${res.catalog?.n} matched=${res.matched?.n} detected=${res.detected?.n}`);
  return res;
}

function fmtTable(rows) {
  const lab = EDGES.slice(0, -1).map((e, i) => `${e.toFixed(2)}-${EDGES[i + 1].toFixed(2)}`);
  const L = ['# W5 Corner-Recall — catalog vs oracle existence in r_norm annuli (Cocoon 60Da vignetting rig)', '',
    `Generated ${new Date().toISOString()}`, '',
    'r_norm = radial pixel distance from image centre / centre-to-corner (corner = 1.0). Vignetted corner zone = 0.67-1.0.',
    'DETECTED = a.net simplexy detections (.axy) — independent-detector existence proof (the key metric; density corrects for annulus area). ' +
    'MATCHED = a.net matched correspondences (.corr). ' +
    'CATALOG(shallow) = reference stars from the SOLVING wide index (.rdls) projected through the WCS (wcs-rd2xy).', '',
    '**CAVEAT — no DEEP-Gaia density**: the shipped Gaia atlas is deny-listed to this agent, and the only catalog projection available ' +
    'is the SOLVING index\'s reference set (index-411x, a SPARSE wide-field index → ~20 stars/field). Treat CATALOG(shallow) as the ' +
    'oracle\'s quad-reference stars, NOT a deep-Gaia recall denominator. The corner existence proof therefore rests on DETECTED density.', '',
    '**OUR per-star detections: NOT MEASURABLE WITHOUT RE-EXTRACTION** — banked receipts carry counts only; ' +
    'no per-star detection list is recoverable from any banked artifact (owner scoping: catalog-side + oracle-existence only tonight).', ''];
  // aggregate
  const agg = { catalog: new Array(EDGES.length - 1).fill(0), matched: new Array(EDGES.length - 1).fill(0), detected: new Array(EDGES.length - 1).fill(0), area: new Array(EDGES.length - 1).fill(0) };
  let nf = 0;
  for (const r of rows) { if (r.error) continue; nf++; for (let b = 0; b < EDGES.length - 1; b++) { agg.catalog[b] += r.catalog?.counts[b] || 0; agg.matched[b] += r.matched?.counts[b] || 0; agg.detected[b] += r.detected?.counts[b] || 0; agg.area[b] += r.annulus_area_px2[b] || 0; } }
  L.push(`## Aggregate over ${nf} vignetting-rig frames`, '',
    '| r_norm annulus | DETECTED (a.net) | DET dens (/Mpx) | dens vs centre | MATCHED | CATALOG(shallow) |', '|---|---|---|---|---|---|');
  const centreDens = agg.area[0] ? agg.detected[0] / (agg.area[0] / 1e6) : 0;
  for (let b = 0; b < EDGES.length - 1; b++) {
    const dens = agg.area[b] ? agg.detected[b] / (agg.area[b] / 1e6) : 0;
    const rel = centreDens ? (dens / centreDens * 100).toFixed(0) + '%' : '';
    L.push(`| ${lab[b]}${b >= 2 ? ' ⬅corner' : ''} | ${agg.detected[b]} | ${dens.toFixed(0)} | ${rel} | ${agg.matched[b]} | ${agg.catalog[b]} |`);
  }
  L.push('', '## Per-frame (CATALOG / MATCHED / DETECTED counts per annulus)', '', '| frame | ' + lab.map(x => `cat ${x}`).join(' | ') + ' |', '|' + '---|'.repeat(lab.length + 1));
  for (const r of rows) { if (r.error) { L.push(`| ${r.base} | ${r.error} ${r.note || ''} |`); continue; } L.push(`| ${r.base} | ` + r.catalog.counts.join(' | ') + ' |'); }
  L.push('', 'MATCHED per annulus (existence proof — a.net matched real stars this far into the corner):', '', '| frame | ' + lab.join(' | ') + ' |', '|' + '---|'.repeat(lab.length + 1));
  for (const r of rows) { if (r.error) continue; L.push(`| ${r.base} | ` + r.matched.counts.join(' | ') + ' |'); }
  return L.join('\n');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = path.resolve(a.out || 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18');
  let frames = fs.readFileSync(a.frames, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (a.limit) frames = frames.slice(0, Number(a.limit));
  console.log(`corner-recall: ${frames.length} frame(s)`);
  const rows = [];
  for (const f of frames) rows.push(await processFrame(f, out)); // serial: 1 solve at a time (keep load sane)
  fs.writeFileSync(path.join(out, 'CORNER_RECALL.json'), JSON.stringify(rows, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'CORNER_RECALL.md'), fmtTable(rows));
  console.log(`wrote CORNER_RECALL.md + .json (${rows.filter(r => !r.error).length}/${rows.length} frames measured)`);
}
main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
