<!-- REFERENCE · total widget-library inventory (dock + replay + tools drivers) · tags: UI/Dashboard · revision trigger: any change to src/engine/ui/widgets/registry.ts (add/remove a widget, mount-state or weightTier change, render-tech change) · owner: ahogan · created 2026-07-11 -->
# Widget Library — total inventory

Lookup surface for **every widget the instrument renders**: the registry widgets (dock +
replay-dashboard slots), the flowchart family (SVG original, WebGPU twin, live HUD), the 3D
cascade, and the tools-lane drivers that render the SAME registry headlessly. Code-authoritative
inventory — every row cites `file:line`; anything not read directly says **NOT VERIFIED**.

Counts below are structural facts read from the registry array (`registry.ts` `WIDGETS`), dated
**as of 2026-07-12** (consolidation delta: +4 live — `residual_quiver`, `psf_attribution`,
`planetary_manifest`, `deep_confirm`; the previously-omitted `nebulosity_layers` is also now
tabulated, so LIVE moves 17→22 / total 27→31); the header's revision trigger names when to
re-measure. Gate/solve numbers
are NOT restated here — see `docs/GATES.md` and CLAUDE.md pinned solves (citation rule, policy §5).

## 1. How the library is wired (one widget world)

There is exactly **one** widget registry — `src/engine/ui/widgets/registry.ts` — and every
surface reads it:
- **`WidgetDock`** (`WidgetDock.tsx:186`) renders the enabled set in a CSS grid. DEFAULT ON,
  opt-out via `skycruncher.widgets.dock` (`registry.ts:192`).
- **`ReplayDashboard`** (`replay/ReplayDashboard.tsx`) hosts the same manifests in swappable
  panes via **`WidgetSlot`** (`replay/WidgetSlot.tsx`), fed by scrubbed replay frames instead of
  a live receipt. DEFAULT ON, opt-out via `skycruncher.replay.dashboard` (`MainApp.tsx:389`).
- **Tools lane** renders the identical registry headlessly (§5).

Each manifest (`registry.ts:81-115`) is `{ id, title, intent, kind?, dataSelector, weightTier,
render }`. Owner law baked into the header comment: **data collection is decoupled from display** —
`dataSelector` is a PURE read over the already-collected receipt/event bus, `weightTier` gates
RENDER COST ONLY, never collection (`registry.ts:6-13`).

**Two mount nuances that change what you actually SEE:**
1. **Weight knob defaults to `stats`** (`registry.ts:168`). At the default level only `stats`-tier
   widgets render; every `chart` and `heavy` widget is enabled-but-dormant until the user raises the
   knob (`+Charts` / `+Heavy`). Only the 4 `stats`-tier widgets render at the default level, so 18
   of 22 live widgets do not render on a fresh load.
2. **Landing co-mount** (`MainApp.tsx:218-223`): dock + replay dashboard both mount with a `null`
   receipt on launch, showing the honest empty-state taxonomy (PLANNED / AWAITING SOLVE / NOT
   MEASURED — `WidgetDock.tsx:44-89`), not a blank screen.

## 2. Registry widgets — LIVE (22)

Phase tag = which pipeline stage / ledger the widget visualizes. Render = current implementation
(SVG/DOM = non-GPU; WebGL2 / WebGPU as noted). All 22 mount in the dock AND are swappable into
replay slots; "default render?" = does it draw at the default `stats` weight level.

