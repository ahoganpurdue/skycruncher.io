// bench_color.mjs — MEASURED per-pixel color/stretch hot-path timing.
// Reimplements the EXACT arithmetic of the live color hot paths (no engine
// import, src/ is read-only) so we can time them headlessly in Node:
//   1. ImageProcessor.float32ToImageDataAutoStretch  (STF v2, :125-227)
//   2. ImageProcessor.applySipUndistort              (SIP render warp, :286-345)
//   3. measureApertureRGB × N matched stars          (SPCC, rgb_aperture_photometry.ts)
//
// Preview cap: PIPELINE_CONSTANTS.PREVIEW_MAX_DIM=3840 keyed to sensorW, so the
// stretch runs at up to 3840×2560 (~9.8MP) for wide sensors, full-frame for
// small ones. 26MP native is included ONLY to show the cost the pipeline avoids.
//
//   node tools/color/bench_color.mjs
import { performance } from 'node:perf_hooks';

// ── realistic synthetic RGB buffer: low sky median + sparse bright stars ──────
function makeRGB(w, h, seed = 1) {
  const n = w * h;
  const a = new Float32Array(n * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    // sky ~0.008 + read-noise, slight blue tilt (typical light-pollution)
    const noise = rnd() * 0.004;
    a[i * 3] = 0.007 + noise;
    a[i * 3 + 1] = 0.008 + noise;
    a[i * 3 + 2] = 0.010 + noise;
  }
  // ~1 star per 2000 px, some saturating (exercises the 0.95 / 0.97 branches)
  const nStars = Math.floor(n / 2000);
  for (let k = 0; k < nStars; k++) {
    const px = Math.floor(rnd() * n);
    const peak = rnd() < 0.15 ? 0.99 : 0.2 + rnd() * 0.6;
    a[px * 3] = peak * (0.8 + rnd() * 0.4);
    a[px * 3 + 1] = peak;
    a[px * 3 + 2] = peak * (0.8 + rnd() * 0.4);
  }
  return a;
}

// ── 1. STF v2 auto-stretch — arithmetic copied verbatim from ImageProcessor ──
function stretch(float32, w, h) {
  const n = w * h;
  const chan = [[], [], []];
  let pixStride = Math.max(1, Math.floor(n / 80_000));
  if (pixStride > 1 && w % pixStride === 0) pixStride += 1;
  for (let p = 0; p < n; p += pixStride) {
    const sIdx = p * 3;
    for (let c = 0; c < 3; c++) { const v = float32[sIdx + c]; if (Number.isFinite(v)) chan[c].push(v); }
  }
  const sorted = chan.map(a => [...a].sort((x, y) => x - y));
  const med = sorted.map(s => s[Math.floor(s.length / 2)]);
  const pedestal = Math.min(med[0], med[1], med[2]);
  const hi = sorted.map(s => { let end = s.length - 1; while (end > 0 && s[end] >= 0.95) end--; return s[Math.floor(end * 0.98)]; });
  const span = hi.map((h2, c) => Math.max(1e-6, h2 - med[c]));
  const spanRef = Math.max(span[0], span[1], span[2]);
  const gain = span.map(s => Math.min(8, Math.max(0.25, spanRef / s)));
  const cal = (v, c) => pedestal + (v - med[c]) * gain[c];
  const samples = [];
  for (let i = 0; i < chan[0].length; i++) samples.push(0.2126 * cal(chan[0][i], 0) + 0.7152 * cal(chan[1][i], 1) + 0.0722 * cal(chan[2][i], 2));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const absDev = samples.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const madn = 1.4826 * absDev[Math.floor(absDev.length / 2)];
  const c0 = Math.min(Math.max(median - 2.8 * madn, 0), 1);
  const range = 1 - c0;
  const mnorm = range > 1e-9 ? (median - c0) / range : 0;
  const B = 0.15;
  const M = (mnorm * (B - 1)) / (2 * B * mnorm - B - mnorm);
  const mtf = x => { if (x <= 0) return 0; if (x >= 1) return 1; return ((M - 1) * x) / ((2 * M - 1) * x - M); };
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const sIdx = i * 3, dIdx = i * 4;
    const r = Math.max(0, cal(float32[sIdx] || 0, 0));
    const g = Math.max(0, cal(float32[sIdx + 1] || 0, 1));
    const b = Math.max(0, cal(float32[sIdx + 2] || 0, 2));
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Ls = mtf((L - c0) / range);
    const ratio = L > 1e-9 ? Ls / L : 0;
    const wSat = smoothstep(B * 0.85, B * 2.2, Ls);
    const wHi = smoothstep(0.85, 1.0, Ls);
    let or_ = Ls + wSat * (r * ratio - Ls);
    let og = Ls + wSat * (g * ratio - Ls);
    let ob = Ls + wSat * (b * ratio - Ls);
    or_ += wHi * (Ls - or_); og += wHi * (Ls - og); ob += wHi * (Ls - ob);
    data[dIdx] = or_ * 255; data[dIdx + 1] = og * 255; data[dIdx + 2] = ob * 255; data[dIdx + 3] = 255;
  }
  return data;
}

