// ============================================================================
// tools/dag/ui/steps_model.js — PURE data-model layer for the curated step-map
// dual rendering (task #11 / step-map Phase 3). No DOM, no browser globals: every
// export is a pure function so `steps_model.test.mjs` (vitest) can cover it.
//
// Kept as a `.js` ESM module ON PURPOSE: the DAG extractor scans `.mjs`/`.ts`
// under tools/ into dag_base (drift-gated), but NOT `.js` — so this module adds
// zero base nodes and needs no dag_base regen. package.json "type":"module" makes
// a bare `.js` a real ES module in Node, so the vitest `.test.mjs` imports it.
//
// Input: tools/dag/steps/steps_map.json (the COMMITTED curated artifact, 96 steps
// = 24 majors + 72 subs). READ-ONLY here — this lane never mutates the map.
// LAW 3 (honest-or-absent) governs: a step renders its OWN prose; absence is an
// explicit state, never invented text; the DRAFT copy fragments elsewhere in
// test_results are deliberately NOT consulted (verification wave pending).
// ============================================================================

// File-type tags that the ONE flow carries on individual steps (owner ruling:
// one unified flow, file-type as a TAG on items — never parallel per-type chains).
// The curated map uses exactly these three; the selector dims non-matching steps.
export const STEP_FILE_TYPE_TAGS = ['fits', 'cr2-raw', 'jpeg-tiff'];

/** Non-file-type tags that carry meaning as badges (kind/arm markers). */
export const STEP_MARKER_TAGS = ['interface', 'branch-point', 'batch', 'headless', 'mcp', 'desktop', 'public-later'];

/** The recognised step `kind` values (interface | pipeline | branch-point). */
export const STEP_KINDS = ['interface', 'pipeline', 'branch-point'];

/** The recognised `observed` provenance values. */
export const STEP_OBSERVED = ['receipt', 'code-derived'];

/** First `n` words of a string, trimmed; '' when empty/absent (never invented). */
export function firstWords(text, n = 9) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const parts = s.split(' ');
  return parts.slice(0, n).join(' ') + (parts.length > n ? '…' : '');
}

/**
 * Split a steps_map into an ordered tree. Majors (parent == null) sort by `order`;
 * each node carries `.subs` (its DIRECT children, sorted by their own `order`),
 * nested RECURSIVELY. The curated map is nominally 2-level (majors → subs), but the
 * committed artifact carries one 3-level item (`step:entry.batch.sources`); nesting
 * recursively means nothing is ever dropped (LAW 3 — honest, never silently
 * discarded). Pure: does not mutate the input steps.
 * @returns { majors:[{...step, subs:[...]}], byId:Map<id,step>, chapters, meta }
 */
export function buildStepTree(map) {
  const steps = (map && Array.isArray(map.steps)) ? map.steps : [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const childrenOf = (parentId) => steps
    .filter((s) => (s.parent ?? null) === parentId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({ ...s, subs: childrenOf(s.id) }));
  const majors = childrenOf(null);
  return {
    majors,
    byId,
    chapters: (map && Array.isArray(map.chapters)) ? map.chapters : [],
    meta: {
      schema_version: map && map.schema_version,
      map_version: map && map.map_version,
      scope: map && map.scope,
      generated: map && map.generated,
      step_count: steps.length,
      major_count: majors.length,
      sub_count: steps.length - majors.length,
    },
  };
}

/**
 * Does a step match a selected file-type tag? No filter (null/'') ⇒ true (all
 * match). A step with NO file-type tags never matches a specific filter (honest:
 * it isn't part of that file-type's flow).
 */
export function stepMatchesFileType(step, ftId) {
  if (!ftId) return true;
  const tags = (step && Array.isArray(step.tags)) ? step.tags : [];
  return tags.includes(ftId);
}

/** The file-type tags actually present across a map's steps, in canonical order. */
export function presentFileTypeTags(map) {
  const steps = (map && Array.isArray(map.steps)) ? map.steps : [];
  const seen = new Set();
  for (const s of steps) for (const t of (s.tags || [])) if (STEP_FILE_TYPE_TAGS.includes(t)) seen.add(t);
  return STEP_FILE_TYPE_TAGS.filter((t) => seen.has(t));
}

/** Badge descriptor for a step: kind, observed, and its non-file-type marker tags. */
export function stepBadges(step) {
  const tags = (step && Array.isArray(step.tags)) ? step.tags : [];
  return {
    kind: step && step.kind ? step.kind : null,
    observed: step && step.observed ? step.observed : null,
    fileTypeTags: tags.filter((t) => STEP_FILE_TYPE_TAGS.includes(t)),
    markerTags: tags.filter((t) => STEP_MARKER_TAGS.includes(t)),
  };
}

/**
 * Parse one flag string into structured parts. Flags carry owner PROVENANCE and
 * are rendered as collapsed ruling notes. Recognised leading keywords:
 *   RULED · RULING-NEEDED · MERGE · SPLIT · RENAME · NOTE
 * Grammar (best-effort, defensive): `<KIND> [date] [(<meta>)]: <body>` where the
 * body may contain a `[orig question]` tail. `code` = first token inside (…).
 * Unrecognised strings return {kind:'FLAG', text:raw} — shown, never dropped.
 */
export function parseFlag(raw) {
  const text = String(raw ?? '').trim();
  const m = text.match(/^(RULED|RULING-NEEDED|MERGE|SPLIT|RENAME|NOTE)\b\s*/i);
  if (!m) return { kind: 'FLAG', ruled: false, needsRuling: false, date: null, code: null, ruling: text, origQuestion: null, raw: text };
  const kind = m[1].toUpperCase();
  let rest = text.slice(m[0].length);
  let date = null;
  const dm = rest.match(/^(\d{4}-\d{2}-\d{2})\s*/);
  if (dm) { date = dm[1]; rest = rest.slice(dm[0].length); }
  let code = null;
  const pm = rest.match(/^\(([^)]*)\)\s*/);
  if (pm) { code = pm[1].split(',')[0].trim(); rest = rest.slice(pm[0].length); }
  rest = rest.replace(/^:\s*/, '');
  let ruling = rest;
  let origQuestion = null;
  const oq = rest.split(/\[orig question\]\s*/i);
  if (oq.length > 1) { ruling = oq[0].trim(); origQuestion = oq.slice(1).join(' ').trim(); }
  return {
    kind,
    ruled: kind === 'RULED',
    needsRuling: kind === 'RULING-NEEDED',
    date,
    code,
    ruling: ruling.trim(),
    origQuestion,
    raw: text,
  };
}

