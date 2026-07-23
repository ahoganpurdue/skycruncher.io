<!-- REFERENCE · webgpu render design; revise on renderlab findings / WebView2 runtime changes · owner: ahogan -->
# WebGPU Render Plan — GPU-accelerated UI rendering (design)

**Status:** design note (owner-requested 2026-07-09). Nothing here is scheduled beyond Phase 0,
which is in flight in a sibling worktree (`tools/renderlab`, LAW 4 incubator). This plan changes
**no `src/` code**; at this writing the dashboard lane owns `src/engine/ui` + `src/index.css` and
the harvest lane owns `tools/starplates/` — this document deliberately stays out of both.
Framing laws: **LAW 4** (prototype in `tools/`, zero app risk, thin drivers, port later behind
module seams), **LAW 3** (a missing GPU adapter renders an honest fallback message, never a
broken canvas), **LAW 6** (every new name below is brand-neutral: `renderlab`, `gpu_marks`,
`render seam` — no new brand literals).

The one-sentence thesis: **WebGPU is for the pixels and the point clouds, not for the charts.**
The DOM already wins everywhere the UI is actually good; the GPU wins exactly where the DOM is
already measured (or specced) to lose — full-frame science-buffer presentation and
catalog-scale mark layers.

---

## 1. Honest scope analysis — what does NOT move (most of the UI)

### 1.1 The instrument charts stay SVG. Permanently.

The Step-6 charts (`src/engine/ui/calibration/CalibrationCharts.tsx`) are the house reference
for honest data-viz (`docs/UI_STYLE_GUIDE.md` A.7) and they are a showcase of things SVG/DOM
does *better* than a GPU canvas:

- **Axes, ticks, units, corner scale notes** — text layout, `textAnchor`, baseline math for
  free (`CalibrationCharts.tsx:104-116`). In WebGPU every glyph is a project (see §3.4).
- **Hover `<title>` readouts and crosshairs** — native tooltip + pointer math per SVG node,
  including the quiver's clipped-outlier true values (`UI_STYLE_GUIDE.md` A.7).
- **Accessibility** — `role="img"`, `aria-label` per chart (`CalibrationCharts.tsx:93-94`),
  `data-testid` for the e2e harness. A GPU canvas is an a11y black hole.
- **They are not a bottleneck.** The distortion/vignette curves are **97 samples** each
  (`for (let i = 0; i <= 96; i++)`, `CalibrationCharts.tsx:154,190`) rendered as one `<path>`,
  geometry lazily `useMemo`'d at render, never in the pipeline hot path
  (`CalibrationCharts.tsx:13-14,65`). Repainting 97-point paths is not where any measured
  millisecond goes.
- **They are already perf-gated.** AUTO mode skips charts entirely; manual render is the
  escape hatch (`diag_prefs.ts`, `ForensicCalibrationStep.tsx` — `UI_STYLE_GUIDE.md` A.7,
  C.2 "good pattern to preserve").

**Rule: the A.7 chart conventions (real axes, labeled ticks, hover titles, honest-or-absent
rendering) stay SVG.** Any GPU work under a chart happens *below* the SVG chrome (§ Phase 2
hybrid contract), never instead of it.

### 1.2 Where the UI slowness actually is (measured truth, not vibes)

`docs/UI_STYLE_GUIDE.md` C.2 already characterized it — do not re-derive:

1. **Dev-mode module storm + unminified/un-split bundle** — Vite serving hundreds of unbundled
   ESM modules dominates startup; a production build is "the free ~20-40% at ship time"
   (`UI_STYLE_GUIDE.md` C.2 preamble, `docs/archive/SEESTAR_ROBUSTNESS.md`). Build-config problem.
   A GPU renderer fixes zero percent of this.
2. **Main-thread pipeline work** — the solve and its data plumbing run on the main thread;
   worker offload is the standing plan (`docs/reference/PERFORMANCE_NOTES.md` §2 D6). Also not a
   rendering problem.
3. **Main-thread preview encode** — `toDataURL('jpeg')` / `putImageData` round trips
   (`docs/reference/PERFORMANCE_NOTES.md` §1: "~100-400 ms at 8 MP [P]; catastrophic at ≥100 MP"; action D4;
   `UI_STYLE_GUIDE.md` C.2 P3). **This one IS a rendering problem — it is Phase 1.**
4. **Canvas full-redraw on slider drag** in the signal step (`UI_STYLE_GUIDE.md` C.2 P2) and
   the **uncapped residual quiver** at dense-field scale (C.2 P1, ~800-1000 SVG nodes at the
   272-star SeeStar reference, correctly gated today). **These are Phase 2 candidates — at
   density thresholds, not by default.**

Chart *paint* appears nowhere in that list. The honest conclusion: a WebGPU migration earns
its keep on items 3 and 4 plus one net-new capability (the Phase 3 sky atlas), and must not
be sold as a general "make the UI fast" project.

---

## 2. What moves — phased

### Phase 0 — NOW, incubator: `tools/renderlab/`

