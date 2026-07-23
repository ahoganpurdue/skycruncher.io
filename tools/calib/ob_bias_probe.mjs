#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/ob_bias_probe.mjs — OB-pixel synthetic-bias RECON (owner rows 540-541)
// ═══════════════════════════════════════════════════════════════════════════
// Phase-1 evidence packet for the CELL① black-level ruling. Drives the SHIPPED
// wasm_decode contract (decode_util.loadDecoder → decode_raw → ob_pixels/rect),
// NEVER edits src. Measurement only: no wiring, no default flip.
//
// Per frame it measures:
//  • OB geometry (rects) + per-area & per-CFA-phase OB stats (raw ADU)
//  • three black-level estimates: (a) metadata blacklevel_bayer routed per output
//    channel (exactly CELL①'s perChannelBlackFromTile) (b) OB-measured per-channel
//    median/mean (c) [batch] cross-frame drift of (b)
//  • delta (a)-(b) in ADU and as % of a background/signal reference
//  • SEM of the OB estimate (how noisy the per-frame anchor itself is)
//  • OB row/column structure (banding) → scalar-vs-vector verdict
//  • histogram PNG per frame (eyes-on)
//
// Ledger: PIXEL (decode + ADU arithmetic; no coordinate math).
//   node tools/calib/ob_bias_probe.mjs --file <raw> [--out <dir>] [--label L]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDecoder } from './decode_util.mjs';
import { makeCanvas, fillRect, drawText, encodePng } from '../validation/visual/bubble_tiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const FILE = arg('--file');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'test_results', 'ob_bias_2026-07-22')));
const LABEL = arg('--label', FILE ? path.basename(FILE) : 'frame');

