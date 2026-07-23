#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// calibration_catalog.mjs — header-only inventory of a calibration-frame pile
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/api/calibration_catalog.mjs <dir> [<dir> ...] --out <catalog.json>
//
// Reads ONLY the FITS header (first blocks) of each frame — never the pixel
// payload — so an 800-frame pile inventories in seconds. Extracts type/camera/
// exposure/temp/gain/dims/binning/filter/date, then groups frames that share
// (type, camera, exptime, temp, binning, dims, filter) into candidate MASTER
// sets for the dark-library program. Honest-or-absent: a header key that is
// missing is recorded null, never fabricated. Type falls back to a filename
// keyword only when IMAGETYP/FRAME/OBSTYPE are all absent (marked inferred).

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { out: null, dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else a.dirs.push(argv[i]);
  }
  return a;
}

function walkFits(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFits(p, acc);
    else if (/\.(fit|fits|fts)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

// Read the FITS primary header (2880-byte blocks of 80-char cards, END-terminated).
// Reads up to maxBlocks blocks from the file start — enough for any real header.
function readHeaderCards(file, maxBlocks = 16) {
  const BLOCK = 2880, CARD = 80;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(BLOCK * maxBlocks);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const cards = {};
    for (let off = 0; off + CARD <= n; off += CARD) {
      const card = buf.toString('latin1', off, off + CARD);
      const key = card.slice(0, 8).trim();
      if (key === 'END') return cards;
      if (key && card[8] === '=') {
        let v = card.slice(10).split('/')[0].trim();      // strip inline comment
        if (v.startsWith("'")) v = v.replace(/^'|'\s*$/g, '').trim(); // string value
        cards[key] = v;
      }
    }
    return cards;                                          // END not found within maxBlocks
  } finally { fs.closeSync(fd); }
}

const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const firstOf = (c, keys) => { for (const k of keys) if (c[k] != null && c[k] !== '') return c[k]; return null; };

function classify(cards, file) {
  const raw = firstOf(cards, ['IMAGETYP', 'FRAME', 'OBSTYPE', 'FRAMETYP']);
  if (raw) {
    const t = raw.toLowerCase();
    if (t.includes('dark')) return { type: 'dark', inferred: false };
    if (t.includes('bias') || t.includes('zero')) return { type: 'bias', inferred: false };
    if (t.includes('flat')) return { type: 'flat', inferred: false };
    if (t.includes('light') || t.includes('object') || t.includes('science')) return { type: 'light', inferred: false };
    return { type: t, inferred: false };
  }
  const fn = path.basename(file).toLowerCase();
  if (/dark/.test(fn)) return { type: 'dark', inferred: true };
  if (/bias/.test(fn)) return { type: 'bias', inferred: true };
  if (/flat/.test(fn)) return { type: 'flat', inferred: true };
  if (/light|_L_|sh2|ngc|m\d/.test(fn)) return { type: 'light', inferred: true };
  return { type: 'unknown', inferred: true };
}

const a = parseArgs(process.argv.slice(2));
if (!a.dirs.length || !a.out) { process.stderr.write('usage: node calibration_catalog.mjs <dir>... --out <catalog.json>\n'); process.exit(1); }

const files = [];
for (const d of a.dirs) { if (fs.existsSync(d)) walkFits(d, files); }
files.sort();

const frames = [];
let readErrors = 0;
for (const f of files) {
  let cards;
  try { cards = readHeaderCards(f); }
  catch (e) { readErrors++; frames.push({ file: f, error: String(e.message || e) }); continue; }
  const { type, inferred } = classify(cards, f);
  frames.push({
    file: f,
    type, type_inferred: inferred,
    camera: firstOf(cards, ['INSTRUME', 'CAMERA', 'DETNAM']),
    exptime_s: num(firstOf(cards, ['EXPTIME', 'EXPOSURE', 'EXP'])),
    ccd_temp_c: num(firstOf(cards, ['CCD-TEMP', 'CCDTEMP', 'TEMPERAT'])),
    set_temp_c: num(firstOf(cards, ['SET-TEMP', 'SETTEMP', 'CCD-STMP'])),
    gain: num(firstOf(cards, ['GAIN', 'EGAIN'])),
    iso: num(firstOf(cards, ['ISO', 'ISOSPEED'])),
    naxis1: num(cards['NAXIS1']), naxis2: num(cards['NAXIS2']),
    xbinning: num(firstOf(cards, ['XBINNING', 'XBIN'])), ybinning: num(firstOf(cards, ['YBINNING', 'YBIN'])),
    filter: firstOf(cards, ['FILTER', 'FILTER1']),
    date_obs: firstOf(cards, ['DATE-OBS', 'DATE_OBS', 'DATE']),
    bitpix: num(cards['BITPIX']),
  });
}

// Candidate master sets: group calibration frames (dark/bias/flat) by the params
// that must match for a stacked master (type/camera/exp/temp/bin/dims/filter).
const groups = new Map();
for (const fr of frames) {
  if (fr.error || !['dark', 'bias', 'flat'].includes(fr.type)) continue;
  const key = [fr.type, fr.camera, fr.type === 'bias' ? 'NA' : fr.exptime_s,
    fr.set_temp_c ?? fr.ccd_temp_c, `${fr.xbinning}x${fr.ybinning}`,
    `${fr.naxis1}x${fr.naxis2}`, fr.type === 'flat' ? fr.filter : 'NA'].join(' | ');
  if (!groups.has(key)) groups.set(key, { key, type: fr.type, camera: fr.camera,
    exptime_s: fr.type === 'bias' ? null : fr.exptime_s, temp_c: fr.set_temp_c ?? fr.ccd_temp_c,
    binning: `${fr.xbinning}x${fr.ybinning}`, dims: `${fr.naxis1}x${fr.naxis2}`,
    filter: fr.type === 'flat' ? fr.filter : null, n: 0, files: [] });
  const g = groups.get(key); g.n++; g.files.push(path.basename(fr.file));
}
const masterSets = [...groups.values()].sort((x, y) => y.n - x.n);

const typeTally = {};
for (const fr of frames) { const t = fr.error ? 'read_error' : fr.type; typeTally[t] = (typeTally[t] || 0) + 1; }

const catalog = {
  kind: 'calibration_catalog', schema: 'calibration_catalog/1',
  generated: new Date().toISOString(),
  source_dirs: a.dirs,
  n_frames: frames.length, read_errors: readErrors,
  type_tally: typeTally,
  candidate_master_sets: masterSets,
  frames,
};
fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
fs.writeFileSync(path.resolve(a.out), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
process.stdout.write(`catalog: ${frames.length} frames, ${masterSets.length} candidate master sets, ${readErrors} read errors -> ${a.out}\n`);
process.stdout.write(`types: ${JSON.stringify(typeTally)}\n`);
