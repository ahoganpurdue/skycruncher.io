#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/confirm_stats_test.mjs — self-test for confirm-tier analytics.
// Plain-assert, vitest-free, node-runnable (tools-lane idiom). Named `_test.mjs`
// (underscore) NOT `.test.mjs` DELIBERATELY — the dot form is swept by vitest and
// would break the `npx vitest run` gate. Run:  node tools/analytics/confirm_stats_test.mjs
//
// Covers: Pearson/Spearman math on fixtures with KNOWN correlation (perfect ±1,
// a hand-computed mid value, zero-variance → null, n<2 → null) · perTargetStrength
// (z/√N, honest null on absent/zero N) · confirmSummary field reads + honest nulls
// · the N-vs-verdict tracker (recompute + baseline agreement verdict, NOT-MEASURED
// exclusion of null-setExcessZ frames) · REFUSED profile · the fdr_shadow
// NOT-MEASURED path (absent) AND the MEASURED path (synthetic shadow block) ·
// determinism (double-run byte-identical over synthetic frames).
// ═══════════════════════════════════════════════════════════════════════════

import {
  pearson, spearman, perTargetStrength, confirmSummary, collectConfirmSummaries,
  statusTally, nVsVerdict, perTargetStrengthBlock, refusedProfile, fdrShadowBlock,
  confirmStats, PEARSON_BASELINE, NOT_MEASURED,
} from './confirm_stats.mjs';
import { stableStringify } from './lib/corpus.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function near(a, b, eps, msg) { ok(a !== null && Math.abs(a - b) <= eps, `${msg}  (got ${a}, want ~${b})`); }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ── Pearson: known correlations ───────────────────────────────────────────────
near(pearson([1, 2, 3], [2, 4, 6]).r, 1, 1e-12, 'pearson perfect positive = 1');
near(pearson([1, 2, 3], [6, 4, 2]).r, -1, 1e-12, 'pearson perfect negative = -1');
// hand-computed: x=[1,2,3,4], y=[1,3,2,5] → r = 5.5/sqrt(5*8.75) = 0.831522…
near(pearson([1, 2, 3, 4], [1, 3, 2, 5]).r, 0.8315218, 1e-6, 'pearson mid value hand-check');
eq(pearson([5, 5, 5], [1, 2, 3]).r, null, 'pearson zero-variance column → null (never 0-as-measured)');
eq(pearson([1], [1]).r, null, 'pearson n<2 → null');
eq(pearson([1], [1]).n, 1, 'pearson reports honest n even when r null');

// ── Spearman: monotone-but-nonlinear → rho=1 where Pearson<1 ──────────────────
near(spearman([1, 2, 3, 4], [1, 4, 9, 16]).rho, 1, 1e-12, 'spearman monotone (quadratic) = 1');
ok(pearson([1, 2, 3, 4], [1, 4, 9, 16]).r < 1, 'pearson on same quadratic < 1 (confirms rank vs linear)');
near(spearman([1, 2, 3, 4], [4, 3, 2, 1]).rho, -1, 1e-12, 'spearman perfect decreasing = -1');
// ties share mean rank: x=[1,1,2,2] all-tie x has zero rank variance → rho null
eq(spearman([1, 1, 1, 1], [1, 2, 3, 4]).rho, null, 'spearman constant column → null');

// ── perTargetStrength (z/√N) ──────────────────────────────────────────────────
near(perTargetStrength(10, 4), 5, 1e-12, 'perTargetStrength 10/√4 = 5');
near(perTargetStrength(155.94, 184), 11.4959, 1e-3, 'perTargetStrength Orion-like check');
eq(perTargetStrength(null, 10), null, 'perTargetStrength null Z → null');
eq(perTargetStrength(5, 0), null, 'perTargetStrength zero N → null (NOT MEASURED, not Infinity)');
eq(perTargetStrength(5, null), null, 'perTargetStrength null N → null');
near(perTargetStrength(-1.05, 11), -0.31659, 1e-4, 'perTargetStrength allows negative Z');

