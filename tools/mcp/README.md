<!-- REFERENCE · tools/mcp — stdio MCP server over the headless solve + widget API -->
# SkyCruncher MCP server (`tools/mcp/`)

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
the **real** calibrated FITS plate-solve pipeline (`runWizardPipeline`) and the widget
render layer to any MCP client (Claude Desktop, Claude Code). It is a thin `tools/`-lane
projection over the proven headless mechanism — it adds **zero** new engine code and
touches **no** `src/`.

- **FITS lane only.** `.fit/.fits/.fts`. CR2/RAW headless is out of scope (per
  `tools/api/headless_driver.ts`), so those tools reject non-FITS input honestly.
- **Local-only.** Reads the local atlas/wasm/Sample Files; writes only under
  `test_results/`. No network, no cloud, no auth. See *Non-goals* below.
- **Evidence-only.** Every `solve_fits` / `render_widget` is a **fresh real solve** —
  there is no caching that could serve a stale receipt as a fresh solve (`cached:false`
  is always stamped). Absent measurements render/return their honest `NOT MEASURED`
  state, never a fabricated number.

## Why hand-rolled JSON-RPC, not `@modelcontextprotocol/sdk`

The server implements the MCP stdio wire format **directly** (see the header of
`server.mjs`) rather than depending on the official SDK. Reasoning:

1. **Shared node_modules.** In the worktree-isolated dev setup, `node_modules` is a
   *junction* onto the owner's main store. `npm install @modelcontextprotocol/sdk` would
   both need network **and** pollute the owner's main `node_modules` — a side effect
   outside a scoped tools change.
2. **Small surface.** MCP stdio = newline-delimited JSON-RPC 2.0, one message per line.
   The methods we need — `initialize`, `notifications/initialized`, `tools/list`,
   `tools/call`, `resources/list`, `resources/read`, `ping` — are a few dozen lines to
   frame by hand.
3. **Zero dependency churn**, offline-safe, no `package.json` edit.

If a future maintainer prefers the SDK, swapping the framing layer is mechanical; the
tool handlers are already pure functions.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `solve_fits` | `{ path }` | Compact solve summary from a fresh real solve: `solved`, `ra_hours`, `dec_degrees`, `pixel_scale_arcsec_per_px`, `stars_matched`, `confidence`, `receipt_schema_version`, `deep_confirmed`, `bc_rematch`, SIP/TPS presence + RMS, `receipt_path`. NO_SOLVE returns `{solved:false, reason}`. |
| `inspect_receipt` | `{ receipt_path, selector? }` | `--select` dot-path projection over a saved receipt (no re-solve). Absent paths → `MISSING` sentinel. Omit `selector` → top-level keys. |
| `rig_profiles` | `{}` | Per-rig pooled Optical Workbench profiles + deposit counts from `test_results/workbench/`. Honest-absent when empty. Pooling reuses the engine `recomputeRigProfile`. |
| `instrument_status` | `{}` | Canonical gate numbers from `docs/GATES.md` (tsc, vitest, sacred e2e, api smoke) + the most recent solve found under `test_results/`. Cheap read. |
| `list_widgets` | `{}` | Registry inventory: `id`, `title`, `intent`, `weightTier`, **LIVE-vs-SCAFFOLD** status, plus a REAL/ABSENT data probe against the bundled M66 receipt. |
| `render_widget` | `{ widget_id, fits_path \| receipt_path, width?, return_image? }` | Renders a registry widget with REAL data to a PNG. Exactly one of `fits_path` (runs a fresh solve first) or `receipt_path` (skips it). A null-selector widget renders its NOT-MEASURED state as the PNG — that IS the correct output, never an error. |
| `librarian_query` | `{ query, k?, threshold? }` | Card-catalog doc retrieval (`tools/librarian`): POINTERS (path + heading + lines + authority class + last_commit), never content-as-answer. Below the calibrated threshold it REFUSES honestly. Spawned child process (native LanceDB isolated from the server). <1 s. |

### Resources

Saved receipts under `test_results/` are exposed as `receipt://<relpath>` resources
(`resources/list` + `resources/read`), path-guarded to stay inside `test_results/`.

### Progress

Long-running tools (`solve_fits`, `render_widget`) emit `notifications/progress` when
the caller supplies a `_meta.progressToken`, with an indeterminate heartbeat every 10 s.
Wall-time expectation: a narrow FITS solve is ~30–120 s.

## Token-light usage (`render_widget.return_image`)

`render_widget` is designed for two audiences via the `return_image` flag:

- **Owner-direct (default, `return_image:true`)** — the PNG is returned **inline** as MCP
  image content and rendered in the chat. Use when you (the human) are calling the tool
  from your own Claude session and want to *see* the widget.
  > Example: *"here's a FITS file `<path>` — render its per-channel color histogram"* →
  > the model calls `solve_fits` then `render_widget(widget_id:"color_color_planckian")`
  > and the image appears inline.
- **Orchestrator / agent (`return_image:false`)** — the PNG is written to
  `test_results/mcp_renders/<id>.png` and the tool returns **only the path + a one-line
  stats summary**. The image bytes never enter an LLM context. Downstream, hand the path
  to the user via a file link / path-passing (e.g. `SendUserFile`) rather than inlining
  base64. Use this in automated multi-step flows so a batch of renders costs ~nothing in
  tokens.

## Register in Claude Desktop / Claude Code

Add to your MCP client config (Claude Desktop: `claude_desktop_config.json`; Claude Code:
`.mcp.json` or `claude mcp add`). Point `args` at `server.mjs` — shown here relative to
the repo root; use the **absolute** path of `server.mjs` in your own checkout:

```json
{
  "mcpServers": {
    "skycruncher-solve": {
      "command": "node",
      "args": ["tools/mcp/server.mjs"]
    }
  }
}
```

(On Windows, forward slashes work in JSON; if you use backslashes, escape them `\\`.)

### Local assets the server needs

Same local-only assets the headless driver needs, relative to the repo root:
`node_modules/`, `src/engine/wasm_compute/pkg/`, `public/atlas/sectors/`, `public/demo/`,
`Sample Files/`. `render_widget` additionally needs a browser for the screenshot — it
launches the system-Chrome channel first (the proven `capture_cascade.mjs` pattern) and
falls back to the bundled chromium. If neither is present it returns an honest error
naming the fix (`npx playwright install chromium`), **never a blank image**.

## Smoke test (exit evidence)

```
node tools/mcp/smoke.mjs
```

Spawns the server, drives `initialize → tools/list → solve_fits(bundled M66)` and asserts
the sacred numbers come back **through the protocol** (`RA=11.341253475172621`,
`matched=272`), then `render_widget(color_color_planckian)` and asserts a `>10 KB` PNG
round-trips as MCP image content. Exit 0 = PASS.

## Non-goals (v1)

- **No hosted / HTTP transport.** stdio only. A hosted HTTP MCP endpoint (with auth and a
  shared archive DB of receipts) is a deliberate *future* — it requires the
  authentication + privacy-tiering + provenance design that the Optical Workbench schema
  and the sextant privacy notes call out before any receipt/profile leaves the local box.
- **No CR2/RAW.** FITS lane only.
- **No solverkit / raw internals.** The server exposes the *calibrated session path*
  (the same receipts the browser download produces), never lower-level solver knobs.
