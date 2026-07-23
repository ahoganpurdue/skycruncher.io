// Hand-rolled BM25 over chunk text — NO npm dependency (see README rationale).
// Pure functions, fully testable. The library never touches disk or LanceDB;
// callers pass in the already-scanned chunk texts. Corpus stats (df, avgdl) are
// rebuilt in-memory per query — trivial at this corpus size (a few hundred
// chunks, < 50 ms) and keeps LanceDB a pure store (no tf/df columns to maintain).

// Minimal English stopword list. Kept deliberately small: removing high-frequency
// function words sharpens BM25 relevance AND widens the real-vs-garbage score gap
// that the refusal threshold depends on ("how do I bake bread" collapses to
// {bake, bread}, neither in the corpus -> score ~0 -> honest refusal).
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'for', 'and', 'or', 'nor', 'but', 'if', 'then',
  'where', 'when', 'how', 'what', 'which', 'who', 'whom', 'why', 'that',
  'this', 'these', 'those', 'with', 'from', 'at', 'by', 'as', 'it', 'its',
  'we', 'you', 'i', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'about', 'into', 'over', 'under', 'out', 'up', 'down', 'so', 'no', 'not',
]);

// Lowercase, split on any non-alphanumeric run (so SOLVER_UW_SWEEP -> solver, uw,
// sweep; GATES.md -> gates, md), drop length-1 tokens and stopwords.
export function tokenize(str) {
  if (!str) return [];
  const out = [];
  for (const raw of String(str).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

// Build the in-memory BM25 corpus from an array of raw text strings.
export function buildCorpus(texts) {
  const docs = texts.map((t) => {
    const tokens = tokenize(t);
    const tf = new Map();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
    return { tf, len: tokens.length };
  });
  const N = docs.length;
  const df = new Map();
  for (const d of docs) {
    for (const term of d.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const totalLen = docs.reduce((s, d) => s + d.len, 0);
  const avgdl = N > 0 ? totalLen / N : 0;
  return { docs, df, N, avgdl };
}

// Okapi BM25 score of one document against the query tokens.
export function bm25Score(corpus, docIndex, queryTokens, { k1 = 1.5, b = 0.75 } = {}) {
  const { docs, df, N, avgdl } = corpus;
  const doc = docs[docIndex];
  if (!doc || doc.len === 0 || avgdl === 0) return 0;
  let score = 0;
  const seen = new Set();
  for (const term of queryTokens) {
    if (seen.has(term)) continue; // count each distinct query term once
    seen.add(term);
    const f = doc.tf.get(term);
    if (!f) continue;
    const n = df.get(term) || 0;
    // idf with the standard BM25 +0.5 smoothing, floored at 0 so ultra-common
    // terms can never subtract from the score.
    const idf = Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    const denom = f + k1 * (1 - b + b * (doc.len / avgdl));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}

// Rank all texts against a query string. Returns [{index, score}] for every doc
// (unsorted); the caller folds in heading/authority signals and sorts.
export function bm25Rank(texts, query, opts = {}) {
  const corpus = buildCorpus(texts);
  const q = tokenize(query);
  return texts.map((_, i) => ({ index: i, score: bm25Score(corpus, i, q, opts) }));
}
