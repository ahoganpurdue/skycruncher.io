'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   #pools tab — dual-account POOL VISIBILITY (owner ruling: shared token-pool
   visibility + semantic ACCEPT/DEFER/RECOMMEND handoffs, ALL INFORMATION, NO
   AUTOMATION — this panel routes nothing, ever).

   Data (both written by tools/ops/account_pools.mjs, served by the generic
   /data passthrough — no server changes):
     · /data/account_pools.json  (feed 'pools')  — schema account-pools/1;
       every number is an OBSERVATION (manual /status read or statusline
       rate_limits feed), recorded verbatim. null → NOT MEASURED.
     · /data/pool_handoffs.json  (state.poolHandoffs, non-fatal side fetch) —
       derived view of the append-only pool_handoffs.jsonl ledger.

   Classic (non-module) script, same global scope as app.js, loaded BEFORE it
   so `renderPools` exists when app.js builds RENDERERS.

   HONESTY (LAW 3):
     · absent pools file → explicit NOT MEASURED panel, never a placeholder bar
     · absent metric     → "NOT MEASURED" cell, bar not drawn
     · observation age is shown plainly (arithmetic on the recorded timestamp);
       >6h old gets an "aging" hint — a prompt to re-read /status, not a guess
   ═══════════════════════════════════════════════════════════════════════════ */

const POOLS_AGING_HOURS = 6; // observation older than this → visual "aging" hint

function poolsAgeText(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return { text: 'just now', aging: false };
  if (mins < 60) return { text: `${mins}m ago`, aging: false };
  const hrs = mins / 60;
  return { text: hrs < 48 ? `${hrs.toFixed(1)}h ago` : `${Math.round(hrs / 24)}d ago`, aging: hrs > POOLS_AGING_HOURS };
}

/* one utilization window row: bar drawn ONLY when a real pct exists */
function poolsWindowRow(name, w) {
  const pct = w && w.utilization_pct != null && Number.isFinite(Number(w.utilization_pct))
    ? Math.max(0, Math.min(100, Number(w.utilization_pct))) : null;
  const resets = w && w.resets_at ? fmtTs(w.resets_at) : NR;
  const bar = pct != null
    ? `<span class="pool-track"><span class="pool-fill${pct >= 80 ? ' hot' : ''}" style="width:${pct}%"></span></span>
       <span class="pool-pct">${pct}%</span>`
    : `<span class="pool-track"></span><span class="pool-pct nr" title="no observation recorded for this window">NOT MEASURED</span>`;
  return `<div class="pool-window">
    <span class="pool-wname">${esc(name)}</span>
    ${bar}
    <span class="pool-resets">resets ${resets}</span>
  </div>`;
}

function poolsAccountCard(id, a) {
  const age = poolsAgeText(a.observed_at);
  const obs = a.observed_at
    ? `observed ${fmtTs(a.observed_at)}${age ? ` <span class="pool-age${age.aging ? ' aging' : ''}">(${esc(age.text)}${age.aging ? ' — aging, re-read /status' : ''})</span>` : ''}`
    : `observed <span class="nr">NEVER</span>`;
  return `<div class="pool-card${age && age.aging ? ' pool-card-aging' : ''}">
    <div class="pool-card-h">
      <span class="pool-id">${esc(id)}</span>
      <b>${a.label != null ? esc(a.label) : NR}</b>
      <span class="pool-role">${a.role != null ? esc(a.role) : ''}</span>
    </div>
    ${poolsWindowRow('5h session', a.five_hour)}
    ${poolsWindowRow('7d week', a.seven_day)}
    <div class="pool-card-foot">
      <span>${obs}</span>
      <span class="pool-src">${a.source != null ? esc(a.source) : NR}</span>
    </div>
    ${a.note ? `<div class="pool-note">${esc(a.note)}</div>` : ''}
  </div>`;
}

function poolsHandoffRows() {
  const v = state.poolHandoffs;
  if (!v || !Array.isArray(v.handoffs)) {
    return `<div class="pool-hand-empty">handoff ledger not available — no entries recorded yet
      (append via <code>tools/ops/account_pools.mjs handoff</code>)</div>`;
  }
  if (v.handoffs.length === 0) {
    return `<div class="pool-hand-empty">ledger present, zero handoffs recorded</div>`;
  }
  const rows = v.handoffs.map((h) => `
    <div class="pool-hrow">
      <span class="pool-act pool-act-${esc(String(h.action || '').toLowerCase())}">${esc(h.action ?? '?')}</span>
      <span class="pool-hitem">${esc(h.item ?? '')}</span>
      <span class="pool-hwho">${h.from_account != null ? `${esc(h.from_account)} → ${h.to_account != null ? esc(h.to_account) : '?'}` : ''}</span>
      <span class="pool-hts">${fmtTs(h.ts)}</span>
      ${h.reason ? `<div class="pool-hreason">${esc(h.reason)}</div>` : ''}
    </div>`).join('');
  const more = v.total > v.handoffs.length
    ? `<div class="pool-hand-more">showing newest ${v.handoffs.length} of ${esc(v.total)} — full history in pool_handoffs.jsonl</div>` : '';
  return rows + more;
}

function renderPools() {
  const st = state.feeds.pools;
  if (st.unreachable) {
    return subheadHtml('pools') + `<div class="offline">
      <div class="o-badge">NOT MEASURED</div>
      <p><code>account_pools.json</code> has not been written yet (or the server is down).
         Pool state is an <b>observation</b>, never a guess — record one with
         <code>node tools/ops/account_pools.mjs record --account A --source "manual /status read" --five-hour-pct … --seven-day-pct …</code>.
         Retrying every ${POLL_MS / 1000}s.</p>
    </div>`;
  }
  const d = st.data;
  const accounts = d && d.accounts && typeof d.accounts === 'object' ? Object.entries(d.accounts) : [];
  const cards = accounts.length
    ? `<div class="pool-grid">${accounts.map(([id, a]) => poolsAccountCard(id, a || {})).join('')}</div>`
    : `<div class="pool-hand-empty">pools file present but carries zero accounts</div>`;

  return subheadHtml('pools') +
    `<p class="pool-lede">Shared token-pool visibility for the two-account split (owner ruling:
      <b>all information, no automation</b> — nothing here routes work; orchestrators read and decide).
      Every number is an observation recorded via <code>tools/ops/account_pools.mjs</code>; absent = NOT MEASURED.</p>` +
    cards +
    `<h2 class="rule">handoff ledger — ACCEPT · DEFER · RECOMMEND (append-only)</h2>
     <p class="pool-lede">Semantic handoffs between account orchestrators: ACCEPT = takes the item,
       DEFER = parks it, RECOMMEND = suggests the other account takes it. Advisory only.</p>
     <div class="pool-hrows">${poolsHandoffRows()}</div>`;
}
