#!/usr/bin/env node
// tools/telemetry/summarize.mjs
// Parse the local OTel collector's metrics.jsonl (OTLP/JSON, DELTA sums) into a
// flat rollup: tokens (by type/model), cost (total + by model), cache-hit rate,
// edit accept/reject, live burn rate, plus a per-session index for the dashboard's
// session filter. Reused by dashboard.mjs. CLI mode prints a terse table.
//
// OTLP note: claude_code.* counters export with aggregationTemporality=1 (DELTA),
// isMonotonic=true -> each datapoint is an increment, so totals are a straight SUM.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_METRICS = resolve(__dirname, '../../test_results/otel/metrics.jsonl');
export const DEFAULT_RUNS = resolve(__dirname, '../../test_results/agent_runs.jsonl');

const attr = (dp, key) => {
  const a = dp.attributes?.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value || {};
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
};
const num = (dp) => Number(dp.asDouble ?? dp.asInt ?? 0);

// Walk every datapoint, calling cb(metricName, dp). Returns parsed-line count.
function eachDataPoint(text, cb) {
  let lines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    lines++;
    for (const rm of obj.resourceMetrics || [])
      for (const sm of rm.scopeMetrics || [])
        for (const m of sm.metrics || []) {
          const pts = m.sum?.dataPoints || m.gauge?.dataPoints || m.histogram?.dataPoints || [];
          for (const dp of pts) cb(m.name, dp);
        }
  }
  return lines;
}

// sessionFilter: array/Set of session ids to include, or null/undefined = all.
export function summarize(metricsPath = DEFAULT_METRICS, sessionFilter = null, nowMs) {
  const now = nowMs || Date.now();
  if (!existsSync(metricsPath)) return { ok: false, error: `metrics file not found: ${metricsPath}` };
  const filter = sessionFilter ? new Set(sessionFilter) : null;
  const text = readFileSync(metricsPath, 'utf8');

  const tokensByType = {}, tokensByModel = {}, costByModel = {};
  let costUSD = 0, linesAdded = 0, linesRemoved = 0, commits = 0, activeTimeSec = 0;
  let recentTokens = 0; const RECENT_MS = 5 * 60 * 1000;
  const editDecisions = { accept: 0, reject: 0, byTool: {} };
  const sessions = new Set(), models = new Set();
  let lastTsNano = 0;

  const exportLines = eachDataPoint(text, (name, dp) => {
    const sid = attr(dp, 'session.id');
    if (filter && sid && !filter.has(sid)) return;
    if (sid) sessions.add(sid);
    const model = attr(dp, 'model'); if (model) models.add(model);
    const tsNano = Number(dp.timeUnixNano || 0); if (tsNano > lastTsNano) lastTsNano = tsNano;
    const v = num(dp);
    switch (name) {
      case 'claude_code.token.usage': {
        const t = attr(dp, 'type') || 'unknown';
        tokensByType[t] = (tokensByType[t] || 0) + v;
        if (model) tokensByModel[model] = (tokensByModel[model] || 0) + v;
        if (tsNano && now - tsNano / 1e6 < RECENT_MS) recentTokens += v;
        break;
      }
      case 'claude_code.cost.usage': {
        costUSD += v; if (model) costByModel[model] = (costByModel[model] || 0) + v; break;
      }
      case 'claude_code.lines_of_code.count':
        if (attr(dp, 'type') === 'removed') linesRemoved += v; else linesAdded += v; break;
      case 'claude_code.commit.count': commits += v; break;
      case 'claude_code.active_time.total': activeTimeSec += v; break;
      case 'claude_code.code_edit_tool.decision': {
        const d = attr(dp, 'decision') === 'reject' ? 'reject' : 'accept';
        editDecisions[d] += v;
        const tool = attr(dp, 'tool_name') || '?';
        editDecisions.byTool[tool] = editDecisions.byTool[tool] || { accept: 0, reject: 0 };
        editDecisions.byTool[tool][d] += v; break;
      }
      default: break;
    }
  });

  const totalTokens = Object.values(tokensByType).reduce((a, b) => a + b, 0);
  const cacheRead = tokensByType.cacheRead || 0;
  const cacheDenom = (tokensByType.input || 0) + cacheRead + (tokensByType.cacheCreation || 0);
  for (const k of Object.keys(costByModel)) costByModel[k] = Number(costByModel[k].toFixed(4));
  return {
    ok: true, metricsPath,
    updatedUnixMs: lastTsNano ? Math.round(lastTsNano / 1e6) : null,
    exportLines, sessions: sessions.size, models: [...models],
    costUSD: Number(costUSD.toFixed(4)), costByModel,
    totalTokens, tokensByType, tokensByModel,
    cacheHitRate: cacheDenom ? Number((cacheRead / cacheDenom).toFixed(4)) : 0,
    burnTokPerMin: Math.round(recentTokens / 5),
    editDecisions,
    linesAdded, linesRemoved, commits, activeTimeSec: Number(activeTimeSec.toFixed(1)),
  };
}

