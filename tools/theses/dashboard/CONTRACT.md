# CSL Thesis Dashboard — Data Contract (PINNED)

Status: **LEDGER/REFERENCE** · Producer: `tools/theses/dashboard/snapshot.mjs` · Consumer: `tools/theses/dashboard/ui/` (design lane).
Pinned fields below are **never renamed**. Additive fields are legal but must be documented in §Additive. Rules: absent data = `null` (UI renders **NOT RECORDED** — LAW 3, never invent); **AI-RESEARCHER and HUMAN buckets are NEVER pooled** in any aggregate; every number traces to a registry record (or to the frozen, hash-verified thesis file the registry anchors).

## Pinned shape — `/data/thesis_dashboard_data.json`

```json
{
  "generated_at": "ISO8601",
  "schema_version": "from THESIS_SCHEMA_VERSION",
  "chain": { "verified": true, "records": 0, "head_hash": "…", "break_at": null },
  "theses": [{
    "id": "THESIS-…", "title": "…",
    "submitter_class": "AI-RESEARCHER|HUMAN",
    "status": "REGISTERED|RUNNING|PASS|FAIL|FAIL-KILL|PARKED",
    "registered_at": "…", "stamped_at": "… or null",
    "time_budget": { "est_wall_minutes": 0, "lane": "inline|overnight" },
    "actual_wall_minutes": null,
    "criteria": [{ "id": "P1", "summary": "…", "verdict": "PASS|FAIL|NOT-MEASURED|null" }],
    "kill_clause_fired": false,
    "deviations": ["…"],
    "verdict_summary": "one-line honest outcome",
    "artifacts": ["repo-relative paths"],
    "registry_hash": "…"
  }],
  "drafts": [{ "id": "…", "title": "…", "status": "DRAFT|PARKED", "lane": "…", "est_wall_minutes": null }],
  "stats": { "by_bucket": { "AI-RESEARCHER": { "lifecycles": 0, "pass": 0, "fail": 0 }, "HUMAN": {} } }
}
```

## Field provenance

Sources: `test_results/theses/registry.jsonl` (CANONICAL hash-chained log; record kinds `register`/`stamp`/`annotate` — reader: `tools/theses/registry.mjs`, LAW-4-reused), the frozen thesis JSON `test_results/theses/<id>.json` (hash-anchored by the chain), and `test_results/theses/drafts/*.json`.

| Field | Maps from |
|---|---|
| `generated_at` | snapshot wall clock |
| `schema_version` | `THESIS_SCHEMA_VERSION` regex-extracted at runtime from `tools/theses/thesis_schema.ts` (single source; never hand-copied) |
| `chain.*` | independent recomputation over raw `registry.jsonl` lines (§Chain) |
| `theses[].id`, `title` | `register.id` / `register.title` (title falls back to the frozen file) |
| `theses[].submitter_class` | frozen file `submitter_class` (0.2.0), else `annotate{provenance}.fields.submitter_class` (authorized retro-stamp); both-present disagreement → annotation wins + a `notes` entry; neither → `null` |
| `theses[].status` | latest-stamp fold from `registry.mjs` `list()`, mapped: `PRE-REGISTERED→REGISTERED`, `FAIL→FAIL-KILL` iff kill detection (§Derivations) is explicitly true. `PARTIAL` (registry-legal, outside this enum) passes through VERBATIM + `notes` entry. `PARKED` never occurs for registered theses (drafts-only status) |
| `theses[].registered_at` / `stamped_at` | `register.ts` / latest `stamp.ts` (`null` if unstamped) |
| `theses[].time_budget` | frozen file `time_budget{est_wall_minutes, lane}`; absent (0.1.0) → `null` |
| `theses[].actual_wall_minutes` | terminal-stamp `ts` − first-`RUNNING`-stamp `ts`, minutes, 1 decimal. **LEDGER stamp times, not measured run wall time** — batch-appended lifecycles legitimately read ~0.0; the registry records no measured wall time. Either stamp absent → `null` |
| `theses[].criteria[].id`, `summary` | frozen file `pass_criteria[].id` / `.description` |
| `theses[].criteria[].verdict` | TEXT-DERIVED from the terminal stamp's `evidence_pointer` by the strict extractor (§Derivations); not confidently extractable → `null` |
| `theses[].kill_clause_fired` | TEXT-DERIVED from terminal-stamp evidence (§Derivations); `true`/`false` only on explicit wording, else `null` (= NOT RECORDED, distinct from `false`) |
| `theses[].deviations` | concat of every `annotate{deviations}.fields.deviations[]`; `[]` = zero deviation records appended (a fact, not missing data) |
| `theses[].verdict_summary` | MECHANICAL excerpt of terminal-stamp evidence (§Derivations); no terminal stamp → `null` |
| `theses[].artifacts` | regex-extracted repo-relative path tokens from all stamps' `evidence_pointer` + the frozen thesis file path; deduped, first-seen order |
| `theses[].registry_hash` | `register.sha256` (the frozen-content hash the whole chain anchors to) |
| `drafts[]` | every `drafts/*.json` whose `id` is **not** registered (registered ⇒ it lives in `theses[]`). `status=PARKED` iff the draft file carries a machine-readable `_disposition`, else `DRAFT`; `lane`/`est_wall_minutes` from the draft's `time_budget` (`null` if absent) |
| `stats.by_bucket` | per-bucket rollup of `theses[]`: `lifecycles` = terminal stamp reached (PASS/FAIL/FAIL-KILL/PARTIAL); `pass` = PASS; `fail` = FAIL + FAIL-KILL. Buckets `AI-RESEARCHER` and `HUMAN` always present; a `null`-class thesis lands in an additive `UNCLASSIFIED` bucket — never silently assigned, never pooled |

