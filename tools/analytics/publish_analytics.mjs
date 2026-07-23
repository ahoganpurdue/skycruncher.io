#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/publish_analytics.mjs — the analytics PUBLISHER for the
// Clockdrive dashboard "Database" tab.
//
// Runs whatever analytics CLIs are present on disk (solve_stats, confirm_stats,
// wall_stats, residuals — each a spec-as-receipt tool emitting {spec,provenance,
// data}), then rolls their headline numbers into ONE tab-ready receipt:
//   test_results/analytics/database_summary.json   (the Database tab's single feed)
// alongside the raw per-module result JSONs (served for "view source" traceability)
// and an index.json roll-call of the publish run.
//
// WHY a publisher (not the tab fetching each raw file):
//   · The four analytics modules land on SEPARATE branches. Until they merge, the
//     module CLIs are simply ABSENT on disk. The publisher discovers what exists
//     and emits an honest roll-up: a section whose module has not merged renders
//     "NOT MEASURED — <module> result not present", never a fabricated zero.
//   · One resolved corpus manifest is handed to every module (absolute paths), so
//     all four measure the SAME frame roster — no per-module corpus drift.
//
// HOUSE LAWS embodied here:
//   · LAW 3 (honest-or-absent): a module that is absent / failed / emitted an
//     unexpected shape becomes a present:false section carrying an explicit
//     reason. No number is invented; nothing is interpolated.
//   · Deterministic: buildSummary() is a PURE function of the module result JSONs
//     (which are themselves deterministic for a fixed corpus+spec). The ONLY
//     wall-clock values live in the provenance block (generated_at); the `data`
//     block carries no timestamps.
//   · Spec-as-receipt: database_summary.json / index.json are themselves
//     {spec, provenance, data} envelopes, so the tab's figures re-derive from
//     their own record.
//   · Tools lane only. No src/ touch. Spawns the module CLIs as child processes;
//     imports nothing from an unmerged branch.
//
// USAGE
//   node tools/analytics/publish_analytics.mjs                 # default corpus → test_results/analytics/
//   node tools/analytics/publish_analytics.mjs --root <dir>    # resolve the manifest's relative paths against <dir>
//                                                                (worktree → main-checkout test_results/)
//   node tools/analytics/publish_analytics.mjs --manifest <f>  # base corpus manifest (default tools/analytics/corpus.default.json)
//   node tools/analytics/publish_analytics.mjs --out-dir <dir> # where to write results (default <root>/test_results/analytics)
//   node tools/analytics/publish_analytics.mjs --quiet         # suppress the stderr roll-call
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PUBLISH_ANALYTICS_VERSION = '1.0.0';
export const NOT_MEASURED = 'NOT MEASURED';

const __dir = path.dirname(fileURLToPath(import.meta.url));
// tools/analytics → repo root is two up.
export const REPO_ROOT = path.resolve(__dir, '..', '..');

// The analytics modules the publisher knows how to run. Each is a spec-as-receipt
// CLI writing {spec,provenance,data} to --out. `manifestFlag` is the flag THAT
// module uses to accept a corpus manifest (solve_stats calls it --spec; the
// others --manifest) — the publisher hands every present module the SAME resolved
// manifest so they measure one frame roster.
export const MODULES = Object.freeze([
  { name: 'solve_stats',   file: 'tools/analytics/solve_stats.mjs',   out: 'solve_stats.json',   manifestFlag: '--spec' },
  { name: 'confirm_stats', file: 'tools/analytics/confirm_stats.mjs', out: 'confirm_stats.json', manifestFlag: '--manifest' },
  { name: 'wall_stats',    file: 'tools/analytics/wall_stats.mjs',    out: 'wall_stats.json',    manifestFlag: '--manifest' },
  { name: 'residuals',     file: 'tools/analytics/residuals.mjs',     out: 'residuals.json',     manifestFlag: '--manifest' },
]);

