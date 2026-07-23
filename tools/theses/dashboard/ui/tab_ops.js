'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   #ops tab — the agentic-OPERATIONS MAP (dashboard-second half of the
   OPERATIONS_MAP.md meta-map). Two views on one scroll:

     1. ACTOR GRAPH — every actor from OPERATIONS_MAP.md §1 as a node, grouped
        by class (human · orchestrator · mechanical · protocol). [CONVENTION]
        actors carry an amber "protocol, not code" badge.
     2. WAIT GRAPH — who waits on what from whom (§3). Directed edges FROM the
        waiter TO the blocker. Edges are LIT from live feeds where the data
        exists, else honestly marked convention / NOT AVAILABLE.

   Classic (non-module) script, same global scope as app.js, loaded BEFORE it
   so `renderOpsMap` exists when app.js builds RENDERERS. Reads the curated
   static map from window.__OPS_MAP__ (ops_map.js) and the already-loaded live
   feeds from state.feeds.{decisions,theses}.

   HONESTY (LAW 3):
     · live edge   → lit from the feed at each 15s poll; idle wait dims.
     · convention  → amber, protocol not mechanical capture — never a number.
     · not_available → the waiting_on.jsonl producer is not live yet; the leg
       says "NOT AVAILABLE — capture goes live next session start", never a guess.
     · feed offline → the live leg says so; it never pretends a count.
   ═══════════════════════════════════════════════════════════════════════════ */

const OPS_CLASS_VAR = { human: 'var(--human)', accent: 'var(--accent)', pass: 'var(--pass)', warn: 'var(--warn)' };

function opsEsc(s) { return typeof esc === 'function' ? esc(String(s)) : String(s); }

/* amber "protocol, not code" badge — the honest [CONVENTION] marker. */
const OPS_CONV_BADGE = '<span class="ops-conv" title="protocol / practice — not mechanically enforced">CONVENTION</span>';

/* ── live-feed derivations (the only numbers on this tab; all from real feeds) ── */

function opsDecisionsWait() {
  const st = (typeof state !== 'undefined') && state.feeds && state.feeds.decisions;
  if (!st || st.unreachable || !st.data) return { ok: false };
  const list = Array.isArray(st.data.decisions) ? st.data.decisions : [];
  const open = list.filter((d) => String(d.state).toUpperCase() === 'OPEN');
  return { ok: true, open, source: st.source };
}

function opsThesesWait() {
  const st = (typeof state !== 'undefined') && state.feeds && state.feeds.theses;
  if (!st || st.unreachable || !st.data) return { ok: false };
  const list = Array.isArray(st.data.theses) ? st.data.theses : [];
  // in-flight = a pre-registered / running thesis whose verdict is not yet stamped.
  const inflight = list.filter((t) => t.stamped_at == null &&
    ['RUNNING', 'PRE-REGISTERED', 'PRE_REGISTERED', 'QUEUED'].includes(String(t.status).toUpperCase()));
  return { ok: true, inflight, source: st.source };
}

/* live activation for a given edge → { active:bool, known:bool, count } */
function opsEdgeLive(edge) {
  if (edge.source !== 'live') return { known: false };
  if (edge.live_feed === 'decisions') {
    const d = opsDecisionsWait();
    if (!d.ok) return { known: false };
    return { known: true, active: d.open.length > 0, count: d.open.length };
  }
  if (edge.live_feed === 'theses') {
    const t = opsThesesWait();
    if (!t.ok) return { known: false };
    return { known: true, active: t.inflight.length > 0, count: t.inflight.length };
  }
  return { known: false };
}

/* ── SVG geometry (self-contained; does not depend on the flow tab) ── */

function opsCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

function opsBorderPoint(n, tx, ty, pad) {
  const c = opsCenter(n);
  const dx = tx - c.x, dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = n.w / 2, hh = n.h / 2;
  let s = Infinity;
  if (dx !== 0) s = Math.min(s, (dx > 0 ? hw : -hw) / dx);
  if (dy !== 0) s = Math.min(s, (dy > 0 ? hh : -hh) / dy);
  const bx = c.x + dx * s, by = c.y + dy * s;
  const len = Math.hypot(dx, dy) || 1;
  return { x: bx + (dx / len) * (pad || 0), y: by + (dy / len) * (pad || 0) };
}

