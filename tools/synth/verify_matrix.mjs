// ═══════════════════════════════════════════════════════════════════════════
// SYNTH VERIFY MATRIX — diversity closed-loop (2026-07-10 re-verification)
// ═══════════════════════════════════════════════════════════════════════════
// Generates a DIVERSE frame set (narrow+medium × {baseline, rot137, parity-flip}
// across a DENSE and a SPARSE atlas pointing) and pushes each through the REAL
// headless FITS wizard (tools/api/run.mjs), scoring solved-vs-truth. Extends
// closed_loop.mjs (which is fixed at M66/rot0/parity1) with rotation, parity,
// and pointing diversity — the axes the e2e-mutation kill-suite needs.
//
//   node tools/synth/verify_matrix.mjs
//
// Seeds pinned per row (recorded). Determinism ⇒ reproducible. Solves run SERIAL
// (one vitest fork at a time) to stay light on a mid-battery box.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateFrame } from './generate_frame.mjs';
import { angSepDeg } from '../solverkit/common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'test_results', 'synth_verify_2026-07-10');
const FRAMES = path.join(OUT, 'frames');
const RECEIPTS = path.join(OUT, 'receipts');
const RUN_MJS = path.join(REPO_ROOT, 'tools', 'api', 'run.mjs');

const SELECT = [
  'solution.ra_hours', 'solution.dec_degrees', 'solution.pixel_scale',
  'solution.roll_degrees', 'solution.parity', 'solution.stars_matched',
  'solution.confidence', 'solution.mean_residual_arcsec',
  'solution.fov_width_deg', 'solution.fov_height_deg',
].join(',');

// ── pointings (picked BY MEASURED atlas density; see probe_density.mjs) ────────
const DENSE = { field: 'cygnus_mw', raDeg: 305.0, decDeg: 40.0 };   // narrow ~2469 stars
const SPARSE = { field: 'highlat_south', raDeg: 30.0, decDeg: -20.0 }; // narrow ~205 stars

// ── the matrix: all 6 {narrow,medium}×{baseline,rot137,flip} combos, split ─────
// across dense/sparse so each FOV class and each variant appears, and the two
// pointings both carry narrow+medium. M66/rot0/parity1 baselines come from the
// companion closed_loop.mjs run (README reconfirm).
const MATRIX = [
  { rig: 'narrow_seestar',   variant: 'baseline',  rot: 0,   parity: 1,  pt: SPARSE, seed: 20260710 },
  { rig: 'narrow_seestar',   variant: 'rot137',    rot: 137, parity: 1,  pt: DENSE,  seed: 20260711 },
  { rig: 'narrow_seestar',   variant: 'parityflip',rot: 0,   parity: -1, pt: SPARSE, seed: 20260712 },
  { rig: 'medium_refractor', variant: 'baseline',  rot: 0,   parity: 1,  pt: DENSE,  seed: 20260713 },
  { rig: 'medium_refractor', variant: 'rot137',    rot: 137, parity: 1,  pt: SPARSE, seed: 20260714 },
  { rig: 'medium_refractor', variant: 'parityflip',rot: 0,   parity: -1, pt: DENSE,  seed: 20260715 },
];

function wrap180(d) { let x = ((d % 360) + 360) % 360; if (x > 180) x -= 360; return x; }

function runWizard(fitsPath, timeoutMs) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [RUN_MJS, '--select', SELECT, '--out', RECEIPTS, fitsPath], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs,
  });
  const ms = Date.now() - t0;
  if (res.error && res.error.code === 'ETIMEDOUT') return { verdict: 'NO_SOLVE', reason: `timeout>${(timeoutMs / 1000) | 0}s`, ms };
  if (res.status === 0 && res.stdout) {
    try {
      const line = res.stdout.trim().split('\n').filter(Boolean).pop();
      const j = JSON.parse(line);
      if (j.solved) return { verdict: 'SOLVE', sol: j, ms };
    } catch { /* fall through */ }
  }
  return { verdict: 'NO_SOLVE', reason: res.status === 2 ? 'wizard NO_SOLVE' : `exit ${res.status}`, ms };
}

