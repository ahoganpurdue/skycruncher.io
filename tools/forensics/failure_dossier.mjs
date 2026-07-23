#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/forensics/failure_dossier.mjs — per-frame failure-forensics join
// (TEST_SUITE_PLAN.md §5 Stage 11, tools-lane half; owner's analytics-plane
// directive: "127 frames fail, all with solid center matches, failing on the
// edges by this amount — tells us a hell of a lot").
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: turn a FAILED frame into information. JOIN, per frame:
//   • the honest NO-SOLVE failure receipt (primary — stages/package.ts:378
//     buildFailureReceipt: kind:'no_solve', failure{stage_of_death}, detection
//     {culling_tally…}, solve_attempts{rejection_reasons,branch_timing},
//     pipeline_provenance{decoder_arm}).
//   • the population / re-run ledger row (wall_ms, resolved_outcome,
//     decoder_arm-GUESSED, log path) — keyed by content sha, id fallback.
//   • an optional BOUNDED log tail-parse (last [PATCH]/[DROP]/[LOCK]/[VERIFIED]/
//     verifyWCS σ lines) — never a whole-file ingest of the 25k-line logs.
// …and emit a per-frame dossier JSON + an aggregate summary with an evidence-
// derived TAXONOMY class per frame and a cited "what would flip this class" hint.
//
// HONEST-OR-ABSENT (LAW 3): every field is a MEASURED value one of the three
// sources already produced, or an explicit null / "NOT MEASURED" / class
// 'unknown' with a stated basis. NOTHING is fabricated. `decoder_arm` is READ
// from receipt.pipeline_provenance (honest) — NEVER guessed; the ledger's own
// decoder_arm is format-guessed (TEST_SUITE_PLAN §4-b2) so it is only a labelled
// fallback when no receipt exists. Ledger: NEITHER (pure read + join).
//
// KEYING (frame identity, mirrors tools/testkit/receipt_diff.mjs):
//   Primary  — content sha256: receipt.frame_sha256 (package.ts:419) ↔ ledger
//              row `sha`. Falls back to receipt.source_provenance.intake_sha256.
//   Fallback — normalized frame NAME (receipt filename stem / ledger `id` / log
//              stem, spaces→'_', lowercased) so sha-less sources still join.
//   Logs carry no sha → matched by name (or the ledger row's `log` basename).
//
// TAXONOMY (evidence-derived, priority-ordered; honest 'unknown' when signals
//   are absent — the driving signal is recorded in dossier.taxonomy.basis):
//     decode_fail | locked_but_dropped | uw_grind_budget_kill |
//     ladder_exhaustion | narrow_fast_fail | unknown   (+ solved / skipped:
//     not failures — reported, no lever hint).
//
// Usage:
//   node tools/forensics/failure_dossier.mjs --receipts <dir> [--logs <dir>] \
//        [--ledger <ledger_resolved.jsonl>] --out <dir>
// EXIT: 0 = dossiers written · 2 = usage / IO error (bad args, missing dir).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAIL_BYTES = 131072;   // bounded log read — last 128 KiB, never the whole file
const CAP = 240;             // per-string render cap (chars)
const NM = 'NOT MEASURED';   // honest-absent sentinel for numeric fields

// ── CLI parse ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = { receipts: null, logs: null, ledger: null, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--receipts') opts.receipts = argv[++i];
        else if (a === '--logs') opts.logs = argv[++i];
        else if (a === '--ledger') opts.ledger = argv[++i];
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--help' || a === '-h') opts.help = true;
        else return { error: `unknown argument: ${a}` };
    }
    return { opts };
}

class IoError extends Error {}

// ── small honest helpers ─────────────────────────────────────────────────────
function str(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : null; }
function cap(s, n = CAP) { return (typeof s === 'string' && s.length > n) ? s.slice(0, n) + '…' : s; }
function normName(name) {
    return String(name || '')
        .replace(/\.receipt\.json$/i, '').replace(/\.json$/i, '').replace(/\.log$/i, '')
        .replace(/\s+/g, '_').toLowerCase();
}
function safeFile(name) {
    const s = String(name || 'frame').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (s || 'frame').slice(0, 120);
}

