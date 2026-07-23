// ============================================================================
// tools/dag/ui/dag_app.js — interactive two-view DAG collaboration space.
// All graph math lives in dag_model.mjs (pure, tested); this file is DOM only.
//
// Two views over ONE data model (owner-ratified 2026-07-16):
//   graph  — card/node-link view, level roll-up + focus drill-in
//   matrix — adjacency matrix, the scale workhorse (cell color = edge type,
//            solid vs ghosted = VERIFIED vs EXTRACTED, dot badge = comments)
// Annotations key on stable node/edge IDs (never pixels) → carry across views.
// LAW 3 everywhere: absent WHY/HOW renders as an explicit "not yet documented"
// state; absent enrichment renders base-only with an honest banner.
// ============================================================================
import {
  LAYERS, UNRECOGNIZED_LAYER, layerOf, defaultEnabledLayers,
  FILE_TYPES, matchesFileType, edgeKey, mergeGraph,
  rollup, filterRolledEdges, focusSubgraph, CONTRACTS_GROUP,
  annotationKeyFor, indexAnnotations, drawnEdgesFrom,
  egoIds, egoFilter, EGO_DIRECTIONS, layeredLayout, proposedPairsFrom, procedureWalk,
  renderTier, buildStagePathIndex, normalizeClockdrive, clockdriveAnchorGroup,
  applyEdgeVisibility, forceLayout, forceStep, springPairs, linkedNodes,
} from './dag_model.mjs';
// Curated step-map dual rendering (task #11). Pure model in a .js sibling so the
// DAG extractor (scans .mjs/.ts, not .js) never turns it into a base node.
import {
  buildStepTree, stepGraph, stepBadges, stepFlags, stepMatchesFileType,
  presentFileTypeTags, orphanAnnotations,
} from './steps_model.js';

// SITE EMBED (skycruncher.io): static read-only copy. No annotate server exists
// on static hosting — every annotate affordance (comment forms, drawn edges) is
// gated off. Annotations ship as a static empty [] (the honest empty state).
const DAG_READ_ONLY = true;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// layer colors come from the stylesheet (single source of truth)
const rootStyle = getComputedStyle(document.documentElement);
const LAYER_COLOR = {};
for (const l of LAYERS) LAYER_COLOR[l.id] = rootStyle.getPropertyValue(`--c-${l.id}`).trim() || '#8fa0bd';
LAYER_COLOR[UNRECOGNIZED_LAYER] = rootStyle.getPropertyValue('--c-unrecognized').trim() || '#e8e8e8';
const EV_COLOR = { VERIFIED: '#3ddc97', REFUTED: '#ff5c5c', STALE: '#f0b23e' };
const MECH_COLOR = rootStyle.getPropertyValue('--muted').trim() || '#66748f';

// ---- state ------------------------------------------------------------------
const state = {
  view: 'graph',
  level: 'subsystem',
  layers: defaultEnabledLayers(),
  fileType: null,
  base: null,
  enrichment: null,          // parsed enrichment.json or null (honest absence)
  enrichmentNote: '',
  merged: null,              // mergeGraph output
  annotations: [],
  annIndex: new Map(),
  annotatedKeys: new Set(),
  selection: null,           // {type:'node', id, node} | {type:'edge', agg}
  focus: null,               // group id being drilled into (graph view)
  iso: null,                 // {center, hops, direction} — connectivity isolation (graph+matrix)
  vb: null,                  // graph viewBox {x,y,w,h} — pan/zoom state, survives re-renders
  vbKey: null,               // content key; when it changes the viewBox refits
  drawFrom: null,            // node id a drawn-edge starts from
  pendingDrawn: null,        // {from,to} awaiting text
  token: localStorage.getItem('dag_token') || '',
  mechDashed: localStorage.getItem('dag_mech_dashed') === '1', // revert toggle: mechanical edges as dashed (default OFF = thin solid muted, owner-ratified)
  hideMechanical: localStorage.getItem('dag_hide_mech') === '1', // owner 2026-07-16: hide the whole grey parser-derived mass in one click (default OFF = shown)
  hideUnlinked: localStorage.getItem('dag_hide_unlinked') === '1', // owner 2026-07-16: after all edge filters, drop nodes with zero visible connection (default OFF)
  clockdrive: [],            // normalized clockdrive overlay nodes (theses + proposals)
  showTheses: localStorage.getItem('dag_cd_theses') !== '0',      // default ON
  showProposals: localStorage.getItem('dag_cd_proposals') !== '0', // default ON
  layoutMode: localStorage.getItem('dag_layout') === 'layered' ? 'layered' : 'force', // owner 2026-07-16: force web is the DEFAULT; layered demoted to an option
  pins: loadPins(),          // Map "<layout>::<level>::<id>" → {x,y} force-sim coords (per-browser, deterministic space)
  // ---- curated step-map (task #11): the FOURTH view + its graph mode --------------
  stepsMap: null,            // parsed steps_map.json or null (honest absence)
  stepsMode: localStorage.getItem('dag_steps_mode') === 'graph' ? 'graph' : 'list', // list = numbered walk (default) · graph = procedure map
  stepFileType: null,        // curated-map file-type dim filter (fits | cr2-raw | jpeg-tiff)
  stepsExpanded: {},         // ruling-flag expand state, keyed by flag dom id (per-render)
  orphans: [],               // orphan annotations (regen-drift banner source)
  stepVb: null,              // curated-map graph viewBox (its own camera, distinct from the dag graph)
  stepVbKey: null,
  _stepLive: null,           // live force relaxor state for the curated-map graph (drag-with-tension)
};

// ---- pin persistence (per-browser; force-sim coords are stable across sessions) ---
function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem('dag_pins') || '{}');
    return new Map(Object.entries(raw).filter(([, v]) => v && Number.isFinite(v.x) && Number.isFinite(v.y)));
  } catch { return new Map(); }
}
function savePins() {
  localStorage.setItem('dag_pins', JSON.stringify(Object.fromEntries(state.pins)));
}
function pinKey(id) { return `${state.layoutMode}::${state.level}::${id}`; }
function isPinned(id) { return state.pins.has(pinKey(id)); }
function setPin(id, x, y) { state.pins.set(pinKey(id), { x, y }); savePins(); }
function clearPin(id) { state.pins.delete(pinKey(id)); savePins(); }
/** Fixed-position map for forceLayout: pinned nodes among the visible set. */
function pinsFixedMap(nodes) {
  const m = new Map();
  for (const n of nodes) { const p = state.pins.get(pinKey(n.id)); if (p) m.set(n.id, p); }
  return m;
}

// ---- data load ----------------------------------------------------------------
async function loadAll() {
  const [baseRes, enrichRes, annRes, clockRes, stepsRes] = await Promise.all([
    fetch('./data/dag_base.json'),
    fetch('./data/enrichment.json'),
    fetch('./data/annotations.json'),
    fetch('./data/clockdrive.json'),
    fetch('./data/steps_map.json'),
  ]);
  if (!baseRes.ok) {
    $('#loading').textContent = 'dag_base.json not available — run: node tools/dag/extract_dag.mjs';
    $('#banner').className = 'error';
    $('#banner').textContent = 'BASE GRAPH MISSING';
    return false;
  }
  state.base = await baseRes.json();
  if (enrichRes.ok) {
    state.enrichment = await enrichRes.json();
  } else {
    state.enrichment = null;
    try { state.enrichmentNote = (await enrichRes.json()).detail || ''; } catch { state.enrichmentNote = ''; }
  }
  state.annotations = annRes.ok ? await annRes.json() : [];
  // clockdrive overlay: honest-empty on any failure (absent files → [] server-side)
  state.clockdrive = [];
  try { if (clockRes.ok) state.clockdrive = normalizeClockdrive(await clockRes.json()); } catch { state.clockdrive = []; }
  // curated step map: honest null when absent (server 404) — step views state it
  state.stepsMap = null;
  try { if (stepsRes.ok) state.stepsMap = await stepsRes.json(); } catch { state.stepsMap = null; }
  setClockdriveCounts();
  rebuild();
  return true;
}

function rebuild() {
  state.merged = mergeGraph(state.base, state.enrichment);
  state.annIndex = indexAnnotations(state.annotations);
  state.annotatedKeys = new Set(state.annIndex.keys());
  state.orphans = orphanAnnotations(state.annotations, computeResolvableIds());
  renderBanner();
  renderOrphanBanner();
}

/**
 * The union of every id an annotation could legitimately resolve to: base module
 * nodes + rollup group ids across ALL levels (subsystem/stage/boundary group ids
 * are generated, not in dag_base) + curated step ids + clockdrive overlay ids.
 * An annotation whose target falls outside this set is a genuine regen-drift
 * orphan (its node/edge vanished from the rendered universe).
 */
function computeResolvableIds() {
  const set = new Set();
  if (state.merged && state.merged.nodes) for (const id of state.merged.nodes.keys()) set.add(id);
  if (state.merged) {
    const dg = { nodes: state.merged.nodes, edges: state.merged.edges };
    for (const lvl of ['subsystem', 'stage', 'boundary']) {
      try { for (const n of rollup(dg, lvl).nodes) set.add(n.id); } catch { /* level roll-up best-effort */ }
    }
  }
  if (state.stepsMap && Array.isArray(state.stepsMap.steps)) for (const s of state.stepsMap.steps) set.add(s.id);
  for (const n of state.clockdrive || []) set.add(n.id);
  return set;
}

/** merged graph + owner drawn-edge annotations as displayable edges */
function displayGraph() {
  const drawn = drawnEdgesFrom(state.annotations);
  return { nodes: state.merged.nodes, edges: state.merged.edges.concat(drawn) };
}

// ---- banner ---------------------------------------------------------------------
function renderBanner() {
  const b = $('#banner');
  const em = state.merged.enrichment;
  if (!em.present) {
    b.className = 'absent';
    b.textContent = 'ENRICHMENT ABSENT — rendering the generated base only: every edge is EXTRACTED (unverified), WHY/HOW not yet documented. ' + (state.enrichmentNote || '');
  } else if (em.fixture) {
    b.className = 'fixture';
    b.textContent = `DEV FIXTURE ENRICHMENT (schema ${em.schema_version}) — sample overlay for UI development, NOT verifier output. Every fixture text is [FIXTURE]-prefixed.`;
  } else {
    b.className = 'real';
    b.textContent = `enrichment loaded · schema ${em.schema_version} · generated at commit ${em.generated_at_commit}`;
  }
}

// ---- orphan-annotation banner (regen-drift safety, additive) --------------------
// Annotations whose target node/edge id no longer resolves anywhere (drift after a
// dag_base regen) are SURFACED here, never silently dropped. Hidden when there are
// none (the common, healthy case). Clicking an entry opens it in the side panel so
// the owner can re-read / re-target it.
function renderOrphanBanner() {
  const b = $('#orphan-banner');
  if (!b) return;
  const orphans = state.orphans || [];
  if (!orphans.length) { b.style.display = 'none'; b.innerHTML = ''; return; }
  b.style.display = '';
  const rows = orphans.map((o, i) => `<button class="orphan-item" data-i="${i}" title="target no longer in the graph — click to open">
      <span class="orphan-kind">${esc(o.kind)}</span>
      <span class="orphan-target">${esc(o.targetLabel)}</span>
      <span class="orphan-first">“${esc(o.firstWords || '(no text)')}”</span>
      ${o.retargeted ? '<span class="orphan-retag">retargeted note present</span>' : ''}
    </button>`).join('');
  b.innerHTML = `<span class="orphan-head">⚠ ${orphans.length} orphan annotation${orphans.length > 1 ? 's' : ''}</span>
    <span class="orphan-sub">target id no longer resolves in the graph (regen drift) — surfaced, never dropped</span>
    <div class="orphan-list">${rows}</div>`;
  b.querySelectorAll('.orphan-item').forEach((el) => el.addEventListener('click', () => selectOrphan(orphans[Number(el.dataset.i)])));
}

/** Open an orphan annotation in the side panel (read-only context; the target id
 *  is shown verbatim so the owner can re-target it via a fresh comment). */
function selectOrphan(o) {
  state.selection = { type: 'orphan', orphan: o };
  state.pendingDrawn = null;
  renderPanel();
}

// ---- header controls ---------------------------------------------------------------
function wireHeader() {
  $('#view-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    state.view = btn.dataset.view;
    for (const x of $('#view-seg').children) x.classList.toggle('on', x === btn);
    render();
  });
  $('#level-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    state.level = btn.dataset.level;
    state.focus = null; state.selection = null; state.drawFrom = null;
    for (const x of $('#level-seg').children) x.classList.toggle('on', x === btn);
    render();
  });
  // layout selector — owner rework: the free-positioned WEB is the default; the
  // layered "flow" is a non-default option (procedure-style reading may want it)
  const lseg = $('#layout-seg');
  if (lseg) {
    for (const b of lseg.children) b.classList.toggle('on', b.dataset.layout === state.layoutMode);
    lseg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      state.layoutMode = btn.dataset.layout;
      localStorage.setItem('dag_layout', state.layoutMode);
      state.vbKey = null; // refit on layout change
      for (const x of lseg.children) x.classList.toggle('on', x === btn);
      render();
    });
  }
  const chips = $('#ft-chips');
  for (const ft of FILE_TYPES) {
    const c = document.createElement('button');
    c.className = 'ftchip'; c.textContent = ft.id; c.title = ft.role;
    c.addEventListener('click', () => {
      state.fileType = state.fileType === ft.id ? null : ft.id;
      for (const x of chips.children) x.classList.toggle('on', x.textContent === state.fileType);
      render();
    });
    chips.appendChild(c);
  }
}

// ---- clockdrive overlay (roadmap theses + proposals) --------------------------------
function wireClockdrive() {
  const th = $('#cd-theses'), pr = $('#cd-proposals');
  if (!th || !pr) return;
  th.checked = state.showTheses; pr.checked = state.showProposals;
  th.addEventListener('change', () => {
    state.showTheses = th.checked; localStorage.setItem('dag_cd_theses', th.checked ? '1' : '0'); render();
  });
  pr.addEventListener('change', () => {
    state.showProposals = pr.checked; localStorage.setItem('dag_cd_proposals', pr.checked ? '1' : '0'); render();
  });
}
function setClockdriveCounts() {
  const te = $('#cd-theses-cnt'), pe = $('#cd-proposals-cnt');
  if (te) te.textContent = state.clockdrive.filter((n) => n.kind === 'thesis').length;
  if (pe) pe.textContent = state.clockdrive.filter((n) => n.kind === 'proposal').length;
}
/** Clockdrive nodes visible under the two rail toggles (order preserved). */
function clockdriveVisible() {
  return state.clockdrive.filter((n) =>
    (n.kind === 'thesis' && state.showTheses) || (n.kind === 'proposal' && state.showProposals));
}
function selectClockdrive(entry) {
  state.selection = { type: 'clockdrive', entry };
  state.pendingDrawn = null;
  render();
}

