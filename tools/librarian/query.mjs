// query.mjs — the librarian's query CLI. A CARD CATALOG: it returns POINTERS
// (path + heading + line range), never document content as an answer. Agents
// always read the primary source at the returned lines.
//
//   node query.mjs "where do receipt schema versions live"
//   node query.mjs -h "gaia atlas junction trap"     # human-readable
//   node query.mjs -k 8 "vignette correction layers"  # top-k (default 5)
//   node query.mjs --threshold 2.5 "…"                # override refusal cutoff
//   node query.mjs --corpus code "where do we correct star flux for vignette"
//   node query.mjs --corpus reports "seestar control alpaca native"  # frozen
//                                                       # test_results/**/*.md
//   node query.mjs --corpus both "…"           # THREE-way: docs+code+reports,
//                                               # each labeled
//
// Scoring = hand-rolled BM25 over chunk text, plus a heading-match boost, times
// the class authority weight. Below a calibrated threshold the CLI REFUSES
// ("no indexed source") rather than emit nearest-neighbour garbage (LAW 3 in
// retrieval form). See README for the calibration set + separation.
//
// THREE corpora, ONE store: --corpus docs (default, BYTE-IDENTICAL to v1) reads
// doc_chunks; --corpus code reads code_chunks (comment-prose over src/**+tools/**);
// --corpus reports reads report_chunks (frozen one-shot docs/research living
// GITIGNORED under test_results/**/*.md across three filesystem roots — these
// files have no git history, so results carry `mtime`+`root_id` instead of
// `last_commit`); --corpus both runs ALL THREE, each labeled with its OWN
// score/threshold (never a unified cross-corpus score — the tables are not
// cross-calibrated).

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, lanceDir, TABLE_NAME } from './lib/corpus.mjs';
import { CODE_TABLE_NAME } from './lib/code_corpus.mjs';
import { REPORTS_TABLE_NAME } from './lib/reports_corpus.mjs';
import { buildCorpus, bm25Score, tokenize } from './lib/bm25.mjs';

// Calibrated on 10 real + 3 garbage queries (see README "Calibration"). With the
// coverage-weighted score below, real in-corpus queries scored >= 7.77 and
// garbage/absent-topic queries scored <= 3.89 — a wide empty gap. 5.0 sits in it
// with margin on both sides.
const DEFAULT_THRESHOLD = 5.0;
// CODE corpus (code_chunks) has its OWN threshold — comment-prose chunks score on
// a different scale than doc-section chunks, so the docs 5.0 does NOT transfer.
// Calibrated on 15 real + 3 garbage code queries (README "Code-corpus
// calibration"): real top-1 >= 9.31, garbage top-1 <= 3.36 — a wide empty gap;
// 5.0 sits in it (margin 1.64 to garbage, 4.31 to the weakest real).
const CODE_DEFAULT_THRESHOLD = 5.0;
// REPORTS corpus (report_chunks) has its OWN threshold — frozen one-shot prose
// over a much smaller, denser corpus (314 files / 2826 chunks vs docs' 82/1177)
// scores on yet another scale. Calibrated on 11 real + 5 garbage queries
// (README "Reports-corpus calibration"): real top-1 >= 4.09, garbage top-1
// <= 2.73 — a narrower but still empty gap. 3.4 sits near the gap's midpoint
// (margin 0.67 to garbage, 0.69 to the weakest real). Smaller margins than
// docs/code are honest here, not hidden — see README for the full query list.
const REPORTS_DEFAULT_THRESHOLD = 3.4;
// Filename-relevance boost for the CODE corpus (0 = OFF for docs, which keeps the
// docs ranker byte-identical). Calibration output: lifts strict top-3 7/15 -> 9/15
// with the garbage gap intact.
const CODE_FILE_BOOST = 2.0;
const HEADING_BOOST = 1.6; // per distinct query term found in the heading chain

// ── Near-miss ledger (owner-ruled 2026-07-16) ─────────────────────────────────
// A refusal whose top score lands in the suspicious band [NEAR_MISS_FLOOR,
// threshold) is a potential CORPUS GAP — "the catalog almost had this" — and is
// appended (query + redacted top hit + score) to a gitignored jsonl so gaps can
// be reviewed in bulk. Confident garbage (below the floor) is NOT logged.
// Floor default 3.0 = margin under the measured garbage ceiling (3.89, N=3
// calibration — small N, hence the margin). The ledger is telemetry ONLY: the
// refusal RESPONSE never carries the near-hit (showing an almost-answer would
// invite consuming nearest-neighbour garbage, defeating the refusal posture).
const NEAR_MISS_FLOOR = Number(process.env.LIBRARIAN_NEAR_MISS_FLOOR || 3.0);
const NEAR_MISS_LEDGER = () => path.join(repoRoot(), 'test_results', 'librarian', 'near_misses.jsonl');

