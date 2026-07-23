// index_docs.mjs — build / upsert the librarian's LanceDB card catalog.
//
// Storage: one LanceDB table `doc_chunks` under tools/librarian/.lancedb/
// (gitignored, derived). Columns: path, heading, lines_start, lines_end, text,
// class, authority_weight, last_commit, file_hash. The `vector` column is ABSENT
// in v1 (lexical-only); the future semantic upgrade fills it + adds an ANN index.
//
// Modes:
//   node index_docs.mjs                 full rebuild (default; idempotent)
//   node index_docs.mjs --changed       incremental upsert of git diff HEAD~1..HEAD
//   node index_docs.mjs <path> [path…]  incremental upsert of the named corpus files
//
// Incremental upsert = for each file, delete all its rows then reinsert its
// chunks — UNLESS the file's sha256 already matches the stored hash (hash-skip).
//
// NEVER import this module (or @lancedb/lancedb) from the vite app bundle —
// it is a native Node-only tools-lane module.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import {
  repoRoot,
  listCorpusFiles,
  isCorpusMember,
  buildRowsForFile,
  lanceDir,
  TABLE_NAME,
} from './lib/corpus.mjs';

const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function openOrCreate(db, seedRows) {
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) return db.openTable(TABLE_NAME);
  // LanceDB infers the schema from the seed rows; every corpus file yields >=1.
  return db.createTable(TABLE_NAME, seedRows);
}

// Existing file_hash for a path (or null if the file has no rows yet).
async function existingHash(table, relPath) {
  const rows = await table.query().where(`path = ${sqlLit(relPath)}`).limit(1).toArray();
  return rows.length ? rows[0].file_hash : null;
}

export async function runFull(root = repoRoot()) {
  const files = listCorpusFiles(root);
  const rows = [];
  for (const f of files) rows.push(...buildRowsForFile(root, f));

  const dir = lanceDir(root);
  const db = await lancedb.connect(dir);
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) await db.dropTable(TABLE_NAME);
  await db.createTable(TABLE_NAME, rows);
  return { mode: 'full', files: files.length, chunks: rows.length };
}

export async function runIncremental(root, relPaths) {
  const dir = lanceDir(root);
  const db = await lancedb.connect(dir);

  // Bootstrap: if the table doesn't exist yet, a partial upsert is meaningless —
  // fall back to a full build so the catalog is complete.
  if (!existsSync(dir) || !(await db.tableNames()).includes(TABLE_NAME)) {
    return runFull(root);
  }
  const table = await db.openTable(TABLE_NAME);

  let upserted = 0;
  let skipped = 0;
  let removed = 0;
  for (const rel of relPaths) {
    if (!isCorpusMember(rel)) continue;
    const stillTracked = existsSync(`${root}/${rel}`);
    if (!stillTracked) {
      await table.delete(`path = ${sqlLit(rel)}`);
      removed++;
      continue;
    }
    const rows = buildRowsForFile(root, rel);
    const newHash = rows[0]?.file_hash;
    const oldHash = await existingHash(table, rel);
    if (oldHash && newHash && oldHash === newHash) {
      skipped++;
      continue; // unchanged content — hash-skip
    }
    await table.delete(`path = ${sqlLit(rel)}`);
    if (rows.length) await table.add(rows);
    upserted++;
  }
  return { mode: 'incremental', upserted, skipped, removed };
}

function changedFilesFromGit(root) {
  const out = execFileSync('git', ['-C', root, 'diff', '--name-only', 'HEAD~1..HEAD'], {
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter(isCorpusMember);
}

async function main() {
  const root = repoRoot();
  const args = process.argv.slice(2);
  let result;
  if (args.includes('--changed')) {
    result = await runIncremental(root, changedFilesFromGit(root));
  } else if (args.length > 0) {
    result = await runIncremental(root, args);
  } else {
    result = await runFull(root);
  }
  console.log(JSON.stringify({ ok: true, lancedb: lanceDir(root), ...result }));
}

// Run only when invoked directly (not when imported by the post-commit hook).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index_docs.mjs')) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e?.stack || e) }));
    process.exit(1);
  });
}