// ── synthetic frames (corpus-record shape) ────────────────────────────────────
// Hermetic: no D: dependency. Only the fields confirm_stats reads are populated.
function frame(key, id, kind, cs, dc) {
  return { key, id, kind, receipt: (cs || dc) ? { confirm_status: cs || null, deep_confirmed: dc || null } : null };
}
const CONFIRMED_A = frame('sha:aa', 'confA', 'solved',
  { status: 'CONFIRMED', setExcessZ: 40, nTargets: 100, confirmed: 90, setGateZ: 15, reason: null },
  { setGatePassed: true, examined: 100, confirmed: 90, provenance: 'CATALOG_FORCED_CONFIRMED', confirmed_stars: [1, 2, 3] });
const CONFIRMED_B = frame('sha:bb', 'confB', 'solved',
  { status: 'CONFIRMED', setExcessZ: 20, nTargets: 25, confirmed: 20, setGateZ: 15, reason: null },
  { setGatePassed: true, examined: 25, confirmed: 20, provenance: 'CATALOG_FORCED_CONFIRMED' });
const REFUSED_HIGHN = frame('sha:cc', 'refHighN', 'solved',
  { status: 'REFUSED', setExcessZ: 6.85, nTargets: 126, confirmed: 0, setGateZ: 15, reason: null },
  { setGatePassed: false, examined: 126, confirmed: 0, provenance: 'CATALOG_FORCED_CONFIRMED' });
const REFUSED_LOWN = frame('sha:dd', 'refLowN', 'solved',
  { status: 'REFUSED', setExcessZ: -1.05, nTargets: 11, confirmed: 0, setGateZ: 15, reason: null },
  { setGatePassed: false, examined: 11, confirmed: 0 });
const INSUFF = frame('sha:ee', 'insuff', 'solved',
  { status: 'INSUFFICIENT_TARGETS', setExcessZ: null, nTargets: 2, confirmed: 0, setGateZ: 15, reason: 'Too few candidates (2 < 10) — NOT MEASURED.' },
  { setGatePassed: false, examined: 2, not_measured: true });
const NOTRUN = frame('sha:ff', 'notrun', 'solved',
  { status: 'NOT_RUN', setExcessZ: null, nTargets: 0, confirmed: 0, setGateZ: 15, reason: 'No in-frame catalog positions — NOT MEASURED.' },
  { setGatePassed: false, examined: 0, not_measured: true });
const NOSOLVE = frame('sha:gg', 'nosolve', 'no_solve', null, null); // no confirm block
const ASSISTED = { key: 'sha:hh', id: 'assist', kind: 'assisted', receipt: null }; // assisted lane carries no receipt

const FRAMES = [CONFIRMED_A, CONFIRMED_B, REFUSED_HIGHN, REFUSED_LOWN, INSUFF, NOTRUN, NOSOLVE, ASSISTED];

// ── confirmSummary field reads + honest nulls ─────────────────────────────────
const sA = confirmSummary(CONFIRMED_A);
eq(sA.status, 'CONFIRMED', 'summary reads status');
eq(sA.setExcessZ, 40, 'summary reads setExcessZ');
eq(sA.nTargets, 100, 'summary reads nTargets');
eq(sA.setGatePassed, true, 'summary reads deep_confirmed.setGatePassed');
eq(sA.confirmedStars, 3, 'summary counts confirmed_stars array');
near(sA.perTargetStrength, 4, 1e-12, 'summary computes z/√N (40/√100=4)');
eq(sA.notMeasured, false, 'CONFIRMED not flagged NOT MEASURED');
const sI = confirmSummary(INSUFF);
eq(sI.setExcessZ, null, 'INSUFFICIENT setExcessZ honest null');
eq(sI.perTargetStrength, null, 'INSUFFICIENT z/√N null');
eq(sI.notMeasured, true, 'INSUFFICIENT flagged NOT MEASURED');
eq(confirmSummary(NOSOLVE), null, 'no-confirm-block frame → null summary');
eq(confirmSummary(ASSISTED), null, 'assisted (no receipt) → null summary');
// the LIVE data carries not_measured as a truthy REASON STRING, not boolean true.
const strNM = frame('sha:nm', 'strNM', 'solved',
  { status: 'INSUFFICIENT_TARGETS', setExcessZ: null, nTargets: 1, confirmed: 0, setGateZ: 15, reason: null },
  { setGatePassed: false, examined: 1, setExcessZ: null, not_measured: 'Too few candidates (1 < 10) — NOT MEASURED.' });
