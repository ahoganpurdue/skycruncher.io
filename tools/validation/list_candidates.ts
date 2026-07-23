// CLI: list_candidates [--ledger-dir <dir>]
//   The registry manifest — every candidate + per-image-type state (OFF/EVAL/ON)
//   and latest verdict (from the ledger if evidence exists, else the honest
//   declared seed verdict).
//
//   node tools/validation/list_candidates.ts

import { pathToFileURL } from 'node:url';
import { summarizeAll } from './registry.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const ledgerDir = arg('--ledger-dir');
  const summaries = ledgerDir ? summarizeAll(ledgerDir) : summarizeAll();

  console.log('validation registry — candidates + per-image-type state\n');
  for (const s of summaries) {
    console.log(`● ${s.id}  [${s.domain}]  GLOBAL=${s.global}  (${s.ledger_inputs} logged)`);
    console.log(`  ${s.description}`);
    for (const p of s.perType) {
      console.log(`    ${p.image_type.padEnd(14)} state=${p.state.padEnd(4)} verdict=${p.verdict.padEnd(18)} n=${p.n}`);
    }
    console.log('');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
