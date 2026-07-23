# @skycruncher/toolchest

Arrow Carrier program, **Phase 1: the forcing consumer.** Turns a completed
run's receipt (from `tools/api/headless_driver.ts` `runWizardPipeline`) into
Apache Arrow tables for the **tabular** products. Tables ride Arrow; rasters
ride typed arrays — never mixed.

Decoupled from the engine: consumes only the receipt contract by structural
typing (`ReceiptLike`), never imports `src/engine/*`.

## Surface

```ts
import { exportAllTables, writeArrowFile } from '@skycruncher/toolchest';

const { receipt } = await runWizardPipeline(buf, opts);
const tables = exportAllTables(receipt);
//   .matched_stars    solution.matched_stars      (per-star science + residual vectors)
//   .detections       signal.clean_stars          (blind source extraction)
//   .forced_confirmed deep_confirmed.confirmed_stars (catalog-forced photometry)
//   .run_summary      solution scalars + confirm   (single row)
await writeArrowFile(tables.matched_stars, 'out/matched_stars.arrow');
```

Also: `matchedStarsTable / detectionsTable / forcedConfirmedTable / runSummaryTable`,
and byte helpers `tableToArrowFileBytes` / `arrowBytesToTable` / `readArrowFile`.

## Guarantees

- **No validity-bitmap tax.** Structurally-present fields are non-nullable Arrow
  columns with no bitmap (the named 6.44 MB debt is avoided by construction).
- **Units are first-class.** Every field carries a `units` metadata key. The trap
  is labelled explicitly: `run_summary.ra_hours` is **HOURS**;
  `matched_stars.ra_deg` is **DEGREES**.
- **Provenance.** Each table's schema metadata cites the LAW-7 boundary
  (`binary_layouts#toolchest_arrow_export`) and the receipt schema version.
- **Honest-or-absent.** A no-solve receipt yields 0-row tables with the full
  schema, never fabricated rows.
- **IEEE-exact + deterministic.** Round-trip preserves bit-exact float values;
  serialization is byte-stable.

## Headless sink (first production consumer)

`tools/api/headless_driver.ts` wires the export into every headless run behind an
env switch — the Arrow Carrier program's first production touchpoint.

```sh
# default OFF: env unset ⇒ no .arrow files, receipt byte-identical by construction
SKYCRUNCHER_ARROW_SINK=out/arrow \
  npx vitest run -c tools/api/api_harness.config.ts
```

When `SKYCRUNCHER_ARROW_SINK` names a directory, `runWizardPipeline` writes the four
tabular products for each run into a **per-run subdir** and returns its path as
`result.arrowDir` (null when the sink is off or a write failed):

```
<SKYCRUNCHER_ARROW_SINK>/<ISO-timestamp>__<frameSha12>/
  matched_stars.arrow      detections.arrow
  forced_confirmed.arrow   run_summary.arrow
  manifest.json            # ts, source, frame_sha256_12, receipt_schema_version, tables
```

The run id mirrors the per-stage timing sidecar's scheme (an FS-sanitised ISO
timestamp); `frameSha12` is `sha256(frame-bytes)` truncated to 12 hex, tying each
subdir to the exact input frame. The write happens **after** the receipt is built
and is fully guarded — a read-only or racy filesystem degrades to a no-op, never a
thrown run (LAW 3, honest-or-absent). This is a pure **consumer** of the existing
`binary_layouts#toolchest_arrow_export` boundary: it defines no layout (LAW 7).

## Fixtures & interop

`fixtures/*.arrow` are committed golden files (from the deterministic
`sampleReceipt()`), pinned byte-identical to the live export. Regenerate with
`npm -w @skycruncher/toolchest run make-fixtures`. Any Arrow reader
(pyarrow/pandas) can consume them cross-language.

## Tests

`npx vitest run packages/toolchest` — round-trip + committed-fixture interop.
