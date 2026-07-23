#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/publish_analytics_test.mjs — node test (underscore idiom; NOT
// vitest-collected). Run:  node tools/analytics/publish_analytics_test.mjs
//
// Covers three layers:
//   A. buildSummary() — the pure roll-up: renderable-data-shape when modules are
//      present, and honest present:false NOT-MEASURED sections when absent/failed/
//      malformed. Determinism (no timestamps in data).
//   B. the CLI empty state — spawned in a module-less temp root: writes an honest
//      "all absent" database_summary.json + index.json, never a fabricated number.
//   C. renderDatabase() — the actual Database-tab renderer (vm-loaded exactly as a
//      browser <script>, with stubbed app.js globals): the "ANALYTICS NOT YET
//      GENERATED" empty state when the feed is absent, populated numbers + source
//      links when present, and per-section NOT MEASURED when a section is absent.
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSummary, MODULES, PUBLISH_ANALYTICS_VERSION } from './publish_analytics.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dir, '..', '..');
const PUBLISHER = path.join(__dir, 'publish_analytics.mjs');
const TAB_JS = path.join(REPO_ROOT, 'tools', 'theses', 'dashboard', 'ui', 'tab_database.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { process.stderr.write(`FAIL  ${name}\n      ${e && e.message || e}\n`); process.exitCode = 1; }
}

// ── fixtures: shape-accurate module result envelopes (fields buildSummary reads) ──
function okResult(data) {
  return { status: 'ok', out_file: 'x.json', result: { spec: { tool_version: '1.0.0' }, provenance: { git_head: 'abc1234', generated_at: '2026-07-12T00:00:00.000Z', tool_version: '1.0.0' }, data } };
}
const SOLVE = okResult({
  overview: { n_frames: 96, by_kind: { solved: 43, no_solve: 42, assisted: 11 }, by_solve_class: { blind: 85, assisted: 11 }, by_key_mode: { sha: 96, filename: 0 }, by_outcome: { solved: 39 }, with_receipt: 74, with_dossier: 96, with_envelope: 11 },
  blind_lane: {
    denominators: { n_blind_frames: 96, n_attempted: 81, n_solved: 43, n_skipped: 15 },
    overall: { solve_rate_of_all_blind: { n: 43, d: 96, pct: 44.8 }, solve_rate_of_attempted: { n: 43, d: 81, pct: 53.1 } },
    by_format: {
      CR2: { n_frames: 45, n_solved: 2, n_attempted: 31, n_skipped: 14, solve_rate_of_all_blind: { pct: 4.4 }, solve_rate_of_attempted: { pct: 6.5 } },
      FITS: { n_frames: 51, n_solved: 41, n_attempted: 50, n_skipped: 1, solve_rate_of_all_blind: { pct: 80.4 }, solve_rate_of_attempted: { pct: 82 } },
    },
  },
  assisted_lane: { n_assisted_frames: 11, of_which_failed_blind: 11, run_labels: ['HINTED-COCOON'] },
});
const RESID = (() => { const r = okResult({
  summary: { frames_total: 96, frames_measured: 39, frames_not_measured: 57, frames_flagged: 15, refit_candidate_count: 26, matched_stars_used: 39087, not_measured_by_reason: { 'NOT MEASURED — below min_stars': 4 } },
  refit_candidates: [{ id: 'file:challenge_T6_IMG_1410.CR2', rig: 'Canon EOS Rebel T6 | Unknown Lens', edge_excess_arcsec: 1929.08, edge_excess_px: 30.52, slope_arcsec_per_radius: 3008.16, n_stars_used: 54 }],
}); r.result.spec = { distortion_slope_threshold_arcsec_per_radius: 3, distortion_edge_excess_threshold_arcsec: 2, signature_rule: 'slope>=slope_threshold AND edge_excess>=edge_excess_threshold' }; return r; })();
const CONFIRM = okResult({
  corpus: { total_frames: 75, with_confirm_block: 44, confirmable_frames: 37, by_status: { CONFIRMED: 20, REFUSED: 16, INSUFFICIENT_TARGETS: 4, NOT_RUN: 3 } },
  n_vs_verdict: { statistic: 'pearson(nTargets, setExcessZ)', pearson: 0.8494, spearman_rho: 0.8327, baseline: 0.836, delta: 0.0134, n_frames: 37, agreement: 'AGREES', baseline_source: 'research/confirm_statistic_review_2026-07-12.md' },
  fdr_shadow: { status: 'NOT MEASURED', present_frames: 0 },
});
const WALL = okResult({
  corpus_summary: { frames: 96, timing_rows: 143, rows_ran: 128, rows_not_run: 15, rows_with_stage_decomposition: 40 },
  solve_wall_decomposition: { overall: { frames: 40, solve_share_of_pipeline: 0.711, solve_share_of_wall: 0.594, solve_ms: 302646, pipeline_ms: 425664, wall_ms: 509321 } },
  blind_vs_assisted: { paired_frames: 11, speedup_median: 19.8, speedup_mean: 19.0, blind_wall_ms: { median: 195897 }, assisted_wall_ms: { median: 9895 } },
  savings_projection: { requested: false },
});
const ALL = { solve_stats: SOLVE, confirm_stats: CONFIRM, wall_stats: WALL, residuals: RESID };