| id | title | phase (stage / ledger) | render | tier | default render? | data source (`file:line`) |
|---|---|---|---|---|---|---|
| `solve_summary` | Solve Summary | Plate solve — headline output | DOM | stats | **yes** | `receipt.solution` + `confirm_status` (`SolveSummaryWidget.tsx:30`) |
| `solve_flowchart` | Solve Flowchart | Process — end-to-end DAG | SVG | stats | **yes** | capture-record corpus + ring + live `events` (`SolveFlowchartWidget.tsx:83`) |
| `solve_flowchart_webgpu` | Solve Flowchart (WebGPU · hybrid) | Process — DAG (A/B twin) | **WebGPU** + DOM text | stats | **yes** | reuses `selectFlowchart` verbatim (`flowchart_webgpu/SolveFlowchartWebGPU.tsx:261`) |
| `starplate_library` | Star-Plate Library | Data plane — catalog sync | DOM | stats | **yes** | Tauri `invoke('starplates_status')`; selector is a no-op stub (`dashboard/StarplateLibraryCard.tsx:280-284`) |
| `distortion_curves` | Distortion & Vignette | Optics — nominal lens prior (COORD) | SVG | chart | no | `receipt.hardware` distortion_profile/vignette (`DistortionCurvesWidget.tsx:33`) |
| `forced_photometry_z` | Forced-Photometry Significance | Deep-verify — catalog-forced confirm | SVG | chart | no | `receipt.deep_confirmed` (`ForcedPhotometryZWidget.tsx:35`) |
| `culling_waterfall` | Culling Waterfall | Detection — cull funnel | SVG | chart | no | `receipt.signal` culling_tally/clean_stars (`CullingWaterfallWidget.tsx:28`) |
| `solve_timing_waterfall` | Solve Timing | Process — per-stage wall clock | SVG | chart | no | `events` stage_started/finished, `solution.solve_time_ms` fallback (`SolveTimingWaterfallWidget.tsx:29`) |
| `color_color_planckian` | Color–Color (Planckian) | Color — photometric calibration | SVG | chart | no | `solution.matched_stars` bv/measured_bv/peak_rgb (`ColorColorPlanckianWidget.tsx:30`) |
| `star_labels` | Named Stars | Astrometry — WCS overlay | SVG | chart | no | `solution.matched_stars` + bundled `NAMED_STARS` ref (`StarLabelsWidget.tsx:47`) |
| `replay_timeline` | Replay Timeline | Process — replay scrub timeline | DOM | chart | no | `useReplayFrame()` context (selector fallback only) (`ReplayTimelineWidget.tsx:119`) |
| `psf_field` | PSF Field | PSF — per-region FWHM/ellipticity (PIXEL) | DOM grid | heavy | no | `receipt.psf_field` (`PsfFieldWidget.tsx:36`) |
| `detection_density` | Detection Density | Detection — spatial density | SVG | heavy | no | `signal.clean_stars` + `matched_stars` (`DetectionDensityWidget.tsx:34`) |
| `bc_edge_recovery` | BC Edge Recovery | Optics — measured Brown-Conrady field (COORD) | SVG | heavy | no | `receipt.lens_distortion_measured` + `matched_stars` (`BcEdgeRecoveryWidget.tsx:39`) |
| `distortion_cascade_2d` | Distortion Cascade (2.5D) | Distortion cascade nominal→BC→SIP→TPS (COORD) | SVG (isometric) | heavy | no | `hardware.distortion_profile`, `lens_distortion_measured`, `solution.astrometry.sip`/`tps` (`DistortionCascade2dWidget.tsx:39`) |
| `flattening_cascade` | Flattening Cascade | Distortion flattening — 3D | **WebGL2** | heavy | no | `selectCascade` (`cascade/cascade_data.ts`, NOT VERIFIED this pass) (`cascade/CascadeExplorer.tsx:216`) |
| `lens_profile_3d` | Lens Profile 3D | PSF/optics field — 3D | **WebGL2** | heavy | no | `receipt.psf_field` + `hardware.vignette_v1` (`cascade/LensProfile3D.tsx:43`) |
| `nebulosity_layers` | Nebulosity Layers | PSF/render — multiscale starlet decomposition (PIXEL) | DOM | chart | no | `receipt.nebulosity_layer` (`NebulosityLayersWidget.tsx:188`) |
| `residual_quiver` | Residual Vector Field | Optics — residual quiver from banked vectors (COORD) | SVG | heavy | no | `receipt.solution.matched_stars` dx_px/dy_px (`ResidualQuiverWidget.tsx`) |
| `psf_attribution` | PSF Attribution | PSF — physics decomposition ledger (PIXEL) | DOM | chart | no | `receipt.psf_attribution` (`PsfAttributionWidget.tsx`) |
| `planetary_manifest` | Planetary Manifest | Astrometry — ephemeris anchors | DOM | chart | no | `receipt.planets` (`PlanetaryManifestWidget.tsx`) |
| `deep_confirm` | Forced-Photometry Confirmation | Deep-verify — forced-photometry confirmation | DOM | chart | no | `receipt.deep_confirmed` (`DeepConfirmWidget.tsx`) |

