# tools/dag/enrich — the typed semantic layer on the base graph

The base graph (`tools/dag/dag_base.json`, read-only to this lane) is purely
mechanical: import edges, contract edges, stage nodes. This directory adds the
layer a person actually wants to read: what each edge MEANS (data-flow vs
control vs unit conversion), whether anyone has CHECKED it, why each node
exists, and which runs actually walked it.

Nothing here is invented. Every claim carries a citation (a file:line, a doc
section, or a banked receipt), and a claim that has no citation is simply
absent — an empty `why` renders as empty, not as filler.

## The artifact

`enrichment.json` — built deterministically from `fragments/*.json` by
`build_enrichment.js`. Shape:

```
{
  "schema_version": "0.1.0",
  "generated_at_commit": "<sha>",
  "nodes": { "<id>": { "why": {"text","cites":[{"path","lines"}]} | null,
                        "copy": {"text","cites":[{"path","lines"}]} | null,
                        "walked_by": ["fits", ...],
                        "badges": { ... } } },
  "edges": [ { "from", "to", "type", "cite", "verification",
               "how?", "why?", "walked_by?", "review_note?" } ]
}
```

Node ids use the base convention (repo-relative path, `stage:<name>`,
`boundary:<name>`). Edges UNION with the base edges; this file never restates
an import edge the base already has.

`why` and `copy` are both optional prose blocks with identical shape
(`{text, cites:[{path, lines}]}`) and identical discipline: single-writer
across fragments (two fragments setting either on the same node fails the
build), and non-null means non-empty `text` plus at least one repo-relative
cite — a block with no cite is a build failure, never filler (LAW 3). `why`
is the derivation-facing rationale (what the node IS / why it exists); `copy`
is the owner-/reader-facing prose surfaced in the UI. Absent (`null`) is
always fine.

**Edge types** (owner-ratified): `data-flow` (with a `how` payload: what moves,
one-line transform, lossy or not) · `control` (gating) · `contract` ·
`unit-conversion` (units/frames change here) · `ordering` · `fallback`
(degradation path) · `evidence` (a gate/spec/e2e covers this edge) ·
`stage-order` (receipt-replayed run order). The `annotation` type is the
owner's overlay and never appears in this file.

**Verification states**: `EXTRACTED` (derived, unreviewed) → `VERIFIED`
(adversarial review confirmed, cite required) | `REFUTED` (review disproved it
— kept in the file, honestly) | `STALE` (cite no longer matches the tree).

## How it is built

1. **Fragments** (`fragments/*.json`) are the unit of derivation. Each fragment
   comes from ONE deriving pass (a mechanical script or one reviewed agent
   batch) and is committed as-is. Merge collisions (two fragments claiming the
   same edge, or two `why`s for one node) fail the build — that is the domain-
   isolation tripwire, not a warning.
2. **Review overlays** (`fragments/review_*.json`) apply last. A review can
   only flip an existing edge's `verification` and attach a note — it can never
   add an edge. Deriver and reviewer are never the same pass.
3. `node tools/dag/enrich/build_enrichment.js` merges, validates, and writes
   `enrichment.json`. `npx vitest run tools/dag` gates it (schema, referential
   integrity vs the base, cite discipline, no absolute paths, byte-identical
   rebuild).

## Stage-order replay (`replay_stage_order.js`)

Reads one banked solved receipt's `stage_records` block (receipt schema ≥
2.26.0) and emits VERIFIED stage-order edges plus `walked_by` filetype tags —
a FITS receipt lights the narrow arm. The edges are *emission-order*
adjacencies of `stage_finished` events: aggregate stages (`extract`, `solve`,
`calibrate`) finish after their own sub-stages, so `forced_confirm ->
calibrate` records fold order, not a data hand-off. Read them as "this really
ran, in this order", and read the `data-flow` edges for what actually moves.

Receipts are local-only (gitignored), so the committed fragment is the banked
evidence and its cite names the receipt's `test_results/`-relative path — the
same convention the base extractor uses for its receipt-sourced nodes.

**Honest gaps, wave 1 (2026-07-16):**

- Only the FITS/SeeStar arm has a `stage_records`-bearing solved receipt
  (schema 2.27.0, banked 2026-07-16). The CR2 e2e harness banks a
  `summary.json` without `stage_records`, and the existing CR2/RAF headless
  receipts predate schema 2.26.0 — so **no `cr2` walked_by tags exist yet**.
  They will appear mechanically once a post-2.26.0 CR2 receipt is banked;
  nothing is fabricated meanwhile. Same for ASDF/PNG classes.
