// Corpus enumeration + chunking + metadata for the documentation librarian.
// Pure(ish): every function takes an explicit repoRoot; nothing depends on cwd
// (an agent's cwd resets between calls — resolve everything from an absolute
// repoRoot). Shared by index_docs.mjs and hook_postcommit.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/librarian/lib

// Repo root, resolved from THIS module's location (cwd-independent). tools/librarian/lib -> up 3.
export function repoRoot() {
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return path.resolve(HERE, '..', '..', '..');
  }
}

// ── Corpus membership ────────────────────────────────────────────────────────
// A tracked file is IN the corpus iff:
//   * it is README.md or CLAUDE.md at the repo root, OR
//   * docs/**/*.md that is NOT under docs/local/ or docs/archive/, OR
//   * any tools/**/README.md (tool-lane READMEs — superset of the brief's
//     tools/*/README.md; more pointers = a better card catalog).
// EXCLUDED forever: docs/local/** (owner-voice) and docs/archive/** (frozen).
export function isCorpusMember(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'README.md' || p === 'CLAUDE.md') return true;
  if (p.startsWith('docs/')) {
    if (p.startsWith('docs/local/') || p.startsWith('docs/archive/')) return false;
    return p.endsWith('.md');
  }
  if (p.startsWith('tools/') && /\/README\.md$/.test(p)) return true;
  return false;
}

// All tracked corpus files (git ls-files -> filter). Sorted for determinism.
export function listCorpusFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isCorpusMember)
    .sort();
}

// ── Classification + authority ───────────────────────────────────────────────
// Doc class from path + a peek at the file head (for the LEDGER marker comment).
// LAW-3-flavored ranking: GATES.md-class ledgers + CLAUDE.md routing outrank
// specs, which outrank narrative prose.
export function deriveClass(relPath, headText = '') {
  const p = relPath.replace(/\\/g, '/');
  const base = p.split('/').pop();
  if (p === 'CLAUDE.md') return 'CLAUDE';
  if (base === 'README.md') return 'README';
  // Explicit ledger marker wins over path/name heuristics (a *_SPEC that is
  // actually a data-contract ledger, e.g. COMMUNITY_DATABASE_SPEC).
  if (/<!--\s*LEDGER/i.test(headText)) return 'LEDGER';
  if (p.startsWith('docs/01-canonical/')) return 'CANONICAL';
  if (p.startsWith('docs/reference/') || /^CARD_/.test(base)) return 'REFERENCE';
  if (p.startsWith('docs/02-specs/') || /_(SPEC|DESIGN|PLAN|SCHEMA|POLICY)\.md$/i.test(base)) return 'spec';
  return 'narrative';
}

// Authority weight — a mild multiplier on the lexical score. Kept near 1.0 so
// relevance still dominates; authority only breaks near-ties toward the source
// of record. Documented in README.
const AUTHORITY = {
  CLAUDE: 1.25, // routing + laws — highest authority
  LEDGER: 1.20, // GATES.md-class: the numbers of record
  CANONICAL: 1.10,
  REFERENCE: 1.05,
  spec: 1.00,
  README: 0.95,
  narrative: 0.90,
};
export function authorityWeight(cls) {
  return AUTHORITY[cls] ?? 0.9;
}

// ── Metadata ─────────────────────────────────────────────────────────────────
export function fileSha256(root, relPath) {
  const buf = readFileSync(path.join(root, relPath));
  return createHash('sha256').update(buf).digest('hex');
}

// Last-commit ISO timestamp for a file. '' if never committed (untracked/new).
export function gitLastCommit(root, relPath) {
  try {
    return execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI', '--', relPath], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

// ── Chunking (heading-anchored) ──────────────────────────────────────────────
// Every markdown heading opens a new chunk that runs to the next heading. The
// chunk carries a breadcrumb heading-chain of its ancestor headings. Content
// before the first heading is a "(preamble)" chunk. Lines are 1-based inclusive.
export function chunkMarkdown(relPath, text) {
  const lines = text.split('\n');
  const base = relPath.replace(/\\/g, '/').split('/').pop();
  const chunks = [];
  const stack = []; // [{level, title}]
  let cur = null;

  const closeCur = (endLine) => {
    if (cur) {
      cur.lines_end = endLine;
      cur.text = lines.slice(cur.lines_start - 1, endLine).join('\n');
      chunks.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) {
      closeCur(i); // previous chunk ends on the line before this heading
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      cur = {
        path: relPath.replace(/\\/g, '/'),
        heading: stack.map((s) => s.title).join(' > '),
        lines_start: i + 1,
      };
    } else if (!cur && lines[i].trim() !== '') {
      // preamble content before the first heading
      cur = {
        path: relPath.replace(/\\/g, '/'),
        heading: `${base} (preamble)`,
        lines_start: i + 1,
      };
    }
  }
  closeCur(lines.length);
  // Drop chunks that are pure whitespace (heading-only chunks are KEPT — the
  // heading text itself is a searchable pointer).
  return chunks.filter((c) => c.text.trim() !== '');
}

// Build all LanceDB rows for one corpus file.
export function buildRowsForFile(root, relPath) {
  const abs = path.join(root, relPath);
  const text = readFileSync(abs, 'utf8');
  const head = text.slice(0, 800);
  const cls = deriveClass(relPath, head);
  const authority = authorityWeight(cls);
  const last_commit = gitLastCommit(root, relPath);
  const file_hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return chunkMarkdown(relPath, text).map((c) => ({
    path: c.path,
    heading: c.heading,
    lines_start: c.lines_start,
    lines_end: c.lines_end,
    text: c.text,
    class: cls,
    authority_weight: authority,
    last_commit,
    file_hash,
    // vector column is ABSENT in v1 — the semantic upgrade fills it later.
  }));
}

export const TABLE_NAME = 'doc_chunks';
export function lanceDir(root) {
  return path.join(root, 'tools', 'librarian', '.lancedb');
}
