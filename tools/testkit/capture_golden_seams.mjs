#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/capture_golden_seams.mjs — golden seam-capsule ACCEPTANCE lane
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ HEAVY LANE — runs a REAL pinned SeeStar solve. NEVER run this during a
//   battery / another heavy lane (box-load incident protocol: one heavy lane
//   at a time). Inner-loop discipline (LAW 2): this tool banks + verifies the
//   frozen capsule set; the FULL gate battery still runs at every checkpoint.
//
// WHAT IT DOES (SEAM_CONTRACT v1 acceptance):
//   1. Resolve the pinned SeeStar FITS exactly as the standing gate does
//      (tools/api/solve_seestar.apispec.ts:19):
//        <ROOT>/Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit
//      and sha256 the file bytes → SEAM_FRAME_ID (contract §2 frame identity).
//   2. CAPTURE: spawn the EXISTING api-harness invocation, seam-capture armed:
//        node node_modules/vitest/vitest.mjs run -c tools/api/api_harness.config.ts \
//             tools/api/solve_seestar.apispec.ts
//      env: CAPTURE_SEAMS=1 · SEAM_FRAME_ID=<sha> · SEAM_CAPTURE_ROOT=<seams>
//           · SEAM_ENGINE_COMMIT=<git HEAD, best-effort>
//      The apispec asserts every SACRED number byte-identically, so the run is
//      simultaneously the proof that capture-ON did not perturb the solve.
//      Capsules land at <seams>/<frame_sha>/<seq>_<stage>/ (default seams root
//      = <artifactRoot>/seams, i.e. the env.mjs Windows heavy-root default —
//      storage law; the drive literal lives in lib/env.mjs ONLY).
//   3. REPLAY: run the stage-replay suite over every replayable stage:
//        node tools/testkit/run.mjs stage_replay_seams --label <label>
//      and REQUIRE: exit 0, zero red, and a byte-identical PASS row for EVERY
//      v1 replayable stage (m7_refine, spcc, psf_field, psf_attribution,
//      bc_measure, integrate). Exit nonzero on any red / missing pass /
//      exit-3 (zero replayable rows = capture produced nothing = FAIL here).
//
// FLAGS:
//   --help          this text (exits 0)
//   --self-test     verify the local plumbing only (sha helper, arg parsing,
//                   ledger grading) — NO solve, NO capture. Safe anywhere.
//   --dry-run       print the exact child commands + env, spawn NOTHING.
//   --skip-capture  grade existing capsules only (replay + acceptance).
//   --seams-root <dir>   override the seams root (both capture + replay legs).
//   --fits <path>        override the pinned FITS (default: the gate's SeeStar).
//   --label <label>      run label (default QUIET-BASELINE).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveEnv } from './lib/env.mjs';
import { runToCompletion } from './lib/child.mjs';
import { REPLAYABLE_STAGES } from './lib/executors/stage_replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The pinned SeeStar gate input — SAME resolution as tools/api/solve_seestar.apispec.ts:18-19.
export const PINNED_SEESTAR_REL = path.join('Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
// The bundled CR2 gate input — SAME resolution as tools/api/solve_cr2.apispec.ts:34 (rawler default arm).
export const PINNED_CR2_REL = path.join('public', 'demo', 'sample_observation.cr2');
// The v1 acceptance set (contract §1; psf is optional/user-requested → not required here).
export const ACCEPTANCE_STAGES = REPLAYABLE_STAGES.filter((s) => s !== 'psf');

// Capture scenarios. Each pins an INPUT + its apispec (which independently loads
// the SAME file → SEAM_FRAME_ID = sha256 of that file must match). SeeStar is the
// canonical golden frame with a HARD acceptance set; the bundled CR2 is the
// rawler-default arm — its per-stage replay fidelity is FIRST-EVER / UNMEASURED,
// so it is report-only (capture-sacred-held + replay-no-error is its gate; spcc
// is a FITS-only no-op on CR2, so the SeeStar acceptance set does not apply).
export const SCENARIOS = Object.freeze({
  seestar: { rel: PINNED_SEESTAR_REL, spec: 'tools/api/solve_seestar.apispec.ts', acceptanceStages: ACCEPTANCE_STAGES, decoderArm: 'rawler' },
  cr2:     { rel: PINNED_CR2_REL,     spec: 'tools/api/solve_cr2.apispec.ts',     acceptanceStages: null,             decoderArm: 'rawler' },
});

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function parseArgs(argv) {
  const opts = { help: false, selfTest: false, dryRun: false, skipCapture: false, seamsRoot: null, fits: null, input: null, scenario: 'seestar', label: 'QUIET-BASELINE' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-capture') opts.skipCapture = true;
    else if (a === '--seams-root') opts.seamsRoot = argv[++i];
    else if (a === '--scenario') opts.scenario = argv[++i];
    else if (a === '--fits' || a === '--input') opts.input = argv[++i];   // --fits kept as a back-compat alias
    else if (a === '--label') opts.label = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  if (!Object.prototype.hasOwnProperty.call(SCENARIOS, opts.scenario)) {
    return { error: `unknown --scenario "${opts.scenario}" (expected: ${Object.keys(SCENARIOS).join(' | ')})` };
  }
  return { opts };
}

/**
 * Grade a testkit ledger (JSONL) for acceptance: every stage in `stages` must
 * have at least one verdict='pass' row, and NO row may be red-class
 * (mismatch / capsule_invalid / error_driver). Returns { ok, missing, reds }.
 */
export function gradeLedger(ledgerPath, stages = ACCEPTANCE_STAGES, runId = null, frameSha = null) {
  if (!fs.existsSync(ledgerPath)) return { ok: false, missing: [...stages], reds: [], reason: `ledger missing: ${ledgerPath}` };
  let rows = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  if (runId) rows = rows.filter((r) => r.run_id === runId);       // the ledger APPENDS across runs — grade THIS run only
  if (frameSha) rows = rows.filter((r) => r.frame_sha === frameSha); // scenario scope — grade only this frame's rows
  const passStages = new Set(rows.filter((r) => r.verdict === 'pass').map((r) => r.stage));
  const reds = rows.filter((r) => ['mismatch', 'capsule_invalid', 'error_driver'].includes(r.verdict))
    .map((r) => ({ stage: r.stage, verdict: r.verdict, first_divergence: r.first_divergence ?? null, reason: r.reason ?? null }));
  const missing = stages.filter((s) => !passStages.has(s));
  return { ok: missing.length === 0 && reds.length === 0, missing, reds };
}

function gitHead(root) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }  // honest-absent (contract §2 engine_commit)
}