// ── frame identity ───────────────────────────────────────────────────────────
function receiptSha(r) {
    const direct = str(r && r.frame_sha256);
    if (direct) return direct;
    const sp = r && r.source_provenance;
    return (sp && typeof sp === 'object') ? str(sp.intake_sha256) : null;
}
function isFailureReceipt(r) {
    return !!r && (r.kind === 'no_solve' || r.solution === null || r.solution === undefined);
}

// ── frame register: merge sources by sha (strong) then normalized name ────────
function makeRegistry() {
    const bySha = new Map();   // sha -> entry
    const byName = new Map();  // normName -> entry
    const entries = [];
    function entryFor(sha, name) {
        const nn = name ? normName(name) : null;
        let e = (sha && bySha.get(sha)) || (nn && byName.get(nn)) || null;
        if (!e) {
            e = { sha: sha || null, name: name || null, receipt: null, receipt_file: null, ledger: null, log_path: null, sources: [] };
            entries.push(e);
        }
        if (sha && !e.sha) e.sha = sha;
        if (name && !e.name) e.name = name;
        if (e.sha) bySha.set(e.sha, e);
        if (e.name) byName.set(normName(e.name), e);
        if (nn && !byName.has(nn)) byName.set(nn, e);
        return e;
    }
    return { entryFor, entries };
}

// ── receipt load ─────────────────────────────────────────────────────────────
function loadReceipts(dir, reg) {
    let stat;
    try { stat = fs.statSync(dir); } catch { throw new IoError(`--receipts directory not found: ${dir}`); }
    if (!stat.isDirectory()) throw new IoError(`--receipts is not a directory: ${dir}`);
    let n = 0;
    for (const f of fs.readdirSync(dir).filter(x => /\.json$/i.test(x)).sort()) {
        const full = path.join(dir, f);
        let receipt;
        try { receipt = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch (e) { throw new IoError(`cannot parse receipt ${f}: ${e.message}`); }
        const sha = receiptSha(receipt);
        const name = f.replace(/\.receipt\.json$/i, '').replace(/\.json$/i, '');
        const e = reg.entryFor(sha, name);
        e.receipt = receipt; e.receipt_file = f; e.sources.push('receipt');
        n++;
    }
    return n;
}

// ── ledger load (jsonl) ──────────────────────────────────────────────────────
function loadLedger(file, reg) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { throw new IoError(`--ledger file not found: ${file}`); }
    let n = 0;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let row;
        try { row = JSON.parse(t); } catch (e) { throw new IoError(`cannot parse ledger row: ${e.message}`); }
        const sha = str(row.sha);
        const name = str(row.id) || str(row.path);
        const e = reg.entryFor(sha, name);
        // Do not clobber a richer row already attached to this frame.
        if (!e.ledger) { e.ledger = row; e.sources.push('ledger'); }
        n++;
    }
    return n;
}

// ── log attach (by name; ledger.log basename honored) ─────────────────────────
function attachLogs(dir, reg) {
    let names = [];
    if (dir) {
        let stat;
        try { stat = fs.statSync(dir); } catch { throw new IoError(`--logs directory not found: ${dir}`); }
        if (!stat.isDirectory()) throw new IoError(`--logs is not a directory: ${dir}`);
        names = fs.readdirSync(dir).filter(x => /\.log$/i.test(x));
    }
    const byNorm = new Map();
    for (const f of names) byNorm.set(normName(f), path.join(dir, f));
    let n = 0;
    for (const e of reg.entries) {
        // Prefer the ledger row's explicit log path if it resolves.
        const cand = [];
        if (e.ledger && str(e.ledger.log)) {
            const base = path.basename(e.ledger.log);
            if (dir) cand.push(byNorm.get(normName(base)));
        }
        if (e.name) cand.push(byNorm.get(normName(e.name)));
        if (e.receipt_file) cand.push(byNorm.get(normName(e.receipt_file)));
        const hit = cand.find(Boolean);
        if (hit) { e.log_path = hit; e.sources.push('log'); n++; }
    }
    return n;
}

