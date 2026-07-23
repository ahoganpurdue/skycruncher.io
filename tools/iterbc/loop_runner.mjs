#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ITERATIVE-BC lane — LEG 2: the bounded iterative Brown-Conrady loop runner v0
// ═══════════════════════════════════════════════════════════════════════════
// Implements the ROADMAP-DRAFT loop (docs/02-specs/ITERATIVE_BC_SPEC.md) on the
// M66 sacred solve. The single live/heavy step (the solve + Float32 buffer) is
// banked by capture_m66.iterbcspec.ts; this runner is PURE .mjs and iterates
// DETERMINISTICALLY on the banked buffer — re-run byte-stable.
//
// Per iteration (bounded cap, spec §"The loop"):
//   (3) MEASURE BC from the current match set (radial k1/k2 LS, translation
//       absorbed) with a HELD-OUT never-worse guard (spec hard rail).
//   (4) FORCED POSITIONAL HARVEST: measure flux at BC-corrected predicted
//       positions of the UNMATCHED catalog cone with forcedMeasure(sigmaPix=null)
//       — NO shape/circularity gate (the corner instrument, ADDENDUM 2026-07-18).
//       Accepted harvests are recentroided -> new matched pairs (densification).
//   (7) iterate to cap=4 or convergence ε on |Δk1| + match-set stability.
//   (8) [final science forced photometry is the engine's deep_confirmed — out of
//       this densification-loop's v0 scope; noted in the handoff].
//
// v0 HONESTY: the BC refit is a transparent radial-only LS (k1,k2) with mean
// translation absorbed — NOT the engine's coverage-gated fitBrownConrady
// (tx/ty/rot/a absorbers + octant gates). That full fit is the graduation target
// (LAW 4 incubator->port). The forced-harvest instrument itself IS the engine's
// exact math (tools/psf/forced_detect.mjs::forcedMeasure, the port the engine
// deep_verify uses). Every emitted number is measured; nothing synthetic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { forcedMeasure } from '../psf/forced_detect.mjs';
import { makeBrownConrady, makeTanProjector, normRadius, radialBinLabel, emptyRadialHistogram, r6, stableStringify, dedupByKey } from './bc_math.mjs';

const ART = 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21';
const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULTS = {
  buffer: `${ART}/m66_buffer.f32`,
  meta: `${ART}/m66_capture_meta.json`,
  catalog: `${MAIN}/test_results/m4_recall_2026-07-18/miss_population.json`,
  frame: 'M66',
  outDir: `${ART}`,
  maxIters: 4,
  snr: 5,
  eps: 1e-4,
};

function parseArgs(argv) {
  const a = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--buffer') a.buffer = argv[++i];
    else if (k === '--meta') a.meta = argv[++i];
    else if (k === '--catalog') a.catalog = argv[++i];
    else if (k === '--frame') a.frame = argv[++i];
    else if (k === '--out-dir') a.outDir = argv[++i];
    else if (k === '--max-iters') a.maxIters = +argv[++i];
    else if (k === '--snr') a.snr = +argv[++i];
    else if (k === '--eps') a.eps = +argv[++i];
  }
  return a;
}

function bareId(id) { return id == null ? null : String(id).replace(/^(Gaia_|HYG_)/, ''); }

/** Flux-weighted, background-subtracted centroid in a tight window (recentroid). */
function centroid(L, W, H, x0, y0, rW) {
  const cx = Math.round(x0), cy = Math.round(y0);
  const R = Math.ceil(rW);
  if (cx < R + 1 || cy < R + 1 || cx >= W - R - 1 || cy >= H - R - 1) return null;
  // local background = min over a coarse ring (robust, cheap)
  let bg = Infinity;
  for (let dy = -R - 2; dy <= R + 2; dy++) for (let dx = -R - 2; dx <= R + 2; dx++) {
    const r2 = dx * dx + dy * dy;
    if (r2 > (R + 2) * (R + 2) || r2 < R * R) continue;
    const v = L[(cy + dy) * W + cx + dx];
    if (v < bg) bg = v;
  }
  if (!Number.isFinite(bg)) bg = 0;
  let sw = 0, swx = 0, swy = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy > rW * rW) continue;
    let w = L[(cy + dy) * W + cx + dx] - bg;
    if (w <= 0) continue;
    sw += w; swx += w * (cx + dx); swy += w * (cy + dy);
  }
  if (sw <= 0) return null;
  return { x: swx / sw, y: swy / sw };
}

