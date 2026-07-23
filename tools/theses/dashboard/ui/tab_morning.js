'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   MORNING REVIEW — a boot surface for BOTH owner and orchestrator.
   Answers, in one glance: "what happened since I last looked, and what needs
   me now." Deltas are computed SERVER-SIDE against the last review mark
   (review_marks.jsonl), never wall-clock, and delivered whole at /api/morning —
   the same query the orchestrator boots from (dual consumer).

   This file is a classic (non-module) script loaded BEFORE app.js. It defines a
   global renderMorning() that app.js's RENDERERS table dispatches to, and reuses
   app.js's shared helpers (esc, NR, subheadHtml, offlineHtml, statusChip, fmtTs,
   fmtDur, fmtTok, state, render, refreshFeed) at render time.

   Honesty (LAW 3): every panel has an explicit absent state —
     · registry/docket/agent_runs/GATES absent  → "NOT AVAILABLE"
     · editorial packet absent                   → "NOT CURATED THIS SESSION"
     · in-flight lanes                           → last-observed snapshot only,
       labelled stale; there is NO live wait-state capture, so nothing is faked.
   Nothing here invents a number, a status, or a "done".
   ═══════════════════════════════════════════════════════════════════════════ */

const MORNING_TOKEN_KEY = 'csl_dashboard_token'; // same write-token localStorage key the decisions tab uses

const morningState = {
  notice: null,     // { kind:'ok'|'err', text } — transient result of a mark-reviewed POST
  noteDraft: '',    // survives the 15s poll re-render so a half-typed note is never lost
};

/* ── section: mark-reviewed control (the one write path on this tab) ───────── */

function morningReviewBar(agg) {
  const lr = agg && agg.last_review;
  const count = agg && agg.review_count != null ? agg.review_count : 0;
  const lastLine = lr && lr.ts
    ? `last reviewed ${fmtTs(lr.ts)}${lr.by ? ` · by <b>${esc(lr.by)}</b>` : ''}${lr.note ? ` · <span class="mr-lastnote">“${esc(lr.note)}”</span>` : ''}`
    : '<span class="nr">NO REVIEW MARKER YET</span> — deltas below show recent activity; mark reviewed to anchor future "since" windows';
  const notice = morningState.notice
    ? `<div class="mr-notice ${morningState.notice.kind === 'err' ? 'err' : 'ok'}">${esc(morningState.notice.text)}</div>` : '';
  return `<div class="mr-bar">
    <div class="mr-bar-row">
      <span class="mr-anchor">▣ REVIEW ANCHOR</span>
      <span class="mr-last">${lastLine}</span>
      <span class="mr-count" title="total review marks on the append-only ledger">${count} on ledger</span>
    </div>
    <div class="mr-mark">
      <input class="mr-note" data-morning-note type="text" autocomplete="off" spellcheck="false"
        placeholder="optional note (what you looked at / what you're deferring)" value="${esc(morningState.noteDraft)}">
      <button type="button" class="mr-btn" data-morning-mark title="append a 'reviewed up to now' mark — future deltas anchor here">✓ Mark reviewed as of now</button>
    </div>
    ${notice}
  </div>`;
}

/* ── section: needs-you-today editorial packet ─────────────────────────────── */

function morningRef(ref) {
  const s = String(ref == null ? '' : ref);
  if (s.startsWith('#')) return `<a class="mr-ref" href="${esc(s)}">${esc(s)}</a>`;
  return `<span class="mr-ref plain">${esc(s)}</span>`;
}

function morningPacket(pk) {
  if (!pk || !pk.curated || !Array.isArray(pk.items) || pk.items.length === 0) {
    return `<div class="mr-card">
      <div class="mr-card-h"><span class="mr-h-glyph">★</span>NEEDS YOU TODAY</div>
      <div class="mr-absent">NOT CURATED THIS SESSION — no <code>morning_packet.json</code> editorial feed.
        This panel shows only a human-ranked packet; it never auto-invents priorities from raw feeds.</div>
    </div>`;
  }
  const items = [...pk.items].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).map((it) => {
    const refs = Array.isArray(it.refs) && it.refs.length
      ? `<div class="mr-item-refs">${it.refs.map(morningRef).join('')}</div>` : '';
    return `<div class="mr-item">
      <span class="mr-rank">${it.rank != null ? esc(it.rank) : '·'}</span>
      <div class="mr-item-body">
        <div class="mr-item-title">${it.title != null ? esc(it.title) : NR}</div>
        ${it.why != null ? `<div class="mr-item-why">${esc(it.why)}</div>` : ''}
        ${it.action != null ? `<div class="mr-item-action"><span class="mr-a-lbl">do →</span>${esc(it.action)}</div>` : ''}
        ${refs}
      </div>
    </div>`;
  }).join('');
  const gen = pk.generated_at ? fmtTs(pk.generated_at) : NR;
  return `<div class="mr-card">
    <div class="mr-card-h"><span class="mr-h-glyph">★</span>NEEDS YOU TODAY
      <span class="mr-card-sub">curated ${gen} · ${pk.items.length} item${pk.items.length === 1 ? '' : 's'}</span></div>
    <div class="mr-packet">${items}</div>
  </div>`;
}