// ---- layer rail -----------------------------------------------------------------------
function renderRail(rolledEdgesAll) {
  const counts = {};
  for (const e of rolledEdgesAll) for (const [l, n] of Object.entries(e.layers)) counts[l] = (counts[l] || 0) + n;
  const list = $('#layer-list');
  list.innerHTML = '';
  const rows = [...LAYERS.map((l) => ({ ...l })), { id: UNRECOGNIZED_LAYER, label: 'unrecognized type', defaultOn: true }];
  for (const l of rows) {
    if (l.id === UNRECOGNIZED_LAYER && !counts[l.id]) continue; // only shown when data carries an unknown type
    const empty = !counts[l.id];
    const row = document.createElement('label');
    row.className = 'layer-row' + (l.loud ? ' loud' : '') + (l.defaultOn ? '' : ' off-default') + (empty ? ' empty' : '');
    if (empty) row.title = 'no edges of this type at this level — toggling it has nothing to turn off (honest absence)';
    const on = state.layers.has(l.id);
    row.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>` +
      `<span class="swatch" style="background:${LAYER_COLOR[l.id]}"></span>` +
      `<span class="name">${esc(l.label)}</span><span class="cnt">${counts[l.id] || 0}</span>`;
    row.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) state.layers.add(l.id); else state.layers.delete(l.id);
      render();
    });
    list.appendChild(row);
  }
  // hide-mechanical toggle (owner 2026-07-16): remove the whole grey
  // parser-derived mass in one click — per-layer toggles can't clear it because
  // contract + stage-order are also mechanical
  const hide = document.createElement('label');
  hide.className = 'layer-row mech-toggle';
  hide.title = 'hide every mechanical (grey, parser-derived) edge in one click — verified/refuted/stale and LLM-extracted edges stay';
  hide.innerHTML = `<input type="checkbox" ${state.hideMechanical ? 'checked' : ''}>`
    + `<span class="swatch" style="background:${MECH_COLOR};opacity:0.4"></span>`
    + `<span class="name">hide mechanical edges</span>`;
  hide.querySelector('input').addEventListener('change', (ev) => {
    state.hideMechanical = ev.target.checked;
    localStorage.setItem('dag_hide_mech', state.hideMechanical ? '1' : '0');
    render();
  });
  list.appendChild(hide);
  // hide-unlinked toggle (owner 2026-07-16, sits next to hide-mechanical): after
  // every edge filter, drop any node with no remaining visible connection — trims
  // the view to just the connected web. Works in both graph layouts and the
  // matrix; clockdrive chips are exempt. Default OFF.
  const unl = document.createElement('label');
  unl.className = 'layer-row mech-toggle';
  unl.title = 'after all edge filters (layer toggles, hide-mechanical, ego), hide any node left with zero visible connections — graph (both layouts) and matrix; clockdrive chips exempt';
  unl.innerHTML = `<input type="checkbox" ${state.hideUnlinked ? 'checked' : ''}>`
    + `<span class="swatch" style="background:${MECH_COLOR};opacity:0.22"></span>`
    + `<span class="name">hide unlinked nodes</span>`;
  unl.querySelector('input').addEventListener('change', (ev) => {
    state.hideUnlinked = ev.target.checked;
    localStorage.setItem('dag_hide_unlinked', state.hideUnlinked ? '1' : '0');
    state.vbKey = null; // node set changed → refit
    render();
  });
  list.appendChild(unl);
  // mechanical-tier revert toggle (owner-ratified default: thin solid muted;
  // one click restores the old dashed rendering)
  const mech = document.createElement('label');
  mech.className = 'layer-row mech-toggle';
  mech.title = 'parser-derived edges (import/contract/stage-order from the base) render thin-solid-muted by default; check to render them dashed like unreviewed claims';
  mech.innerHTML = `<input type="checkbox" ${state.mechDashed ? 'checked' : ''}${state.hideMechanical ? ' disabled' : ''}>`
    + `<span class="swatch" style="background:${MECH_COLOR}"></span>`
    + `<span class="name">mechanical edges as dashed</span>`;
  mech.querySelector('input').addEventListener('change', (ev) => {
    state.mechDashed = ev.target.checked;
    localStorage.setItem('dag_mech_dashed', state.mechDashed ? '1' : '0');
    render();
  });
  list.appendChild(mech);
  // honest notes
  const notes = [];
  const em = state.merged.enrichment;
  if (!em.present) notes.push('walked_by file-type tags come from the enrichment lane; with enrichment absent, no node carries tags — a file-type filter therefore dims everything (honest absence, not a bug).');
  const so = rolledEdgesAll.some((e) => e.layers['ordering-only']);
  if (!so) notes.push('no ordering edges in this checkout: the base extractor found no banked receipt (receipts are local-only), so stage order is honestly unordered here.');
  const unplaced = state._unplacedDrawn || 0;
  if (unplaced) notes.push(`${unplaced} edge(s) (owner-drawn or enrichment) reference IDs not present at this level — kept in the data, not drawable here.`);
  $('#rail-notes').innerHTML = notes.map((n) => `<div>${esc(n)}</div>`).join('<br>');
}

// ---- shared render entry -------------------------------------------------------------
function render() {
  const dg = displayGraph();
  state._proposedPairs = proposedPairsFrom(state.annotations);
  const rolled = rollup(dg, state.level, { annotatedKeys: state.annotatedKeys });
  const nodeIds = new Set(rolled.nodes.map((n) => n.id));
  state._lastNodeIds = nodeIds;
  let edges = filterRolledEdges(rolled.edges, state.layers);
  edges = applyEdgeVisibility(edges, { hideMechanical: state.hideMechanical });
  state._unplacedDrawn = rolled.edges.filter((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to)).length;
  edges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  // aggregate-level annotation badge (constituent badges are set by rollup)
  for (const e of edges) {
    if (!e.annotated && state.annIndex.has(`edge:${edgeKey(e.from, e.to, 'aggregate')}`)) e.annotated = true;
  }
  renderRail(rolled.edges);

  // connectivity isolation: ego subgraph over the LAYER-FILTERED edges, honest
  // auto-exit when the center id does not exist at the current level
  let visNodes = rolled.nodes;
  if (state.iso && !nodeIds.has(state.iso.center)) state.iso = null;
  if (state.iso) {
    const ego = egoFilter(visNodes, edges, state.iso.center, state.iso);
    visNodes = ego.nodes;
    edges = ego.edges;
  }
  // hide-unlinked (owner add): after EVERY edge filter (layer toggles +
  // hide-mechanical + ego + endpoint-existence), drop nodes with zero remaining
  // visible connection. Pure fn in the model; recomputed every render → live on
  // any filter change. Feeds BOTH graph layouts (hidden nodes leave the laid-out
  // set, so they exert no forces) and the matrix (their rows/cols disappear).
  // Clockdrive is an overlay strip (not in visNodes) → inherently exempt. Removed
  // nodes have degree 0, so no edge is orphaned (no edge re-filter needed).
  if (state.hideUnlinked) visNodes = linkedNodes(visNodes, edges);
  renderIsoBar(visNodes.length, edges.length);

  $('#loading').style.display = 'none';
  $('#graph-view').style.display = state.view === 'graph' ? '' : 'none';
  $('#matrix-view').style.display = state.view === 'matrix' ? '' : 'none';
  $('#procedure-view').style.display = state.view === 'procedure' ? '' : 'none';
  $('#steps-view').style.display = state.view === 'steps' ? '' : 'none';
  $('#focus-bar').style.display = (state.view === 'graph' && state.focus) ? '' : 'none';

  if (state.view === 'graph') {
    if (state.focus) renderFocus(dg); else renderGraph(visNodes, edges);
  } else if (state.view === 'matrix') {
    renderMatrix(visNodes, edges);
  } else if (state.view === 'steps') {
    renderStepsView();
  } else {
    renderProcedure();
  }
  renderPanel();
}

// ---- connectivity-isolation bar ----------------------------------------------------
function renderIsoBar(nVis, eVis) {
  const bar = $('#iso-bar');
  if (!state.iso || state.view === 'procedure' || state.view === 'steps' || (state.view === 'graph' && state.focus)) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const { center, hops, direction } = state.iso;
  bar.innerHTML = `isolated: <b>${esc(center.replace(/^subsystem:/, ''))}</b>`
    + ` <span class="iso-meta">· ${nVis} node(s) · ${eVis} edge(s) shown</span>`
    + ` <span class="iso-meta">hops</span> <button class="btn ghost" id="iso-minus" ${hops <= 1 ? 'disabled' : ''}>−1</button>`
    + ` <b>${hops}</b> <button class="btn ghost" id="iso-plus">+1</button>`
    + ` <span class="seg" id="iso-dir">${EGO_DIRECTIONS.map((d) =>
        `<button data-dir="${d}" class="${d === direction ? 'on' : ''}">${d === 'upstream' ? 'upstream (feeds this)' : d === 'downstream' ? 'downstream (fed by this)' : 'both'}</button>`).join('')}</span>`
    + ` <button class="btn" id="iso-exit">exit isolation</button>`;
  bar.querySelector('#iso-plus').addEventListener('click', () => { state.iso.hops += 1; render(); });
  const minus = bar.querySelector('#iso-minus');
  if (minus) minus.addEventListener('click', () => { state.iso.hops = Math.max(1, state.iso.hops - 1); render(); });
  bar.querySelector('#iso-dir').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.iso.direction = b.dataset.dir;
    render();
  });
  bar.querySelector('#iso-exit').addEventListener('click', () => { state.iso = null; render(); });
}

// ---- taxonomy bucketing (matrix row/col ordering; the graph view now uses the
// layered layout instead of these fixed columns) ---------------------------------
function colOf(n) {
  const label = n.label || n.id;
  if (n.kind === 'boundary' || label === CONTRACTS_GROUP) return 3;
  if (n.kind === 'stage' || label.startsWith('engine/pipeline')) return 2;
  if (label.startsWith('engine')) return 1;
  if (label === 'src' || label.startsWith('src/')) return 0;
  if (label === 'tools' || label.startsWith('tools/')) return 4;
  return 5;
}
function nodeDimmed(n) {
  return state.fileType !== null && !matchesFileType(n.walked_by, state.fileType);
}
function dominantLayer(e) {
  let best = null, bn = -1;
  for (const [l, n] of Object.entries(e.layers)) if (n > bn) { bn = n; best = l; }
  return best;
}
function edgeStroke(e) {
  const dom = dominantLayer(e);
  const tier = renderTier(e);
  let color = LAYER_COLOR[dom] || '#8fa0bd';
  if (tier === 'refuted') color = EV_COLOR.REFUTED;
  else if (tier === 'stale') color = EV_COLOR.STALE;
  const loud = dom === 'unit-frame-conversion';
  if (tier === 'mechanical' && !state.mechDashed) {
    // parser-derived, drift-gate-checked (owner-ratified): thin solid muted —
    // distinct from VERIFIED (full solid) and LLM-EXTRACTED (dashed)
    return { color: MECH_COLOR, width: 1 + (loud ? 1.5 : 0), dash: null, opacity: 0.55, tier };
  }
  const ghost = tier === 'extracted' || tier === 'mechanical';
  return {
    color,
    width: Math.min(6, 1 + Math.log2(e.count + 1)) + (loud ? 1.5 : 0),
    dash: ghost ? '6 4' : null,
    opacity: ghost ? 0.5 : 0.9,
    tier,
  };
}

// ---- graph (card) view: Sugiyama layered layout + pan/zoom + semantic zoom -----
// Layout math (ranks + barycentric order) is PURE in dag_model.mjs and
// deterministic — the owner has spatial memory across sessions, so the same
// data always lands in the same place. This block only maps (rank, order) to
// pixels and handles the viewBox camera.
const NODE_W = 188, NODE_H = 30, ROW_GAP = 8, LANE_W = NODE_W + 12, COL_GAP = 96, TOP = 46;
const SLOT_H = 78, RANK_GAP = 130, GMARGIN = 40, DETAIL_H = 66;

// clockdrive strip (unanchored roadmap chips, reserved at the top of the world)
const CD_CHIP_W = 152, CD_CHIP_H = 26, CD_GAP_X = 8, CD_GAP_Y = 6, CD_LABEL_H = 16, CD_BAND_TOP = 26;

/** Lay out the clockdrive chips into a wrapping band anchored at (ox, oy). Pure
 *  geometry (no DOM): theses group first, then proposals; each group gets a
 *  sub-label; chips wrap within `bandW`. Empty input ⇒ height 0 (no band drawn).
 *  Coordinates are ABSOLUTE world coords so the band coexists with either layout
 *  (layered = top-left origin · force = floated above the node cloud). */
function layoutClockdriveStrip(cdNodes, bandW, ox, oy) {
  if (!cdNodes.length) return { chips: [], labels: [], band: null, height: 0 };
  const startX = ox + GMARGIN;
  const availW = Math.max(bandW - GMARGIN * 2, CD_CHIP_W);
  const chips = [], labels = [];
  let y = oy + CD_BAND_TOP;
  for (const kind of ['thesis', 'proposal']) {
    const group = cdNodes.filter((n) => n.kind === kind);
    if (!group.length) continue;
    labels.push({ kind, x: startX, y: y + 11, count: group.length });
    y += CD_LABEL_H;
    let x = startX;
    for (const entry of group) {
      if (x > startX && x + CD_CHIP_W > startX + availW) { x = startX; y += CD_CHIP_H + CD_GAP_Y; }
      chips.push({ entry, x, y, w: CD_CHIP_W, h: CD_CHIP_H });
      x += CD_CHIP_W + CD_GAP_X;
    }
    y += CD_CHIP_H + CD_GAP_Y * 2; // clear the last row, gap before the next group
  }
  const height = (y + 4) - oy;
  return { chips, labels, band: { x: ox + 6, y: oy + 2, w: Math.max(120, bandW - 12), h: height - 2 }, height };
}

/** Draw the clockdrive strip (band + kind labels + chips + best-effort anchor lines)
 *  into the graph SVG. Trust rendering: pending = dashed hollow · dead = struck +
 *  dimmed · adopted/approved = subtle solid; unknown status carries a warn flag. */
function drawClockdriveStrip(svg, strip, pos, nodeIds, stageIdx) {
  if (!strip.height || !strip.band) return;
  const g = svgEl('g', { class: 'cd-strip' });
  g.appendChild(svgEl('rect', { class: 'cd-band', x: strip.band.x, y: strip.band.y, width: strip.band.w, height: strip.band.h, rx: 8 }));
  const bl = svgEl('text', { class: 'cd-band-label', x: strip.band.x + 34, y: strip.band.y + 16 });
  bl.textContent = 'clockdrive';
  g.appendChild(bl);
  for (const l of strip.labels) {
    const t = svgEl('text', { class: 'cd-kind-label', x: l.x, y: l.y });
    t.textContent = `${l.kind === 'thesis' ? 'theses' : 'proposals'} (${l.count})`;
    g.appendChild(t);
  }
  // best-effort anchor lines: only when the anchor resolves to a node rendered NOW
  for (const c of strip.chips) {
    for (const a of c.entry.anchors) {
      const gid = clockdriveAnchorGroup(a, state.merged, state.level, stageIdx);
      if (gid && nodeIds.has(gid) && pos.has(gid)) {
        const np = pos.get(gid);
        g.appendChild(svgEl('line', { class: 'cd-anchor-line', x1: c.x + c.w / 2, y1: c.y + c.h, x2: np.x + NODE_W / 2, y2: np.y }));
        break; // one line per chip — clutter guard
      }
    }
  }
  for (const c of strip.chips) {
    const e = c.entry;
    const selected = state.selection && state.selection.type === 'clockdrive' && state.selection.entry.id === e.id;
    const cg = svgEl('g', { class: `cd-chip cd-${e.status}` + (selected ? ' selected' : ''), transform: `translate(${c.x},${c.y})` });
    cg.appendChild(svgEl('rect', { width: c.w, height: c.h, rx: 5 }));
    const title = svgEl('text', { class: 'cd-chip-title', x: 8, y: 11 });
    title.textContent = truncate(e.title || e.id, 24);
    cg.appendChild(title);
    const sub = svgEl('text', { class: 'cd-chip-sub', x: 8, y: 21 });
    sub.textContent = e.status + (e.submitter_class ? ' · AI' : '');
    cg.appendChild(sub);
    if (e.status === 'dead') cg.appendChild(svgEl('line', { class: 'cd-strike', x1: 6, y1: c.h / 2, x2: c.w - 6, y2: c.h / 2 }));
    if (e.statusFlagged) cg.appendChild(svgEl('circle', { class: 'cd-flag', cx: c.w - 8, cy: 8, r: 3 }));
    cg.addEventListener('click', () => selectClockdrive(e));
    cg.addEventListener('mousemove', (ev) => showTip(ev,
      `<div class="t-title">${esc(e.title || e.id)}</div>`
      + `<div class="t-meta">clockdrive ${esc(e.kind)} · ${esc(e.status)}${e.statusFlagged ? ' (flagged)' : ''}</div>`
      + (e.raw_status ? `<div class="t-meta">${esc(e.raw_status)}</div>` : '')));
    cg.addEventListener('mouseleave', hideTip);
    g.appendChild(cg);
  }
  svg.appendChild(g);
}

/** Fit a world bbox {x,y,w,h} (any origin — force coords are centered on 0) into
 *  the viewport, centered. */
function fitBox(bx, cw, ch) {
  const scale = Math.min(cw / bx.w, ch / bx.h, 1);
  const w = cw / scale, h = ch / scale;
  return { x: bx.x + (bx.w - w) / 2, y: bx.y + (bx.h - h) / 2, w, h };
}

function applyVB(svg) {
  const vb = state.vb;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  // semantic zoom: px-per-world-unit ≥ ~1.05 ⇒ detail cards
  const k = (svg.clientWidth || Number(svg.getAttribute('width'))) / vb.w;
  svg.classList.toggle('sem-detail', k >= 1.05);
}

function zoomBy(svg, factor, clientX, clientY, worldW) {
  const vb = state.vb;
  const r = svg.getBoundingClientRect();
  const nw = Math.min(worldW * 6 + 4000, Math.max(120, vb.w * factor));
  const s = nw / vb.w;
  const mx = vb.x + ((clientX - r.left) / r.width) * vb.w;
  const my = vb.y + ((clientY - r.top) / r.height) * vb.h;
  vb.x = mx - (mx - vb.x) * s;
  vb.y = my - (my - vb.y) * s;
  vb.w = nw;
  vb.h = vb.h * s;
  applyVB(svg);
}

/** Screen (clientX/Y) → world coords via the current viewBox. */
function screenToWorld(svg, clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return {
    x: state.vb.x + ((clientX - r.left) / r.width) * state.vb.w,
    y: state.vb.y + ((clientY - r.top) / r.height) * state.vb.h,
  };
}

/** Edge path string. Force = straight center-to-center line (a free web); layered
 *  = the rank-directed bezier attaching at card left/right edges. */
function edgePathD(a, b, useForce) {
  if (useForce) return `M ${a.cx} ${a.cy} L ${b.cx} ${b.cy}`;
  const ay = a.cy, by = b.cy;
  if (b.x > a.x) { const x1 = a.x + NODE_W, x2 = b.x, mx = (x1 + x2) / 2; return `M ${x1} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${x2} ${by}`; }
  if (b.x < a.x) { const x1 = a.x, x2 = b.x + NODE_W, mx = (x1 + x2) / 2; return `M ${x1} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${x2} ${by}`; }
  const x1 = a.x + NODE_W, x2 = b.x + NODE_W, bow = 34 + Math.abs(by - ay) * 0.08;
  return `M ${x1} ${ay} C ${x1 + bow} ${ay}, ${x2 + bow} ${by}, ${x2} ${by}`;
}

// ---- interactive force relaxation (drag-with-tension + pinning) ----------------
// state._live (set in renderGraph, force mode only) = { sim:Map id→{x,y}(centers),
// ids:sorted, springs, kk, nodeEls:Map id→g, edgeEls:[{path,hit,from,to}],
// proposedEls:[{line,hit,from,to}] }. The sim is a LIVE relaxor: dragging a node
// keeps its neighbors clearing around it (owner order 2026-07-16). The seeded
// deterministic layout is the resting state; this only perturbs it live.
function pinnedVisibleIds() {
  const prefix = `${state.layoutMode}::${state.level}::`;
  const out = [];
  for (const k of state.pins.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
  return out;
}
function paintLive() {
  const L = state._live; if (!L) return;
  for (const [id, g] of L.nodeEls) { const s = L.sim.get(id); if (s) g.setAttribute('transform', `translate(${s.x - NODE_W / 2},${s.y - NODE_H / 2})`); }
  for (const e of L.edgeEls) {
    const a = L.sim.get(e.from), b = L.sim.get(e.to); if (!a || !b) continue;
    const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    e.path.setAttribute('d', d); if (e.hit) e.hit.setAttribute('d', d);
  }
  for (const e of L.proposedEls) {
    const a = L.sim.get(e.from), b = L.sim.get(e.to); if (!a || !b) continue;
    for (const el of [e.line, e.hit]) { if (!el) continue; el.setAttribute('x1', a.x); el.setAttribute('y1', a.y); el.setAttribute('x2', b.x); el.setAttribute('y2', b.y); }
  }
}
function dragRelax(id, wx, wy) {
  const L = state._live; if (!L || !L.sim.has(id)) return;
  L.sim.get(id).x = wx; L.sim.get(id).y = wy;
  const fixed = new Set([id, ...pinnedVisibleIds().filter((n) => L.sim.has(n))]);
  for (let i = 0; i < 6; i++) forceStep(L.sim, L.ids, L.springs, { k: L.kk, temp: L.kk * 0.14, gravity: 0.03, fixed });
  paintLive();
}
function endDrag(id) {
  const L = state._live; if (!L || !L.sim.has(id)) { state._dragging = null; return; }
  const s = L.sim.get(id);
  setPin(id, s.x, s.y);   // release auto-pins (owner spec); unpin available in the panel + pin dot
  state._dragging = null;
  render();
}

function renderGraph(nodes, edges) {
  const host = $('#graph-view');
  host.innerHTML = '';
  if (!nodes.length) {
    host.innerHTML = '<div id="loading">no nodes visible under the current filters</div>';
    return;
  }

  const useForce = state.layoutMode !== 'layered';
  const cdNodes = clockdriveVisible();

  // ---- node centers (world coords) ----
  // force (DEFAULT, owner rework): seeded deterministic web, positions free —
  // no ranks, no columns. layered: the demoted "flow" option, rank×order grid.
  const center = new Map();
  let layout = null;
  const nN = nodes.length;
  const side = Math.max(600, Math.sqrt(nN) * 170);
  const kk = Math.max(70, Math.sqrt((side * side) / nN));
  if (useForce) {
    const fpos = forceLayout(nodes, edges, { fixed: pinsFixedMap(nodes) });
    for (const [id, p] of fpos) center.set(id, { cx: p.x, cy: p.y });
  } else {
    layout = layeredLayout(nodes, edges);
    for (const n of nodes) {
      const r = layout.rank.get(n.id), o = layout.order.get(n.id);
      center.set(n.id, { cx: GMARGIN + r * (NODE_W + RANK_GAP) + NODE_W / 2, cy: TOP + o * SLOT_H + NODE_H / 2 });
    }
  }

  // ---- node bbox (any origin; force is centered on 0) ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of center.values()) {
    minX = Math.min(minX, c.cx); maxX = Math.max(maxX, c.cx);
    minY = Math.min(minY, c.cy); maxY = Math.max(maxY, c.cy);
  }
  minX -= NODE_W / 2 + GMARGIN; maxX += NODE_W / 2 + GMARGIN;
  minY -= NODE_H / 2 + GMARGIN; maxY += NODE_H / 2 + GMARGIN;
  const nodeTopY = minY;

  // ---- clockdrive strip floated ABOVE the node cloud (kept a strip; chips are
  // not sim particles — owner ruling) ----
  const bandW = Math.max(maxX - minX, 480);
  let strip = layoutClockdriveStrip(cdNodes, bandW, minX, 0);
  if (strip.height) {
    const stripTop = minY - strip.height - 24;
    strip = layoutClockdriveStrip(cdNodes, bandW, minX, stripTop);
    minY = Math.min(minY, stripTop);
  }
  const bbox = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };

  // ---- pos: id → {x (top-left), y, cx, cy, n} ----
  const pos = new Map();
  for (const n of nodes) {
    const c = center.get(n.id);
    pos.set(n.id, { x: c.cx - NODE_W / 2, y: c.cy - NODE_H / 2, cx: c.cx, cy: c.cy, n });
  }

  // container size; a hidden-at-load pane can measure 0 — fall back to the
  // window minus the rails (corrected on the next resize event anyway)
  const hostRect = host.getBoundingClientRect();
  const cw = Math.floor(hostRect.width >= 50 ? hostRect.width : Math.max(400, window.innerWidth - 610));
  const ch = Math.floor(hostRect.height >= 50 ? hostRect.height : Math.max(320, window.innerHeight - 120));
  const svg = svgEl('svg', { id: 'graph-svg', width: cw, height: ch, preserveAspectRatio: 'xMidYMid meet' });

  const key = `graph|${state.layoutMode}|${state.level}|${state.iso ? `${state.iso.center}|${state.iso.hops}|${state.iso.direction}` : ''}`
    + `|cd:${cdNodes.length}:${state.showTheses ? 1 : 0}${state.showProposals ? 1 : 0}`
    + `|mech:${state.hideMechanical ? 1 : 0}|hu:${state.hideUnlinked ? 1 : 0}|pins:${pinnedVisibleIds().length}`;
  if (!state.vb || state.vbKey !== key) { state.vb = fitBox(bbox, cw, ch); state.vbKey = key; }

  // live relaxor state (force mode: drag-with-tension + pinning)
  state._live = null;
  if (useForce) {
    const sim = new Map();
    for (const [id, c] of center) sim.set(id, { x: c.cx, y: c.cy });
    state._live = { sim, ids: [...center.keys()].sort(), springs: springPairs(edges, new Set(center.keys())), kk, nodeEls: new Map(), edgeEls: [], proposedEls: [] };
  }

  // rank guides (LAYERED only — orientation, not taxonomy). The force web has none.
  if (!useForce && layout) {
    for (let r = 0; r < layout.layerCount; r++) {
      const t = svgEl('text', { x: GMARGIN + r * (NODE_W + RANK_GAP), y: nodeTopY + 20, class: 'colhdr' });
      t.textContent = `rank ${r}`;
      svg.appendChild(t);
    }
  }

  // edges under nodes
  const eg = svgEl('g');
  svg.appendChild(eg);
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const s = edgeStroke(e);
    const d = edgePathD(a, b, useForce);
    const dim = nodeDimmed(a.n) || nodeDimmed(b.n);
    const selected = state.selection && state.selection.type === 'edge'
      && state.selection.agg.from === e.from && state.selection.agg.to === e.to;
    const path = svgEl('path', {
      d, class: 'gedge' + (dim ? ' dimmed' : '') + (selected ? ' selected' : ''),
      stroke: s.color, 'stroke-width': s.width, 'stroke-opacity': s.opacity,
    });
    if (s.dash) path.setAttribute('stroke-dasharray', s.dash);
    if (e.constituents.some((c) => c.drawn)) path.setAttribute('stroke-dasharray', '2 5');
    eg.appendChild(path);
    const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
    if (e.verification === 'REFUTED') {
      eg.appendChild(svgEl('line', { x1: mx - 5, y1: my - 5, x2: mx + 5, y2: my + 5, stroke: EV_COLOR.REFUTED, 'stroke-width': 2 }));
    }
    if (e.annotated) {
      eg.appendChild(svgEl('circle', { cx: mx, cy: my - 8, r: 3.5, class: 'mx-ann' }));
    }
    const hit = svgEl('path', { d, class: 'gedge-hit' });
    hit.addEventListener('click', () => { selectEdge(e); });
    hit.addEventListener('mousemove', (ev) => { if (!state._dragging) showEdgeTip(ev, e); });
    hit.addEventListener('mouseleave', hideTip);
    eg.appendChild(hit);
    if (state._live) state._live.edgeEls.push({ path, hit, from: e.from, to: e.to });
  }

  // owner-proposed connections (empty-cell annotations): overlay lines on the
  // annotation layer — never part of the roll-up, distinct from drawn edges
  if (state.layers.has('annotation')) {
    for (const p of state._proposedPairs || []) {
      const a = pos.get(p.from), b = pos.get(p.to);
      if (!a || !b) continue;
      const line = svgEl('line', { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy, class: 'g-proposed' });
      eg.appendChild(line);
      const hit = svgEl('line', { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy, class: 'gedge-hit' });
      hit.addEventListener('click', () => selectPair(p));
      hit.addEventListener('mousemove', (ev) => showTip(ev,
        `<div class="t-title">${esc(p.from)} → ${esc(p.to)}</div>`
        + `<div class="t-meta">proposed connection (owner) · ${p.count} annotation(s) · no extracted/verified edge here</div>`));
      hit.addEventListener('mouseleave', hideTip);
      eg.appendChild(hit);
      if (state._live) state._live.proposedEls.push({ line, hit, from: p.from, to: p.to });
    }
  }

  // nodes: compact card always; detail card swapped in by semantic zoom
  for (const { x: nx, y: ny, n } of pos.values()) {
    const g = svgEl('g', {
      class: 'gnode kind-' + n.kind
        + (nodeDimmed(n) ? ' dimmed' : '')
        + (state.selection && state.selection.type === 'node' && state.selection.id === n.id ? ' selected' : ''),
      transform: `translate(${nx},${ny})`,
    });
    const rx = n.kind === 'boundary' ? 13 : 5;
    g.appendChild(svgEl('rect', { class: 'nd-compact', width: NODE_W, height: NODE_H, rx }));
    g.appendChild(svgEl('rect', { class: 'nd-detail', width: NODE_W, height: DETAIL_H, rx }));
    const label = svgEl('text', { x: 8, y: 13.5 });
    label.textContent = truncate(n.label, 24);
    g.appendChild(label);
    const sub = svgEl('text', { x: 8, y: 25, class: 'sub' });
    sub.textContent = n.kind === 'subsystem'
      ? `${n.memberCount} modules${n.internalEdgeCount ? ` · ${n.internalEdgeCount} internal` : ''}`
      : n.kind + (n.memberCount > 1 ? ` · ${n.memberCount - 1} module twin` : '');
    g.appendChild(sub);
    // detail lines (semantic zoom): verified plain-language copy when present,
    // else WHY, else an explicit honest-absent state — never invented text
    const detailSrc = (n.copy && n.copy.text) || (n.why && n.why.text) || null;
    const l1 = svgEl('text', { x: 8, y: 40, class: 'nd-detail-txt' + (detailSrc ? '' : ' faint') });
    l1.textContent = detailSrc ? detailSrc.slice(0, 38) : 'why: not yet documented';
    g.appendChild(l1);
    if (detailSrc && detailSrc.length > 38) {
      const l2 = svgEl('text', { x: 8, y: 51, class: 'nd-detail-txt' });
      l2.textContent = detailSrc.slice(38, 74) + (detailSrc.length > 74 ? '…' : '');
      g.appendChild(l2);
    }
    const wb = svgEl('text', { x: 8, y: DETAIL_H - 5, class: 'nd-detail-txt faint' });
    wb.textContent = n.walked_by && n.walked_by.length ? `walked by: ${n.walked_by.join(', ')}` : 'no receipt walk recorded';
    g.appendChild(wb);
    if (n.annotated) g.appendChild(svgEl('circle', { cx: NODE_W - 9, cy: 9, r: 3.5, class: 'ann-dot' }));
    if (n.why) g.appendChild(svgEl('circle', { cx: NODE_W - 9, cy: NODE_H - 9, r: 2.5, fill: '#4cc2ff', opacity: 0.7 }));
    // pin marker (force mode): a pinned node is fixed; the sim skips it. Click the
    // dot to release it (drag auto-pins; panel has an explicit pin/unpin too).
    if (useForce && isPinned(n.id)) {
      g.classList.add('pinned');
      const pinDot = svgEl('circle', { cx: 7, cy: 7, r: 4, class: 'pin-dot' });
      const title = svgEl('title'); title.textContent = 'pinned — click to release'; pinDot.appendChild(title);
      pinDot.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      pinDot.addEventListener('click', (ev) => { ev.stopPropagation(); clearPin(n.id); render(); });
      g.appendChild(pinDot);
    }
    g.addEventListener('mousemove', (ev) => { if (!state._dragging) showNodeTip(ev, n); });
    g.addEventListener('mouseleave', hideTip);
    if (useForce) {
      // pointer gesture: click (no move) = select · drag = live relax + auto-pin
      let down = false, moved = false, sx = 0, sy = 0;
      g.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();               // don't let the svg start a pan
        try { g.setPointerCapture(ev.pointerId); } catch { /* older engines */ }
        down = true; moved = false; sx = ev.clientX; sy = ev.clientY; state._dragging = null;
      });
      g.addEventListener('pointermove', (ev) => {
        if (!down) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; state._dragging = n.id; hideTip();
        const w = screenToWorld(svg, ev.clientX, ev.clientY);
        dragRelax(n.id, w.x, w.y);
      });
      g.addEventListener('pointerup', (ev) => {
        if (!down) return;
        down = false;
        try { g.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
        if (moved) endDrag(n.id); else nodeClicked(n);
      });
    } else {
      g.addEventListener('click', () => nodeClicked(n));
    }
    svg.appendChild(g);
    if (state._live) state._live.nodeEls.set(n.id, g);
  }

  // clockdrive strip on top (unanchored roadmap chips + best-effort anchor lines)
  drawClockdriveStrip(svg, strip, pos, new Set(nodes.map((n) => n.id)), buildStagePathIndex(state.merged.nodes));

  // camera: wheel zoom about the cursor; drag-pan from empty space (pointer capture)
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoomBy(svg, Math.exp(ev.deltaY * 0.0012), ev.clientX, ev.clientY, bbox.w);
  }, { passive: false });
  let pan = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg || ev.button !== 0) return;
    svg.setPointerCapture(ev.pointerId);
    pan = { sx: ev.clientX, sy: ev.clientY, vx: state.vb.x, vy: state.vb.y, vw: state.vb.w, vh: state.vb.h };
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pan) return;
    const r = svg.getBoundingClientRect();
    state.vb.x = pan.vx - ((ev.clientX - pan.sx) / r.width) * pan.vw;
    state.vb.y = pan.vy - ((ev.clientY - pan.sy) / r.height) * pan.vh;
    applyVB(svg);
  });
  const endPan = () => { pan = null; svg.classList.remove('panning'); };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  host.appendChild(svg);
  applyVB(svg);

  // zoom controls (also the playwright-testable path)
  const ctl = document.createElement('div');
  ctl.className = 'zoom-ctl';
  ctl.innerHTML = '<button data-z="in" title="zoom in">+</button><button data-z="out" title="zoom out">−</button><button data-z="fit" title="fit all">fit</button>';
  ctl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const r = svg.getBoundingClientRect();
    if (b.dataset.z === 'fit') { state.vb = fitBox(bbox, cw, ch); applyVB(svg); return; }
    zoomBy(svg, b.dataset.z === 'in' ? 1 / 1.4 : 1.4, r.left + r.width / 2, r.top + r.height / 2, bbox.w);
  });
  host.appendChild(ctl);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---- focus (drill-in) view --------------------------------------------------------------
function renderFocus(dg) {
  const host = $('#graph-view');
  host.innerHTML = '';
  const fb = $('#focus-bar');
  fb.innerHTML = `focused: <b>${esc(state.focus.replace(/^subsystem:/, ''))}</b> — module-level drill-in `
    + `<button class="btn ghost" id="exit-focus">back to ${esc(state.level)} view</button>`;
  fb.querySelector('#exit-focus').addEventListener('click', () => { state.focus = null; render(); });

  const f = focusSubgraph(dg, state.level, state.focus);
  let members = f.members;
  let capNote = '';
  const deg = new Map();
  for (const e of f.edges) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  if (members.length > 60) {
    members = [...members].sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)).slice(0, 60);
    capNote = `showing 60 of ${f.members.length} members (by edge count)`;
  }
  const memberIds = new Set(members.map((m) => m.id));
  const edges = f.edges.filter((e) => state.layers.has(e.layer))
    .filter((e) => (memberIds.has(e.from) || e.from.startsWith('subsystem:') || !f.members.some((m) => m.id === e.from))
                && (memberIds.has(e.to) || e.to.startsWith('subsystem:') || !f.members.some((m) => m.id === e.to)));

  // layout: ports (other groups) left column, members center in lanes
  const ports = f.ports.sort((a, b) => b.count - a.count);
  const pos = new Map();
  ports.forEach((p, i) => pos.set(p.id, { x: 24, y: TOP + i * (NODE_H + ROW_GAP), port: true, label: p.id.replace(/^subsystem:/, ''), count: p.count }));
  const lanes = Math.min(3, Math.ceil(members.length / 22));
  const perLane = Math.ceil(members.length / lanes);
  members.forEach((m, i) => {
    const lane = Math.floor(i / perLane), row = i % perLane;
    pos.set(m.id, { x: 24 + LANE_W + COL_GAP + lane * LANE_W, y: TOP + row * (NODE_H + ROW_GAP), m });
  });
  const width = 24 + LANE_W + COL_GAP + lanes * LANE_W + 60;
  const height = TOP + Math.max(ports.length, perLane) * (NODE_H + ROW_GAP) + 60;
  const svg = svgEl('svg', { id: 'graph-svg', width, height });
  const th = svgEl('text', { x: 24, y: 24, class: 'colhdr' });
  th.textContent = `neighbor groups (${ports.length})`;
  svg.appendChild(th);
  const th2 = svgEl('text', { x: 24 + LANE_W + COL_GAP, y: 24, class: 'colhdr' });
  th2.textContent = `members ${capNote ? '— ' + capNote : `(${members.length})`}`;
  svg.appendChild(th2);

  const eg = svgEl('g'); svg.appendChild(eg);
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const s = edgeStroke({ layers: { [e.layer]: 1 }, count: 1, verification: e.verification, constituents: [e] });
    const ay = a.y + NODE_H / 2, by = b.y + NODE_H / 2;
    const x1 = a.x + (b.x > a.x ? NODE_W : 0), x2 = b.x + (b.x > a.x ? 0 : NODE_W);
    const mx = (x1 + x2) / 2;
    const path = svgEl('path', {
      d: `M ${x1} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${x2} ${by}`,
      class: 'gedge', stroke: s.color, 'stroke-width': s.width, 'stroke-opacity': s.opacity,
    });
    if (s.dash) path.setAttribute('stroke-dasharray', s.dash);
    eg.appendChild(path);
    const hit = svgEl('path', { d: path.getAttribute('d'), class: 'gedge-hit' });
    hit.addEventListener('click', () => selectEdge({ from: e.from, to: e.to, count: 1, types: { [e.type]: 1 }, layers: { [e.layer]: 1 }, verification: e.verification, verifiedCount: e.verification === 'VERIFIED' ? 1 : 0, constituents: [e], walked_by: e.walked_by, annotated: state.annIndex.has(`edge:${edgeKey(e.from, e.to, e.type)}`) }));
    hit.addEventListener('mousemove', (ev) => showEdgeTip(ev, { ...e, count: 1, types: { [e.type]: 1 }, layers: { [e.layer]: 1 }, constituents: [e] }));
    hit.addEventListener('mouseleave', hideTip);
    eg.appendChild(hit);
  }

  for (const [id, p] of pos) {
    if (p.port) {
      const g = svgEl('g', { class: 'gnode kind-subsystem', transform: `translate(${p.x},${p.y})` });
      g.appendChild(svgEl('rect', { width: NODE_W, height: NODE_H, rx: 5, 'stroke-dasharray': '4 3' }));
      const t = svgEl('text', { x: 8, y: 13.5 }); t.textContent = truncate(p.label, 24); g.appendChild(t);
      const s2 = svgEl('text', { x: 8, y: 25, class: 'sub' }); s2.textContent = `${p.count} cross edges`; g.appendChild(s2);
      g.addEventListener('click', () => { state.focus = null; state.selection = null; render(); });
      svg.appendChild(g);
    } else {
      const m = p.m;
      const merged = state.merged.nodes.get(m.id);
      const annotated = state.annIndex.has(`node:${m.id}`);
      const g = svgEl('g', {
        class: 'gnode kind-' + m.kind + (nodeDimmed(merged || m) ? ' dimmed' : '')
          + (state.selection && state.selection.type === 'node' && state.selection.id === m.id ? ' selected' : ''),
        transform: `translate(${p.x},${p.y})`,
      });
      g.appendChild(svgEl('rect', { width: NODE_W, height: NODE_H, rx: 5 }));
      const t = svgEl('text', { x: 8, y: 13.5 }); t.textContent = truncate(m.path.split('/').pop(), 24); g.appendChild(t);
      const s2 = svgEl('text', { x: 8, y: 25, class: 'sub' }); s2.textContent = truncate(m.path, 30); g.appendChild(s2);
      if (annotated) g.appendChild(svgEl('circle', { cx: NODE_W - 9, cy: 9, r: 3.5, class: 'ann-dot' }));
      g.addEventListener('click', () => nodeClicked({ id: m.id, kind: m.kind, label: m.path, memberCount: 1, members: [m.id], walked_by: (merged && merged.walked_by) || [], annotated, internalEdgeCount: 0, why: (merged && merged.why) || null, path: m.path, cite: m.cite }));
      g.addEventListener('mousemove', (ev) => showNodeTip(ev, { label: m.path, why: (merged && merged.why) || null, kind: m.kind, memberCount: 1 }));
      g.addEventListener('mouseleave', hideTip);
      svg.appendChild(g);
    }
  }
  host.appendChild(svg);
}

// ---- procedure view (third view: the owner's plain-language ordered walk) -------
// Step titles are PLAIN STAGE NAMES (owner ruling 2026-07-16: no file paths in
// this view — paths stay in the detail panel and the other two views).
function procStepHtml(s, i) {
  const anns = state.annIndex.get(`node:${s.id}`) || [];
  const copyHtml = s.copy && s.copy.text
    ? `<div class="proc-copy">${esc(s.copy.text)}</div>`
      + (s.copy.cites && s.copy.cites.length
        ? `<div class="proc-cite">${s.copy.cites.map((c) => esc(c.path) + (c.lines ? ':' + esc(c.lines) : '')).join(' · ')}</div>` : '')
    : '<div class="proc-copy not-doc">plain-language copy not yet verified</div>';
  const badges = [];
  if (s.badges && s.badges.substrate) badges.push(`<span class="wb-chip proc-substrate">${esc(String(s.badges.substrate))}</span>`);
  if (s.badges && s.badges.receipt_write) badges.push(`<span class="wb-chip proc-receipt">writes receipt block: ${esc(String(s.badges.receipt_write))}</span>`);
  return `<div class="proc-step" data-id="${esc(s.id)}">
    <div class="proc-num">${i + 1}</div>
    <div class="proc-body">
      <div class="proc-title">${esc(s.name)}${s.known ? '' : ` <span class="ev-chip ev-STALE">${s.enrichmentOnly ? 'not in base graph · enrichment-sourced' : 'not in base graph'}</span>`}${anns.length ? ` <span class="proc-ann">● ${anns.length}</span>` : ''}</div>
      ${copyHtml}
      ${s.why && s.why.text ? `<div class="proc-why"><b>why</b> ${esc(s.why.text)}</div>` : ''}
      ${badges.length ? `<div class="proc-badges">${badges.join('')}</div>` : ''}
      <div class="proc-links">
        <button class="btn ghost" data-goto="graph">view in graph</button>
        <button class="btn ghost" data-goto="matrix">view in matrix</button>
        <button class="btn human" data-goto="comment">comment / question</button>
      </div>
    </div>
  </div>`;
}

/** Select a procedure step's node in the side panel (same annotation store —
 *  comments key on the node id and carry across all three views). */
function procSelect(id) {
  const mn = state.merged.nodes.get(id);
  state.selection = {
    type: 'node', id,
    node: {
      id, kind: mn ? mn.kind : 'stage', label: id.replace(/^stage:/, ''),
      memberCount: 1, members: [id], walked_by: mn ? mn.walked_by : [],
      annotated: state.annIndex.has(`node:${id}`), internalEdgeCount: 0,
      why: mn ? mn.why : null, copy: mn ? mn.copy : null,
      path: mn ? mn.path : null, cite: mn ? mn.cite : null,
    },
  };
  renderPanel();
}

/** Jump from a procedure step to the same node in graph/matrix (stage nodes are
 *  individual from the 'stage' level up, so subsystem level hops to stage). */
function gotoNode(id, view) {
  if (state.level === 'subsystem') {
    state.level = 'stage';
    for (const x of $('#level-seg').children) x.classList.toggle('on', x.dataset.level === 'stage');
  }
  state.view = view;
  for (const x of $('#view-seg').children) x.classList.toggle('on', x.dataset.view === view);
  state.focus = null;
  procSelect(id);
  render();
}

function renderProcedure() {
  const host = $('#procedure-view');
  host.innerHTML = '';
  const walk = procedureWalk(state.merged, {
    fileType: state.fileType,
    enrichmentNodes: state.enrichment && state.enrichment.nodes ? state.enrichment.nodes : null,
  });
  const wrap = document.createElement('div');
  wrap.id = 'proc-wrap';
  let html = `<div class="proc-intro">Ordered walk of the pipeline, driven by stage-order edges replayed from banked
    receipts (the cite under each chain header names the receipt). Steps link back to the same node in the graph and
    matrix views; comments carry across all three by node id.</div>`;
  if (!walk.chains.length) {
    html += `<div class="proc-note">No stage-order chain ${state.fileType ? `carries the tag ${esc(state.fileType)}` : 'exists in this checkout'} —
      stage order comes from receipt walks (enrichment lane).${walk.skippedTags.length ? ` Walks exist for: ${walk.skippedTags.map(esc).join(', ')}.` : ''}</div>`;
  } else if (walk.skippedTags.length) {
    html += `<div class="proc-note">file-type filter active — walks hidden: ${walk.skippedTags.map(esc).join(', ')}</div>`;
  }
  for (const chain of walk.chains) {
    html += `<div class="proc-chain">
      <div class="proc-chain-h">walked by: <b>${esc(chain.tag)}</b> · ${chain.steps.length} step(s)</div>
      <div class="proc-cite">walk replayed from: ${chain.cites.map(esc).join(' · ') || 'no receipt cite recorded'}</div>
      ${chain.note ? `<div class="proc-note warn">${esc(chain.note)}</div>` : ''}
      ${chain.steps.map((s, i) => procStepHtml(s, i)).join('')}
    </div>`;
  }
  html += `<div class="proc-foot">
    <div class="proc-chain-h">stages not yet observed in a receipt walk (${walk.unwalked.length})</div>
    ${walk.unwalked.length
      ? walk.unwalked.map((id) => `<span class="wb-chip proc-unwalked" data-id="${esc(id)}">${esc(id.replace(/^stage:/, ''))}</span>`).join('')
      : '<span class="not-doc">none — every stage node appears in at least one walk</span>'}
  </div>`;
  wrap.innerHTML = html;
  wrap.querySelectorAll('.proc-step').forEach((el) => {
    el.querySelector('.proc-title').addEventListener('click', () => procSelect(el.dataset.id));
    el.querySelector('[data-goto="graph"]').addEventListener('click', () => gotoNode(el.dataset.id, 'graph'));
    el.querySelector('[data-goto="matrix"]').addEventListener('click', () => gotoNode(el.dataset.id, 'matrix'));
    el.querySelector('[data-goto="comment"]').addEventListener('click', () => procSelect(el.dataset.id));
  });
  wrap.querySelectorAll('.proc-unwalked').forEach((el) => el.addEventListener('click', () => procSelect(el.dataset.id)));
  host.appendChild(wrap);
}

// ============================================================================
// CURATED STEP-MAP VIEW (task #11) — the FOURTH view. Renders the ONE committed
// steps_map.json TWO ways from a shared toolbar: a numbered step-by-step walk
// (default) and a procedure-map graph. Comments key on the STEP id (node:step:*)
// so they carry across every view. Prose is the map's OWN — the DRAFT copy
// fragments in test_results/dag_copy_fragments are deliberately NOT rendered
// (verification wave pending). Honest states: kind/observed badges, RULED flags
// as owner-provenance notes, unresolved branch/converge targets never fabricated.
// ============================================================================
const STEP_NODE_W = 158, STEP_NODE_H = 30, STEP_DETAIL_H = 60, STEP_GMARGIN = 50;
const STEP_REL_STYLE = {
  contains: { color: '#454f66', width: 1, dash: '2 4', opacity: 0.55 },  // major→sub clustering
  branch:   { color: '#4cc2ff', width: 1.7, dash: null, opacity: 0.9 },   // a decision branch
  converge: { color: '#8fa0bd', width: 1.5, dash: null, opacity: 0.85 },  // flow / re-convergence
};

// step-graph pins live in the shared state.pins map under a 'steps::' namespace,
// distinct from the dag graph's '<layout>::<level>::' keys (no collision).
function stepPinKey(id) { return `steps::${id}`; }
function stepIsPinned(id) { return state.pins.has(stepPinKey(id)); }
function stepSetPin(id, x, y) { state.pins.set(stepPinKey(id), { x, y }); savePins(); }
function stepClearPin(id) { state.pins.delete(stepPinKey(id)); savePins(); }
function stepPinsFixedMap(nodes) {
  const m = new Map();
  for (const n of nodes) { const p = state.pins.get(stepPinKey(n.id)); if (p) m.set(n.id, p); }
  return m;
}
function stepPinnedVisibleIds() {
  const out = [];
  for (const k of state.pins.keys()) if (k.startsWith('steps::')) out.push(k.slice(7));
  return out;
}

function renderStepsView() {
  const host = $('#steps-view');
  host.innerHTML = '';
  if (!state.stepsMap || !Array.isArray(state.stepsMap.steps) || !state.stepsMap.steps.length) {
    host.innerHTML = `<div class="steps-toolbar"></div>`
      + `<div id="steps-content" class="mode-list"><div class="proc-note warn" style="padding:16px 22px">`
      + `The curated step map (<code>tools/dag/steps/steps_map.json</code>) is not present in this checkout — nothing to render. (Honest absence, LAW 3 — not an error.)</div></div>`;
    return;
  }
  state._stepById = new Map(state.stepsMap.steps.map((s) => [s.id, s]));
  host.appendChild(buildStepsToolbar());
  const content = document.createElement('div');
  content.id = 'steps-content';
  content.className = state.stepsMode === 'graph' ? 'mode-graph' : 'mode-list';
  host.appendChild(content);
  if (state.stepsMode === 'graph') renderStepsGraph(content);
  else renderStepsList(content);
}

function buildStepsToolbar() {
  const meta = buildStepTree(state.stepsMap).meta;
  const fts = presentFileTypeTags(state.stepsMap);
  const el = document.createElement('div');
  el.className = 'steps-toolbar';
  el.innerHTML = `
    <div class="st-row">
      <span class="lbl">render</span>
      <div class="seg" id="steps-mode-seg">
        <button data-mode="list" class="${state.stepsMode === 'list' ? 'on' : ''}">step-by-step</button>
        <button data-mode="graph" class="${state.stepsMode === 'graph' ? 'on' : ''}">procedure map</button>
      </div>
      <span class="lbl">file type</span>
      <div class="chip-row" id="steps-ft">
        ${fts.map((t) => `<button class="ftchip ${state.stepFileType === t ? 'on' : ''}" data-ft="${esc(t)}" title="dim steps NOT tagged ${esc(t)} (one flow, never a parallel chain)">${esc(t)}</button>`).join('')}
      </div>
      <span class="st-meta">${meta.major_count} majors · ${meta.sub_count} subs · map v${esc(meta.map_version || '?')} · schema ${esc(meta.schema_version || '?')}</span>
    </div>
    <div class="st-note">Procedure (curated map) — the curated <code>steps_map.json</code> walk (judgment-derived, owner-rulable data). One unified flow; a file-type tag DIMS non-matching steps, never a parallel per-type chain. Prose is the map's own; DRAFT copy fragments are not rendered (verification pending).${state.stepsMode === 'graph' ? ' <span class="st-legend"><span class="lg contains">contains</span> <span class="lg branch">branch</span> <span class="lg converge">converge / flow</span></span>' : ''}</div>`;
  el.querySelector('#steps-mode-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.stepsMode = b.dataset.mode; localStorage.setItem('dag_steps_mode', state.stepsMode);
    state.stepVbKey = null; render();
  });
  el.querySelector('#steps-ft').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.stepFileType = state.stepFileType === b.dataset.ft ? null : b.dataset.ft;
    render();
  });
  return el;
}

