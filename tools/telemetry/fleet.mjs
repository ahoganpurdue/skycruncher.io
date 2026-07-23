#!/usr/bin/env node
// tools/telemetry/fleet.mjs
// Live agent-fleet view from LOCAL sanctioned sources only (zero agent round-trips):
//   - test_results/agent_runs.jsonl  (SubagentStop hook): per-instance tokens/
//     duration/turns/model on completion + a live background_tasks[] roster snapshot.
//   - test_results/otel/metrics.jsonl (OTel): token/cost split by query_source.
//   - <project>/<session>/subagents/agent-<id>.jsonl : a RUNNING subagent's model
//     (read from the file HEAD only — model is in the first assistant message; we
//     never load the full transcript into memory).
//
// Honest-or-absent: a running agent's per-instance token spend is only known ON
// COMPLETION (the hook fires at SubagentStop). Running rows show measured elapsed
// vs the CALIBRATED time estimate + model; never a fabricated token count.

import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNS = resolve(__dirname, '../../test_results/agent_runs.jsonl');
export const DEFAULT_METRICS = resolve(__dirname, '../../test_results/otel/metrics.jsonl');

// Calibrated time estimates (seconds) from CLAUDE.md's 26-run ledger. Soft budgets.
const EST_SEC = {
  scout: 240, gatekeeper: 240, auditor: 600, researcher: 600,
  measurer: 900, surgeon: 2700, 'general-purpose': 900, custom: 900,
};
const estFor = (t) => EST_SEC[t] ?? 900;

function targetFromCommand(cmd = '') {
  const hits = new Set();
  const re = /([\w./-]+\.(?:ts|tsx|mjs|js|json|app\.json|fits|cr2|log|sh))/gi;
  let m; while ((m = re.exec(cmd)) && hits.size < 6) hits.add(m[1]);
  const fm = cmd.match(/FRAMES="([^"]+)"/);
  if (fm) fm[1].split(/\s+/).slice(0, 8).forEach((f) => hits.add(f));
  return [...hits];
}

// Read the first ~64KB of a subagent transcript and pull its model. Cheap: the
// model appears in the first assistant message; we never read the whole file.
function readHead(path, bytes = 65536) {
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}
function modelForRunning(projectDir, sessionId, agentId) {
  if (!projectDir || !sessionId) return null;
  const p = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  const m = readHead(p).match(/"model":"([^"]+)"/);
  return m ? m[1] : null;
}