// ── bounded log tail parse ────────────────────────────────────────────────────
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, ''); }
function readTail(file) {
    const size = fs.statSync(file).size;
    const N = Math.min(TAIL_BYTES, size);
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(N);
        fs.readSync(fd, buf, 0, N, size - N);
        return { text: buf.toString('utf8'), bytes_read: N, truncated: size > N, size };
    } finally { fs.closeSync(fd); }
}
function lastMatch(lines, re) {
    let last = null, count = 0;
    for (const l of lines) if (re.test(l)) { last = l; count++; }
    return last === null ? null : { line: cap(last), count };
}
// Best (highest) verifyWCS SIGNIFICANCE the log reports — how close a real solve
// verification got to the +5σ lock gate. Two look-alike log-line families exist;
// only verifyWCS lines are significance, so we ANCHOR on the verifyWCS token first
// (A8 fix, 2026-07-11: the un-anchored regex read the DETECTION-threshold σ and
// mis-reported best_sigma=6 on Crab/andromeda_11h, which have NO verifyWCS σ line):
//   (A) REAL verifyWCS significance — the achieved value we want. The PlateSolver
//       logs it on every rejected verify attempt, e.g.:
//         [PlateSolver] verifyWCS FAIL-UW (idx 0): 3 matches vs 1 chance
//                       (+2.4 sigma, 3 unique). Need +5 sigma & 12 unique.
//       The ACHIEVED σ PRECEDES the word "sigma" and is FOLLOWED BY A COMMA
//       ("(+2.4 sigma,"). The trailing "Need +5 sigma & 12 unique" is the GATE
//       (followed by " &", never a comma) — the comma anchor structurally excludes
//       it. A synthetic Greek "σ≈1.2" form (self-test fixtures) is also honored,
//       but still only on a verifyWCS line.
//   (B) FALSE match — the SignalProcessor Vanguard / Deep-Scan DETECTION threshold:
//         [SignalProcessor] Vanguard Threshold: 0.0753 (sigma=6.00)
//       An extraction CUT LEVEL (the number FOLLOWS "sigma": "sigma=6.00"), NOT a
//       solve significance, and NOT on a verifyWCS line — this is precisely the
//       line that made Crab/andromeda_11h (zero verifyWCS σ) report best_sigma=6.
//   Other Greek-σ solve-adjacent lines ([UW-ESCALATE] "excess ±Nσ", [DeepConfirm]
//   "setExcessZ Nσ vs gate Nσ", [UW-SWEEP] "peak +Nσ", [HotPixelMap] "Nσ spike")
//   are NOT verifyWCS significance and are excluded by the verifyWCS anchor.
// HONEST ABSENCE: no verifyWCS significance line ⇒ null (never a look-alike).
function bestSigma(lines) {
    // Achieved-σ tokens, tried in order (first hit per line wins):
    //   [0] real FAIL-UW: number BEFORE "sigma" and COMMA-trailed ("(+2.4 sigma,")
    //       so the "Need +5 sigma &" gate can never match.
    //   [1] synthetic Greek "σ≈N" form used by the self-test fixtures.
    const pats = [
        /([+-]?[0-9]+(?:\.[0-9]+)?)\s*sigma\s*,/i,
        /σ\s*[≈~=]?\s*([+-]?[0-9]+(?:\.[0-9]+)?)/,
    ];
    let best = null, src = null;
    for (const l of lines) {
        if (!/verifyWCS/i.test(l)) continue;   // significance lives ONLY on verifyWCS lines
        for (const re of pats) {
            const m = l.match(re);
            if (m) { const v = parseFloat(m[1]); if (Number.isFinite(v) && (best === null || v > best)) { best = v; src = cap(l); } break; }
        }
    }
    return best === null ? null : { sigma: best, source_line: src };
}
function parseLog(file) {
    let raw;
    try { raw = readTail(file); } catch (e) { return { available: false, reason: `read failed: ${e.message}` }; }
    const lines = stripAnsi(raw.text).split('\n').map(l => l.trimEnd()).filter(Boolean);
    const verified = lastMatch(lines, /\[VERIFIED\]/);
    let stars_matched_log = null;
    if (verified) { const m = verified.line.match(/verified:\s*([0-9]+)\s*stars?\s*matched/i); if (m) stars_matched_log = parseInt(m[1], 10); }
    return {
        available: true,
        bytes_read: raw.bytes_read,
        tail_truncated: raw.truncated,
        log_size_bytes: raw.size,
        markers: {
            patch: lastMatch(lines, /\[PATCH\]/),
            drop: lastMatch(lines, /\[DROP\]/),
            lock: lastMatch(lines, /\[LOCK\]/),
            verified,
            verify_wcs: lastMatch(lines, /verifyWCS/i),
        },
        stars_matched_log,
        best_sigma: bestSigma(lines),
        guard_throw: /must be complete before calibration/i.test(raw.text),
        search_exhausted: /search exhausted/i.test(raw.text),
        ultra_wide_seen: /ultra-wide/i.test(raw.text) || /\[PATCH\][^\n]*ultra/i.test(raw.text),
    };
}

