#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/forensics/failure_dossier_test.mjs — self-test for failure_dossier.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (tools-lane idiom, cf.
// tools/testkit/receipt_diff_test.mjs). Named `*_test.mjs` (underscore) NOT
// `*.test.mjs` (dot) DELIBERATELY — the dot form is swept by vitest and would
// perturb the `npx vitest run` gate. Runs standalone:
//     node tools/forensics/failure_dossier_test.mjs
//
// Hermetic: a throwaway temp dir, torn down at the end. Spawns the REAL CLI
// (child_process) so the exit-code + on-disk contract is exercised end to end,
// and unit-checks pure exports. Synthetic fixtures for EVERY taxonomy class incl.
// locked_but_dropped via BOTH confidence_floor_drop and the [LOCK]+guard-throw
// log path, and the ledger-only (no-receipt) UW timeout join.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { normName, receiptSha, classify, stripAnsi, parseLog, CLASS_HINTS } from './failure_dossier.mjs';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'failure_dossier.mjs');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function has(s, sub, msg) { ok(typeof s === 'string' && s.includes(sub), `${msg}  (got ${JSON.stringify(s)}, want substring ${JSON.stringify(sub)})`); }

// ── fixture builders (shapes mirror stages/package.ts buildFailureReceipt) ────
function failReceipt(over = {}) {
    return {
        version: '2.13.0', kind: 'no_solve',
        failure: { stage_reached: 'solve', stage_of_death: 'solve', reason: 'No geometric lock', error: null },
        frame_sha256: null, source_format: 'FITS', image_width: 1000, image_height: 1000, metadata: null,
        detection: { clean_stars: 120, anomalies: 3, planet_candidates: 0, culling_tally: { saturated: 5, edge: 2 }, background_level: 10.2, noise_floor: 1.1 },
        solve_attempts: { solve_time_ms: 4000, quads_detected: 50, quads_catalog: 200, matches_found: 0, verified_clusters: 0, peak_background_ratio: null, reflection_detected: false, center_lock_verified: false, rejection_reasons: ['No WASM Quad Matches'], branch_timing: { 'solve.quad_wasm': { ms: 900, attempts: 1 } } },
        stage_timings: null,
        pipeline_provenance: { decoder_arm: 'rawler', atlas_id: 'abc123', atlas_version_source: 'test' },
        solution: null, source_provenance: null, warnings: [], timestamp_trusted: true, export_date: '2026-07-12T00:00:00.000Z',
        ...over,
    };
}
function solvedReceipt(over = {}) {
    return { version: '2.13.0', solution: { ra_hours: 1.5, pixel_scale: 3.6, stars_matched: 272 }, source_provenance: null, pipeline_provenance: { decoder_arm: 'rawler', atlas_id: 'abc', atlas_version_source: 'test' }, export_date: 'x', ...over };
}
function ledgerRow(over = {}) {
    return { seq: 1, id: 'frame', path: 'frame', sha: null, format: 'FITS', decoder_arm: 'rawler', wall_ms: 5000, timeout_budget_ms: 120000, outcome: 'no_solve', resolved_outcome: 'no_solve', log: null, receipt: null, error_signature: null, stages: { load: 5, extract: 100 }, ...over };
}
function writeReceipt(dir, name, obj) { fs.writeFileSync(path.join(dir, `${name}.receipt.json`), JSON.stringify(obj, null, 2)); }
function writeLog(dir, name, body) { fs.writeFileSync(path.join(dir, `${name}.log`), body); }
function sha(ch) { return ch.repeat(64); }