A standalone prototype lane (**now ON main** — `tools/renderlab/cascade.mjs` exists; the
"does not exist on `main` yet" posture this section was written under is retired, status
refreshed 2026-07-11).
LAW 4 shape: browser-openable demo drivers + thin CLI, zero imports from `src/`, fixtures not
live pipeline data. Its job is to convert this plan's [P] marks into [M] marks:

- adapter/device bring-up in plain Chromium AND in the Tauri/WebView2 runtime (§4.1);
- one full-frame linear-Float32 → canvas presentation pipeline (Phase 1 dress rehearsal);
- one instanced point-sprite pipeline at T0 (119k) and synthetic 3M scale (Phase 2/3 dress
  rehearsal), with frame-time numbers;
- the honest-fallback rendering path when `requestAdapter()` returns null.

Nothing ports out of renderlab until it has numbers and until the owner schedules a phase.

### Phase 1 — science-buffer display via a WebGPU canvas context

**The debt it kills** (all on trunk today):

- The preview path already *computes* on GPU and then throws the residency away:
  `preview_pipeline.ts` dispatches a downsample compute pass, then reads back
  (`stagingBuffer.mapAsync` → `Float32Array` copy, `preview_pipeline.ts:344-380`), converts
  Float32→8-bit **in a JS loop with CPU gamma** (`ImageProcessor.float32ToImageData`,
  `ImageProcessor.ts:289-311`), then `putImageData` + JPEG encode
  (`imageDataToJpegUrl`, `preview_pipeline.ts:386-398`; `createPreviewUrl` →
  `toDataURL('image/jpeg')`, `ImageProcessor.ts:403-413`). That is a
  GPU→CPU→canvas→base64-string round trip for pixels that were already in VRAM.
- `docs/reference/PERFORMANCE_NOTES.md` §1 prices the encode leg at ~100-400 ms at 8 MP [P], catastrophic at
  ≥100 MP; D4 (preview-dim cap) is the stopgap. `UI_STYLE_GUIDE.md` C.2 P3 carries the same
  flag.
- The hook is already exposed: `DemosaicResult.rgbBuffer?: GPUBuffer // Shared GPU Memory`
  (`demosaic_pipeline.ts:15`) — the demosaic output can stay resident and be bound directly
  by a render pipeline. Zero readback, zero ImageData, zero base64.

**The shape:** a fullscreen-triangle render pass sampling the linear Float32 science buffer
(storage buffer or texture), with the display transform in the fragment shader.

**The physics rule (LAW 1, non-negotiable):** pixels stay linear; **stretch is render-layer.**
This is already house law — "physics stays LINEAR; Oklab = render layer only" (CLAUDE.md
routing, Color/stretch row) — and Phase 1 actually *improves* compliance: today's preview bakes
a `pow(x, 1/2.2)` into an 8-bit ImageData (`ImageProcessor.ts:294,304-306`, inside `float32ToImageData`); the GPU path keeps
the buffer linear end-to-end and applies STF/OETF only in the fragment shader at present time.
The science buffer bytes, the receipts, and every measurement are untouched — the render layer
**reads** the pixel ledger, never writes it.

Ships behind a flag (default OFF), with the existing ImageData path as the untouched fallback.

### Phase 2 — dense mark layers behind a module seam

GPU instanced marks for exactly the layers that have (or will have) DOM-scale problems:

