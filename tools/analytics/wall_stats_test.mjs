#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/wall_stats_test.mjs — self-test for the wall-clock analytics.
// Plain-assert, vitest-free, node-runnable (tools-lane idiom, matches
// corpus_test.mjs / deposit_test.mjs). Named `*_test.mjs` (underscore) NOT
// `*.test.mjs` DELIBERATELY — the dot form is swept by vitest and would break the
// `npx vitest run` gate. Run standalone:  node tools/analytics/wall_stats_test.mjs
//
// Covers, on synthetic frame records (no disk, no real corpus):
//   · extractTimingRows: top-level vs dotted sub-stage split (no double-count) ·
//     skipped/zero-wall → ran:false · assisted-lane format inferred from filename
//   · stageAggregation: medians + honest denominators (solved-only) + blind-only
//     "ran without stage decomposition" gap
//   · solveWallDecomposition: share math + its stated pipeline denominator
//   · blindVsAssisted: sha-paired blind→assisted speedup (the cocoon story)
//   · savingsProjection labelling: opt-in absence · projection:true + inputs +
//     formula math · distinct-frame collapse · assisted-wall override ·
//     honest NOT-MEASURED when no assisted data
//   · runWallTrends: not-run excluded from wall summary
//   · determinism: computeWallStats double-run byte-identical
// ═══════════════════════════════════════════════════════════════════════════

import {
  extractTimingRows, stageAggregation, solveWallDecomposition,
  blindVsAssisted, savingsProjection, runWallTrends, computeWallStats,
} from './wall_stats.mjs';
import { stableStringify } from './lib/corpus.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function approx(a, b, msg, tol = 1e-6) { ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg}  (got ${a}, want ~${b})`); }

// ── synthetic frame-record builders (match the corpus core's record shape) ────
const lrow = (o) => ({ __ledger: 'pop.jsonl', ...o });
const rrow = (o) => ({ __ledger: 'rerun.jsonl', ...o });
const erow = (o) => ({ __envelope: 'env.jsonl', ...o });
function frame(o) {
  return {
    key: o.key, id: o.id, sha: o.sha || null,
    kind: o.kind || 'solved', solve_class: o.solve_class || 'blind',
    has_assisted_solve: !!(o.envelope_rows || []).some((e) => e.outcome === 'solved'),
    ledger_rows: o.ledger_rows || [], envelope_rows: o.envelope_rows || [],
  };
}

// S1 / S2 — FITS blind solved WITH per-stage decomposition.
//   S1: solve 400 of pipeline 800 → 0.500 ;  S2: solve 600 of pipeline 800 → 0.750
const S1 = frame({ key: 'sha:s1', id: 's1', sha: 's1',
  ledger_rows: [lrow({ id: 's1', resolved_outcome: 'solved', format: 'FITS', wall_ms: 1000, pipeline_ms: 800, total_ms: 800,
    stages: { load: 10, extract: 200, solve: 400, 'solve.uw_sweep': 100, calibrate: 190 } })] });
const S2 = frame({ key: 'sha:s2', id: 's2', sha: 's2',
  ledger_rows: [lrow({ id: 's2', resolved_outcome: 'solved', format: 'FITS', wall_ms: 1000, pipeline_ms: 800, total_ms: 800,
    stages: { load: 20, extract: 100, solve: 600, calibrate: 80 } })] });
// C1 — CR2 blind FAILED (twice: population + rerun) then ASSISTED solved. sha-paired.
const C1 = frame({ key: 'sha:c1', id: 'c1', sha: 'c1', kind: 'assisted', solve_class: 'assisted',
  ledger_rows: [
    lrow({ id: 'c1', resolved_outcome: 'no_solve', format: 'CR2', wall_ms: 200000 }),
    rrow({ id: 'c1', outcome: 'no_solve', format: 'CR2', wall_ms: 190000 }),
  ],
  envelope_rows: [erow({ outcome: 'solved', wall_ms: 10000, run_label: 'HINTED', frame_basename: 'c1.CR2' })] });
