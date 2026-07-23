# Telemetry Tab (Tab 4) — Data Contract

**Producer:** `tools/theses/dashboard/telemetry_adapter.mjs` — `export async function snapshot(opts?)`
**Persisted copy:** `test_results/theses/dashboard/token_tracker_data.json` (written on every `snapshot()` call, best-effort; the *returned object* is the primary product)
**Canonical upstream:** `tools/telemetry/summarize.mjs` (imported directly: `summarize()`, `listSessions()`) + agent-run aggregation re-derived per `tools/telemetry/fleet.mjs` semantics (fleet caps at 16 completed rows, so its function couldn't be imported wholesale — dedupe rule is identical).

## Refresh semantics

- The dashboard server dynamic-imports this module and calls `snapshot()` **per request**. No internal polling.
- `test_results/agent_runs.jsonl` (~1100 lines) is re-parsed on every call (~20 ms).
- `test_results/otel/metrics.jsonl` (~24 MB) is re-parsed **only when its mtime+size change** (module-level cache; cold parse ~300 ms, warm ~0 ms). Measured full cold `snapshot()`: **308 ms**; warm: **20 ms**.
- The JSONL files are live (hooks append mid-session); two calls seconds apart can legitimately differ by a run.

## Emitted shape

```jsonc
{
  "generated_at": "2026-07-11T04:01:00.000Z",   // ISO8601, wall clock at snapshot
  "totals": {
    "runs": 1095,                 // unique completed subagents (see dedupe rule)
    "tokens": 3982243854,         // sum over ENRICHED runs only
    "by_model": {                 // enriched runs only; key = model id verbatim
      "claude-opus-4-8": { "runs": 454, "tokens": 3300562876 }
    },
    "runs_without_token_data": 407  // EXTENSION; present only when > 0
  },
  "recent_runs": [                // last 50 by ts, NEWEST FIRST
    { "ts": "...", "agent": "measurer", "model": "claude-fable-5",
      "tokens": 8205997, "duration_s": 719, "turns": 78 }
  ],
  "skipped_lines": 0,             // EXTENSION: unparseable or non-SubagentStop lines
  "sessions": { /* see below */ }, // OPTIONAL — omitted when OTel data unavailable
  "error": "...",                 // OPTIONAL — only on agent_runs read/parse failure
  "write_error": "..."            // OPTIONAL — only if the JSON file couldn't be written
}
```

### Field provenance — `totals` / `recent_runs` (from `test_results/agent_runs.jsonl`, SubagentStop hook)

| Emitted field | JSONL source field | Notes |
|---|---|---|
| `totals.runs` | one per unique `agent_id` | Dedupe: keep LAST record per `agent_id` (matches `fleet.mjs`; 28 duplicate hook fires exist in the real file). Records without `agent_id` count individually. |
| `totals.tokens`, `by_model.*.tokens`, `recent_runs[].tokens` | `tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation` | Same convention as the telemetry dashboard's `ftok()`. Cache-read dominates the sum. |
| `by_model` key, `recent_runs[].model` | `model` | Verbatim model id (e.g. `claude-opus-4-8`). |
| `recent_runs[].ts` | `ts` | Hook append time = agent completion time. |
| `recent_runs[].agent` | `subagent_name` ?? `agent_type` ?? `"unknown"` | `subagent_name` rarely present (early records). |
| `recent_runs[].duration_s` | `duration_s` | `null` unless > 0. |
| `recent_runs[].turns` | `turns` | |
| `totals.runs_without_token_data` | absence of `tokens` | Hook enrichment (duration/tokens/turns/model derived from the agent transcript) exists only since 2026-07-08; older records are counted in `runs` but contribute **nothing** to `tokens`/`by_model`. |

**LAW 3 (honest-or-absent):** unenriched runs emit `model/tokens/duration_s/turns` as `null`, never `0`. Missing OTel data omits the `sessions` key entirely. A missing `agent_runs.jsonl` yields zeroed `totals` plus an `error` string — `snapshot()` never throws.

### `sessions` key (from `test_results/otel/metrics.jsonl` via `summarize()` / `listSessions()`)

Present only when the OTel metrics file exists and parses. All aggregation logic lives in `tools/telemetry/summarize.mjs` (DELTA counters summed).

| Emitted field | Provenance |
|---|---|
| `count` | distinct `session.id` attrs in OTel datapoints (`summarize().sessions`) |
| `cost_usd`, `cost_by_model` | `claude_code.cost.usage` counter |
| `total_tokens`, `tokens_by_type`, `tokens_by_model` | `claude_code.token.usage` counter (`type` attr: input/output/cacheRead/cacheCreation) |
| `cache_hit_rate` | `cacheRead / (input + cacheRead + cacheCreation)` |
| `otel_updated` | max `timeUnixNano` seen (ISO8601) — the collector's last export; **stale if the collector isn't running** |
| `list[]` | `listSessions()`: per-session `{id, short, start, last, tokens, cost_usd, agents, is_current}`; `agents` counted from agent_runs, `is_current` = session of the newest hook record |

Note: `totals.tokens` (per-agent, hook-derived) and `sessions.total_tokens` (OTel) are **different instruments over different windows** — do not expect them to reconcile. OTel covers whole sessions (main + subagents) but only while the collector runs; the hook covers every subagent completion since 2026-07-06 but not the orchestrator's own spend.

### Deltas from the target shape

1. `totals.tokens` / `by_model` cover enriched runs only — the balancing count is exposed as `totals.runs_without_token_data` (additive extension, present only when nonzero).
2. `skipped_lines` added at top level (crash-proofing receipt: corrupt + non-SubagentStop lines).
3. `recent_runs` may contain `null` for `model/tokens/duration_s/turns` on pre-2026-07-08 records (only relevant if the file ever shrinks below 50 recent enriched rows; currently all 50 are enriched).
4. `sessions` included (cheaply available via existing `summarize.mjs`), shape documented above.
5. `error` / `write_error` optional diagnostic strings on degraded operation.

No target field was renamed.
