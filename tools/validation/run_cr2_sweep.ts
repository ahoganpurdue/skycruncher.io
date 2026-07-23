// CLI: run_cr2_sweep.ts — the CR2 real-pipeline A/B for candidate uw_anchor_topN.
//
//   node tools/validation/run_cr2_sweep.ts                 # both arms + merge
//   node tools/validation/run_cr2_sweep.ts --arm 1         # run ONLY the OFF arm
//   node tools/validation/run_cr2_sweep.ts --arm 3         # run ONLY the ON arm
//   node tools/validation/run_cr2_sweep.ts --merge-only    # build ledger from raw
//   node tools/validation/run_cr2_sweep.ts --budget 60000  # per-frame budget cap
//   node tools/validation/run_cr2_sweep.ts --limit 3       # smoke: first N frames
//
// Each arm is a SEPARATE vitest process because SOLVER_UW_ANCHOR_CANDIDATES is
// read by pipeline_config at module-load — flipping process.env in-process (the
// runner's mechanism) cannot re-read it. OFF=1, ON=3. The binding spec writes a
// raw RunResult per (arm, frame); --merge pairs them into trials via the
// harness's extractSolverOutcome / computeSolverDelta and appends to the
// gitignored uw_anchor_topN ledger. `locked` ≡ passed verifyWCS (never invented).

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, Ledger } from './ledger.ts';
import { fullCost } from './stats.ts';
import { extractSolverOutcome, computeSolverDelta, type SolverOutcome } from './domains.ts';
import { UW_ANCHOR_TOPN } from './candidates/uw_anchor_topN.ts';
import { check } from './policy.ts';
import { resolveTruth } from './truth/loader.ts';
import { applyTruthToRunResult, recordedCenterIsFrameCenter } from './truth/harness_hook.ts';
import type { Trial, Efficiency, RunResult } from './types.ts';

const DETS_DIR = path.join(REPO_ROOT, 'test_results', 'cr2_dets');
const RAW_DIR = path.join(REPO_ROOT, 'test_results', 'validation', '_cr2_raw');
const DETAIL_FILE = path.join(REPO_ROOT, 'test_results', 'validation', 'cr2_trials_detail.json');
// Tracked ground-truth labels (labels.json + bundled table + FITS-header deriver).
// A clone keeps the ANSWERS even though the sample frames are gitignored/local.
const LABELS_FILE = path.join(REPO_ROOT, 'tools', 'validation', 'truth', 'labels.json');
const CONFIG = 'tools/validation/cr2_binding.config.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Enumerate the distinct CR2 frames that have a detection dump. Input filtering:
 * .app.json per frame; the two CSM30803 dumps are the SAME 5D3 frame → keep the
 * iso6400_15s variant only; OOM super-stacks / rejmaps / JPEGs are FITS/derived
 * and never reach cr2_dets. IMG_1238 has no dump → absent by construction.
 */
function enumerateDumps(limit?: number): { frame: string; rel: string }[] {
  const files = fs
    .readdirSync(DETS_DIR)
    .filter((f) => f.endsWith('.app.json'))
    .filter((f) => f !== 'CSM30803_5DMkIII.app.json'); // dedupe 5D3 → keep iso6400_15s
  const out = files
    .sort()
    .map((f) => ({ frame: f.replace(/\.app\.json$/i, ''), rel: path.join('test_results', 'cr2_dets', f) }));
  return limit ? out.slice(0, limit) : out;
}

function runArm(arm: 1 | 3, dumps: { rel: string }[], budgetMs: number): void {
  const CR2_DUMPS = dumps.map((d) => d.rel.split(path.sep).join('/')).join(',');
  console.log(`\n═══ ARM anchor#${arm} — ${dumps.length} frames, budget ${budgetMs}ms/frame ═══`);
  const res = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vitest', 'run', '-c', CONFIG],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SOLVER_UW_ANCHOR_CANDIDATES: String(arm),
        CR2_DUMPS,
        CR2_BUDGET_MS: String(budgetMs),
        CR2_OUTDIR: RAW_DIR,
      },
      stdio: 'inherit',
      shell: false,
    },
  );
  if (res.status !== 0) console.error(`  [warn] arm anchor#${arm} vitest exited ${res.status} (some frames may still have written raw results)`);
}