/** Append a near-miss record. Best-effort telemetry: NEVER throws into a query.
 *  `corpus` tags which catalog almost had it ("docs" | "code") so gaps triage
 *  per-corpus (shared ledger, owner-ruled 2026-07-16). */
function logNearMiss(out, topHit, corpus = 'docs') {
  try {
    if (!(out.top_score >= NEAR_MISS_FLOOR && out.top_score < out.threshold)) return;
    const file = NEAR_MISS_LEDGER();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      corpus,
      query: out.query,
      top_score: out.top_score,
      threshold: out.threshold,
      floor: NEAR_MISS_FLOOR,
      top_hit: topHit, // {path, heading, lines, score} | null — ledger-only, redacted from the response
    }) + '\n');
  } catch { /* telemetry must never break a query */ }
}

const CORPUS_VALUES = new Set(['code', 'reports', 'both']); // 'docs' is the fall-through default

function parseArgs(argv) {
  // threshold defaults to undefined so query() can pick the corpus-appropriate
  // default (docs 5.0 vs code 5.0 vs reports 3.4); an explicit --threshold
  // overrides all.
  const opts = { human: false, k: 5, threshold: undefined, corpus: 'docs', query: '' };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--human') opts.human = true;
    else if (a === '-k' || a === '--top') opts.k = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (a === '--threshold') opts.threshold = parseFloat(argv[++i]);
    else if (a === '--corpus') {
      const c = String(argv[++i] || '').toLowerCase();
      opts.corpus = CORPUS_VALUES.has(c) ? c : 'docs';
    } else words.push(a);
  }
  opts.query = words.join(' ').trim();
  return opts;
}

export { DEFAULT_THRESHOLD };

// Filename tokens = the last path segment minus its extension, tokenized. For a
// CODE query the filename is a strong relevance signal ("rawler decoder arm" ->
// rawler_decoder.ts): standard code-search practice. Used ONLY when fileBoost>0.
function fileTokens(relPath) {
  const base = String(relPath || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  return new Set(tokenize(base));
}

// Pure ranking + refusal over already-scanned chunk rows. No LanceDB, no disk —
// so it is deterministic and unit-testable. rows = [{path, heading, lines_start,
// lines_end, text, class, authority_weight, last_commit}].
//   fileBoost — per distinct query term found in the filename (default 0 = OFF;
//   the CODE corpus passes >0). At 0 the term vanishes and the score is IDENTICAL
//   to v1, so the docs default stays byte-identical (see query.mjs corpus router).
export function rankChunks(rows, queryStr, { k = 5, threshold = DEFAULT_THRESHOLD, fileBoost = 0 } = {}) {
  const qTokens = tokenize(queryStr);
  const distinctQ = [...new Set(qTokens)];
  const corpus = buildCorpus(rows.map((r) => r.text));

  // Final score = (BM25 + heading boost + filename boost) × authority × coverage.
  //   coverage = fraction of the query's distinct content terms that appear in
  //   this chunk (text ∪ heading). Coverage is the length-normalized signal that
  //   separates real queries (most terms land in ONE chunk) from garbage (a few
  //   rare words scatter across unrelated chunks); raw BM25 alone does NOT
  //   separate them (it rewards long queries that match incidental rare words).
  const scored = rows.map((r, i) => {
    const bm = bm25Score(corpus, i, qTokens);
    const headTokens = new Set(tokenize(r.heading));
    const headMatches = distinctQ.filter((t) => headTokens.has(t)).length;
    const fileMatches = fileBoost ? (() => { const ft = fileTokens(r.path); return distinctQ.filter((t) => ft.has(t)).length; })() : 0;
    const covered = distinctQ.filter((t) => corpus.docs[i].tf.has(t) || headTokens.has(t)).length;
    const coverage = distinctQ.length ? covered / distinctQ.length : 0;
    const score = (bm + HEADING_BOOST * headMatches + fileBoost * fileMatches) * (r.authority_weight ?? 1) * coverage;
    return { r, score };
  });
  // Deterministic order: score desc, then a stable tiebreak on path + start line.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.r.path.localeCompare(b.r.path) ||
      a.r.lines_start - b.r.lines_start,
  );

  const top = scored.slice(0, k).filter((s) => s.score > 0);
  const topScore = top.length ? top[0].score : 0;

  if (topScore < threshold) {
    return {
      refused: true,
      reason: 'below-threshold',
      detail: 'no indexed source for this query',
      query: queryStr,
      top_score: Number(topScore.toFixed(4)),
      threshold,
      results: [],
      // INTERNAL: what the refusal almost returned — consumed by the near-miss
      // ledger in main() and REDACTED from every printed/served response.
      top_hit: top.length
        ? { path: top[0].r.path, heading: top[0].r.heading, lines: `${top[0].r.lines_start}-${top[0].r.lines_end}`, score: Number(top[0].score.toFixed(4)) }
        : null,
    };
  }

  return {
    refused: false,
    query: queryStr,
    threshold,
    // `mtime`/`root_id` are ADDITIVE and only ever present on REPORTS rows (the
    // only corpus with no git history — see lib/reports_corpus.mjs). Their
    // absence on every docs/code row keeps this shape byte-identical to v1 for
    // both corpora (JSON.stringify never emits an undefined-valued key).
    results: top.map(({ r, score }) => ({
      path: r.path,
      heading: r.heading,
      lines: `${r.lines_start}-${r.lines_end}`,
      score: Number(score.toFixed(4)),
      last_commit: r.last_commit || null,
      class: r.class,
      // `checkout`/`branch` are ADDITIVE and only ever present on CODE rows (which
      // working tree the pointer lives in — main vs rest-integration). Their
      // absence on every docs/reports row keeps this shape byte-identical to v1
      // there (JSON.stringify never emits an undefined-valued key).
      ...(r.checkout ? { checkout: r.checkout, branch: r.branch || null } : {}),
      ...(r.mtime ? { mtime: r.mtime, root_id: r.root_id } : {}),
    })),
  };
}