eq(confirmSummary(strNM).notMeasured, true, 'string-valued not_measured flagged (matches live data shape)');

// ── collect + tally ───────────────────────────────────────────────────────────
const summaries = collectConfirmSummaries(FRAMES);
eq(summaries.length, 6, 'collectConfirmSummaries keeps only confirm-block frames (6 of 8)');
const keys = summaries.map((s) => s.key);
eq(keys.slice().sort(), keys, 'summaries deterministically sorted by key');
const tally = statusTally(summaries);
eq(tally.CONFIRMED, 2, 'tally CONFIRMED=2');
eq(tally.REFUSED, 2, 'tally REFUSED=2');
eq(tally.INSUFFICIENT_TARGETS, 1, 'tally INSUFFICIENT_TARGETS=1');
eq(tally.NOT_RUN, 1, 'tally NOT_RUN=1');

// ── N-vs-verdict: recompute + NOT-MEASURED exclusion + baseline agreement ─────
const nvv = nVsVerdict(summaries, { baseline: 0.9, tolerance: 0.5 });
eq(nvv.n_frames, 4, 'N-vs-verdict uses only confirmable frames (4: null-setExcessZ excluded)');
eq(nvv.excluded_not_measured, 2, 'two NOT-MEASURED frames excluded (not zero-filled)');
// pearson over N=[100,25,126,11], Z=[40,20,6.85,-1.05] — recompute independently:
const expectR = pearson([100, 25, 126, 11], [40, 20, 6.85, -1.05]).r;
near(nvv.pearson, expectR, 1e-12, 'N-vs-verdict pearson matches independent recompute');
eq(nvv.agreement, Math.abs(expectR - 0.9) <= 0.5 ? 'AGREES' : 'DIVERGES', 'agreement verdict consistent with tolerance');
// baseline is never moved to fit: a tiny tolerance flips the verdict, r unchanged.
const nvvTight = nVsVerdict(summaries, { baseline: 0.9, tolerance: 0.0001 });
near(nvvTight.pearson, expectR, 1e-12, 'tightening tolerance does NOT change recomputed r');
eq(nvvTight.agreement, 'DIVERGES', 'tight tolerance → DIVERGES (evidence added, baseline not lowered)');
// all-NOT-MEASURED corpus → pearson null, agreement NOT MEASURED (never a fake 0).
const nvvEmpty = nVsVerdict([confirmSummary(INSUFF), confirmSummary(NOTRUN)]);
eq(nvvEmpty.pearson, null, 'all-null-setExcessZ → pearson null');
eq(nvvEmpty.agreement, NOT_MEASURED, 'all-NOT-MEASURED → agreement NOT MEASURED');

// ── per-target strength block + N-inflation canary ordering ───────────────────
const pts = perTargetStrengthBlock(summaries);
eq(pts.n_frames, 4, 'per-target block over 4 measured frames');
ok(pts.per_frame[0].perTargetStrength >= pts.per_frame[1].perTargetStrength, 'per_frame sorted by strength desc');
eq(pts.n_inflation_canaries.frames[0].id, 'refHighN', 'top N-inflation canary = highest-nTargets REFUSED (refHighN, n=126)');
eq(pts.by_status.CONFIRMED.n, 2, 'by_status CONFIRMED sample n=2');
eq(pts.by_status.REFUSED.n, 2, 'by_status REFUSED sample n=2');

