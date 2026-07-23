#!/usr/bin/env node
// scibuf_to_pgm.mjs — render a native f32 science-luminance buffer to a 16-bit
// PGM (P5, big-endian) for astrometry.net an-pnmtofits → solve-field.
//   node tools/rawlab/scibuf_to_pgm.mjs <scibuf.f32> <W> <H> <out.pgm>
// Linear stretch, p99.9 clip (star cores preserved; simplexy does its own
// background subtraction). Star POSITIONS are decode-independent — this is a
// valid independent-truth input regardless of which decoder rendered the buffer.
import fs from 'node:fs';

const [, , inPath, wStr, hStr, outPath] = process.argv;
const W = +wStr, H = +hStr;
const buf = fs.readFileSync(inPath);
const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const n = W * H;
if (f32.length < n) { console.error(`buffer ${f32.length} < ${W}x${H}=${n}`); process.exit(1); }

// p99.9 clip for the linear high point (avoid a single hot pixel flattening stars).
const sample = [];
for (let i = 0; i < n; i += 37) sample.push(f32[i]);
sample.sort((a, b) => a - b);
let lo = sample[Math.floor(0.02 * (sample.length - 1))];
let hi = sample[Math.floor(0.999 * (sample.length - 1))];
if (!(hi > lo)) { lo = 0; hi = 1; }
const scale = 65535 / (hi - lo);

const out = Buffer.allocUnsafe(n * 2);
for (let i = 0; i < n; i++) {
    let v = Math.round((f32[i] - lo) * scale);
    if (v < 0) v = 0; else if (v > 65535) v = 65535;
    out.writeUInt16BE(v, i * 2); // PGM 16-bit is big-endian
}
const header = Buffer.from(`P5\n${W} ${H}\n65535\n`, 'ascii');
fs.mkdirSync(outPath.replace(/[\/\\][^\/\\]*$/, ''), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([header, out]));
console.log(`wrote ${outPath} (${W}x${H} 16-bit PGM, lo=${lo.toFixed(4)} hi=${hi.toFixed(4)})`);
