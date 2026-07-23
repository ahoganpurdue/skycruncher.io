#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/solve_stats_test.mjs — self-test for the solve/failure analytics.
// Plain-assert, vitest-free, node-runnable (tools-lane idiom). Named `*_test.mjs`
// (underscore) NOT `*.test.mjs` — the dot form is swept by the vitest gate.
//   Run:  node tools/analytics/solve_stats_test.mjs
//
// FOCUS (the two things this analytics MUST get right):
//   · DENOMINATOR correctness — every rate over the right denominator. A frame the
//     blind lane FAILED but the assisted lane SOLVED stays in the blind denominator
//     as a failure (dropping it would inflate the blind rate); a SKIPPED frame is in
//     n_frames but NOT n_attempted; a rerun RECOVERY counts as a blind solve.
//   · CLASS SEPARATION — assisted solves NEVER inflate blind numbers. The blind
//     solve rate is byte-identical whether or not assisted deposits exist.
// Plus: helper derivations (format / rig / header-pointing), honest-null rate on an
// empty denominator, unmeasured NOT folded into absent, determinism.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus, stableStringify } from './lib/corpus.mjs';
import {
  computeSolveStats, frameFormat, rigFamily, headerPointing, solvedVia,
  blindDisposition, inBlindLane, isSkipped,
} from './solve_stats.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const SHA = (c) => c.repeat(64);
const SHA_FITS = SHA('1'), SHA_CR2 = SHA('2'), SHA_SKIP = SHA('3'), SHA_REC = SHA('4'), SHA_PURE = SHA('5');

// ── synthetic corpus on disk ──────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'solvestats_test_'));
const solvedDir = path.join(TMP, 'receipts');
const nosolveDir = path.join(TMP, 'nosolve', 'receipts');
const dossierDir = path.join(TMP, 'dossiers');
for (const d of [solvedDir, nosolveDir, dossierDir]) fs.mkdirSync(d, { recursive: true });
const wj = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const wjl = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// FITS_A — blind SOLVED, header pointing present, ZWO ASI, solved_via metadata.
wj(path.join(solvedDir, 'fitsA.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null,
  metadata: { width: 100, height: 100, camera_model: 'FITS ZWO ASI533MC Pro', ra_hint: 10.3, dec_hint: 21.6 },
  solve_provenance: { solved_via: 'assisted:metadata' },
  solution: { ra_hours: 1, stars_matched: 300, confidence: 0.7, matched_stars: [{ x: 50, y: 50, mag: 10 }] },
});
// CR2_B — blind FAILED (no-solve receipt) then ASSISTED solved (envelope). Canon, no header pointing.
wj(path.join(nosolveDir, 'cr2B.CR2.receipt.json'), {
  version: '2.13.0', kind: 'no_solve', solution: null, frame_sha256: SHA_CR2,
  image_width: 5202, image_height: 3465, source_provenance: null,
  metadata: { width: 5202, height: 3465, camera_model: 'Canon EOS Rebel T6' }, // NO ra_hint/dec_hint
});
// SKIP_C — deliberately skipped (ledger skipped_correlated_set), no receipt.
// REC_D — RECOVERY: population ledger no_solve, rerun receipt carries a solution.
wj(path.join(nosolveDir, 'recD.fits.receipt.json'), {
  version: '2.13.0', source_provenance: null,
  metadata: { width: 200, height: 200, camera_model: 'FITS ZWO ASI533MC Pro', ra_hint: 5, dec_hint: 5 },
  solve_provenance: { solved_via: 'blind' },
  solution: { ra_hours: 9, stars_matched: 120, confidence: 0.4, matched_stars: [] },
});
// PURE_E — blind SOLVED with NO header pointing (pure blind), Seestar.
wj(path.join(solvedDir, 'pureE.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null,
  metadata: { width: 60, height: 60, camera_model: 'ZWO Seestar S50' }, // no ra_hint
  solve_provenance: { solved_via: 'blind' },
  solution: { ra_hours: 3, stars_matched: 80, confidence: 0.55, matched_stars: [] },
});

// dossiers (taxonomy)
wj(path.join(dossierDir, 'cr2B.CR2.dossier.json'), {
  key: `sha:${SHA_CR2}`, key_mode: 'sha', frame: { name: 'cr2B.CR2', sha256: SHA_CR2, source_format: 'CR2' },
  outcome: 'no_solve', taxonomy: { class: 'ladder_exhaustion', basis: 'Search exhausted' },
  stage_of_death: { stage_reached: 'solve', stage_of_death: 'solve', reason: 'no geometric lock' },
});
wj(path.join(dossierDir, 'skipC.fit.dossier.json'), {
  key: `sha:${SHA_SKIP}`, key_mode: 'sha', frame: { name: 'skipC.fit', sha256: SHA_SKIP, source_format: 'FITS' },
  outcome: 'skipped_correlated_set', taxonomy: { class: 'skipped', basis: 'ledger outcome=skipped_correlated_set' },
  stage_of_death: null,
});