| Layer | Today | GPU threshold |
|---|---|---|
| Starfield overlay (`MainOverlay.tsx`) | SVG, capped at **25** stars (`computeOverlayStars(solution, 25)`, `MainOverlay.tsx:29`) — fine at 25 | catalog scale: post-solve deep harvest / starplates T1 field = 10²-10⁴ marks. SVG at 25 stays; the *dense* mode is GPU |
| Residual quiver (`ResidualQuiver`) | SVG, uncapped, ~3-4 nodes/star, gated to manual render (`UI_STYLE_GUIDE.md` C.2 P1) | past **~1k arrows** (C.2 P1's own decimation note) render arrows as instanced segments under SVG chrome |
| Heatmaps (residual maps, sky background, coverage) | none / ad-hoc | any dense raster: one quad + a data texture |

**Hybrid composition contract (the seam):** SVG chrome ABOVE, GPU mark canvas BELOW, **shared
scales.** The chart keeps its axes, ticks, labels, hover readouts, and a11y in SVG exactly per
A.7; the GPU canvas draws only the marks; both consume one scale object (the `sx`/`sy` pair
that `CalibrationCharts.tsx:72-73` already computes) so a tick and a mark can never disagree by
a pixel. Hit-testing for hover readouts stays CPU-side (positions are already in JS — the
quiver model). The seam is a small module (working name `gpu_marks`, neutral per LAW 6) with a
`supported: boolean` — when false, callers keep doing exactly what they do today.

### Phase 3 — the sky-atlas region picker (starplates sync UI)

The one net-new surface: a pan/zoom whole-catalog view to drive the starplates sync layer —
"whole-tier mirror or FOV-neighborhood prefetch" (`docs/STARPLATES_SPEC.md` §7) currently has
no region UI. The same canvas doubles as the **offline pre-download region picker** (choose
tonight's sky before leaving connectivity — the offline-first field-astronomy story,
`docs/DATA_PLATFORM.md` §1).

Why this is cheap on the GPU and impossible in DOM:

- **The data is already GPU-shaped.** Starplates cells are Arrow IPC, exactly one record batch,
  no validity buffers, 64-byte-aligned SoA columns (`STARPLATES_SPEC.md` §3.2) — the documented
  precondition for "the GPU lane's zero-transpose upload" (§3.2, third bullet). Columns decode
  as contiguous zero-copy TypedArray views in JS (§5.2, §12 verified constraints). The
  `Float32` columns (`g_mag`, `bp_rp`) upload to instance buffers **verbatim**; the `Float64`
  positions go through the spec's own at-upload derivation — a per-cell f64→cell-local-f32
  rotation, O(rows), adjudicated in §12 #2 ("the GPU lane... derives its cell-local f32 SoA
  at upload time"). No AoS materialization, no `StandardStar[]` objects, no transpose.
- **LOD is a row slice.** Cells are sorted `g_mag` asc (§3.2) precisely so "brightest-K
  selection is a slice" — zoomed out, upload/draw only the row prefix per cell.
- **Coverage view needs no star data at all.** The manifest carries per-cell
  center/radius/rows/bytes (§2.3), so the "which cells are local / absent / in the missing
  sky" picker renders from `manifest.json` alone (≤12,288 instanced quads) — including honest
  rendering of the known coverage gap (86.4% in the shipped release; measured, §4 below).

Depends on the starplates local store landing (harvest lane); until then renderlab drives it
from forge output fixtures.

---

## 3. Architecture

### 3.1 Device management — one browser device; and the one we cannot share

- **Browser side: exactly one `GPUDevice`, the existing singleton.**
  `src/engine/core/WebGPUContext.ts` is already the house device manager: cached device,
  adapter-absent → `null` (never throws), `device.lost` recovery hook, and the "Nuclear Fix"
  monkeypatch that forces any library's `requestDevice()` to return the singleton
  (`WebGPUContext.ts:21-101`). Render contexts join it, they do not fork it:
  `canvas.getContext('webgpu').configure({ device: WebGPUContext.getDevice(), ... })`.
  Same-device is what makes Phase 1 zero-copy — the demosaic `rgbBuffer` (created on that
  device, `demosaic_pipeline.ts`) is bindable by the render pass only if compute and render
  share the device. The singleton's `requiredLimits` are compute-tuned
  (`WebGPUContext.ts:49-54`); render pipelines need no additional limits. (Its label
  `SkyCruncher_Primary_Compute` is a pre-existing identifier — LAW 6 uniform-rename-later,
  don't churn; any *new* labels are neutral.)
- **The native wgpu device is a different process. No sharing. Say it plainly:**
  `src-tauri/native_gpu/src/lib.rs:14-30` creates its own wgpu instance/adapter/device inside
  the Rust process. WebView2 renders in its own process; there is no cross-process
  `GPUBuffer`/texture sharing in the WebGPU API, and the existing `NativeGpuBridge` already
  pays the honest price (bytes over Tauri IPC, `demosaic_pipeline.ts:91-104`). UI rendering is
  therefore **browser-device-only**. If a native-composited render surface ever becomes
  interesting (wry/Tauri overlay experiments exist upstream), that is a separate research
  note, not this plan.

### 3.2 Canvas context configuration

```ts
const ctx = canvas.getContext('webgpu')!;
ctx.configure({
  device,                                       // the WebGPUContext singleton
  format: navigator.gpu.getPreferredCanvasFormat(),  // bgra8unorm on Windows
  alphaMode: 'premultiplied',                   // composite over DOM chrome correctly
  // render linear, present sRGB-correct: use the '-srgb' view format
  viewFormats: [navigator.gpu.getPreferredCanvasFormat() + '-srgb'],
});
// device-pixel-ratio: back the canvas at physical pixels, CSS-size it logically
canvas.width  = Math.round(clientWidth  * devicePixelRatio);
canvas.height = Math.round(clientHeight * devicePixelRatio);
```

- `premultiplied` alpha because GPU mark canvases sit *under* SVG/DOM chrome (Phase 2
  contract) and the science canvas sits inside token-styled panels — the page compositor must
  blend honestly.
- DPR handling is mandatory: star sprites are 1-3 px objects; a CSS-pixel backbuffer would
  blur exactly the marks this project exists to sharpen. Re-configure on `resize` /
  `devicePixelRatio` change.
- **sRGB correctness (LAW 1 + the color conventions):** all shading math in linear light;
  the sRGB OETF happens once, at the surface, via the `-srgb` view format (or explicitly in
  the fragment shader if the view-format route measures badly in WebView2 — renderlab
  decides). This matches the engine's stated convention ("sRGB EOTF/OETF for linearization",
  CLAUDE.md key math) and replaces today's CPU `pow(1/2.2)` approximation
  (`ImageProcessor.ts:241`) with the real transfer function.

### 3.3 Instanced point-sprite pipeline (sketch)

One pipeline serves the starfield overlay, the atlas picker, and (with a segment expansion)
the quiver. **Vertex pulling from storage buffers — no vertex buffers, no per-mark JS.**

```wgsl
struct Star { pos: vec2f, mag: f32, bp_rp: f32 };          // 16 B/instance
@group(0) @binding(0) var<storage, read> stars: array<Star>;
struct View { scale: vec2f, offset: vec2f, dpr: f32, mag_lim: f32,
              size_k: vec2f };                              // shared-scale uniform
@group(0) @binding(1) var<uniform> view: View;

struct VSOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f,
               @location(1) color: vec4f };

@vertex fn vs(@builtin(vertex_index) v: u32,
              @builtin(instance_index) i: u32) -> VSOut {
  let s = stars[i];
  let corner = vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0;   // 4-vert tri-strip quad
  // mag → size: linear in mag (mag is already log-flux; the canvas overlay's
  // log10(flux) sizing convention, UI_STYLE_GUIDE A.7, transported to catalog G)
  let size_px = clamp(view.size_k.x - view.size_k.y * s.mag, 1.0, 12.0) * view.dpr;
  // mag → alpha: fade the last ~1.5 mag before mag_lim instead of popping
  let alpha = clamp((view.mag_lim - s.mag) / 1.5, 0.0, 1.0);
  // bp_rp → color: Gaia BP-RP tint (the engine's photometric color system,
  //                CLAUDE.md key math) via a small 1D LUT texture or polynomial
  ...
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  let g = exp(-4.0 * r2);              // gaussian sprite, linear-light
  return vec4f(in.color.rgb * g * in.color.a, g * in.color.a);  // premultiplied
}
```

Draw call: `pass.draw(4, starCount)` — one instanced call for the whole layer. Pan/zoom is a
uniform update, not a re-upload. Culling/LOD = adjusting the instance range (mag-sorted row
prefixes, §2 Phase 3). The quiver variant expands two endpoints per instance into a
screen-space-width segment quad; heatmaps are one textured quad. That is the entire pipeline
zoo — three WGSL files, no framework.

### 3.4 Text stays DOM — explicit non-goal

No SDF font-atlas project, ever, in this plan. Every label, tick value, hover readout, badge,
and unit string remains DOM/SVG, where the house typography (mono + `tnum` tabular numerics,
`UI_STYLE_GUIDE.md` A.3) and the honesty-badge system (A.6) already live. GPU text rendering
is a rabbit hole with zero instrument payoff: our dense layers are *marks*, and their labels
are sparse (hover one star → one DOM tooltip). The hybrid contract (§ Phase 2) exists
precisely so text never has to enter the canvas.

---

## 4. Constraints & fallbacks

### 4.1 WebView2 WebGPU availability (checked 2026-07-09)

- WebView2 tracks Edge/Chromium; [caniwebview.com](https://caniwebview.com/features/web-feature-webgpu/)
  lists WebGPU on WebView2/Windows as supported ("up to date"). The Tauri project itself
  [confirmed WebGPU works on Windows in Tauri](https://x.com/TauriApps/status/1630990337576431616)
  (Feb 2023), and as of late 2025 WebGPU ships by default in all major browsers
  ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers)).
- **Stronger, in-repo evidence:** this codebase already runs WebGPU *compute* in the shipping
  paths — `WebGPUContext` + the demosaic and preview compute pipelines
  (`m3_gpu_preprocess/demosaic_pipeline.ts`, `preview_pipeline.ts`). Same API surface, same
  runtime.
- **Honest gap (narrowed 2026-07-11):** compute working ≠ render-canvas presentation proven.
  `getContext('webgpu')` + `configure()` + swapchain IS now exercised in this repo in plain
  Chromium — the shipped WebGPU flowchart twin does exactly that
  (`src/engine/pipeline/ui/widgets/flowchart_webgpu/flowchart_gpu_renderer.ts:138-143`).
  The remaining unproven half is the same sequence inside **WebView2's composition**
  specifically. That is a named Phase 0 deliverable, not an assumption. Platform variance is
  real (WebView2 on Xbox, for instance, has [no WebGPU](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4138));
  Windows desktop is our target, but the fallback below is permanent regardless.

### 4.2 Adapter-absent fallback = today's path, permanently

`WebGPUContext.init()` already returns `null` on missing `navigator.gpu` or adapter
(`WebGPUContext.ts:27-39`), and every current consumer falls back (demosaic → CPU bilinear).
The render layer inherits the same discipline, LAW 3 flavored:

- **Canvas2D/SVG paths are never deleted.** They are the honest fallback forever — WebGPU is
  an *accelerator*, never a *requirement*. Two render paths (GPU, DOM), no third (§6).
- A dense layer that wanted GPU and didn't get it renders the DOM version at its existing caps
  plus an honest notice where the density was the point (e.g. the atlas picker:
  "GPU rendering unavailable — showing cell coverage only"), styled as an A.6 state, never a
  blank or broken canvas.
- `device.lost` (already hooked, `WebGPUContext.ts:58-63`) → the layer downgrades to the DOM
  path for the session and says so once.

### 4.3 `prefers-reduced-motion`

No ambient animation, full stop: no twinkle, no idle shimmer, no decorative parallax — the
instrument ethos already forbids decorative motion and the codebase currently has **zero**
`prefers-reduced-motion` handling (`UI_STYLE_GUIDE.md` C.1 C7, an open debt this project must
not deepen). GPU layers redraw on interaction (pan/zoom/hover) and data change only; any
eased transition (e.g. zoom inertia) is disabled under `prefers-reduced-motion: reduce`.
Frame loop idles at 0 Hz when nothing changed (draw-on-dirty, not rAF-always).

### 4.4 Memory budget

Measured against the shipped starplates release
(`src-tauri/resources/starplates/starplates-2026.07-gdr3/manifest.json`):

| Dataset | Rows (measured) | Instance data @ 16-20 B/star | Verdict |
|---|---|---|---|
| T0 all-sky (G ≤ 9) | **119,306** | **~1.9-2.4 MB** | trivial; the boot dataset |
| Full T1 (G ≤ 12.5) | **2,999,976** (10,612 cells) | **~48-60 MB** | one storage buffer, comfortably legal |

The WebGPU **defaults** — already skeptic-verified for this repo's designs — are **128 MiB
`maxStorageBufferBindingSize` / 256 MiB `maxBufferSize`** (`STARPLATES_SPEC.md` §12, verified
constraints; the design rule there is normative here too: *never architect around elevated
limits*). Full-T1-resident at 60 MB fits both defaults with >2× headroom; per-cell incremental
upload (~5-6 KB/cell at 20 B × ~309 rows) makes even that ceiling optional. The Phase 1
science buffer is the bigger object (8 MP × 3ch × f32 ≈ 100 MB) — also under both defaults,
and already resident today whenever the demosaic ran on GPU.

### 4.5 Determinism / receipts

The render layer reads the coordinate and pixel ledgers; it writes neither. No solve output,
receipt field, or measurement may depend on whether a frame was presented via WebGPU, Canvas2D,
or not at all. This is what makes §5's byte-identity gate enforceable.

---

## 5. Exit gates per phase (house discipline: measured, not asserted)

Every phase ports out of renderlab only through the standard battery (`docs/GATES.md` is
canonical: tsc baseline unchanged, vitest green, sacred e2e **byte-identical**) plus
render-specific gates:

| Gate | Definition | Phases |
|---|---|---|
| **e2e byte-identity** | `run_wizard_seestar.mjs` + `run_wizard_cr2.mjs` byte-identical with the render flag ON and OFF — rendering must never change receipts (§4.5). Flag default stays OFF until the owner flips it. | all |
| **Visual parity screenshots** | Playwright captures (tools/e2e harness) of each migrated surface, GPU vs DOM path, same fixture: marks within ±1 px position, panel chrome pixel-identical (chrome never moved). Stored under `test_results/` (gitignored) with a checked-in comparison script. | 1, 2, 3 |
| **Perf budgets, measured** | ≥20-iteration mean ± sd (the `starplates_bench` idiom, `STARPLATES_SPEC.md` §9.3), stated per phase up front: P1 — preview present ≤ 16 ms at 8 MP and main-thread encode time → 0 (vs the ~100-400 ms [P] baseline, `docs/reference/PERFORMANCE_NOTES.md` §1); P2 — 10k marks ≤ 4 ms/frame; P3 — 3M-star pan/zoom ≥ 30 fps on the dev box, honest numbers filed either way. A missed budget is a finding, not a shrug (`docs/reference/PERFORMANCE_NOTES.md` §3 discipline). | 1, 2, 3 |
| **Fallback exercised** | The adapter-absent path is *driven* in a test (force `WebGPUContext.reset()` + stubbed `navigator.gpu`), asserting the DOM path renders and the honest notice appears. LAW 3 is a gate, not a hope. | all |
| **Flag-OFF inertness** | With the flag unset, the GPU render module is never imported (dynamic-import seam, mirroring `VITE_STARPLATES` inertness proof, `STARPLATES_SPEC.md` §9.4). | all |

---

## 6. Non-goals (explicit)

1. **Chart chrome in GPU.** Axes, ticks, labels, hover readouts, badges: SVG/DOM forever (§1.1,
   §3.4). GPU appears under charts only via the Phase 2 mark seam.
2. **three.js / deck.gl / regl.** Weighed honestly: deck.gl's instanced scatter/heatmap layers
   are exactly our Phase 2-3 shapes and would save the WGSL authoring — but it is a
   WebGL-first stack with a large dependency tree and its own device/layer lifecycle that would
   fight `WebGPUContext`'s singleton, and this repo has hard-won form on heavy deps (the 134 MB
   dead-ONNX deletion, CLAUDE.md LIVE/DEAD). Our needed pipeline zoo is three small WGSL files
   and one draw call each (§3.3). **Recommendation: hand-rolled thin pipeline.** Revisit only
   if Phase 3 scope grows real scene-graph needs (it should not).
