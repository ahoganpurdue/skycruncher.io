#!/usr/bin/env node
// tools/gates/check_gates.mjs — mechanical (zero-LLM) regenerator for docs/GATES.md.
//
// Runs the machine-checkable gates (tsc error-TS count, vitest pass/skip, LAW-7 layout
// contracts, and the greenfield reference-solver sentinel) and rewrites the AUTO block in
// docs/GATES.md so the regression numbers never drift by hand-editing. The e2e scenarios
// need a browser + a fresh Vite port, so they stay documented statically in GATES.md (run
// them with the commands listed there).
//
// The greenfield sentinel leg is ENV-SENSITIVE: its script (gitignored under test_results/),
// the solver crates, and the pins bank all live locally/on D:. On a box/worktree where any
// is absent the leg reports an honest "NOT RUN (bank absent)" — never a fake pass, never a
// regenerator crash. A real decision drift (gate exit 2) is a RED gate in BOTH modes, same
// policy as the layout contracts (regen must never bake reference-solver drift into the baseline).
//
// Usage:
//   node tools/gates/check_gates.mjs --check    # ENFORCING (CI) mode: exit non-zero if live numbers
//                                               #   drift from the doc, tsc crashes, vitest fails, or a
//                                               #   layout contract FAILs. Never writes. (`npm run gates`)
//   node tools/gates/check_gates.mjs            # BASELINE REGEN: run gates, rewrite the AUTO block,
//                                               #   print numbers. Refuses on a dirty worktree unless
//                                               #   --force. (`npm run gates:update`)
//   node tools/gates/check_gates.mjs --force    #   regen even when the worktree is dirty beyond GATES.md
//
// Both modes hard-fail (nonzero exit) on: a tsc COMPILER CRASH (nonzero exit with zero
// parsed `error TS` diagnostics — a false-green the line count alone would miss), a
// vitest failure/nonzero exit, or a real layout-contract FAIL.
//
// Requires node_modules + the gitignored src/engine/wasm_compute/pkg/ present
// (same prerequisites as running the gates directly).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gatesDoc = resolve(root, 'docs', 'GATES.md');
const checkOnly = process.argv.includes('--check');
const force = process.argv.includes('--force');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(cmd) {
  try {
    const out = execSync(cmd, { cwd: root, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stripAnsi(out) };
  } catch (e) {
    // tsc exits non-zero when it reports diagnostics; that is expected.
    return { code: e.status ?? 1, out: stripAnsi(`${e.stdout || ''}${e.stderr || ''}`) };
  }
}

// Baseline regeneration (default mode) rewrites the COMMITTED gate numbers in
// docs/GATES.md, so it must reflect a known tree: refuse when the worktree carries
// uncommitted changes beyond the doc itself (a regen computed against un-committed code
// would bake unverified numbers into the baseline). --check never writes and is exempt.
// Override with --force.
function worktreeDirtyBeyondGatesDoc() {
  const res = run('git status --porcelain');
  if (res.code !== 0) return { gitError: true, dirty: false, offenders: [] };
  const offenders = res.out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .filter((l) => l.slice(3).trim() !== 'docs/GATES.md');
  return { gitError: false, dirty: offenders.length > 0, offenders };
}

if (!checkOnly) {
  const dirt = worktreeDirtyBeyondGatesDoc();
  if (dirt.gitError) {
    console.warn('[gates] warning: `git status` unavailable — skipping the clean-worktree guard for baseline regeneration.');
  } else if (dirt.dirty && !force) {
    console.error(
      '[gates] REFUSING to regenerate baselines: git worktree is dirty beyond docs/GATES.md:\n  ' +
        dirt.offenders.join('\n  ') +
        '\n\nThe regenerator rewrites the committed baseline numbers; run it from a clean tree so the\n' +
        'baseline reflects a known state. Commit/stash the above, or pass --force to override.'
    );
    process.exit(3);
  }
}

console.log('[gates] running `npx tsc --noEmit` ...');
const tsc = run('npx tsc --noEmit');
// Count real TypeScript diagnostics only: lines matching /error TS\d+/ (i.e.
// `npx tsc --noEmit | grep -c 'error TS'`). The old `wc -l` metric counted EVERY
// stdout line, so npm-notice / pipe noise inflated the baseline (the standing 7-vs-2
// false-red). Owner-ruled fix D-tsc-baseline-fix-vs-pin (dashboard 2026-07-11).
const tscErrors = tsc.out.split('\n').filter((l) => /error TS\d+/.test(l)).length;

// A nonzero tsc exit WITH parsed `error TS` lines is normal (diagnostics, counted
// above). A nonzero exit with ZERO parsed diagnostics is a COMPILER CRASH (bad tsconfig,
// OOM, internal error) that the error-line count silently reads as a clean "0 errors"
// pass — a false-green. Hard RED in both modes (owner directive: crash != pass).
if (tsc.code !== 0 && tscErrors === 0) {
  console.error(`[gates] TSC CRASH: \`npx tsc --noEmit\` exited ${tsc.code} with 0 parsed 'error TS' diagnostics (compiler crash, not a clean pass). Raw tail:\n` + tsc.out.slice(-800));
  process.exit(2);
}

console.log('[gates] running `npx vitest run` ...');
const vitest = run('npx vitest run');
// Parse the vitest "Tests" summary line (NOT the "Test Files" line).
const testsLine = (vitest.out.match(/^\s*Tests\s+.*$/m) || [])[0] || '';
const passed = Number((testsLine.match(/(\d+)\s+passed/) || [])[1] ?? NaN);
const skipped = Number((testsLine.match(/(\d+)\s+skipped/) || [])[1] ?? 0);
const failed = Number((testsLine.match(/(\d+)\s+failed/) || [])[1] ?? 0);

if (!Number.isFinite(passed)) {
  console.error('[gates] FAILED to parse vitest summary. Raw tail:\n' + vitest.out.slice(-800));
  process.exit(2);
}
// A failing test is a RED GATE, never a silently-lower passed count (caught live
// 2026-07-11: 3 failures reported as "1396 passed / 0 skipped" with exit 0 —
// a false-green). Also red on a nonzero vitest exit even if the summary parses.
if (failed > 0 || vitest.code !== 0) {
  console.error(`[gates] VITEST RED: ${failed} failed (exit ${vitest.code}). Raw tail:\n` + vitest.out.slice(-800));
  process.exit(2);
}

// LAW 7 standing gate (owner-ruled D-law7-golden-vectors-scope, dashboard 2026-07-11):
// run the layout-contract battery as a PASS/NOT-MEASURED-tolerant gate. NOT MEASURED
// entries are honest absence (golden vectors land at decoder cutover #14), NOT failures;
// the gate asserts 0 real FAILs, no PASS regression, and no boundary silently disappears.
// The tool is a zero-dependency leaf .ts import (no node_modules needed) and exits nonzero
// on real failure — run() captures its JSON on stdout either way.
console.log('[gates] running `node tools/contracts/check_layout_contracts.mjs --json` ...');
const layout = run('node tools/contracts/check_layout_contracts.mjs --json');
let layoutJson;
try {
  layoutJson = JSON.parse(layout.out);
} catch {
  console.error('[gates] FAILED to parse layout-contract JSON. Raw tail:\n' + layout.out.slice(-800));
  process.exit(2);
}
const layoutAll = [
  ...(layoutJson.globalChecks || []),
  ...((layoutJson.boundaries || []).flatMap((b) => b.checks || [])),
];
const layoutPass = layoutAll.filter((c) => c.status === 'PASS').length;
const layoutNm = layoutAll.filter((c) => c.status === 'NOT MEASURED').length;
const layoutFail = Number(layoutJson.failCount ?? NaN);
const layoutBoundaries = (layoutJson.boundaries || []).length;
if (!Number.isFinite(layoutFail) || layoutBoundaries === 0) {
  console.error('[gates] layout-contract JSON missing failCount/boundaries. Raw tail:\n' + layout.out.slice(-800));
  process.exit(2);
}
// A real layout-contract FAIL is a RED GATE in BOTH modes: regen must never bake a
// broken binary boundary into the committed baseline (previously enforced only inside
// the --check block). PASS-regression / boundary-disappeared drift stays a --check-only
// concern below — those need the doc baseline to compare against.
if (layoutFail > 0) {
  console.error(`[gates] LAYOUT CONTRACTS RED: ${layoutFail} real FAIL(s). Run \`node tools/contracts/check_layout_contracts.mjs\` for detail. Raw tail:\n` + layout.out.slice(-800));
  process.exit(2);
}

console.log(`[gates] tsc = ${tscErrors} error TS · vitest = ${passed} passed / ${skipped} skipped · layout = ${layoutPass} PASS / ${layoutNm} NM / ${layoutFail} FAIL across ${layoutBoundaries} boundaries`);

// Greenfield reference-solver sentinel gate (owner rebaseline 2026-07-21: the greenfield Rust
// solver core is the REFERENCE ENGINE). test_results/greenfield_solver/greenfield_gate.mjs runs
// the M66_seestar + CSM30799 sentinels and asserts each decision CORE (state/pose/resolved_config)
// is byte-equal to its pinned receipt. The build-commit provenance stamp is excluded BY DESIGN
// (the one legit cross-commit diff); counter jitter is WARN-only. Exit 0 = PASS · 2 = decision
// drift · 1 = infra error.
//
// ENV-SENSITIVE: the gate script (gitignored under test_results/), the solver crates
// (D:/AstroLogic/worktrees/wt-greenfield/crates), and the pins bank
// (D:/AstroLogic/test_artifacts/greenfield_solver/m6_ab/receipts) are all LOCAL/gitignored. When
// any is absent the leg reports an honest "NOT RUN (bank absent)" — never a fake pass. When
// present: exit 0 = PASS + pin count; exit 2 = real drift = RED (regen must never bake drift into
// the baseline, same policy as layout contracts); any other nonzero = infra error = RED (surfaced,
// never a silent pass). These probe paths mirror the constants inside the gate script.
const gfGate = resolve(root, 'test_results', 'greenfield_solver', 'greenfield_gate.mjs');
const gfCrates = 'D:/AstroLogic/worktrees/wt-greenfield/crates/build.cmd';
const gfPin = 'D:/AstroLogic/test_artifacts/greenfield_solver/m6_ab/receipts/M66_seestar.receipt.json';
let greenfieldCell;
const gfMissing = [
  !existsSync(gfGate) && 'gate script',
  !existsSync(gfCrates) && 'solver crates',
  !existsSync(gfPin) && 'pins bank',
].filter(Boolean);
if (gfMissing.length) {
  console.log(`[gates] greenfield sentinel = NOT RUN (bank absent: ${gfMissing.join(', ')})`);
  greenfieldCell =
    `**NOT RUN (bank absent)** — reference-solver sentinel skipped on this box (missing: ${gfMissing.join(', ')}); ` +
    `it runs where the greenfield gate script + crates + pins are present (local/D:). Honest absence, not a pass.`;
} else {
  console.log('[gates] running `node test_results/greenfield_solver/greenfield_gate.mjs` ...');
  const gf = run(`node "${gfGate}"`);
  const passIds = [...gf.out.matchAll(/^GATE PASS\s+(\S+)/gm)].map((m) => m[1]);
  if (gf.code === 2) {
    console.error(`[gates] GREENFIELD RED: reference-solver decision drift vs pins. Raw tail:\n` + gf.out.slice(-800));
    process.exit(2);
  }
  if (gf.code !== 0) {
    console.error(`[gates] GREENFIELD infra error (exit ${gf.code}) — assets present but the sentinel did not complete. Raw tail:\n` + gf.out.slice(-800));
    process.exit(2);
  }
  console.log(`[gates] greenfield sentinel = PASS (${passIds.length} pins byte-equal: ${passIds.join(', ')})`);
  greenfieldCell =
    `**PASS** · **${passIds.length}** sentinel pins CORE byte-equal (${passIds.join(', ')}) — reference-solver decision-CORE ` +
    `(state / pose / resolved_config) vs pinned receipts; build-commit provenance excluded by design, counter jitter WARN-only`;
}

const stamp = new Date().toISOString();
const autoBlock =
`<!-- BEGIN AUTO (generated by tools/gates/check_gates.mjs — do not hand-edit) -->
| Gate | Command | Expected |
|---|---|---|
| TypeScript | \`npx tsc --noEmit \\| grep -c 'error TS'\` | **${tscErrors}** error TS diagnostics (pre-existing baseline — counts \`error TSnnnn\` lines only, NOT raw stdout lines; the old \`wc -l\` metric included npm-notice/pipe noise. never *lower* to pass, add evidence) |
| Unit tests | \`npx vitest run\` | **${passed} passed / ${skipped} skipped** |
| Layout contracts (LAW 7) | \`node tools/contracts/check_layout_contracts.mjs --json\` | **${layoutPass}** PASS · **${layoutNm}** NOT MEASURED · **${layoutFail}** FAIL across **${layoutBoundaries}** boundaries (PASS/NOT-MEASURED-tolerant standing gate: 0 real failures, no PASS regression, no boundary disappears; NOT MEASURED = honest absence, golden vectors land at decoder cutover #14) |
| Greenfield reference solver (sentinel) | \`node test_results/greenfield_solver/greenfield_gate.mjs\` | ${greenfieldCell} |

_Last regenerated: ${stamp} by tools/gates/check_gates.mjs_
<!-- END AUTO -->`;

if (!existsSync(gatesDoc)) {
  console.error(`[gates] ${gatesDoc} not found`);
  process.exit(2);
}
const doc = readFileSync(gatesDoc, 'utf8');
const re = /<!-- BEGIN AUTO[\s\S]*?<!-- END AUTO -->/;
if (!re.test(doc)) {
  console.error('[gates] AUTO markers not found in docs/GATES.md');
  process.exit(2);
}

if (checkOnly) {
  const current = doc.match(re)[0];
  const curTsc = Number((current.match(/\*\*(\d+)\*\* error TS/) || [])[1] ?? NaN);
  const curPass = Number((current.match(/\*\*(\d+) passed/) || [])[1] ?? NaN);
  const curSkip = Number((current.match(/passed \/ (\d+) skipped/) || [])[1] ?? NaN);
  const curLayoutPass = Number((current.match(/\*\*(\d+)\*\* PASS ·/) || [])[1] ?? NaN);
  const curLayoutBoundaries = Number((current.match(/across \*\*(\d+)\*\* boundaries/) || [])[1] ?? NaN);

  const problems = [];
  // tsc / vitest — exact-drift (equality) as before, now on the error-TS count.
  if (curTsc !== tscErrors) problems.push(`tsc error-count drift: doc=${curTsc} live=${tscErrors}`);
  if (curPass !== passed) problems.push(`vitest passed drift: doc=${curPass} live=${passed}`);
  if (curSkip !== skipped) problems.push(`vitest skipped drift: doc=${curSkip} live=${skipped}`);
  // Layout contracts — PASS/NOT-MEASURED-tolerant drift checks. A real FAIL already
  // hard-exited above (both modes); here we catch a PASS regression or a disappeared
  // boundary, which need the doc baseline to compare against. A NOT-MEASURED count or an
  // ADDITIVE PASS increase is a legit surface bump — regen the doc, not a failure.
  if (Number.isFinite(curLayoutPass) && layoutPass < curLayoutPass)
    problems.push(`layout PASS regressed: doc=${curLayoutPass} live=${layoutPass}`);
  if (Number.isFinite(curLayoutBoundaries) && layoutBoundaries < curLayoutBoundaries)
    problems.push(`layout boundary disappeared: doc=${curLayoutBoundaries} live=${layoutBoundaries}`);

  if (problems.length) {
    console.error('[gates] DRIFT/REGRESSION:\n  - ' + problems.join('\n  - ') +
      '\nRun without --check to refresh tsc/vitest/layout numbers, or investigate a real layout regression.');
    process.exit(1);
  }
  console.log('[gates] OK — doc matches live tsc/vitest; layout contracts clean (0 FAIL, no PASS regression, no boundary disappeared).');
  process.exit(0);
}

writeFileSync(gatesDoc, doc.replace(re, autoBlock));
console.log(`[gates] rewrote AUTO block in ${gatesDoc}`);
