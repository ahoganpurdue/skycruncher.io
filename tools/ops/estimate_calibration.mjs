#!/usr/bin/env node
// estimate_calibration.mjs — REPORT-ONLY agent-time calibration.
//
// Reads two ground-truth sources and computes per-class calibration factors:
//   A) test_results/agent_runs.jsonl  — SubagentStop hook rows, keyed by the
//      machine field `agent_type`, carrying real `duration_s`. Absolute actuals.
//   B) docs/AGENT_TIMING_LOG.md        — the manual est-vs-actual ledger. Yields
//      Δ = actual ÷ estimate (the doc's own stated invariant), keyword-bucketed
//      by the free-text task title. Robust to the column drift in the table
//      (recent rows shifted est/act/Δ left by two columns) via an identity-scored
//      two-mapping parse.
//
// Output: a calibration table + a SUGGESTED CLAUDE.md budget-line replacement.
// It NEVER edits CLAUDE.md or any source (constant changes are orchestrator-only).
//
// CLI:  node tools/ops/estimate_calibration.mjs [--root DIR] [--runs FILE]
//                                               [--timing FILE] [--json] [--self-test]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
// agent_runs.jsonl is gitignored/local — lives only in the MAIN repo, never in a worktree.
const MAIN_REPO = process.env.SKYCRUNCHER_MAIN_CHECKOUT || DEFAULT_ROOT;

// The 5 canonical budget classes from CLAUDE.md + measured-only extras.
const CLASSES = ['scout', 'audit', 'verification', 'code-wave', 'sweep'];
const EXTRA_CLASSES = ['gate', 'research', 'other'];

// current CLAUDE.md budget line, for the comparison column
const CURRENT_BUDGET = {
  scout: 4, audit: 10, verification: 15, 'code-wave': 45, sweep: 20 /* tool wall + 10 */,
};

// --- agent_type (machine field) -> class ------------------------------------
function agentTypeToClass(t) {
  switch (t) {
    case 'scout': return 'scout';
    case 'auditor': case 'auditor-sonnet': case 'auditor-haiku': return 'audit';
    case 'surgeon': return 'code-wave';
    case 'measurer': return 'sweep';
    case 'gatekeeper': return 'gate';
    case 'researcher': return 'research';
    default: return 'other';
  }
}

// --- timing-log title (free text) -> class ----------------------------------
const TITLE_RULES = [
  ['scout', /\bscout\b|\blocate\b|\bwhere is\b/i],
  ['verification', /false.positive|pressure.test|falsif|\bchase\b|adversar/i],
  ['code-wave', /surgeon|implement|\bwire\b|\bport\b|refactor|merge|\bfix\b|\bcode\b|\bbuild\b/i],
  ['sweep', /sweep|gauntlet|corpus|benchmark|measurer|\bmeasure\b|forced.?photom|\bA\/B\b/i],
  ['audit', /audit|\breview\b|inventory|\bmap\b|distill|reconcile|extract|\bscan\b|verif|\bconfirm\b|research|seam/i],
];
function titleToClass(title) {
  for (const [cls, re] of TITLE_RULES) if (re.test(title)) return cls;
  return 'UNCLASSIFIED';
}

