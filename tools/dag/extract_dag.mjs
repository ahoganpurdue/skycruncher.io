// Zero-LLM DAG extractor — the "generate-then-verify" foundation.
//
// Emits the GENERATED-BASE dependency graph of the codebase as JSON, from three
// purely mechanical sources (no model, no judgment — a later agent VERIFIES these
// edges, it never discovers them cold):
//
//   a. IMPORT GRAPH  — walk tracked .ts/.tsx/.mjs under src/ and tools/ (git
//      ls-files, tests skipped), lexically read import / export-from / dynamic-
//      import specifiers, resolve relative + "@/*" paths to repo-relative file
//      nodes. Module-level (file) granularity. Edge type "import".
//   b. STAGE CHAIN   — the runtime stage vocabulary + order from the COMMITTED
//      mechanical fragments tools/dag/enrich/fragments/stage_order*.json (each
//      the zero-LLM output of tools/dag/enrich/replay_stage_order.js over one
//      banked receipt — the fragment is the committed evidence, so this build is
//      deterministic across checkouts; banked receipts themselves are gitignored
//      and are never scanned here). Fragment stage node ids are emitted verbatim
//      (source "receipt") with "stage-order" edges. UNIONED with the
//      src/engine/pipeline/stages/ file inventory: stages that never appear in a
//      replayed receipt (package, solve_context, ...) remain represented as
//      unordered nodes marked source "static" (honest: a file listing carries no
//      order, so no stage-order edges are fabricated for them).
//        ALIAS COLLAPSE: a stage FILE whose code runs at runtime under a
//      DIFFERENT receipt substage id (the withStage/timeSubstage wrap names the
//      substage, not the file) would otherwise mint a file-derived twin of the
//      receipt-observed node for the SAME code (e.g. stages/ingest.ts ->
//      stage:ingest vs the receipt's stage:extract.decode). STAGE_FILE_ALIAS maps
//      each such filename to its canonical receipt id — evidenced by the wrap site
//      — so the static inventory collapses onto the receipt node instead of a
//      duplicate. Files with no alias keep their filename id, as before.
//   c. CONTRACTS     — the enumerated LAW-7 boundaries declared in
//      src/engine/contracts/binary_layouts.ts. One node per boundary (with its
//      version); "contract" edges to each module the schema entry names.
//
// binary_layouts.ts is TypeScript and this is a .mjs with no TS loader available
// in the worktree, so the boundary list is read by REGEX over that file (stated
// honestly rather than importing the exported constant).
//
// Every path in the output is REPO-RELATIVE with forward slashes — no drive
// letters, no machine names (the emitted JSON may become a public page).
// IDs are derived from repo-relative path / boundary name / stage name, never an
// array index, so they are stable across regenerations (owner annotations key on
// them).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/dag

export const DAG_SCHEMA_VERSION = '0.1.0';

// Repo root resolved from THIS module's location (cwd-independent — an agent's
// cwd resets between calls).
export function repoRoot() {
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return path.resolve(HERE, '..', '..');
  }
}

function headSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

// ── File universe ────────────────────────────────────────────────────────────

const CODE_EXT = new Set(['.ts', '.tsx', '.mjs']); // module-node extensions
const TEST_RE = /\.(test|spec|apispec|capturespec|capturespec)\.(ts|tsx|mjs|js)$/;

function isTest(rel) {
  if (TEST_RE.test(rel)) return true;
  if (rel.includes('/__tests__/')) return true;
  return false;
}

function extOf(rel) {
  const b = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = b.lastIndexOf('.');
  return dot < 0 ? '' : b.slice(dot);
}

// A module node = tracked .ts/.tsx/.mjs under src/ or tools/, not a test, not a
// .d.ts declaration file.
function isModuleNode(rel) {
  if (!(rel.startsWith('src/') || rel.startsWith('tools/'))) return false;
  if (isTest(rel)) return false;
  if (rel.endsWith('.d.ts')) return false;
  return CODE_EXT.has(extOf(rel));
}

