// CLI: check_graduation <candidate_id> [--ledger-dir <dir>]
//   Reads the append-only ledger and prints the mechanical per-image-type tally
//   + verdict, and the GLOBAL verdict. Pure read — never mutates evidence.
//
//   node tools/validation/check_graduation.ts synthetic_solver

import { pathToFileURL } from 'node:url';
import { getCandidate } from './registry.ts';
import { Ledger } from './ledger.ts';
import { check } from './policy.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: check_graduation <candidate_id> [--ledger-dir <dir>]');
    process.exit(2);
  }
  const candidate = getCandidate(id);
  if (!candidate) {
    console.error(`unknown candidate '${id}'. See list_candidates.ts`);
    process.exit(2);
  }
  const ledgerDir = arg('--ledger-dir');
  const ledger = ledgerDir ? new Ledger(id, ledgerDir) : new Ledger(id);
  const trials = ledger.read();
  const report = check(candidate, trials);

  console.log(`graduation check — ${id}  (${trials.length} distinct inputs logged)`);
  console.log(`  ${'image_type'.padEnd(14)} ${'verdict'.padEnd(18)} n/N_min  +imp/-reg`);
  for (const p of report.perType) {
    const na = p.applicable ? '' : '  (not applicable)';
    console.log(
      `  ${p.image_type.padEnd(14)} ${p.verdict.padEnd(18)} ${String(p.n).padStart(2)}/${String(p.n_min).padStart(2)}    +${p.improvements}/-${p.regressions}${na}`,
    );
  }
  console.log(`  ${'GLOBAL'.padEnd(14)} ${report.global}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
