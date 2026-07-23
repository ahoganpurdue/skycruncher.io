#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/atmosphere — measure_sigma_star.mjs : thin CLI over the runspec kernel
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/atmosphere/measure_sigma_star.mjs [--maglimit 7.0] [--out <dir>]
//
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md increment 1. Measures σ_star(mag[,X]) on
// the bundled CR2 via forced photometry at catalog positions, per channel + band.
//
// A plain .mjs cannot resolve the engine `@/` alias or import the TS
// forcedMeasure/computeAirMass/computeAltAz, so — exactly like tools/api/run.mjs —
// this CLI owns arg parsing + projection and spawns the REAL measurement under
// vitest (measure_sigma_star.config.ts + measure_sigma_star.runspec.ts). Artifacts
// land on disk; only the headline σ table is projected to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = 'tools/atmosphere/measure_sigma_star.config.ts';

function parseArgs(argv) {
  const a = { maglimit: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--maglimit') a.maglimit = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else { process.stderr.write(`[atmosphere] unknown arg: ${t}\n`); process.exit(1); }
  }
  return a;
}

const a = parseArgs(process.argv.slice(2));
const outDir = a.out ? path.resolve(a.out) : path.join(ROOT, 'test_results', 'atmosphere');
fs.mkdirSync(outDir, { recursive: true });
const outJson = path.join(outDir, 'sigma_star_cr2.json');
const outSvg = path.join(outDir, 'sigma_star_cr2.svg');

const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', CONFIG], {
  cwd: ROOT, encoding: 'utf8', timeout: 420_000,
  env: {
    ...process.env,
    ATM_OUT_JSON: outJson,
    ATM_OUT_SVG: outSvg,
    ...(a.maglimit ? { ATM_MAGLIMIT: a.maglimit } : {}),
  },
});
// forward the kernel's console (measurement narrative) to stderr
process.stderr.write((res.stdout || '').split('\n').filter(l => /\[(decode|frame|catalog|geometry|match|saturation|forced|photometry|σ_star|artifacts)/.test(l)).join('\n') + '\n');
if (res.status !== 0 || !fs.existsSync(outJson)) {
  process.stderr.write((res.stdout || '') + (res.stderr || '') + '\n');
  process.stderr.write(`[atmosphere] measurement failed (vitest exit ${res.status}); no artifact at ${outJson}\n`);
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(outJson, 'utf8'));
const summary = {
  n_usable_rows: j.exit_gate.n_per_channel,
  met_200: j.exit_gate.met_200,
  band_counts: j.counts.band,
  sigma_overall: j.sigma_overall,
  cfa_checkerboard_contribution_mag: j.cfa_checkerboard_contribution_mag,
  x_axis_measured: j.x_axis.measured,
  NOT_MEASURED: Object.keys(j.NOT_MEASURED),
  artifacts: [path.relative(ROOT, outJson), path.relative(ROOT, outSvg)],
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);
