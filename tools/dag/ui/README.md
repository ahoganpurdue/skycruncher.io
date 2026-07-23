# tools/dag/ui — interactive DAG collaboration space

Three views over ONE data model of the codebase DAG (owner-ratified spec,
2026-07-16; increment 2 same day): a **graph** (layered node-link) view for
collaboration, a **matrix** (adjacency) view as the scale workhorse, and a
**procedure** view — the plain-language ordered pipeline walk. Everything
renders honestly from whatever exists — base only, base + enrichment, or base +
the labeled dev fixture — and absence is always an explicit state, never
invented text (LAW 3).

## Run

```
node tools/dag/ui/serve_dag.mjs                # port env DAG_UI_PORT, default 4322
node tools/dag/ui/serve_dag.mjs --host 0.0.0.0 # LAN mode
node tools/dag/ui/serve_dag.mjs --fixture      # dev: labeled fixture when enrichment is absent
npx vitest run tools/dag                       # data-model suite + extractor suite
node tools/dag/ui/screenshot_dag_ui.mjs --url http://127.0.0.1:4322 \
     --out test_results/dag_ui_screens [--token <X-Dag-Token>]
                                               # eyes-on driver: PNGs of all views + flows
```

The server is the house dashboard pattern (`tools/theses/dashboard/serve.mjs`):
zero dependencies, read-only data plane, exactly one append-only write endpoint
(`POST /api/annotate`, `X-Dag-Token` gated; the token file
`test_results/dag_annotations/.dag_token` is reloaded, never regenerated over a
live one). Annotations land in `test_results/dag_annotations/annotations.jsonl`
as `{id, ts, author, target:{node|edge}, kind, text, private:true}` —
private-by-default owner-voice; `private:true` is stamped server-side.

## Data inputs

| input | owner | absent ⇒ |
|---|---|---|
| `tools/dag/dag_base.json` | extractor core (READ-ONLY to this lane) | page reports the regen command |
| `tools/dag/enrich/enrichment.json` | enrichment lane | banner: base-only, all edges EXTRACTED |
| `test_results/dag_annotations/annotations.jsonl` | this server (append-only) | empty comment lists |

`tools/dag/ui/fixtures/enrichment.fixture.json` is a hand-written DEVELOPMENT
FIXTURE (schema `0.0.0-FIXTURE`, every text `[FIXTURE]`-prefixed, loud banner
when active). It is served only under `--fixture` and only when real enrichment
is absent; it must never be copied into `tools/dag/enrich/`.

## Node levels (subsystem → stage → boundary)

Module nodes are NEVER rendered en masse (813 of them); they roll up:

- **subsystem** — everything grouped by mechanical path prefix:
  `src/engine/pipeline/<seg>/…` → `engine/pipeline/<seg>` (pipeline is large, so
  it splits one level deeper) · `src/engine/<seg>/…` → `engine/<seg>` ·
  `src/<seg>/…` → `src/<seg>` (bare `src/<file>` → `src`) · `tools/<seg>/…` →
  `tools/<seg>` (bare `tools/<file>` → `tools`). The 21 stage nodes roll into
  `engine/pipeline/stages`; the 15 LAW-7 boundaries roll into a single
  `contracts (LAW-7 boundaries)` group.
- **stage** — same, plus the 21 stage nodes individual (a module that IS a
  stage file merges into its stage node).
- **boundary** — same, plus the 15 boundary nodes individual.

Module granularity is reached by **focus** (drill into one group): members plus
neighbor-group ports, capped at 60 members by edge count with an honest note.
Within-group edges are counted (matrix diagonal / node subtitle), not drawn.

## Edge-type layers (14, all toggleable)

ON by default: data-flow · control/gating · contract · unit/frame-conversion
(rendered LOUD) · ordering-only · fallback/degradation · evidence · annotation.
OFF by default: receipt-write · calibration-consumes · inverse-pair ·
duplication/shadow · external-dependency · doc-binding.

Base extractor types map onto layers without losing their raw type:
`import` → data-flow (a static import is the extracted, unverified form of data
flow — its EXTRACTED ghosting is the honest rendering), `stage-order` →
ordering-only, `contract` → contract. Unknown types go to a visible
`unrecognized` pseudo-layer — data is never silently hidden.

Evidence states everywhere: EXTRACTED ghosted/dashed · VERIFIED solid ·
REFUTED struck/red · STALE amber. An aggregate (rolled-up) edge is VERIFIED
only when EVERY constituent is; mixed evidence renders EXTRACTED with a
`verified/total` count.

## Annotations & keying

Comments/questions key on **stable IDs, never pixels**, so they carry across
both views automatically: `node:<id>` and `edge:<from>|<to>|<type>`. A
single-constituent edge selection keys on the raw edge (level-independent);
a multi-constituent aggregate keys on the group pair with type `aggregate`
(level-scoped by construction — group IDs are level-specific). Constituent
edges are individually selectable for level-independent commenting.
Owner **drawn edges** (`kind:"drawn-edge"`) render as dashed human-pink edges
on the annotation layer in both views.

## File-type selectors

CR2 / FITS (solve inputs) · ASDF (export container) · PNG+JPEG (render
products) · JSON (receipts/replay plane) filter by the enrichment lane's
`walked_by` tags — rows+cols dim in the matrix, nodes+edges dim in the graph.
With enrichment absent no node carries tags, so a filter honestly dims
everything (stated in the rail notes).

