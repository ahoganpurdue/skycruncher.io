# Render Lab — standalone WebGPU rendering playground

A **standalone, unwired** incubator (LAW 4): nothing in `src/` imports anything
here, and nothing here imports app code. Zero app risk — the only repo
dependency is `apache-arrow` resolved from the root `node_modules`. If this lab
ever graduates, it ports behind module seams later; today it is a toy you can
fly around in.

## Run

From the repo root:

```
npx vite tools/renderlab --port 3007 --strictPort
```

Then open <http://localhost:3007>.

**Never port 3005** — that is the owner's protected dev instance. `--strictPort`
makes vite fail loudly instead of silently hopping ports.

## Data

The starfield demo fetches a real starplate blob (`/t0/allsky.arrow`,
Arrow IPC file format, schema per `docs/STARPLATES_SPEC.md` §3.2/§5.2) at
runtime. `vite.config.mjs` picks the directory to serve, in order:

1. **`tools/renderlab/data/`** — if `data/t0/allsky.arrow` exists, it wins.
   Copy or symlink a release folder's contents from the forge output:

   ```powershell
   # copy (PowerShell, from repo root)
   New-Item -ItemType Directory -Force tools\renderlab\data\t0 | Out-Null
   Copy-Item test_results\starplates\starplates-2026.07-gdr3\t0\allsky.arrow tools\renderlab\data\t0\
   ```

   ```powershell
   # or symlink the whole release folder as data/ (needs Developer Mode or admin)
   New-Item -ItemType SymbolicLink -Path tools\renderlab\data -Target (Resolve-Path test_results\starplates\starplates-2026.07-gdr3)
   ```

2. **Fallback (works with zero setup):** the T0 seed committed at
   `src-tauri/resources/starplates/starplates-2026.07-gdr3/` (4.77 MB,
   119,306 rows, G ≤ 9.0) is served automatically.

The publicDir is chosen **at server start** — restart the dev server after
creating or removing `data/`. `data/` is gitignored here; never commit blobs.

## What's in the box

| File | Role |
|---|---|
| `index.html` | page shell: canvas, HUD, controls, pane overlays, honest fallback block |
| `main.mjs` | boot, frame loop, input (drag pan/orbit / wheel zoom), HUD, HMR teardown |
| `gpu.mjs` | WebGPU bootstrap + `GpuUnavailableError` + timestamp-query timer |
| `arrow_loader.mjs` | fetch + `tableFromIPC` decode of the starplate columns |
| `starfield.mjs` | instanced point sprites, WGSL vertex pulling, in-shader gnomonic projection |
| `quiver.mjs` | SYNTHETIC residual field, instanced GPU line segments, N slider 100→100k |
| `cascade.mjs` | CASCADE data: verbatim display-only ports of the engine's four distortion-model evals, sampled onto the grid from a REAL receipt |
| `surface.mjs` | CASCADE geometry: displaced-grid-mesh surfaces, 2×2 viewport panes, orbit camera, fill+wire pipelines |
| `tokens.css` | instrument color/type tokens **copied** from `src/index.css` (the source of truth — the lab may not import app CSS) |
| `vite.config.mjs` | port 3007 strict, publicDir resolution, `/receipt.json` middleware, repo-root fs allow |

## Demos

**STARFIELD** — all T0 stars (119,306 at G ≤ 9.0 in the seeded release) as
instanced point sprites. Magnitude → size + alpha (log scaling); bp_rp →
temperature tint (**ILLUSTRATIVE** blackbody-ish ramp, not photometric — the
UI says so). Drag to pan, wheel to zoom. Starts on the M66 field.

**QUIVER** — a **SYNTHETIC** (labeled) residual field rendered as instanced
line segments, 100 → 100,000 arrows on a log slider. Purpose: feel where GPU
instancing beats the current SVG quiver; the HUD shows real draw/frame time
at each N.

**CASCADE** (DEMO 3) — the distortion cascade as four isometric surfaces in a
2×2 layout, `z = |displacement(x, y)|` px over the frame, from a **REAL**
receipt (see "DEMO 3 data" below). The four stages, each a **verbatim
display-only port** of the engine's own eval (COORDINATE ledger — no solving,
no synthesized coefficients, ever):

| Pane | Stage | Coefficients read | Math ported from |
|---|---|---|---|
| top-left | NOMINAL BC | `hardware.distortion_profile` k1/k2/k3 + `hardware.fit_stats.r_ref_px`, center = `wcs.CRPIX` | `hardware_profiler.ts::calculateRMSE` / `chart_math.ts::distortionShiftPx` |
| top-right | MEASURED BC | `lens_distortion_measured.coefficients` (k1/k2/k3 **+ p1/p2**) + `half_diag_px`, center = frame center | `tools/psf/refit_distortion.mjs::pairBasis/predictNative` (lens terms only — tx/ty/rot/a are WCS absorbers, never lens) |
| bottom-left | SIP | `solution.astrometry.sip` A/B matrices about `wcs.CRPIX` | `residual_analyzer.ts` (dx,dy polynomials in u = x−CRPIX1, v = y−CRPIX2) |
| bottom-right | TPS | `solution.astrometry.tps` anchors/weights/affine | `shaders/unified_calibration.wgsl::evaluate_tps` (U(r) = r²·ln r) |

Each pane is normalized to its **own peak**, with the real peak px (and its
frame position) annotated on the pane — honest per-stage scale; the panes are
comparable in *shape*, not height. A stage missing from the receipt renders an
explicit **NOT MEASURED** tile with the concrete reason (e.g. MEASURED BC has
no producer yet; TPS has schema slots but no emitter). Drag orbits the shared
camera; wheel zooms; FILL/WIRE toggle the surface style; the grid slider
sweeps 32×32 → 256×256 (heights re-evaluated on the CPU, measured in the HUD).

