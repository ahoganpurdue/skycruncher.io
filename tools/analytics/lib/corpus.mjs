#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/lib/corpus.mjs — the QUERY CORE every analytics module imports.
// Joins the population-run receipts, ledgers, forensic dossiers, and assisted
// (hinted-cocoon) envelope deposits into ONE frame-record roster keyed by frame
// content sha (filename fallback), then provides the query primitives + the
// spec-as-receipt emitter every analytics CLI is built on.
// ═══════════════════════════════════════════════════════════════════════════
//
// HOUSE LAWS embodied here:
//   · LAW 3 (honest-or-absent): a missing source is reported ABSENT and
//     contributes nothing — never fabricated, never silently dropped. Every
//     provenance value is READ from the data or `null`. Frame dims / matched
//     stars absent on a no-solve frame are simply absent, not zero-filled.
//   · Deterministic outputs: the same corpus + the same spec produce a
//     byte-identical result JSON. The ONLY wall-clock value is
//     provenance.generated_at (isolated in the provenance block). Frame records
//     are returned sorted by key; emitResult serializes with recursively sorted
//     object keys (stableStringify).
//   · NEVER conflate blind vs assisted. A blind solve is ALWAYS labelled
//     solve_class 'blind'; an assisted (hinted) solve only becomes a record's
//     `kind` when there is NO blind solve. Assisted solves live ONLY in
//     envelope_rows[] — they are never merged into the blind `receipt`/`solution`.
//
// ─── FRAME IDENTITY (sha, filename fallback) ─────────────────────────────────
// Population frames carry NO intake sha in the receipt (source_provenance:null —
// they are bundled/local, not intake-fetched). The content sha lives in the
// LEDGER (`sha`), the DOSSIER (`key`/`frame.sha256`), the no-solve receipt
// (`frame_sha256`), and the envelope deposit (`frame_sha`). Solved receipts and
// the no-solve-rerun ledger are keyed only by FILENAME.
//   Resolution is two-phase so every source of a frame collapses onto one key:
//     Phase A — scan all items; build a global filename-stem → sha map from every
//               item that carries BOTH a stem and a sha (ledger id→sha is the
//               authoritative 96-entry map; no-solve receipts add frame_sha256).
//     Phase B — each item's sha = own sha ?? map[stem] ?? null. key = `sha:<sha>`
//               when known (key_mode 'sha') else `file:<stem>` (key_mode
//               'filename'). key_mode is recorded per frame — never silent.
//   Two filenames sharing one sha (an intentional archive duplicate) collapse to
//   ONE record carrying both filenames — that is the dedup the sha key exists for.
//
// ─── RECORD SHAPE ────────────────────────────────────────────────────────────
//   { key, key_mode, sha|null, id, outcome|null, kind, solve_class,
//     receipt|null, receipt_path|null, dossier|null,
//     ledger_rows[], envelope_rows[], dims|null, frame_names[],
//     has_blind_solve, has_assisted_solve, assisted_solve_count }
//   kind         solved | no_solve | assisted  (blind-solve precedence; see below)
//   solve_class  blind | assisted  (the lane the `kind` was decided by)
//   outcome      the raw BLIND-run resolved outcome from the ledger
//                (solved | no_solve | honest_timeout | skipped_* | …), honest null.
//                A rerun RECOVERY keeps its blind outcome here (e.g. 'no_solve')
//                while kind flips to 'solved' — recovery stays visible.
//   receipt      the BLIND-lane parsed receipt (population OR no-solve-rerun);
//                assisted solves are NEVER placed here.
//   kind precedence (deterministic, non-conflating):
//     1) a blind solve exists (receipt.solution present OR a blind ledger row
//        outcome==='solved')            → kind 'solved',   solve_class 'blind'
//     2) else an assisted envelope solve → kind 'assisted', solve_class 'assisted'
//     3) else                            → kind 'no_solve', solve_class 'blind'
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitHeadShort } from '../../db/deposit.mjs';

export const CORPUS_CORE_VERSION = '1.0.0';

