// CLI: grade_tools [--candidate <id>] [--image-type <T>] [--ledger-dir <dir>]
//   The efficiency×effectiveness profile per (tool, image_type): lock-rate,
//   median σ, median ms + median cost (APPROXIMATE), combined grade. Reads one
//   candidate's ledger, or ALL candidate ledgers if --candidate is omitted.
//   This is the SUBSTRATE for a future hint-driven tool SEQUENCER.
//
//   node tools/validation/grade_tools.ts --candidate synthetic_solver
//   node tools/validation/grade_tools.ts --image-type CR2_DSLR

import { pathToFileURL } from 'node:url';
import { CANDIDATES, getCandidate } from './registry.ts';
import { Ledger } from './ledger.ts';
import { gradeTools } from './grade.ts';
import type { Trial } from './types.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(n: number | null, digits = 1): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

function main(): void {
  const candId = arg('--candidate');
  const imageType = arg('--image-type');
  const ledgerDir = arg('--ledger-dir');

  const ids = candId ? [candId] : CANDIDATES.map((c) => c.id);
  if (candId && !getCandidate(candId)) {
    console.error(`unknown candidate '${candId}'. See list_candidates.ts`);
    process.exit(2);
  }

  const trials: Trial[] = [];
  for (const id of ids) {
    const ledger = ledgerDir ? new Ledger(id, ledgerDir) : new Ledger(id);
    trials.push(...ledger.read());
  }

  const report = gradeTools(trials, imageType);
  const scope = candId ? `candidate=${candId}` : 'all candidates';
  console.log(`tool grades — ${scope}${imageType ? `  image_type=${imageType}` : ''}  (${trials.length} trials)`);
  console.log(`  ${report.note}`);
  console.log(
    `  ${'tool'.padEnd(24)} ${'image_type'.padEnd(14)} lock%  medσ   med_ms  med_cost  eff   grade`,
  );
  if (report.rows.length === 0) {
    console.log('  (no locking trials — nothing to grade)');
  }
  for (const r of report.rows) {
    console.log(
      `  ${r.tool.padEnd(24)} ${r.image_type.padEnd(14)} ` +
        `${(r.lock_rate * 100).toFixed(0).padStart(3)}%  ` +
        `${fmt(r.median_sigma).padStart(4)}  ` +
        `${fmt(r.median_ms, 0).padStart(6)}  ` +
        `${fmt(r.median_cost, 0).padStart(7)}  ` +
        `${r.efficiency.toFixed(2)}  ${r.grade}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