// ── taxonomy classifier (priority-ordered, cites the driving signal) ──────────
function classify(e, log) {
    const r = e.receipt || null;
    const led = e.ledger || null;
    const outcome = (led && (str(led.resolved_outcome) || str(led.outcome)))
        || (r ? 'no_solve' : null);
    const fmt = (r && str(r.source_format)) || (led && str(led.format)) || null;
    const sa = r && r.solve_attempts;
    const reasons = (sa && Array.isArray(sa.rejection_reasons)) ? sa.rejection_reasons : [];
    const bt = (sa && sa.branch_timing && typeof sa.branch_timing === 'object') ? sa.branch_timing : {};
    const hasUW = !!(bt['solve.uw_sweep'] || bt['solve.uw_escalation']);
    const hasQuadOnly = !!bt['solve.quad_wasm'] && !hasUW;
    const failErr = r && r.failure ? str(r.failure.error) : null;
    const errSig = led ? str(led.error_signature) : null;
    const detection = r ? r.detection : undefined; // null = extraction produced none; undefined = no receipt
    const wall = led && Number.isFinite(led.wall_ms) ? led.wall_ms : null;
    const budget = led && Number.isFinite(led.timeout_budget_ms) ? led.timeout_budget_ms : null;
    const floorDrop = reasons.find(x => /^confidence_floor_drop/i.test(String(x)));
    const guardThrow = !!(log && log.guard_throw)
        || /must be complete before calibration/i.test(failErr || '')
        || /guard-throw|blind lock|calibration precondition/i.test(errSig || '');
    const lockSeen = !!(log && log.markers && log.markers.lock);
    const searchExhausted = !!(log && log.search_exhausted)
        || reasons.some(x => /exhaust/i.test(String(x)))
        || /exhaust/i.test(errSig || '');

    const set = (cls, basis) => ({ class: cls, basis });

    // (0) not-a-failure: reported for completeness, no lever hint.
    if (outcome === 'skipped_correlated_set' || outcome === 'skipped_too_large')
        return { ...set('skipped', `ledger outcome=${outcome}`), signals: { outcome } };
    if (outcome === 'solved' || (r && r.solution && typeof r.solution === 'object'))
        return { ...set('solved', 'solved receipt / ledger outcome=solved — not a failure'), signals: { outcome } };

    const signals = {
        outcome, source_format: fmt, has_uw_branch: hasUW, has_quad_branch: !!bt['solve.quad_wasm'],
        rejection_reasons_head: reasons.slice(0, 4).map(x => cap(String(x), 120)),
        detection_present: detection == null ? false : true,
        guard_throw: guardThrow, lock_seen: lockSeen, search_exhausted: searchExhausted,
        best_sigma: log && log.best_sigma ? log.best_sigma.sigma : null,
        wall_ms: wall, timeout_budget_ms: budget,
    };
    const S = (cls, basis) => ({ class: cls, basis, signals });

    // (1) decode_fail — extraction never produced a detection packet, or a decode error.
    const decodeErr = /decode|OOM|out of memory|readFileSync|ENOMEM|too large|corrupt|magic/i;
    const preDetectionDeath = r && r.failure && !/detect|solve|match|calibrat/i.test(str(r.failure.stage_reached) || '');
    if ((detection === null && preDetectionDeath) || decodeErr.test(failErr || '') || decodeErr.test(errSig || ''))
        return S('decode_fail', detection === null
            ? `no detection packet + stage_reached='${r.failure.stage_reached}' (death before detection)`
            : `decode/ingest error signature: ${cap(failErr || errSig, 120)}`);

    // (2) locked_but_dropped — geometry LOCKED/verified but no solution banked
    //     (confidence-floor drop, or the §3-a2 locked-but-no-solution defect). The
    //     step-5 calibration guard-throw ALONE is NOT a distinguisher — it fires for
    //     EVERY headless no-solve (§4-b1), and the ledger's own error_signature says
    //     "no blind lock" even on the M101 case that WASM-locked — so we require an
    //     actual lock signal (log [LOCK] / receipt center_lock_verified), never the
    //     guard-throw by itself.
    if (floorDrop)
        return S('locked_but_dropped', `rejection_reasons: ${cap(String(floorDrop), 160)}`);
    const lockEvidence =
        lockSeen ? 'log [LOCK] geometry-lock marker'
        : /\[LOCK\]|geometry locked/i.test(failErr || '') ? 'receipt failure.error names a geometry lock'
        : (r && r.solve_attempts && r.solve_attempts.center_lock_verified === true) ? 'receipt solve_attempts.center_lock_verified=true'
        : null;
    if (lockEvidence)
        return S('locked_but_dropped', `locked-but-no-solution (§3-a2): ${lockEvidence}, but no solution banked${guardThrow ? ' (step-5 calibration guard-throw)' : ''}`);

    // (3) uw_grind_budget_kill — UW sweep never locks, killed at the wall.
    if (outcome === 'honest_timeout')
        return S('uw_grind_budget_kill', `honest_timeout${wall != null ? ` at ${wall}ms` : ''}${budget != null ? `/${budget}ms budget` : ''}`);
    if (hasUW && (Number.isFinite(bt['solve.uw_sweep']?.attempts) || Number.isFinite(bt['solve.uw_escalation']?.attempts))
        && !lockSeen && budget != null && wall != null && wall >= 0.8 * budget)
        return S('uw_grind_budget_kill', `ultra-wide sweep, no lock, wall ${wall}ms ≥ 0.8×budget ${budget}ms`);

    // (4) ladder_exhaustion — search/escalation budget exhausted, self-terminates under budget.
    if (searchExhausted)
        return S('ladder_exhaustion', 'log/rejection: "Search exhausted" / escalation budget exhausted, self-terminated under budget');
    if (fmt && /CR2|NEF|ARW|RAW|DNG/i.test(fmt) && outcome === 'no_solve' && (hasUW || bt['solve.uw_escalation']))
        return S('ladder_exhaustion', 'CR2/RAW no_solve: escalation ladder exhausted under budget (UW branch attempted, no lock)');

    // (5) narrow_fast_fail — quad-only path, verifyWCS never clears +5σ, fast self-terminate.
    if (hasQuadOnly && outcome === 'no_solve')
        return S('narrow_fast_fail', `quad-only path (no UW sweep), no lock, fast self-terminate${wall != null ? ` (${wall}ms)` : ''}${reasons.length ? `; reasons: ${cap(String(reasons[0]), 100)}` : ''}`);

    // (6) unknown — no discriminating signal. NEVER guessed.
    return S('unknown', 'insufficient discriminating signal (receipt/log absent or markers ambiguous) — enrich the join before mapping a lever');
}

