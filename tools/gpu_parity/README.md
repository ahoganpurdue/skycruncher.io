# tools/gpu_parity — CPU vs GPU demosaic kernel parity rail

MEASUREMENT lane (not a gate). Measures the float32 ULP divergence between the two
REAL demosaic incumbents on golden Bayer fixtures, driving actual WebGPU headless
via Playwright real Chrome. Answers the standing question behind the in-code note
`src/engine/pipeline/m3_gpu_preprocess/demosaic_pipeline.ts:63-68`
("61.6% of interior pixels differ by 1 float32 ULP, RTX 3060") — for which no
test previously existed anywhere.

## Units under test (imported, never reimplemented)
- **CPU** `DemosaicEngine.demosaicBilinear` — neighbor sums in JS float64, rounded
  to float32 at the store; a separate float64 calibration pass.
- **GPU** `demosaic_bayer_param.wgsl` via `demosaicWebGPU` — float32 throughout.

The only difference is precision (f64-intermediate vs f32-throughout); same algorithm.

## Files
- `fixtures/gen_fixtures.mjs` — deterministic fixture generator (seed `0x5C0FFEE1`,
  mulberry32). Emits three 256x256 RGGB Uint16 mosaics (`gradient`, `impulse`,
  `noise`) as raw little-endian `.bin` + `manifest.json` (dims, md5s, stats).
- `harness/index.html` + `harness/harness.ts` — minimal page that imports the real
  src paths and exposes `window.__runParity(payload)` returning both Float32 RGB
  buffers (base64) + adapter info. Runs both paths per fixture.
- `run_parity.mjs` — Node runner: spawns its OWN vite on a fresh strict port,
  curl-warms it, launches Playwright real Chrome (channel `chrome`, headless),
  drives the harness, computes ULP-delta histograms (interior/border, per channel)
  + a decision-relevance probe, writes results, kills its vite by exact PID.

## Rerun
```
# 1. (re)generate fixtures — only needed if you change the generator
node tools/gpu_parity/fixtures/gen_fixtures.mjs

# 2. run the parity measurement (default port 3247; NEVER 3005/3199)
node tools/gpu_parity/run_parity.mjs
#    override port:  GPU_PARITY_PORT=3251 node tools/gpu_parity/run_parity.mjs
#    override browser channel: E2E_BROWSER_CHANNEL=msedge node tools/gpu_parity/run_parity.mjs
```
Output: `test_results/gpu_parity_<YYYY-MM-DD>/{REPORT.md, results.json, adapter_info.json, vite_server.log}`.

## Reading the output
- `gpuUsed` MUST be `true` — else WebGPU did not dispatch and the run degraded to
  CPU-vs-CPU (deltas meaningless). The runner prints a loud `[WARN]` if so.
- `comparison.interior_pct_differ_any` — % interior RGB elements that differ at all.
- `comparison.interior_pct_ulp_eq_1` — the banked "1 ULP" metric.
- `comparison.max_ulp` / `max_abs_diff` — worst-case divergence magnitude.
- `decision_probe.star_candidate_set_identical` — whether ULP noise moved any
  downstream star-candidate decision (the number that actually matters).

## Provisioning (worktree)
Needs `node_modules` (junction) + both wasm pkgs `src/engine/wasm_compute/pkg` &
`src/engine/wasm_decode/pkg` (COPIED, per CLAUDE.md infra trap) so vite/tsc resolve.
The atlas/demo/Sample-Files assets are NOT touched by this lane (demosaic only).

## Scope / caveats
- MEASUREMENT, not a gate. A byte-identity gate would be wrong by construction.
  Any pass-bar is an owner ruling (see the REPORT's PROPOSED section).
- ULP rounding is GPU-microarchitecture-dependent; measure more adapters
  (non-NVIDIA, software fallback) before locking a numeric ULP bar.