The last five rows entered the registry in the 2026-07-12 consolidation delta (`nebulosity_layers`
was live earlier but omitted from this table; the other four re-home previously step-local /
dashboard-card viewers as pure receipt reads). `distortion_curves` already covers the step-6
DistortionChart + VignetteChart — not re-registered.

**Phase totals (live 22):** Process/orchestration 4 (`solve_timing_waterfall`, `solve_flowchart`,
`solve_flowchart_webgpu`, `replay_timeline`) · Distortion/optics-coord 5 (`distortion_curves`,
`bc_edge_recovery`, `distortion_cascade_2d`, `flattening_cascade`, `residual_quiver`) · Detection 2
(`culling_waterfall`, `detection_density`) · PSF/optics-pixel 4 (`psf_field`, `lens_profile_3d`,
`psf_attribution`, `nebulosity_layers`) · Astrometry 3 (`solve_summary`, `star_labels`,
`planetary_manifest`) · Color 1 · Deep-verify 2 (`forced_photometry_z`, `deep_confirm`) ·
Data-plane 1.

**Render-tech totals (live 22):** WebGPU 1 · WebGL2 2 · SVG 11 · DOM 8.

Architecture notes (honest, from the reads):
- `starplate_library` **breaks the pure-selector contract** every other widget follows: its
  `dataSelector` is a no-op `() => ({})` and real data comes from a Tauri `invoke` inside the
  component (`StarplateLibraryCard.tsx:280-284`). Env/native-driven, not receipt-driven — flagged,
  not wrong.
- `solve_flowchart`, `solve_flowchart_webgpu`, `replay_timeline` selectors **never return null**
  (structural surfaces); honest-absence is expressed per-node inside the render, not via the
  selector's null contract.

## 3. Registry widgets — SCAFFOLDS (9, `kind:'scaffold'`)

Registered so their intent reads honestly beside a **PLANNED** state; every selector returns
`null` (no measurement path built). Source: `widgets/ScaffoldWidgets.tsx:47-66`.

| id | title | phase | tier |
|---|---|---|---|
| `extinction_airmass` | Extinction vs Airmass | Atmosphere — extinction | chart |
| `lp_gradient_map` | Light-Pollution Gradient | Atmosphere — sky background | heavy |
| `rayleigh_mie` | Rayleigh / Mie Split | Atmosphere — scattering decomposition | chart |
| `zodiacal_overlay` | Zodiacal Light | Atmosphere — zodiacal band | heavy |
| `aod_haze` | Aerosol / Haze (AOD) | Atmosphere — aerosol depth | chart |
| `per_rig_workbench_trend` | Per-Rig Trend | Optical workbench — calibration trend | chart |
| `stack_registration_residuals` | Stack Registration Residuals | Stacking — per-sub residuals | chart |
| `sextant_confidence` | Sextant Confidence | Sextant — observer-location confidence | chart |
| `bad_pixel_map` | Bad-Pixel Map | Sensor calibration — hot/cold/stuck | heavy |

