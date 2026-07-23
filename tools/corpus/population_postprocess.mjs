#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// POPULATION RUN — post-processor (reclassify errors, build canonical summary)
// ═══════════════════════════════════════════════════════════════════════════
// The runner records raw process outcomes. The headless runWizardPipeline THROWS
// on any no-solve (orchestrator_session:989 "Step 4 (Solve) must be complete
// before calibration") — so a genuine no-lock surfaces as exit-nonzero 'error'
// with no receipt. This pass reads each error frame's log, reclassifies
// no_solve (guard-throw) vs true error (OOM/decode/other), extracts the vitest
// pipeline-ms for thrown frames, and writes the canonical summary + readable md.
// Read-only over the ledger + logs; writes only summary artifacts.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const D_RUN = 'D:/AstroLogic/test_artifacts/population_run_2026-07-11';
const LOGS = path.join(D_RUN, 'logs');
const TR_RUN = path.join(ROOT, 'test_results', 'population_run_2026-07-11');
const LEDGER = path.join(TR_RUN, 'ledger.jsonl');
const SNAPS = path.join(TR_RUN, 'box_load_snapshots.json');
const MANIFEST = path.join(TR_RUN, 'manifest.json');

const FLAGS = [
  "CR2/DSLR frames carry NO color photometry: SPCC is FITS-gated (science.ts:118) — no channel gains, per-star fluxes, color fit, or zeropoint banked for non-FITS.",
  "Rawler per-frame calibration (WB coeffs, black/white levels, CFA pattern, optical-black dark stats) is computed but NOT persisted — receipt keeps only decoder_arm='rawler'.",
  "SPCC gains are decoder-independent (FITS/decoder_arm=null); cold-vs-default gain-delta rider does not affect banked SPCC.",
];
const GUARD = 'Step 4 (Solve) must be complete before calibration';
const NO_SOLVE_RECEIPT = 'ABSENT — headless guard-throw (task #16); re-runnable post-fix';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

for (const r of rows) {
  r.resolved_outcome = r.outcome;
  r.pipeline_ms = r.total_ms ?? null;
  r.error_signature = null;
  if (!String(r.outcome).startsWith('error')) continue;
  const logPath = path.join(LOGS, `${r.id}.log`);
  let txt = '';
  try { txt = stripAnsi(fs.readFileSync(logPath, 'utf8')); } catch {}
  // pipeline-ms: vitest file-duration on the runspec line, e.g. "runspec.ts (1 test | 1 failed) 187586ms"
  const mMs = txt.match(/solve_to_receipt\.runspec\.ts[^\n]*?(\d{2,})ms/);
  if (mMs) r.pipeline_ms = parseInt(mMs[1], 10);
  if (txt.includes(GUARD)) {
    r.resolved_outcome = 'no_solve';
    r.receipt = NO_SOLVE_RECEIPT;
    r.error_signature = 'guard-throw (no blind lock → calibration precondition)';
  } else if (/heap out of memory|Allocation failed|FATAL ERROR[^\n]*memory|Reached heap limit/i.test(txt)) {
    r.resolved_outcome = 'error_oom';
    r.error_signature = 'JS heap OOM';
  } else {
    const mErr = txt.match(/\bError:?\s*([^\n]{0,120})/);
    r.error_signature = mErr ? mErr[1].trim() : 'unknown (no Error line captured)';
  }
}

// ── tallies ───────────────────────────────────────────────────────────────────
const tally = {};
for (const r of rows) tally[r.resolved_outcome] = (tally[r.resolved_outcome] || 0) + 1;

const confirmTally = {};
for (const r of rows) if (r.resolved_outcome === 'solved') confirmTally[r.confirm_status ?? 'null'] = (confirmTally[r.confirm_status ?? 'null'] || 0) + 1;

