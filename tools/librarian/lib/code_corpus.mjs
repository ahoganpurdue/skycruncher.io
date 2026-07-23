// Code-corpus enumeration + chunking + metadata for the CODE librarian (second
// corpus, table `code_chunks`). Indexes the PROSE that lives in the code —
// comment banners, JSDoc, section headers, Rust /// docs — so concept-phrased
// code questions ("where do we correct star flux for vignette") resolve to a
// pointer that identifier-grep cannot reach. NOT identifier search, NOT an AST
// index (see docs/CODE_LIBRARIAN_SPEC.md).
//
// Pure(ish): every function takes an explicit repoRoot; nothing depends on cwd.
// Shares the docs lane's git/last-commit/lanceDir helpers. The BM25 ranker
// (query.mjs::rankChunks + lib/bm25.mjs) is corpus-agnostic and reused as-is.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gitLastCommit } from './corpus.mjs';

// Same per-checkout .lancedb, SEPARATE table (docs stay in doc_chunks). The
// refusal threshold is calibrated per-corpus — never a unified score.
export const CODE_TABLE_NAME = 'code_chunks';

const CODE_EXTS = new Set(['ts', 'tsx', 'mjs', 'js', 'rs', 'wgsl']);

// ── Multi-checkout roots (provenance-tagged) ─────────────────────────────────
// The code corpus spans TWO working trees of the same origin: the main
// ASTROLOGIC_DEPLOY checkout AND the sibling `rest-integration` checkout (the
// restoration branch). Both are enumerated independently by `git ls-files`; every
// row carries a `checkout` id + `branch` so a query result names WHICH tree it
// came from and the two trees' duplicate symbols never mix silently. The
// LanceDB row key is the COMPOSITE (path, checkout) — incremental upserts scope
// their delete by checkout so a main-tree change never clobbers a rest-tree row.
//
// rest-integration is silently skipped if absent on this box (own-box
// heterogeneity). Override its location with LIBRARIAN_REST_INTEGRATION_ROOT
// (same env var the reports corpus reads — it names the CHECKOUT root).
export const MAIN_CHECKOUT_ID = 'ASTROLOGIC_DEPLOY';

// Current branch of a checkout ('' on failure / detached — recorded honestly,
// never fabricated). Cheap: one git call per ROOT (not per file).
export function gitBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function isGitWorktree(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// The code-corpus working trees present on THIS box, each tagged {id, dir, branch}.
// deployRoot (repoRoot()) is always first; rest-integration is appended only when
// it resolves to a real git worktree. Order is deterministic.
export function codeRoots(deployRoot) {
  const restDir = process.env.LIBRARIAN_REST_INTEGRATION_ROOT
    ? path.resolve(process.env.LIBRARIAN_REST_INTEGRATION_ROOT)
    : path.resolve(deployRoot, '..', 'rest-integration');
  const candidates = [
    { id: MAIN_CHECKOUT_ID, dir: path.resolve(deployRoot) },
    { id: 'rest-integration', dir: restDir },
  ];
  return candidates
    .filter((r) => existsSync(r.dir) && isGitWorktree(r.dir))
    .map((r) => ({ ...r, branch: gitBranch(r.dir) }));
}

// The checkout descriptor for a given working-tree root (used when an incremental
// caller passes only the root dir — e.g. the post-commit hook, which always
// operates on the main checkout). Falls back to a bare basename id for an
// unrecognised root rather than guessing MAIN.
export function checkoutForRoot(deployRoot, root) {
  const abs = path.resolve(root);
  const match = codeRoots(deployRoot).find((r) => r.dir === abs);
  if (match) return { id: match.id, branch: match.branch };
  return { id: path.basename(abs) || MAIN_CHECKOUT_ID, branch: gitBranch(abs) };
}

// ── Corpus membership ────────────────────────────────────────────────────────
// A tracked file is IN the code corpus iff it lives under src/** or tools/**,
// has a code extension, and is not vendored (node_modules). git ls-files already
// excludes every gitignored path (wasm pkg/, dist/, target/), so those exclusions
// hold by construction; the @generated head-scan (see isGenerated) is the only
// exclusion git can't enforce on a *tracked* file.
export function isCodeCorpusMember(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p.includes('/node_modules/') || p.startsWith('node_modules/')) return false;
  // SELF-EXCLUSION: the librarian's own lane is the retrieval MACHINERY, not
  // subject-matter code, and its test fixtures/README examples embed deliberately
  // adversarial GARBAGE query strings ("how to bake sourdough bread at home" in
  // librarian.test.mjs; a "bake bread" comment in bm25.mjs). Indexing them poisons
  // the refusal separation with a self-referential false positive. The lane's prose
  // is already covered in the DOCS corpus (tools/librarian/README.md).
  if (p.startsWith('tools/librarian/')) return false;
  // crates/** = the greenfield Rust solver core (the REFERENCE ENGINE since the
  // 2026-07-21 cutover) — absent from the roots until the 2026-07-22 flag-review
  // day measured the gap (agents could not librarian their way into the engine).
  if (!(p.startsWith('src/') || p.startsWith('tools/') || p.startsWith('crates/'))) return false;
  const ext = p.split('.').pop().toLowerCase();
  return CODE_EXTS.has(ext);
}

