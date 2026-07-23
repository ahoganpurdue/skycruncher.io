'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ROADMAP tab — NEXT_MOVES / ROADMAP as work items with a client-side DAG.

   Classic (non-module) script. Loaded BEFORE app.js so its bare-name entry
   points (renderRoadmap, roadmapDecisionUnlocks) exist in the shared global
   scope by the time app.js's RENDERERS literal and decisionCard reference them.

   All app.js helpers (esc, NR, subheadHtml, offlineHtml, copyBtn, fmtTs, state,
   render) are called at render time — after every script has loaded — so the
   only load-order constraint is the two bare-name references above.

   Honesty rules (LAW 3) carried through verbatim:
     · absent ledger            → "LEDGER NOT PUBLISHED" (never a stale draft as-if-live)
     · dep id not in the map     → "NOT MAPPED" node, fail-closed to HUMAN-REQUIRED
     · no derivable live state   → "LIVE: NOT AVAILABLE" (never a guessed status)
     · nothing is fabricated; every chip is sourced from a feed or an item field
   ═══════════════════════════════════════════════════════════════════════════ */

/* Module-local persistent state — kept OUT of app.js's `state` object so app.js
   stays additive-only. Survives the 15s poll re-render (expansion + checkbox
   selections are re-derived from here on every render, exactly like state.open). */
const RM = {
  open: new Set(),      // item ids whose detail/prereq-tree is expanded
  checks: new Map(),    // itemId → { overnight:bool, session:bool }
  notice: null,         // { kind:'ok'|'err', text } — transient emit result
  tags: new Set(),      // active tag-filter chips (orchestrator-assigned tags)
  tagMode: 'any',       // 'any' (OR) | 'all' (AND)
  collapse: new Set(['completed']), // status roll-up groups collapsed by default (completed folded away)
};

const RM_TOKEN_KEY = 'csl_dashboard_token'; // same localStorage key the decisions tab writes; read-only here

const RM_TIERS = [
  { id: 'next-move', label: 'next moves',       hint: 'NEXT_MOVES.md — executable, near-term' },
  { id: 'roadmap',   label: 'roadmap',          hint: 'ROADMAP.md — planned, not yet scheduled' },
  { id: 'horizon',   label: 'horizon',          hint: 'ideas / long-range, sequencing owner-gated' },
];

/* ── HUMAN-REQUIRED deny-list (part D classification) ──────────────────────
   Fail toward HUMAN-REQUIRED. An owner decision matches if its category is
   owner-gated by nature OR its text hits an irreversibility/authority pattern.
   Anything left over is PROXY-ELIGIBLE; an UNMAPPED decision or dep is
   fail-closed to HUMAN-REQUIRED (never assume a missing gate is safe). */
const RM_HUMAN_CATEGORIES = new Set(['ruling', 'sign-off', 'signoff', 'sign_off', 'supply', 'release', 'naming', 'purchase', 'security']);
const RM_HUMAN_PATTERNS = [
  { re: /calibrat|sigma|\bσ|gate constant|solver_|\brecal\b|rebaselin|conf-?floor|\bthreshold/i, why: 'touches a calibrated value / gate constant' },
  { re: /publish|releas|installer|\bship\b|deploy|distribut|cutover|\bflip\b|ceremony/i,          why: 'publish / release / irreversible ship step' },
  { re: /\bdelet|\bremov|\bretire|\bprune\b|destroy|\bwipe\b|purge/i,                              why: 'deletion / removal' },
  { re: /renam|naming|\bbrand/i,                                                                  why: 'naming / brand' },
  { re: /\bmoney\b|payment|purchas|\bfund|billing|invoice|\bspend\b/i,                            why: 'money / spend' },
  { re: /\bkeys?\b|secret|credential|\bauth\b|oauth|\btoken\b|\bgrant\b|sign-?off|signing/i,       why: 'keys / credentials / auth grant' },
  { re: /irreversib|one-way|permanent|non-reversible/i,                                           why: 'explicitly irreversible' },
  { re: /\bheld\b|owner-?gat|owner research|do not build|unilateral|owner-?parked|owner decision|owner ruling/i, why: 'explicitly owner-gated' },
];

/* ── data access ───────────────────────────────────────────────────────────
   The feed tolerates two shapes: a bare array (the fixture DRAFT is one) or an
   object { generated_at, published, items:[…] } from the graceful server route. */
function rmItems() {
  const d = state.feeds.roadmap && state.feeds.roadmap.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.items)) return d.items;
  return [];
}