// ── cited "what would flip this class" hints — mechanical §3 mapping, no invention ──
const CLASS_HINTS = {
    narrow_fast_fail: { lever: 'matcher', cite: 'TEST_SUITE_PLAN §3-a1 → §5 Stage 4 (matcher diagnostic ladder); FITS stack/mosaic subclass §3-a5',
        hint: 'Pre-lock quad/RANSAC matching failure — verifyWCS never clears +5σ. Attack the MATCHER (pairwise-Hough / photometric-rank quad correspondence / stellarity-weighted seeds), not more search priors (the hinter family is a closed lever, §3-a1).' },
    uw_grind_budget_kill: { lever: 'prior/hint + σ-plateau early-abort', cite: 'TEST_SUITE_PLAN §3-a4 (UW barrel + budget-wall + σ-plateau early-abort) + §3-a5 (FL→scale-seed routing) → §5 Stage 7',
        hint: 'Ultra-wide barrel distortion keeps true quads out of the quad-hash; the FITS-UW lane relies on the budget wall to stop. A correct FL/pointing PRIOR reaching the blind sweep (rig3 Cocoon solved when hinted) plus a σ-plateau / anchors-exhausted early-abort reclaims the dead grind. Solve-path change — owner sign-off, own evidence receipt.' },
    ladder_exhaustion: { lever: 'matcher', cite: 'TEST_SUITE_PLAN §3-a1 (matcher) + §3-a3 (single-sub physics limit) → §5 Stage 4 / Stage 6',
        hint: 'CR2 escalation ladder exhausts search under budget. Same root as narrow_fast_fail — attack the matcher (Stage 4). Physics-limited single-subs (5D3 24mm sub-pixel PSF; bias-only "lights") need darks+stack instead — no solver trick recovers absent flux (§3-a3).' },
    locked_but_dropped: { lever: 'correctness fix (not harvest)', cite: 'TEST_SUITE_PLAN §3-a2 → §5 Stage 3; solver_entry.ts:677 confidence_floor_drop; orchestrator_session.ts:989-990 guard-throw',
        hint: 'Frame LOCKED geometry then dropped the verified lock below the confidence/match floor, or died on the step-5 calibration guard-throw with solution=null. Harvest only CLASSIFIES this — the FIX is the Stage-3 root-cause, independent of any matcher/recall work.' },
    decode_fail: { lever: 'decode/ingest (outside §3 solve levers)', cite: 'TEST_SUITE_PLAN §1 (zero decode failures in the 2026-07-11 population) + §4-b8 (streaming-ingest gap)',
        hint: 'Frame produced no detection packet — decode/extraction failed before the solver ran. NOTE: the population had ZERO decode failures (rawler decoded all 45 CR2 + 52 FITS); the 2 GiB readFileSync streaming-ingest limit (§4-b8) is the one known ingest gap.' },
    unknown: { lever: null, cite: 'TEST_SUITE_PLAN §4-b1/b2 (guard-throw banks no receipt; runner loses stage-of-death)',
        hint: 'Insufficient discriminating signal. Enrich the join (bank the failure receipt via task #16, retain the log tail) before mapping a lever — do NOT guess.' },
};

