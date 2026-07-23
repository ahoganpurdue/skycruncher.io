#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CORPUS RESULTS LEDGER — append-only, cumulative record of every corpus-frame
// solve outcome across runs. run_corpus overwrites its per-run corpus_report.json;
// this preserves the history the report throws away.
//
// One append-only artifact serves THREE needs (docs/CORPUS_INTAKE.md):
//   1. results tracking for the random/rotating feeds — the AUTO equivalent of the
//      hand-curated CR2_SOLVER_FINDINGS.md (breadth; interesting frames graduate).
//   2. the 2-solve churn purge — a frame's solve count = its count of `solved` lines.
//   3. the pooled-failure labeled dataset (ROADMAP corpus-driven error decomposition).
//
// Each line is JSON: { ts, commit, frame, solved, ...row }. The `commit` tag ties a
// result to the code version, so a fix (e.g. the APS-C pitch bug) shows a frame
// flip `failed → solved` across commits — improvement becomes MEASURED, not asserted.
//
// Local (references gitignored corpus files): test_results/corpus_ledger.jsonl.
//   run_corpus appends automatically at the end of every sweep; or manually:
//     node tools/corpus/ledger.mjs --ingest [report.json]   # append a report's rows
//     node tools/corpus/ledger.mjs --rollup                 # per-frame + aggregate view
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'test_results', 'corpus_ledger.jsonl');

const SOLVED = s => s === 'PASS' || String(s).startsWith('SOLVED');
function gitCommit() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); }
  catch { return 'unknown'; }
}

/** Append run_corpus rows to the cumulative ledger. Returns count appended. */
export function appendResults(rows, when) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const commit = gitCommit();
  const ts = when || new Date().toISOString();
  const lines = rows.map(r => JSON.stringify({
    ts, commit,
    frame: path.basename(r.file ?? '?'),
    solved: SOLVED(r.status),
    ...r,
  }));
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, lines.join('\n') + '\n');
  return lines.length;
}

/** Read a run_corpus report JSON and append its rows to the ledger. */
export function ingestReport(reportPath) {
  const p = reportPath || path.join(ROOT, 'test_results', 'corpus_report.json');
  if (!fs.existsSync(p)) { console.error(`[ledger] no report at ${path.relative(ROOT, p)}`); return 0; }
  const rep = JSON.parse(fs.readFileSync(p, 'utf8'));
  const n = appendResults(rep.rows ?? [], rep.when);
  console.log(`[ledger] appended ${n} result(s) → ${path.relative(ROOT, LEDGER)}`);
  return n;
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Per-frame latest status + solve count, plus aggregate solve-rate. */
export function rollup() {
  const all = readLedger();
  if (!all.length) { console.log('\n[ledger] empty — no corpus results logged yet.\n'); return; }
  const byFrame = new Map();
  for (const e of all) {
    const f = byFrame.get(e.frame) ?? { runs: 0, solves: 0, latest: null };
    f.runs++; if (e.solved) f.solves++; f.latest = e; // ledger is append-order = chronological
    byFrame.set(e.frame, f);
  }
  console.log(`\nCorpus results ledger — ${all.length} result(s) · ${byFrame.size} frame(s)   (${path.relative(ROOT, LEDGER)})\n`);
  console.log(`  ${'frame'.padEnd(42)} ${'latest'.padEnd(14)} runs solves ${'fmt'.padEnd(5)} ${'scale'.padEnd(8)} match  flag`);
  const byStatus = {}, byFmt = {};
  for (const [frame, f] of [...byFrame.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const e = f.latest;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const fmt = e.fmt ?? (/\.fits?$/i.test(String(e.file)) ? 'FITS' : 'CR2');
    (byFmt[fmt] ??= { s: 0, t: 0 }).t++; if (e.solved) byFmt[fmt].s++;
    const flag = f.solves >= 2 ? 'purge-eligible' : '';
    console.log(`  ${frame.slice(0, 42).padEnd(42)} ${String(e.status).padEnd(14)} ${String(f.runs).padStart(4)} ${String(f.solves).padStart(6)} ${fmt.padEnd(5)} ${String(e.scale ?? e.headerScale ?? '-').padEnd(8)} ${String(e.matches ?? '-').padStart(5)}  ${flag}`);
  }
  console.log(`\n  latest-status tally: ${JSON.stringify(byStatus)}`);
  console.log('  solve-rate by format: ' + Object.entries(byFmt).map(([k, v]) => `${k} ${v.s}/${v.t}`).join(' · ') + '\n');
}

// CLI (only when invoked directly, never when imported by run_corpus)
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/tools/corpus/ledger.mjs')) {
  const arg = process.argv[2];
  if (arg === '--ingest') ingestReport(process.argv[3]);
  else if (arg === '--rollup') rollup();
  else console.log('usage: node tools/corpus/ledger.mjs --ingest [report.json] | --rollup');
}