// --- numeric cell parse (handles **bold**, ≈, ~, ranges, wall, n/a) ----------
export function parseNum(cell) {
  if (cell == null) return null;
  let s = String(cell).replace(/\*\*|`|≈|⚠|✅|~|×/g, '').replace(/\b(min|wall)\b/gi, '').replace(/,/g, '').trim();
  if (s === '' || /^(n\/a|—|-|\?|tbd)$/i.test(s)) return null;
  const range = s.match(/^(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)$/);
  if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// --- robust est/act/Δ recovery from one table row ---------------------------
// Returns {est, act, delta, title} or null. Uses two candidate column mappings
// and scores each by the Δ = act/est identity (self-validating against drift).
export function parseTimingRow(line) {
  const c = line.split('|').map((x) => x.trim());
  if (!/^\d+$/.test(c[1] || '')) return null;
  const title = c[3] || '';
  const mappings = [
    { est: parseNum(c[6]), act: parseNum(c[7]), deltaCell: parseNum(c[8]) }, // header/original
    { est: parseNum(c[4]), act: parseNum(c[6]), deltaCell: parseNum(c[7]) }, // shifted/recent
  ];
  let best = null, bestScore = -Infinity;
  for (const m of mappings) {
    if (!(m.est > 0) || !(m.act > 0)) continue;
    const computed = m.act / m.est;
    let score = 1;
    if (m.deltaCell != null && Math.abs(m.deltaCell - computed) / computed < 0.2) score += 2;
    if (computed >= 0.05 && computed <= 20) score += 0.5; else score -= 1;
    if (score > bestScore) { bestScore = score; best = { est: m.est, act: m.act, delta: computed }; }
  }
  if (!best || bestScore < 1) return null;
  return { ...best, title };
}

// --- stats helpers ----------------------------------------------------------
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// --- load sources -----------------------------------------------------------
function loadRuns(file) {
  const byClass = {}; // class -> [minutes]
  const byType = {};   // agent_type -> [minutes]
  if (!file || !fs.existsSync(file)) return { byClass, byType, present: false, n: 0 };
  let n = 0;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (typeof o.duration_s !== 'number' || o.duration_s <= 0) continue;
      const mins = o.duration_s / 60;
      const t = o.agent_type || '(none)';
      const cls = agentTypeToClass(t);
      (byType[t] = byType[t] || []).push(mins);
      (byClass[cls] = byClass[cls] || []).push(mins);
      n++;
    } catch { /* skip */ }
  }
  return { byClass, byType, present: true, n };
}

function loadTiming(file) {
  const byClass = {}; // class -> [{delta, act, est}]
  if (!file || !fs.existsSync(file)) return { byClass, present: false, rows: 0, parsed: 0 };
  let rows = 0, parsed = 0;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(l)) continue;
    rows++;
    const p = parseTimingRow(l);
    if (!p) continue;
    parsed++;
    const cls = titleToClass(p.title);
    (byClass[cls] = byClass[cls] || []).push({ delta: p.delta, act: p.act, est: p.est });
  }
  return { byClass, present: true, rows, parsed };
}

// --- build calibration table ------------------------------------------------
function buildTable(runs, timing) {
  const table = [];
  for (const cls of [...CLASSES, ...EXTRA_CLASSES]) {
    const tRows = timing.byClass[cls] || [];
    const deltas = tRows.map((r) => r.delta);
    const tActuals = tRows.map((r) => r.act);
    const rMins = runs.byClass[cls] || [];
    const medDelta = median(deltas);
    const medRunActual = median(rMins);
    const medTimingActual = median(tActuals);
    // Suggested budget: prefer the hook-measured absolute median (largest,
    // cleanest sample); fall back to the timing-log actual median.
    const suggested = r1(medRunActual != null ? medRunActual : medTimingActual);
    table.push({
      class: cls,
      timing_n: tRows.length,
      median_delta: r1(medDelta),           // actual ÷ estimate (< 1 = over-budgeted)
      mean_delta: r1(mean(deltas)),
      runs_n: rMins.length,
      median_actual_min: r1(medRunActual),  // hook wall-clock
      timing_actual_min: r1(medTimingActual),
      current_budget_min: CURRENT_BUDGET[cls] ?? null,
      suggested_budget_min: suggested,
    });
  }
  return table;
}

function suggestBudgetLine(table) {
  const g = (c) => table.find((r) => r.class === c);
  const fmt = (c, label) => {
    const r = g(c);
    const v = r && r.suggested_budget_min != null ? r.suggested_budget_min : '?';
    return `${label} ~${v}min`;
  };
  const totalRuns = table.reduce((s, r) => s + r.runs_n, 0);
  return (
    `Calibrated estimates (measured from ${totalRuns} hook runs + timing ledger; ` +
    `Δ=actual÷est medians below): ` +
    [
      fmt('scout', 'scout'),
      fmt('audit', 'audit'),
      fmt('verification', 'verification/false-positive chase'),
      fmt('code-wave', 'code wave'),
      fmt('sweep', 'sweep'),
    ].join(' · ') +
    `. (gatekeeper ~${g('gate')?.suggested_budget_min ?? '?'}min · researcher ~${g('research')?.suggested_budget_min ?? '?'}min.)`
  );
}

// --- render -----------------------------------------------------------------
function printReport(res) {
  const { table, meta } = res;
  console.log('estimate-calibration — REPORT ONLY (does not edit CLAUDE.md)');
  console.log(`agent_runs.jsonl: ${meta.runsPresent ? meta.runsN + ' timed runs' : 'ABSENT'}  (${meta.runsFile})`);
  console.log(`AGENT_TIMING_LOG.md: ${meta.timingPresent ? meta.timingParsed + '/' + meta.timingRows + ' rows parsed' : 'ABSENT'}  (${meta.timingFile})`);
  console.log('');
  const cols = [
    ['class', 14], ['tlog_n', 7], ['medΔ', 6], ['meanΔ', 7],
    ['runs_n', 7], ['med_act', 8], ['tlog_act', 9], ['cur_bud', 8], ['SUGGEST', 8],
  ];
  console.log(cols.map(([h, w]) => h.padEnd(w)).join(''));
  console.log(cols.map(([, w]) => '-'.repeat(w - 1).padEnd(w)).join(''));
  for (const r of table) {
    const cells = [
      r.class, r.timing_n, r.median_delta ?? '·', r.mean_delta ?? '·',
      r.runs_n, r.median_actual_min ?? '·', r.timing_actual_min ?? '·',
      r.current_budget_min ?? '·', r.suggested_budget_min ?? '·',
    ];
    console.log(cells.map((v, i) => String(v).padEnd(cols[i][1])).join(''));
  }
  console.log('\nΔ = actual ÷ estimate. Δ<1 means agents finish UNDER estimate (over-budgeted).');
  console.log('\nSuggested CLAUDE.md budget-line replacement (orchestrator applies; report-only):');
  console.log('  ' + meta.suggestion);
}

function run(opts) {
  const root = opts.root || DEFAULT_ROOT;
  const runsFile = opts.runs || path.join(root, 'test_results', 'agent_runs.jsonl');
  // if the resolved runs file is missing (e.g. worktree), fall back to the main repo
  const runsResolved = fs.existsSync(runsFile) ? runsFile : path.join(MAIN_REPO, 'test_results', 'agent_runs.jsonl');
  const timingFile = opts.timing || path.join(root, 'docs', 'AGENT_TIMING_LOG.md');
  const timingResolved = fs.existsSync(timingFile) ? timingFile : path.join(MAIN_REPO, 'docs', 'AGENT_TIMING_LOG.md');

  const runs = loadRuns(runsResolved);
  const timing = loadTiming(timingResolved);
  const table = buildTable(runs, timing);
  const suggestion = suggestBudgetLine(table);
  return {
    table,
    meta: {
      runsFile: runsResolved, runsPresent: runs.present, runsN: runs.n,
      timingFile: timingResolved, timingPresent: timing.present, timingRows: timing.rows, timingParsed: timing.parsed,
      suggestion,
    },
    byType: runs.byType,
  };
}

// --- self-test --------------------------------------------------------------
function selfTest() {
  const checks = [];
  const assert = (name, cond) => checks.push({ name, ok: !!cond });

  // parseNum
  assert('parseNum bold', parseNum('**10.95**') === 10.95);
  assert('parseNum range en-dash midpoint', parseNum('5–8') === 6.5);
  assert('parseNum range hyphen midpoint', parseNum('7-11') === 9);
  assert('parseNum n/a -> null', parseNum('n/a (pre-protocol)') === null);
  assert('parseNum dash -> null', parseNum('—') === null);
  assert('parseNum ~25 wall', parseNum('~25 wall') === 25);

  // header-format row (est=c6, act=c7, delta=c8)
  const hRow = '| 11 | 07-06 | Knip dead-code chase | — | run knip | 5–8 | **10.95** | **≈1.68** | done | notes |';
  const hp = parseTimingRow(hRow);
  assert('header row est=6.5', hp && hp.est === 6.5);
  assert('header row act=10.95', hp && hp.act === 10.95);
  assert('header row Δ≈1.684', hp && Math.abs(hp.delta - 10.95 / 6.5) < 1e-9);

  // shifted-format row (est=c4, act=c6, delta=c7); c8 dash
  const sRow = '| 224 | 07-11 | Gauntlet re-run (Opus measurer) | 80 | post-cutover sweep | 54.2 | 0.68 | — | LOCK | 274k tok |';
  const sp = parseTimingRow(sRow);
  assert('shifted row est=80 (not 54.2)', sp && sp.est === 80);
  assert('shifted row act=54.2', sp && sp.act === 54.2);
  assert('shifted row Δ≈0.6775', sp && Math.abs(sp.delta - 54.2 / 80) < 1e-9);

  // class bucketing
  assert('title surgeon -> code-wave', titleToClass('Oklab render surgeon (Opus, worktree)') === 'code-wave');
  assert('title gauntlet measurer -> sweep', titleToClass('Gauntlet re-run (Opus measurer)') === 'sweep');
  assert('title false-positive -> verification', titleToClass('false-positive chase on IMG_1757') === 'verification');
  assert('title scout -> scout', titleToClass('scout: locate config key') === 'scout');
  // regression: unanchored /locate/ used to match "reLOCATEd" and misclassify a 51-min
  // surgeon row (timing-log #128) as a scout, inflating scout tlog_act to 51.
  assert('title relocated NOT scout', titleToClass('SPCC channel gains TLS wiring (surgeon, relocated worktree)') === 'code-wave');
  assert('title allocate NOT scout', titleToClass('Buffer allocate refactor (surgeon)') === 'code-wave');
  assert('title audit -> audit', titleToClass('processing_flow reality audit') === 'audit');
  assert('agent_type surgeon -> code-wave', agentTypeToClass('surgeon') === 'code-wave');
  assert('agent_type auditor-haiku -> audit', agentTypeToClass('auditor-haiku') === 'audit');
  assert('agent_type measurer -> sweep', agentTypeToClass('measurer') === 'sweep');

  // end-to-end on a tiny in-memory fixture
  const runsFix = [
    JSON.stringify({ duration_s: 120, agent_type: 'surgeon' }),
    JSON.stringify({ duration_s: 240, agent_type: 'surgeon' }),
    JSON.stringify({ duration_s: 90, agent_type: 'scout' }),
    JSON.stringify({ event: 'x' }), // no duration -> ignored
  ].join('\n');
  const tmp = path.join(process.env.TEMP || '/tmp', `estcal_selftest_${process.pid}.jsonl`);
  fs.writeFileSync(tmp, runsFix);
  const rl = loadRuns(tmp);
  fs.unlinkSync(tmp);
  assert('fixture runs: code-wave median = 3min', median(rl.byClass['code-wave']) === 3);
  assert('fixture runs: scout n=1', rl.byClass['scout'].length === 1);
  assert('fixture runs: no-duration ignored (n=3)', rl.n === 3);

  let pass = 0;
  for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`); if (c.ok) pass++; }
  console.log(`\nself-test: ${pass}/${checks.length} passed`);
  return pass === checks.length;
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const o = { json: false, selfTest: false, root: null, runs: null, timing: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--json') o.json = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--runs') o.runs = argv[++i];
    else if (a === '--timing') o.timing = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/ops/estimate_calibration.mjs [--root DIR] [--runs FILE] [--timing FILE] [--json] [--self-test]');
  process.exit(0);
} else if (opts.selfTest) {
  process.exit(selfTest() ? 0 : 1);
} else {
  const res = run(opts);
  if (opts.json) console.log(JSON.stringify(res, null, 2));
  else printReport(res);
}
