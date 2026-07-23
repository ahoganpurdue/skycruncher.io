# Test Architecture

_Canonical, revised 2026-07-10._

Successor doctrine to the two-frame regression environment: generalize testing beyond the two
pinned frames to test ground truth — not just images, but the pure science and large datasets
behind them.

## 0. Diagnosis (why this exists)
The two pinned solves (SeeStar FITS, bundled CR2) are a **canary, not a correctness test**: byte-identity
measures STABILITY, never TRUTH. Failure modes already observed: (a) thresholds implicitly calibrated to
the frames' own artifacts (CFA checkerboard, flag-ON 2227→21,636 honest_failure); (b) rebaseline
procedures structurally tax improvement; (c) N=2 measures no RATES — the A5 sweep found 13 verify-gate
FPs the frames had never stressed. Root fix: anchor "correct" to EXTERNAL invariants — mathematical law,
truth-by-construction, and independent instruments — not to our own past output.
**The two frames REMAIN forever** as a fast bit-exact tripwire + two benchmark rows. They stop being the
definition of correct.

## Layer 0 — Boundary golden vectors (bit-exact, where bit-exact belongs)
This layer checks that data crossing a fixed boundary (decoder output, WASM memory layout, and
similar) matches an exact, pre-recorded byte pattern — the one place bit-exact testing actually
makes sense, since the boundary has a fixed spec.

LAW 7 golden vectors + `tools/contracts/check_layout_contracts.mjs` offset/conformance battery.
Byte-identity migrates here: a boundary has a spec; end-to-end bytes conflate a thousand decisions.
Lands per the decoder-cutover program. Cadence: per-commit (cheap).

## Layer 1 — Pure science: property tests against mathematical law (no images)
This layer tests the math itself, independent of any real image: does the code obey the physical
and geometric laws it claims to implement, across randomized inputs.

- WCS/projection round-trips (pixel→sky→pixel ≤ tolerance) over RANDOMIZED valid WCS configs (seeded).
- Invariance laws: $\text{solve} \circ \text{rotate} = \text{rotate} \circ \text{solve}$ (WCS), parity
  flips, centroid translation equivariance, quad-hash invariance under similarity transforms.
- Reference-value tests: refraction vs published tables, airmass vs Kasten-Young, photometric zero-point
  recovery on synthetic fluxes.
- Null-distribution validation: Monte-Carlo the scrambled-field forced-photometry null in CI (small N) —
  the σ math our gates ASSUME becomes a thing we MEASURE.
- Degeneracy properties: fitters (SIP/TPS/LM) fed singular/collinear geometry must ABSTAIN, never emit
  non-finite output badged as applied (honest-or-absent at the numerics layer).
Cadence: per-commit. Tooling: vitest + property-generation (seeded), Rust side via proptest at cutover.

## Layer 2 — Ground truth by construction: synthetic sky harness
This layer builds synthetic sky images from a known truth — a chosen star field rendered with a
realistic PSF and noise model — so recall and accuracy can be measured against an exact answer
instead of an estimate.

Generator = atlas patch sample → PSF render (measured PSF fields) + noise model (measured photon/read/
dark params) → distortion model → arbitrary FOV/scale/rotation/parity/density/band. Seeded, deterministic.
- Outputs MEASURED ERROR DISTRIBUTIONS, not pass/fail: astrometric residual vs truth by FOV/density/SNR;
  detection recall/precision vs injected magnitude. **Injected stars ARE the recall denominator** —
  resolves the recall-denominator problem by construction (see task #20 in `NEXT_MOVES.md`, whose
  criterion is injection truth).
- Adversarial generation on demand: trails, gradients, vignettes, planet interlopers (layers taxonomy),
  lying EXIF, busted clocks, hot-pixel fields.
- HONESTY CAVEAT: validates the pipeline against our own PSF/noise models — model mismatch is the
  residual blind spot; Layer 3 covers it.
Cadence: per-PR (small suite) + nightly (sweep). Seeds pinned; results are distributions with
pre-registered bounds.

## Layer 3 — Large datasets, independent truth: stratified benchmark battery
This layer runs the pipeline against a large, growing library of real frames whose truth comes
from a source independent of the pipeline itself, organized so results stay comparable release to
release.

