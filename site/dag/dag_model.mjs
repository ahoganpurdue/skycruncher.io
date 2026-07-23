// ============================================================================
// tools/dag/ui/dag_model.mjs — pure data-model layer for the DAG collab space.
//
// NO I/O, NO DOM: every function here is pure so the SAME module is imported by
//   • the browser page (tools/dag/ui/dag_app.js) as an ES module, and
//   • the vitest suite (tools/dag/ui/dag_model.test.mjs) in Node.
//
// Responsibilities:
//   • union of the generated base graph (tools/dag/dag_base.json, READ-ONLY to
//     this lane) with the enrichment overlay (tools/dag/enrich/enrichment.json,
//     owned by the sibling enrichment lane — may be ABSENT; absence is honest)
//   • the 14-edge-type layer taxonomy + base-type → layer mapping
//   • node level roll-up: subsystem → stage → boundary (module nodes are NEVER
//     rendered en masse; they roll into groups, reachable via focusSubgraph)
//   • file-type (walked_by) matching, annotation keying (stable IDs, never
//     pixels — the same key works in the card view and the matrix view)
//
// Evidence-state vocabulary (LAW 3 — honest-or-absent):
//   EXTRACTED (ghosted/dashed) · VERIFIED (solid) · REFUTED (struck/red) ·
//   STALE (amber). Base edges are all EXTRACTED; only the enrichment lane can
//   promote/demote. An aggregate edge is VERIFIED only when EVERY constituent
//   is VERIFIED — mixed evidence renders as EXTRACTED with a partial count.
// ============================================================================

// ---- edge-type layers (owner-ratified 2026-07-16: 14 layers, all toggleable) --
export const LAYERS = [
  // ON by default
  { id: 'data-flow',              label: 'data-flow',               defaultOn: true },
  { id: 'control-gating',         label: 'control / gating',        defaultOn: true },
  { id: 'contract',               label: 'contract',                defaultOn: true },
  { id: 'unit-frame-conversion',  label: 'unit / frame conversion', defaultOn: true, loud: true },
  { id: 'ordering-only',          label: 'ordering-only',           defaultOn: true },
  { id: 'fallback-degradation',   label: 'fallback / degradation',  defaultOn: true },
  { id: 'evidence',               label: 'evidence',                defaultOn: true },
  { id: 'annotation',             label: 'annotation',              defaultOn: true },
  // OFF by default (badge/overlay layers)
  { id: 'receipt-write',          label: 'receipt-write',           defaultOn: false },
  { id: 'calibration-consumes',   label: 'calibration-consumes',    defaultOn: false },
  { id: 'inverse-pair',           label: 'inverse-pair',            defaultOn: false },
  { id: 'duplication-shadow',     label: 'duplication / shadow',    defaultOn: false },
  { id: 'external-dependency',    label: 'external-dependency',     defaultOn: false },
  { id: 'doc-binding',            label: 'doc-binding',             defaultOn: false },
];

/** Pseudo-layer for edge types this taxonomy does not recognize. ON by default:
 *  unknown data must stay VISIBLE (hiding it silently would fabricate absence). */
export const UNRECOGNIZED_LAYER = 'unrecognized';

/** Normalize a type spelling: "control/gating", "control gating" → "control-gating". */
export function normalizeType(t) {
  return String(t || '').trim().toLowerCase().replace(/[\/\s_]+/g, '-');
}

// Base extractor types map onto layers; the raw type is PRESERVED on the edge
// (an 'import' is a static dependency — the extracted, unverified form of
// data-flow; its EXTRACTED ghosting is exactly the honest rendering).
const TYPE_TO_LAYER = new Map([
  ['import',      'data-flow'],
  ['stage-order', 'ordering-only'],
  ['owner-drawn', 'annotation'],   // drawn-edge annotations render on the annotation layer
  ['proposed-connection', 'annotation'], // owner-proposed absent edge (empty matrix cell)
  // enrichment-lane type spellings (observed in the real enrichment.json,
  // 2026-07-16): short forms of ratified layer names — aliased onto their
  // layers so they land on the right toggle instead of 'unrecognized'
  ['unit-conversion', 'unit-frame-conversion'],
  ['fallback',        'fallback-degradation'],
  ['control',         'control-gating'],
]);
for (const l of LAYERS) TYPE_TO_LAYER.set(l.id, l.id);

export function layerOf(type) {
  return TYPE_TO_LAYER.get(normalizeType(type)) || UNRECOGNIZED_LAYER;
}

export function defaultEnabledLayers() {
  const s = new Set(LAYERS.filter((l) => l.defaultOn).map((l) => l.id));
  s.add(UNRECOGNIZED_LAYER);
  return s;
}

// ---- file-type selectors (owner spec: honest roles) ------------------------
export const FILE_TYPES = [
  { id: 'CR2',      match: ['cr2', 'raw'],          role: 'solve input (DSLR raw)' },
  { id: 'FITS',     match: ['fits', 'fit'],         role: 'solve input (FITS)' },
  { id: 'ASDF',     match: ['asdf'],                role: 'export container' },
  { id: 'PNG+JPEG', match: ['png', 'jpeg', 'jpg'],  role: 'render products' },
  { id: 'JSON',     match: ['json', 'receipt'],     role: 'receipts / replay plane' },
];

/** Does a walked_by tag list match a selected file type? Tags are matched
 *  case-insensitively against the type's alias list ('PNG+JPEG' ⇒ png|jpeg). */
export function matchesFileType(walkedBy, fileTypeId) {
  if (!fileTypeId) return true; // no filter selected → everything matches
  const ft = FILE_TYPES.find((f) => f.id === fileTypeId);
  if (!ft || !Array.isArray(walkedBy)) return false;
  return walkedBy.some((w) => ft.match.includes(String(w).trim().toLowerCase()));
}

// ---- evidence states --------------------------------------------------------
export const EVIDENCE_STATES = ['EXTRACTED', 'VERIFIED', 'REFUTED', 'STALE'];

/** Fold constituent evidence states into one aggregate state.
 *  REFUTED dominates (a refuted member poisons the aggregate), then STALE,
 *  then VERIFIED only if unanimous, else EXTRACTED (mixed = still unproven). */
