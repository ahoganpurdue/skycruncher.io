# `tools/validation/` — Validation & Graduation Harness

A reusable, evidence-gated framework for promoting experimental changes
("candidates") from **OFF → ON**, decided **mechanically by a logged ledger,
never by judgment**. Extends the solver law *"gates are never lowered; evidence
is added"* from the solve path to FEATURES. Pure, headless, zero app-risk — it
proves candidates via a reversible **env-var binding**, it never edits solver
source.

Spec: [`docs/VALIDATION_HARNESS.md`](../../docs/VALIDATION_HARNESS.md) (authoritative).

## Two first-class dimensions
1. **Per-image-type graduation** — a candidate can GRADUATE for one regime
   (`FITS_SEESTAR`, `CR2_DSLR`, …) or GLOBALLY. Verdicts are cohorted by
   `image_type`; a per-type verdict never pools across types.
2. **Efficiency → tool grading** — every trial records processing efficiency
   (wall ms + cost proxies + which tool locked), so `grade_tools` can profile
   the toolchain by effectiveness × efficiency — the substrate for a future
   hint-driven tool **sequencer** (ML-hint-recommender-only law: grades seed
   tool ORDER; the math gate `verifyWCS` stays the sole arbiter of a solve).

## Verdicts (per image_type + global)
`GRADUATE` · `KEEP-EVAL` · `BLOCKED` · `INSUFFICIENT-DATA` · `N/A`, resolved
per-type over ≥ `N_min(T)` distinct inputs:
`net_improvements ≥ K AND regressions == 0` → GRADUATE; any regression → BLOCKED;
`< N_min` → INSUFFICIENT-DATA; type not in `applicability` → N/A.
**GLOBAL** = the per-type criterion met for EVERY applicable type (any BLOCKED ⇒
BLOCKED; all GRADUATE ⇒ GRADUATE; any INSUFFICIENT ⇒ INSUFFICIENT; else KEEP-EVAL).

## Module layout
| File | Role |
|---|---|
| `types.ts` | `Candidate`, `Trial`, `Binding`, `Efficiency`, `Delta`, `Verdict`, `Policy` |
| `domains.ts` | SOLVER / CONFIRMATION outcome shapes + `computeDelta` models |
| `ledger.ts` | append-only JSONL `Ledger` at `test_results/validation/<id>.jsonl` (gitignored), keyed by `input_id` |
| `policy.ts` | PURE per-type + global verdict engine (`check`, `tallyForType`, `globalVerdict`) |
| `runner.ts` | runs each input OFF then ON via the binding, appends trials (idempotent) |
| `grade.ts` | `gradeTools` — per (tool, image_type) lock-rate / median σ / median ms / median cost / grade |
| `stats.ts` | `median` (honest-or-absent on empty), `costScalar` |
| `registry.ts` | `CANDIDATES` manifest + `summarize` (per-type state + latest verdict) |
| `candidates/` | `synthetic.ts` (self-test), `uw_anchor_topN.ts` + `deep_confirm_set.ts` (descriptors) |
| `run_validation.ts` · `check_graduation.ts` · `grade_tools.ts` · `list_candidates.ts` | CLIs |

## Run / check / grade
The CLIs run under Node 24 native TypeScript (no build step):

```bash
node tools/validation/list_candidates.ts                       # registry + per-type state
node tools/validation/run_validation.ts synthetic_solver       # A/B every input, append ledger
node tools/validation/check_graduation.ts synthetic_solver     # per-type + global verdict
node tools/validation/grade_tools.ts --candidate synthetic_solver   # tool grade table
node tools/validation/grade_tools.ts --image-type CR2_DSLR          # scope to a regime
```

Flags: `--force` (re-run logged inputs), `--ledger-dir <dir>` (redirect the
ledger — e.g. a scratch dir for experiments), `--image-type <T>`.

The unit suite (`src/engine/tests/validation_harness.test.ts`, part of the
sacred `npx vitest run` gate) proves the whole loop on the **synthetic
candidate** with zero calibrated-path dependency.

## Add a candidate
1. Create `candidates/<id>.ts` exporting a `Candidate`:
   - `id`, `description`, `domain`, `applicability: Set<ImageType>`.
   - `binding`: `{ envVar, offValue, onValue, defaultByType }` — the env var read
     at the **real config site** (`envInt('SOLVER_…', default)`). This is the A/B
     lever: reversible, parallel-safe, byte-identical when unset. **Never mutate
     source config for an A/B** — a sweep that edits `pipeline_config.ts` races
     every other agent.
   - `extractOutcome` / `computeDelta`: reuse a `domains.ts` pair or write your own.
   - `policy`: `{ nMin, nMinDefault, k, blockingRegressions? }`.
   - `seedVerdicts?`: the honest CURRENT state if the live A/B is not yet wired.
2. Register it in `registry.ts` (`CANDIDATES`).
3. To run it live, add `{ runFn, inputs }` to the `WIRED` map in
   `run_validation.ts`. `runFn(input)` must read the SAME env var the config
   site reads. For real calibrated candidates this wiring is
   **orchestrator-owned** (calibrated path) and is done separately.

## Invariants
- **`locked` ≡ passed verifyWCS**, not "the candidate fired" — never conflate
  (fabricates wins). `new_false_positive` is set only from an explicit oracle
  flag, never from a lever firing.
- **Cohort integrity** — never pool outcomes across image types; N/A ≠ null.
- **Efficiency is wall-clock noisy** — report MEDIANS, labelled APPROXIMATE.
- **Honest-or-absent** — `< N_min` ⇒ INSUFFICIENT-DATA, never a guessed PASS.
- **Ledger is gitignored** — a clone has the machinery, not the evidence.
- **Determinism** — no `Date.now`/`Math.random` in verdict logic; timestamps and
  timings are DATA fields (recorded), never control flow.
