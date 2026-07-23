// ═══════════════════════════════════════════════════════════════════════════
// BEACH RENDER — owner eyes-on deliverable (tools/render lane, additive)
// ═══════════════════════════════════════════════════════════════════════════
// Two COLOR PNGs of the bundled beach photo (public/demo/sample_observation.cr2,
// Canon EOS Rebel T6, Milky Way core over terrain):
//
//   1) beach_original.png   — AS-SHOT look. decodeEngine rgb16 (rawler arm,
//      already demosaiced, raw-ADU pedestal-included) → per-channel black-
//      subtract (blacklevel_bayer) → normalize by (whitelevel-black) → apply the
//      CAMERA as-shot WB multipliers from meta.wb_coeffs (the decode contract
//      EXPOSES them — [R,G,B]=[1.7178,1,2.0078], G-referenced; NOT invented) →
//      clamp → standard sRGB OETF → 8-bit. NO stretch, NO color matrix.
//
//   2) beach_render_stf.png — the app's RENDER-LAYER output. Feeds the exact
//      pipeline input (rgb16/65535 Float32, matching decodeRawlerForPipeline)
//      into the SHIPPED engine function ImageProcessor.float32ToImageDataAuto-
//      Stretch (STF v2 per-channel auto-stretch) via the read-only esbuild
//      bundle. REAL engine code path, no reimplementation. No per-body color
//      matrix supplied (that is an upstream pipeline product requiring body
//      resolution); the STF's own two-part color calibration + star-ensemble
//      highlight WB does the balancing.
//
// Full-res + ~1600px downscale of each → D:/AstroLogic/test_artifacts/
// beach_render_2026-07-22/. LAW 2 gates untouched (render-plane only).
// usage: node tools/render/beach_render.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { decodeEngine, terminateEngineDecodeWorkers } from '../psf/decode_engine.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const esbuild = require('esbuild');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FILE = path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT_ART = 'D:/AstroLogic/test_artifacts/beach_render_2026-07-22';
const OUT_LOCAL = path.join(ROOT, 'test_results', 'beach_render_2026-07-22');
fs.mkdirSync(OUT_ART, { recursive: true });
fs.mkdirSync(OUT_LOCAL, { recursive: true });

// ── esbuild the read-only ImageProcessor engine surface into a node-ESM bundle ─
async function buildEngineBundle() {
  const outfile = path.join(OUT_ART, '_engine_bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(HERE, '_starlet_engine_entry.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20',
    logLevel: 'warning',
  });
  return pathToFileURL(outfile).href;
}

// standard sRGB opto-electronic transfer (linear [0,1] → gamma-encoded [0,1])
function srgbOetf(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

// box-average downsample an RGBA Uint8 buffer to <= targetLong on the long side
function downsampleRgba(data, w, h, targetLong = 1600) {
  const ds = Math.max(1, Math.round(Math.max(w, h) / targetLong));
  if (ds === 1) return { data, w, h, ds };
  const ow = Math.floor(w / ds), oh = Math.floor(h / ds);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = 0; dy < ds; dy++) {
        const sy = y * ds + dy; if (sy >= h) break;
        for (let dx = 0; dx < ds; dx++) {
          const sx = x * ds + dx; if (sx >= w) break;
          const si = (sy * w + sx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; c++;
        }
      }
      const di = (y * ow + x) * 4;
      out[di] = r / c; out[di + 1] = g / c; out[di + 2] = b / c; out[di + 3] = 255;
    }
  }
  return { data: out, w: ow, h: oh, ds };
}

function writeRgbaPng(data, w, h, filePath) {
  const png = new PNG({ width: w, height: h });
  png.data.set(data);
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return filePath;
}

