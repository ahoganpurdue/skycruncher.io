'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   CSL LEDGER — 4-tab shell. Zero dependencies, pure client-side render.

   Data resolution per feed, in order:
     1. /data/<name>.json            (live — the wiring layer's endpoint)
     2. fixture/<name>.json          (dev over http)
     3. fixture/<name>.js            (dev over file:// — fetch() is blocked on
                                      the file scheme, so the fixture also ships
                                      as a generated script wrapper)

   Honesty rules (LAW 3):
     · null → "NOT RECORDED", never blank, never a placeholder number
     · unreachable feed → explicit offline panel, never stale-pretending
     · submitter buckets are NEVER numerically merged
     · FAIL is a deliverable — steel chip, not alarm styling
     · red is reserved for one thing: a broken hash chain
   ═══════════════════════════════════════════════════════════════════════════ */

const POLL_MS = 15000;
const TOKEN_KEY = 'csl_dashboard_token'; // localStorage: the write-token pasted once by the owner

const FEEDS = {
  morning:   { live: '/api/morning',                     key: 'morning_review' },
  theses:    { live: '/data/thesis_dashboard_data.json', key: 'thesis_dashboard_data' },
  decisions: { live: '/data/owner_decisions.json',       key: 'owner_decisions' },
  tokens:    { live: '/data/token_tracker_data.json',    key: 'token_tracker_data' },
  documents: { live: '/data/docs_manifest.json',         key: 'docs_manifest' },
  roadmap:   { live: '/data/work_items.json',            key: 'work_items' },
  pools:     { live: '/data/account_pools.json',         key: 'account_pools' },
  timings:   { live: '/data/stage_timings.json',         key: 'stage_timings_data' },
  database:  { live: '/data/analytics/database_summary.json', key: 'database_summary' },
  mining:    { live: '/data/mining_dashboard_data.json', key: 'mining_dashboard_data' },
  runtelem:  { live: '/data/run_telemetry.json',         key: 'run_telemetry' },
};

const TABS = [
  { id: 'morning',   label: 'Morning Review',  feed: 'morning' },
  { id: 'theses',    label: 'Theses',          feed: 'theses' },
  { id: 'decisions', label: 'Owner Decisions', feed: 'decisions' },
  { id: 'documents', label: 'Documents',       feed: 'documents' },
  { id: 'flow',      label: 'Processing Flow', feed: null },
  { id: 'ops',       label: 'Ops Map',         feed: null },
  { id: 'roadmap',   label: 'Roadmap',         feed: 'roadmap' },
  { id: 'timings',   label: 'Stage Timings',   feed: 'timings' },
  { id: 'database',  label: 'Database',        feed: 'database' },
  { id: 'mining',    label: 'Mining',          feed: 'mining' },
  { id: 'runtelem',  label: 'Run Telemetry',   feed: 'runtelem' },
  { id: 'tokens',    label: 'Token Tracker',   feed: 'tokens' },
  { id: 'pools',     label: 'Account Pools',   feed: 'pools' },
];

const state = {
  active: 'theses',
  bucket: 'BOTH', // AI-RESEARCHER | HUMAN | BOTH — display filter only, stats stay per-bucket
  open: new Set(),
  decisionTags: new Set(),          // active tag filter chips on the Owner Decisions tab (orchestrator-assigned tags)
  decisionTagMode: 'any',           // 'any' (OR) | 'all' (AND) — how multiple selected tags combine
  decisionCollapse: new Set(['resolved']), // group ids currently collapsed; resolved/ruled collapsed by default
  childCollapse: new Set(),         // parent decision ids whose sub-tier (children[]) list is collapsed; DEFAULT expanded (not present = shown)
  thesisTags: new Set(),            // active tag filter chips on the Theses tab (orchestrator-assigned, sidecar/heuristic)
  thesisTagMode: 'any',             // 'any' (OR) | 'all' (AND)
  thesisCollapse: new Set(['pass', 'fail', 'parked']), // status groups collapsed by default (stamped verdicts folded away)
  thesisMeta: {},                   // /data/thesis_meta.json tags_by_id — orchestrator-assigned thesis tags (never in the registry)
  editing: new Map(),  // decision_id → 'answer' | 'overturn' (open editor; suppresses poll clobber)
  notice: null,        // { id, kind: 'ok'|'err', text } — transient per-card message
  responses: [],       // /data/owner_responses.json — the append-only owner-response ledger, overlaid on decisions
  acks: [],            // /data/response_acks.json — orchestrator ingestion-ack ledger; overlays an INGESTED chip on each response
  reconcile: null,     // /data/decision_reconcile.json — decision_done_propagation report; overlays a done-propagation chip. null = feed absent (honest, no chip)
  docSlug: null,       // #documents/<slug> — which snapshot the reader pane is showing (null = list view)
  docCache: new Map(), // slug → { loading, text, error } — fetched raw markdown, rendered client-side
  live: { data: null, source: null, unreachable: true }, // token-tracker "live ops" — /data/live_ops.json, else /api/morning fallback
  poolHandoffs: null,  // /data/pool_handoffs.json — derived view of the append-only handoff ledger (null = not available → honest empty state)
  feeds: {
    morning:   { data: null, source: null, lastOk: null, unreachable: true },
    theses:    { data: null, source: null, lastOk: null, unreachable: true },
    decisions: { data: null, source: null, lastOk: null, unreachable: true },
    tokens:    { data: null, source: null, lastOk: null, unreachable: true },
    documents: { data: null, source: null, lastOk: null, unreachable: true },
    roadmap:   { data: null, source: null, lastOk: null, unreachable: true },
    pools:     { data: null, source: null, lastOk: null, unreachable: true },
    timings:   { data: null, source: null, lastOk: null, unreachable: true },
    database:  { data: null, source: null, lastOk: null, unreachable: true },
    mining:    { data: null, source: null, lastOk: null, unreachable: true },
    runtelem:  { data: null, source: null, lastOk: null, unreachable: true },
  },
};

/* ── utilities ───────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const NR = '<span class="nr" title="value absent in the snapshot">NOT RECORDED</span>';

function p2(n) { return String(n).padStart(2, '0'); }

function fmtTs(iso) {
  if (iso == null) return NR;
  const d = new Date(iso);
  if (isNaN(d)) return `<span class="nr">${esc(iso)}</span>`;
  return `<span title="${esc(iso)}">${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}</span>`;
}

function fmtClock(d) { return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }

function fmtMins(n) {
  if (n == null) return NR;
  return `<span title="${esc(n)} minutes">${Math.round(n)}m</span>`;
}

function fmtTok(n) {
  if (n == null) return NR;
  const exact = Number(n).toLocaleString('en-US');
  let s;
  if (n >= 1e6) s = (n / 1e6).toFixed(1) + 'M';
  else if (n >= 1e3) s = (n / 1e3).toFixed(1) + 'k';
  else s = String(n);
  return `<span title="${exact} tokens">${s}</span>`;
}

function fmtDur(sec) {
  if (sec == null) return NR;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `<span title="${esc(sec)} s">${m ? m + 'm ' : ''}${s}s</span>`;
}

function truncHash(h, n = 10) {
  if (h == null) return NR;
  const s = String(h);
  return s.length <= 2 * n ? esc(s) : `${esc(s.slice(0, n))}…${esc(s.slice(-6))}`;
}

/* ── data layer ──────────────────────────────────────────────────────────── */

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

function loadFixtureScript(key) {
  return new Promise((resolve, reject) => {
    window.__CSL_FIXTURES__ = window.__CSL_FIXTURES__ || {};
    delete window.__CSL_FIXTURES__[key];
    const s = document.createElement('script');
    s.src = `fixture/${key}.js?t=${Date.now()}`;
    s.onload = () => {
      s.remove();
      const d = window.__CSL_FIXTURES__[key];
      d ? resolve(d) : reject(new Error(`fixture script for ${key} loaded but carried no payload`));
    };
    s.onerror = () => { s.remove(); reject(new Error(`fixture script for ${key} unreachable`)); };
    document.head.appendChild(s);
  });
}

async function refreshFeed(name) {
  const feed = FEEDS[name];
  const st = state.feeds[name];
  try {
    let data, source;
    try {
      data = await fetchJson(feed.live);
      source = 'LIVE /data';
    } catch (e1) {
      if (location.protocol === 'file:') {
        data = await loadFixtureScript(feed.key);
        source = 'DEV FIXTURE (file://)';
      } else {
        data = await fetchJson(`fixture/${feed.key}.json`);
        source = 'DEV FIXTURE';
      }
    }
    st.data = data; st.source = source; st.lastOk = new Date(); st.unreachable = false;
  } catch (err) {
    st.unreachable = true; st.data = null; st.source = null;
    console.warn(`[csl-ledger] feed '${name}' unreachable:`, err);
  }
}

async function refreshResponses() {
  // The owner-response ledger is a bare array (not the {generated_at,…} feed shape),
  // so it bypasses the FEEDS machinery. Missing endpoint (dev fixture mode) is non-fatal:
  // keep the prior list; a true server outage surfaces via the decisions feed's offline panel.
  try {
    const arr = await fetchJson('/data/owner_responses.json');
    if (Array.isArray(arr)) state.responses = arr;
  } catch { /* non-fatal — see above */ }
}

async function refreshAcks() {
  // The ingestion-ack ledger (orchestrator-appended, served graceful-empty as [])
  // also bypasses the FEEDS machinery. Missing endpoint (dev fixture mode) is
  // non-fatal: the per-response chip simply defaults to NOT YET INGESTED (honest).
  try {
    const arr = await fetchJson('/data/response_acks.json');
    if (Array.isArray(arr)) state.acks = arr;
  } catch { /* non-fatal — see above */ }
}

async function refreshReconcile() {
  // Done-propagation report for the decisions docket (decision_done_propagation.mjs
  // --out). Overlays a CONFIRM/SUGGEST/INTEGRITY chip on decision cards. Missing
  // endpoint (server without the report yet) falls back to the dev fixture, then
  // to null — a null feed shows NO chip (honest-absent), never a fabricated one.
  const ok = (d) => d && typeof d === 'object' && (Array.isArray(d.confirmed) || Array.isArray(d.suggestions));
  try {
    const d = await fetchJson('/data/decision_reconcile.json');
    if (ok(d)) { state.reconcile = d; return; }
  } catch { /* try fixture */ }
  try {
    const d = await fetchJson('fixture/decision_reconcile.json');
    if (ok(d)) { state.reconcile = d; return; }
  } catch { state.reconcile = null; }
}

async function refreshThesisMeta() {
  // Orchestrator-assigned thesis tags live OUTSIDE the hash-chained registry, in a
  // sidecar. Missing endpoint (dev/older server) is non-fatal: the theses tab then
  // falls back to the client-side autoTags() heuristic. Never fabricated.
  try {
    const d = await fetchJson('/data/thesis_meta.json');
    const map = d && typeof d === 'object' && d.tags_by_id && typeof d.tags_by_id === 'object' ? d.tags_by_id : null;
    if (map) state.thesisMeta = map;
  } catch { /* non-fatal — heuristic fallback */ }
}

async function refreshPoolHandoffs() {
  // Derived view of the append-only pool_handoffs.jsonl ledger (Account Pools
  // tab). Missing endpoint/file is non-fatal and HONEST: null → the panel says
  // the ledger is not available, never an invented empty history.
  try {
    const d = await fetchJson('/data/pool_handoffs.json');
    state.poolHandoffs = (d && typeof d === 'object' && Array.isArray(d.handoffs)) ? d : null;
  } catch { state.poolHandoffs = null; }
}

async function refreshLive() {
  // Live-ops for the Token Tracker tab. Primary = the wait-graph route
  // (/data/live_ops.json, launch−complete). If that route is absent (an older
  // server build), fall back to /api/morning's last-observed lanes — both are
  // honestly labelled at render time. True outage → offline panel.
  try {
    const d = await fetchJson('/data/live_ops.json');
    state.live = { data: d, source: 'live_ops', unreachable: false };
    return;
  } catch { /* try the fallback */ }
  try {
    const m = await fetchJson('/api/morning');
    state.live = { data: m, source: 'morning', unreachable: false };
    return;
  } catch { state.live = { data: null, source: null, unreachable: true }; }
}

async function refreshAll() {
  await Promise.all([...Object.keys(FEEDS).map(refreshFeed), refreshResponses(), refreshAcks(), refreshThesisMeta(), refreshLive(), refreshPoolHandoffs(), refreshReconcile()]);
  renderPoll();
}

/** True when the owner is mid-entry inside the panel (textarea/input focused). */
function isEditingPanel() {
  const a = document.activeElement;
  const panel = document.getElementById('panel');
  return !!(panel && a && panel.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'));
}

/** Poll-driven render: never wipe an in-progress edit or token entry on the 15s tick. */
function renderPoll() {
  if (state.active === 'decisions' && (state.editing.size > 0 || isEditingPanel())) {
    render({ skipPanel: true }); // refresh chrome (tabs/clock/foot) but leave the docket DOM intact
    return;
  }
  // reading a document: leave the reader pane in place on the poll tick so a
  // long read is not scrolled back to the top every 15s (content is static).
  if (state.active === 'documents' && state.docSlug) {
    render({ skipPanel: true });
    return;
  }
  render();
}

/* ── shared fragments ────────────────────────────────────────────────────── */

function subheadHtml(feedName) {
  const st = state.feeds[feedName];
  const gen = st.data && st.data.generated_at ? fmtTs(st.data.generated_at) : NR;
  const srcCls = st.source && st.source.startsWith('LIVE') ? '' : ' fixture';
  const src = st.unreachable
    ? '<span class="src fixture">NO SOURCE</span>'
    : `<span class="src${srcCls}">${esc(st.source)}</span>`;
  const refreshed = st.lastOk ? fmtClock(st.lastOk) : 'never';
  return `<div class="subhead">
    ${src}
    <span>snapshot generated ${gen}</span>
    <span class="spacer"></span>
    <span>refreshed ${esc(refreshed)} · polling ${POLL_MS / 1000}s</span>
  </div>`;
}

function offlineHtml(feedName, what) {
  const st = state.feeds[feedName];
  const last = st.lastOk ? `last good snapshot ${fmtClock(st.lastOk)}` : 'no snapshot this session';
  return `<div class="offline">
    <div class="o-badge">SNAPSHOT UNREACHABLE</div>
    <p>The ${esc(what)} feed could not be read. Showing nothing rather than
       pretending stale data is live. Retrying every ${POLL_MS / 1000}s.</p>
    <div class="o-last">${last}</div>
  </div>`;
}

function statusChip(status) {
  switch (status) {
    case 'PASS':      return '<span class="chip pass">✓ PASS</span>';
    case 'FAIL':      return '<span class="chip fail">✕ FAIL</span>';
    case 'FAIL-KILL': return '<span class="chip fail">✕ FAIL</span>';
    case 'RUNNING':   return '<span class="chip running"><span class="pulse"></span>RUNNING</span>';
    case 'REGISTERED':return '<span class="chip registered">◇ REGISTERED</span>';
    case 'PARKED':    return '<span class="chip parked">‖ PARKED</span>';
    default:          return `<span class="chip">${esc(status ?? 'NOT RECORDED')}</span>`;
  }
}

function verdictChip(v) {
  if (v == null) return NR;
  switch (v) {
    case 'PASS':         return '<span class="chip pass">✓ PASS</span>';
    case 'FAIL':         return '<span class="chip fail">✕ FAIL</span>';
    case 'NOT-MEASURED': return '<span class="chip">NOT MEASURED</span>';
    default:             return `<span class="chip">${esc(v)}</span>`;
  }
}

function bucketTag(cls) {
  if (cls === 'AI-RESEARCHER') return '<span class="btag ai">AI</span>';
  if (cls === 'HUMAN') return '<span class="btag human">HUMAN</span>';
  return `<span class="btag">${cls == null ? 'NOT RECORDED' : esc(cls)}</span>`;
}

function copyBtn(text, cls = 'art') {
  return `<button type="button" class="${cls}" data-copy="${esc(text)}" title="click to copy">${esc(text)}</button>`;
}

/* ── shared tag-filter + collapsible-group primitives ──────────────────────────
   Extracted so Owner Decisions, Theses, and Roadmap all render the SAME chip UI
   and collapsible sections rather than three copies. Each tab owns its own
   selected-set + mode + collapse-set in state; these helpers are pure over what
   they are handed. Tags are ALWAYS orchestrator-assigned (data field or the
   autoTags heuristic), never owner-authored — the bar says so. */

// The one shared tag vocabulary. Canonical order = render order in every bar.
const TAG_VOCAB = ['CSL', 'Project Management', 'Solver', 'Deconvolution', 'Color', 'Access', 'Testing', 'Infra', 'Atlas/Data', 'Release', 'UI/Dashboard'];

// Keyword → tag heuristic. SINGLE source of the auto-tagger (theses fall back to
// it when the sidecar lacks an id; roadmap uses it when a work-item carries no
// explicit `tags`). Deterministic, evidence-only: a tag is added only on a real
// keyword hit — nothing is invented.
const AUTO_TAG_RULES = [
  ['CSL',                /\bthesis\b|\bcsl\b|falsif|kill[- ]?clause|frozen run|pre-?regist|registry|verdict/i],
  ['Project Management', /roadmap|\bowner\b|decision|docket|proxy|sign-?off|\bledger\b|orchestrat|planning|methodolog|\bops\b/i],
  ['Solver',             /solv|plate|astromet|\bwcs\b|blind|\bscale\b|\bquad\b|anchor|\bpose\b|matched|\bsweep\b|detect|recall|\bprior\b|\bsip\b|distortion|\bcenter\b|\bfov\b|galactic|densif|reach|regime/i],
  ['Deconvolution',     /deconv|\bpsf\b|richardson|\brl\b|ring(ing)?|sharpen|vignette|flatness/i],
  ['Color',              /\bcolou?r\b|oklab|\bspcc\b|stretch|\bstf\b|nebulos|\bxyz\b|white ?balance|throughput|\bqe\b/i],
  ['Access',             /gdrive|google drive|\bupload\b|\bauth\b|credential|\bkeys?\b|oauth|permission|\br2\b|bucket|cold[- ]?tier/i],
  ['Testing',            /\btest\b|vitest|\bgate\b|regression|property-?test|coverage|\be2e\b|harness|forced_confirm|\bconfirm\b|\bverify\b|falsifier|recall denominator/i],
  ['Infra',              /\bwasm\b|arrow|\bworker\b|boundary|memcpy|\bheap\b|telemetry|\bhook\b|pipeline|decoder|decode|\bipc\b|tauri|\bbuild\b|\bport\b|layout|serial|\bperf\b|substrate/i],
  ['Atlas/Data',         /\batlas\b|gaia|\bhyg\b|catalog|sector|gazetteer|dataplane|starplates|\bingest\b|corpus|dataset|provenance/i],
  ['Release',            /releas|\bship\b|installer|deploy|publish|cutover|\bversion\b|desktop app|\bnsis\b|self-?update/i],
  ['UI/Dashboard',       /dashboard|widget|flowchart|\bui\b|\bux\b|\btab\b|\bchart\b|quiver|overlay|replay|\bdock\b|wizard|booth|\bdemo\b/i],
];

/** Heuristic auto-tags for a blob of text, in vocab order, capped for tidy chips. */
function autoTags(text) {
  const s = String(text == null ? '' : text);
  const set = new Set();
  for (const [tag, re] of AUTO_TAG_RULES) if (re.test(s)) set.add(tag);
  return TAG_VOCAB.filter((t) => set.has(t)).slice(0, 4);
}

/** Order an arbitrary tag list by the canonical vocab, unknowns alphabetical after. */
function orderTags(tags) {
  const set = new Set(tags);
  return [...TAG_VOCAB.filter((t) => set.has(t)), ...[...set].filter((t) => !TAG_VOCAB.includes(t)).sort()];
}

/** Pure filter predicate: empty selection → everything passes. */
function passesTagFilter(tags, sel, mode) {
  if (!sel || !sel.size) return true;
  const set = new Set(tags);
  if (mode === 'all') { for (const t of sel) if (!set.has(t)) return false; return true; }
  for (const t of sel) if (set.has(t)) return true; // any
  return false;
}

/** The shared filter bar (class .dfilter). `attrs` names the data-* hooks so each
   tab routes to its own state without colliding: {tag, mode, clear}. */
function tagFilterBar(present, sel, mode, attrs) {
  if (!present || !present.size) return '';
  const ordered = orderTags([...present]);
  const chips = ordered.map((t) =>
    `<button type="button" class="dfilter-chip${sel.has(t) ? ' on' : ''}" data-${attrs.tag}="${esc(t)}"
      aria-pressed="${sel.has(t)}">${esc(t)}</button>`).join('');
  const modeToggle = sel.size > 1
    ? `<button type="button" class="dfilter-mode" data-${attrs.mode} title="switch between matching ANY vs ALL selected tags">match: <b>${mode === 'all' ? 'ALL' : 'ANY'}</b></button>`
    : '';
  const clear = sel.size ? `<button type="button" class="dfilter-clear" data-${attrs.clear}>clear filter</button>` : '';
  return `<div class="dfilter">
    <span class="dfilter-lbl" title="tags are orchestrator-assigned, not owner-authored">filter by tag <span class="dfilter-note">orchestrator-assigned</span></span>
    <div class="dfilter-chips">${chips}</div>
    ${modeToggle}${clear}
  </div>`;
}

/** Per-item clickable tag chips (class .dc-tag). Clicking one toggles it in the
   tab's filter set via the named data-* attribute. */
function tagChipsHtml(tags, selSet, tagAttr) {
  if (!tags || !tags.length) return '';
  const chips = tags.map((t) => {
    const on = selSet.has(t);
    return `<button type="button" class="dc-tag${on ? ' on' : ''}" data-${tagAttr}="${esc(t)}"
      title="filter by ${esc(t)} (orchestrator-assigned tag)">${esc(t)}</button>`;
  }).join('');
  return `<div class="dc-tags">${chips}</div>`;
}

/** The shared collapsible section shell (class .dgroup). `groupAttr` names the
   data-* toggle hook so each tab drives its own collapse set. */
function collapsibleGroup(cfg) {
  const { cls = '', collapsed = false, label, count, sub = '', groupAttr, groupId, body, extra = '' } = cfg;
  // `extra` = pre-built HTML (chips) injected into the header; always visible
  // (collapsed or not) so a rollup summary reads at a glance. Default '' keeps
  // every existing caller byte-identical.
  return `<section class="dgroup ${cls}${collapsed ? ' collapsed' : ''}">
    <button type="button" class="dgroup-head" data-${groupAttr}="${esc(groupId)}" aria-expanded="${!collapsed}">
      <span class="dg-caret">▶</span>
      <span class="dg-label">${esc(label)}</span>
      <span class="dg-count">${count}</span>
      ${sub ? `<span class="dg-sub">${esc(sub)}</span>` : ''}
      ${extra ? `<span class="dg-extra">${extra}</span>` : ''}
    </button>
    <div class="dgroup-body">${body}</div>
  </section>`;
}

/* ── documents manifest + cross-linking ──────────────────────────────────── */

/** The manifest ships as an object {generated_at, docs:[…]} but tolerate a bare
 *  array too — either way return the entry list (never throws). */
function manifestDocs(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.docs)) return data.docs;
  return [];
}

