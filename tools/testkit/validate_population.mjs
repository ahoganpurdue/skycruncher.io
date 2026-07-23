#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/validate_population.mjs — retro-validation of Manifest Builder v2
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN.md §5 Stage 12 step 4: rebuild tonight's population manifest
// through lib/manifest.mjs and verify it reproduces the ACTUAL distribution
// decisions RETROACTIVELY — cocoon collapses to 3 sampled + 22 tagged (vs the
// live run's 11-run + 14 mid-run skip), r_mosaic bands enumerate fully, the
// 4.49 GB frame skips with reason, carina gets the blind budget. Reports the diff
// vs what we actually ran (MEASURED).
//
// Reads the SHIPPED population manifest (frame metadata: id/rel/abs/sha/size/
// format — NO pixel bytes) and re-runs the v2 policy on it. Real FITS header
// probes run against frame.abs when reachable; otherwise the row is honestly
// flagged probe-unavailable (conservative blind budget) — never guessed.
//
//   node tools/testkit/validate_population.mjs --manifest <shipped manifest.json>
//
// Exit 0 = every retro-target reproduced; 1 = a target diverged; 2 = usage/IO.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './lib/manifest.mjs';

// ── the MEASURED actuals from population_run_2026-07-11 (docs/TEST_SUITE_PLAN.md
//    §1 + tools/corpus/population_timing_run.mjs runResume COCOON_REASON). These
//    are what we ACTUALLY ran, hard-recorded for the diff. ─────────────────────
const ACTUAL = {
  n_frames: 97,
  executed: 82,                 // 40 solved + 35 no_solve + 7 honest_timeout
  cocoon_total: 25,
  cocoon_run: 11,               // wastefully solved before the mid-run kill
  cocoon_skipped_midrun: 14,    // owner-ruled correlated-set skip, mid-run surgery
  oversize_skipped: 1,          // 4.49 GB Cygnus loop
  carina_timeout_ms: 120_000,   // old policy: all FITS = 120 s → carina UW killed at the wall
};

function parseArgs(argv) {
  const o = { manifest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') o.manifest = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') o.help = true;
    else return { error: `unknown arg: ${argv[i]}` };
  }
  return { o };
}

async function main(argv) {
  const { o, error } = parseArgs(argv);
  if (error) { console.error(`validate: ${error}`); return 2; }
  if (o.help || !o.manifest) { console.log('Usage: node tools/testkit/validate_population.mjs --manifest <shipped manifest.json>'); return o.help ? 0 : 2; }
  if (!fs.existsSync(o.manifest)) { console.error(`validate: manifest not found: ${o.manifest}`); return 2; }

  const shipped = JSON.parse(fs.readFileSync(o.manifest, 'utf8'));
  const frames = shipped.frames;
  console.log(`[validate] shipped manifest: ${frames.length} frames (${shipped.run ?? '?'})`);

  const v2 = await buildManifest({ frames, label: 'QUIET-BASELINE' });
  const d = v2.distribution;
  const rowById = new Map(v2.frames.map((r) => [r.id, r]));

  // helpers to locate the specific retro-target frames
  const cocoon = v2.frames.filter((r) => /cocoon_60da/.test(r.rel));
  const rmosaic = v2.frames.filter((r) => /r_mosaic_[a-z]\.fits$/i.test(r.rel));
  const oversize = v2.frames.filter((r) => r.disposition === 'skipped_too_large');
  const carina = v2.frames.filter((r) => /carina60Da/i.test(r.rel));

  const cocoonSampled = cocoon.filter((r) => r.disposition === 'sampled').length;
  const cocoonSkipped = cocoon.filter((r) => r.disposition === 'skipped_correlated_set').length;
  const rmosaicEnum = rmosaic.filter((r) => r.disposition === 'enumerated').length;
  const carinaBlind = carina.filter((r) => r.timeout_class === 'blind').length;

  const checks = [];
  const check = (name, got, want, extra = '') => { const ok = got === want; checks.push({ name, ok, got, want, extra }); };

  check('cocoon sampled (v2)', cocoonSampled, 3, 'was 11 actually run');
  check('cocoon skipped_correlated_set (v2, at BUILD)', cocoonSkipped, 22, `was ${ACTUAL.cocoon_skipped_midrun} skipped MID-RUN`);
  check('r_mosaic bands enumerated fully', rmosaicEnum, 6, 'axis: filter_band — never sampled (would hide the gate bug)');
  check('oversize skipped_too_large', oversize.length, 1, `${oversize[0]?.rel ?? '?'} (${((oversize[0]?.size_bytes ?? 0) / 1e9).toFixed(2)}GB)`);
  check('carina → blind budget', carinaBlind, carina.length, `${carina.length} frame(s); v2 ${carina[0]?.timeout_ms ?? '?'}ms vs actual ${ACTUAL.carina_timeout_ms}ms`);

  // v2 solve-lane vs actual executed (the wasted-work delta)
  const v2Solve = d.solve_lane;
  const savedCocoon = ACTUAL.cocoon_run - cocoonSampled;   // 11 - 3 = 8 wasteful solves eliminated
  check('v2 solve-lane count', v2Solve, ACTUAL.executed - savedCocoon, `actual executed ${ACTUAL.executed} − ${savedCocoon} wasteful cocoon solves`);

  console.log('\n── v2 distribution ─────────────────────────────────────────');
  console.log(JSON.stringify(d, null, 2));

  console.log('\n── retro-diff vs actual population_run_2026-07-11 (MEASURED) ─');
  console.log(`  cocoon set (25): actual = ${ACTUAL.cocoon_run} run + ${ACTUAL.cocoon_skipped_midrun} skipped MID-RUN`);
  console.log(`                     v2   = ${cocoonSampled} sampled + ${cocoonSkipped} tagged skipped_correlated_set AT BUILD`);
  console.log(`                     Δ    = v2 eliminates ${savedCocoon} wasteful cocoon solves; zero mid-run surgery`);
  console.log(`  total solve-lane:  actual executed = ${ACTUAL.executed}   v2 = ${v2Solve}   Δ = ${v2Solve - ACTUAL.executed}`);
  console.log(`  r_mosaic (6):      actual = all 6 run   v2 = ${rmosaicEnum} enumerated (axis_varying: filter_band)`);
  console.log(`  oversize (4.49GB): actual = 1 skip      v2 = ${oversize.length} skipped_too_large`);
  console.log(`  carina60Da (${carina.length}):     actual budget = ${ACTUAL.carina_timeout_ms}ms (FITS wall, KILLED) → v2 = ${carina[0]?.timeout_ms}ms (${carina[0]?.timeout_class}, ${carina[0]?.timeout_provenance})`);

  console.log('\n── checks ──────────────────────────────────────────────────');
  let fails = 0;
  for (const c of checks) { if (!c.ok) fails++; console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: got ${c.got}, want ${c.want}${c.extra ? '  [' + c.extra + ']' : ''}`); }

  console.log(`\nVALIDATION: ${fails ? 'FAIL' : 'PASS'} (${checks.length - fails}/${checks.length} retro-targets reproduced)`);
  return fails ? 1 : 0;
}

const invokedDirect = (() => { try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return true; } })();
if (invokedDirect) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('[validate FATAL]', e); process.exit(1); });

export { main, ACTUAL };
