#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/lib/corpus_test.mjs — self-test for the analytics query core.
// Plain-assert, vitest-free, node-runnable (tools-lane idiom, matches
// deposit_test.mjs / receipt_diff_test.mjs). Named `*_test.mjs` (underscore) NOT
// `*.test.mjs` DELIBERATELY — the dot form is swept by vitest and would break the
// `npx vitest run` gate. Run standalone:  node tools/analytics/lib/corpus_test.mjs
//
// Covers: join correctness on synthetic fixtures (sha key · filename fallback ·
// sha/filename cross-source merge · duplicate collapse · dossier-only frame) ·
// assisted-NEVER-conflated (blind stays no_solve; assisted lives only in
// envelope_rows; kind flips to 'assisted' only absent a blind solve) · rerun
// recovery (blind outcome preserved, kind solved) · determinism (double-run
// byte-identical) · honest-null on missing sources · query primitives · the
// center-normalized matched-star iterator · the spec-as-receipt emitter.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCorpus, filter, groupBy, summarize, aggregateBy,
  iterMatchedStars, matchedStars, canonicalize, stableStringify,
  emitResult, corpusProvenance, frameDims, frameStem,
} from './corpus.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64), SHA_D = 'd'.repeat(64), SHA_E = 'e'.repeat(64), SHA_F = 'f'.repeat(64);
const W = 100, H = 200;

// ── build a synthetic corpus on disk ─────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus_test_'));
const solvedDir = path.join(TMP, 'receipts');
const nosolveDir = path.join(TMP, 'nosolve', 'receipts');
const dossierDir = path.join(TMP, 'dossiers');
fs.mkdirSync(solvedDir, { recursive: true });
fs.mkdirSync(nosolveDir, { recursive: true });
fs.mkdirSync(dossierDir, { recursive: true });
const wj = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const wjl = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Frame A — blind solved. Receipt carries NO sha; ledger supplies it (cross-source merge).
wj(path.join(solvedDir, 'frameA.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null, metadata: { width: W, height: H },
  solution: { ra_hours: 1, matched_stars: [
    { gaia_id: 'g_center', x: W / 2, y: H / 2, residual_arcsec: 0.5, mag: 10 },
    { gaia_id: 'g_corner', x: 0, y: 0, residual_arcsec: 1.5, mag: 12 },
  ] },
});
// Frame F — rerun RECOVERY (lived in nosolve dir, solution present). Blind outcome
// stays no_solve in the ledger; kind must flip to solved (still blind lane).
wj(path.join(nosolveDir, 'frameF.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null, metadata: { width: 50, height: 50 },
  solution: { ra_hours: 9, matched_stars: [{ gaia_id: 'gf', x: 25, y: 25, residual_arcsec: 0.9, mag: 11 }] },
});
// Frame B — blind FAILED then ASSISTED solved. No-solve receipt carries frame_sha256.
wj(path.join(nosolveDir, 'frameB.fit.receipt.json'), {
  version: '2.13.0', kind: 'no_solve', solution: null, frame_sha256: SHA_B,
  image_width: 80, image_height: 80, source_provenance: null,
});
// Frame C — filename FALLBACK: solved receipt with no sha anywhere (no ledger, no frame_sha256).
wj(path.join(solvedDir, 'frameC.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null, metadata: { width: 10, height: 10 },
  solution: { ra_hours: 3, matched_stars: [] },
});
// Frame D — DUPLICATE collapse: two stems, one sha, two solved receipts + two ledger rows.
wj(path.join(solvedDir, 'frameD.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null, metadata: { width: 20, height: 20 },
  solution: { ra_hours: 4, matched_stars: [] },
});
wj(path.join(solvedDir, 'archive_frameD.fit.receipt.json'), {
  version: '2.13.0', source_provenance: null, metadata: { width: 20, height: 20 },
  solution: { ra_hours: 4, matched_stars: [] },
});
// Frame E — DOSSIER-ONLY (no receipt, no ledger, no envelope). Present via sha in dossier.
wj(path.join(dossierDir, 'frameE.fit.dossier.json'), {
  tool: 'failure_dossier', schema: '1.0.0', key: `sha:${SHA_E}`, key_mode: 'sha',
  frame: { name: 'frameE.fit', sha256: SHA_E }, outcome: 'no_solve',
  taxonomy: { class: 'no_solve', basis: 'synthetic' },
});