/** Normalise a repo path for a tolerant compare: slashes + case + leading ./ */
function normPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.?\/+/, '').trim().toLowerCase();
}

/** Build slug→entry and normPath→entry indexes from the live manifest.
 *  Returns null when the manifest is unreachable/absent — callers then fall
 *  back to plain text (failure isolation: a missing manifest never breaks a card). */
function docIndex() {
  const st = state.feeds.documents;
  if (st.unreachable || !st.data) return null;
  const bySlug = new Map(), byPath = new Map();
  for (const e of manifestDocs(st.data)) {
    if (!e || typeof e.slug !== 'string') continue;
    bySlug.set(e.slug, e);
    if (typeof e.source_path === 'string') byPath.set(normPath(e.source_path), e);
  }
  return { bySlug, byPath };
}

/** Render a repo path: if it matches a published doc's source_path, a clickable
 *  link into the reader (#documents/<slug>); otherwise EXACTLY the prior
 *  copyable-text behaviour, unchanged. */
function pathLink(text, cls = 'art') {
  const idx = docIndex();
  const e = idx && idx.byPath.get(normPath(text));
  if (!e) return copyBtn(text, cls);
  return `<a class="doc-src ${cls === 'art' ? 'art' : ''}" href="#documents/${encodeURIComponent(e.slug)}"
    title="open snapshot: ${esc(e.title || e.slug)}"><span class="doc-glyph">▤</span>${esc(text)}<span class="doc-suffix">${esc(e.title || e.slug)}</span></a>`;
}

/** Render an explicit `docs: ["slug", …]` array as clickable chips. Unknown or
 *  (manifest-offline) slugs render as muted dead chips — never break the card. */
function docsChips(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return '';
  const idx = docIndex();
  const chips = slugs.map((sl) => {
    if (idx == null) return `<span class="doc-chip dead" title="documents manifest offline">▤ ${esc(sl)} · manifest offline</span>`;
    const e = idx.bySlug.get(sl);
    if (e) return `<a class="doc-chip" href="#documents/${encodeURIComponent(sl)}" title="${esc(e.source_path || '')}">▤ ${esc(e.title || sl)}</a>`;
    return `<span class="doc-chip dead" title="slug not present in the manifest">▤ ${esc(sl)} · not in manifest</span>`;
  }).join('');
  return `<div class="doc-chips"><span class="dcx-lbl">docs</span>${chips}</div>`;
}

/* ── tab: theses ─────────────────────────────────────────────────────────── */

function chainHtml(chain) {
  if (!chain) return `<div class="chain broken"><span class="badge">⛓ CHAIN STATE ${'NOT RECORDED'}</span></div>`;
  if (chain.verified === true) {
    return `<div class="chain">
      <span class="badge">⛓ CHAIN VERIFIED</span>
      <span><b>${chain.records != null ? esc(chain.records) : 'NOT RECORDED'}</b> records, hash-linked, append-only</span>
      <span class="hash">head <b title="${esc(chain.head_hash ?? '')}">${truncHash(chain.head_hash)}</b></span>
    </div>`;
  }
  const at = chain.break_at != null ? `#${esc(chain.break_at)}` : '(position NOT RECORDED)';
  return `<div class="chain broken">
    <span class="badge">⛓ CHAIN BROKEN AT RECORD ${at}</span>
    <span class="hash">${chain.records != null ? esc(chain.records) + ' records on file' : ''}</span>
    <span class="why">Hash linkage failed. Every record at and beyond the break is untrusted —
    treat the ledger as compromised until it re-verifies.</span>
  </div>`;
}

function bucketPanel(name, stats, theses) {
  const s = stats && stats[name];
  const running = (theses || []).filter((t) => t.submitter_class === name && t.status === 'RUNNING').length;
  const v = (x) => (x == null ? NR : `<span>${esc(x)}</span>`);
  const cls = name === 'AI-RESEARCHER' ? 'ai' : 'human';
  return `<div class="bucket-panel">
    <div class="bp-head"><span class="idsq ${cls}"></span>${esc(name)}</div>
    <div class="tiles">
      <div class="tile"><div class="lbl">lifecycles</div><div class="val">${s ? v(s.lifecycles) : NR}</div></div>
      <div class="tile"><div class="lbl"><span class="sq pass"></span>stamped pass</div><div class="val">${s ? v(s.pass) : NR}</div></div>
      <div class="tile"><div class="lbl"><span class="sq steel"></span>stamped fail</div><div class="val">${s ? v(s.fail) : NR}</div></div>
      <div class="tile"><div class="lbl"><span class="sq run"></span>running now</div><div class="val">${running}</div></div>
    </div>
  </div>`;
}