// ---- step list mode: numbered nested walk (majors → subs → deeper) --------------
function stepCardHtml(step, num, depth) {
  const b = stepBadges(step);
  const anns = state.annIndex.get(`node:${step.id}`) || [];
  const dim = state.stepFileType && !stepMatchesFileType(step, state.stepFileType);
  const selected = state.selection && state.selection.type === 'step' && state.selection.id === step.id;
  const byId = state._stepById || new Map();
  const title = (id) => (byId.has(id) ? byId.get(id).title : id);
  const badgeHtml = [
    b.kind ? `<span class="step-badge sb-kind">${esc(b.kind)}</span>` : '',
    b.observed ? `<span class="step-badge sb-obs sb-${esc(b.observed)}">${esc(b.observed)}</span>` : '',
    ...b.fileTypeTags.map((t) => `<span class="step-badge sb-ft">${esc(t)}</span>`),
    ...b.markerTags.filter((t) => t !== b.kind).map((t) => `<span class="step-badge sb-tag">${esc(t)}</span>`),
  ].join('');
  const flow = [];
  if (step.branches_to && step.branches_to.length) {
    flow.push(`<div class="step-flow"><span class="sf-lbl sf-branch">branches →</span> ${step.branches_to.map((id) => `<span class="sf-tgt" data-jump-step="${esc(id)}">${esc(title(id))}</span>`).join('<span class="sf-sep">·</span>')}</div>`);
  }
  if (step.converges_to) {
    flow.push(`<div class="step-flow"><span class="sf-lbl sf-converge">converges →</span> <span class="sf-tgt" data-jump-step="${esc(step.converges_to)}">${esc(title(step.converges_to))}</span></div>`);
  }
  const vis = step.visible_at_this_point || [];
  const flags = stepFlags(step);
  const flagHtml = flags.map((f) => `<details class="step-flag ${f.needsRuling ? 'flag-needs' : 'flag-ruled'}">
      <summary><span class="flag-kind">${esc(f.kind)}</span>${f.code ? ` <span class="flag-code">${esc(f.code)}</span>` : ''}${f.date ? ` <span class="flag-date">${esc(f.date)}</span>` : ''}<span class="flag-peek">${esc(firstWordsShort(f.ruling))}</span></summary>
      <div class="flag-ruling">${esc(f.ruling)}</div>
      ${f.origQuestion ? `<div class="flag-origq"><b>original question</b> ${esc(f.origQuestion)}</div>` : ''}
    </details>`).join('');
  const anchors = (step.anchors || []).map((a) => {
    const r = state.merged && state.merged.nodes && state.merged.nodes.has(a);
    return r ? `<button class="step-jump" data-jump="${esc(a)}" title="jump to this node in the graph">${esc(a)}</button>` : `<span class="step-plain">${esc(a)}</span>`;
  }).join(' ');
  const cites = (step.cites || []).map((c) => {
    const p = c.path || ''; const lab = p + (c.lines ? `:${c.lines}` : '');
    const r = state.merged && state.merged.nodes && state.merged.nodes.has(p);
    return r ? `<button class="step-jump" data-jump="${esc(p)}" title="jump to this node in the graph">${esc(lab)}</button>` : `<span class="step-plain">${esc(lab)}</span>`;
  }).join(' ');
  return `<div class="step-card depth-${depth}${dim ? ' dimmed' : ''}${selected ? ' selected' : ''}" data-id="${esc(step.id)}">
    <div class="step-head">
      <span class="step-num">${esc(num)}</span>
      <span class="step-title" data-id="${esc(step.id)}">${esc(step.title)}</span>
      ${anns.length ? `<span class="step-anncount" title="${anns.length} comment(s)/question(s)">● ${anns.length}</span>` : ''}
    </div>
    ${badgeHtml ? `<div class="step-badges">${badgeHtml}</div>` : ''}
    ${flow.join('')}
    <div class="step-prose">${esc(step.narrative || '') || '<span class="not-doc">no prose recorded</span>'}</div>
    ${vis.length ? `<div class="step-visible"><span class="sv-lbl">visible here</span> ${vis.map((v) => `<span class="sv-chip">${esc(v)}</span>`).join('')}</div>` : ''}
    ${anchors ? `<div class="step-refs"><span class="sr-lbl">anchors</span> ${anchors}</div>` : ''}
    ${cites ? `<div class="step-refs"><span class="sr-lbl">cites</span> ${cites}</div>` : ''}
    ${flagHtml ? `<div class="step-flags">${flagHtml}</div>` : ''}
    <div class="step-actions"><button class="btn human step-comment" data-id="${esc(step.id)}">comment / question</button></div>
  </div>`;
}