/**
 * Radial BC fit from matched pairs (pred = rectilinear/linear-projected pixel,
 * obs = observed native centroid). Absorbs a mean translation (tx,ty) first, then
 * fits rd/ru = a + k1 ru^2 + k2 ru^4 by ordinary least squares over the basis
 * [1, ru^2, ru^4]. The CONSTANT term `a` is a linear-radial-SCALE absorber (the
 * engine fitBrownConrady's 'a' term) — it soaks up the WCS linear-scale residual
 * so k1/k2 are clean LENS coefficients, NOT a residual vacuum (spec §Premise
 * hazard). `a` is reported for the record but is NOT a lens term. `idxMask`
 * selects the training subset (held-out validation uses the complement).
 */
function fitRadialBC(pairs, W, H, idxMask) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  // mean translation over the training pairs
  let tx = 0, ty = 0, nt = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (idxMask && !idxMask(i)) continue;
    tx += pairs[i].ox - pairs[i].px; ty += pairs[i].oy - pairs[i].py; nt++;
  }
  if (nt > 0) { tx /= nt; ty /= nt; }
  // 3x3 normal equations for [a,k1,k2] over basis g=[1, ru^2, ru^4], target rd/ru
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (idxMask && !idxMask(i)) continue;
    const p = pairs[i];
    const ru = Math.hypot(p.px - cx, p.py - cy) / hd;
    if (ru < 0.02) continue; // near-center: radial signal degenerate
    const rd = Math.hypot((p.ox - tx) - cx, (p.oy - ty) - cy) / hd;
    const g = [1, ru * ru, ru * ru * ru * ru];
    const t = rd / ru;
    for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) A[r][c] += g[r] * g[c]; b[r] += g[r] * t; }
    n++;
  }
  const sol = solve3x3(A, b);
  const a = sol ? sol[0] : 1, k1 = sol ? sol[1] : 0, k2 = sol ? sol[2] : 0;
  return { a, k1, k2, tx, ty, n };
}

/** Solve a 3x3 linear system via Cramer's rule; null if singular. */
function solve3x3(A, b) {
  const d = det3(A);
  if (!(Math.abs(d) > 1e-20)) return null;
  const c0 = det3([[b[0], A[0][1], A[0][2]], [b[1], A[1][1], A[1][2]], [b[2], A[2][1], A[2][2]]]);
  const c1 = det3([[A[0][0], b[0], A[0][2]], [A[1][0], b[1], A[1][2]], [A[2][0], b[2], A[2][2]]]);
  const c2 = det3([[A[0][0], A[0][1], b[0]], [A[1][0], A[1][1], b[1]], [A[2][0], A[2][1], b[2]]]);
  return [c0 / d, c1 / d, c2 / d];
}
function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/** Apply the radial model {a,k1,k2,tx,ty}: pred (rectilinear) -> observed native. */
function applyRadial(m, px, py, W, H, out) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const nx = (px - cx) / hd, ny = (py - cy) / hd;
  const r2 = nx * nx + ny * ny;
  const f = m.a + m.k1 * r2 + m.k2 * r2 * r2;
  out[0] = cx + nx * f * hd + m.tx;
  out[1] = cy + ny * f * hd + m.ty;
  return out;
}

/** 2D RMS residual of a radial model {a,k1,k2,tx,ty} over a pair subset. */
function heldoutRms(pairs, m, W, H, idxMask) {
  const out = [0, 0];
  let s = 0, n = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (idxMask && !idxMask(i)) continue;
    const p = pairs[i];
    applyRadial(m, p.px, p.py, W, H, out);
    const dx = out[0] - p.ox, dy = out[1] - p.oy;
    s += dx * dx + dy * dy; n++;
  }
  return n ? Math.sqrt(s / n) : Infinity;
}

