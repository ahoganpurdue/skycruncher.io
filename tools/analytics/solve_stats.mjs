#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/solve_stats.mjs — solve / failure analytics over the corpus.
//
// Built ON TOP OF tools/analytics/lib/corpus.mjs (the query core — imported, never
// modified). Emits the spec-as-receipt envelope { spec, provenance, data } so any
// headline is re-derivable bit-for-bit from its own record (the reproducibility
// law). The ONLY wall-clock value is provenance.generated_at.
//
// WHAT IT MEASURES (every rate states its DENOMINATOR explicitly — the m4-recall
// lesson: a rate without its denominator is a lie):
//   · blind solve rate, split by {format · rig family · header-pointing presence ·
//     solved_via · confirm_status · ledger source}, with BOTH denominators
//     (attempted = solver actually ran; all = incl. deliberately-skipped frames).
//   · assisted (hinted) solve stats — reported in a SEPARATE lane block and NEVER
//     pooled into blind numbers (a hinted rescue must not inflate a blind rate).
//   · failure taxonomy (join the forensic dossier taxonomy.class + stage_of_death),
//     cross-tabbed by format and rig.
//   · recovery / regression tracking — kind transitions across runs (a frame the
//     blind population failed but a rerun recovered = RECOVERY; a frame the blind
//     lane failed but the assisted lane solved = an ASSISTED recovery, kept apart).
//   · matched-star + confidence distributions (over SOLVED frames only — a failed
//     solve has null matched/confidence, never zero-filled).
//   · a per-run-label comparison (blind population vs HINTED-COCOON) laid side by
//     side, EXPLICITLY flagged as different frame sets + different lanes, not a
//     controlled A/B.
//
// HOUSE LAWS: LAW 3 honest-or-absent (missing → null / "unmeasured", never
// fabricated); deterministic (canonical key sort via the core's stableStringify;
// groups iterated in sorted order); tools-lane only (zero src/ edits); node-run.
//
// USAGE:
//   node tools/analytics/solve_stats.mjs                 # default corpus → stdout
//   node tools/analytics/solve_stats.mjs --root <dir>    # resolve relative manifest
//                                                          paths against <dir> (use
//                                                          when running from a
//                                                          worktree whose test_results
//                                                          live in the main checkout)
//   node tools/analytics/solve_stats.mjs --spec <file>   # custom corpus manifest
//   node tools/analytics/solve_stats.mjs --out <file>    # write JSON to a file
//   node tools/analytics/solve_stats.mjs --headlines     # human-readable summary
//                                                          to stderr (JSON still emits)
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCorpus, loadManifest, DEFAULT_MANIFEST_PATH, REPO_ROOT,
  groupBy, summarize, emitResult, corpusProvenance, stableStringify, resolvePath,
} from './lib/corpus.mjs';

export const SOLVE_STATS_VERSION = '1.0.0';

// ── rig-family rules (ordered; first match wins). Emitted into the spec so the
// classification is auditable + reproducible. Camera model is READ from the
// blind receipt's metadata.camera_model (the ONLY place it lives); a frame with
// no receipt has no camera model → family 'unknown (no receipt)'. Nothing is
// invented: an unmatched-but-present model becomes 'other:<model>' verbatim. ──
export const RIG_FAMILY_RULES = [
  { pattern: 'seestar', family: 'ZWO Seestar' },
  { pattern: 'canon|eos', family: 'Canon DSLR' },
  { pattern: 'atr\\d', family: 'Altair/ToupTek 533' },
  { pattern: 'asiair', family: 'ZWO ASIAIR' },
  { pattern: 'asi\\d|\\basi\\b', family: 'ZWO ASI' },
];

// ── small honest helpers ──────────────────────────────────────────────────────
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }
function round4(x) { return x == null ? null : Math.round(x * 1e4) / 1e4; }

