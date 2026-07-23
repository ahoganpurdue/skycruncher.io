// CLI: run_fits_sweep.ts — the FITS real-pipeline A/B for candidate fits_solve.
//
//   node tools/validation/run_fits_sweep.ts                 # both arms + merge
//   node tools/validation/run_fits_sweep.ts --arm 0         # run ONLY the OFF arm
//   node tools/validation/run_fits_sweep.ts --arm 1         # run ONLY the ON arm
//   node tools/validation/run_fits_sweep.ts --merge-only    # build ledger from raw
//   node tools/validation/run_fits_sweep.ts --limit 3       # smoke: first N frames
//   node tools/validation/run_fits_sweep.ts --frames "DSO_Stacked_738_M 66_..."
//
// Mirrors run_cr2_sweep.ts. Each arm is a SEPARATE vitest process because
// SOLVER_FITS_VALIDATION_ARM is read by pipeline_config at module-load. The lever
// is an IDENTITY seam (0 ≡ 1 → byte-identical solve), so the A/B delta is
// structurally empty BY DESIGN — the value is the OFF-arm truth verdict. --merge
// pairs the arms into truth-adjudicated trials and (because the FITS binding
// records the FRAME CENTER) truth adjudication is LIVE: a truth-DISAGREEING lock
// becomes a `new_false_positive` regression. It also adjudicates each frame's
// receipt.psf_attribution against the KNOWN rig (pillar C).

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, Ledger } from './ledger.ts';
import { fullCost } from './stats.ts';
import { extractSolverOutcome, computeSolverDelta, type SolverOutcome } from './domains.ts';
import { FITS_SOLVE } from './candidates/fits_solve.ts';
import { check } from './policy.ts';
import { resolveTruth } from './truth/loader.ts';
import { applyTruthToRunResult, recordedCenterIsFrameCenter } from './truth/harness_hook.ts';
import { adjudicatePsfAttribution } from './psf_attribution_check.ts';
import type { Trial, Efficiency, RunResult } from './types.ts';

const DETS_DIR = path.join(REPO_ROOT, 'test_results', 'fits_dets');
const RAW_DIR = path.join(REPO_ROOT, 'test_results', 'validation', '_fits_raw');
const DETAIL_FILE = path.join(REPO_ROOT, 'test_results', 'validation', 'fits_trials_detail.json');
const LABELS_FILE = path.join(REPO_ROOT, 'tools', 'validation', 'truth', 'labels.json');
const MANIFEST_FILE = path.join(REPO_ROOT, 'test_results', 'corpus_manifest.json');
const CONFIG = 'tools/validation/fits_binding.config.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Frame id = the source FITS basename minus extension (matches labels.json). */
function frameIdOfFits(fitsRel: string): string {
  return path.basename(fitsRel).replace(/\.(fit|fits|fts)$/i, '');
}

/**
 * Enumerate FITS detection dumps → { frame, rel (dump path), fits (FITS path) }.
 * frame is derived from the dump's `file` (the real FITS), so archive DUPLICATEs
 * map to their OWN distinct FITS → distinct frame_id (no dedupe needed; a frame
 * without a truth label resolves NO_TRUTH honestly).
 */
function enumerateDumps(limit?: number, frames?: string[]): { frame: string; rel: string }[] {
  if (!fs.existsSync(DETS_DIR)) return [];
  let out = fs
    .readdirSync(DETS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const rel = path.join('test_results', 'fits_dets', f);
      let frame = f.replace(/\.json$/i, '');
      try {
        const dump = JSON.parse(fs.readFileSync(path.join(DETS_DIR, f), 'utf8'));
        if (dump.file) frame = frameIdOfFits(dump.file);
      } catch { /* keep basename */ }
      return { frame, rel };
    });
  if (frames && frames.length) out = out.filter((d) => frames.includes(d.frame));
  return limit != null ? out.slice(0, limit) : out;
}

function runArm(arm: 0 | 1, dumps: { rel: string }[]): void {
  const FITS_DUMPS = dumps.map((d) => d.rel.split(path.sep).join('/')).join(',');
  console.log(`\n═══ ARM fits#${arm} — ${dumps.length} frames ═══`);
  const res = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vitest', 'run', '-c', CONFIG],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SOLVER_FITS_VALIDATION_ARM: String(arm),
        FITS_DUMPS,
        FITS_OUTDIR: RAW_DIR,
      },
      stdio: 'inherit',
      shell: false,
    },
  );
  if (res.status !== 0) console.error(`  [warn] arm fits#${arm} vitest exited ${res.status} (some frames may still have written raw results)`);
}

