#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/scope.mjs — change-aware scoping: changed files → affected stages
// ═══════════════════════════════════════════════════════════════════════════
// Contract: SEAM_CONTRACT.md §6 (frozen, 2026-07-12). v1 = static dir→stage
// anchor table (the §6 table, verbatim as data) + a cheap ONE-HOP regex import
// scan: a changed file that is IMPORTED BY an anchor-mapped file inherits that
// importer's stages. NOT a graph engine — one hop, no transitivity.
//
// HONEST FALLBACK (binding, LAW 3): any changed file not confidently mapped ⇒
// fallback_full=true with the unmapped files listed — the caller must run the
// FULL battery. fallback_full is DATA, not an error (exit 0). Over-testing is
// the safe direction; this mapper never guesses a narrower scope than it can
// defend from the table + one verified import edge.
//
// CLI:
//   node tools/testkit/lib/scope.mjs --diff <gitref>        (runs `git diff --name-only <gitref>` itself)
//   node tools/testkit/lib/scope.mjs --files a.ts b.ts ...
// stdout = deterministic JSON:
//   { schema: 'testkit.scope.v1', stages: [...sorted], fallback_full: bool,
//     mapped: {file→stages}, unmapped: [...], anchor_hits: n, import_hits: n }
// Cross-cutting files (orchestrator_session.ts, constants/, contracts/, core/)
// appear in `mapped` with the sentinel ['FULL'] (they ARE confidently mapped —
// to everything) and force fallback_full=true; only files with NO confident
// mapping at all go in `unmapped`. `stages` lists real stage ids only.
// Exit 0 whenever the analysis itself succeeds; exit 2 on usage/git errors.
//
// Purely static on paths — changed files need not exist on disk (deletions
// still map). Importer scan reads only files under src/engine/pipeline and
// src/engine/wasm_compute in the checkout it runs from.
//
// run.mjs integration point (builder-2 owns run.mjs this wave — do NOT wire
// here): future run.mjs imports { scopeFiles } from './lib/scope.mjs', runs
// only suites whose stage sets intersect result.stages, and runs the FULL
// battery whenever result.fallback_full is true. A replay MISMATCH is never
// auto-rebaselined (contract §6): fix, or full battery + explicit enumerated
// capsule re-freeze (LAW 2).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCOPE_SCHEMA = 'testkit.scope.v1';
export const FULL = 'FULL'; // sentinel stage for cross-cutting anchors

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..', '..', '..');

// ── path helpers ─────────────────────────────────────────────────────────────
function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return s.length ? s : null;
}
const segsOf = (p) => p.split('/');
const baseOf = (p) => segsOf(p).at(-1);
const baseNoExt = (p) => baseOf(p).replace(/\.[^.]+$/, '');
const hasSeg = (p, seg) => segsOf(p).includes(seg);
function hasSegPair(p, a, b) {
  const s = segsOf(p);
  for (let i = 0; i + 1 < s.length; i++) if (s[i] === a && s[i + 1] === b) return true;
  return false;
}
// stages/<name>.<ext> — EXACT basename (never prefix: stages/solve_provenance
// must NOT match a stages/solve anchor; §6 puts it under integrate).
function stageFile(p, name) {
  const s = segsOf(p);
  return s.length >= 2 && s.at(-2) === 'stages' && baseNoExt(p) === name;
}
function inDirBaseExact(p, dir, names) { return hasSeg(p, dir) && names.includes(baseNoExt(p)); }
function inDirBasePrefix(p, dir, prefixes) {
  return hasSeg(p, dir) && prefixes.some((pre) => baseNoExt(p).startsWith(pre));
}