// rate cell: numerator / denominator, honest null when the denominator is 0
// (an empty group has NO rate — never 0-as-absent, never division noise).
function rateCell(numer, denom) {
  const d = denom || 0;
  return {
    n: numer,
    d: denom,
    rate: d > 0 ? round4(numer / d) : null,
    pct: d > 0 ? round1((numer / d) * 100) : null,
  };
}

// ── per-frame derived attributes (all READ from the join, honest-absent) ──────

// format: ledger.format is authoritative + present on every population frame;
// fall back to the dossier's frame.source_format, then the filename extension.
export function frameFormat(f) {
  for (const r of f.ledger_rows) if (r.format) return String(r.format).toUpperCase();
  const sf = f.dossier && f.dossier.frame && f.dossier.frame.source_format;
  if (sf) return String(sf).toUpperCase();
  for (const nm of f.frame_names) {
    const m = /\.([a-z0-9]+)$/i.exec(nm);
    if (m) { const e = m[1].toLowerCase(); if (e === 'fit' || e === 'fits') return 'FITS'; if (e === 'cr2') return 'CR2'; return e.toUpperCase(); }
  }
  return null;
}

// camera model (raw) — only lives in the blind receipt's metadata. null when no
// receipt (skipped / timed-out frames never produced one).
export function cameraModel(f) {
  const m = f.receipt && f.receipt.metadata;
  return (m && typeof m.camera_model === 'string' && m.camera_model.trim()) ? m.camera_model.trim() : null;
}

// rig family via the ordered rule list; assisted frames carry an explicit rig
// tag in their envelope deposit (envelope_rows[].rig) — prefer that when a
// frame's kind is assisted so the cocoon rig is named honestly even though its
// blind receipt's camera model would also resolve.
export function rigFamily(f, rules = RIG_FAMILY_RULES) {
  const cam = cameraModel(f);
  if (cam) {
    for (const { pattern, family } of rules) {
      if (new RegExp(pattern, 'i').test(cam)) return family;
    }
    return `other:${cam}`;
  }
  // no receipt: fall back to an assisted deposit's rig tag if present, else unknown.
  const env = f.envelope_rows.find((r) => typeof r.rig === 'string' && r.rig.trim());
  if (env) return `rig:${env.rig.trim()}`;
  return 'unknown (no receipt)';
}

// header-pointing presence: did the input file carry a pointing/WCS hint in its
// header? Measured from the blind receipt's metadata.ra_hint + dec_hint (both
// non-null ⇒ present). No receipt ⇒ 'unmeasured' (honest — never folded into
// 'absent'). NOTE: this is header POINTING (RA/DEC hint the solver may lean on),
// corroborated by solve_provenance.solved_via 'assisted:metadata'; it is not a
// claim that a full fitted WCS existed in the header.
export function headerPointing(f) {
  const m = f.receipt && f.receipt.metadata;
  if (!m) return 'unmeasured';
  const has = num(m.ra_hint) !== null && num(m.dec_hint) !== null;
  return has ? 'present' : 'absent';
}

// solved_via — how a BLIND solve was achieved (blind receipt's solve_provenance).
export function solvedVia(f) {
  const sp = f.receipt && f.receipt.solve_provenance;
  return (sp && typeof sp.solved_via === 'string' && sp.solved_via.trim()) ? sp.solved_via.trim() : null;
}

// blind confirm status (forced-photometry confirmation) from the blind ledger row.
export function confirmStatus(f) {
  for (const r of f.ledger_rows) if (r.confirm_status) return String(r.confirm_status);
  const c = f.receipt && f.receipt.confirm_status;
  return (typeof c === 'string' && c) ? c : null;
}

// blind matched-star count + confidence (the ledger scalar; receipt fallback).
export function blindMatched(f) {
  for (const r of f.ledger_rows) { const v = num(r.stars_matched); if (v !== null) return v; }
  const s = f.receipt && f.receipt.solution;
  return s ? num(s.stars_matched) : null;
}
export function blindConfidence(f) {
  for (const r of f.ledger_rows) { const v = num(r.confidence); if (v !== null) return v; }
  const s = f.receipt && f.receipt.solution;
  return s ? num(s.confidence) : null;
}