3. **WebGL fallback.** This section originally ruled "two paths, not three" — **superseded by
   owner ruling D-webgpu-default (2026-07-11):** *WebGPU for all widgets and dashboard items
   going forward where it makes sense; if split between the two, prefer WebGPU; if WebGL,
   document why.* The live WebGL2 cascade tier
   (`src/engine/pipeline/ui/widgets/cascade/webgl_surface.ts:216`) is thereby
   **RATIFIED-with-documentation** — its documented why (per §7.5): a no-deps hand-rolled
   choice made K:-side for the 2.5D displacement surfaces BEFORE the two-paths rule and the
   WebGPU widget substrate were in scope, sound on its own terms at the time. The original
   rationale here (a middle tier doubles the shader surface — GLSL beside WGSL, a second
   context-loss lifecycle) stands as the argument that no NEW WebGL surface should ship
   without the same documented-why discipline. Forward rule: WebGPU-first (D-webgpu-default).
4. **SDF font atlas / GPU text** (§3.4).
5. **Cross-process sharing with the native wgpu device** (§3.1) — bytes over IPC remain the
   only bridge; UI rendering is browser-device-only.
6. **Replacing the AUTO-mode diagnostics gate.** AUTO stays stats-only (`diag_prefs.ts`
   pattern); GPU rendering never becomes an excuse to compute visuals on the hot path.