/* ── section: thesis verdict stamps since last review ──────────────────────── */

function morningStamps(ts) {
  if (!ts || !ts.available) {
    return `<div class="mr-card">
      <div class="mr-card-h"><span class="mr-h-glyph">⎇</span>VERDICT STAMPS SINCE REVIEW</div>
      <div class="mr-absent">NOT AVAILABLE — thesis registry not present in this worktree.</div>
    </div>`;
  }
  const rows = Array.isArray(ts.stamps) && ts.stamps.length
    ? ts.stamps.map((s) => `<a class="mr-stamp" href="#theses" title="open the theses ledger">
        <span class="mr-stamp-chip">${statusChip(s.status)}</span>
        <span class="mr-stamp-main">
          <span class="mr-stamp-title">${s.title != null ? esc(s.title) : (s.id != null ? esc(s.id) : NR)}</span>
          <span class="mr-stamp-meta">${esc(s.id ?? '')} · stamp ${fmtTs(s.ts)}${s.by ? ` · by ${esc(s.by)}` : ''}${s.integrity_ok === false ? ' · <span class="mr-bad">INTEGRITY FAIL</span>' : ''}</span>
          ${s.evidence_pointer != null ? `<span class="mr-stamp-ev">${esc(s.evidence_pointer)}</span>` : ''}
        </span>
      </a>`).join('')
    : `<div class="mr-empty">${ts.note != null ? esc(ts.note) : 'no new verdict stamps since your last review'}</div>`;
  const banner = ts.since == null && Array.isArray(ts.stamps) && ts.stamps.length
    ? `<div class="mr-since-note">${esc(ts.note || 'no review marker — showing recent stamps')}</div>` : '';
  return `<div class="mr-card">
    <div class="mr-card-h"><span class="mr-h-glyph">⎇</span>VERDICT STAMPS SINCE REVIEW
      <span class="mr-card-sub">${ts.since ? `since ${fmtTs(ts.since)}` : 'no anchor yet'}</span></div>
    ${banner}
    <div class="mr-stamps">${rows}</div>
  </div>`;
}

/* ── section: decisions docket delta ───────────────────────────────────────── */

function morningDecisions(dec, since) {
  if (!dec || !dec.available) {
    return `<div class="mr-card">
      <div class="mr-card-h"><span class="mr-h-glyph">◈</span>DECISIONS SINCE REVIEW</div>
      <div class="mr-absent">NOT AVAILABLE — owner-decisions docket not present in this worktree.</div>
    </div>`;
  }
  const c = dec.counts || {};
  const sub = `${c.open ?? 0} open · ${c.answer_pending ?? 0} answer-pending · ${c.blocked ?? 0} blocked`;
  const noAnchor = since == null; // no review mark yet → "since" deltas are undefined, shown honestly

  const listOr = (arr, empty, fn) => (Array.isArray(arr) && arr.length ? arr.map(fn).join('') : `<div class="mr-empty">${empty}</div>`);

  const newItems = listOr(dec.new_since_review, noAnchor ? 'no review anchor yet — mark reviewed to track newly-raised items' : 'no new decision items since your last review', (d) => `
    <a class="mr-dec" href="#decisions" title="open the decision docket">
      ${decisionStateChip(d.state)}
      <span class="mr-dec-cat">${d.category != null ? esc(d.category) : ''}</span>
      <span class="mr-dec-title">${d.title != null ? esc(d.title) : esc(d.id ?? '')}</span>
      <span class="mr-dec-ts">asked ${fmtTs(d.asked_on)}</span>
    </a>`);

  const answered = listOr(dec.answered_since_review, noAnchor ? 'no review anchor yet — mark reviewed to track newly-answered items' : 'no owner responses recorded since your last review', (r) => `
    <a class="mr-dec" href="#decisions" title="open the decision docket">
      ${respChip(r.action)}
      <span class="mr-dec-title">${r.title != null ? esc(r.title) : esc(r.decision_id ?? '')}</span>
      <span class="mr-dec-ts">${fmtTs(r.ts)}</span>
    </a>`);

  const pending = listOr(dec.ingestion_pending, 'no responses awaiting ingestion', (r) => `
    <a class="mr-dec pending" href="#decisions" title="response on the ledger; decision still open on the docket">
      ${respChip(r.action)}
      <span class="mr-dec-title">${r.title != null ? esc(r.title) : esc(r.decision_id ?? '')}</span>
      <span class="mr-dec-ts">${esc(r.decision_id ?? '')} · still ${esc(String(r.state ?? '').toLowerCase())}</span>
    </a>`);

  return `<div class="mr-card">
    <div class="mr-card-h"><span class="mr-h-glyph">◈</span>DECISIONS SINCE REVIEW
      <span class="mr-card-sub">${sub}</span></div>
    <div class="mr-dec-group"><div class="mr-dec-lbl">newly raised</div>${newItems}</div>
    <div class="mr-dec-group"><div class="mr-dec-lbl">newly answered by owner</div>${answered}</div>
    <div class="mr-dec-group"><div class="mr-dec-lbl">responded — awaiting orchestrator ingestion
      <span class="mr-dec-hint" title="the docket carries no explicit 'ingested' flag; this is an honest heuristic: a response exists but the decision is still on the docket">?</span></div>${pending}</div>
  </div>`;
}