function main() {
  const args = parseArgs(process.argv);
  // ── load banked buffer + meta + cone ──
  const raw = fs.readFileSync(args.buffer);
  const meta = JSON.parse(fs.readFileSync(args.meta, 'utf8'));
  const W = meta.width, H = meta.height;
  const L = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  if (L.length !== W * H * (meta.channels ?? 1)) throw new Error(`buffer length ${L.length} != ${W}x${H}x${meta.channels}`);
  const fwhmPx = meta.mean_fwhm_px || 4;
  const project = makeTanProjector(meta.wcs);

  const catAll = JSON.parse(fs.readFileSync(args.catalog, 'utf8'));
  const cone = dedupByKey(catAll.filter((r) => r.frame_id === args.frame && r.matched !== true &&
    Number.isFinite(r.pred_x) && Number.isFinite(r.pred_y)), 'star_id'); // collapse overlapping depth slices
  const coneById = new Map();
  for (const s of cone) coneById.set(bareId(s.star_id), s);

  // ── initial matched pairs from the sacred matched_stars ──
  let pairs = [];
  for (const s of meta.matched_stars) {
    if (s.ra_deg == null || s.dec_deg == null) continue;
    const [px, py] = project(s.ra_deg, s.dec_deg);
    pairs.push({ id: bareId(s.gaia_id), px, py, ox: s.x, oy: s.y, src: 'initial' });
  }
  const N0 = pairs.length;
  // deterministic held-out split: index parity (stable, reproducible)
  const isTrain = (i) => i % 2 === 0;
  const isHeldout = (i) => i % 2 === 1;

  const rApRecentroid = Math.max(2, 0.68 * fwhmPx);
  const seen = new Set(); // existing pair obs positions (rounded) for dedup
  for (const p of pairs) seen.add(`${Math.round(p.ox)},${Math.round(p.oy)}`);

  let bc = { a: 1, k1: 0, k2: 0, tx: 0, ty: 0 }; // nominal prior (spec step 1)
  let prevHeldout = Infinity;
  const iters = [];
  const renderRecords = [];
  let converged = false, haltReason = 'max_iters';

  for (let k = 1; k <= args.maxIters; k++) {
    // (3) MEASURE BC from current match set, held-out never-worse guard
    const fit = fitRadialBC(pairs, W, H, isTrain);
    const cand = { a: fit.a, k1: fit.k1, k2: fit.k2, tx: fit.tx, ty: fit.ty };
    const candHeldout = heldoutRms(pairs, cand, W, H, isHeldout);
    const acceptBc = candHeldout <= prevHeldout + 1e-9; // never-worse
    const bcUsed = acceptBc ? cand : bc;
    if (acceptBc) prevHeldout = candHeldout;

    // (4) FORCED POSITIONAL HARVEST at BC-corrected predicted positions
    const out = [0, 0];
    const positions = [];
    for (const s of cone) {
      applyRadial(bcUsed, s.pred_x, s.pred_y, W, H, out);
      const x = out[0], y = out[1];
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      positions.push({ x, y, gaia_id: String(s.star_id), mag: s.cat_mag });
    }
    const fm = forcedMeasure({ L, w: W, h: H, positions, fwhmPx, snrThreshold: args.snr, sigmaPix: null });
    const accepts = fm.results.filter((r) => r.accepted && r.snr >= args.snr);

    // recentroid accepts -> new pairs (dedup vs existing detections)
    let added = 0;
    const coverage = emptyRadialHistogram();
    const newIds = new Set();
    for (const r of accepts) {
      const c = centroid(L, W, H, r.x, r.y, rApRecentroid);
      if (!c) continue;
      const key = `${Math.round(c.x)},${Math.round(c.y)}`;
      if (seen.has(key)) continue; // already a matched detection
      const cs = coneById.get(bareId(r.gaia_id));
      if (!cs) continue;
      seen.add(key);
      pairs.push({ id: bareId(r.gaia_id), px: cs.pred_x, py: cs.pred_y, ox: c.x, oy: c.y, src: `harvest_iter${k}` });
      coverage[radialBinLabel(normRadius(c.x, c.y, W, H))]++;
      newIds.add(bareId(r.gaia_id));
      added++;
    }
    // per-iteration render records (test stars for the noise-onset PNG overlay)
    renderRecords.push({
      iter: k,
      bc_used: { a: bcUsed.a, k1: bcUsed.k1, k2: bcUsed.k2 },
      snr_bound: args.snr,
      test_stars: fm.results.map((r) => ({
        x: r6(r.x), y: r6(r.y), snr: r6(r.snr),
        accepted: r.accepted && r.snr >= args.snr,
        is_new: newIds.has(bareId(r.gaia_id)),
        r_norm: r6(normRadius(r.x, r.y, W, H)),
      })),
    });

    const inSampleRms = heldoutRms(pairs, bcUsed, W, H, null);
    iters.push({
      iter: k,
      bc_measured: { a: r6(fit.a), k1: r6(fit.k1), k2: r6(fit.k2), fit_pairs: fit.n },
      bc_used: { a: r6(bcUsed.a), k1: r6(bcUsed.k1), k2: r6(bcUsed.k2), tx: r6(bcUsed.tx), ty: r6(bcUsed.ty) },
      bc_accept_guard: acceptBc ? 'ACCEPTED' : 'KEPT_PREVIOUS_never_worse',
      heldout_rms_px: r6(candHeldout),
      insample_rms_px: r6(inSampleRms),
      pairs_before: pairs.length - added,
      harvest_positions: positions.length,
      forced_accepts: accepts.length,
      new_pairs_added: added,
      pairs_after: pairs.length,
      harvest_radial_coverage: coverage,
    });

    // (7) convergence: |Δk1| small AND no new matches (match-set stable)
    const dK1 = Math.abs(bcUsed.k1 - bc.k1);
    bc = bcUsed;
    if (dK1 < args.eps && added === 0) { converged = true; haltReason = `converged (|dk1|=${dK1.toExponential(2)} < eps, match set stable)`; break; }
  }

  const ledger = {
    schema: 'iterbc.loop.v0',
    generated_by: 'tools/iterbc/loop_runner.mjs',
    frame: args.frame,
    inputs: { buffer: path.basename(args.buffer), meta: path.basename(args.meta), catalog: path.basename(args.catalog) },
    frame_dims: { w: W, h: H },
    fwhm_px: r6(fwhmPx),
    params: { max_iters: args.maxIters, forced_snr_threshold: args.snr, convergence_eps_k1: args.eps },
    refit_method: 'v0 radial-only k1/k2 LS with mean-translation absorbed + held-out(index-parity) never-worse guard; engine coverage-gated fitBrownConrady is the graduation target',
    harvest_source: `miss_population ${args.frame} unmatched cone (${cone.length} stars, G<17, center-cropped r_norm<~0.5); forced flux via forced_detect.mjs::forcedMeasure(sigmaPix=null) = NO shape gate`,
    initial_matched_pairs: N0,
    converged,
    halt_reason: haltReason,
    final_bc: { a: r6(bc.a), k1: r6(bc.k1), k2: r6(bc.k2), tx: r6(bc.tx), ty: r6(bc.ty) },
    scale_absorber_note: 'a = linear-radial-scale absorber (WCS scale residual), NOT a lens term; k1/k2 are the lens coefficients',
    engine_measured_bc_reference: { k1: meta.bc_measured?.k1 ?? null, k2: meta.bc_measured?.k2 ?? null, note: 'the live solve single-pass measured-BC, for comparison to the loop refit' },
    iterations: iters,
  };

  fs.mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, 'm66_loop_ledger.json');
  fs.writeFileSync(outPath, stableStringify(ledger));
  // per-iteration render data (test stars) for the noise-onset PNG overlay — big
  // file, D: only (K: thin-disk law). Separate from the ledger so the ledger
  // stays a compact byte-stable artifact.
  fs.writeFileSync(path.join(args.outDir, 'm66_loop_render.json'), stableStringify({ frame: args.frame, buffer: path.basename(args.buffer), meta: path.basename(args.meta), iterations: renderRecords }));

  console.log(`[iterbc/loop] frame=${args.frame} ${W}x${H} fwhm=${r6(fwhmPx)}px  initial pairs=${N0}`);
  for (const it of iters) {
    console.log(`  iter ${it.iter}: BC k1=${it.bc_used.k1} (${it.bc_accept_guard}) heldout_rms=${it.heldout_rms_px}px | harvest ${it.harvest_positions} pos -> ${it.forced_accepts} accepts -> +${it.new_pairs_added} pairs (total ${it.pairs_after})`);
  }
  console.log(`  ${converged ? 'CONVERGED' : 'STOPPED'}: ${haltReason}; final k1=${ledger.final_bc.k1} (engine single-pass ref ${ledger.engine_measured_bc_reference.k1})`);
  console.log(`  ledger -> ${outPath}`);
  return ledger;
}

main();
