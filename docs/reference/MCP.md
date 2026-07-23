<!-- REFERENCE · public documentation of the MCP server (tools/mcp/) -->
# MCP server

The repository ships a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI agent can drive the plate solver directly: run a solve, read the receipt, and query past results — the same pipeline, the same receipts, the same honesty rules as the desktop app. It runs locally over stdio; nothing is hosted.

**Forensic Question:** *"What can an agent ask the instrument, and does every answer carry its evidence?"*

## What it is

`tools/mcp/server.mjs` is a stdio MCP server: an MCP client launches it as a child process and speaks JSON-RPC over stdin/stdout. It is a thin projection over the [headless API](API.md) — it adds no engine code of its own, which is the point: an agent-driven solve is the same solve, producing the same bit-identical receipt.

Three properties hold for every tool:

- **Local only.** No network service, no auth, no cloud. The server reads your local star data and writes only under `test_results/`.
- **Fresh, never cached.** Every solve is a real solve; there is no cache that could serve a stale receipt as a fresh result.
- **Honest or absent.** Missing data comes back as an explicit sentinel or an honest "not measured" — never a fabricated value.

## Setup

Point your MCP client at the server script. For Claude Desktop (`claude_desktop_config.json`) or Claude Code (`.mcp.json`, or `claude mcp add`):

```json
{
  "mcpServers": {
    "skycruncher": {
      "command": "node",
      "args": ["/absolute/path/to/your/checkout/tools/mcp/server.mjs"]
    }
  }
}
```

Use the absolute path of `server.mjs` in your checkout (on Windows, forward slashes work in JSON). The server needs the same local assets as the headless API: installed dependencies, the built WebAssembly modules, and the fetched star data — see "Getting started" in the top-level [README](../../README.md).

Long-running tools report progress: a client that supplies a progress token gets a heartbeat notification every 10 seconds during a solve.

## Tools

The four tools below are the documented surface. Per tool: what it takes, what it returns, and an honest maturity label.

| Tool | Arguments | Returns | Maturity |
|---|---|---|---|
| `solve_fits` | `path` — a `.fit` / `.fits` / `.fts` file | A compact summary of a fresh real solve: `solved`, `ra_hours`, `dec_degrees`, `pixel_scale_arcsec_per_px`, `stars_matched`, `confidence`, the verification and distortion summaries, and `receipt_path` — where the full receipt landed. A failed solve returns `solved: false` with the reason. | **Stable.** FITS input only — anything else is rejected with a reason, not half-read. Expect real wall time (the server's own progress notes put a narrow-field solve at roughly 30–120 s). |
| `inspect_receipt` | `receipt_path`, optional `selector` (comma-separated dot-paths, e.g. `solution.ra_hours,confirm_status.status`) | The selected values from a saved receipt, without re-solving. An absent path returns the `MISSING` sentinel. With no selector, the receipt's top-level keys. | **Stable.** A pure read. |
| `query_results` | Exactly one of `canned` (`frames-summary`, `verdicts-by-frame`, `gap-classes`, `odds-separation`, `tables`) or `sql` (a read-only SELECT); optional `limit` (row cap, default 1000) | Query rows over locally banked result exports (Parquet, queried through DuckDB): per-frame solve outcomes, per-star records, failure classifications. Absent tables report an honest not-measured. | **Test/dev.** The result schema is not locked and may change without notice — treat output as exploratory, not citable. Rails are enforced: SELECT-only (any write or DDL statement is rejected before execution), row cap, query timeout. |
| `rig_profiles` | none | Pooled per-rig optical profiles (built up from your own solves) plus deposit counts, using the engine's own pooling code. | **Stable, data-dependent.** Returns an honest "empty" until solves have deposited profiles on your machine. |

The server exposes further tools — widget rendering, documentation retrieval, research bookkeeping — that are internal for now. The documented surface will grow as those stabilize.

Saved receipts are also exposed as MCP resources (`receipt://` URIs), path-guarded to `test_results/`.

## An agent workflow

The intended loop is solve, then interrogate — the agent never has to hold a full receipt in context to reason about a run.

1. **Solve.** `solve_fits { path: "frames/m66_stack.fits" }` → `solved: true`, summary numbers, and a `receipt_path`.
2. **Interrogate the evidence.** `inspect_receipt { receipt_path, selector: "confirm_status.status,confirm_status.n_confirmed_fdr,solution.astrometry.rms_arcsec" }` → was the solve *confirmed* by forced photometry, by how many stars, and how tight is the fit? Only those three values enter the agent's context.
3. **Compare against history.** `query_results { canned: "frames-summary" }` → how this run sits against previously banked solves (test/dev tier — trends, not citations).

A no-solve is a first-class outcome in this loop: the agent gets `solved: false` plus a receipt whose diagnostics say why, and can decide what to do next based on evidence rather than a silent failure.

## Where this is going

Planned, not built — listed so the direction is visible:

- **A growing tool surface** — the internal tools graduate here as their contracts stabilize.
- **ASCOM Alpaca integration** — device and observatory control over the Alpaca HTTP standard, bringing capture into the same agent loop.
- **Community measurement contribution** — an opt-in channel for contributing receipts to a community database (in development).
- **Data plane** — streamed star data and result distribution; design in [`docs/02-specs/DATA_DISTRIBUTION_PLAN.md`](../02-specs/DATA_DISTRIBUTION_PLAN.md).
