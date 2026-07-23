#!/usr/bin/env node
// Corpus intake auditor (ADVISORY) — reports per-lane frame counts + DISK
// FOOTPRINT, the dev-drive free space, protects the TRUTH set, and FLAGS large
// files for the OWNER's deletion decision. The real constraint is DISK SPACE,
// not file count (100+ small frames is fine). It NEVER deletes and NEVER blocks
// (exit 0). The algorithmic purge of *passing rotating* frames is a separate
// action on the rotating run, not this tool. Policy: docs/CORPUS_INTAKE.md.
//   node tools/corpus/intake_guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMG_EXT = new Set(['.cr2', '.nef', '.arw', '.pef', '.fit', '.fits', '.xisf']);
const BIG_GB = 0.5;      // flag single frames larger than this for deletion review
const LOW_FREE_GB = 20;  // warn when dev-drive free space drops below this
const BUDGET_GB = 20;    // soft total-corpus footprint target (rotating churns to stay under)

const LANES = [
  { name: 'TRUTH',     dir: 'Sample Files/truth',     note: 'fixed regression anchors — protected' },
  { name: 'ROTATING',  dir: 'Sample Files/rotating',  note: 'novel + robustness churn (passing frames self-purge)' },
  { name: 'CHALLENGE', dir: 'Sample Files/challenge',  note: 'slow/hard — deliberate pass only' },
  { name: 'ARCHIVE',   dir: 'Sample Files/archive',   note: 'large holds — kept, flag when exhausted' },
  { name: 'legacy',    dir: 'Sample Files/corpus',    note: 'pre-policy unsorted — reorganize into lanes' },
];

function scan(dir) {
  const out = [];
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return null; // lane absent
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (IMG_EXT.has(path.extname(e.name).toLowerCase())) out.push({ p, gb: fs.statSync(p).size / 1e9 });
    }
  })(abs);
  return out;
}

const f2 = n => n.toFixed(2);
console.log('\nCorpus intake audit (ADVISORY — reports + flags, never deletes)   docs/CORPUS_INTAKE.md\n');
let grand = 0;
const flags = [];
for (const lane of LANES) {
  const s = scan(lane.dir);
  if (s === null) { console.log(`  ${lane.name.padEnd(10)}  (absent)`); continue; }
  const gb = s.reduce((a, f) => a + f.gb, 0);
  grand += gb;
  console.log(`  ${lane.name.padEnd(10)} ${String(s.length).padStart(4)} frames  ${f2(gb).padStart(7)} GB   ${lane.note}`);
  for (const f of s) if (f.gb > BIG_GB) flags.push(`${f2(f.gb)} GB  ${path.relative(ROOT, f.p)}  [${lane.name}]`);
}
console.log(`  ${'-'.repeat(64)}`);
console.log(`  TOTAL corpus footprint: ${f2(grand)} GB  (soft budget ${BUDGET_GB} GB${grand > BUDGET_GB ? ' — OVER: purge cleared rotating frames before new intake' : ''})`);
try {
  const st = fs.statfsSync(ROOT);
  const freeGb = (st.bfree * st.bsize) / 1e9;
  console.log(`  Dev-drive free space:   ${f2(freeGb)} GB${freeGb < LOW_FREE_GB ? '   [LOW]' : ''}`);
} catch { console.log('  Dev-drive free space:   NOT MEASURED (statfs unavailable)'); }

console.log('');
if (flags.length) {
  console.log(`FLAGGED for owner deletion-review (single files > ${BIG_GB} GB — NOT deleted):`);
  for (const f of flags) console.log('  • ' + f);
  console.log('');
}
console.log('Advisory only — constraint is disk space, not file count. Deletion is owner (or rotating auto-purge on pass).\n');