function readArm(arm: 0 | 1): Map<string, any> {
  const dir = path.join(RAW_DIR, `arm${arm}`);
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

/** frame_id → { cohort, camera } from the corpus manifest (authoritative rig). */
function loadRigMap(): Map<string, { cohort: string | null; camera: string | null }> {
  const m = new Map<string, { cohort: string | null; camera: string | null }>();
  if (!fs.existsSync(MANIFEST_FILE)) return m;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    for (const im of manifest.images ?? []) {
      const id = frameIdOfFits(im.path);
      m.set(id, { cohort: im.cohort ?? im.image_type ?? null, camera: im.camera ?? null });
    }
  } catch { /* honest-absent */ }
  return m;
}

/**
 * TRUTH ADJUDICATION — LIVE for FITS. The FITS binding records the FITTED FRAME
 * CENTER (recorded_center_is_frame=true, VERIFIED apples-to-apples with the frame-
 * center labels), so resolveTruth → applyTruthToRunResult grades a real center
 * agreement/disagreement (unlike the CR2 anchor-center harness, which is honest-
 * absent). NO_TRUTH ⇒ byte-identical to un-adjudicated grading.
 */
async function adjudicateArm(frame: string, raw: RunResult): Promise<RunResult> {
  if (!recordedCenterIsFrameCenter(raw)) return applyTruthToRunResult(raw, null);
  const truth = await resolveTruth(frame, { labelsFile: LABELS_FILE });
  return applyTruthToRunResult(raw, truth);
}

/**
 * FORCED-PHOTOMETRY ADJUDICATOR — a REPORTED signal, NEVER a gate. Maps the engine's
 * deep_confirmed summary (surfaced by fits_binding.distill → provenance.forced_photometry)
 * to a third-column verdict enum, orthogonal to solver-lock and oracle-truth. It touches
 * NOTHING in the solve/lock/truth path. The gate is calibrated N=1 (SeeStar-only), so this
 * ships as SIGNAL, flagged as such — not a science accept/reject.
 *   CONFIRMED     setGatePassed === true && confirmed >= 1
 *   FALSE_LOCK    not_measured == null && examined >= 10 && setGatePassed === false
 *   NOT_MEASURED  not_measured != null || examined < 10  (or forced_photometry absent)
 */
type ForcedVerdict = 'CONFIRMED' | 'FALSE_LOCK' | 'NOT_MEASURED';
function adjudicateForcedPhotometry(fp: any): {
  verdict: ForcedVerdict; setExcessZ: number | null; confirmed: number | null;
  examined: number | null; setGatePassed: boolean | null;
} {
  if (!fp) return { verdict: 'NOT_MEASURED', setExcessZ: null, confirmed: null, examined: null, setGatePassed: null };
  const examined = typeof fp.examined === 'number' ? fp.examined : null;
  const confirmed = typeof fp.confirmed === 'number' ? fp.confirmed : null;
  const setGatePassed = typeof fp.setGatePassed === 'boolean' ? fp.setGatePassed : null;
  const setExcessZ = typeof fp.setExcessZ === 'number' ? fp.setExcessZ : null;
  const notMeasured = fp.not_measured ?? null;
  let verdict: ForcedVerdict;
  if (setGatePassed === true && (confirmed ?? 0) >= 1) verdict = 'CONFIRMED';
  else if (notMeasured == null && (examined ?? 0) >= 10 && setGatePassed === false) verdict = 'FALSE_LOCK';
  else verdict = 'NOT_MEASURED';
  return { verdict, setExcessZ, confirmed, examined, setGatePassed };
}