const __dir = path.dirname(fileURLToPath(import.meta.url));
// tools/analytics/lib → repo root is three up.
export const REPO_ROOT = path.resolve(__dir, '..', '..', '..');

// ── small honest helpers ──────────────────────────────────────────────────────
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function nonEmptyStr(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : null; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// forward-slash a path so emitted records are byte-identical across Windows/Linux
// (path.join would inject backslashes on Windows and break the determinism law).
export function toPosix(p) { return String(p).replace(/\\/g, '/'); }

// strip the on-disk suffix to recover a frame's filename stem (its ledger id).
export function frameStem(file) {
  return file
    .replace(/\.receipt\.json$/i, '')
    .replace(/\.dossier\.json$/i, '')
    .replace(/\.json$/i, '');
}

// resolve a source path: absolute stays, relative resolves against a root
// (default = repo root) so a manifest of repo-relative + absolute (D:\) paths
// both work from any cwd.
export function resolvePath(p, root = REPO_ROOT) {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

// ── source readers (all honest-absent: missing → {present:false, …}) ──────────
function readJsonlFile(p) {
  const rows = [];
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (e) { throw new Error(`corpus: bad JSONL at ${p}:${i + 1}: ${e.message}`); }
  }
  return rows;
}
function readJsonDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let obj;
    try { obj = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { throw new Error(`corpus: cannot parse ${full}: ${e.message}`); }
    out.push({ file: f, path: full, obj });
  }
  return out;
}

// sha readers per source shape (READ or null — never guess).
function shaOfLedgerRow(r) { return nonEmptyStr(r && r.sha); }
function shaOfDossier(d) {
  const fromFrame = isObj(d) && isObj(d.frame) ? nonEmptyStr(d.frame.sha256) : null;
  if (fromFrame) return fromFrame;
  // key is like "sha:<hex>" when key_mode === 'sha'
  if (isObj(d) && d.key_mode === 'sha' && typeof d.key === 'string') {
    const m = d.key.match(/^sha:(.+)$/);
    if (m) return nonEmptyStr(m[1]);
  }
  return null;
}
function shaOfNoSolveReceipt(r) { return isObj(r) ? nonEmptyStr(r.frame_sha256) : null; }

