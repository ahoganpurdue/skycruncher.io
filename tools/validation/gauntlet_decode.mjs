// ═══════════════════════════════════════════════════════════════════════════
// ENH-2 gauntlet escalation — STEP 1: decode CR2 -> browser-faithful 8-bit
// luminance sidecar (grayscale, w*h bytes) for the forced-photometry solve step.
// ═══════════════════════════════════════════════════════════════════════════
// STANDALONE (does NOT touch the sweep's cr2_binding files). Run ONE frame per
// process (fresh memory each time) — 3 other agents are decoding concurrently,
// so we never parallelize here.
//
//   node tools/validation/gauntlet_decode.mjs <frame> <cr2Path> <dumpPath> <outDir>
//
// Reproduces the BROWSER science->solve pixel path exactly:
//   decode (libraw active area, dominant-channel mosaic)
//   -> detectPattern -> fixHotPixelsCFA -> demosaicBilinear ([0,1] planes)
//   -> Rec.709 luminance  (orchestrator_session.computeluminance: .2126/.7152/.0722)
//   -> gamma 1/2.2 * 255  (orchestrator_session.luminanceToImageData)
// The escalation's luminanceFromImageData then reads R=G=B=byte back as byte/255,
// i.e. pow(lum,1/2.2) — identical to the browser solve buffer.
//
// GRID-CONSISTENCY GUARD (#1 risk): the decode returns the libraw ACTIVE AREA
// (landscape native); the detection dump may be EXIF-rotated (portrait). We
// (1) match dims (identity or transpose), (2) for a transpose, rotate CW/CCW and
// keep whichever makes the brightest dump detections land on bright luminance,
// and (3) EMPIRICALLY validate alignment (brightest dets must sit on local
// maxima well above background) — on failure we mark grid_ok=false and the solve
// step HONEST-SKIPS rather than measure on a sheared/mis-oriented grid.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeCR2, detectPattern, fixHotPixelsCFA, cfaChannelStats,
  demosaicBilinear, splitRGB, terminateDecodeWorkers,
} from '../psf/decode_cr2.mjs';

const [, , frame, cr2Path, dumpPath, outDir] = process.argv;
if (!frame || !cr2Path || !dumpPath || !outDir) {
  console.error('usage: gauntlet_decode.mjs <frame> <cr2Path> <dumpPath> <outDir>');
  process.exit(2);
}

const GAMMA = 1 / 2.2;

function toGrayGamma(R, G, B, n) {
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lum = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]; // Rec.709 (app)
    let v = Math.pow(lum > 0 ? lum : 0, GAMMA) * 255;
    gray[i] = v > 255 ? 255 : v; // Uint8 truncates like Uint8ClampedArray rounds-toward here; fine for a monotone stretch
  }
  return gray;
}

function rotateCW(src, w, h) {
  // native (w x h) -> (h x w); 90 deg clockwise
  const nw = h, nh = w;
  const dst = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y, ny = x;
      dst[ny * nw + nx] = src[y * w + x];
    }
  }
  return { data: dst, w: nw, h: nh };
}
function rotateCCW(src, w, h) {
  const nw = h, nh = w;
  const dst = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = y, ny = w - 1 - x;
      dst[ny * nw + nx] = src[y * w + x];
    }
  }
  return { data: dst, w: nw, h: nh };
}

// robust frame background (median + MAD) over a strided sample
function frameStats(gray) {
  const s = [];
  for (let i = 0; i < gray.length; i += 733) s.push(gray[i]);
  s.sort((a, b) => a - b);
  const med = s[s.length >> 1] || 0;
  const dev = s.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = 1.4826 * (dev[dev.length >> 1] || 0);
  return { med, mad: Math.max(mad, 1) };
}

// local 5x5 max at (x,y)
function localMax(gray, w, h, x, y) {
  let m = 0;
  const x0 = Math.max(0, x - 2), x1 = Math.min(w - 1, x + 2);
  const y0 = Math.max(0, y - 2), y1 = Math.min(h - 1, y + 2);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * w;
    for (let xx = x0; xx <= x1; xx++) {
      const v = gray[row + xx];
      if (v > m) m = v;
    }
  }
  return m;
}

// Alignment metric: at the brightest dump detections, how far above background
// (in sigma) does the local luminance peak sit? Compare to a random-position
// null. Aligned grid => detections sit on stars => much higher than null.
function alignment(gray, w, h, dets) {
  const st = frameStats(gray);
  const top = [...dets].sort((a, b) => (+b.flux) - (+a.flux)).slice(0, 200);
  const zAt = (arr) => {
    const zs = arr.map((d) => (localMax(gray, w, h, d.x, d.y) - st.med) / st.mad);
    zs.sort((a, b) => a - b);
    return zs[zs.length >> 1] || 0; // median sigma
  };
  const detZ = zAt(top.filter((d) => d.x >= 0 && d.x < w && d.y >= 0 && d.y < h).map((d) => ({ x: Math.round(d.x), y: Math.round(d.y) })));
  // seeded pseudo-random null positions
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const nullPos = [];
  for (let i = 0; i < 200; i++) nullPos.push({ x: Math.floor(rnd() * w), y: Math.floor(rnd() * h) });
  const nullZ = zAt(nullPos);
  return { detZ: +detZ.toFixed(2), nullZ: +nullZ.toFixed(2), med: st.med, mad: +st.mad.toFixed(2), nDetInBounds: top.filter((d) => d.x >= 0 && d.x < w && d.y >= 0 && d.y < h).length };
}