async function merge(): Promise<void> {
  const off = readArm(0);
  const on = readArm(1);
  const rig = loadRigMap();
  const frames = [...new Set([...off.keys(), ...on.keys()])].sort();
  if (frames.length === 0) {
    console.error('no raw results found — run the arms first (--arm 0 / --arm 1).');
    process.exit(3);
  }

  const ledger = new Ledger(FITS_SOLVE.id);
  const detail: any[] = [];
  const rows: { frame: string; bo: SolverOutcome; co: SolverOutcome; imp: string[]; reg: string[]; truth: string; tier: string; psf: string; forced: string }[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  // TWO-TIER accounting — a coarse goto pass is NEVER conflated with a gold oracle pass.
  let goldTP = 0, coarseTP = 0;
  let psfPass = 0, psfFail = 0;
  // Forced-photometry (third column) tally — REPORT-ONLY, NON-GATING.
  let fpConfirmed = 0, fpFalseLock = 0, fpNotMeasured = 0;

  for (const frame of frames) {
    const o = off.get(frame);
    const c = on.get(frame);
    // OFF arm is authoritative for a single-arm --merge; ON mirrors it (identity seam).
    const oArm = o ?? c;
    const cArm = c ?? o;
    if (!oArm || !cArm) continue;

    const oAdj = await adjudicateArm(frame, oArm as RunResult);
    const cAdj = await adjudicateArm(frame, cArm as RunResult);
    const baseline = extractSolverOutcome(oAdj);
    const cand = extractSolverOutcome(cAdj);
    const delta = computeSolverDelta(baseline, cand);
    const truthVerdict =
      (oAdj as { truth?: { verdict?: string } }).truth?.verdict ??
      (cAdj as { truth?: { verdict?: string } }).truth?.verdict ??
      'NO_TRUTH';
    // WHICH tier adjudicated this frame (GOLD oracle bar vs COARSE goto) — recorded
    // so a coarse pass is counted, and reported, DISTINCTLY from a gold pass.
    const truthTier =
      (oAdj as { truth?: { tier?: string | null } }).truth?.tier ??
      (cAdj as { truth?: { tier?: string | null } }).truth?.tier ??
      null;
    if (truthVerdict === 'TRUE_POSITIVE') {
      truePositives += 1;
      if (truthTier === 'GOLD') goldTP += 1;
      else if (truthTier === 'COARSE') coarseTP += 1;
    }
    if (delta.regressions.includes('new_false_positive')) falsePositives += 1;

    // ── pillar C: adjudicate the PSF-attribution block against the KNOWN rig ──
    const r = rig.get(frame);
    const psfBlock = (oArm as any).provenance?.psf_attribution ?? null;
    const psfAdj = adjudicatePsfAttribution({
      frame_id: frame,
      block: psfBlock,
      cohort: r?.cohort ?? (oArm as any).image_type ?? null,
      camera: r?.camera ?? (oArm as any).provenance?.rig?.instrume ?? null,
    });
    if (psfBlock) {
      if (psfAdj.tracking.status === 'PASS') psfPass += 1;
      else if (psfAdj.tracking.status === 'FAIL') psfFail += 1;
    }

    // ── THIRD COLUMN: forced-photometry confirmation (report-only, NON-GATING) ──
    // The OFF arm is authoritative (identity seam). deep_confirmed lands in the arm
    // raw's provenance.forced_photometry (null on non-locked / unconfirmable frames).
    const fpBlock = (oArm as any).provenance?.forced_photometry ?? null;
    const fpAdj = adjudicateForcedPhotometry(fpBlock);
    if (fpAdj.verdict === 'CONFIRMED') fpConfirmed += 1;
    else if (fpAdj.verdict === 'FALSE_LOCK') fpFalseLock += 1;
    else fpNotMeasured += 1;

    const trial: Trial<SolverOutcome> = {
      candidate_id: FITS_SOLVE.id,
      input_id: frame,
      image_type: (oArm as any).image_type ?? 'FITS_OTHER',
      baseline,
      candidate: cand,
      delta,
      efficiency: toEfficiency(oArm as RunResult, cArm as RunResult),
      ts: Date.now(),
    };
    ledger.append(trial);
    rows.push({ frame, bo: baseline, co: cand, imp: delta.improvements, reg: delta.regressions, truth: truthVerdict, tier: truthTier ?? 'NO_TRUTH', psf: psfBlock ? psfAdj.tracking.status : 'no-psf', forced: fpAdj.verdict });
    detail.push({
      frame,
      image_type: trial.image_type,
      off: { locked: baseline.locked, ra: baseline.ra, dec: baseline.dec, scale: (oAdj as any).pixel_scale_arcsec, matched: baseline.matched, ms: oArm.wall_ms, threw: oArm.threw ?? null },
      truth_verdict: truthVerdict,
      truth_tier: truthTier,
      truth_comparison: (oAdj as { truth?: { comparison?: unknown } }).truth?.comparison ?? null,
      psf_attribution: {
        expected_tracking: psfAdj.expected_tracking,
        inferred: psfAdj.tracking.inferred,
        tracking_status: psfAdj.tracking.status,
        floor_status: psfAdj.floor.status,
        floor_ratio: psfAdj.floor.ratio,
        pass: psfAdj.pass,
      },
      // THIRD COLUMN — forced-photometry confirmation (report-only, NON-GATING signal;
      // calibrated N=1 SeeStar-only → NOT a science gate, carried as flagged evidence).
      forced_photometry: {
        verdict: fpAdj.verdict,
        setExcessZ: fpAdj.setExcessZ,
        confirmed: fpAdj.confirmed,
        examined: fpAdj.examined,
        setGatePassed: fpAdj.setGatePassed,
      },
      delta,
    });
  }

  fs.mkdirSync(path.dirname(DETAIL_FILE), { recursive: true });
  fs.writeFileSync(DETAIL_FILE, JSON.stringify({ generated: new Date().toISOString(), candidate: FITS_SOLVE.id, frames: detail }, null, 2), 'utf8');

  // ── summary ──
  console.log(`\n═══ FITS A/B merged — ${rows.length} frames (fits_solve) ═══`);
  console.log(`  ${'frame'.padEnd(46)} ${'lock'.padEnd(8)} ${'truth'.padEnd(15)} ${'tier'.padEnd(9)} ${'psf-track'.padEnd(10)} forced-phot`);
  for (const r of rows) {
    const fo = r.bo.locked ? `LOCK` : 'no-lock';
    const d = [...r.imp.map((x) => '+' + x), ...r.reg.map((x) => '-' + x)].join(' ');
    console.log(`  ${r.frame.slice(0, 46).padEnd(46)} ${fo.padEnd(8)} ${r.truth.padEnd(15)} ${r.tier.padEnd(9)} ${r.psf.padEnd(10)} ${r.forced}${d ? '  ' + d : ''}`);
  }

  const report = check(FITS_SOLVE, ledger.read());
  console.log(`\n  ── graduation verdict (fits_solve) ──`);
  for (const p of report.perType) {
    const na = p.applicable ? '' : '  (N/A)';
    console.log(`  ${p.image_type.padEnd(14)} ${p.verdict.padEnd(18)} n=${p.n}/${p.n_min}  +${p.improvements}/-${p.regressions}${na}`);
  }
  console.log(`  GLOBAL         ${report.global}`);

  console.log(`\n  ── solver-vs-truth (the rail's PRIMARY value) ──`);
  console.log(`  TRUE_POSITIVE: ${truePositives}   new_false_positive: ${falsePositives}   (identity lever → 0 net improvements/regressions expected)`);
  console.log(`  ── two-tier truth (COARSE goto NEVER conflated with GOLD oracle) ──`);
  console.log(`  GOLD TRUE_POSITIVE: ${goldTP}   COARSE TRUE_POSITIVE: ${coarseTP}   (GOLD is the trusted science bar; COARSE is added goto evidence, LAW 2)`);
  console.log(`  ── PSF-attribution tracking vs rig ──`);
  console.log(`  TRACKED-as-expected PASS: ${psfPass}   FAIL: ${psfFail}`);
  console.log(`  ── forced-photometry confirmation (REPORT-ONLY, NON-GATING; calibrated N=1 SeeStar-only → SIGNAL not a science gate) ──`);
  console.log(`  CONFIRMED: ${fpConfirmed}   FALSE_LOCK: ${fpFalseLock}   NOT_MEASURED: ${fpNotMeasured}`);
  console.log(`\n  ledger:  ${ledger.file}`);
  console.log(`  detail:  ${DETAIL_FILE}`);
}

async function main(): Promise<void> {
  const mergeOnly = process.argv.includes('--merge-only');
  const armSel = arg('--arm');
  const limit = arg('--limit') ? parseInt(arg('--limit')!, 10) : undefined;
  const frames = arg('--frames') ? arg('--frames')!.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const dumps = enumerateDumps(limit, frames);

  console.log(`FITS sweep — ${dumps.length} dumped frames:`);
  console.log('  ' + dumps.map((d) => d.frame).join(', '));

  if (!mergeOnly) {
    if (armSel === '0' || armSel === '1') {
      runArm(Number(armSel) as 0 | 1, dumps);
      return; // arm-only: caller merges after both arms complete
    }
    runArm(0, dumps);
    runArm(1, dumps);
  }
  await merge();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
