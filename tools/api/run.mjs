#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// TOOLCHEST API — run.mjs : thin CLI projection wrapper over runWizardPipeline
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/api/run.mjs [--select a.b,c.d] [--out <dir>] [--config '<json>'] <fits-path>
//
// Runs the REAL calibrated FITS wizard pipeline headlessly, dumps the FULL
// canonical receipt to <out|test_results/api_runs>/<basename>.receipt.json, and
// prints ONLY a selected dot-path projection to stdout. "Artifacts to disk,
// conclusions to context" applied to the instrument: the whole receipt is on
// disk; an agent pays context only for the fields it selects.
//
// A plain .mjs cannot resolve the engine's `@/` alias or boot the compiled wasm,
// so the real solve is spawned under vitest (run.config.ts + solve_to_receipt.runspec.ts)
// — the proven mechanism the overnight driver uses. run.mjs owns arg parsing,
// projection, and the exit code.
//
// Honest-or-absent: a --select path absent from the receipt prints "MISSING",
// never a fabricated value. Exit 0 on solve, 2 on no-solve, 1 on error.
//
// KNOB EXPERIMENTS (NEXT_MOVES §11b): --config '<json>' threads PIPELINE_CONSTANTS
// overrides at runtime WITHOUT editing source. The JSON is a flat {KEY: value}
// map of KNOWN constant names (unknown/mistyped keys are rejected + warned, never
// silently created). Applied pre-solve via applyConfigOverrides; the receipt is
// then stamped experimental=true + config_overrides={...} so an experimental run
// is never mistaken for a calibrated one. Omitted/empty ⇒ strict no-op (a
// byte-identical calibrated solve). Each run.mjs invocation forks a FRESH process,
// so the process-global config mutation never leaks between solves.
//   e.g.  node tools/api/run.mjs --config '{"SOLVER_UW_SWEEP_MIN_Z":4.0}' <fits>
//
// SCOPE: FITS lane only (CR2/RAW headless is out of scope, per headless_driver).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeCrashRecord } from './crash_record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const RUN_CONFIG = 'tools/api/run.config.ts';
const DEFAULT_OUT = path.join(ROOT, 'test_results', 'api_runs');

// Default projection = a minimal solve summary (REAL receipt field paths). The
// full deep_confirmed block (incl. its ~198-star confirmed_stars array) stays on
// disk; only its set-gate conclusion is projected to context.
const DEFAULT_SELECT = [
  'solution.ra_hours',
  'solution.dec_degrees',
  'solution.pixel_scale',
  'solution.stars_matched',
  'solution.confidence',
  'deep_confirmed.setGatePassed',
];
const MISSING = 'MISSING';

function die(msg, code = 1) { process.stderr.write(`[api/run] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const a = { select: null, out: null, config: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--select') a.select = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--config') a.config = argv[++i];
    else if (t.startsWith('--')) die(`unknown flag: ${t}`);
    else a._.push(t);
  }
  return a;
}

// Dot-path projection: returns the value (which may legitimately be null) or the
// MISSING sentinel when any path segment is absent. Never fabricates a value.
function project(root, dotPath) {
  let cur = root;
  for (const key of dotPath.split('.')) {
    if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key];
    else return MISSING;
  }
  return cur;
}

const a = parseArgs(process.argv.slice(2));
const fitsArg = a._[0];
if (!fitsArg) die('usage: node tools/api/run.mjs [--select a.b,c.d] [--out <dir>] <fits-path>');
const fitsPath = path.resolve(fitsArg);
if (!fs.existsSync(fitsPath)) die(`FITS input not found: ${fitsPath}`);
if (!/\.(fit|fits|fts)$/i.test(fitsPath)) die(`FITS lane only — not a .fit/.fits/.fts file: ${fitsPath}`);

// Validate --config JSON here so a typo fails LOUD before we fork the solve. The
// flat {KEY:value} object is forwarded to the runspec, which calls applyConfigOverrides.
let configJson = null;
if (a.config != null) {
  let parsed;
  try { parsed = JSON.parse(a.config); }
  catch (e) { die(`--config is not valid JSON: ${e.message}`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die('--config must be a JSON object of {CONSTANT_NAME: value} overrides');
  }
  configJson = JSON.stringify(parsed);
}

const outDir = a.out ? path.resolve(a.out) : DEFAULT_OUT;
fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(fitsPath).replace(/\.(fit|fits|fts)$/i, '');
const receiptPath = path.join(outDir, `${base}.receipt.json`);

// Run the REAL pipeline under vitest — captured (NOT inherited) so our stdout
// stays projection-only; vitest's own output is forwarded to stderr only on failure.
const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', RUN_CONFIG], {
  // 256MB maxBuffer: verbose blind solves exceed Node's 1MB default, which
  // SIGTERM-kills the child mid-frame (ENOBUFS misread as a crash; 2026-07-17 harvest incident)
  cwd: ROOT, encoding: 'utf8', timeout: 360_000, maxBuffer: 256 * 1024 * 1024,
  env: {
    ...process.env,
    API_RUN_FITS: fitsPath,
    API_RUN_RECEIPT_OUT: receiptPath,
    ...(configJson ? { API_RUN_CONFIG: configJson } : {}),
  },
});
if (res.status !== 0 || !fs.existsSync(receiptPath)) {
  process.stderr.write((res.stdout || '') + (res.stderr || '') + '\n');
  // Infra failure (process kill / OOM / spawnSync ETIMEDOUT / spec throw) lands
  // NOTHING on the normal path — bank a DISTINCT crash record so the frame is
  // never silently dropped and can never be mistaken for a scientific no-solve
  // (LAW 3 honest-or-absent). Never-fatal: a crash-write failure must not mask
  // the original failure or change the exit code.
  const crashPath = path.join(outDir, `${base}.crash.json`);
  try {
    writeCrashRecord({ crashPath, inputPath: fitsPath, receiptPath, res });
    process.stderr.write(`[api/run] crash record → ${path.relative(ROOT, crashPath)}\n`);
  } catch (e) {
    process.stderr.write(`[api/run] WARN: could not write crash record ${crashPath}: ${e.message}\n`);
  }
  const errCode = res.error && res.error.code != null ? res.error.code : null;
  die(`pipeline run failed (vitest exit ${res.status}; signal=${res.signal ?? 'none'}; error=${errCode ?? 'none'}); no receipt at ${receiptPath}`);
}

let receipt;
try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
catch (e) { die(`could not parse receipt ${receiptPath}: ${e.message}`); }

const solved = receipt.solution != null;
const paths = a.select ? a.select.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SELECT;
const out = { solved };
for (const p of paths) out[p] = project(receipt, p);

// stdout = projection JSON ONLY (machine-readable); the artifact breadcrumb + the
// verdict go to stderr so they never contaminate a piped `| jq`.
process.stderr.write(`[api/run] full receipt → ${path.relative(ROOT, receiptPath)}  (${solved ? 'SOLVED' : 'NO-SOLVE'})\n`);
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(solved ? 0 : 2);
