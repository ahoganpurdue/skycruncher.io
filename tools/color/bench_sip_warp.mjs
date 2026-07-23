// bench_sip_warp.mjs — MEASURED before/after for the SIP render-warp perf fix.
//
// The color audit (`git show 0afe8c9`) clocked the render-lane SIP undistort at
// ~2.35 s @ 9.8 MP on the CR2 preview — the worst main-thread stall — because
// `applySipUndistort` called Math.pow(u,p) per row AND Math.pow(v,q) per term,
// PER PIXEL. The 2026-07-10 fix (src/engine/core/ImageProcessor.ts) replaces the
// transcendental Math.pow with per-pixel power TABLES built by repeated
// multiplication. src/ is read-only to tools, so — exactly like bench_color.mjs —
// this reimplements the EXACT warp arithmetic (OLD vs NEW) so both are timed on
// the SAME harness the 2.35 s figure came from (apples-to-apples).
//
//   node tools/color/bench_sip_warp.mjs
import { performance } from 'node:perf_hooks';

function makeRGB(w, h, seed = 1) {
  const n = w * h;
  const a = new Float32Array(n * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const noise = rnd() * 0.004;
    a[i * 3] = 0.007 + noise; a[i * 3 + 1] = 0.008 + noise; a[i * 3 + 2] = 0.010 + noise;
  }
  const nStars = Math.floor(n / 2000);
  for (let k = 0; k < nStars; k++) {
    const px = Math.floor(rnd() * n);
    const peak = rnd() < 0.15 ? 0.99 : 0.2 + rnd() * 0.6;
    a[px * 3] = peak * (0.8 + rnd() * 0.4); a[px * 3 + 1] = peak; a[px * 3 + 2] = peak * (0.8 + rnd() * 0.4);
  }
  return a;
}

// ── OLD: verbatim pre-fix arithmetic (Math.pow per term per pixel) ────────────
function warpOld(float32, w, h, sip, crpixX, crpixY, coordScale = 1) {
  const s = coordScale > 0 ? coordScale : 1;
  const poly = (coeff, u, v) => {
    let acc = 0;
    for (let p = 0; p < coeff.length; p++) {
      const row = coeff[p]; if (!row) continue; const up = Math.pow(u, p);
      for (let q = 0; q < row.length; q++) { const c = row[q]; if (c) acc += c * up * Math.pow(v, q); }
    }
    return acc;
  };
  const out = new Float32Array(w * h * 3);
  for (let yo = 0; yo < h; yo++) for (let xo = 0; xo < w; xo++) {
    const us = (xo - crpixX) / s, vs = (yo - crpixY) / s;
    const srcX = xo + s * poly(sip.a, us, vs), srcY = yo + s * poly(sip.b, us, vs);
    sample(float32, out, w, h, xo, yo, srcX, srcY);
  }
  return out;
}

// ── NEW: verbatim post-fix arithmetic (per-pixel power tables) ────────────────
function warpNew(float32, w, h, sip, crpixX, crpixY, coordScale = 1) {
  const s = coordScale > 0 ? coordScale : 1;
  const degU = Math.max(sip.a.length, sip.b.length);
  let degV = 0;
  for (const row of sip.a) if (row && row.length > degV) degV = row.length;
  for (const row of sip.b) if (row && row.length > degV) degV = row.length;
  const upow = new Float64Array(Math.max(1, degU)), vpow = new Float64Array(Math.max(1, degV));
  const poly = (coeff) => {
    let acc = 0;
    for (let p = 0; p < coeff.length; p++) {
      const row = coeff[p]; if (!row) continue; const up = upow[p];
      for (let q = 0; q < row.length; q++) { const c = row[q]; if (c) acc += c * up * vpow[q]; }
    }
    return acc;
  };
  const out = new Float32Array(w * h * 3);
  for (let yo = 0; yo < h; yo++) for (let xo = 0; xo < w; xo++) {
    const us = (xo - crpixX) / s, vs = (yo - crpixY) / s;
    upow[0] = 1; for (let p = 1; p < upow.length; p++) upow[p] = upow[p - 1] * us;
    vpow[0] = 1; for (let q = 1; q < vpow.length; q++) vpow[q] = vpow[q - 1] * vs;
    const srcX = xo + s * poly(sip.a), srcY = yo + s * poly(sip.b);
    sample(float32, out, w, h, xo, yo, srcX, srcY);
  }
  return out;
}