// Generated-but-tracked exclusion (head-scan). git ls-files DOES list these
// (they are tracked); a @generated / autogenerated / "DO NOT EDIT" marker in the
// file head means the prose is machine-emitted, not authored intent → excluded.
export function isGenerated(headText) {
  return /@generated|auto-?generated|GENERATED FILE|DO NOT EDIT/i.test(headText);
}

// All tracked code-corpus files (git ls-files -> membership filter). Sorted for
// determinism. Generated files are still listed here (counted as scanned); their
// chunk rows come back empty from buildCodeRowsForFile.
export function listCodeCorpusFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isCodeCorpusMember)
    .sort();
}

// ── Classification + authority ───────────────────────────────────────────────
// CONTRACT (load-bearing law) > ENGINE (canonical behavior) > LANE (tool-lane
// narrative) > TEST (intent prose). apispec/capturespec route to CONTRACT BEFORE
// the .test/.spec test-basename rule so a *.apispec.ts is never misfiled as TEST.
export function deriveCodeClass(relPath) {
  const p = relPath.replace(/\\/g, '/');
  const base = p.split('/').pop();
  if (/\.(apispec|capturespec)\.ts$/.test(base)) return 'CONTRACT';
  if (base === 'binary_layouts.ts' || base === 'schema_versions.ts' || base === 'pipeline_config.ts') return 'CONTRACT';
  if (p.startsWith('src/engine/contracts/')) return 'CONTRACT';
  if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(base)) return 'TEST';
  if (p.startsWith('src/')) return 'ENGINE';
  if (p.startsWith('tools/')) return 'LANE';
  return 'ENGINE';
}

// Authority weight — a mild multiplier on the lexical score (near 1.0 so
// relevance dominates; authority only breaks near-ties toward the source of
// record). Values are a CALIBRATION output (see README "Code-corpus calibration").
const CODE_AUTHORITY = {
  CONTRACT: 1.25, // load-bearing law (schema/pipeline_config/apispec/contracts)
  ENGINE: 1.10,   // canonical pipeline behavior
  LANE: 1.00,     // tool-lane banners — rich but lane-local
  TEST: 0.85,     // intent prose, lowest weight
};
export function codeAuthorityWeight(cls) {
  return CODE_AUTHORITY[cls] ?? 1.0;
}

