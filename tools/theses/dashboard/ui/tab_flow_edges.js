'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   #flow tab — PROCESSING FLOW, edge-semantics map.

   Classic (non-module) script: it runs in the same global scope as app.js and
   is loaded BEFORE it, so `renderFlowEdges` exists by the time app.js builds
   its RENDERERS table. It may freely call app.js helpers (esc, …).

   Connector lines encode MEMORY / TRANSFER semantics (owner directive):
     · DOTTED   = zero-copy SHARED VIEW
     · DOT-DASH = zero-copy OWNERSHIP TRANSFER (transferable — the 172-482x lever)
     · SOLID    = COPY / SERIALIZE, stroke weight ∝ measured cost (ms)

   Shape glyphs sit at BOTH ends of every line (on the line, not the cards),
   classifying the data structure passed vs received — a start≠end shape makes
   a format conversion visible. The glyph vocabulary is GENERATIVE from the
   LAW-7 layout schema (see gen_flow_edge_semantics.mjs).

   HONESTY (LAW 3): only edges whose transfer semantics were MEASURED (Arrow
   serialization-walls report) render full-color. Unmeasured edges (Tauri IPC
   runtime) render muted grey and say NOT MEASURED. Absent data file → the tab
   says NOT AVAILABLE rather than drawing anything invented.
   ═══════════════════════════════════════════════════════════════════════════ */

const FLOW_COLOR = {
  view: 'var(--flow-view)',
  transfer: 'var(--flow-transfer)',
  copy: 'var(--flow-copy)',
  muted: 'var(--flow-muted)',
  dead: 'var(--flow-dead)',
};

function flowEscAttr(s) {
  // app.js esc() covers &<>"'; reuse it for title/tooltip text.
  return typeof esc === 'function' ? esc(String(s)) : String(s);
}

function flowColorFor(edge, lineClass) {
  if (edge.status === 'dead') return FLOW_COLOR.dead;
  if (!edge.measured) return FLOW_COLOR.muted;
  return FLOW_COLOR[lineClass.color] || FLOW_COLOR.copy;
}

/* stroke weight ∝ measured copy/serialize cost (ms). Non-copy edges are cheap
   (bitmap-only view / µs transfer) → a thin fixed weight. */
function flowWidthFor(edge, lineClass) {
  if (lineClass.dash === 'solid' && edge.measured && typeof edge.cost_ms === 'number') {
    const w = 2.4 + edge.cost_ms * 0.085;
    return Math.max(2.4, Math.min(11, w));
  }
  if (!edge.measured) return 1.6;
  return 2.2;
}

function flowDashFor(lineClass) {
  if (lineClass.dash === 'dotted') return '1.5 6';
  if (lineClass.dash === 'dot-dash') return '12 5 2 5';
  return ''; // solid
}

/* ── geometry ────────────────────────────────────────────────────────────── */

function flowCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

/* Intersection of the ray (cx,cy)->(tx,ty) with node n's border, pushed `pad`
   px outside the card so the line starts at the edge, not under it. */
function flowBorderPoint(n, tx, ty, pad) {
  const c = flowCenter(n);
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

function flowQuad(p0, cp, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y,
  };
}

/* ── glyph shape factory ─────────────────────────────────────────────────── */
/* Returns an SVG fragment centered at (x,y). Shape encodes the DATA STRUCTURE;
   color follows the edge (measured class color, or muted grey). A backing disc
   lifts the glyph off the connector line so it reads cleanly. */
