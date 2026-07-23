// index_code.mjs — build / upsert the CODE librarian's LanceDB card catalog.
//
// Storage: table `code_chunks` in the SAME tools/librarian/.lancedb/ as the docs
// catalog (doc_chunks) — one DB keeps hook wiring unified; the tables never mix
// (separate corpus, separate refusal threshold). Columns mirror doc_chunks:
// path, heading, lines_start, lines_end, text, class, authority_weight,
// last_commit, file_hash — PLUS the additive provenance pair {checkout, branch}.
// `vector` is ABSENT in v1 (lexical-only).
//
// MULTI-CHECKOUT (2026-07-18): a FULL build indexes EVERY working tree returned by
// codeRoots() — the main ASTROLOGIC_DEPLOY checkout AND the sibling
// rest-integration checkout (restoration branch), silently skipping any that are
// absent on this box. The LanceDB row key is the COMPOSITE (path, checkout): two
// trees may hold the same relative path, so every delete/hash lookup is scoped by
// BOTH so a main-tree change never clobbers a rest-tree row (disambiguation is
// load-bearing, never silent mixing).
//
// Modes (identical CLI to index_docs.mjs):
//   node index_code.mjs                 full rebuild of ALL checkouts (default)
//   node index_code.mjs --changed       incremental upsert of git diff HEAD~1..HEAD
//                                        (main checkout only — the hook's tree)
//   node index_code.mjs <path> [path…]  incremental upsert of the named files
//
// The full rebuild is the ONE-COMMAND refresh that covers both checkouts (run it
// after a rest-integration commit; a rest-side git hook is an owner wire-up step —
// see hook_postcommit.mjs). Incremental upsert = per file, delete its rows then
// reinsert its chunks — UNLESS the file's sha256 already matches the stored hash
// (hash-skip). Generated / zero-chunk files reinsert nothing.
//
// NEVER import this (or @lancedb/lancedb) from the vite app bundle — tools-lane
// native Node-only.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { repoRoot, lanceDir } from './lib/corpus.mjs';
import {
  listCodeCorpusFiles,
  isCodeCorpusMember,
  buildCodeRowsForFile,
  codeRoots,
  checkoutForRoot,
  CODE_TABLE_NAME,
} from './lib/code_corpus.mjs';

const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Composite-key predicate: a code row is uniquely a (path, checkout) pair.
const keyPred = (relPath, checkoutId) =>
  `path = ${sqlLit(relPath)} AND checkout = ${sqlLit(checkoutId)}`;

// Existing file_hash for a (path, checkout) pair (or null if it has no rows yet).
async function existingHash(table, relPath, checkoutId) {
  const rows = await table.query().where(keyPred(relPath, checkoutId)).limit(1).toArray();
  return rows.length ? rows[0].file_hash : null;
}

// Full rebuild across EVERY present checkout. The .lancedb store always lives
// under the main deployRoot (never moves); rest-integration files are read from
// their own tree but stored in the same table, tagged by checkout.
export async function runFull(deployRoot = repoRoot()) {
  const roots = codeRoots(deployRoot);
  const rows = [];
  let scanned = 0;
  const perCheckout = {};
  for (const r of roots) {
    const checkout = { id: r.id, branch: r.branch };
    const files = listCodeCorpusFiles(r.dir);
    let cChunks = 0;
    for (const f of files) {
      const built = buildCodeRowsForFile(r.dir, f, checkout);
      scanned++;
      cChunks += built.length;
      rows.push(...built);
    }
    perCheckout[r.id] = { branch: r.branch, files: files.length, chunks: cChunks };
  }
  const dir = lanceDir(deployRoot);
  const db = await lancedb.connect(dir);
  const names = await db.tableNames();
  if (names.includes(CODE_TABLE_NAME)) await db.dropTable(CODE_TABLE_NAME);
  await db.createTable(CODE_TABLE_NAME, rows);
  return { mode: 'full', table: CODE_TABLE_NAME, files: scanned, chunks: rows.length, checkouts: perCheckout };
}

// Incremental upsert of files WITHIN one checkout (default: the main tree the
// hook runs in). `root` is that checkout's working-tree dir; deletes/hash lookups
// are scoped by its resolved checkout id so sibling-tree rows are never touched.
export async function runIncremental(root, relPaths, deployRoot = repoRoot()) {
  const dir = lanceDir(deployRoot);
  const db = await lancedb.connect(dir);
  const checkout = checkoutForRoot(deployRoot, root);

  // Bootstrap: no table yet -> a partial upsert is meaningless; full build
  // (covers ALL checkouts, not just this one — the store starts complete).
  if (!existsSync(dir) || !(await db.tableNames()).includes(CODE_TABLE_NAME)) {
    return runFull(deployRoot);
  }
  const table = await db.openTable(CODE_TABLE_NAME);

  let upserted = 0;
  let skipped = 0;
  let removed = 0;
  for (const rel of relPaths) {
    if (!isCodeCorpusMember(rel)) continue;
    if (!existsSync(`${root}/${rel}`)) {
      await table.delete(keyPred(rel, checkout.id));
      removed++;
      continue;
    }
    const rows = buildCodeRowsForFile(root, rel, checkout);
    const newHash = rows[0]?.file_hash;
    const oldHash = await existingHash(table, rel, checkout.id);
    if (oldHash && newHash && oldHash === newHash) {
      skipped++;
      continue; // unchanged content — hash-skip
    }
    await table.delete(keyPred(rel, checkout.id));
    if (rows.length) await table.add(rows);
    upserted++;
  }
  return { mode: 'incremental', table: CODE_TABLE_NAME, checkout: checkout.id, upserted, skipped, removed };
}

function changedFilesFromGit(root) {
  const out = execFileSync('git', ['-C', root, 'diff', '--name-only', 'HEAD~1..HEAD'], {
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter(isCodeCorpusMember);
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index_code.mjs')) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e?.stack || e) }));
    process.exit(1);
  });
}
