#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ITERATIVE-BC lane — per-iteration overlay PNGs (owner directive 2026-07-18)
// ═══════════════════════════════════════════════════════════════════════════
// docs/local/QUADVIZ_ITERATION_PNG_SPEC_2026-07-18.md: for every loop iteration,
// emit a FULL-RES PNG showing the "test" stars (the forced-harvest candidates at
// the current bound) colored by outcome + sized by measured significance, drawn
// on the aesthetic (STF-stretched) render — "so I can genuinely SEE when it
// starts picking up noise." RENDER plane only (LAW 1): overlays sit on the
// stretched luma, the science path is untouched, this consumes banked records.
//
// SCOPE NOTE (honest): the spec's OTHER overlay element — quad polylines — comes
// from the quad SOLVER's quad_gen records; this BC densification loop runs on the
// FIXED solved pose (post-solve) and forms no quads, so quad lines are ABSENT
// here (not synthesized). The test-star / noise-onset element — the owner's
// stated intent — is the payload.
//
// Big PNGs live on D: (K: thin-disk law). Reuses the shared canvas/STF/PNG
// helpers from tools/validation/visual/bubble_tiles.mjs.
//
// USAGE: node tools/iterbc/render_iterations.mjs [--render <m66_loop_render.json>]
//        [--buffer <m66_buffer.f32>] [--meta <m66_capture_meta.json>] [--out-dir <dir>]

import fs from 'fs';
import path from 'path';
import { makeCanvas, fillRect, drawText, drawRing, stretch, grayToCanvas, encodePng } from '../validation/visual/bubble_tiles.mjs';

const ART = 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21';
const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const RENDER = arg('--render', `${ART}/m66_loop_render.json`);
const BUFFER = arg('--buffer', `${ART}/m66_buffer.f32`);
const META = arg('--meta', `${ART}/m66_capture_meta.json`);
const OUT_DIR = arg('--out-dir', ART);

const COL = {
  newAcc: [255, 210, 60],  // gold — new-this-iteration accepted harvest
  reAcc: [80, 240, 160],   // green — accepted but coincident with an existing detection
  low: [230, 90, 90],      // red — tested but below the current bound (noise/absent)
  panel: [10, 12, 20],
  text: [235, 238, 245],
  dim: [150, 158, 172],
};

function ringRad(snr) {
  // significance -> ring size so the noise floor is visually apparent
  if (!Number.isFinite(snr)) return 2;
  const r = 2 + 2.2 * Math.log10(Math.max(1, snr));
  return Math.min(14, r);
}

function main() {
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const render = JSON.parse(fs.readFileSync(RENDER, 'utf8'));
  const W = meta.width, H = meta.height;
  const raw = fs.readFileSync(BUFFER);
  const L = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  // aesthetic background: STF-stretch the luma ONCE (shared across iterations)
  const gray = stretch(L, { asinh: 14, lo: 0.30, hi: 0.9985 });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  for (const it of render.iterations) {
    const c = grayToCanvas(gray, W, H);
    let nNew = 0, nRe = 0, nLow = 0;
    // draw below-bound first (so accepted rings sit on top)
    for (const t of it.test_stars) {
      if (t.accepted) continue;
      drawRing(c, t.x, t.y, ringRad(t.snr), COL.low, 0.5); nLow++;
    }
    for (const t of it.test_stars) {
      if (!t.accepted) continue;
      if (t.is_new) { drawRing(c, t.x, t.y, ringRad(t.snr), COL.newAcc, 0.95); nNew++; }
      else { drawRing(c, t.x, t.y, ringRad(t.snr), COL.reAcc, 0.75); nRe++; }
    }
    // legend panel (top-left)
    const s = 3;
    fillRect(c, 0, 0, 760, 150, COL.panel[0], COL.panel[1], COL.panel[2], 210);
    drawText(c, `iterbc M66 - iteration ${it.iter}/${render.iterations.length}`, 12, 12, s, COL.text);
    drawText(c, `forced bound snr>=${it.snr_bound}   BC k1=${(+it.bc_used.k1).toFixed(5)} k2=${(+it.bc_used.k2).toFixed(5)}`, 12, 44, s - 1, COL.dim);
    drawText(c, `new(gold) ${nNew}   re-detected(green) ${nRe}   below-bound(red) ${nLow}   tested ${it.test_stars.length}`, 12, 74, s - 1, COL.dim);
    drawText(c, `render plane / STF asinh / science untouched / quad lines N-A (post-solve BC loop)`, 12, 104, s - 1, COL.dim);

    const out = path.join(OUT_DIR, `m66_iter${it.iter}.png`);
    fs.writeFileSync(out, encodePng(c));
    written.push({ iter: it.iter, path: out, new: nNew, re: nRe, low: nLow });
    console.log(`[iterbc/render] iter ${it.iter}: new ${nNew} / re ${nRe} / low ${nLow} -> ${out}`);
  }
  return written;
}

main();
