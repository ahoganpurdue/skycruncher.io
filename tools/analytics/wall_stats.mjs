#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/wall_stats.mjs — wall-clock economics analytics.
//
// Answers "where does the wall time go?" over the joined corpus:
//   · per-stage timing aggregation (medians/distributions by format + outcome)
//   · solve-wall decomposition — the "blind plate-solve sweep dominates wall"
//     finding, recomputed as a live number WITH its stated denominator
//   · blind-vs-assisted wall comparison — the hinted-cocoon 196s→10.3s story as
//     a queryable, frame-paired statistic
//   · per-run wall trends (grouped by run_label / source ledger)
//   · a SAVINGS-MODEL section — given a lever spec {assisted_fraction: X}, the
//     PROJECTED corpus-sweep wall. Clearly labelled PROJECTION, inputs stated,
//     never presented as a measurement.
//
// HOUSE LAWS embodied here:
//   · LAW 3 (honest-or-absent): timing data absent on a frame is reported ABSENT
//     ("NOT MEASURED"), never zero-filled. Only SOLVED frames carry a per-stage
//     `stages` map — no-solve/timeout/skipped frames carry NO stage breakdown, so
//     the stage sections state their solved-only denominator explicitly. A
//     `skipped_*` row (wall_ms == 0) means DID-NOT-RUN and is excluded from wall
//     distributions — it is never counted as "ran in 0 ms".
//   · Deterministic: same corpus + same spec ⇒ byte-identical `data`. The only
//     wall-clock value is provenance.generated_at (isolated by emitResult).
//     Per-frame arrays are built from the core's sorted frame roster; the emitter
//     serialises with recursively sorted keys.
//   · The PROJECTION is never a measurement: it is emitted under
//     `savings_projection` with projection:true, an `inputs` block naming every
//     measured input it consumes, and it is ABSENT (with a reason) unless a lever
//     is supplied. Measured headlines and projected numbers never share a field.
//
// ─── TIMING DATA MODEL (learned from the ledgers) ────────────────────────────
//   Per-stage timings live in the LEDGER rows, not the receipts. Each blind
//   ledger row of a SOLVED frame carries:
//     wall_ms       total wall clock of the frame's run (process spawn→exit)
//     pipeline_ms   sum of the pipeline stage time (== total_ms in this corpus)
//     stages{}      { <stage>: ms }. TOP-LEVEL stage names have no dot and
//                   partition pipeline_ms (∑ top-level ≈ pipeline_ms). DOTTED
//                   names (solve.uw_sweep, solve.quad_wasm, solve.uw_escalation)
//                   are SUB-instrumentation WITHIN a top-level stage — reported
//                   separately, never summed into the partition (double-count).
//   The `solve` top-level stage IS the blind plate-solve sweep. For ultra-wide
//   CR2/DSLR blind solves it dominates (~96% of pipeline); for narrow FITS quad
//   solves it is a minority (~31%).
//   Assisted (hinted-cocoon) solves live in envelope rows — wall_ms only, NO
//   stage decomposition (the assisted lane is not stage-instrumented here).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCorpus, loadManifest, resolvePath, corpusProvenance, emitResult,
  stableStringify, summarize, CORPUS_CORE_VERSION, REPO_ROOT, DEFAULT_MANIFEST_PATH,
} from './lib/corpus.mjs';

export const WALL_STATS_VERSION = '1.0.0';
const SCHEMA = 'analytics.wall_stats';