---

## 7. Widget-suite GPU mapping — the dock's widgets onto this plan's primitives

The K:-drive fleet's widget suite is the ratified dock architecture (authoritative,
owner-ratified): manifest entries of `{id, title, dataSelector, weightTier(stats|chart|heavy),
render}`, mounted in a `WidgetDock` behind the flag `skycruncher.widgets.dock` (a pre-existing
K:-side identifier — LAW 6 uniform-rename-later, don't churn; every *new* name in this section
is neutral). The `dataSelector` is a **pure read**; `null` means the dock renders the canonical
NOT MEASURED frame and the widget's `render` never runs. This section maps every registered
widget — plus the planned coordinate-overlay layers and the drag-rotate 3D lens profile — onto
this plan's GPU primitives. It schedules nothing and changes no K: code; renderlab stays
unwired (LAW 4).

### 7.1 Disposition table — every registered id

Four dispositions: **GPU-SURFACE** (displaced-mesh pipeline), **GPU-MARKS** (instanced
points/vectors, §3.3), **GPU-SPLAT** (density accumulation), **STAYS-DOM** (SVG/DOM, reason
stated). Mark-count claims are grounded in the real receipt numbers at the SeeStar reference
solve: **272 matched**, **698 clean detections**, **205 forced-photometry points**,
**97-sample** curves.