export function aggregateVerification(states) {
  if (!states.length) return 'EXTRACTED';
  if (states.includes('REFUTED')) return 'REFUTED';
  if (states.includes('STALE')) return 'STALE';
  if (states.every((s) => s === 'VERIFIED')) return 'VERIFIED';
  return 'EXTRACTED';
}

// ---- mechanical render tier ---------------------------------------------------
// Base parser-derived edges (import/contract/stage-order originating from the
// generated base) are machine-extracted facts mechanically re-checked by the
// drift gate — rendering them identically to unreviewed LLM claims buries the
// owner in dots. Owner-ratified 2026-07-16: they render THIN SOLID MUTED by
// default (a rail toggle restores the old dashed rendering in one click).
export const MECHANICAL_TYPES = new Set(['import', 'contract', 'stage-order']);

/** A single edge is mechanical when it came from the base parser, its type is a
 *  parser-derived type, and no enrichment verdict has promoted/demoted it (a
 *  VERIFIED/REFUTED/STALE verdict outranks the mechanical tier in render). */
export function isMechanical(edge) {
  return edge.origin === 'base'
    && MECHANICAL_TYPES.has(normalizeType(edge.type))
    && edge.verification === 'EXTRACTED';
}

/**
 * Render tier for an edge or aggregate edge:
 *   'verified' | 'refuted' | 'stale' — evidence verdicts win outright
 *   'mechanical' — EXTRACTED, and every unverified constituent is parser-derived
 *   'extracted'  — at least one unreviewed LLM-extracted claim remains (dashed)
 */
export function renderTier(e) {
  if (e.verification === 'VERIFIED') return 'verified';
  if (e.verification === 'REFUTED') return 'refuted';
  if (e.verification === 'STALE') return 'stale';
  const cs = e.constituents || [e];
  const unverified = cs.filter((c) => c.verification === 'EXTRACTED');
  if (unverified.length && unverified.every((c) => isMechanical(c))) return 'mechanical';
  return 'extracted';
}

/**
 * Drop the mechanical (grey, parser-derived) tier from an edge list when the
 * owner asks to hide it. The per-layer toggles alone can't clear the grey mass
 * because contract AND stage-order are BOTH mechanical — you would have to
 * uncheck three layers to clear it, and any surviving multi-layer aggregate
 * still renders grey. One flag removes the whole tier (owner order 2026-07-16:
 * "the grey import mass dominates; dashing them isn't enough"). Verdict-bearing
 * edges (VERIFIED/REFUTED/STALE) and LLM-extracted claims are never touched. */
export function applyEdgeVisibility(edges, opts = {}) {
  if (!opts.hideMechanical) return edges;
  return edges.filter((e) => renderTier(e) !== 'mechanical');
}

// ---- edge identity ----------------------------------------------------------
export function edgeKey(from, to, type) {
  return `${from}|${to}|${normalizeType(type)}`;
}

// ---- merge: base ∪ enrichment ------------------------------------------------
/**
 * Union the generated base with the enrichment overlay.
 * @param base       parsed dag_base.json ({nodes:[], edges:[]})
 * @param enrichment parsed enrichment.json or null/undefined (honest absence)
 * @returns {{
 *   nodes: Map<string, node>,          // node = {...base, why, walked_by, badges}
 *   edges: Array<edge>,                // edge = {from,to,type,layer,cites[],verification,how,why,walked_by,unknownEndpoint?}
 *   enrichment: {present:boolean, fixture:boolean, schema_version:string|null, generated_at_commit:string|null},
 * }}
 */
export function mergeGraph(base, enrichment) {
  const nodes = new Map();
  for (const n of base.nodes) {
    nodes.set(n.id, { ...n, why: null, copy: null, walked_by: [], badges: null });
  }

  // base edges, deduped by (from,to,type); cites collected
  const byKey = new Map();
  const edges = [];
  for (const e of base.edges) {
    const k = edgeKey(e.from, e.to, e.type);
    let cur = byKey.get(k);
    if (!cur) {
      cur = {
        from: e.from, to: e.to, type: normalizeType(e.type), layer: layerOf(e.type),
        cites: [], verification: e.verification || 'EXTRACTED',
        how: null, why: null, walked_by: [], origin: 'base',
      };
      byKey.set(k, cur);
      edges.push(cur);
    }
    if (e.cite && !cur.cites.includes(e.cite)) cur.cites.push(e.cite);
  }

  const meta = { present: false, fixture: false, schema_version: null, generated_at_commit: null };
  if (enrichment && typeof enrichment === 'object') {
    meta.present = true;
    meta.fixture = enrichment.fixture === true;
    meta.schema_version = enrichment.schema_version ?? null;
    meta.generated_at_commit = enrichment.generated_at_commit ?? null;

    // node enrichment attaches why / walked_by / badges — never invents nodes
    const en = enrichment.nodes && typeof enrichment.nodes === 'object' ? enrichment.nodes : {};
    for (const [id, info] of Object.entries(en)) {
      const node = nodes.get(id);
      if (!node || !info) continue; // enrichment for a node the base no longer has → ignored (base is the node authority)
      if (info.why && typeof info.why.text === 'string') node.why = info.why;
      // plain-language copy contract: {text, cites:[{path,lines}]} — present ONLY
      // once the copy lane has VERIFIED it; absent = honest "not yet verified"
      if (info.copy && typeof info.copy.text === 'string') node.copy = info.copy;
      if (Array.isArray(info.walked_by)) node.walked_by = info.walked_by.slice();
      if (info.badges && typeof info.badges === 'object') node.badges = info.badges;
    }

    // edge enrichment: same-key edges OVERRIDE verification and attach how/why/
    // walked_by; new keys append as semantic edges (UNION, per the spec).
    const ee = Array.isArray(enrichment.edges) ? enrichment.edges : [];
    for (const e of ee) {
      if (!e || !e.from || !e.to || !e.type) continue;
      const k = edgeKey(e.from, e.to, e.type);
      let cur = byKey.get(k);
      if (cur) {
        if (EVIDENCE_STATES.includes(e.verification)) cur.verification = e.verification;
        if (e.how && typeof e.how === 'object') cur.how = e.how;
        if (e.why && typeof e.why.text === 'string') cur.why = e.why;
        if (Array.isArray(e.walked_by)) cur.walked_by = e.walked_by.slice();
        if (e.cite && !cur.cites.includes(e.cite)) cur.cites.push(e.cite);
      } else {
        cur = {
          from: e.from, to: e.to, type: normalizeType(e.type), layer: layerOf(e.type),
          cites: e.cite ? [e.cite] : [],
          verification: EVIDENCE_STATES.includes(e.verification) ? e.verification : 'EXTRACTED',
          how: (e.how && typeof e.how === 'object') ? e.how : null,
          why: (e.why && typeof e.why.text === 'string') ? e.why : null,
          walked_by: Array.isArray(e.walked_by) ? e.walked_by.slice() : [],
          origin: 'enrichment',
        };
        // an enrichment edge naming a node the base doesn't have is KEPT but
        // flagged — the UI renders the flag; silently dropping it would hide data
        if (!nodes.has(e.from) || !nodes.has(e.to)) cur.unknownEndpoint = true;
        byKey.set(k, cur);
        edges.push(cur);
      }
    }
  }

  return { nodes, edges, enrichment: meta };
}