// ── ANCHOR TABLE — SEAM_CONTRACT.md §6, verbatim as data ─────────────────────
// A file collects the UNION of stages from every entry it matches.
export const ANCHOR_TABLE = [
  // m1_ingestion | stages/ingest → load, extract
  { id: 'm1_ingestion', match: (p) => hasSeg(p, 'm1_ingestion'), stages: ['load', 'extract'] },
  { id: 'stages/ingest', match: (p) => stageFile(p, 'ingest'), stages: ['load', 'extract'] },
  // m4_signal_detect | stages/detect → extract
  { id: 'm4_signal_detect', match: (p) => hasSeg(p, 'm4_signal_detect'), stages: ['extract'] },
  { id: 'stages/detect', match: (p) => stageFile(p, 'detect'), stages: ['extract'] },
  // stages/metrology | m2_hardware/{scale,optics,sensor}* → metrology
  { id: 'stages/metrology', match: (p) => stageFile(p, 'metrology'), stages: ['metrology'] },
  { id: 'm2_hardware/{scale,optics,sensor}*', match: (p) => inDirBasePrefix(p, 'm2_hardware', ['scale', 'optics', 'sensor']), stages: ['metrology'] },
  // m6_plate_solve | wasm_compute | stages/solve | stages/solve_context → solve
  { id: 'm6_plate_solve', match: (p) => hasSeg(p, 'm6_plate_solve'), stages: ['solve'] },
  { id: 'wasm_compute', match: (p) => hasSeg(p, 'wasm_compute'), stages: ['solve'] },
  { id: 'stages/solve', match: (p) => stageFile(p, 'solve'), stages: ['solve'] },
  { id: 'stages/solve_context', match: (p) => stageFile(p, 'solve_context'), stages: ['solve'] },
  // (+forced_confirm for solver_entry/deep_verify/forced_confirm files)
  { id: 'm6 solver_entry/deep_verify/forced_confirm → +forced_confirm', match: (p) => inDirBaseExact(p, 'm6_plate_solve', ['solver_entry', 'deep_verify', 'forced_confirm']), stages: ['forced_confirm'] },
  // stages/calibrate | m7_astrometry → m7_refine
  { id: 'stages/calibrate', match: (p) => stageFile(p, 'calibrate'), stages: ['m7_refine'] },
  { id: 'm7_astrometry', match: (p) => hasSeg(p, 'm7_astrometry'), stages: ['m7_refine'] },
  // stages/science | m8_photometry → spcc
  { id: 'stages/science', match: (p) => stageFile(p, 'science'), stages: ['spcc'] },
  { id: 'm8_photometry', match: (p) => hasSeg(p, 'm8_photometry'), stages: ['spcc'] },
  // stages/psf_characterize | m10_psf → psf_field, psf_attribution, psf
  { id: 'stages/psf_characterize', match: (p) => stageFile(p, 'psf_characterize'), stages: ['psf_field', 'psf_attribution', 'psf'] },
  { id: 'm10_psf', match: (p) => hasSeg(p, 'm10_psf'), stages: ['psf_field', 'psf_attribution', 'psf'] },
  // m2_hardware/lens_distortion_refit → bc_measure  (EXACT base: the helper
  // lens_distortion_rematch.ts is deliberately NOT anchored — one-hop covers it)
  { id: 'm2_hardware/lens_distortion_refit', match: (p) => inDirBaseExact(p, 'm2_hardware', ['lens_distortion_refit']), stages: ['bc_measure'] },
  // m2_hardware/lens_distortion_rematch_pass → bc_rematch
  { id: 'm2_hardware/lens_distortion_rematch_pass', match: (p) => inDirBaseExact(p, 'm2_hardware', ['lens_distortion_rematch_pass']), stages: ['bc_rematch'] },
  // stages/package | stages/{schema_versions,solve_provenance,user_annotations,
  // receipt_serializer} | export/ | m9_export → integrate
  { id: 'stages/package', match: (p) => stageFile(p, 'package'), stages: ['integrate'] },
  { id: 'stages/schema_versions', match: (p) => stageFile(p, 'schema_versions'), stages: ['integrate'] },
  { id: 'stages/solve_provenance', match: (p) => stageFile(p, 'solve_provenance'), stages: ['integrate'] },
  { id: 'stages/user_annotations', match: (p) => stageFile(p, 'user_annotations'), stages: ['integrate'] },
  { id: 'stages/receipt_serializer', match: (p) => stageFile(p, 'receipt_serializer'), stages: ['integrate'] },
  { id: 'pipeline/export', match: (p) => hasSegPair(p, 'pipeline', 'export'), stages: ['integrate'] },
  { id: 'm9_export', match: (p) => hasSeg(p, 'm9_export'), stages: ['integrate'] },
  // orchestrator_session.ts | constants/ | contracts/ | core/ → FALLBACK_FULL (cross-cutting)
  { id: 'orchestrator_session.ts', match: (p) => baseOf(p) === 'orchestrator_session.ts', stages: [FULL] },
  { id: 'constants/', match: (p) => hasSeg(p, 'constants'), stages: [FULL] },
  { id: 'contracts/', match: (p) => hasSeg(p, 'contracts'), stages: [FULL] },
  { id: 'core/', match: (p) => hasSeg(p, 'core'), stages: [FULL] },
  // §6 maps m5_coordinate_flatten|m3_gpu_preprocess|shaders → "extract/render
  // or FULL" (ambiguous in the frozen contract). Safest reading implemented:
  // FULL. FLAGGED to the wave orchestrator — never silently reconciled.
  { id: 'm5_coordinate_flatten', match: (p) => hasSeg(p, 'm5_coordinate_flatten'), stages: [FULL] },
  { id: 'm3_gpu_preprocess', match: (p) => hasSeg(p, 'm3_gpu_preprocess'), stages: [FULL] },
  { id: 'shaders', match: (p) => hasSeg(p, 'shaders'), stages: [FULL] },
];