| Widget (tier) | Disposition | Why (one line) |
|---|---|---|
| `solve_summary` (stats) | STAYS-DOM | stat tiles are text + tabular numerics (A.3); zero marks |
| `distortion_curves` (chart) | STAYS-DOM | two 97-sample `<path>`s with axes/hover — the §1.1 case verbatim |
| `psf_field` (heavy) | GPU-MARKS | instanced PSF ellipse glyphs: 698 glyphs × ~4 SVG nodes ≈ 2.8k nodes, past the C.2 P1 pain line; SVG chrome stays above |
| `forced_photometry_z` (chart) | STAYS-DOM | 205 forced points, one series; the hover readout *is* the widget |
| `culling_waterfall` (chart) | STAYS-DOM | a handful of stage bars (the 698→272 story); trivial mark count |
| `solve_timing_waterfall` (chart, event-only) | STAYS-DOM | event-only repaint of tens of bars; never on a hot path |
| `color_color_planckian` (chart, KEYSTONE) | STAYS-DOM | 272 matched points + one locus path; the keystone keeps full A.7 chrome — axes, hover, a11y |
| `detection_density` (heavy) | GPU-SPLAT | kernel accumulation over 698 detections is per-pixel work, not per-mark — exactly what splat is for |
| `bc_edge_recovery` (heavy) | GPU-SPLAT | edge-band recovery density; second consumer of the splat pipeline, marginal cost ≈ one buffer + one uniform block |
| `distortion_cascade_2d` (heavy) | GPU-SURFACE | four 2.5D isometric displacement surfaces (Nominal BC / Measured BC / SIP / TPS), each own-peak normalized; render-side eval mirrors engine conventions, reads the coefficient ledger only (§4.5) |
| `extinction_airmass` (scaffold) | STAYS-DOM | one extinction-vs-airmass curve, 97-sample class |
| `lp_gradient_map` (scaffold, heavy) | GPU-SURFACE — born GPU-first | smooth per-pixel gradient field from a data texture; an SVG twin would be throwaway |
| `rayleigh_mie` (scaffold) | STAYS-DOM | two scattering-law curves, 97-sample class |
| `zodiacal_overlay` (scaffold, heavy) | GPU-SURFACE — born GPU-first | smooth sky-brightness field; data-texture quad/surface |
| `aod_haze` (scaffold) | STAYS-DOM | scalar trend, trivial marks |
| `per_rig_workbench_trend` (scaffold) | STAYS-DOM | tens of per-session trend points |
| `stack_registration_residuals` (scaffold) | GPU-MARKS | 272 vectors × N frames crosses the ~1k-arrow line (C.2 P1) by frame ~4; instanced segments = the §3.3 quiver variant |
| `sextant_confidence` (scaffold) | STAYS-DOM | a confidence readout — text and a gauge |
| `bad_pixel_map` (scaffold, heavy) | GPU-MARKS — born GPU-first | 10³–10⁵ pixel marks at sensor scale; one instanced draw |
| WCS grid (overlay) | STAYS-DOM | tens of labeled graticule polylines at 1–2° FOV; the labels are DOM anyway (§3.4) |
| GWCS chain grid (overlay) | STAYS-DOM | same shape and count as the WCS grid |
| Δ-divergence layer (overlay, heavy) | GPU-SURFACE | the WCS-vs-GWCS Δ is a smooth per-pixel field — heat/displacement surface from a data texture |
| HEALPix zones (overlay) | STAYS-DOM | single-digit cell outlines intersect a SeeStar frame; the all-sky case is already Phase 3's ≤12,288 instanced quads |
| atlas sectors (overlay) | STAYS-DOM | few sector outlines at narrow FOV; atlas-picker scale belongs to Phase 3 |
| DSO labels (overlay) | STAYS-DOM | text; GPU text is a permanent non-goal (§3.4) |
| astrometry.net index tiles (overlay) | STAYS-DOM | a handful of labeled tile rectangles |
| 3D lens profile (drag-rotate) | GPU-SURFACE | same displaced mesh, camera as a uniform; drag-rotate redraws on interaction only (§4.3) |

