<!-- REFERENCE · public documentation of the headless API (tools/api/) -->
# Headless API

Everything the desktop app measures, a Node process can measure without the app. `runWizardPipeline` runs the real pipeline — the same stages, the same compiled WebAssembly, the same star atlas — and returns the same JSON receipt, bit for bit. This page covers how to run it and how to read what comes back.

**Forensic Question:** *"Can a program drive the same instrument a person drives, and get the same answer, byte for byte?"*

## What it is

There is no separate "API implementation" that could drift from the app. `runWizardPipeline` (`tools/api/headless_driver.ts`) constructs the same pipeline session the desktop wizard uses and drives it end to end in Node: load, extract, metrology, solve, calibrate, integrate. It boots the same compiled WebAssembly and reads the same star atlas through a filesystem loader.

The receipt it returns is bit-identical to what the desktop app exports — IEEE floating-point equality, no tolerances — and the repository's own regression gates (`tools/api/*.apispec.ts`, ledgered in `docs/GATES.md`) assert exact values on every change. If headless and desktop ever disagreed on a single bit, the gate would go red.

Two input formats are exercised and pinned by those gates: FITS (`.fit` / `.fits` / `.fts`) and Canon CR2 raw.

## Quick start

The practical entry point is the CLI wrapper, which forks the real solve and gives you a receipt on disk plus a compact summary on stdout. It currently accepts FITS input.

```bash
node tools/api/run.mjs "path/to/your_frame.fits"
```

What happens:

- The **full receipt** is written to `test_results/api_runs/<basename>.receipt.json` (change the directory with `--out`).
- **stdout** carries only a JSON projection of selected fields, so a script or agent pays for exactly the fields it asks for. Select your own with `--select`, comma-separated dot-paths:

```bash
node tools/api/run.mjs --select solution.ra_hours,confirm_status.status "path/to/your_frame.fits"
```

- **Exit code**: `0` solved, `2` an honest no-solve (a failure receipt is still written, with the diagnostics for why), `1` error.
- A selected path that does not exist in the receipt prints the string `MISSING` — never a fabricated value.

The default projection:

```json
{
  "solved": true,
  "solution.ra_hours": "<hours>",
  "solution.dec_degrees": "<degrees>",
  "solution.pixel_scale": "<arcsec per pixel>",
  "solution.stars_matched": "<count>",
  "solution.confidence": "<0..1>",
  "deep_confirmed.setGatePassed": "<true|false|null>"
}
```

Unit note: `ra_hours` is in **hours**, not degrees. Degrees appear only at the FITS-file boundary.

Prerequisites: `npm install`, both WebAssembly modules built, and the star data fetched — see "Getting started" in the top-level [README](../../README.md). The wrapper aborts a run at 360 seconds.

### Importing directly

The engine resolves imports through a bundler path alias and needs the compiled WebAssembly booted, so `runWizardPipeline` is not importable from a plain Node script. The proven mechanism is to run it under the repository's vitest harness (`tools/api/api_harness.config.ts`), which is exactly what `run.mjs` does for you. The signature, for harness-hosted callers:

```ts
runWizardPipeline(buffer: ArrayBuffer, opts: {
  atlasRoot: string;            // directory the atlas URLs resolve against, e.g. <repo>/public
  overrides?: ...;              // the wizard's observation-details form, as data
  callerHint?: ...;             // an optional target hint — a search prior, never a measurement
  onEvent?: (e) => void;        // live tap on every pipeline event
}): Promise<{ receipt, events, session }>
```

CR2 headless runs through the same harness; `tools/api/solve_cr2.apispec.ts` is the pinned proof.

## The receipt, block by block

The receipt is the product: one JSON document that records what was measured, how, and what was not measured. Field names below are the real ones. Any block can be `null` — that means the measurement did not run or did not apply, and it is never silently filled in.