// ── per-frame dossier assembly ────────────────────────────────────────────────
function buildDossier(e, log, taxonomy) {
    const r = e.receipt || null;
    const led = e.ledger || null;
    const sa = r && r.solve_attempts;
    const bt = (sa && sa.branch_timing && typeof sa.branch_timing === 'object') ? sa.branch_timing : null;

    // decoder_arm — READ from receipt.pipeline_provenance (honest), NEVER guessed.
    // Ledger's own decoder_arm is format-guessed (§4-b2) → labelled fallback only.
    let decoder_arm = null, decoder_arm_source = `${NM} — no receipt or ledger`;
    if (r && r.pipeline_provenance && ('decoder_arm' in r.pipeline_provenance)) {
        decoder_arm = r.pipeline_provenance.decoder_arm;
        decoder_arm_source = 'receipt.pipeline_provenance.decoder_arm (READ from decode arm)';
    } else if (led && ('decoder_arm' in led)) {
        decoder_arm = str(led.decoder_arm);
        decoder_arm_source = 'ledger.decoder_arm (GUESSED from format — TEST_SUITE_PLAN §4-b2; no receipt to read the true arm)';
    }

    // detection — what the detector saw (counts + culling tally). NOT MEASURED w/o receipt.
    const detection = r ? (r.detection ?? { note: `${NM} — extraction produced no signal packet` }) : { note: `${NM} — no failure receipt (receipt: ${led ? str(led.receipt) || 'absent' : 'absent'})` };

    // anchors / strategies attempted.
    const solve_attempts = sa ? {
        solve_time_ms: sa.solve_time_ms ?? null,
        quads_detected: sa.quads_detected ?? null,
        quads_catalog: sa.quads_catalog ?? null,
        matches_found: sa.matches_found ?? null,
        verified_clusters: sa.verified_clusters ?? null,
        center_lock_verified: sa.center_lock_verified ?? null,
        rejection_reasons: Array.isArray(sa.rejection_reasons) ? sa.rejection_reasons : [],
        branches_attempted: bt ? Object.entries(bt).map(([k, v]) => ({ branch: k, ms: v?.ms ?? null, attempts: v?.attempts ?? null })) : null,
    } : { note: `${NM} — solve ladder produced no diagnostics` };

    // best σ reached — log-only measurement; honest null when no log.
    const best_sigma_reached = log && log.best_sigma
        ? { sigma: log.best_sigma.sigma, threshold_ref: '+5σ verifyWCS gate', source: 'log tail', source_line: log.best_sigma.source_line }
        : { sigma: null, note: log ? `${NM} — no σ line in log tail` : `${NM} — no log joined` };

    // stage timings to death.
    const stage_of_death = r && r.failure ? { stage_reached: r.failure.stage_reached ?? null, stage_of_death: r.failure.stage_of_death ?? null, reason: cap(str(r.failure.reason)), error: cap(str(r.failure.error)) } : null;
    const stage_timings = (r && r.stage_timings) ? r.stage_timings : (led && led.stages ? { source: 'ledger.stages', per_stage_ms: led.stages } : null);

    return {
        tool: 'failure_dossier',
        schema: '1.0.0',
        key: e.sha ? `sha:${e.sha}` : `file:${normName(e.name)}`,
        key_mode: e.sha ? 'sha' : 'filename',
        frame: {
            name: e.name,
            sha256: e.sha,
            source_format: (r && str(r.source_format)) || (led && str(led.format)) || null,
            image_width: r ? r.image_width ?? null : null,
            image_height: r ? r.image_height ?? null : null,
        },
        sources_joined: { receipt: !!r, ledger: !!led, log: !!e.log_path },
        outcome: (led && (str(led.resolved_outcome) || str(led.outcome))) || (r ? r.kind || 'no_solve' : null),
        wall_ms: led && Number.isFinite(led.wall_ms) ? led.wall_ms : null,
        taxonomy: { class: taxonomy.class, basis: taxonomy.basis, signals: taxonomy.signals ?? null },
        decoder_arm, decoder_arm_source,
        detection,
        solve_attempts,
        best_sigma_reached,
        stage_of_death,
        stage_timings,
        log: log ? {
            available: log.available,
            bytes_read: log.bytes_read ?? null,
            tail_truncated: log.tail_truncated ?? null,
            log_size_bytes: log.log_size_bytes ?? null,
            markers: log.markers ?? null,
            stars_matched_log: log.stars_matched_log ?? null,
            guard_throw: log.guard_throw ?? null,
            search_exhausted: log.search_exhausted ?? null,
        } : { available: false, note: `${NM} — no log joined` },
        error_signature: led ? str(led.error_signature) : null,
    };
}

