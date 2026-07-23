#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/atmosphere — fit_vertical.mjs : thin CLI over the runspec fit kernel
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/atmosphere/fit_vertical.mjs [--maglimit 7.0] [--out <dir>]
//
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md increment 2. Robust fit of (ZP,k,β,ẑ) on
// the bundled CR2's forced-photometry star table (built by lib/star_table.ts —
// the SAME table increment 1 measured), with honest identifiability guards.
//
// Like measure_sigma_star.mjs, a plain .mjs cannot resolve the engine `@/` alias
// or import AtmosphericManager/TimeService, so this CLI owns arg parsing and spawns
// the REAL fit under vitest (fit_vertical.config.ts + fit_vertical.runspec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = 'tools/atmosphere/fit_vertical.config.ts';

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
const outJson = path.join(outDir, 'fit_vertical_cr2.json');
const outSvg = path.join(outDir, 'fit_vertical_cr2.svg');

const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', CONFIG], {
  cwd: ROOT, encoding: 'utf8', timeout: 480_000,
  env: {
    ...process.env,
    ATM_FIT_OUT_JSON: outJson,
    ATM_FIT_OUT_SVG: outSvg,
    ...(a.maglimit ? { ATM_MAGLIMIT: a.maglimit } : {}),
  },
});
process.stderr.write((res.stdout || '').split('\n').filter(l => /\[(table|fit|synthetic|artifacts)/.test(l)).join('\n') + '\n');
if (res.status !== 0 || !fs.existsSync(outJson)) {
  process.stderr.write((res.stdout || '') + (res.stderr || '') + '\n');
  process.stderr.write(`[atmosphere] fit failed (vitest exit ${res.status}); no artifact at ${outJson}\n`);
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(outJson, 'utf8'));
const summary = {
  band: j.band,
  n_stars_used: j.n_stars_used,
  zenith_MEASURED: j.zenith_hat.MEASURED,
  boresight_offset_deg: j.zenith_hat.boresight_offset_deg,
  airmass_span_dX: j.airmass_span_dX,
  k_per_channel: j.k_per_channel,
  ellipse: j.zenith_hat.covariance_ellipse,
  beta_color_term: j.beta_color_term,
  NOT_MEASURED: Object.keys(j.NOT_MEASURED),
  artifacts: [path.relative(ROOT, outJson), path.relative(ROOT, outSvg)],
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);