// ═══ A. buildSummary ═══════════════════════════════════════════════════════
t('A1 all-absent → every section present:false with a NOT MEASURED reason', () => {
  const d = buildSummary({});
  assert.equal(d.generated, false);
  assert.ok(typeof d.all_absent_note === 'string' && d.all_absent_note.includes('NOT MEASURED'));
  for (const key of ['corpus', 'solve', 'residuals', 'confirm', 'wall']) {
    assert.equal(d[key].present, false, `${key} should be absent`);
    assert.ok(String(d[key].reason).includes('NOT MEASURED'), `${key} reason must say NOT MEASURED`);
  }
  assert.equal(d.modules.length, MODULES.length);
  for (const m of d.modules) { assert.equal(m.status, 'absent'); assert.equal(m.present, false); }
});

t('A2 all-present → renderable data shape with the numbers pulled through', () => {
  const d = buildSummary(ALL);
  assert.equal(d.generated, true);
  assert.equal(d.all_absent_note, null);
  // corpus
  assert.equal(d.corpus.present, true);
  assert.equal(d.corpus.n_frames, 96);
  assert.deepEqual(d.corpus.by_kind, { solved: 43, no_solve: 42, assisted: 11 });
  assert.equal(d.corpus.with_receipt, 74);
  // solve — rates carry BOTH denominators
  assert.equal(d.solve.present, true);
  assert.deepEqual(d.solve.rate_all_blind, { n: 43, d: 96, pct: 44.8 });
  assert.deepEqual(d.solve.rate_attempted, { n: 43, d: 81, pct: 53.1 });
  assert.equal(d.solve.denominators.n_attempted, 81);
  assert.equal(d.solve.by_format.length, 2);
  const cr2 = d.solve.by_format.find((f) => f.format === 'CR2');
  assert.equal(cr2.n_solved, 2); assert.equal(cr2.pct_all_blind, 4.4);
  assert.equal(d.solve.assisted.n_assisted_frames, 11);
  // residuals — edge-growth headline
  assert.equal(d.residuals.present, true);
  assert.equal(d.residuals.frames_flagged, 15);
  assert.equal(d.residuals.top_refit.edge_excess_arcsec, 1929.08);
  assert.equal(d.residuals.thresholds.edge_excess_arcsec, 2);
  // confirm — N-profile
  assert.equal(d.confirm.present, true);
  assert.equal(d.confirm.by_status.CONFIRMED, 20);
  assert.equal(d.confirm.n_vs_verdict.pearson, 0.8494);
  assert.equal(d.confirm.n_vs_verdict.agreement, 'AGREES');
  assert.equal(d.confirm.fdr_shadow.status, 'NOT MEASURED');
  // wall — economics
  assert.equal(d.wall.present, true);
  assert.equal(d.wall.solve_share.of_pipeline, 0.711);
  assert.equal(d.wall.blind_vs_assisted.speedup_median, 19.8);
  assert.equal(d.wall.blind_vs_assisted.blind_median_ms, 195897);
  // roll-call
  assert.ok(d.modules.every((m) => m.present && m.status === 'ok'));
  assert.ok(d.modules.every((m) => m.git_head === 'abc1234'));
});

t('A3 failed module → section present:false, roll-call surfaces status+error', () => {
  const d = buildSummary({ ...ALL, wall_stats: { status: 'failed', error: 'exit 2: boom', result: null } });
  assert.equal(d.wall.present, false);
  const wm = d.modules.find((m) => m.name === 'wall_stats');
  assert.equal(wm.status, 'failed');
  assert.ok(String(wm.error).includes('boom'));
  // other sections unaffected
  assert.equal(d.solve.present, true);
});

t('A4 malformed module data → section present:false, never throws', () => {
  const broken = { status: 'ok', result: { spec: {}, provenance: {}, data: { overview: null /* no blind_lane */ } } };
  const d = buildSummary({ solve_stats: broken });
  assert.equal(d.solve.present, false);
  assert.equal(d.corpus.present, false); // overview absent → no corpus either
});

t('A5 buildSummary data is deterministic and carries NO timestamp', () => {
  const a = JSON.stringify(buildSummary(ALL));
  const b = JSON.stringify(buildSummary(ALL));
  assert.equal(a, b, 'same input → byte-identical roll-up');
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:/.test(a), 'no ISO timestamp may appear in the data block');
});