// ── small helpers (honest: null, never a fabricated 0) ────────────────────────
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
function ratio(a, b) { return (num(a) !== null && num(b) && b !== 0) ? a / b : null; }
function round(v, dp = 4) {
  if (num(v) === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
// round every numeric leaf of a summarize() block for stable, readable output.
function roundStats(s, dp = 3) {
  if (!s) return s;
  const out = {};
  for (const k of Object.keys(s)) out[k] = (k === 'n') ? s[k] : round(s[k], dp);
  return out;
}
// derive a format label: explicit row.format, else the filename extension.
function rowFormat(row, fallbackName) {
  const f = str(row.format);
  if (f) return f.toUpperCase();
  const name = str(fallbackName) || str(row.frame_basename) || str(row.id) || '';
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════════
// extractTimingRows — normalise the corpus into a flat roster of timing rows.
// One row per blind ledger row + one per assisted envelope row. Every row:
//   { key, id, sha, lane, format, outcome, source, run_label,
//     wall_ms|null, pipeline_ms|null, ran(bool), has_stages(bool),
//     top_stages|null, sub_stages|null }
// `ran` is false for skipped_* / wall_ms<=0 (DID-NOT-RUN) — excluded from wall
// distributions downstream. Deterministic: frames are already sorted by key; we
// emit blind rows then assisted rows, in the core's row order.
// ═══════════════════════════════════════════════════════════════════════════
export function extractTimingRows(frames) {
  const rows = [];
  for (const f of frames) {
    // blind lane — ledger rows (resolved population + no-solve rerun).
    for (const lr of (f.ledger_rows || [])) {
      const outcome = str(lr.resolved_outcome) || str(lr.outcome);
      const wall = num(lr.wall_ms);
      const skipped = /^skipped/i.test(outcome || '');
      const ran = !skipped && wall !== null && wall > 0;
      let top = null, sub = null;
      if (lr.stages && typeof lr.stages === 'object') {
        top = {}; sub = {};
        for (const [k, v] of Object.entries(lr.stages)) {
          const ms = num(v);
          if (ms === null) continue;
          if (k.includes('.')) sub[k] = ms; else top[k] = ms;
        }
        if (!Object.keys(sub).length) sub = null;
      }
      rows.push({
        key: f.key, id: f.id, sha: f.sha, lane: 'blind',
        format: rowFormat(lr, lr.path || lr.id),
        outcome: outcome || null,
        source: str(lr.__ledger),
        run_label: str(lr.run_label) || null,
        wall_ms: wall,
        pipeline_ms: num(lr.pipeline_ms) ?? num(lr.total_ms),
        ran, has_stages: !!top,
        top_stages: top, sub_stages: sub,
      });
    }
    // assisted lane — envelope rows (hinted-cocoon). Wall only, no stages.
    for (const er of (f.envelope_rows || [])) {
      const wall = num(er.wall_ms);
      rows.push({
        key: f.key, id: f.id, sha: f.sha, lane: 'assisted',
        format: rowFormat(er, er.frame_basename || er.frame),
        outcome: str(er.outcome) || null,
        source: str(er.__envelope),
        run_label: str(er.run_label) || null,
        wall_ms: wall,
        pipeline_ms: null,
        ran: wall !== null && wall > 0,
        has_stages: false, top_stages: null, sub_stages: null,
      });
    }
  }
  return rows;
}

// ── generic grouped summarize over a value accessor ───────────────────────────
function groupSummarize(items, keyFn, valFn) {
  const buckets = new Map();
  for (const it of items) {
    const k = keyFn(it);
    const kk = (k == null) ? '∅' : String(k);
    if (!buckets.has(kk)) buckets.set(kk, []);
    const v = valFn(it);
    if (num(v) !== null) buckets.get(kk).push(v);
  }
  const out = {};
  for (const k of [...buckets.keys()].sort()) out[k] = roundStats(summarize(buckets.get(k)));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// stageAggregation — per-stage wall distributions.
// Only rows with a stage decomposition contribute (SOLVED frames). Grouped by
// format; the group's non-solved population is reported as NOT MEASURED count.
// ═══════════════════════════════════════════════════════════════════════════
export function stageAggregation(rows) {
  const staged = rows.filter((r) => r.has_stages);
  // blind rows that ran but carry no stage map — the honest "no decomposition"
  // gap (assisted rows are never stage-instrumented, so they are not a gap).
  const ranNoStages = rows.filter((r) => r.lane === 'blind' && r.ran && !r.has_stages);

  // collect the full stage vocabulary (deterministic sorted).
  const topNames = new Set(), subNames = new Set();
  for (const r of staged) {
    for (const k of Object.keys(r.top_stages)) topNames.add(k);
    if (r.sub_stages) for (const k of Object.keys(r.sub_stages)) subNames.add(k);
  }
  const perStage = (subset) => {
    const top = {};
    for (const name of [...topNames].sort()) {
      top[name] = roundStats(summarize(subset.map((r) => r.top_stages[name]).filter((v) => num(v) !== null)));
    }
    const subs = {};
    for (const name of [...subNames].sort()) {
      subs[name] = roundStats(summarize(subset.map((r) => (r.sub_stages ? r.sub_stages[name] : null)).filter((v) => num(v) !== null)));
    }
    return { frames: subset.length, top_level_stages: top, sub_stages: subs };
  };

  const byFormat = {};
  const fmts = [...new Set(staged.map((r) => r.format))].sort();
  for (const fmt of fmts) byFormat[fmt] = perStage(staged.filter((r) => r.format === fmt));

  return {
    note: 'A per-stage decomposition exists ONLY for solved frames. Non-solved frames (no_solve / timeout / skipped) carry NO stage breakdown — reported below as ran_without_stage_decomposition and, for skipped, as not-run. Top-level stage names partition pipeline time; dotted sub_stages are instrumentation WITHIN a top-level stage and are NOT part of the partition.',
    frames_with_stage_decomposition: staged.length,
    ran_without_stage_decomposition: ranNoStages.length,
    overall: perStage(staged),
    by_format: byFormat,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// solveWallDecomposition — the blind-sweep share, WITH its denominator.
// solve stage = the blind plate-solve sweep. share = Σ(solve) / Σ(pipeline_ms)
// over the solved-with-stages frames. Reported overall + per-format + as a
// per-frame share distribution, so the reader sees exactly which subset yields
// the >95% figure (it is the ultra-wide CR2 blind sweep).
// ═══════════════════════════════════════════════════════════════════════════
export function solveWallDecomposition(rows) {
  const staged = rows.filter((r) => r.has_stages && num(r.pipeline_ms) !== null);
  const block = (subset) => {
    const solveMs = subset.reduce((a, r) => a + (num(r.top_stages.solve) || 0), 0);
    const pipeMs = subset.reduce((a, r) => a + (num(r.pipeline_ms) || 0), 0);
    const wallMs = subset.reduce((a, r) => a + (num(r.wall_ms) || 0), 0);
    return {
      frames: subset.length,
      solve_ms: round(solveMs, 1),
      pipeline_ms: round(pipeMs, 1),
      wall_ms: round(wallMs, 1),
      solve_share_of_pipeline: round(ratio(solveMs, pipeMs)),
      solve_share_of_wall: round(ratio(solveMs, wallMs)),
    };
  };
  const byFormat = {};
  for (const fmt of [...new Set(staged.map((r) => r.format))].sort()) {
    byFormat[fmt] = block(staged.filter((r) => r.format === fmt));
  }
  // per-frame solve/pipeline share distribution.
  const perFrameShare = staged.map((r) => ratio(num(r.top_stages.solve) || 0, r.pipeline_ms)).filter((v) => num(v) !== null);
  return {
    definition: "The 'solve' top-level stage is the blind plate-solve sweep. share = Σ(solve) / Σ(pipeline_ms) over solved frames carrying a stage decomposition. Denominator is pipeline_ms (summed per-stage pipeline time); a wall-based share is also given.",
    denominator: { basis: 'pipeline_ms', frames: staged.length, frame_kind: 'solved-with-stage-decomposition' },
    overall: block(staged),
    by_format: byFormat,
    per_frame_solve_share_of_pipeline: roundStats(summarize(perFrameShare)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// blindVsAssisted — frame-paired wall comparison (the hinted-cocoon story).
// A frame qualifies when it has BOTH a blind attempt that RAN and an assisted
// solve. Paired by frame content sha (the join the core already performed).
// blind_wall / assisted_wall summarised per frame and in aggregate; the speedup
// is aggregate blind median / assisted median.
// ═══════════════════════════════════════════════════════════════════════════
export function blindVsAssisted(frames) {
  const perFrame = [];
  const blindMeans = [], assistedMeans = [];
  for (const f of frames) {
    if (!f.has_assisted_solve) continue;
    const blind = (f.ledger_rows || [])
      .map((lr) => ({ wall: num(lr.wall_ms), outcome: str(lr.resolved_outcome) || str(lr.outcome), skipped: /^skipped/i.test(str(lr.resolved_outcome) || str(lr.outcome) || '') }))
      .filter((r) => r.wall !== null && r.wall > 0 && !r.skipped);
    const assisted = (f.envelope_rows || [])
      .filter((er) => str(er.outcome) === 'solved')
      .map((er) => ({ wall: num(er.wall_ms), outcome: 'solved' }))
      .filter((r) => r.wall !== null && r.wall > 0);
    if (!blind.length || !assisted.length) continue;
    const blindWalls = blind.map((r) => r.wall);
    const asstWalls = assisted.map((r) => r.wall);
    const bMean = blindWalls.reduce((a, b) => a + b, 0) / blindWalls.length;
    const aMean = asstWalls.reduce((a, b) => a + b, 0) / asstWalls.length;
    blindMeans.push(bMean); assistedMeans.push(aMean);
    perFrame.push({
      id: f.id, sha: f.sha,
      blind_attempts: blind.length,
      blind_outcomes: [...new Set(blind.map((r) => r.outcome))].sort(),
      blind_wall_ms: roundStats(summarize(blindWalls)),
      assisted_solves: assisted.length,
      assisted_wall_ms: roundStats(summarize(asstWalls)),
      speedup: round(ratio(bMean, aMean), 2),
    });
  }
  const blindAgg = roundStats(summarize(blindMeans));
  const asstAgg = roundStats(summarize(assistedMeans));
  return {
    definition: 'Frames carrying BOTH a blind attempt that ran and an assisted solve, joined by frame content sha. Per-frame wall summarised over that frame\'s blind attempts vs its assisted solves; aggregate over per-frame mean walls. speedup = blind median / assisted median.',
    paired_frames: perFrame.length,
    blind_wall_ms: blindAgg,
    assisted_wall_ms: asstAgg,
    speedup_median: round(ratio(blindAgg.median, asstAgg.median), 2),
    speedup_mean: round(ratio(blindAgg.mean, asstAgg.mean), 2),
    per_frame: perFrame,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// runWallTrends — wall distribution per run.
// run identity = row.run_label ?? its source ledger file (additive-safe: a new
// run appended to the manifest self-separates by its own source). Skipped/
// not-run rows are excluded from the wall summary but counted honestly.
// ═══════════════════════════════════════════════════════════════════════════
export function runWallTrends(rows) {
  // full source path (not basename) so two ledgers sharing a basename never merge.
  const runKey = (r) => r.run_label || r.source || '∅';
  const buckets = new Map();
  for (const r of rows) {
    const k = runKey(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const by_run = {};
  for (const k of [...buckets.keys()].sort()) {
    const rs = buckets.get(k);
    const ranRows = rs.filter((r) => r.ran);
    const byOutcome = {};
    for (const r of rs) { const o = r.outcome || 'null'; byOutcome[o] = (byOutcome[o] || 0) + 1; }
    const lanes = [...new Set(rs.map((r) => r.lane))].sort();
    by_run[k] = {
      lanes,
      rows: rs.length,
      ran: ranRows.length,
      not_run: rs.length - ranRows.length,
      by_outcome: byOutcome,
      wall_ms: roundStats(summarize(ranRows.map((r) => r.wall_ms))),
      source: [...new Set(rs.map((r) => r.source).filter(Boolean))].sort(),
    };
  }
  return {
    definition: 'run identity = row.run_label if present, else the basename of the source ledger. Wall summary excludes not-run (skipped / zero-wall) rows; those are counted under not_run.',
    by_run,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// savingsProjection — PROJECTION, never a measurement.
// Models: if a fraction X of the DISTINCT frames that currently fail blind (a
// blind attempt that RAN but did not solve: no_solve / *timeout) were instead
// solved via the assisted lane at cost A ms/frame, what is the projected sweep
// wall over that modelled frame set?
//   Each distinct frame's blind_wall_i = the MEAN of its blind-failing attempt
//   walls (a frame retried across ledgers is ONE modelled frame, not two).
//   projected_total = Σ_frames [ (1-X)·blind_wall_i + X·A ]
//   savings         = baseline_total − projected_total = X·(baseline_total − n·A)
// A defaults to the MEASURED median assisted wall from this corpus; absent
// assisted data ⇒ projection ABSENT (NOT MEASURED). Every measured input is named.
// ═══════════════════════════════════════════════════════════════════════════
export function savingsProjection(rows, lever) {
  if (!lever || num(lever.assisted_fraction) === null) {
    return { requested: false, reason: 'No lever supplied. Pass --assisted-fraction <0..1> (optionally --assisted-wall-ms) or spec.savings to model projected wall. Projection is opt-in so a bare run reports only measurements.' };
  }
  const X = Math.max(0, Math.min(1, lever.assisted_fraction));

  // measured assisted wall A (median), unless overridden.
  const assistedWalls = rows.filter((r) => r.lane === 'assisted' && r.outcome === 'solved' && r.ran).map((r) => r.wall_ms);
  const measuredA = summarize(assistedWalls).median;
  const A = num(lever.assisted_wall_ms) ?? num(measuredA);
  if (A === null) {
    return { requested: true, projection: false, reason: 'No assisted wall available (no assisted solves in corpus and no --assisted-wall-ms override): projected wall is NOT MEASURED.' };
  }

  // modelled pool: blind attempts that RAN but did not solve (the sweep-wall pool),
  // then collapsed to DISTINCT frames (a frame is one modelled unit, not per-retry).
  const failingRows = rows.filter((r) => r.lane === 'blind' && r.ran && !/solved/i.test(r.outcome || '') && r.wall_ms !== null);
  const perFrame = new Map(); // key → [wall,…]
  for (const r of failingRows) {
    if (!perFrame.has(r.key)) perFrame.set(r.key, []);
    perFrame.get(r.key).push(r.wall_ms);
  }
  const frameWalls = [...perFrame.values()].map((ws) => ws.reduce((a, b) => a + b, 0) / ws.length);
  const n = frameWalls.length;
  const baseline = frameWalls.reduce((a, b) => a + b, 0);
  const projected = frameWalls.reduce((a, w) => a + ((1 - X) * w + X * A), 0);
  const savings = baseline - projected;

  return {
    projection: true,
    label: 'PROJECTION — modelled wall, not a measurement.',
    inputs: {
      assisted_fraction: X,
      assisted_wall_ms: round(A, 1),
      assisted_wall_ms_source: num(lever.assisted_wall_ms) !== null ? 'override:--assisted-wall-ms' : `measured:median assisted solve wall (n=${assistedWalls.length})`,
      modelled_set: 'distinct frames with a blind attempt that ran but did not solve (no_solve / *timeout); per-frame blind wall = mean of its failing attempts',
      modelled_frames: n,
      blind_failing_attempts: failingRows.length,
      baseline_wall_ms: round(baseline, 1),
      baseline_wall_ms_source: 'measured: Σ per-frame mean blind wall over the modelled frames',
    },
    projected_wall_ms: round(projected, 1),
    projected_savings_ms: round(savings, 1),
    projected_savings_fraction: round(ratio(savings, baseline)),
    formula: 'projected = Σ_frames[(1-X)·blind_wall_i + X·A];  savings = X·(baseline − n·A)',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// computeWallStats — assemble the full `data` payload from a loaded corpus.
// ═══════════════════════════════════════════════════════════════════════════
export function computeWallStats(loaded, spec = {}) {
  let frames = loaded.frames;
  if (str(spec.format)) {
    const want = spec.format.toUpperCase();
    // keep a frame if any of its timing rows match the requested format.
    frames = frames.filter((f) => {
      const rs = extractTimingRows([f]);
      return rs.some((r) => r.format === want);
    });
  }
  let rows = extractTimingRows(frames);
  if (str(spec.format)) rows = rows.filter((r) => r.format === spec.format.toUpperCase());

  const byLane = { blind: 0, assisted: 0 };
  const byFormat = {}, byOutcome = {};
  let ran = 0, notRun = 0, withStages = 0;
  for (const r of rows) {
    byLane[r.lane] = (byLane[r.lane] || 0) + 1;
    byFormat[r.format] = (byFormat[r.format] || 0) + 1;
    const o = r.outcome || 'null'; byOutcome[o] = (byOutcome[o] || 0) + 1;
    if (r.ran) ran++; else notRun++;
    if (r.has_stages) withStages++;
  }

  return {
    corpus_summary: {
      frames: frames.length,
      timing_rows: rows.length,
      rows_ran: ran,
      rows_not_run: notRun,
      rows_with_stage_decomposition: withStages,
      by_lane: byLane,
      by_format: byFormat,
      by_outcome: byOutcome,
    },
    stage_medians: stageAggregation(rows),
    solve_wall_decomposition: solveWallDecomposition(rows),
    blind_vs_assisted: blindVsAssisted(frames),
    run_wall_trends: runWallTrends(rows),
    savings_projection: savingsProjection(rows, spec.savings),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

// Build the resolved spec from --spec file (if any) overlaid with flags. The
// resolved spec is what gets emitted — the exact recipe to reproduce the result.
function resolveSpec(args) {
  let spec = { schema: SCHEMA, schema_version: WALL_STATS_VERSION };
  if (str(args.spec)) {
    const fileSpec = JSON.parse(fs.readFileSync(resolvePath(args.spec), 'utf8'));
    spec = { ...spec, ...fileSpec };
  }
  // flag overrides (flags win over file).
  spec.manifest = str(args.manifest) || spec.manifest || 'tools/analytics/corpus.default.json';
  if (str(args.format)) spec.format = args.format.toUpperCase();
  if (spec.format) spec.format = String(spec.format).toUpperCase();
  // savings lever
  const af = num(Number(args['assisted-fraction']));
  if (af !== null && args['assisted-fraction'] !== true) {
    spec.savings = { ...(spec.savings || {}), assisted_fraction: af };
  }
  const aw = num(Number(args['assisted-wall-ms']));
  if (aw !== null && args['assisted-wall-ms'] !== true) {
    spec.savings = { ...(spec.savings || {}), assisted_wall_ms: aw };
  }
  return spec;
}

function loadFromSpec(spec, rootOverride) {
  // manifest path resolves against repo root; a --root overrides where the
  // manifest's relative corpus paths resolve (for cross-checkout runs). The
  // absolute root never enters `data`, so `data` stays byte-identical.
  const manifestPath = resolvePath(spec.manifest);
  const m = loadManifest(manifestPath);
  const root = rootOverride ? path.resolve(rootOverride)
    : (m.root ? resolvePath(m.root) : REPO_ROOT);
  const loaded = loadCorpus({
    receiptDirs: m.receiptDirs || [],
    ledgers: m.ledgers || [],
    dossierDir: m.dossierDir,
    dossierDirs: m.dossierDirs,
    envelopeLedgers: m.envelopeLedgers || [],
    root,
  });
  loaded.__manifest = m;
  loaded.__root = root;
  return loaded;
}

export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`wall_stats.mjs — wall-clock economics analytics (spec-as-receipt)

Usage:
  node tools/analytics/wall_stats.mjs [flags]

Flags:
  --spec <file>              JSON spec file; flags below override its fields
  --manifest <path>          corpus manifest (default tools/analytics/corpus.default.json)
  --root <path>              override where the manifest's relative paths resolve
                             (cross-checkout runs; never enters the result data)
  --format <FITS|CR2|...>    restrict every section to one frame format
  --assisted-fraction <x>    enable the savings PROJECTION: fraction 0..1 of
                             blind-failing sweep frames modelled as assisted
  --assisted-wall-ms <ms>    override the assisted wall cost (default: measured median)
  --out <file>               write result JSON here (default: stdout)
  --help                     this text

Emits { spec, provenance, data }; data is byte-identical for a given corpus+spec.
`);
    return 0;
  }

  const spec = resolveSpec(args);
  const loaded = loadFromSpec(spec, str(args.root));
  const data = computeWallStats(loaded, spec);

  const provenance = {
    tool: 'tools/analytics/wall_stats.mjs',
    tool_version: WALL_STATS_VERSION,
    corpus_core_version: CORPUS_CORE_VERSION,
    manifest: spec.manifest,
    ...corpusProvenance(loaded, loaded.__root),
  };
  const result = emitResult(spec, data, provenance);
  const text = stableStringify(result, 2) + '\n';

  if (str(args.out)) {
    fs.writeFileSync(resolvePath(args.out), text);
    process.stderr.write(`wall_stats: wrote ${resolvePath(args.out)}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

// run when invoked directly (never on import).
const isMain = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = path.resolve(fileURLToPath(import.meta.url));
    return !!invoked && self === invoked;
  } catch { return false; }
})();

if (isMain) process.exit(runCli(process.argv.slice(2)));
