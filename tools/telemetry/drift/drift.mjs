#!/usr/bin/env node
// tools/telemetry/drift/drift.mjs
//
// R2 DRIFT INSTRUMENT v0 -- CLI. Builds the population baseline, runs the v0 drift
// queries, self-tests them by splitting the banked population, and emits the three
// banked deliverables. Pure node builtins, zero deps (no DuckDB needed at v0).
//
// Subcommands:
//   baseline   Build baseline_snapshot.json from the population (or a --filter subset).
//   selftest   Split the population and report what v0 drift flags (validation evidence).
//   report     (default) baseline + selftest + drift_summary.json + REPORT.md into --bank.
//
// Sources (LOCAL-ONLY -- verified present, never assumed; R2 is owner-gated & optional):
//   --db     <dir>   telemetry_db produced by the untracked ETL receipts_to_parquet.mjs
//                    (default D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db)
//   --pins   <file>  PINNED_REFERENCE_SOLVES.json (truth-anchored baseline)
//   --bank   <dir>   output dir (default test_results/drift_instrument_2026-07-21)
//
// Usage:
//   node tools/telemetry/drift/drift.mjs report
//   node tools/telemetry/drift/drift.mjs baseline --filter arm=m6
//   node tools/telemetry/drift/drift.mjs selftest --json

import fs from 'node:fs';
import path from 'node:path';
import {
  DRIFT_INSTRUMENT_VERSION, DEFAULT_DB, DEFAULT_PINS,
  loadPopulation, buildBaseline, compareBatch, loadPins,
  stratifiedHalfSplit, groupByDim, PROVISIONAL_TRIAGE_MARKERS, STRATUM_DIMS,
} from './drift_lib.mjs';

const REPO_ROOT = process.cwd();
const DEFAULT_BANK = path.join(REPO_ROOT, 'test_results/drift_instrument_2026-07-21');

function parseArgs(argv) {
  const a = { cmd: 'report', db: DEFAULT_DB, batchDb: null, pins: DEFAULT_PINS, bank: DEFAULT_BANK, receipts: null, batchReceipts: null, json: false, filter: {}, split: 'arm' };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('--')) a.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--db') a.db = rest[++i];
    else if (t === '--batch-db') a.batchDb = rest[++i];
    else if (t === '--pins') a.pins = rest[++i];
    else if (t === '--bank') a.bank = rest[++i];
    else if (t === '--receipts') a.receipts = rest[++i];
    else if (t === '--batch-receipts') a.batchReceipts = rest[++i];
    else if (t === '--json') a.json = true;
    else if (t === '--split') a.split = rest[++i];
    else if (t === '--filter') { const [k, v] = rest[++i].split('='); a.filter[k] = v; }
  }
  return a;
}

function applyFilter(rows, filter) {
  const keys = Object.keys(filter);
  if (!keys.length) return rows;
  return rows.filter((r) => keys.every((k) => String(r[k]) === filter[k]));
}

// Compact per-stratum digest for the dashboard artifact: outcome mix + a couple of
// headline metric medians. Full stats live in baseline_snapshot.json.
function compactStrata(baseline) {
  const out = {};
  for (const dim of ['arm', 'rig_class', 'truth_class']) {
    out[dim] = {};
    for (const [val, s] of Object.entries(baseline.strata[dim] || {})) {
      out[dim][val] = {
        n: s.n,
        solved_frac: s.outcome_mix.solved_flag.frac.solved || 0,
        verdict_counts: s.outcome_mix.truth_verdict.counts,
        median_wall_ms: s.metrics.wall_ms.median,
        median_accept_band: s.metrics.accept_band.median,
        median_n_matched: s.metrics.n_matched.median,
      };
    }
  }
  return out;
}