## Chain (`chain.*`) — recomputed every snapshot, never assumed

The registry chain is **registration-hash-anchored**: each `stamp`/`annotate` carries `registration_sha256` + a thesis re-hash at stamp time + `integrity_ok`, and the frozen thesis file is re-hashable on disk. Per-record checks (first failure = `break_at`, 1-based line number; reason in additive `break_reason`):

1. line parses as JSON with a known `kind`
2. `register`: id not previously registered; on-disk `test_results/theses/<file>` exists and `sha256(bytes) === record.sha256` (live frozen-content check)
3. `stamp`/`annotate`: a prior `register` exists; `registration_sha256 === register.sha256`; `integrity_ok === (sha256 === registration_sha256)`
4. `stamp.status ∈ {RUNNING, PASS, FAIL, PARTIAL}`

`head_hash` = rolling fold over the raw stored lines: `h_1 = sha256(line_1)`, `h_i = sha256(hex(h_{i-1}) + "\n" + line_i)` — recomputable by anyone from `registry.jsonl` alone. `verified` = zero check failures and ≥1 record.

## Derivations (text-derived fields — exact rules)

**Criteria verdicts** (from terminal-stamp `evidence_pointer`; case-sensitive tokens; first rule that matches wins; else `null`):
1. *Adjacency*: `<ID>` (optionally `(i)`-suffixed) immediately followed by `PASS`/`literal-PASS`/`FAIL`/`NOT MEASURED` → that verdict (`literal-PASS`→`PASS`, `NOT MEASURED`→`NOT-MEASURED`).
2. *Slash groups*: `<ID>` inside a `P5/P8/L2 NOT MEASURED`-style group → `NOT-MEASURED`.
3. *Spans*: `<ID>` inside the span from `PASSES:` / `NON-KILL PASSES recorded:` to the next `FAIL` token → `PASS`; inside the span from `FAIL ground(s)…:` / `FAIL/KILL ground:` to the first `. ` → `FAIL`.

**Kill detection**: `VERDICT=FAIL (NOT kill` → `false`; `VERDICT=FAIL (KILL` / `FAIL ground(s) (kill clause)` / `kill-clause member tripped` / `independent kills` → `true`; else `null`.

**verdict_summary**: if evidence contains `VERDICT=` → that substring to the first `. `; else if a FAIL-grounds span exists → `<status> — <span>`; else `<status> — evidence: <text>`; all capped at 300 chars + `…`.

## Additive fields (documented; UI may ignore)

