// hook_postcommit.mjs — git post-commit / post-merge driver for librarian liveness.
//
// Liveness is GIT-EVENT-DRIVEN ONLY. There is deliberately NO file-watcher daemon
// on this box (standing-daemon leak class + the chokidar × junctioned-worktree
// trap are both documented incidents). This script runs from a git hook and does
// an incremental upsert of the just-committed corpus files — for BOTH catalogs
// (doc_chunks via index_docs.mjs, code_chunks via index_code.mjs). Each indexer
// filters the changed-file list to its own corpus membership, so a docs-only or
// code-only commit only touches the relevant table (measured incremental upsert
// of a commit-sized code delta: ~1.3 s, well under the 5 s budget).
//
// GATE: hooks fire in EVERY worktree of a shared repo. This script indexes ONLY
// in the canonical checkout — it compares `git rev-parse --show-toplevel` against
// a configured canonical root and exits SILENTLY (0) everywhere else, so agent
// worktrees never race to rebuild the owner's catalog.
//
// Configure the canonical root via env LIBRARIAN_CANONICAL_ROOT, else the
// CANONICAL_ROOT_DEFAULT constant below. If neither resolves to this checkout,
// the hook is a no-op.
//
// INSTALL (owner/orchestrator step, AFTER review — do NOT self-install):
//   printf '#!/bin/sh\nnode "$(git rev-parse --show-toplevel)/tools/librarian/hook_postcommit.mjs"\n' \
//     > .git/hooks/post-commit && chmod +x .git/hooks/post-commit
//   (repeat for .git/hooks/post-merge)

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Owner edits this (or sets LIBRARIAN_CANONICAL_ROOT) at wire-up time.
const CANONICAL_ROOT_DEFAULT = path.resolve(HERE, '..', '..');

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function toplevel() {
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function main() {
  const canonical = process.env.LIBRARIAN_CANONICAL_ROOT || CANONICAL_ROOT_DEFAULT;
  const here = toplevel();
  if (!here || norm(here) !== norm(canonical)) {
    // Not the canonical checkout (or not a repo) — silent no-op by design.
    process.exit(0);
  }
  // Thin driver: delegate to BOTH incremental indexers for HEAD's corpus files.
  // Each self-filters to its own membership; a non-zero exit from either surfaces.
  let status = 0;
  for (const script of ['index_docs.mjs', 'index_code.mjs']) {
    const res = spawnSync('node', [path.join(HERE, script), '--changed'], { cwd: here, stdio: 'inherit' });
    if ((res.status ?? 0) !== 0) status = res.status;
  }
  process.exit(status);
}

main();