function selfTests(rows, pinsObj) {
  const tests = [];

  // --- Self-test A: stratified NULL split (both halves share arm composition) ---
  // Expectation: an instrument that does not cry wolf reports ~no candidates here.
  {
    const { A, B } = stratifiedHalfSplit(rows, 'arm', 42);
    const cmp = compareBatch(A, B, { pinsObj });
    tests.push({
      name: 'null_stratified_arm_split',
      design: 'Deterministic seeded 50/50 split within each arm; A=baseline, B=batch. Same population, same composition -> a genuine NULL. Validates the instrument does not false-alarm.',
      baseline_n: A.length, batch_n: B.length,
      n_numeric_candidates: cmp.candidates.n_numeric_candidates,
      n_outcome_candidates: cmp.candidates.n_outcome_candidates,             // binary solved_flag (powered)
      n_outcome_informational: cmp.candidates.n_outcome_informational,       // multi-category TVD (unpowered at N=47)
      n_pin_divergences: cmp.candidates.n_pin_divergences,                   // reference-core only
      n_pin_cross_arm_expected: cmp.candidates.n_pin_cross_arm_expected,
      top_numeric: cmp.candidates.numeric_top.slice(0, 5),
      top_outcome: cmp.candidates.outcome_top.slice(0, 5),
      pooled_wall_ms_drift: cmp.numeric_drift.ALL?.ALL?.find((m) => m.metric === 'wall_ms') || null,
      verdict: (cmp.candidates.n_outcome_candidates === 0 && (cmp.candidates.n_pin_divergences || 0) === 0)
        ? `PASS -- no powered false-alarm on a null split (binary-outcome candidates=0, reference-core pin divergences=0). Numeric candidates=${cmp.candidates.n_numeric_candidates} (small-N sampling residual, see note); multi-category outcome TVD movers=${cmp.candidates.n_outcome_informational} (informational -- positive null floor at N=47).`
        : `FLAGGED ${cmp.candidates.n_outcome_candidates} binary-outcome + ${cmp.candidates.n_pin_divergences} pin on a null split -- INVESTIGATE (unexpected powered false-alarm)`,
      _full: cmp,
    });
  }

  // --- Self-test B: POSITIVE CONTROL -- baseline arm m6 vs batch arm m6_bandmajor ---
  // m6 runs the full ladder after accept; m6_bandmajor aborts on accept. Expectation:
  // large, correctly-signed wall-time drift + outcome-mix shift. Validates DETECTION POWER.
  {
    const base = rows.filter((r) => r.arm === 'm6');
    const batch = rows.filter((r) => r.arm === 'm6_bandmajor');
    if (base.length && batch.length) {
      const cmp = compareBatch(base, batch, { pinsObj });
      const wall = cmp.numeric_drift.ALL.ALL.find((m) => m.metric === 'wall_ms');
      tests.push({
        name: 'positive_control_m6_vs_bandmajor',
        design: 'baseline=arm m6 (full ladder after accept), batch=arm m6_bandmajor (abort-on-accept). A real behavioural difference. Validates the instrument HAS detection power.',
        baseline_n: base.length, batch_n: batch.length,
        n_numeric_candidates: cmp.candidates.n_numeric_candidates,
        n_outcome_candidates: cmp.candidates.n_outcome_candidates,
        n_pin_divergences: cmp.candidates.n_pin_divergences,
        headline_wall_ms_drift: wall,
        top_numeric: cmp.candidates.numeric_top.slice(0, 6),
        top_outcome: cmp.candidates.outcome_top.slice(0, 4),
        verdict: (wall && wall.provisional_candidate)
          ? `DETECTED (wall_ms median ${wall.base_median} -> ${wall.batch_median} ms, ${wall.median_shift_iqr_units} IQR units, Cliff's ${wall.cliffs_delta} [${wall.cliffs_band}]) -- instrument has power`
          : 'NOT DETECTED (unexpected -- investigate)',
        _full: cmp,
      });
    }
  }

  // --- Self-test C: config-drift sentinel by git_commit (real "did a commit move it") ---
  {
    const commits = [...groupByDim(rows, 'git_commit_short').keys()];
    if (commits.length >= 2) {
      // baseline = the majority commit, batch = the other(s)
      const counts = new Map(commits.map((c) => [c, rows.filter((r) => r.git_commit_short === c).length]));
      const baseCommit = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const base = rows.filter((r) => r.git_commit_short === baseCommit);
      const batch = rows.filter((r) => r.git_commit_short !== baseCommit);
      const cmp = compareBatch(base, batch, { pinsObj });
      tests.push({
        name: 'config_sentinel_by_git_commit',
        design: `baseline=majority commit ${baseCommit} (n=${base.length}), batch=other commits (n=${batch.length}). NOTE: in this population the commit split ~coincides with the arm split, so drift here is CONFOUNDED with the arm behavioural difference -- reported as a sentinel demo, not a clean code-effect estimate.`,
        baseline_n: base.length, batch_n: batch.length,
        n_numeric_candidates: cmp.candidates.n_numeric_candidates,
        n_outcome_candidates: cmp.candidates.n_outcome_candidates,
        n_pin_divergences: cmp.candidates.n_pin_divergences,
        top_numeric: cmp.candidates.numeric_top.slice(0, 5),
        confound_note: 'commit split ~= arm split in this bank; interpret with the positive-control caveat',
        _full: cmp,
      });
    }
  }

  return tests;
}