function firstWordsShort(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length > 52 ? t.slice(0, 51) + '…' : t;
}

function stepBlockHtml(node, num, depth) {
  let html = stepCardHtml(node, num, depth);
  if (node.subs && node.subs.length) {
    html += `<div class="step-subs">${node.subs.map((s) => stepBlockHtml(s, `${num}.${s.order}`, depth + 1)).join('')}</div>`;
  }
  return html;
}

function renderStepsList(content) {
  const tree = buildStepTree(state.stepsMap);
  const wrap = document.createElement('div');
  wrap.id = 'steps-wrap';
  wrap.innerHTML = tree.majors.map((mj) => stepBlockHtml(mj, String(mj.order), 0)).join('')
    || '<div class="not-doc" style="padding:16px 22px">the map has no top-level steps</div>';
  wrap.querySelectorAll('.step-title, .step-comment').forEach((el) => el.addEventListener('click', (ev) => { ev.stopPropagation(); selectStep(el.dataset.id); }));
  wrap.querySelectorAll('[data-jump]').forEach((el) => el.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToDagNode(el.dataset.jump); }));
  wrap.querySelectorAll('[data-jump-step]').forEach((el) => el.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToStep(el.dataset.jumpStep); }));
  content.appendChild(wrap);
}

// ---- step selection + cross-view jumps ------------------------------------------
function selectStep(id) {
  const step = state._stepById ? state._stepById.get(id) : null;
  if (!step) return;
  state.selection = { type: 'step', id, step };
  state.pendingDrawn = null;
  render();
}
/** Jump to another curated step (branch/converge target) — select + scroll into
 *  view in the list; in graph mode just selects (the node highlights in place). */