// ── Comment-line classification ──────────────────────────────────────────────
// One C-style model covers every corpus extension: // line comments (with the
// Rust /// and //! doc variants), and /* */ block comments (incl. JSDoc /** */).
// A comment must start the (trimmed) line — a trailing `code(); // note` never
// opens a run (matches the survey's line-start rule; JSX {/* */} is a known gap).
const WORDCHAR = /[A-Za-z0-9]/; // ASCII word signal (mojibake box chars are NOT word chars)

// Lint / tooling directives break a comment run and never qualify as prose.
function isLintLine(trimmed) {
  return /^\/\/#/.test(trimmed)
    || /^\/\/\s*(eslint-|@ts-(ignore|expect-error|nocheck)|prettier-ignore|@flow|biome-ignore|deno-lint|istanbul\b|c8\b|v8\b|@vitest-|@jest-)/i.test(trimmed);
}

// Strip the // /// //! prefix, keep the body (rule symbols preserved for banner
// detection). Returns trimmed remainder.
function stripSlashes(trimmed) {
  return trimmed.replace(/^\/\/[/!]?/, '').trim();
}
// Strip leading * (JSDoc continuation / ** opener) and any trailing */.
function stripStars(s) {
  return s.trim().replace(/^\*+/, '').replace(/\*\/\s*$/, '').trim();
}

// A pure divider/banner rule line: >=6 non-space chars, zero ASCII word-chars.
// SYMBOL-REPETITION based (NOT a unicode box-char class): catches clean `═════`,
// ascii `------`, AND the 59 files' mojibake `â•â•â•` double-encoded banners.
function isDivider(body) {
  return body.replace(/\s+/g, '').length >= 6 && !WORDCHAR.test(body);
}
// A single-line inline-ruled SECTION HEADER (`// ── Constants ──────`): has a
// title (word chars) AND a rule run (>=4 consecutive non-word non-space chars).
// Harvested as a heading-chain TITLE, never a standalone chunk (STRICT boundary).
function isSectionHeader(body) {
  return WORDCHAR.test(body) && /[^\w\s]{4,}/.test(body) && !isDivider(body);
}
// Title text = body with internal rule runs removed, then leading/trailing
// non-word fragments trimmed (short `--`/`==` rails, mojibake, spaces), whitespace
// collapsed. Internal punctuation (em dash, slashes) is preserved.
function titleText(body) {
  return body
    .replace(/[^\w\s]{4,}/g, ' ')     // internal rule runs -> space
    .replace(/^[^\w]+|[^\w]+$/g, '')  // trim leading/trailing symbols + spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// Per-line classification with block-comment state.
function classifyLines(lines) {
  const res = [];
  let inBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (inBlock) {
      const end = trimmed.indexOf('*/');
      let b = trimmed;
      if (end >= 0) { inBlock = false; b = trimmed.slice(0, end); }
      const body = stripStars(b);
      res.push({ isComment: true, isLint: false, body });
      continue;
    }
    if (trimmed.startsWith('//')) {
      const body = stripSlashes(trimmed);
      res.push({ isComment: true, isLint: isLintLine(trimmed), body });
      continue;
    }
    if (trimmed.startsWith('/*')) {
      let b = trimmed.slice(2);
      const end = b.indexOf('*/');
      if (end >= 0) b = b.slice(0, end);
      else inBlock = true;
      res.push({ isComment: true, isLint: false, body: stripStars(b) });
      continue;
    }
    res.push({ isComment: false, isLint: false, body: '' });
  }
  // Annotate divider/section-header flags once bodies are known.
  for (const r of res) {
    if (r.isComment && !r.isLint) {
      r.isDivider = isDivider(r.body);
      r.isSectionHeader = isSectionHeader(r.body);
    } else {
      r.isDivider = false;
      r.isSectionHeader = false;
    }
  }
  return res;
}

// The banner TITLE of a qualifying comment run: the first non-empty, non-divider
// prose line, rule-runs stripped, capped. '' when the run is pure dividers.
function bannerTitleForRun(runLines) {
  for (const l of runLines) {
    if (l.isDivider) continue;
    if (!l.body) continue;
    const t = titleText(l.body);
    if (t) return t.slice(0, 160);
  }
  return '';
}