// ledgers (blind lane)
const popLedger = path.join(TMP, 'ledger_resolved.jsonl');
wjl(popLedger, [
  { seq: 1, id: 'fitsA.fit', path: 'fitsA.fit', sha: SHA_FITS, format: 'FITS', outcome: 'solved', resolved_outcome: 'solved', stars_matched: 300, confidence: 0.7, confirm_status: 'CONFIRMED' },
  { seq: 2, id: 'cr2B.CR2', path: 'cr2B.CR2', sha: SHA_CR2, format: 'CR2', outcome: 'no_solve', resolved_outcome: 'no_solve', stars_matched: null, confidence: null },
  { seq: 3, id: 'skipC.fit', path: 'skipC.fit', sha: SHA_SKIP, format: 'FITS', outcome: 'skipped_correlated_set', resolved_outcome: 'skipped_correlated_set' },
  { seq: 4, id: 'recD.fits', path: 'recD.fits', sha: SHA_REC, format: 'FITS', outcome: 'no_solve', resolved_outcome: 'no_solve' },
  { seq: 5, id: 'pureE.fit', path: 'pureE.fit', sha: SHA_PURE, format: 'FITS', outcome: 'solved', resolved_outcome: 'solved', stars_matched: 80, confidence: 0.55, confirm_status: 'REFUSED' },
]);
const nosolveLedger = path.join(TMP, 'nosolve', 'ledger.jsonl');
wjl(nosolveLedger, [
  { seq: 1, id: 'recD.fits', path: 'recD.fits', format: 'FITS', outcome: 'solved', resolved_outcome: 'solved', stars_matched: 120, confidence: 0.4 },
]);

// envelope ledger (assisted lane) — CR2_B rescued.
const envLedger = path.join(TMP, 'ledger_envelope.jsonl');
wjl(envLedger, [
  { row_schema: '1.0.0', run_label: 'HINTED-COCOON', solve_class: 'assisted', outcome: 'solved',
    frame_sha: SHA_CR2, frame_sha_mode: 'content_sha256', frame_basename: 'cr2B.CR2',
    rig: 'cocoon_60da', matched: 3171, confidence: 0.53 },
]);

const spec = { receiptDirs: [solvedDir, nosolveDir], ledgers: [popLedger, nosolveLedger], dossierDir, envelopeLedgers: [envLedger] };