// ── frame dims (for the matched-star iterator) ────────────────────────────────
// solved receipts carry metadata.width/height; no-solve receipts carry
// image_width/image_height. Absent → null (honest), never zero-filled.
export function frameDims(receipt) {
  if (!isObj(receipt)) return null;
  const m = isObj(receipt.metadata) ? receipt.metadata : {};
  const w = num(m.width) ?? num(receipt.image_width) ?? num(receipt.width);
  const h = num(m.height) ?? num(receipt.image_height) ?? num(receipt.height);
  return (w && h) ? { width: w, height: h } : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// loadCorpus — the join.
// spec: { receiptDirs?[], ledgers?[], dossierDir?|dossierDirs?[], envelopeLedgers?[], root? }
// returns { frames[], sources{}, counts{} }  (never throws on a missing source)
// ═══════════════════════════════════════════════════════════════════════════
export function loadCorpus(spec = {}) {
  const root = spec.root ? path.resolve(spec.root) : REPO_ROOT;
  const receiptDirs = (spec.receiptDirs || []).map((p) => ({ raw: p, abs: resolvePath(p, root) }));
  const ledgers = (spec.ledgers || []).map((p) => ({ raw: p, abs: resolvePath(p, root) }));
  const dossierDirsRaw = spec.dossierDirs || (spec.dossierDir ? [spec.dossierDir] : []);
  const dossierDirs = dossierDirsRaw.map((p) => ({ raw: p, abs: resolvePath(p, root) }));
  const envelopeLedgers = (spec.envelopeLedgers || []).map((p) => ({ raw: p, abs: resolvePath(p, root) }));

  const sources = { receipt_dirs: [], ledgers: [], dossier_dirs: [], envelope_ledgers: [] };

  // Each raw item: { kind, stem, sha, payload, srcRaw }. Collected before keying.
  const items = [];

  // (1) ledgers — authoritative id→sha map lives here; every row kept.
  for (const { raw, abs } of ledgers) {
    if (!fs.existsSync(abs)) { sources.ledgers.push({ path: raw, present: false, row_count: 0 }); continue; }
    const rows = readJsonlFile(abs);
    sources.ledgers.push({ path: raw, present: true, row_count: rows.length });
    for (const r of rows) {
      const stem = nonEmptyStr(r.id) || (nonEmptyStr(r.path) ? frameStem(path.basename(r.path)) : null);
      items.push({ kind: 'ledger', stem, sha: shaOfLedgerRow(r), payload: r, srcRaw: raw });
    }
  }

  // (2) receipt dirs — solved receipts (no sha) + no-solve receipts (frame_sha256).
  for (const { raw, abs } of receiptDirs) {
    if (!fs.existsSync(abs)) { sources.receipt_dirs.push({ path: raw, present: false, receipt_count: 0 }); continue; }
    const loaded = readJsonDir(abs);
    sources.receipt_dirs.push({ path: raw, present: true, receipt_count: loaded.length });
    for (const { file, path: full, obj } of loaded) {
      items.push({
        kind: 'receipt', stem: frameStem(file), sha: shaOfNoSolveReceipt(obj),
        payload: obj, receiptPath: full, receiptRelPath: `${toPosix(raw)}/${file}`, srcRaw: raw,
      });
    }
  }

  // (3) dossiers — carry sha directly.
  for (const { raw, abs } of dossierDirs) {
    if (!fs.existsSync(abs)) { sources.dossier_dirs.push({ path: raw, present: false, dossier_count: 0 }); continue; }
    const loaded = readJsonDir(abs);
    sources.dossier_dirs.push({ path: raw, present: true, dossier_count: loaded.length });
    for (const { file, obj } of loaded) {
      const stem = frameStem(file);
      items.push({ kind: 'dossier', stem, sha: shaOfDossier(obj), payload: obj, srcRaw: raw });
    }
  }

  // (4) envelope ledgers — ASSISTED lane deposits (frame_sha keyed).
  for (const { raw, abs } of envelopeLedgers) {
    if (!fs.existsSync(abs)) { sources.envelope_ledgers.push({ path: raw, present: false, row_count: 0 }); continue; }
    const rows = readJsonlFile(abs);
    sources.envelope_ledgers.push({ path: raw, present: true, row_count: rows.length });
    for (const r of rows) {
      const stem = nonEmptyStr(r.frame_basename) ? frameStem(r.frame_basename)
        : (nonEmptyStr(r.frame) ? frameStem(r.frame) : null);
      items.push({ kind: 'envelope', stem, sha: nonEmptyStr(r.frame_sha), payload: r, srcRaw: raw });
    }
  }

  // ── Phase A: global stem → sha map (only from items that carry both). ────────
  const stemToSha = new Map();
  const stemShaConflicts = [];
  for (const it of items) {
    if (it.stem && it.sha) {
      const prior = stemToSha.get(it.stem);
      if (prior && prior !== it.sha) stemShaConflicts.push({ stem: it.stem, a: prior, b: it.sha });
      else if (!prior) stemToSha.set(it.stem, it.sha);
    }
  }

  // ── Phase B: resolve each item's key, then group. ───────────────────────────
  const groups = new Map(); // key → record-builder bucket
  for (const it of items) {
    const sha = it.sha || (it.stem ? stemToSha.get(it.stem) || null : null);
    const key = sha ? `sha:${sha}` : (it.stem ? `file:${it.stem}` : 'file:<unknown>');
    const key_mode = sha ? 'sha' : 'filename';
    let g = groups.get(key);
    if (!g) {
      g = { key, key_mode, sha, stems: new Set(), ledger: [], receipts: [], dossiers: [], envelopes: [] };
      groups.set(key, g);
    }
    if (it.stem) g.stems.add(it.stem);
    if (it.kind === 'ledger') g.ledger.push({ row: it.payload, __source: it.srcRaw });
    else if (it.kind === 'receipt') g.receipts.push({ obj: it.payload, path: it.receiptPath, relPath: it.receiptRelPath, __source: it.srcRaw });
    else if (it.kind === 'dossier') g.dossiers.push({ obj: it.payload, __source: it.srcRaw });
    else if (it.kind === 'envelope') g.envelopes.push({ row: it.payload, __source: it.srcRaw });
  }

  // ── build final records (deterministic: sorted by key) ───────────────────────
  const frames = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    const frame_names = [...g.stems].sort();
    const id = pickId(g, frame_names);

    // receipt: deterministic single blind receipt (sorted by path). Note collision.
    const receiptsSorted = g.receipts.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const chosenReceipt = receiptsSorted[0] || null;
    const receipt = chosenReceipt ? chosenReceipt.obj : null;
    const receipt_path = chosenReceipt ? chosenReceipt.relPath : null;

    // dossier: deterministic single (sorted by a stable field).
    const dossier = pickDossier(g.dossiers);

    // ledger rows (blind lane) — deterministic order by (source, seq/id).
    const ledger_rows = g.ledger.map((l) => ({ ...l.row, __ledger: l.__source }))
      .sort(ledgerRowCmp);
    // envelope rows (assisted lane) — deterministic order.
    const envelope_rows = g.envelopes.map((e) => ({ ...e.row, __envelope: e.__source }))
      .sort(envelopeRowCmp);

    const outcome = resolveOutcome(ledger_rows, receipt);
    const has_blind_solve = !!(isObj(receipt) && isObj(receipt.solution))
      || ledger_rows.some((r) => r.outcome === 'solved' || r.resolved_outcome === 'solved');
    const assistedSolves = envelope_rows.filter((r) => r.outcome === 'solved');
    const has_assisted_solve = assistedSolves.length > 0;

    const kind = has_blind_solve ? 'solved' : (has_assisted_solve ? 'assisted' : 'no_solve');
    const solve_class = has_blind_solve ? 'blind' : (has_assisted_solve ? 'assisted' : 'blind');

    frames.push({
      key: g.key,
      key_mode: g.key_mode,
      sha: g.sha,
      id,
      outcome,
      kind,
      solve_class,
      receipt,
      receipt_path,
      dossier,
      ledger_rows,
      envelope_rows,
      dims: frameDims(receipt),
      frame_names,
      has_blind_solve,
      has_assisted_solve,
      assisted_solve_count: assistedSolves.length,
      receipt_collision: g.receipts.length > 1
        ? g.receipts.map((r) => r.relPath).sort() : null,
    });
  }

  const counts = tallyCorpus(frames);
  counts.stem_sha_conflicts = stemShaConflicts.length;
  return {
    frames,
    sources: { ...sources, stem_sha_conflicts: stemShaConflicts },
    counts,
    root,
  };
}