- The `receipt_write` badge value is a BLOCK NAME, not necessarily a top-level
  receipt key: `m7_refine` records `payload_ref: "astrometry"`, which lives at
  `solution.astrometry` in the same receipt (checked 2026-07-16, not a drift).

## Why the scripts here are `.js`, not `.mjs`

The base extractor turns every tracked `.ts/.tsx/.mjs` under `tools/` into a
module node, and `dag_base.json` is read-only to this lane — committing `.mjs`
scripts here would make the base drift gate red through no semantic change.
`.js` (this package is ESM) keeps the enrichment lane out of the graph it
annotates. If the orchestrator prefers these scripts as graph nodes, the merge
step is: rename to `.mjs` + regenerate the base in the same commit.

## Findings surfaced by wave 1 (the point of the program)

- **Base-granularity drift (extractor-core change request #1, routed to the
  orchestrator — the extractor is read-only to this lane). CLOSED 2026-07-16:
  the base extractor now consumes the committed `fragments/stage_order*.json`
  directly (all 23 declared ids + 22 order edges are base nodes/edges — see
  `tools/dag/README.md`); change request #2 below remains OPEN.** The committed
  `dag_base.json` was generated in a receipt-less checkout, so its stage nodes
  come from the static `stages/` file inventory. The RUNTIME stage vocabulary
  (receipt `stage_records`) is finer: 8 `withStage` seams are collapsed into
  their coarse parents and cannot appear as base nodes until the base learns
  them — `solve.quad_wasm`, `calibrate.m7_analyze`, `calibrate.sip_gate`,
  `calibrate.tps_gate`, `m7_refine`, `bc_measure`, `bc_rematch`,
  `render_apply_sip`. Where the extractor would find them: they are already
  emitted by the receipt path of `extract_dag.mjs` when a `stage_records`
  receipt exists in the checkout; statically they are the `withStage(...)`
  call sites in `src/engine/pipeline/orchestrator_session.ts` (step-5 region:
  m7 analysis ~1713, bc_measure ~1744, bc_rematch ~1786, render_apply_sip
  ~1856, spcc ~1907, spcc_render_gains ~1962, psf_field ~1990,
  psf_attribution ~2016, forced_confirm ~2069) plus the solve/calibrate
  sub-seams reached from steps 4-5. Wave 1 worked around nothing: these ids
  exist here as enrichment-DECLARED nodes (provenance-badged from the receipt),
  and the loud sub-stage edges are expressed against them. When the base gains
  the granularity, the declarations collapse into ordinary base references.
- **Non-base producers/consumers (extractor-core change request #2).** These
  binary_layouts-named endpoints are not base nodes, so their crossing edges
  are unexpressed (skipped, never mis-attributed): `src/engine/wasm_compute/src/lib.rs`
  (Rust; producer of `boundary:wasm_typed_array`), the `src/engine/wasm_decode`
  crate (Rust; producer of `boundary:rawler_cfa`), `src-tauri/src/lib.rs`
  (Rust; producer of `boundary:tauri_native_ipc`), `packages/toolchest/src/tables.ts`
  (outside the extractor's src/+tools/ walk; producer of
  `boundary:toolchest_arrow_export` — that boundary's data-flow is wholly
  unexpressed and only its evidence coverage appears), `tools/solverkit`
  (consumer of `boundary:starplates_blobs`), `tools/testkit` stage_replay
  (consumer of `boundary:seam_capsule`), and the `libraw-wasm` package
  (external dependency; producer of `boundary:libraw_mem_image`).
- **Parity sign is not assertable anywhere** — the relevant schema entries
  (libraw_mem_image, rawler_cfa, wgsl_structs, gpu_quad_scoring) each state
  the parity/sky-mirror sign is NOT asserted, matching the repo law "do not
  assert sign". No honest unit-conversion edge exists for parity; the gap is
  recorded instead of an edge being invented.
- **`psf` and `integrate` stages can never be receipt-tagged.** Both exist in
  code (`orchestrator_session.ts` ~2246/~2262) but are absent from
  `stage_records` — the packaging stage folds the records BEFORE its own
  completion (by design, `src/engine/events/stage_records.ts`). Receipt replay
  is structurally blind to them; any walked_by tag for them must come from a
  different evidence class.
- **Two stage vocabularies coexist by design.** Base static ids
  (`stage:package`, `stage:solve_context`, ...) come from file names; runtime
  ids (`stage:load`, `stage:extract.detect`, ...) come from receipts. Four ids
  are shared verbatim (`metrology`, `solve`, `calibrate`, `psf_attribution`).
  **RECONCILED (alias-collapse wave):** four more file names whose code runs
  under a *different* receipt substage id are now collapsed onto that id by the
  base extractor's `STAGE_FILE_ALIAS` (`ingest.ts` → `stage:extract.decode`,
  `detect.ts` → `stage:extract.detect`, `psf_characterize.ts` →
  `stage:psf_field`, `science.ts` → `stage:spcc`), so the file-derived twin is
  no longer minted and this layer no longer declares node entries for it — the
  static node's real outgoing edges (detect → metrology/solve, and the carina
  evidence edge) were re-pointed onto the canonical `stage:extract.detect`.
  `stage:package` stays genuinely static (its `integrate` step folds records
  before its own completion, so it can never be receipt-tagged — see below).

