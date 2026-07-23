// Tests for the documentation librarian (card-catalog retrieval over tracked docs).
// Collected by the root vitest config (tools/**/*.test.mjs), runs in Node.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @lancedb/lancedb is a NATIVE dep living in the LANE-LOCAL node_modules
// (tools/librarian/node_modules — `npm ci` here; deliberately NOT in the root
// package.json). Worktrees junction only the ROOT node_modules, so the lane dep
// is absent there and a static import fails at COLLECTION (took the whole suite
// down for 5 agents on 2026-07-16). Guarded dynamic import instead: the pure
// tests (corpus/bm25/ranking) always run; only the on-disk round-trip skips,
// with a printed reason distinguishing env-gap from real breakage (same
// skip-legibility pattern as tools/prysm).
let lancedb = null;
try {
  lancedb = await import('@lancedb/lancedb');
} catch {
  // eslint-disable-next-line no-console
  console.warn('[librarian.test] SKIP LanceDB round-trip: @lancedb/lancedb not resolvable (lane node_modules absent — run `npm ci` in tools/librarian; expected in worktrees/CI)');
}

import {
  isCorpusMember,
  listCorpusFiles,
  repoRoot,
  deriveClass,
  authorityWeight,
  chunkMarkdown,
  TABLE_NAME,
} from './lib/corpus.mjs';
import { tokenize, bm25Rank, STOPWORDS } from './lib/bm25.mjs';
import { rankChunks, DEFAULT_THRESHOLD } from './query.mjs';
// CODE corpus (second catalog). code_corpus.mjs is PURE (no @lancedb import) —
// static import is safe in every worktree, same as lib/corpus.mjs above.
import {
  isCodeCorpusMember,
  isGenerated,
  deriveCodeClass,
  codeAuthorityWeight,
  chunkCode,
  CODE_TABLE_NAME,
} from './lib/code_corpus.mjs';

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('corpus membership — exclusion negative control', () => {
  it('EXCLUDES docs/local and docs/archive (owner-voice / frozen)', () => {
    expect(isCorpusMember('docs/local/RESTORATION_PLAN.md')).toBe(false);
    expect(isCorpusMember('docs/archive/CR2_SOLVER_FINDINGS.md')).toBe(false);
    expect(isCorpusMember('docs/archive/antigravity/deploy.md')).toBe(false);
  });
  it('INCLUDES tracked docs, root README/CLAUDE, and tool READMEs', () => {
    expect(isCorpusMember('docs/GATES.md')).toBe(true);
    expect(isCorpusMember('docs/01-canonical/processing_flow.md')).toBe(true);
    expect(isCorpusMember('README.md')).toBe(true);
    expect(isCorpusMember('CLAUDE.md')).toBe(true);
    expect(isCorpusMember('tools/scope/README.md')).toBe(true);
  });
  it('EXCLUDES non-doc files and non-README tool files', () => {
    expect(isCorpusMember('src/engine/pipeline/stages/solve.ts')).toBe(false);
    expect(isCorpusMember('tools/scope/driver.mjs')).toBe(false);
    expect(isCorpusMember('package.json')).toBe(false);
  });
  it('the live corpus enumeration leaks NO docs/local or docs/archive', () => {
    const files = listCorpusFiles(repoRoot());
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith('docs/local/'))).toBe(false);
    expect(files.some((f) => f.startsWith('docs/archive/'))).toBe(false);
    expect(files).toContain('docs/GATES.md');
    expect(files).toContain('CLAUDE.md');
  });
});

describe('classification + authority', () => {
  it('routes classes and orders authority CLAUDE > LEDGER > spec > narrative', () => {
    expect(deriveClass('CLAUDE.md')).toBe('CLAUDE');
    expect(deriveClass('docs/GATES.md', '<!-- LEDGER · owner: ahogan -->')).toBe('LEDGER');
    expect(deriveClass('docs/01-canonical/processing_flow.md')).toBe('CANONICAL');
    expect(deriveClass('docs/reference/CARD_ATMOSPHERE_OPTICS.md')).toBe('REFERENCE');
    expect(deriveClass('docs/02-specs/OBSERVATORY_CONTROL_SPEC.md')).toBe('spec');
    expect(deriveClass('tools/scope/README.md')).toBe('README');
    expect(deriveClass('docs/WHITEPAPER.md')).toBe('narrative');
    expect(authorityWeight('CLAUDE')).toBeGreaterThan(authorityWeight('LEDGER'));
    expect(authorityWeight('LEDGER')).toBeGreaterThan(authorityWeight('spec'));
    expect(authorityWeight('spec')).toBeGreaterThan(authorityWeight('narrative'));
  });
});

