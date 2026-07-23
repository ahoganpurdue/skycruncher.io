// Deterministic golden Bayer fixture generator for the GPU/CPU demosaic parity rail.
//
// Emits three synthetic Uint16 RGGB mosaics (raw single-channel sensor buffers,
// stride == width, no padding) as raw little-endian .bin files plus a manifest
// with md5s. Fully deterministic: a fixed SEED constant drives a mulberry32 PRNG.
// NO Date.now / unseeded Math.random — the same seed reproduces byte-identical
// fixtures on any box.
//
// Rerun:  node tools/gpu_parity/fixtures/gen_fixtures.mjs
//
// Field rationale (units under test = DemosaicEngine.demosaicBilinear (CPU,
// float64-intermediate) vs demosaic_bayer_param.wgsl (GPU, float32-throughout)):
//   - gradient : smooth full-range diagonal ramp; low neighbor contrast, few
//                clamps -> a gentle baseline for ULP drift.
//   - impulse  : near-black background with sparse bright "stars"; most pixels
//                clamp to 0 on BOTH paths (exact agreement) -> low % differ,
//                measures whether high-contrast neighborhoods diverge.
//   - noise    : uniform mid-range [3000,15000] (never clamps) -> every interior
//                pixel runs the full arithmetic chain in different precision;
//                the closest analog to the banked RTX 3060 61.6%@1ULP frame.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Determinism knobs (recorded in the manifest) ───────────────────────────
const SEED = 0x5C0FFEE1;          // fixed 32-bit seed constant
const WIDTH = 256;                // even -> clean RGGB 2x2 tiling
const HEIGHT = 256;
const STRIDE = 256;               // == width, no row padding
const BLACK = 2048;               // matches DEFAULT_DEMOSAIC_PARAMS.blackLevel
const WHITE = 16383;              // 14-bit white (Canon default)

// mulberry32 — tiny, fast, fully deterministic 32-bit PRNG.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));

function genGradient() {
  const raw = new Uint16Array(WIDTH * HEIGHT);
  // Diagonal ramp from ~BLACK to ~WHITE across the frame + a mild per-CFA-phase
  // offset so R/G/B channels carry distinct levels (a flat gray gives trivial
  // demosaic output). Deterministic, no PRNG.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const t = (x + y) / (WIDTH + HEIGHT - 2);       // 0..1 diagonal
      let v = BLACK + t * (WHITE - BLACK);
      // per-phase colour offset (RGGB): R+8%, G nominal, B-6% of span
      const evenR = (y & 1) === 0, evenC = (x & 1) === 0;
      const span = (WHITE - BLACK);
      if (evenR && evenC) v += 0.08 * span;            // R
      else if (!evenR && !evenC) v -= 0.06 * span;     // B
      raw[y * WIDTH + x] = clampU16(v);
    }
  }
  return raw;
}

function genImpulse() {
  const rnd = mulberry32(SEED ^ 0x11111111);
  const raw = new Uint16Array(WIDTH * HEIGHT);
  const bg = BLACK + 120;                              // just above black
  for (let i = 0; i < raw.length; i++) {
    raw[i] = clampU16(bg + (rnd() - 0.5) * 40);        // faint noisy background
  }
  // ~200 bright star impulses with a tiny 3x3 falloff (stays a CFA raw, so we
  // just deposit into the single channel; brightness up to near-white).
  const N_STARS = 200;
  for (let s = 0; s < N_STARS; s++) {
    const cx = 3 + Math.floor(rnd() * (WIDTH - 6));
    const cy = 3 + Math.floor(rnd() * (HEIGHT - 6));
    const peak = BLACK + 4000 + rnd() * (WHITE - BLACK - 4000);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const w = (dx === 0 && dy === 0) ? 1.0 : 0.35;
        const idx = (cy + dy) * WIDTH + (cx + dx);
        raw[idx] = clampU16(Math.max(raw[idx], bg + w * (peak - bg)));
      }
    }
  }
  return raw;
}

function genNoise() {
  const rnd = mulberry32(SEED ^ 0x22222222);
  const raw = new Uint16Array(WIDTH * HEIGHT);
  const LO = 3000, HI = 15000;                          // never clamps at black/white
  for (let i = 0; i < raw.length; i++) {
    raw[i] = clampU16(LO + rnd() * (HI - LO));
  }
  return raw;
}

const FIELDS = [
  { name: 'gradient', gen: genGradient },
  { name: 'impulse', gen: genImpulse },
  { name: 'noise', gen: genNoise },
];

const manifest = {
  generator: 'tools/gpu_parity/fixtures/gen_fixtures.mjs',
  seed: SEED,
  seed_hex: '0x' + (SEED >>> 0).toString(16).toUpperCase(),
  prng: 'mulberry32',
  width: WIDTH, height: HEIGHT, stride: STRIDE,
  cfa: 'RGGB', dtype: 'uint16', endianness: 'little', layout: 'single-channel-mosaic',
  black_level: BLACK, white_level: WHITE,
  generated_utc: new Date().toISOString(),
  fixtures: [],
};

for (const f of FIELDS) {
  const raw = f.gen();
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const file = `${f.name}_${WIDTH}x${HEIGHT}_rggb_u16le.bin`;
  fs.writeFileSync(path.join(HERE, file), buf);
  // quick stats for the manifest (sanity, not a gate)
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < raw.length; i++) { const v = raw[i]; if (v < min) min = v; if (v > max) max = v; sum += v; }
  manifest.fixtures.push({
    name: f.name, file, bytes: buf.length, md5,
    stats: { min, max, mean: +(sum / raw.length).toFixed(2) },
  });
  console.log(`${f.name.padEnd(9)} -> ${file}  md5=${md5}  min=${min} max=${max} mean=${(sum / raw.length).toFixed(1)}`);
}

fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest.json written (${manifest.fixtures.length} fixtures, seed ${manifest.seed_hex}, ${WIDTH}x${HEIGHT})`);
