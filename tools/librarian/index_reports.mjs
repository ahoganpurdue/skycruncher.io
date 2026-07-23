// index_reports.mjs — build / reconcile the REPORTS librarian's LanceDB card
// catalog (table `report_chunks`, same store as doc_chunks/code_chunks).
//
// LIVENESS (v1, MANUAL — no git hook): the three roots this corpus walks are
// gitignored inside a tracked repo (ASTROLOGIC_DEPLOY/test_results,
// rest-integration/test_results) or entirely outside any repo
// (D:/AstroLogic/test_artifacts). A commit-driven hook cannot observe changes to
// files no commit ever touches, so `hook_postcommit.mjs` is UNCHANGED — reports
// liveness is a manual `node index_reports.mjs` re-run (fast: a plain filesystem
// walk of a few hundred files, then a hash-diff upsert — no git diff needed
// because there is no git history to diff against).
//
// Modes:
//   node index_reports.mjs          reconcile (default) — full fs walk, then
//                                    hash-skip unchanged / upsert changed+new /
//                                    remove rows for files no longer on disk
//   node index_reports.mjs --full   hard drop+recreate (matches docs/code's
//                                    `runFull` semantics; use after a schema
//                                    change or if the table needs a clean rebuild)

import { existsSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { repoRoot, lanceDir } from './lib/corpus.mjs';
import {
  listReportFiles,
  buildReportRowsForFile,
  reportDisplayPath,
  REPORTS_TABLE_NAME,
} from './lib/reports_corpus.mjs';

const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function runFull(root = repoRoot()) {
  const files = listReportFiles(root);
  const rows = [];
  for (const f of files) rows.push(...buildReportRowsForFile(f));
  const dir = lanceDir(root);
  const db = await lancedb.connect(dir);
  const names = await db.tableNames();
  if (names.includes(REPORTS_TABLE_NAME)) await db.dropTable(REPORTS_TABLE_NAME);
  await db.createTable(REPORTS_TABLE_NAME, rows);
  return { mode: 'full', table: REPORTS_TABLE_NAME, files: files.length, chunks: rows.length };
}

// Reconcile: fresh filesystem walk vs the existing table, keyed on the composite
// `path` (rootId:relPath). Per file: hash-skip if unchanged, else delete+reinsert
// its rows (upsert). Any table row whose path was not seen on this walk gets
// deleted (the file was removed/moved since the last index).
export async function runReconcile(root = repoRoot()) {
  const dir = lanceDir(root);
  const db = await lancedb.connect(dir);
  if (!existsSync(dir) || !(await db.tableNames()).includes(REPORTS_TABLE_NAME)) {
    return runFull(root);
  }
  const table = await db.openTable(REPORTS_TABLE_NAME);
  const files = listReportFiles(root);

  const seenPaths = new Set();
  let inserted = 0;
  let upserted = 0;
  let skipped = 0;
  for (const f of files) {
    const displayPath = reportDisplayPath(f);
    seenPaths.add(displayPath);
    const rows = buildReportRowsForFile(f);
    const newHash = rows[0]?.file_hash;
    const existing = await table.query().where(`path = ${sqlLit(displayPath)}`).limit(1).toArray();
    const oldHash = existing.length ? existing[0].file_hash : null;
    if (oldHash && newHash && oldHash === newHash) {
      skipped++;
      continue; // unchanged content — hash-skip
    }
    await table.delete(`path = ${sqlLit(displayPath)}`);
    if (rows.length) await table.add(rows);
    if (oldHash) upserted++; else inserted++;
  }

  // Remove rows for files no longer present on any root (deleted/moved since
  // the last reconcile). A full scan of stored paths is cheap at this corpus size.
  const allRows = await table.query().toArray();
  const storedPaths = new Set(allRows.map((r) => r.path));
  let removed = 0;
  for (const p of storedPaths) {
    if (!seenPaths.has(p)) {
      await table.delete(`path = ${sqlLit(p)}`);
      removed++;
    }
  }

  return {
    mode: 'reconcile',
    table: REPORTS_TABLE_NAME,
    files: files.length,
    inserted,
    upserted,
    skipped,
    removed,
  };
}

async function main() {
  const root = repoRoot();
  const args = process.argv.slice(2);
  const result = args.includes('--full') ? await runFull(root) : await runReconcile(root);
  console.log(JSON.stringify({ ok: true, lancedb: lanceDir(root), ...result }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index_reports.mjs')) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e?.stack || e) }));
    process.exit(1);
  });
}