/* ── section: lanes (completed + last-observed in-flight) ──────────────────── */

function morningLanes(lanes) {
  const completed = (!lanes || !lanes.completed_available)
    ? '<div class="mr-absent">NOT AVAILABLE — agent_runs.jsonl not present in this worktree.</div>'
    : (Array.isArray(lanes.recent_completed) && lanes.recent_completed.length
        ? `<div class="mr-lanes">${lanes.recent_completed.map((r) => `<div class="mr-lane">
            <span class="mr-lane-agent">${r.agent_type != null ? esc(r.agent_type) : NR}</span>
            <span class="mr-lane-model">${r.model != null ? esc(r.model) : ''}</span>
            <span class="mr-lane-metrics">${fmtDur(r.duration_s)} · ${r.turns != null ? esc(r.turns) + ' turns' : NR} · ${r.tokens ? fmtTok(r.tokens.total) : NR} tok</span>
            <span class="mr-lane-ts">${fmtTs(r.ts)}</span>
          </div>`).join('')}</div>`
        : '<div class="mr-empty">NONE LOGGED</div>');

  const inf = lanes && lanes.in_flight;
  let inflight;
  if (!inf || !inf.available) {
    inflight = `<div class="mr-absent">NOT AVAILABLE — ${inf && inf.note ? esc(inf.note) : 'no in-flight snapshot'}.</div>`;
  } else if (Array.isArray(inf.tasks) && inf.tasks.length) {
    inflight = `<div class="mr-inflight-note">last observed ${fmtTs(inf.observed_at)} — snapshot, NOT a live feed (may be stale)</div>
      <div class="mr-lanes">${inf.tasks.map((t) => `<div class="mr-lane running">
        <span class="mr-lane-agent"><span class="mr-run-dot"></span>${t.type != null ? esc(t.type) : NR}</span>
        <span class="mr-lane-desc">${t.description != null ? esc(t.description) : esc(t.id ?? '')}</span>
      </div>`).join('')}</div>`;
  } else {
    inflight = `<div class="mr-inflight-note">last observed ${fmtTs(inf.observed_at)} — snapshot, NOT a live feed</div>
      <div class="mr-empty">no running background tasks in the last-observed snapshot</div>`;
  }

  return `<div class="mr-card">
    <div class="mr-card-h"><span class="mr-h-glyph">⛭</span>LANES</div>
    <div class="mr-lane-group"><div class="mr-dec-lbl">recently completed (agent_runs tail)</div>${completed}</div>
    <div class="mr-lane-group"><div class="mr-dec-lbl">in flight (last-observed)</div>${inflight}</div>
  </div>`;
}

/* ── section: gates (from docs/GATES.md — never re-measured here) ───────────── */

