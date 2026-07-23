#!/usr/bin/env node
// tools/gates/failure_fingerprint.mjs — failure-fingerprint diagnostic (mutation-test posture)
//
// The ~1800-test suite is a SENSOR ARRAY, not a gate: the *set* of tests a merge
// knocks over localizes what it changed. This tool captures that set as a fingerprint,
// set-diffs two fingerprints to isolate what moved, and checks the blast radius against
// a declared subsystem scope. It is a DIAGNOSTIC — it ALWAYS exits 0, never gates.
//
// Modes:
//   --capture --label <name> [--name <exact-basename>]
//       Run `npx vitest run --reporter=json` (the gate's own selection) and write a
//       fingerprint manifest of every NON-PASSING test to
//       test_results/restoration_fingerprints/<timestamp>_<label>.json + latest.json.
//       (--name overrides the auto timestamped basename, e.g. for a fixed baseline file.)
//
//   --diff <a.json> <b.json>   |   --diff-latest [--baseline <b.json>]
//       Set-diff two fingerprints -> NEW / RESOLVED / PERSISTING failures. NEW failures
//       are bucketed by test-file path into subsystems and printed as a compact table.
//       --diff-latest diffs the two most recent captures (A=penultimate, B=newest);
//       --diff-latest --baseline <b> diffs that baseline (A) against the newest (B).
//
//   ... --expect <csv-of-subsystems>
//       After a diff, partition NEW failures into EXPECTED (declared subsystems) vs
//       UNEXPECTED (outside). The UNEXPECTED group is the payload — surface, not verdict.
//
// Dependency-free: node stdlib + vitest's own JSON reporter. Never added to CI.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = resolve(ROOT, 'test_results', 'restoration_fingerprints');
const SCHEMA = 'failure-fingerprint/1';

// ---------------------------------------------------------------------------
// argv parse (tiny, positional-aware)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { capture: false, diffLatest: false, label: null, name: null, expect: null, diff: null, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--capture') a.capture = true;
    else if (t === '--diff-latest') a.diffLatest = true;
    else if (t === '--label') a.label = argv[++i];
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--expect') a.expect = argv[++i];
    else if (t === '--baseline') a.baseline = argv[++i];
    else if (t === '--diff') { a.diff = [argv[++i], argv[++i]]; }
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

// ---------------------------------------------------------------------------
// subsystem classification — derive a bucket from the test-file path.
// Module-prefixed files (m10_psf.test.ts -> 10) win first (no m1/m10 collision);
// unprefixed files fall to keyword rules. Heuristic, not load-bearing.
// ---------------------------------------------------------------------------
const MODULE_MAP = {
  1: 'm1_ingestion', 2: 'm2_hardware', 3: 'm2_hardware', 4: 'm4_signal_detect',
  5: 'm4_signal_detect', 6: 'm6_plate_solve', 7: 'stages', 8: 'm8_photometry',
  9: 'stages', 10: 'm10_psf', 11: 'm11_stack',
};
const KEYWORD_RULES = [
  [/psf/, 'm10_psf'],
  [/stack|drizzl/, 'm11_stack'],
  [/ingest|decoder|memimage|black_level|timestamp|observer|rawler|cr2|raf|fits_decoder|format_registry|intake/, 'm1_ingestion'],
  [/optic|lens|sensor|calibrat|workbench|camera_color|cfa|hardware/, 'm2_hardware'],
  [/detect|horizon|metrolog|culling|density|planet|signal|denoise|drift/, 'm4_signal_detect'],
  [/solve|solver|atlas|catalog|confirm|deep_verify|fdr|anchor|hint|tps|residual|reproject|starplates|provenance|search_prior|truth|tonative/, 'm6_plate_solve'],
  [/spcc|annulus|photometr|channel_gain|color_fidelity/, 'm8_photometry'],
  [/stage|pipeline|orchestrat|receipt|package|no_solve|schema/, 'stages'],
  [/widget|ui_|dashboard|flowchart|step6|charts|label|render|oklab|webgpu|nebulos|sexagesimal|format/, 'ui'],
  [/core|image_processor|synthesis|cascade/, 'core'],
  [/type|contract|layout|coordinate_integrity|layer1/, 'types'],
  [/validation|harness|e2e|capture|seam|batch|overnight|queue|timing|smoke|failure_diagn|serial|conformance|sibling/, 'tests-infra'],
];
function classify(filePath) {
  const base = String(filePath).replace(/\\/g, '/').split('/').pop() || String(filePath);
  const m = base.match(/^m(\d+)_/);
  if (m && MODULE_MAP[Number(m[1])]) return MODULE_MAP[Number(m[1])];
  const p = base.toLowerCase();
  for (const [re, bucket] of KEYWORD_RULES) if (re.test(p)) return bucket;
  return 'other';
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.status === 0 ? String(r.stdout) : '').trim();
}
function relFromRoot(abs) {
  const a = String(abs).replace(/\\/g, '/');
  const r = ROOT.replace(/\\/g, '/');
  return a.startsWith(r + '/') ? a.slice(r.length + 1) : a;
}

