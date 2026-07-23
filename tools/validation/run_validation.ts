// CLI: run_validation <candidate_id> [--force] [--ledger-dir <dir>]
//   Runs each input OFF then ON via the binding and appends trials (idempotent).
//   Only the SYNTHETIC candidate is wired with a live runFn here — the real
//   candidates' A/B runs on the calibrated path are ORCHESTRATOR-OWNED.
//
//   node tools/validation/run_validation.ts synthetic_solver
//   node tools/validation/run_validation.ts synthetic_solver --force

import { pathToFileURL } from 'node:url';
import { getCandidate } from './registry.ts';
import { run } from './runner.ts';
import { check } from './policy.ts';
import { Ledger } from './ledger.ts';
import { SYNTHETIC_INPUTS, syntheticRunFn } from './candidates/synthetic.ts';
import type { RunFn, RunInput } from './types.ts';

/** Live run wiring. Real solver candidates are intentionally absent (calibrated path). */
const WIRED: Record<string, { runFn: RunFn; inputs: RunInput[] }> = {
  synthetic_solver: { runFn: syntheticRunFn, inputs: SYNTHETIC_INPUTS },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: run_validation <candidate_id> [--force] [--ledger-dir <dir>]');
    process.exit(2);
  }
  const candidate = getCandidate(id);
  if (!candidate) {
    console.error(`unknown candidate '${id}'. See list_candidates.ts`);
    process.exit(2);
  }
  const wired = WIRED[id];
  if (!wired) {
    console.error(
      `candidate '${id}' has no wired live runFn — its A/B is orchestrator-owned\n` +
        `(calibrated path: env-override on the real config site + the real sweeps).\n` +
        `binding: ${candidate.binding.envVar}  OFF=${candidate.binding.offValue} ON=${candidate.binding.onValue}`,
    );
    process.exit(3);
  }

  const ledgerDir = arg('--ledger-dir');
  const force = process.argv.includes('--force');
  const ledger = ledgerDir ? new Ledger(id, ledgerDir) : new Ledger(id);

  const summary = await run(candidate, wired.inputs, wired.runFn, { force, ledger });
  console.log(`[${id}] ran ${summary.ran.length}, skipped ${summary.skipped.length}`);
  if (summary.ran.length) console.log(`  ran:     ${summary.ran.join(', ')}`);
  if (summary.skipped.length) console.log(`  skipped: ${summary.skipped.join(', ')} (already logged)`);

  const report = check(candidate, ledger.read());
  console.log(`\nverdict — ${id}`);
  for (const p of report.perType) {
    console.log(
      `  ${p.image_type.padEnd(14)} ${p.verdict.padEnd(18)} n=${p.n}/${p.n_min} +${p.improvements}/-${p.regressions}`,
    );
  }
  console.log(`  GLOBAL         ${report.global}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