function listTracked(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '--', 'src', 'tools'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── Import parsing ───────────────────────────────────────────────────────────

// Blank out block comments while preserving newlines (keeps line numbers exact),
// so a `from '...'` inside a comment cannot become a phantom import edge.
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Returns [{spec, line}] for every import/export-from/side-effect/dynamic import.
// Anchored patterns start at the statement's own line, so a `// import ...`
// comment line does not match (the `//` precedes the keyword).
function parseImports(text) {
  const src = stripBlockComments(text);
  const hits = [];
  // import ... from 'x'  /  export ... from 'x'  (may span multiple lines)
  const fromRe = /^[ \t]*(?:import|export)\b[\s\S]*?\bfrom[ \t]*['"]([^'"]+)['"]/gm;
  // side-effect: import 'x'
  const sideRe = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm;
  // dynamic import('x') / require('x')
  const dynRe = /\b(?:import|require)[ \t]*\([ \t]*['"]([^'"]+)['"]/g;
  for (const re of [fromRe, sideRe, dynRe]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      hits.push({ spec: m[1], line: lineOf(src, m.index) });
    }
  }
  return hits;
}

// POSIX-style join+normalize (git paths are always forward-slash).
function posixResolve(fromRel, spec) {
  const dir = fromRel.slice(0, fromRel.lastIndexOf('/'));
  const combined = (dir ? dir + '/' : '') + spec;
  const parts = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// Resolve a specifier to a tracked repo-relative file, or null. Handles the
// "@/*" -> "src/*" tsconfig alias, relative paths, TS-ESM ".js"->".ts", implicit
// extensions and /index files. Only relative + alias specifiers resolve; bare
// package specifiers (npm / node builtins) return null.
function resolveSpec(fromRel, spec, fileSet) {
  let base;
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('.')) base = posixResolve(fromRel, spec);
  else return null; // package / builtin

  const cand = [base];
  if (base.endsWith('.js')) {
    cand.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  }
  for (const e of ['.ts', '.tsx', '.mjs', '.js', '.json', '.d.ts']) cand.push(base + e);
  for (const e of ['.ts', '.tsx', '.mjs', '.js']) cand.push(base + '/index' + e);
  for (const c of cand) if (fileSet.has(c)) return c;
  return null;
}

// ── Contract boundaries (regex over binary_layouts.ts) ───────────────────────

const CONTRACTS_REL = 'src/engine/contracts/binary_layouts.ts';
// repo-relative file token that names a producer/consumer inside an entry.
const PATH_TOKEN_RE = /\b((?:src|tools|public|docs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|json))/g;

function parseBoundaries(root) {
  const abs = path.join(root, CONTRACTS_REL);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  const startKey = 'export const BINARY_LAYOUTS';
  const start = text.indexOf(startKey);
  if (start < 0) return [];
  // Array body ends at the first "\n];" after the declaration.
  const bracket = text.indexOf('[', start);
  const end = text.indexOf('\n];', bracket);
  const body = text.slice(bracket, end < 0 ? undefined : end);

  // Entry boundaries: each entry's first field is `name: '...'` (line-anchored).
  const nameRe = /^[ \t]+name:[ \t]*'([^']+)'/gm;
  const marks = [];
  let m;
  while ((m = nameRe.exec(body)) !== null) marks.push({ name: m[1], at: m.index });
  const entries = [];
  for (let i = 0; i < marks.length; i++) {
    const slice = body.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : undefined);
    const vm = /version:[ \t]*'([^']+)'/.exec(slice);
    const paths = new Set();
    let pm;
    PATH_TOKEN_RE.lastIndex = 0;
    while ((pm = PATH_TOKEN_RE.exec(slice)) !== null) paths.add(pm[1]);
    entries.push({ name: marks[i].name, version: vm ? vm[1] : 'UNKNOWN', paths: [...paths] });
  }
  return entries;
}

// ── Stage chain (committed stage_order fragments ∪ static file inventory) ────

const STAGES_DIR = 'src/engine/pipeline/stages';
const STAGE_FRAGMENTS_DIR = 'tools/dag/enrich/fragments';
const STAGE_FRAGMENT_RE = /^stage_order.*\.json$/;

