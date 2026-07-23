# tools/dag — generated-base DAG extractor

A zero-LLM extractor that reads the codebase's dependency structure straight from
the source and writes it to `dag_base.json`. No model runs here — every node and
edge comes from a mechanical read of the tree. This is the base other tools and
people annotate and verify on top of: the graph is generated first, then checked,
so nobody discovers edges from scratch.

## What it reads

Three sources, each producing one edge type:

- **import** — walks every tracked `.ts` / `.tsx` / `.mjs` under `src/` and
  `tools/` (tests skipped), reads the `import` / `export ... from` / dynamic
  `import()` specifiers, and resolves relative and `@/*` paths to file nodes. One
  node per file; one edge per import between two files.
- **stage-order** — the runtime stage vocabulary and order from the COMMITTED
  mechanical fragments `tools/dag/enrich/fragments/stage_order*.json` (each one
  the zero-LLM output of `tools/dag/enrich/replay_stage_order.js` over a single
  banked receipt; the fragment is the committed evidence, so a regen is
  identical on every checkout of the same commit — the extractor never scans
  the gitignored local receipts). Fragment stage ids are emitted verbatim as
  nodes marked `source: "receipt"` (sub-stage seams like `stage:solve.quad_wasm`
  carry `path: null` — they are not files of their own), with `stage-order`
  edges at `verification: "EXTRACTED"` (the base invariant — the enrichment
  overlay flips same-key edges to VERIFIED at merge time). This is UNIONED with
  the `src/engine/pipeline/stages/` file inventory: any stage file whose id no
  fragment claims stays represented as an unordered node marked
  `source: "static"` — a file listing has no order, so no order edges are made
  up for those. Each node's `source` field says which path produced it. This
  closes the enrich lane's extractor-change request #1
  (`tools/dag/enrich/README.md`, base-granularity drift).
  **Alias collapse**: a stage file whose code actually runs under a *different*
  receipt substage id (the `withStage`/`timeSubstage` wrap names the substage,
  not the file) is mapped onto its canonical receipt id via `STAGE_FILE_ALIAS`,
  so the static inventory never mints a file-named twin of the receipt-observed
  node for the same code (`stages/ingest.ts` → `stage:extract.decode`,
  `detect.ts` → `stage:extract.detect`, `psf_characterize.ts` →
  `stage:psf_field`, `science.ts` → `stage:spcc`; each cited to its wrap site in
  `orchestrator_session.ts`). The file's *module* node is unaffected — only the
  duplicate **stage** node collapses.
- **contract** — the enumerated LAW-7 binary boundaries declared in
  `src/engine/contracts/binary_layouts.ts`. One node per boundary (with its
  version); an edge to each module the boundary entry names as a producer or
  consumer. The boundary list is read by regex over that file, because this is a
  `.mjs` and no TypeScript loader is available in the worktree.

## Output shape

`dag_base.json`:

```
{
  "schema_version": "0.1.0",
  "generated_at_commit": "<sha>",
  "nodes": [{ "id", "kind": "module|stage|boundary", "path", "cite", "source", "version" }],
  "edges": [{ "from", "to", "type": "import|stage-order|contract", "cite", "verification": "EXTRACTED" }]
}
```

Node IDs are derived from the repo-relative path (module), the stage name
(`stage:<name>`), or the boundary name (`boundary:<name>`) — never an array
index — so they stay stable across regenerations and annotations can key on them.
Every path is repo-relative with forward slashes; no drive letters or machine
names appear, because the file may become a public page.

## Commands

```
node tools/dag/extract_dag.mjs      # regenerate dag_base.json
node tools/dag/check_dag_drift.mjs  # fail (nonzero) if code and committed base diverge
npx vitest run tools/dag            # the test suite
```

To refresh the runtime stage tier from a newly banked receipt: run
`tools/dag/enrich/replay_stage_order.js` (the enrich lane's offline refresher),
commit the updated `stage_order*.json` fragment, then regenerate the base — the
extractor itself never reads receipts.

`check_dag_drift.mjs` compares node and edge SETS only; `generated_at_commit`
differs by design and is ignored. When you intend a graph change, regenerate the
base and commit it in the same change — the committed `dag_base.json` is the
artifact under the drift gate.