// ---- subsystem derivation (documented in tools/dag/ui/README.md) -------------
/**
 * Mechanical path-prefix grouping:
 *   src/engine/pipeline/<seg>/…  → engine/pipeline/<seg>   (139 modules split one level deeper)
 *   src/engine/<seg>/…           → engine/<seg>
 *   src/<seg>/…                  → src/<seg>;  src/<file>  → src
 *   tools/<seg>/…                → tools/<seg>; tools/<file> → tools
 *   anything else                → first path segment
 */
export function subsystemOf(path) {
  const parts = String(path || '').split('/');
  if (parts[0] === 'src' && parts[1] === 'engine') {
    if (parts[2] === 'pipeline') {
      return parts.length > 4 ? `engine/pipeline/${parts[3]}` : 'engine/pipeline';
    }
    return parts.length > 3 ? `engine/${parts[2]}` : 'engine';
  }
  if (parts[0] === 'src') return parts.length > 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'tools') return parts.length > 2 ? `tools/${parts[1]}` : 'tools';
  return parts[0] || '(unknown)';
}

export const LEVELS = ['subsystem', 'stage', 'boundary'];

/** The LAW-7 boundary group name used when boundaries are rolled up. */
export const CONTRACTS_GROUP = 'contracts (LAW-7 boundaries)';

/**
 * Which display group does a node belong to at a given level?
 * Levels are progressively FINER:
 *   subsystem — everything grouped: modules by path prefix, the 21 stage nodes
 *               into engine/pipeline/stages, the 15 boundaries into CONTRACTS_GROUP
 *   stage     — same, but stage nodes are individual (and a module that IS a
 *               stage file merges into its stage node)
 *   boundary  — same as stage, plus boundary nodes individual
 * Module nodes are never individual at any level (focusSubgraph drills in).
 */
export function groupOf(node, level, stagePathIndex) {
  if (node.kind === 'boundary') {
    return level === 'boundary' ? node.id : `subsystem:${CONTRACTS_GROUP}`;
  }
  if (node.kind === 'stage') {
    return level === 'subsystem' ? 'subsystem:engine/pipeline/stages' : node.id;
  }
  // module: at stage/boundary level, a module whose path IS a stage file merges into the stage node
  if (level !== 'subsystem' && stagePathIndex && stagePathIndex.has(node.path)) {
    return stagePathIndex.get(node.path);
  }
  return `subsystem:${subsystemOf(node.path)}`;
}

/** path → stage:<id> for the stage files (module twins merge into their stage). */
export function buildStagePathIndex(nodes) {
  const idx = new Map();
  for (const n of nodes.values()) if (n.kind === 'stage') idx.set(n.path, n.id);
  return idx;
}

// ---- roll-up ------------------------------------------------------------------
/**
 * Roll the merged graph up to a display level.
 * @param merged   result of mergeGraph
 * @param level    'subsystem' | 'stage' | 'boundary'
 * @param opts     { annotatedKeys?: Set<string> } — annotation keys with ≥1 annotation
 * @returns {{ nodes: Array<groupNode>, edges: Array<groupEdge> }}
 *   groupNode = {id, kind, label, memberCount, members[], walked_by[], annotated, internalEdgeCount, why}
 *   groupEdge = {from, to, count, types:{}, layers:{}, verification, verifiedCount,
 *                constituents[], walked_by[], annotated}
 */
export function rollup(merged, level, opts = {}) {
  const annotatedKeys = opts.annotatedKeys || new Set();
  const stageIdx = buildStagePathIndex(merged.nodes);

  const groups = new Map();
  const nodeToGroup = new Map();
  for (const n of merged.nodes.values()) {
    const gid = groupOf(n, level, stageIdx);
    nodeToGroup.set(n.id, gid);
    let g = groups.get(gid);
    if (!g) {
      g = {
        id: gid, kind: 'subsystem', label: gid.replace(/^subsystem:/, ''),
        memberCount: 0, members: [], walked_by: [],
        annotated: false, internalEdgeCount: 0,
        why: null, copy: null, path: null, cite: null,
      };
      groups.set(gid, g);
    }
    if (gid === n.id) {
      // this member IS the group's identity node (stage/boundary rendered as
      // itself) — claim kind/label regardless of member iteration order
      g.kind = n.kind;
      g.label = n.kind === 'boundary' ? n.id.replace(/^boundary:/, '') : n.id.replace(/^stage:/, '');
      g.path = n.path; g.cite = n.cite;
    }
    g.memberCount += 1;
    g.members.push(n.id);
    if (n.why && (gid === n.id || (stageIdx.get(n.path) === gid))) g.why = n.why; // a group's own why comes only from its identity node
    if (n.copy && (gid === n.id || (stageIdx.get(n.path) === gid))) g.copy = n.copy;
    for (const w of n.walked_by) if (!g.walked_by.includes(w)) g.walked_by.push(w);
    if (annotatedKeys.has(`node:${n.id}`)) g.annotated = true;
  }

  const aggByKey = new Map();
  const aggEdges = [];
  for (const e of merged.edges) {
    const gf = nodeToGroup.get(e.from) || e.from; // unknown endpoints keep their raw id
    const gt = nodeToGroup.get(e.to) || e.to;
    if (gf === gt) {
      const g = groups.get(gf);
      if (g) g.internalEdgeCount += 1;
      continue; // within-group edges are counted, not drawn
    }
    const k = `${gf}→${gt}`;
    let agg = aggByKey.get(k);
    if (!agg) {
      agg = {
        from: gf, to: gt, count: 0, types: {}, layers: {},
        verification: 'EXTRACTED', verifiedCount: 0,
        constituents: [], walked_by: [], annotated: false,
      };
      aggByKey.set(k, agg);
      aggEdges.push(agg);
    }
    agg.count += 1;
    agg.types[e.type] = (agg.types[e.type] || 0) + 1;
    agg.layers[e.layer] = (agg.layers[e.layer] || 0) + 1;
    if (e.verification === 'VERIFIED') agg.verifiedCount += 1;
    agg.constituents.push(e);
    for (const w of e.walked_by) if (!agg.walked_by.includes(w)) agg.walked_by.push(w);
    if (annotatedKeys.has(`edge:${edgeKey(e.from, e.to, e.type)}`)) agg.annotated = true;
  }
  for (const agg of aggEdges) {
    agg.verification = aggregateVerification(agg.constituents.map((c) => c.verification));
  }

  return { nodes: [...groups.values()], edges: aggEdges };
}

