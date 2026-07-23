#!/usr/bin/env node
// tools/theses/dashboard/telemetry_adapter.mjs
// Token-tracker data adapter for the 4-tab theses dashboard (tab 4).
//
// REUSES the canonical telemetry system (tools/telemetry/ — LAW 4, no rebuild):
//   - summarize.mjs  summarize()/listSessions()  -> session-level OTel aggregates
//     (cost, per-session tokens, cache-hit rate). Imported directly.
//   - agent-run aggregation follows tools/telemetry/fleet.mjs semantics
//     (dedupe SubagentStop records by agent_id, keep LAST) but is re-derived here
//     because fleet() caps completed rows at 16 and mixes in a live roster; the
//     tab needs full totals + last ~50. Canonical source: tools/telemetry/fleet.mjs.
//
// Contract: tools/theses/dashboard/telemetry_tab_contract.md
// Consumer: the dashboard server dynamic-imports this file, calls snapshot()
// per request. Crash-proof: bad JSONL lines are skipped+counted, never thrown.

import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { summarize, listSessions, DEFAULT_METRICS, DEFAULT_RUNS } from '../../telemetry/summarize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_JSON = resolve(__dirname, '../../../test_results/theses/dashboard/token_tracker_data.json');

const RECENT_N = 50;

// tokens-per-run convention matches the telemetry dashboard's ftok():
// input + output + cache_read + cache_creation.
const runTokens = (t) =>
  (t?.input ?? 0) + (t?.output ?? 0) + (t?.cache_read ?? 0) + (t?.cache_creation ?? 0);

// ---- OTel sessions block, cached by metrics.jsonl mtime+size (file is ~24MB;
// summarize() re-parses it fully, ~1-2s cold — cache keeps repeat snapshots fast).
let sessionsCache = { key: null, value: undefined };
function sessionsBlock() {
  try {
    if (!existsSync(DEFAULT_METRICS)) return undefined; // absent -> key omitted (LAW 3)
    const st = statSync(DEFAULT_METRICS);
    const key = `${st.mtimeMs}:${st.size}`;
    if (sessionsCache.key === key) return sessionsCache.value;
    const s = summarize(DEFAULT_METRICS);
    if (!s.ok) return undefined;
    const list = listSessions(DEFAULT_METRICS, DEFAULT_RUNS).map((x) => ({
      id: x.id, short: x.short,
      start: x.startMs ? new Date(x.startMs).toISOString() : null,
      last: x.lastMs ? new Date(x.lastMs).toISOString() : null,
      tokens: x.tokens, cost_usd: x.cost, agents: x.agents, is_current: x.isCurrent,
    }));
    const value = {
      count: s.sessions,
      cost_usd: s.costUSD,
      cost_by_model: s.costByModel,
      total_tokens: s.totalTokens,
      tokens_by_type: s.tokensByType,
      tokens_by_model: s.tokensByModel,
      cache_hit_rate: s.cacheHitRate,
      otel_updated: s.updatedUnixMs ? new Date(s.updatedUnixMs).toISOString() : null,
      list,
    };
    sessionsCache = { key, value };
    return value;
  } catch {
    return undefined; // never let the OTel side take down the tab
  }
}

// opts.runsPath: override agent_runs.jsonl location (tests only; default = canonical).
export async function snapshot(opts = {}) {
  const runsPath = opts.runsPath || DEFAULT_RUNS;
  const data = {
    generated_at: new Date().toISOString(),
    totals: { runs: 0, tokens: 0, by_model: {} },
    recent_runs: [],
    skipped_lines: 0,
  };

  // ---- agent_runs.jsonl (SubagentStop hook records) ----
  try {
    if (existsSync(runsPath)) {
      const byId = new Map(); // dedupe by agent_id, keep LAST (fleet.mjs semantics)
      let anon = 0;
      for (const raw of readFileSync(runsPath, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { data.skipped_lines++; continue; }
        if ((r.hook_event_name || r.event) !== 'SubagentStop') { data.skipped_lines++; continue; }
        byId.set(r.agent_id || `__anon_${anon++}`, r);
      }
      const runs = [...byId.values()].sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));

      let unenriched = 0;
      for (const r of runs) {
        data.totals.runs++;
        const enriched = !!r.tokens; // hook derives tokens/model/duration since 2026-07-08
        if (!enriched) { unenriched++; continue; }
        const tok = runTokens(r.tokens);
        data.totals.tokens += tok;
        const m = r.model || 'unknown';
        const bm = (data.totals.by_model[m] ||= { runs: 0, tokens: 0 });
        bm.runs++; bm.tokens += tok;
      }
      if (unenriched) data.totals.runs_without_token_data = unenriched;

      data.recent_runs = runs.slice(-RECENT_N).reverse().map((r) => ({
        ts: r.ts ?? null,
        agent: r.subagent_name || r.agent_type || 'unknown',
        model: r.model ?? null,                                  // null = pre-enrichment record
        tokens: r.tokens ? runTokens(r.tokens) : null,           // null, never a fake 0 (LAW 3)
        duration_s: Number(r.duration_s) > 0 ? r.duration_s : null,
        turns: r.turns ?? null,
      }));
    } else {
      data.error = `agent_runs.jsonl not found: ${runsPath}`;
    }
  } catch (e) {
    data.error = `agent_runs parse failed: ${e.message}`;
  }

  // ---- session-level OTel aggregates (omitted entirely when unavailable) ----
  const sess = sessionsBlock();
  if (sess !== undefined) data.sessions = sess;

  // ---- persist (best-effort; the returned object is the primary product) ----
  try {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    writeFileSync(OUT_JSON, JSON.stringify(data, null, 2));
  } catch (e) {
    data.write_error = `could not write ${OUT_JSON}: ${e.message}`;
  }

  return data;
}

// CLI: node tools/theses/dashboard/telemetry_adapter.mjs
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const t0 = Date.now();
  const d = await snapshot();
  const t1 = Date.now();
  const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  console.log(`snapshot() ${t1 - t0}ms (cold) -> ${OUT_JSON}`);
  console.log(`runs=${d.totals.runs} tokens=${k(d.totals.tokens)} skipped=${d.skipped_lines}` +
    (d.totals.runs_without_token_data ? ` unenriched=${d.totals.runs_without_token_data}` : ''));
  for (const [m, v] of Object.entries(d.totals.by_model).sort((a, b) => b[1].tokens - a[1].tokens))
    console.log(`  ${m.padEnd(28)} runs=${String(v.runs).padStart(4)} tokens=${k(v.tokens)}`);
  console.log(`recent_runs=${d.recent_runs.length} sessions_key=${'sessions' in d ? `yes (count=${d.sessions.count}, $${d.sessions.cost_usd})` : 'OMITTED'}`);
  const t2 = Date.now();
  await snapshot();
  console.log(`snapshot() ${Date.now() - t2}ms (warm, cached OTel)`);
}