Corpus frames with truth labels from INDEPENDENT sources: astrometry.net oracle (ALWAYS lite-cfg per
oracle protocol), trusted header pointing, or dual-solver agreement. Organized as a VERSIONED, IMMUTABLE,
STRATIFIED manifest (FOV class × camera × band × density × quality; content-hashed, starplates-style) so
numbers compare across months. Seed = A5 receipts + gauntlet GOLD labels; growth = photo funnel + intake.
- Gates are STATISTICAL and PRE-REGISTERED: per-stratum solve rate ≥ baseline−ε, FP rate at CONFIRMED
  tier == 0, residual medians ≤ bound — with confidence intervals (one frame can't red a build; a trend
  can't hide). LAW 2 generalization: rate gates ratchet upward on evidence only.
- **SEALED HOLD-OUT STRATUM**: a slice that NEVER participates in development, evaluated only at release
  points. This is the structural defense against the suite overfitting to its own data (the CFA-artifact
  lesson at benchmark scale).
Cadence: nightly (benchmark), release (full + hold-out).

## Layer 4 — Absolute anchors: test against astronomy itself
This layer checks results against astronomical facts that exist independent of this codebase
entirely: real star positions, real planet positions, another solver's output.

- Gaia positions (proper-motion-corrected to frame epoch) = absolute residuals for the whole coordinate
  chain.
- Ephemeris planets in solved frames = combined clock+WCS check (timestampTrusted-gated).
- DIFFERENTIAL TESTING: every exported WCS re-projected by astropy must agree ≤ tolerance (generalize the
  TPS/ASDF conformance pattern); our solver vs astrometry.net on IDENTICAL detection lists — divergence
  = investigation, never shrug.
Cadence: nightly/weekly + at export-surface changes.

## M — Mutation: the meta-axis (tests the TESTS)
Mutation testing = inject small code defects (mutants), require the suite to kill them. It is orthogonal
to Layers 0-4: coverage says what code RUNS under test; mutation score says what defects the tests CATCH.
- **Primary immediate value: mutation maps the two-frame shadow.** The pinned solves kill mutants
  brutally on the exact code path the two frames exercise and let mutants on every other path (UW
  branches, abstain/error paths, mono handling) survive freely. The per-module survivor map IS the
  quantified picture of our two-frame over-reliance — run it first as a MEASUREMENT, then as a gate.
- Mechanically finds vacuous tests (tautologies, over-mocked suites) that human review hunts by reading.
- Tooling: StrykerJS (vitest runner) for TS; cargo-mutants for Rust (at cutover). COST CONTROL: per-PR
  mutants are killed by Layers 0-2 fast suites (incremental diff-mutation, changed lines only); weekly =
  sampled full run → per-module mutation-score report. The byte-identical pinned regression / browser
  e2e and the Layer-3 benchmark NEVER run per-mutant.
- **E2E mutation via synthetic frames**: the designated mid-cost mutant
  killer for solver-path mutants = Layer-2 synthetic frames driven through the REAL headless pipeline
  with TRUTH-TOLERANCE assertions (recovered WCS/star-set within pre-registered tolerance of constructed
  truth). **Repoint at cutover**: "REAL headless pipeline" currently means the TS `headless_driver.ts` (`tools/api/`, `runWizardPipeline`); once the greenfield Rust solver core ships, the solver-path mutant killer repoints to the native Rust CLI harness (`crates/`, cargo-mutants — see the Tooling line above), with the TS headless driver retained as the real pipeline for non-solver stages only. This kills correctness-breaking mutants across regimes the two pinned frames never reach
  (UW/mono/parity/density branches — exactly the shadow), while tolerating benign refactors byte-identity
  would false-kill. Budget: ~5 diverse synthetic frames × sampled mutants, nightly. PRECONDITION:
  verify-then-use the EXISTING generator assets (tools/synth, solverkit/synthetic_inject, calib/synth_dark
  — capability audit first; extend, never duplicate, LAW 4).
- **Expected-survivor register**: mutants on calibrated constants (e.g. gate values) may survive the fast
  suites BY DESIGN — they are guarded by process (LAW 2 + benchmark rates), not unit tests. Such
  survivors are REGISTERED with their guarding mechanism named, not silently tolerated; unregistered
  constant-mutant survivors = missing benchmark assertion. Dormant/dead code is excluded from mutation
  (survivors there re-announce known dormancy).
- Score policy: pre-registered per module tier (engine COORDINATE/verify chain = high bar; UI copy = low).
  Scores ratchet like rate gates.
- Cousin lane — INPUT mutation (fuzzing): malformed/truncated FITS+CR2, hostile EXIF, corrupt headers →
  ingest boundary must fail GRACEFULLY — graceful failure and honest derivation, never fabrication.
  Seeded corpus-mutation fuzzer lives in tools/, runs nightly; crashes/fabrications = bugs.

## Governance
1. PRE-REGISTRATION: every gate threshold/bound/score bar is frozen BEFORE the
   data runs. No tuning-to-the-benchmark — that is the CFA-artifact failure mode at suite scale.
2. Rebaselines: Layer-0 golden vectors rebaseline via enumerated receipt-discipline events only; Layer-3
   baselines move by evidence-cited ratchet.
3. The two-frame tripwire is never removed without a deliberate decision; it simply stops being the
   definition of correctness.
4. Sealed stratum access = release evaluation only; unsealing for development requires a deliberate
   decision plus a replacement stratum.

## Sequencing
- PRE-FREEZE-SAFE (now): Layer-1 property suite MVP (pure math) · Layer-2 generator MVP (assembly of
  owned parts: atlas + PSF fields + synthetic_inject + noise params) · injection-based recall denominator
  (feeds task #20) · mutation MEASUREMENT run (map the shadow, no gate). All via the proposer →
  frozen-test pipeline.
- WAVE 1: benchmark manifest v1 (stratified ~50-100 labeled frames from A5/gauntlet seeds) +
  pre-registered statistical gates + sealed stratum sealed.
- WITH DECODER CUTOVER (#14): Layer-0 golden battery lands + cargo-mutants on wasm crates.
  Status: the decoder cutover is complete (rawler default, libraw cold path) and the Layer-0
  layout-contract battery has landed (`tools/contracts/check_layout_contracts.mjs` @31f0437; 90
  checks pass, including the atlas_rows golden vector in the @992338d [GATES](../GATES.md)
  regeneration). cargo-mutants on the wasm crates: not yet verified landed.
- THEREAFTER: Layer-4 differential lanes; input-fuzz nightly; mutation gates ratchet on.

## Related
- [GATES.md](../GATES.md) — the two pinned solves this doctrine keeps as a tripwire but retires as the definition of correct
- [NEXT_MOVES.md](../NEXT_MOVES.md) — task #20's recall-denominator criterion, which Layer 2 is built to resolve
- [VALIDATION_HARNESS.md](../VALIDATION_HARNESS.md) — the evidence-gated graduation harness this test doctrine's gates feed into
- [processing_flow.md](processing_flow.md) — the shipped pipeline stages the layered tests exercise
