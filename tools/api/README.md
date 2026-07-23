<!-- REFERENCE · operating notes for the Toolchest headless API lane · owner: ahogan -->
# Toolchest headless API lane (`tools/api/`)

The Toolchest "Wave 1" lane: `headless_driver.ts` (`runWizardPipeline`) drives the
**real** wizard pipeline in Node — real compiled wasm, real decode + extraction +
solve — with the receipt IEEE bit-identical to the browser. The `*.apispec.ts`
specs assert the pinned reference solves.

## Canonical run

```
npx vitest run -c tools/api/api_harness.config.ts
```

Canonical pass count + the pinned anchor values (SeeStar / CR2 headless, receipt
schema version, the env-gated skip) live in **`docs/GATES.md`** under "Headless API
smoke" — cite it, never hand-copy. Suffix is deliberately `*.apispec.ts` (not
`*.test.ts`/`*.spec.ts`) so the SACRED `npx vitest run` gate never picks these up
(same pattern as `tools/dslr/*.uwspec.ts`). The config also nulls `setupFiles` so
the real wasm runs instead of the sacred suite's pure-JS mock.

## Operating notes (read before running)

- **This is a HEAVY lane — one heavy lane at a time.** Each apispec runs a full
  wizard solve (50MB FITS decode + wasm extraction + solve; `testTimeout` 300s).
  vitest runs spec FILES in parallel worker threads, so a full harness run fans
  several real solves across cores at once. Per the box-load incident protocol
  (battery XOR download XOR build), do **not** run it concurrently with another
  solve-heavy lane — `tools/e2e/run_wizard_cr2.mjs`, a `tools/corpus/` sweep, or a
  CR2 solve bisect — or the 300s-timeout solves can flake under CPU contention.
  The lanes don't share a port (all in-process Node), so the contention is CPU/RAM,
  not sockets; there is no cross-run isolation to lean on.

- **Run with DEFAULT env.** Since the 2026-07-11 decoder cutover, rawler is the
  default RAW arm. `VITE_DECODER_RAWLER=0` selects the libraw **cold path**, and the
  CR2 apispec will honestly FAIL against the default-arm pins (it asserts the rawler
  values). Only set that flag when deliberately exercising the cold path.

- **No pushes/merges from this lane's edits** without the orchestrator's gate battery —
  the apispecs are a standing gate; treat a red spec as evidence, not a thing to
  loosen (gates are never lowered, evidence is added).