| Block | What it holds |
|---|---|
| `version` | The receipt schema version string (see the next section). |
| `solution` | The solve: `ra_hours` (hours), `dec_degrees`, `pixel_scale` (arcsec/px), `roll_degrees`, `parity`, `confidence`, `stars_matched`, the fitted distortion analysis (`astrometry`, with SIP and, when admitted, thin-plate-spline terms), and the measured-distortion rematch record (`bc_rematch`). `null` when the frame did not solve. |
| `solution.matched_stars` | Per-star evidence for the solve: catalog identity (`gaia_id`, `ra_deg`, `dec_deg`, `mag`), detected position (`x`, `y`), `flux`, `fwhm`, and the 2-D residual vector (`dx_px`, `dy_px`, `dRA_arcsec`, `dDec_arcsec`). |
| `wcs` | The fitted world-coordinate solution as exported — never re-synthesized from summary numbers. |
| `deep_confirmed` | Solve verification by forced photometry: flux is measured at catalog star positions (including stars the solver never matched), compared against a scrambled-null distribution, with the per-star statistics and the `fdr` block the set-level decision reads. |
| `confirm_status` | One verdict for the whole verification: `status` is `CONFIRMED`, `REFUSED`, `INSUFFICIENT_TARGETS`, `CONFIRM_UNDERPOWERED`, or `NOT_RUN`, alongside `gate_authority`, `n_confirmed_fdr`, and `fdr_q`. The deciding authority is false-discovery-rate control (Benjamini–Yekutieli step-up) over the forced-photometry family. `CONFIRM_UNDERPOWERED` means the test could not decide — which is reported as exactly that, not as a refusal. |
| `psf_field` | Spatially varying point-spread-function measurements (per-star fits, FWHM/ellipticity across the field) at the solved positions. `null` when characterization did not run. |
| `spcc` | Spectrophotometric color calibration against catalog colors, including a fidelity report on the fit itself. `null` when it did not run. |
| `final_astrometry` | A second, provenance-tagged WCS refit from the matched set, using PSF-fit centroids and — where site and time are trusted — differential refraction applied at the coordinate level. A product for export; it never overwrites the solve. |
| `lens_distortion_measured` | The measured lens-distortion fit for this frame, when one was made. |
| `solve_provenance` | Whether the solve was blind or assisted, and by what category of hint. A hinted solve is not a lesser solve — acceptance never consults the hint — but the receipt says which it was. |
| `pipeline_provenance` | Which raw-decoder arm produced the pixels and which atlas build the solve matched against, so a receipt stays interpretable across decoder and catalog updates. |
| `compute_routes` | Which compute path (GPU, CPU, or skipped) each GPU-capable stage actually took on this run. |
| `user_annotations` | Free-text observer notes, stored as testimony. Never parsed into the solve. |

## The receipt discipline

The receipt is versioned, and the version means something. Three rules make it a contract rather than a dump:

1. **One version constant.** `RECEIPT_SCHEMA_VERSION` in `src/engine/pipeline/stages/schema_versions.ts` is the single source of truth, and the same file carries the change log for every version — what block was added and why. Cite the constant, not a copy of it.
2. **Additive changes.** New capability lands as new blocks with a version bump; existing fields are not repurposed. A consumer written against an older version keeps reading its fields.
3. **Honest or absent.** A `null` block means "not measured" or "did not apply" — never a default, an estimate presented as a measurement, or a placeholder. If a number is approximate, it is labeled approximate.

Byte-identity between the headless receipt and the desktop export is not a claim in this document; it is a standing regression gate in the repository, asserted with exact floating-point equality per change.

## What it is not

- **Not a cloud API.** There is no hosted endpoint. Everything runs on your machine, against your local star data, and your images never leave it.
- **Not a lower-level solver interface.** The surface is the calibrated pipeline and its receipt — not raw solver internals or tuning knobs.

## Where this is going

Planned, not built — listed so the direction is visible:

- **ASCOM Alpaca integration** — device and observatory control over the Alpaca HTTP standard, so capture and solve can sit in one loop.
- **Community measurement contribution** — an opt-in channel for contributing receipts back to a community database (in development).
- **Data plane** — streamed star data and remote result distribution; design in [`docs/02-specs/DATA_DISTRIBUTION_PLAN.md`](../02-specs/DATA_DISTRIBUTION_PLAN.md).
- **Desktop API surface** — the app's command surface reorganized for external callers; design in [`docs/02-specs/DESKTOP_API_REMAP.md`](../02-specs/DESKTOP_API_REMAP.md).
