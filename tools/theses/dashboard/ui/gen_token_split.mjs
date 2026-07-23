#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   GENERATOR — token_split.{json,js}   (#tokens tab: composition panel)

   Derives the INPUT / OUTPUT / CACHE-READ / CACHE-CREATION token composition
   from test_results/agent_runs.jsonl (the SubagentStop hook log). Emits a
   compact global the tokens tab reads client-side, with a selector for:
     · FLEET   — every measured run summed.
     · SESSION — measured runs aggregated by session_id.
     · RUN     — recent individual agent runs.

   WHY A STATIC GLOBAL (not a server feed): the dashboard server (serve.mjs) is
   long-running and MUST NOT be restarted; its telemetry adapter is import-cached,
   so an adapter edit would not take effect live. A ui/ static file, by contrast,
   is served fresh from disk on every request — so regenerating this global and
   reloading the page surfaces new data with zero server change. Same pattern as
   flow_stages.js / flow_edge_semantics.js.

   HONESTY (LAW 3):
     · agent_runs rows only carry a token split since the 2026-07-08 hook
       upgrade. Rows without `tokens` are COUNTED as unmeasured, never guessed.
     · agent_runs logs SUBAGENT stops only — a per-session aggregate here is the
       sum of that session's SUBAGENTS, and does NOT include the orchestrator
       main-thread tokens. This caveat travels in the data + is shown in the tab.
     · Complete session-level splits (main thread included) live in the OTel
       collector (test_results/otel/metrics.jsonl). This generator STATS that
       file and reports its freshness, but does not parse it — if it is stale or
       absent, the tab says so rather than showing a stale number as if live.

   Run:  node tools/theses/dashboard/ui/gen_token_split.mjs
   Emits (NOT committed — volatile telemetry snapshot, gitignored via ui/.gitignore):
     tools/theses/dashboard/ui/token_split.json
     tools/theses/dashboard/ui/token_split.js   (window.__TOKEN_SPLIT__)
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const RUNS_PATH = resolve(REPO_ROOT, 'test_results', 'agent_runs.jsonl');
const OTEL_METRICS = resolve(REPO_ROOT, 'test_results', 'otel', 'metrics.jsonl');

const RECENT_RUNS = 200;   // per-run selector cap (keeps the global small)
const SPLIT_KEYS = ['input', 'output', 'cache_read', 'cache_creation'];

const zeroSplit = () => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
const addSplit = (a, t) => { for (const k of SPLIT_KEYS) a[k] += Number(t[k]) || 0; return a; };
const hasSplit = (t) => t && SPLIT_KEYS.some((k) => typeof t[k] === 'number');
const shortSess = (s) => (typeof s === 'string' ? s.slice(0, 8) : null);