// ── aggregate ─────────────────────────────────────────────────────────────────
function aggregate(dossiers) {
    const by_class = {};
    const decoder_arm_dist = {};
    let with_receipt = 0, with_ledger = 0, with_log = 0, arm_read = 0, arm_guessed = 0, arm_null = 0;
    for (const d of dossiers) {
        by_class[d.taxonomy.class] = (by_class[d.taxonomy.class] || 0) + 1;
        if (d.sources_joined.receipt) with_receipt++;
        if (d.sources_joined.ledger) with_ledger++;
        if (d.sources_joined.log) with_log++;
        const arm = d.decoder_arm == null ? 'null' : d.decoder_arm;
        decoder_arm_dist[arm] = (decoder_arm_dist[arm] || 0) + 1;
        if (/READ/.test(d.decoder_arm_source)) arm_read++;
        else if (/GUESSED/.test(d.decoder_arm_source)) arm_guessed++;
        else arm_null++;
    }
    const failure_classes = ['decode_fail', 'locked_but_dropped', 'uw_grind_budget_kill', 'ladder_exhaustion', 'narrow_fast_fail', 'unknown'];
    const class_hints = {};
    for (const c of failure_classes) if (by_class[c]) class_hints[c] = { count: by_class[c], ...CLASS_HINTS[c] };
    return {
        tool: 'failure_dossier',
        schema: '1.0.0',
        n_frames: dossiers.length,
        sources: { with_receipt, with_ledger, with_log },
        decoder_arm: { distribution: decoder_arm_dist, read_from_receipt: arm_read, guessed_from_ledger: arm_guessed, not_measured: arm_null },
        taxonomy_counts: by_class,
        class_hints,
        notes: [
            'decoder_arm is READ from receipt.pipeline_provenance where a receipt exists; ledger decoder_arm is format-guessed (§4-b2) and used only as a labelled fallback.',
            "class hints are a mechanical mapping from TEST_SUITE_PLAN §3 — cited per class, no invention. 'unknown' carries no lever.",
        ],
    };
}