const TABLE_BY_CORPUS = { code: CODE_TABLE_NAME, reports: REPORTS_TABLE_NAME };
const REINDEX_HINT_BY_CORPUS = { code: 'run: node index_code.mjs', reports: 'run: node index_reports.mjs' };

// Scan ONE corpus table and rank. corpus ∈ {'docs','code','reports'}. tag=false
// returns the bare rankChunks output (v1 shape, no corpus field — used for the
// byte-identical docs default); tag=true stamps `corpus` on the result + each
// row (code/reports/both).
async function queryTable(db, corpus, queryStr, opts, tag) {
  const tableName = TABLE_BY_CORPUS[corpus] ?? TABLE_NAME;
  const names = await db.tableNames();
  if (!names.includes(tableName)) {
    const detail = REINDEX_HINT_BY_CORPUS[corpus] ?? 'run: node index_docs.mjs';
    const out = { refused: true, reason: 'index-missing', detail, query: queryStr, results: [] };
    if (tag) out.corpus = corpus;
    return out;
  }
  const defThresh = corpus === 'code' ? CODE_DEFAULT_THRESHOLD : corpus === 'reports' ? REPORTS_DEFAULT_THRESHOLD : DEFAULT_THRESHOLD;
  const threshold = (opts.threshold != null && !Number.isNaN(opts.threshold)) ? opts.threshold : defThresh;
  const fileBoost = corpus === 'code' ? CODE_FILE_BOOST : 0; // 0 => docs/reports byte-identical ranking formula
  const table = await db.openTable(tableName);
  const rows = await table.query().toArray();
  const out = rankChunks(rows, queryStr, { k: opts.k ?? 5, threshold, fileBoost });
  if (tag) {
    out.corpus = corpus;
    if (!out.refused) out.results = out.results.map((r) => ({ ...r, corpus }));
  }
  return out;
}