function opsQuad(p0, cp, p1, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x,
           y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y };
}

/* edge visual class: live-active | live-idle | convention | not_available */
function opsEdgeStyle(edge, live) {
  if (edge.source === 'live') {
    if (live && live.known && live.active) return { cls: 'live-active', color: 'var(--accent)', width: 3.2, dash: '' };
    if (live && live.known) return { cls: 'live-idle', color: 'var(--muted)', width: 1.8, dash: '' };
    return { cls: 'live-off', color: 'var(--muted)', width: 1.6, dash: '4 5' }; // feed offline
  }
  if (edge.source === 'not_available') return { cls: 'na', color: 'var(--flow-muted, #55607a)', width: 1.8, dash: '1.5 6' };
  return { cls: 'conv', color: 'var(--warn)', width: 2, dash: '9 5' }; // convention
}

/* ── wait-graph SVG ── */

function opsWaitSvg(model) {
  const wg = model.wait_graph || {};
  const vb = wg.viewbox || { w: 960, h: 600 };
  const nodeById = {};
  (wg.nodes || []).forEach((n) => { nodeById[n.id] = n; });

  let edgeSvg = '';
  (wg.edges || []).forEach((e) => {
    const A = nodeById[e.from], B = nodeById[e.to];
    if (!A || !B) return;
    const live = opsEdgeLive(e);
    const stl = opsEdgeStyle(e, live);
    const ac = opsCenter(A), bc = opsCenter(B);
    const p0 = opsBorderPoint(A, bc.x, bc.y, 3);
    const p1 = opsBorderPoint(B, ac.x, ac.y, 3);
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = e.curve || 0;
    const cp = { x: mid.x + (-dy / len) * off, y: mid.y + (dx / len) * off };

    const headAt = opsQuad(p0, cp, p1, 0.965);
    const preHead = opsQuad(p0, cp, p1, 0.92);
    const ha = Math.atan2(headAt.y - preHead.y, headAt.x - preHead.x);
    const hl = 9;
    const hx1 = headAt.x - hl * Math.cos(ha - 0.42), hy1 = headAt.y - hl * Math.sin(ha - 0.42);
    const hx2 = headAt.x - hl * Math.cos(ha + 0.42), hy2 = headAt.y - hl * Math.sin(ha + 0.42);

    const tip = [
      `${e.id}: ${e.from} → ${e.to}`,
      e.label,
      e.source === 'live'
        ? (live.known ? `LIVE · ${live.count} active` : 'LIVE · feed offline')
        : e.source === 'not_available' ? 'NOT AVAILABLE — capture goes live next session' : 'CONVENTION — protocol, not code',
      e.for_what,
    ].filter(Boolean).join('\n');
    const dashAttr = stl.dash ? `stroke-dasharray:${stl.dash};` : '';

    edgeSvg += `<g class="ops-edge ops-${stl.cls}">
      <title>${opsEsc(tip)}</title>
      <path d="M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} Q ${cp.x.toFixed(1)} ${cp.y.toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}"
        style="fill:none;stroke:${stl.color};stroke-width:${stl.width};${dashAttr}stroke-linecap:round"/>
      <polygon points="${headAt.x.toFixed(1)},${headAt.y.toFixed(1)} ${hx1.toFixed(1)},${hy1.toFixed(1)} ${hx2.toFixed(1)},${hy2.toFixed(1)}"
        style="fill:${stl.color}"/>
      <text x="${mid.x.toFixed(1)}" y="${(mid.y - 4).toFixed(1)}" text-anchor="middle" class="ops-elabel">${opsEsc(e.id)}${
        e.source === 'live' && live.known && live.active ? ' · ' + live.count : ''}</text>
    </g>`;
  });

  let nodeSvg = '';
  (wg.nodes || []).forEach((n) => {
    const cv = OPS_CLASS_VAR[(model.classById && model.classById[n.class] && model.classById[n.class].color)] || 'var(--ink-2)';
    nodeSvg += `<g class="ops-wnode">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" style="stroke:${cv}"/>
      <text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4.5}" text-anchor="middle" class="ops-wnode-t">${opsEsc(n.label)}</text>
    </g>`;
  });

  return `<div class="ops-canvas"><svg viewBox="0 0 ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet"
     role="img" aria-label="Operations wait graph — who waits on whom">
    ${edgeSvg}${nodeSvg}
  </svg></div>`;
}