t('A6 corpus falls back to provenance.row_counts when solve_stats overview absent', () => {
  const wallOnly = { wall_stats: { status: 'ok', out_file: 'wall_stats.json', result: { spec: {}, provenance: { row_counts: { by_kind: { solved: 5 } } }, data: { corpus_summary: { frames: 5 } } } } };
  const d = buildSummary(wallOnly);
  assert.equal(d.corpus.present, true);
  assert.ok(String(d.corpus.source).includes('row_counts'));
});

// ═══ B. CLI empty state (spawned in a module-less temp root) ════════════════
t('B1 CLI in a module-less root → honest ALL-ABSENT summary + index, exit 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubanalytics-'));
  try {
    // copy ONLY the publisher into <tmp>/tools/analytics/ — no sibling modules, no manifest.
    const dstDir = path.join(tmp, 'tools', 'analytics');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(PUBLISHER, path.join(dstDir, 'publish_analytics.mjs'));
    const outDir = path.join(tmp, 'out');
    const proc = spawnSync(process.execPath, [path.join(dstDir, 'publish_analytics.mjs'), '--out-dir', outDir, '--quiet'], { encoding: 'utf8' });
    assert.equal(proc.status, 0, `exit 0 expected, got ${proc.status}: ${proc.stderr}`);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'database_summary.json'), 'utf8'));
    assert.equal(summary.data.generated, false);
    assert.equal(summary.spec.base_manifest_present, false);
    for (const key of ['corpus', 'solve', 'residuals', 'confirm', 'wall']) assert.equal(summary.data[key].present, false);
    for (const m of summary.data.modules) assert.equal(m.status, 'absent');
    // provenance holds the ONLY timestamp
    assert.ok(/\d{4}-\d\d-\d\dT/.test(summary.provenance.generated_at));
    // index.json roll-call written
    const idx = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
    assert.equal(idx.data.generated, false);
    assert.equal(idx.data.summary_file, 'database_summary.json');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ═══ C. renderDatabase() — the actual renderer, vm-loaded like a browser <script> ══
function loadRenderer(feedState) {
  const code = fs.readFileSync(TAB_JS, 'utf8');
  const sandbox = {
    // stubbed app.js globals the tab reads at call time
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    NR: 'NOT RECORDED',
    POLL_MS: 15000,
    fmtTs: (x) => String(x),
    fmtClock: (x) => String(x),
    state: { feeds: { database: feedState } },
    module: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'tab_database.js' });
  assert.equal(typeof sandbox.renderDatabase, 'function', 'tab_database.js must define renderDatabase()');
  return sandbox.renderDatabase;
}
function envelope(data) { return { spec: {}, provenance: { generated_at: '2026-07-12T00:00:00.000Z', git_head: 'abc1234' }, data }; }

t('C1 feed absent → the honest "ANALYTICS NOT YET GENERATED" empty state', () => {
  const html = loadRenderer({ unreachable: true, data: null, source: null, lastOk: null })();
  assert.ok(html.includes('ANALYTICS NOT YET GENERATED'), 'must show the empty-state badge');
  assert.ok(html.includes('publish_analytics'), 'must tell the user to run publish_analytics');
});

t('C2 feed present + generated → numbers + traceable source links, no empty badge', () => {
  const html = loadRenderer({ unreachable: false, data: envelope(buildSummary(ALL)), source: 'LIVE /data', lastOk: new Date() })();
  assert.ok(!html.includes('ANALYTICS NOT YET GENERATED'), 'populated feed must NOT show the empty state');
  assert.ok(html.includes('>96<'), 'corpus frame count renders');
  assert.ok(html.includes('44.8%'), 'blind solve rate renders');
  assert.ok(html.includes('/data/analytics/solve_stats.json'), 'source link to the solve_stats result JSON');
  assert.ok(html.includes('/data/analytics/residuals.json'), 'source link to the residuals result JSON');
  assert.ok(html.includes('AGREES'), 'confirm N-vs-verdict agreement renders');
});

t('C3 feed present but all-absent → per-section NOT MEASURED, no empty badge', () => {
  const html = loadRenderer({ unreachable: false, data: envelope(buildSummary({})), source: 'LIVE /data', lastOk: new Date() })();
  assert.ok(!html.includes('ANALYTICS NOT YET GENERATED'), 'a published-but-empty feed is NOT the absent-feed state');
  assert.ok(html.includes('NOT MEASURED'), 'sections render NOT MEASURED');
  assert.ok(html.includes('Corpus') && html.includes('Wall-clock economics'), 'section heads still render');
});

t('C4 renderer never fabricates: a null tile value shows NOT MEASURED not 0', () => {
  const partial = buildSummary(ALL);
  partial.corpus.with_envelope = null; // simulate an absent count
  const html = loadRenderer({ unreachable: false, data: envelope(partial), source: 'LIVE /data', lastOk: new Date() })();
  // the "with envelope" tile must render NOT MEASURED, never a fabricated 0
  assert.ok(/with envelope[\s\S]{0,120}NOT MEASURED/i.test(html), 'null count → NOT MEASURED tile');
});

process.stdout.write(`\npublish_analytics_test: ${passed} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