function pickId(g, frame_names) {
  // prefer a ledger id, then a receipt stem, then any stem — deterministic.
  for (const l of g.ledger) { const s = nonEmptyStr(l.row.id); if (s) return s; }
  if (frame_names.length) return frame_names[0];
  return g.sha ? g.sha : g.key;
}
function pickDossier(dossiers) {
  if (!dossiers.length) return null;
  const sorted = dossiers.slice().sort((a, b) => {
    const ka = String(a.obj && a.obj.key || ''), kb = String(b.obj && b.obj.key || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return sorted[0].obj;
}
function ledgerRowCmp(a, b) {
  const sa = String(a.__ledger || ''), sb = String(b.__ledger || '');
  if (sa !== sb) return sa < sb ? -1 : 1;
  const qa = num(a.seq), qb = num(b.seq);
  if (qa !== null && qb !== null && qa !== qb) return qa - qb;
  const ia = String(a.id || ''), ib = String(b.id || '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
function envelopeRowCmp(a, b) {
  const ta = String(a.ts || ''), tb = String(b.ts || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  const fa = String(a.frame_basename || a.frame || ''), fb = String(b.frame_basename || b.frame || '');
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}
// blind-run disposition: prefer a population ledger row, then any ledger row,
// then receipt-derived, else null (honest).
function resolveOutcome(ledger_rows, receipt) {
  for (const r of ledger_rows) {
    const o = nonEmptyStr(r.resolved_outcome) || nonEmptyStr(r.outcome);
    if (o) return o;
  }
  if (isObj(receipt)) {
    if (isObj(receipt.solution)) return 'solved';
    if (nonEmptyStr(receipt.kind)) return receipt.kind;
    return 'no_solve';
  }
  return null;
}

function tallyCorpus(frames) {
  const c = {
    frames: frames.length,
    by_kind: { solved: 0, no_solve: 0, assisted: 0 },
    by_solve_class: { blind: 0, assisted: 0 },
    by_outcome: {},
    by_key_mode: { sha: 0, filename: 0 },
    with_receipt: 0, with_dossier: 0, with_envelope: 0,
    with_blind_solve: 0, with_assisted_solve: 0,
    receipt_collisions: 0,
  };
  for (const f of frames) {
    c.by_kind[f.kind] = (c.by_kind[f.kind] || 0) + 1;
    c.by_solve_class[f.solve_class] = (c.by_solve_class[f.solve_class] || 0) + 1;
    const o = f.outcome == null ? 'null' : f.outcome;
    c.by_outcome[o] = (c.by_outcome[o] || 0) + 1;
    c.by_key_mode[f.key_mode] = (c.by_key_mode[f.key_mode] || 0) + 1;
    if (f.receipt) c.with_receipt++;
    if (f.dossier) c.with_dossier++;
    if (f.envelope_rows.length) c.with_envelope++;
    if (f.has_blind_solve) c.with_blind_solve++;
    if (f.has_assisted_solve) c.with_assisted_solve++;
    if (f.receipt_collision) c.receipt_collisions++;
  }
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
// Query primitives.
// ═══════════════════════════════════════════════════════════════════════════
export function filter(frames, predicate) { return frames.filter(predicate); }

// groupBy → Map with keys inserted in sorted order (deterministic iteration).
export function groupBy(frames, keyFn) {
  const tmp = new Map();
  for (const f of frames) {
    const k = keyFn(f);
    const kk = k == null ? '∅' : String(k);
    if (!tmp.has(kk)) tmp.set(kk, []);
    tmp.get(kk).push(f);
  }
  const out = new Map();
  for (const k of [...tmp.keys()].sort()) out.set(k, tmp.get(k));
  return out;
}

// summarize a numeric sample — honest n, null stats on empty (never 0-as-absent).
export function summarize(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0, min: null, max: null, mean: null, median: null, sum: null, p90: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  const q = (p) => {
    if (n === 1) return xs[0];
    const idx = p * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  };
  return { n, min: xs[0], max: xs[n - 1], mean: sum / n, median: q(0.5), sum, p90: q(0.9) };
}

// aggregate: group frames, map each group's frames → a numeric sample via
// valueFn, summarize. Returns a plain object keyed by group (sorted keys).
export function aggregateBy(frames, keyFn, valueFn) {
  const groups = groupBy(frames, keyFn);
  const out = {};
  for (const [k, fs_] of groups) {
    const sample = [];
    for (const f of fs_) { const v = valueFn(f); if (typeof v === 'number' && Number.isFinite(v)) sample.push(v); }
    out[k] = summarize(sample);
  }
  return out;
}

// ── matched-star iterator ─────────────────────────────────────────────────────
// Lazy generator over every matched star of every (blind-solved) frame, with a
// center-normalized radius. radius_norm = distance-from-center / half-diagonal, so
// 0 at the optical center and ~1.0 at a frame corner. Absent dims / no solution →
// the frame yields nothing (honest — never fabricated positions).
export function* iterMatchedStars(frames, opts = {}) {
  const only = opts.onlyKind ? new Set([].concat(opts.onlyKind)) : null;
  for (const f of frames) {
    if (only && !only.has(f.kind)) continue;
    const sol = f.receipt && f.receipt.solution;
    const stars = sol && Array.isArray(sol.matched_stars) ? sol.matched_stars : null;
    if (!stars) continue;
    const dims = f.dims;
    const cx = dims ? dims.width / 2 : null;
    const cy = dims ? dims.height / 2 : null;
    const halfDiag = dims ? 0.5 * Math.hypot(dims.width, dims.height) : null;
    for (const s of stars) {
      const x = num(s.x), y = num(s.y);
      let radius_px = null, radius_norm = null;
      if (x !== null && y !== null && cx !== null) {
        radius_px = Math.hypot(x - cx, y - cy);
        radius_norm = halfDiag ? radius_px / halfDiag : null;
      }
      yield {
        sha: f.sha, id: f.id, frame_kind: f.kind,
        gaia_id: s.gaia_id ?? null, name: s.name ?? null,
        x, y, mag: num(s.mag), flux: num(s.flux), fwhm: num(s.fwhm),
        residual_arcsec: num(s.residual_arcsec),
        dx_px: num(s.dx_px), dy_px: num(s.dy_px),
        width: dims ? dims.width : null, height: dims ? dims.height : null,
        cx, cy, radius_px, radius_norm,
      };
    }
  }
}
// convenience: materialize one frame's stars.
export function matchedStars(frame) { return [...iterMatchedStars([frame])]; }

// ═══════════════════════════════════════════════════════════════════════════
// Spec-as-receipt emitter (the reproducibility law).
// ═══════════════════════════════════════════════════════════════════════════
// Recursively sort object keys → canonical structure (arrays keep order; the
// caller builds arrays deterministically from the sorted frame roster).
export function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}
// deterministic serialization: canonical key order, given indent.
export function stableStringify(v, indent = 2) {
  return JSON.stringify(canonicalize(v), null, indent);
}

// Build the { corpus_paths, row_counts, git_head } provenance from a loadCorpus
// result — the reproducibility record of WHICH bytes produced a figure.
export function corpusProvenance(loaded, root = REPO_ROOT) {
  const s = loaded.sources || {};
  return {
    corpus_paths: {
      receipt_dirs: (s.receipt_dirs || []).map((r) => ({ path: r.path, present: r.present, receipts: r.receipt_count })),
      ledgers: (s.ledgers || []).map((r) => ({ path: r.path, present: r.present, rows: r.row_count })),
      dossier_dirs: (s.dossier_dirs || []).map((r) => ({ path: r.path, present: r.present, dossiers: r.dossier_count })),
      envelope_ledgers: (s.envelope_ledgers || []).map((r) => ({ path: r.path, present: r.present, rows: r.row_count })),
    },
    row_counts: loaded.counts,
    git_head: gitHeadShort(root),
  };
}

// emitResult(spec, data, provenanceExtras) → { spec, provenance, data }.
// generated_at (wall clock) is the ONLY non-deterministic field and is isolated
// in provenance. Serialize with stableStringify for byte-identical output.
export function emitResult(spec, data, provenanceExtras = {}) {
  return {
    spec: spec ?? null,
    provenance: {
      ...provenanceExtras,
      generated_at: new Date().toISOString(),
    },
    data: data ?? null,
  };
}

// ── default manifest loader ───────────────────────────────────────────────────
export const DEFAULT_MANIFEST_PATH = path.resolve(__dir, '..', 'corpus.default.json');
export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const abs = path.resolve(manifestPath);
  const m = JSON.parse(fs.readFileSync(abs, 'utf8'));
  // manifest paths resolve against the repo root (so a manifest of repo-relative
  // + absolute paths is portable). Carry the manifest's own path for provenance.
  return { ...m, __manifest_path: abs };
}
// convenience: load the default corpus in one call.
export function loadDefaultCorpus(manifestPath = DEFAULT_MANIFEST_PATH) {
  const m = loadManifest(manifestPath);
  const loaded = loadCorpus({
    receiptDirs: m.receiptDirs || [],
    ledgers: m.ledgers || [],
    dossierDir: m.dossierDir,
    dossierDirs: m.dossierDirs,
    envelopeLedgers: m.envelopeLedgers || [],
    root: m.root ? resolvePath(m.root) : REPO_ROOT,
  });
  loaded.manifest = m;
  return loaded;
}
