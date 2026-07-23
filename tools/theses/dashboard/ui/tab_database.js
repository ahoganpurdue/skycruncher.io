'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   CSL LEDGER — "Database" tab. Renders the SkyCruncher analytics roll-up
   (tools/analytics/publish_analytics.mjs → test_results/analytics/database_summary.json),
   a spec-as-receipt {spec, provenance, data} envelope.

   Loaded as a plain script BEFORE app.js, so it defines the global
   renderDatabase() that app.js's RENDERERS map dispatches to. It reads
   app.js globals (state, esc, NR, POLL_MS, fmtTs) at CALL time — defensive
   wrappers below cover the case where a helper is momentarily unavailable.

   HONESTY (LAW 3):
     · feed absent (publisher never run / no result JSON) → the explicit empty
       state "ANALYTICS NOT YET GENERATED — run publish_analytics", never blank.
     · a module absent/failed → its section renders "NOT MEASURED — <reason>",
       never a fabricated zero.
     · every number carries a source line pointing at the result JSON whose spec
       block re-derives it (/data/analytics/<file>).
   ═══════════════════════════════════════════════════════════════════════════ */

function dbEsc(s) { return typeof esc === 'function' ? esc(String(s)) : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const DB_NM = '<span class="db-nm" title="not present in the analytics result — nothing is fabricated">NOT MEASURED</span>';
function dbNR() { return typeof NR === 'string' ? NR : DB_NM; }
function dbPollS() { return (typeof POLL_MS === 'number' ? POLL_MS : 15000) / 1000; }

/* number helpers — null/undefined ALWAYS render as NOT MEASURED, never 0 or blank */
function dbInt(v) { return typeof v === 'number' && Number.isFinite(v) ? dbEsc(String(v)) : DB_NM; }
function dbNum(v, dp) { return typeof v === 'number' && Number.isFinite(v) ? dbEsc((dp != null ? v.toFixed(dp) : String(v))) : DB_NM; }
function dbPct(v) { return typeof v === 'number' && Number.isFinite(v) ? dbEsc(v.toFixed(1)) + '%' : DB_NM; }
function dbStr(v) { return v == null || v === '' ? DB_NM : dbEsc(v); }
function dbTs(iso) { return iso == null ? DB_NM : (typeof fmtTs === 'function' ? fmtTs(iso) : dbEsc(iso)); }

/* per-section source line — "source: solve_stats.json · git <head> · v<ver>" + a
   link to the raw result JSON whose spec block re-derives every number. */
function dbSource(section, modules) {
  if (!section || section.present !== true || !section.source) return '';
  const file = String(section.source).split(' ')[0]; // "solve_stats.json" or "x.json · row_counts"
  const mod = Array.isArray(modules) ? modules.find((m) => m && m.source_file === file) : null;
  const bits = [`source: <a class="db-srclink" href="/data/analytics/${dbEsc(file)}" target="_blank" rel="noopener">${dbEsc(file)}</a>`];
  if (mod && mod.git_head) bits.push(`git ${dbEsc(mod.git_head)}`);
  if (mod && mod.tool_version) bits.push(`v${dbEsc(mod.tool_version)}`);
  return `<div class="db-src">${bits.join(' · ')}</div>`;
}

/* an absent section: NOT MEASURED with the module's own reason. */
function dbAbsent(section) {
  const reason = section && section.reason ? dbEsc(section.reason) : 'NOT MEASURED';
  return `<div class="db-nmbox"><span class="db-nm">NOT MEASURED</span> <span class="db-nmreason">${reason}</span></div>`;
}

function dbTile(lbl, valHtml, cls) {
  return `<div class="tile${cls ? ' ' + cls : ''}"><div class="lbl">${dbEsc(lbl)}</div><div class="val">${valHtml}</div></div>`;
}

function dbSectionHead(title, section, modules) {
  return `<div class="db-shead"><h3>${dbEsc(title)}</h3>${dbSource(section, modules)}</div>`;
}

/* ── the tab ──────────────────────────────────────────────────────────────── */
function renderDatabase() {
  const st = (typeof state !== 'undefined' && state.feeds && state.feeds.database) ? state.feeds.database : { unreachable: true, data: null, source: null, lastOk: null };

  // (1) no feed at all → the honest empty state.
  if (st.unreachable || !st.data) {
    const last = st.lastOk && typeof fmtClock === 'function' ? `last good snapshot ${fmtClock(st.lastOk)}` : 'no snapshot this session';
    return `<div class="db-empty">
      <div class="db-empty-badge">ANALYTICS NOT YET GENERATED</div>
      <p>No analytics result was found under <code>test_results/analytics/</code>. Nothing is shown
         rather than a fabricated number (LAW 3).</p>
      <p class="db-empty-run">Run <code>node tools/analytics/publish_analytics.mjs</code> to generate it,
         then this tab renders the corpus counts, solve rates, residual, confirmation and wall-clock headlines —
         each traceable to its result JSON. Retrying every ${dbPollS()}s.</p>
      <div class="db-empty-last">${dbEsc(last)}</div>
    </div>`;
  }

  const env = st.data;                                   // { spec, provenance, data }
  const d = env && env.data ? env.data : {};
  const prov = env && env.provenance ? env.provenance : {};
  const modules = Array.isArray(d.modules) ? d.modules : [];

  return dbSubhead(st, prov) + dbRollcall(d, prov) +
    (d.generated === false ? dbAllAbsentBanner(d) : '') +
    dbReplication(d.replication, modules) +
    dbCorpus(d.corpus, modules) +
    dbSolve(d.solve, modules) +
    dbResiduals(d.residuals, modules) +
    dbConfirm(d.confirm, modules) +
    dbWall(d.wall, modules);
}

/* ── replication (what is ACTUALLY in the community database) ─────────────────
   Leads the tab: the "Database" label is earned by showing pushed-vs-local truth,
   not implied by the presence of solve stats. Sourced from the community push
   ledger via publish_analytics (replication.json). */
function dbReplication(rp, modules) {
  const head = dbSectionHead('Database replication', rp, modules);
  if (!rp || rp.present !== true) return `<section class="db-section">${head}${dbAbsent(rp)}</section>`;
  const bs = rp.by_status || {};
  const lr = rp.local_by_reason || {};
  const tiles = [
    dbTile('in database', dbInt(rp.replicated), 'pass'),
    dbTile('local only', dbInt(rp.local_only), rp.local_only ? 'warn' : ''),
    dbTile('distinct objects', dbInt(rp.distinct_objects), 'accent'),
    dbTile('distinct frames', dbInt(rp.distinct_frames)),
    dbTile('solved in DB', dbInt(rp.solved_in_db)),
    dbTile('no-solve in DB', dbInt(rp.unsolved_in_db)),
  ].join('');
  const order = ['pushed', 'deduped', 'skipped_no_identity', 'skipped_unsafe', 'failed'];
  const seen = new Set(order);
  const keys = order.concat(Object.keys(bs).filter((k) => !seen.has(k))).filter((k) => bs[k] != null);
  const chips = keys.map((k) => {
    const cls = (k === 'pushed' || k === 'deduped') ? 'ok' : (k === 'failed' ? 'warn' : '');
    return `<span class="db-statchip ${cls}">${dbEsc(k)} <b>${dbInt(bs[k])}</b></span>`;
  }).join('');
  const meta = `<div class="db-note"><b>Bucket:</b> ${dbStr(rp.bucket)} ·
    last push ${dbTs(rp.last_push_ts)} · ${dbInt(rp.total_rows)} ledger rows
    <span class="db-frameid">${dbStr(rp.ledger)}</span></div>`;
  const local = rp.local_only ? `<div class="db-note db-thr">local-only (recorded, NOT in the bucket):
    ${Object.keys(lr).map((k) => `${dbEsc(k)} ${dbInt(lr[k])}`).join(' · ')} — honest divergence, not a fabricated push.</div>` : '';
  const mean = rp.meaning ? `<div class="db-note db-thr">${dbEsc(rp.meaning)}</div>` : '';
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div>
    <div class="db-chiprow">${chips}</div>${meta}${local}${mean}</section>`;
}

function dbSubhead(st, prov) {
  const srcCls = st.source && String(st.source).startsWith('LIVE') ? '' : ' fixture';
  const src = `<span class="src${srcCls}">${dbStr(st.source)}</span>`;
  const gen = prov && prov.generated_at ? dbTs(prov.generated_at) : dbNR();
  const head = prov && prov.git_head ? `git ${dbEsc(prov.git_head)}` : '';
  const refreshed = st.lastOk && typeof fmtClock === 'function' ? fmtClock(st.lastOk) : 'never';
  return `<div class="subhead">
    ${src}
    <span>published ${gen}${head ? ' · ' + head : ''}</span>
    <span class="spacer"></span>
    <span>refreshed ${dbEsc(refreshed)} · polling ${dbPollS()}s</span>
  </div>`;
}

/* module roll-call — which analytics CLIs produced this snapshot. */
function dbRollcall(d, prov) {
  const mods = Array.isArray(d.modules) ? d.modules : [];
  if (!mods.length) return '';
  const chips = mods.map((m) => {
    const cls = m.status === 'ok' ? 'ok' : (m.status === 'failed' ? 'failed' : 'absent');
    const title = m.status === 'failed' && m.error ? ` title="${dbEsc(m.error)}"` : '';
    const ver = m.tool_version ? ` <span class="db-modver">v${dbEsc(m.tool_version)}</span>` : '';
    return `<span class="db-modchip ${cls}"${title}>${dbEsc(m.name)} <b>${dbEsc(m.status)}</b>${ver}</span>`;
  }).join('');
  return `<div class="db-rollcall">
    <span class="db-rc-lbl">analytics modules</span>
    ${chips}
    <a class="db-srclink db-rc-idx" href="/data/analytics/index.json" target="_blank" rel="noopener">index.json</a>
  </div>`;
}

function dbAllAbsentBanner(d) {
  return `<div class="db-nmbox db-banner">
    <span class="db-nm">NOT MEASURED</span>
    <span class="db-nmreason">${d.all_absent_note ? dbEsc(d.all_absent_note) : 'No analytics module produced a result yet.'}</span>
  </div>`;
}

/* ── corpus ──────────────────────────────────────────────────────────────── */
function dbCorpus(c, modules) {
  const head = dbSectionHead('Corpus', c, modules);
  if (!c || c.present !== true) return `<section class="db-section">${head}${dbAbsent(c)}</section>`;
  const k = c.by_kind || {}, cl = c.by_solve_class || {};
  const tiles = [
    dbTile('frames', dbInt(c.n_frames), 'accent'),
    dbTile('solved', dbInt(k.solved), 'pass'),
    dbTile('no-solve', dbInt(k.no_solve)),
    dbTile('assisted', dbInt(k.assisted)),
    dbTile('blind lane', dbInt(cl.blind)),
    dbTile('with receipt', dbInt(c.with_receipt)),
    dbTile('with dossier', dbInt(c.with_dossier)),
    dbTile('with envelope', dbInt(c.with_envelope)),
  ].join('');
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div></section>`;
}

/* ── solve rates (denominators always shown) ─────────────────────────────── */
function dbRate(r) {
  if (!r) return DB_NM;
  return `${dbPct(r.pct)} <span class="db-frac">${dbInt(r.n)}/${dbInt(r.d)}</span>`;
}
function dbSolve(s, modules) {
  const head = dbSectionHead('Blind solve rate', s, modules);
  if (!s || s.present !== true) return `<section class="db-section">${head}${dbAbsent(s)}</section>`;
  const den = s.denominators || {};
  const tiles = [
    dbTile('of all blind', dbRate(s.rate_all_blind), 'accent'),
    dbTile('of attempted', dbRate(s.rate_attempted), 'pass'),
    dbTile('blind frames', dbInt(den.n_blind_frames)),
    dbTile('attempted', dbInt(den.n_attempted)),
    dbTile('solved', dbInt(den.n_solved)),
    dbTile('skipped', dbInt(den.n_skipped)),
  ].join('');
  const rows = (Array.isArray(s.by_format) ? s.by_format : []).map((f) => `
    <tr><td>${dbStr(f.format)}</td><td class="num">${dbInt(f.n_solved)}/${dbInt(f.n_frames)}</td>
    <td class="num">${dbPct(f.pct_all_blind)}</td><td class="num">${dbPct(f.pct_attempted)}</td>
    <td class="num">${dbInt(f.n_skipped)}</td></tr>`).join('');
  const byFmt = rows ? `<table class="db-table"><thead><tr><th>format</th><th class="num">solved/frames</th>
    <th class="num">% all blind</th><th class="num">% attempted</th><th class="num">skipped</th></tr></thead>
    <tbody>${rows}</tbody></table>` : '';
  const assisted = s.assisted ? `<div class="db-note"><b>Assisted lane (kept apart):</b>
    ${dbInt(s.assisted.n_assisted_frames)} hinted solves, ${dbInt(s.assisted.of_which_failed_blind)} of which failed blind first.
    ${dbEsc(s.lanes_note || '')}</div>` : '';
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div>${byFmt}${assisted}</section>`;
}

/* ── residuals (edge-growth headline) ────────────────────────────────────── */
function dbResiduals(r, modules) {
  const head = dbSectionHead('Edge residuals', r, modules);
  if (!r || r.present !== true) return `<section class="db-section">${head}${dbAbsent(r)}</section>`;
  const tiles = [
    dbTile('measured', dbInt(r.frames_measured), 'accent'),
    dbTile('not measured', dbInt(r.frames_not_measured)),
    dbTile('distortion-flagged', dbInt(r.frames_flagged), 'warn'),
    dbTile('refit candidates', dbInt(r.refit_candidate_count)),
    dbTile('matched stars used', dbInt(r.matched_stars_used)),
  ].join('');
  const t = r.top_refit;
  const top = t ? `<div class="db-note"><b>Worst edge-growth frame:</b> ${dbStr(t.rig)} —
    edge excess ${dbNum(t.edge_excess_arcsec, 1)}″ (${dbNum(t.edge_excess_px, 1)} px),
    slope ${dbNum(t.slope_arcsec_per_radius, 1)}″/radius over ${dbInt(t.n_stars_used)} stars.
    <span class="db-frameid">${dbStr(t.id)}</span></div>` : '';
  const th = r.thresholds || {};
  const thr = `<div class="db-note db-thr">signature rule: ${dbStr(th.signature_rule)} ·
    slope ≥ ${dbNum(th.slope_arcsec_per_radius)}″/radius AND edge-excess ≥ ${dbNum(th.edge_excess_arcsec)}″</div>`;
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div>${top}${thr}</section>`;
}

/* ── confirmation N-profile ──────────────────────────────────────────────── */
function dbConfirm(c, modules) {
  const head = dbSectionHead('Confirmation N-profile', c, modules);
  if (!c || c.present !== true) return `<section class="db-section">${head}${dbAbsent(c)}</section>`;
  const bs = c.by_status || {};
  const order = ['CONFIRMED', 'REFUSED', 'INSUFFICIENT_TARGETS', 'NOT_RUN'];
  const statusChips = order.map((k) => `<span class="db-statchip ${k === 'CONFIRMED' ? 'ok' : (k === 'REFUSED' ? 'warn' : '')}">${dbEsc(k)} <b>${dbInt(bs[k])}</b></span>`).join('');
  const tiles = [
    dbTile('frames w/ confirm', dbInt(c.with_confirm_block), 'accent'),
    dbTile('confirmable', dbInt(c.confirmable_frames)),
    dbTile('total frames', dbInt(c.total_frames)),
  ].join('');
  const nvv = c.n_vs_verdict;
  const nBlock = nvv ? `<div class="db-note"><b>N-vs-verdict</b> (${dbStr(nvv.statistic)}):
    pearson ${dbNum(nvv.pearson, 4)} vs baseline ${dbNum(nvv.baseline, 3)} → <b>${dbStr(nvv.agreement)}</b>
    (Δ ${dbNum(nvv.delta, 4)}, spearman ρ ${dbNum(nvv.spearman_rho, 4)}, n=${dbInt(nvv.n_frames)}).
    ${nvv.baseline_source ? `<span class="db-frameid">baseline: ${dbStr(nvv.baseline_source)}</span>` : ''}</div>` : '';
  const fdr = c.fdr_shadow ? `<div class="db-note db-thr">FDR shadow: ${dbStr(c.fdr_shadow.status)}
    (${dbInt(c.fdr_shadow.present_frames)} frames)</div>` : '';
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div>
    <div class="db-chiprow">${statusChips}</div>${nBlock}${fdr}</section>`;
}

/* ── wall-clock economics ────────────────────────────────────────────────── */
function dbWall(w, modules) {
  const head = dbSectionHead('Wall-clock economics', w, modules);
  if (!w || w.present !== true) return `<section class="db-section">${head}${dbAbsent(w)}</section>`;
  const ss = w.solve_share || {};
  const bva = w.blind_vs_assisted || {};
  const cs = w.corpus_summary || {};
  const pctOf = (x) => (typeof x === 'number' && Number.isFinite(x) ? dbEsc((x * 100).toFixed(1)) + '%' : DB_NM);
  const secs = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? dbEsc((ms / 1000).toFixed(1)) + 's' : DB_NM);
  const tiles = [
    dbTile('solve % of pipeline', pctOf(ss.of_pipeline), 'accent'),
    dbTile('solve % of wall', pctOf(ss.of_wall)),
    dbTile('blind→assisted speedup', typeof bva.speedup_median === 'number' ? dbNum(bva.speedup_median, 1) + '×' : DB_NM, 'pass'),
    dbTile('timing rows', dbInt(cs.timing_rows)),
    dbTile('rows w/ stages', dbInt(cs.rows_with_stage_decomposition)),
  ].join('');
  const bvaNote = bva.paired_frames != null ? `<div class="db-note"><b>Blind vs assisted</b> (${dbInt(bva.paired_frames)} paired frames):
    blind median ${secs(bva.blind_median_ms)} → assisted median ${secs(bva.assisted_median_ms)}
    (median speedup ${typeof bva.speedup_median === 'number' ? dbNum(bva.speedup_median, 1) + '×' : DB_NM}).</div>` : '';
  const shareNote = ss.frames != null ? `<div class="db-note db-thr">solve share measured over ${dbInt(ss.frames)}
    solved frames carrying a stage decomposition (denominator: pipeline_ms).</div>` : '';
  return `<section class="db-section">${head}<div class="db-tiles">${tiles}</div>${bvaNote}${shareNote}</section>`;
}

/* expose for node tests + browser (non-module script global). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderDatabase };
}
