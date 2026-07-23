# Desktop → API Remap (REFERENCE, design closed 2026-07-09)

*Closes task #9: desktop wiring audit + remap design. Audit + ecosystem research 2026-07-09 (evidence-cited); build = Toolchest Wave 2. North star (owner): desktop solver, overnight rig, and browser all consume ONE maintained core — minimal maintenance.*

## Audit verdict (2026-07-09, evidence-cited)
- **Drift = days, not weeks** (src-tauri last meaningfully touched 7ef9edd 2026-07-07). Tauri **v2.10.3**; bundles `frontendDist: ../dist`, devUrl = localhost:3005 (still the configured value in `tauri.conf.json:8`; the "owner's protected manual port" framing is dated — the 3005 owner-manual vite + its prewarm-hook leg were RETIRED @d0d76d4, 2026-07-10 EOD. The config value itself is unchanged and accurate; do not change unilaterally).
- **RESOLVED 2026-07-10 (was CONFIRMED-ROT: vanguard.bin)** — the owner decision below was ruled in the RETIRE direction: the legacy `init_catalog`/`query_catalog`/vanguard.bin native reader was removed from `lib.rs`'s invoke_handler (`src-tauri/src/lib.rs:140-144`) and replaced by the starplates native path (`STARPLATES_SPEC.md §5`). *Historical rot, retained for context:* the 84MB mmap Gaia catalog loaded via a bare relative path (star_catalog_adapter.ts:243) and `bundle.resources: []` shipped it nowhere → every shipped build threw in `init_catalog` and SILENTLY fell back to the JSON atlas (:255-266). ~~OWNER DECISION: bundle (+84MB installer) vs formally retire the native catalog path~~ — ruled RETIRE; JSON/starplates is now the single de-silenced path.
- **HEALTHY: export sinks** — AnalysisPanel uses plugin-dialog save() + plugin-fs writeFile + the shared TS serializers (ASDF, and FITS as of 8d9fe75) — already the thin-sink pattern. Dead Rust asdf_writer cleanly removed.
- **Orphan inventory**: zero JS→Rust orphans (all 7 invoke() callsites map to registered commands). Reverse: `run_terrain_oracle`/`run_distortion_oracle` registered, feature-gated OFF, no JS callers — dead-but-inert ONNX Rust surviving the 2026-07-06 TS ONNX deletion (cleanup fodder). `register_buffer`/`buffer_diagnostics` caller-light (only demosaic_native live via demosaic_pipeline.ts:95).
- UNKNOWN (no build run): whether bundled dist/ actually contains atlas sectors + the libraw worker under the production asset protocol.

## The remap gap, precisely
The webview calls `orchestrator_session` IN-PROCESS — no API boundary today. `tools/api/headless_driver.ts runWizardPipeline` (the receipt-bit-identical Node lane) has exactly **three Node-isms**: node:fs atlas reads (:64), `fs.readFileSync(WASM_BG_PATH)` init (:47), `import.meta.url` REPO_ROOT resolution (:37). No worker_threads. Browser equivalents already exist in the wizard paths (fetch + initSync).

## Ecosystem facts (researched, cited in session ledger)
- Tauri v2 CSP already grants `wasm-unsafe-eval` + `worker-src blob:` → **no blocker for running the core in-webview**.
- Sidecar route (if ever needed): Tauri docs use @yao-pkg/pkg; **Bun `--compile` has the best WASM+worker single-binary story**; stdio = one-shot only, persistent service → localhost-HTTP + auth token. Tauri+Node sidecar is early/unproven at scale vs Electron's utility-process norm.