// Per-session index for the dashboard's session picker. Reads OTel (tokens/cost/
// timestamps per session) + agent_runs (agent count, and which session is current).
export function listSessions(metricsPath = DEFAULT_METRICS, runsPath = DEFAULT_RUNS, nowMs) {
  const now = nowMs || Date.now();
  const byId = {};
  const touch = (id) => (byId[id] ||= { id, startMs: Infinity, lastMs: 0, tokens: 0, cost: 0, agents: 0 });
  if (existsSync(metricsPath)) {
    eachDataPoint(readFileSync(metricsPath, 'utf8'), (name, dp) => {
      const id = attr(dp, 'session.id'); if (!id) return;
      const s = touch(id);
      const ms = Number(dp.timeUnixNano || 0) / 1e6;
      if (ms) { s.startMs = Math.min(s.startMs, ms); s.lastMs = Math.max(s.lastMs, ms); }
      if (name === 'claude_code.token.usage') s.tokens += num(dp);
      else if (name === 'claude_code.cost.usage') s.cost += num(dp);
    });
  }
  let current = null;
  if (existsSync(runsPath)) {
    const recs = readFileSync(runsPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const agentCount = {};
    for (const r of recs) {
      if (!r.session_id) continue;
      const s = touch(r.session_id);
      // Fold hook timestamps into the session window so sessions that predate the
      // OTel collector still get a real start/last time (not the epoch fallback).
      const ms = Date.parse(r.ts);
      if (ms) { s.startMs = Math.min(s.startMs, ms); s.lastMs = Math.max(s.lastMs, ms); }
      if (r.agent_id) (agentCount[r.session_id] ||= new Set()).add(r.agent_id);
    }
    if (recs.length) current = recs[recs.length - 1].session_id;
    for (const [id, set] of Object.entries(agentCount)) { touch(id).agents = set.size; }
  }
  return Object.values(byId)
    .map((s) => ({
      id: s.id, short: s.id.slice(0, 8),
      startMs: Number.isFinite(s.startMs) ? Math.round(s.startMs) : null,
      lastMs: s.lastMs || null,
      ageSec: s.lastMs ? Math.round((now - s.lastMs) / 1000) : null,
      tokens: Math.round(s.tokens), cost: Number(s.cost.toFixed(4)),
      agents: s.agents, isCurrent: s.id === current,
    }))
    .sort((a, b) => (b.startMs || 0) - (a.startMs || 0));
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const s = summarize();
  if (!s.ok) { console.error(s.error); process.exit(1); }
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
  console.log('SkyCruncher telemetry rollup');
  console.log('  sessions     :', s.sessions, '·', s.models.join(', '));
  console.log('  cost (USD)   : $' + s.costUSD.toFixed(4));
  for (const [m, c] of Object.entries(s.costByModel).sort((a, b) => b[1] - a[1]))
    console.log('      ' + m.replace('claude-', '').padEnd(20), '$' + c.toFixed(4));
  console.log('  tokens total :', k(s.totalTokens), '· cache-hit', (s.cacheHitRate * 100).toFixed(1) + '%', '· burn', k(s.burnTokPerMin) + '/min');
  for (const [t, v] of Object.entries(s.tokensByType).sort((a, b) => b[1] - a[1]))
    console.log('      ' + t.padEnd(14), k(v));
  console.log('  edits        :', s.editDecisions.accept, 'accept /', s.editDecisions.reject, 'reject');
  console.log('  lines +/-    : +' + s.linesAdded, '-' + s.linesRemoved, '· commits', s.commits, '· active', s.activeTimeSec + 's');
  console.log('\nSESSIONS:');
  for (const ss of listSessions())
    console.log('  ' + (ss.isCurrent ? '►' : ' '), ss.short, new Date(ss.startMs).toISOString().slice(5, 16).replace('T', ' '),
      '· ' + k(ss.tokens) + 'tok · $' + ss.cost.toFixed(2) + ' · ' + ss.agents + ' agents');
}
