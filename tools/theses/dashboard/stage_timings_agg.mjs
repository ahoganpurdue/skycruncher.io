#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/stage_timings_agg.mjs — POPULATION STAGE-TIMING aggregator
// ============================================================================
// Reads the per-frame stage-timing ledger a population run appends
//   (test_results/perf/stage_timings.jsonl — one JSON object per line,
//    schema v1: {ts, source, run_id, frame_sha, source_format, decoder_arm,
//                ok, n_stages, total_ms, stages:{<stage>: <ms>}})
// and emits a compact, per-stage summary the dashboard's Timings tab renders.
//
// HONESTY (LAW 3):
//   • No population data on disk → the tool still emits a well-formed envelope
//     with runs.total = 0 and stages: []; the UI renders "no population run
//     data yet". Never a fabricated row.
//   • decoder arms (rawler / libraw) have very different cost profiles, so the
//     arm mix is ALWAYS surfaced (by_arm counts + per-arm total_ms p50); overall
//     stage stats are computed across every run that reported the stage, with the
//     arm mix disclosed so a reader never mistakes a mixed pool for one arm.
//   • Each stage carries its OWN n (count of runs that reported it) — a stage
//     absent from some runs is honest about how many it was measured on.
//
// This tool is READ-ONLY on the ledger and writes ONLY the summary it is told to
// (stdout by default, or --out FILE). It never edits source, docs, the registry,
// or .dashboard_token.
//
// CLI: node tools/theses/dashboard/stage_timings_agg.mjs
//        [--in FILE] [--out FILE] [--self-test] [--help]
//   Wiring: --out test_results/theses/dashboard/stage_timings.json makes the
//   summary available at /data/stage_timings.json via the server's existing
//   generic /data/<name>.json passthrough — NO serve.mjs change/restart needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');
// test_results/ is gitignored/local — absent in a worktree; fall back to MAIN.
const MAIN_REPO = process.env.SKYCRUNCHER_MAIN_CHECKOUT || DEFAULT_REPO;
const LEDGER_REL = path.join('test_results', 'perf', 'stage_timings.jsonl');
export const SCHEMA = 'stage-timings/1';

// --- pure stats -------------------------------------------------------------
export function percentile(sortedAsc, q) {
  const a = sortedAsc;
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const idx = q * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
export function summarize(values) {
  const nums = values.filter((v) => typeof v === 'number' && isFinite(v)).sort((x, y) => x - y);
  if (!nums.length) return { n: 0, p50: null, mean: null, p95: null, min: null, max: null, sum: 0 };
  const sum = nums.reduce((s, v) => s + v, 0);
  return {
    n: nums.length,
    p50: round1(percentile(nums, 0.5)),
    mean: round1(sum / nums.length),
    p95: round1(percentile(nums, 0.95)),
    min: round1(nums[0]),
    max: round1(nums[nums.length - 1]),
    sum: round1(sum),
  };
}

// --- parse ------------------------------------------------------------------
export function parseJsonl(raw) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch { /* skip corrupt line — never fabricated */ }
  }
  return out;
}

// --- aggregate (pure) -------------------------------------------------------
// records: array of stage-timing objects. Returns the summary envelope.
export function aggregate(records, opts = {}) {
  const generatedAt = opts.now || new Date().toISOString();
  const recs = Array.isArray(records) ? records : [];
  const okRecs = recs.filter((r) => r && r.ok !== false);
  const failed = recs.length - okRecs.length;

  const byArm = {}, byFormat = {};
  const armTotals = {}; // arm -> [total_ms]
  const totals = [];
  const tsList = [];
  const stageBuckets = new Map(); // stageName -> number[]
  const stageOrder = [];          // first-seen order across the population

  for (const r of recs) {
    const arm = r.decoder_arm == null ? 'unknown' : String(r.decoder_arm);
    const fmt = r.source_format == null ? 'unknown' : String(r.source_format);
    byArm[arm] = (byArm[arm] || 0) + 1;
    byFormat[fmt] = (byFormat[fmt] || 0) + 1;
    if (typeof r.ts === 'string') tsList.push(r.ts);
    if (typeof r.total_ms === 'number' && isFinite(r.total_ms)) {
      totals.push(r.total_ms);
      (armTotals[arm] = armTotals[arm] || []).push(r.total_ms);
    }
    const stages = (r && r.stages && typeof r.stages === 'object') ? r.stages : {};
    for (const [name, ms] of Object.entries(stages)) {
      if (typeof ms !== 'number' || !isFinite(ms)) continue;
      if (!stageBuckets.has(name)) { stageBuckets.set(name, []); stageOrder.push(name); }
      stageBuckets.get(name).push(ms);
    }
  }

  const totalSummary = summarize(totals);
  const stages = stageOrder.map((name) => {
    const s = summarize(stageBuckets.get(name));
    // share of the mean total the stage's mean represents (context, honest label).
    const share = (s.mean != null && totalSummary.mean) ? round1((s.mean / totalSummary.mean) * 100) : null;
    return { name, ...s, share_pct: share };
  }).sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1));

  const perArm = Object.keys(armTotals).sort().map((arm) => ({ arm, count: byArm[arm], total_ms: summarize(armTotals[arm]) }));

  tsList.sort();
  return {
    generated_at: generatedAt,
    schema: SCHEMA,
    source_file: opts.sourceLabel || LEDGER_REL.replace(/\\/g, '/'),
    runs: { total: recs.length, ok: okRecs.length, failed },
    window: { first_ts: tsList[0] || null, last_ts: tsList[tsList.length - 1] || null },
    by_arm: byArm,
    by_format: byFormat,
    per_arm_total_ms: perArm,
    total_ms: totalSummary,
    stages,
  };
}