// ── REFUSED profile ───────────────────────────────────────────────────────────
const rp = refusedProfile(summaries);
eq(rp.n_frames, 2, 'REFUSED profile n=2');
eq(rp.nTargets.max, 126, 'REFUSED nTargets max = 126');
eq(rp.nTargets.min, 11, 'REFUSED nTargets min = 11');
eq(rp.frames[0].id, 'refHighN', 'REFUSED frames sorted nTargets desc');
ok(rp.setExcessZ.min < 0, 'REFUSED setExcessZ can be negative (honest, not clamped)');

// ── fdr_shadow: NOT-MEASURED path (absent everywhere) ─────────────────────────
const shadowAbsent = fdrShadowBlock(FRAMES);
eq(shadowAbsent.status, NOT_MEASURED, 'fdr_shadow absent → NOT MEASURED');
eq(shadowAbsent.present_frames, 0, 'fdr_shadow absent → 0 present frames');
eq(shadowAbsent.comparison, null, 'fdr_shadow absent → no fabricated comparison');

// ── fdr_shadow: MEASURED path (synthetic shadow block) ────────────────────────
const shadowFrame = frame('sha:zz', 'shadowed', 'solved',
  { status: 'REFUSED', setExcessZ: 6.85, nTargets: 126, confirmed: 0, setGateZ: 15, reason: null },
  { setGatePassed: false, examined: 126, fdr_shadow: { value: 0.03, gatePassed: false } });
const shadowFrame2 = frame('sha:yy', 'shadowed2', 'solved',
  { status: 'CONFIRMED', setExcessZ: 40, nTargets: 100, confirmed: 90, setGateZ: 15, reason: null },
  { setGatePassed: true, examined: 100, fdr_shadow: { value: 0.9, gatePassed: false } }); // verdict FLIPS
const shadowPresent = fdrShadowBlock([shadowFrame, shadowFrame2]);
eq(shadowPresent.status, 'MEASURED', 'fdr_shadow present → MEASURED');
eq(shadowPresent.present_frames, 2, 'fdr_shadow reads both frames');
eq(shadowPresent.comparison[0].old.value, 6.85, 'fdr_shadow carries old setExcessZ');
eq(shadowPresent.comparison[0].verdict_changed, false, 'unchanged verdict detected (both refuse)');
eq(shadowPresent.verdict_changes, 1, 'one verdict flip detected (CONFIRMED→refuse under shadow)');

// ── confirmStats assembly + determinism (double-run byte-identical) ───────────
const d1 = confirmStats(FRAMES, { baseline: PEARSON_BASELINE });
const d2 = confirmStats(FRAMES, { baseline: PEARSON_BASELINE });
eq(d1.corpus.with_confirm_block, 6, 'confirmStats corpus.with_confirm_block=6');
eq(d1.corpus.confirmable_frames, 4, 'confirmStats corpus.confirmable_frames=4');
eq(stableStringify(d1), stableStringify(d2), 'confirmStats deterministic (double-run byte-identical)');
// re-ordering the input frames must NOT change the canonical output (sorted-by-key).
const shuffled = [ASSISTED, NOTRUN, CONFIRMED_B, REFUSED_HIGHN, NOSOLVE, CONFIRMED_A, INSUFF, REFUSED_LOWN];
eq(stableStringify(confirmStats(shuffled, { baseline: PEARSON_BASELINE })), stableStringify(d1),
  'confirmStats order-invariant (deterministic key sort)');

// ── report ────────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`confirm_stats_test: ${pass} assertions PASS`);
else { console.error(`confirm_stats_test: ${fail} FAIL / ${pass} pass`); process.exit(1); }