// ── robust stats ─────────────────────────────────────────────────────────────
function stats(arr) {
  const n = arr.length;
  if (!n) return { n: 0, mean: 0, std: 0, min: 0, max: 0, median: 0, mad: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) { const v = arr[i]; if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  let va = 0; for (let i = 0; i < n; i++) { const d = arr[i] - mean; va += d * d; }
  const std = Math.sqrt(va / n);
  const s = Float64Array.from(arr).sort();
  const median = s.length & 1 ? s[s.length >> 1] : 0.5 * (s[(s.length >> 1) - 1] + s[s.length >> 1]);
  const dev = new Float64Array(n); for (let i = 0; i < n; i++) dev[i] = Math.abs(arr[i] - median);
  dev.sort(); const mad = 1.4826 * dev[dev.length >> 1];
  return { n, mean: +mean.toFixed(3), std: +std.toFixed(3), min, max, median: +median.toFixed(3), mad: +mad.toFixed(3) };
}
function subsampleMedian(buf, stride, pred) {
  const o = []; for (let i = 0; i < buf.length; i += stride) { if (!pred || pred(i)) o.push(buf[i]); }
  if (!o.length) return null; const s = Float64Array.from(o).sort();
  return { median: s[s.length >> 1], p10: s[Math.floor(s.length * 0.10)], n: o.length };
}
// CELL①'s routing: target 0=R (tile==0), 1=G (tile==1), 2=B (tile!=0&&!=1)
function routePerChannel(tile, vals) {
  const ch = (t) => { let s = 0, c = 0; for (let i = 0; i < 4; i++) { const cc = tile[i]; const r = t === 0 ? cc === 0 : t === 1 ? cc === 1 : (cc !== 0 && cc !== 1); if (r && Number.isFinite(vals[i])) { s += vals[i]; c++; } } return c ? s / c : null; };
  return [ch(0), ch(1), ch(2)];
}

async function decodeFull(filePath) {
  const mod = await loadDecoder();
  const bytes = fs.readFileSync(filePath);
  const t0 = Date.now();
  const dec = mod.decode_raw(new Uint8Array(bytes));
  const meta = JSON.parse(dec.meta_json());
  const W = meta.width, H = meta.height;
  const src = dec.cfa_full();
  const cfa = new Uint16Array(src.length); cfa.set(src);
  const obRaw = [];
  for (let i = 0; i < dec.ob_area_count(); i++) {
    const rect = meta.black_areas[i];
    const p = dec.ob_pixels(i);
    const px = new Uint16Array(p.length); px.set(p);
    obRaw.push({ rect, px });
  }
  dec.free();
  return { meta, W, H, cfa, obRaw, decodeMs: Date.now() - t0, fileBytes: bytes.byteLength };
}

function analyzeObArea({ rect, px }, W, H) {
  const { x, y, w, h } = rect;
  const effW = Math.min(x + w, W) - x;
  const effH = Math.min(y + h, H) - y;
  // per-phase collections
  const phase = [[], [], [], []];
  for (let r = 0; r < effH; r++) {
    const ay = y + r;
    for (let cc = 0; cc < effW; cc++) {
      const ax = x + cc;
      const p = ((ay & 1) << 1) | (ax & 1);
      phase[p].push(px[r * effW + cc]);
    }
  }
  const perPhase = phase.map((a) => stats(a));
  // banding: per-row & per-col mean of the highest-coverage phase, isolating one CFA channel
  const bestPhase = perPhase.map((s, i) => [s.n, i]).sort((a, b) => b[0] - a[0])[0][1];
  const pr = (bestPhase >> 1) & 1, pc = bestPhase & 1;
  const rowMeans = [], colSums = new Float64Array(effW), colCnts = new Int32Array(effW);
  for (let r = 0; r < effH; r++) {
    if (((y + r) & 1) !== pr) continue;
    let s = 0, c = 0;
    for (let cc = 0; cc < effW; cc++) { if (((x + cc) & 1) !== pc) continue; s += px[r * effW + cc]; c++; colSums[cc] += px[r * effW + cc]; colCnts[cc]++; }
    if (c) rowMeans.push(s / c);
  }
  const colMeans = []; for (let cc = 0; cc < effW; cc++) if (colCnts[cc]) colMeans.push(colSums[cc] / colCnts[cc]);
  const phN = perPhase[bestPhase].n, phStd = perPhase[bestPhase].std;
  const rowStat = stats(rowMeans), colStat = stats(colMeans);
  // noise floor per row/col = phase std / sqrt(pixels-per-row-or-col of that phase)
  const perRowPix = phN / Math.max(1, rowMeans.length);
  const perColPix = phN / Math.max(1, colMeans.length);
  const rowNoiseFloor = phStd / Math.sqrt(Math.max(1, perRowPix));
  const colNoiseFloor = phStd / Math.sqrt(Math.max(1, perColPix));
  return {
    rect, effW, effH, nPix: effW * effH,
    perPhase,
    banding: {
      isolated_phase: bestPhase,
      row: { count: rowMeans.length, structural_std: rowStat.std, noise_floor: +rowNoiseFloor.toFixed(3), snr: +(rowStat.std / rowNoiseFloor).toFixed(2), range: rowMeans.length ? +(rowStat.max - rowStat.min).toFixed(2) : 0 },
      col: { count: colMeans.length, structural_std: colStat.std, noise_floor: +colNoiseFloor.toFixed(3), snr: +(colStat.std / colNoiseFloor).toFixed(2), range: colMeans.length ? +(colStat.max - colStat.min).toFixed(2) : 0 },
    },
    _rowMeans: rowMeans, _colMeans: colMeans,
  };
}

// aggregate OB pixels across ALL areas, per phase, → per-channel median/mean/SEM
function aggregateChannels(obRaw, W, H, tile) {
  const phase = [[], [], [], []];
  for (const { rect, px } of obRaw) {
    const { x, y, w, h } = rect;
    const effW = Math.min(x + w, W) - x, effH = Math.min(y + h, H) - y;
    for (let r = 0; r < effH; r++) { const ay = y + r; for (let cc = 0; cc < effW; cc++) { const ax = x + cc; const p = ((ay & 1) << 1) | (ax & 1); phase[p].push(px[r * effW + cc]); } }
  }
  const phStat = phase.map((a) => stats(a));
  // route phase→channel using CELL① rule but on measured medians/means
  const medByPhase = phStat.map((s) => s.median);
  const meanByPhase = phStat.map((s) => s.mean);
  const chMed = routePerChannel(tile, medByPhase);
  const chMean = routePerChannel(tile, meanByPhase);
  // SEM per channel: pool phases routing to channel; SEM_median ≈ 1.2533*std/sqrt(n)
  const chSem = [0, 1, 2].map((t) => {
    const vs = []; for (let i = 0; i < 4; i++) { const cc = tile[i]; const r = t === 0 ? cc === 0 : t === 1 ? cc === 1 : (cc !== 0 && cc !== 1); if (r) { const ph = phase[i]; for (let k = 0; k < ph.length; k++) vs.push(ph[k]); } }
    const s = stats(vs); return { std: s.std, n: s.n, sem_mean: +(s.std / Math.sqrt(Math.max(1, s.n))).toFixed(4), sem_median: +(1.2533 * s.std / Math.sqrt(Math.max(1, s.n))).toFixed(4) };
  });
  return { phStat, chMed, chMean, chSem };
}

function drawHistogram(canvas, ox, oy, w, h, values, color, title, blkMeta, blkOb) {
  const s = stats(values);
  const lo = Math.max(0, s.median - 6 * (s.mad || s.std || 4));
  const hi = s.median + 6 * (s.mad || s.std || 4);
  const NB = 80; const bins = new Int32Array(NB); const span = (hi - lo) || 1;
  for (let i = 0; i < values.length; i++) { let b = Math.floor((values[i] - lo) / span * NB); if (b < 0) b = 0; if (b >= NB) b = NB - 1; bins[b]++; }
  let maxb = 1; for (const b of bins) if (b > maxb) maxb = b;
  fillRect(canvas, ox, oy, w, h, 22, 24, 30);
  const bw = w / NB;
  for (let i = 0; i < NB; i++) { const bh = Math.round((bins[i] / maxb) * (h - 22)); fillRect(canvas, Math.round(ox + i * bw), oy + (h - bh), Math.ceil(bw), bh, color[0], color[1], color[2]); }
  // markers: metadata black (yellow) and OB median (cyan)
  const xOf = (v) => Math.round(ox + (v - lo) / span * w);
  if (Number.isFinite(blkMeta) && blkMeta >= lo && blkMeta <= hi) fillRect(canvas, xOf(blkMeta), oy, 2, h, 250, 214, 90);
  if (Number.isFinite(blkOb) && blkOb >= lo && blkOb <= hi) fillRect(canvas, xOf(blkOb), oy, 2, h, 90, 220, 230);
  drawText(canvas, title, ox + 4, oy + 3, 1, [230, 230, 235]);
  drawText(canvas, `med ${s.median} mad ${s.mad}`, ox + 4, oy + 12, 1, [180, 185, 195]);
  drawText(canvas, `${lo | 0}`, ox, oy + h + 2, 1, [150, 150, 160]);
  drawText(canvas, `${hi | 0}`, ox + w - 30, oy + h + 2, 1, [150, 150, 160]);
}

async function main() {
  if (!FILE || !fs.existsSync(FILE)) { console.error(`[ob] FILE ABSENT: ${FILE}`); process.exit(3); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });
  console.log(`[ob] decoding ${LABEL} ...`);
  const { meta, W, H, cfa, obRaw, decodeMs, fileBytes } = await decodeFull(FILE);
  const tile = meta.cfa_tile;
  console.log(`[ob] ${meta.clean_make || meta.make} ${meta.clean_model || meta.model} ${W}x${H} pattern=${meta.cfa_pattern_full} tile=[${tile}] OBareas=${obRaw.length} decode=${decodeMs}ms`);

  // metadata black routed per channel (exactly CELL①)
  const blkBayer = meta.blacklevel_bayer;
  const metaCh = routePerChannel(tile, blkBayer);

  // OB analysis
  const areas = obRaw.map((a) => analyzeObArea(a, W, H));
  const agg = obRaw.length ? aggregateChannels(obRaw, W, H, tile) : null;

  // active-area signal reference per channel (subsample the full cfa within active area)
  const aa = meta.active_area;
  let sigRef = null;
  if (aa) {
    const chVals = [[], [], []];
    const step = 7; // stride rows/cols for speed
    for (let y = aa.y; y < aa.y + aa.h; y += step) {
      for (let x = aa.x; x < aa.x + aa.w; x += step) {
        const p = ((y & 1) << 1) | (x & 1); const cc = tile[p];
        const t = cc === 0 ? 0 : cc === 1 ? 1 : 2;
        chVals[t].push(cfa[y * W + x]);
      }
    }
    sigRef = chVals.map((a) => { const s = Float64Array.from(a).sort(); return { median: s[s.length >> 1], p10: s[Math.floor(s.length * 0.10)], p50: s[s.length >> 1], n: s.length }; });
  }

  // deltas: metadata black - OB median, per channel, in ADU and % of signal-above-black
  const chNames = ['R', 'G', 'B'];
  const deltas = agg ? [0, 1, 2].map((t) => {
    const dm = metaCh[t], ob = agg.chMed[t];
    const delta = (Number.isFinite(dm) && Number.isFinite(ob)) ? dm - ob : null;
    const sigAboveBlack = sigRef ? (sigRef[t].median - (ob ?? dm ?? 0)) : null;
    const bgAboveBlack = sigRef ? (sigRef[t].p10 - (ob ?? dm ?? 0)) : null;
    return {
      channel: chNames[t], meta_black: dm != null ? +dm.toFixed(2) : null, ob_median: ob != null ? +ob.toFixed(2) : null,
      ob_mean: agg.chMean[t] != null ? +agg.chMean[t].toFixed(2) : null,
      delta_meta_minus_ob_ADU: delta != null ? +delta.toFixed(2) : null,
      ob_sem_median: agg.chSem[t].sem_median, ob_std: agg.chSem[t].std, ob_n: agg.chSem[t].n,
      signal_ref_median_ADU: sigRef ? sigRef[t].median : null,
      signal_above_black_ADU: sigAboveBlack != null ? +sigAboveBlack.toFixed(1) : null,
      bg_p10_above_black_ADU: bgAboveBlack != null ? +bgAboveBlack.toFixed(1) : null,
      delta_pct_of_signal: (delta != null && sigAboveBlack) ? +(100 * delta / sigAboveBlack).toFixed(3) : null,
      delta_pct_of_bg_p10: (delta != null && bgAboveBlack) ? +(100 * delta / bgAboveBlack).toFixed(3) : null,
    };
  }) : null;

  // ── histogram PNG (per phase/channel OB dist) ──
  let pngPath = null;
  if (obRaw.length) {
    const cw = 940, ch = 300;
    const canvas = makeCanvas(cw, ch);
    fillRect(canvas, 0, 0, cw, ch, 14, 15, 19);
    drawText(canvas, `OB PIXEL HISTOGRAMS  ${LABEL}  ${meta.clean_model || meta.model}  ${meta.cfa_pattern_full}`, 12, 8, 1, [235, 235, 240]);
    drawText(canvas, `yellow=metadata black   cyan=OB median`, 12, 20, 1, [200, 200, 210]);
    // gather per-phase pixels once for the plot
    const phasePx = [[], [], [], []];
    for (const { rect, px } of obRaw) { const { x, y, w, h } = rect; const eW = Math.min(x + w, W) - x, eH = Math.min(y + h, H) - y; for (let r = 0; r < eH; r++) { const ay = y + r; for (let c2 = 0; c2 < eW; c2++) { const ax = x + c2; const p = ((ay & 1) << 1) | (ax & 1); phasePx[p].push(px[r * eW + c2]); } } }
    const chCol = [[235, 90, 90], [110, 220, 120], [110, 150, 240]]; // R,G,B by true channel
    const chOf = (p) => { const cc = tile[p]; return cc === 0 ? 0 : cc === 1 ? 1 : 2; };
    for (let p = 0; p < 4; p++) {
      const ox = 12 + p * 232, oy = 40;
      const t = chOf(p);
      drawHistogram(canvas, ox, oy, 220, 230, phasePx[p], chCol[t], `phase${p}=${chNames[t]}`, blkBayer[p], agg ? agg.phStat[p].median : NaN);
    }
    pngPath = path.join(OUT, 'png', `${LABEL}.ob_hist.png`);
    fs.writeFileSync(pngPath, encodePng(canvas));
    console.log(`[ob] png -> ${path.relative(ROOT, pngPath)}`);
  }

  const result = {
    schema: 'skycruncher.calib.ob_bias_probe/1',
    label: LABEL, file: FILE, generated_at: new Date().toISOString(),
    decoder: meta.decoder, make: meta.clean_make || meta.make, model: meta.clean_model || meta.model,
    dims: { W, H }, decodeMs, fileBytes,
    cfa_pattern_full: meta.cfa_pattern_full, cfa_tile: tile, whitelevel: meta.whitelevel,
    blacklevel_bayer: blkBayer, meta_black_per_channel: metaCh.map((v) => v != null ? +v.toFixed(2) : null),
    active_area: aa, crop_area: meta.crop_area,
    ob_area_count: obRaw.length,
    ob_areas: areas.map((a) => ({ rect: a.rect, effW: a.effW, effH: a.effH, nPix: a.nPix, perPhase: a.perPhase, banding: a.banding })),
    ob_aggregate: agg ? { phStat: agg.phStat, chMedian: agg.chMed.map((v) => v != null ? +v.toFixed(2) : null), chMean: agg.chMean.map((v) => v != null ? +v.toFixed(2) : null), chSem: agg.chSem } : null,
    signal_reference: sigRef,
    deltas,
    png: pngPath ? path.relative(ROOT, pngPath) : null,
  };
  const jp = path.join(OUT, `${LABEL}.ob_bias.json`);
  fs.writeFileSync(jp, JSON.stringify(result, null, 2));
  console.log(`[ob] json -> ${path.relative(ROOT, jp)}`);
  // console summary
  if (deltas) { console.log(`[ob] per-channel  meta_black / ob_median / delta_ADU / %ofBG_p10 / SEM_med`); for (const d of deltas) console.log(`   ${d.channel}: ${d.meta_black} / ${d.ob_median} / ${d.delta_meta_minus_ob_ADU} / ${d.delta_pct_of_bg_p10}% / ±${d.ob_sem_median}`); }
  if (areas.length) { const b = areas[0].banding; console.log(`[ob] banding area0: ROW snr=${b.row.snr} (range ${b.row.range} ADU, ${b.row.count} rows) COL snr=${b.col.snr} (range ${b.col.range} ADU, ${b.col.count} cols)`); }
  process.exit(0);
}
main().catch((e) => { console.error('[ob] FATAL:', e.stack || e.message); process.exit(1); });