/** Filter rolled-up edges by the enabled layer set. An aggregate edge shows if
 *  ANY of its constituent layers is enabled; its visible count/types shrink to
 *  the enabled layers so toggles never smuggle hidden-layer counts. */
export function filterRolledEdges(rolled, enabledLayers) {
  const out = [];
  for (const e of rolled) {
    const constituents = e.constituents.filter((c) => enabledLayers.has(c.layer));
    if (!constituents.length) continue;
    const types = {}; const layers = {};
    let verifiedCount = 0;
    for (const c of constituents) {
      types[c.type] = (types[c.type] || 0) + 1;
      layers[c.layer] = (layers[c.layer] || 0) + 1;
      if (c.verification === 'VERIFIED') verifiedCount += 1;
    }
    out.push({
      ...e, constituents, count: constituents.length, types, layers, verifiedCount,
      verification: aggregateVerification(constituents.map((c) => c.verification)),
    });
  }
  return out;
}

/** Drill into ONE group: its member module nodes + edges touching them, with the
 *  far endpoint mapped to its group (rendered as a port). This is how the card
 *  view reaches module granularity without ever rendering all 813 modules. */
export function focusSubgraph(merged, level, groupId) {
  const stageIdx = buildStagePathIndex(merged.nodes);
  const memberIds = new Set();
  for (const n of merged.nodes.values()) {
    if (groupOf(n, level, stageIdx) === groupId) memberIds.add(n.id);
  }
  const ports = new Map(); // far-group id → count
  const edges = [];
  for (const e of merged.edges) {
    const fIn = memberIds.has(e.from);
    const tIn = memberIds.has(e.to);
    if (!fIn && !tIn) continue;
    let from = e.from, to = e.to;
    if (!fIn) { from = groupOf(merged.nodes.get(e.from) || { kind: 'module', path: e.from }, level, stageIdx); ports.set(from, (ports.get(from) || 0) + 1); }
    if (!tIn) { to = groupOf(merged.nodes.get(e.to) || { kind: 'module', path: e.to }, level, stageIdx); ports.set(to, (ports.get(to) || 0) + 1); }
    edges.push({ ...e, from, to });
  }
  return {
    members: [...memberIds].map((id) => merged.nodes.get(id)).filter(Boolean),
    ports: [...ports.entries()].map(([id, count]) => ({ id, count })),
    edges,
  };
}

// ---- Sugiyama layered layout (pure, deterministic — owner has spatial memory
// across sessions, so every step is order-stable: sorted inputs, fixed sweep
// counts, id tie-breaks; NO randomness anywhere) --------------------------------

/**
 * Deterministic DFS back-edge removal: returns the subset of `edges` that forms
 * a DAG over `nodeIds`. Roots and out-neighbors are visited in sorted-id order,
 * so the same graph always breaks its cycles at the same edges. Self-loops and
 * edges with endpoints outside `nodeIds` are dropped for LAYOUT purposes only
 * (they still render — this function feeds ranking, nothing else).
 */
export function acyclicEdges(nodeIds, edges) {
  const idSet = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  const ids = [...idSet].sort();
  const out = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) out.get(e.from).push(i);
  });
  for (const lst of out.values()) {
    lst.sort((a, b) => (edges[a].to < edges[b].to ? -1 : edges[a].to > edges[b].to ? 1 : a - b));
  }
  const state = new Map(); // undefined=unvisited · 1=on stack · 2=done
  const keep = new Set();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nbrs = out.get(top[0]);
      if (top[1] < nbrs.length) {
        const ei = nbrs[top[1]++];
        const to = edges[ei].to;
        const st = state.get(to);
        if (st === 1) continue;      // back edge → excluded from ranking (cycle break)
        keep.add(ei);                // tree/forward/cross edges keep direction
        if (!st) { state.set(to, 1); stack.push([to, 0]); }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  return edges.filter((_, i) => keep.has(i));
}

/**
 * Longest-path layer assignment along the edge direction (stage-order/data-flow
 * edges point down the pipeline, so ranks follow the pipeline where present):
 * rank(source)=0, rank(n)=max(rank(pred)+1). Cycle-safe via acyclicEdges.
 * Returns Map id → rank. Deterministic.
 */
export function assignRanks(nodeIds, edges) {
  const idSet = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  const dagEdges = acyclicEdges(idSet, edges);
  const indeg = new Map([...idSet].map((id) => [id, 0]));
  const out = new Map([...idSet].map((id) => [id, []]));
  for (const e of dagEdges) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    out.get(e.from).push(e.to);
  }
  const rank = new Map([...idSet].map((id) => [id, 0]));
  let queue = [...idSet].filter((id) => indeg.get(id) === 0).sort();
  while (queue.length) {
    const next = [];
    for (const id of queue) {
      for (const to of out.get(id)) {
        rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0) next.push(to);
      }
    }
    queue = next.sort();
  }
  return rank;
}