// --- IO ---------------------------------------------------------------------
function resolveIn(opts) {
  if (opts.in) return opts.in;
  const here = path.join(DEFAULT_REPO, LEDGER_REL);
  if (fs.existsSync(here)) return here;
  return path.join(MAIN_REPO, LEDGER_REL);
}

function run(opts) {
  const inPath = resolveIn(opts);
  let records = [];
  let sourceLabel = LEDGER_REL.replace(/\\/g, '/');
  if (fs.existsSync(inPath)) {
    records = parseJsonl(fs.readFileSync(inPath, 'utf8'));
    sourceLabel = inPath.replace(/\\/g, '/');
  }
  const env = aggregate(records, { sourceLabel });
  const json = JSON.stringify(env, null, 2) + '\n';
  if (opts.out) {
    fs.writeFileSync(opts.out, json);
    console.log(`stage-timings summary → ${opts.out}  (${env.runs.total} runs, ${env.stages.length} stages)`);
  } else {
    process.stdout.write(json);
  }
}

// --- self-test --------------------------------------------------------------
function selfTest() {
  const checks = [];
  const assert = (name, cond) => checks.push({ name, ok: !!cond });

  assert('percentile median odd', percentile([1, 2, 3], 0.5) === 2);
  assert('percentile p95 clamps to max', percentile([1, 2, 3, 4], 1) === 4);
  assert('percentile empty null', percentile([], 0.5) === null);
  const s = summarize([10, 20, 30, 40]);
  assert('summarize n', s.n === 4);
  assert('summarize mean', s.mean === 25);
  assert('summarize max', s.max === 40);
  assert('summarize p50', s.p50 === 25);
  assert('summarize drops non-numbers', summarize([1, 'x', null, 3]).n === 2);
  assert('parseJsonl skips corrupt', parseJsonl('{"a":1}\nGARBAGE\n{"a":2}').length === 2);

  const recs = [
    { ts: '2026-07-11T16:41:27Z', ok: true, source_format: 'FITS', decoder_arm: 'rawler', total_ms: 100, stages: { extract: 60, solve: 30, integrate: 10 } },
    { ts: '2026-07-11T16:41:29Z', ok: true, source_format: 'FITS', decoder_arm: 'rawler', total_ms: 200, stages: { extract: 120, solve: 60, integrate: 20 } },
    { ts: '2026-07-11T16:41:32Z', ok: false, source_format: 'CR2', decoder_arm: 'libraw', total_ms: 500, stages: { extract: 400 } },
  ];
  const env = aggregate(recs, { now: 'T', sourceLabel: 'x.jsonl' });
  assert('schema id', env.schema === 'stage-timings/1');
  assert('runs total', env.runs.total === 3);
  assert('runs ok', env.runs.ok === 2);
  assert('runs failed', env.runs.failed === 1);
  assert('by_arm split', env.by_arm.rawler === 2 && env.by_arm.libraw === 1);
  assert('by_format split', env.by_format.FITS === 2 && env.by_format.CR2 === 1);
  assert('window bounds', env.window.first_ts === '2026-07-11T16:41:27Z' && env.window.last_ts === '2026-07-11T16:41:32Z');
  const extract = env.stages.find((x) => x.name === 'extract');
  assert('extract counts all 3 runs', extract.n === 3);           // present on every run incl. failed
  assert('extract is largest (sorted first)', env.stages[0].name === 'extract');
  const solve = env.stages.find((x) => x.name === 'solve');
  assert('solve n = 2 (absent on failed run)', solve.n === 2);    // per-stage own n
  assert('total_ms mean over all (rounded 1dp)', env.total_ms.mean === 266.7); // (100+200+500)/3 = 266.66… → 266.7
  assert('per_arm has both arms', env.per_arm_total_ms.length === 2);
  const empty = aggregate([], { now: 'T' });
  assert('empty envelope well-formed', empty.runs.total === 0 && Array.isArray(empty.stages) && empty.stages.length === 0);
  assert('empty total null', empty.total_ms.p50 === null);

  let pass = 0;
  for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`); if (c.ok) pass++; }
  console.log(`\nself-test: ${pass}/${checks.length} passed`);
  return pass === checks.length;
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--in') o.in = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/theses/dashboard/stage_timings_agg.mjs [--in FILE] [--out FILE] [--self-test]');
  console.log('  default: reads test_results/perf/stage_timings.jsonl, prints summary JSON to stdout.');
  console.log('  --out test_results/theses/dashboard/stage_timings.json → served at /data/stage_timings.json (no restart).');
  process.exit(0);
} else if (opts.selfTest) {
  process.exit(selfTest() ? 0 : 1);
} else {
  run(opts);
}