/** All parsed flags for a step (empty array when none). */
export function stepFlags(step) {
  const flags = (step && Array.isArray(step.flags)) ? step.flags : [];
  return flags.map(parseFlag);
}

/**
 * Build the procedure-MAP graph from the curated steps: nodes = every step, edges
 * from branch/converge relations plus major→sub containment (so subs cluster
 * around their major hub in the force layout). Deterministic, deduped, pure.
 *   - `contains`  : major → each of its subs (clustering springs)
 *   - `branch`    : step → each id in `branches_to`
 *   - `converge`  : step → `converges_to`
 * Endpoints that don't exist as steps are dropped from EDGES but noted in
 * `.unresolved` (honest — never silently fabricate a target).
 * @returns { nodes:[{id,title,kind,isMajor,parent,tags,order}], edges:[{from,to,rel}], unresolved:[{from,to,rel}] }
 */
export function stepGraph(map) {
  const steps = (map && Array.isArray(map.steps)) ? map.steps : [];
  const idSet = new Set(steps.map((s) => s.id));
  const nodes = steps.map((s) => ({
    id: s.id, title: s.title || s.id, kind: s.kind || 'pipeline',
    isMajor: !s.parent, parent: s.parent ?? null, tags: s.tags || [], order: s.order ?? 0,
  }));
  const edges = [];
  const unresolved = [];
  const seen = new Set();
  const add = (from, to, rel) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!idSet.has(from) || !idSet.has(to)) { unresolved.push({ from, to, rel }); return; }
    edges.push({ from, to, rel });
  };
  for (const s of steps) {
    if (s.parent) add(s.parent, s.id, 'contains');       // parent→child clustering (any depth)
    for (const b of (s.branches_to || [])) add(s.id, b, 'branch');
    if (s.converges_to) add(s.id, s.converges_to, 'converge');
  }
  return { nodes, edges, unresolved };
}

/**
 * Detect ORPHAN annotations: those whose target node id (or either edge endpoint)
 * no longer RESOLVES against the set of ids the app can render. `resolvableIds`
 * is the caller-built union: every dag_base node id, every rollup group id across
 * levels, every curated step id, every clockdrive overlay id. An orphan is
 * SURFACED in a banner, never silently dropped (regen-drift safety).
 * @param annotations parsed annotations array
 * @param resolvableIds Set<string>
 * @returns [{id, kind, targetKind:'node'|'edge', targetLabel, unresolved:[ids], firstWords, author, retargeted}]
 */
export function orphanAnnotations(annotations, resolvableIds) {
  const set = resolvableIds instanceof Set ? resolvableIds : new Set(resolvableIds || []);
  const out = [];
  for (const a of (Array.isArray(annotations) ? annotations : [])) {
    const t = a && a.target;
    if (!t) continue;
    if (typeof t.node === 'string') {
      if (!set.has(t.node)) {
        out.push({
          id: a.id, kind: a.kind, targetKind: 'node', targetLabel: t.node,
          unresolved: [t.node], firstWords: firstWords(a.text), author: a.author || 'owner',
          retargeted: a.retargeted || null,
        });
      }
    } else if (t.edge && typeof t.edge.from === 'string' && typeof t.edge.to === 'string') {
      const miss = [];
      if (!set.has(t.edge.from)) miss.push(t.edge.from);
      if (!set.has(t.edge.to)) miss.push(t.edge.to);
      if (miss.length) {
        out.push({
          id: a.id, kind: a.kind, targetKind: 'edge',
          targetLabel: `${t.edge.from} → ${t.edge.to}${t.edge.type ? ` [${t.edge.type}]` : ''}`,
          unresolved: miss, firstWords: firstWords(a.text), author: a.author || 'owner',
          retargeted: a.retargeted || null,
        });
      }
    }
  }
  return out;
}
