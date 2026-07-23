// Reports-corpus enumeration + chunking + metadata for the REPORTS librarian
// (third corpus, table `report_chunks`). Indexes the project's frozen one-shot
// docs/research that live GITIGNORED next to their run artifacts under
// test_results/**/*.md — NOT reachable by `git ls-files` (doc_chunks/code_chunks'
// enumeration strategy) because these files carry no git history at all: two of
// the three roots are gitignored inside a tracked repo, the third
// (D:/AstroLogic/test_artifacts) is entirely outside any repo. Enumeration is
// therefore a plain FILESYSTEM WALK, and `mtime` (not `last_commit`) is the
// freshness signal — recorded per chunk alongside root id + relative path so a
// result can point back to its exact file on disk.
//
// Reuses `chunkMarkdown` from lib/corpus.mjs unchanged (heading-anchored
// chunking is format-specific, not source-specific).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chunkMarkdown } from './corpus.mjs';

export const REPORTS_TABLE_NAME = 'report_chunks';

// Frozen one-shot artifacts: real evidence, but unreviewed/uncurated relative to
// tracked docs — same tier logic as the code corpus's TEST class. mtime backs
// freshness, not editorial review, so this sits below every tracked-docs class.
export const REPORTS_AUTHORITY = 0.85;
export function reportsAuthorityWeight() {
  return REPORTS_AUTHORITY;
}

const MAX_FILE_BYTES = 1024 * 1024; // 1MB — skip anything larger (bulk dumps, not reports)
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.lancedb',
  // dirs that hold BULK run artifacts (large binary/data siblings), not reports —
  // even though this walk only picks up *.md, skipping the dir avoids descending
  // into thousands of sibling binary entries for no payoff.
  'decoded', 'seams', 'wcs', 'logs',
]);

// The three roots, each tagged with a short rootId used in the composite `path`
// (`<rootId>:<relPath>`) so two roots can never collide on the same relative
// path. Overridable via env for a different box layout; silently skipped if a
// root does not exist on this machine (own-box heterogeneity, e.g. no D: drive).
export function reportRoots(deployRoot) {
  const roots = [
    { id: 'ASTROLOGIC_DEPLOY', dir: path.join(deployRoot, 'test_results') },
    {
      id: 'rest-integration',
      dir: process.env.LIBRARIAN_REST_INTEGRATION_ROOT
        ? path.join(process.env.LIBRARIAN_REST_INTEGRATION_ROOT, 'test_results')
        : path.resolve(deployRoot, '..', 'rest-integration', 'test_results'),
    },
    {
      id: 'test_artifacts',
      dir: process.env.LIBRARIAN_TEST_ARTIFACTS_ROOT || 'D:/AstroLogic/test_artifacts',
    },
  ];
  return roots.filter((r) => {
    try { return fs.statSync(r.dir).isDirectory(); } catch { return false; }
  });
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name.toLowerCase())) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

// Enumerate every eligible report file across all present roots. Sorted for
// determinism (`rootId:relPath` order — matches the composite path used as the
// LanceDB row key).
export function listReportFiles(deployRoot) {
  const files = [];
  for (const r of reportRoots(deployRoot)) {
    const found = [];
    walk(r.dir, found);
    for (const abs of found) {
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue; // HARD EXCLUSION: >1MB
      const rel = path.relative(r.dir, abs).replace(/\\/g, '/');
      files.push({ rootId: r.id, rootDir: r.dir, abs, rel, mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => `${a.rootId}:${a.rel}`.localeCompare(`${b.rootId}:${b.rel}`));
  return files;
}

export function reportDisplayPath(fileMeta) {
  return `${fileMeta.rootId}:${fileMeta.rel}`;
}

// Build all LanceDB rows for one report file. `path` is the composite
// `rootId:relPath` key (unique across roots); `root_id`/`rel_path`/`abs_path`/
// `mtime` carry the provenance the brief asked for. `last_commit` is INTENTIONALLY
// absent (not '' — these files have no git history at all, so the field does not
// apply; '' on the docs/code tables means "uncommitted", a different honest state).
export function buildReportRowsForFile(fileMeta) {
  const text = fs.readFileSync(fileMeta.abs, 'utf8');
  const displayPath = reportDisplayPath(fileMeta);
  const file_hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const mtime = new Date(fileMeta.mtimeMs).toISOString();
  return chunkMarkdown(displayPath, text).map((c) => ({
    path: c.path,
    root_id: fileMeta.rootId,
    rel_path: fileMeta.rel,
    abs_path: fileMeta.abs,
    heading: c.heading,
    lines_start: c.lines_start,
    lines_end: c.lines_end,
    text: c.text,
    class: 'REPORT',
    authority_weight: REPORTS_AUTHORITY,
    mtime,
    file_hash,
    // vector column ABSENT (lexical-only), matching doc_chunks/code_chunks v1.
  }));
}
