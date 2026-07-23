#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A5 corpus-pass SUMMARIZER — a5_results.jsonl → a5_summary.json (mechanical)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/api/a5_summarize.mjs
//
// Pure aggregation over the per-frame jsonl the sweep appends. Honest-or-absent:
// counts only what is in the jsonl; frames enumerated in the manifest but absent
// from the jsonl are reported under `not_run` (never counted as solved/failed).
// Editorial findings/hints/compat-delta are computed from the data where
// mechanical, else left for the orchestrator relay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'test_results', 'overnight_run_2026-07-10');
const RESULTS = path.join(OUT, 'a5_results.jsonl');
const MANIFEST = path.join(OUT, 'a5_manifest.json');
const SUMMARY = path.join(OUT, 'a5_summary.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const expected = {}; // source -> [filenames of lights]
for (const src of Object.keys(manifest.sources)) {
  expected[src] = manifest.sources[src].filter((f) => f.frame_role === 'light').map((f) => f.filename);
}
const expectedTotal = Object.values(expected).reduce((a, b) => a + b.length, 0);

const rows = fs.existsSync(RESULTS)
  ? fs.readFileSync(RESULTS, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];
const byFrame = new Map(rows.map((r) => [r.frame, r]));

const laneOf = (r) => (r.format === 'FITS' ? 'FITS' : 'CR2');
const empty = () => ({ run: 0, solved: 0, honest_failure: 0, error: 0 });
const bump = (o, r) => { o.run++; o[r.outcome] = (o[r.outcome] || 0) + 1; };

const by_source = {};
const by_lane = { FITS: empty(), CR2: empty() };
const by_rig = {};
const failure_taxonomy = {};
let cr2_solved_blind = 0, cr2_solved_hinted = 0, cr2_run = 0;
let fits_assisted = 0, fits_blind_pointing = 0;
const truth_details = [];
let tp = 0, fp = 0, truth_measured = 0;
const solved_frames = [];

for (const r of rows) {
  by_source[r.source] = by_source[r.source] || empty();
  bump(by_source[r.source], r);
  bump(by_lane[laneOf(r)], r);
  if (r.rig) { by_rig[r.rig] = by_rig[r.rig] || empty(); bump(by_rig[r.rig], r); }

  const attempts = [r.blind, r.hinted].filter(Boolean);
  for (const a of attempts) {
    if (a && a.failure_class) failure_taxonomy[a.failure_class] = (failure_taxonomy[a.failure_class] || 0) + 1;
  }

  if (laneOf(r) === 'CR2') {
    cr2_run++;
    if (r.blind?.outcome === 'solved') cr2_solved_blind++;
    else if (r.hinted?.outcome === 'solved') cr2_solved_hinted++;
  } else {
    if (r.blind?.pointing_assisted) fits_assisted++; else fits_blind_pointing++;
  }

  const t = r.truth;
  if (t && t.verdict && t.verdict !== 'NOT_MEASURED') {
    truth_measured++;
    if (t.verdict === 'TRUE_POSITIVE') tp++; else if (t.verdict === 'FALSE_POSITIVE') fp++;
    truth_details.push({ frame: r.frame, source: r.source, verdict: t.verdict, truth_source: t.source,
      center_sep_deg: t.center_sep_deg, scale_err_frac: t.scale_err_frac, rotation_err_deg: t.rotation_err_deg,
      reasons: t.reasons, note: t.note });
  }

  if (r.outcome === 'solved') {
    const w = r.provenance === 'hinted' ? r.hinted : r.blind;
    solved_frames.push({ frame: r.frame, source: r.source, rig: r.rig || null, provenance: r.provenance,
      ra_hours: w.ra_hours, dec_degrees: w.dec_degrees, pixel_scale: w.pixel_scale,
      stars_matched: w.stars_matched, confidence: w.confidence,
      truth_verdict: t?.verdict ?? 'NOT_MEASURED', center_sep_deg: t?.center_sep_deg ?? null,
      scale_err_frac: t?.scale_err_frac ?? null });
  }
}

const not_run = [];
for (const src of Object.keys(expected)) {
  for (const fn of expected[src]) if (!byFrame.has(fn)) not_run.push(fn);
}

const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : null);
const fitsSolved = by_lane.FITS.solved, fitsRun = by_lane.FITS.run;
const cr2Solved = by_lane.CR2.solved, cr2Run = by_lane.CR2.run;

const summary = {
  schema: 'skycruncher.a5_graded_corpus_summary/1',
  generated_at: new Date().toISOString(),
  color_capable_engine: true,
  frames_expected: expectedTotal,
  frames_run: rows.length,
  not_run,
  by_source_expected: Object.fromEntries(Object.keys(expected).map((k) => [k, expected[k].length])),
  by_source,
  by_lane,
  by_rig,
  crack_rate: {
    FITS: rate(fitsSolved, fitsRun),
    CR2_overall: rate(cr2Solved, cr2Run),
    CR2_blind: rate(cr2_solved_blind, cr2_run),
    CR2_hinted_incremental: rate(cr2_solved_hinted, cr2_run),
    overall: rate(fitsSolved + cr2Solved, rows.length),
  },
  cr2_provenance: { run: cr2_run, solved_blind: cr2_solved_blind, solved_hinted: cr2_solved_hinted },
  fits_pointing: { header_assisted: fits_assisted, truly_blind_pointing: fits_blind_pointing },
  failure_taxonomy,
  truth_graded: { measured: truth_measured, TRUE_POSITIVE: tp, FALSE_POSITIVE: fp, details: truth_details },
  solved_frames,
  // Editorial layers — mechanical seeds; orchestrator folds into COMPAT_MATRIX.
  recommended_hints: [],
  knob_notes: [],
  compat_matrix_delta: [],
  findings: [],
};

fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
console.log(`[a5-sum] ${rows.length}/${expectedTotal} run | FITS ${fitsSolved}/${fitsRun} | CR2 ${cr2Solved}/${cr2Run} | truth TP=${tp} FP=${fp}/${truth_measured} | not_run=${not_run.length}`);
console.log(`[a5-sum] wrote ${path.relative(ROOT, SUMMARY)}`);