// ── small honest helpers ──────────────────────────────────────────────────────
function toPosix(p) { return String(p).replace(/\\/g, '/'); }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
// recursively key-sorted JSON — byte-identical output for a fixed input.
function stableStringify(v, indent = 2) {
  const seen = new WeakSet();
  const canon = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return null;
    seen.add(x);
    if (Array.isArray(x)) return x.map(canon);
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = canon(x[k]);
    return o;
  };
  return JSON.stringify(canon(v), null, indent);
}
function gitHeadShort(root = REPO_ROOT) {
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    if (r.status === 0) { const s = String(r.stdout || '').trim(); return s || null; }
  } catch { /* git absent → honest null */ }
  return null;
}

// ── resolved corpus manifest ──────────────────────────────────────────────────
// Read the base manifest and rewrite every relative source path to absolute
// against `root`, so a module invoked from ANY cwd/checkout reads the same bytes.
// Returns { manifest, path } or null when the base manifest is absent.
export function buildResolvedManifest(basePath, root, outPath) {
  if (!fs.existsSync(basePath)) return null;
  const m = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const abs = (x) => toPosix(path.isAbsolute(x) ? x : path.resolve(root, x));
  const out = { ...m };
  if (Array.isArray(m.receiptDirs)) out.receiptDirs = m.receiptDirs.map(abs);
  if (Array.isArray(m.ledgers)) out.ledgers = m.ledgers.map(abs);
  if (m.dossierDir) out.dossierDir = abs(m.dossierDir);
  if (Array.isArray(m.dossierDirs)) out.dossierDirs = m.dossierDirs.map(abs);
  if (Array.isArray(m.envelopeLedgers)) out.envelopeLedgers = m.envelopeLedgers.map(abs);
  out.__resolved_from = toPosix(basePath);
  out.__resolved_root = toPosix(root);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  return { manifest: out, path: outPath };
}