// ---------------------------------------------------------------------------
// CAPTURE
// ---------------------------------------------------------------------------
function capture(label, exactName) {
  if (!label) { console.error('[fingerprint] --capture requires --label <name>'); return 0; }
  mkdirSync(OUT_DIR, { recursive: true });
  // Temp JSON in a space-free tmpdir: the repo root has spaces ("Coding Projects"),
  // and cmd.exe (shell:true's default on Windows) would split an unquoted path. We
  // quote it AND keep it space-free for belt-and-suspenders.
  const jsonTmp = join(tmpdir(), `fp_vitest_${process.pid}.json`);
  if (existsSync(jsonTmp)) { try { unlinkSync(jsonTmp); } catch { /* ignore */ } }

  console.log(`[fingerprint] capturing '${label}' — running \`npx vitest run --reporter=json\` (gate selection) ...`);
  const t0 = Date.now();
  // Single quoted command STRING (not an args array): with shell:true the shell parses
  // the quotes, so paths with spaces survive. Mirrors tools/gates/check_gates.mjs.
  const cmd = `npx vitest run --reporter=json --outputFile="${jsonTmp}"`;
  const r = spawnSync(cmd, {
    cwd: ROOT, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
  });
  const wallMs = Date.now() - t0;
  const vitestExitCode = r.status ?? -1;

  let report = null, parseError = null;
  try {
    report = JSON.parse(readFileSync(jsonTmp, 'utf8'));
  } catch (e) {
    // Fallback: the json reporter also emits to stdout when outputFile is unavailable.
    // Slice the outermost JSON object (first '{' .. last '}') from captured stdout.
    const so = String(r.stdout || '');
    const lo = so.indexOf('{'), hi = so.lastIndexOf('}');
    if (lo >= 0 && hi > lo) {
      try { report = JSON.parse(so.slice(lo, hi + 1)); parseError = null; }
      catch (e2) { parseError = `outputFile: ${e && e.message || e}; stdout-fallback: ${e2 && e2.message || e2}`; }
    } else {
      parseError = String(e && e.message || e);
    }
  }
  try { if (existsSync(jsonTmp)) unlinkSync(jsonTmp); } catch { /* ignore */ }

  const nonPassing = [];
  let passed = 0, failed = 0, skipped = 0, todo = 0;
  if (report && Array.isArray(report.testResults)) {
    for (const suite of report.testResults) {
      const fileAbs = suite.name || suite.testFilePath || '(unknown)';
      const fileRel = relFromRoot(fileAbs);
      const subsystem = classify(fileRel);
      for (const ar of (suite.assertionResults || [])) {
        const status = ar.status; // passed | failed | skipped | todo | pending | disabled
        const testName = ar.fullName || [...(ar.ancestorTitles || []), ar.title].filter(Boolean).join(' > ') || ar.title || '(unnamed)';
        if (status === 'passed') { passed++; continue; }
        if (status === 'failed') failed++;
        else if (status === 'todo') todo++;
        else skipped++; // skipped | pending | disabled — quirk: NOT a failure
        nonPassing.push({ file: relFromRoot(fileAbs), fileRel, testName, status, subsystem });
      }
    }
  }
  // Prefer vitest's own top-level counts when present (authoritative), else our tally.
  const counts = {
    total: num(report && report.numTotalTests, passed + failed + skipped + todo),
    passed: num(report && report.numPassedTests, passed),
    failed: num(report && report.numFailedTests, failed),
    skipped: num(report && report.numPendingTests, skipped),
    todo: num(report && report.numTodoTests, todo),
    nonPassing: nonPassing.length,
  };
  nonPassing.sort((x, y) => (x.fileRel === y.fileRel ? cmp(x.testName, y.testName) : cmp(x.fileRel, y.fileRel)));

  const manifest = {
    schema: SCHEMA,
    label,
    timestamp: new Date().toISOString(),
    sha: git(['rev-parse', 'HEAD']) || null,
    shaShort: git(['rev-parse', '--short', 'HEAD']) || null,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    vitestExitCode,
    wallMs,
    parseError,
    counts,
    nonPassing,
  };

  const safeLabel = String(label).replace(/[^a-zA-Z0-9._+-]/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outName = exactName ? ensureJson(exactName) : `${stamp}_${safeLabel}.json`;
  const outPath = join(OUT_DIR, outName);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify({
    path: outName, label, timestamp: manifest.timestamp, sha: manifest.sha, shaShort: manifest.shaShort,
    counts, wallMs,
  }, null, 2));

  console.log(`[fingerprint] wrote ${relFromRoot(outPath)}`);
  console.log(`[fingerprint] sha=${manifest.shaShort} vitestExit=${vitestExitCode} wall=${(wallMs / 1000).toFixed(1)}s`);
  if (parseError) console.log(`[fingerprint] WARNING: could not parse vitest JSON (${parseError}); manifest recorded with empty failure set.`);
  console.log(`[fingerprint] counts: ${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped · ${counts.todo} todo · ${counts.nonPassing} non-passing recorded`);
  return 0; // ALWAYS 0 — diagnostic, never a gate.
}

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------
function keyOf(e) { return `${e.fileRel} :: ${e.testName}`; }
function failMap(fp) { return new Map((fp.nonPassing || []).filter((e) => e.status === 'failed').map((e) => [keyOf(e), e])); }
function skipMap(fp) { return new Map((fp.nonPassing || []).filter((e) => e.status !== 'failed').map((e) => [keyOf(e), e])); }