## The design: library seam, not a server
**`runWizardPipeline(input, opts) → receipt` becomes the single surface, over HOST ADAPTERS for the three Node-isms** (atlas loader · wasm init · root/asset resolution):
- Node adapter = what the driver does today (fs/readFileSync) — overnight rig unchanged.
- Browser adapter = fetch/initSync — the wizard's existing paths, factored behind the same interface.
- **STALE (superseded by the 2026-07-21 cutover):** this plan targeted the legacy TS/WASM `runWizardPipeline` core. The shipping engine is now the greenfield Rust solver core, which is **native-first** (service + CLI; browser/WASM support is explicitly "later" — `docs/local/GREENFIELD_SOLVER_CORE_BRIEF_2026-07-20.md` §1) and reaches desktop through its own Tauri seam (`solve_greenfield`, double-gated flag, DEFAULT-OFF — `test_results/greenfield_solver/NIGHT_LEDGER_2026-07-21.md` item A). Desktop no longer needs a BROWSER adapter to reach the new core.
- **Legacy/cold-path plan (retained, never deleted) — desktop consumes the BROWSER adapter in-webview** — zero new runtime, no sidecar packaging risk, one maintained surface. The API smoke gate (IEEE bit-exact) becomes the shared contract all three hosts inherit. This remains accurate for the frozen legacy `runWizardPipeline` engine only.
This IS Toolchest Wave 2 (`packages/toolchest`): ImageDataLike widening + stage exports + the adapter seam.

## Phasing
1. **Hygiene (cheap, anytime):** vanguard.bin — RETIRED 2026-07-10 (owner ruled retire; native reader removed from `lib.rs`, starplates is the native path) + make the JSON fallback LOUD (status honesty) + delete/quarantine the dead ONNX oracle Rust.
2. **The remap (Wave 2):** host-adapter seam + packages/toolchest; desktop UI calls runWizardPipeline through the browser adapter. Per-host thin smoke tests; the bit-exact receipt contract verified once, inherited thrice.
3. **Optional later — Bun sidecar** for off-webview compute / CR2-headless parity: deferred behind the libraw-headless problem (same blocker as worktree CR2 e2e — solving it pays twice).

Sequencing: after the current build queue clears; the FITS writer's one-serializer-three-sinks build (8d9fe75) was the dress rehearsal for exactly this architecture. Multi-window drag-out (WORKSPACE_DASHBOARD_DESIGN v3) lands on the desktop remap as its killer feature.

## Related
- [STARPLATES_SPEC](../STARPLATES_SPEC.md) — §5 covers the native catalog path that replaced vanguard.bin, cited in the audit verdict
- [WORKSPACE_DASHBOARD_DESIGN](../WORKSPACE_DASHBOARD_DESIGN.md) — multi-window drag-out that lands on this remap as its killer feature
- [SURFACE_CONVERGENCE](../SURFACE_CONVERGENCE.md) — the rig/browser/desktop convergence-onto-one-core goal this remap builds toward
- [SkyCruncher_Architecture](../01-canonical/SkyCruncher_Architecture.md) — the wizard pipeline (`runWizardPipeline`) this remap turns into a shared host-adapter surface

---
## Sidecar program (APPENDED 2026-07-21; REVISED same day per owner flow-definition — Siril first)

**The owner-defined flow (verbatim-adjacent, 2026-07-21):** open Siril → a SkyCruncher panel →
upload your photo INTO SkyCruncher → it does ALL the solving, mathematical fixes and calculations →
uploads the data to the database → any aesthetic edits you want → stamps C2PA → THEN passes the
result through to Siril for further editing. **SkyCruncher is the INTAKE STATION; Siril is the
downstream editor.** This inverts the classic sidecar direction — the science, provenance, and
database-population happen before the artistic tool ever sees the file. Strategically this is the
distributed-supernova-lab intake embedded in the community's normal workflow: every photo through
the panel populates the R2 receipt database as a side effect of ordinary use.

