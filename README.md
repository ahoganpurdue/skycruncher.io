# skycruncher.io

An astrophotography processing pipeline that shows its work.

RAW/FITS ingest, blind plate solving, lens and atmospheric correction, color calibration, PSF deconvolution, nebulosity separation, FITS/ASDF export with C2PA provenance signing, and a database of every measurement — each value measured, labeled approximate, or absent.

Builds a custom lens profile for your rig: vignetting, measured lens distortion, a SIP layer with atmospheric refraction separated out where site and time are known, and a final thin-plate-spline pass for what the parametric models miss.

## What it does

- Solves FITS and Canon CR2 raw files blind, no pointing hints needed. An unlabeled ultra-wide DSLR nightscape and a narrow telescope stack both work.
- Verifies each solve with forced photometry: flux is measured at catalog star positions, and a statistical gate (false-discovery-rate control) decides whether the solution is confirmed.
- Measures lens distortion (radial terms plus SIP polynomials) instead of assuming a model.
- Walks the pipeline in a step-by-step wizard that shows the intermediate evidence at each stage: detected sources, the candidate solution, per-star residuals, calibration charts.
- Exports FITS with the fitted WCS, plus a JSON record of the run: every measurement, and the diagnostics for anything that failed.
- Solves entirely on your machine. Once the star data is downloaded, no network is involved in producing a result.

## What it doesn't do

- No machine learning in the measurement path. Solving and verification are geometry and statistics.
- No synthetic or placeholder numbers. Anything unmeasured is shown as NOT MEASURED.
- No silent partial support: file types the decoder doesn't handle are rejected with a reason, not half-read.
- If a solve fails, the output says it failed and why. There is no "best guess" mode.

## Getting started

### Releases

Coming soon. Until then, build from source.

### Star data

The solver needs two datasets before it can do anything. Both come from a public bucket and are one-time downloads.

- **Quad index** (about 1 GB) — the geometric index the solver matches against. In the desktop app, open the storage settings and use the star-data download; every file is checksum-verified. The app does not solve until this index exists.
- **Star atlas** (about 340 MB) — the reference catalog used for verification. When building from source, fetch it before building:

```bash
node tools/setup/fetch_index.mjs --atlas-only --atlas-root public/atlas
```

### Building from source

Prerequisites: Node.js 18+, a stable Rust toolchain, [wasm-pack](https://rustwasm.github.io/wasm-pack/), and the [Tauri 2 platform dependencies](https://v2.tauri.app/start/prerequisites/) (WebView2 on Windows).

```bash
npm install

# Build the two WebAssembly modules (their output is not checked in)
cd src/engine/wasm_compute && wasm-pack build --target web --release && cd ../../..
cd src/engine/wasm_decode && wasm-pack build --target web && cd ../../..

npm run tauri:dev     # run the desktop app in development
npm run tauri:build   # build the installer
```

Development happens on Windows. Other platforms are untested.

## How it works

The solver extracts stars from the image, forms four-star patterns, and hashes their geometry against an index derived from the Gaia DR3 catalog. Matching hashes propose candidate poses; each candidate is checked against the catalog before anything is reported, and that verification — not the match count — is what accepts or rejects a solve. The pipeline is deterministic: the same input file produces the same output.

## Tech

Tauri desktop shell with a native Rust solver core, React/TypeScript front end, and Rust compiled to WebAssembly for the numeric kernels.

## Data credits and license

Star reference data is derived from ESA's [Gaia](https://www.cosmos.esa.int/gaia) mission (Data Release 3), processed by the Gaia Data Processing and Analysis Consortium (DPAC), with bright-star supplements from the Hipparcos and Tycho-2 catalogs.

Code is Apache 2.0 licensed. See [LICENSE](LICENSE).

## Status

Early release, under active development. Interfaces and file formats may still change.