function thesisRow(t) {
  const open = state.open.has(t.id);
  const kill = t.kill_clause_fired === true
    ? '<span class="kill-mark" title="kill clause fired — pre-registered abort machinery terminated the run">⚡ KILL</span>' : '';
  const span = `reg ${fmtTs(t.registered_at)} → ${t.status === 'RUNNING' && t.stamped_at == null
    ? '<b>in progress</b>' : `stamp ${fmtTs(t.stamped_at)}`}`;
  const est = t.time_budget ? t.time_budget.est_wall_minutes : null;
  const lane = t.time_budget && t.time_budget.lane ? ` <span class="lane">${esc(t.time_budget.lane)}</span>` : '';
  let time = `est ${fmtMins(est)} · act ${fmtMins(t.actual_wall_minutes)}`;
  if (est != null && t.actual_wall_minutes != null && est > 0) {
    const d = Math.round((t.actual_wall_minutes / est - 1) * 100);
    time += ` <span class="${d > 0 ? 'over' : ''}">(${d >= 0 ? '+' : ''}${d}%)</span>`;
  }
  return `<div class="thesis-row${open ? ' open' : ''}" data-toggle="${esc(t.id)}" role="button" tabindex="0"
       aria-expanded="${open}">
    <span>${statusChip(t.status)}</span>
    <span class="t-id">${esc(t.id)}</span>
    <span class="t-main">
      <span class="t-title">${esc(t.title)}${kill}</span>
      <span class="t-meta"><span class="t-span">${span}</span><span class="t-time">${time}${lane}</span></span>
      ${tagChipsHtml(thesisTagsOf(t), state.thesisTags, 'ttag')}
    </span>
    <span>${bucketTag(t.submitter_class)}</span>
    <span class="t-chev">▶</span>
  </div>${open ? thesisDetail(t) : ''}`;
}

