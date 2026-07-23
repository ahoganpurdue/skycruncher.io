// Ledger backup (owner ruling 2026-07-11, D-proxy-questions-batch ⑦): the CANONICAL thesis
// registry + dashboard ledgers live in gitignored test_results/ — copy them to D: and S: at
// every session start (RPO ≈ one session, better than the approved nightly). Never deletes
// sources; prunes only its own dated backup dirs beyond RETAIN.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = [
  'test_results/theses/registry.jsonl',
  'test_results/theses/dashboard/owner_decisions.json',
  'test_results/theses/dashboard/owner_responses.jsonl',
  'test_results/agent_runs.jsonl',
  'docs/AGENT_TIMING_LOG.md',
];
const TARGETS = ['D:/AstroLogic/backups/ledgers', 'S:/ledgers_backup'];
const RETAIN = 14;

const stamp = new Date().toISOString().slice(0, 10);
let copied = 0, skippedTargets = 0;
for (const t of TARGETS) {
  try {
    const dir = path.join(t, stamp);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of SOURCES) {
      const src = path.join(ROOT, s);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(dir, path.basename(s)));
      copied++;
    }
    // prune own dated dirs beyond RETAIN (never touches anything else)
    const dated = fs.readdirSync(t).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of dated.slice(0, Math.max(0, dated.length - RETAIN))) {
      fs.rmSync(path.join(t, old), { recursive: true, force: true });
    }
  } catch (e) {
    skippedTargets++;
    console.error(`[backup_ledgers] target ${t} skipped: ${e.message}`);
  }
}
console.log(`[backup_ledgers] ${stamp}: ${copied} file-copies across ${TARGETS.length - skippedTargets}/${TARGETS.length} targets`);