function readArm(arm: 1 | 3): Map<string, any> {
  const dir = path.join(RAW_DIR, `anchor${arm}`);
  const m = new Map<string, any>();
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    m.set(raw.frame ?? f.replace(/\.json$/, ''), raw);
  }
  return m;
}

function toEfficiency(off: RunResult, on: RunResult): Efficiency {
  return {
    baseline_ms: off.wall_ms,
    candidate_ms: on.wall_ms,
    cost: fullCost(on.cost),
    locking_tool: (on.locking_tool as string) ?? 'none',
  };
}

/**
 * TRUTH ADJUDICATION (Validation Harness · Enh1) — fold a frame's resolved ground
 * truth into an arm's raw result BEFORE it is graded, so a truth-DISAGREEING lock
 * becomes a `new_false_positive` regression in the ledger delta. Honest-absent by
 * construction: adjudication is applied ONLY when the recorded (ra,dec) IS the
 * frame center (`recorded_center_is_frame`) — this anchored-sweep harness records
 * the verify ANCHOR center (~12° off the frame center for a wide field), so a
 * frame-center truth is NOT center-compared against it (that would flag a correct
 * solve). NO_TRUTH / not-comparable ⇒ applyTruthToRunResult(raw, null) is
 * byte-identical to the un-adjudicated grading. This is the seam the FITS/narrow-
 * field solve-A/B rail (which records a frame center) consumes to flag real FPs.
 */
async function adjudicateArm(frame: string, raw: RunResult): Promise<RunResult> {
  if (!recordedCenterIsFrameCenter(raw)) return applyTruthToRunResult(raw, null);
  const truth = await resolveTruth(frame, { labelsFile: LABELS_FILE });
  return applyTruthToRunResult(raw, truth);
}