// A stage FILE (stem, no .ts) whose stage-entry function is wrapped at runtime
// under a DIFFERENT receipt substage id than its filename. The static file
// inventory must collapse each onto its canonical receipt id, or it mints a
// file-derived twin of the receipt-observed node for the SAME code. Each entry
// is evidenced by the withStage/timeSubstage wrap site in
// src/engine/pipeline/orchestrator_session.ts (the wrapped function is imported
// from the named stage file):
//   ingest.ts           decodeScienceFrame     -> timeSubstage 'extract.decode' (~:880)
//   detect.ts           detectSignal           -> timeSubstage 'extract.detect' (~:1137)
//   psf_characterize.ts runPsfCharacterization -> withStage   'psf_field'      (~:1990)
//   science.ts          runSpcc                -> withStage   'spcc'           (~:1907)
// Shared ids where filename == receipt id (metrology, solve, calibrate,
// psf_attribution) need no alias — the fragment already claims them by name.
export const STAGE_FILE_ALIAS = new Map([
  ['ingest', 'stage:extract.decode'],
  ['detect', 'stage:extract.detect'],
  ['psf_characterize', 'stage:psf_field'],
  ['science', 'stage:spcc'],
]);

// Committed, zero-LLM stage_order fragments (output of the enrich lane's
// replay_stage_order.js over one banked receipt each). Reading THESE — never the
// gitignored receipts — keeps the regen identical on every checkout of the same
// commit. Sorted by filename so multi-fragment merges are deterministic
// (stage_order.json, stage_order_cr2.json, ...).
function listStageOrderFragments(root) {
  const dirAbs = path.join(root, STAGE_FRAGMENTS_DIR);
  let names = [];
  try {
    names = readdirSync(dirAbs).filter((f) => STAGE_FRAGMENT_RE.test(f)).sort();
  } catch {
    return [];
  }
  const frags = [];
  for (const name of names) {
    let json;
    try {
      json = JSON.parse(readFileSync(path.join(dirAbs, name), 'utf8'));
    } catch {
      continue; // unreadable fragment: skipped, nothing fabricated
    }
    frags.push({ rel: `${STAGE_FRAGMENTS_DIR}/${name}`, json });
  }
  return frags;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildDag(root = repoRoot()) {
  const tracked = listTracked(root);
  const fileSet = new Set(tracked); // every tracked src/tools file (for resolution)
  const moduleRels = tracked.filter(isModuleNode);
  const moduleSet = new Set(moduleRels);

  const nodes = [];
  const edges = [];
  const edgeSeen = new Set();
  const nodeSeen = new Set();

  const addNode = (n) => {
    if (nodeSeen.has(n.id)) return;
    nodeSeen.add(n.id);
    nodes.push(n);
  };
  const addEdge = (e) => {
    const k = `${e.from} ${e.to} ${e.type}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push(e);
  };

  // (a) IMPORT GRAPH
  for (const rel of moduleRels) {
    addNode({
      id: rel,
      kind: 'module',
      path: rel,
      cite: rel,
      source: 'import-graph',
      version: null,
    });
  }
  for (const rel of moduleRels) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const { spec, line } of parseImports(text)) {
      const target = resolveSpec(rel, spec, fileSet);
      if (!target || !moduleSet.has(target) || target === rel) continue;
      addEdge({
        from: rel,
        to: target,
        type: 'import',
        cite: `${rel}:${line}`,
        verification: 'EXTRACTED',
      });
    }
  }

  // (b) STAGE CHAIN — runtime vocabulary from committed fragments, then the
  // static inventory for every stage the fragments did not claim.
  const claimedStageIds = new Set();
  for (const frag of listStageOrderFragments(root)) {
    const declared =
      frag.json && frag.json.nodes && typeof frag.json.nodes === 'object'
        ? Object.keys(frag.json.nodes)
        : [];
    const rows = Array.isArray(frag.json?.edges)
      ? frag.json.edges.filter(
          (r) =>
            r &&
            r.type === 'stage-order' &&
            typeof r.from === 'string' &&
            typeof r.to === 'string' &&
            r.from.startsWith('stage:') &&
            r.to.startsWith('stage:'),
        )
      : [];
    // Node ids come from the fragment's nodes map plus any edge endpoint (so a
    // fragment edge can never dangle), emitted VERBATIM — the enrich lane's
    // reconciliation contract keys on these exact strings.
    const ids = new Set(declared.filter((id) => id.startsWith('stage:')));
    for (const r of rows) {
      ids.add(r.from);
      ids.add(r.to);
    }
    for (const id of ids) {
      claimedStageIds.add(id);
      const rel = `${STAGES_DIR}/${id.slice('stage:'.length)}.ts`;
      addNode({
        id,
        kind: 'stage',
        path: fileSet.has(rel) ? rel : null, // sub-stage seams have no file of their own
        cite: frag.rel,
        source: 'receipt',
        version: null,
      });
    }
    for (const r of rows) {
      addEdge({
        from: r.from,
        to: r.to,
        type: 'stage-order',
        cite: frag.rel,
        verification: 'EXTRACTED', // base invariant; the enrichment overlay flips same-key edges
      });
    }
  }
  // Static inventory UNION: stage files never claimed by a fragment (package,
  // solve_context, ...) stay represented as unordered nodes — no fabricated
  // order. A file whose code runs under a different receipt substage id is
  // collapsed onto that canonical id (STAGE_FILE_ALIAS) so no file-derived twin
  // is minted: if the receipt already claims the canonical id we skip the file
  // entirely (the receipt node owns it); otherwise the node is emitted under the
  // CANONICAL id (never the filename twin), so a receipt landing later reconciles
  // 1:1 with zero annotation-orphaning.
  const stageDirAbs = path.join(root, STAGES_DIR);
  let stageFiles = [];
  try {
    stageFiles = readdirSync(stageDirAbs)
      .filter((f) => f.endsWith('.ts') && !isTest(`${STAGES_DIR}/${f}`))
      .sort();
  } catch {
    stageFiles = [];
  }
  for (const f of stageFiles) {
    const stem = f.replace(/\.ts$/, '');
    const id = STAGE_FILE_ALIAS.get(stem) || `stage:${stem}`;
    if (claimedStageIds.has(id)) continue;
    const rel = `${STAGES_DIR}/${f}`;
    addNode({
      id,
      kind: 'stage',
      path: rel,
      cite: rel,
      source: 'static',
      version: null,
    });
  }

  // (c) CONTRACT BOUNDARIES
  for (const b of parseBoundaries(root)) {
    const bid = 'boundary:' + b.name;
    addNode({
      id: bid,
      kind: 'boundary',
      path: CONTRACTS_REL,
      cite: `${CONTRACTS_REL}#${b.name}`,
      source: 'contract-schema',
      version: b.version,
    });
    for (const p of b.paths) {
      if (!moduleSet.has(p)) continue; // only link to files that are module nodes
      addEdge({
        from: bid,
        to: p,
        type: 'contract',
        cite: `${CONTRACTS_REL}#${b.name}`,
        verification: 'EXTRACTED',
      });
    }
  }

  // Stable ordering (never index-derived).
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => {
    const ka = `${a.from} ${a.to} ${a.type}`;
    const kb = `${b.from} ${b.to} ${b.type}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    schema_version: DAG_SCHEMA_VERSION,
    generated_at_commit: headSha(root),
    nodes,
    edges,
  };
}

// Stable pretty JSON (trailing newline) — the committed artifact form.
export function serializeDag(dag) {
  return JSON.stringify(dag, null, 2) + '\n';
}

// CLI: regenerate tools/dag/dag_base.json.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('extract_dag.mjs')) {
  const root = repoRoot();
  const dag = buildDag(root);
  const outAbs = path.join(root, 'tools', 'dag', 'dag_base.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outAbs, serializeDag(dag), 'utf8');
  const byKind = {};
  for (const n of dag.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  const byType = {};
  for (const e of dag.edges) byType[e.type] = (byType[e.type] || 0) + 1;
  process.stdout.write(
    `dag_base.json written: ${dag.nodes.length} nodes ${JSON.stringify(byKind)}, ` +
      `${dag.edges.length} edges ${JSON.stringify(byType)}\n`,
  );
}