/** 'unreachable' | 'not-published' | 'empty' | 'ok' */
function rmLedgerState() {
  const st = state.feeds.roadmap;
  if (!st || st.unreachable || st.data == null) return 'unreachable';
  const d = st.data;
  if (!Array.isArray(d) && d && d.published === false) return 'not-published';
  const items = rmItems();
  if (!items.length) return (!Array.isArray(d) && d && d.published === false) ? 'not-published' : 'empty';
  return 'ok';
}

function rmItemMap(items) {
  const m = new Map();
  for (const it of items) { if (it && typeof it.id === 'string') m.set(it.id, it); }
  return m;
}

function rmDecisionMap() {
  const st = state.feeds.decisions;
  const m = new Map();
  if (!st || st.unreachable || !st.data) return m;
  const list = Array.isArray(st.data.decisions) ? st.data.decisions : (Array.isArray(st.data) ? st.data : []);
  for (const dc of list) { if (dc && typeof dc.id === 'string') m.set(dc.id, dc); }
  return m;
}

function rmFindThesis(id) {
  const st = state.feeds.theses;
  if (!st || !st.data) return null;
  const arr = Array.isArray(st.data.theses) ? st.data.theses : [];
  return arr.find((t) => t && t.id === id) || null;
}

/* ── DAG walk: transitive prerequisites (part B) ───────────────────────────── */

/** Build a render tree over depends_on. Cycle = id already on the ancestor
   path (marked, not recursed — never a stack overflow). Unknown id → item:null
   node rendered "NOT MAPPED". */
function rmBuildNode(id, itemMap, ancestors) {
  const item = itemMap.get(id) || null;
  const cycle = ancestors.indexOf(id) !== -1;
  const node = { id, item, cycle, children: [] };
  if (item && !cycle) {
    const next = ancestors.concat(id);
    for (const dep of (Array.isArray(item.depends_on) ? item.depends_on : [])) {
      node.children.push(rmBuildNode(dep, itemMap, next));
    }
  }
  return node;
}

/** Flat collect over root + full dependency subtree: visited ids, unmapped dep
   ids, union of blocked_by_decisions, and whether any cycle was hit. Drives the
   pre-flight classification (part D). */
function rmCollect(rootId, itemMap) {
  const seen = new Set(), unmapped = new Set(), decisions = new Set();
  let cycle = false;
  (function walk(id, ancestors) {
    if (ancestors.indexOf(id) !== -1) { cycle = true; return; }
    const item = itemMap.get(id);
    if (!item) { unmapped.add(id); return; }
    if (seen.has(id)) return; // diamond — already fully expanded
    seen.add(id);
    for (const d of (Array.isArray(item.blocked_by_decisions) ? item.blocked_by_decisions : [])) decisions.add(d);
    const next = ancestors.concat(id);
    for (const dep of (Array.isArray(item.depends_on) ? item.depends_on : [])) walk(dep, next);
  })(rootId, []);
  return { ids: [...seen], unmapped: [...unmapped], decisions: [...decisions], cycle };
}

/* ── classification (part D) ───────────────────────────────────────────────── */

function rmClassifyDecision(id, decMap) {
  const dec = decMap && decMap.get(id);
  if (!dec) return { id, classification: 'HUMAN-REQUIRED', reason: 'not in the owner-decisions ledger — fail-closed', state: null, found: false };
  if (dec.recommendation == null || String(dec.recommendation).trim() === '') return { id, classification: 'HUMAN-REQUIRED', reason: 'no standing recommendation — fail-closed', state: dec.state || null, found: true };
  const cat = String(dec.category || '').toLowerCase();
  const hay = [dec.category, dec.title, dec.summary, dec.recommendation].filter(Boolean).join(' · ');
  if (RM_HUMAN_CATEGORIES.has(cat)) return { id, classification: 'HUMAN-REQUIRED', reason: `category '${dec.category}' is owner-gated`, state: dec.state || null, found: true };
  for (const p of RM_HUMAN_PATTERNS) { if (p.re.test(hay)) return { id, classification: 'HUMAN-REQUIRED', reason: p.why, state: dec.state || null, found: true }; }
  return { id, classification: 'PROXY-ELIGIBLE', reason: `category '${dec.category || '?'}' · no deny-list match`, state: dec.state || null, found: true };
}

/** Full pre-flight over root + subtree. overall HUMAN-REQUIRED if any decision
   is human-required OR any dependency is unmapped OR a cycle exists (both
   structural hazards are fail-closed). */