Top-level: `chain.break_reason` (string|null) · `source{registry, drafts_dir, schema}` · `notes[]` (honesty flags emitted during the build — chain breaks, PARTIAL passthrough, unrecorded kill status, submitter-class disagreements).
Per thesis: `schema_version` · `integrity_ok` (live frozen-file re-hash verdict) · `history[]` (`{kind: register|stamp|annotate, label, at, by}` chronological — the "history" view's spine).
Per draft: `disposition` (verbatim `_disposition`, `null` if none) · `schema_version` · `submitter_class`.
Stats buckets additionally carry `fail_kill`, `registered`, `running`; an `UNCLASSIFIED` bucket appears only if needed.

## Honesty caveats (known source limits — surfaced, not coerced)

- Per-criterion verdicts and kill firing are **not structured registry fields**; the text extractor above is conservative — expect `null` (NOT RECORDED) where the stamp prose is not explicit (e.g. THESIS-2026-07-10-001's stamp cites an .md by pointer only → all its criteria verdicts are `null`).
- `drafts/INDEX.md` disposition rows (HOLD/KILL/SUPERSEDED queueing) are **doc-level, not machine-readable**; only an in-file `_disposition` flips a draft to `PARKED`. As of 2026-07-11 only `DRAFT-horizon-envelope-audit` carries one.
- `actual_wall_minutes` reflects ledger stamp times (see provenance row) — several lifecycles were stamped in one append burst and honestly read ≈0.

## Serving — `tools/theses/dashboard/serve.mjs` (READ-ONLY, GET/HEAD only)

```
node tools/theses/dashboard/serve.mjs                      # http://localhost:4321/
node tools/theses/dashboard/serve.mjs --port 4321 --host 0.0.0.0   # LAN mode — reachable at http://<LAN-IP>:4321/
```

| Endpoint | Behavior |
|---|---|
| `/data/thesis_dashboard_data.json` | **REGENERATES** from the registry on every request (via `snapshot.mjs`; also refreshes the on-disk file) |
| `/data/token_tracker_data.json` | **REGENERATES via adapter** if `tools/theses/dashboard/telemetry_adapter.mjs` exists (its exported `snapshot()`; telemetry lane owns that file); any adapter failure → static file passthrough; absent too → 404 honest missing-state. The adapter can never crash the server |
| `/data/owner_responses.json` | **PARSED** view of the append-only `owner_responses.jsonl` (each non-empty line → one array element; corrupt/tampered lines skipped, never fabricated); absent file → `[]` (honest "no responses yet"). GET only |
| `/data/response_acks.json` | **PARSED** view of the append-only `response_acks.jsonl` — the orchestrator's ingestion-ack ledger (each line `{response_ts, decision_id, acked_at, by}`; corrupt lines skipped); absent file → `[]` (graceful-empty 200, never 404). **No write endpoint** — the orchestrator appends to the file directly. The UI overlays an `INGESTED ✓` / `NOT YET INGESTED` chip on each owner-response chip by matching `decision_id`+`response_ts`. GET only |
| `/data/<any>.json` | read-only **passthrough** of `test_results/theses/dashboard/<any>.json` (e.g. `owner_decisions.json` — decisions lane; flow-stub data); missing → 404 |
| `POST /api/respond` | the **one write endpoint** — token-gated, append-only owner response (see §Owner responses below). Every other non-GET/HEAD request → 405; any other POST path → 404 |
| `/` and static paths | `tools/theses/dashboard/ui/` (design lane); extension-less routes fall back to `index.html` (tab routing); `ui/` absent → 503 with the data plane still live |

Everything GET is served `Cache-Control: no-store`. The DATA and UI planes remain read-only; the single append-only exception is `POST /api/respond`.

## Owner responses — the interactive write plane (`POST /api/respond`)

The Owner Decisions tab is interactive: the owner approves / answers / overturns / parks each decision **from any machine on the LAN**, and every action becomes one line in an **append-only** ledger the orchestrator ingests. There is **no update or delete endpoint of any kind** — a changed mind is a new appended line; the latest line for a `decision_id` is the current ruling, and the full history stays on disk.

**Ledger file** — `test_results/theses/dashboard/owner_responses.jsonl` (gitignored). One JSON object per line:

```json
{"decision_id":"D-…","action":"approve|overturn|answer|park","note":"","ts":"ISO8601","via":"dashboard"}
```

**Request** — `POST /api/respond`, `Content-Type: application/json`, header `X-Dashboard-Token: <token>`, body `{ decision_id, action, note? }`. The server stamps `ts` (server clock) and `via:"dashboard"`; client-supplied `ts`/`via` are ignored. Validation (all → `400`): `decision_id` non-empty string (≤256); `action` ∈ {approve, overturn, answer, park}; `note` string (≤8000); **`answer` and `overturn` require a non-empty note**; body must be a JSON object; oversized body (>64 KB) rejected. Success → `200 {ok:true, appended:{…}}`.

**Token gate** — on first start, if `test_results/theses/dashboard/.dashboard_token` is absent the server generates a random token there (`crypto.randomBytes(24)` hex, mode 0600, gitignored) and **prints it to the server console** (and reprints it, labelled `loaded`, on subsequent starts for LAN convenience). `POST /api/respond` requires `X-Dashboard-Token` to match; missing/mismatch → `401` (checked **before** the body, so a tokenless request is 401 regardless of payload). The UI stores the token in `localStorage` (a small "WRITE TOKEN" box on the Decisions tab). This is a **home-LAN convenience gate, not security-grade auth** — stated verbatim in the UI.

**UI overlay** — the UI GETs `/data/owner_responses.json`, folds it to the latest response per `decision_id`, and overlays a response chip + note + timestamp onto each card. The **original decision text always stays visible** (the ask is never hidden). Approve is disabled (with tooltip) when `recommendation` is `null`. The 15s poll never clobbers an open editor or the token box.

## Orchestrator pickup

The orchestrator **ingests `owner_responses.jsonl` at each relay / session open**. Dashboard rulings are **real owner rulings** and are actioned as such — with one carve-out: **calibrated numeric sign-offs** (SOLVER_* constants, GATES.md numbers, sigma gates — anything under the owner-guards-calibrated-gates discipline) additionally require **in-session echo-confirmation** before adoption. For those, the appended line is the owner's intent-of-record, but the orchestrator echoes the exact number back for a live confirm before changing any constant; the ledger line alone never flips a calibrated gate. Fold by `decision_id`, latest line wins, and treat the ledger as append-only truth (never rewrite it).

Snapshot standalone: `node tools/theses/dashboard/snapshot.mjs` → writes `test_results/theses/dashboard/thesis_dashboard_data.json`, prints chain/count summary, exit 1 on chain-verification failure.
Future domain hosting: `tools/theses/dashboard/publish_r2.mjs` — STUB, zero remote writes, `--dry-run` enumerates would-be uploads (bucket `theses-dashboard`, keys `csl/ui/*` + `csl/data/*`); real uploads blocked pending owner Cloudflare auth.