## Declared runtime stage ids (base-extension reconciliation contract)

The extractor-core granularity extension (change request #1 above) must adopt
EXACTLY these id strings so the nodes this layer declares reconcile 1:1 into
generated base nodes with zero annotation-orphaning. Declaration mechanism:
`fragments/stage_order.json` (generated by `replay_stage_order.js`), id
convention `'stage:' + record.stage` VERBATIM from `receipt.stage_records[].stage`
— the same slug rule as `extract_dag.mjs`'s own receipt path, so a base
regenerated in a receipt-bearing checkout already converges on these ids. The
23 declared ids: stage:load, stage:extract.decode, stage:extract.luminance,
stage:extract.detect, stage:extract.spectral_peek, stage:extract,
stage:metrology, stage:solve.quad_wasm, stage:solve, stage:calibrate.m7_analyze,
stage:calibrate.sip_gate, stage:calibrate.tps_gate, stage:m7_refine,
stage:bc_measure, stage:bc_rematch, stage:calibrate.hardware_profile,
stage:render_apply_sip, stage:spcc, stage:spcc_render_gains, stage:psf_field,
stage:psf_attribution, stage:forced_confirm, stage:calibrate. (Four already
exist as base static nodes: metrology, solve, calibrate, psf_attribution.)

## Review-pass findings (adversarial reviewer, 2026-07-16)

- **CRPIX convention is consistent by design, not a divergence**: the receipt
  WCS block is engine 0-based by explicit label (`stages/package.ts` ~170);
  `export/fits_writer.ts` ~209 applies the +1 at FITS serialization, while the
  stacker writer (`tools/stack/fits_io.mjs` ~218) applies +1 in one hop from a
  raw engine WCS. Both outputs land 1-based; the +1 lives at different chain
  positions.
- **`src/engine/contracts/binary_layouts.ts` carries stale internal line
  references** to its own FITS conversion sites (names `fits_decoder.ts:403`,
  actual ~1127; names `package.ts:77/:101`, actual ~161/~185). The enrichment
  edges cite the CURRENT lines; the schema's self-references need a refresh
  (routed to the orchestrator — that file is outside this lane).

## Wave-1 verification counts

Regenerate with `node tools/dag/enrich/build_enrichment.js` — the build prints
counts by type and verification state. The numbers below are the wave-1
close-out (2026-07-16) and are NOT hand-maintained afterward.

- 117 semantic edges: data-flow 56 · stage-order 22 · evidence 19 ·
  unit-conversion 7 · control 7 · fallback 4 · contract 2.
- Verification: **97 VERIFIED · 20 EXTRACTED · 0 REFUTED · 0 STALE.**
  VERIFIED = 22 mechanically replayed (receipt) + 75 confirmed by an
  independent adversarial Opus review that read every cited line (its verdict
  rows: `fragments/review_e.json`). The 20 EXTRACTED edges were simply not
  reached inside the review time-box (1 tauri boundary edge, 6 stage
  data-flow, ~13 evidence edges) — unreviewed, not suspect.
- WHY coverage: 45 of 59 node entries carry a cited why (41 librarian-derived
  + 4 external-dependency); 14 are honest nulls (no doc hit genuinely about
  the node). Review sampled 8 whys (all confirmed); the rest are unreviewed
  wave-2 work.
- Refutations found: none. The reviewer's substantive outputs were the two
  findings above — both discoveries, neither an edge error.
- Module-level (813 module nodes) semantic typing: NOT attempted in wave 1,
  by scope. The base's 1475 import edges remain EXTRACTED in the base file.

## Copy wave (2026-07-16)

- copy wave: 52 verified, 3 withheld (honest-absent — `boundary:gpu_quad_scoring`,
  `boundary:wgsl_structs`, `stage:psf_attribution` failed independent re-review).
  Fragment `fragments/copy_f.json` (copy-only, single-writer); 52 of 59 node
  entries now carry cited owner-facing `copy`. Two entries quote the phrase "not
  measured", whose JSON `\"` escape tripped the path-hygiene test's any-backslash
  check — realigned to the serializer's own double-backslash (UNC) guard so the
  gate still catches every absolute-path form without flagging prose quotes.
- nuance pass (2026-07-16): 54 entries rewritten owner-style (operational guards
  surfaced) each carrying a `substrate` badge (compute-substrate string per node;
  Opus-rewrite / Haiku cross-check per owner two-model tiering), the 3 formerly-
  withheld entries now admitted; 1 flagged entry (`stage:psf_field`) kept its
  wave-F copy unchanged (honest). 55 of 59 node entries now carry `copy`, 54 carry
  `substrate`.

## Wave-2 counts (2026-07-16)

Wave 2 adds the typed semantic layer across 11 domains (11 `wave2_*.json`
fragments: contracts, core-color, detect, export-events, ingest-hw, psf,
solver, stages, tools-api, tools-lanes, ui-app). Regenerate with
`node tools/dag/enrich/build_enrichment.js`.

- **Total after wave 2: 302 semantic edges** (185 new). By type — data-flow 162
  (+106) · control 31 (+24) · evidence 29 (+10) · contract 28 (+26) ·
  stage-order 22 (+0) · fallback 16 (+12) · unit-conversion 14 (+7).
- **Verification: 117 VERIFIED · 185 EXTRACTED · 0 REFUTED · 0 STALE.** All 117
  VERIFIED are wave-1 edges (22 receipt-replayed + 75 review_e + 20 wave-1
  closeout SET A via `fragments/review_g.json`). **Every one of the 185 wave-2
  edges stays EXTRACTED** — the per-domain adversarial reviewer stage was
  cancelled and the domain reviews are **WAIVED by owner ruling 2026-07-16
  (Opus-mapped work skips independent verification)**. Unreviewed edges render
  dashed per the ratified legend; nothing is flipped to VERIFIED without a
  reviewer.
- **WHY coverage: 156 of 170 node entries carry a cited why** (45 wave-1 + 111
  wave-2); the 14 honest nulls are unchanged from wave 1.
- **Wave-1 REVIEW CLOSEOUT applied** (`test_results/wave2_reviews/closeout.json`):
  SET A = 20 previously-unreviewed EXTRACTED edges → **20 VERIFIED / 0 REFUTED**
  (overlaid via `fragments/review_g.json`). SET B = 45 node whys → **35 OK / 10
  CORRECT / 0 REMOVE**; the 10 corrections were applied in-place to
  `fragments/why_d.json` (text + tight cites for arrow_seam, seam_capsule,
  toolchest_arrow_export, bc_measure, calibrate.hardware_profile,
  psf_attribution, solve_provenance, spcc, render_apply_sip, user_annotations).
- **Cite-tightening**: the 4 loose cites review_e flagged (a-d) were tightened
  in `fragments/loud_edges_c.json` — sip_convention→asdf_writer onto its real
  call site asdf_writer.ts:346 (`+ :495`), fits_writer→fits_io onto
  binary_layouts.ts:303, solve→calibrate onto the consumer calibrate.ts:66, and
  the wasm_typed_array→psf_field `6-vs-13 auto-detect` claim code-verified and
  cited at psf_field.ts:393-394.
- **Collisions**: none — no duplicate edge key and no double-`why` across the 11
  wave-2 fragments or against wave 1 (build fail-loud, clean).
- Gates (in the wave-2 worktree at its 96d0268 base): `npx vitest run tools/dag` 42/42 green · `npx tsc --noEmit` 0.

## Haiku check wave (2026-07-16)

Under the owner two-model rule (2026-07-16), a wave-2 edge that an independent
Haiku reviewer confirms against the cited code counts as legitimately VERIFIED —
this is the second model that the cancelled per-domain adversarial stage would
have supplied, so it lifts the WAIVED status above for the edges it reaches.
Overlay: `fragments/review_h.json` (177 rows, note `haiku cross-check (two-model
rule, owner 2026-07-16)`).

- **New verification totals: 294 VERIFIED · 8 EXTRACTED · 0 REFUTED · 0 STALE**
  (was 117 · 185). 177 wave-2 edges flip EXTRACTED→VERIFIED; the 8 that remain
  EXTRACTED are exactly the flagged edges below, honestly left dashed for an
  Opus fix pass. This SUPERSEDES the "185 EXTRACTED / WAIVED" line in the wave-2
  counts section above for the 177 cross-checked edges.
- **Resolution**: all 177 Haiku-confirmed keys resolved to a committed fragment
  edge (166 exact-id, 11 basename for the bare-filename ingest-hw domain); 0
  unresolved, 0 duplicate collisions.

### Flag ledger (follow-up queue for an Opus fix pass)

Six of the 11 domains flagged nothing (stages, psf, contracts, core-color,
tools-api, tools-lanes). The five with flags:

- **ingest-hw — 3 flagged edges, HELD EXTRACTED** (real edge-relationship
  concerns, correctly not in the confirmed set):
  - `optics_resolver.ts → metrology.ts` [unit-conversion]: cite `optics_resolver.ts:54`
    is the formula helper `computeScaleFromOptics`; metrology actually consumes it
    via `resolveOpticsFromExif` (~:69, which calls the helper at ~:83). Retarget
    the cite to the wrapper the consumer reaches.
  - `scale_manager.ts → detect.ts` [unit-conversion]: `getscienceScale`/`getBufferScale`/
    `getNativeScale`/`getPreviewScale` (defined ~78-95) reported NEVER CALLED —
    detect.ts imports `ScaleManager` only as a type. Reviewer says the described
    conversion does not occur; the strongest flag in the wave. Re-verify the
    consumer before any flip.
  - `location_trust.ts → psf_attribution.ts` [control]: cite `:88` is
    `resolveObserverLocation`; the code actually calls the wrapper
    `isObserverLocationTrusted` (~:100). Retarget the cite.
- **m6_plate_solve — 7 flagged edges + 2 why-flags, ALL ADJUDICATED FALSE
  POSITIVE (stale-checkout artifact)**. The Haiku reviewer read an out-of-date
  tree. Evidence against current HEAD: `gpu_quads/` EXISTS
  (`quad_scoring_backend.ts`, `gpu_quads_flag.ts`, `gpu_quad_backend.ts` all
  present) — so the 3 PHANTOM-MODULE flags are wrong; and the 4
  LINE-NUMBER-ERROR cites are all correct — `package.ts:1355` is the
  `classifyConfirmStatus` call (package.ts is 1511 lines, not the 805 the
  reviewer saw), `solver_entry.ts:1138` is `findStarsInField`, `:1514` is the
  escalation accept-gate, `:2786` is `projectCatalogToPixels`. **All 16 m6
  verified keys therefore flip normally; these flags do NOT enter the queue —
  they are noise from a stale base.** (The 3 phantom-target edges
  solver_entry→gpu_quads/* and the two internal gpu_quads edges stay EXTRACTED
  only because they were never in the confirmed set, not because the flag holds.)
- **export-events — 1 flagged edge (node-why DRIFT), edge FLIPPED; 1 why-flag
  queued**: `stage_timing_summary.ts → package.ts` [data-flow] is genuinely
  verified (package.ts declares `stage_timings` ~:845 and assigns it in the
  receipt builders ~:1091), so the edge flips. The flag is about the SOURCE
  node's `why`/docstring, which still claims the summary is "RECEIPT-INERT / a
  SIDECAR never folded into the receipt" — STALE: it IS folded in as an
  envelope-class block (wall-clock ms, outside the byte-identity contract).
  Correct phrasing already exists in `stage_records.ts:20-24`. Node-why fix
  queued (does not block the edge).
- **ui-app — 2 flagged edges, HELD EXTRACTED** (off-by-N cite lines; edge
  relationships real):
  - `PipelineWizard.tsx → time_trust.ts` [unit-conversion]: cite `:461` is a
    bare `new Date(...)`; the `buildUserTimeClaim()` call is at `~:469`.
  - `ForensicCalibrationStep.tsx → diag_prefs.ts` [control]: cite `:48` is
    blank; `diagnosticsVisualsEnabled(autoRun)` is at `~:47`.
- **detect — 2 flags are NODE flags, not edges** (no edge held): `masked_background.ts`
  and `luminance_reduce.ts` each carry a complete `why` but have ZERO referencing
  edges and no importer in the module — dead code or incomplete integration.
  Queued for the Opus pass to decide (wire vs. drop the node `why`).
- Gates after this overlay (worktree base d20fb2d): `node tools/dag/enrich/build_enrichment.js`
  clean (302 edges, 294 VERIFIED / 8 EXTRACTED) · `npx vitest run tools/dag`
  **95/95 green** · `npx tsc --noEmit` **0**.