function build() {
  if (!existsSync(RUNS_PATH)) {
    return { available: false, reason: `agent_runs.jsonl not found at ${RUNS_PATH}` };
  }

  // dedupe SubagentStop by agent_id, keep LAST (tools/telemetry/fleet.mjs semantics)
  const byId = new Map();
  let anon = 0, skipped = 0;
  for (const raw of readFileSync(RUNS_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { skipped++; continue; }
    if ((r.hook_event_name || r.event) !== 'SubagentStop') { skipped++; continue; }
    byId.set(r.agent_id || `__anon_${anon++}`, r);
  }
  const runs = [...byId.values()].sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));

  const fleet = zeroSplit();
  let measured = 0, unmeasured = 0, newestTs = null;
  const sessions = new Map();
  const measuredRuns = [];

  for (const r of runs) {
    if (r.ts && (!newestTs || r.ts > newestTs)) newestTs = r.ts;
    if (!hasSplit(r.tokens)) { unmeasured++; continue; }
    measured++;
    addSplit(fleet, r.tokens);
    const split = zeroSplit(); addSplit(split, r.tokens);
    const rec = {
      ts: r.ts ?? null,
      agent: r.subagent_name || r.agent_type || 'unknown',
      model: r.model ?? null,
      session: shortSess(r.session_id),
      split,
    };
    measuredRuns.push(rec);

    const sid = r.session_id || 'unknown';
    let s = sessions.get(sid);
    if (!s) { s = { id: sid, short: shortSess(sid), runs: 0, split: zeroSplit(), first_ts: r.ts, last_ts: r.ts, models: {} }; sessions.set(sid, s); }
    s.runs++; addSplit(s.split, r.tokens);
    if (r.ts && (!s.first_ts || r.ts < s.first_ts)) s.first_ts = r.ts;
    if (r.ts && (!s.last_ts || r.ts > s.last_ts)) s.last_ts = r.ts;
    if (r.model) s.models[r.model] = (s.models[r.model] || 0) + 1;
  }

  const sessionList = [...sessions.values()]
    .sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0));

  // OTel freshness (stat only — never parse the ~24MB file here)
  let otel;
  if (!existsSync(OTEL_METRICS)) {
    otel = { present: false, note: 'OTel metrics.jsonl absent — complete per-session splits (incl. orchestrator main thread) NOT AVAILABLE.' };
  } else {
    const st = statSync(OTEL_METRICS);
    const lastWrite = new Date(st.mtimeMs).toISOString();
    const stale = !!(newestTs && lastWrite < newestTs);
    otel = {
      present: true,
      last_write: lastWrite,
      size_mb: +(st.size / 1e6).toFixed(1),
      stale,
      note: stale
        ? `OTel collector last wrote ${lastWrite.slice(0, 10)}, older than the newest agent run (${(newestTs || '').slice(0, 10)}) — its complete session splits are STALE. The session view below uses the CURRENT agent_runs subagent aggregation instead (main-thread tokens not included).`
        : 'OTel metrics present and current; complete session splits could be layered in a future pass.',
    };
  }

  return {
    available: true,
    generated_at: new Date().toISOString(),
    provenance: {
      runs_source: 'test_results/agent_runs.jsonl (SubagentStop hook log)',
      split_keys: SPLIT_KEYS,
      caveats: [
        'agent_runs logs SUBAGENT stops only — session aggregates exclude the orchestrator main thread.',
        'Rows before the 2026-07-08 hook upgrade carry no token split and are counted as unmeasured, never guessed.',
      ],
    },
    fleet: {
      split: fleet,
      total: SPLIT_KEYS.reduce((a, k) => a + fleet[k], 0),
      measured_runs: measured,
      unmeasured_runs: unmeasured,
      total_runs: measured + unmeasured,
      sessions: sessionList.length,
      skipped_lines: skipped,
    },
    otel,
    sessions: sessionList.map((s) => ({
      id: s.id, short: s.short, runs: s.runs, split: s.split,
      total: SPLIT_KEYS.reduce((a, k) => a + s.split[k], 0),
      first_ts: s.first_ts, last_ts: s.last_ts,
      models: Object.entries(s.models).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}×${n}`),
    })),
    runs: measuredRuns.slice(-RECENT_RUNS).reverse(),
  };
}

const model = build();
const jsonPath = resolve(__dirname, 'token_split.json');
const jsPath = resolve(__dirname, 'token_split.js');

writeFileSync(jsonPath, JSON.stringify(model, null, 2) + '\n');
writeFileSync(
  jsPath,
  '/* GENERATED from token_split.json by gen_token_split.mjs — volatile telemetry\n' +
  '   snapshot (gitignored). file:// loader shim: the tokens tab reads this global.\n' +
  '   Regenerate: node tools/theses/dashboard/ui/gen_token_split.mjs */\n' +
  'window.__TOKEN_SPLIT__ = ' + JSON.stringify(model, null, 2) + ';\n',
);

if (model.available) {
  const f = model.fleet, t = f.total || 1;
  console.log('wrote', jsPath);
  console.log(`measured=${f.measured_runs} unmeasured=${f.unmeasured_runs} sessions=${f.sessions}`);
  console.log(SPLIT_KEYS.map((k) => `${k}=${(100 * f.split[k] / t).toFixed(1)}%`).join(' '));
  console.log('otel:', model.otel.present ? (model.otel.stale ? 'STALE' : 'current') : 'ABSENT');
} else {
  console.log('wrote', jsPath, '— NOT AVAILABLE:', model.reason);
}
