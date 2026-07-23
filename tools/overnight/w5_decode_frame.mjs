#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// W5 ORACLE — isolated per-frame decode child (spawned by w5_oracle_label.mjs)
// ═══════════════════════════════════════════════════════════════════════════
// Runs ONE frame's decode in its OWN process so a libraw-wasm hang/OOM can be
// killed per-frame without stalling the pool. Produces the astrometry.net
// solver input:
//   CR2  -> 16-bit PGM (P5, BE) of native-res luminance   (reuse tools/psf/decode_cr2.mjs
//           + the scibuf_to_pgm p99.9-clip render; star POSITIONS are decode-independent)
//   RAF  -> embedded full-res JPEG carved from the RAF header (X-Trans Bayer path in
//           decode_cr2 checkerboards, so we solve the camera's own preview JPEG; a.net
//           reads JPEG via jpegtopnm). Records the preview resolution as a caveat.
//
//   node tools/overnight/w5_decode_frame.mjs <frame> <out-base>
//     CR2 -> writes <out-base>.pgm ; prints "OK pgm <W> <H>"
//     RAF -> writes <out-base>.jpg ; prints "OK jpg <W> <H>"  (W/H = JPEG SOF dims)
// EXIT 0 = ok, 2 = decode error. Writes ONLY <out-base>.{pgm,jpg}.
import fs from 'node:fs';
import path from 'node:path';

const [, , frame, outBase] = process.argv;
if (!frame || !outBase) { console.error('usage: w5_decode_frame.mjs <frame> <out-base>'); process.exit(1); }

function parseJpegDims(buf) {
  // scan for SOF0/1/2 (0xFFC0/C1/C2) marker → height(BE u16)@5, width@7 after marker.
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m === 0xc0 || m === 0xc1 || m === 0xc2 || m === 0xc3) {
      const H = buf.readUInt16BE(i + 5), W = buf.readUInt16BE(i + 7);
      return { W, H };
    }
    i += 2 + len;
  }
  return { W: 0, H: 0 };
}

async function decodeCR2ToPgm() {
  const {
    decodeCR2, detectPattern, cfaChannelStats, fixHotPixelsCFA, demosaicBilinear,
    terminateDecodeWorkers,
  } = await import('../psf/decode_cr2.mjs');
  const { w, h, rgb16 } = await decodeCR2(frame);
  const { pat } = detectPattern(rgb16, w, h);
  const stats = cfaChannelStats(rgb16, w, h, pat);
  fixHotPixelsCFA(rgb16, w, h, pat, stats);
  const [R, G, B] = demosaicBilinear(rgb16, w, h, pat);
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];

  // scibuf_to_pgm p99.9 linear clip (star cores preserved; simplexy bg-subtracts).
  const sample = [];
  for (let i = 0; i < n; i += 37) sample.push(lum[i]);
  sample.sort((a, b) => a - b);
  let lo = sample[Math.floor(0.02 * (sample.length - 1))];
  let hi = sample[Math.floor(0.999 * (sample.length - 1))];
  if (!(hi > lo)) { lo = 0; hi = 1; }
  const scale = 65535 / (hi - lo);
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    let v = Math.round((lum[i] - lo) * scale);
    if (v < 0) v = 0; else if (v > 65535) v = 65535;
    out.writeUInt16BE(v, i * 2);
  }
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.pgm`, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n65535\n`, 'ascii'), out]));
  try { terminateDecodeWorkers(); } catch { /* best-effort */ }
  console.log(`OK pgm ${w} ${h}`);
}

function extractRafJpeg() {
  const fd = fs.openSync(frame, 'r');
  const hdr = Buffer.alloc(160);
  fs.readSync(fd, hdr, 0, 160, 0);
  if (hdr.slice(0, 15).toString('latin1') !== 'FUJIFILMCCD-RAW') {
    fs.closeSync(fd); throw new Error('not a FUJIFILM RAF (bad magic)');
  }
  const off = hdr.readUInt32BE(84), len = hdr.readUInt32BE(88);
  if (!(off > 0 && len > 1000)) { fs.closeSync(fd); throw new Error(`bad RAF jpeg dir off=${off} len=${len}`); }
  const jpg = Buffer.alloc(len);
  fs.readSync(fd, jpg, 0, len, off);
  fs.closeSync(fd);
  if (!(jpg[0] === 0xff && jpg[1] === 0xd8)) throw new Error('carved bytes are not a JPEG (no SOI)');
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.jpg`, jpg);
  const { W, H } = parseJpegDims(jpg);
  console.log(`OK jpg ${W} ${H}`);
}

try {
  if (/\.raf$/i.test(frame)) { extractRafJpeg(); process.exit(0); }
  await decodeCR2ToPgm();
  process.exit(0);
} catch (e) {
  console.error(`DECODE_ERROR ${e?.message || e}`);
  process.exit(2);
}