// SK — CR2 skipped (DID-NOT-RUN, wall 0). Must be excluded from wall distributions.
const SK = frame({ key: 'sha:sk', id: 'sk', sha: 'sk', kind: 'no_solve',
  ledger_rows: [lrow({ id: 'sk', resolved_outcome: 'skipped_correlated_set', format: 'CR2', wall_ms: 0 })] });
// RUN — FITS blind no_solve that RAN but carries NO stages (the honest gap).
const RUN = frame({ key: 'sha:run', id: 'run', sha: 'run', kind: 'no_solve',
  ledger_rows: [rrow({ id: 'run', outcome: 'no_solve', format: 'FITS', wall_ms: 5000 })] });

const FRAMES = [S1, S2, C1, SK, RUN];
const rows = extractTimingRows(FRAMES);

// ── T1 extractTimingRows: top vs sub split, ran flags, format inference ───────
const s1rows = rows.filter((r) => r.id === 's1');
eq(s1rows.length, 1, 'T1 s1 → one blind row');
eq(s1rows[0].top_stages.solve, 400, 'T1 top_stages.solve present');
ok(!('solve.uw_sweep' in s1rows[0].top_stages), 'T1 dotted stage NOT in top_stages (no double-count)');
eq(s1rows[0].sub_stages['solve.uw_sweep'], 100, 'T1 dotted stage in sub_stages');
eq(s1rows[0].ran, true, 'T1 solved row ran');
eq(s1rows[0].has_stages, true, 'T1 solved row has_stages');
const skrow = rows.find((r) => r.id === 'sk');
eq(skrow.ran, false, 'T1 skipped/zero-wall row ran:false');
const envRow = rows.find((r) => r.lane === 'assisted');
eq(envRow.format, 'CR2', 'T1 assisted format inferred from frame_basename ext');
eq(envRow.ran, true, 'T1 assisted solved row ran');
eq(rows.length, 7, 'T1 total timing rows (S1,S2 blind + C1 2-blind+1-assisted + SK blind + RUN blind)');

// ── T2 stageAggregation: medians + honest denominators ────────────────────────
const agg = stageAggregation(rows);
eq(agg.frames_with_stage_decomposition, 2, 'T2 only S1,S2 carry a stage decomposition');
eq(agg.ran_without_stage_decomposition, 3, 'T2 blind-only ran-no-stages gap = C1(2 blind) + RUN (assisted excluded)');
eq(agg.overall.top_level_stages.solve.median, 500, 'T2 overall solve median = median(400,600)');
eq(agg.overall.top_level_stages.solve.n, 2, 'T2 overall solve n=2');
eq(agg.by_format.FITS.top_level_stages.solve.median, 500, 'T2 FITS solve median');
ok(/ONLY for solved frames/.test(agg.note), 'T2 note states solved-only denominator');
ok('solve.uw_sweep' in agg.overall.sub_stages, 'T2 sub_stages reported separately');

// ── T3 solveWallDecomposition: share math + stated denominator ────────────────
const dec = solveWallDecomposition(rows);
eq(dec.denominator.basis, 'pipeline_ms', 'T3 denominator basis stated');
eq(dec.denominator.frames, 2, 'T3 denominator frame count');
eq(dec.overall.solve_ms, 1000, 'T3 Σ solve = 400+600');
eq(dec.overall.pipeline_ms, 1600, 'T3 Σ pipeline = 800+800');
approx(dec.overall.solve_share_of_pipeline, 0.625, 'T3 solve share of pipeline = 1000/1600');
approx(dec.by_format.FITS.solve_share_of_pipeline, 0.625, 'T3 FITS solve share');
eq(dec.per_frame_solve_share_of_pipeline.median, 0.625, 'T3 per-frame share median = median(0.5,0.75)');