// ── per-class stage medians (from SOLVED frames only — the only rows with stages) ─
function classSummary(fmt) {
  const cls = rows.filter((r) => r.format === fmt);
  const solved = cls.filter((r) => r.resolved_outcome === 'solved');
  const stageKeys = {};
  for (const r of solved) for (const [k, v] of Object.entries(r.stages || {})) (stageKeys[k] ??= []).push(v);
  const stageMed = {}; for (const [k, v] of Object.entries(stageKeys)) stageMed[k] = med(v);
  const outc = {}; for (const r of cls) outc[r.resolved_outcome] = (outc[r.resolved_outcome] || 0) + 1;
  return {
    n: cls.length, outcomes: outc,
    n_solved: solved.length,
    solved_wall_median_s: solved.length ? +(med(solved.map((r) => r.wall_ms)) / 1000).toFixed(2) : null,
    solved_pipeline_ms_median: solved.length ? med(solved.map((r) => r.pipeline_ms ?? r.total_ms).filter((x) => x != null)) : null,
    all_wall_median_s: cls.length ? +(med(cls.filter(r=>r.wall_ms>0).map((r) => r.wall_ms)) / 1000).toFixed(2) : null,
    solved_total_ms_median: solved.length ? med(solved.map((r) => r.total_ms).filter((x) => x != null)) : null,
    stage_median_ms: stageMed,
  };
}
const FITS = classSummary('FITS');
const CR2 = classSummary('CR2');

// ── slowest frames (real process wall; excludes zero-wall skips) ────────────────
const slowest = [...rows].filter((r) => r.wall_ms > 0).sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 5)
  .map((r) => ({ seq: r.seq, id: r.id, format: r.format, outcome: r.resolved_outcome, wall_s: +(r.wall_ms / 1000).toFixed(1), pipeline_ms: r.pipeline_ms }));

const timeouts = rows.filter((r) => r.resolved_outcome === 'honest_timeout').map((r) => ({ seq: r.seq, id: r.id, format: r.format, wall_s: +(r.wall_ms / 1000).toFixed(1) }));

let snaps = null; try { snaps = JSON.parse(fs.readFileSync(SNAPS, 'utf8')); } catch {}
let manifest = null; try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch {}

const totalWallS = +(rows.reduce((s, r) => s + (r.wall_ms || 0), 0) / 1000).toFixed(1);

const summary = {
  label: 'QUIET-BASELINE', run: 'population_run_2026-07-11', generated: new Date().toISOString(),
  decoder_default_arm: 'rawler (VITE_DECODER_RAWLER unset)',
  n_frames: rows.length,
  n_CR2: rows.filter((r) => r.format === 'CR2').length,
  n_FITS: rows.filter((r) => r.format === 'FITS').length,
  task_stated_count: 73,
  count_note: manifest?.count_note ?? null,
  process_wall_sum_s: totalWallS,
  process_wall_sum_note: 'Sum of per-frame process walls (serial); includes vitest cold-start per frame. NOT identical to end-to-end runner span (which spans the kill/relaunch resume).',
  outcomes: tally,
  outcomes_note: "no_solve = headless guard-throw (runWizardPipeline forces calibration, which requires a solution); reclassified from raw 'error' via the orchestrator_session:989 log signature. error_oom/error = true failures (see error_signature per row).",
  solved_confirm_status: confirmTally,
  by_class: { FITS, CR2 },
  slowest_5: slowest,
  honest_timeouts: timeouts,
  cocoon_skip: {
    n: rows.filter((r) => r.resolved_outcome === 'skipped_correlated_set').length,
    reason: 'owner-ruled mid-run: correlated set (same rig/target/night), 11/25 sampled all no-solve ~196s',
    wall_saved_est_s: rows.filter((r) => r.resolved_outcome === 'skipped_correlated_set').length * 196,
  },
  oversize_skip: rows.filter((r) => r.resolved_outcome === 'skipped_too_large').map((r) => ({ id: r.id, size_gb: +(r.size_bytes / 1e9).toFixed(2) })),
  MANDATORY_FLAGS: FLAGS,
  box_load_snapshots: snaps?.snapshots ?? null,
  heartbeats: snaps?.heartbeats ?? null,
};