// ── 2. SIP render warp — arithmetic copied verbatim from applySipUndistort ───
function sipUndistort(float32, w, h, sip, crpixX, crpixY, coordScale = 1) {
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
  for (let yo = 0; yo < h; yo++) {
    for (let xo = 0; xo < w; xo++) {
      const us = (xo - crpixX) / s, vs = (yo - crpixY) / s;
      const srcX = xo + s * poly(sip.a, us, vs), srcY = yo + s * poly(sip.b, us, vs);
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
  }
  return out;
}

// ── 3. measureApertureRGB — copied verbatim from rgb_aperture_photometry.ts ──
function medianOf(values) { if (!values.length) return 0; const s = values.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function measureApertureRGB(rgb, w, h, cx, cy, fwhmPx) {
  const ap = Math.max(3.5, 1.5 * (fwhmPx || 3.0)), inner = ap + 1.5, outer = inner + 3.0;
  const apSq = ap * ap, innerSq = inner * inner, outerSq = outer * outer;
  const startX = Math.max(0, Math.floor(cx - outer)), endX = Math.min(w - 1, Math.ceil(cx + outer));
  const startY = Math.max(0, Math.floor(cy - outer)), endY = Math.min(h - 1, Math.ceil(cy + outer));
  let sumR = 0, sumG = 0, sumB = 0, nAperture = 0; const skyR = [], skyG = [], skyB = [];
  for (let y = startY; y <= endY; y++) { const dy = y - cy;
    for (let x = startX; x <= endX; x++) { const dx = x - cx; const dist2 = dx * dx + dy * dy; if (dist2 > outerSq) continue;
      const idx = (y * w + x) * 3; const r = rgb[idx], g = rgb[idx + 1], b = rgb[idx + 2];
      if (dist2 <= apSq) { sumR += r; sumG += g; sumB += b; nAperture++; }
      else if (dist2 >= innerSq) { skyR.push(r); skyG.push(g); skyB.push(b); } } }
  return { flux_r: sumR - medianOf(skyR) * nAperture, flux_g: sumG - medianOf(skyG) * nAperture, flux_b: sumB - medianOf(skyB) * nAperture, n_aperture: nAperture };
}

// ── timing harness ───────────────────────────────────────────────────────────
function bench(label, fn, iters) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (performance.now() - t0) / iters;
  console.log(`${label.padEnd(46)} ${dt.toFixed(2)} ms/call  (${iters} iters)`);
  return dt;
}

const cfgs = [
  { name: 'SeeStar-ish 1080x1920 (2.07 MP)', w: 1080, h: 1920 },
  { name: 'preview cap 3840x2560 (9.83 MP)', w: 3840, h: 2560 },
  { name: 'CR2 native 5760x3840 (22.1 MP)', w: 5760, h: 3840 },
  { name: '26 MP native 6240x4160', w: 6240, h: 4160 },
];

console.log('=== STF v2 auto-stretch (float32ToImageDataAutoStretch) ===');
for (const c of cfgs) {
  const buf = makeRGB(c.w, c.h);
  const iters = c.w * c.h > 10e6 ? 5 : 20;
  bench(c.name, () => stretch(buf, c.w, c.h), iters);
}

console.log('\n=== SIP render warp (applySipUndistort, deg-3 SIP, CR2 path) ===');
const sip = { a: [[0, 1e-6, 2e-9, 1e-12], [3e-6, 1e-9, 2e-12], [4e-9, 5e-12], [6e-12]],
              b: [[0, 2e-6, 1e-9, 3e-12], [1e-6, 3e-9, 1e-12], [2e-9, 4e-12], [5e-12]] };
for (const c of cfgs.slice(1, 3)) {
  const buf = makeRGB(c.w, c.h);
  const iters = c.w * c.h > 10e6 ? 3 : 10;
  bench(c.name, () => sipUndistort(buf, c.w, c.h, sip, c.w / 2, c.h / 2, 0.667), iters);
}

console.log('\n=== SPCC aperture photometry (measureApertureRGB × 272 stars) ===');
{
  const c = cfgs[1]; const buf = makeRGB(c.w, c.h);
  let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const stars = Array.from({ length: 272 }, () => ({ x: 20 + rnd() * (c.w - 40), y: 20 + rnd() * (c.h - 40), fwhm: 2.5 + rnd() * 2 }));
  bench('272 apertures on 9.83 MP buffer', () => { for (const st of stars) measureApertureRGB(buf, c.w, c.h, st.x, st.y, st.fwhm); }, 30);
}
console.log('\nNote: timing is data-value near-independent (branches are cheap); values chosen realistic.');