// ledgers (blind lane)
const popLedger = path.join(TMP, 'ledger_resolved.jsonl');
wjl(popLedger, [
  { seq: 1, id: 'frameA.fit', path: 'frameA.fit', sha: SHA_A, outcome: 'solved', resolved_outcome: 'solved', stages: { load: 1, solve: 5 } },
  { seq: 2, id: 'frameB.fit', path: 'frameB.fit', sha: SHA_B, outcome: 'no_solve', resolved_outcome: 'no_solve', stages: { load: 1 } },
  { seq: 3, id: 'frameD.fit', path: 'frameD.fit', sha: SHA_D, outcome: 'solved', resolved_outcome: 'solved', stages: { load: 1, solve: 7 } },
  { seq: 4, id: 'archive_frameD.fit', path: 'archive/frameD.fit', sha: SHA_D, outcome: 'solved', resolved_outcome: 'solved', stages: { load: 1, solve: 7 } },
  { seq: 5, id: 'frameF.fit', path: 'frameF.fit', sha: SHA_F, outcome: 'no_solve', resolved_outcome: 'no_solve', stages: { load: 1 } },
]);
const nosolveLedger = path.join(TMP, 'nosolve', 'ledger.jsonl');
wjl(nosolveLedger, [
  { seq: 1, id: 'frameB.fit', path: 'frameB.fit', outcome: 'no_solve', stages: { load: 1 } },
  { seq: 2, id: 'frameF.fit', path: 'frameF.fit', outcome: 'solved', stages: { load: 1, solve: 3 } },
]);

// envelope ledger (assisted lane) — Frame B gets an assisted solve.
const envLedger = path.join(TMP, 'ledger_envelope.jsonl');
wjl(envLedger, [
  { row_schema: '1.0.0', run_label: 'HINTED-COCOON', solve_class: 'assisted', outcome: 'solved',
    frame_sha: SHA_B, frame_sha_mode: 'content_sha256', frame_basename: 'frameB.fit', ra_hours: 5.5, matched: 40 },
]);

const spec = {
  receiptDirs: [solvedDir, nosolveDir],
  ledgers: [popLedger, nosolveLedger],
  dossierDir,
  envelopeLedgers: [envLedger],
};