function usage() {
  console.log(`capture_golden_seams — golden seam-capsule capture + replay acceptance (SEAM_CONTRACT v1)

⚠ HEAVY LANE: runs a REAL pinned SeeStar solve (capture leg) + one vitest child
  per replayed stage. NEVER run during a battery or any other heavy lane
  (box-load protocol: one heavy lane at a time). LAW 2: this is an inner-loop
  verification tool — the full gate battery still runs at checkpoints.

Usage: node tools/testkit/capture_golden_seams.mjs [--scenario seestar|cr2]
         [--label QUIET-BASELINE|THROUGHPUT] [--seams-root <dir>] [--input <path>]
         [--skip-capture] [--dry-run] [--self-test]

Scenarios (rawler default arm):
  seestar  ${PINNED_SEESTAR_REL}  (canonical golden frame — HARD acceptance set)
  cr2      ${PINNED_CR2_REL}  (bundled CR2 — REPORT-ONLY, fidelity first-ever)

Capture child (documented, exact — scenario picks the apispec):
  node node_modules/vitest/vitest.mjs run -c tools/api/api_harness.config.ts <scenario apispec>
  env: CAPTURE_SEAMS=1 SEAM_FRAME_ID=<sha256(input)> SEAM_CAPTURE_ROOT=<seams> SEAM_ENGINE_COMMIT=<git HEAD>
Replay child:
  node tools/testkit/run.mjs stage_replay_seams --label <label>
Acceptance (seestar): replay AND a byte-identical PASS row for every v1 stage
  (${ACCEPTANCE_STAGES.join(', ')}) on the SeeStar frame; any red / missing pass fails.
Acceptance (cr2): report-only — capture-sacred-held + replay-no-error; per-stage
  reds/passes surfaced for inspection (spcc is a FITS-only no-op on CR2).`);
}

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
  // sha helper against the NIST SHA-256 test vector for "abc"
  const tmp = fs.mkdtempSync(path.join(process.env.TMP || process.env.TMPDIR || '.', 'seams_selftest_'));
  const f = path.join(tmp, 'abc.bin');
  fs.writeFileSync(f, 'abc');
  ok(sha256File(f) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256File matches the NIST "abc" vector');
  // arg parsing
  const { opts } = parseArgs(['--skip-capture', '--seams-root', 'X', '--label', 'THROUGHPUT']);
  ok(opts.skipCapture && opts.seamsRoot === 'X' && opts.label === 'THROUGHPUT' && opts.scenario === 'seestar', 'parseArgs maps flags (scenario defaults seestar)');
  ok(parseArgs(['--bogus']).error != null, 'parseArgs rejects unknown flags');
  // scenario selection
  ok(parseArgs(['--scenario', 'cr2']).opts.scenario === 'cr2', 'parseArgs maps --scenario cr2');
  ok(parseArgs(['--input', 'Y']).opts.input === 'Y' && parseArgs(['--fits', 'Y']).opts.input === 'Y', '--input / --fits alias both set input');
  ok(parseArgs(['--scenario', 'nope']).error != null, 'parseArgs rejects unknown scenario');
  ok(SCENARIOS.cr2.spec === 'tools/api/solve_cr2.apispec.ts' && SCENARIOS.cr2.acceptanceStages === null, 'cr2 scenario is report-only with the CR2 apispec');
  // ledger grading
  const led = path.join(tmp, 'ledger.jsonl');
  const mk = (stage, verdict, frame) => JSON.stringify(frame ? { stage, verdict, frame_sha: frame } : { stage, verdict });
  fs.writeFileSync(led, ACCEPTANCE_STAGES.map((s) => mk(s, 'pass')).join('\n') + '\n');
  ok(gradeLedger(led).ok === true, 'gradeLedger: all-pass ledger accepted');
  fs.writeFileSync(led, [mk('m7_refine', 'pass'), mk('spcc', 'mismatch')].join('\n') + '\n');
  const g = gradeLedger(led);
  ok(g.ok === false && g.reds.length === 1 && g.missing.includes('psf_field'), 'gradeLedger: mismatch red + missing stages rejected');
  ok(gradeLedger(path.join(tmp, 'nope.jsonl')).ok === false, 'gradeLedger: missing ledger rejected honestly');
  // frameSha scope filter: two frames, only the requested one graded
  fs.writeFileSync(led, [
    ...ACCEPTANCE_STAGES.map((s) => mk(s, 'pass', 'AAA')),
    mk('m7_refine', 'mismatch', 'BBB'),
  ].join('\n') + '\n');
  ok(gradeLedger(led, ACCEPTANCE_STAGES, null, 'AAA').ok === true, 'gradeLedger frameSha=AAA: ignores frame BBB reds');
  ok(gradeLedger(led, ACCEPTANCE_STAGES, null, 'BBB').ok === false, 'gradeLedger frameSha=BBB: grades only BBB (red)');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`self-test: ${pass} passed, ${fail} failed (plumbing only — no solve, no capture)`);
  return fail ? 1 : 0;
}

