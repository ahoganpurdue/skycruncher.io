#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/confirm_stats.mjs — confirmation-tier analytics + CLI.
//
// Feeds the FDR-swap validation (task #21: flip the live confirm gate from the
// N-inflated setExcessZ statistic to an FDR statistic). Everything here is a
// READ over the corpus confirm blocks — it computes NOTHING new about the sky,
// it measures the CURRENT confirmation statistic's behaviour so the swap has an
// evidence baseline to beat.
//
// WHAT IT REPORTS (all recomputed from the corpus, never asserted):
//   · per-frame confirm summary — status, setExcessZ, nTargets, confirmed,
//     setGatePassed, perTargetStrength (z/√N), provenance. Honest nulls when a
//     field is absent (INSUFFICIENT_TARGETS / NOT_RUN carry null setExcessZ).
//   · the N-vs-verdict tracker — Pearson(nTargets, setExcessZ) recomputed over
//     the confirmable frames, compared against the research baseline (0.836 from
//     research/confirm_statistic_review_2026-07-12.md). This IS the motivation
//     for the swap: the set statistic scales with √N, so a big-N frame can clear
//     the Z gate on target COUNT rather than per-target signal. High correlation
//     = the statistic is N-confounded; the recompute VALIDATES that finding.
//   · per-target strength z/√N — the M31-canary covariate. It decouples the set
//     statistic from N: an M31-like frame (many targets, weak per-target signal)
//     shows a LARGE nTargets but a SMALL z/√N, and is correctly REFUSED. The raw
//     setExcessZ alone would look "medium" without this N-normalisation.
//   · REFUSED-frame profiles — the nTargets / setExcessZ / z/√N distribution of
//     the frames the gate refused (the population the swap must keep refusing).
//   · --fdr-shadow — old-vs-new statistic comparison, read from
//     deep_confirmed.fdr_shadow blocks WHEN PRESENT. They land after the day-lane
//     shadow re-run; ABSENT everywhere today → that section reports NOT MEASURED
//     (LAW 3: never fabricated, never interpolated).
//
// HOUSE LAWS: LAW 3 honest-or-absent (null / "NOT MEASURED", never a placeholder
// number) · deterministic (same corpus + same spec ⇒ byte-identical result JSON;
// the only wall-clock value is provenance.generated_at, isolated by emitResult) ·
// tools lane only (imports the committed query core, zero src/ touch).
//
// USAGE
//   node tools/analytics/confirm_stats.mjs                 # default corpus → stdout
//   node tools/analytics/confirm_stats.mjs --fdr-shadow    # old-vs-new focus
//   node tools/analytics/confirm_stats.mjs --baseline 0.836 --tolerance 0.05
//   node tools/analytics/confirm_stats.mjs --spec spec.json --out result.json
//   node tools/analytics/confirm_stats.mjs --summary       # headline lines to stderr
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCorpus, loadManifest, DEFAULT_MANIFEST_PATH, resolvePath, REPO_ROOT,
  summarize, emitResult, corpusProvenance, stableStringify,
} from './lib/corpus.mjs';

export const CONFIRM_STATS_VERSION = '1.0.0';

// The research baseline this tool validates against. Cite, never silently move.
export const PEARSON_BASELINE = 0.836; // Pearson(nTargets, setExcessZ), population run
export const DEFAULT_TOLERANCE = 0.05; // |recomputed − baseline| within → AGREES
export const NOT_MEASURED = 'NOT MEASURED';

// The four confirm-tier statuses the gate emits (load-bearing UI contract).
export const CONFIRM_STATUSES = ['CONFIRMED', 'REFUSED', 'INSUFFICIENT_TARGETS', 'NOT_RUN'];

// ── honest scalar helpers ─────────────────────────────────────────────────────
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ═══════════════════════════════════════════════════════════════════════════
// Statistic math (pure — the unit-tested surface).
// ═══════════════════════════════════════════════════════════════════════════

// Pearson product-moment correlation. Honest: needs n≥2 AND non-zero variance in
// BOTH samples, else r=null (a constant column has no linear correlation — never
// return 0 as if measured). Returns { n, r }.
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { n, r: null };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { n, r: null };
  return { n, r: sxy / Math.sqrt(sxx * syy) };
}

// Fractional (average) ranks — ties share the mean rank. Used for Spearman.
function fractionalRanks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

