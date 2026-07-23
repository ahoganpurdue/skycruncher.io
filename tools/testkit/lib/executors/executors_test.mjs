#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/executors_test.mjs — self-test for the 5 executors
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (`_test.mjs` underscore). Drives each
// executor with a MOCKED child (a real trivial `node`/.cjs child, the exact
// mechanism the executor uses) into a TEMP ledger via the REAL depositResult, and
// asserts: outcome mapping (incl. honest no-solve / timeout vs RED infra error),
// nonzero-exit propagation, the deposited ROW SHAPE (envelope contract), and —
// for e2e — the two-PID cleanup (Vite AND runner reaped by exact pid on all paths).
// stage_replay (SEAM_CONTRACT v1 §5) is tested against SYNTHETIC capsule pairs in
// a temp dir with a trivial stage fn injected via deps.invokeDriver — this tests
// the EXECUTOR machinery (load/sha-verify/compare/deposit), never the engine.
//   node tools/testkit/lib/executors/executors_test.mjs
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pidAlive } from '../child.mjs';
import * as solve from './solve_to_receipt.mjs';
import * as api from './api_smoke.mjs';
import * as golden from './golden_vector.mjs';
import * as e2e from './e2e_scenario.mjs';
import * as replay from './stage_replay.mjs';
import { planRows } from './index.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit_ex_'));
let ledgerSeq = 0;
function mkPaths(extra = {}) {
  const dir = path.join(TMP, `run_${ledgerSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    label: 'QUIET-BASELINE', runId: 'test-run', root: TMP, shardCount: 1,
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    receiptsDir: path.join(dir, 'receipts'),
    logsDir: path.join(dir, 'logs'),
    ...extra,
  };
}
function rows(paths) {
  if (!fs.existsSync(paths.ledgerPath)) return [];
  return fs.readFileSync(paths.ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
async function waitDead(pid, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!pidAlive(pid)) return true; await new Promise((r) => setTimeout(r, 40)); }
  return !pidAlive(pid);
}

// ── helper child scripts (.cjs = always CommonJS, package.json type-agnostic) ──
const RECEIPT_CJS = path.join(TMP, 'fake_receipt.cjs');
fs.writeFileSync(RECEIPT_CJS, `
const fs = require('fs');
const out = process.env.API_RUN_RECEIPT_OUT;
const mode = process.argv[2] || 'solved';
if (mode === 'solved') fs.writeFileSync(out, JSON.stringify({ version: '2.13.0', solution: { ra_hours: 1.5, dec_degrees: 2.5, pixel_scale: 3.5, stars_matched: 42, confidence: 0.9 }, pipeline_provenance: { decoder_arm: 'rawler', atlas_id: 'atl' }, confirm_status: { status: 'CONFIRMED' } }));
else if (mode === 'nosolve') fs.writeFileSync(out, JSON.stringify({ version: '2.13.0', solution: null }));
else if (mode === 'error') process.exit(3);   // no receipt + nonzero → RED
process.exit(0);
`);
const VITEST_CJS = path.join(TMP, 'fake_vitest.cjs');
fs.writeFileSync(VITEST_CJS, `
const P = +(process.argv[2] || 0), F = +(process.argv[3] || 0), code = +(process.argv[4] || 0);
console.log('Test Files  1 ' + (F ? 'failed' : 'passed') + ' (1)');
console.log(' Tests  ' + P + ' passed' + (F ? ' | ' + F + ' failed' : '') + ' (' + (P + F) + ')');
process.exit(code);
`);
const GOLDEN_CJS = path.join(TMP, 'fake_golden.cjs');
fs.writeFileSync(GOLDEN_CJS, `
const failCount = +(process.argv[2] || 0);
const boundaries = [{ name: 'b1', version: '0.2.0', units: 'px', checks: [{ status: failCount > 0 ? 'FAIL' : 'PASS' }, { status: 'NOT MEASURED' }] }];
const globalChecks = [{ status: 'PASS' }];
console.log(JSON.stringify({ tool: 'check_layout_contracts', surfaceVersion: '0.2.0', globalChecks, boundaries, failCount, exit: failCount > 0 ? 1 : 0 }));
process.exit(failCount > 0 ? 1 : 0);
`);

// ═══ solve_to_receipt ═════════════════════════════════════════════════════════
{
  const frame = { id: 'F1', rel: 'a/F1.fits', abs: path.join(TMP, 'F1.fits'), sha: 'sha_F1', format: 'FITS', lane: 'solve', timeout_ms: 60_000, disposition: 'enumerated', set_id: 's0', size_bytes: 100 };

  // solved
  let p = mkPaths();
  let r = await solve.run(frame, { root: TMP }, p, { command: NODE, args: [RECEIPT_CJS, 'solved'] });
  eq(r.outcome, 'solved', 'solve: fake solved receipt → outcome solved');
  eq(r.red, false, 'solve: solved is not red');
  let row = rows(p)[0];
  eq(row.row_schema, '1.0.0', 'solve row: envelope schema 1.0.0');
  eq(row.run_label, 'QUIET-BASELINE', 'solve row: run_label carried');
  eq(row.frame_sha, 'sha_F1', 'solve row: frame_sha = frame.sha');
  eq(row.outcome, 'solved', 'solve row: outcome solved');
  eq(row.executor, 'solve_to_receipt', 'solve row: executor tag');
  eq(row.stars_matched, 42, 'solve row: stars_matched read from receipt');
  eq(row.decoder_arm, 'rawler', 'solve row: decoder_arm read from receipt pipeline_provenance');
  eq(row.confirm_status, 'CONFIRMED', 'solve row: confirm_status surfaced');
  ok(typeof row.deposit_identity === 'string' && row.deposit_identity.includes('sha_F1'), 'solve row: deposit_identity keyed by frame_sha');

  // honest no-solve (valid outcome, NOT red)
  p = mkPaths();
  r = await solve.run(frame, { root: TMP }, p, { command: NODE, args: [RECEIPT_CJS, 'nosolve'] });
  eq(r.outcome, 'honest_failure', 'solve: solution:null receipt → honest_failure');
  eq(r.red, false, 'solve: honest_failure is NOT red (valid no-solve)');

  // infra error: nonzero exit + no receipt → error (RED, exit propagated)
  p = mkPaths();
  r = await solve.run(frame, { root: TMP }, p, { command: NODE, args: [RECEIPT_CJS, 'error'] });
  eq(r.outcome, 'error', 'solve: nonzero exit + no receipt → error');
  eq(r.red, true, 'solve: error is RED');
  row = rows(p)[0];
  eq(row.child_exit, 3, 'solve row: nonzero child exit propagated into the row (not swallowed)');

  // timeout mapping (inject a canned timed-out result — mapping-only, no 150s wait)
  p = mkPaths();
  r = await solve.run(frame, { root: TMP }, p, {
    runToCompletion: async () => ({ pid: 999999, code: null, signal: null, timedOut: true, error: null, killResult: { method: 'taskkill', killed: true }, stdout: '', stderr: '', durationMs: 5 }),
  });
  eq(r.outcome, 'honest_timeout', 'solve: timed-out child → honest_timeout');
  eq(r.red, false, 'solve: honest_timeout is NOT red');

  // stack-lane frame → skipped row, no spawn
  p = mkPaths();
  r = await solve.run({ ...frame, id: 'F2', lane: 'stack', disposition: 'skipped_correlated_set', reason: 'correlated_set_remainder' }, { root: TMP }, p, {});
  eq(r.outcome, 'skipped_correlated_set', 'solve: stack-lane frame → skipped_correlated_set');
  eq(r.red, false, 'solve: skipped is not red');
  row = rows(p)[0];
  eq(row.disposition, 'skipped_correlated_set', 'solve skip row: disposition carried');
}

// ═══ api_smoke ════════════════════════════════════════════════════════════════
{
  eq(JSON.stringify(api.parseVitestSummary('foo\n Tests  3 passed (3)\nbar')), JSON.stringify({ tests_passed: 3, tests_failed: 0 }), 'api parseVitestSummary: passed count');
  eq(JSON.stringify(api.parseVitestSummary(' Tests  0 passed | 2 failed (2)')), JSON.stringify({ tests_passed: 0, tests_failed: 2 }), 'api parseVitestSummary: failed count');
  eq(JSON.stringify(api.parseVitestSummary('no summary here')), JSON.stringify({ tests_passed: null, tests_failed: null }), 'api parseVitestSummary: honest-absent when no line');

  // pass
  let p = mkPaths();
  let r = await api.run({ id: 'solve_cr2', spec: 'tools/api/solve_cr2.apispec.ts' }, { root: TMP }, p, { command: NODE, args: [VITEST_CJS, '2', '0', '0'] });
  eq(r.outcome, 'pass', 'api: child exit 0 → pass');
  eq(r.red, false, 'api: pass not red');
  let row = rows(p)[0];
  eq(row.executor, 'api_smoke', 'api row: executor tag');
  eq(row.pins_checked, 2, 'api row: pins_checked from vitest summary');
  eq(row.spec, 'tools/api/solve_cr2.apispec.ts', 'api row: spec recorded');
  eq(row.run_label, 'QUIET-BASELINE', 'api row: run_label carried');

  // fail (nonzero exit → RED, exit propagated)
  p = mkPaths();
  r = await api.run({ id: 'solve_cr2', spec: 's.apispec.ts' }, { root: TMP }, p, { command: NODE, args: [VITEST_CJS, '0', '1', '1'] });
  eq(r.outcome, 'fail', 'api: child exit 1 → fail');
  eq(r.red, true, 'api: fail is RED');
  row = rows(p)[0];
  eq(row.child_exit, 1, 'api row: nonzero exit propagated');
  ok(typeof row.output_tail === 'string' && row.output_tail.length > 0, 'api row: output_tail captured on red for diagnosis');
}

// ═══ golden_vector ════════════════════════════════════════════════════════════
{
  // pure fn: countChecks
  const rep = { globalChecks: [{ status: 'PASS' }], boundaries: [{ checks: [{ status: 'PASS' }, { status: 'NOT MEASURED' }, { status: 'FAIL' }] }], failCount: 1 };
  eq(JSON.stringify(golden.countChecks(rep)), JSON.stringify({ pass: 2, fail: 1, nm: 1, boundaries: 1 }), 'golden countChecks: PASS/FAIL/NM/boundaries');

  // pure fn: parseGatesLayout (temp GATES.md)
  const gDir = path.join(TMP, 'gates_root', 'docs'); fs.mkdirSync(gDir, { recursive: true });
  fs.writeFileSync(path.join(gDir, 'GATES.md'), '| Layout contracts (LAW 7) | cmd | **90** PASS · **23** NOT MEASURED · **0** FAIL across **10** boundaries |\n');
  eq(JSON.stringify(golden.parseGatesLayout(path.join(gDir, 'GATES.md'))), JSON.stringify({ pass: 90, nm: 23, fail: 0, boundaries: 10 }), 'golden parseGatesLayout: standing counts parsed (cited, not hand-copied)');
  eq(golden.parseGatesLayout(path.join(TMP, 'nope.md')), null, 'golden parseGatesLayout: honest-null when absent');

  // run() pass — env.root = TMP (exists as child cwd) has no docs/GATES.md →
  // expected=null → gate on failCount alone.
  let p = mkPaths();
  let r = await golden.run({ id: 'layout' }, { root: TMP }, p, { command: NODE, args: [GOLDEN_CJS, '0'] });
  eq(r.outcome, 'pass', 'golden: failCount 0 (no GATES row) → pass');
  eq(r.red, false, 'golden: pass not red');
  let row = rows(p)[0];
  eq(row.executor, 'golden_vector', 'golden row: executor tag');
  eq(JSON.stringify(row.observed), JSON.stringify({ pass: 2, fail: 0, nm: 1, boundaries: 1 }), 'golden row: observed counts');

  // run() fail — failCount > 0
  p = mkPaths();
  r = await golden.run({ id: 'layout' }, { root: TMP }, p, { command: NODE, args: [GOLDEN_CJS, '1'] });
  eq(r.outcome, 'fail', 'golden: failCount 1 → fail');
  eq(r.red, true, 'golden: fail is RED');

  // run() drift — expected pass(5) from a GATES row > observed pass(2)
  p = mkPaths();
  r = await golden.run({ id: 'layout' }, { root: path.join(TMP, 'gates_root') }, p, { command: NODE, args: [GOLDEN_CJS, '0'] });
  eq(r.outcome, 'drift', 'golden: observed PASS < GATES-cited PASS → drift (RED)');
  eq(r.red, true, 'golden: drift is RED');
}

// ═══ e2e_scenario ═════════════════════════════════════════════════════════════
{
  // seed a dummy sample so the sha-keyed path fires (content sha of the file)
  const demoDir = path.join(TMP, 'public', 'demo'); fs.mkdirSync(demoDir, { recursive: true });
  fs.writeFileSync(path.join(demoDir, 'sample_observation.cr2'), 'dummy-cr2-bytes');

  const cannedPass = {
    pass: true, blindOutcome: 'solved',
    finalSession: { solution: { ra_hours: 17.595604137818327, pixel_scale: 63.439401949684004, matched: 79, confidence: 0.6785197423205406 } },
  };
  const trivialVite = () => ({ command: NODE, args: ['-e', 'setInterval(()=>{}, 1000)'], cwd: TMP });
  const trivialRunner = (code) => () => ({ command: NODE, args: ['-e', `process.exit(${code})`], cwd: TMP, timeoutMs: 10_000 });
  const baseDeps = (runnerCode, summary) => ({
    allocPort: async () => 0,
    prewarm: async () => true,
    buildViteSpec: (port, env, paths) => ({ ...trivialVite(), logFile: path.join(paths.logsDir, 'vite.log') }),
    buildRunnerSpec: (scenario, port, env, paths) => ({ ...trivialRunner(runnerCode)(), logFile: path.join(paths.logsDir, 'runner.log') }),
    readSummary: () => summary,
    shaSample: async () => 'fakesha1234',
  });

  // pass — runner exit 0 + pins match; assert BOTH children reaped by exact pid
  let p = mkPaths();
  let r = await e2e.run({ id: 'cr2', scenario: 'cr2' }, { root: TMP }, p, baseDeps(0, cannedPass));
  eq(r.outcome, 'pass', 'e2e: runner exit 0 + pins match → pass');
  eq(r.red, false, 'e2e: pass not red');
  let row = rows(p)[0];
  eq(row.executor, 'e2e_scenario', 'e2e row: executor tag');
  eq(row.scenario, 'cr2', 'e2e row: scenario recorded');
  eq(row.pins_match, true, 'e2e row: pins_match true');
  eq(row.frame_sha, 'fakesha1234', 'e2e row: sha-keyed (streamed sample sha)');
  eq(row.frame_sha_mode, 'content_sha256', 'e2e row: frame_sha_mode content_sha256');
  ok(Number.isInteger(row.vite_pid) && Number.isInteger(row.runner_pid), 'e2e row: both child pids recorded');
  ok(await waitDead(row.vite_pid), 'e2e: OWNED Vite reaped by exact pid (leaked-vite killer)');
  ok(await waitDead(row.runner_pid), 'e2e: runner tree reaped by exact pid');

  // fail — runner exit 3 (byte-identity assert broke); Vite still reaped
  p = mkPaths();
  r = await e2e.run({ id: 'cr2', scenario: 'cr2' }, { root: TMP }, p, baseDeps(3, cannedPass));
  eq(r.outcome, 'fail', 'e2e: runner exit 3 → fail (exit propagated)');
  eq(r.red, true, 'e2e: fail is RED');
  row = rows(p)[0];
  eq(row.runner_exit, 3, 'e2e row: runner nonzero exit propagated');
  ok(await waitDead(row.vite_pid), 'e2e: Vite reaped even on runner failure (finally path)');

  // pin_mismatch — runner exit 0 but observed ≠ pins (tripwire)
  p = mkPaths();
  const mismatch = { pass: true, blindOutcome: 'solved', finalSession: { solution: { ra_hours: 17.595604137818327, pixel_scale: 63.439401949684004, matched: 78, confidence: 0.6785197423205406 } } };
  r = await e2e.run({ id: 'cr2', scenario: 'cr2' }, { root: TMP }, p, baseDeps(0, mismatch));
  eq(r.outcome, 'pin_mismatch', 'e2e: exit 0 but matched 78≠79 → pin_mismatch (tripwire)');
  eq(r.red, true, 'e2e: pin_mismatch is RED');

  // comparePins pure-fn sanity
  ok(e2e.comparePins('seestar', { finalSession: { solution: { ra_hours: 11.341253475172621, pixel_scale: 3.6776147325019153, matched: 272, confidence: 0.8310893541573466 } } }).match, 'e2e comparePins: exact seestar pins match');
}

// ═══ stage_replay (SEAM_CONTRACT v1 §5) ═══════════════════════════════════════
{
  const FRAME = 'f'.repeat(64);
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

  // Build one capsule dir per contract §2 (sidecar + optional .bin buffers).
  // rawStateJson lets a test hand-write JSON the stringify path can't produce
  // (e.g. a literal -0, which JSON.parse preserves but JSON.stringify erases).
  let capSeq = 0;
  function writeCapsule({ stage, seq, state = {}, rawStateJson = null, buffers = [] }) {
    const dir = path.join(TMP, 'seams_fixtures', `cap_${capSeq++}`, `${String(seq).padStart(2, '0')}_${stage}`);
    fs.mkdirSync(dir, { recursive: true });
    const bufEntries = buffers.map((b) => {
      fs.writeFileSync(path.join(dir, `${b.field}.bin`), b.data);
      return {
        field: b.field, dtype: b.dtype ?? 'float32', shape: b.shape ?? [b.data.length / 4],
        byte_length: b.data.length, endianness: 'LE', units: b.units ?? 'adu',
        sha256: sha256(b.data), file: `${b.field}.bin`,
      };
    });
    const sidecar = {
      capsule_schema_version: '1.0.0', stage, seq, frame_sha: FRAME,
      receipt_schema_version: '2.13.0', binary_layouts_version: '0.4.0',
      engine_commit: null, decoder_arm: null, buffers: bufEntries, state: '__STATE__',
    };
    const text = JSON.stringify(sidecar).replace('"__STATE__"', rawStateJson ?? JSON.stringify(state));
    fs.writeFileSync(path.join(dir, 'capsule.json'), text);
    return dir;
  }
  const mkRow = (stage, inputDir, expectedDir, seq = 9) => ({
    id: `${FRAME.slice(0, 8)}_${String(seq).padStart(2, '0')}_${stage}`,
    frame_sha: FRAME, stage, seq, capsule_dir: expectedDir, input_capsule_dir: inputDir,
  });
  // trivial injected stage fn — writes a replayed capsule from the loaded input
  const mkDriver = (mutate) => async (row, _env, replayedDir, { input }) => {
    fs.mkdirSync(replayedDir, { recursive: true });
    const st = JSON.parse(JSON.stringify(input.sidecar.state));
    mutate(st);
    const sidecar = {
      ...input.sidecar, stage: row.stage, replayed: true,
      buffers: (input.sidecar.buffers ?? []).map((b) => ({ ...b, file: null, unchanged_from_input: true })),
      state: st,
    };
    fs.writeFileSync(path.join(replayedDir, 'capsule.json'), JSON.stringify(sidecar));
  };

  // pure fns: IEEE-exact compare (−0, ULP, missing key), byte divergence
  {
    const c1 = replay.compareJsonStates({ a: 1, b: [1, 2, { c: 'x' }] }, { a: 1, b: [1, 2, { c: 'x' }], extra: 9 });
    ok(c1.equal && c1.json_leaves === 4, 'replay compareJsonStates: deep-equal, extra replayed keys ignored');
    const c2 = replay.compareJsonStates({ a: -0 }, { a: 0 });
    ok(!c2.equal && c2.first_divergence.path === 'a' && c2.first_divergence.want === '-0', 'replay compareJsonStates: Object.is catches -0 vs 0');
    const c3 = replay.compareJsonStates({ a: { b: 2 } }, { a: {} });
    ok(!c3.equal && c3.first_divergence.path === 'a.b' && c3.first_divergence.got === '(missing key)', 'replay compareJsonStates: missing key surfaced with path');
    eq(replay.firstByteDivergence(Buffer.from([1, 2, 3]), Buffer.from([1, 9, 3])), 1, 'replay firstByteDivergence: offset of first differing byte');
    eq(replay.firstByteDivergence(Buffer.from([1, 2]), Buffer.from([1, 2])), -1, 'replay firstByteDivergence: identical → -1');

    // volatile-field mask (task fix #1) — declared whitelist, logged when hit
    const cm = replay.compareJsonStates({ receipt: { export_date: 'A', ra: 1 } }, { receipt: { export_date: 'B', ra: 1 } }, { mask: ['receipt.export_date'] });
    ok(cm.equal && cm.masked.length === 1 && cm.masked[0] === 'receipt.export_date', 'replay compareJsonStates: declared volatile path masked → equal, recorded in masked[]');
    const cm2 = replay.compareJsonStates({ receipt: { export_date: 'A', ra: 1 } }, { receipt: { export_date: 'B', ra: 2 } }, { mask: ['receipt.export_date'] });
    ok(!cm2.equal && cm2.first_divergence.path === 'receipt.ra' && cm2.masked.includes('receipt.export_date'), 'replay compareJsonStates: mask skips ONLY the declared leaf — a real sibling divergence still fails');
    const cm3 = replay.compareJsonStates({ a: 1 }, { a: 1 }, { mask: ['nope.stale'] });
    ok(cm3.equal && cm3.masked.length === 0 && cm3.masked_declared.includes('nope.stale'), 'replay compareJsonStates: declared-but-unhit mask reported (stale-mask tripwire)');
    const cm4 = replay.compareJsonStates({ receipt: { export_date: 'A', ra: 1 } }, { receipt: { ra: 1 } }, { mask: ['receipt.export_date'] });
    ok(cm4.equal && cm4.masked.includes('receipt.export_date'), 'replay compareJsonStates: masked key skips the missing-key check too');
  }

  const BUF = Buffer.from(new Float32Array([1.5, -2.25, 3e-7, 0]).buffer);
  const baseState = { solution: { ra_hours: 11.341253475172621, matched: 3 }, imageWidth: 4, imageHeight: 1, warnings: [] };

  // (b) byte-identical fixture replay → pass (row shape asserted)
  {
    const input = writeCapsule({ stage: 'psf_field', seq: 8, state: baseState, buffers: [{ field: 'scienceBuffer', data: BUF }] });
    const expState = { ...baseState, bcMeasured: { k1: -0.145, n_used: 3 } };
    const expected = writeCapsule({ stage: 'bc_measure', seq: 9, state: expState, buffers: [{ field: 'scienceBuffer', data: BUF }] });
    const p = mkPaths();
    const r = await replay.run(mkRow('bc_measure', input, expected), { root: TMP }, p, {
      invokeDriver: mkDriver((st) => { st.bcMeasured = { k1: -0.145, n_used: 3 }; }),
    });
    eq(r.outcome, 'pass', 'replay: byte-identical synthetic replay → pass');
    eq(r.red, false, 'replay: pass not red');
    const row = rows(p)[0];
    eq(row.executor, 'stage_replay', 'replay row: executor tag');
    eq(row.stage, 'bc_measure', 'replay row: stage recorded');
    eq(row.frame_sha, FRAME, 'replay row: frame_sha carried');
    eq(row.capsule_schema_version, '1.0.0', 'replay row: capsule schema version recorded');
    eq(row.verdict, 'pass', 'replay row: verdict pass');
    ok(row.compared && row.compared.json_leaves > 0 && row.compared.buffers === 1, 'replay row: compared counts (json leaves + buffers)');
    ok(Number.isFinite(row.wall_ms), 'replay row: wall_ms measured');
    eq(rows(p).length, 1, 'replay: EXACTLY ONE deposited row per row (contract §5)');
  }

  // (c1) plain ULP-level numeric diff → mismatch with first_divergence path
  {
    const input = writeCapsule({ stage: 'spcc', seq: 8, state: baseState });
    const expected = writeCapsule({ stage: 'bc_measure', seq: 9, state: { ...baseState, bcMeasured: { k1: 0.1 + 2e-17 } } });
    const p = mkPaths();
    const r = await replay.run(mkRow('bc_measure', input, expected), { root: TMP }, p, {
      invokeDriver: mkDriver((st) => { st.bcMeasured = { k1: 0.1 }; }),
    });
    eq(r.outcome, 'mismatch', 'replay: ULP numeric diff → mismatch (IEEE-exact, no tolerance)');
    eq(r.red, true, 'replay: mismatch is RED');
    const row = rows(p)[0];
    eq(row.first_divergence.path, 'bcMeasured.k1', 'replay row: first_divergence path recorded');
  }

  // (c2) −0 vs 0 → mismatch (Object.is per number; JSON.parse preserves -0)
  {
    const raw = JSON.stringify(baseState).replace('}', ',"crval0":-0}'); // hand-written -0 inside solution? keep top-level for clarity
    const expRaw = JSON.stringify({ ...baseState }).slice(0, -1) + ',"crval0":-0}';
    const input = writeCapsule({ stage: 'spcc', seq: 8, state: { ...baseState, crval0: 0 } });
    const expected = writeCapsule({ stage: 'bc_measure', seq: 9, rawStateJson: expRaw });
    const p = mkPaths();
    const r = await replay.run(mkRow('bc_measure', input, expected), { root: TMP }, p, {
      invokeDriver: mkDriver(() => { /* leaves crval0 as parsed 0 */ }),
    });
    eq(r.outcome, 'mismatch', 'replay: -0 (frozen) vs 0 (replayed) → mismatch');
    const row = rows(p)[0];
    eq(row.first_divergence.want, '-0', 'replay row: -0 printed honestly in first_divergence (stringify would erase it)');
    void raw;
  }

  // (a) capsule sha mismatch → capsule_invalid (RED infra), loud not silent
  {
    const input = writeCapsule({ stage: 'spcc', seq: 8, state: baseState, buffers: [{ field: 'scienceBuffer', data: BUF }] });
    const expected = writeCapsule({ stage: 'bc_measure', seq: 9, state: baseState, buffers: [{ field: 'scienceBuffer', data: BUF }] });
    fs.writeFileSync(path.join(expected, 'scienceBuffer.bin'), Buffer.concat([BUF.subarray(0, BUF.length - 1), Buffer.from([0x7f])]));
    const p = mkPaths();
    const r = await replay.run(mkRow('bc_measure', input, expected), { root: TMP }, p, { invokeDriver: mkDriver(() => { }) });
    eq(r.outcome, 'capsule_invalid', 'replay: corrupted buffer bytes vs sidecar sha → capsule_invalid');
    eq(r.red, true, 'replay: capsule_invalid is RED (infra)');
    ok(/sha256/.test(rows(p)[0].reason), 'replay row: sha-mismatch reason recorded');

    // missing input capsule dir → capsule_invalid too (no predecessor = infra)
    const p2 = mkPaths();
    const r2 = await replay.run(mkRow('bc_measure', null, writeCapsule({ stage: 'bc_measure', seq: 9, state: baseState })), { root: TMP }, p2, { invokeDriver: mkDriver(() => { }) });
    eq(r2.outcome, 'capsule_invalid', 'replay: missing input capsule → capsule_invalid');
  }

  // (d) NOT-YET stage → skip_not_replayable with the named blocker, NOT red
  {
    const p = mkPaths();
    const r = await replay.run(mkRow('solve', null, path.join(TMP, 'nonexistent')), { root: TMP }, p, {});
    eq(r.outcome, 'skip_not_replayable', 'replay: NOT-YET stage (solve) → skip_not_replayable');
    eq(r.red, false, 'replay: skip_not_replayable is NOT red (honest)');
    const row = rows(p)[0];
    ok(typeof row.blocker === 'string' && /StarCatalogAdapter/.test(row.blocker), 'replay row: named blocker from contract §1 deposited');
    const p3 = mkPaths();
    const r3 = await replay.run(mkRow('forced_confirm', null, path.join(TMP, 'nonexistent')), { root: TMP }, p3, {});
    eq(r3.outcome, 'skip_not_replayable', 'replay: forced_confirm → skip_not_replayable (grep-resolved catalog dependency)');
    ok(/solver_entry\.ts:2506/.test(rows(p3)[0].blocker), 'replay row: forced_confirm blocker cites the grep evidence');
  }

  // (e) planRows enumeration from a fake seams_root (chaining + filters)
  {
    const seams = path.join(TMP, 'fake_seams');
    const frameDir = path.join(seams, FRAME);
    for (const d of ['04_solve', '05_m7_refine', '06_spcc']) fs.mkdirSync(path.join(frameDir, d), { recursive: true });
    const all = replay.planReplayRows(seams);
    eq(all.length, 3, 'replay planRows: enumerates all capsule dirs');
    eq(all[0].input_capsule_dir, null, 'replay planRows: first seq has no input (no predecessor)');
    eq(all[1].input_capsule_dir, path.join(frameDir, '04_solve'), 'replay planRows: input = previous-seq capsule dir');
    eq(all[1].id, `${FRAME.slice(0, 8)}_05_m7_refine`, 'replay planRows: id = <sha8>_<seq>_<stage>');
    eq(all[2].stage, 'spcc', 'replay planRows: stage parsed from dir name');
    const filtered = replay.planReplayRows(seams, { stages: ['spcc'] });
    eq(filtered.length, 1, 'replay planRows: stages filter applied');
    eq(filtered[0].input_capsule_dir, path.join(frameDir, '05_m7_refine'), 'replay planRows: input chain uses FULL seq order, not the filtered set');
    eq(replay.planReplayRows(seams, { frames: ['0000'] }).length, 0, 'replay planRows: frames filter applied');
    eq(replay.planReplayRows(path.join(TMP, 'no_such_root')).length, 0, 'replay planRows: missing seams_root → zero rows (run.mjs exits 3 honestly)');
    // registry wiring: planRows dispatches through index.mjs with suite/env
    const viaIndex = planRows('stage_replay', { suite: { seams_root: seams, stages: ['m7_refine'] }, env: { root: TMP, artifactRoot: TMP } });
    eq(viaIndex.length, 1, 'index planRows: stage_replay case wired (suite.seams_root honored)');
    // task fix #1: suite.volatile_fields threaded onto EVERY row
    const withMask = planRows('stage_replay', { suite: { seams_root: seams, volatile_fields: ['receipt.export_date'] }, env: { root: TMP, artifactRoot: TMP } });
    ok(withMask.length === 3 && withMask.every((r) => Array.isArray(r.volatile_fields) && r.volatile_fields[0] === 'receipt.export_date'), 'index planRows: suite.volatile_fields threaded onto every row');
    // capsule-slice-scoped mask (orchestrator ruling 2026-07-21): fields apply ONLY
    // to the matching frame(prefix)+stage row, never globally. FRAME='f'.repeat(64);
    // the spcc dir is '06_spcc' → only that row gets spccBlock; m7_refine/solve don't.
    const scopedRows = planRows('stage_replay', { suite: { seams_root: seams, volatile_fields: ['receipt.export_date'], scoped_volatile_fields: [{ frame: 'ffff', stage: 'spcc', fields: ['spccBlock'] }] }, env: { root: TMP, artifactRoot: TMP } });
    const spccRow = scopedRows.find((r) => r.stage === 'spcc');
    const nonSpcc = scopedRows.filter((r) => r.stage !== 'spcc');
    ok(spccRow && spccRow.volatile_fields.includes('spccBlock') && spccRow.volatile_fields.includes('receipt.export_date'), 'index planRows: scoped mask adds spccBlock to the matching spcc slice (global mask preserved)');
    ok(nonSpcc.length === 2 && nonSpcc.every((r) => !r.volatile_fields.includes('spccBlock')), 'index planRows: scoped mask does NOT leak onto non-spcc slices');
    const wrongFrame = planRows('stage_replay', { suite: { seams_root: seams, scoped_volatile_fields: [{ frame: '0000', stage: 'spcc', fields: ['spccBlock'] }] }, env: { root: TMP, artifactRoot: TMP } });
    ok(wrongFrame.every((r) => !Array.isArray(r.volatile_fields) || !r.volatile_fields.includes('spccBlock')), 'index planRows: scoped mask frame-prefix must match (wrong frame → no mask)');
  }

  // (f) volatile mask end-to-end (task fix #1): a wall-clock export_date that
  // differs between frozen + replayed is masked → integrate-style PASS.
  {
    const input = writeCapsule({ stage: 'psf', seq: 14, state: { ...baseState, receipt: { export_date: 'FROZEN', zeropoint: 15.6 } } });
    const expected = writeCapsule({ stage: 'integrate', seq: 15, state: { ...baseState, receipt: { export_date: 'FROZEN', zeropoint: 15.6 } } });
    const p = mkPaths();
    const r = await replay.run({ ...mkRow('integrate', input, expected, 15), volatile_fields: ['receipt.export_date'] }, { root: TMP }, p, {
      invokeDriver: mkDriver((st) => { st.receipt = { export_date: 'REPLAY-WALLCLOCK', zeropoint: 15.6 }; }),
    });
    eq(r.outcome, 'pass', 'replay: differing volatile export_date masked → PASS (task fix #1)');
    const row = rows(p)[0];
    ok(Array.isArray(row.masked_volatile) && row.masked_volatile.includes('receipt.export_date'), 'replay row: masked_volatile records the skipped path (logged, never silent)');
  }

  // (g) a REAL divergence stays RED + writes a localized dossier (task fix #3):
  // NEVER masked green; the swallowed driver stage-error is surfaced.
  {
    const input = writeCapsule({ stage: 'psf_attribution', seq: 10, state: baseState });
    const expected = writeCapsule({ stage: 'bc_measure', seq: 11, state: { ...baseState, bcMeasured: { k1: -0.14 } } });
    const p = mkPaths();
    const gRow = mkRow('bc_measure', input, expected, 11);
    const r = await replay.run(gRow, { root: TMP }, p, {
      invokeDriver: mkDriver((st) => { st.bcMeasured = null; st.__replay_stage_error = { stage: 'bc_measure', message: 'synthetic throw' }; }),
    });
    eq(r.outcome, 'mismatch', 'replay: real null-vs-object divergence stays RED (never masked)');
    const row = rows(p)[0];
    ok(typeof row.divergence_dossier === 'string' && row.divergence_dossier.length > 0, 'replay row: divergence_dossier path recorded');
    eq(row.replay_stage_error && row.replay_stage_error.message, 'synthetic throw', 'replay row: driver-swallowed stage error surfaced (localization)');
    const dossPath = path.join(p.logsDir, `${gRow.id}_divergence.json`);
    ok(fs.existsSync(dossPath), 'replay: divergence dossier file written to logsDir');
    const doss = JSON.parse(fs.readFileSync(dossPath, 'utf8'));
    ok(doss.divergent_block && doss.divergent_block.key === 'bcMeasured' && doss.divergent_block.replayed === null, 'replay dossier: localizes the divergent top-level block (expected object vs replayed null)');
    ok(doss.replay_stage_error && doss.replay_stage_error.message === 'synthetic throw', 'replay dossier: surfaces the driver-recorded swallowed throw');
    ok(typeof doss.diagnosis === 'string' && /measureBrownConradyFromSolution/.test(doss.diagnosis), 'replay dossier: canned bc_measure diagnosis hint present');
  }
}

// cleanup temp
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\nexecutors self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