## Graph layout, camera, and semantic zoom (increment 2 + force-web rework)

The graph view's **default layout is the seeded force-directed web** (owner
ruling 2026-07-16, landed @8e5aee1): PRNG seeded from the sorted node-id set,
localStorage node pinning, drag-with-tension, connected-only simulation with a
contained satellite ring for unlinked nodes (@c0bb7ab) and a hide-unlinked
toggle (@0af6326). A deterministic **"flow (layered)" layout** (Sugiyama: pure
functions in `dag_model.mjs` — sorted-id DFS back-edge removal → longest-path
rank along the edge direction → barycentric crossing-reduction with a FIXED
sweep count and id tie-breaks) is retained as a picker option, not the default.
Both layouts are deterministic: same data ⇒ same picture, every session (the
owner has spatial memory). Camera = SVG viewBox: wheel zoom about the cursor,
drag-pan from empty space, `+ − fit` controls. **Semantic zoom**: past
~1.05 px/unit the compact cards swap for detail cards (verified copy, else WHY,
else the explicit honest-absent line, plus walked-by).

## Connectivity isolation (ego view)

Select any node → **isolate** shows only its connectivity: hop depth (default
1, `+1`/`−1`), direction selector — **upstream** ("what feeds this") vs
**downstream** ("what does this feed") vs both. The BFS runs over the
post-layer-filter edge list, so layer toggles are respected; the matrix form
hides all unconnected rows/cols. Isolation auto-exits (honestly) when the
center id does not exist at the current level.

## Procedure view (third view)

An ordered, numbered walk of the pipeline driven by the merged graph's
stage-order edges (present only where a banked receipt walk was replayed; the
chain header cites the receipt). Chains group per `walked_by` tag — data-driven
headers, so the CR2 chain lands automatically. Per step: **plain stage name**
(owner ruling: no file paths in this view) · plain-language `copy` `{text,
cites}` rendered ONLY when the copy lane has verified it, else exactly
"plain-language copy not yet verified" · WHY line · `substrate` +
`receipt_write` badges render-if-present · comment/question on the node id
(same store as the other views) · view-in-graph/matrix jumps. Footer honestly
lists stages never observed in any walk. Walked ids missing from the base (the
known 23-id base↔receipt reconciliation gap) fall back to the enrichment node
entry, labeled `enrichment-sourced`; `mergeGraph` keeps the base as node
authority.

## Empty-cell annotation (proposed connections)

Clicking an EMPTY matrix intersection opens the comment/question form targeting
`{edge:{from,to,type:"proposed-connection"}}` — the annotation marks the
ABSENCE itself. Proposed pairs never enter the roll-up: they render as a ring
badge on the cell and a dashed owner-pink line in the graph, both on the
annotation layer.

## Mechanical render tier (owner-ratified)

Base parser-derived edges (`import`/`contract`/`stage-order` from the base,
still EXTRACTED) are drift-gate-checked facts, rendered **thin solid muted** —
distinct from VERIFIED (full solid) and LLM-EXTRACTED claims (dashed). An
enrichment verdict (VERIFIED/REFUTED/STALE) outranks the tier; an aggregate is
mechanical only when EVERY unverified constituent is. The rail toggle
"mechanical edges as dashed" (localStorage-persisted) reverts to the old
rendering in one click.

## Clockdrive overlay (roadmap theses + proposals — owner order 2026-07-16)

A lightweight roadmap overlay of **theses** (pre-registered / running / failed /
adopted) and owner **proposals** (decision items), ported by a sibling lane into
`test_results/dag_clockdrive/port_theses.json` + `port_proposals.json` and served
verbatim at **`/data/clockdrive.json`** as `{theses:[…], proposals:[…]}`. Either
file absent ⇒ its list is `[]`; both absent ⇒ `{theses:[],proposals:[]}` — honest
empty, never an error, no fabricated rows. `normalizeClockdrive` (pure, tested) turns
the payload into overlay nodes of kind `thesis`/`proposal` with stable, already
namespaced ids (`thesis:<id>` / `proposal:<id>`), so annotation keying works
UNCHANGED — a comment targets `{node:<id>}` and keys on `node:thesis:<id>`, carrying
exactly like every other node. An unrecognized `status` passes through as `pending`
with `statusFlagged:true` (shown, but marked — never silently coerced).

These chips are **unanchored**: they are NOT graph edges and never enter the roll-up.
In the **graph view only** they render as a dedicated brass-gold strip above the
ranks — **pending** = dashed hollow chip · **dead** = struck-through + dimmed
(visible-but-dead, killable history) · **adopted/approved** = subtle solid; an
unknown-status chip carries a warn dot. Two rail toggles (theses / proposals, default
ON) show/hide each kind. Clicking a chip opens the detail panel: title, `status`,
verbatim `raw_status`, `detail`, `source` cite, anchors, and the same
comment/question form as the rest of the app. When an entry's `anchors[]` resolve to
a node rendered at the current level, a thin annotation-style line is drawn to it
(best-effort; most anchors are `test_results/` paths that map to no rendered node —
no match ⇒ no line, honestly). **Matrix and procedure views are explicitly out of
scope for this overlay — graph-only.**

## Public-later hygiene

No absolute paths, drive letters, or machine names in any rendered copy or
served payload; all cites are repo-relative. Endpoint naming stays in config —
the page itself never hard-codes a public hostname.