// taxonomy class + stage-of-death label from the forensic dossier.
export function taxonomyClass(f) {
  const t = f.dossier && f.dossier.taxonomy;
  return (t && typeof t.class === 'string' && t.class) ? t.class : null;
}
export function stageOfDeath(f) {
  const s = f.dossier && f.dossier.stage_of_death;
  if (!s) return null;
  if (typeof s === 'string') return s;
  // failure dossiers carry {stage_reached, stage_of_death, reason}
  if (typeof s === 'object') return s.stage_of_death || s.stage_reached || null;
  return null;
}

// ── blind-lane membership + disposition ───────────────────────────────────────
// A frame is in the BLIND lane if it carries blind evidence (a blind ledger row
// OR a blind receipt). Every population frame does. Its disposition:
//   solved  — a blind solve exists (INCLUDING a rerun recovery: kind flips to
//             solved while the population outcome stays no_solve).
//   skipped — the solver was deliberately not run (skipped_correlated_set /
//             skipped_too_large). NOT an attempt.
//   failed  — attempted and did not solve (no_solve / honest_timeout / ladder
//             exhaustion / …). Assisted-lane frames that FAILED blind land here —
//             they are blind failures and stay in the blind denominator.
export function inBlindLane(f) { return f.ledger_rows.length > 0 || !!f.receipt; }
export function isSkipped(f) {
  if (/^skipped/i.test(f.outcome || '')) return true;
  return taxonomyClass(f) === 'skipped';
}
export function blindDisposition(f) {
  if (f.has_blind_solve) return 'solved';
  if (isSkipped(f)) return 'skipped';
  return 'failed';
}

// tally a set of blind frames into an explicit-denominator cell.
function blindTally(frames) {
  let n_frames = 0, n_skipped = 0, n_solved = 0;
  for (const f of frames) {
    n_frames++;
    const d = blindDisposition(f);
    if (d === 'skipped') n_skipped++;
    else if (d === 'solved') n_solved++;
  }
  const n_attempted = n_frames - n_skipped;
  const n_failed = n_attempted - n_solved;
  return {
    n_frames, n_skipped, n_attempted, n_solved, n_failed,
    solve_rate_of_attempted: rateCell(n_solved, n_attempted),
    solve_rate_of_all_blind: rateCell(n_solved, n_frames),
  };
}

// split a frame set by a key function → { keyed: {k: blindTally}, sorted keys }.
function blindSplit(frames, keyFn) {
  const g = groupBy(frames, keyFn);
  const out = {};
  for (const [k, fs_] of g) out[k] = blindTally(fs_);
  return out;
}

// simple count-histogram, sorted keys, honest ∅ for null.
function countBy(frames, keyFn) {
  const g = groupBy(frames, keyFn);
  const out = {};
  for (const [k, fs_] of g) out[k] = fs_.length;
  return out;
}

