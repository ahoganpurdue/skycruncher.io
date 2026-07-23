# tools/dag/steps — curated full-pipeline step map

`steps_map.json` is the one narrative step map of the entire SkyCruncher pipeline
(Upload → receipt/export), owner-rulable as data. Unlike `tools/dag/dag_base.json`
— a zero-LLM mechanical extract that is drift-gated against the code — this map is
a **curated, judgment-derived** artifact: it was assembled from five domain
segments (upload→solve, calibration/refinement, photometry/science,
packaging/export, interface arms) by human/agent judgment about where one step
ends and the next begins, so it is **NOT drift-gated** (regenerating it from code
is not meaningful). It is instead **validator-gated**: `validate_steps.mjs`
enforces that ids are unique, that every `parent`/`branches_to`/`converges_to`
edge and every anchor resolves (anchors to a `dag_base` node, an `xref:` to another
step, or a documented `NON_BASE_ANCHORS` exemption), that every step is cited or
flagged, and that tags/kind/observed are drawn from the known set. The map is the
single source of truth; `NARRATIVE_FULL_PIPELINE.md` is a generated view of it.

## Files

- `steps_map.json` — the map (v1.0). One unified flow, 96 steps, 24 top-level, 6
  chapters. File-type tags on steps (never parallel per-type chains).
- `NARRATIVE_FULL_PIPELINE.md` — generated numbered walk (chapter per major-step
  group, per-step "Visible at this point", flags inline, owner-ruling-queue footer).
- `validate_steps.mjs` — the gate (exit 0/1 + violation list). Exports
  `validateSteps()`.
- `validate_steps.test.mjs` — vitest lane; runs the validator against the map.
- `render_narrative.mjs` — regenerates `NARRATIVE_FULL_PIPELINE.md` from the map.

## Commands

```
node tools/dag/steps/validate_steps.mjs    # gate the map (exit 1 on any violation)
node tools/dag/steps/render_narrative.mjs  # regenerate the narrative from the map
npx vitest run tools/dag                   # the tools/dag suite, incl. this lane
```

Note: `validate_steps.mjs` and `render_narrative.mjs` are `.mjs` under `tools/`, so
each is a module node in `dag_base.json`. Regenerate the base
(`node tools/dag/extract_dag.mjs`) whenever these files are added or removed, in the
same change, so `node tools/dag/check_dag_drift.mjs` stays green.

## Honest anchoring notes

Four anchors the segments cite legitimately do NOT appear in the zero-LLM
`dag_base` and are enumerated as documented exemptions in `validate_steps.mjs`
(`NON_BASE_ANCHORS`): `src/engine/wasm_decode/src/lib.rs` (Rust source — the
extractor only walks `.ts/.tsx/.mjs`), `stage:solve.uw_sweep` and
`stage:solve.uw_escalation` (real ultra-wide substage seams not present in the
committed `stage_order` fragment), and `boundary:wasm_refine_stars_lm` (a PSF LM
wasm crossing that is not one of the enumerated LAW-7 boundaries — the generic
`boundary:wasm_typed_array` is). Any other unmatched anchor is a real violation.

## Owner ruling ledger

_(empty — owner split/merge/rename rulings on `steps_map.json` are logged here as
they land; each ruling updates the map (data, not prose), the narrative
re-renders, and the corresponding `OWNER RULING NEEDED` flag moves from the map's
ruling queue to a `RULED …` line.)_