function rmPreflight(rootId, itemMap, decMap) {
  const c = rmCollect(rootId, itemMap);
  const decisions = c.decisions.map((id) => rmClassifyDecision(id, decMap));
  const anyHuman = decisions.some((d) => d.classification === 'HUMAN-REQUIRED');
  const overall = (anyHuman || c.unmapped.length > 0 || c.cycle) ? 'HUMAN-REQUIRED' : 'PROXY-ELIGIBLE';
  return { rootId, ids: c.ids, unmapped: c.unmapped, cycle: c.cycle, decisions, overall };
}

/* ── live telemetry (part E) ────────────────────────────────────────────────
   ONLY states derivable from server-exposed feeds. Registry (theses) via an
   explicit item.thesis_id join key; a human gate via the decisions feed. Every
   other item → null → "LIVE: NOT AVAILABLE" (the DRAFT carries no join key, so
   it is uniformly NOT AVAILABLE until items gain a thesis_id or a live gate). */
function rmLiveState(item, decMap) {
  const tid = item.thesis_id;
  if (tid) {
    const th = rmFindThesis(tid);
    if (th) {
      const s = String(th.status || '').toUpperCase();
      if (s === 'RUNNING') return { state: 'running', src: `registry ${tid} RUNNING` };
      if (s === 'PASS' || s === 'FAIL' || s === 'FAIL-KILL' || th.stamped_at) return { state: 'done', src: `registry ${tid} stamped` };
      if (s === 'PARKED') return { state: 'parked', src: `registry ${tid} PARKED` };
      if (s === 'REGISTERED') return { state: 'queued', src: `registry ${tid} REGISTERED` };
    }
  }
  const decs = Array.isArray(item.blocked_by_decisions) ? item.blocked_by_decisions : [];
  for (const id of decs) {
    const dec = decMap && decMap.get(id);
    if (dec && /^(OPEN|ANSWER-PENDING|BLOCKED)$/i.test(String(dec.state || ''))) {
      if (rmClassifyDecision(id, decMap).classification === 'HUMAN-REQUIRED') {
        return { state: 'blocked-at-human-gate', src: `decisions feed · ${id} ${dec.state}` };
      }
    }
  }
  return null;
}

/* ── small render fragments ────────────────────────────────────────────────── */

function rmStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (/\bdone\b/.test(s)) return 'done';
  if (/in-?flight|running|restore-recommended/.test(s)) return 'run';
  if (/closed|retired|superseded|folded|not built|deprecat/.test(s)) return 'steel';
  if (/parked|ladder-gated|dormant/.test(s)) return 'parked';
  if (/blocked/.test(s)) return 'blocked';
  if (/\bopen\b|recommends/.test(s)) return 'open';
  return ''; // pending / queued / partial / proposal / horizon idea → neutral
}

function rmStatusChip(status) {
  if (status == null) return NR;
  return `<span class="rm-status ${rmStatusClass(status)}" title="editorial status (curated intent, not live telemetry)">${esc(status)}</span>`;
}

/* ── tags + status roll-up (shared UI with the decisions/theses tabs) ──────────
   Tags: an explicit work-item `tags:[]` field wins (future owner curation);
   otherwise the shared autoTags heuristic (app.js) derives them from the item's
   own text. Labelled orchestrator-assigned in the bar, never owner-authored. */
function rmTagsOf(item) {
  if (Array.isArray(item.tags) && item.tags.length) {
    return orderTags(item.tags.filter((x) => typeof x === 'string' && x.trim() !== ''));
  }
  const docs = Array.isArray(item.docs) ? item.docs.join(' ') : '';
  return autoTags(`${item.title || ''} ${item.one_liner || ''} ${item.status || ''} ${docs}`);
}

/* Free-text editorial status → one of four roll-up buckets. The item's EXACT
   status chip is always rendered too, so this coarse mapping never hides the
   truth. Absent/unmatched status → pending + an honest "unlabeled" flag. */
const RM_STATUS_GROUPS = [
  { id: 'in-progress', label: 'In progress', sub: 'in-flight / running / partial',        cls: 'g-run' },
  { id: 'blocked',     label: 'Blocked',     sub: 'blocked on a gate or a decision',      cls: 'g-blocked' },
  { id: 'pending',     label: 'Pending',     sub: 'queued, parked, open, or unlabeled',   cls: 'g-pending' },
  { id: 'completed',   label: 'Completed',   sub: 'done, stamped, closed, or retired',    cls: 'g-done' },
];