async function main() {
  const T0 = Date.now();

  // ── engine bundle (ImageProcessor, read-only) ──
  const tB = Date.now();
  const bundleUrl = await buildEngineBundle();
  const { ImageProcessor } = await import(bundleUrl);
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  }
  console.log(`[beach] engine bundle ready in ${((Date.now() - tB) / 1000).toFixed(1)}s`);

  // ── decode (engine rawler arm) ──
  const tD = Date.now();
  const dec = await decodeEngine(FILE);
  const { w, h, rgb16, meta } = dec;
  const n = w * h;
  const decodeS = (Date.now() - tD) / 1000;
  console.log(`[beach] decoded ${w}x${h} (${(n / 1e6).toFixed(1)}MP) arm=${dec.arm} in ${decodeS.toFixed(1)}s | model=${meta?.clean_model ?? meta?.model}`);

  // camera contract values (MEASURED — nothing invented)
  const bl = meta.blacklevel_bayer;                // RGGB → [R,G,G,B]
  const black = [bl[0], (bl[1] + bl[2]) / 2, bl[3]];
  const white = Array.isArray(meta.whitelevel) ? meta.whitelevel[0] : meta.whitelevel;
  const wbRaw = meta.wb_coeffs;                     // [R,G,B,(G2|null)]
  const gRef = wbRaw[1] || 1;
  const wb = [wbRaw[0] / gRef, wbRaw[1] / gRef, wbRaw[2] / gRef];
  const wbApplied = Number.isFinite(wb[0]) && Number.isFinite(wb[2]);
  console.log(`[beach] black=[${black.join(',')}] white=${white} wb=${wb.map(v => v.toFixed(4)).join('/')} applied=${wbApplied}`);

  // ── 1) AS-SHOT ORIGINAL: black-sub, white-norm, camera WB, sRGB OETF ──
  const tO = Date.now();
  const orig = new Uint8ClampedArray(n * 4);
  const denom = [Math.max(1, white - black[0]), Math.max(1, white - black[1]), Math.max(1, white - black[2])];
  for (let i = 0; i < n; i++) {
    const s = i * 3, d = i * 4;
    for (let c = 0; c < 3; c++) {
      let lin = (rgb16[s + c] - black[c]) / denom[c];
      lin = lin < 0 ? 0 : lin;
      if (wbApplied) lin *= wb[c];
      lin = lin > 1 ? 1 : lin;
      orig[d + c] = srgbOetf(lin) * 255;
    }
    orig[d + 3] = 255;
  }
  const origS = (Date.now() - tO) / 1000;
  const pOrig = writeRgbaPng(orig, w, h, path.join(OUT_ART, 'beach_original.png'));
  const dsO = downsampleRgba(orig, w, h);
  const pOrig16 = writeRgbaPng(dsO.data, dsO.w, dsO.h, path.join(OUT_ART, 'beach_original_1600.png'));
  console.log(`[beach] ORIGINAL rendered in ${origS.toFixed(2)}s → ${pOrig} (+${dsO.w}x${dsO.h} downscale, ds=${dsO.ds})`);

  // ── 2) STF v2 RENDER via the REAL engine function ──
  // pipeline input domain = rgb16/65535 Float32 (decodeRawlerForPipeline).
  const tS = Date.now();
  const f32 = new Float32Array(n * 3);
  const inv = 1 / 65535;
  for (let i = 0; i < f32.length; i++) f32[i] = rgb16[i] * inv;
  const img = ImageProcessor.float32ToImageDataAutoStretch(f32, w, h);
  const stfS = (Date.now() - tS) / 1000;
  const stf = new Uint8ClampedArray(img.data.length);
  stf.set(img.data);
  const pStf = writeRgbaPng(stf, w, h, path.join(OUT_ART, 'beach_render_stf.png'));
  const dsS = downsampleRgba(stf, w, h);
  const pStf16 = writeRgbaPng(dsS.data, dsS.w, dsS.h, path.join(OUT_ART, 'beach_render_stf_1600.png'));
  console.log(`[beach] STF v2 rendered in ${stfS.toFixed(2)}s → ${pStf} (+${dsS.w}x${dsS.h} downscale, ds=${dsS.ds})`);

  const sidecar = {
    generated: new Date().toISOString(),
    file: FILE, model: meta?.clean_model ?? meta?.model, arm: dec.arm,
    dims: { w, h, mp: +(n / 1e6).toFixed(2) },
    camera_contract: { blacklevel_bayer: bl, black_per_channel: black, whitelevel: white, wb_coeffs: wbRaw, wb_normalized: wb, wb_applied: wbApplied },
    original: { method: 'black-sub + white-norm + camera-wb + sRGB-OETF (no stretch, no matrix)', full: pOrig, downscale: pOrig16 },
    stf: { method: 'ImageProcessor.float32ToImageDataAutoStretch on rgb16/65535 (real engine path, no colorTransform)', full: pStf, downscale: pStf16 },
    timings_s: { engine_bundle: +((tD - tB) / 1000).toFixed(2), decode: +decodeS.toFixed(2), original: +origS.toFixed(2), stf: +stfS.toFixed(2), total: +((Date.now() - T0) / 1000).toFixed(2) },
  };
  fs.writeFileSync(path.join(OUT_LOCAL, 'SUMMARY.json'), JSON.stringify(sidecar, null, 2));
  console.log(`[beach] sidecar → ${path.join(OUT_LOCAL, 'SUMMARY.json')}`);
  console.log(`[beach] TOTAL ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  terminateEngineDecodeWorkers();
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => { console.error('[beach] FATAL:', err); process.exit(1); });
