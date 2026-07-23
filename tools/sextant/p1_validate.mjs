#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/p1_validate.mjs — thin CLI over the P1 validation kernel
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/sextant/p1_validate.mjs --receipt <path/to/summary.json> [--trusted] [--out <json>]
//
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md — sextant P1 (validation sextant). Runs the
// PURE-COMPOSITION P1 verdict on a banked solve receipt: solved WCS + trusted UTC +
// claimed GPS → Alt/Az + Bennett refraction + a VALIDATE/REFUTE/REFUSE verdict with
// honest error propagation. Zero src/ diffs; COORDINATE ledger only.
//
// A plain .mjs cannot resolve the engine spherical-astronomy TS, so — exactly like
// tools/atmosphere/measure_sigma_star.mjs — this CLI parses args and spawns the REAL
// composition under vitest (p1_validate.config.ts + p1_validate.runspec.ts). The full
// P1Result lands on disk (--out); a summary projects to stdout.
//
// --trusted asserts the observation clock is trusted (echoing the ingest unset-clock
// forensics). WITHOUT it the clock is treated as UNTRUSTED and P1 refuses (a bogus
// clock rotates the alt-az frame → a wrong position; we refuse instead).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = 'tools/sextant/p1_validate.config.ts';

function parseArgs(argv) {
  const a = { receipt: null, trusted: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--receipt') a.receipt = argv[++i];
    else if (t === '--trusted') a.trusted = true;
    else if (t === '--out') a.out = argv[++i];
    else { process.stderr.write(`[sextant] unknown arg: ${t}\n`); process.exit(1); }
  }
  if (!a.receipt) { process.stderr.write('[sextant] --receipt <path> is required\n'); process.exit(1); }
  return a;
}

const a = parseArgs(process.argv.slice(2));
const receiptPath = path.resolve(a.receipt);
if (!fs.existsSync(receiptPath)) { process.stderr.write(`[sextant] receipt not found: ${receiptPath}\n`); process.exit(1); }
const outJson = a.out ? path.resolve(a.out) : path.join(ROOT, 'test_results', 'sextant', `p1_${path.basename(path.dirname(receiptPath)) || 'frame'}.json`);
fs.mkdirSync(path.dirname(outJson), { recursive: true });

const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', CONFIG], {
  cwd: ROOT, encoding: 'utf8', timeout: 180_000,
  env: {
    ...process.env,
    SEXTANT_RECEIPT: receiptPath,
    SEXTANT_OUT: outJson,
    SEXTANT_TRUSTED: a.trusted ? '1' : '0',
  },
});

// forward the kernel narrative
process.stderr.write((res.stdout || '').split('\n').filter(l => /\[p1\]/.test(l)).join('\n') + '\n');
if (res.status !== 0 || !fs.existsSync(outJson)) {
  process.stderr.write((res.stdout || '') + (res.stderr || '') + '\n');
  process.stderr.write(`[sextant] P1 run failed (vitest exit ${res.status}); no artifact at ${outJson}\n`);
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(outJson, 'utf8'));
const p = j.p1;
const summary = {
  frame: j.frame,
  status: p.status,
  predicate: p.predicate,
  timestamp_trust_source: j.timestamp_trust_source,
  claimed_gps: j.inputs.claimed_gps,
  boresight_altaz: p.boresight_altaz,
  airmass: p.airmass,
  refraction_arcsec: p.refraction_arcsec,
  boresight_to_zenith_deg: p.consistency.boresight_to_zenith_deg,
  derived_location: p.derived_location,
  attestation: p.attestation,
  artifact: path.relative(ROOT, outJson),
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);