`aod_haze` is the **original-sin slot** — a fake `AOD=0.10` was once displayed here; it is HELD as
a scaffold until a genuine measurement path exists (`ScaffoldWidgets.tsx` intent text). Keeping it
PLANNED is the honest state, not a debt.

## 4. Dashboard-level surfaces (not registry widgets, in scope)

| surface | render | mount | data | `file:line` |
|---|---|---|---|---|
| `LiveSolveFlowchart` | SVG (reuses `solve_flowchart` render) | floating HUD co-mounted with the wizard, default-visible | live session event bus | `dashboard/LiveSolveFlowchart.tsx:1-32` |
| `ReplayDashboard` | DOM/SVG host (hosts registry widgets in slots) | landing + post-solve, DEFAULT ON (opt-out `skycruncher.replay.dashboard`) | capture-record → `deriveReplayFrame` | `replay/ReplayDashboard.tsx:1-45` |
| `SolveQueuePane` | DOM | landing, DEFAULT ON (opt-out `skycruncher.solvequeue.pane`) | queue state | `MainApp.tsx:202`; `solve_queue/SolveQueuePane.tsx` |

Separate from the widget library (NOT inventoried here): the step-6 / inspector dashboard **cards**
— `PlanetaryManifest`, `DataFlowDiagram`, `DeepConfirmCard`, `StarIntegrityList`, `TelemetryBar`,
`ConfirmTierBadge` (`src/engine/ui/dashboard/*.tsx`). These are fixed panels, not registry widgets;
their contents are NOT VERIFIED in this pass.

## 5. Tools-lane widget drivers (headless render of the SAME registry)

| driver | what it does | `file` |
|---|---|---|
| `build_gallery.mjs` | one-shot SSR gallery of every registered widget → `test_results/widget_review/gallery.html` | `tools/widgets/build_gallery.mjs` |
| `build_gallery.galleryspec.ts` | the render spec (react-dom/server SSR) | `tools/widgets/build_gallery.galleryspec.ts` |
| `capture_cascade.mjs` | Playwright PNG capture for gallery images | `tools/widgets/capture_cascade.mjs` |
| MCP `list_widgets` / `render_widget` | exposes `WIDGETS` + `SCAFFOLD_WIDGETS` over MCP (SSR + Playwright screenshot) | `tools/mcp/server.mjs:323-429`, helper `tools/mcp/mcp_helpers.mcpspec.ts` |

The MCP server and the gallery both import the SAME `registry.ts` — there is **no second widget
set**. `tools/theses/dashboard/serve.mjs` serves the owner dashboard UI + curated docs and does NOT
render src widgets (NOT a widget driver).

## 6. Render-tech policy conformance (owner ruling `D-webgpu-default`)

Owner ruling 2026-07-11 (`owner_decisions.json` `D-webgpu-default`): **WebGPU for widgets/dashboard
going forward where it makes sense; if a call splits WebGPU vs WebGL, prefer WebGPU; a WebGL choice
ships only with a documented why.** DOM/SVG is fine for non-GPU surfaces (policy §3 rendering rule).

| render tech | widgets | policy status |
|---|---|---|
| WebGPU | `solve_flowchart_webgpu` | **Compliant** — the WebGPU-first exemplar; device from the shared `WebGPUContext` singleton (LAW 4), DOM text overlay = deliberate hybrid (`flowchart_webgpu/flowchart_gpu_renderer.ts:6-17`) |
| WebGL2 | `flattening_cascade`, `lens_profile_3d` | **Ratified-with-documentation** — documented why EXISTS: `WEBGPU_RENDER_PLAN.md` §7.5 (no-deps hand-rolled surface; a middle GLSL tier would double the shader surface beside WGSL). Shared engine `cascade/webgl_surface.ts:1-18` |
| SVG / DOM | remaining 19 live + all scaffolds | Non-GPU — policy allows; no "why" owed |