/**
 * Barycentric crossing-reduction over the ranked layers. FIXED sweep count
 * (default 8: alternating downward/upward passes) → fully deterministic.
 * Ties break by (barycenter, id). Nodes with no placed neighbors keep their
 * current position. Returns Map id → row index within its rank.
 */
export function orderRanks(rankMap, edges, sweeps = 8) {
  const layers = new Map();
  for (const [id, r] of rankMap) {
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r).push(id);
  }
  const rankList = [...layers.keys()].sort((a, b) => a - b);
  for (const r of rankList) layers.get(r).sort();
  const pos = new Map();
  for (const r of rankList) layers.get(r).forEach((id, i) => pos.set(id, i));

  const preds = new Map(); const succs = new Map();
  for (const e of edges) {
    if (!rankMap.has(e.from) || !rankMap.has(e.to) || e.from === e.to) continue;
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e.to);
  }
  const bary = (id, nbrMap, fallback) => {
    const ns = nbrMap.get(id);
    if (!ns || !ns.length) return fallback;
    let sum = 0;
    for (const n of ns) sum += pos.get(n);
    return sum / ns.length;
  };
  for (let s = 0; s < sweeps; s++) {
    const nbrMap = s % 2 === 0 ? preds : succs;
    const order = s % 2 === 0 ? rankList : [...rankList].reverse();
    for (const r of order) {
      const ids = layers.get(r);
      const keyed = ids.map((id, i) => ({ id, key: bary(id, nbrMap, i) }));
      keyed.sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const reordered = keyed.map((k) => k.id);
      layers.set(r, reordered);
      reordered.forEach((id, i) => pos.set(id, i));
    }
  }
  return pos;
}

/** Count edge crossings between consecutive ranks (layout-quality metric for
 *  tests; also honest evidence that the sweeps actually reduce crossings). */
export function countCrossings(rankMap, orderMap, edges) {
  const spans = [];
  for (const e of edges) {
    const rf = rankMap.get(e.from), rt = rankMap.get(e.to);
    if (rf === undefined || rt === undefined || Math.abs(rf - rt) !== 1) continue;
    const [lo, a, b] = rf < rt
      ? [rf, orderMap.get(e.from), orderMap.get(e.to)]
      : [rt, orderMap.get(e.to), orderMap.get(e.from)];
    spans.push({ lo, a, b });
  }
  let crossings = 0;
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].lo !== spans[j].lo) continue;
      const s = spans[i], t = spans[j];
      if ((s.a - t.a) * (s.b - t.b) < 0) crossings += 1;
    }
  }
  return crossings;
}

/** Full layered layout: ranks (columns) + barycentric row order. */
export function layeredLayout(nodes, edges, opts = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  const rank = assignRanks(ids, edges);
  const order = orderRanks(rank, edges, opts.sweeps ?? 8);
  const layerSizes = new Map();
  for (const [id, r] of rank) {
    layerSizes.set(r, Math.max(layerSizes.get(r) || 0, order.get(id) + 1));
  }
  return { rank, order, layerSizes, layerCount: layerSizes.size ? Math.max(...layerSizes.keys()) + 1 : 0 };
}

// ---- seeded force-directed layout (owner rework 2026-07-16: "a web, a map,
// things that are not bound in space at all, they position themselves freely
// based on minimizing crossing lines, nothing in a column") ---------------------
// Fruchterman-Reingold with cooling. FULLY DETERMINISTIC: the initial placement
// PRNG is seeded from the node-id SET (stable across sessions — the owner's
// spatial-memory requirement still stands), springs and repulsion are summed in
// a canonical (sorted) order so the result is independent of input array order,
// and the iteration count is fixed. No Math.random anywhere.

/** FNV-1a hash over the sorted id set → a stable 32-bit seed. */
export function hashIds(ids) {
  const s = [...new Set(ids)].sort().join('~');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Undirected, deduped spring list among ids present in idSet, sorted by a
 *  canonical pair key so accumulation order never depends on edge array order. */
export function springPairs(edges, idSet) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}~${e.to}` : `${e.to}~${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: e.from, b: e.to, key });
  }
  out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out;
}

/**
 * ONE relaxation iteration, mutating `pos` (Map id→{x,y}) in place. Reused both
 * by forceLayout (batch) and by the interactive drag relaxor (live). `ids` MUST
 * be pre-sorted; `springs` from springPairs. `fixed` (Set or Map of id) pins a
 * node exactly where it is. Deterministic given deterministic inputs.
 */
export function forceStep(pos, ids, springs, params) {
  const { k, temp, gravity = 0.02, fixed = null } = params;
  const n = ids.length;
  const disp = new Map();
  for (const id of ids) disp.set(id, { x: 0, y: 0 });
  // repulsion (canonical i<j order)
  for (let i = 0; i < n; i++) {
    const vi = pos.get(ids[i]);
    for (let j = i + 1; j < n; j++) {
      const vj = pos.get(ids[j]);
      let dx = vi.x - vj.x, dy = vi.y - vj.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.01) { // deterministic index-based nudge (never Math.random)
        dx = ((i % 7) - 3) * 0.01 + 0.001; dy = ((j % 5) - 2) * 0.01 + 0.001;
        dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      }
      const rep = (k * k) / dist;
      const ux = dx / dist, uy = dy / dist;
      const di = disp.get(ids[i]), dj = disp.get(ids[j]);
      di.x += ux * rep; di.y += uy * rep;
      dj.x -= ux * rep; dj.y -= uy * rep;
    }
  }
  // attraction along springs
  for (const e of springs) {
    const a = pos.get(e.a), b = pos.get(e.b);
    let dx = a.x - b.x, dy = a.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const att = (dist * dist) / k;
    const ux = dx / dist, uy = dy / dist;
    const da = disp.get(e.a), db = disp.get(e.b);
    da.x -= ux * att; da.y -= uy * att;
    db.x += ux * att; db.y += uy * att;
  }
  // weak centering + capped integration
  for (const id of ids) {
    if (fixed && (fixed.has ? fixed.has(id) : false)) continue;
    const p = pos.get(id), d = disp.get(id);
    d.x -= p.x * gravity; d.y -= p.y * gravity;
    const dl = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
    const step = Math.min(dl, temp);
    p.x += (d.x / dl) * step;
    p.y += (d.y / dl) * step;
  }
}

