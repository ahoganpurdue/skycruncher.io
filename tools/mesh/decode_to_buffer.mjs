// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — decode a RAW frame ONCE → f32 luminance buffer (for the mesh
//             cascade) + 16-bit PGM (astrometry.net oracle solve input).
// ═══════════════════════════════════════════════════════════════════════════
// ENGINE-ROUTE decode (row-518 follow-up, 2026-07-22): uses the SHARED engine
// decode `tools/psf/decode_engine.mjs` `decodeEngine()` — the same decode the
// live wizard + headless driver run (rawler wasm for CR2/Bayer, libraw
// Markesteijn for Fuji X-Trans/RAF). CONTRACT DELTA vs the prior decodeCR2 path:
// decodeEngine returns rgb16 ALREADY DEMOSAICED (interleaved RGB16, w*h*3), so
// the manual CFA chain (detectPattern → cfaChannelStats → fixHotPixelsCFA →
// demosaicBilinear) is DROPPED — Rec.709 luminance is computed straight off the
// interleave. This unblocks X-Trans RAF frames (the 2×2 Bayer assumption in the
// old path checkerboarded them) for the mesh graduation / gate-③ campaign.
//
// VALUE-DOMAIN NOTE (honest): the rawler arm emits raw-ADU pedestal-included u16
// (NOT black-subtracted); the libraw RAF arm emits libraw's demosaiced 16-bit.
// Absolute luminance levels therefore differ from the old libraw-document-mode
// black-subtracted mosaic. The mesh forced-photometry (relative flux at
// positions) and the PGM percentile stretch are both robust to that offset.
//
//   node tools/mesh/decode_to_buffer.mjs <raw-path> <out-base>
//     writes <out-base>.f32  (float32-le, w*h, single channel — mesh buffer)
//           <out-base>.pgm  (P5 16-bit BE — solve-field input)
//           <out-base>.dims.json { width, height }
//     prints "OK <W> <H> arm=<rawler|libraw-fulldemosaic>"
import fs from 'node:fs';
import path from 'node:path';

const [, , frame, outBase] = process.argv;
if (!frame || !outBase) { console.error('usage: decode_to_buffer.mjs <raw> <out-base>'); process.exit(1); }

async function main() {
  const { decodeEngine, terminateEngineDecodeWorkers } = await import('../psf/decode_engine.mjs');
  // ENGINE route: rgb16 is ALREADY demosaiced (interleaved RGB16, w*h*3).
  const { w, h, rgb16, arm } = await decodeEngine(frame);
  const n = w * h;
  if (rgb16.length !== n * 3) throw new Error(`engine payload ${rgb16.length} != ${w}x${h}x3 (${n * 3})`);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * 3;
    lum[i] = 0.2126 * rgb16[b] + 0.7152 * rgb16[b + 1] + 0.0722 * rgb16[b + 2];
  }

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  // f32 buffer (native luminance; mesh forced-photometry consumes this)
  fs.writeFileSync(`${outBase}.f32`, Buffer.from(lum.buffer, lum.byteOffset, n * 4));

  // 16-bit PGM (p99.9 linear clip; star cores preserved, simplexy bg-subtracts)
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
  fs.writeFileSync(`${outBase}.pgm`, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n65535\n`, 'ascii'), out]));
  fs.writeFileSync(`${outBase}.dims.json`, JSON.stringify({ width: w, height: h, decode_arm: arm }));
  try { terminateEngineDecodeWorkers(); } catch { /* best-effort */ }
  console.log(`OK ${w} ${h} arm=${arm}`);
  setTimeout(() => process.exit(0), 100);
}
main().catch((e) => { console.error(`DECODE_ERROR ${e?.stack || e}`); process.exit(2); });