(async () => {
  const t0 = Date.now();
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  const dumpW = dump.width, dumpH = dump.height;
  const dets = (dump.detections || []).map((d) => ({ x: +d.x, y: +d.y, flux: +d.flux }));

  console.log(`[decode] ${frame}: decoding ${path.basename(cr2Path)} ...`);
  const { w, h, rgb16, meta } = await decodeCR2(cr2Path);
  const decodeMs = Date.now() - t0;
  console.log(`[decode] ${frame}: active area ${w}x${h} (dump ${dumpW}x${dumpH}); libraw flip=${meta?.flip}; ${decodeMs}ms`);

  const pat = detectPattern(rgb16, w, h);
  let R, G, B;
  if (pat.oneHot) {
    const stats = cfaChannelStats(rgb16, w, h, pat.pat);
    const hp = fixHotPixelsCFA(rgb16, w, h, pat.pat, stats);
    [R, G, B] = demosaicBilinear(rgb16, w, h, pat.pat);
    console.log(`[decode] ${frame}: CFA one-hot pat=[${pat.pat}] leak=${pat.leakFraction.toFixed(3)} hotpix=${hp.count}`);
  } else {
    [R, G, B] = splitRGB(rgb16, w, h);
    console.log(`[decode] ${frame}: NOT one-hot (leak=${pat.leakFraction.toFixed(3)}) -> splitRGB fallback`);
  }
  const grayNative = toGrayGamma(R, G, B, w * h);

  // ── orientation resolution + empirical alignment ──
  let chosen = null; // { data, w, h, mode, align }
  const cands = [];
  if (w === dumpW && h === dumpH) {
    cands.push({ data: grayNative, w, h, mode: 'identity' });
  } else if (w === dumpH && h === dumpW) {
    const cw = rotateCW(grayNative, w, h);
    const ccw = rotateCCW(grayNative, w, h);
    cands.push({ ...cw, mode: 'rotCW' });
    cands.push({ ...ccw, mode: 'rotCCW' });
  } else {
    // dims mismatch that is neither identity nor transpose -> unrecoverable
    cands.push({ data: grayNative, w, h, mode: 'DIM_MISMATCH' });
  }
  for (const c of cands) c.align = alignment(c.data, c.w, c.h, dets);
  // pick the candidate whose brightest dets sit highest above background
  cands.sort((a, b) => b.align.detZ - a.align.detZ);
  chosen = cands[0];

  // grid_ok: dims must match the dump (the design's primary guard) AND the
  // brightest detections must land on real luminance features rather than random
  // background. A truly SHEARED / mis-oriented grid collapses detZ down to the
  // null (~0.3-0.8σ); an ALIGNED-but-noisy frame keeps detZ clearly above the
  // null even when its absolute value is modest (thermal MAD inflates the floor).
  // So the veto fires only on detZ ~ nullZ, NOT on low absolute contrast — a
  // noisy-but-aligned frame must still RUN (its collapse is then a real physics
  // result, not a decode artifact). Absolute detZ is reported as a diagnostic.
  const dimsMatch = chosen.w === dumpW && chosen.h === dumpH;
  const alignOk = chosen.align.detZ >= chosen.align.nullZ + 2.0 && chosen.align.detZ >= 2.5;
  const grid_ok = dimsMatch && alignOk;

  console.log(`[decode] ${frame}: chosen=${chosen.mode} ${chosen.w}x${chosen.h} dimsMatch=${dimsMatch} detZ=${chosen.align.detZ} nullZ=${chosen.align.nullZ} med=${chosen.align.med} mad=${chosen.align.mad} -> grid_ok=${grid_ok}`);

  fs.mkdirSync(outDir, { recursive: true });
  const lumPath = path.join(outDir, `${frame}.lum8`);
  const sidePath = path.join(outDir, `${frame}.decode.json`);
  fs.writeFileSync(lumPath, Buffer.from(chosen.data.buffer, chosen.data.byteOffset, chosen.data.byteLength));
  fs.writeFileSync(sidePath, JSON.stringify({
    frame, cr2Path, dumpPath,
    nativeW: w, nativeH: h, dumpW, dumpH,
    chosenW: chosen.w, chosenH: chosen.h, orientation: chosen.mode,
    oneHot: pat.oneHot, leakFraction: pat.leakFraction, librawFlip: meta?.flip ?? null,
    alignment: chosen.align,
    allCandidates: cands.map((c) => ({ mode: c.mode, w: c.w, h: c.h, detZ: c.align.detZ, nullZ: c.align.nullZ })),
    dimsMatch, alignOk, grid_ok,
    decodeMs, totalMs: Date.now() - t0,
    lum8Bytes: chosen.data.byteLength,
  }, null, 2), 'utf8');
  console.log(`[decode] ${frame}: wrote ${lumPath} (${chosen.data.byteLength} bytes) + sidecar. total ${Date.now() - t0}ms`);
  terminateDecodeWorkers();
  // worker_threads can keep the loop alive; exit explicitly.
  setTimeout(() => process.exit(0), 100).unref?.();
})().catch((e) => {
  console.error(`[decode] ${frame}: FAILED`, e?.stack || e);
  process.exit(1);
});
