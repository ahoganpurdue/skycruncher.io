'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   #runtelem tab — LIVE headless-run telemetry (owner directive 2026-07-18:
   "live headless-run telemetry on the owner dashboard, build NOW while the
   graduation run is live").

   ONE feed: /data/run_telemetry.json — a compact render-ready snapshot written
   every ~5s by tools/theses/dashboard/run_telemetry_watch.mjs, which derives it
   READ-ONLY from the live corpus run dir (driver.err.log + per-frame receipt/
   crash JSON counts + run_manifest). serve.mjs auto-serves it from the data
   plane — no server change.

   HONESTY (LAW 3):
     · feed unreachable → whole-tab offline panel (watcher not launched / down)
     · any field the watcher could not derive is null in the feed and renders
       "NOT MEASURED" here — never a placeholder number
     · in-flight frame NAMES are not derivable (the driver logs no per-frame
       start lines); only an ESTIMATE (min(workers, pending)) is shown, labelled
     · nothing in this file is a hand-typed figure — every value reads
       state.feeds.runtelem.data at render time

   Classic (non-module) script, loaded before app.js so renderRunTelem() exists
   when app.js builds RENDERERS.
   ═══════════════════════════════════════════════════════════════════════════ */

const RT_NM = '<span class="rt-nm" title="not derivable from the run artifacts">NOT MEASURED</span>';

function rtNum(x) { return (x == null || !isFinite(x)) ? RT_NM : String(x); }

/** ms → "16m 39s" / "3.2s" / "1h 04m". */
function rtDur(ms) {
  if (ms == null || !isFinite(ms)) return RT_NM;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(ss).padStart(2, '0')}s`;
}

/** ISO → "3s ago" / "4m ago" / absolute if old. */
function rtAgo(iso) {
  if (!iso) return RT_NM;
  const t = Date.parse(iso);
  if (!isFinite(t)) return RT_NM;
  const d = Date.now() - t;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return esc(iso);
}

function rtStateBadge(state, incomplete) {
  const map = {
    running: ['rt-b-running', 'RUNNING'],
    done: ['rt-b-done', 'DONE'],
    pending: ['rt-b-pending', 'PENDING'],
  };
  const [cls, label] = map[state] || ['rt-b-pending', esc(String(state || '?')).toUpperCase()];
  const inc = incomplete ? '<span class="rt-b rt-b-incomplete" title="driver rolled up but done &lt; total (aborted mid-run — e.g. OOM)">ABORTED</span>' : '';
  return `<span class="rt-b ${cls}">${label}</span>${inc}`;
}

function rtVerdictChip(v) {
  const m = {
    solved: ['rt-v-solved', 'solved'],
    no_solve: ['rt-v-nosolve', 'no-solve'],
    error: ['rt-v-error', 'error'],
    crashed: ['rt-v-error', 'crashed'],
    completed: ['rt-v-done', 'done'],
  };
  const [cls, label] = m[v] || ['rt-v-other', esc(String(v || '?'))];
  return `<span class="rt-vchip ${cls}">${label}</span>`;
}

/** Segmented progress bar: solved | no-solve | crashed | pending-verdict | pending. */
function rtProgressBar(a) {
  const total = a.total;
  if (total == null || total <= 0) {
    return `<div class="rt-bar rt-bar-unknown"><span>total ${RT_NM} · ${rtNum(a.done)} done</span></div>`;
  }
  const seg = (n, cls, title) => {
    const pct = (100 * (n || 0) / total);
    if (!pct) return '';
    return `<span class="rt-seg ${cls}" style="width:${pct}%" title="${esc(title)}: ${n}"></span>`;
  };
  const pend = a.pending != null ? a.pending : Math.max(0, total - a.done);
  return `<div class="rt-bar" role="img" aria-label="${a.done}/${total} frames">
    ${seg(a.solved, 'rt-seg-solved', 'solved')}
    ${seg(a.failed, 'rt-seg-nosolve', 'no-solve')}
    ${seg(a.crashed, 'rt-seg-crashed', 'crashed')}
    ${seg(a.pending_verdict, 'rt-seg-pending-v', 'completed (verdict pending)')}
    ${seg(pend, 'rt-seg-pending', 'not started')}
  </div>`;
}

function rtArmCard(a) {
  const donePct = (a.total && a.total > 0) ? `${Math.round(100 * a.done / a.total)}%` : RT_NM;
  const tally = [
    `<span class="rt-t rt-t-solved">${rtNum(a.solved)} solved</span>`,
    `<span class="rt-t rt-t-nosolve">${rtNum(a.failed)} no-solve</span>`,
    `<span class="rt-t rt-t-crashed">${rtNum(a.crashed)} crashed</span>`,
    a.pending_verdict ? `<span class="rt-t rt-t-pv">${a.pending_verdict} verdict-pending</span>` : '',
  ].join('');
  const inflight = a.state === 'running'
    ? `<span class="rt-meta">in-flight ≈ <b>${rtNum(a.in_flight_estimate)}</b> <span class="rt-est">(est: min(workers,pending); names not logged)</span></span>`
    : '';
  const workers = a.workers != null ? `<span class="rt-meta">workers ${a.workers}</span>` : '';
  const last = a.last_finished_frame
    ? `<span class="rt-meta">last: <code>${esc(a.last_finished_frame)}</code> ${rtVerdictChip(a.last_finished_verdict)} <span class="rt-est">${rtAgo(a.last_finished_at)}</span></span>`
    : `<span class="rt-meta">last: ${RT_NM}</span>`;
  const rollupNote = a.note ? `<div class="rt-note">${esc(a.note)}</div>` : '';
  return `<div class="rt-arm rt-arm-${esc(a.state)}">
    <div class="rt-arm-head">
      <div class="rt-arm-id">Arm ${esc(a.arm)} ${rtStateBadge(a.state, a.incomplete)}</div>
      <div class="rt-arm-count">${rtNum(a.done)}<span class="rt-of">/${a.total != null ? a.total : '?'}</span> <span class="rt-pct">${donePct}</span></div>
    </div>
    ${a.desc ? `<div class="rt-arm-desc">${esc(a.desc)}</div>` : ''}
    ${rtProgressBar(a)}
    <div class="rt-tally">${tally}</div>
    <div class="rt-arm-meta">${workers}${inflight}${last}</div>
    ${rollupNote}
  </div>`;
}

function rtRecentStrip(frames) {
  if (!frames || frames.length === 0) return `<div class="rt-empty">no frames finished yet — ${RT_NM}</div>`;
  const rows = frames.map((f) => `<tr>
    <td class="rt-rc-arm">${esc(f.arm)}</td>
    <td class="rt-rc-frame"><code>${esc(f.frame)}</code></td>
    <td class="rt-rc-v">${rtVerdictChip(f.verdict)}</td>
    <td class="rt-rc-ms">${rtDur(f.ms)}</td>
  </tr>`).join('');
  return `<table class="rt-recent"><thead><tr><th>arm</th><th>frame</th><th>verdict</th><th>wall</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rtHistoryStrip(hist) {
  if (!hist || hist.length === 0) return `<div class="rt-empty">no sibling runs found — ${RT_NM}</div>`;
  return `<ul class="rt-history">${hist.map((h) => `<li class="${h.is_current ? 'rt-h-current' : ''}">
    <code>${esc(h.name)}</code>
    ${h.is_current ? '<span class="rt-b rt-b-running">CURRENT</span>' : ''}
    <span class="rt-meta">${h.launch_sha ? `sha ${esc(h.launch_sha)}` : RT_NM}</span>
    <span class="rt-meta">${h.mode ? esc(h.mode) : ''}</span>
    <span class="rt-meta">${h.generated_at ? rtAgo(h.generated_at) : RT_NM}</span>
  </li>`).join('')}</ul>`;
}