// Spearman rank correlation — a monotone-but-robust companion to Pearson.
// Reported as a secondary robustness stat (the baseline comparison stays on
// Pearson); it resists the leverage of the few very-large-N frames.
export function spearman(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { n, rho: null };
  const rx = fractionalRanks(xs.slice(0, n));
  const ry = fractionalRanks(ys.slice(0, n));
  const { r } = pearson(rx, ry);
  return { n, rho: r };
}

// per-target confirmation strength = setExcessZ / √nTargets. The N-decoupled
// covariate: it normalises the set statistic (which grows with √N) back to a
// per-target signal. null (NOT MEASURED) when either input is absent or n≤0.
export function perTargetStrength(setExcessZ, nTargets) {
  const z = num(setExcessZ), n = num(nTargets);
  if (z === null || n === null || n <= 0) return null;
  return z / Math.sqrt(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-frame confirm summary.
// ═══════════════════════════════════════════════════════════════════════════
// Reads a corpus frame record's BLIND receipt (assisted solves never carry a
// confirm block). confirm_status is the load-bearing UI contract; deep_confirmed
// is the source-of-record for the forced-photometry internals. Every field is
// READ or null. Returns null when the frame has no confirm block at all.
export function confirmSummary(frame) {
  const receipt = frame && frame.receipt;
  if (!isObj(receipt)) return null;
  const cs = isObj(receipt.confirm_status) ? receipt.confirm_status : null;
  const dc = isObj(receipt.deep_confirmed) ? receipt.deep_confirmed : null;
  if (!cs && !dc) return null;

  const status = (cs && typeof cs.status === 'string') ? cs.status : null;
  const setExcessZ = num(cs && cs.setExcessZ) ?? num(dc && dc.setExcessZ);
  const nTargets = num(cs && cs.nTargets);
  const examined = num(dc && dc.examined);
  const confirmed = num(cs && cs.confirmed) ?? num(dc && dc.confirmed);
  const setGateZ = num(cs && cs.setGateZ);
  const setGatePassed = (dc && typeof dc.setGatePassed === 'boolean') ? dc.setGatePassed : null;
  const provenance = (dc && typeof dc.provenance === 'string') ? dc.provenance : null;
  const reason = (cs && typeof cs.reason === 'string' && cs.reason.trim()) ? cs.reason.trim() : null;
  // deep_confirmed.not_measured is truthy when the set statistic was not computed
  // (a boolean true OR a reason STRING in the live data) — read it as a flag.
  const notMeasuredFlag = !!(dc && dc.not_measured);
  // confirmed_stars count is honest evidence of how many the set gate carried.
  const confirmedStars = (dc && Array.isArray(dc.confirmed_stars)) ? dc.confirmed_stars.length : null;

  return {
    key: frame.key ?? null,
    id: frame.id ?? null,
    kind: frame.kind ?? null,
    status,
    setExcessZ,
    nTargets,
    examined,
    confirmed,
    confirmedStars,
    setGateZ,
    setGatePassed,
    perTargetStrength: perTargetStrength(setExcessZ, nTargets),
    provenance,
    fdrShadowPresent: !!(dc && isObj(dc.fdr_shadow)),
    notMeasured: notMeasuredFlag || setExcessZ === null,
    reason,
  };
}

// Collect per-frame summaries for every frame that carries a confirm block,
// deterministically ordered by frame key (the corpus already sorts by key).
export function collectConfirmSummaries(frames) {
  const out = [];
  for (const f of frames) {
    const s = confirmSummary(f);
    if (s) out.push(s);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

// status → count over a summary roster (all four statuses always present, 0-safe
// because these are COUNTS of an enumerated contract, not measurements).
export function statusTally(summaries) {
  const t = {};
  for (const s of CONFIRM_STATUSES) t[s] = 0;
  t['(other)'] = 0;
  t['(null status)'] = 0;
  for (const s of summaries) {
    if (s.status === null) t['(null status)']++;
    else if (Object.prototype.hasOwnProperty.call(t, s.status)) t[s.status]++;
    else t['(other)']++;
  }
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════
// The N-vs-verdict tracker — recompute Pearson(nTargets, setExcessZ).
// ═══════════════════════════════════════════════════════════════════════════
// "Confirmable" = both nTargets and setExcessZ finite. INSUFFICIENT_TARGETS and
// NOT_RUN frames (null setExcessZ) are honestly EXCLUDED — they are NOT MEASURED,
// not zeros. Compares the recompute against the research baseline and reports an
// agreement verdict (never adjusts the baseline to fit — LAW 2 spirit).
export function nVsVerdict(summaries, opts = {}) {
  const baseline = num(opts.baseline) ?? PEARSON_BASELINE;
  const tolerance = num(opts.tolerance) ?? DEFAULT_TOLERANCE;
  const usable = summaries.filter((s) => s.nTargets !== null && s.setExcessZ !== null);
  const N = usable.map((s) => s.nTargets);
  const Z = usable.map((s) => s.setExcessZ);
  const { n, r } = pearson(N, Z);
  const { rho } = spearman(N, Z);
  const delta = (r === null) ? null : r - baseline;
  const agreement = (r === null || delta === null)
    ? NOT_MEASURED
    : (Math.abs(delta) <= tolerance ? 'AGREES' : 'DIVERGES');
  return {
    statistic: 'pearson(nTargets, setExcessZ)',
    n_frames: n,
    pearson: r,
    spearman_rho: rho,
    baseline,
    baseline_source: 'research/confirm_statistic_review_2026-07-12.md',
    tolerance,
    delta,
    agreement,
    excluded_not_measured: summaries.length - usable.length,
    interpretation: r === null ? NOT_MEASURED
      : 'high positive r ⇒ setExcessZ is N-confounded (scales with √N); the FDR swap must decouple the verdict from target COUNT.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// per-target strength block (the M31-canary covariate).
// ═══════════════════════════════════════════════════════════════════════════
// Reports z/√N per frame + a by-status summary, then derives the N-inflation
// canaries deterministically: REFUSED frames ranked by nTargets desc — the
// frames with the MOST targets that the gate still refused, i.e. exactly where a
// count-driven statistic would be most tempted to over-confirm. M31 is one such
// canary; the ranking surfaces it from the data rather than hard-coding a name.
export function perTargetStrengthBlock(summaries) {
  const frames = summaries
    .filter((s) => s.perTargetStrength !== null)
    .map((s) => ({
      key: s.key, id: s.id, status: s.status,
      nTargets: s.nTargets, setExcessZ: s.setExcessZ,
      perTargetStrength: s.perTargetStrength,
    }))
    .sort((a, b) => (b.perTargetStrength - a.perTargetStrength)
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const byStatus = {};
  for (const st of CONFIRM_STATUSES) {
    const vals = frames.filter((f) => f.status === st).map((f) => f.perTargetStrength);
    byStatus[st] = summarize(vals);
  }

  // N-inflation canaries: REFUSED frames with the largest nTargets. Deterministic
  // order (nTargets desc, key asc). Honest — top-5 slice of whatever exists.
  const canaries = frames
    .filter((f) => f.status === 'REFUSED')
    .slice()
    .sort((a, b) => (b.nTargets - a.nTargets) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, 5)
    .map((f) => ({ id: f.id, nTargets: f.nTargets, setExcessZ: f.setExcessZ, perTargetStrength: f.perTargetStrength }));

  return {
    definition: 'perTargetStrength = setExcessZ / sqrt(nTargets)',
    n_frames: frames.length,
    overall: summarize(frames.map((f) => f.perTargetStrength)),
    by_status: byStatus,
    n_inflation_canaries: {
      selection: 'REFUSED frames ranked by nTargets desc — high target COUNT, gate still refused (the M31-canary pattern)',
      frames: canaries,
    },
    per_frame: frames,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REFUSED-frame profile.
// ═══════════════════════════════════════════════════════════════════════════
// The population the current gate refuses — the swap's non-regression target
// (an FDR gate must keep refusing these). Profiles nTargets, setExcessZ, z/√N.
export function refusedProfile(summaries) {
  const refused = summaries.filter((s) => s.status === 'REFUSED');
  return {
    n_frames: refused.length,
    nTargets: summarize(refused.map((s) => s.nTargets)),
    setExcessZ: summarize(refused.map((s) => s.setExcessZ)),
    perTargetStrength: summarize(refused.map((s) => s.perTargetStrength).filter((v) => v !== null)),
    frames: refused
      .map((s) => ({ id: s.id, nTargets: s.nTargets, setExcessZ: s.setExcessZ, perTargetStrength: s.perTargetStrength, setGatePassed: s.setGatePassed }))
      .sort((a, b) => (b.nTargets - a.nTargets) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FDR shadow comparison (old-vs-new statistic).
// ═══════════════════════════════════════════════════════════════════════════
// Reads deep_confirmed.fdr_shadow WHEN PRESENT. The shadow block is expected to
// carry the new-statistic verdict alongside the old so the swap can be judged
// per-frame. Its exact schema lands with the day-lane shadow re-run; we read
// generically (old/new value + gatePassed, whatever fields exist) and never
// assume. ABSENT everywhere today ⇒ status NOT MEASURED (honest-or-absent).
export function fdrShadowBlock(frames) {
  const rows = [];
  for (const f of frames) {
    const dc = f.receipt && f.receipt.deep_confirmed;
    const shadow = isObj(dc) && isObj(dc.fdr_shadow) ? dc.fdr_shadow : null;
    if (!shadow) continue;
    const cs = isObj(f.receipt.confirm_status) ? f.receipt.confirm_status : {};
    const oldValue = num(cs.setExcessZ) ?? num(dc.setExcessZ);
    const oldPassed = (typeof dc.setGatePassed === 'boolean') ? dc.setGatePassed : null;
    // read the new-statistic view generically — support a few plausible field names.
    const newValue = num(shadow.statistic) ?? num(shadow.value) ?? num(shadow.fdr)
      ?? num(shadow.q) ?? num(shadow.z) ?? null;
    const newPassed = (typeof shadow.gatePassed === 'boolean') ? shadow.gatePassed
      : (typeof shadow.passed === 'boolean') ? shadow.passed : null;
    const verdictChanged = (oldPassed !== null && newPassed !== null) ? (oldPassed !== newPassed) : null;
    rows.push({
      id: f.id,
      old: { statistic: 'setExcessZ', value: oldValue, gatePassed: oldPassed },
      new: { value: newValue, gatePassed: newPassed, raw: shadow },
      verdict_changed: verdictChanged,
    });
  }
  if (rows.length === 0) {
    return {
      status: NOT_MEASURED,
      present_frames: 0,
      note: 'deep_confirmed.fdr_shadow absent across the corpus — the FDR shadow re-run has not landed. Old-vs-new comparison NOT MEASURED.',
      comparison: null,
    };
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const changed = rows.filter((r) => r.verdict_changed === true).length;
  return {
    status: 'MEASURED',
    present_frames: rows.length,
    verdict_changes: changed,
    comparison: rows,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Assemble the full data object from a loaded corpus's frames.
// ═══════════════════════════════════════════════════════════════════════════
export function confirmStats(frames, opts = {}) {
  const summaries = collectConfirmSummaries(frames);
  const tally = statusTally(summaries);
  const nvv = nVsVerdict(summaries, opts);
  return {
    corpus: {
      total_frames: frames.length,
      with_confirm_block: summaries.length,
      by_status: tally,
      confirmable_frames: nvv.n_frames, // both nTargets & setExcessZ finite
    },
    n_vs_verdict: nvv,
    per_target_strength: perTargetStrengthBlock(summaries),
    refused_profile: refusedProfile(summaries),
    fdr_shadow: fdrShadowBlock(frames),
    per_frame: summaries,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI — resolve spec, load corpus, emit the spec-as-receipt result.
// ═══════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const a = { baseline: PEARSON_BASELINE, tolerance: DEFAULT_TOLERANCE, fdrShadow: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--fdr-shadow') a.fdrShadow = true;
    else if (t === '--summary') a.summary = true;
    else if (t === '--spec') a.specPath = argv[++i];
    else if (t === '--manifest') a.manifest = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--baseline') a.baseline = Number(argv[++i]);
    else if (t === '--tolerance') a.tolerance = Number(argv[++i]);
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`confirm_stats: unknown arg '${t}'`);
  }
  return a;
}

const HELP = `confirm_stats.mjs — confirmation-tier analytics (spec-as-receipt)
  --fdr-shadow        old-vs-new statistic comparison focus (NOT MEASURED until the shadow re-run lands)
  --baseline <r>      Pearson(nTargets,setExcessZ) baseline to validate against (default ${PEARSON_BASELINE})
  --tolerance <t>     |recomputed − baseline| within → AGREES (default ${DEFAULT_TOLERANCE})
  --manifest <path>   corpus manifest (default tools/analytics/corpus.default.json)
  --spec <path>       JSON spec file; its keys override the flag defaults + name the corpus
  --out <path>        write result JSON to a file (default: stdout)
  --summary           print measured headlines to stderr (data still emitted)`;

// Resolve the effective spec: flags, then an optional --spec file overrides. The
// resolved spec is echoed verbatim in the output so any figure re-derives itself.
function resolveSpec(args) {
  const spec = {
    tool: 'confirm_stats',
    tool_version: CONFIRM_STATS_VERSION,
    manifest: args.manifest || null,
    baseline: args.baseline,
    tolerance: args.tolerance,
    mode: args.fdrShadow ? 'fdr-shadow' : 'full',
    statistic: 'pearson(nTargets, setExcessZ)',
    perTargetStrength: 'setExcessZ / sqrt(nTargets)',
  };
  if (args.specPath) {
    const abs = path.resolve(args.specPath);
    const fromFile = JSON.parse(fs.readFileSync(abs, 'utf8'));
    // a spec file may name its own corpus (receiptDirs/ledgers/…) and override knobs.
    Object.assign(spec, fromFile, { spec_file: abs });
  }
  return spec;
}

// Build the corpus load spec: an explicit corpus in the spec wins; else the
// manifest (named or default). Returns { loaded, manifestPath }.
function loadCorpusForSpec(spec) {
  const hasExplicitCorpus = spec.receiptDirs || spec.ledgers || spec.dossierDir || spec.dossierDirs || spec.envelopeLedgers;
  if (hasExplicitCorpus) {
    const loaded = loadCorpus({
      receiptDirs: spec.receiptDirs || [],
      ledgers: spec.ledgers || [],
      dossierDir: spec.dossierDir,
      dossierDirs: spec.dossierDirs,
      envelopeLedgers: spec.envelopeLedgers || [],
      root: spec.root ? resolvePath(spec.root) : REPO_ROOT,
    });
    return { loaded, manifestPath: spec.spec_file || '(inline spec)' };
  }
  const manifestPath = spec.manifest ? path.resolve(spec.manifest) : DEFAULT_MANIFEST_PATH;
  const m = loadManifest(manifestPath);
  const loaded = loadCorpus({
    receiptDirs: m.receiptDirs || [],
    ledgers: m.ledgers || [],
    dossierDir: m.dossierDir,
    dossierDirs: m.dossierDirs,
    envelopeLedgers: m.envelopeLedgers || [],
    root: m.root ? resolvePath(m.root) : REPO_ROOT,
  });
  return { loaded, manifestPath };
}

export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP + '\n'); return 0; }

  const spec = resolveSpec(args);
  const { loaded, manifestPath } = loadCorpusForSpec(spec);
  const data = confirmStats(loaded.frames, { baseline: spec.baseline, tolerance: spec.tolerance });

  const result = emitResult(spec, data, {
    ...corpusProvenance(loaded, loaded.root),
    manifest: manifestPath,
    corpus_core_version: (loaded.manifest && loaded.manifest.schema_version) || null,
  });
  const text = stableStringify(result);

  if (args.out) fs.writeFileSync(path.resolve(args.out), text + '\n');
  else process.stdout.write(text + '\n');

  if (args.summary) {
    const nvv = data.n_vs_verdict;
    const rp = data.refused_profile;
    const lines = [
      `confirm_stats: ${data.corpus.with_confirm_block} frames with a confirm block of ${data.corpus.total_frames} total`,
      `  by status: ${CONFIRM_STATUSES.map((s) => `${s}=${data.corpus.by_status[s]}`).join('  ')}`,
      `  N-vs-verdict: pearson=${fmt(nvv.pearson)} (n=${nvv.n_frames}) vs baseline ${nvv.baseline} → ${nvv.agreement} (Δ=${fmt(nvv.delta)}); spearman ρ=${fmt(nvv.spearman_rho)}`,
      `  REFUSED profile (n=${rp.n_frames}): nTargets ${fmt(rp.nTargets.min)}..${fmt(rp.nTargets.max)} (med ${fmt(rp.nTargets.median)}); setExcessZ ${fmt(rp.setExcessZ.min)}..${fmt(rp.setExcessZ.max)}; z/√N med ${fmt(rp.perTargetStrength.median)}`,
      `  fdr_shadow: ${data.fdr_shadow.status}${data.fdr_shadow.present_frames ? ` (${data.fdr_shadow.present_frames} frames)` : ''}`,
    ];
    process.stderr.write(lines.join('\n') + '\n');
  }
  return 0;
}

function fmt(v) { return v === null || v === undefined ? NOT_MEASURED : (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v)); }

// run when invoked directly (not when imported by the test).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try { process.exit(runCli(process.argv.slice(2))); }
  catch (e) { process.stderr.write(`confirm_stats: ${e.message}\n`); process.exit(1); }
}