// ── Chunking ─────────────────────────────────────────────────────────────────
// A CHUNK = a contiguous comment run of >=3 lines OR a >=2-line ruled banner
// block, PLUS up to 2 following non-blank/non-comment lines (the anchored
// signature — pulls the documented symbol's identifiers into the chunk text).
// A 1-line comment run is never a chunk; a 1-line section header is harvested as
// the heading title for the chunks that follow. Lines are 1-based inclusive.
export function chunkCode(relPath, text) {
  const p = relPath.replace(/\\/g, '/');
  const lines = text.split('\n');
  const cls = classifyLines(lines);
  const chunks = [];
  let sectionTitle = ''; // nearest preceding banner/section title (heading context)
  let i = 0;

  while (i < lines.length) {
    if (!cls[i].isComment || cls[i].isLint) { i++; continue; }

    // Accumulate a maximal comment run (lint-directive lines break it).
    let j = i;
    const runLines = [];
    while (j < lines.length && cls[j].isComment && !cls[j].isLint) {
      runLines.push(cls[j]);
      j++;
    }

    const hasDivider = runLines.some((l) => l.isDivider);
    const qualifies = runLines.length >= 3 || (runLines.length >= 2 && hasDivider);

    if (!qualifies) {
      // Non-chunk run: a lone section header seeds the heading context.
      const sh = runLines.find((l) => l.isSectionHeader);
      if (sh) sectionTitle = titleText(sh.body).slice(0, 160);
      i = j;
      continue;
    }

    const title = bannerTitleForRun(runLines) || sectionTitle;

    // Anchored signature: up to 2 following non-blank, non-comment lines.
    let sigEnd = j - 1;
    let taken = 0;
    for (let k = j; k < lines.length && taken < 2; k++) {
      if (lines[k].trim() === '') break;
      if (cls[k].isComment) break;
      sigEnd = k;
      taken++;
    }

    chunks.push({
      path: p,
      heading: title ? `${p} > ${title}` : p,
      lines_start: i + 1,
      lines_end: sigEnd + 1,
      text: lines.slice(i, sigEnd + 1).join('\n'),
    });
    if (title) sectionTitle = title; // subsequent code chunks inherit nearest title
    i = j;
  }

  return chunks.filter((c) => c.text.trim() !== '');
}

// Build all LanceDB rows for one code-corpus file (empty for generated or
// zero-chunk files). Columns mirror doc_chunks so a `both` query is uniform, plus
// the additive provenance pair {checkout, branch} that names WHICH working tree
// the row came from (the composite key with `path` — see codeRoots). `checkout`
// defaults to the descriptor resolved from `root` when a single-root caller omits
// it (per-file git branch lookup; the hot multi-root path passes it in once).
export function buildCodeRowsForFile(root, relPath, checkout = null) {
  const abs = path.join(root, relPath);
  const text = readFileSync(abs, 'utf8');
  if (isGenerated(text.slice(0, 2000))) return [];
  const cls = deriveCodeClass(relPath);
  const authority = codeAuthorityWeight(cls);
  const last_commit = gitLastCommit(root, relPath);
  const file_hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const ck = checkout || { id: MAIN_CHECKOUT_ID, branch: gitBranch(root) };
  return chunkCode(relPath, text).map((c) => ({
    path: c.path,
    heading: c.heading,
    lines_start: c.lines_start,
    lines_end: c.lines_end,
    text: c.text,
    class: cls,
    authority_weight: authority,
    last_commit,
    file_hash,
    checkout: ck.id,   // provenance: which working tree (composite key with path)
    branch: ck.branch, // provenance: which branch of that tree
    // vector column ABSENT (lexical-only), matching doc_chunks v1.
  }));
}