/* ── wait-edge readable rows (the mobile-readable carrier of the same edges) ── */

function opsEdgeRow(e) {
  const live = opsEdgeLive(e);
  let badge, detail;
  if (e.source === 'live') {
    if (!live.known) {
      badge = '<span class="ops-src off">LIVE · FEED OFFLINE</span>';
      detail = '<span class="ops-detail nr">feed unreachable — no count shown rather than a guessed one</span>';
    } else if (live.active) {
      badge = `<span class="ops-src live">LIVE · ${live.count} ACTIVE</span>`;
      detail = opsLiveDetail(e);
    } else {
      badge = '<span class="ops-src idle">LIVE · idle</span>';
      detail = '<span class="ops-detail">no active wait on this edge right now</span>';
    }
  } else if (e.source === 'not_available') {
    badge = '<span class="ops-src na">NOT AVAILABLE</span>';
    detail = '<span class="ops-detail">capture goes live next session start (waiting_on.jsonl producer)</span>';
  } else {
    badge = `<span class="ops-src conv">CONVENTION</span>`;
    detail = `<span class="ops-detail">protocol, not mechanically captured</span>`;
  }
  return `<div class="ops-erow ops-e-${e.source}">
    <div class="ops-erow-head">
      <code class="ops-eid">${opsEsc(e.id)}</code>
      <span class="ops-eflow"><b>${opsEsc(e.from)}</b> <span class="ops-arrow">waits on →</span> <b>${opsEsc(e.to)}</b></span>
      ${badge}
    </div>
    <div class="ops-erow-for">${opsEsc(e.for_what)}</div>
    <div class="ops-erow-foot">${detail}<span class="ops-ev">${opsEsc(e.evidence)}</span></div>
  </div>`;
}

function opsLiveDetail(e) {
  if (e.live_feed === 'decisions') {
    const d = opsDecisionsWait();
    if (!d.ok) return '';
    return '<ul class="ops-live-list">' + d.open.slice(0, 8).map((x) =>
      `<li><code>${opsEsc(x.id)}</code> ${opsEsc(x.title)}</li>`).join('') + '</ul>';
  }
  if (e.live_feed === 'theses') {
    const t = opsThesesWait();
    if (!t.ok) return '';
    return '<ul class="ops-live-list">' + t.inflight.slice(0, 8).map((x) =>
      `<li><code>${opsEsc(x.id)}</code> ${opsEsc(x.status)} — ${opsEsc(x.title)}</li>`).join('') + '</ul>';
  }
  return '';
}

/* ── actor cards, grouped by class (the ACTOR GRAPH, HTML-native for mobile) ── */

function opsActorCards(model) {
  return (model.classes || []).map((cls) => {
    const members = (model.actors || []).filter((a) => a.class === cls.id);
    if (!members.length) return '';
    const cv = OPS_CLASS_VAR[cls.color] || 'var(--ink-2)';
    const cards = members.map((a) => `
      <div class="ops-card${a.convention ? ' ops-card-conv' : ''}">
        <div class="ops-card-h"><b>${opsEsc(a.label)}</b>${a.convention ? OPS_CONV_BADGE : ''}</div>
        <div class="ops-card-role">${opsEsc(a.role)}</div>
        <div class="ops-card-lives"><span class="ops-lives-k">lives at</span> <code>${opsEsc(a.lives_at)}</code></div>
      </div>`).join('');
    return `<section class="ops-class" style="--ops-cv:${cv}">
      <h3 class="ops-class-h"><span class="ops-class-dot"></span>${opsEsc(cls.label)}
        <span class="ops-class-meaning">${opsEsc(cls.meaning || '')}</span>
        <span class="ops-class-n">${members.length}</span></h3>
      <div class="ops-card-grid">${cards}</div>
    </section>`;
  }).join('');
}

/* ── legend for the wait graph ── */