function loadFp(p) {
  const abs = resolve(process.cwd(), p);
  const fp = JSON.parse(readFileSync(abs, 'utf8'));
  if (fp.schema !== SCHEMA) console.warn(`[fingerprint] note: ${p} schema='${fp.schema}' (expected ${SCHEMA})`);
  return fp;
}

function pickLatestTwo(baselinePath) {
  if (!existsSync(OUT_DIR)) return null;
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== 'latest.json');
  const fps = files.map((f) => {
    try { const fp = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8')); return { f, ts: fp.timestamp || '', fp }; }
    catch { return null; }
  }).filter(Boolean).sort((x, y) => cmp(x.ts, y.ts));
  if (fps.length === 0) return null;
  const b = fps[fps.length - 1];
  if (baselinePath) return { aPath: baselinePath, a: loadFp(baselinePath), bPath: join(OUT_DIR, b.f), b: b.fp };
  if (fps.length < 2) return null;
  const a = fps[fps.length - 2];
  return { aPath: join(OUT_DIR, a.f), a: a.fp, bPath: join(OUT_DIR, b.f), b: b.fp };
}

function diff(aFp, bFp, aName, bName, expectCsv) {
  const fa = failMap(aFp), fb = failMap(bFp);
  const sa = skipMap(aFp), sb = skipMap(bFp);

  const newFailures = [...fb.values()].filter((e) => !fa.has(keyOf(e)));
  const resolved = [...fa.values()].filter((e) => !fb.has(keyOf(e)));
  const persisting = [...fb.values()].filter((e) => fa.has(keyOf(e)));
  const newSkips = [...sb.values()].filter((e) => !sa.has(keyOf(e)) && !fa.has(keyOf(e)));

  const line = '='.repeat(72);
  console.log(line);
  console.log('FAILURE-FINGERPRINT DIFF');
  console.log(`  A (baseline): ${relFromRoot(aName)}  [${aFp.shaShort || '?'}, ${fa.size} failed]`);
  console.log(`  B (subject):  ${relFromRoot(bName)}  [${bFp.shaShort || '?'}, ${fb.size} failed]`);
  console.log(line);
  console.log(`  NEW failures:        ${newFailures.length}`);
  console.log(`  RESOLVED failures:   ${resolved.length}`);
  console.log(`  PERSISTING failures: ${persisting.length}`);
  console.log(`  NEW skips (non-fail): ${newSkips.length}${newSkips.length ? '  (watch: "0 new skips" gate)' : ''}`);
  console.log(line);

  // Subsystem x new-failure table
  if (newFailures.length) {
    const byBucket = groupBy(newFailures, (e) => e.subsystem);
    const buckets = [...byBucket.keys()].sort((x, y) => byBucket.get(y).length - byBucket.get(x).length || cmp(x, y));
    console.log('NEW FAILURES BY SUBSYSTEM (blast localization)');
    const w = Math.max(...buckets.map((b) => b.length), 10);
    for (const b of buckets) {
      const items = byBucket.get(b);
      console.log(`  ${b.padEnd(w)}  ${String(items.length).padStart(3)}`);
      for (const e of items) console.log(`  ${' '.repeat(w)}    - [${e.fileRel}] ${e.testName}`);
    }
    console.log(line);
  } else {
    console.log('NEW FAILURES: none — B introduced no failing test not already failing in A.');
    console.log(line);
  }

  if (resolved.length) {
    console.log(`RESOLVED (were failing in A, pass/gone in B): ${resolved.length}`);
    for (const e of resolved.slice(0, 40)) console.log(`  + [${e.fileRel}] ${e.testName}`);
    if (resolved.length > 40) console.log(`  ... +${resolved.length - 40} more`);
    console.log(line);
  }

  // Blast-radius partition
  if (expectCsv != null) blastRadius(newFailures, expectCsv, line);
  return { newFailures, resolved, persisting, newSkips };
}