## DEMO 3 data (receipt)

The cascade fetches `/receipt.json` at runtime. Provide a real one by copying
the latest e2e run's receipt into the gitignored `data/` folder (from the repo
root, PowerShell — picks the newest run automatically):

```powershell
$latest = Get-ChildItem test_results\e2e -Directory | Sort-Object LastWriteTime | Select-Object -Last 1
New-Item -ItemType Directory -Force tools\renderlab\data | Out-Null
Copy-Item (Join-Path $latest.FullName 'receipt.json') tools\renderlab\data\receipt.json
```

`vite.config.mjs` serves `data/receipt.json` through a per-request middleware,
so unlike the starplate publicDir choice **no server restart is needed** —
drop the file in and reload the page. No receipt → the whole demo renders its
honest-absent state with these setup instructions (never a synthetic surface).
`data/` is gitignored; never commit receipts.

## Precision note (read before trusting the pixels)

The starplate release stores `ra_deg`/`dec_deg` as **f64**, and the spec's
sub-mas precision statements apply to **cell-local** frames. They do **not**
apply to a naive global f32 ra/dec (f32 quantizes ~0.08 arcsec near RA 360°,
worse after trig). This lab is display-only and handles it honestly:

- world unit vectors are computed once in f64 from the f64 columns;
- the GPU buffer stores **center-relative** f32 unit vectors, anchored at a
  "buffer center"; a small f64-composed delta rotation (buffer → live view)
  is uploaded per frame;
- when the view drifts > 25° from the anchor, the buffer is rebuilt in f64
  (the HUD shows the measured recenter cost).

Residual f32 error near the view center is ~0.02 arcsec — far below a display
pixel at any zoom the lab allows. **No astrometric claims are made**; science
paths keep f64 end-to-end.

## HUD (all numbers real or `--`)

- `fps` / `frame` — windowed FPS and rAF interval (measured).
- `encode` — CPU time from command-encoder creation to submit.
- `gpu pass` — real GPU render-pass time via `timestamp-query` **when the
  adapter has the feature**; otherwise the HUD prints `--` and says why.
  No fake numbers, ever.
- `decode` / `fetch` / `recenter` / `gen` — measured costs of the Arrow decode,
  blob fetch, f64 recenter pass, and quiver regeneration.

## Honest fallback (LAW 3)

If `navigator.gpu` is missing, `requestAdapter()` returns null, or the device
is lost, the page renders a visible DOM message — *"WebGPU unavailable in this
browser — the app's SVG/Canvas paths remain the shipping renderer"* — plus the
concrete reason. Never a blank canvas.

## First-run checklist (what you should see)

1. `npx vite tools/renderlab --port 3007 --strictPort` from the repo root →
   vite banner with `Local: http://localhost:3007/`. If 3007 is busy, vite
   exits (strict) — free the port, do not fall back to another instance.
2. Open it in a WebGPU browser (Chrome/Edge 113+). Within ~1 s the HUD
   (top-left, mono) should read `stars 119,306` with the release id and a
   decode time of a few tens of ms.
3. A recognizable sky: bright stars large/white-blue through amber, dense
   Milky Way band visible while panning. Starts on the M66 field
   (RA 170.4°, DEC +12.8°), 60° FOV.
4. Drag pans; wheel zooms (0.1°–110° FOV). Panning >25° triggers a `recenter`
   readout (a few ms) with no visible hitch.
5. `fps` ≈ your display refresh (vsync-capped); `gpu pass` sub-millisecond on
   a discrete GPU, or `--` with the honest reason if the adapter lacks
   `timestamp-query`.
6. QUIVER toggle → colored arrow field; slider sweeps 100 → 100,000 segments;
   `gpu pass`/`frame` stay flat far beyond where the SVG quiver would crawl.
7. CASCADE toggle **without** a receipt → the honest-absent panel with the
   copy command (no blank canvas, no fake surfaces). After copying a receipt
   (see "DEMO 3 data") and reloading → 2×2 isometric surfaces; with the
   current e2e receipts expect NOMINAL BC + SIP as surfaces (slate floor →
   cyan → amber → red by height) and MEASURED BC + TPS as NOT MEASURED tiles
   with their concrete reasons. Each measured pane's label shows its real
   peak px and frame position; the HUD lists per-stage peaks, grid size, eval
   ms, and the usual frame/encode/gpu-pass timings.
8. In CASCADE: drag → all panes orbit together; wheel → zoom; FILL/WIRE
   buttons toggle surface style (both off falls back to wire — never a blank
   pane); grid slider re-evaluates heights (eval ms updates in the HUD).
9. No WebGPU? The fallback message above, centered, with the reason — not a
   blank page.
10. Edit any `.mjs` while the server runs → vite hot-reloads; the old GPU
    device is destroyed on dispose (no device-leak warnings piling up in the
    console).

## Verified vs. needs-owner-eyes

Verified at build time (2026-07-09, headless WebGPU-capable browser):
`node --check` on every module; vite boot on :3007; blob fetch (HTTP 200,
4,773,514 bytes) + decode (119,306 rows, release id read from Arrow schema
metadata); starfield pipeline rendering at 60 fps with a real
`timestamp-query` gpu-pass reading (~1.8 ms) and a clean console (zero WGSL
or WebGPU validation errors); quiver pipeline creation + 100,000-arrow
regenerate; mode toggle; and the `GpuUnavailableError` throw path.
Needs your eyes: visual quality of the sky and arrows, pan/zoom feel,
sustained frame numbers on your GPU, and hot-reload teardown over a long
editing session (checklist above).
