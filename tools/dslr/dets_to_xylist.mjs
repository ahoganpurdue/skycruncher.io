// ═══════════════════════════════════════════════════════════════════════════
// DETECTIONS → FITS XYLIST (measurer-lane, one-shot) — for feeding solve-field
// a pre-extracted source list instead of a raw image. Standard astrometry.net
// xylist convention: a FITS binary table with X/Y/FLUX float32 columns +
// IMAGEW/IMAGEH header keywords (the same shape image2xy emits).
//
//   node tools/dslr/dets_to_xylist.mjs <cr2_dets.json> <out.xyls>
//
// Writes ONLY under the given --out path (caller's choice; this run keeps it
// under test_results/). No engine files touched.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';

const [detsPath, outPath] = process.argv.slice(2);
if (!detsPath || !outPath) {
  console.error('usage: node tools/dslr/dets_to_xylist.mjs <dets.json> <out.xyls>');
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(detsPath, 'utf8'));
const dets = d.detections;
const W = d.width, H = d.height;
if (!Array.isArray(dets) || !dets.length) { console.error('no detections'); process.exit(1); }

function card(key, val, comment) {
  let line;
  if (typeof val === 'boolean') line = `${key.padEnd(8)}= ${val ? 'T' : 'F'}`.padEnd(30);
  else if (typeof val === 'number') line = `${key.padEnd(8)}= ${String(Number.isInteger(val) ? val : val).padStart(20)}`;
  else line = `${key.padEnd(8)}= '${val}'`.padEnd(30);
  if (comment) line = (line + ` / ${comment}`);
  return line.slice(0, 80).padEnd(80);
}
function padBlock(buf) {
  const rem = buf.length % 2880;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(2880 - rem, 0x20)]);
}

// ── Primary HDU (empty) ──
const primaryCards = [
  card('SIMPLE', true),
  card('BITPIX', 8),
  card('NAXIS', 0),
  card('EXTEND', true),
  'END'.padEnd(80),
];
const primaryHdr = padBlock(Buffer.from(primaryCards.join(''), 'latin1'));

// ── BINTABLE extension: X, Y, FLUX as 1E (float32) ──
const nrows = dets.length;
const rowBytes = 12; // 3 x float32
const extCards = [
  card('XTENSION', 'BINTABLE'),
  card('BITPIX', 8),
  card('NAXIS', 2),
  card('NAXIS1', rowBytes),
  card('NAXIS2', nrows),
  card('PCOUNT', 0),
  card('GCOUNT', 1),
  card('TFIELDS', 3),
  card('TTYPE1', 'X'),
  card('TFORM1', '1E'),
  card('TTYPE2', 'Y'),
  card('TFORM2', '1E'),
  card('TTYPE3', 'FLUX'),
  card('TFORM3', '1E'),
  card('IMAGEW', W, 'source image width (px)'),
  card('IMAGEH', H, 'source image height (px)'),
  'END'.padEnd(80),
];
const extHdr = padBlock(Buffer.from(extCards.join(''), 'latin1'));

const data = Buffer.alloc(nrows * rowBytes);
for (let i = 0; i < nrows; i++) {
  const o = i * rowBytes;
  data.writeFloatBE(dets[i].x, o);
  data.writeFloatBE(dets[i].y, o + 4);
  data.writeFloatBE(dets[i].flux, o + 8);
}
const dataBlock = padBlock(data);

const out = Buffer.concat([primaryHdr, extHdr, dataBlock]);
fs.writeFileSync(outPath, out);
console.log(`[xylist] ${nrows} rows, W=${W} H=${H} -> ${outPath} (${out.length} bytes)`);