function morningGates(g) {
  if (!g || !g.available) {
    return `<div class="mr-card">
      <div class="mr-card-h"><span class="mr-h-glyph">▦</span>GATES <span class="mr-card-sub">at last battery</span></div>
      <div class="mr-absent">NOT AVAILABLE — could not read docs/GATES.md.</div>
    </div>`;
  }
  const rows = (g.rows || []).map((r) => `<tr>
    <td class="mr-g-gate">${esc(r.gate)}</td>
    <td class="mr-g-cmd"><code>${esc(r.command)}</code></td>
    <td class="mr-g-exp">${esc(r.expected)}</td></tr>`).join('');
  const regen = g.regenerated_at
    ? `regenerated ${fmtTs(g.regenerated_at)}${g.regenerated_by ? ` by <code>${esc(g.regenerated_by)}</code>` : ''}`
    : 'regen marker NOT RECORDED';
  return `<div class="mr-card">
    <div class="mr-card-h"><span class="mr-h-glyph">▦</span>GATES
      <span class="mr-card-sub">AT LAST BATTERY — canonical from ${esc(g.source || 'docs/GATES.md')}, never re-measured live</span></div>
    <table class="mr-gates"><thead><tr><th>gate</th><th>command</th><th>expected</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="mr-g-regen">${regen}</div>
  </div>`;
}

/* ── cross-links strip ─────────────────────────────────────────────────────── */

function morningCrosslinks() {
  const links = [
    ['#theses', 'Theses'], ['#decisions', 'Owner Decisions'], ['#documents', 'Documents'],
    ['#flow', 'Processing Flow'], ['#tokens', 'Token Tracker'],
  ];
  return `<div class="mr-xlinks"><span class="mr-xlbl">jump to</span>
    ${links.map(([h, l]) => `<a class="mr-xlink" href="${h}">${esc(l)} ▸</a>`).join('')}</div>`;
}

/* ── the renderer app.js dispatches to ─────────────────────────────────────── */

function renderMorning() {
  const st = state.feeds.morning;
  if (st.unreachable) return subheadHtml('morning') + offlineHtml('morning', 'morning-review aggregate');
  const agg = st.data || {};
  return `${subheadHtml('morning')}
    ${morningReviewBar(agg)}
    <div class="mr-top">
      ${morningStamps(agg.thesis_stamps)}
      ${morningPacket(agg.packet)}
    </div>
    ${morningDecisions(agg.decisions, agg.since)}
    <div class="mr-two">
      ${morningLanes(agg.lanes)}
      ${morningGates(agg.gates)}
    </div>
    ${morningCrosslinks()}`;
}

/* ── the one write path: POST /api/review-mark (append-only, token-gated) ──── */

async function postReviewMark(note) {
  const token = (localStorage.getItem(MORNING_TOKEN_KEY) || '').trim();
  if (!token) {
    morningState.notice = { kind: 'err', text: 'No write token set — paste it on the Owner Decisions tab first (same X-Dashboard-Token).' };
    render();
    return;
  }
  try {
    const r = await fetch('/api/review-mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
      body: JSON.stringify({ note: note || '' }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      morningState.notice = { kind: 'ok', text: 'Review anchor recorded. Deltas below now measure from this moment.' };
      morningState.noteDraft = '';
      if (typeof refreshFeed === 'function') await refreshFeed('morning'); // recompute deltas against the new mark
      render();
    } else if (r.status === 401) {
      morningState.notice = { kind: 'err', text: 'Token rejected (401). Re-check the X-Dashboard-Token in the server console.' };
      render();
    } else {
      morningState.notice = { kind: 'err', text: `Rejected (${r.status}): ${data && data.error ? data.error : 'request refused'}.` };
      render();
    }
  } catch (err) {
    morningState.notice = { kind: 'err', text: `Could not reach the server: ${err && err.message ? err.message : String(err)}` };
    render();
  }
}

/* ── own listeners (scoped to the morning tab; no app.js behaviour changed) ── */

document.addEventListener('click', (e) => {
  if (state.active !== 'morning') return;
  const mark = e.target.closest('[data-morning-mark]');
  if (mark) {
    const inp = document.querySelector('[data-morning-note]');
    postReviewMark(inp ? inp.value : '');
    return;
  }
});

document.addEventListener('input', (e) => {
  if (state.active !== 'morning') return;
  if (e.target.matches('[data-morning-note]')) morningState.noteDraft = e.target.value; // survive the poll re-render
});

document.addEventListener('keydown', (e) => {
  if (state.active !== 'morning') return;
  if (e.key === 'Enter' && e.target.matches('[data-morning-note]')) {
    e.preventDefault();
    postReviewMark(e.target.value);
  }
});

// clear the transient notice when leaving the tab so it never resurfaces stale
window.addEventListener('hashchange', () => {
  if ((location.hash || '').slice(1).split('/')[0] !== 'morning') morningState.notice = null;
});