function opsWaitLegend() {
  return `<div class="ops-legend">
    <div class="ops-leg-row"><span class="ops-leg-swatch live"></span><b>LIVE</b> — lit from a feed at each ${
      (typeof POLL_MS !== 'undefined' ? POLL_MS / 1000 : 15)}s poll (decisions · thesis registry). Idle wait dims; feed offline says so.</div>
    <div class="ops-leg-row"><span class="ops-leg-swatch conv"></span><b>CONVENTION</b> — protocol / practice, not mechanically captured. Never a number.</div>
    <div class="ops-leg-row"><span class="ops-leg-swatch na"></span><b>NOT AVAILABLE</b> — the waiting_on.jsonl producer goes live next session; the leg is drawn but honestly empty.</div>
  </div>`;
}

/* ── main render ── */

function renderOpsMap() {
  const model = (typeof window !== 'undefined') && window.__OPS_MAP__;
  if (!model || !Array.isArray(model.actors) || !model.wait_graph) {
    return `<div class="subhead"><span class="src fixture">DATA FILE NOT LOADED</span><span class="spacer"></span></div>
      <div class="offline"><div class="o-badge">NOT AVAILABLE</div>
        <p>The operations map (<code>ops_map.js</code>) did not load, so this tab has nothing
           to draw. Nothing is fabricated in its place.</p></div>`;
  }
  // index classes once for node coloring
  model.classById = {};
  (model.classes || []).forEach((c) => { model.classById[c.id] = c; });

  const pv = model._provenance || {};
  const draft = String(pv.doc_version || '').toUpperCase().includes('DRAFT');
  const subhead = `<div class="subhead">
    <span class="src static">STATIC · checked-in map</span>
    <span class="ops-sub-meta">source doc: <code>${opsEsc(pv.source_doc || 'OPERATIONS_MAP.md')}</code>,
      ${opsEsc(pv.doc_version || '?')}${draft ? ' — ' + opsEsc(pv.doc_status || 'owner review pending') : ''}
      (${opsEsc(pv.doc_date || '?')})</span>
    <span class="spacer"></span>
    <span class="ops-sub-meta">${(model.actors || []).length} actors · ${(model.wait_graph.edges || []).length} wait-edges</span>
  </div>`;

  // live status strip — the three live legs, each explicit
  const d = opsDecisionsWait();
  const t = opsThesesWait();
  const strip = `<div class="ops-strip">
    <div class="ops-stat">
      <span class="ops-stat-k">orchestrator ⟶ OWNER</span>
      <span class="ops-stat-v ${d.ok ? (d.open.length ? 'hot' : 'cool') : 'off'}">${
        d.ok ? `${d.open.length} open decision${d.open.length === 1 ? '' : 's'}` : 'feed offline'}</span>
      <span class="ops-stat-src">live · decisions feed</span>
    </div>
    <div class="ops-stat">
      <span class="ops-stat-k">frozen runs ⟶ QUIET BOX</span>
      <span class="ops-stat-v ${t.ok ? (t.inflight.length ? 'hot' : 'cool') : 'off'}">${
        t.ok ? `${t.inflight.length} in flight` : 'feed offline'}</span>
      <span class="ops-stat-src">live · thesis registry</span>
    </div>
    <div class="ops-stat">
      <span class="ops-stat-k">orchestrator ⟶ AGENT lanes</span>
      <span class="ops-stat-v na">NOT AVAILABLE</span>
      <span class="ops-stat-src">waiting_on.jsonl — next session</span>
    </div>
  </div>`;

  const edgeRows = (model.wait_graph.edges || []).map(opsEdgeRow).join('');

  return subhead + strip +
    `<h2 class="rule">actor graph — ${opsEsc((model.actors || []).length)} actors by class</h2>` +
    `<p class="ops-note">Every actor in the operations system (OPERATIONS_MAP.md §1). Amber
      ${OPS_CONV_BADGE} marks an actor whose authority is written practice, not code.</p>` +
    opsActorCards(model) +
    `<h2 class="rule">wait graph — who waits on what from whom (§3)</h2>` +
    opsWaitLegend() +
    opsWaitSvg(model) +
    `<div class="ops-erows">${edgeRows}</div>`;
}