function thesisDetail(t) {
  const crits = Array.isArray(t.criteria) && t.criteria.length
    ? t.criteria.map((c) => `<div class="crit">
        <span class="pid">${esc(c.id ?? '?')}</span>${verdictChip(c.verdict)}
        <span class="csum">${c.summary != null ? esc(c.summary) : NR}</span>
      </div>`).join('')
    : `<div class="none-logged">${Array.isArray(t.criteria) ? 'NONE LOGGED' : 'NOT RECORDED'}</div>`;

  const devs = Array.isArray(t.deviations)
    ? (t.deviations.length
        ? `<ul class="dev-list">${t.deviations.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
        : '<div class="none-logged">NONE LOGGED — clean run</div>')
    : `<div class="none-logged">NOT RECORDED</div>`;

  const killBanner = t.kill_clause_fired === true
    ? `<div class="kill-banner"><b>⚡ KILL CLAUSE FIRED</b> — the pre-registered abort machinery
       terminated this run exactly as specified. This is the safety system working, not an error.</div>` : '';

  const arts = Array.isArray(t.artifacts) && t.artifacts.length
    ? t.artifacts.map((a) => pathLink(a)).join('')
    : `<div class="none-logged">${Array.isArray(t.artifacts) ? 'NONE LOGGED' : 'NOT RECORDED'}</div>`;

  const linkedDocs = docsChips(t.docs);

  return `<div class="thesis-detail">
    <div>
      <div class="block"><h3>criteria — frozen at registration</h3>${crits}</div>
      <div class="block"><h3>deviations — verbatim</h3>${devs}</div>
    </div>
    <div>
      ${killBanner}
      <div class="block"><h3>verdict</h3>
        <p class="verdict-p">${t.verdict_summary != null ? esc(t.verdict_summary) : NR}</p></div>
      <div class="block"><h3>artifacts — local paths, click to copy · ▤ = published snapshot</h3>${arts}</div>
      ${linkedDocs ? `<div class="block"><h3>linked documents</h3>${linkedDocs}</div>` : ''}
      <div class="block"><h3>registry hash</h3>
        <div class="hashline">${t.registry_hash != null ? copyBtn(t.registry_hash) : NR}</div></div>
    </div>
  </div>`;
}

/* Orchestrator-assigned tags for a thesis: sidecar (thesis_meta.json) first, else
   the shared autoTags heuristic over title + verdict summary. Registry stays
   untouched — tags never live in the hash-chained ledger. */
function thesisTagsOf(t) {
  const meta = state.thesisMeta && state.thesisMeta[t.id];
  if (meta && Array.isArray(meta.tags) && meta.tags.length) {
    return orderTags(meta.tags.filter((x) => typeof x === 'string' && x.trim() !== ''));
  }
  return autoTags(`${t.title || ''} ${t.verdict_summary || ''}`);
}

/* Lifecycle-status → collapsible group. Running + registered open; stamped
   verdicts (PASS/FAIL) collapsed with counts. Order here = render order. */
const THESIS_STATUS_GROUPS = [
  { id: 'running',    label: 'Running now',  sub: 'frozen run in flight',                          cls: 'g-run',     match: (s) => s === 'RUNNING' },
  { id: 'registered', label: 'Registered',   sub: 'criteria frozen — awaiting its run',            cls: 'g-reg',     match: (s) => s === 'REGISTERED' },
  { id: 'partial',    label: 'Partial',      sub: 'a pre-declared partial boundary was reached',   cls: 'g-partial', match: (s) => s === 'PARTIAL' },
  { id: 'pass',       label: 'Stamped PASS', sub: 'survived falsification',                        cls: 'g-pass',    match: (s) => s === 'PASS' },
  { id: 'fail',       label: 'Stamped FAIL', sub: 'a completed deliverable — falsification is the product', cls: 'g-fail', match: (s) => s === 'FAIL' || s === 'FAIL-KILL' },
  { id: 'parked',     label: 'Parked',       sub: 'deferred, not stamped',                         cls: 'g-parked',  match: (s) => s === 'PARKED' },
];

function thesisStatusGroupOf(status) {
  const s = String(status || '').toUpperCase();
  for (const g of THESIS_STATUS_GROUPS) if (g.match(s)) return g.id;
  return 'other';
}

/* ── proposal-pipeline strip (lifecycle funnel) ──────────────────────────────
   Banked draft → pre-registered (criteria frozen) → running (frozen run) →
   stamped verdict. Every count traces to d.drafts[] / d.theses[]. Counts are
   ALWAYS split by submitter bucket and NEVER pooled into one cross-bucket number
   (CONTRACT: buckets are never numerically merged); a submitter_class-less node
   is surfaced in its own UNCLASSIFIED pill, never silently folded into either
   bucket. Empty stages render 0 honestly. Note: the registry maps PRE-REGISTERED
   → REGISTERED (pinned in snapshot.mjs); the 'Pre-registered' stage below is that
   REGISTERED cohort — criteria frozen, awaiting its frozen run. */
const PIPELINE_STAGES = [
  { id: 'draft',      label: 'Drafted',        sub: 'banked · pre-registration',        cls: 'ps-draft',
    isDraft: true,  draftMatch: (dr) => String(dr.status || '').toUpperCase() !== 'PARKED' },
  { id: 'registered', label: 'Pre-registered', sub: 'criteria frozen · awaiting run',    cls: 'ps-reg',
    match: (s) => s === 'REGISTERED' },
  { id: 'running',    label: 'Running',        sub: 'frozen run in flight',              cls: 'ps-run',
    match: (s) => s === 'RUNNING' },
  { id: 'stamped',    label: 'Stamped',        sub: 'verdict recorded (pass/fail/partial)', cls: 'ps-stamp',
    match: (s) => s === 'PASS' || s === 'FAIL' || s === 'FAIL-KILL' || s === 'PARTIAL' },
];
const PIPE_BUCKETS = [
  { id: 'AI-RESEARCHER', cls: 'ai',    short: 'ai' },
  { id: 'HUMAN',         cls: 'human', short: 'human' },
];
function pipeBucketOf(n) {
  const s = n && n.submitter_class;
  return s === 'AI-RESEARCHER' ? 'AI-RESEARCHER' : s === 'HUMAN' ? 'HUMAN' : 'UNCLASSIFIED';
}
function thesisPipelineHtml(d) {
  const theses = Array.isArray(d.theses) ? d.theses : [];
  const drafts = Array.isArray(d.drafts) ? d.drafts : [];
  const cells = PIPELINE_STAGES.map((sg) => {
    const counts = { 'AI-RESEARCHER': 0, 'HUMAN': 0, 'UNCLASSIFIED': 0 };
    if (sg.isDraft) {
      for (const dr of drafts) if (sg.draftMatch(dr)) counts[pipeBucketOf(dr)]++;
    } else {
      for (const t of theses) if (sg.match(String(t.status || '').toUpperCase())) counts[pipeBucketOf(t)]++;
    }
    const total = counts['AI-RESEARCHER'] + counts['HUMAN'] + counts['UNCLASSIFIED'];
    const pills = PIPE_BUCKETS.map((b) =>
      `<span class="pp-b ${b.cls}" title="${counts[b.id]} ${esc(b.id)}">${b.short} ${counts[b.id]}</span>`).join('');
    const uncl = counts['UNCLASSIFIED']
      ? `<span class="pp-b uncl" title="${counts['UNCLASSIFIED']} unclassified — submitter_class absent, never pooled into a bucket">? ${counts['UNCLASSIFIED']}</span>`
      : '';
    return `<div class="pp-stage ${sg.cls}">
      <div class="pp-h"><span class="pp-label">${esc(sg.label)}</span><span class="pp-total">${total}</span></div>
      <div class="pp-sub">${esc(sg.sub)}</div>
      <div class="pp-bucks">${pills}${uncl}</div>
    </div>`;
  }).join('<span class="pp-arrow" aria-hidden="true">›</span>');
  return `<div class="pipeline">
    <div class="pp-lead">proposal pipeline <span class="pp-note">counts split by submitter bucket — never pooled</span></div>
    <div class="pp-row">${cells}</div>
  </div>`;
}

function renderTheses() {
  const st = state.feeds.theses;
  if (st.unreachable) return subheadHtml('theses') + offlineHtml('theses', 'thesis registry');
  const d = st.data;
  const stats = d.stats && d.stats.by_bucket;
  const theses = Array.isArray(d.theses) ? [...d.theses] : [];
  theses.sort((a, b) => String(b.registered_at ?? '').localeCompare(String(a.registered_at ?? '')));
  const shown = state.bucket === 'BOTH' ? theses : theses.filter((t) => t.submitter_class === state.bucket);

  const buckets = state.bucket === 'BOTH'
    ? `<div class="buckets">${bucketPanel('AI-RESEARCHER', stats, theses)}${bucketPanel('HUMAN', stats, theses)}</div>`
    : `<div class="buckets single">${bucketPanel(state.bucket, stats, theses)}</div>`;

  const toggle = `<div class="bucket-toggle" role="group" aria-label="submitter bucket filter">
    ${['AI-RESEARCHER', 'HUMAN', 'BOTH'].map((b) =>
      `<button type="button" data-bucket="${b}" class="${state.bucket === b ? 'on' : ''}">${b === 'BOTH' ? 'both — side by side' : b}</button>`).join('')}
  </div>`;

  // tag filter over the bucket-filtered set (chips reflect what is actually present)
  const present = new Set();
  for (const t of shown) for (const tg of thesisTagsOf(t)) present.add(tg);
  const filterBar = tagFilterBar(present, state.thesisTags, state.thesisTagMode, { tag: 'ttag', mode: 'ttag-mode', clear: 'ttag-clear' });
  const tagged = shown.filter((t) => passesTagFilter(thesisTagsOf(t), state.thesisTags, state.thesisTagMode));
  const filterLine = state.thesisTags.size
    ? ` · <b>${tagged.length}</b> of ${shown.length} shown`
    : '';

  // group by lifecycle status → collapsible sections
  const byGroup = new Map();
  for (const t of tagged) { const gid = thesisStatusGroupOf(t.status); if (!byGroup.has(gid)) byGroup.set(gid, []); byGroup.get(gid).push(t); }
  const boardOf = (items) => `<div class="board">${items.map(thesisRow).join('')}</div>`;
  let rows;
  if (!tagged.length) {
    rows = `<div class="none-logged" style="padding:10px 2px">${shown.length ? 'No lifecycles match this tag filter.' : 'No lifecycles recorded in this bucket.'}</div>`;
  } else {
    const known = THESIS_STATUS_GROUPS.map((g) => {
      const items = byGroup.get(g.id);
      if (!items || !items.length) return '';
      return collapsibleGroup({ cls: g.cls, collapsed: state.thesisCollapse.has(g.id), label: g.label, count: items.length, sub: g.sub, groupAttr: 'tgroup', groupId: g.id, body: boardOf(items) });
    }).join('');
    const other = byGroup.get('other');
    const otherSection = other && other.length
      ? collapsibleGroup({ cls: 'g-other', collapsed: state.thesisCollapse.has('other'), label: 'Other status', count: other.length, sub: 'status not one of the known lifecycle states — shown, never hidden', groupAttr: 'tgroup', groupId: 'other', body: boardOf(other) })
      : '';
    rows = `<div class="thesis-groups">${known}${otherSection}</div>`;
  }

  const drafts = Array.isArray(d.drafts) && d.drafts.length
    ? d.drafts.map((dr) => `<div class="draft">
        <div class="d-head">${statusChip(dr.status)}<span class="d-id">${esc(dr.id)}</span></div>
        <div class="d-title">${esc(dr.title)}</div>
        <div class="d-meta"><span class="lane">${dr.lane != null ? esc(dr.lane) : 'lane?'}</span>
          &nbsp;est <b>${dr.est_wall_minutes != null ? esc(Math.round(dr.est_wall_minutes)) + 'm' : ''}</b>${dr.est_wall_minutes == null ? NR : ''}</div>
      </div>`).join('')
    : `<div class="draft"><span class="none-logged">NONE BANKED</span></div>`;

  return `${subheadHtml('theses')}
    ${chainHtml(d.chain)}
    <h2 class="rule">per-bucket record — never pooled ${toggle}</h2>
    ${buckets}
    ${thesisPipelineHtml(d)}
    <div class="economy-note">A stamped FAIL is a completed deliverable — falsification is this registry's product.</div>
    <div class="content-grid">
      <div>
        <h2 class="rule">lifecycles — register → frozen run → stamp${filterLine}</h2>
        ${filterBar}
        ${rows}
      </div>
      <div>
        <h2 class="rule">pre-registration drafts</h2>
        <div class="drafts">${drafts}</div>
      </div>
    </div>`;
}

/* ── tab: owner decisions ────────────────────────────────────────────────── */

const DECISION_RANK = { 'OPEN': 0, 'ANSWER-PENDING': 1, 'BLOCKED': 2 };

/* Tag vocabulary is the shared TAG_VOCAB (see the tag-filter primitives above).
   Decision tags live on each owner_decisions.json entry as an additive `tags:[]`
   field; the filter bar only ever offers tags actually present on the docket. */

/* Three docket groups. `needs` = the owner's action queue (surfaced first,
   prominent, matches the masthead NEEDS-YOU badge exactly); `pending` = acted-on
   but not yet closed on the docket; `resolved` = terminal/ruled (collapsed by
   default). Order here is the render order. */
const DECISION_GROUPS = [
  { id: 'needs',    label: 'Requires your input', sub: 'blocked on you specifically — orchestrator cannot resolve these', cls: 'g-needs' },
  { id: 'pending',  label: 'In progress',         sub: 'you acted or it is mid-flight; awaiting orchestrator close-out',   cls: 'g-pending' },
  { id: 'resolved', label: 'Resolved & ruled',    sub: 'answered, ruled, proxy-decided, or informational — no action',    cls: 'g-resolved' },
];

const DECISION_TERMINAL = new Set(['ANSWERED', 'RESOLVED', 'REPOINTED', 'PROXY-RULED', 'DEPRECATED']);
const DECISION_AWAITS_OWNER = new Set(['OPEN', 'ANSWER-PENDING', 'BLOCKED']);

/* ── implementation lifecycle (additive `implementation` field) ──────────────
   A resolved/ruled decision (or a sub-tier child) MAY carry:
     implementation: { status: 'implemented'|'pending'|'owner-side'|'obsolete',
                       evidence: '<commit hash / artifact path / one-liner>',
                       updated: 'YYYY-MM-DD' }
   This splits the resolved pool so the owner can see what was RULED but not yet
   BUILT. Honest-or-absent (LAW 3): a missing / unreadable / unrecognised field —
   AND status 'pending' — land in 'awaiting', NEVER silently in 'implemented'.
   A parent's bucket reads its OWN field only; it is never inferred from its
   children (children carry their own implementation field independently). */
const IMPL_BUCKETS = [
  { id: 'implemented', label: 'implemented', chip: 'IMPLEMENTED',  cls: 'impl-done' },
  { id: 'awaiting',    label: 'awaiting',    chip: 'AWAITING IMPL', cls: 'impl-await' },
  { id: 'owner-side',  label: 'owner-side',  chip: 'OWNER-SIDE',   cls: 'impl-owner' },
  { id: 'obsolete',    label: 'obsolete',    chip: 'OBSOLETE',     cls: 'impl-obsolete' },
];
const IMPL_BUCKET_BY_ID = new Map(IMPL_BUCKETS.map((b) => [b.id, b]));

/** The decision/child's implementation object, or null when absent/malformed. */
function implOf(node) {
  const impl = node && node.implementation;
  return (impl && typeof impl === 'object' && !Array.isArray(impl)) ? impl : null;
}
/** True only when a readable, non-empty implementation.status is present. */
function hasImplField(node) {
  const impl = implOf(node);
  return !!(impl && typeof impl.status === 'string' && impl.status.trim() !== '');
}
/** Implementation bucket from the node's OWN field only. 'pending' | absent |
   unreadable | unknown → 'awaiting' (never 'implemented'). */
function implBucketOf(node) {
  const impl = implOf(node);
  const st = (impl && typeof impl.status === 'string') ? impl.status.trim().toLowerCase() : '';
  if (st === 'implemented') return 'implemented';
  if (st === 'owner-side')  return 'owner-side';
  if (st === 'obsolete')    return 'obsolete';
  return 'awaiting';
}
/** A small implementation-status chip. `always=true` renders the honest
   'AWAITING IMPL' chip even with no field (used on resolved cards so an
   unrecorded ruling is visibly flagged, never blank); otherwise absent → ''. */
function implChip(node, always) {
  const present = hasImplField(node);
  if (!always && !present) return '';
  const b = IMPL_BUCKET_BY_ID.get(implBucketOf(node));
  const impl = implOf(node);
  const ev = (impl && impl.evidence != null && String(impl.evidence).trim() !== '') ? String(impl.evidence) : null;
  const upd = (impl && impl.updated != null && String(impl.updated).trim() !== '') ? String(impl.updated) : null;
  const title = !present
    ? 'no implementation status recorded — treated as awaiting (honest-or-absent)'
    : `implementation: ${b.label}${ev ? ' — ' + ev : ''}${upd ? ' (updated ' + upd + ')' : ''}`;
  return `<span class="impl-chip ${b.cls}" title="${esc(title)}">${b.chip}${upd ? ` <span class="impl-upd">${esc(upd)}</span>` : ''}</span>`;
}
/** Done-propagation overlay chip (from decision_done_propagation.mjs, served at
   /data/decision_reconcile.json). Keyed by decision id + child_id (childId=null
   for the parent card). CONFIRM = a commit hash in the evidence was verified in
   git → the flip to implemented is machine-justified but still applied by hand.
   SUGGEST = a fuzzy match only ("evidence landed — confirm"), NEVER an auto-flip.
   INTEGRITY = implemented but the cited hash is not in the repo. Absent feed → ''
   (honest, no chip). Never mutates the ledger — purely advisory. */
function reconcileChip(id, childId) {
  const r = state.reconcile;
  if (!r) return '';
  const cid = childId || null;
  const match = (arr) => (Array.isArray(arr) ? arr.find((x) => x.id === id && (x.child_id || null) === cid) : null);
  const conf = match(r.confirmed);
  if (conf) {
    const h = conf.hash ? String(conf.hash).slice(0, 7) : '';
    return `<span class="rc-chip rc-confirm" title="${esc(conf.reason || '')} — apply the flip to implemented by hand (report-only)">◆ COMMIT VERIFIED${h ? ' @' + esc(h) : ''}</span>`;
  }
  const sug = match(r.suggestions);
  if (sug) {
    const subj = sug.commit && sug.commit.subject ? sug.commit.subject : '';
    return `<span class="rc-chip rc-suggest" title="${esc(sug.reason || '')}${subj ? ' — ' + esc(subj) : ''}">◇ EVIDENCE LANDED — CONFIRM</span>`;
  }
  const integ = match(r.integrity);
  if (integ) return `<span class="rc-chip rc-integrity" title="${esc(integ.reason || '')}">⚠ HASH NOT IN REPO</span>`;
  return '';
}

/** Rollup summary chips for the resolved pool: "N ruled: X implemented · Y
   awaiting · …". Only non-zero buckets render. Each decision counted by its OWN
   field (never inferred from children). */
function resolvedRollupHtml(items) {
  if (!items.length) return '';
  const counts = {};
  for (const dc of items) { const b = implBucketOf(dc); counts[b] = (counts[b] || 0) + 1; }
  const chips = IMPL_BUCKETS.filter((b) => counts[b.id]).map((b) =>
    `<span class="rrollup ${b.cls}" title="${counts[b.id]} ${b.label}">${counts[b.id]} ${b.label}</span>`).join('');
  return `<span class="rrollup-lead">${items.length} ruled:</span>${chips}`;
}
/** Implementation breakdown of a parent's children (only children that carry
   the field). "a parent's chip shows child counts" — the parent's OWN status is
   NEVER inferred from these. '' when no child carries the field. */
function childImplRollup(children) {
  const counts = {};
  for (const c of children) { if (hasImplField(c)) { const b = implBucketOf(c); counts[b] = (counts[b] || 0) + 1; } }
  return IMPL_BUCKETS.filter((b) => counts[b.id]).map((b) =>
    `<span class="crollup ${b.cls}" title="${counts[b.id]} sub-item(s) ${b.label}">${counts[b.id]} ${b.label}</span>`).join('');
}

/* Resolved-pool sub-sections, in render order. 'Awaiting' is surfaced FIRST —
   the owner's stated need is to see what was ruled but not yet built. */
const RESOLVED_SUBGROUPS = [
  { id: 'awaiting',    label: 'Ruled — awaiting implementation', cls: 'rs-await',    sub: 'you ruled; not built yet (or no implementation status recorded)' },
  { id: 'owner-side',  label: 'Owner-side',                       cls: 'rs-owner',    sub: 'ruled; the remaining step is yours, not the orchestrator’s' },
  { id: 'implemented', label: 'Implemented',                      cls: 'rs-done',     sub: 'ruled and shipped — evidence on the card' },
  { id: 'obsolete',    label: 'Obsolete',                         cls: 'rs-obsolete', sub: 'ruled but overtaken — no longer actionable' },
];
/** Body for the resolved group: cards sub-grouped by implementation bucket, each
   sub-section labelled with its own count. Empty buckets don't render (honest). */
function resolvedSubGroupedBody(items, cardOf) {
  const byBucket = { awaiting: [], 'owner-side': [], implemented: [], obsolete: [] };
  for (const dc of items) byBucket[implBucketOf(dc)].push(dc);
  return RESOLVED_SUBGROUPS.map((sg) => {
    const list = byBucket[sg.id];
    if (!list.length) return '';
    return `<div class="resolved-sub ${sg.cls}">
      <div class="rs-head"><span class="rs-label">${esc(sg.label)}</span><span class="rs-count">${list.length}</span><span class="rs-sub">${esc(sg.sub)}</span></div>
      <div class="rs-body">${list.map(cardOf).join('')}</div>
    </div>`;
  }).join('');
}

/** Which group a decision belongs to. `hasResp` = a live owner-response ledger
   entry exists for it; an embedded latest_response counts too. A decision that
   still awaits the owner AND has no response anywhere is the only thing that
   lands in `needs` (kept identical to needsYouCount so the badge never disagrees
   with the queue). */
function decisionGroupOf(dc, hasResp) {
  const st = String(dc.state || '').toUpperCase();
  const anyResp = hasResp || (dc.latest_response != null);
  if (DECISION_AWAITS_OWNER.has(st) && !anyResp) return 'needs';
  if (DECISION_TERMINAL.has(st)) return 'resolved';
  return 'pending';
}

function decisionTags(dc) {
  return Array.isArray(dc.tags) ? dc.tags.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
}

function decisionStateChip(s) {
  switch (s) {
    case 'OPEN':           return '<span class="chip open-state">● OPEN</span>';
    case 'ANSWER-PENDING': return '<span class="chip pending">◔ ANSWER-PENDING</span>';
    case 'BLOCKED':        return '<span class="chip blocked">‖ BLOCKED</span>';
    default:               return `<span class="chip">${s == null ? 'NOT RECORDED' : esc(s)}</span>`;
  }
}

/* response overlay — read from the append-only ledger, never fabricated */

const RESP_LABEL = { approve: '✓ APPROVED', overturn: '⊘ OVERTURNED', answer: '✎ ANSWERED', park: '⏸ PARKED', proxy: '⇄ KICKED TO PROXY' /* PROXY-KICK */ };

function respChip(action) {
  const cls = { approve: 'resp-approve', overturn: 'resp-overturn', answer: 'resp-answer', park: 'resp-park', proxy: 'resp-proxy' /* PROXY-KICK */ }[action];
  const lbl = RESP_LABEL[action];
  if (!cls) return `<span class="chip">${esc(action ?? 'NOT RECORDED')}</span>`;
  return `<span class="chip ${cls}">${lbl}</span>`;
}

/* ingestion-ack overlay — an INGESTED chip driven by the orchestrator's
   append-only response_acks ledger. A response is "ingested" when an ack line
   matches it on BOTH decision_id and response_ts (the response's own ts). */
function ackKeySet(acks) {
  const s = new Set();
  for (const a of Array.isArray(acks) ? acks : []) {
    if (a && typeof a.decision_id === 'string' && a.response_ts != null) {
      s.add(a.decision_id + ' ' + a.response_ts);
    }
  }
  return s;
}

function isResponseAcked(resp, ackKeys) {
  if (!resp || resp.decision_id == null || resp.ts == null) return false;
  return ackKeys.has(resp.decision_id + ' ' + resp.ts);
}

/* plain-terms block — an optional owner-readable gloss on a decision. Rendered
   FIRST on the card (before the technical summary/rec), visually distinct. The
   whole block, and each row, is honest-absent: nothing renders when the field
   or a sub-field is missing/empty. */
function plainTermsBlock(pt) {
  if (!pt || typeof pt !== 'object') return '';
  const clean = (v) => (v != null && String(v).trim() !== '') ? String(v) : null;
  const wim = clean(pt.what_it_means);
  const iy  = clean(pt.if_yes);
  const ino = clean(pt.if_no);
  const cw  = clean(pt.cost_of_wrong);
  if (!wim && !iy && !ino && !cw) return ''; // honest-absent — no placeholder
  const row = (lbl, val, cls) => val
    ? `<div class="pt-row ${cls}"><span class="pt-k">${lbl}</span><span class="pt-v">${esc(val)}</span></div>` : '';
  return `<div class="pt-block">
    <span class="pt-badge" title="plain-terms summary — the technical detail follows below">IN PLAIN TERMS</span>
    ${wim ? `<p class="pt-lede">${esc(wim)}</p>` : ''}
    ${row('if yes', iy, 'yes')}
    ${row('if no', ino, 'no')}
    ${row('cost if wrong', cw, 'cost')}
  </div>`;
}

/** Fold the ledger to the latest PARENT-scoped response per decision + a count.
   Rows carrying a child_id are sub-tier responses (see foldChildResponses); they
   are EXCLUDED here so a child ruling never masquerades as the parent's — the
   "never cascade silently" rule. Legacy rows have no child_id, so this is a
   no-op for every existing line. */
function foldResponses(list) {
  const byId = new Map(), countById = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.decision_id !== 'string') continue;
    if (typeof r.child_id === 'string' && r.child_id.trim() !== '') continue; // child-scope → not a parent response
    byId.set(r.decision_id, r); // append order → last write is current
    countById.set(r.decision_id, (countById.get(r.decision_id) || 0) + 1);
  }
  return { byId, countById };
}

/* ── sub-tier (children[]) helpers ───────────────────────────────────────────
   A decision may carry an additive `children:[{id,title,summary,state,
   recommendation?,latest_response?}]`. Each child gets the SAME action set as a
   parent; child responses reuse the parent decision_id and add child_id. All of
   this is honest-absent: no children[] → nothing below renders, exactly the
   prior behavior. */

// Map/notice/editing key for a child editor (never emitted into the DOM — used
// only as a JS key + compared in noticeHtml; the delimiter just has to be
// collision-free vs real ids).
function childScopeKey(pid, cid) { return JSON.stringify(['scope', pid, cid]); }
// Ledger-fold key for a child response.
function childRespKey(pid, cid) { return JSON.stringify([pid, cid]); }

/** Fold ONLY child-scoped response rows → latest per (decision_id, child_id) +
   a count. Parent-scope rows (no child_id) are ignored (they belong above). */
function foldChildResponses(list) {
  const byKey = new Map(), countByKey = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.decision_id !== 'string') continue;
    if (typeof r.child_id !== 'string' || r.child_id.trim() === '') continue; // parent-scope → skip
    const k = childRespKey(r.decision_id, r.child_id);
    byKey.set(k, r); // append order → last write is current
    countByKey.set(k, (countByKey.get(k) || 0) + 1);
  }
  return { byKey, countByKey };
}

/* Effective sub-item status bucket for the rollup summary. A live ledger
   response wins; an embedded latest_response counts too; otherwise the child's
   declared state. Honest — never fabricated. */
const CHILD_BUCKETS = [
  { id: 'open',     label: 'open',     cls: 'cb-open' },
  { id: 'answered', label: 'answered', cls: 'cb-answered' },
  { id: 'parked',   label: 'parked',   cls: 'cb-parked' },
  { id: 'proxy',    label: 'to proxy', cls: 'cb-proxy' },
  { id: 'resolved', label: 'resolved', cls: 'cb-resolved' },
];
function childEffectiveResp(child, resp) {
  if (resp) return resp;
  return (child && child.latest_response != null && typeof child.latest_response === 'object') ? child.latest_response : null;
}
function childBucket(child, resp) {
  const r = childEffectiveResp(child, resp);
  if (r && r.action) {
    if (r.action === 'park') return 'parked';
    if (r.action === 'proxy') return 'proxy';
    return 'answered'; // approve | answer | overturn
  }
  const st = String((child && child.state) || '').toUpperCase();
  if (DECISION_TERMINAL.has(st)) return 'resolved';
  return 'open'; // OPEN / ANSWER-PENDING / BLOCKED / unknown → awaiting the owner
}

/** Rollup chips summarizing the sub-tier (e.g. "3 open · 4 answered · 2 parked").
   Only non-zero buckets render; empty → an honest "no sub-items" pill. */
function childRollupChips(children, childFold, pid) {
  const counts = {};
  for (const c of children) {
    const cid = c && typeof c.id === 'string' ? c.id : null;
    const resp = cid != null ? (childFold.byKey.get(childRespKey(pid, cid)) || null) : null;
    const b = childBucket(c, resp);
    counts[b] = (counts[b] || 0) + 1;
  }
  const chips = CHILD_BUCKETS.filter((b) => counts[b.id]).map((b) =>
    `<span class="crollup ${b.cls}" title="${counts[b.id]} sub-item(s): ${b.label}">${counts[b.id]} ${b.label}</span>`).join('');
  return chips || '<span class="crollup cb-none">no sub-items</span>';
}

/** Per-child action controls — mirrors decisionControls, child-scoped. Child
   buttons carry data-pid/data-cid so the handler posts a child_id response;
   answer/overturn open a scoped editor. A child with no usable id is not
   actionable (honest — a response cannot be scoped without one). */
function childControls(dc, child) {
  const pid = dc.id, cid = child.id;
  const scope = childScopeKey(pid, cid);
  const editing = state.editing.get(scope);
  if (editing === 'answer' || editing === 'overturn') {
    const isOv = editing === 'overturn';
    return `<div class="dc-editor child" data-ceditor="${esc(scope)}">
      <textarea class="dc-ta" data-cta="${esc(scope)}" rows="3"
        placeholder="${isOv ? 'reason for overturning the recommendation (required)' : 'your answer / ruling (required)'}"></textarea>
      <div class="dc-editor-row">
        <button type="button" class="dc-btn ${isOv ? 'ov' : 'ans'}" data-csubmit="1" data-pid="${esc(pid)}" data-cid="${esc(cid)}" data-act="${editing}">submit ${isOv ? 'overturn' : 'answer'}</button>
        <button type="button" class="dc-btn ghost" data-ccancel="1" data-pid="${esc(pid)}" data-cid="${esc(cid)}">cancel</button>
        <span class="dc-hint">${isOv ? 'overturn requires a note' : 'Ctrl/⌘+Enter to submit'}</span>
      </div>
    </div>`;
  }
  const noRec = child.recommendation == null;
  return `<div class="dc-controls child">
    <button type="button" class="dc-btn approve" data-cdo="approve" data-pid="${esc(pid)}" data-cid="${esc(cid)}"
      ${noRec ? 'disabled title="no recommendation to approve — use Answer to record your ruling"'
              : 'title="approve the recommendation as written"'}>✓ Approve</button>
    <button type="button" class="dc-btn ans" data-cedit="answer" data-pid="${esc(pid)}" data-cid="${esc(cid)}" title="write an answer / ruling">✎ Answer</button>
    <button type="button" class="dc-btn ov" data-cedit="overturn" data-pid="${esc(pid)}" data-cid="${esc(cid)}" title="overturn the recommendation (note required)">⊘ Overturn</button>
    <button type="button" class="dc-btn park" data-cdo="park" data-pid="${esc(pid)}" data-cid="${esc(cid)}" title="park — defer without a ruling">⏸ Park</button>
    <button type="button" class="dc-btn proxy" data-cdo="proxy" data-pid="${esc(pid)}" data-cid="${esc(cid)}" title="kick this sub-item to the owner-proxy">⇄ Proxy</button>
  </div>`;
}

/** One sub-item row: state + response overlay + summary/rec + its own controls. */
function childRow(dc, child, childFold, ackKeys) {
  const pid = dc.id;
  const cidValid = child && typeof child.id === 'string' && child.id.trim() !== '';
  const cid = cidValid ? child.id : null;
  const key = cid != null ? childRespKey(pid, cid) : null;
  const resp = key != null ? (childFold.byKey.get(key) || null) : null;
  const count = key != null ? (childFold.countByKey.get(key) || 0) : 0;
  const shownResp = childEffectiveResp(child, resp);
  const acked = resp ? isResponseAcked(resp, ackKeys) : false; // ack matched on decision_id+ts (ts is effectively unique)
  const title = child && child.title != null ? esc(child.title) : NR;
  const summary = child && child.summary != null && String(child.summary).trim() !== ''
    ? `<p class="cr-summary">${esc(child.summary)}</p>` : '';
  const rec = child && child.recommendation != null
    ? `<div class="rec child"><span class="r-lbl">rec →</span>${esc(child.recommendation)}</div>` : '';
  return `<div class="child-row state-${esc(String((child && child.state) || 'unknown').toLowerCase())}${shownResp ? ' responded' : ''}">
    <div class="cr-head">
      ${decisionStateChip(child && child.state)}
      ${shownResp ? respChip(shownResp.action) : ''}
      ${implChip(child, false) /* child carries its OWN implementation field — honest-absent */}
      <span class="cr-id">${cid != null ? esc(cid) : 'NO ID'}</span>
      <span class="cr-title">${title}</span>
    </div>
    ${summary}
    ${rec}
    ${shownResp ? responseBlock(shownResp, resp ? count : 0, acked) : ''}
    ${cid != null ? noticeHtml(childScopeKey(pid, cid)) : ''}
    ${cid != null ? childControls(dc, child)
                  : '<div class="cr-noaction">sub-item has no id — not actionable (a response cannot be scoped without one)</div>'}
  </div>`;
}

/** The expandable sub-tier block under a parent card. No children[] → '' (prior
   behavior). Malformed children[] → an honest note, never a crash. */
function childrenSection(dc, childFold, ackKeys) {
  if (dc.children === undefined || dc.children === null) return ''; // no sub-tier → exactly prior behavior
  if (!Array.isArray(dc.children)) {
    return '<div class="children-block malformed"><div class="cr-noaction">sub-items field present but is not a list — nothing to show (honest fallback)</div></div>';
  }
  if (dc.children.length === 0) return ''; // empty list = no sub-tier
  const children = dc.children.filter((c) => c && typeof c === 'object');
  if (children.length === 0) {
    return '<div class="children-block malformed"><div class="cr-noaction">sub-items present but unreadable — nothing to show (honest fallback)</div></div>';
  }
  const pid = dc.id;
  const collapsed = state.childCollapse.has(pid);
  const rollup = childRollupChips(children, childFold, pid);
  const implRollup = childImplRollup(children); // '' unless a child carries an implementation field
  const body = collapsed ? ''
    : `<div class="children-list">${children.map((c) => childRow(dc, c, childFold, ackKeys)).join('')}</div>`;
  const n = children.length;
  return `<div class="children-block">
    <div class="children-head" data-cchild-toggle="${esc(pid)}" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="ctog">${collapsed ? '▸' : '▾'}</span>
      <span class="clbl">${n} sub-item${n === 1 ? '' : 's'}</span>
      <span class="crollup-wrap">${rollup}${implRollup ? `<span class="crollup-sep" title="implementation status of sub-items">·</span>${implRollup}` : ''}</span>
    </div>
    ${body}
  </div>`;
}

function ackChip(acked) {
  return acked
    ? '<span class="rp-ack ingested" title="the orchestrator has marked this response ingested (response_acks ledger)">INGESTED ✓</span>'
    : '<span class="rp-ack pending" title="not yet marked ingested by the orchestrator — honest default">NOT YET INGESTED</span>';
}

function responseBlock(resp, count, acked) {
  const note = resp.note != null && String(resp.note).trim() !== ''
    ? `<div class="rp-note">${esc(resp.note)}</div>`
    : '<div class="rp-note none">no note recorded</div>';
  const multi = count > 1
    ? ` <span class="rp-multi" title="${count} responses on the append-only ledger — latest shown">${count} on ledger · latest</span>` : '';
  return `<div class="dc-response">
    <div class="rp-head">${respChip(resp.action)}${ackChip(acked)}<span class="rp-ts">${fmtTs(resp.ts)}</span>
      <span class="rp-via">via ${esc(resp.via ?? 'dashboard')}</span>${multi}</div>
    ${note}
  </div>`;
}

function decisionControls(dc) {
  const id = dc.id;
  const editing = state.editing.get(id);
  if (editing === 'answer' || editing === 'overturn') {
    const isOv = editing === 'overturn';
    return `<div class="dc-editor" data-editor="${esc(id)}">
      <textarea class="dc-ta" data-ta="${esc(id)}" rows="3"
        placeholder="${isOv ? 'reason for overturning the recommendation (required)' : 'your answer / ruling (required)'}"></textarea>
      <div class="dc-editor-row">
        <button type="button" class="dc-btn ${isOv ? 'ov' : 'ans'}" data-submit="${esc(id)}" data-act="${editing}">submit ${isOv ? 'overturn' : 'answer'}</button>
        <button type="button" class="dc-btn ghost" data-cancel="${esc(id)}">cancel</button>
        <span class="dc-hint">${isOv ? 'overturn requires a note' : 'Ctrl/⌘+Enter to submit'}</span>
      </div>
    </div>`;
  }
  const noRec = dc.recommendation == null;
  return `<div class="dc-controls">
    <button type="button" class="dc-btn approve" data-do="approve" data-id="${esc(id)}"
      ${noRec ? 'disabled title="no recommendation to approve — use Answer to record your ruling"'
              : 'title="approve the recommendation as written"'}>✓ Approve</button>
    <button type="button" class="dc-btn ans" data-edit="answer" data-id="${esc(id)}" title="write an answer / ruling">✎ Answer</button>
    <button type="button" class="dc-btn ov" data-edit="overturn" data-id="${esc(id)}" title="overturn the recommendation (note required)">⊘ Overturn</button>
    <button type="button" class="dc-btn park" data-do="park" data-id="${esc(id)}" title="park — defer without a ruling">⏸ Park</button>
    ${window.ProxyKick ? window.ProxyKick.buttonHtml(id, dc) : '' /* PROXY-KICK: kick out-of-domain decision to the owner-proxy (reuses [data-do] → postResponse) */}
  </div>`;
}

function noticeHtml(id) {
  if (!state.notice || state.notice.id !== id) return '';
  return `<div class="dc-notice ${state.notice.kind === 'err' ? 'err' : 'ok'}">${esc(state.notice.text)}</div>`;
}

/* Per-card tag chips (orchestrator-assigned). Clicking one adds it to the filter
   bar. Active tags render highlighted so the card shows why it matched. */
function decisionTagsHtml(dc) {
  return tagChipsHtml(decisionTags(dc), state.decisionTags, 'dtag');
}

function decisionCard(dc, resp, count, acked, childFold, ackKeys) {
  let blocks;
  if (Array.isArray(dc.blocking)) {
    blocks = dc.blocking.length
      ? `<ul>${dc.blocking.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
      : '<div class="nothing">nothing recorded as blocked — informational item</div>';
  } else if (dc.blocking != null) {
    blocks = `<ul><li>${esc(dc.blocking)}</li></ul>`;
  } else {
    blocks = `<div class="nothing">${'NOT RECORDED'}</div>`;
  }
  const rec = dc.recommendation != null
    ? `<div class="rec"><span class="r-lbl">rec →</span>${esc(dc.recommendation)}</div>`
    : `<div class="rec"><span class="r-lbl">rec →</span>${NR}</div>`;
  const responded = resp ? ' responded' : '';
  // On a resolved/ruled card, always surface an implementation chip (awaiting is
  // flagged even when unrecorded); elsewhere only when the field is present.
  const isResolved = DECISION_TERMINAL.has(String(dc.state || '').toUpperCase());
  const implTag = implChip(dc, isResolved);
  const dimmed = isResolved && implBucketOf(dc) === 'obsolete' ? ' impl-dimmed' : '';
  return `<div class="decision state-${esc(String(dc.state || 'unknown').toLowerCase())}${responded}${dimmed}">
    <div class="dc-head">
      ${decisionStateChip(dc.state)}
      ${resp ? respChip(resp.action) : ''}
      ${implTag}
      ${reconcileChip(dc.id, null)}
      <span class="cat">${dc.category != null ? esc(dc.category) : 'NOT RECORDED'}</span>
      <span class="dc-id">${esc(dc.id ?? '')}</span>
      <span class="dc-title">${dc.title != null ? esc(dc.title) : NR}</span>
    </div>
    ${decisionTagsHtml(dc)}
    ${plainTermsBlock(dc.plain_terms)}
    <p class="dc-summary">${dc.summary != null ? esc(dc.summary) : NR}</p>
    <div class="blocks"><span class="b-lbl">blocks</span>${blocks}</div>
    ${rec}
    ${docsChips(dc.docs)}
    <div class="dc-foot">
      <span class="asked">asked ${fmtTs(dc.asked_on)}</span>
      ${dc.source != null ? pathLink(dc.source, 'art') : `<span class="asked">source ${NR}</span>`}
      ${typeof roadmapDecisionUnlocks === 'function' ? roadmapDecisionUnlocks(dc.id) : ''}
    </div>
    ${resp ? responseBlock(resp, count, acked) : ''}
    ${resp && resp.action === 'proxy' && window.ProxyKick ? window.ProxyKick.derivedBanner(resp, dc) : '' /* PROXY-KICK: from-ledger kicked state, re-derived every poll */}
    ${noticeHtml(dc.id)}
    ${decisionControls(dc)}
    ${childrenSection(dc, childFold || { byKey: new Map(), countByKey: new Map() }, ackKeys || new Set())}
  </div>`;
}

function tokenBar() {
  const tok = (localStorage.getItem(TOKEN_KEY) || '').trim();
  const set = tok !== '';
  const masked = set ? esc(tok.slice(0, 4) + '…' + tok.slice(-4)) : '';
  return `<div class="token-bar">
    <span class="tb-lbl">WRITE&nbsp;TOKEN</span>
    <span class="tb-state ${set ? 'on' : 'off'}">${set ? 'set ✓ <span class="tb-mask">' + masked + '</span>' : 'not set'}</span>
    <input class="tb-input" id="tokInput" type="password" autocomplete="off" spellcheck="false"
      placeholder="paste X-Dashboard-Token (printed in the server console)">
    <button type="button" class="dc-btn ghost" data-tokset>save</button>
    ${set ? '<button type="button" class="dc-btn ghost" data-tokclear>clear</button>' : ''}
    <span class="tb-note">convenience gate for home LAN — <b>not security-grade auth</b>. Responses append to an owner-only ledger the orchestrator ingests.</span>
  </div>`;
}

/** The tag filter bar (shared primitive): chips for every tag present on the
   docket, a match-mode toggle, and a clear. Multi-select, orchestrator-assigned. */
function decisionFilterBar(list) {
  const present = new Set();
  for (const dc of list) for (const t of decisionTags(dc)) present.add(t);
  return tagFilterBar(present, state.decisionTags, state.decisionTagMode, { tag: 'dtag', mode: 'dtag-mode', clear: 'dtag-clear' });
}

/** True when a decision passes the active tag filter (empty filter → all pass). */
function decisionPassesFilter(dc) {
  return passesTagFilter(decisionTags(dc), state.decisionTags, state.decisionTagMode);
}

function renderDecisions() {
  const st = state.feeds.decisions;
  if (st.unreachable) return subheadHtml('decisions') + offlineHtml('decisions', 'owner-decision docket');
  const all = Array.isArray(st.data.decisions) ? [...st.data.decisions] : [];
  const { byId, countById } = foldResponses(state.responses);
  const childFold = foldChildResponses(state.responses);
  const ackKeys = ackKeySet(state.acks);

  const list = all.filter(decisionPassesFilter);
  list.sort((a, b) => {
    const r = (DECISION_RANK[a.state] ?? 9) - (DECISION_RANK[b.state] ?? 9);
    if (r !== 0) return r;
    return String(a.asked_on ?? '').localeCompare(String(b.asked_on ?? '')); // oldest ask first
  });

  // bucket into the three groups
  const grouped = { needs: [], pending: [], resolved: [] };
  for (const dc of list) grouped[decisionGroupOf(dc, byId.has(dc.id))].push(dc);

  const cardOf = (dc) => {
    const resp = byId.get(dc.id) || null;
    return decisionCard(dc, resp, countById.get(dc.id) || 0, resp ? isResponseAcked(resp, ackKeys) : false, childFold, ackKeys);
  };

  const sections = DECISION_GROUPS.map((g) => {
    const items = grouped[g.id];
    // needs/pending always render (even empty → honest "none") so the queue is
    // always visible; resolved hides only when the active filter empties it.
    if (!items.length && g.id === 'resolved' && state.decisionTags.size) return '';
    const collapsed = state.decisionCollapse.has(g.id);
    // The resolved pool is sub-split by implementation status (Awaiting / Owner-
    // side / Implemented / Obsolete) and carries a rollup summary in its header.
    let body, extra = '';
    if (g.id === 'resolved') {
      body = items.length
        ? resolvedSubGroupedBody(items, cardOf)
        : '<div class="none-logged" style="padding:6px 2px">None.</div>';
      extra = resolvedRollupHtml(items);
    } else {
      body = items.length
        ? items.map(cardOf).join('')
        : `<div class="none-logged" style="padding:6px 2px">${g.id === 'needs' ? 'Nothing awaiting you right now.' : 'None.'}</div>`;
    }
    return collapsibleGroup({ cls: g.cls, collapsed, label: g.label, count: items.length, sub: g.sub, groupAttr: 'dgroup', groupId: g.id, body, extra });
  }).join('');

  const total = all.length;
  const shown = list.length;
  const filterLine = state.decisionTags.size
    ? ` · <b>${shown}</b> of ${total} shown (${[...state.decisionTags].map(esc).join(state.decisionTagMode === 'all' ? ' AND ' : ' OR ')})`
    : ` · ${total} on docket`;

  return `${subheadHtml('decisions')}
    ${tokenBar()}
    <h2 class="rule">decision docket — grouped by who owns the next move${filterLine}</h2>
    ${decisionFilterBar(all)}
    <div class="docket-groups">${sections || '<div class="none-logged">No decisions match this filter.</div>'}</div>`;
}

/* ── owner-response POST (the one write path) ────────────────────────────── */

async function postResponse(id, action, note, opts = {}) {
  // opts.childId → sub-tier scoping (a child_id is added to the POST body).
  // opts.scopeKey → the editing/notice key (defaults to the decision id; child
  //   actions pass the child scope key so notices land on the child row).
  const childId = opts.childId;
  const nid = opts.scopeKey || id; // notice/editing key
  const token = (localStorage.getItem(TOKEN_KEY) || '').trim();
  if (!token) {
    state.notice = { id: nid, kind: 'err', text: 'No write token set — paste the token from the server console into the box above.' };
    render();
    return;
  }
  try {
    const r = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
      body: JSON.stringify({ decision_id: id, action, note: note || '', ...(childId != null ? { child_id: childId } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      state.editing.delete(nid);
      state.notice = { id: nid, kind: 'ok', text: `Recorded: ${action}${childId != null ? ' (sub-item ' + childId + ')' : ''}${note && note.trim() ? ' — with note' : ''}. Appended to the owner ledger.` };
      await refreshResponses();
      render();
    } else if (r.status === 401) {
      state.notice = { id: nid, kind: 'err', text: 'Token rejected (401). Re-check the X-Dashboard-Token in the server console.' };
      render();
    } else {
      state.notice = { id: nid, kind: 'err', text: `Rejected (${r.status}): ${data && data.error ? data.error : 'request refused'}.` };
      render();
    }
  } catch (err) {
    state.notice = { id: nid, kind: 'err', text: `Could not reach the server: ${err && err.message ? err.message : String(err)}` };
    render();
  }
}

/* ── tab: processing flow ────────────────────────────────────────────────── */
/* renderFlowEdges() lives in tab_flow_edges.js (loaded before app.js) — the
   edge-semantics map (memory/transfer connector classes + LAW-7 glyphs). */

/* ── tab: documents ──────────────────────────────────────────────────────── */
/* Manifest-driven list → client-side markdown reader. The renderer is
   hand-rolled (no external libs); ANY throw is caught by the reader and falls
   back to <pre> raw text — never blank. Italic is deliberately unsupported:
   these technical docs carry '*' globs and '_' in paths, and mangling a path
   is worse than a missing emphasis. */

function mdInlineEmphasis(escaped) {
  // input is already HTML-escaped, so <>&"' are safe; markdown punctuation
  // (* [ ] ( )) survives escaping so these regexes still fire on the right chars.
  let s = escaped;
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (/^(https?:\/\/|\/|#|\.\/|\.\.\/)/i.test(url)) {
      const safeUrl = url.replace(/"/g, '%22');
      const ext = /^https?:/i.test(url);
      return `<a href="${safeUrl}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    }
    return m; // unknown scheme (e.g. javascript:) → leave literal, never a live link
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  return s;
}

function mdInline(text) {
  const out = [];
  const re = /`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out.push(mdInlineEmphasis(esc(text.slice(last, m.index))));
    out.push(`<code class="md-ic">${esc(m[1])}</code>`);
    last = re.lastIndex;
  }
  out.push(mdInlineEmphasis(esc(text.slice(last))));
  return out.join('');
}

function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function mdIsTableSep(line) {
  if (line == null || line.indexOf('-') === -1) return false;
  const cells = mdSplitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')));
}

function mdAlign(sepCells) {
  return sepCells.map((c) => {
    const x = c.replace(/\s/g, '');
    const l = x.startsWith(':'), r = x.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const closeRe = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{3,}\\s*$');
      const buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume the closing fence if present
      html.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    // heading
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { const lvl = h[1].length; html.push(`<h${lvl} class="md-h md-h${lvl}">${mdInline(h[2])}</h${lvl}>`); i++; continue; }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr class="md-hr">'); i++; continue; }

    // table: this line has a pipe AND the next line is a separator row
    if (line.includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      const header = mdSplitRow(line);
      const align = mdAlign(mdSplitRow(lines[i + 1]));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { rows.push(mdSplitRow(lines[i])); i++; }
      const th = header.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(c)}</th>`).join('');
      const tb = rows.map((r) => '<tr>' + header.map((_, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(r[k] != null ? r[k] : '')}</td>`).join('') + '</tr>').join('');
      html.push(`<div class="md-table-scroll"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html.push(`<blockquote class="md-bq">${mdInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // list (unordered or ordered)
    if (/^\s*([-*+]\s+|\d+[.)]\s+)/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); i++; }
      const lis = items.map((it) => `<li>${mdInline(it)}</li>`).join('');
      html.push(ordered ? `<ol class="md-list">${lis}</ol>` : `<ul class="md-list">${lis}</ul>`);
      continue;
    }

    // paragraph — collect to the next blank line / block starter
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^\s*(#{1,6})\s+/.test(lines[i])
      && !/^\s*(`{3,}|~{3,})/.test(lines[i])
      && !/^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])
      && !/^\s*>/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    html.push(`<p class="md-p">${mdInline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('\n');
}

function docStalenessBanner(entry) {
  const hasPath = entry && typeof entry.source_path === 'string' && entry.source_path !== '';
  const src = hasPath ? esc(entry.source_path) : 'NOT RECORDED';
  const copied = entry && entry.copied_at ? fmtTs(entry.copied_at) : NR;
  const mtime = entry && entry.source_mtime ? fmtTs(entry.source_mtime) : null;
  return `<div class="doc-stale">
    <span class="ds-badge">SNAPSHOT — MAY BE STALE</span>
    <span class="ds-line">canonical lives at
      <button type="button" class="ds-path" data-copy="${hasPath ? esc(entry.source_path) : ''}" title="click to copy path">${src}</button></span>
    <span class="ds-line">copied ${copied}${mtime ? ` · source modified ${mtime}` : ''}</span>
  </div>`;
}

function loadDoc(slug) {
  if (state.docCache.has(slug)) return; // loading / loaded / errored — no auto-refetch (retry clears the entry)
  state.docCache.set(slug, { loading: true, text: null, error: null });
  fetch(`/docs/${encodeURIComponent(slug)}.md`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    .then((text) => {
      state.docCache.set(slug, { loading: false, text, error: null });
      if (state.active === 'documents' && state.docSlug === slug) render();
    })
    .catch((err) => {
      state.docCache.set(slug, { loading: false, text: null, error: (err && err.message) || String(err) });
      if (state.active === 'documents' && state.docSlug === slug) render();
    });
}

function renderDocReader(slug, docs) {
  const entry = docs.find((d) => d && d.slug === slug) || null;
  const back = '<a class="doc-back" href="#documents">◂ all documents</a>';
  if (!entry) {
    return `${back}
      <div class="offline"><div class="o-badge">UNKNOWN DOCUMENT</div>
        <p>No published document has the slug <code>${esc(slug)}</code>. It may have been renamed or pruned
           from the manifest. Nothing is shown rather than guessing.</p></div>`;
  }
  const cache = state.docCache.get(slug);
  let bodyHtml;
  if (!cache || cache.loading) {
    if (!cache) loadDoc(slug); // kick off fetch; completion triggers a re-render
    bodyHtml = `<div class="doc-loading">loading ${esc(slug)}.md …</div>`;
  } else if (cache.error) {
    bodyHtml = `<div class="offline"><div class="o-badge">DOCUMENT UNREACHABLE</div>
      <p>Could not fetch <code>/docs/${esc(slug)}.md</code> — ${esc(cache.error)}.
         The canonical copy is at <code>${esc(entry.source_path || '')}</code>.</p>
      <div class="o-last"><button type="button" class="dc-btn ghost" data-doc-retry="${esc(slug)}">retry</button></div></div>`;
  } else {
    let rendered;
    try { rendered = renderMarkdown(cache.text); }
    catch (err) {
      console.warn('[csl-ledger] markdown render failed — raw fallback:', err);
      rendered = `<div class="doc-rawnote">rendering failed — showing raw text</div><pre class="md-raw">${esc(cache.text)}</pre>`;
    }
    bodyHtml = `<article class="doc-body">${rendered}</article>`;
  }
  return `<div class="doc-reader-head">
      ${back}
      <h1 class="doc-h1">${esc(entry.title || slug)}</h1>
      <div class="doc-oneliner">${entry.one_liner != null ? esc(entry.one_liner) : ''}</div>
    </div>
    ${docStalenessBanner(entry)}
    ${bodyHtml}`;
}

function renderDocList(docs, data) {
  const missing = (data && Array.isArray(data.missing)) ? data.missing : [];
  const cards = docs.length
    ? docs.map((e) => {
        const size = e.size != null ? `${(e.size / 1024).toFixed(1)} kB` : 'NOT RECORDED';
        return `<a class="doc-card" href="#documents/${encodeURIComponent(e.slug)}">
          <div class="dcard-top">
            <span class="dcard-title">${esc(e.title || e.slug)}</span>
            <span class="dcard-open">read ▸</span>
          </div>
          <div class="dcard-one">${e.one_liner != null ? esc(e.one_liner) : NR}</div>
          <div class="dcard-meta">
            <span class="dcard-path" title="canonical source (may be newer than this snapshot)">${e.source_path != null ? esc(e.source_path) : NR}</span>
            <span class="dcard-sub">snapshot ${e.copied_at != null ? fmtTs(e.copied_at) : NR} · ${esc(size)}</span>
          </div>
        </a>`;
      }).join('')
    : '<div class="none-logged">No documents published. Run tools/theses/dashboard/publish_docs.mjs.</div>';

  const missBlock = missing.length
    ? `<div class="doc-missing"><span class="dm-lbl">not published — source absent at snapshot time (honest gap, never faked)</span>
        ${missing.map((m) => `<div class="dm-row">▤ ${esc(m.slug || '?')} — <span class="dm-src">${esc(m.source_path || '')}</span>
          <span class="dm-why">${esc(m.reason || '')}</span></div>`).join('')}</div>`
    : '';

  return `<div class="doc-intro">Read-only snapshots of narrative reports, copied for LAN reading.
      Each is a point-in-time copy — the canonical file (shown per card) is authoritative and may be newer.</div>
    <h2 class="rule">published documents · ${docs.length}</h2>
    <div class="doc-list">${cards}</div>
    ${missBlock}`;
}

function renderDocuments() {
  const st = state.feeds.documents;
  if (st.unreachable) return subheadHtml('documents') + offlineHtml('documents', 'documents manifest');
  const docs = manifestDocs(st.data);
  const body = state.docSlug ? renderDocReader(state.docSlug, docs) : renderDocList(docs, st.data);
  return subheadHtml('documents') + body;
}

/* ── tab: token tracker ──────────────────────────────────────────────────── */

/* Live-ops "running now" section. Primary source = /data/live_ops.json (the
   wait-graph: launch − complete from waiting_on.jsonl). Fallback = /api/morning
   last-observed lanes when an older server lacks the route. HONESTY (LAW 3):
   there is no true process-liveness probe in this system — every label here says
   exactly what it is (ledger arithmetic / last-observed snapshot), and an absent
   feed renders NOT MEASURED, never a fabricated count. */
function renderLiveOps() {
  const lv = state.live;
  if (!lv || lv.unreachable || !lv.data) {
    return `<div class="live-ops na">
      <div class="lo-head"><span class="lo-badge na">LIVE OPS — NOT MEASURED</span></div>
      <p class="lo-note">No live-operations feed is reachable. Nothing is shown rather than a fabricated count (LAW 3).
        If this is a live server, restart <code>node tools/theses/dashboard/serve.mjs</code> to enable the
        <code>/data/live_ops.json</code> route.</p>
    </div>`;
  }
  return lv.source === 'live_ops' ? liveOpsPrimary(lv.data) : liveOpsMorning(lv.data);
}

function liveOpsItem(who, model, desc, ageHtml, stale) {
  return `<div class="lo-item${stale ? ' stale' : ''}">
    <span class="lo-run"><span class="pulse"></span></span>
    <span class="lo-who">${esc(who)}${model ? ` <span class="lo-model">${esc(model)}</span>` : ''}</span>
    <span class="lo-desc">${desc != null ? esc(desc) : NR}</span>
    <span class="lo-age">${ageHtml}</span>
  </div>`;
}

function liveOpsPrimary(d) {
  if (d && d.available === false) {
    return `<div class="live-ops na"><div class="lo-head"><span class="lo-badge na">LIVE OPS — NOT AVAILABLE</span></div>
      <p class="lo-note">${esc(d.note || 'waiting_on.jsonl not present')}</p></div>`;
  }
  const active = Array.isArray(d.active) ? d.active : [];
  const list = active.length
    ? active.map((a) => {
        const stale = a.stale
          ? ' <span class="lo-stale" title="older than the stale threshold — may have finished or died without a completion record">stale?</span>' : '';
        const age = (a.age_min != null ? `<span title="launched ${esc(a.launched_at || '')}">${esc(a.age_min)}m</span>` : NR) + stale;
        const who = a.subagent_type || (a.model ? a.model : 'agent');
        const model = a.subagent_type && a.model ? a.model : null;
        return liveOpsItem(who, model, a.desc, age, a.stale);
      }).join('')
    : `<div class="none-logged" style="padding:8px 2px">No launch without a matching completion — nothing running by this ledger.</div>`;

  const untracked = d.untracked_launches
    ? `<div class="lo-sub">${esc(d.untracked_launches)} launch(es) carried no parseable agent_id — cannot be tracked, so not counted as running.</div>` : '';

  const lo = d.last_observed;
  const lastObs = lo && lo.available
    ? `<div class="lo-lastobs">
        <span class="lo-lbl">last-observed background tasks</span>
        <span class="lo-obs-note" title="${esc(lo.note || '')}">snapshot @ ${fmtTs(lo.observed_at)} — may be stale</span>
        ${(Array.isArray(lo.tasks) && lo.tasks.length)
          ? `<ul class="lo-tasks">${lo.tasks.map((t) => `<li><b>${esc(t.type || '?')}</b> ${esc(t.description || '')}</li>`).join('')}</ul>`
          : '<div class="none-logged" style="padding:4px 2px">none running in that snapshot</div>'}
      </div>`
    : '';

  return `<div class="live-ops">
    <div class="lo-head">
      <span class="lo-badge">RUNNING NOW <span class="lo-n">${d.active_count != null ? esc(d.active_count) : NR}</span></span>
      ${d.stale_count ? `<span class="lo-stalecount">${esc(d.stale_count)} possibly stale</span>` : ''}
      <span class="lo-src">source: waiting_on.jsonl (launch − complete)</span>
    </div>
    <p class="lo-note"><b>Honest semantics:</b> ledger arithmetic — a launch record with no matching completion —
      <b>not a process-liveness probe</b>. An agent that ended without a completion record stays here until it ages
      past ${d.stale_threshold_min != null ? esc(d.stale_threshold_min) : 30}m, when it is flagged <i>stale?</i>.</p>
    <div class="lo-list">${list}</div>
    ${untracked}
    ${lastObs}
  </div>`;
}

function liveOpsMorning(d) {
  const inflight = d && d.lanes && d.lanes.in_flight ? d.lanes.in_flight : null;
  const tasks = inflight && Array.isArray(inflight.tasks) ? inflight.tasks : [];
  const list = tasks.length
    ? tasks.map((t) => liveOpsItem(t.type || 'task', null, t.description, '', false)).join('')
    : `<div class="none-logged" style="padding:8px 2px">${inflight && inflight.available ? 'No tasks running in the last-observed snapshot.' : 'In-flight snapshot NOT AVAILABLE.'}</div>`;
  return `<div class="live-ops fallback">
    <div class="lo-head">
      <span class="lo-badge fallback">LAST-OBSERVED <span class="lo-n">${tasks.length}</span></span>
      <span class="lo-src">source: /api/morning lanes (agent_runs snapshot)</span>
    </div>
    <p class="lo-note"><b>Fallback source.</b> The <code>/data/live_ops.json</code> wait-graph route is absent on this
      server build, so this shows the background-task snapshot from the most recent completion event — a real
      point-in-time observation, <b>not a live feed</b>${inflight && inflight.observed_at ? `, observed ${fmtTs(inflight.observed_at)}` : ''}.</p>
    <div class="lo-list">${list}</div>
  </div>`;
}

const RUN_COLS = ['ts', 'agent', 'model', 'tokens', 'duration_s', 'turns'];

function renderTokens() {
  const st = state.feeds.tokens;
  if (st.unreachable) return subheadHtml('tokens') + offlineHtml('tokens', 'token-tracker');
  const d = st.data;
  const totals = d.totals || {};

  // known tiles + any extra scalar totals rendered generically
  let tiles = `
    <div class="tile"><div class="lbl">agent runs</div><div class="val">${totals.runs != null ? esc(totals.runs) : NR}</div></div>
    <div class="tile"><div class="lbl">tokens total</div><div class="val">${fmtTok(totals.tokens)}</div></div>`;
  for (const [k, v] of Object.entries(totals)) {
    if (k === 'runs' || k === 'tokens' || k === 'by_model') continue;
    if (typeof v === 'object' && v !== null) continue;
    tiles += `<div class="tile"><div class="lbl">${esc(k)}</div><div class="val">${v != null ? esc(v) : NR}</div></div>`;
  }

  const byModel = totals.by_model && typeof totals.by_model === 'object' ? Object.entries(totals.by_model) : [];
  byModel.sort((a, b) => (b[1]?.tokens ?? 0) - (a[1]?.tokens ?? 0));
  const maxTok = Math.max(1, ...byModel.map(([, v]) => v?.tokens ?? 0));
  const bars = byModel.length
    ? byModel.map(([m, v]) => {
        const t = v?.tokens ?? null;
        const w = t != null ? Math.max(1, Math.round((t / maxTok) * 100)) : 0;
        return `<div class="mbar">
          <span class="m-name">${esc(m)}</span>
          <span class="m-track">${t != null ? `<span class="m-fill" style="width:${w}%"></span>` : ''}</span>
          <span class="m-val"><b>${fmtTok(t)}</b> · ${v?.runs != null ? esc(v.runs) + ' runs' : NR}</span>
        </div>`;
      }).join('')
    : `<div class="none-logged">NOT RECORDED</div>`;

  const runs = Array.isArray(d.recent_runs) ? d.recent_runs : [];
  const rows = runs.length
    ? runs.map((r) => {
        const extras = Object.entries(r).filter(([k]) => !RUN_COLS.includes(k));
        const extraStr = extras.length
          ? extras.map(([k, v]) => `${esc(k)}=${esc(JSON.stringify(v))}`).join(' ') : '';
        return `<tr>
          <td>${fmtTs(r.ts)}</td>
          <td>${r.agent != null ? esc(r.agent) : NR}</td>
          <td>${r.model != null ? esc(r.model) : NR}</td>
          <td class="num">${fmtTok(r.tokens)}</td>
          <td class="num">${fmtDur(r.duration_s)}</td>
          <td class="num">${r.turns != null ? esc(r.turns) : NR}</td>
          <td><span class="extra">${extraStr}</span></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="7"><span class="none-logged">NONE LOGGED</span></td></tr>`;

  return `${subheadHtml('tokens')}
    <h2 class="rule">live · running now</h2>
    ${renderLiveOps()}
    <h2 class="rule">totals</h2>
    <div class="tok-tiles">${tiles}</div>
    <h2 class="rule">tokens by model — per-model, never a blended rate</h2>
    <div class="modelbars">${bars}</div>
    <h2 class="rule">token composition — input · output · cache <span class="rule-sub">where the tokens actually go · fleet / per session / per agent run</span></h2>
    ${typeof renderTokenSplitPanel === 'function' ? renderTokenSplitPanel() : '<div class="none-logged">NOT MEASURED — token_split feed absent</div>'}
    <h2 class="rule">recent agent runs</h2>
    <div class="table-scroll"><table class="runs">
      <thead><tr><th>completed</th><th>agent</th><th>model</th>
        <th class="num">tokens</th><th class="num">wall</th><th class="num">turns</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ── needs-you-today badge (masthead — persistent, visible from every tab) ──── */

/** Count of decisions the owner still owes a call on: OPEN or ANSWER-PENDING with
   NO owner response on the ledger. null → the decisions feed is unreachable
   (rendered NOT AVAILABLE, never a fabricated 0). Derived from the same feeds
   the Decisions tab uses. */
function needsYouCount() {
  const st = state.feeds.decisions;
  if (!st || st.unreachable || !st.data) return null;
  const list = Array.isArray(st.data.decisions) ? st.data.decisions : (Array.isArray(st.data) ? st.data : []);
  const { byId } = foldResponses(state.responses);
  let n = 0;
  for (const dc of list) {
    if ((dc.state === 'OPEN' || dc.state === 'ANSWER-PENDING') && !byId.has(dc.id)) n++;
  }
  return n;
}

function needsBadgeHtml() {
  const n = needsYouCount();
  if (n === null) {
    return `<button type="button" class="needs-badge na" data-tab="decisions"
      title="owner-decision docket unreachable — count NOT AVAILABLE">NEEDS YOU <span class="nb-n">N/A</span></button>`;
  }
  const cls = n > 0 ? 'active' : 'clear';
  const title = n > 0
    ? `${n} open / answer-pending decision${n === 1 ? '' : 's'} with no owner response — click to review the docket`
    : 'no open decisions awaiting you — click to review the docket';
  return `<button type="button" class="needs-badge ${cls}" data-tab="decisions" title="${esc(title)}">NEEDS YOU TODAY <span class="nb-n">${n}</span></button>`;
}

/* ── shell ───────────────────────────────────────────────────────────────── */

/* ── tab: stage timings ──────────────────────────────────────────────────────
   Per-stage population timing summary from tools/theses/dashboard/
   stage_timings_agg.mjs (reads test_results/perf/stage_timings.jsonl). Every
   number is a measured aggregate; absent data → an honest empty state, never a
   fabricated row. Nested solve.* sub-stages OVERLAP their parent `solve`, so
   per-stage shares intentionally do NOT sum to 100% — surfaced, not hidden. */
function fmtMs(n) {
  if (n == null) return NR;
  if (n >= 1000) return `<span title="${esc(n)} ms">${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s</span>`;
  return `<span title="${esc(n)} ms">${Math.round(n)}ms</span>`;
}
function timingBreakdownHtml(label, obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return `<span class="ti-none">${NR}</span>`;
  return keys.sort().map((k) => `<span class="ti-pill"><span class="ti-pk">${esc(k)}</span>${esc(obj[k])}</span>`).join('');
}
function renderTimings() {
  const st = state.feeds.timings;
  if (st.unreachable) return subheadHtml('timings') + offlineHtml('timings', 'stage-timing summary');
  const d = st.data || {};
  const runs = d.runs || { total: 0 };
  if (!runs.total) {
    return `${subheadHtml('timings')}
      <div class="none-logged" style="padding:22px 4px">
        <b>No population run data yet.</b><br>
        The Timings summary is produced by
        <code>node tools/theses/dashboard/stage_timings_agg.mjs --out test_results/theses/dashboard/stage_timings.json</code>
        over <code>test_results/perf/stage_timings.jsonl</code>. Once a population run has
        appended per-frame stage timings, this tab fills in — until then it stays
        honestly empty.
      </div>`;
  }
  const t = d.total_ms || {};
  const stages = Array.isArray(d.stages) ? d.stages : [];
  const maxMean = stages.reduce((m, s) => Math.max(m, s.mean || 0), 0) || 1;

  const tiles = `<div class="ti-tiles">
    <div class="ti-tile"><div class="ti-lbl">runs</div><div class="ti-val">${esc(runs.total)}</div>
      <div class="ti-sub">${esc(runs.ok)} ok · ${esc(runs.failed)} failed</div></div>
    <div class="ti-tile"><div class="ti-lbl">total per frame · p50</div><div class="ti-val">${fmtMs(t.p50)}</div>
      <div class="ti-sub">mean ${fmtMs(t.mean)} · p95 ${fmtMs(t.p95)} · max ${fmtMs(t.max)}</div></div>
    <div class="ti-tile"><div class="ti-lbl">by decoder arm</div><div class="ti-val ti-break">${timingBreakdownHtml('arm', d.by_arm)}</div>
      <div class="ti-sub">run counts — arms are never pooled in a per-arm read</div></div>
    <div class="ti-tile"><div class="ti-lbl">by source format</div><div class="ti-val ti-break">${timingBreakdownHtml('fmt', d.by_format)}</div>
      <div class="ti-sub">run counts</div></div>
  </div>`;

  const perArm = Array.isArray(d.per_arm_total_ms) && d.per_arm_total_ms.length
    ? `<div class="ti-perarm">${d.per_arm_total_ms.map((a) =>
        `<span class="ti-arm"><b>${esc(a.arm)}</b> · n ${esc(a.count)} · total p50 ${fmtMs(a.total_ms && a.total_ms.p50)}</span>`).join('')}</div>`
    : '';

  const rows = stages.map((s) => {
    const w = Math.max(1, Math.round(((s.mean || 0) / maxMean) * 100));
    return `<tr>
      <td class="ti-name"><span class="ti-bar" style="width:${w}%"></span><span class="ti-nm">${esc(s.name)}</span></td>
      <td class="ti-num">${fmtMs(s.p50)}</td>
      <td class="ti-num">${fmtMs(s.mean)}</td>
      <td class="ti-num">${fmtMs(s.p95)}</td>
      <td class="ti-num">${fmtMs(s.max)}</td>
      <td class="ti-num ti-n">${s.n != null ? esc(s.n) : NR}</td>
      <td class="ti-num ti-share">${s.share_pct != null ? esc(s.share_pct) + '%' : NR}</td>
    </tr>`;
  }).join('');

  const table = `<div class="ti-tablewrap"><table class="ti-table">
    <thead><tr><th>stage <span class="ti-th-sub">bar = mean, scaled to slowest</span></th>
      <th>p50</th><th>mean</th><th>p95</th><th>max</th><th>n</th><th title="stage mean as a share of the mean total-per-frame">share</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  const window = d.window || {};
  return `${subheadHtml('timings')}
    <h2 class="rule">stage timings — population summary <span class="rule-sub">${esc(d.source_file || '')}</span></h2>
    ${tiles}
    ${perArm}
    <h2 class="rule">per-stage cost — sorted by mean</h2>
    ${table}
    <div class="economy-note">Nested <code>solve.*</code> sub-stages overlap their parent <code>solve</code>, so shares do not sum to 100% — this is the real shape of the ledger, not double-counting. Window: ${fmtTs(window.first_ts)} → ${fmtTs(window.last_ts)}.</div>`;
}

const RENDERERS = { morning: renderMorning, theses: renderTheses, decisions: renderDecisions, documents: renderDocuments, flow: (typeof renderFlow === 'function' ? renderFlow : renderFlowEdges), ops: renderOpsMap, tokens: renderTokens, roadmap: renderRoadmap, pools: renderPools, timings: renderTimings, database: renderDatabase, mining: renderMining, runtelem: renderRunTelem };

function render(opts) {
  const skipPanel = !!(opts && opts.skipPanel);
  // tab bar — the theses tab carries a red chain marker visible from ANY tab
  const chain = state.feeds.theses.data && state.feeds.theses.data.chain;
  const chainBroken = chain && chain.verified === false;
  document.getElementById('tabs').innerHTML = TABS.map((t) => `
    <button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.active === t.id}">
      ${esc(t.label)}${t.id === 'theses' && chainBroken ? '<span class="tab-alert" title="hash chain broken">⛓!</span>' : ''}
    </button>`).join('');

  // persistent "needs you today" badge in the masthead — refreshed every render/poll
  const needsSlot = document.getElementById('needsToday');
  if (needsSlot) needsSlot.innerHTML = needsBadgeHtml();

  if (!skipPanel) {
    const panel = document.getElementById('panel');
    try {
      panel.innerHTML = `<section class="tabpanel" role="tabpanel">${RENDERERS[state.active]()}</section>`;
    } catch (err) {
      console.error('[csl-ledger] render failed:', err);
      panel.innerHTML = `<div class="offline"><div class="o-badge">RENDER ERROR</div>
        <p>The snapshot did not match the expected shape and this tab refuses to guess.
           ${esc(err && err.message ? err.message : String(err))}</p></div>`;
    }
  }

  document.getElementById('foot').innerHTML = `
    <span class="hon">Buckets are never numerically merged · absent values render as NOT RECORDED ·
    nothing on this page is fabricated.</span><br>
    feeds: /data/*.json, falling back to fixture/ in dev · schema ${state.feeds.theses.data && state.feeds.theses.data.schema_version
      ? esc(state.feeds.theses.data.schema_version) : 'NOT RECORDED'}`;
}

/* ── events ──────────────────────────────────────────────────────────────── */

function applyHash() {
  // hash routing supports a compound form for the documents reader:
  //   #documents            → list          #documents/<slug> → reader
  const raw = (location.hash || '#theses').slice(1);
  const slash = raw.indexOf('/');
  const seg0 = slash === -1 ? raw : raw.slice(0, slash);
  const seg1 = slash === -1 ? '' : raw.slice(slash + 1);
  const next = TABS.some((t) => t.id === seg0) ? seg0 : 'theses';
  if (next !== state.active) state.notice = null; // don't carry a card message across tabs
  state.active = next;
  let slug = null;
  if (next === 'documents' && seg1) { try { slug = decodeURIComponent(seg1); } catch { slug = seg1; } }
  state.docSlug = slug;
  render();
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { location.hash = '#' + tab.dataset.tab; return; }

  const bucket = e.target.closest('[data-bucket]');
  if (bucket) { state.bucket = bucket.dataset.bucket; render(); return; }

  // ── owner-decision grouping + tag filter (read-only view controls) ──
  const dtag = e.target.closest('[data-dtag]');
  if (dtag) {
    const t = dtag.dataset.dtag;
    state.decisionTags.has(t) ? state.decisionTags.delete(t) : state.decisionTags.add(t);
    if (state.decisionTags.size < 2) state.decisionTagMode = 'any'; // mode toggle only meaningful with 2+
    render();
    return;
  }
  if (e.target.closest('[data-dtag-mode]')) {
    state.decisionTagMode = state.decisionTagMode === 'all' ? 'any' : 'all';
    render();
    return;
  }
  if (e.target.closest('[data-dtag-clear]')) {
    state.decisionTags.clear();
    state.decisionTagMode = 'any';
    render();
    return;
  }
  const dgroup = e.target.closest('[data-dgroup]');
  if (dgroup) {
    const g = dgroup.dataset.dgroup;
    state.decisionCollapse.has(g) ? state.decisionCollapse.delete(g) : state.decisionCollapse.add(g);
    render();
    return;
  }
  // sub-tier (children[]) expand/collapse — keyed on the parent decision id
  const cchild = e.target.closest('[data-cchild-toggle]');
  if (cchild) {
    const pid = cchild.dataset.cchildToggle;
    state.childCollapse.has(pid) ? state.childCollapse.delete(pid) : state.childCollapse.add(pid);
    render();
    return;
  }

  // ── theses grouping + tag filter (same chip UI as decisions; checked BEFORE the
  //    row-toggle handler so a tag click filters instead of expanding the row) ──
  const ttag = e.target.closest('[data-ttag]');
  if (ttag) {
    const t = ttag.dataset.ttag;
    state.thesisTags.has(t) ? state.thesisTags.delete(t) : state.thesisTags.add(t);
    if (state.thesisTags.size < 2) state.thesisTagMode = 'any';
    render();
    return;
  }
  if (e.target.closest('[data-ttag-mode]')) { state.thesisTagMode = state.thesisTagMode === 'all' ? 'any' : 'all'; render(); return; }
  if (e.target.closest('[data-ttag-clear]')) { state.thesisTags.clear(); state.thesisTagMode = 'any'; render(); return; }
  const tgroup = e.target.closest('[data-tgroup]');
  if (tgroup) {
    const g = tgroup.dataset.tgroup;
    state.thesisCollapse.has(g) ? state.thesisCollapse.delete(g) : state.thesisCollapse.add(g);
    render();
    return;
  }

  // ── owner-decision write controls ──
  if (e.target.closest('[data-tokset]')) {
    const inp = document.getElementById('tokInput');
    const v = (inp && inp.value || '').trim();
    if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
    state.notice = null;
    render();
    return;
  }
  if (e.target.closest('[data-tokclear]')) {
    localStorage.removeItem(TOKEN_KEY);
    state.notice = null;
    render();
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const id = edit.dataset.id;
    state.editing.set(id, edit.dataset.edit);
    state.notice = null;
    render();
    const ta = [...document.querySelectorAll('[data-ta]')].find((x) => x.dataset.ta === id);
    if (ta) ta.focus();
    return;
  }
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    state.editing.delete(cancel.dataset.cancel);
    if (state.notice && state.notice.id === cancel.dataset.cancel) state.notice = null;
    render();
    return;
  }
  const doBtn = e.target.closest('[data-do]');
  if (doBtn && !doBtn.disabled) {
    postResponse(doBtn.dataset.id, doBtn.dataset.do, '');
    return;
  }
  const submit = e.target.closest('[data-submit]');
  if (submit) {
    const id = submit.dataset.submit;
    const act = submit.dataset.act;
    const editor = submit.closest('[data-editor]');
    const ta = editor && editor.querySelector('textarea');
    const note = ta ? ta.value : '';
    if ((act === 'answer' || act === 'overturn') && note.trim() === '') {
      state.notice = { id, kind: 'err', text: act === 'overturn' ? 'Overturn requires a note.' : 'Answer cannot be empty.' };
      render();
      return;
    }
    postResponse(id, act, note);
    return;
  }

  // ── sub-tier (child) write controls — same action set, child-scoped ──
  const cdo = e.target.closest('[data-cdo]');
  if (cdo && !cdo.disabled) {
    const pid = cdo.dataset.pid, cid = cdo.dataset.cid;
    postResponse(pid, cdo.dataset.cdo, '', { childId: cid, scopeKey: childScopeKey(pid, cid) });
    return;
  }
  const cedit = e.target.closest('[data-cedit]');
  if (cedit) {
    const scope = childScopeKey(cedit.dataset.pid, cedit.dataset.cid);
    state.editing.set(scope, cedit.dataset.cedit);
    state.notice = null;
    render();
    const ta = [...document.querySelectorAll('[data-cta]')].find((x) => x.dataset.cta === scope);
    if (ta) ta.focus();
    return;
  }
  const ccancel = e.target.closest('[data-ccancel]');
  if (ccancel) {
    const scope = childScopeKey(ccancel.dataset.pid, ccancel.dataset.cid);
    state.editing.delete(scope);
    if (state.notice && state.notice.id === scope) state.notice = null;
    render();
    return;
  }
  const csubmit = e.target.closest('[data-csubmit]');
  if (csubmit) {
    const pid = csubmit.dataset.pid, cid = csubmit.dataset.cid, act = csubmit.dataset.act;
    const scope = childScopeKey(pid, cid);
    const editor = csubmit.closest('[data-ceditor]');
    const ta = editor && editor.querySelector('textarea');
    const note = ta ? ta.value : '';
    if ((act === 'answer' || act === 'overturn') && note.trim() === '') {
      state.notice = { id: scope, kind: 'err', text: act === 'overturn' ? 'Overturn requires a note.' : 'Answer cannot be empty.' };
      render();
      return;
    }
    postResponse(pid, act, note, { childId: cid, scopeKey: scope });
    return;
  }

  const docRetry = e.target.closest('[data-doc-retry]');
  if (docRetry) { state.docCache.delete(docRetry.dataset.docRetry); render(); return; }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const text = copy.dataset.copy;
    const flash = () => { copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 900); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => selectNode(copy));
    } else { selectNode(copy); }
    return;
  }

  const row = e.target.closest('[data-toggle]');
  if (row) {
    const id = row.dataset.toggle;
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle], [data-cchild-toggle]')) {
    e.preventDefault();
    e.target.click();
    return;
  }
  // Ctrl/⌘+Enter submits the open answer/overturn editor (parent or child)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('[data-ta]')) {
    e.preventDefault();
    const btn = e.target.closest('[data-editor]');
    const submit = btn && btn.querySelector('[data-submit]');
    if (submit) submit.click();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('[data-cta]')) {
    e.preventDefault();
    const btn = e.target.closest('[data-ceditor]');
    const submit = btn && btn.querySelector('[data-csubmit]');
    if (submit) submit.click();
    return;
  }
  // Enter in the token box saves it
  if (e.key === 'Enter' && e.target.id === 'tokInput') {
    e.preventDefault();
    const set = document.querySelector('[data-tokset]');
    if (set) set.click();
  }
});

function selectNode(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

window.addEventListener('hashchange', applyHash);

setInterval(() => {
  const c = document.getElementById('clock');
  if (c) c.textContent = fmtClock(new Date());
}, 1000);

/* ── boot ────────────────────────────────────────────────────────────────── */

applyHash();
refreshAll();
setInterval(refreshAll, POLL_MS);

// Run Telemetry is a LIVE tab — while it is the active tab, poll its feed on a
// tighter ~5s cadence than the global POLL_MS so a running corpus arm updates
// snappily. Only fires when active (no extra load on other tabs / when idle).
const RUNTELEM_POLL_MS = 5000;
setInterval(async () => {
  if (state.active !== 'runtelem') return;
  await refreshFeed('runtelem');
  render();
}, RUNTELEM_POLL_MS);