function stripFull(tests) {
  return tests.map(({ _full, ...t }) => t);
}

function fmtNum(x) { return x == null ? '-' : String(x); }

function writeReport(bankDir, pop, baseline, tests, pinsObj) {
  const lines = [];
  const L = (s = '') => lines.push(s);
  L('# R2 Drift Instrument v0 -- Report');
  L('');
  L(`Instrument version: \`${DRIFT_INSTRUMENT_VERSION}\`  ·  Tier: **TEST/DEV** (R2 row schema NOT locked -- owner queue item)`);
  L(`Generated: ${new Date().toISOString()}`);
  L('');
  L('## What this is');
  L('');
  L('The owner descoped bit-identical solver pins to serious-regression tripwires (2026-07-21) on the premise that **R2 population telemetry becomes the systemic-drift instrument of record**. This is v0 of that instrument. It ingests the banked greenfield SolveReceipt population, builds baseline distributions stratified by rig / arm / truth-class / field-class, and given a new batch reports robust distribution shifts, outcome-mix deltas, and any receipt whose decision core diverges from its truth-anchored pin.');
  L('');
  L('**No calibrated constants.** v0 reports magnitudes and flags *candidates* only. The provisional triage markers used to sort the report (`|median-shift/IQR| >= ' + PROVISIONAL_TRIAGE_MARKERS.numeric_iqr_units_abs + '`, `|Cliff\'s delta| >= ' + PROVISIONAL_TRIAGE_MARKERS.numeric_cliffs_abs + '`, `outcome TVD >= ' + PROVISIONAL_TRIAGE_MARKERS.outcome_tvd + '`) are **NOT alert thresholds** -- real thresholds are an owner ruling later. No significance tests (no p-values) anywhere: every figure is an effect-size magnitude.');
  L('');
  L('## Population ingested');
  L('');
  L(`- Source: \`${pop.source}\` (${pop.source_path})`);
  L(`- Rows (one per SolveReceipt): **${pop.n}**`);
  L(`- solver_core_version(s): ${baseline.provenance.solver_core_versions.join(', ') || '-'}`);
  L(`- git_commit(s): ${baseline.provenance.git_commits.map((c) => c.slice(0, 8)).join(', ') || '-'}`);
  L(`- index_aggregate_md5(s): ${baseline.provenance.index_aggregate_md5s.map((c) => c.slice(0, 8)).join(', ') || '-'}`);
  L(`- arms: ${baseline.provenance.arms.join(', ') || '-'}`);
  if (pinsObj) L(`- truth-anchored pins: ${pinsObj.pins.length} (\`PINNED_REFERENCE_SOLVES.json\`)`);
  L('');
  L('## Strata found (baseline of record)');
  L('');
  for (const dim of ['arm', 'rig_class', 'truth_class', 'field_class']) {
    const s = baseline.strata[dim];
    if (!s) continue;
    L(`**${dim}**`);
    L('');
    L('| stratum | n | solved% | median wall_ms | median band | median matched |');
    L('|---|--:|--:|--:|--:|--:|');
    for (const [val, st] of Object.entries(s).sort()) {
      const solvedPct = Math.round((st.outcome_mix.solved_flag.frac.solved || 0) * 100);
      L(`| ${val} | ${st.n} | ${solvedPct}% | ${fmtNum(st.metrics.wall_ms.median)} | ${fmtNum(st.metrics.accept_band.median)} | ${fmtNum(st.metrics.n_matched.median)} |`);
    }
    L('');
  }
  L('## Self-test drift findings (validation evidence)');
  L('');
  L('The instrument is validated by splitting the banked population and reporting what v0 flags.');
  L('');
  for (const t of tests) {
    L(`### ${t.name}`);
    L('');
    L(t.design);
    L('');
    L(`- baseline_n=${t.baseline_n}  batch_n=${t.batch_n}`);
    L(`- numeric candidates: **${t.n_numeric_candidates}**  ·  outcome candidates: **${t.n_outcome_candidates}**  ·  pin divergences: **${fmtNum(t.n_pin_divergences)}**`);
    if (t.headline_wall_ms_drift) {
      const w = t.headline_wall_ms_drift;
      L(`- headline wall_ms: median ${w.base_median} -> ${w.batch_median} ms  (shift ${w.median_shift} ms; ${fmtNum(w.median_shift_iqr_units)} IQR units; Cliff's delta ${fmtNum(w.cliffs_delta)} [${fmtNum(w.cliffs_band)}])`);
    }
    if (t.pooled_wall_ms_drift) {
      const w = t.pooled_wall_ms_drift;
      L(`- pooled wall_ms: median ${w.base_median} -> ${w.batch_median} ms  (${fmtNum(w.median_shift_iqr_units)} IQR units; Cliff's ${fmtNum(w.cliffs_delta)} [${fmtNum(w.cliffs_band)}]; low_power=${w.low_power})`);
    }
    if (t.top_numeric && t.top_numeric.length) {
      L('- top numeric movers (concordant IQR-units + Cliff\'s):');
      for (const m of t.top_numeric.slice(0, 6)) L(`    - ${m.stratum_dim}=${m.stratum} · ${m.metric}: ${m.base_median} -> ${m.batch_median} (${fmtNum(m.median_shift_iqr_units)} IQR units, Cliff's ${fmtNum(m.cliffs_delta)} [${m.cliffs_band}], batch_n=${m.batch_n})`);
    }
    if (t.top_outcome && t.top_outcome.length) {
      L('- top binary-outcome movers (solved_flag):');
      for (const o of t.top_outcome.slice(0, 4)) L(`    - ${o.stratum_dim}=${o.stratum} · ${o.outcome_dim} TVD=${o.tvd} (batch_n=${o.batch_n})`);
    }
    L(`- **verdict: ${t.verdict || t.confound_note || '-'}**`);
    L('');
  }
  L('## Schema caveats');
  L('');
  L('- **R2 row schema is NOT locked** (owner queue item). Every column is either MEASURED from a receipt field or honest-null. Do not treat the flatten column set as stable.');
  L('- Ingest currently consumes the ETL-emitted `telemetry_db/solves.ndjson`. The ETL (`tools/telemetry/receipts_to_parquet.mjs`) is UNTRACKED working-tree code owned by the greenfield session; this instrument reads its output, does not own it. A thin raw-receipt fallback (`--receipts <dir>`) exists but projects only the drift subset.');
  L('- `field_class` is solve-conditional (derived from recovered scale); refusals fall in `unsolved`.');
  L('- The git_commit split ~coincides with the arm split in this bank, so a "code effect" cannot be cleanly separated from the arm behavioural difference at N=47. Flagged in self-test C.');
  L('- Parity sign is reported but never asserted (CLAUDE.md unit trap).');
  L('- **N is small (47).** Per-stratum drift power is limited; strata with batch_n < ' + PROVISIONAL_TRIAGE_MARKERS.min_batch_n_for_numeric + ' are marked `low_power` and never auto-flagged.');
  L('');
  L('## Rerun');
  L('');
  L('```');
  L('node tools/telemetry/drift/drift.mjs report');
  L('```');
  L('See `tools/telemetry/drift/README.md` for details.');
  L('');
  fs.writeFileSync(path.join(bankDir, 'REPORT.md'), lines.join('\n'));
}