function rmStatusBucket(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return { bucket: 'pending', unlabeled: true };
  if (/\bdone\b|fail-?stamped|\bfail\b|stamped|retired|superseded|\bfolded\b|\bclosed\b|demoted/.test(s)) return { bucket: 'completed', unlabeled: false };
  if (/in-?flight|running|\bpartial\b|infra landed/.test(s)) return { bucket: 'in-progress', unlabeled: false };
  if (/blocked/.test(s)) return { bucket: 'blocked', unlabeled: false };
  if (/parked|ladder-gated|dormant|\bopen\b|queued|pending|proposal|un-?approved|horizon|post-monday|owner|recommend|unblocked|sequenced|committed|doctrine|designed|measured|revival|not built|incubator/.test(s)) return { bucket: 'pending', unlabeled: false };
  return { bucket: 'pending', unlabeled: true }; // ambiguous — honestly flagged, never invented
}

/** Render a set of items as collapsible status roll-up sub-groups (shared shell). */
function rmGroupedList(items, itemMap, decMap) {
  const byBucket = new Map();
  for (const it of items) {
    const { bucket } = rmStatusBucket(it.status);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(it);
  }
  const groups = RM_STATUS_GROUPS.map((g) => {
    const its = byBucket.get(g.id);
    if (!its || !its.length) return '';
    const body = `<div class="rm-list">${its.map((i) => rmItemHtml(i, itemMap, decMap)).join('')}</div>`;
    return collapsibleGroup({ cls: g.cls, collapsed: RM.collapse.has(g.id), label: g.label, count: its.length, sub: g.sub, groupAttr: 'rgroup', groupId: g.id, body });
  }).join('');
  return `<div class="rm-subgroups">${groups}</div>`;
}

function rmLiveChip(live) {
  if (!live) return `<span class="rm-live na" title="no state derivable from the registry or decisions feeds">LIVE: NOT AVAILABLE</span>`;
  const cls = { running: 'run', done: 'done', parked: 'parked', queued: 'queued', 'blocked-at-human-gate': 'gate' }[live.state] || '';
  const lbl = { running: 'RUNNING', done: 'DONE', parked: 'PARKED', queued: 'QUEUED', 'blocked-at-human-gate': 'AT HUMAN GATE' }[live.state] || String(live.state);
  return `<span class="rm-live ${cls}" title="derived from ${esc(live.src)}">LIVE: ${esc(lbl)}</span>`;
}

function rmClassChip(cls) {
  return cls === 'HUMAN-REQUIRED'
    ? '<span class="rm-cls human">HUMAN-REQUIRED</span>'
    : '<span class="rm-cls proxy">PROXY-ELIGIBLE</span>';
}

/** unlocks / dep id → chip. Known id links (and deep-opens) into the roadmap;
   unknown id renders "NOT MAPPED" (dead chip). */
function rmIdChip(id, itemMap) {
  const it = itemMap.get(id);
  if (!it) return `<span class="rm-idchip dead" title="id not present in the work-items ledger">▪ ${esc(id)} · NOT MAPPED</span>`;
  return `<a class="rm-idchip" href="#roadmap/${encodeURIComponent(id)}" title="${esc(it.title)}">▪ ${esc(it.title)}</a>`;
}

function rmNodeHtml(node, itemMap) {
  if (node.cycle) {
    return `<li class="rm-node cycle"><span class="rm-n-mark">⟲ CYCLE</span>
      <code>${esc(node.id)}</code><span class="rm-n-why">already on this path — recursion stopped, never a crash</span></li>`;
  }
  if (!node.item) {
    return `<li class="rm-node unmapped"><span class="rm-n-mark">NOT MAPPED</span>
      <code>${esc(node.id)}</code><span class="rm-n-why">referenced dependency has no work-item entry (fail-closed → HUMAN-REQUIRED)</span></li>`;
  }
  const kids = node.children.length
    ? `<ul class="rm-tree">${node.children.map((c) => rmNodeHtml(c, itemMap)).join('')}</ul>`
    : '';
  const decCount = Array.isArray(node.item.blocked_by_decisions) ? node.item.blocked_by_decisions.length : 0;
  const decMark = decCount ? `<span class="rm-n-dec" title="${decCount} blocking decision(s)">⛔ ${decCount}</span>` : '';
  return `<li class="rm-node"><span class="rm-status ${rmStatusClass(node.item.status)} mini">${esc(node.item.status || '')}</span>
    <a class="rm-n-title" href="#roadmap/${encodeURIComponent(node.id)}">${esc(node.item.title)}</a>${decMark}${kids}</li>`;
}

