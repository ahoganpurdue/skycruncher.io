// ═══════════════════════════════════════════════════════════════════════════
// SYNTH LANE — CLOSED-LOOP ACCEPTANCE  (generate → solve → recover truth)
// ═══════════════════════════════════════════════════════════════════════════
// THE DELIVERABLE. Generate three regimes (narrow / medium / wide), push each
// through the REAL headless FITS wizard (tools/api/run.mjs), and score the
// solved WCS against the injected truth sidecar — center offset (arcsec), scale
// error (%), matched stars, and an ECHO GUARD (did the solver refine to truth,
// or just echo the coarse header goto?). A regime that honestly fails to solve
// is REPORTED (a solver finding, not a generator failure).
//
//   node tools/synth/closed_loop.mjs                 # all three rigs
//   node tools/synth/closed_loop.mjs --skip-generate # reuse existing frames
//   node tools/synth/closed_loop.mjs --rigs narrow_seestar,medium_refractor
//
// Determinism: frames come from generate_frame.mjs (same seed ⇒ byte-identical),
// so the whole table is reproducible.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateFrame } from './generate_frame.mjs';
import { angSepDeg } from '../solverkit/common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'test_results', 'synth');
const RUN_MJS = path.join(REPO_ROOT, 'tools', 'api', 'run.mjs');

const SELECT = 'solution.ra_hours,solution.dec_degrees,solution.pixel_scale,solution.stars_matched,solution.confidence';

// per-rig solve budget (ms). Ultra-wide is bounded SHORT so a non-terminating
// narrow-quad run reports a clean NO_SOLVE(timeout) instead of grinding to the
// vitest 360s cap.
const RIG_TIMEOUT_MS = { narrow_seestar: 180_000, medium_refractor: 180_000, wide_dslr14: 150_000 };

function runWizard(fitsPath, timeoutMs) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [RUN_MJS, '--select', SELECT, fitsPath], {
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

/** Score a solved WCS against truth. Angles on the sphere via angSepDeg. */
function score(truth, sol) {
  const t = truth.wcs_truth;
  const truthRaDeg = t.crval_deg[0], truthDecDeg = t.crval_deg[1];
  const solRaDeg = sol['solution.ra_hours'] * 15, solDecDeg = sol['solution.dec_degrees'];
  const centerArcsec = angSepDeg(truthRaDeg, truthDecDeg, solRaDeg, solDecDeg) * 3600;
  const scaleErrPct = 100 * Math.abs(sol['solution.pixel_scale'] - t.pixel_scale_arcsec) / t.pixel_scale_arcsec;
  // echo guard: distance solved→truth vs solved→goto. PASS ⇔ solved is closer to
  // truth than to the (offset) header goto — proves refinement, not header echo.
  const goto = truth.pointing.goto_hint_deg;
  const dTruth = angSepDeg(truthRaDeg, truthDecDeg, solRaDeg, solDecDeg) * 3600;
  const dGoto = angSepDeg(goto[0], goto[1], solRaDeg, solDecDeg) * 3600;
  return {
    center_offset_arcsec: +centerArcsec.toFixed(3),
    scale_err_pct: +scaleErrPct.toFixed(4),
    matched: sol['solution.stars_matched'],
    confidence: +(sol['solution.confidence'] ?? 0).toFixed(4),
    echo_guard: dTruth < dGoto ? 'PASS (refined to truth)' : 'FAIL (near goto)',
    solved_center_deg: [+solRaDeg.toFixed(6), +solDecDeg.toFixed(6)],
  };
}


async function main() {
  const args = process.argv.slice(2);
  const skipGen = args.includes('--skip-generate');
  const rigArg = args.includes('--rigs') ? args[args.indexOf('--rigs') + 1] : null;
  const rigs = rigArg ? rigArg.split(',') : ['narrow_seestar', 'medium_refractor', 'wide_dslr14'];
  const names = { narrow_seestar: 'cl_narrow', medium_refractor: 'cl_medium', wide_dslr14: 'cl_wide' };

  const rows = [];
  for (const rig of rigs) {
    const name = names[rig] || `cl_${rig}`;
    const fitsPath = path.join(OUT, `${name}.fits`);
    const truthPath = path.join(OUT, `${name}.truth.json`);
    if (!skipGen || !fs.existsSync(fitsPath)) {
      generateFrame({ rig, name, outDir: OUT, raDeg: 170.425, decDeg: 12.842 });
    }
    const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
    process.stderr.write(`[closed_loop] solving ${rig} (${truth.frame.width}x${truth.frame.height}, ${truth.catalog.in_frame_count} stars)…\n`);
    const run = runWizard(fitsPath, RIG_TIMEOUT_MS[rig] ?? 180_000);
    const row = { rig, frame: [truth.frame.width, truth.frame.height], in_frame: truth.catalog.in_frame_count,
      truth_scale: truth.wcs_truth.pixel_scale_arcsec, distortion: truth.distortion.model,
      max_shift_px: truth.distortion.max_corner_shift_px ?? 0, verdict: run.verdict, solve_ms: run.ms };
    if (run.verdict === 'SOLVE') row.score = score(truth, run.sol);
    else {
      row.reason = run.reason;
    }
    rows.push(row);
  }

  // ── the table ─────────────────────────────────────────────────────────────
  console.log('\n═══ REVERSE-PIPELINE CLOSED LOOP — truth vs solved ═══════════════════════════');
  console.log('rig               frame        stars scale"/px dist  verdict   Δcenter Δscale% matched conf   echo');
  for (const r of rows) {
    const s = r.score;
    const base = `${r.rig.padEnd(17)} ${(`${r.frame[0]}x${r.frame[1]}`).padEnd(12)} ${String(r.in_frame).padStart(5)} ${r.truth_scale.toFixed(2).padStart(8)} ${r.distortion.slice(0, 4).padEnd(5)} ${r.verdict.padEnd(9)}`;
    if (s) console.log(`${base} ${(`${s.center_offset_arcsec}"`).padStart(8)} ${s.scale_err_pct.toFixed(3).padStart(6)} ${String(s.matched).padStart(6)}  ${s.confidence.toFixed(2)}  ${s.echo_guard.split(' ')[0]}`);
    else console.log(`${base} ${r.reason}`);
  }
  console.log('──────────────────────────────────────────────────────────────────────────────');
  console.log('Δcenter = great-circle solved-vs-truth center (arcsec). echo=PASS ⇒ solver refined to truth, not the +0.1° header goto.');

  const artifact = { schema: 'skycruncher.synth.closed_loop/0', deterministic: true, generatedAtUnix: null, rows };
  fs.mkdirSync(OUT, { recursive: true });
  const outPath = path.join(OUT, 'closed_loop_result.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\n[artifact] ${path.relative(REPO_ROOT, outPath)}`);
  return rows.some((r) => r.verdict === 'SOLVE');
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(2); });