// Connect to the LanceDB store and rank against the selected corpus.
//  - 'docs' (default): BYTE-IDENTICAL to v1 (doc_chunks, no corpus tagging).
//  - 'code': code_chunks, own threshold, results tagged corpus:'code'.
//  - 'reports': report_chunks (frozen test_results/**/*.md, three fs roots),
//    own threshold, results tagged corpus:'reports' and carry mtime/root_id.
//  - 'both': runs ALL THREE, returns {both,query,docs,code,reports}, each with
//    its OWN score/threshold — never a unified cross-corpus score.
export async function query(root, queryStr, opts = {}) {
  const corpus = CORPUS_VALUES.has(opts.corpus) ? opts.corpus : 'docs';
  // LAZY import — the lane's node_modules is gitignored, so every worktree lacks
  // it. A static import dies as a bare ERR_MODULE_NOT_FOUND before any code runs
  // (and, via librarian.test.mjs → query.mjs, took a whole vitest collection down
  // for worktree agents on 2026-07-16/17). Refuse with the remedy instead: this
  // CLI is cwd-independent, so invoking a FULL checkout's query.mjs by absolute
  // path works from any worktree.
  let lancedb;
  try { lancedb = await import('@lancedb/lancedb'); }
  catch {
    return {
      refused: true,
      reason: 'deps-missing',
      detail: 'librarian deps absent in THIS checkout (worktrees never have them — gitignored). Invoke a full checkout\'s tools/librarian/query.mjs by ABSOLUTE path (the CLI is cwd-independent), or npm install in its tools/librarian.',
      query: queryStr,
      results: [],
    };
  }
  const db = await lancedb.connect(lanceDir(root));
  if (corpus === 'both') {
    // THREE-way (docs+code+reports since the reports corpus landed) — each runs
    // independently with its OWN threshold; never a unified cross-corpus score.
    const docs = await queryTable(db, 'docs', queryStr, opts, true);
    const code = await queryTable(db, 'code', queryStr, opts, true);
    const reports = await queryTable(db, 'reports', queryStr, opts, true);
    return { both: true, query: queryStr, docs, code, reports };
  }
  // 'docs' is untagged (v1 byte-identical); 'code'/'reports' are tagged.
  return queryTable(db, corpus, queryStr, opts, corpus !== 'docs');
}

function printHuman(out) {
  // Corpus label prints ONLY for tagged (code/reports/both) results; a
  // docs-default `out` has no `corpus` field, so this line never fires there →
  // v1 output byte-identical.
  if (out.corpus) console.log(`── corpus: ${out.corpus} ──`);
  if (out.refused) {
    console.log(`REFUSED (${out.reason}): ${out.detail}`);
    console.log(`  query:     "${out.query}"`);
    if (out.top_score !== undefined) console.log(`  top score: ${out.top_score}  (threshold ${out.threshold})`);
    return;
  }
  console.log(`Query: "${out.query}"   (top ${out.results.length}, threshold ${out.threshold})`);
  console.log('');
  out.results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.path}:${r.lines}   [${r.class}]  score ${r.score}`);
    console.log(`   ${r.heading}`);
    // CODE rows name their working tree (main vs rest-integration) so the reader
    // opens the RIGHT checkout. Only present on code rows → docs output unchanged.
    if (r.checkout) console.log(`   checkout: ${r.checkout}${r.branch ? ` (${r.branch})` : ''}`);
    // REPORTS rows carry mtime/root_id instead of last_commit (no git history —
    // see lib/reports_corpus.mjs); every other corpus keeps the v1 line exactly.
    if (r.mtime) console.log(`   root: ${r.root_id}   mtime: ${r.mtime}`);
    else console.log(`   last commit: ${r.last_commit || 'uncommitted'}`);
  });
}

// Emit one single-corpus result (refusal object or per-result JSON lines / human
// block) and log a near-miss for a below-threshold refusal. Shared by all corpus
// modes so the docs-default path stays byte-identical to v1.
function emitAndLog(out, human) {
  if (out.refused && out.reason === 'below-threshold') {
    // Ledger first, then REDACT: the near-hit goes to gap telemetry only, never
    // into the response (CLI stdout feeds the MCP tool verbatim).
    const topHit = out.top_hit ?? null;
    delete out.top_hit;
    logNearMiss(out, topHit, out.corpus || 'docs');
  }
  if (human) printHuman(out);
  else if (out.refused) console.log(JSON.stringify(out));
  else for (const r of out.results) console.log(JSON.stringify(r));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.query) {
    console.error('usage: node query.mjs [-h] [-k N] [--threshold X] [--corpus docs|code|reports|both] "your query"');
    console.error('  docs    (default) tracked docs — see README');
    console.error('  code    comment-prose over src/**+tools/** (concept-phrased code questions)');
    console.error('  reports frozen one-shot docs/research under test_results/**/*.md (3 fs roots,');
    console.error('          no git history — results carry mtime+root_id instead of last_commit)');
    console.error('  both    THREE-way: docs + code + reports, each labeled with its own threshold');
    process.exit(2);
  }
  const out = await query(repoRoot(), opts.query, { k: opts.k, threshold: opts.threshold, corpus: opts.corpus });
  if (out.both) {
    // Each corpus emits its OWN refusal/results with its OWN threshold label.
    emitAndLog(out.docs, opts.human);
    emitAndLog(out.code, opts.human);
    emitAndLog(out.reports, opts.human);
    return;
  }
  emitAndLog(out, opts.human);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('query.mjs')) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e?.stack || e) }));
    process.exit(1);
  });
}