// ── report ───────────────────────────────────────────────────────────────────
function printReport(opts, agg, nR, nL, nLog) {
    console.log(`failure_dossier — receipts:${opts.receipts ? ` ${opts.receipts} (${nR})` : ' (none)'}  ledger:${opts.ledger ? ` ${nL} rows` : ' (none)'}  logs:${opts.logs ? ` ${nLog} joined` : ' (none)'}`);
    console.log(`frames: ${agg.n_frames}  ·  sources: ${agg.sources.with_receipt} w/receipt, ${agg.sources.with_ledger} w/ledger, ${agg.sources.with_log} w/log`);
    console.log(`decoder_arm: ${JSON.stringify(agg.decoder_arm.distribution)}  (${agg.decoder_arm.read_from_receipt} read, ${agg.decoder_arm.guessed_from_ledger} ledger-guessed, ${agg.decoder_arm.not_measured} NOT MEASURED)`);
    console.log('taxonomy:');
    for (const [c, n] of Object.entries(agg.taxonomy_counts).sort((a, b) => b[1] - a[1])) {
        const h = agg.class_hints[c];
        console.log(`  ${String(n).padStart(4)}  ${c}${h ? `  → ${h.lever ?? '(no lever)'}  [${h.cite}]` : ''}`);
    }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main(argv) {
    const { opts, error } = parseArgs(argv);
    if (error) { console.error(`failure_dossier: ${error}`); return 2; }
    const usage = 'Usage: node tools/forensics/failure_dossier.mjs --receipts <dir> [--logs <dir>] [--ledger <ledger_resolved.jsonl>] --out <dir>';
    if (opts.help) { console.log(usage); return 0; }
    if (!opts.out) { console.error(`failure_dossier: --out is required\n${usage}`); return 2; }
    if (!opts.receipts && !opts.ledger) { console.error(`failure_dossier: at least one of --receipts / --ledger is required\n${usage}`); return 2; }

    const reg = makeRegistry();
    let nR = 0, nL = 0, nLog = 0;
    try {
        if (opts.receipts) nR = loadReceipts(opts.receipts, reg);
        if (opts.ledger) nL = loadLedger(opts.ledger, reg);
        nLog = attachLogs(opts.logs, reg);   // also honors ledger.log basenames when --logs given
    } catch (e) {
        if (e instanceof IoError) { console.error(`failure_dossier: ${e.message}`); return 2; }
        throw e;
    }

    const dossiers = [];
    for (const e of reg.entries) {
        const log = e.log_path ? parseLog(e.log_path) : null;
        const taxonomy = classify(e, log);
        dossiers.push(buildDossier(e, log, taxonomy));
    }
    // deterministic order: by key
    dossiers.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const agg = aggregate(dossiers);

    // write out
    try {
        const dossierDir = path.join(opts.out, 'dossiers');
        fs.mkdirSync(dossierDir, { recursive: true });
        const used = new Set();
        for (const d of dossiers) {
            let base = safeFile(d.frame.name || (d.frame.sha256 ? d.frame.sha256.slice(0, 16) : 'frame'));
            let fn = `${base}.dossier.json`;
            if (used.has(fn)) fn = `${base}.${(d.frame.sha256 || '').slice(0, 8) || used.size}.dossier.json`;
            used.add(fn);
            fs.writeFileSync(path.join(dossierDir, fn), JSON.stringify(d, null, 2));
        }
        fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify(agg, null, 2));
    } catch (e) { console.error(`failure_dossier: cannot write --out ${opts.out}: ${e.message}`); return 2; }

    printReport(opts, agg, nR, nL, nLog);
    console.log(`\nwrote ${dossiers.length} dossiers + summary.json → ${opts.out}`);
    return 0;
}

const invokedDirect = (() => {
    try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
    catch { return true; }
})();
if (invokedDirect) process.exit(main(process.argv.slice(2)));

export {
    parseArgs, receiptSha, isFailureReceipt, normName, makeRegistry,
    stripAnsi, parseLog, classify, buildDossier, aggregate, CLASS_HINTS, main,
};