// ── T4 blindVsAssisted: sha-paired speedup (the cocoon story) ─────────────────
const bva = blindVsAssisted(FRAMES);
eq(bva.paired_frames, 1, 'T4 only C1 pairs (blind ran + assisted solved)');
eq(bva.blind_wall_ms.mean, 195000, 'T4 blind per-frame mean = mean(200000,190000)');
eq(bva.assisted_wall_ms.mean, 10000, 'T4 assisted mean');
eq(bva.speedup_median, 19.5, 'T4 speedup = 195000/10000');
eq(bva.per_frame[0].id, 'c1', 'T4 per-frame row present');
eq(bva.per_frame[0].blind_attempts, 2, 'T4 per-frame counts both blind attempts');

// ── T5 savingsProjection: labelling + math + honest absence ───────────────────
// (a) opt-in absence
const none = savingsProjection(rows, null);
eq(none.requested, false, 'T5a no lever → requested:false');
ok(!('projection' in none), 'T5a no lever → no projection field');
// (b) projection with measured A (median assisted = 10000). failing rows: C1x2 + RUN;
//     distinct frames: C1 (mean 195000) + RUN (5000) → baseline 200000.
const proj = savingsProjection(rows, { assisted_fraction: 0.5 });
eq(proj.projection, true, 'T5b projection:true');
ok(/PROJECTION/.test(proj.label), 'T5b label says PROJECTION');
eq(proj.inputs.assisted_wall_ms, 10000, 'T5b measured assisted median A=10000');
ok(/measured:median/.test(proj.inputs.assisted_wall_ms_source), 'T5b A source = measured median');
eq(proj.inputs.modelled_frames, 2, 'T5b distinct modelled frames (C1,RUN)');
eq(proj.inputs.blind_failing_attempts, 3, 'T5b blind failing attempts (C1x2 + RUN)');
eq(proj.inputs.baseline_wall_ms, 200000, 'T5b baseline = 195000 + 5000');
eq(proj.projected_wall_ms, 110000, 'T5b projected = 0.5*(195000+5000) + 2*0.5*10000');
eq(proj.projected_savings_ms, 90000, 'T5b savings = baseline - projected');
approx(proj.projected_savings_fraction, 0.45, 'T5b savings fraction = 90000/200000');
// (c) assisted-wall override respected
const projO = savingsProjection(rows, { assisted_fraction: 0.5, assisted_wall_ms: 20000 });
eq(projO.inputs.assisted_wall_ms, 20000, 'T5c override A=20000');
ok(/override/.test(projO.inputs.assisted_wall_ms_source), 'T5c A source = override');
eq(projO.projected_wall_ms, 120000, 'T5c projected with A=20000 = (97500+10000)+(2500+10000)');
// (d) honest NOT-MEASURED when no assisted data and no override
const noAsstRows = extractTimingRows([S1, S2, RUN]); // no envelope rows anywhere
const projN = savingsProjection(noAsstRows, { assisted_fraction: 0.5 });
eq(projN.projection, false, 'T5d no assisted + no override → projection:false');
ok(/NOT MEASURED/.test(projN.reason), 'T5d reason says NOT MEASURED');

// ── T6 runWallTrends: not-run excluded from wall summary ──────────────────────
const trends = runWallTrends(rows);
ok('HINTED' in trends.by_run, 'T6 assisted run_label keys its own run');
eq(trends.by_run['HINTED'].wall_ms.median, 10000, 'T6 HINTED wall median');
const pop = trends.by_run['pop.jsonl'];
eq(pop.not_run, 1, 'T6 pop run counts the skipped row as not_run');
ok(!pop.wall_ms || pop.wall_ms.n === 3, 'T6 pop wall summary excludes the not-run row (S1,S2,C1-blind = 3)');

// ── T7 determinism: computeWallStats double-run byte-identical ────────────────
const loaded = { frames: FRAMES };
const spec = { format: null, savings: { assisted_fraction: 0.5 } };
const d1 = stableStringify(computeWallStats(loaded, spec));
const d2 = stableStringify(computeWallStats(loaded, spec));
eq(d1, d2, 'T7 computeWallStats is deterministic (byte-identical)');

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\nwall_stats_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