/**
 * Deterministic seeded force layout. Returns Map id→{x,y} (node CENTERS, in a
 * self-centered coordinate space ≈ origin). Same node set + edge multiset ⇒
 * byte-identical positions, regardless of array order.
 *
 * Only edge-bearing nodes (and pins) join the force sim: an edge-LESS node has no
 * spring to earn a place in the web, so on pure repulsion it flies out to a huge
 * radius and shrinks the connected web to a dot at fit-all. Such nodes are instead
 * CORRALLED into a compact deterministic grid beside the web — readable at fit,
 * order-independent, and honest (their arbitrary free position carries no meaning).
 * @param opts { iterations, k, gravity, fixed:Map<id,{x,y}>, seed }
 */
export function forceLayout(nodes, edges, opts = {}) {
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const pos = new Map();
  if (!ids.length) return pos;
  const fixed = opts.fixed instanceof Map ? opts.fixed : null;
  const idSet = new Set(ids);
  const springs = springPairs(edges, idSet);
  // sim participants: nodes that carry a spring, plus any pinned node (a pin is a
  // deliberate placement to honor even for an edge-less node)
  const connected = new Set();
  for (const s of springs) { connected.add(s.a); connected.add(s.b); }
  if (fixed) for (const id of fixed.keys()) if (idSet.has(id)) connected.add(id);
  const simIds = ids.filter((id) => connected.has(id)); // sorted subset
  const isoIds = ids.filter((id) => !connected.has(id)); // sorted subset (edge-less, unpinned)

  const nSim = Math.max(1, simIds.length);
  const iterations = opts.iterations ?? 420;
  // ideal edge length k = sqrt(area / n); area scales with the sim node count so
  // the web breathes as it grows (FR classic)
  const side = Math.max(600, Math.sqrt(nSim) * 170);
  const kk = opts.k ?? Math.max(70, Math.sqrt((side * side) / nSim));
  const rnd = mulberry32(opts.seed != null ? opts.seed : hashIds(ids));
  const R = Math.max(120, Math.sqrt(nSim) * 90);
  for (const id of simIds) {
    const ang = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd()) * R;
    pos.set(id, { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
  }
  // honor incoming pins (fixed positions) before relaxing
  if (fixed) for (const [id, p] of fixed) if (pos.has(id)) pos.set(id, { x: p.x, y: p.y });
  // centering gravity: enough to coil long pendant chains inward so the web
  // reads at fit-all, without collapsing the core into a hairball
  const gravity = opts.gravity ?? 0.07;
  let temp = kk * 0.9;
  const cool = temp / (iterations + 1);
  for (let it = 0; it < iterations; it++) {
    forceStep(pos, simIds, springs, { k: kk, temp, gravity, fixed });
    temp = Math.max(temp - cool, kk * 0.02);
  }
  // place edge-less nodes as free-looking SATELLITES in a contained ring around
  // the web — NOT a grid/column (owner: "nothing in a column"). Golden-angle
  // scatter is organic and deterministic; the ring radius tracks the web so the
  // fit stays tight and the connected web still reads (edge-less nodes carry no
  // "minimize-crossings" position — this is just an honest, bounded parking orbit).
  if (isoIds.length) {
    let cx = 0, cy = 0, cnt = 0;
    for (const id of simIds) { const p = pos.get(id); if (!p) continue; cx += p.x; cy += p.y; cnt++; }
    if (cnt) { cx /= cnt; cy /= cnt; }
    // ROBUST radius (p65, not max): the web usually has a dense core plus a few
    // far pendant chains — ringing off the max would fling satellites past the
    // outliers. p65 seats them just outside the bulk of the web.
    const radii = simIds.map((id) => { const p = pos.get(id); return p ? Math.hypot(p.x - cx, p.y - cy) : 0; }).sort((a, b) => a - b);
    const rCore = radii.length ? radii[Math.floor(radii.length * 0.65)] : kk * 3;
    const base = (rCore || kk * 3) * 1.1;
    const span = Math.max(kk * 1.4, rCore * 0.35);
    isoIds.forEach((id, i) => {
      const ang = i * 2.399963229728653 + rnd() * 0.5; // golden angle ≈137.5°, seeded jitter
      const rad = base + rnd() * span;
      pos.set(id, { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad });
    });
  }
  return pos;
}

// ---- hide-unlinked degree (owner add 2026-07-16: "hide unlinked nodes" toggle,
// next to hide-mechanical) ------------------------------------------------------
// PURE. The caller passes the ALREADY-FILTERED visible edge set (layer toggles +
// hide-mechanical + ego + endpoint-existence); "linked" therefore means "still
// connected in the current view". Degree counts edges to OTHER nodes only —
// self-loops / aggregated internal edges are not a connection to the rest of the
// web, so an internal-only subsystem reads as unlinked (declutter is the intent).

/** Map id→incident-visible-edge count over `edges`, for the given node ids (Set
 *  or array). Only edges with BOTH endpoints in the set count (that is what the
 *  graph/matrix actually draw); self-loops (from===to) contribute 0. */
export function visibleDegree(nodeIds, edges) {
  const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  const deg = new Map();
  for (const id of ids) deg.set(id, 0);
  for (const e of edges) {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    deg.set(e.from, deg.get(e.from) + 1);
    deg.set(e.to, deg.get(e.to) + 1);
  }
  return deg;
}

/** The subset of `nodes` with at least one visible edge (degree > 0). Pure; the
 *  single source of truth for the "hide unlinked nodes" toggle in BOTH graph
 *  layouts (hidden nodes are simply absent from the laid-out set, so they exert
 *  no forces) AND the matrix (zero-visible-edge rows/cols drop out). */
export function linkedNodes(nodes, edges) {
  const deg = visibleDegree(nodes.map((n) => n.id), edges);
  return nodes.filter((n) => (deg.get(n.id) || 0) > 0);
}

// ---- connectivity isolation (ego subgraph) ------------------------------------
export const EGO_DIRECTIONS = ['upstream', 'downstream', 'both'];

/**
 * IDs within `hops` of `centerId`, following edge direction:
 *   'downstream' — follow from→to ("what does this feed?")
 *   'upstream'   — follow to→from ("what feeds this?")
 *   'both'       — either (default)
 * Pure BFS over the EDGES GIVEN — the caller passes the post-layer-filter edge
 * list, so isolation honestly respects the active layer toggles. The center is
 * always included, even with no edges. hops defaults to 1; invalid opts clamp.
 */
export function egoIds(edges, centerId, opts = {}) {
  const hops = Number.isInteger(opts.hops) && opts.hops > 0 ? opts.hops : 1;
  const direction = EGO_DIRECTIONS.includes(opts.direction) ? opts.direction : 'both';
  const out = new Map(); const inn = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
    if (!inn.has(e.to)) inn.set(e.to, []);
    inn.get(e.to).push(e.from);
  }
  const seen = new Set([centerId]);
  let frontier = [centerId];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next = [];
    for (const id of frontier) {
      if (direction !== 'upstream') for (const t of out.get(id) || []) if (!seen.has(t)) { seen.add(t); next.push(t); }
      if (direction !== 'downstream') for (const f of inn.get(id) || []) if (!seen.has(f)) { seen.add(f); next.push(f); }
    }
    frontier = next;
  }
  return seen;
}

