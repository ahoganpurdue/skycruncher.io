#!/usr/bin/env node
// serial_coverage_scan.mjs — MEASURE per-body-serial availability across on-disk
// file classes WITHOUT loading image bytes into the agent context.
//  - RAW/JPEG/TIFF: exifr (the app's own EXIF lib) with makerNote enabled; pulls
//    BodySerialNumber(0xA431), Canon MakerNote SerialNumber, InternalSerialNumber,
//    LensSerialNumber, CameraSerialNumber.
//  - FITS: reads ONLY the ASCII header blocks (2880-byte units up to END), never
//    the image array; scans for INSTRUME/TELESCOP + any serial-ish card.
// Emits rows of {file, class, format, make, model, lens, body_serial_tag,
//   body_serial, lens_serial_tag, lens_serial}. Only metadata strings leave —
//   never raw image bytes (sanctioned "run extractor, read JSON summary" pattern).
import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';

const OUT_DIR = 'test_results/serial_coverage';
fs.mkdirSync(OUT_DIR, { recursive: true });

// Classes: [label, rootDir, globPredicate]
const RASTER_EXT = new Set(['.cr2', '.nef', '.arw', '.jpg', '.jpeg', '.tif', '.tiff']);
const FITS_EXT = new Set(['.fit', '.fits', '.fts']);

const CLASSES = [
  ['bundled_demo_cr2', 'public/demo', f => f.toLowerCase().endsWith('.cr2')],
  ['canon_t6_rokinon_cr2', 'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm', f => f.toLowerCase().endsWith('.cr2')],
  ['canon_jpeg', 'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm', f => /\.jpe?g$/i.test(f)],
  ['canon_5dmk3_cr2', 'Sample Files/rotating', f => f.toLowerCase().endsWith('.cr2')],
  ['seestar_fits_local', 'Sample Files', f => FITS_EXT.has(path.extname(f).toLowerCase())],
  ['fits_demo', 'public', f => FITS_EXT.has(path.extname(f).toLowerCase())],
];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Serial tag priority for the EXIF/MakerNote path.
const BODY_SERIAL_TAGS = ['BodySerialNumber', 'SerialNumber', 'InternalSerialNumber', 'CameraSerialNumber'];
const LENS_SERIAL_TAGS = ['LensSerialNumber'];

async function scanRaster(file) {
  const row = { file: path.basename(file), format: path.extname(file).slice(1).toUpperCase(),
    make: null, model: null, lens: null, body_serial_tag: null, body_serial: null,
    lens_serial_tag: null, lens_serial: null, error: null };
  try {
    const buf = fs.readFileSync(file);
    const tags = await exifr.parse(buf, {
      tiff: true, exif: true, ifd0: true, makerNote: true,
      translateKeys: true, translateValues: true, reviveValues: true,
      mergeOutput: true, sanitize: true,
    }) || {};
    row.make = tags.Make != null ? String(tags.Make).trim() : null;
    row.model = tags.Model != null ? String(tags.Model).trim() : null;
    row.lens = tags.LensModel != null ? String(tags.LensModel).trim() : null;
    for (const t of BODY_SERIAL_TAGS) {
      if (tags[t] != null && String(tags[t]).trim().length) { row.body_serial_tag = t; row.body_serial = String(tags[t]).trim(); break; }
    }
    for (const t of LENS_SERIAL_TAGS) {
      if (tags[t] != null && String(tags[t]).trim().length) { row.lens_serial_tag = t; row.lens_serial = String(tags[t]).trim(); break; }
    }
    // Canon MakerNote sometimes surfaces as a nested object under 'makerNote' or as
    // Canon* keys; probe a few known Canon serial homes if the standard tag missed.
    if (!row.body_serial) {
      const mn = tags.makerNote || tags.MakerNote || {};
      const cand = mn.SerialNumber ?? mn.InternalSerialNumber ?? tags.CanonSerialNumber;
      if (cand != null && String(cand).trim().length) { row.body_serial_tag = 'MakerNote.SerialNumber'; row.body_serial = String(cand).trim(); }
    }
  } catch (e) { row.error = String(e && e.message || e).slice(0, 120); }
  return row;
}