function flowGlyphSvg(shape, x, y, colorVar) {
  const bg = `<circle cx="${x}" cy="${y}" r="10.5" class="flow-glyph-bg"/>`;
  const fill = `fill:${colorVar}`;
  const stroke = `fill:none;stroke:${colorVar};stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round`;
  let g = '';
  switch (shape) {
    case 'square':
      g = `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="1.6" style="${fill}"/>`;
      break;
    case 'circle':
      g = `<circle cx="${x}" cy="${y}" r="6.4" style="${fill}"/>`;
      break;
    case 'bars':
      g = `<g style="${fill}">
        <rect x="${x - 6}" y="${y - 6.5}" width="2.6" height="13" rx="0.6"/>
        <rect x="${x - 1.3}" y="${y - 6.5}" width="2.6" height="13" rx="0.6"/>
        <rect x="${x + 3.4}" y="${y - 6.5}" width="2.6" height="13" rx="0.6"/></g>`;
      break;
    case 'braces':
      g = `<text x="${x}" y="${y + 4.4}" text-anchor="middle"
        style="font:700 13px var(--mono);fill:${colorVar}">{ }</text>`;
      break;
    case 'diamond':
      g = `<polygon points="${x},${y - 7.2} ${x + 7.2},${y} ${x},${y + 7.2} ${x - 7.2},${y}" style="${fill}"/>`;
      break;
    case 'chevron':
      g = `<path d="M ${x - 6} ${y - 6} L ${x} ${y} L ${x - 6} ${y + 6}
              M ${x + 1} ${y - 6} L ${x + 7} ${y} L ${x + 1} ${y + 6}" style="${stroke}"/>`;
      break;
    case 'hexagon': {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        pts.push(`${(x + Math.cos(a) * 7.2).toFixed(1)},${(y + Math.sin(a) * 7.2).toFixed(1)}`);
      }
      g = `<polygon points="${pts.join(' ')}" style="${fill}"/>`;
      break;
    }
    case 'crossbox':
      g = `<g style="${stroke}">
        <rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="1.2"/>
        <path d="M ${x - 6} ${y} L ${x + 6} ${y} M ${x} ${y - 6} L ${x} ${y + 6}"/></g>`;
      break;
    default:
      g = `<circle cx="${x}" cy="${y}" r="5" style="${fill}"/>`;
  }
  return bg + g;
}

/* ── main render ─────────────────────────────────────────────────────────── */