/** Filter a rolled node/edge set down to the ego of centerId. Kept edges are
 *  exactly those with BOTH endpoints inside the ego set — every edge shown is a
 *  fact among the shown nodes (never a stub to a hidden node). */
export function egoFilter(nodes, edges, centerId, opts = {}) {
  const ids = egoIds(edges, centerId, opts);
  return {
    ids,
    nodes: nodes.filter((n) => ids.has(n.id)),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

// ---- annotations ----------------------------------------------------------------
/** Stable annotation key for a target — the SAME key in both views (spec: keys
 *  on IDs, never pixels). target = {node:"id"} or {edge:{from,to,type}}. */
export function annotationKeyFor(target) {
  if (!target) return null;
  if (target.node) return `node:${target.node}`;
  if (target.edge && target.edge.from && target.edge.to) {
    return `edge:${edgeKey(target.edge.from, target.edge.to, target.edge.type || 'owner-drawn')}`;
  }
  return null;
}

/** Index a parsed annotations array by key. Returns Map key → [annotation…]. */
export function indexAnnotations(list) {
  const idx = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const k = annotationKeyFor(a && a.target);
    if (!k) continue;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(a);
  }
  return idx;
}

/**
 * Owner proposed-connection annotations (made on EMPTY matrix cells — absence
 * made annotatable). Deduped by (from,to); each pair carries its annotations.
 * These are NOT graph edges and never enter the roll-up — the views render
 * them as a separate overlay (matrix ring badge, graph dashed pink line).
 */
export function proposedPairsFrom(list) {
  const byKey = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const t = a && a.target && a.target.edge;
    if (!t || !t.from || !t.to) continue;
    if (normalizeType(t.type) !== 'proposed-connection') continue;
    const k = `${t.from}|${t.to}`;
    let p = byKey.get(k);
    if (!p) { p = { from: t.from, to: t.to, count: 0, annotations: [] }; byKey.set(k, p); }
    p.count += 1;
    p.annotations.push(a);
  }
  return [...byKey.values()];
}

// ---- procedure walk (third view: plain-language ordered pipeline) --------------
/** Per-step payload for the procedure view. `known:false` marks a stage id the
 *  stage-order edges reference but the base graph lacks (rendered flagged,
 *  never silently dropped). For such ids the ENRICHMENT node entry — the spec's
 *  named source for copy — may still carry why/copy/badges: used with
 *  `enrichmentOnly:true` so the view labels the provenance (the 23-id
 *  base↔receipt reconciliation is a known cross-lane contract; when the base
 *  regen lands these steps flip to known:true automatically). */
function procStepInfo(merged, id, enrichmentNodes) {
  const n = merged.nodes.get(id) || null;
  const fb = (!n && enrichmentNodes && typeof enrichmentNodes === 'object') ? enrichmentNodes[id] : null;
  return {
    id,
    name: id.replace(/^stage:/, ''),
    known: !!n,
    enrichmentOnly: !n && !!fb,
    why: (n && n.why) || (fb && fb.why && typeof fb.why.text === 'string' ? fb.why : null),
    copy: (n && n.copy) || (fb && fb.copy && typeof fb.copy.text === 'string' ? fb.copy : null), // absent ⇒ "plain-language copy not yet verified"
    badges: (n && n.badges) || (fb && fb.badges && typeof fb.badges === 'object' ? fb.badges : null), // substrate / receipt_write render-if-present
    walked_by: n ? n.walked_by : (fb && Array.isArray(fb.walked_by) ? fb.walked_by.slice() : []),
  };
}

/**
 * Ordered numbered walk of the pipeline, driven by the stage-order edges of the
 * MERGED graph (they exist only where a banked receipt walk was replayed — the
 * chain's `cites` say exactly which receipt). Chains group by walked_by tag
 * (data-driven: one header per file type, ready for the CR2 chain when it
 * lands). Deterministic: tags sorted, chain starts sorted, branch tie-break by
 * id. opts.fileType filters chains by tag via the FILE_TYPES alias matcher;
 * tags hidden by the filter are reported in `skippedTags` (never silently).
 * `unwalked` lists stage nodes observed in NO walk at all — the honest footer.
 */