Tally: **10 of 27 surfaces go GPU, across exactly three pipelines; 17 stay DOM.** The `chart`
tier goes GPU **zero** times — §1.1 holds unmodified.

### 7.2 The three shared primitives, spec'd once

The point of the mapping is that ten GPU widgets share **three** pipelines — not ten. Each
primitive is one WGSL file, one bind-group layout created once on the `WebGPUContext` singleton
(§3.1), and one draw (or one dispatch + one draw). Per-widget cost is *data*, not code: one
storage buffer or texture plus a ≤256 B uniform block.

**`gpu_surface` — displaced mesh.** One shared index-drawn grid (97×97 vertices — the house
sample density); the vertex stage pulls height per grid node, so no widget owns geometry. The
cascade draws it instanced ×4 — `instance_index` selects model + viewport quadrant.

```wgsl
@group(0) @binding(0) var<uniform> view: SurfaceView;
    // camera basis (fixed isometric OR drag-rotate angles), z_scale (own-peak
    // normalization, computed CPU-side from the same source), grid_dims, model_select
@group(0) @binding(1) var<storage, read> height_src: array<f32>;
    // EITHER a sampled field (lp_gradient_map, Δ-divergence, zodiacal_overlay)
    // OR a coefficient block evaluated in the vertex shader (distortion_cascade_2d:
    //    BC radial terms, SIP polynomial, TPS kernels — render-side eval mirroring
    //    the engine's conventions; reads the ledger, writes nothing, §4.5)
@group(0) @binding(2) var palette: texture_1d<f32>;   // shared LUT (+ sampler)
```

Varies per widget: height-source *contents*, normalization scalar, camera mode. Nothing else.

**`gpu_marks` — instanced points/vectors.** Exactly §3.3, unchanged: storage-buffer vertex
pulling, `draw(4, N)`. Varies per widget: the interpretation of the 16 B instance struct and
the fragment shape function — gaussian sprite (starfield), ellipse glyph with axis ratio +
position angle (`psf_field`), endpoint-pair segment quad (`stack_registration_residuals`),
1 px pixel quad (`bad_pixel_map`). The bind-group layout is identical in all four.

**`gpu_splat` — density accumulation.** Two legs. Accumulate (compute pass): points storage
buffer → `atomic<u32>` grid, uniform `{grid_dims, data_bounds, kernel_radius, weight_mode}`.
Present (render pass): the grid plus the same palette LUT as `gpu_surface` → one panel quad,
with the normalization uniform set to the **measured** max bin — the colorbar states the real
ceiling, never auto-beautified (LAW 3). Varies per widget: which dataSelector rows become
points (`detection_density`: the 698 clean; `bc_edge_recovery`: the edge-band recoveries),
kernel radius, weight mode.

### 7.3 The migration seam — dataSelector untouched, render swapped

- **`dataSelector` is never touched.** It stays a pure read. `null` ⇒ the dock frame renders
  the canonical NOT MEASURED state and returns **before any render impl is invoked** — the GPU
  path is unreachable on missing data. NOT MEASURED never reaches the GPU; there is no WGSL
  spelling of absence, by construction. Honest-or-absent happens at the dock frame, not in a
  shader.