// nested cross-tab: outer key → { inner key → count }.
function crossTab(frames, outerFn, innerFn) {
  const g = groupBy(frames, outerFn);
  const out = {};
  for (const [k, fs_] of g) out[k] = countBy(fs_, innerFn);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// computeSolveStats — the whole analysis over a loaded corpus. Pure + deterministic.
// ═══════════════════════════════════════════════════════════════════════════
export function computeSolveStats(loaded, rules = RIG_FAMILY_RULES) {
  const frames = loaded.frames;
  const counts = loaded.counts;

  const blind = frames.filter(inBlindLane);
  const blindNonSolved = blind.filter((f) => blindDisposition(f) !== 'solved');
  const blindSolved = blind.filter((f) => blindDisposition(f) === 'solved');

  // ── overview ────────────────────────────────────────────────────────────────
  const overview = {
    n_frames: frames.length,
    by_kind: counts.by_kind,
    by_solve_class: counts.by_solve_class,
    by_key_mode: counts.by_key_mode,
    by_outcome: counts.by_outcome,
    with_receipt: counts.with_receipt,
    with_dossier: counts.with_dossier,
    with_envelope: counts.with_envelope,
    receipt_collisions: counts.receipt_collisions,
    stem_sha_conflicts: counts.stem_sha_conflicts,
    lanes_note: 'blind and assisted (hinted) solves are reported in SEPARATE lane blocks and NEVER pooled; an assisted rescue never inflates a blind rate.',
  };

  // ── blind lane ────────────────────────────────────────────────────────────────
  const blindLane = {
    denominators: {
      n_blind_frames: blind.length,
      n_skipped: blind.filter(isSkipped).length,
      n_attempted: blind.filter((f) => blindDisposition(f) !== 'skipped').length,
      n_solved: blindSolved.length,
      note: 'blind frames = every frame with blind evidence (ledger row or receipt). attempted = blind frames the solver actually ran (skipped_correlated_set / skipped_too_large excluded). solve rate is reported over BOTH denominators.',
    },
    overall: blindTally(blind),
    by_format: blindSplit(blind, frameFormat),
    by_rig_family: blindSplit(blind, (f) => rigFamily(f, rules)),
    by_header_pointing: blindSplit(blind, headerPointing),
    // among SOLVED blind frames only (denominator = n_solved): how it was solved
    // and how well it was confirmed. NOTE: solved_via 'assisted:metadata' is the
    // blind solver leaning on the file's OWN header pointing — it is NOT the
    // user-assisted lane (that lives in assisted_lane below).
    solved_via_of_solved: countBy(blindSolved, solvedVia),
    confirm_status_of_solved: countBy(blindSolved, confirmStatus),
    by_ledger_source_of_solved: countBy(blindSolved, (f) => {
      const srcs = [...new Set(f.ledger_rows.map((r) => r.__ledger))].sort();
      // a recovery joins both population + rerun ledgers; label it by whether a
      // rerun row exists, so the rerun's contribution is visible.
      return srcs.some((s) => /nosolve_rerun/.test(s)) && f.outcome !== 'solved'
        ? 'nosolve_rerun (recovery)' : 'population';
    }),
  };

  // ── assisted lane (SEPARATE — never pooled) ──────────────────────────────────
  const assistedFrames = frames.filter((f) => f.has_assisted_solve);
  const assistedRows = [];
  for (const f of assistedFrames) for (const r of f.envelope_rows) if (r.outcome === 'solved') assistedRows.push(r);
  const assistedMatched = assistedRows.map((r) => num(r.matched)).filter((v) => v !== null);
  const assistedConf = assistedRows.map((r) => num(r.confidence)).filter((v) => v !== null);
  const assistedLane = {
    note: 'assisted (user-hinted) solves. These frames were attempted BLIND first and FAILED — the assisted lane is a targeted rescue, not a general population. Reported apart from blind numbers by law.',
    n_assisted_frames: assistedFrames.length,
    n_assisted_solve_rows: assistedRows.length,
    of_which_failed_blind: assistedFrames.filter((f) => !f.has_blind_solve).length,
    run_labels: [...new Set(assistedRows.map((r) => r.run_label).filter(Boolean))].sort(),
    by_rig: countBy(assistedFrames, (f) => {
      const r = f.envelope_rows.find((x) => x.rig);
      return r ? r.rig : (rigFamily(f, rules));
    }),
    by_format: countBy(assistedFrames, frameFormat),
    distributions: {
      matched_stars: summarize(assistedMatched),
      confidence: summarize(assistedConf),
    },
  };

  // ── failure taxonomy (over blind NON-solved frames) ──────────────────────────
  const failureTaxonomy = {
    note: `taxonomy of the ${blindNonSolved.length} frames the blind lane did not solve (attempted-and-failed + deliberately-skipped). ${assistedLane.of_which_failed_blind} of these were later rescued in the assisted lane — see recovery_tracking. skipped is a distinct class (not an attempt).`,
    n_blind_non_solved: blindNonSolved.length,
    n_attempted_failures: blindNonSolved.filter((f) => !isSkipped(f)).length,
    by_class: countBy(blindNonSolved, taxonomyClass),
    by_stage_of_death: countBy(blindNonSolved.filter((f) => !isSkipped(f)), stageOfDeath),
    by_class_x_format: crossTab(blindNonSolved, taxonomyClass, frameFormat),
    by_class_x_rig: crossTab(blindNonSolved, taxonomyClass, (f) => rigFamily(f, rules)),
  };

  // ── recovery / regression tracking (kind transitions across runs) ────────────
  // blind RECOVERY: a blind solve exists but the population outcome was NOT solved
  //   (the rerun recovered it — still the blind lane).
  // assisted RECOVERY: blind failed, the assisted lane solved (different lane).
  // REGRESSION: population solved but no blind solve now — honest (expected empty).
  const blindRecoveries = blind
    .filter((f) => f.has_blind_solve && f.outcome !== 'solved')
    .map((f) => ({
      id: f.id, from_outcome: f.outcome, to_kind: f.kind,
      format: frameFormat(f), rig_family: rigFamily(f, rules), taxonomy: taxonomyClass(f),
    }));
  const assistedRecoveries = assistedFrames
    .filter((f) => !f.has_blind_solve)
    .map((f) => ({
      id: f.id, from_outcome: f.outcome, to_kind: f.kind,
      format: frameFormat(f), rig: (f.envelope_rows.find((r) => r.rig) || {}).rig || null,
      taxonomy: taxonomyClass(f),
    }));
  const regressions = blind
    .filter((f) => f.outcome === 'solved' && !f.has_blind_solve)
    .map((f) => ({ id: f.id, outcome: f.outcome, kind: f.kind }));
  const recoveryTracking = {
    note: 'RECOVERY = kind flipped to solved from a non-solved blind population outcome. Blind recoveries stay in the blind lane; assisted recoveries are a separate lane. REGRESSION (population solved → no blind solve) is reported honestly, empty when none.',
    blind_recoveries: { n: blindRecoveries.length, frames: blindRecoveries.sort((a, b) => (a.id < b.id ? -1 : 1)) },
    assisted_recoveries: { n: assistedRecoveries.length, frames: assistedRecoveries.sort((a, b) => (a.id < b.id ? -1 : 1)) },
    regressions: { n: regressions.length, frames: regressions.sort((a, b) => (a.id < b.id ? -1 : 1)) },
  };

  // ── distributions (SOLVED frames only — failed rows carry null, never 0) ─────
  const blindSolvedMatched = blindSolved.map(blindMatched).filter((v) => v !== null);
  const blindSolvedConf = blindSolved.map(blindConfidence).filter((v) => v !== null);
  const matchedByFormat = {};
  const confByFormat = {};
  for (const [k, fs_] of groupBy(blindSolved, frameFormat)) {
    matchedByFormat[k] = summarize(fs_.map(blindMatched).filter((v) => v !== null));
    confByFormat[k] = summarize(fs_.map(blindConfidence).filter((v) => v !== null));
  }
  const distributions = {
    note: 'over SOLVED frames only — a failed solve reports null matched/confidence and is excluded (never zero-filled). n is the honest sample size per group.',
    blind_solved: {
      matched_stars: summarize(blindSolvedMatched),
      confidence: summarize(blindSolvedConf),
      matched_stars_by_format: matchedByFormat,
      confidence_by_format: confByFormat,
    },
    assisted: assistedLane.distributions,
  };

  // ── per-run-label comparison (blind population vs HINTED-COCOON) ──────────────
  // The blind ledgers carry no run_label field (only run_id) — the blind label is
  // SYNTHESIZED from the corpus and marked as such; the assisted label is READ
  // from the envelope deposit. This is a side-by-side of TWO DIFFERENT frame sets
  // in TWO DIFFERENT lanes — explicitly NOT a controlled A/B.
  const blindTallyAll = blindTally(blind);
  const runLabelComparison = {
    note: 'DIFFERENT frame sets + DIFFERENT lanes — a side-by-side, NOT a controlled comparison. The blind label is synthesized (blind ledgers carry no run_label); the assisted label is read from the envelope run_label.',
    rows: [
      {
        label: 'BLIND-POPULATION-2026-07-11',
        label_source: 'synthesized (no run_label in blind ledgers)',
        lane: 'blind',
        n_frames: blind.length,
        n_attempted: blindTallyAll.n_attempted,
        n_solved: blindTallyAll.n_solved,
        solve_rate_of_attempted: blindTallyAll.solve_rate_of_attempted,
        matched_stars: summarize(blindSolvedMatched),
        confidence: summarize(blindSolvedConf),
      },
      {
        label: assistedLane.run_labels[0] || 'HINTED-COCOON',
        label_source: 'read from envelope run_label',
        lane: 'assisted',
        n_frames: assistedFrames.length,
        n_attempted: assistedFrames.length,
        n_solved: assistedFrames.filter((f) => f.has_assisted_solve).length,
        solve_rate_of_attempted: rateCell(assistedFrames.filter((f) => f.has_assisted_solve).length, assistedFrames.length),
        matched_stars: summarize(assistedMatched),
        confidence: summarize(assistedConf),
      },
    ],
  };

  return {
    overview,
    blind_lane: blindLane,
    assisted_lane: assistedLane,
    failure_taxonomy: failureTaxonomy,
    recovery_tracking: recoveryTracking,
    distributions,
    run_label_comparison: runLabelComparison,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const a = { root: null, spec: null, out: null, headlines: false, compact: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--root') a.root = argv[++i];
    else if (t === '--spec') a.spec = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--headlines') a.headlines = true;
    else if (t === '--compact') a.compact = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`solve_stats: unknown arg '${t}'`);
  }
  return a;
}

// resolve the corpus manifest + build the loadCorpus spec (records the resolved
// root so the emitted spec is a complete reproduction record).
function resolveCorpusSpec(args) {
  const manifestPath = args.spec ? path.resolve(args.spec) : DEFAULT_MANIFEST_PATH;
  const m = loadManifest(manifestPath);
  const root = args.root ? path.resolve(args.root) : (m.root ? resolvePath(m.root) : REPO_ROOT);
  return {
    manifest_path: manifestPath,
    resolved_root: root,
    receiptDirs: m.receiptDirs || [],
    ledgers: m.ledgers || [],
    dossierDir: m.dossierDir,
    dossierDirs: m.dossierDirs,
    envelopeLedgers: m.envelopeLedgers || [],
  };
}

function humanHeadlines(data) {
  const L = [];
  const o = data.overview, b = data.blind_lane, a = data.assisted_lane;
  L.push(`corpus: ${o.n_frames} frames  (kind ${JSON.stringify(o.by_kind)}; lanes ${JSON.stringify(o.by_solve_class)})`);
  const ov = b.overall;
  L.push(`BLIND solve rate: ${ov.n_solved}/${ov.n_attempted} attempted = ${ov.solve_rate_of_attempted.pct}%  ` +
    `(of all ${ov.n_frames} blind incl ${ov.n_skipped} skipped = ${ov.solve_rate_of_all_blind.pct}%)`);
  L.push('  by format:');
  for (const [k, c] of Object.entries(b.by_format)) {
    L.push(`    ${k.padEnd(6)} ${c.n_solved}/${c.n_attempted} attempted = ${c.solve_rate_of_attempted.pct == null ? 'n/a' : c.solve_rate_of_attempted.pct + '%'}  (skipped ${c.n_skipped})`);
  }
  L.push('  by rig family:');
  for (const [k, c] of Object.entries(b.by_rig_family)) {
    L.push(`    ${k.padEnd(22)} ${c.n_solved}/${c.n_attempted} = ${c.solve_rate_of_attempted.pct == null ? 'n/a' : c.solve_rate_of_attempted.pct + '%'}`);
  }
  L.push('  by header-pointing:');
  for (const [k, c] of Object.entries(b.by_header_pointing)) {
    L.push(`    ${k.padEnd(11)} ${c.n_solved}/${c.n_attempted} = ${c.solve_rate_of_attempted.pct == null ? 'n/a' : c.solve_rate_of_attempted.pct + '%'}`);
  }
  L.push(`  solved_via (of ${b.denominators.n_solved} blind solves): ${JSON.stringify(b.solved_via_of_solved)}`);
  L.push(`  confirm_status (of solved): ${JSON.stringify(b.confirm_status_of_solved)}`);
  L.push(`ASSISTED lane (separate): ${a.n_assisted_frames} frames, all previously blind-failed → ${data.run_label_comparison.rows[1].n_solved} solved  ` +
    `[${a.run_labels.join(',')}]  rig ${JSON.stringify(a.by_rig)}`);
  L.push(`  assisted matched median ${a.distributions.matched_stars.median}, confidence median ${round4(a.distributions.confidence.median)}`);
  L.push(`FAILURE taxonomy (${data.failure_taxonomy.n_blind_non_solved} non-solved, ${data.failure_taxonomy.n_attempted_failures} attempted-fail): ${JSON.stringify(data.failure_taxonomy.by_class)}`);
  const rt = data.recovery_tracking;
  L.push(`RECOVERY: blind ${rt.blind_recoveries.n} (rerun), assisted ${rt.assisted_recoveries.n} (hinted); regressions ${rt.regressions.n}`);
  const d = data.distributions.blind_solved;
  L.push(`BLIND solved distributions: matched n=${d.matched_stars.n} median ${d.matched_stars.median}; confidence n=${d.confidence.n} median ${round4(d.confidence.median)}`);
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      'solve_stats.mjs — solve/failure analytics over the analytics corpus.',
      'usage: node tools/analytics/solve_stats.mjs [--root <dir>] [--spec <manifest>] [--out <file>] [--headlines] [--compact]',
      '  --root       resolve relative manifest paths against <dir> (worktree → main checkout test_results)',
      '  --spec       custom corpus manifest (default: tools/analytics/corpus.default.json)',
      '  --out        write the result JSON to a file (default: stdout)',
      '  --headlines  print a human summary to stderr (JSON still emitted)',
      '  --compact    single-line JSON (default: 2-space indent)',
      '',
    ].join('\n'));
    return 0;
  }

  const cs = resolveCorpusSpec(args);
  const loaded = loadCorpus({
    receiptDirs: cs.receiptDirs, ledgers: cs.ledgers,
    dossierDir: cs.dossierDir, dossierDirs: cs.dossierDirs,
    envelopeLedgers: cs.envelopeLedgers, root: cs.resolved_root,
  });

  const data = computeSolveStats(loaded);

  // spec-as-receipt: the EXACT resolved spec, so a figure re-derives from its record.
  const spec = {
    tool: 'solve_stats',
    tool_version: SOLVE_STATS_VERSION,
    manifest_path: path.relative(cs.resolved_root, cs.manifest_path).split(path.sep).join('/'),
    resolved_root: cs.resolved_root.split(path.sep).join('/'),
    corpus: {
      receiptDirs: cs.receiptDirs, ledgers: cs.ledgers,
      dossierDir: cs.dossierDir || null, dossierDirs: cs.dossierDirs || null,
      envelopeLedgers: cs.envelopeLedgers,
    },
    rig_family_rules: RIG_FAMILY_RULES,
  };

  const result = emitResult(spec, data, corpusProvenance(loaded, cs.resolved_root));
  const json = args.compact ? JSON.stringify(result) : stableStringify(result, 2);

  if (args.out) fs.writeFileSync(path.resolve(args.out), json + '\n');
  else process.stdout.write(json + '\n');

  if (args.headlines) process.stderr.write('\n' + humanHeadlines(data) + '\n');
  return 0;
}

// run-as-main guard (ESM idiom): only execute the CLI when invoked directly.
const invokedDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirect) {
  try { process.exit(main()); }
  catch (e) { process.stderr.write(`solve_stats ERROR: ${e.message}\n`); process.exit(1); }
}