try {
  const loaded = loadCorpus(spec);
  const byKey = new Map(loaded.frames.map((f) => [f.key, f]));

  // ── (1) roster + counts ─────────────────────────────────────────────────
  eq(loaded.frames.length, 6, 'six distinct frame records (A,B,C,D-collapsed,E,F)');
  eq(loaded.counts.by_key_mode.sha, 5, 'five sha-keyed frames (A,B,D,E,F)');
  eq(loaded.counts.by_key_mode.filename, 1, 'one filename-fallback frame (C)');
  eq(loaded.counts.by_kind.solved, 4, 'solved kind: A, C, D, F (recovery)');
  eq(loaded.counts.by_kind.assisted, 1, 'assisted kind: B');
  eq(loaded.counts.by_kind.no_solve, 1, 'no_solve kind: E (dossier-only)');

  // C solved via its solution, and is the filename-fallback frame:
  eq(byKey.get('file:frameC.fit').kind, 'solved', 'C is solved via solution (filename-keyed)');

  // ── (2) sha keying + cross-source merge (A) ─────────────────────────────
  const A = byKey.get(`sha:${SHA_A}`);
  ok(A, 'A keyed by sha');
  eq(A.key_mode, 'sha', 'A key_mode sha');
  ok(A.receipt && A.receipt.solution, 'A receipt (no sha in it) merged with ledger by sha');
  eq(A.ledger_rows.length, 1, 'A has its ledger row');
  eq(A.solve_class, 'blind', 'A solve_class blind');

  // ── (3) filename fallback (C) ───────────────────────────────────────────
  const C = byKey.get('file:frameC.fit');
  ok(C, 'C keyed by filename (no sha anywhere)');
  eq(C.key_mode, 'filename', 'C key_mode filename');
  eq(C.sha, null, 'C sha null (honest)');

  // ── (4) assisted NEVER conflated (B) ────────────────────────────────────
  const B = byKey.get(`sha:${SHA_B}`);
  ok(B, 'B keyed by sha (from frame_sha256/ledger/envelope)');
  eq(B.kind, 'assisted', 'B kind assisted (no blind solve, has assisted solve)');
  eq(B.solve_class, 'assisted', 'B solve_class assisted');
  eq(B.outcome, 'no_solve', 'B blind outcome PRESERVED as no_solve (not overwritten by assisted)');
  eq(B.has_blind_solve, false, 'B has NO blind solve');
  eq(B.has_assisted_solve, true, 'B has an assisted solve');
  eq(B.receipt && B.receipt.solution, null, 'B receipt is the BLIND no-solve receipt (solution null) — assisted NOT merged in');
  eq(B.envelope_rows.length, 1, 'B assisted solve lives in envelope_rows');
  eq(B.envelope_rows[0].solve_class, 'assisted', 'B envelope row carries solve_class assisted');
  eq(B.assisted_solve_count, 1, 'B assisted_solve_count 1');

  // ── (5) rerun recovery (F): blind outcome preserved, kind solved, still blind ──
  const F = byKey.get(`sha:${SHA_F}`);
  ok(F, 'F present');
  eq(F.kind, 'solved', 'F kind solved (recovered via blind rerun receipt)');
  eq(F.solve_class, 'blind', 'F recovery is still BLIND lane');
  eq(F.outcome, 'no_solve', 'F population blind outcome preserved as no_solve');
  eq(F.ledger_rows.length, 2, 'F joins both the population and nosolve-rerun ledger rows');

  // ── (6) duplicate collapse (D) ──────────────────────────────────────────
  const D = byKey.get(`sha:${SHA_D}`);
  ok(D, 'D collapsed to one sha record');
  eq(D.frame_names.length, 2, 'D carries both filenames');
  eq(D.ledger_rows.length, 2, 'D carries both ledger rows');
  ok(Array.isArray(D.receipt_collision) && D.receipt_collision.length === 2, 'D flags a receipt collision (2 receipts, deterministic pick)');
  eq(D.kind, 'solved', 'D solved');

  // ── (7) dossier-only frame (E) ──────────────────────────────────────────
  const E = byKey.get(`sha:${SHA_E}`);
  ok(E, 'E present via dossier sha alone');
  eq(E.receipt, null, 'E has no receipt (honest null)');
  ok(E.dossier && E.dossier.taxonomy, 'E carries its dossier');
  eq(E.kind, 'no_solve', 'E no_solve (no solve of any lane)');

  // ── (8) determinism: double-run byte-identical ──────────────────────────
  const loaded2 = loadCorpus(spec);
  eq(stableStringify(loaded.frames), stableStringify(loaded2.frames), 'double-run frames byte-identical');

  // ── (9) honest-null on missing sources ──────────────────────────────────
  const missingSpec = {
    receiptDirs: [solvedDir, path.join(TMP, 'does_not_exist')],
    ledgers: [popLedger, path.join(TMP, 'nope.jsonl')],
    dossierDir: path.join(TMP, 'no_dossiers'),
    envelopeLedgers: [path.join(TMP, 'no_env.jsonl')],
  };
  let missLoaded;
  let threw = false;
  try { missLoaded = loadCorpus(missingSpec); } catch { threw = true; }
  eq(threw, false, 'missing sources do NOT throw');
  eq(missLoaded.sources.receipt_dirs[1].present, false, 'missing receipt dir reported absent');
  eq(missLoaded.sources.ledgers[1].present, false, 'missing ledger reported absent');
  eq(missLoaded.sources.dossier_dirs[0].present, false, 'missing dossier dir reported absent');
  eq(missLoaded.sources.envelope_ledgers[0].present, false, 'missing envelope ledger reported absent');
  ok(missLoaded.frames.length >= 4, 'frames still built from the present sources');
  // nothing fabricated: a present dossier count is honest zero, not invented
  eq(missLoaded.counts.with_dossier, 0, 'no dossiers present → with_dossier honestly 0');

  // ── (10) matched-star iterator + center-normalized radius ───────────────
  const aStars = matchedStars(A);
  eq(aStars.length, 2, 'A yields 2 matched stars');
  const center = aStars.find((s) => s.gaia_id === 'g_center');
  const corner = aStars.find((s) => s.gaia_id === 'g_corner');
  eq(center.radius_px, 0, 'center star radius_px 0');
  eq(center.radius_norm, 0, 'center star radius_norm 0');
  ok(Math.abs(corner.radius_norm - 1.0) < 1e-9, 'corner star radius_norm ~1.0 (half-diagonal normalized)');
  // no-solve frame yields nothing (honest — no fabricated positions)
  eq(matchedStars(B).length, 0, 'no-solve frame B yields no stars');
  // iterator honors onlyKind
  const solvedStarCount = [...iterMatchedStars(loaded.frames, { onlyKind: 'solved' })].length;
  const allStarCount = [...iterMatchedStars(loaded.frames)].length;
  eq(solvedStarCount, allStarCount, 'onlyKind:solved == all (only solved frames have stars here)');
  ok(allStarCount === 3, 'total matched stars across corpus = 2 (A) + 0 + 1 (F) = 3');

  // ── (11) query primitives ───────────────────────────────────────────────
  eq(filter(loaded.frames, (f) => f.kind === 'solved').length, 4, 'filter solved → 4 (A,C,D,F)');
  const g = groupBy(loaded.frames, (f) => f.kind);
  eq([...g.keys()].join(','), 'assisted,no_solve,solved', 'groupBy keys sorted');
  // aggregate solve-stage ms by kind (from ledger rows) — honest summarize
  const agg = aggregateBy(
    filter(loaded.frames, (f) => f.ledger_rows.length > 0),
    (f) => f.kind,
    (f) => { const r = f.ledger_rows.find((x) => x.stages && typeof x.stages.solve === 'number'); return r ? r.stages.solve : null; },
  );
  ok(agg.solved && agg.solved.n >= 1, 'aggregateBy produced a solved-group summary');
  const s = summarize([3, 1, 2, null, 'x']);
  eq(s.n, 3, 'summarize ignores non-numbers');
  eq(s.median, 2, 'summarize median');
  eq(summarize([]).mean, null, 'summarize empty → null mean (honest, not 0)');

  // ── (12) emitResult / spec-as-receipt ───────────────────────────────────
  const prov = corpusProvenance(loaded);
  const r1 = emitResult(spec, { hello: 'world' }, prov);
  ok(r1.spec && r1.provenance && r1.data, 'emitResult has spec/provenance/data');
  ok(typeof r1.provenance.generated_at === 'string', 'provenance.generated_at present (the only wall clock)');
  ok(r1.provenance.git_head !== undefined, 'provenance carries git_head');
  ok(r1.provenance.corpus_paths && r1.provenance.row_counts, 'provenance carries corpus_paths + row_counts');
  // determinism: two emits differ ONLY in generated_at
  const strip = (r) => { const c = JSON.parse(stableStringify(r)); delete c.provenance.generated_at; return JSON.stringify(c); };
  const r2 = emitResult(spec, { hello: 'world' }, corpusProvenance(loaded));
  eq(strip(r1), strip(r2), 'emitResult deterministic except generated_at');
  // canonicalize sorts keys
  eq(stableStringify({ b: 1, a: 2 }), '{\n  "a": 2,\n  "b": 1\n}', 'stableStringify sorts object keys');

  // ── (13) misc unit ──────────────────────────────────────────────────────
  eq(frameStem('x.fit.receipt.json'), 'x.fit', 'frameStem strips .receipt.json');
  eq(frameStem('x.fit.dossier.json'), 'x.fit', 'frameStem strips .dossier.json');
  eq(JSON.stringify(frameDims({ metadata: { width: 4, height: 8 } })), '{"width":4,"height":8}', 'frameDims from metadata');
  eq(JSON.stringify(frameDims({ image_width: 5, image_height: 9 })), '{"width":5,"height":9}', 'frameDims from image_width/height');
  eq(frameDims({ metadata: {} }), null, 'frameDims null when absent (honest)');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\ncorpus_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