function blastRadius(newFailures, expectCsv, line) {
  const expected = new Set(expectCsv.split(',').map((s) => s.trim()).filter(Boolean));
  const inScope = newFailures.filter((e) => expected.has(e.subsystem));
  const outScope = newFailures.filter((e) => !expected.has(e.subsystem));
  console.log('BLAST-RADIUS CHECK');
  console.log(`  declared scope: {${[...expected].join(', ')}}`);
  console.log(line);
  console.log(`  EXPECTED (in declared scope): ${inScope.length}`);
  for (const e of inScope) console.log(`    · [${e.subsystem}] ${e.fileRel} :: ${e.testName}`);
  console.log('');
  console.log(`  >>> UNEXPECTED (OUTSIDE declared scope): ${outScope.length} <<<`);
  if (outScope.length === 0) {
    console.log('    (none — every new failure lands inside the declared subsystems)');
  } else {
    const byBucket = groupBy(outScope, (e) => e.subsystem);
    for (const [b, items] of [...byBucket.entries()].sort((x, y) => y[1].length - x[1].length)) {
      console.log(`    [${b}] x${items.length}`);
      for (const e of items) console.log(`      · ${e.fileRel} :: ${e.testName}`);
    }
    console.log('');
    console.log('    ^ UNEXPECTED is the payload, not a verdict — investigate the seam this merge crossed.');
  }
  console.log(line);
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function num(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function cmp(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }
function ensureJson(n) { return n.endsWith('.json') ? n : `${n}.json`; }
function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function usage() {
  console.log(`failure_fingerprint.mjs — mutation-test posture diagnostic (always exits 0)

  Capture:  node tools/gates/failure_fingerprint.mjs --capture --label <name> [--name <basename>]
  Diff:     node tools/gates/failure_fingerprint.mjs --diff <a.json> <b.json> [--expect <csv>]
            node tools/gates/failure_fingerprint.mjs --diff-latest [--baseline <b.json>] [--expect <csv>]

  Subsystem buckets: m1_ingestion m2_hardware m4_signal_detect m6_plate_solve
                     m8_photometry m10_psf m11_stack stages ui core types tests-infra other`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }

if (args.capture) {
  process.exit(capture(args.label, args.name));
} else if (args.diff) {
  const [aP, bP] = args.diff;
  diff(loadFp(aP), loadFp(bP), aP, bP, args.expect);
  process.exit(0); // diagnostic
} else if (args.diffLatest) {
  const pair = pickLatestTwo(args.baseline);
  if (!pair) { console.error('[fingerprint] --diff-latest needs at least two captures (or one + --baseline) in ' + relFromRoot(OUT_DIR)); process.exit(0); }
  diff(pair.a, pair.b, pair.aPath, pair.bPath, args.expect);
  process.exit(0);
} else {
  usage();
  process.exit(0);
}