**Pipeline mapping (what exists vs what's new):**
| Flow stage | Status |
|---|---|
| Solve + mathematical fixes (WCS, BC/TPS, photometry, confirm) | EXISTS — `runWizardPipeline` runs the full pipeline headless; desktop runs greenfield core |
| Database upload | PARTIAL — receipts→R2 plumbing exists (telemetry_db, wrangler path); needs the in-flow upload step + CONSENT gate (community users opt in; schema stays TEST/DEV until sitting item S5 locks) |
| Aesthetic edits | PARTIAL — render-plane products exist (STF, previews); the beautification program is ruled: gated, LABELED, default-off, C2PA-marked as a display product. Science data passes through LINEAR regardless — aesthetic output is an additional artifact, never a replacement |
| C2PA stamp | EXISTS — `org.skycruncher.*` assertions |
| Pass-through to Siril | NEW — write solved FITS (WCS via `export/sip_convention.ts`, FITS-convention SIP) + command Siril to load it |

**Panel implementation shape (recommended):** do NOT rebuild our UX in Tkinter. The Siril-side
glue (single-file `sirilpy` script, GPL-compatible, one-click via Siril's Scripts repo) is a
LAUNCHER + HANDOFF RECEIVER: it summons the SkyCruncher desktop app (or a slim window of it — the
WebviewWindow plumbing from the docking program applies), holds the sirilpy bridge open, and when
the user hits "Send to Siril" it loads the emitted FITS into the live Siril session
(`cmd("load", …)` guaranteed path; `set_image_metadata_from_header_string` in-memory path =
BENCH-TEST). The full honest-or-absent SkyCruncher UI — wizard, widgets, receipts — IS the panel.

**Siril first (research 2026-07-21, cited in the research bank; version facts as of Siril 1.4.3):**
- Glue = a single-file `sirilpy` Python script (Siril 1.4's integrated Python — runs INSIDE a live
  Siril session, ordinary CPython, can POST to our endpoint after `sirilpy.ensure_installed()`).
  Distribution: Siril's built-in Scripts repository = one-click install in their GUI (single-file
  .py required — which independently forces the correct process-boundary design).
- Solution return, two paths: (A) in-memory — `set_image_metadata_from_header_string()` pushes a
  whole FITS header at the open image; **BENCH-TEST REQUIRED**: whether annotations/PSF consume the
  new WCS without a reload (UNVERIFIED — the spec's one open technical question). (B) guaranteed —
  write solved FITS, `cmd("load", …)`.
- **SIP trap (load-bearing):** Siril 1.4+ consumes SIP orders 1-5 and applies whatever convention
  the header declares → the sidecar MUST emit through `export/sip_convention.ts` (FITS-convention
  negation), never the engine-internal SIP form. RA hours→degrees only at the FITS boundary
  (`tools/stack/fits_io.mjs` discipline).
- **The pitch vs Siril's own solver (measured gap):** Siril's solving is online-catalog or
  multi-GB local index installs; ours is fully offline on the g15u index, sub-second on narrows,
  deterministic, and receipted. No evidence artifact exists in Siril's path at all.
- License boundary: Siril is GPLv3; the process boundary keeps the proprietary core clean. The
  published glue script imports `sirilpy` → ship it GPL-compatible (it's a thin HTTP client we'd
  publish anyway). UNVERIFIED before publishing: sirilpy's exact license header; per-OS script dirs.
- Effort: endpoint ~1-2d · glue + bench-test ~1-2d → working demo ≈ one focused week post-merge-train.

**PixInsight second:** PJSR script → same endpoint; the deep work = writing PI's astrometric-solution
format so PI-native tooling (annotation, SPCC, mosaic) consumes it. ~2-4d after the endpoint.
**Lightroom third (owner amendment 2026-07-21: LR over Photoshop — "what photographers are actually
using"):** same intake-station flow — SkyCruncher processes/stamps, then the product lands in the
user's Lightroom catalog. Target = **Lightroom CLASSIC** (its Lua plugin SDK is the established
third-party surface: menu items, export/import hooks, external-process invocation; cloud-Lightroom
has no plugin SDK — UNVERIFIED current state, pin at its research rung). Shape: LR plugin =
launcher + auto-import receiver (our emitted TIFF/DNG + sidecar metadata into the catalog, C2PA
riding the file). Photoshop demoted to optional-later. Research rung fires before any LR build.

Implementation is NOT scheduled by this section — it launches on owner word (sitting item S12),
post-merge-train. Docs-first record only.