function jumpToStep(id) {
  selectStep(id);
  if (state.view === 'steps' && state.stepsMode === 'list') {
    const el = document.querySelector(`.step-card[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
/** Jump from a step anchor/cite to that node in the main graph view (only when the
 *  id resolves to a real dag_base node — honest: unresolvable refs render plain). */
function jumpToDagNode(id) {
  if (!state.merged || !state.merged.nodes || !state.merged.nodes.has(id)) return;
  gotoNode(id, 'graph');
}

// ---- step graph mode: procedure map on the force renderer ------------------------
function applyStepVB(svg) {
  const vb = state.stepVb;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const k = (svg.clientWidth || Number(svg.getAttribute('width'))) / vb.w;
  svg.classList.toggle('sem-detail', k >= 1.05);
}
function zoomStep(svg, factor, clientX, clientY, worldW) {
  const vb = state.stepVb;
  const r = svg.getBoundingClientRect();
  const nw = Math.min(worldW * 6 + 4000, Math.max(120, vb.w * factor));
  const s = nw / vb.w;
  const mx = vb.x + ((clientX - r.left) / r.width) * vb.w;
  const my = vb.y + ((clientY - r.top) / r.height) * vb.h;
  vb.x = mx - (mx - vb.x) * s; vb.y = my - (my - vb.y) * s; vb.w = nw; vb.h = vb.h * s;
  applyStepVB(svg);
}
function screenToWorldStep(svg, clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return { x: state.stepVb.x + ((clientX - r.left) / r.width) * state.stepVb.w, y: state.stepVb.y + ((clientY - r.top) / r.height) * state.stepVb.h };
}
function stepPaintLive() {
  const L = state._stepLive; if (!L) return;
  for (const [id, grp] of L.nodeEls) { const s = L.sim.get(id); if (s) grp.setAttribute('transform', `translate(${s.x - STEP_NODE_W / 2},${s.y - STEP_NODE_H / 2})`); }
  for (const e of L.edgeEls) { const a = L.sim.get(e.from), b = L.sim.get(e.to); if (!a || !b) continue; e.path.setAttribute('d', `M ${a.x} ${a.y} L ${b.x} ${b.y}`); }
}
function stepDragRelax(id, wx, wy) {
  const L = state._stepLive; if (!L || !L.sim.has(id)) return;
  L.sim.get(id).x = wx; L.sim.get(id).y = wy;
  const fixed = new Set([id, ...stepPinnedVisibleIds().filter((n) => L.sim.has(n))]);
  for (let i = 0; i < 6; i++) forceStep(L.sim, L.ids, L.springs, { k: L.kk, temp: L.kk * 0.14, gravity: 0.03, fixed });
  stepPaintLive();
}
function stepEndDrag(id) {
  const L = state._stepLive; if (!L || !L.sim.has(id)) { state._stepDragging = null; return; }
  const s = L.sim.get(id); stepSetPin(id, s.x, s.y); state._stepDragging = null; render();
}
function showStepTip(ev, n) {
  const st = state._stepById && state._stepById.get(n.id);
  showTip(ev, `<div class="t-title">${esc(n.title)}</div>`
    + `<div class="t-meta">${esc(n.isMajor ? 'major' : 'sub')} · ${esc(n.kind)}${n.tags && n.tags.length ? ' · ' + esc(n.tags.join(', ')) : ''}</div>`
    + (st && st.narrative ? `<div class="t-why">${esc(st.narrative.slice(0, 180))}${st.narrative.length > 180 ? '…' : ''}</div>` : ''));
}

function renderStepsGraph(content) {
  content.innerHTML = '';
  const g = stepGraph(state.stepsMap);
  const nodes = g.nodes, edges = g.edges;
  if (!nodes.length) { content.innerHTML = '<div id="loading">no steps to render</div>'; return; }

  const center = new Map();
  const fpos = forceLayout(nodes, edges, { fixed: stepPinsFixedMap(nodes) });
  for (const [id, p] of fpos) center.set(id, { cx: p.x, cy: p.y });

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of center.values()) { minX = Math.min(minX, c.cx); maxX = Math.max(maxX, c.cx); minY = Math.min(minY, c.cy); maxY = Math.max(maxY, c.cy); }
  minX -= STEP_NODE_W / 2 + STEP_GMARGIN; maxX += STEP_NODE_W / 2 + STEP_GMARGIN;
  minY -= STEP_NODE_H / 2 + STEP_GMARGIN; maxY += STEP_NODE_H / 2 + STEP_GMARGIN;
  const bbox = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };

  const pos = new Map();
  for (const n of nodes) { const c = center.get(n.id); if (!c) continue; pos.set(n.id, { x: c.cx - STEP_NODE_W / 2, y: c.cy - STEP_NODE_H / 2, cx: c.cx, cy: c.cy, n }); }

  const rect = content.getBoundingClientRect();
  const cw = Math.floor(rect.width >= 50 ? rect.width : Math.max(400, window.innerWidth - 610));
  const ch = Math.floor(rect.height >= 50 ? rect.height : Math.max(320, window.innerHeight - 170));
  const svg = svgEl('svg', { id: 'steps-svg', width: cw, height: ch, preserveAspectRatio: 'xMidYMid meet' });
  if (!state.stepVb || state.stepVbKey !== 'steps') { state.stepVb = fitBox(bbox, cw, ch); state.stepVbKey = 'steps'; }

  const sim = new Map();
  for (const [id, c] of center) sim.set(id, { x: c.cx, y: c.cy });
  const side = Math.max(600, Math.sqrt(nodes.length) * 170);
  state._stepLive = { sim, ids: [...center.keys()].sort(), springs: springPairs(edges, new Set(center.keys())), kk: Math.max(70, Math.sqrt((side * side) / nodes.length)), nodeEls: new Map(), edgeEls: [] };

  const eg = svgEl('g'); svg.appendChild(eg);
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
    const st = STEP_REL_STYLE[e.rel] || STEP_REL_STYLE.converge;
    const dim = state.stepFileType && (!stepMatchesFileType(a.n, state.stepFileType) || !stepMatchesFileType(b.n, state.stepFileType));
    const path = svgEl('path', { d: `M ${a.cx} ${a.cy} L ${b.cx} ${b.cy}`, class: 'sedge' + (dim ? ' dimmed' : ''), stroke: st.color, 'stroke-width': st.width, 'stroke-opacity': st.opacity, fill: 'none' });
    if (st.dash) path.setAttribute('stroke-dasharray', st.dash);
    eg.appendChild(path);
    state._stepLive.edgeEls.push({ path, from: e.from, to: e.to });
  }

  for (const { x: nx, y: ny, n } of pos.values()) {
    const dim = state.stepFileType && !stepMatchesFileType(n, state.stepFileType);
    const selected = state.selection && state.selection.type === 'step' && state.selection.id === n.id;
    const anns = state.annIndex.get(`node:${n.id}`) || [];
    const grp = svgEl('g', { class: 'snode ' + (n.isMajor ? 'snode-major' : 'snode-sub') + (dim ? ' dimmed' : '') + (selected ? ' selected' : ''), transform: `translate(${nx},${ny})` });
    grp.appendChild(svgEl('rect', { class: 'snd-compact', width: STEP_NODE_W, height: STEP_NODE_H, rx: n.isMajor ? 6 : 4 }));
    grp.appendChild(svgEl('rect', { class: 'snd-detail', width: STEP_NODE_W, height: STEP_DETAIL_H, rx: n.isMajor ? 6 : 4 }));
    const t = svgEl('text', { x: 9, y: 13.5, class: 'snd-title' }); t.textContent = truncate(n.title, 26); grp.appendChild(t);
    const sub = svgEl('text', { x: 9, y: 24.5, class: 'snd-sub' }); sub.textContent = (n.isMajor ? 'major' : 'sub') + ' · ' + n.kind; grp.appendChild(sub);
    const st = state._stepById && state._stepById.get(n.id);
    const prose = st && st.narrative ? st.narrative : '';
    const l1 = svgEl('text', { x: 9, y: 40, class: 'snd-detail-txt' + (prose ? '' : ' faint') }); l1.textContent = prose ? prose.slice(0, 40) : 'no prose'; grp.appendChild(l1);
    if (prose && prose.length > 40) { const l2 = svgEl('text', { x: 9, y: 51, class: 'snd-detail-txt' }); l2.textContent = prose.slice(40, 80) + (prose.length > 80 ? '…' : ''); grp.appendChild(l2); }
    if (anns.length) grp.appendChild(svgEl('circle', { cx: STEP_NODE_W - 9, cy: 9, r: 3.5, class: 'ann-dot' }));
    if (stepIsPinned(n.id)) {
      grp.classList.add('pinned');
      const pd = svgEl('circle', { cx: 7, cy: 7, r: 4, class: 'pin-dot' });
      const ti = svgEl('title'); ti.textContent = 'pinned — click to release'; pd.appendChild(ti);
      pd.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      pd.addEventListener('click', (ev) => { ev.stopPropagation(); stepClearPin(n.id); render(); });
      grp.appendChild(pd);
    }
    grp.addEventListener('mousemove', (ev) => { if (!state._stepDragging) showStepTip(ev, n); });
    grp.addEventListener('mouseleave', hideTip);
    let down = false, moved = false, sx = 0, sy = 0;
    grp.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      try { grp.setPointerCapture(ev.pointerId); } catch { /* older engines */ }
      down = true; moved = false; sx = ev.clientX; sy = ev.clientY; state._stepDragging = null;
    });
    grp.addEventListener('pointermove', (ev) => {
      if (!down) return;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true; state._stepDragging = n.id; hideTip();
      const w = screenToWorldStep(svg, ev.clientX, ev.clientY);
      stepDragRelax(n.id, w.x, w.y);
    });
    grp.addEventListener('pointerup', (ev) => {
      if (!down) return;
      down = false;
      try { grp.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (moved) stepEndDrag(n.id); else selectStep(n.id);
    });
    svg.appendChild(grp);
    state._stepLive.nodeEls.set(n.id, grp);
  }

  svg.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomStep(svg, Math.exp(ev.deltaY * 0.0012), ev.clientX, ev.clientY, bbox.w); }, { passive: false });
  let pan = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg || ev.button !== 0) return;
    svg.setPointerCapture(ev.pointerId);
    pan = { sx: ev.clientX, sy: ev.clientY, vx: state.stepVb.x, vy: state.stepVb.y, vw: state.stepVb.w, vh: state.stepVb.h };
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pan) return;
    const r = svg.getBoundingClientRect();
    state.stepVb.x = pan.vx - ((ev.clientX - pan.sx) / r.width) * pan.vw;
    state.stepVb.y = pan.vy - ((ev.clientY - pan.sy) / r.height) * pan.vh;
    applyStepVB(svg);
  });
  const endPan = () => { pan = null; svg.classList.remove('panning'); };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  content.appendChild(svg);
  applyStepVB(svg);

  const ctl = document.createElement('div');
  ctl.className = 'zoom-ctl';
  ctl.innerHTML = '<button data-z="in" title="zoom in">+</button><button data-z="out" title="zoom out">−</button><button data-z="fit" title="fit all">fit</button>';
  ctl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const r = svg.getBoundingClientRect();
    if (b.dataset.z === 'fit') { state.stepVb = fitBox(bbox, cw, ch); applyStepVB(svg); return; }
    zoomStep(svg, b.dataset.z === 'in' ? 1 / 1.4 : 1.4, r.left + r.width / 2, r.top + r.height / 2, bbox.w);
  });
  content.appendChild(ctl);
}

// ---- matrix view ------------------------------------------------------------------------
const CELL = 16, LABEL_W = 240, TOP_H = 170;

function renderMatrix(nodes, edges) {
  const wrap = $('#matrix-wrap');
  wrap.innerHTML = '';
  const sorted = [...nodes].sort((a, b) => colOf(a) - colOf(b) || a.label.localeCompare(b.label));
  const idx = new Map(sorted.map((n, i) => [n.id, i]));
  const N = sorted.length;
  const w = LABEL_W + N * CELL + 20, h = TOP_H + N * CELL + 20;
  const svg = svgEl('svg', { width: w, height: h });

  // grid + block outlines per column group
  const gx = (i) => LABEL_W + i * CELL, gy = (i) => TOP_H + i * CELL;
  for (let i = 0; i <= N; i++) {
    svg.appendChild(svgEl('line', { x1: gx(0), y1: gy(i), x2: gx(N), y2: gy(i), class: 'mx-grid' }));
    svg.appendChild(svgEl('line', { x1: gx(i), y1: gy(0), x2: gx(i), y2: gy(N), class: 'mx-grid' }));
  }
  let blockStart = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || colOf(sorted[i]) !== colOf(sorted[blockStart])) {
      svg.appendChild(svgEl('rect', { x: gx(blockStart), y: gy(blockStart), width: (i - blockStart) * CELL, height: (i - blockStart) * CELL, class: 'mx-block' }));
      blockStart = i;
    }
  }

  // empty-cell click catcher (UNDER the edge cells): clicking an intersection
  // with no edge opens the proposed-connection annotation form — absence made
  // annotatable. Diagonal clicks select the node.
  const catcher = svgEl('rect', { x: gx(0), y: gy(0), width: N * CELL, height: N * CELL, fill: 'transparent', class: 'mx-catcher' });
  catcher.addEventListener('click', (ev) => {
    const r = svg.getBoundingClientRect(); // matrix svg has no viewBox: units == px
    const col = Math.floor((ev.clientX - r.left - LABEL_W) / CELL);
    const row = Math.floor((ev.clientY - r.top - TOP_H) / CELL);
    if (row < 0 || col < 0 || row >= N || col >= N) return;
    if (row === col) { nodeClicked(sorted[row]); return; }
    selectPair({ from: sorted[row].id, to: sorted[col].id, count: 0, annotations: [] });
  });
  svg.appendChild(catcher);

  // diagonal: internal edge counts (honest — within-group edges are counted, not drawn)
  sorted.forEach((n, i) => {
    if (!n.internalEdgeCount) return;
    const r = svgEl('rect', { x: gx(i) + 1, y: gy(i) + 1, width: CELL - 2, height: CELL - 2, class: 'mx-diag' });
    const t = svgEl('title'); t.textContent = `${n.label}: ${n.internalEdgeCount} internal edges (within-group, not drawn)`;
    r.appendChild(t);
    r.addEventListener('click', () => nodeClicked(n));
    svg.appendChild(r);
  });

  // labels
  sorted.forEach((n, i) => {
    const dim = nodeDimmed(n);
    const rl = svgEl('text', { x: LABEL_W - 8, y: gy(i) + CELL - 4, class: 'mx-lab' + (dim ? ' dimmed' : ''), 'text-anchor': 'end' });
    rl.textContent = truncate(n.label, 32) + (n.annotated ? ' ●' : '');
    if (n.annotated) rl.setAttribute('fill', '#f778ba');
    rl.addEventListener('click', () => nodeClicked(n));
    rl.addEventListener('mousemove', (ev) => showNodeTip(ev, n));
    rl.addEventListener('mouseleave', hideTip);
    svg.appendChild(rl);
    const cl = svgEl('text', {
      x: 0, y: 0, class: 'mx-lab' + (dim ? ' dimmed' : ''),
      transform: `translate(${gx(i) + CELL - 4},${TOP_H - 6}) rotate(-58)`,
    });
    cl.textContent = truncate(n.label, 26);
    cl.addEventListener('click', () => nodeClicked(n));
    svg.appendChild(cl);
  });

  // cells: row = from, col = to
  for (const e of edges) {
    const r = idx.get(e.from), c = idx.get(e.to);
    if (r === undefined || c === undefined) continue;
    const dom = dominantLayer(e);
    const tier = renderTier(e);
    let fill = LAYER_COLOR[dom] || '#8fa0bd';
    let opacity = tier === 'verified' ? 0.92 : 0.32;                // solid vs ghosted (spec)
    if (tier === 'mechanical' && !state.mechDashed) { fill = MECH_COLOR; opacity = 0.5; } // muted-solid tier (owner-ratified)
    if (tier === 'refuted') { fill = EV_COLOR.REFUTED; opacity = 0.65; }
    if (tier === 'stale') { fill = EV_COLOR.STALE; opacity = 0.7; }
    const dim = nodeDimmed(sorted[r]) || nodeDimmed(sorted[c]);
    const selected = state.selection && state.selection.type === 'edge'
      && state.selection.agg.from === e.from && state.selection.agg.to === e.to;
    const cell = svgEl('rect', {
      x: gx(c) + 1, y: gy(r) + 1, width: CELL - 2, height: CELL - 2,
      fill, 'fill-opacity': opacity,
      class: 'mx-cell' + (dim ? ' dimmed' : '') + (selected ? ' selected' : ''),
    });
    cell.addEventListener('click', () => selectEdge(e));
    cell.addEventListener('mousemove', (ev) => showEdgeTip(ev, e));
    cell.addEventListener('mouseleave', hideTip);
    svg.appendChild(cell);
    if (e.verification === 'REFUTED') {
      svg.appendChild(svgEl('line', { x1: gx(c) + 3, y1: gy(r) + 3, x2: gx(c) + CELL - 3, y2: gy(r) + CELL - 3, class: 'mx-refx' }));
      svg.appendChild(svgEl('line', { x1: gx(c) + CELL - 3, y1: gy(r) + 3, x2: gx(c) + 3, y2: gy(r) + CELL - 3, class: 'mx-refx' }));
    }
    if (Object.keys(e.types).length > 1) {
      svg.appendChild(svgEl('path', { d: `M ${gx(c) + CELL - 6} ${gy(r) + 1} L ${gx(c) + CELL - 1} ${gy(r) + 1} L ${gx(c) + CELL - 1} ${gy(r) + 6} Z`, fill: '#dce5f7', 'fill-opacity': 0.8, 'pointer-events': 'none' }));
    }
    if (e.annotated) {
      svg.appendChild(svgEl('circle', { cx: gx(c) + CELL - 4, cy: gy(r) + CELL - 4, r: 2.6, class: 'mx-ann' }));
    }
  }

  // proposed-connection ring badges (annotation layer): dot-badge the pair's
  // cell whether or not an extracted edge also lives there
  if (state.layers.has('annotation')) {
    for (const p of state._proposedPairs || []) {
      const r = idx.get(p.from), c = idx.get(p.to);
      if (r === undefined || c === undefined) continue;
      const ring = svgEl('circle', { cx: gx(c) + CELL / 2, cy: gy(r) + CELL / 2, r: 4.2, class: 'mx-proposed' });
      ring.addEventListener('click', () => selectPair(p));
      ring.addEventListener('mousemove', (ev) => showTip(ev,
        `<div class="t-title">${esc(p.from)} → ${esc(p.to)}</div>`
        + `<div class="t-meta">proposed connection (owner) · ${p.count} annotation(s)</div>`));
      ring.addEventListener('mouseleave', hideTip);
      svg.appendChild(ring);
    }
  }

  // axis note
  const note = svgEl('text', { x: 12, y: TOP_H - 6, class: 'colhdr' });
  note.textContent = 'row → col · click an EMPTY cell to propose a connection';
  svg.appendChild(note);
  wrap.appendChild(svg);
}

// ---- tooltip (WHY on hover — spec) -----------------------------------------------------------
function showTip(ev, html) {
  const tip = $('#tip');
  tip.innerHTML = html;
  tip.style.display = 'block';
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { $('#tip').style.display = 'none'; }

function whyHtml(why) {
  if (why && why.text) {
    const cites = (why.cites || []).map((c) => `${esc(c.path)}${c.lines ? ':' + esc(c.lines) : ''}`).join(' · ');
    return `<div class="t-why">${esc(why.text)}</div>` + (cites ? `<div class="t-meta">${cites}</div>` : '');
  }
  return `<div class="t-why t-notdoc">WHY: not yet documented</div>`; // LAW 3: explicit absent state, never invented text
}
function showNodeTip(ev, n) {
  showTip(ev, `<div class="t-title">${esc(n.label)}</div>`
    + `<div class="t-meta">${esc(n.kind || '')}${n.memberCount > 1 ? ` · ${n.memberCount} modules` : ''}</div>`
    + whyHtml(n.why));
}
function showEdgeTip(ev, e) {
  const types = Object.entries(e.types || {}).map(([t, n]) => `${t}×${n}`).join(' · ');
  const why = (e.constituents || []).map((c) => c.why).find(Boolean) || e.why || null;
  const tier = renderTier(e);
  showTip(ev, `<div class="t-title">${esc(e.from)} → ${esc(e.to)}</div>`
    + `<div class="t-meta">${esc(types)} · ${esc(e.verification)}${e.verifiedCount ? ` (${e.verifiedCount}/${e.count} verified)` : ''}${tier === 'mechanical' ? ' · mechanical (parser-derived, drift-gate-checked)' : ''}</div>`
    + whyHtml(why));
}

// ---- selection --------------------------------------------------------------------------------
function nodeClicked(n) {
  if (state.drawFrom && state.drawFrom !== n.id) {
    state.pendingDrawn = { from: state.drawFrom, to: n.id };
    state.drawFrom = null;
    renderPanel();
    return;
  }
  state.selection = { type: 'node', id: n.id, node: n };
  state.pendingDrawn = null;
  render();
}
function selectEdge(e) {
  state.selection = { type: 'edge', agg: e };
  state.pendingDrawn = null;
  render();
}
function selectPair(p) {
  state.selection = { type: 'pair', from: p.from, to: p.to };
  state.pendingDrawn = null;
  render();
}

// ---- side panel -------------------------------------------------------------------------------
function renderPanel() {
  const body = $('#panel-body');
  const empty = $('#panel-empty');
  if (!state.selection && !state.pendingDrawn) { body.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';

  if (state.pendingDrawn) {
    body.innerHTML = `
      <div class="p-h">draw edge</div>
      <div class="p-kind">owner-drawn · annotation layer</div>
      <div class="p-cite">${esc(state.pendingDrawn.from)} → ${esc(state.pendingDrawn.to)}</div>
      ${annFormHtml('drawn-edge')}`;
    wireAnnForm(body, { edge: { from: state.pendingDrawn.from, to: state.pendingDrawn.to, type: 'owner-drawn' } }, 'drawn-edge');
    return;
  }

  const sel = state.selection;
  if (sel.type === 'clockdrive') {
    // roadmap overlay entry — comments key on the entry id ({node:<id>}), the SAME
    // annotation store as every other view, so notes carry (LAW 3 honest-absent)
    const c = sel.entry;
    const target = { node: c.id };
    const anns = state.annIndex.get(annotationKeyFor(target)) || [];
    const statusClass = `cd-${c.status}` + (c.statusFlagged ? ' cd-flagged' : '');
    body.innerHTML = `
      <div class="p-h">${esc(c.title || c.id)}</div>
      <div class="p-kind cd-kind">clockdrive ${esc(c.kind)}${c.submitter_class ? ` · ${esc(c.submitter_class)}` : ''}</div>
      <div><span class="cd-status-chip ${statusClass}">${esc(c.status)}</span>${c.statusFlagged ? ' <span class="not-doc">source status not recognized → shown as pending</span>' : ''}</div>
      <div class="p-sec"><h3>raw status</h3>${c.raw_status ? `<div class="p-cite">${esc(c.raw_status)}</div>` : '<span class="not-doc">none recorded</span>'}</div>
      <div class="p-sec"><h3>detail</h3>${c.detail ? `<div class="p-why">${esc(c.detail)}</div>` : '<span class="not-doc">no detail recorded</span>'}</div>
      <div class="p-sec"><h3>source</h3>${c.source ? `<div class="p-cite">${esc(c.source)}</div>` : '<span class="not-doc">not recorded</span>'}</div>
      ${c.anchors && c.anchors.length ? `<div class="p-sec"><h3>anchors (${c.anchors.length})</h3>${c.anchors.map((a) => `<div class="p-cite">${esc(a)}</div>`).join('')}</div>` : ''}
      <div class="p-sec"><h3>comments &amp; questions (${anns.length})</h3>
        ${anns.map(annHtml).join('') || '<span class="not-doc">none yet</span>'}
        ${annFormHtml('comment', ['comment', 'question'])}</div>`;
    wireAnnForm(body, target, 'comment');
    return;
  }
  if (sel.type === 'step') {
    // curated step — comments key on the STEP id ({node:step:*}), the SAME store
    // as every other view, so notes carry across all four views (LAW 3 honest).
    const s = sel.step;
    const target = { node: s.id };
    const anns = state.annIndex.get(annotationKeyFor(target)) || [];
    const b = stepBadges(s);
    const byId = state._stepById || new Map();
    const title = (id) => (byId.has(id) ? byId.get(id).title : id);
    const flags = stepFlags(s);
    const jumpAnchor = (a) => (state.merged && state.merged.nodes && state.merged.nodes.has(a)
      ? `<div class="p-jump" data-jump="${esc(a)}">${esc(a)} <span class="p-jump-arrow">→ graph</span></div>`
      : `<div class="p-cite">${esc(a)}</div>`);
    body.innerHTML = `
      <div class="p-h">${esc(s.title)}</div>
      <div class="p-kind">curated step${s.kind ? ` · ${esc(s.kind)}` : ''}${s.observed ? ` · ${esc(s.observed)}` : ''}</div>
      <div class="p-cite">${esc(s.id)}</div>
      <div class="p-sec"><h3>what happens</h3><div class="p-why">${s.narrative ? esc(s.narrative) : '<span class="not-doc">no prose recorded</span>'}</div></div>
      ${(s.visible_at_this_point && s.visible_at_this_point.length) ? `<div class="p-sec"><h3>visible at this point</h3>${s.visible_at_this_point.map((v) => `<span class="wb-chip">${esc(v)}</span>`).join('')}</div>` : ''}
      <div class="p-sec"><h3>badges</h3>${[b.kind ? `<span class="wb-chip">kind: ${esc(b.kind)}</span>` : '', b.observed ? `<span class="wb-chip">observed: ${esc(b.observed)}</span>` : '', ...b.fileTypeTags.map((t) => `<span class="wb-chip">${esc(t)}</span>`), ...b.markerTags.filter((t) => t !== b.kind).map((t) => `<span class="wb-chip">${esc(t)}</span>`)].join('') || '<span class="not-doc">none</span>'}</div>
      ${(s.branches_to && s.branches_to.length) ? `<div class="p-sec"><h3>branches to</h3>${s.branches_to.map((id) => `<div class="p-jump" data-jump-step="${esc(id)}">${esc(title(id))}</div>`).join('')}</div>` : ''}
      ${s.converges_to ? `<div class="p-sec"><h3>converges to</h3><div class="p-jump" data-jump-step="${esc(s.converges_to)}">${esc(title(s.converges_to))}</div></div>` : ''}
      ${(s.anchors && s.anchors.length) ? `<div class="p-sec"><h3>anchors</h3>${s.anchors.map(jumpAnchor).join('')}</div>` : ''}
      ${(s.cites && s.cites.length) ? `<div class="p-sec"><h3>cites</h3>${s.cites.map((c) => { const p = c.path || ''; const lab = p + (c.lines ? `:${c.lines}` : ''); return (state.merged && state.merged.nodes && state.merged.nodes.has(p)) ? `<div class="p-jump" data-jump="${esc(p)}">${esc(lab)} <span class="p-jump-arrow">→ graph</span></div>` : `<div class="p-cite">${esc(lab)}</div>`; }).join('')}</div>` : ''}
      ${flags.length ? `<div class="p-sec"><h3>rulings &amp; flags (${flags.length})</h3>${flags.map((f) => `<div class="p-flag ${f.needsRuling ? 'flag-needs' : 'flag-ruled'}"><div class="pf-head"><span class="flag-kind">${esc(f.kind)}</span>${f.code ? ` <span class="flag-code">${esc(f.code)}</span>` : ''}${f.date ? ` <span class="flag-date">${esc(f.date)}</span>` : ''}</div><div class="flag-ruling">${esc(f.ruling)}</div>${f.origQuestion ? `<div class="flag-origq"><b>original question</b> ${esc(f.origQuestion)}</div>` : ''}</div>`).join('')}</div>` : ''}
      <div class="p-sec"><h3>comments &amp; questions (${anns.length})</h3>
        ${anns.map(annHtml).join('') || '<span class="not-doc">none yet</span>'}
        ${annFormHtml('comment', ['comment', 'question'])}</div>`;
    body.querySelectorAll('[data-jump]').forEach((el) => el.addEventListener('click', () => jumpToDagNode(el.dataset.jump)));
    body.querySelectorAll('[data-jump-step]').forEach((el) => el.addEventListener('click', () => jumpToStep(el.dataset.jumpStep)));
    wireAnnForm(body, target, 'comment');
    return;
  }
  if (sel.type === 'orphan') {
    // regen-drift orphan — target id vanished from the graph. Surfaced, never
    // dropped; shown read-only so the owner can re-read and re-target it.
    const o = sel.orphan;
    const full = (state.annotations || []).find((a) => a.id === o.id) || {};
    body.innerHTML = `
      <div class="p-h">orphan annotation</div>
      <div class="p-kind">${esc(o.kind)} · target no longer in graph</div>
      <div class="p-sec"><h3>unresolved target</h3><div class="p-cite">${esc(o.targetLabel)}</div>
        <div class="not-doc" style="margin-top:4px">${o.unresolved.length} id(s) do not resolve: ${o.unresolved.map(esc).join(', ')}</div></div>
      <div class="p-sec"><h3>text</h3><div class="p-why">${esc(full.text || o.firstWords || '(no text)')}</div></div>
      ${o.retargeted ? `<div class="p-sec"><h3>retarget note</h3><div class="p-cite">${esc(o.retargeted)}</div></div>` : ''}
      <div class="p-sec"><span class="not-doc">This annotation's target vanished from the graph (regen drift). It is surfaced here so it is never silently lost — re-target it by re-selecting the current node/edge and re-posting.</span></div>`;
    return;
  }
  if (sel.type === 'node') {
    const n = sel.node;
    const target = { node: n.id };
    const anns = state.annIndex.get(annotationKeyFor(target)) || [];
    body.innerHTML = `
      <div class="p-h">${esc(n.label)}</div>
      <div class="p-kind">${esc(n.kind)}${n.memberCount > 1 ? ` · ${n.memberCount} modules` : ''}</div>
      ${n.path ? `<div class="p-cite">${esc(n.cite || n.path)}</div>` : ''}
      <div class="p-sec"><h3>why</h3>${whyHtml(n.why).replace(/t-why/g, 'p-why').replace(/t-meta/g, 'p-why cites').replace(/t-notdoc/g, 'not-doc')}</div>
      <div class="p-sec"><h3>walked by</h3>${n.walked_by && n.walked_by.length ? n.walked_by.map((w) => `<span class="wb-chip">${esc(w)}</span>`).join('') : '<span class="not-doc">no file-type walk recorded (enrichment lane)</span>'}</div>
      ${n.badges ? `<div class="p-sec"><h3>badges</h3>${Object.entries(n.badges).map(([k, v]) => `<span class="wb-chip">${esc(k)}: ${esc(String(v))}</span>`).join('')}</div>` : ''}
      ${n.kind === 'subsystem' && !state.focus ? `<div class="p-sec"><button class="btn" id="focus-btn">focus: drill into members</button></div>` : ''}
      ${state._lastNodeIds && state._lastNodeIds.has(n.id) ? `<div class="p-sec"><button class="btn" id="iso-btn">${state.iso && state.iso.center === n.id ? 'exit isolation' : 'isolate: show only its connectivity'}</button></div>` : ''}
      ${state.layoutMode === 'force' && state.view === 'graph' && !state.focus && state._lastNodeIds && state._lastNodeIds.has(n.id) ? `<div class="p-sec"><button class="btn" id="pin-btn">${isPinned(n.id) ? 'unpin (let it float)' : 'pin here (sim skips it)'}</button></div>` : ''}
      ${n.members && n.members.length > 1 ? `<div class="p-sec"><h3>members (${n.members.length})</h3><div class="member-list">${n.members.slice(0, 400).map((m) => `<div>${esc(m)}</div>`).join('')}</div></div>` : ''}
      ${DAG_READ_ONLY ? '' : `<div class="p-sec"><button class="btn human" id="draw-btn">draw edge from here…</button>
        ${state.drawFrom ? `<div class="draw-hint">drawing from ${esc(state.drawFrom)} — click a target node (Esc cancels)</div>` : ''}</div>`}
      <div class="p-sec"><h3>comments &amp; questions (${anns.length})</h3>
        ${anns.map(annHtml).join('') || '<span class="not-doc">none yet</span>'}
        ${annFormHtml('comment')}</div>`;
    const fb = body.querySelector('#focus-btn');
    if (fb) fb.addEventListener('click', () => { if (state.view !== 'graph') { state.view = 'graph'; for (const x of $('#view-seg').children) x.classList.toggle('on', x.dataset.view === 'graph'); } state.iso = null; state.focus = n.id; render(); });
    const ib = body.querySelector('#iso-btn');
    if (ib) ib.addEventListener('click', () => {
      state.iso = (state.iso && state.iso.center === n.id) ? null : { center: n.id, hops: 1, direction: 'both' };
      state.focus = null;
      render();
    });
    const pb = body.querySelector('#pin-btn');
    if (pb) pb.addEventListener('click', () => {
      if (isPinned(n.id)) clearPin(n.id);
      else { const s = state._live && state._live.sim.get(n.id); if (s) setPin(n.id, s.x, s.y); }
      render();
    });
    const db = body.querySelector('#draw-btn');
    if (db) db.addEventListener('click', () => { state.drawFrom = n.id; renderPanel(); });
    body.querySelectorAll('.member-list div').forEach((d) => d.addEventListener('click', () => {
      const mid = d.textContent;
      const mn = state.merged.nodes.get(mid);
      if (mn) nodeClicked({ id: mid, kind: mn.kind, label: mn.path, memberCount: 1, members: [mid], walked_by: mn.walked_by, annotated: state.annIndex.has(`node:${mid}`), internalEdgeCount: 0, why: mn.why, path: mn.path, cite: mn.cite });
    }));
    wireAnnForm(body, target, 'comment');
    return;
  }

  if (sel.type === 'pair') {
    // proposed connection on an EMPTY intersection — the annotation targets the
    // node PAIR; absence is the thing under review (LAW 3: stated, not faked)
    const target = { edge: { from: sel.from, to: sel.to, type: 'proposed-connection' } };
    const anns = state.annIndex.get(annotationKeyFor(target)) || [];
    body.innerHTML = `
      <div class="p-h">${esc(sel.from)} → ${esc(sel.to)}</div>
      <div class="p-kind">proposed connection · empty intersection</div>
      <div class="p-sec"><span class="not-doc">No extracted or verified edge exists between these two at this level.
        Annotations here mark the ABSENCE itself for review; they render as a ring badge on this matrix cell and a
        dashed owner-pink line in the graph view (annotation layer).</span></div>
      <div class="p-sec"><h3>comments &amp; questions (${anns.length})</h3>
        ${anns.map(annHtml).join('') || '<span class="not-doc">none yet</span>'}
        ${annFormHtml('question', ['comment', 'question'])}</div>`;
    wireAnnForm(body, target, 'question');
    return;
  }

  // edge selection
  const e = sel.agg;
  const target = e.count === 1 && e.constituents.length === 1
    ? { edge: { from: e.constituents[0].from, to: e.constituents[0].to, type: e.constituents[0].type } }
    : { edge: { from: e.from, to: e.to, type: 'aggregate' } };
  const anns = state.annIndex.get(annotationKeyFor(target)) || [];
  const types = Object.entries(e.types).map(([t, n]) => `<span class="wb-chip" style="border-color:${LAYER_COLOR[layerOf(t)]}">${esc(t)} ×${n}</span>`).join('');
  body.innerHTML = `
    <div class="p-h">${esc(e.from)} → ${esc(e.to)}</div>
    <div class="p-kind">edge${e.count > 1 ? ` · ${e.count} constituents` : ''}</div>
    <div><span class="ev-chip ev-${esc(e.verification)}">${esc(e.verification)}</span>
      ${e.count > 1 ? `<span class="p-cite"> ${e.verifiedCount}/${e.count} verified</span>` : ''}</div>
    <div class="p-sec"><h3>types</h3>${types}</div>
    <div class="p-sec"><h3>walked by</h3>${e.walked_by && e.walked_by.length ? e.walked_by.map((w) => `<span class="wb-chip">${esc(w)}</span>`).join('') : '<span class="not-doc">no file-type walk recorded</span>'}</div>
    <div class="p-sec"><h3>how / what crosses (click a constituent)</h3><div id="how-slot">${e.count === 1 ? howHtml(e.constituents[0]) : '<span class="not-doc">select a constituent below</span>'}</div></div>
    <div class="p-sec"><h3>constituent edges (${e.constituents.length})</h3>
      <div class="const-list">${e.constituents.slice(0, 80).map((c, i) => `
        <div class="const-item" data-i="${i}">
          <span class="t" style="color:${LAYER_COLOR[c.layer]}">${esc(c.type)}</span>
          <span class="ev-chip ev-${esc(c.verification)}">${esc(c.verification)}</span>${c.unknownEndpoint ? ' <span class="ev-chip ev-STALE">unknown endpoint</span>' : ''}<br>
          ${esc(c.from)} → ${esc(c.to)}<br>
          <span class="p-cite">${(c.cites || []).slice(0, 3).map(esc).join(' · ') || 'no cite'}</span>
        </div>`).join('')}
        ${e.constituents.length > 80 ? `<div class="not-doc">…${e.constituents.length - 80} more</div>` : ''}</div></div>
    <div class="p-sec"><h3>comments &amp; questions (${anns.length})</h3>
      ${anns.map(annHtml).join('') || '<span class="not-doc">none yet</span>'}
      ${annFormHtml('comment')}</div>`;
  body.querySelectorAll('.const-item').forEach((d) => d.addEventListener('click', () => {
    const c = e.constituents[Number(d.dataset.i)];
    $('#how-slot').innerHTML = howHtml(c) + `<div style="margin-top:6px">${whyHtml(c.why).replace(/t-why/g, 'p-why').replace(/t-notdoc/g, 'not-doc')}</div>`;
  }));
  wireAnnForm(body, target, 'comment');
}

/** HOW payload rendering — explicit not-yet-documented state when absent (LAW 3). */
function howHtml(c) {
  if (!c || !c.how) return '<span class="not-doc">HOW: not yet documented (enrichment lane)</span>';
  const h = c.how;
  return `<div class="how-box">
    <div><b>what</b> ${esc(h.what ?? '—')}</div>
    <div><b>transform</b> ${esc(h.transform ?? '—')}</div>
    <div><b>lossy</b> <span class="${h.lossy ? 'lossy-yes' : 'lossy-no'}">${h.lossy === undefined ? '—' : h.lossy ? 'YES' : 'no'}</span></div>
  </div>`;
}

function annHtml(a) {
  return `<div class="ann-item">
    <div class="meta"><span class="kind-${esc(a.kind)}">${esc(a.kind)}</span> · ${esc(a.author || 'owner')} · ${esc((a.ts || '').slice(0, 16).replace('T', ' '))}${a.private ? ' · private' : ''}</div>
    <div class="txt">${esc(a.text)}</div>
  </div>`;
}

function annFormHtml(defaultKind, kinds = ['comment', 'question', 'drawn-edge']) {
  if (DAG_READ_ONLY) return '';
  return `<div class="ann-form">
    <textarea placeholder="${defaultKind === 'drawn-edge' ? 'why does the owner think this edge exists / matters?' : 'comment or question — private by default, appended to the annotations ledger'}"></textarea>
    <div class="row">
      <select>
        ${kinds.map((k) => `<option value="${k}" ${defaultKind === k ? 'selected' : ''}>${k}</option>`).join('')}
      </select>
      <input type="password" class="tok" placeholder="write token" value="${esc(state.token)}" title="X-Dag-Token — printed by serve_dag.mjs at startup">
      <button class="btn">post</button>
    </div>
    <div class="form-msg"></div>
  </div>`;
}

function wireAnnForm(scope, target, defaultKind) {
  if (DAG_READ_ONLY) return;
  const form = scope.querySelector('.ann-form:last-of-type') || scope.querySelector('.ann-form');
  if (!form) return;
  form.querySelector('.btn').addEventListener('click', async () => {
    const text = form.querySelector('textarea').value.trim();
    const kind = form.querySelector('select').value;
    const token = form.querySelector('.tok').value.trim();
    const msg = form.querySelector('.form-msg');
    if (!text) { msg.className = 'form-msg err'; msg.textContent = 'text required'; return; }
    if (kind === 'drawn-edge' && !target.edge) { msg.className = 'form-msg err'; msg.textContent = 'a drawn-edge must target an edge — use "draw edge from here" on a node'; return; }
    state.token = token; localStorage.setItem('dag_token', token);
    try {
      const res = await fetch('/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dag-Token': token },
        body: JSON.stringify({ target, kind, text, author: 'owner' }),
      });
      const j = await res.json();
      if (!res.ok) { msg.className = 'form-msg err'; msg.textContent = j.error || `HTTP ${res.status}`; return; }
      msg.className = 'form-msg ok'; msg.textContent = 'appended';
      const annRes = await fetch('./data/annotations.json');
      state.annotations = annRes.ok ? await annRes.json() : state.annotations;
      state.annIndex = indexAnnotations(state.annotations);
      state.annotatedKeys = new Set(state.annIndex.keys());
      state.pendingDrawn = null;
      render();
    } catch (err) {
      msg.className = 'form-msg err'; msg.textContent = String(err && err.message || err);
    }
  });
}

// ---- boot -----------------------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.drawFrom = null; state.pendingDrawn = null; renderPanel(); }
});
let resizeT = null;
window.addEventListener('resize', () => {
  if (!state.merged) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { state.vbKey = null; state.stepVbKey = null; render(); }, 150);
});
wireHeader();
wireClockdrive();
loadAll().then((ok) => { if (ok) render(); });