Every current WebGL entry carries its documented why. The one policy tension is forward-looking:
`distortion_cascade_2d` renders 2.5D surfaces in SVG today, and `WEBGPU_RENDER_PLAN.md` §7.1/§7.4
already names it the first `gpu_surface` (WebGPU) bring-up — see recommendations.

## 7. Recommendations (WebGPU-first, honest about substrate)

1. **[TOP] Promote `distortion_cascade_2d` to the WebGPU `gpu_surface`.** It is the only heavy
   widget the render plan explicitly earmarks for WebGPU (`WEBGPU_RENDER_PLAN.md` §7.4: "brings up
   `gpu_surface` end-to-end"), and its four 2.5D displacement surfaces are exactly what SVG can only
   render decimated (§7.5, ~37k polygons for the cascade). Substrate exists — `WebGPUContext`
   singleton is live and the twin proves the pattern. WebGPU-first, aligned with `D-webgpu-default`,
   and it is the natural second WebGPU widget after the flowchart twin.
2. **Resolve the flowchart A/B.** `solve_flowchart` (SVG) and `solve_flowchart_webgpu` (WebGPU) are
   a deliberate A/B twin sharing one selector + geometry. Once the FPS/quality comparison has run,
   pick one as canonical and archive-note the other (or keep the WebGPU twin as the reference
   surface) — carrying both indefinitely is latent duplication.
3. **Graduate `extinction_airmass` first among scaffolds.** Atmosphere increment-2 is a live NEXT
   LEVER; extinction-vs-airmass is the closest scaffold to a real measurement path. The other 8
   scaffolds stay honestly PLANNED until their stages exist — no mount or archive change owed.
4. **Discoverability of the dormant chart/heavy widgets.** At the default `stats` weight level, 18
   of 22 live widgets never render. Consider a per-phase default or an in-dock hint that raising the
   knob reveals them — today a fresh user sees 4 of 22. (Display-only; does not touch the
   collection/display decoupling.)
5. **Normalize `starplate_library` or document the deviation in the registry.** Its no-op selector
   + Tauri-invoke pattern is the sole registry widget outside the pure-selector contract; its
   manifest already notes this, but a one-line registry comment would keep the contract legible.

No registry widget is orphaned — all 31 are reachable via the dock and replay slots. The large
"craft-your-own-graph" master-graph widget is **already** a ROADMAP HORIZON item (memory:
master-graph-widget-vision; ~70% substrate) — referenced, not re-proposed here.

## Related
- [../01-canonical/DOCUMENTATION_POLICY.md](../01-canonical/DOCUMENTATION_POLICY.md) — the doc policy this inventory follows, including the §3 rendering-tech rule and the citation rules
- [../02-specs/WEBGPU_RENDER_PLAN.md](../02-specs/WEBGPU_RENDER_PLAN.md) — the render-tech plan; §7.5 documents the ratified WebGL2 cascade tier and §7.4 earmarks `distortion_cascade_2d` for WebGPU
- [../WORKSPACE_DASHBOARD_DESIGN.md](../WORKSPACE_DASHBOARD_DESIGN.md) — the replay-dashboard host these widgets slot into via `WidgetSlot`
- [CARD_ASTROMETRY_WCS.md](CARD_ASTROMETRY_WCS.md) — the distortion/SIP/TPS math the cascade + BC-edge widgets visualize
- [CARD_ATMOSPHERE_OPTICS.md](CARD_ATMOSPHERE_OPTICS.md) — the physics the atmosphere scaffolds will draw on once measurement paths exist
- [CARD_COLOR_PHOTOCAL.md](CARD_COLOR_PHOTOCAL.md) — the color/photometric calibration behind `color_color_planckian` and `forced_photometry_z`
- [CARD_STARPLATES_DATAPLANE.md](CARD_STARPLATES_DATAPLANE.md) — the catalog data plane `starplate_library` reports sync status for
- [INDEX.md](../INDEX.md) — the per-file discovery table this doc registers in
