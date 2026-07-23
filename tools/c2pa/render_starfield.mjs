#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/render_starfield.mjs — a real instrument render DERIVED from a receipt
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/render_starfield.mjs <receipt.json> [--out <png>] [--scale 0.25]
//
// Plots the receipt's own MEASURED & MATCHED star field (solution.matched_stars:
// native-grid x/y, flux, peak_rgb) onto a PNG. This is a genuine visualization of
// measured data — the honest "PNG derived from the M66 receipt" the sign→verify
// demo needs, corresponding to the receipt it will be signed against (not a
// mismatched screenshot from a different capture).
//
// PIXEL ledger note: this is a display-space render (one scale-down of measured
// COORDINATE positions into a raster). It performs NO measurement and feeds
// nothing back into WCS — pure output visualization.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

function parseArgs(argv) {
  const a = { out: null, scale: 0.25, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--scale') a.scale = parseFloat(argv[++i]);
    else a._.push(t);
  }
  return a;
}

function plotDisk(png, cx, cy, radius, rgb) {
  const { width, height, data } = png;
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const falloff = 1 - Math.sqrt(dx * dx + dy * dy) / (radius + 0.5);
      const idx = (width * y + x) << 2;
      // additive blend so overlapping cores brighten (approximates a stacked field)
      data[idx] = Math.min(255, data[idx] + Math.round(rgb[0] * 255 * falloff));
      data[idx + 1] = Math.min(255, data[idx + 1] + Math.round(rgb[1] * 255 * falloff));
      data[idx + 2] = Math.min(255, data[idx + 2] + Math.round(rgb[2] * 255 * falloff));
      data[idx + 3] = 255;
    }
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const receiptPath = path.resolve(a._[0] || '');
  if (!fs.existsSync(receiptPath)) { process.stderr.write('[c2pa] receipt not found\n'); process.exit(1); }
  const r = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const stars = r?.solution?.matched_stars;
  if (!Array.isArray(stars) || stars.length === 0) {
    process.stderr.write('[c2pa] receipt has no solution.matched_stars to render\n'); process.exit(2);
  }
  const nativeW = r?.metadata?.width || 2160;
  const nativeH = r?.metadata?.height || 3840;
  const W = Math.max(64, Math.round(nativeW * a.scale));
  const H = Math.max(64, Math.round(nativeH * a.scale));
  const png = new PNG({ width: W, height: H });
  // faint dark-blue astronomical background
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 4; png.data[i + 1] = 6; png.data[i + 2] = 14; png.data[i + 3] = 255;
  }
  const mags = stars.map((s) => (typeof s.mag === 'number' ? s.mag : 12));
  const mMin = Math.min(...mags), mMax = Math.max(...mags);
  for (const s of stars) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
    const cx = (s.x / nativeW) * W;
    const cy = (s.y / nativeH) * H;
    // brighter (lower mag) ⇒ bigger disk
    const t = mMax > mMin ? (mMax - (s.mag ?? 12)) / (mMax - mMin) : 0.5;
    const radius = Math.max(1, Math.round(1 + t * 3));
    const rgb = Array.isArray(s.peak_rgb) && s.peak_rgb.length === 3 ? s.peak_rgb : [1, 1, 1];
    plotDisk(png, cx, cy, radius, rgb);
  }
  const outPath = a.out
    ? path.resolve(a.out)
    : path.resolve('test_results', 'c2pa', path.basename(receiptPath).replace(/\.receipt\.json$/i, '') + '.starfield.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.sync.write(png));
  process.stderr.write(`[c2pa] rendered ${stars.length} matched stars → ${outPath} (${W}x${H})\n`);
  process.stdout.write(JSON.stringify({ png: outPath, stars: stars.length, width: W, height: H }) + '\n');
}

main();