function renderRunTelem() {
  const st = state.feeds.runtelem;
  if (!st || st.unreachable) {
    return subheadHtml('runtelem') + `<div class="offline">
      <div class="o-badge">NOT MEASURED</div>
      <p><code>run_telemetry.json</code> is not being served (the watcher is not running, or no run is live).
         Launch it with
         <code>node tools/theses/dashboard/run_telemetry_watch.mjs --run-dir &lt;run&gt; --interval-ms 5000</code>.
         Retrying every ${POLL_MS / 1000}s.</p>
    </div>`;
  }
  const d = st.data || {};
  const run = d.run || {};
  if (!run.available) {
    return subheadHtml('runtelem') + `<div class="offline">
      <div class="o-badge">NO LIVE RUN</div>
      <p>The watcher is up but the run directory is not present or has no data yet.
         ${run.note ? `<br><code>${esc(run.note)}</code>` : ''}</p>
    </div>`;
  }
  const arms = d.arms || [];
  const cur = run.current_arm;
  const header = `<div class="rt-runhead">
    <div class="rt-rh-main">
      <span class="rt-rh-label">CURRENT ARM</span>
      <span class="rt-rh-arm">${run.run_complete ? 'RUN COMPLETE' : (cur ? esc(cur) : RT_NM)}</span>
    </div>
    <div class="rt-rh-facts">
      <span>sha <code>${run.launch_sha ? esc(run.launch_sha) : '—'}</code></span>
      <span>mode ${run.mode ? esc(run.mode) : RT_NM}</span>
      <span>arms ${(run.arms_sequence || []).map(esc).join(' → ') || RT_NM}</span>
      <span>frames/arm ${rtNum(run.total_frames_per_arm)}</span>
      <span>wall ${rtDur(run.wall_ms_so_far)}</span>
    </div>
  </div>`;

  return subheadHtml('runtelem') +
    `<p class="rt-lede">Live headless-run telemetry, derived READ-ONLY every ${d.watcher ? (d.watcher.interval_ms / 1000) : 5}s by
      <code>run_telemetry_watch.mjs</code> from the run's <code>driver.err.log</code> + per-frame receipt/crash counts.
      Run dir: <code>${esc(d.watcher ? d.watcher.run_dir : 'NOT RECORDED')}</code>.
      Snapshot age: ${rtAgo(d.generated_at)}.</p>
    ${header}
    <div class="rt-arms">${arms.map(rtArmCard).join('')}</div>
    <h3 class="rt-h3">Recent frames <span class="rt-sub">(most recent first)</span></h3>
    ${rtRecentStrip(d.recent_frames)}
    <h3 class="rt-h3">Recent runs</h3>
    ${rtHistoryStrip(d.history)}`;
}