fs.writeFileSync(path.join(TR_RUN, 'summary.json'), JSON.stringify(summary, null, 2));
// rewrite ledger with resolved fields (append-only integrity preserved: raw 'outcome' kept, resolved_outcome added)
fs.writeFileSync(path.join(TR_RUN, 'ledger_resolved.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ── readable markdown ───────────────────────────────────────────────────────────
const fmtStages = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${Math.round(v)}`).join(' · ');
const md = `# Population Timing Run — QUIET-BASELINE (2026-07-11)

Real headless wizard pipeline (\`runWizardPipeline\` via \`tools/api/run.config.ts\` / \`solve_to_receipt.runspec.ts\`), **process-per-frame, serial, quiet box**. Decoder arm = **rawler** (default). Runner path validated byte-identical to the sacred CR2 apispec before the sweep.

## Corpus
- **${summary.n_frames} science frames** enumerated on disk (${summary.n_CR2} CR2 + ${summary.n_FITS} FITS) — maxdepth-3 + \`corpus/cocoon_60da/lights\` only (bias/darks/flats excluded). Task stated 73; the extra are grown \`rotating/\` + \`cocoon/lights\`.

## Outcomes (resolved)
${Object.entries(tally).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

- \`solved\` confirm_status: ${Object.entries(confirmTally).map(([k, v]) => `${k}=${v}`).join(' · ')}
- **no_solve** = the headless entry throws at calibration on any no-lock (orchestrator_session:989) — no receipt, wall/pipeline-ms only. Follow-up = task #16 (graceful no-solve receipt).
- **error_oom / error** = true failures; see \`error_signature\` in \`ledger_resolved.jsonl\`.

## Per-stage timing medians (from SOLVED frames — the only rows the sidecar reaches)
**FITS** (n=${FITS.n}, solved=${FITS.n_solved}, solved wall median ${FITS.solved_wall_median_s}s):
\`\`\`
${fmtStages(FITS.stage_median_ms)}
\`\`\`
**CR2** (n=${CR2.n}, solved=${CR2.n_solved}, solved wall median ${CR2.solved_wall_median_s}s):
\`\`\`
${fmtStages(CR2.stage_median_ms)}
\`\`\`

## 3 slowest frames (process wall)
${slowest.slice(0, 3).map((r) => `1. **${r.id}** (${r.format}, ${r.outcome}) — ${r.wall_s}s`).join('\n')}

## Honest timeouts (${timeouts.length}) — big FITS stacks over the 120s FITS budget
${timeouts.map((r) => `- ${r.id} (${r.wall_s}s)`).join('\n')}

## Owner mid-run cocoon skip
- ${summary.cocoon_skip.n} correlated \`cocoon_60da/lights\` frames skipped (\`skipped_correlated_set\`); ~${(summary.cocoon_skip.wall_saved_est_s / 60).toFixed(0)} min wall saved. 11/25 sampled first, all no-solve ~196s.

## Oversize skip
${summary.oversize_skip.map((o) => `- ${o.id} (${o.size_gb}GB > 2GiB Node readFileSync limit; headless runspec cannot ingest — task #16-adjacent streaming-ingest backlog)`).join('\n')}

## Mandatory flags
${FLAGS.map((f) => `- ${f}`).join('\n')}

## Box load (quiet baseline)
${(snaps?.snapshots ?? []).map((s) => `- **${s.label}** ${s.ts}: mem ${s.mem_used_pct}% used (${s.mem_free_gb}/${s.mem_total_gb}GB free), cpu ${s.cpu_load_pct ?? 'n/a'}%, node procs ${s.node_proc_count ?? 'n/a'}`).join('\n')}

_Artifacts: receipts + per-frame logs under \`D:/AstroLogic/test_artifacts/population_run_2026-07-11/\`; ledger + summary here._
`;
fs.writeFileSync(path.join(TR_RUN, 'SUMMARY.md'), md);
console.log('[postprocess] wrote summary.json, ledger_resolved.jsonl, SUMMARY.md');
console.log('resolved tally:', JSON.stringify(tally));
console.log('FITS solved wall median', FITS.solved_wall_median_s + 's', '· CR2 solved wall median', CR2.solved_wall_median_s + 's');
console.log('slowest3:', slowest.slice(0, 3).map((r) => `${r.id.slice(0,40)}=${r.wall_s}s`).join(' | '));