function runCli(args) {
    try { return { status: 0, stdout: execFileSync('node', [TOOL, ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { status: e.status ?? -1, stdout: (e.stdout || '') + (e.stderr || '') }; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'failure_dossier_test_'));
try {
    // ───────────────────────────────────────────────────────────────────────
    // (1) Pure-export unit checks
    // ───────────────────────────────────────────────────────────────────────
    eq(normName('DSO_Stacked M 66.receipt.json'), 'dso_stacked_m_66', 'normName strips suffix + normalizes spaces');
    eq(normName('a.fit.log'), 'a.fit', 'normName strips .log');
    eq(receiptSha(failReceipt({ frame_sha256: sha('a') })), sha('a'), 'receiptSha reads frame_sha256');
    eq(receiptSha(failReceipt({ frame_sha256: null, source_provenance: { intake_sha256: sha('b') } })), sha('b'), 'receiptSha falls back to intake_sha256');
    eq(receiptSha(failReceipt({ frame_sha256: null })), null, 'receiptSha honest null when no sha');
    // ANSI strip
    ok(!stripAnsi('\x1b[22m\x1b[39m[LOCK] x').includes('\x1b'), 'stripAnsi removes ESC sequences');
    has(stripAnsi('\x1b[1m[LOCK]\x1b[22m Geometry'), '[LOCK] Geometry', 'stripAnsi keeps text');

    // classify() on synthetic entries (no I/O) — each class + honest basis
    const cNarrow = classify({ receipt: failReceipt(), ledger: ledgerRow() }, null);
    eq(cNarrow.class, 'narrow_fast_fail', 'classify: quad-only FITS no_solve → narrow_fast_fail');
    const cFloor = classify({ receipt: failReceipt({ solve_attempts: { rejection_reasons: ['confidence_floor_drop: verified lock via planar_local at RA 13.5 confidence=0.41 <= 0.5, matches=6 < 8'], branch_timing: {} } }) }, null);
    eq(cFloor.class, 'locked_but_dropped', 'classify: confidence_floor_drop → locked_but_dropped');
    has(cFloor.basis, 'confidence_floor_drop', 'locked_but_dropped basis cites the reason');
    // guard-throw ALONE is NOT enough (fires for every headless no-solve); a real
    // lock signal (log [LOCK]) is required — mirrors the M101/r_mosaic a2 case.
    const cGuard = classify(
        { receipt: failReceipt({ failure: { stage_reached: 'solve', stage_of_death: 'calibrate', reason: null, error: 'Step 4 (Solve) must be complete before calibration.' } }) },
        { markers: { lock: { line: '[LOCK] Geometry Locked via WASM match!', count: 1 } }, guard_throw: true, best_sigma: null, search_exhausted: false });
    eq(cGuard.class, 'locked_but_dropped', 'classify: [LOCK] log + step-5 guard-throw → locked_but_dropped');
    // guard-throw WITHOUT any lock signal must NOT be swallowed as locked (honest)
    const cGuardNoLock = classify({ receipt: failReceipt({ failure: { stage_reached: 'solve', stage_of_death: 'calibrate', reason: null, error: 'Step 4 (Solve) must be complete before calibration.' } }) }, null);
    ok(cGuardNoLock.class !== 'locked_but_dropped', 'classify: guard-throw alone (no lock evidence) is NOT locked_but_dropped');
    const cTimeout = classify({ ledger: ledgerRow({ resolved_outcome: 'honest_timeout', wall_ms: 120200 }) }, null);
    eq(cTimeout.class, 'uw_grind_budget_kill', 'classify: honest_timeout → uw_grind_budget_kill (ledger-only)');
    const cLadder = classify({ receipt: failReceipt({ source_format: 'CR2', solve_attempts: { rejection_reasons: [], branch_timing: { 'solve.uw_escalation': { ms: 5000, attempts: 3 } } } }), ledger: ledgerRow({ format: 'CR2', outcome: 'no_solve', resolved_outcome: 'no_solve' }) }, { search_exhausted: true });
    eq(cLadder.class, 'ladder_exhaustion', 'classify: Search exhausted → ladder_exhaustion');
    const cDecode = classify({ receipt: failReceipt({ detection: null, failure: { stage_reached: 'ingest', stage_of_death: 'ingest', reason: null, error: null } }) }, null);
    eq(cDecode.class, 'decode_fail', 'classify: no detection packet + pre-detection death → decode_fail');
    const cUnknown = classify({ receipt: failReceipt({ solve_attempts: { rejection_reasons: [], branch_timing: {} } }) }, null);
    eq(cUnknown.class, 'unknown', 'classify: no discriminating signal → unknown (never guessed)');
    const cSolved = classify({ ledger: ledgerRow({ resolved_outcome: 'solved' }) }, null);
    eq(cSolved.class, 'solved', 'classify: outcome solved → solved (not a failure)');
    const cSkip = classify({ ledger: ledgerRow({ resolved_outcome: 'skipped_correlated_set' }) }, null);
    eq(cSkip.class, 'skipped', 'classify: skipped_correlated_set → skipped');

    // cited hints — mechanical §3 mapping, no invention
    eq(CLASS_HINTS.narrow_fast_fail.lever, 'matcher', 'narrow_fast_fail lever = matcher');
    has(CLASS_HINTS.narrow_fast_fail.cite, '§3-a1', 'narrow_fast_fail cites §3-a1');
    eq(CLASS_HINTS.ladder_exhaustion.lever, 'matcher', 'ladder_exhaustion lever = matcher (task-specified)');
    has(CLASS_HINTS.locked_but_dropped.cite, '§3-a2', 'locked_but_dropped cites §3-a2');
    eq(CLASS_HINTS.unknown.lever, null, 'unknown carries no lever (honest)');

    // parseLog on a real temp file (bounded read, ANSI strip, σ + markers)
    const logDir0 = path.join(TMP, 'logs0'); fs.mkdirSync(logDir0);
    writeLog(logDir0, 'uw', ['start', '\x1b[22m\x1b[39m[PlateSolver] [PATCH] Ultra-wide field sweep center 3', '\x1b[1m[verifyWCS] anchor best σ≈1.2 (below +5 gate)\x1b[22m', 'grind...'].join('\n'));
    const lp = parseLog(path.join(logDir0, 'uw.log'));
    eq(lp.available, true, 'parseLog available');
    eq(lp.best_sigma.sigma, 1.2, 'parseLog extracts best σ 1.2');
    ok(lp.markers.patch && !lp.markers.patch.line.includes('\x1b'), 'parseLog PATCH marker ANSI-stripped');
    eq(lp.ultra_wide_seen, true, 'parseLog sees ultra-wide');

    // ── bestSigma: verifyWCS-ANCHORED significance, NOT the Vanguard detection
    //    threshold (A8 regression: Crab/andromeda_11h reported best_sigma=6 from
    //    "[SignalProcessor] Vanguard Threshold: … (sigma=6.00)" — a DETECTION cut
    //    level, not a verifyWCS σ; those frames have NO verifyWCS σ line at all). ──
    // (a) Vanguard/Deep-Scan detection thresholds ALONE → honest null (no lock σ).
    const logDirV = path.join(TMP, 'logsV'); fs.mkdirSync(logDirV);
    writeLog(logDirV, 'vanguard', [
        '[SignalProcessor] Vanguard Threshold: 0.0753 (sigma=6.00)',
        '[SignalProcessor] Deep Scan Threshold: 0.0297 (Fixed Sigma: 1.0)',
        '[PlateSolver]   Candidate 0 (quad err 8.69e-9, inferred 2.00"/px) rejected by verifyWCS.',
    ].join('\n'));
    const lpV = parseLog(path.join(logDirV, 'vanguard.log'));
    eq(lpV.best_sigma, null, 'bestSigma: Vanguard (sigma=6.00) detection threshold does NOT parse as verifyWCS σ → null');
    // (b) real FAIL-UW line → the ACHIEVED σ (comma-anchored), never the "Need +5 sigma" gate.
    writeLog(logDirV, 'failuw', [
        '[PlateSolver] verifyWCS FAIL-UW (idx 0): 1 matches vs 1 chance (+0.3 sigma, 1 unique). Need +5 sigma & 12 unique.',
        '[PlateSolver] verifyWCS FAIL-UW (idx 0): 3 matches vs 1 chance (+2.4 sigma, 3 unique). Need +5 sigma & 12 unique.',
    ].join('\n'));
    const lpF = parseLog(path.join(logDirV, 'failuw.log'));
    eq(lpF.best_sigma.sigma, 2.4, 'bestSigma: FAIL-UW reports max ACHIEVED σ 2.4 (not the +5 gate)');
    // (c) the exact defect combo — Vanguard sigma=6.00 AND a real +2.4 FAIL-UW → 2.4, never 6.
    writeLog(logDirV, 'combo', [
        '[SignalProcessor] Vanguard Threshold: 0.0443 (sigma=6.00)',
        '[PlateSolver] verifyWCS FAIL-UW (idx 0): 3 matches vs 1 chance (+2.4 sigma, 3 unique). Need +5 sigma & 12 unique.',
    ].join('\n'));
    eq(parseLog(path.join(logDirV, 'combo.log')).best_sigma.sigma, 2.4, 'bestSigma: Vanguard σ=6 ignored when a real verifyWCS σ is present → 2.4');

    // ───────────────────────────────────────────────────────────────────────
    // (2) End-to-end CLI: one frame per taxonomy class → summary + dossiers
    // ───────────────────────────────────────────────────────────────────────
    const R = path.join(TMP, 'receipts'); const L = path.join(TMP, 'logs'); const OUT = path.join(TMP, 'out');
    fs.mkdirSync(R); fs.mkdirSync(L);

    // narrow_fast_fail (sha-keyed join)
    writeReceipt(R, 'narrow', failReceipt({ frame_sha256: sha('a') }));
    // locked_but_dropped via confidence_floor_drop (no log)
    writeReceipt(R, 'floordrop', failReceipt({ frame_sha256: sha('b'), solve_attempts: { rejection_reasons: ['confidence_floor_drop: verified lock via planar_local confidence=0.41 <= 0.5, matches=6 < 8'], branch_timing: { 'solve.quad_wasm': { ms: 800, attempts: 1 } } } }));
    // locked_but_dropped via [LOCK]+guard-throw LOG (receipt error=null → log drives it)
    writeReceipt(R, 'guardthrow', failReceipt({ frame_sha256: sha('c'), failure: { stage_reached: 'solve', stage_of_death: 'calibrate', reason: null, error: null } }));
    writeLog(L, 'guardthrow', ['\x1b[22m\x1b[39m[PlateSolver] [VERIFIED] Sky fingerprint verified: 12180 stars matched around origin (confidence: 100.0%).', '\x1b[1m[PlateSolver] [LOCK] Geometry Locked via WASM match!\x1b[22m', 'Error: Step 4 (Solve) must be complete before calibration.'].join('\n'));
    // ladder_exhaustion (CR2 + log Search exhausted)
    writeReceipt(R, 'ladder', failReceipt({ frame_sha256: sha('d'), source_format: 'CR2', solve_attempts: { rejection_reasons: [], branch_timing: { 'solve.uw_escalation': { ms: 5000, attempts: 3 } } } }));
    writeLog(L, 'ladder', 'grind\n[PlateSolver] Search exhausted after 6 escalations\n');
    // decode_fail (no detection packet, pre-detection death)
    writeReceipt(R, 'decode', failReceipt({ frame_sha256: sha('e'), detection: null, failure: { stage_reached: 'ingest', stage_of_death: 'ingest', reason: 'decode failed', error: null } }));
    // unknown (no signal)
    writeReceipt(R, 'unknownframe', failReceipt({ frame_sha256: sha('f'), solve_attempts: { rejection_reasons: [], branch_timing: {} } }));
    // solved receipt
    writeReceipt(R, 'solvedframe', solvedReceipt({ source_provenance: { intake_sha256: sha('9') } }));

    // ledger: sha-keyed rows for the above + a LEDGER-ONLY uw timeout + a skipped
    const ledgerRows = [
        ledgerRow({ id: 'narrow', sha: sha('a'), wall_ms: 4200 }),
        ledgerRow({ id: 'floordrop', sha: sha('b') }),
        ledgerRow({ id: 'guardthrow', sha: sha('c'), error_signature: 'guard-throw (no blind lock → calibration precondition)' }),
        ledgerRow({ id: 'ladder', sha: sha('d'), format: 'CR2', timeout_budget_ms: 300000, wall_ms: 150000 }),
        ledgerRow({ id: 'decode', sha: sha('e') }),
        ledgerRow({ id: 'unknownframe', sha: sha('f') }),
        ledgerRow({ id: 'solvedframe', sha: sha('9'), resolved_outcome: 'solved', outcome: 'solved' }),
        // ledger-ONLY UW timeout: no receipt, decoder_arm must fall back to ledger (guessed), best σ from log
        ledgerRow({ id: 'uwtimeout', sha: sha('7'), resolved_outcome: 'honest_timeout', outcome: 'honest_timeout', wall_ms: 120200, timeout_budget_ms: 120000, decoder_arm: 'rawler', log: 'uwtimeout.log' }),
        // ledger-only skipped
        ledgerRow({ id: 'skipframe', sha: sha('8'), resolved_outcome: 'skipped_correlated_set', outcome: 'skipped_correlated_set' }),
    ];
    const ledgerPath = path.join(TMP, 'ledger_resolved.jsonl');
    fs.writeFileSync(ledgerPath, ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    // uw timeout log (σ 1.2, ultra-wide) — joined by name to the ledger-only frame
    writeLog(L, 'uwtimeout', ['\x1b[22m[PlateSolver] [PATCH] Ultra-wide field sweep', '[verifyWCS] best anchor σ≈1.2 (below +5 gate)', 'killed at wall'].join('\n'));

    const cli = runCli(['--receipts', R, '--logs', L, '--ledger', ledgerPath, '--out', OUT]);
    eq(cli.status, 0, 'CLI exit 0 on a clean run');
    const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));

    // taxonomy counts (one per class)
    eq(summary.taxonomy_counts.narrow_fast_fail, 1, 'count narrow_fast_fail');
    eq(summary.taxonomy_counts.locked_but_dropped, 2, 'count locked_but_dropped (floordrop + guardthrow)');
    eq(summary.taxonomy_counts.uw_grind_budget_kill, 1, 'count uw_grind_budget_kill');
    eq(summary.taxonomy_counts.ladder_exhaustion, 1, 'count ladder_exhaustion');
    eq(summary.taxonomy_counts.decode_fail, 1, 'count decode_fail');
    eq(summary.taxonomy_counts.unknown, 1, 'count unknown');
    eq(summary.taxonomy_counts.solved, 1, 'count solved');
    eq(summary.taxonomy_counts.skipped, 1, 'count skipped');
    eq(summary.n_frames, 9, 'n_frames = 9 (7 receipts + 2 ledger-only)');

    // per-frame dossier reads
    const dossierDir = path.join(OUT, 'dossiers');
    const readDoss = (name) => JSON.parse(fs.readFileSync(path.join(dossierDir, `${name}.dossier.json`), 'utf8'));

    const dNarrow = readDoss('narrow');
    eq(dNarrow.key_mode, 'sha', 'narrow keyed by sha');
    eq(dNarrow.sources_joined.receipt && dNarrow.sources_joined.ledger, true, 'narrow joined receipt+ledger by sha');
    has(dNarrow.decoder_arm_source, 'READ', 'narrow decoder_arm READ from receipt');
    eq(dNarrow.decoder_arm, 'rawler', 'narrow decoder_arm value');
    eq(dNarrow.detection.clean_stars, 120, 'narrow detection.clean_stars surfaced');
    eq(dNarrow.detection.culling_tally.saturated, 5, 'narrow culling_tally surfaced');
    ok(Array.isArray(dNarrow.solve_attempts.branches_attempted), 'narrow branches_attempted listed');

    const dGuard = readDoss('guardthrow');
    eq(dGuard.taxonomy.class, 'locked_but_dropped', 'guardthrow classifies locked_but_dropped');
    has(dGuard.taxonomy.basis, 'locked-but-no-solution', 'guardthrow basis names locked-but-no-solution (§3-a2)');
    ok(dGuard.log.markers.lock && !dGuard.log.markers.lock.line.includes('\x1b'), 'guardthrow log LOCK marker joined + ANSI-stripped');
    eq(dGuard.log.stars_matched_log, 12180, 'guardthrow reads [VERIFIED] stars_matched from log');
    eq(dGuard.log.guard_throw, true, 'guardthrow log guard_throw flag');

    const dUw = readDoss('uwtimeout');
    eq(dUw.sources_joined.receipt, false, 'uwtimeout has NO receipt');
    eq(dUw.sources_joined.ledger && dUw.sources_joined.log, true, 'uwtimeout joined ledger+log');
    eq(dUw.taxonomy.class, 'uw_grind_budget_kill', 'uwtimeout → uw_grind_budget_kill');
    has(dUw.decoder_arm_source, 'GUESSED', 'uwtimeout decoder_arm falls back to ledger (GUESSED, labelled)');
    eq(dUw.best_sigma_reached.sigma, 1.2, 'uwtimeout best σ 1.2 read from log');
    has(dUw.detection.note, 'NOT MEASURED', 'uwtimeout detection honest NOT MEASURED (no receipt)');

    const dUnknown = readDoss('unknownframe');
    eq(dUnknown.taxonomy.class, 'unknown', 'unknownframe → unknown');
    eq(dUnknown.best_sigma_reached.sigma, null, 'unknownframe best σ honest null (no log)');

    // aggregate hints present + cited, only for failure classes, none for solved/skipped
    has(summary.class_hints.narrow_fast_fail.cite, '§3-a1', 'summary narrow hint cites §3-a1');
    eq(summary.class_hints.narrow_fast_fail.lever, 'matcher', 'summary narrow lever matcher');
    ok(!summary.class_hints.solved && !summary.class_hints.skipped, 'no lever hint for solved/skipped');
    eq(summary.decoder_arm.read_from_receipt >= 7, true, 'decoder_arm read_from_receipt counted');
    eq(summary.decoder_arm.guessed_from_ledger >= 1, true, 'decoder_arm guessed_from_ledger counted (uwtimeout)');

    // ───────────────────────────────────────────────────────────────────────
    // (3) filename-fallback join (no sha on either side)
    // ───────────────────────────────────────────────────────────────────────
    const R2 = path.join(TMP, 'r2'); const OUT2 = path.join(TMP, 'out2'); fs.mkdirSync(R2);
    writeReceipt(R2, 'noshaframe', failReceipt({ frame_sha256: null }));
    const led2 = path.join(TMP, 'led2.jsonl');
    fs.writeFileSync(led2, JSON.stringify(ledgerRow({ id: 'noshaframe', sha: null, wall_ms: 7777 })) + '\n');
    eq(runCli(['--receipts', R2, '--ledger', led2, '--out', OUT2]).status, 0, 'filename-fallback run exit 0');
    const dNo = JSON.parse(fs.readFileSync(path.join(OUT2, 'dossiers', 'noshaframe.dossier.json'), 'utf8'));
    eq(dNo.key_mode, 'filename', 'no-sha frame keyed by filename');
    eq(dNo.sources_joined.receipt && dNo.sources_joined.ledger, true, 'no-sha receipt+ledger joined by name');
    eq(dNo.wall_ms, 7777, 'no-sha frame picked up ledger wall_ms via name join');

    // ───────────────────────────────────────────────────────────────────────
    // (4) usage / IO exit-2 paths
    // ───────────────────────────────────────────────────────────────────────
    eq(runCli(['--receipts', R]).status, 2, 'missing --out → exit 2');
    eq(runCli(['--out', OUT]).status, 2, 'no source (--receipts/--ledger) → exit 2');
    eq(runCli(['--receipts', path.join(TMP, 'nope'), '--out', OUT]).status, 2, 'missing receipts dir → exit 2');
    eq(runCli(['--bogus']).status, 2, 'unknown arg → exit 2');
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nfailure_dossier self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