describe('markdown chunking — heading-anchored', () => {
  const md = [
    'preamble line',      // 1
    '',                   // 2
    '# Title',            // 3
    'body of title',      // 4
    '## Sub A',           // 5
    'body a',             // 6
    '## Sub B',           // 7
    'body b1',            // 8
    'body b2',            // 9
  ].join('\n');
  const chunks = chunkMarkdown('docs/X.md', md);

  it('produces a preamble chunk plus one chunk per heading', () => {
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('X.md (preamble)');
    expect(headings).toContain('Title');
    expect(headings).toContain('Title > Sub A');
    expect(headings).toContain('Title > Sub B');
  });
  it('records 1-based inclusive line ranges', () => {
    const subB = chunks.find((c) => c.heading === 'Title > Sub B');
    expect(subB.lines_start).toBe(7);
    expect(subB.lines_end).toBe(9);
    expect(subB.text).toContain('body b2');
  });
});

describe('tokenizer + BM25', () => {
  it('lowercases, splits identifiers, drops stopwords and length-1 tokens', () => {
    const toks = tokenize('The SOLVER_UW_SWEEP where a Z');
    expect(toks).toContain('solver');
    expect(toks).toContain('sweep');
    expect(toks).not.toContain('the');   // stopword
    expect(toks).not.toContain('where'); // stopword
    expect(toks).not.toContain('z');     // length-1
    expect(STOPWORDS.has('the')).toBe(true);
  });
  it('ranks the on-topic document highest', () => {
    const texts = [
      'vignette correction applies at the pixel level and render plane',
      'quads and geometric hashing for blind plate solving',
      'thesis registry submitter class hash chain',
    ];
    const ranked = bm25Rank(texts, 'vignette correction render').sort((a, b) => b.score - a.score);
    expect(ranked[0].index).toBe(0);
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

describe('rankChunks — known-topic hit, garbage refusal, determinism', () => {
  const rows = [
    { path: 'docs/GATES.md', heading: 'Gates', lines_start: 1, lines_end: 5,
      text: 'seestar fits solve byte identical regression pinned reference numbers tsc vitest gate',
      class: 'LEDGER', authority_weight: 1.2, last_commit: '2026-07-16T00:00:00Z' },
    { path: 'docs/WHITEPAPER.md', heading: 'Deep verify', lines_start: 10, lines_end: 20,
      text: 'forced photometry confirmation family wise gate catalog positions escalation',
      class: 'narrative', authority_weight: 0.9, last_commit: '2026-07-14T00:00:00Z' },
    { path: 'tools/scope/README.md', heading: 'observatory control', lines_start: 1, lines_end: 8,
      text: 'telescope mount interlocks safety limits observatory control lane',
      class: 'README', authority_weight: 0.95, last_commit: '2026-07-16T00:00:00Z' },
  ];

  // Ranking correctness — decoupled from the production threshold (BM25 absolute
  // scores scale with corpus size; the DEFAULT_THRESHOLD is calibrated on the
  // full ~1177-chunk corpus, not a 3-row synthetic one).
  it('returns the known doc in the top-k for an in-corpus query', () => {
    const out = rankChunks(rows, 'seestar byte identical solve regression', { k: 3, threshold: 1.0 });
    expect(out.refused).toBe(false);
    expect(out.results[0].path).toBe('docs/GATES.md');
  });

  it('REFUSES a garbage / absent-topic query rather than emit nearest-neighbour', () => {
    const out = rankChunks(rows, 'how to bake sourdough bread at home', { k: 5 });
    expect(out.refused).toBe(true);
    expect(out.reason).toBe('below-threshold');
    expect(out.results).toHaveLength(0);
    expect(out.top_score).toBeLessThan(DEFAULT_THRESHOLD);
  });

  it('is deterministic — same rows + query yield identical scores', () => {
    const a = rankChunks(rows, 'observatory telescope interlocks', { k: 3 });
    const b = rankChunks(rows, 'observatory telescope interlocks', { k: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe.skipIf(!lancedb)('LanceDB dataset round-trips (index → reopen → query)', () => {
  it('writes doc_chunks, reopens on a fresh connection, and queries it back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'librarian-lance-'));
    tmpDirs.push(dir);
    const seed = [
      { path: 'docs/GATES.md', heading: 'Gates', lines_start: 1, lines_end: 5,
        text: 'seestar fits solve byte identical regression tsc vitest gate numbers',
        class: 'LEDGER', authority_weight: 1.2, last_commit: '2026-07-16T00:00:00Z', file_hash: 'h1' },
      { path: 'tools/scope/README.md', heading: 'observatory control', lines_start: 1, lines_end: 8,
        text: 'telescope mount interlocks safety limits observatory control lane',
        class: 'README', authority_weight: 0.95, last_commit: '2026-07-16T00:00:00Z', file_hash: 'h2' },
    ];
    const db = await lancedb.connect(dir);
    await db.createTable(TABLE_NAME, seed);

    // Reopen on a brand-new connection to prove on-disk persistence.
    const db2 = await lancedb.connect(dir);
    const table = await db2.openTable(TABLE_NAME);
    const rows = await table.query().toArray();
    expect(rows).toHaveLength(2);

    const out = rankChunks(rows, 'telescope interlocks observatory', { k: 2, threshold: 1.0 });
    expect(out.refused).toBe(false);
    expect(out.results[0].path).toBe('tools/scope/README.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CODE CORPUS (code_chunks) — membership, classification, chunker, fileBoost
// ═══════════════════════════════════════════════════════════════════════════

describe('code corpus membership', () => {
  it('INCLUDES src/** and tools/** code files across every extension', () => {
    expect(isCodeCorpusMember('src/engine/pipeline/stages/solve.ts')).toBe(true);
    expect(isCodeCorpusMember('src/engine/ui/widgets/Foo.tsx')).toBe(true);
    expect(isCodeCorpusMember('tools/psf/decode_cr2.mjs')).toBe(true);
    expect(isCodeCorpusMember('tools/gates/check_gates.js')).toBe(true);
    expect(isCodeCorpusMember('src/engine/wasm_compute/src/statistics.rs')).toBe(true);
    expect(isCodeCorpusMember('src/engine/pipeline/shaders/kernel.wgsl')).toBe(true);
  });
  it('SELF-EXCLUDES the librarian lane (adversarial garbage fixtures poison the corpus)', () => {
    expect(isCodeCorpusMember('tools/librarian/query.mjs')).toBe(false);
    expect(isCodeCorpusMember('tools/librarian/lib/bm25.mjs')).toBe(false);
    expect(isCodeCorpusMember('tools/librarian/librarian.test.mjs')).toBe(false);
  });
  it('EXCLUDES node_modules, non-code extensions, and non-src/tools paths', () => {
    expect(isCodeCorpusMember('tools/x/node_modules/pkg/index.js')).toBe(false);
    expect(isCodeCorpusMember('src/engine/data/atlas.json')).toBe(false);
    expect(isCodeCorpusMember('docs/GATES.md')).toBe(false);
    expect(isCodeCorpusMember('README.md')).toBe(false);
  });
  it('excludes @generated files by head-scan (git cannot enforce on tracked files)', () => {
    expect(isGenerated('// @generated by codegen — DO NOT EDIT\nexport const x = 1;')).toBe(true);
    expect(isGenerated('/* AUTO-GENERATED FILE */\nconst y = 2;')).toBe(true);
    expect(isGenerated('// SOLVE STAGE — hand-written banner\nexport function f(){}')).toBe(false);
  });
});

describe('code classification + authority (CONTRACT > ENGINE > LANE > TEST)', () => {
  it('routes classes; apispec/capturespec win over the .test/.spec rule', () => {
    expect(deriveCodeClass('src/engine/contracts/binary_layouts.ts')).toBe('CONTRACT');
    expect(deriveCodeClass('src/engine/pipeline/stages/schema_versions.ts')).toBe('CONTRACT');
    expect(deriveCodeClass('src/engine/pipeline/constants/pipeline_config.ts')).toBe('CONTRACT');
    expect(deriveCodeClass('tools/api/solve_seestar.apispec.ts')).toBe('CONTRACT');
    expect(deriveCodeClass('tools/confirm/fdr.capturespec.ts')).toBe('CONTRACT');
    expect(deriveCodeClass('src/engine/pipeline/stages/solve.ts')).toBe('ENGINE');
    expect(deriveCodeClass('src/engine/tests/sip_render_warp.test.ts')).toBe('TEST');
    expect(deriveCodeClass('tools/psf/decode_cr2.mjs')).toBe('LANE');
  });
  it('orders authority CONTRACT > ENGINE > LANE > TEST', () => {
    expect(codeAuthorityWeight('CONTRACT')).toBeGreaterThan(codeAuthorityWeight('ENGINE'));
    expect(codeAuthorityWeight('ENGINE')).toBeGreaterThan(codeAuthorityWeight('LANE'));
    expect(codeAuthorityWeight('LANE')).toBeGreaterThan(codeAuthorityWeight('TEST'));
  });
});

describe('code chunker — comment syntaxes, banners, boundaries, signature', () => {
  it('// line banner + up to 2 signature lines; heading = file > banner title', () => {
    const src = [
      '// ------------------------------', // 1 divider
      '// SOLVE STAGE — hint resolution',  // 2 title prose
      '// ------------------------------', // 3 divider
      '// Ledger: COORDINATE ledger notes', // 4 prose
      'export function solveStage(opts) {', // 5 signature
      '  return opts;',                     // 6 signature
      '}',                                  // 7
    ].join('\n');
    const chunks = chunkCode('src/engine/foo.ts', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].lines_start).toBe(1);
    expect(chunks[0].lines_end).toBe(6); // 4 comment + 2 signature
    expect(chunks[0].heading).toBe('src/engine/foo.ts > SOLVE STAGE — hint resolution');
    expect(chunks[0].text).toContain('solveStage'); // signature identifier is indexed
  });
  it('/* */ JSDoc block chunks as one', () => {
    const src = ['/**', ' * SCHEMA VERSIONS — single home for versions', ' * Do NOT bump without a schema change.', ' */', 'export const X = 1;'].join('\n');
    const chunks = chunkCode('src/engine/schema_versions.ts', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toContain('SCHEMA VERSIONS');
    expect(chunks[0].text).toContain('bump');
  });
  it('Rust /// and //! doc comments are captured', () => {
    const src = ['/// Estimate the image background level and noise (sigma)', '/// using iterative sigma-clipping.', '/// Returns the estimated background.', 'pub fn estimate_bg(data: &[f32]) -> f32 {'].join('\n');
    const chunks = chunkCode('src/engine/wasm_compute/src/statistics.rs', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('sigma-clipping');
  });
  it('detects MOJIBAKE banners by symbol-repetition, not a box-char class', () => {
    const div = 'â•'.repeat(8); // "â•" ×8 — the double-encoded ═ banner
    const src = [`// ${div}`, '// PIPELINE CONFIG — thresholds', `// ${div}`, 'export const CFG = {};'].join('\n');
    const chunks = chunkCode('src/engine/pipeline/constants/pipeline_config.ts', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toContain('PIPELINE CONFIG');
  });
  it('STRICT boundary: a lone single-line ruled section header is NOT a standalone chunk', () => {
    const src = ['// -- Constants ------------------------', 'export const A = 1;', 'export const B = 2;'].join('\n');
    expect(chunkCode('src/engine/x.ts', src)).toHaveLength(0);
  });
  it('harvests a single-line section title into a following divider-only chunk heading', () => {
    const src = [
      '// -- Helpers -------------------------', // section header -> title "Helpers"
      '',
      '// ==================================', // divider
      '// ==================================', // divider (2-line banner block, no prose)
      'function helper() {}',
    ].join('\n');
    const chunks = chunkCode('src/engine/x.ts', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('src/engine/x.ts > Helpers'); // fallback to harvested title
  });
  it('lint-directive lines break a comment run', () => {
    const src = [
      '// alpha comment one here now',
      '// beta comment two here now',
      '// eslint-disable-next-line no-console',
      '// gamma comment three here',
      '// delta comment four here',
    ].join('\n');
    // Without the lint break this is one 5-line chunk; the break splits it into
    // two 2-line runs, neither of which qualifies (<3, no divider).
    expect(chunkCode('src/engine/x.ts', src)).toHaveLength(0);
  });
  it('a 2-line plain comment run (no divider) does not qualify', () => {
    const src = ['// just two lines', '// of plain prose', 'const z = 1;'].join('\n');
    expect(chunkCode('src/engine/x.ts', src)).toHaveLength(0);
  });
});

describe('rankChunks fileBoost — code filename relevance, default-off byte-identity', () => {
  const rows = [
    { path: 'src/x/rawler_decoder.ts', heading: 'h > arm select', lines_start: 1, lines_end: 5,
      text: 'select the decoder arm at ingest time', class: 'ENGINE', authority_weight: 1.1, last_commit: '2026-07-16T00:00:00Z' },
    { path: 'src/x/other.ts', heading: 'h2 > misc', lines_start: 1, lines_end: 5,
      text: 'unrelated content about pixel buffers only', class: 'ENGINE', authority_weight: 1.1, last_commit: '2026-07-16T00:00:00Z' },
  ];
  it('fileBoost=0 is byte-identical to omitting it (docs default preserved)', () => {
    const a = rankChunks(rows, 'rawler decoder arm', { k: 2, threshold: 0.0001 });
    const b = rankChunks(rows, 'rawler decoder arm', { k: 2, threshold: 0.0001, fileBoost: 0 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('fileBoost>0 raises the score of a filename-matching chunk (with content coverage)', () => {
    const off = rankChunks(rows, 'rawler decoder arm', { k: 2, threshold: 0.0001, fileBoost: 0 });
    const on = rankChunks(rows, 'rawler decoder arm', { k: 2, threshold: 0.0001, fileBoost: 5 });
    const s0 = off.results.find((r) => r.path.endsWith('rawler_decoder.ts')).score;
    const s1 = on.results.find((r) => r.path.endsWith('rawler_decoder.ts')).score;
    expect(s1).toBeGreaterThan(s0);
  });
  it('exposes the code table name distinct from doc_chunks', () => {
    expect(CODE_TABLE_NAME).toBe('code_chunks');
    expect(CODE_TABLE_NAME).not.toBe(TABLE_NAME);
  });
});