- **Per-widget render swap.** A migrated widget's manifest `render` becomes a thin dispatcher:
  the GPU impl iff (`WebGPUContext` adapter present) AND (`weightTier === 'heavy'`) AND the
  dock flag; otherwise the SVG body. `stats` and `chart` tiers never route to GPU — the tier
  gate is structural, not advisory.
- **The SVG render body is the permanent fallback** (§4.2's rule, restated for the dock): it is
  never deleted for a migrated widget. Born-GPU-first widgets (§7.4) still ship a minimal
  honest DOM body — the aggregate numbers plus an A.6-styled "GPU rendering unavailable"
  notice — never a blank canvas.
- **Flag-OFF and adapter-absent inertness** inherit the §5 gates unchanged: the GPU module is
  reachable only via dynamic import behind the dispatcher, and the fallback path is *driven*
  in a test, not hoped for.
- Prototyping happens in renderlab against dock fixture frames (LAW 4); nothing wires into the
  dock until the §5 battery passes.

### 7.4 Sequencing — first three, and the born-GPU scaffolds

First three migrations, chosen for visual payoff per shared primitive brought up:

1. **`distortion_cascade_2d`** — brings up `gpu_surface` end-to-end (mesh, camera, palette,
   own-peak normalization, render-side coefficient eval) and is the suite's highest-payoff
   visual: four surfaces SVG can only render decimated (§7.5).
2. **`detection_density`** — brings up `gpu_splat` (both legs), reusing the surface's palette
   present machinery.
3. **`bc_edge_recovery`** — proves the reuse thesis: second consumer of `gpu_splat`, whose
   marginal cost should *measure* as ≈ one buffer + one uniform block. If it doesn't, the
   shared-primitive claim was wrong and gets re-examined before anything else migrates.

`psf_field` and `stack_registration_residuals` follow on `gpu_marks`, whose bring-up Phase 2
already owns. Scaffolds that should be **born GPU-first when their data lands** —
`lp_gradient_map`, `bad_pixel_map`, `zodiacal_overlay` — are all smooth-field or
sensor-scale-mark widgets where an SVG-first implementation would be throwaway work at a
density SVG can't honestly show; they get the minimal DOM fallback body (§7.3), not an SVG
twin.

### 7.5 Honest costs — the isometric-surface call

The cascade's four 2.5D surfaces are currently planned K:-side as hand-rolled WebGL/SVG — the
fleet already chose no-deps hand-rolled, and that choice was sound on its own terms. The
three-way tradeoff, stated plainly for this one case:

- **SVG:** a 96×96 displaced grid is ~9.2k filled polygons per surface, ~37k for the cascade,
  painter-sorted and re-sorted per rotation — an order of magnitude past the C.2 P1 pain
  line. SVG is only honest here at a decimation coarse enough to blunt the exact structure
  the widget exists to show. Acceptable as a *fallback* body (heavily decimated and labeled
  as such); under-serving as the primary.
- **Hand-rolled WebGL:** no deps, mature, and more universally available than WebGPU in the
  abstract. But it is a second GPU API in this codebase — GLSL beside WGSL, its own
  context-loss lifecycle beside `WebGPUContext` — and it collides head-on with §6.3's
  two-paths-not-three rule, which was adjudicated for exactly this repo's runtime (WebView2
  ships WebGPU, §4.1). The K: choice predates that rule being in scope.
- **WebGPU:** one API across compute + render, the singleton device shared with pipelines
  that already ship (§3.1), one shader dialect — and `gpu_surface` is reused by four other
  rows of the §7.1 table. Cost: narrower availability than WebGL in general, and WebView2
  canvas *presentation* is still a Phase 0 deliverable, not a proven fact (§4.1).

**Recommendation: WebGPU with the permanent DOM fallback** — consistent with §6.3 and with
every other row of this plan. But the fleet's WebGL choice is owner-ratified and this document
changes no K: code: **the final call is the owner's.** If the owner keeps WebGL on K:, the
§7.1 cascade row becomes "GPU-SURFACE (WebGL, K:-side)" and the S:-side plan simply does not
duplicate it.

## Related
- [UI Style Guide](../UI_STYLE_GUIDE.md) — source of the chart conventions (A.7) and measured slowness (C.2) this plan builds its scope decisions on
- [Performance Notes](../reference/PERFORMANCE_NOTES.md) — the preview-encode and main-thread cost numbers this plan's Phase 1 targets
- [SeeStar Robustness Report](../archive/SEESTAR_ROBUSTNESS.md) — corroborates the dev-mode module-storm finding cited in §1.2
- [Starplates Spec](../STARPLATES_SPEC.md) — the Arrow IPC cell layout Phase 3's sky-atlas picker uploads directly
- [Data Platform](../DATA_PLATFORM.md) — the offline-first field-astronomy story Phase 3's region picker serves
- [Gates](../GATES.md) — canonical battery (tsc/vitest/sacred e2e) every phase must pass before porting out of renderlab