export function fleet(runsPath = DEFAULT_RUNS, metricsPath = DEFAULT_METRICS, sessionFilter = null, nowMs) {
  const now = nowMs || Date.now();
  if (!existsSync(runsPath)) return { ok: false, error: `agent_runs.jsonl not found: ${runsPath}` };
  const filter = sessionFilter ? new Set(sessionFilter) : null;

  const records = readFileSync(runsPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!records.length) return { ok: false, error: 'no records in agent_runs.jsonl' };

  const last = records[records.length - 1];
  const currentSession = last.session_id;
  const snapshotMs = Date.parse(last.ts);
  // Project dir = the directory holding <session>.jsonl (from any transcript_path).
  const projectDir = last.transcript_path ? dirname(last.transcript_path) : null;

  // First time each background-task id was seen -> ~start time.
  const firstSeenMs = {};
  for (const r of records) {
    const t = Date.parse(r.ts);
    for (const bt of r.background_tasks || []) if (!(bt.id in firstSeenMs)) firstSeenMs[bt.id] = t;
  }

  // Completed subagents keyed by agent_id (optionally session-filtered), keep last.
  const completedById = {};
  for (const r of records) {
    if (r.hook_event_name !== 'SubagentStop' || !r.agent_id) continue;
    if (filter && !filter.has(r.session_id)) continue;
    completedById[r.agent_id] = r;
  }
  const completedIds = new Set(Object.keys(completedById));

  // Live roster (only meaningful for the current session's snapshot). Suppressed
  // when the filter excludes the current session.
  const showRoster = !filter || filter.has(currentSession);
  const running = !showRoster ? [] : (last.background_tasks || [])
    .filter((bt) => bt.status === 'running' && !(bt.type === 'subagent' && completedIds.has(bt.id)))
    .map((bt) => {
      const startMs = firstSeenMs[bt.id];
      const elapsedSec = startMs ? Math.round((now - startMs) / 1000) : null;
      const est = estFor(bt.agent_type);
      return {
        id: bt.id, kind: bt.type, agentType: bt.agent_type || bt.type,
        model: bt.type === 'subagent' ? modelForRunning(projectDir, currentSession, bt.id) : null,
        description: bt.description || '',
        target: bt.type === 'shell' ? targetFromCommand(bt.command) : [],
        elapsedSec, estSec: bt.type === 'subagent' ? est : null,
        overBudget: elapsedSec != null && bt.type === 'subagent' && elapsedSec > est,
      };
    });

  // Only records enriched with a real duration (the hook derives duration/tokens/
  // model since 2026-07-08; older records lack them and would show as 0m00s junk).
  const completedArr = Object.values(completedById)
    .filter((r) => Number(r.duration_s) > 0)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const completed = completedArr.slice(0, 16).map((r) => ({
    id: r.agent_id, agentType: r.agent_type, model: r.model,
    durationSec: r.duration_s, estSec: estFor(r.agent_type), turns: r.turns,
    tokens: {
      input: r.tokens?.input ?? 0, output: r.tokens?.output ?? 0,
      cacheRead: r.tokens?.cache_read ?? 0, cacheCreation: r.tokens?.cache_creation ?? 0,
    },
    effort: r.effort?.level ?? null,
    result: (r.last_assistant_message || '').replace(/\s+/g, ' ').slice(0, 90),
  }));

  // Calibration: est-vs-actual per agent type (feeds the CLAUDE.md timekeeper goal).
  const cal = {};
  for (const r of completedArr) {
    const t = r.agent_type || 'custom';
    (cal[t] ||= { type: t, n: 0, totalSec: 0, estSec: estFor(t) });
    cal[t].n++; cal[t].totalSec += r.duration_s || 0;
  }
  const calibration = Object.values(cal).map((c) => {
    const avg = c.n ? c.totalSec / c.n : 0;
    return { type: c.type, n: c.n, avgSec: Math.round(avg), estSec: c.estSec,
      deltaPct: c.estSec ? Math.round(((avg - c.estSec) / c.estSec) * 100) : 0 };
  }).sort((a, b) => b.n - a.n);

  // OTel live token/cost split by query_source.
  const spend = { main: { tokens: 0, cost: 0 }, subagent: { tokens: 0, cost: 0 }, auxiliary: { tokens: 0, cost: 0 } };
  if (existsSync(metricsPath)) {
    for (const line of readFileSync(metricsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
      for (const rm of o.resourceMetrics || []) for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
        if (m.name !== 'claude_code.token.usage' && m.name !== 'claude_code.cost.usage') continue;
        for (const dp of m.sum?.dataPoints || []) {
          const a = (k) => dp.attributes?.find((x) => x.key === k)?.value?.stringValue;
          if (filter && a('session.id') && !filter.has(a('session.id'))) continue;
          const bucket = spend[a('query_source')]; if (!bucket) continue;
          const v = Number(dp.asDouble ?? dp.asInt ?? 0);
          if (m.name === 'claude_code.token.usage') bucket.tokens += v; else bucket.cost += v;
        }
      }
    }
    for (const b of Object.values(spend)) b.cost = Number(b.cost.toFixed(4));
  }

  return {
    ok: true, now, sessionId: currentSession, rosterShown: showRoster,
    snapshotAgeSec: snapshotMs ? Math.round((now - snapshotMs) / 1000) : null,
    runningCount: running.length, running, completed, calibration, spend,
  };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const f = fleet();
  if (!f.ok) { console.error(f.error); process.exit(1); }
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const mmss = (s) => s == null ? '  -  ' : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  const short = (m) => (m || '?').replace('claude-', '');
  console.log(`FLEET  session ${String(f.sessionId).slice(0, 8)}  ·  roster ${f.snapshotAgeSec}s old`);
  console.log(`\nRUNNING (${f.runningCount}):`);
  for (const r of f.running) {
    const bud = r.estSec ? ` / ~${mmss(r.estSec)}${r.overBudget ? ' OVER' : ''}` : '';
    const mdl = r.model ? ` [${short(r.model)}]` : r.kind === 'subagent' ? ' [model?]' : '';
    console.log(`  ● ${r.kind.padEnd(8)} ${(r.agentType || '').padEnd(11)}${mdl}  ${mmss(r.elapsedSec)}${bud}  ${r.description}`);
    if (r.target.length) console.log(`      ↳ ${r.target.join('  ')}`);
  }
  console.log(`\nSPEND (live, by source):`);
  for (const [src, v] of Object.entries(f.spend))
    console.log(`  ${src.padEnd(10)} ${k(v.tokens).padStart(8)} tok   $${v.cost.toFixed(4)}`);
  console.log(`\nCALIBRATION (est vs actual):`);
  for (const c of f.calibration)
    console.log(`  ${c.type.padEnd(11)} n=${String(c.n).padStart(2)}  avg ${mmss(c.avgSec)} / est ${mmss(c.estSec)}  ${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}%`);
  console.log(`\nCOMPLETED (${f.completed.length}):`);
  for (const c of f.completed) {
    const over = c.durationSec > c.estSec ? '!' : ' ';
    const tot = c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheCreation;
    console.log(`  ✓ ${(c.agentType || '').padEnd(11)} [${short(c.model)}] ${mmss(c.durationSec)}/${mmss(c.estSec)}${over} ${String(c.turns).padStart(3)}t ${k(tot).padStart(8)}tok`);
    if (c.result) console.log(`      ↳ ${c.result}`);
  }
}