function rmTreeHtml(item, itemMap) {
  const deps = Array.isArray(item.depends_on) ? item.depends_on : [];
  if (!deps.length) return '<div class="rm-none">no prerequisites — this is a root item</div>';
  const kids = deps.map((d) => rmNodeHtml(rmBuildNode(d, itemMap, [item.id]), itemMap)).join('');
  return `<ul class="rm-tree root">${kids}</ul>`;
}

function rmChk(itemId, lane, on, label) {
  return `<button type="button" class="rm-chk${on ? ' on' : ''}" data-rm-check="${esc(itemId)}" data-rm-lane="${lane}"
    role="checkbox" aria-checked="${on}" title="queue this item for the ${esc(label)} pre-flight lane">
    <span class="rm-box">${on ? '✓' : ''}</span>${esc(label)}</button>`;
}

/** Inline pre-flight verdict shown whenever a lane is checked. The red
   HUMAN-REQUIRED warning is un-bypassable: it always renders when overall is
   human-required, and the emit still records it — it is never suppressed. */
function rmPreflightPanel(item, itemMap, decMap) {
  const pf = rmPreflight(item.id, itemMap, decMap);
  const human = pf.overall === 'HUMAN-REQUIRED';
  const decRows = pf.decisions.length
    ? pf.decisions.map((d) => {
        // plain-terms gloss, if the owner-decisions ledger carries one (honest-absent otherwise)
        const full = decMap.get(d.id);
        const pt = full && full.plain_terms;
        const wim = pt && pt.what_it_means != null && String(pt.what_it_means).trim() !== '' ? String(pt.what_it_means) : null;
        return `<div class="rm-decrow ${d.classification === 'HUMAN-REQUIRED' ? 'human' : 'proxy'}">
        ${rmClassChip(d.classification)}<code>${esc(d.id)}</code>
        <span class="rm-dec-state">${d.state ? esc(d.state) : (d.found ? '' : 'UNMAPPED')}</span>
        <span class="rm-dec-why">${esc(d.reason)}</span>
        ${wim ? `<span class="rm-dec-plain" title="plain-terms summary from the owner-decisions ledger"><b>in plain terms:</b> ${esc(wim)}</span>` : ''}</div>`;
      }).join('')
    : '<div class="rm-none">no blocking decisions across this item and its prerequisites</div>';

  const hazards = [];
  if (pf.cycle) hazards.push('a dependency CYCLE was detected in the prerequisite tree');
  if (pf.unmapped.length) hazards.push(`unmapped dependency: ${pf.unmapped.map(esc).join(', ')}`);

  const warn = human
    ? `<div class="rm-warn">
        <div class="rm-warn-h">⛔ HUMAN-REQUIRED — proxy cannot clear this pre-flight</div>
        <div class="rm-warn-b">This lane touches at least one owner-gated / irreversible gate (or a fail-closed
        unmapped dependency). It is recorded in the manifest for the orchestrator, but a human must clear the
        gates below before any run. This warning cannot be bypassed from the dashboard.</div>
        ${hazards.length ? `<ul class="rm-hazards">${hazards.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      </div>`
    : `<div class="rm-ok">✓ PROXY-ELIGIBLE — every blocking decision across the tree is proxy-adjudicable; no owner-only gate detected.</div>`;

  return `<div class="rm-preflight ${human ? 'human' : 'proxy'}">
    <div class="rm-pf-head">pre-flight · walked ${pf.ids.length} item(s) in the dependency tree · overall ${rmClassChip(pf.overall)}</div>
    ${warn}
    <div class="rm-decs">${decRows}</div>
  </div>`;
}

function rmDocRefs(docs) {
  if (!Array.isArray(docs) || !docs.length) return '';
  return `<span class="rm-docrefs">${docs.map((d) => `<span class="rm-docref">${esc(d)}</span>`).join('')}</span>`;
}

function rmItemHtml(item, itemMap, decMap) {
  const open = RM.open.has(item.id);
  const chk = RM.checks.get(item.id) || { overnight: false, session: false };
  const anyChecked = !!(chk.overnight || chk.session);
  const live = rmLiveChip(rmLiveState(item, decMap));

  const decChips = (Array.isArray(item.blocked_by_decisions) && item.blocked_by_decisions.length)
    ? `<div class="rm-block"><h4>blocked by decisions</h4><div class="rm-decchips">${
        item.blocked_by_decisions.map((id) => {
          const c = rmClassifyDecision(id, decMap);
          return `<span class="rm-decchip ${c.classification === 'HUMAN-REQUIRED' ? 'human' : 'proxy'}" title="${esc(c.reason)}">${esc(id)} · ${c.classification === 'HUMAN-REQUIRED' ? 'HUMAN' : 'PROXY'}</span>`;
        }).join('')
      }</div></div>`
    : '';

  const unlocks = (Array.isArray(item.unlocks) && item.unlocks.length)
    ? `<div class="rm-block"><h4>unlocks</h4><div class="rm-idchips">${item.unlocks.map((id) => rmIdChip(id, itemMap)).join('')}</div></div>`
    : '';

  const detail = open ? `<div class="rm-detail">
      <p class="rm-oneliner">${item.one_liner != null ? esc(item.one_liner) : NR}</p>
      <div class="rm-block"><h4>transitive prerequisites — depends_on, walked client-side</h4>${rmTreeHtml(item, itemMap)}</div>
      ${decChips}
      ${unlocks}
      <div class="rm-block"><h4>source</h4>${item.source != null ? copyBtn(item.source) : NR}</div>
    </div>` : '';

  const unlabeled = rmStatusBucket(item.status).unlabeled
    ? '<span class="rm-unlabeled" title="status text did not map to a known roll-up state — placed under Pending, never invented">status: unlabeled</span>' : '';
  return `<div class="rm-item${open ? ' open' : ''}${anyChecked ? ' checked' : ''}" data-rm-id="${esc(item.id)}">
    <div class="rm-row" data-rm-toggle="${esc(item.id)}" role="button" tabindex="0" aria-expanded="${open}">
      <span class="rm-caret">▶</span>
      ${rmStatusChip(item.status)}${unlabeled}
      <span class="rm-title">${esc(item.title)}</span>
      ${rmDocRefs(item.docs)}
      ${live}
      <span class="rm-lanes">${rmChk(item.id, 'overnight', chk.overnight, 'overnight')}${rmChk(item.id, 'session', chk.session, 'current session')}</span>
    </div>
    ${tagChipsHtml(rmTagsOf(item), RM.tags, 'rtag')}
    ${anyChecked ? rmPreflightPanel(item, itemMap, decMap) : ''}
    ${detail}
  </div>`;
}

function rmTierSection(tier, items, itemMap, decMap) {
  const inTier = items.filter((i) => i && i.tier === tier.id);
  if (!inTier.length) return '';
  return `<h2 class="rule">${esc(tier.label)} · ${inTier.length} <span class="rm-tier-hint">${esc(tier.hint)}</span></h2>
    ${rmGroupedList(inTier, itemMap, decMap)}`;
}

function rmUntieredSection(items, itemMap, decMap) {
  const known = new Set(RM_TIERS.map((t) => t.id));
  const other = items.filter((i) => i && !known.has(i.tier));
  if (!other.length) return '';
  return `<h2 class="rule">other / untiered · ${other.length} <span class="rm-tier-hint">tier absent or unrecognised — shown, never hidden</span></h2>
    ${rmGroupedList(other, itemMap, decMap)}`;
}

/* ── toolbar: selected set + emit (the one write path for this tab) ─────────── */

function rmSelectedIds() {
  const out = [];
  for (const [id, v] of RM.checks) { if (v && (v.overnight || v.session)) out.push(id); }
  return out;
}

function rmToolbarHtml(items, itemMap, decMap) {
  const sel = rmSelectedIds();
  const tokenSet = ((localStorage.getItem(RM_TOKEN_KEY) || '').trim() !== '');
  let humanCount = 0;
  for (const id of sel) { const it = itemMap.get(id); if (it && rmPreflight(id, itemMap, decMap).overall === 'HUMAN-REQUIRED') humanCount++; }
  const notice = RM.notice ? `<span class="rm-notice ${RM.notice.kind === 'err' ? 'err' : 'ok'}">${esc(RM.notice.text)}</span>` : '';
  const humanNote = humanCount ? `<span class="rm-tb-human">${humanCount} of ${sel.length} selected are HUMAN-REQUIRED</span>` : '';
  return `<div class="rm-toolbar">
    <div class="rm-tb-left">
      <span class="rm-tb-count">${sel.length} selected</span>
      ${humanNote}
      ${!tokenSet ? '<span class="rm-tb-tokwarn" title="the write token is set on the Owner Decisions tab">no write token — set it on the Decisions tab</span>' : ''}
    </div>
    <div class="rm-tb-right">
      ${notice}
      <button type="button" class="rm-btn ghost" data-rm-clear ${sel.length ? '' : 'disabled'}>clear</button>
      <button type="button" class="rm-btn emit" data-rm-emit ${sel.length ? '' : 'disabled'} title="append the checked set + classification to preflight_manifests.jsonl (append-only; no execution)">emit pre-flight manifest →</button>
    </div>
  </div>`;
}

async function rmEmitPreflight() {
  const items = rmItems();
  const itemMap = rmItemMap(items);
  const decMap = rmDecisionMap();
  const sel = rmSelectedIds();
  if (!sel.length) { RM.notice = { kind: 'err', text: 'Nothing selected.' }; render(); return; }

  const token = (localStorage.getItem(RM_TOKEN_KEY) || '').trim();
  if (!token) { RM.notice = { kind: 'err', text: 'No write token — set it once on the Owner Decisions tab, then retry.' }; render(); return; }

  const selections = sel.map((id) => {
    const it = itemMap.get(id) || { id };
    const v = RM.checks.get(id) || {};
    const lanes = []; if (v.overnight) lanes.push('overnight'); if (v.session) lanes.push('current-session');
    const pf = rmPreflight(id, itemMap, decMap);
    return {
      item_id: id,
      title: it.title || null,
      tier: it.tier || null,
      lanes,
      dependency_tree_ids: pf.ids,
      unmapped_deps: pf.unmapped,
      cycle: pf.cycle,
      overall_classification: pf.overall,
      blocking_decisions: pf.decisions.map((d) => ({ id: d.id, classification: d.classification, reason: d.reason, state: d.state })),
    };
  });

  const payload = { kind: 'roadmap-preflight', client_emitted_at: new Date().toISOString(), selections };
  try {
    const r = await fetch('/api/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      RM.notice = { kind: 'ok', text: `Manifest appended — ${selections.length} item(s) recorded for the orchestrator.` };
    } else if (r.status === 401) {
      RM.notice = { kind: 'err', text: 'Token rejected (401). Re-check the token on the Decisions tab.' };
    } else {
      RM.notice = { kind: 'err', text: `Rejected (${r.status}): ${data && data.error ? data.error : 'request refused'}.` };
    }
  } catch (err) {
    RM.notice = { kind: 'err', text: `Could not reach the server: ${err && err.message ? err.message : String(err)}` };
  }
  render();
}

/* ── absent-ledger honest states ───────────────────────────────────────────── */

function rmNotPublishedHtml() {
  return `<div class="offline">
    <div class="o-badge">LEDGER NOT PUBLISHED</div>
    <p>The roadmap work-items ledger has not been published to
       <code>test_results/theses/dashboard/work_items.json</code> yet. This is the orchestrator's
       curated editorial ledger — nothing is shown rather than presenting a draft as if it were live.</p>
    <div class="o-last">the server answers 200 with an explicit empty state until the ledger is written</div>
  </div>`;
}

function rmEmptyHtml() {
  return `<div class="offline">
    <div class="o-badge">NO WORK ITEMS MAPPED</div>
    <p>The ledger is present but carries no work items. Nothing to render.</p>
  </div>`;
}

function rmLegendHtml() {
  return `<div class="rm-legend">
    <span class="rm-leg-h">legend</span>
    <span>editorial <b>status</b> = curated intent · <b>LIVE</b> = derived from registry/decisions feeds, else NOT AVAILABLE</span>
    <span><b>OVERNIGHT</b> / <b>CURRENT SESSION</b> checkboxes walk the full dependency tree and classify every
      blocking decision; HUMAN-REQUIRED gates are un-bypassable · emit records the checked set to an append-only manifest.</span>
  </div>`;
}

/** Deep-link support: #roadmap/<id> auto-opens that item (used by the decisions
   "unlocks" affordance and internal unlocks/dependency links). */
function rmApplyDeepLink(items) {
  const raw = (location.hash || '').slice(1);
  const slash = raw.indexOf('/');
  if (slash === -1 || raw.slice(0, slash) !== 'roadmap') return;
  let id = raw.slice(slash + 1);
  try { id = decodeURIComponent(id); } catch { /* keep raw */ }
  if (id && items.some((i) => i.id === id)) RM.open.add(id);
}

/* ── tab entry point (referenced by app.js RENDERERS by bare name) ──────────── */

function renderRoadmap() {
  const head = subheadHtml('roadmap');
  const st = state.feeds.roadmap;
  if (!st || st.unreachable) return head + offlineHtml('roadmap', 'roadmap work-items ledger');
  const ledger = rmLedgerState();
  if (ledger === 'not-published') return head + rmNotPublishedHtml();
  const items = rmItems();
  if (ledger === 'empty' || !items.length) return head + rmEmptyHtml();

  const itemMap = rmItemMap(items); // FULL map — dependency trees still resolve even when a dep is filtered out of the view
  const decMap = rmDecisionMap();
  rmApplyDeepLink(items);

  const intro = `<div class="rm-intro">NEXT_MOVES / ROADMAP as work items with a client-side dependency DAG.
    Expand an item for its transitive prerequisite tree; check a lane to pre-flight-classify every blocking decision
    across that tree. Absent deps render NOT MAPPED, cycles are flagged, nothing is fabricated.</div>`;

  // tag filter (display only — dep resolution always uses the full item map)
  const present = new Set();
  for (const it of items) for (const tg of rmTagsOf(it)) present.add(tg);
  const filterBar = tagFilterBar(present, RM.tags, RM.tagMode, { tag: 'rtag', mode: 'rtag-mode', clear: 'rtag-clear' });
  const shownItems = items.filter((it) => passesTagFilter(rmTagsOf(it), RM.tags, RM.tagMode));
  const filterNote = RM.tags.size
    ? `<div class="rm-filter-note"><b>${shownItems.length}</b> of ${items.length} items shown · filtering by ${[...RM.tags].map(esc).join(RM.tagMode === 'all' ? ' AND ' : ' OR ')}</div>` : '';

  const sections = RM_TIERS.map((t) => rmTierSection(t, shownItems, itemMap, decMap)).join('') + rmUntieredSection(shownItems, itemMap, decMap);
  const body = sections || '<div class="none-logged" style="padding:12px 2px">No work items match this tag filter.</div>';

  return head + intro + rmToolbarHtml(items, itemMap, decMap) + filterBar + filterNote + body + rmLegendHtml();
}

/* ── join affordance for the decisions tab (part C) ─────────────────────────
   Called by app.js decisionCard by bare name. Returns '' when the roadmap feed
   is unavailable or nothing joins — never throws, never fabricates. */
function roadmapDecisionUnlocks(decisionId) {
  const st = state.feeds.roadmap;
  if (!st || st.unreachable || !st.data) return '';
  const items = rmItems();
  if (!items.length) return '';
  const matched = items.filter((it) => Array.isArray(it.blocked_by_decisions) && it.blocked_by_decisions.includes(decisionId));
  if (!matched.length) return '';
  const titles = matched.map((m) => m.title).join(' · ');
  return `<a class="rm-unlocks" href="#roadmap/${encodeURIComponent(matched[0].id)}" title="${esc(titles)}">⇱ unlocks ${matched.length} work item${matched.length > 1 ? 's' : ''}</a>`;
}

/* ── events (own listener — coexists with app.js's global handler) ──────────── */

document.addEventListener('click', (e) => {
  const chk = e.target.closest('[data-rm-check]');
  if (chk) {
    const id = chk.dataset.rmCheck, lane = chk.dataset.rmLane;
    const cur = RM.checks.get(id) || { overnight: false, session: false };
    cur[lane] = !cur[lane];
    if (!cur.overnight && !cur.session) RM.checks.delete(id); else RM.checks.set(id, cur);
    RM.notice = null;
    render();
    return;
  }
  if (e.target.closest('[data-rm-emit]')) { rmEmitPreflight(); return; }
  if (e.target.closest('[data-rm-clear]')) { RM.checks.clear(); RM.notice = null; render(); return; }

  // ── tag filter + status roll-up collapse (mirror of decisions/theses) ──
  const rtag = e.target.closest('[data-rtag]');
  if (rtag) {
    const t = rtag.dataset.rtag;
    RM.tags.has(t) ? RM.tags.delete(t) : RM.tags.add(t);
    if (RM.tags.size < 2) RM.tagMode = 'any';
    render();
    return;
  }
  if (e.target.closest('[data-rtag-mode]')) { RM.tagMode = RM.tagMode === 'all' ? 'any' : 'all'; render(); return; }
  if (e.target.closest('[data-rtag-clear]')) { RM.tags.clear(); RM.tagMode = 'any'; render(); return; }
  const rgroup = e.target.closest('[data-rgroup]');
  if (rgroup) {
    const g = rgroup.dataset.rgroup;
    RM.collapse.has(g) ? RM.collapse.delete(g) : RM.collapse.add(g);
    render();
    return;
  }

  const tog = e.target.closest('[data-rm-toggle]');
  if (tog) {
    const id = tog.dataset.rmToggle;
    RM.open.has(id) ? RM.open.delete(id) : RM.open.add(id);
    render();
    return;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-rm-toggle]')) {
    e.preventDefault();
    e.target.click();
  }
});
