# tools/desktop_rail — Desktop Test Rail v0

**MEASUREMENT rail, not a gate** (GPU program piece 3, branch `rail/desktop-v0`, NEVER
merges). The only rail that exercises the REAL desktop paths that no browser/headless
harness can reach: the **webview→Rust seam** and the **native wgpu kernels**. It drives
the actual Tauri app self-driving (no manual clicks) and banks per-leg verdicts.

## What it proves

### LEG 1 — app-solve (webview → Rust greenfield seam)
Drives the REAL `stages/greenfield_seam.ts::solveViaGreenfield` through the live webview
`invoke('solve_greenfield')` on the banked **M66 SeeStar** detections
(`D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/…M_66…json`, 698 dets,
all finite → the exact set the Rust cargo gate solves). Asserts:
- `solved_via = greenfield_rust`, terminal state `Solved`
- pinned decision core: **scale `3.679184978895153`**, **matches `265`**
  (from `D:/AstroLogic/test_artifacts/greenfield_solver/PINNED_REFERENCE_SOLVES.json`)

This is the leg that caught the 2026-07-21 walkthrough NaN-cannot-cross-JSON bug — it runs
the actual IPC boundary, not an in-process shim.

### LEG 2 — native-GPU demosaic parity (first-ever evidence for the native shader)
Through the same webview, calls `NativeGpuBridge.demosaic` → `invoke('demosaic_native')`
(the native **wgpu** kernel, shader `demosaic_bayer_param.wgsl` — the SAME shader the
browser path runs, with the Canon-RGGB DEFAULT params baked into the Rust side since the
2026-07-21 native kernel fix) on the gpu_parity synthetic RGGB Bayer fixtures, then
compares the native output against:
- **CPU** `DemosaicEngine.demosaicBilinear` (f64 intermediate)
- **browser-WebGPU** `demosaicWebGPU` (`demosaic_bayer_param.wgsl`, f32)

using the SAME per-pixel float32-ULP methodology as `tools/gpu_parity` (interior region,
per-channel histograms, decision-relevance probe). The browser-GPU-vs-CPU comparison is
also computed as a **cross-check** against the banked `wt-gpuparity` numbers. The fixtures
are RGGB (cfa_offset 0,0). The native frame is interleaved RGB (w·h·3) — the same shape as
the CPU/browser-GPU incumbents — and is compared directly. Because native and browser now
run identical WGSL, native-vs-browser-GPU ULP isolates backend float determinism.

## Run (one command)

```
node tools/desktop_rail/run_rail.mjs
```

The runner is self-contained: it captures the MSVC dev environment itself (so cargo/
`link.exe` work without a VS developer shell), stages the input assets into
`public/__testrail_tmp/` for vite to serve, spawns `tauri dev -c
src-tauri/tauri.testrail.conf.json` (private vite port **3260**, window boots at
`#/testrail`), scrapes the self-driving webview's `RAIL|` result lines off tauri-dev
stdout, reassembles the chunked payloads, writes the report, and **kills every child by
PID on exit** (tauri, cargo, vite, the app window) + removes the staged assets.

First run does a cold Rust build (~10-15 min on a fresh `target/`); warm runs are ~2-3 min.
NEVER binds 3005/3199. Heavy: run it ALONE on the box (do not interleave with e2e/other
GPU lanes — concurrent heavy lanes crawl the box).

## Output — `test_results/desktop_rail_2026-07-21/`
- `REPORT.md` — human-readable both-legs summary
- `verdict_app_solve.json` / `verdict_native_gpu.json` — machine-readable verdicts
- `receipt_M66.json` — full greenfield receipt from the app-solve leg
- `results.json` — all reassembled payloads + run metadata
- `tauri_dev.log` — raw tauri-dev stdout/stderr (panics, build errors, RAIL lines)

## Pieces
- `webview/TestRailHost.tsx` — the self-driving host, mounted at `#/testrail` (wired in
  `src/main.tsx`). Imports live src paths; reimplements nothing.
- `webview/parity.ts` — ULP compare/decision-probe math, ported verbatim from
  `tools/gpu_parity/run_parity.mjs`.
- `run_rail.mjs` — the Node orchestrator.
- `fixtures/` — vendored gpu_parity RGGB fixtures + `gen_fixtures.mjs` (regenerable,
  seed `0x5C0FFEE1`) + `manifest.json` (md5s).
- `src-tauri/tauri.testrail.conf.json` — config variant (port 3260, `#/testrail` window).
- `src-tauri/capabilities/testrail.json` — additive capability (`log:default` only;
  custom app commands are not ACL-gated).

## Provisioning (worktree)
`node_modules` (junction) + BOTH wasm pkgs `wasm_compute/pkg` & `wasm_decode/pkg` (COPIED,
per CLAUDE.md infra trap). The atlas/demo/Sample-Files assets are NOT needed (greenfield
solve reads the g15u quad index natively via `SKYCRUNCHER_QUADIDX_DIR`; demosaic needs no
atlas) — do NOT junction `public/atlas` (338MB → wedges the vite watcher).

## Scope / caveats
- MEASUREMENT, not a gate. It is a gate-PRODUCER (banks verdicts), not a gate-consumer.
- The native demosaic path had NO prior parity evidence; whatever this rail measures
  (parity, divergence, or an honest error) IS that first evidence — recorded verbatim,
  never forced into a fake comparison.
- ULP magnitudes are GPU-microarchitecture-dependent (adapter recorded in the report).