function score(truth, sol) {
  const t = truth.wcs_truth;
  const truthRaDeg = t.crval_deg[0], truthDecDeg = t.crval_deg[1];
  const solRaDeg = sol['solution.ra_hours'] * 15, solDecDeg = sol['solution.dec_degrees'];
  const centerArcsec = angSepDeg(truthRaDeg, truthDecDeg, solRaDeg, solDecDeg) * 3600;
  const scaleErrPct = 100 * Math.abs(sol['solution.pixel_scale'] - t.pixel_scale_arcsec) / t.pixel_scale_arcsec;
  const goto = truth.pointing.goto_hint_deg;
  const dGoto = angSepDeg(goto[0], goto[1], solRaDeg, solDecDeg) * 3600;
  return {
    center_offset_arcsec: +centerArcsec.toFixed(3),
    center_offset_px: +(centerArcsec / t.pixel_scale_arcsec).toFixed(3),
    scale_err_pct: +scaleErrPct.toFixed(4),
    matched: sol['solution.stars_matched'],
    confidence: +(sol['solution.confidence'] ?? 0).toFixed(4),
    mean_residual_arcsec: +(sol['solution.mean_residual_arcsec'] ?? 0).toFixed(3),
    // rotation/parity: RAW truth-vs-solved (convention offset NOT asserted — the
    // cross-variant flip/track analysis in the report is the real test).
    truth_rotation_deg: t.rotation_deg, solved_roll_deg: +(sol['solution.roll_degrees']).toFixed(4),
    roll_minus_truth_wrapped_deg: +wrap180(sol['solution.roll_degrees'] - t.rotation_deg).toFixed(4),
    truth_parity: t.parity, solved_parity: sol['solution.parity'],
    echo_guard: centerArcsec < dGoto ? 'PASS' : 'FAIL',
    solved_center_deg: [+solRaDeg.toFixed(6), +solDecDeg.toFixed(6)],
  };
}

async function main() {
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(RECEIPTS, { recursive: true });
  const rows = [];
  for (const m of MATRIX) {
    const name = `vm_${m.rig.split('_')[0]}_${m.variant}_${m.pt.field}`;
    process.stderr.write(`\n[verify_matrix] generate ${name} (rig=${m.rig} rot=${m.rot} parity=${m.parity} @ ${m.pt.field})\n`);
    const { truth } = generateFrame({
      rig: m.rig, raDeg: m.pt.raDeg, decDeg: m.pt.decDeg,
      rotationDeg: m.rot, parity: m.parity, seed: m.seed, name, outDir: FRAMES,
    });
    const fitsPath = path.join(FRAMES, `${name}.fits`);
    process.stderr.write(`[verify_matrix] solve ${name} (${truth.frame.width}x${truth.frame.height}, ${truth.catalog.in_frame_count} in-frame stars)…\n`);
    const run = runWizard(fitsPath, 200_000);
    const row = {
      name, rig: m.rig, variant: m.variant, pointing: m.pt.field,
      injected_rot_deg: m.rot, injected_parity: m.parity, seed: m.seed,
      frame: [truth.frame.width, truth.frame.height], in_frame: truth.catalog.in_frame_count,
      truth_scale: truth.wcs_truth.pixel_scale_arcsec, distortion: truth.distortion.model,
      max_shift_px: truth.distortion.max_corner_shift_px ?? 0,
      verdict: run.verdict, solve_ms: run.ms,
    };
    if (run.verdict === 'SOLVE') row.score = score(truth, run.sol);
    else row.reason = run.reason;
    rows.push(row);
    process.stderr.write(`[verify_matrix] ${name}: ${run.verdict} (${(run.ms / 1000).toFixed(1)}s)${row.score ? ` Δc=${row.score.center_offset_arcsec}" Δs=${row.score.scale_err_pct}% matched=${row.score.matched}` : ` ${row.reason}`}\n`);
    // incremental write so a mid-run stall still leaves partial evidence
    fs.writeFileSync(path.join(OUT, 'results.json'),
      JSON.stringify({ schema: 'skycruncher.synth.verify_matrix/0', generatedAtUnix: null,
        dense: DENSE, sparse: SPARSE, rows }, null, 2));
  }
  console.log('\n═══ SYNTH VERIFY MATRIX — truth vs solved ════════════════════════════════════');
  console.log('name                                    frame        stars scale"/px verdict   Δc(as) Δc(px) Δscale% Δroll  parT→S matched conf   echo');
  for (const r of rows) {
    const s = r.score;
    const base = `${r.name.padEnd(39)} ${(`${r.frame[0]}x${r.frame[1]}`).padEnd(12)} ${String(r.in_frame).padStart(5)} ${r.truth_scale.toFixed(2).padStart(8)} ${r.verdict.padEnd(9)}`;
    if (s) console.log(`${base} ${String(s.center_offset_arcsec).padStart(6)} ${String(s.center_offset_px).padStart(6)} ${s.scale_err_pct.toFixed(3).padStart(7)} ${String(s.roll_minus_truth_wrapped_deg).padStart(6)} ${String(s.truth_parity)}→${String(s.solved_parity)}  ${String(s.matched).padStart(6)}  ${s.confidence.toFixed(2)}  ${s.echo_guard}`);
    else console.log(`${base} ${r.reason}`);
  }
  console.log(`\n[artifact] ${path.relative(REPO_ROOT, path.join(OUT, 'results.json'))}`);
  return rows;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