function scanFitsHeader(file) {
  const row = { file: path.basename(file), format: 'FITS', make: null, model: null,
    lens: null, body_serial_tag: null, body_serial: null, lens_serial_tag: null,
    lens_serial: null, error: null };
  try {
    const fd = fs.openSync(file, 'r');
    // Read header only: up to 64 * 2880 bytes (184KB) or until END card.
    const BLOCK = 2880; const MAXBLOCKS = 64;
    const cards = {};
    let done = false;
    for (let b = 0; b < MAXBLOCKS && !done; b++) {
      const buf = Buffer.alloc(BLOCK);
      const n = fs.readSync(fd, buf, 0, BLOCK, b * BLOCK);
      if (n <= 0) break;
      const txt = buf.toString('latin1', 0, n);
      for (let i = 0; i < n; i += 80) {
        const card = txt.slice(i, i + 80);
        const kw = card.slice(0, 8).trim();
        if (kw === 'END') { done = true; break; }
        if (!kw || card[8] !== '=') continue;
        let val = card.slice(10).split('/')[0].trim();
        if (val.startsWith("'")) val = val.replace(/'/g, '').trim();
        cards[kw] = val;
      }
    }
    fs.closeSync(fd);
    row.model = cards.INSTRUME ?? null;
    row.lens = cards.TELESCOP ?? null;
    row.make = cards.ORIGIN ?? cards.CREATOR ?? cards.SWCREATE ?? null;
    // Serial-ish cards seen in ZWO/ASIAIR/SeeStar/pro-cam FITS.
    const SERIAL_CARDS = ['CAMERAID', 'SERIALNU', 'CCD-ID', 'CCDSERNO', 'DETSER', 'GUID', 'CAMSERNO', 'SERIAL', 'INSTID'];
    for (const c of SERIAL_CARDS) {
      if (cards[c] != null && String(cards[c]).trim().length) { row.body_serial_tag = c; row.body_serial = String(cards[c]).trim(); break; }
    }
    row._allKeys = Object.keys(cards).join(',');
  } catch (e) { row.error = String(e && e.message || e).slice(0, 120); }
  return row;
}

const results = { generated: new Date().toISOString(), classes: {} };
const seen = new Set();
for (const [label, root, pred] of CLASSES) {
  const files = walk(root).filter(pred).filter(f => { if (seen.has(f)) return false; seen.add(f); return true; });
  const rows = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const row = FITS_EXT.has(ext) ? scanFitsHeader(f) : await scanRaster(f);
    row.class = label;
    rows.push(row);
  }
  const withBody = rows.filter(r => r.body_serial).length;
  const withLens = rows.filter(r => r.lens_serial).length;
  results.classes[label] = {
    root, files_scanned: rows.length,
    body_serial_present: withBody,
    body_serial_pct: rows.length ? +(100 * withBody / rows.length).toFixed(1) : 0,
    lens_serial_present: withLens,
    lens_serial_pct: rows.length ? +(100 * withLens / rows.length).toFixed(1) : 0,
    body_serial_tags: [...new Set(rows.filter(r => r.body_serial_tag).map(r => r.body_serial_tag))],
    rows,
  };
}

fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

// Compact console summary (counts + tags only; serial strings go to JSON on disk).
console.log('=== SERIAL COVERAGE SUMMARY ===');
for (const [label, c] of Object.entries(results.classes)) {
  console.log(`\n[${label}]  n=${c.files_scanned}  root="${c.root}"`);
  console.log(`  body_serial: ${c.body_serial_present}/${c.files_scanned} (${c.body_serial_pct}%) tags=${JSON.stringify(c.body_serial_tags)}`);
  console.log(`  lens_serial: ${c.lens_serial_present}/${c.files_scanned} (${c.lens_serial_pct}%)`);
  const ex = c.rows[0];
  if (ex) console.log(`  e.g. ${ex.file}: make=${ex.make} model=${ex.model} bodySerialTag=${ex.body_serial_tag} lensSerialTag=${ex.lens_serial_tag}${ex.error ? ' ERR=' + ex.error : ''}`);
  if (label.includes('fits') && ex && ex._allKeys) console.log(`  FITS keys(${ex.file}): ${ex._allKeys.slice(0, 260)}`);
}
console.log('\nWROTE', path.join(OUT_DIR, 'results.json'));