// ── anchor pass ──────────────────────────────────────────────────────────────
export function anchorStages(file) {
  const stages = new Set();
  let full = false;
  for (const entry of ANCHOR_TABLE) {
    if (!entry.match(file)) continue;
    for (const s of entry.stages) { if (s === FULL) full = true; else stages.add(s); }
  }
  return { stages: [...stages].sort(), full };
}

// ── one-hop import scan ──────────────────────────────────────────────────────
// Importer candidates = files under the scan roots that the anchor table maps
// to concrete stages (FULL anchors are excluded: nearly everything is imported
// by orchestrator_session.ts — inheriting from it would scope every change to
// FULL and defeat the mapper). One hop only: changed→importer, no transitivity.
const SCAN_ROOTS = ['src/engine/pipeline', 'src/engine/wasm_compute'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'pkg', 'target', 'dist']);
const IMPORT_RE = /(?:import|export)\s+(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

function walk(dirAbs, relPrefix, out) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const rel = `${relPrefix}/${e.name}`;
    const abs = path.join(dirAbs, e.name);
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile() && SCAN_EXTS.has(path.extname(e.name))) out.push(rel);
  }
}

function extractSpecifiers(source) {
  const specs = [];
  for (const m of source.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  return specs;
}

// Resolve an import specifier from `importerRel` to a repo-relative path.
// Handles the tsconfig alias `@/* → src/*` (tsconfig.json:20-22) and plain
// relative imports. Bare package specifiers → null.
export function resolveSpecifier(spec, importerRel) {
  if (!spec) return null;
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(importerRel);
    const joined = path.posix.normalize(path.posix.join(dir, spec));
    return joined.startsWith('..') ? null : joined;
  }
  return null; // bare package import
}

const RESOLVE_VARIANTS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.js'];
function resolvesTo(resolved, changedFile) {
  return RESOLVE_VARIANTS.some((v) => resolved + v === changedFile);
}

function buildImporterIndex(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) walk(path.join(root, ...scanRoot.split('/')), scanRoot, files);
  const importers = [];
  for (const rel of files.sort()) {
    const a = anchorStages(rel);
    if (a.full || a.stages.length === 0) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { continue; }
    const resolved = extractSpecifiers(src)
      .map((s) => resolveSpecifier(s, rel))
      .filter(Boolean);
    if (resolved.length) importers.push({ rel, stages: a.stages, resolved });
  }
  return importers;
}

function inheritFromImporters(changedFile, importers) {
  const stages = new Set();
  for (const imp of importers) {
    if (imp.resolved.some((r) => resolvesTo(r, changedFile))) for (const s of imp.stages) stages.add(s);
  }
  return [...stages].sort();
}

// ── core API (future run.mjs integration point) ──────────────────────────────
export function scopeFiles(files, { root = REPO_ROOT } = {}) {
  const norm = [...new Set(files.map(normalizePath).filter(Boolean))].sort();
  const mappedPairs = [];
  const pending = [];
  const unmapped = [];
  let anchor_hits = 0;
  let import_hits = 0;
  let sawFull = false;

  for (const f of norm) {
    const a = anchorStages(f);
    if (a.full) { mappedPairs.push([f, [FULL]]); anchor_hits++; sawFull = true; }
    else if (a.stages.length) { mappedPairs.push([f, a.stages]); anchor_hits++; }
    else pending.push(f);
  }

  if (pending.length) {
    const importers = buildImporterIndex(root);
    for (const f of pending) {
      const inherited = inheritFromImporters(f, importers);
      if (inherited.length) { mappedPairs.push([f, inherited]); import_hits++; }
      else unmapped.push(f);
    }
  }

  const mapped = {};
  for (const [f, st] of mappedPairs.sort((x, y) => (x[0] < y[0] ? -1 : 1))) mapped[f] = st;
  const stages = [...new Set(mappedPairs.flatMap(([, st]) => st).filter((s) => s !== FULL))].sort();
  return {
    schema: SCOPE_SCHEMA,
    stages,
    fallback_full: sawFull || unmapped.length > 0,
    mapped,
    unmapped: unmapped.sort(),
    anchor_hits,
    import_hits,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = `usage:
  node tools/testkit/lib/scope.mjs --diff <gitref>
  node tools/testkit/lib/scope.mjs --files <path> [<path> ...]`;

function main(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  let files;
  if (mode === '--diff' && args.length === 2) {
    const ref = args[1];
    const res = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--name-only', ref], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      console.error(`scope: git diff --name-only ${ref} failed: ${res.error?.message ?? (res.stderr || `exit ${res.status}`).trim()}`);
      return 2;
    }
    files = res.stdout.split(/\r?\n/).filter((l) => l.trim().length);
  } else if (mode === '--files' && args.length >= 2) {
    files = args.slice(1);
  } else {
    console.error(USAGE);
    return 2;
  }
  process.stdout.write(JSON.stringify(scopeFiles(files), null, 2) + '\n');
  return 0; // fallback_full is DATA, not an error
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exit(main(process.argv));