async function main(argv) {
  const { opts, error } = parseArgs(argv);
  if (error) { console.error(`capture_golden_seams: ${error}`); usage(); return 2; }
  if (opts.help) { usage(); return 0; }
  if (opts.selfTest) return selfTest();

  const env = resolveEnv();
  const scenario = SCENARIOS[opts.scenario];
  const seamsRoot = opts.seamsRoot ?? path.join(env.artifactRoot, 'seams');
  const input = opts.input ?? path.join(env.root, scenario.rel);
  if (!fs.existsSync(input)) { console.error(`capture_golden_seams: pinned ${opts.scenario} input missing at ${input} (local-only asset — same path the ${opts.scenario} apispec loads)`); return 2; }

  console.log(`[seams] scenario=${opts.scenario} (arm=${scenario.decoderArm}) sha256(${path.basename(input)}) …`);
  const frameSha = sha256File(input);
  console.log(`[seams] SEAM_FRAME_ID=${frameSha}`);
  const vitest = path.join(env.root, 'node_modules', 'vitest', 'vitest.mjs');
  const captureSpec = {
    command: process.execPath,
    // Rawler-default arm for BOTH scenarios: ambient env inherited, VITE_DECODER_RAWLER
    // NOT forced (the apispec's pins are the default-arm values; a =0 cold-path env
    // would make the apispec fail loudly, an honest red).
    args: [vitest, 'run', '-c', 'tools/api/api_harness.config.ts', scenario.spec],
    cwd: env.root,
    env: {
      ...process.env,
      CAPTURE_SEAMS: '1',
      SEAM_FRAME_ID: frameSha,
      SEAM_CAPTURE_ROOT: seamsRoot,
      SEAM_ENGINE_COMMIT: gitHead(env.root) ?? '',
    },
    timeoutMs: 600_000,
  };
  const replayArgs = [path.join(HERE, 'run.mjs'), 'stage_replay_seams', '--label', opts.label];
  const acceptStages = scenario.acceptanceStages;   // null → report-only (CR2 first-ever fidelity)

  if (opts.dryRun) {
    console.log(`[dry-run] capture: ${captureSpec.command} ${captureSpec.args.join(' ')}`);
    console.log(`[dry-run]   env: CAPTURE_SEAMS=1 SEAM_FRAME_ID=${frameSha} SEAM_CAPTURE_ROOT=${seamsRoot}`);
    console.log(`[dry-run] replay:  ${process.execPath} ${replayArgs.join(' ')}`);
    console.log(acceptStages
      ? `[dry-run] accept:  pass row required for each of [${acceptStages.join(', ')}] on frame ${frameSha.slice(0, 12)}…; any red fails.`
      : `[dry-run] accept:  REPORT-ONLY (scenario ${opts.scenario} fidelity is first-ever/unmeasured); capture-sacred-held + replay-no-error is the gate.`);
    return 0;
  }

  if (!opts.skipCapture) {
    console.log(`[seams] CAPTURE leg (heavy — real pinned ${opts.scenario} solve, sacred numbers asserted in-run) …`);
    const cap = await runToCompletion(captureSpec);
    if (cap.timedOut || cap.code !== 0) {
      console.error(`[seams] capture leg FAILED (${cap.timedOut ? 'timeout' : `exit ${cap.code}`}) — the apispec asserts the SACRED numbers, so a red here means capture-ON perturbed the solve OR the gate itself is red. Investigate before re-running.`);
      console.error((cap.stdout + '\n' + cap.stderr).slice(-1600));
      return 1;
    }
    console.log('[seams] capture leg PASSED (sacred numbers held with CAPTURE_SEAMS=1).');
  } else {
    console.log('[seams] --skip-capture: grading existing capsules.');
  }

  console.log('[seams] REPLAY leg …');
  const rep = await runToCompletion({ command: process.execPath, args: replayArgs, cwd: env.root, env: { ...process.env }, timeoutMs: 1_800_000 });
  process.stdout.write(rep.stdout);
  process.stderr.write(rep.stderr);
  if (rep.timedOut) {
    console.error('[seams] replay leg TIMED OUT (infra) — no grade.');
    return 1;
  }
  if (rep.code !== 0) {
    // exit 1 (reds somewhere) / exit 3 (zero replayable somewhere) are NOT
    // authoritative per-scenario: the shared seams root can hold OTHER frames
    // whose reds must not fail THIS scenario. The FRAME-SCOPED grade below is the
    // real gate (acceptance for seestar; report-only surfacing for cr2).
    console.error(`[seams] replay leg exited ${rep.code} (reds/zero-replayable somewhere in the shared seams root — grading THIS scenario's frame below).`);
  }
  const outDir = path.join(env.testResults, 'testkit_stage_replay_seams');
  const ledger = path.join(outDir, 'ledger.jsonl');
  let runId = null;
  try { runId = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8')).run_id ?? null; } catch { /* grade unfiltered */ }

  if (!acceptStages) {
    // REPORT-ONLY scenario: surface the per-stage outcomes for THIS frame, but do
    // not gate on a SeeStar-shaped acceptance set (CR2 replay fidelity is unmeasured).
    const g = gradeLedger(ledger, ACCEPTANCE_STAGES, runId, frameSha);
    console.log(`[seams] scenario=${opts.scenario} REPORT-ONLY — frame ${frameSha.slice(0, 12)}… replay reds: ${JSON.stringify(g.reds)} · pass-missing (vs SeeStar set): [${g.missing.join(', ')}]`);
    console.log(`[seams] CR2 capsules banked; capture sacred numbers held. Per-stage fidelity is FIRST-EVER — inspect the divergence dossiers under ${path.relative(env.root, path.join(env.artifactRoot, 'testkit_stage_replay_seams', 'logs')).replace(/\\/g, '/')}.`);
    return 0;
  }

  const grade = gradeLedger(ledger, acceptStages, runId, frameSha);
  if (!grade.ok) {
    console.error(`[seams] ACCEPTANCE FAILED — missing pass stages: [${grade.missing.join(', ')}], reds: ${JSON.stringify(grade.reds)}`);
    return 1;
  }
  console.log(`[seams] ACCEPTANCE PASSED — byte-identical replay for [${acceptStages.join(', ')}] on frame ${frameSha.slice(0, 12)}…`);
  return 0;
}

const invokedDirect = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return true; }
})();
if (invokedDirect) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('[capture_golden_seams FATAL]', e); process.exit(1); });