// shared bilinear sampler (identical to ImageProcessor.applySipUndistort tail)
function sample(float32, out, w, h, xo, yo, srcX, srcY) {
  const dIdx = (yo * w + xo) * 3;
  const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
  const fx = srcX - x0, fy = srcY - y0;
  const cx0 = Math.min(Math.max(x0, 0), w - 1), cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
  const cy0 = Math.min(Math.max(y0, 0), h - 1), cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
  for (let c = 0; c < 3; c++) {
    const p00 = float32[(cy0 * w + cx0) * 3 + c] || 0, p10 = float32[(cy0 * w + cx1) * 3 + c] || 0;
    const p01 = float32[(cy1 * w + cx0) * 3 + c] || 0, p11 = float32[(cy1 * w + cx1) * 3 + c] || 0;
    const top = p00 + (p10 - p00) * fx, bot = p01 + (p11 - p01) * fx;
    out[dIdx + c] = top + (bot - top) * fy;
  }
}

function bench(label, fn, iters) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (performance.now() - t0) / iters;
  console.log(`${label.padEnd(40)} ${dt.toFixed(1)} ms/call  (${iters} iters)`);
  return dt;
}

// deg-3 SIP, CR2 path — identical to bench_color.mjs so numbers are comparable.
const sip = { a: [[0, 1e-6, 2e-9, 1e-12], [3e-6, 1e-9, 2e-12], [4e-9, 5e-12], [6e-12]],
              b: [[0, 2e-6, 1e-9, 3e-12], [1e-6, 3e-9, 1e-12], [2e-9, 4e-12], [5e-12]] };

const cfgs = [
  { name: 'preview cap 3840x2560 (9.83 MP)', w: 3840, h: 2560 },
  { name: 'CR2 native 5760x3840 (22.1 MP)', w: 5760, h: 3840 },
];

console.log('=== SIP render warp: OLD (Math.pow/term) vs NEW (power tables) ===');
let maxAbs = 0, maxRel = 0;
for (const c of cfgs) {
  const buf = makeRGB(c.w, c.h);
  const iters = c.w * c.h > 10e6 ? 3 : 5;
  const tOld = bench(`OLD  ${c.name}`, () => warpOld(buf, c.w, c.h, sip, c.w / 2, c.h / 2, 0.667), iters);
  const tNew = bench(`NEW  ${c.name}`, () => warpNew(buf, c.w, c.h, sip, c.w / 2, c.h / 2, 0.667), iters);
  console.log(`     speedup ${(tOld / tNew).toFixed(2)}x  (saved ${(tOld - tNew).toFixed(0)} ms)\n`);
  // equivalence spot-check on this size
  const oOld = warpOld(buf, c.w, c.h, sip, c.w / 2, c.h / 2, 0.667);
  const oNew = warpNew(buf, c.w, c.h, sip, c.w / 2, c.h / 2, 0.667);
  for (let i = 0; i < oOld.length; i += 997) {
    const a = oOld[i], b = oNew[i], d = Math.abs(a - b);
    if (d > maxAbs) maxAbs = d;
    const r = d / Math.max(1e-9, Math.abs(a)); if (r > maxRel) maxRel = r;
  }
}
console.log(`equivalence (sampled outputs, all sizes): max|Δ|=${maxAbs.toExponential(3)}  maxRel=${maxRel.toExponential(3)}`);