try {
  const loaded = loadCorpus(spec);
  const byKey = new Map(loaded.frames.map((f) => [f.key, f]));
  const A = byKey.get(`sha:${SHA_FITS}`), B = byKey.get(`sha:${SHA_CR2}`),
    C = byKey.get(`sha:${SHA_SKIP}`), D = byKey.get(`sha:${SHA_REC}`), E = byKey.get(`sha:${SHA_PURE}`);

  // ── (0) fixture sanity: the join placed frames as intended ──────────────────
  eq(loaded.frames.length, 5, 'five synthetic frames');
  eq(A.kind, 'solved', 'A blind solved');
  eq(B.kind, 'assisted', 'B assisted (blind failed, assisted solved)');
  eq(B.outcome, 'no_solve', 'B blind outcome preserved no_solve');
  eq(C.outcome, 'skipped_correlated_set', 'C skipped');
  eq(D.kind, 'solved', 'D recovered → solved');
  eq(D.outcome, 'no_solve', 'D blind population outcome preserved no_solve');

  // ── (1) per-frame derivations ───────────────────────────────────────────────
  eq(frameFormat(A), 'FITS', 'A format FITS');
  eq(frameFormat(B), 'CR2', 'B format CR2');
  eq(rigFamily(A), 'ZWO ASI', 'A rig ZWO ASI');
  eq(rigFamily(B), 'Canon DSLR', 'B rig Canon DSLR');
  eq(rigFamily(E), 'ZWO Seestar', 'E rig ZWO Seestar');
  eq(headerPointing(A), 'present', 'A header pointing present (ra/dec hint)');
  eq(headerPointing(B), 'absent', 'B header pointing absent (has receipt, no hint)');
  eq(headerPointing(C), 'unmeasured', 'C header pointing unmeasured (no receipt)');
  eq(solvedVia(A), 'assisted:metadata', 'A solved_via metadata (leaned on header)');
  eq(solvedVia(E), 'blind', 'E solved_via pure blind');
  eq(blindDisposition(A), 'solved', 'A disposition solved');
  eq(blindDisposition(B), 'failed', 'B disposition FAILED (blind lane) — not dropped by assisted solve');
  eq(blindDisposition(C), 'skipped', 'C disposition skipped');
  eq(blindDisposition(D), 'solved', 'D disposition solved (recovery)');
  eq(isSkipped(C), true, 'C isSkipped');
  ok(loaded.frames.every(inBlindLane), 'all synthetic frames are in the blind lane (have ledger evidence)');

  const R = computeSolveStats(loaded);

  // ── (2) DENOMINATOR correctness ─────────────────────────────────────────────
  const den = R.blind_lane.denominators;
  eq(den.n_blind_frames, 5, 'blind n_frames = 5 (ALL frames, incl the assisted-rescued B)');
  eq(den.n_skipped, 1, 'blind n_skipped = 1 (C)');
  eq(den.n_attempted, 4, 'blind n_attempted = 4 (5 − 1 skipped): A,B,D,E');
  eq(den.n_solved, 3, 'blind n_solved = 3 (A, D-recovery, E) — B NOT counted');

  const ov = R.blind_lane.overall;
  eq(ov.n_solved, 3, 'overall n_solved 3');
  eq(ov.n_attempted, 4, 'overall n_attempted 4');
  eq(ov.n_failed, 1, 'overall n_failed 1 (B — blind failure that assisted rescued)');
  eq(ov.solve_rate_of_attempted.rate, 0.75, 'blind rate over attempted = 3/4 = 0.75 (B is the failed denominator member)');
  eq(ov.solve_rate_of_all_blind.rate, 0.6, 'blind rate over all = 3/5 = 0.60 (incl skipped)');

  // the CRITICAL denominator invariant: B is a blind FAILURE and an assisted SOLVE
  // simultaneously, and appears in BOTH — never dropped, never pooled.
  eq(R.blind_lane.by_format.CR2.n_attempted, 1, 'CR2 blind attempted = 1 (B stays in the blind denominator)');
  eq(R.blind_lane.by_format.CR2.n_solved, 0, 'CR2 blind solved = 0 (B did NOT solve blind)');
  eq(R.blind_lane.by_format.CR2.solve_rate_of_attempted.rate, 0, 'CR2 blind rate = 0/1 = 0 (NOT undefined, NOT excluded)');

  // splits sum back to the overall denominator (nothing lost, nothing double-counted)
  const sum = (obj, field) => Object.values(obj).reduce((a, c) => a + c[field], 0);
  eq(sum(R.blind_lane.by_format, 'n_frames'), 5, 'by_format n_frames sums to 5');
  eq(sum(R.blind_lane.by_format, 'n_solved'), 3, 'by_format n_solved sums to 3');
  eq(sum(R.blind_lane.by_rig_family, 'n_attempted'), 4, 'by_rig_family n_attempted sums to 4');
  eq(sum(R.blind_lane.by_header_pointing, 'n_solved'), 3, 'by_header_pointing n_solved sums to 3');

  // header-pointing 'unmeasured' is its OWN bucket, never folded into 'absent'
  ok('unmeasured' in R.blind_lane.by_header_pointing, 'header-pointing keeps an unmeasured bucket');
  eq(R.blind_lane.by_header_pointing.unmeasured.n_frames, 1, 'unmeasured = 1 (C, no receipt) — not absent');
  eq(R.blind_lane.by_header_pointing.absent.n_frames, 2, 'absent = 2 (B failed + E pure-blind solve) — receipt present, no ra/dec hint');
  eq(R.blind_lane.by_header_pointing.present.n_frames, 2, 'present = 2 (A + D, both carry ra/dec hint)');
  // E: header pointing absent yet SOLVED (pure blind) — the absent bucket is not all-failures
  eq(R.blind_lane.by_header_pointing.absent.n_solved, 1, 'absent bucket has 1 solve (E, pure blind)');

  // honest-null rate on an empty denominator (a group with 0 attempted)
  // (construct: header-pointing unmeasured group C is skipped → attempted 0)
  eq(R.blind_lane.by_header_pointing.unmeasured.n_attempted, 0, 'unmeasured attempted 0 (C skipped)');
  eq(R.blind_lane.by_header_pointing.unmeasured.solve_rate_of_attempted.rate, null, 'empty-denominator rate is null (honest, not 0)');
  eq(R.blind_lane.by_header_pointing.unmeasured.solve_rate_of_attempted.pct, null, 'empty-denominator pct is null');

  // ── (3) CLASS SEPARATION — assisted NEVER inflates blind ─────────────────────
  // blind numbers must be byte-identical with the assisted deposit present vs absent.
  const loadedNoEnv = loadCorpus({ ...spec, envelopeLedgers: [] });
  const Rno = computeSolveStats(loadedNoEnv);
  eq(stableStringify(Rno.blind_lane), stableStringify(R.blind_lane),
    'blind_lane is byte-identical with vs without the assisted envelope — assisted never leaks into blind');
  eq(Rno.assisted_lane.n_assisted_frames, 0, 'no envelope → assisted lane honestly empty');
  eq(R.assisted_lane.n_assisted_frames, 1, 'with envelope → 1 assisted frame');
  eq(R.assisted_lane.n_assisted_solve_rows, 1, 'one assisted solve row');
  eq(R.assisted_lane.of_which_failed_blind, 1, 'the assisted frame failed blind first');
  eq(R.assisted_lane.by_rig.cocoon_60da, 1, 'assisted rig read from envelope (cocoon_60da)');
  eq(R.assisted_lane.run_labels, ['HINTED-COCOON'], 'assisted run label read from envelope');

  // ── (4) RECOVERY / REGRESSION (kind transitions) ────────────────────────────
  eq(R.recovery_tracking.blind_recoveries.n, 1, 'one blind recovery (D: no_solve→solved via rerun)');
  eq(R.recovery_tracking.blind_recoveries.frames[0].id, 'recD.fits', 'blind recovery is D');
  eq(R.recovery_tracking.blind_recoveries.frames[0].from_outcome, 'no_solve', 'recovery preserved from_outcome no_solve');
  eq(R.recovery_tracking.assisted_recoveries.n, 1, 'one assisted recovery (B)');
  eq(R.recovery_tracking.assisted_recoveries.frames[0].id, 'cr2B.CR2', 'assisted recovery is B');
  eq(R.recovery_tracking.regressions.n, 0, 'no regressions (honest empty)');
  // recovery D is counted as a blind SOLVE in the denominators (not a failure)
  eq(R.blind_lane.by_format.FITS.n_solved, 3, 'FITS blind solved = 3 (A, D-recovery, E)');

  // ── (5) failure taxonomy (over blind non-solved) ────────────────────────────
  eq(R.failure_taxonomy.n_blind_non_solved, 2, 'blind non-solved = 2 (B failed, C skipped)');
  eq(R.failure_taxonomy.n_attempted_failures, 1, 'attempted-failures = 1 (B; C was skipped, not attempted)');
  eq(R.failure_taxonomy.by_class.ladder_exhaustion, 1, 'B classed ladder_exhaustion');
  eq(R.failure_taxonomy.by_class.skipped, 1, 'C classed skipped');
  eq(R.failure_taxonomy.by_stage_of_death.solve, 1, 'stage_of_death extracted from the object (solve) for B');
  eq(R.failure_taxonomy.by_class_x_format.ladder_exhaustion.CR2, 1, 'cross-tab class×format: ladder_exhaustion CR2 = 1');

  // ── (6) distributions over SOLVED frames only ───────────────────────────────
  eq(R.distributions.blind_solved.matched_stars.n, 3, 'matched distribution n = 3 (solved frames only)');
  // solved matched values: A=300, D=120, E=80 → median 120
  eq(R.distributions.blind_solved.matched_stars.median, 120, 'matched median 120 (300,120,80)');
  eq(R.distributions.assisted.matched_stars.n, 1, 'assisted matched distribution n = 1');
  eq(R.distributions.assisted.matched_stars.median, 3171, 'assisted matched median 3171');

  // ── (7) run-label comparison keeps the lanes apart + labels honest ──────────
  const rows = R.run_label_comparison.rows;
  eq(rows[0].lane, 'blind', 'row 0 blind lane');
  eq(rows[1].lane, 'assisted', 'row 1 assisted lane');
  ok(/synthesized/.test(rows[0].label_source), 'blind label flagged synthesized (no run_label in ledgers)');
  ok(/read from envelope/.test(rows[1].label_source), 'assisted label flagged read-from-envelope');
  eq(rows[1].n_solved, 1, 'assisted row solved = 1');

  // ── (8) determinism ─────────────────────────────────────────────────────────
  eq(stableStringify(computeSolveStats(loaded)), stableStringify(R), 'computeSolveStats deterministic (double-run identical)');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nsolve_stats_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