// ── run one module CLI (child process) ────────────────────────────────────────
// Returns { name, status:'ok'|'failed'|'absent', result|null, error|null,
//           out_file, ran }.  Never throws.
//   moduleRoot — the checkout the module CLI files live in (the publisher's own).
//   resolvedManifestPath — an ABSOLUTE-path corpus manifest; the module reads the
//                          same frame roster no matter where it is invoked from.
export function runModule(mod, opts) {
  const { moduleRoot, nodeBin, resolvedManifestPath, outDir } = opts;
  const file = path.resolve(moduleRoot, mod.file);
  const outFile = path.join(outDir, mod.out);
  if (!fs.existsSync(file)) {
    return { name: mod.name, status: 'absent', result: null, error: null, out_file: toPosix(outFile), ran: false };
  }
  const args = [file];
  if (resolvedManifestPath) args.push(mod.manifestFlag, resolvedManifestPath);
  args.push('--out', outFile);
  let proc;
  try {
    proc = spawnSync(nodeBin, args, { cwd: moduleRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return { name: mod.name, status: 'failed', result: null, error: `spawn failed: ${e && e.message || e}`, out_file: toPosix(outFile), ran: true };
  }
  if (proc.status !== 0) {
    const tail = String(proc.stderr || proc.stdout || '').trim().split('\n').slice(-3).join(' · ');
    return { name: mod.name, status: 'failed', result: null, error: `exit ${proc.status}: ${tail || 'no output'}`, out_file: toPosix(outFile), ran: true };
  }
  // read back the result the module wrote (--out), validate the envelope shape.
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    return { name: mod.name, status: 'failed', result: null, error: `wrote no parseable JSON to ${toPosix(outFile)}: ${e && e.message || e}`, out_file: toPosix(outFile), ran: true };
  }
  if (!isObj(result) || !isObj(result.data)) {
    return { name: mod.name, status: 'failed', result: null, error: 'result JSON is not a {spec,provenance,data} envelope', out_file: toPosix(outFile), ran: true };
  }
  return { name: mod.name, status: 'ok', result, error: null, out_file: toPosix(outFile), ran: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// buildSummary — the PURE roll-up. Given a map { <module>: runResult } produce
// the tab-ready `data` block. Every number is READ from a module's own `data`;
// an absent/failed module yields a present:false section with an explicit reason.
// No timestamps here — the envelope's provenance carries generated_at.
// ═══════════════════════════════════════════════════════════════════════════
function absentReason(name) {
  return `${NOT_MEASURED} — ${name} result not present; run node tools/analytics/publish_analytics.mjs after the ${name} branch merges to main`;
}
function dataOf(results, name) {
  const r = results[name];
  return r && r.status === 'ok' && isObj(r.result) && isObj(r.result.data) ? r.result.data : null;
}
function provOf(results, name) {
  const r = results[name];
  return r && r.status === 'ok' && isObj(r.result) && isObj(r.result.provenance) ? r.result.provenance : null;
}

function corpusSection(results) {
  const ov = (() => { const d = dataOf(results, 'solve_stats'); return d && isObj(d.overview) ? d.overview : null; })();
  if (ov) {
    return {
      present: true, source: 'solve_stats.json', basis: 'solve_stats.data.overview',
      n_frames: num(ov.n_frames),
      by_kind: isObj(ov.by_kind) ? ov.by_kind : null,
      by_solve_class: isObj(ov.by_solve_class) ? ov.by_solve_class : null,
      by_key_mode: isObj(ov.by_key_mode) ? ov.by_key_mode : null,
      by_outcome: isObj(ov.by_outcome) ? ov.by_outcome : null,
      with_receipt: num(ov.with_receipt), with_dossier: num(ov.with_dossier), with_envelope: num(ov.with_envelope),
    };
  }
  // fallback: any present module's provenance.row_counts (weaker, but honest).
  for (const m of MODULES) {
    const p = provOf(results, m.name);
    if (p && isObj(p.row_counts)) {
      return { present: true, source: `${m.out} · provenance.row_counts`, basis: 'row_counts', n_frames: null, row_counts: p.row_counts };
    }
  }
  return { present: false, reason: absentReason('solve_stats') };
}

function solveSection(results) {
  const d = dataOf(results, 'solve_stats');
  const bl = d && isObj(d.blind_lane) ? d.blind_lane : null;
  if (!bl) return { present: false, reason: absentReason('solve_stats') };
  const ov = isObj(bl.overall) ? bl.overall : {};
  const rate = (r) => (isObj(r) ? { n: num(r.n), d: num(r.d), pct: num(r.pct) } : null);
  const byFormat = isObj(bl.by_format)
    ? Object.keys(bl.by_format).sort().map((fmt) => {
        const v = bl.by_format[fmt] || {};
        return {
          format: fmt, n_frames: num(v.n_frames), n_solved: num(v.n_solved), n_attempted: num(v.n_attempted), n_skipped: num(v.n_skipped),
          pct_all_blind: num(v.solve_rate_of_all_blind && v.solve_rate_of_all_blind.pct),
          pct_attempted: num(v.solve_rate_of_attempted && v.solve_rate_of_attempted.pct),
        };
      })
    : [];
  const al = isObj(d.assisted_lane) ? d.assisted_lane : null;
  return {
    present: true, source: 'solve_stats.json',
    denominators: isObj(bl.denominators)
      ? { n_blind_frames: num(bl.denominators.n_blind_frames), n_attempted: num(bl.denominators.n_attempted), n_solved: num(bl.denominators.n_solved), n_skipped: num(bl.denominators.n_skipped) }
      : null,
    rate_all_blind: rate(ov.solve_rate_of_all_blind),
    rate_attempted: rate(ov.solve_rate_of_attempted),
    by_format: byFormat,
    assisted: al ? { n_assisted_frames: num(al.n_assisted_frames), of_which_failed_blind: num(al.of_which_failed_blind), run_labels: Array.isArray(al.run_labels) ? al.run_labels : null } : null,
    lanes_note: 'blind and assisted (hinted) solves are NEVER pooled — an assisted rescue never inflates a blind rate.',
  };
}

function residualsSection(results) {
  const r = results['residuals'];
  const d = dataOf(results, 'residuals');
  const s = d && isObj(d.summary) ? d.summary : null;
  if (!s) return { present: false, reason: absentReason('residuals') };
  const spec = r && isObj(r.result) && isObj(r.result.spec) ? r.result.spec : {};
  const cands = Array.isArray(d.refit_candidates) ? d.refit_candidates : [];
  const top = cands.length && isObj(cands[0]) ? cands[0] : null;
  return {
    present: true, source: 'residuals.json',
    frames_total: num(s.frames_total), frames_measured: num(s.frames_measured),
    frames_not_measured: num(s.frames_not_measured), frames_flagged: num(s.frames_flagged),
    refit_candidate_count: num(s.refit_candidate_count), matched_stars_used: num(s.matched_stars_used),
    not_measured_by_reason: isObj(s.not_measured_by_reason) ? s.not_measured_by_reason : null,
    top_refit: top ? {
      id: top.id != null ? String(top.id) : (top.key != null ? String(top.key) : null),
      rig: top.rig != null ? String(top.rig) : null,
      edge_excess_arcsec: num(top.edge_excess_arcsec), edge_excess_px: num(top.edge_excess_px),
      slope_arcsec_per_radius: num(top.slope_arcsec_per_radius), n_stars_used: num(top.n_stars_used),
    } : null,
    thresholds: {
      slope_arcsec_per_radius: num(spec.distortion_slope_threshold_arcsec_per_radius),
      edge_excess_arcsec: num(spec.distortion_edge_excess_threshold_arcsec),
      signature_rule: spec.signature_rule != null ? String(spec.signature_rule) : null,
    },
  };
}

function confirmSection(results) {
  const d = dataOf(results, 'confirm_stats');
  const c = d && isObj(d.corpus) ? d.corpus : null;
  if (!c) return { present: false, reason: absentReason('confirm_stats') };
  const nvv = isObj(d.n_vs_verdict) ? d.n_vs_verdict : null;
  const fdr = isObj(d.fdr_shadow) ? d.fdr_shadow : null;
  return {
    present: true, source: 'confirm_stats.json',
    total_frames: num(c.total_frames), with_confirm_block: num(c.with_confirm_block), confirmable_frames: num(c.confirmable_frames),
    by_status: isObj(c.by_status) ? c.by_status : null,
    n_vs_verdict: nvv ? {
      statistic: nvv.statistic != null ? String(nvv.statistic) : null,
      pearson: num(nvv.pearson), spearman_rho: num(nvv.spearman_rho),
      baseline: num(nvv.baseline), delta: num(nvv.delta), n_frames: num(nvv.n_frames),
      agreement: nvv.agreement != null ? String(nvv.agreement) : null,
      baseline_source: nvv.baseline_source != null ? String(nvv.baseline_source) : null,
    } : null,
    fdr_shadow: fdr ? { status: fdr.status != null ? String(fdr.status) : NOT_MEASURED, present_frames: num(fdr.present_frames) } : null,
  };
}

function wallSection(results) {
  const d = dataOf(results, 'wall_stats');
  if (!d) return { present: false, reason: absentReason('wall_stats') };
  const cs = isObj(d.corpus_summary) ? d.corpus_summary : null;
  const swd = isObj(d.solve_wall_decomposition) && isObj(d.solve_wall_decomposition.overall) ? d.solve_wall_decomposition.overall : null;
  const bva = isObj(d.blind_vs_assisted) ? d.blind_vs_assisted : null;
  const sp = isObj(d.savings_projection) ? d.savings_projection : null;
  return {
    present: true, source: 'wall_stats.json',
    corpus_summary: cs ? { frames: num(cs.frames), timing_rows: num(cs.timing_rows), rows_ran: num(cs.rows_ran), rows_not_run: num(cs.rows_not_run), rows_with_stage_decomposition: num(cs.rows_with_stage_decomposition) } : null,
    solve_share: swd ? { frames: num(swd.frames), of_pipeline: num(swd.solve_share_of_pipeline), of_wall: num(swd.solve_share_of_wall), solve_ms: num(swd.solve_ms), pipeline_ms: num(swd.pipeline_ms), wall_ms: num(swd.wall_ms) } : null,
    blind_vs_assisted: bva ? {
      paired_frames: num(bva.paired_frames), speedup_median: num(bva.speedup_median), speedup_mean: num(bva.speedup_mean),
      blind_median_ms: num(bva.blind_wall_ms && bva.blind_wall_ms.median), assisted_median_ms: num(bva.assisted_wall_ms && bva.assisted_wall_ms.median),
    } : null,
    savings_projection: sp ? { requested: sp.requested === true } : { requested: false },
  };
}

function moduleRollcall(results) {
  return MODULES.map((m) => {
    const r = results[m.name] || { status: 'absent' };
    const spec = r.result && isObj(r.result.spec) ? r.result.spec : null;
    const prov = r.result && isObj(r.result.provenance) ? r.result.provenance : null;
    return {
      name: m.name,
      source_file: m.out,
      status: r.status,
      present: r.status === 'ok',
      tool_version: (spec && spec.tool_version) != null ? String(spec.tool_version) : ((prov && prov.tool_version) != null ? String(prov.tool_version) : null),
      git_head: prov && prov.git_head != null ? String(prov.git_head) : null,
      error: r.error != null ? String(r.error) : null,
    };
  });
}

// ── replication (owner plane-divergence law 2026-07-12: replication state RENDERED
//    honestly; "the Database label must be earned"). Sourced NOT from a spawned
//    analytics module but from the community push ledger
//    (test_results/community/replication_*.jsonl), whose per-row status is written
//    by push_solve/backfill. Pure: a function of the ledger rows only. ─────────────
//
// status → plane mapping:
//   pushed | deduped            → REPLICATED (object HEAD-verified present in R2)
//   skipped_no_identity         → local-only (no resolvable frame identity)
//   skipped_unsafe              → local-only (non-receipt ledger row / unsafe)
//   failed                      → local-only (push errored)
export function replicationSection(rows, ledgerFile) {
  if (!Array.isArray(rows)) {
    return { present: false, reason: `${NOT_MEASURED} — no community replication ledger `
      + `(test_results/community/replication_*.jsonl) found; run node test_results/community/`
      + `backfill_2026-07-12.mjs (or the live community push) to record per-row replication state` };
  }
  const IN_DB = new Set(['pushed', 'deduped']);
  const by_status = {};
  const local_by_reason = {};
  const objects = new Set();
  const frames = new Set();
  let replicated = 0, local_only = 0, solved_in_db = 0, unsolved_in_db = 0, last_push_ts = null;
  for (const r of rows) {
    const s = (r && typeof r.status === 'string') ? r.status : 'unknown';
    by_status[s] = (by_status[s] || 0) + 1;
    if (IN_DB.has(s)) {
      replicated++;
      if (typeof r.object_key === 'string') {
        objects.add(r.object_key);
        const m = /solves\/([0-9a-f]{12})/.exec(r.object_key);
        if (m) frames.add(m[1]);
      }
      if (r.solved === true) solved_in_db++;
      else if (r.solved === false) unsolved_in_db++;
      if (typeof r.ts === 'string' && (last_push_ts == null || r.ts > last_push_ts)) last_push_ts = r.ts;
    } else {
      local_only++;
      const key = s === 'skipped_no_identity' ? 'no_frame_identity'
        : s === 'skipped_unsafe' ? 'unsafe_or_not_a_receipt'
        : s === 'failed' ? 'push_failed' : s;
      local_by_reason[key] = (local_by_reason[key] || 0) + 1;
    }
  }
  return {
    present: true,
    source: 'replication.json',
    bucket: 'community-database',
    ledger: ledgerFile ? toPosix(ledgerFile) : null,
    total_rows: rows.length,
    replicated, local_only,
    distinct_objects: objects.size,
    distinct_frames: frames.size,
    solved_in_db, unsolved_in_db,
    by_status, local_by_reason, last_push_ts,
    meaning: 'replicated = receipt objects confirmed present in the community-database R2 bucket '
      + '(status pushed or deduped; the backfill HEAD-verifies each key). local_only = recorded but '
      + 'NOT in the bucket (no resolvable frame identity, non-receipt ledger rows, or a failed push).',
  };
}

// Discover + read the newest community replication ledger under <dataRoot>. Honest-
// absent on any failure (missing dir/file, unreadable) → { rows: null, file: null }.
export function readReplicationLedger(dataRoot) {
  try {
    const dir = path.join(dataRoot, 'test_results', 'community');
    if (!fs.existsSync(dir)) return { rows: null, file: null };
    const cand = fs.readdirSync(dir).filter((f) => /^replication_.*\.jsonl$/.test(f));
    if (!cand.length) return { rows: null, file: null };
    cand.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    const file = path.join(dir, cand[0]);
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { rows, file };
  } catch { return { rows: null, file: null }; }
}

export function buildSummary(results, extra = {}) {
  const r = results || {};
  const rollcall = moduleRollcall(r);
  const anyPresent = rollcall.some((m) => m.present);
  return {
    generated: anyPresent,
    modules: rollcall,
    all_absent_note: anyPresent ? null
      : `${NOT_MEASURED} — no analytics module CLI is present on disk yet. The four analytics modules land on separate branches; once merged, re-run node tools/analytics/publish_analytics.mjs to populate this tab.`,
    corpus: corpusSection(r),
    solve: solveSection(r),
    residuals: residualsSection(r),
    confirm: confirmSection(r),
    wall: wallSection(r),
    replication: replicationSection(extra.replicationRows ?? null, extra.replicationFile ?? null),
  };
}

// ── provenance (timestamps live ONLY here) ────────────────────────────────────
function buildProvenance(results, root, resolvedManifestPath) {
  const source_results = {};
  for (const m of MODULES) {
    const r = results[m.name] || { status: 'absent' };
    const prov = r.result && isObj(r.result.provenance) ? r.result.provenance : null;
    source_results[m.name] = {
      status: r.status,
      out_file: r.out_file || null,
      git_head: prov && prov.git_head != null ? String(prov.git_head) : null,
      generated_at: prov && prov.generated_at != null ? String(prov.generated_at) : null,
      error: r.error != null ? String(r.error) : null,
    };
  }
  return {
    publisher: 'tools/analytics/publish_analytics.mjs',
    publisher_version: PUBLISH_ANALYTICS_VERSION,
    git_head: gitHeadShort(root),
    resolved_manifest: resolvedManifestPath ? toPosix(resolvedManifestPath) : null,
    source_results,
    generated_at: new Date().toISOString(),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { root: null, manifest: null, outDir: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--root') a.root = argv[++i];
    else if (t === '--manifest') a.manifest = argv[++i];
    else if (t === '--out-dir') a.outDir = argv[++i];
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`publish_analytics: unknown arg '${t}'`);
  }
  return a;
}

const HELP = `publish_analytics.mjs — run the analytics CLIs and roll them into the Database tab feed.

Usage:
  node tools/analytics/publish_analytics.mjs [flags]

Flags:
  --root <dir>      resolve the corpus manifest's relative paths against <dir>
                    (worktree → main-checkout test_results/). Default: repo root.
  --manifest <f>    base corpus manifest. Default: tools/analytics/corpus.default.json
  --out-dir <dir>   where results are written. Default: <root>/test_results/analytics
  --quiet           suppress the stderr roll-call
  --help            this text

Writes (spec-as-receipt {spec,provenance,data} envelopes):
  <out-dir>/database_summary.json   the Database tab's single feed (tab-ready roll-up)
  <out-dir>/index.json              publish-run roll-call
  <out-dir>/<module>.json           each present module's raw result (for "view source")
Absent/failed modules render as NOT MEASURED — never a fabricated number (LAW 3).`;

export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP + '\n'); return 0; }

  // Two distinct roots (identical in production, split only in a worktree):
  //   moduleRoot — where the analytics module CLIs live: the publisher's OWN
  //                checkout. Never overridable — the modules are its siblings.
  //   dataRoot   — where the corpus manifest's relative paths + the default
  //                out-dir resolve. `--root` overrides it (worktree → main checkout).
  const moduleRoot = REPO_ROOT;
  const dataRoot = args.root ? path.resolve(args.root) : REPO_ROOT;
  const outDir = args.outDir ? path.resolve(args.outDir) : path.join(dataRoot, 'test_results', 'analytics');
  const baseManifest = args.manifest ? path.resolve(args.manifest) : path.join(moduleRoot, 'tools', 'analytics', 'corpus.default.json');
  fs.mkdirSync(outDir, { recursive: true });

  // 1) one resolved manifest handed to every module → one frame roster.
  const resolvedManifestPath = path.join(outDir, '_resolved_corpus_manifest.json');
  const resolved = buildResolvedManifest(baseManifest, dataRoot, resolvedManifestPath);
  const manifestForModules = resolved ? resolvedManifestPath : null;

  // 2) run each present module.
  const results = {};
  for (const m of MODULES) {
    results[m.name] = runModule(m, { moduleRoot, nodeBin: process.execPath, resolvedManifestPath: manifestForModules, outDir });
  }

  // 3) roll up (pure) + wrap in a spec-as-receipt envelope. The replication section
  //    is sourced from the community push ledger (not a spawned module).
  const ledger = readReplicationLedger(dataRoot);
  const data = buildSummary(results, { replicationRows: ledger.rows, replicationFile: ledger.file });
  const spec = {
    tool: 'publish_analytics',
    tool_version: PUBLISH_ANALYTICS_VERSION,
    module_root: toPosix(moduleRoot),
    data_root: toPosix(dataRoot),
    out_dir: toPosix(outDir),
    base_manifest: toPosix(baseManifest),
    base_manifest_present: !!resolved,
    modules: MODULES.map((m) => ({ name: m.name, file: m.file, out: m.out })),
  };
  const provenance = buildProvenance(results, moduleRoot, manifestForModules);
  const summary = { spec, provenance, data };

  // 4) write the tab feed + the roll-call index.
  fs.writeFileSync(path.join(outDir, 'database_summary.json'), stableStringify(summary) + '\n');
  const index = {
    spec: { tool: 'publish_analytics.index', tool_version: PUBLISH_ANALYTICS_VERSION, out_dir: toPosix(outDir) },
    provenance: { publisher_version: PUBLISH_ANALYTICS_VERSION, git_head: provenance.git_head, generated_at: provenance.generated_at },
    data: { modules: data.modules, generated: data.generated, summary_file: 'database_summary.json' },
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), stableStringify(index) + '\n');

  // 4b) replication.json — the Database tab's "view source" for the replication
  //     section (served at /data/analytics/replication.json). Honest-absent safe.
  const replEnv = {
    spec: {
      tool: 'publish_analytics.replication', tool_version: PUBLISH_ANALYTICS_VERSION,
      source_ledger: ledger.file ? toPosix(ledger.file) : null,
      note: 'Per-row replication state rolled up from the community push ledger. Bucket = community-database. '
        + 'replicated = pushed|deduped (HEAD-verified in R2); local_only = recorded but not in the bucket.',
    },
    provenance: {
      publisher_version: PUBLISH_ANALYTICS_VERSION, git_head: provenance.git_head,
      generated_at: provenance.generated_at,
      ledger_rows: Array.isArray(ledger.rows) ? ledger.rows.length : null,
    },
    data: data.replication,
  };
  fs.writeFileSync(path.join(outDir, 'replication.json'), stableStringify(replEnv) + '\n');

  if (!args.quiet) {
    const parts = data.modules.map((m) => `${m.name}=${m.status}`).join('  ');
    process.stderr.write(`publish_analytics: ${data.generated ? 'ok' : 'ALL ABSENT'} → ${toPosix(outDir)}\n  ${parts}\n`);
    for (const m of data.modules) if (m.status === 'failed') process.stderr.write(`  ! ${m.name}: ${m.error}\n`);
  }
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) process.exit(runCli(process.argv.slice(2)));