function main() {
  const args = parseArgs(process.argv);
  const pop = loadPopulation({ db: args.db, receiptsDir: args.receipts });
  if (!pop.n) { console.error(`[drift] no population: ${pop.error || 'empty'}`); process.exit(1); }
  const rows = applyFilter(pop.rows, args.filter);
  const pinsObj = loadPins(args.pins);

  if (args.cmd === 'baseline') {
    const baseline = buildBaseline(rows, { pinsPath: args.pins });
    if (args.json) { console.log(JSON.stringify(baseline, null, 2)); return; }
    fs.mkdirSync(args.bank, { recursive: true });
    fs.writeFileSync(path.join(args.bank, 'baseline_snapshot.json'), JSON.stringify(baseline, null, 2));
    console.log(`[drift] baseline_snapshot.json written (${rows.length} rows, ${baseline.stratum_dims.length} dims) -> ${args.bank}`);
    return;
  }

  if (args.cmd === 'compare') {
    // Live-batch path: compare a NEW batch telemetry_db against this baseline population.
    if (!args.batchDb && !args.batchReceipts) { console.error('[drift] compare needs --batch-db <dir> (or --batch-receipts <dir>)'); process.exit(1); }
    const batchPop = loadPopulation({ db: args.batchDb || args.db, receiptsDir: args.batchReceipts });
    if (!batchPop.n) { console.error(`[drift] empty batch: ${batchPop.error || 'no rows'}`); process.exit(1); }
    const cmp = compareBatch(rows, batchPop.rows, { pinsObj });
    const summary = {
      drift_instrument_version: DRIFT_INSTRUMENT_VERSION, tier: 'TEST/DEV', generated_at: new Date().toISOString(),
      baseline: { n: rows.length, source: pop.source_path }, batch: { n: batchPop.n, source: batchPop.source_path },
      provisional_markers: cmp.candidates.markers,
      n_numeric_candidates: cmp.candidates.n_numeric_candidates,
      n_outcome_candidates: cmp.candidates.n_outcome_candidates,
      n_outcome_informational: cmp.candidates.n_outcome_informational,
      n_pin_divergences: cmp.candidates.n_pin_divergences,
      n_pin_cross_arm_expected: cmp.candidates.n_pin_cross_arm_expected,
      numeric_top: cmp.candidates.numeric_top, outcome_top: cmp.candidates.outcome_top,
      pin_divergences: cmp.pin_divergence.diverged,
    };
    if (args.json) { console.log(JSON.stringify(summary, null, 2)); return; }
    fs.mkdirSync(args.bank, { recursive: true });
    fs.writeFileSync(path.join(args.bank, 'drift_summary_batch.json'), JSON.stringify(summary, null, 2));
    console.log(`[drift] compare: baseline_n=${rows.length} batch_n=${batchPop.n} | numeric_cand=${summary.n_numeric_candidates} outcome_cand=${summary.n_outcome_candidates} pin_div=${summary.n_pin_divergences} (cross-arm-expected=${summary.n_pin_cross_arm_expected})`);
    console.log(`[drift] wrote drift_summary_batch.json -> ${args.bank}`);
    return;
  }

  if (args.cmd === 'selftest') {
    const tests = selfTests(rows, pinsObj);
    if (args.json) { console.log(JSON.stringify(stripFull(tests), null, 2)); return; }
    for (const t of tests) {
      console.log(`\n== ${t.name} ==\n${t.design}`);
      console.log(`baseline_n=${t.baseline_n} batch_n=${t.batch_n} | numeric_candidates=${t.n_numeric_candidates} outcome_candidates=${t.n_outcome_candidates} pin_divergences=${t.n_pin_divergences}`);
      console.log(`verdict: ${t.verdict || t.confound_note}`);
    }
    return;
  }

  // default: full report
  fs.mkdirSync(args.bank, { recursive: true });
  const baseline = buildBaseline(rows, { pinsPath: args.pins });
  const tests = selfTests(rows, pinsObj);

  // baseline snapshot
  fs.writeFileSync(path.join(args.bank, 'baseline_snapshot.json'), JSON.stringify(baseline, null, 2));

  // dashboard-ready drift summary
  const driftSummary = {
    drift_instrument_version: DRIFT_INSTRUMENT_VERSION,
    tier: 'TEST/DEV (R2 row schema NOT locked -- owner queue item)',
    generated_at: new Date().toISOString(),
    population: { n: pop.n, source: pop.source, provenance: baseline.provenance },
    provisional_markers: {
      _disclaimer: PROVISIONAL_TRIAGE_MARKERS._disclaimer,
      numeric_iqr_units_abs: PROVISIONAL_TRIAGE_MARKERS.numeric_iqr_units_abs,
      numeric_cliffs_abs: PROVISIONAL_TRIAGE_MARKERS.numeric_cliffs_abs,
      outcome_tvd: PROVISIONAL_TRIAGE_MARKERS.outcome_tvd,
      min_batch_n_for_numeric: PROVISIONAL_TRIAGE_MARKERS.min_batch_n_for_numeric,
    },
    baseline_of_record: {
      label: baseline.label,
      population_n: baseline.population_n,
      truth_anchored_pins: baseline.truth_anchored_pin_stratum,
      compact_strata: compactStrata(baseline),
    },
    self_tests: stripFull(tests).map((t) => ({
      name: t.name, design: t.design, baseline_n: t.baseline_n, batch_n: t.batch_n,
      n_numeric_candidates: t.n_numeric_candidates, n_outcome_candidates: t.n_outcome_candidates,
      n_pin_divergences: t.n_pin_divergences, verdict: t.verdict || t.confound_note,
      headline_wall_ms_drift: t.headline_wall_ms_drift || t.pooled_wall_ms_drift || null,
      top_numeric: t.top_numeric || [], top_outcome: t.top_outcome || [],
    })),
    latest_batch_vs_baseline: {
      _note: 'Slot reserved for a live batch. Populate via: node tools/telemetry/drift/drift.mjs compare (see README). Empty at v0 -- no live batch beyond the banked population.',
      status: 'EMPTY',
    },
    caveats: [
      'R2 row schema NOT locked (owner queue item) -- columns are TEST/DEV.',
      'N=47 banked receipts -- per-stratum drift power is limited; low_power strata are never auto-flagged.',
      'git_commit split ~= arm split in this bank -> code effect confounded with arm behaviour.',
      'Provisional triage markers are NOT calibrated alert thresholds -- owner ruling pending.',
      'Cliff\'s-delta bands are conventional literature descriptors (Romano 2006), not gates.',
    ],
  };
  fs.writeFileSync(path.join(args.bank, 'drift_summary.json'), JSON.stringify(driftSummary, null, 2));

  writeReport(args.bank, pop, baseline, stripFull(tests), pinsObj);

  console.log(`[drift] population=${pop.n} rows (${pop.source})`);
  for (const t of tests) console.log(`[drift] ${t.name}: numeric_cand=${t.n_numeric_candidates} outcome_cand=${t.n_outcome_candidates} pin_div=${t.n_pin_divergences} -> ${(t.verdict || t.confound_note || '').slice(0, 80)}`);
  console.log(`[drift] wrote baseline_snapshot.json, drift_summary.json, REPORT.md -> ${args.bank}`);
}

main();