async function merge(): Promise<void> {
  const off = readArm(1);
  const on = readArm(3);
  const frames = [...new Set([...off.keys(), ...on.keys()])].sort();
  if (frames.length === 0) {
    console.error('no raw results found — run the arms first (--arm 1 / --arm 3).');
    process.exit(3);
  }

  const ledger = new Ledger(UW_ANCHOR_TOPN.id);
  const detail: any[] = [];
  const rows: { frame: string; bo: SolverOutcome; co: SolverOutcome; imp: string[]; reg: string[] }[] = [];
  let newLocks = 0;
  let bothMissing = 0;
  let falsePositives = 0;

  for (const frame of frames) {
    const o = off.get(frame);
    const c = on.get(frame);
    if (!o || !c) {
      bothMissing += 1;
      console.error(`  [skip] ${frame}: missing ${!o ? 'OFF' : 'ON'} arm result`);
      continue;
    }
    // Truth-adjudicate BOTH arms before extractSolverOutcome (honest-absent for
    // this anchor-center harness → byte-identical; live for the FITS rail).
    const oAdj = await adjudicateArm(frame, o as RunResult);
    const cAdj = await adjudicateArm(frame, c as RunResult);
    const baseline = extractSolverOutcome(oAdj);
    const cand = extractSolverOutcome(cAdj);
    const delta = computeSolverDelta(baseline, cand);
    if (delta.improvements.includes('new_verified_lock')) newLocks += 1;
    if (delta.regressions.includes('new_false_positive')) falsePositives += 1;

    const trial: Trial<SolverOutcome> = {
      candidate_id: UW_ANCHOR_TOPN.id,
      input_id: frame,
      image_type: 'CR2_DSLR',
      baseline,
      candidate: cand,
      delta,
      efficiency: toEfficiency(o as RunResult, c as RunResult),
      ts: Date.now(),
    };
    ledger.append(trial);
    rows.push({ frame, bo: baseline, co: cand, imp: delta.improvements, reg: delta.regressions });
    const truthVerdict =
      (cAdj as { truth?: { verdict?: string } }).truth?.verdict ??
      (oAdj as { truth?: { verdict?: string } }).truth?.verdict ??
      'NO_TRUTH';
    detail.push({
      frame,
      off: { locked: baseline.locked, sigma: baseline.sigma, matched: baseline.matched, ms: o.wall_ms, best_peak_z: o.provenance?.best_peak_z, sweeps: o.cost?.sweeps, threw: o.threw ?? null },
      on: { locked: cand.locked, sigma: cand.sigma, matched: cand.matched, ms: c.wall_ms, best_peak_z: c.provenance?.best_peak_z, sweeps: c.cost?.sweeps, threw: c.threw ?? null },
      delta,
      truth_verdict: truthVerdict, // TRUE_POSITIVE | FALSE_POSITIVE | NO_TRUTH (honest-absent for anchor-center CR2)
      provenance: c.provenance ?? o.provenance ?? null,
    });
  }

  fs.writeFileSync(DETAIL_FILE, JSON.stringify({ generated: new Date().toISOString(), candidate: UW_ANCHOR_TOPN.id, frames: detail }, null, 2), 'utf8');

  // ── summary ──
  console.log(`\n═══ CR2 A/B merged — ${rows.length} frames (uw_anchor_topN, CR2_DSLR) ═══`);
  console.log(`  ${'frame'.padEnd(30)} OFF          ON           Δ`);
  for (const r of rows) {
    const fo = r.bo.locked ? `LOCK +${r.bo.sigma}σ` : 'no-lock';
    const fc = r.co.locked ? `LOCK +${r.co.sigma}σ` : 'no-lock';
    const d = [...r.imp.map((x) => '+' + x), ...r.reg.map((x) => '-' + x)].join(' ') || '·';
    console.log(`  ${r.frame.padEnd(30)} ${fo.padEnd(12)} ${fc.padEnd(12)} ${d}`);
  }

  const report = check(UW_ANCHOR_TOPN, ledger.read());
  console.log(`\n  ── graduation verdict (uw_anchor_topN) ──`);
  for (const p of report.perType) {
    const na = p.applicable ? '' : '  (N/A)';
    console.log(`  ${p.image_type.padEnd(14)} ${p.verdict.padEnd(18)} n=${p.n}/${p.n_min}  +${p.improvements}/-${p.regressions}${na}`);
  }
  console.log(`  GLOBAL         ${report.global}`);

  const offLocks = rows.filter((r) => r.bo.locked).length;
  const onLocks = rows.filter((r) => r.co.locked).length;
  console.log(`\n  ── SANITY (expect 0 NEW locks; sample_observation locks in BOTH arms) ──`);
  console.log(`  OFF locks: ${offLocks}/${rows.length}   ON locks: ${onLocks}/${rows.length}   NEW verified locks (ON∖OFF): ${newLocks}`);
  console.log(newLocks === 0 ? `  ✓ 0 new locks — sanity HELD` : `  ✗ ${newLocks} new locks — INVESTIGATE the wiring (expected 0/6)`);
  // Truth adjudication is honest-absent for this anchor-center harness → expect 0
  // false positives (a nonzero count here would mean a frame-center rail was wired
  // in and a lock DISAGREED with truth — a real regression to investigate).
  console.log(`  truth-adjudicated false positives (ON): ${falsePositives}`);
  if (bothMissing) console.log(`  [note] ${bothMissing} frames skipped (missing an arm).`);
  console.log(`\n  ledger:  ${ledger.file}`);
  console.log(`  detail:  ${DETAIL_FILE}`);
}

async function main(): Promise<void> {
  const mergeOnly = process.argv.includes('--merge-only');
  const armSel = arg('--arm');
  const budget = arg('--budget') ? parseInt(arg('--budget')!, 10) : 90_000;
  const limit = arg('--limit') ? parseInt(arg('--limit')!, 10) : undefined;
  const dumps = enumerateDumps(limit);

  console.log(`CR2 sweep — ${dumps.length} distinct dumped frames:`);
  console.log('  ' + dumps.map((d) => d.frame).join(', '));

  if (!mergeOnly) {
    if (armSel === '1' || armSel === '3') {
      runArm(Number(armSel) as 1 | 3, dumps, budget);
      return; // arm-only: caller merges after both arms complete
    }
    runArm(1, dumps, budget);
    runArm(3, dumps, budget);
  }
  await merge();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