export function procedureWalk(merged, opts = {}) {
  const fileType = opts.fileType || null;
  const enrichmentNodes = opts.enrichmentNodes || null;
  const soEdges = merged.edges.filter((e) => e.type === 'stage-order');

  const byTag = new Map();
  for (const e of soEdges) {
    const tags = (e.walked_by && e.walked_by.length)
      ? e.walked_by.map((t) => String(t).trim().toLowerCase())
      : ['(untagged)'];
    for (const t of tags) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(e);
    }
  }

  const chains = [];
  const skippedTags = [];
  for (const tag of [...byTag.keys()].sort()) {
    if (fileType && !matchesFileType([tag], fileType)) { skippedTags.push(tag); continue; }
    const edges = byTag.get(tag);
    const succ = new Map(); const indeg = new Map(); const nodeSet = new Set();
    for (const e of edges) {
      nodeSet.add(e.from); nodeSet.add(e.to);
      if (!succ.has(e.from)) succ.set(e.from, []);
      succ.get(e.from).push(e.to);
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    }
    const cites = [...new Set(edges.flatMap((e) => e.cites || []))].sort();
    const visited = new Set();
    const starts = [...nodeSet].filter((id) => !indeg.get(id)).sort();
    for (const s of starts) {
      const stepIds = [];
      let cur = s;
      while (cur !== null && !visited.has(cur)) {
        visited.add(cur);
        stepIds.push(cur);
        const nexts = (succ.get(cur) || []).filter((n) => !visited.has(n)).sort();
        cur = nexts.length ? nexts[0] : null;
      }
      if (stepIds.length) {
        chains.push({ tag, cites, steps: stepIds.map((id) => procStepInfo(merged, id, enrichmentNodes)), note: null });
      }
    }
    const leftover = [...nodeSet].filter((id) => !visited.has(id)).sort();
    if (leftover.length) {
      chains.push({
        tag, cites,
        steps: leftover.map((id) => procStepInfo(merged, id, enrichmentNodes)),
        note: 'not reachable from a chain start (stage-order cycle or bypassed branch) — listed unordered',
      });
    }
  }

  // honest footer: stage nodes observed in NO receipt walk, computed over ALL
  // stage-order edges (independent of the active file-type filter)
  const everWalked = new Set();
  for (const e of soEdges) { everWalked.add(e.from); everWalked.add(e.to); }
  const unwalked = [...merged.nodes.values()]
    .filter((n) => n.kind === 'stage' && !everWalked.has(n.id))
    .map((n) => n.id)
    .sort();

  return { chains, unwalked, skippedTags };
}

/** Owner drawn-edge annotations become synthetic edges on the annotation layer. */
export function drawnEdgesFrom(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || a.kind !== 'drawn-edge' || !a.target || !a.target.edge) continue;
    const t = a.target.edge;
    if (!t.from || !t.to) continue;
    out.push({
      from: t.from, to: t.to, type: 'owner-drawn', layer: 'annotation',
      cites: [], verification: 'EXTRACTED', how: null,
      why: a.text ? { text: a.text, cites: [] } : null,
      walked_by: [], drawn: true, annotation: a, origin: 'annotation',
    });
  }
  return out;
}

// ---- Clockdrive overlay (theses + proposals — owner order 2026-07-16) -----------
// A lightweight roadmap overlay: theses (pre-registered / running / failed / adopted)
// and owner proposals (decision items). These are UNANCHORED status chips — they are
// NOT graph edges and never enter the roll-up; they render as a dedicated strip.
// Data is ported by a sibling lane into test_results/dag_clockdrive/*.json and served
// verbatim at /data/clockdrive.json ({theses:[], proposals:[]}); this normalizer is
// the SAME pure code the browser and the vitest suite both run.
//
// Overlay-node ids arrive already namespaced ('thesis:<id>' / 'proposal:<id>'), so
// annotation keying works UNCHANGED: a comment on the chip targets {node:<id>} and
// keys on `node:thesis:<id>` — exactly what the panel posts and indexAnnotations reads.

/** Overlay-node kinds and the recognized status vocabulary. Any status outside this
 *  set is passed through as 'pending' with statusFlagged:true (honest — never hidden,
 *  never silently coerced without a mark). */
export const CLOCKDRIVE_KINDS = ['thesis', 'proposal'];
export const CLOCKDRIVE_STATUSES = ['pending', 'dead', 'adopted', 'approved'];

/** Normalize ONE ported clockdrive entry into an overlay node. Returns null when the
 *  entry has no stable string id (can't be keyed → not invented into existence). */
export function normalizeClockdriveEntry(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : null;
  if (!id) return null;
  const rawStatus = String(raw.status ?? '').trim().toLowerCase();
  const known = CLOCKDRIVE_STATUSES.includes(rawStatus);
  return {
    id,                                 // stable, namespaced — annotation key is `node:${id}` unchanged
    kind,                               // 'thesis' | 'proposal'
    title: typeof raw.title === 'string' ? raw.title : '',
    status: known ? rawStatus : 'pending',
    statusFlagged: !known,              // unknown status → shown as pending, but FLAGGED
    raw_status: typeof raw.raw_status === 'string' ? raw.raw_status : '', // verbatim provenance line
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    submitter_class: typeof raw.submitter_class === 'string' ? raw.submitter_class : null,
    anchors: Array.isArray(raw.anchors) ? raw.anchors.filter((a) => typeof a === 'string' && a.trim() !== '') : [],
  };
}

/**
 * Normalize the served clockdrive payload ({theses:[], proposals:[]}) into a flat,
 * deterministic list of overlay nodes (theses first, then proposals; input order
 * preserved within each kind). Absence is honest-empty at every level:
 *   null / missing keys / non-arrays → [] (never an error, never fabricated rows).
 * Duplicate ids keep the FIRST occurrence (theses win over a same-id proposal — the
 * namespaced ids make a real collision impossible, this is only belt-and-suspenders).
 */
export function normalizeClockdrive(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const theses = Array.isArray(p.theses) ? p.theses : [];
  const proposals = Array.isArray(p.proposals) ? p.proposals : [];
  const out = [];
  const seen = new Set();
  for (const t of theses) {
    const n = normalizeClockdriveEntry(t, 'thesis');
    if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
  }
  for (const pr of proposals) {
    const n = normalizeClockdriveEntry(pr, 'proposal');
    if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
  }
  return out;
}

/**
 * Best-effort resolve a clockdrive entry's anchor path to a display-node id at the
 * current level (so the strip can draw a thin annotation line to the anchor node WHEN
 * it exists at that level — most anchors are test_results/ paths that resolve to no
 * rendered node, which is fine: no match ⇒ no line, honest). Exact module match wins;
 * otherwise the subsystem bucket. Returns a candidate id — the caller checks presence
 * against the actually-rendered node set (never draws a stub to a hidden node).
 */
export function clockdriveAnchorGroup(anchorPath, merged, level, stagePathIndex) {
  if (typeof anchorPath !== 'string' || anchorPath.trim() === '') return null;
  const node = merged && merged.nodes && merged.nodes.get(anchorPath);
  if (node) return groupOf(node, level, stagePathIndex);
  return `subsystem:${subsystemOf(anchorPath)}`;
}
