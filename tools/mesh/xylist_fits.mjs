// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — build an astrometry.net XYLIST (FITS BINTABLE) from banked
//             greenfield detections, so solve-field can solve WITHOUT decoding
//             the image (independent quad-hash oracle from a source list).
// ═══════════════════════════════════════════════════════════════════════════
//   node tools/mesh/xylist_fits.mjs <detections.json> <out.fits>
// detections.json: greenfield extraction ({ detections:[{x,y,flux}] } or array).
// Writes a 2-column (X,Y float32-BE) BINTABLE, rows sorted by flux DESC (a.net
// wants brightest first). Prints "OK <nrows> <W?>".
import fs from 'node:fs';

const [, , detPath, outPath] = process.argv;
if (!detPath || !outPath) { console.error('usage: xylist_fits.mjs <detections.json> <out.fits>'); process.exit(1); }

function card(k, v, comment) {
  let s;
  if (v === true) s = `${k.padEnd(8)}=                    T`;
  else if (typeof v === 'string' && !/^[-+]?[0-9]/.test(v)) s = `${k.padEnd(8)}= '${v}'`;
  else s = `${k.padEnd(8)}= ${String(v).padStart(20)}`;
  if (comment) s += ` / ${comment}`;
  return s.slice(0, 80).padEnd(80);
}
function pad2880(buf) {
  const rem = buf.length % 2880;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(2880 - rem, 0x20)]);
}
function headerBlock(cards) {
  const s = cards.map((c) => c.padEnd(80)).join('') + 'END'.padEnd(80);
  return pad2880(Buffer.from(s, 'latin1'));
}

const raw = JSON.parse(fs.readFileSync(detPath, 'utf8'));
const dets = Array.isArray(raw) ? raw : (raw.detections || raw.dets || raw.sources || []);
const rows = dets.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y))
  .map((d) => ({ x: d.x, y: d.y, flux: d.flux ?? d.peak ?? 0 }))
  .sort((a, b) => b.flux - a.flux);
const n = rows.length;

const primary = headerBlock([
  card('SIMPLE', true, 'conforms to FITS standard'),
  card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true),
]);
// 3 cols (X,Y,FLUX float32-BE) so solve-field can --sort-column FLUX (a.net wants
// brightest-first for quad selection; rows are also pre-sorted flux DESC).
const ext = headerBlock([
  "XTENSION= 'BINTABLE'".padEnd(80),
  card('BITPIX', 8), card('NAXIS', 2),
  card('NAXIS1', 12, '3 cols x 4 bytes'), card('NAXIS2', n),
  card('PCOUNT', 0), card('GCOUNT', 1), card('TFIELDS', 3),
  "TTYPE1  = 'X       '".padEnd(80), "TFORM1  = 'E       '".padEnd(80),
  "TTYPE2  = 'Y       '".padEnd(80), "TFORM2  = 'E       '".padEnd(80),
  "TTYPE3  = 'FLUX    '".padEnd(80), "TFORM3  = 'E       '".padEnd(80),
]);
const data = Buffer.allocUnsafe(n * 12);
for (let i = 0; i < n; i++) { data.writeFloatBE(rows[i].x, i * 12); data.writeFloatBE(rows[i].y, i * 12 + 4); data.writeFloatBE(rows[i].flux, i * 12 + 8); }
fs.writeFileSync(outPath, Buffer.concat([primary, ext, pad2880(data)]));
console.log(`OK ${n}`);
