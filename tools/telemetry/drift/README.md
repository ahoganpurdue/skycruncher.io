# R2 Drift Instrument v0 (`tools/telemetry/drift/`)

**Tier: TEST/DEV. The R2 row schema is NOT locked (owner queue item). Nothing here is a calibrated alert threshold.**

## Why this exists

On 2026-07-21 the owner descoped bit-identical solver pins to *serious-regression tripwires*, on the explicit premise that **R2 population telemetry becomes the systemic-drift instrument of record**. That instrument did not exist. This is v0 of it.

It answers: *given the banked population of solve receipts as a baseline, does a new batch of receipts drift — in outcome mix, in the distribution of any measured quantity, or in a decision core that should still match a truth-anchored pin?* It reports **magnitudes and candidates**; it does not decide. Alert thresholds are a later owner ruling.

## What it does

1. **Population ingest.** Loads the normalized solve-receipt row table emitted by the upstream ETL (`tools/telemetry/receipts_to_parquet.mjs` → `telemetry_db/solves.ndjson`). That ETL is untracked working-tree code owned by the greenfield session; this instrument **reads its output, does not own it**. A thin raw-receipt fallback (`--receipts <dir>`) projects only the drift subset when no `telemetry_db` is present.
2. **Baseline distributions**, stratified by `arm` / `rig_class` / `truth_class` / `field_class` / `git_commit_short` (+ pooled `ALL`). Per stratum: outcome mix (solved / state / truth-verdict) and median / IQR / p10 / p90 for each numeric metric. The truth-anchored pins (`PINNED_REFERENCE_SOLVES.json`) are their own labeled stratum.
3. **Drift queries** (new batch vs baseline):
   - **Numeric drift** — robust effect sizes: **median shift in baseline-IQR units** *and* **Cliff's delta**. A candidate requires **both** to exceed their provisional marker (*concordance* — a single measure is fooled: IQR-units by multimodal mixed-rig strata, Cliff's by tiny-N chance). No p-values anywhere.
   - **Outcome-mix drift** — total-variation distance. Only the binary `solved_flag` (solve/refuse) outcome is auto-flagged; `state`/`truth_verdict` are informational (a 6-way outcome has a positive TVD null floor at small N).
   - **Pin divergence** — each batch receipt's decision core (state / scale / parity / band / RA / Dec) vs the pin for its frame. Only **reference-core** receipts (`band_major=false`) count as drift; band-major receipts legitimately differ from the reference-arm pins and are reported as *expected cross-arm*.
4. **Dashboard-ready output.** `drift_summary.json` (compact) is designed for a future widget. **This lane does not touch dashboard/UI code.**

## No calibrated constants

v0 reports magnitudes and flags candidates only. The provisional triage markers — `|median-shift/IQR| ≥ 1.0`, `|Cliff's delta| ≥ 0.474`, `outcome TVD ≥ 0.25`, power floor `batch_n ≥ 5` — exist **only to sort the report so the largest movers surface first**. They are **NOT alert thresholds**. Real thresholds are an owner ruling. Cliff's-delta descriptor bands (negligible / small / medium / large, Romano et al. 2006) are conventional literature labels for interpretation, never a pass/fail gate. There are no significance tests; every figure is an effect-size magnitude over the observed population.

## Run

```bash
# Full deliverable: baseline_snapshot.json + drift_summary.json + REPORT.md into the bank
node tools/telemetry/drift/drift.mjs report

# Baseline snapshot only (optionally a subset)
node tools/telemetry/drift/drift.mjs baseline --filter arm=m6 --json

# Self-tests only (validation evidence: null split + positive control + config sentinel)
node tools/telemetry/drift/drift.mjs selftest

# Live-batch path: compare a NEW batch telemetry_db against the baseline population
node tools/telemetry/drift/drift.mjs compare --batch-db <new_telemetry_db_dir>
node tools/telemetry/drift/drift.mjs compare --batch-receipts <dir_of_receipt_jsons> --json
```

Flags: `--db <dir>` (baseline telemetry_db), `--batch-db <dir>`, `--pins <file>`, `--bank <out dir>`, `--receipts <dir>` / `--batch-receipts <dir>` (raw-receipt fallback), `--filter col=val`, `--json`.

Defaults: `--db D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db`, `--pins .../PINNED_REFERENCE_SOLVES.json`, `--bank test_results/drift_instrument_2026-07-21`.

**Prerequisite:** the `telemetry_db` must exist. If absent, first run the upstream ETL (`node tools/telemetry/receipts_to_parquet.mjs`, untracked greenfield lane) or point `--receipts` at a receipt directory.

## Files

- `drift_lib.mjs` — pure library (robust stats, ingest, baseline, compare, pin-check). Single source of truth (CLAUDE.md LAW 4). Zero deps.
- `drift.mjs` — CLI (`report` / `baseline` / `selftest` / `compare`).

## Outputs (banked under `test_results/drift_instrument_2026-07-21/`)

- `baseline_snapshot.json` — full stratified baseline distributions + provenance.
- `drift_summary.json` — compact, dashboard-ready: baseline-of-record digest + self-test results + a reserved `latest_batch_vs_baseline` slot.
- `REPORT.md` — human-readable strata + self-test findings + caveats.

## v0 validation (self-test on the banked N=47)

- **Null (stratified 50/50 split, same population):** PASS — 0 powered false-alarms (binary-outcome candidates = 0, reference-core pin divergences = 0). One numeric candidate survives — a genuine small-N sampling residual (`m6_ab scale_residual_pct`, batch_n=8) — kept, not tuned away.
- **Positive control (m6 full-ladder vs m6_bandmajor abort-on-accept):** DETECTED — `wall_ms` median 72041 → 419 ms (−1.06 IQR units, Cliff's −1), plus probe-census and solve-rate shifts. The instrument has power.
- **Config sentinel (by git commit):** demo only — in this bank the commit split ≈ the arm split, so the code effect is confounded with the arm behaviour. Flagged.

## Known limitations / v0 honesty

- **N = 47.** Per-stratum drift power is limited. Multi-category (`truth_verdict`) TVD has a positive null floor at this N and is informational only. More population is the single biggest v0 improvement.
- The upstream ETL and `PINNED_REFERENCE_SOLVES.json` are local/untracked; presence is verified, never assumed.
- R2 is not read at v0 (owner-gated). Everything runs from the local banked receipts. When the R2 schema locks, point `--db`/`--batch-db` at R2-materialized telemetry_dbs; the drift math is unchanged.