function renderFlowEdges() {
  const model = (typeof window !== 'undefined') && window.__FLOW_EDGE_SEMANTICS__;
  if (!model || !Array.isArray(model.edges) || !Array.isArray(model.nodes)) {
    return `<div class="subhead"><span class="src fixture">DATA FILE NOT LOADED</span><span class="spacer"></span></div>
      <div class="offline"><div class="o-badge">NOT AVAILABLE</div>
        <p>The edge-semantics data file (<code>flow_edge_semantics.js</code>) did not load,
           so this tab has nothing measured to draw. Nothing is fabricated in its place.</p></div>`;
  }

  const nodeById = {};
  model.nodes.forEach((n) => { nodeById[n.id] = n; });
  const classById = {};
  (model.line_classes || []).forEach((c) => { classById[c.id] = c; });
  // glyph id → visual shape token (edges reference glyphs by id; the shape lives
  // on the vocabulary entry, keyed to the LAW-7 schema).
  const shapeByGlyph = {};
  (model.glyph_vocabulary || []).forEach((g) => { shapeByGlyph[g.id] = g.shape; });

  const vb = model.viewbox || { w: 948, h: 400 };
  const measuredCount = model.edges.filter((e) => e.measured).length;

  /* ── edges (drawn first, under the nodes) ── */
  let edgeSvg = '';
  model.edges.forEach((e) => {
    const A = nodeById[e.from], B = nodeById[e.to];
    if (!A || !B) return;
    const lc = classById[e.line_class] || { dash: 'solid', color: 'copy' };
    const ac = flowCenter(A), bc = flowCenter(B);
    const p0 = flowBorderPoint(A, bc.x, bc.y, 3);
    const p1 = flowBorderPoint(B, ac.x, ac.y, 3);
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    // perpendicular offset for curved/parallel edges
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = e.curve || 0;
    const cp = { x: mid.x + (-dy / len) * off, y: mid.y + (dx / len) * off };

    const color = flowColorFor(e, lc);
    const width = flowWidthFor(e, lc);
    const dash = flowDashFor(lc);
    const dashAttr = dash ? `stroke-dasharray:${dash};` : '';

    const gStart = flowQuad(p0, cp, p1, 0.135);
    const gEnd = flowQuad(p0, cp, p1, 0.865);
    const headAt = flowQuad(p0, cp, p1, 0.97);
    // arrowhead direction from a point just before the end
    const preHead = flowQuad(p0, cp, p1, 0.93);
    const ha = Math.atan2(headAt.y - preHead.y, headAt.x - preHead.x);
    const hl = 8;
    const hx1 = headAt.x - hl * Math.cos(ha - 0.42), hy1 = headAt.y - hl * Math.sin(ha - 0.42);
    const hx2 = headAt.x - hl * Math.cos(ha + 0.42), hy2 = headAt.y - hl * Math.sin(ha + 0.42);

    const isDead = e.status === 'dead';
    const tip = [
      `${e.from} → ${e.to}`,
      isDead ? `DEAD PATH${e.dead_date ? ` (deleted ${e.dead_date})` : ''}` : '',
      isDead ? (e.dead_reason || '') : '',
      `${lc.label}`,
      `format: ${e.start_glyph} → ${e.end_glyph}`,
      e.measured ? `MEASURED · ${e.wall}` : `NOT MEASURED · ${e.wall} (static inventory)`,
      e.site ? `site: ${e.site}` : '',
      e.measurement || '',
    ].filter(Boolean).join('\n');

    edgeSvg += `<g class="flow-edge${isDead ? ' dead' : (e.measured ? '' : ' unmeasured')}">
      <title>${flowEscAttr(tip)}</title>
      <path d="M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} Q ${cp.x.toFixed(1)} ${cp.y.toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}"
        style="fill:none;stroke:${color};stroke-width:${width.toFixed(2)};${dashAttr}stroke-linecap:round"/>
      <polygon points="${headAt.x.toFixed(1)},${headAt.y.toFixed(1)} ${hx1.toFixed(1)},${hy1.toFixed(1)} ${hx2.toFixed(1)},${hy2.toFixed(1)}"
        style="fill:${color}"/>
      ${flowGlyphSvg(shapeByGlyph[e.start_glyph] || e.start_glyph, gStart.x, gStart.y, color)}
      ${flowGlyphSvg(shapeByGlyph[e.end_glyph] || e.end_glyph, gEnd.x, gEnd.y, color)}
      ${isDead
        ? `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 6).toFixed(1)}" text-anchor="middle" class="flow-dead-tag">DEAD PATH · FILE DELETED</text>`
        : (!e.measured ? `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 6).toFixed(1)}" text-anchor="middle" class="flow-nm-tag">NOT MEASURED</text>` : '')}
    </g>`;
  });

  /* ── nodes (drawn over the edges) ── */
  let nodeSvg = '';
  model.nodes.forEach((n) => {
    const nDead = n.status === 'dead';
    const nTip = nDead
      ? [`${n.label} — DEAD${n.dead_date ? ` (deleted ${n.dead_date})` : ''}`, n.dead_reason || ''].filter(Boolean).join('\n')
      : '';
    nodeSvg += `<g class="flow-node${nDead ? ' dead' : ''}">
      ${nDead ? `<title>${flowEscAttr(nTip)}</title>` : ''}
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="7"/>
      <text x="${n.x + n.w / 2}" y="${n.y + (n.sub ? 21 : n.h / 2 + 4)}" text-anchor="middle" class="flow-node-t">${flowEscAttr(n.label)}</text>
      ${n.sub ? `<text x="${n.x + n.w / 2}" y="${n.y + 36}" text-anchor="middle" class="flow-node-s">${flowEscAttr(n.sub)}</text>` : ''}
      ${nDead ? `<text x="${n.x + n.w / 2}" y="${n.y + n.h - 6}" text-anchor="middle" class="flow-node-dead-tag">✕ DELETED${n.dead_date ? ` ${n.dead_date}` : ''}</text>` : ''}
    </g>`;
  });

  const svg = `<div class="flow-canvas">
    <svg viewBox="0 0 ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Processing-flow memory/transfer edge-semantics map">
      ${edgeSvg}
      ${nodeSvg}
    </svg></div>`;

  /* ── subhead ── */
  const pv = model.provenance || {};
  const gsrc = pv.glyph_vocabulary_source || {};
  const msrc = pv.measured_edges_source || {};
  const subhead = `<div class="subhead">
    <span class="src static">STATIC · checked-in semantics map</span>
    <span class="flow-sub-meta">glyphs ← ${flowEscAttr(gsrc.file || 'binary_layouts.ts')} @ ${flowEscAttr(gsrc.schema_version || '?')}</span>
    <span class="flow-sub-meta">${measuredCount}/${model.edges.length} edges MEASURED</span>
    <span class="spacer"></span>
  </div>`;

  return subhead + svg + flowLegend(model);
}

/* ── legend (generated from the same data) ───────────────────────────────── */

function flowLegend(model) {
  // line-class rows
  const classRows = (model.line_classes || []).map((c) => {
    const color = FLOW_COLOR[c.color] || FLOW_COLOR.copy;
    const dash = flowDashFor(c);
    const dashAttr = dash ? `stroke-dasharray:${dash};` : '';
    let sample;
    if (c.dash === 'solid') {
      // three widths → demonstrate weight ∝ measured cost
      sample = `<svg viewBox="0 0 120 46" class="flow-leg-line" aria-hidden="true">
        <line x1="6" y1="11" x2="114" y2="11" style="stroke:${color};stroke-width:2.6"/>
        <line x1="6" y1="24" x2="114" y2="24" style="stroke:${color};stroke-width:5.6"/>
        <line x1="6" y1="38" x2="114" y2="38" style="stroke:${color};stroke-width:9.4"/>
      </svg>
      <span class="flow-leg-scale">thin→thick = 12ms · 41ms · 95ms measured</span>`;
    } else {
      sample = `<svg viewBox="0 0 120 24" class="flow-leg-line" aria-hidden="true">
        <line x1="6" y1="12" x2="114" y2="12" style="stroke:${color};stroke-width:2.6;${dashAttr}stroke-linecap:round"/>
      </svg>`;
    }
    return `<div class="flow-leg-row">
      <div class="flow-leg-sample">${sample}</div>
      <div class="flow-leg-text"><b style="color:${color}">${flowEscAttr(c.label)}</b>
        <span>${flowEscAttr(c.meaning)}</span></div>
    </div>`;
  }).join('');

  // glyph vocabulary cards
  const glyphCards = (model.glyph_vocabulary || []).map((g) => {
    const shape = flowGlyphSvg(g.shape, 17, 17, 'var(--ink-2)');
    return `<div class="flow-glyph-card">
      <svg viewBox="0 0 34 34" aria-hidden="true">${shape}</svg>
      <div class="flow-glyph-meta">
        <b>${flowEscAttr(g.label)}</b>
        <code>${flowEscAttr(g.dtype)}</code>
        <span class="flow-glyph-cite">LAW 7 · ${flowEscAttr(g.schema_entry)} @ ${flowEscAttr(g.schema_version)}</span>
        ${g.note ? `<span class="flow-glyph-note">${flowEscAttr(g.note)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  const pv = model.provenance || {};
  const gsrc = pv.glyph_vocabulary_source || {};
  const msrc = pv.measured_edges_source || {};
  const deadCount = (model.edges || []).filter((e) => e.status === 'dead').length
    + (model.nodes || []).filter((n) => n.status === 'dead').length;

  return `<div class="flow-legend">
    <h2 class="rule">connector semantics — memory / transfer class</h2>
    <div class="flow-leg-classes">${classRows}</div>

    <h2 class="rule">data-structure glyphs — keyed to the LAW-7 layout schema</h2>
    <p class="flow-leg-note">A glyph sits at each line's start and terminus; a start≠end
      shape means the structure was converted on the wire. The vocabulary is generated
      from <code>${flowEscAttr(gsrc.file || '')}</code> — every glyph is an enumerated
      binary boundary, none is hand-invented.</p>
    <div class="flow-glyph-grid">${glyphCards}</div>

    <h2 class="rule">honesty</h2>
    <div class="flow-honesty">
      <p><span class="flow-hon-chip measured">FULL COLOR</span> the edge's transfer semantics were
        <b>MEASURED</b> — Arrow serialization-walls report
        <code>${flowEscAttr(msrc.path || '')}</code> (${flowEscAttr(msrc.date || '')},
        repo ${flowEscAttr(msrc.repo_head || '')}).</p>
      <p><span class="flow-hon-chip notmeasured">GREY</span> <b>NOT MEASURED</b> — static code
        inventory only (Tauri IPC runtime needs the packaged app). No timing is invented for these.</p>
      ${deadCount ? `<p><span class="flow-hon-chip dead">DEAD PATH</span> <b>FILE DELETED</b> — the
        worker source at this seam was removed (orphaned, never spawned; live path runs in-process).
        The edge is kept, struck-through in crimson, so the history stays honest — its measured
        numbers were a real micro-benchmark of a code path that no longer exists.</p>` : ''}
      ${msrc.note ? `<p class="flow-leg-note">${flowEscAttr(msrc.note)}</p>` : ''}
    </div>
  </div>`;
}
