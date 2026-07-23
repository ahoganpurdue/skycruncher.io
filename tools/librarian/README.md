# tools/librarian — documentation librarian (v1)

A **card catalog** over the repo's tracked docs. You ask a question; it hands back
**pointers** — `path`, `heading`, and a line range — ranked by relevance. It is
**never a content oracle**: it does not summarize, generate, or answer. Agents
read the primary source at the returned lines. This is deliberate — the librarian
can be wrong about *ranking* without ever being wrong about *facts*, because it
never states any.

CLI-first per the incubator pattern (prototype in `tools/`, port behind seams
later). v1 is **lexical-only and says so**. No cloud calls anywhere.

## Quick start

```sh
cd tools/librarian
npm install                       # lane-local; installs @lancedb/lancedb (native, Node-only)
node index_docs.mjs               # build the catalog (full rebuild; idempotent)
node query.mjs -h "gaia atlas junction trap"
node query.mjs "where do receipt schema versions live"   # JSON lines (default)
node query.mjs -k 8 "vignette correction layers"          # top-k (default 5)
```

Output (JSON-lines mode) is one object per hit:
`{path, heading, lines, score, last_commit, class}`. A refusal is a single
`{refused:true, reason, detail, query, top_score, threshold}` object.

## Corpus & exclusions

Indexed (tracked files only, via `git ls-files`):

- `docs/**/*.md`
- root `README.md` and `CLAUDE.md` (read-only corpus member, highest authority)
- `tools/**/README.md` (all tool-lane READMEs — a superset of the brief's
  `tools/*/README.md`; more pointers = a better catalog)

**Never indexed:** `docs/local/**` (owner-voice) and `docs/archive/**` (frozen
one-shot audits/research). Enforced in `lib/corpus.mjs::isCorpusMember` and covered
by a negative-control test.

Current corpus: **82 files → 1177 chunks**.

### Chunking

One chunk per markdown **section** (heading-anchored). Each chunk records its
ancestor heading breadcrumb (`A > B > C`), 1-based inclusive `lines_start/end`,
and the section text. Content before the first heading becomes a `(preamble)`
chunk. Heading-only sections are kept — the heading itself is a searchable pointer.

### Doc class & authority

Class is derived from path + a peek at the file head (for the `<!-- LEDGER -->`
marker). Authority is a mild multiplier on the lexical score — near 1.0 so
relevance dominates and authority only breaks near-ties toward the source of record:

| class | weight | examples |
|---|---|---|
| `CLAUDE` | 1.25 | `CLAUDE.md` (routing + laws) |
| `LEDGER` | 1.20 | `GATES.md`, `AGENT_TIMING_LOG.md`, `<!-- LEDGER -->`-marked docs |
| `CANONICAL` | 1.10 | `docs/01-canonical/**` |
| `REFERENCE` | 1.05 | `docs/reference/**`, `CARD_*.md` |
| `spec` | 1.00 | `docs/02-specs/**`, `*_SPEC/_DESIGN/_PLAN/_SCHEMA/_POLICY.md` |
| `README` | 0.95 | tool-lane READMEs |
| `narrative` | 0.90 | everything else (`WHITEPAPER`, `ROADMAP`, `NEXT_MOVES`, …) |

## Scoring & the refusal posture (LAW 3 in retrieval form)

`score = (BM25 + heading-boost) × authority × coverage`

- **BM25** — hand-rolled Okapi BM25 (`k1=1.5, b=0.75`) over chunk text. No FTS
  dependency (see "Storage" for why). Tokenizer lowercases, splits on any
  non-alphanumeric run (so `SOLVER_UW_SWEEP` → `solver, uw, sweep`), drops
  length-1 tokens and a small stopword list.
- **heading-boost** — `+1.6` per distinct query term found in the heading chain.
- **coverage** — fraction of the query's distinct terms present in the chunk. This
  is the length-normalized signal that makes refusal work: raw BM25 alone does
  **not** separate real from garbage queries (it rewards a long garbage query that
  matches a couple of incidental rare words). Coverage collapses those.

When the top score falls **below a calibrated threshold**, the CLI prints a
structured **refusal** ("no indexed source for this query") instead of
nearest-neighbour garbage.

### Threshold calibration (honest, documented)

Calibrated on **10 real** + **3 garbage** queries against the live 1177-chunk
corpus (`DEFAULT_THRESHOLD = 5.0`):

**Real queries** (min top-score `8.60`):
`where do receipt schema versions live` · `gaia atlas junction trap` ·
`vignette correction layers` · `telescope interlocks observatory control` ·
`seestar byte identical solve regression` · `decoder cutover rawler libraw cold path` ·
`differential refraction correction bennett` · `forced photometry confirmation gate` ·
`sip convention fits export negation` · `thesis schema submitter class registry`

**Garbage queries** (max top-score `3.89`):
`how to bake sourdough bread` · `quarterly sales tax accounting spreadsheet` ·
`best hiking trails national park weekend`

**Separation:** empty gap `[3.89, 8.60]`. Threshold `5.0` sits in it with margin
`1.11` below (to garbage) and `3.60` above (to the weakest real query); ratio
`8.60 / 3.89 ≈ 2.2`. All 10 real pass, all 3 garbage refuse.

**Known limitation:** BM25 absolute scores scale with corpus size, so the numeric
threshold is tied to *this* corpus's scale — a large corpus change should re-run
the calibration. Override per-query with `--threshold X`.

## Storage — LanceDB (Arrow-native)

One LanceDB table `doc_chunks` under `tools/librarian/.lancedb/` (gitignored,
derived — rebuild anytime). Columns:

`path · heading · lines_start · lines_end · text · class · authority_weight ·
last_commit · file_hash`

The `vector` column is **absent in v1** (lexical-only). The semantic upgrade later
= fill a `vector` column + add an ANN index; LanceDB supports adding a column
without rewriting the dataset, so this is not a format break. This absent column
*is* the pluggable-embedder seam — there is no separate stub.

**Native FTS vs JS-side BM25.** The pinned LanceDB (`0.31.0`) *does* ship native
full-text search in the JS API (`lancedb.Index.fts()` exists). v1 deliberately does
**not** use it: we scan the table (Arrow-native `table.query().toArray()`, a few
hundred chunks, <50 ms) and score BM25 in JS. Native FTS returns opaque scores that
can't cleanly fold in the heading boost, the authority multiplier, or a
calibratable/interpretable refusal threshold — all of which are hard v1
requirements. JS-side scoring keeps the scores transparent and the refusal
honest. Switching to native FTS later is a query-layer swap, no schema change.

**Dependency discipline:** `@lancedb/lancedb` is pinned in a **lane-local**
`package.json` with its own committed lockfile. It is a native Node-only module and
**must never be imported anywhere reachable by the vite app bundle** — tools-lane
only.

## Liveness — git-event-driven only

**Explicit non-goal: there is no file-watcher daemon, ever, on this box.** The
standing-daemon leak class and the chokidar × junctioned-worktree trap are both
documented incidents. Liveness is **git-event-driven only.**

- **`file_hash`** (sha256 of the source file) is stored per chunk. Incremental
  indexing hash-skips unchanged files (cheap now; load-bearing once a per-chunk
  embedding step exists).
- **Incremental upsert:** `node index_docs.mjs --changed` reads
  `git diff --name-only HEAD~1..HEAD`, filters to corpus members, and for each
  changed file deletes its rows and reinserts its chunks (hash-skipping unchanged
  ones). You can also pass explicit paths: `node index_docs.mjs docs/GATES.md …`.
  Full rebuild stays the default and is idempotent.
- **`hook_postcommit.mjs`** is a post-commit / post-merge driver. It **gates on the
  canonical checkout** (`git rev-parse --show-toplevel` vs a configured canonical
  root) and exits silently everywhere else — hooks fire in every worktree of a
  shared repo, and agent worktrees must not race to rebuild the owner's catalog.
  Configure via env `LIBRARIAN_CANONICAL_ROOT` or the `CANONICAL_ROOT_DEFAULT`
  constant in the script.

**Install (owner/orchestrator step, after review — not self-installed):**

```sh
printf '#!/bin/sh\nnode "$(git rev-parse --show-toplevel)/tools/librarian/hook_postcommit.mjs"\n' \
  > .git/hooks/post-commit && chmod +x .git/hooks/post-commit
cp .git/hooks/post-commit .git/hooks/post-merge   # same driver for merges
```

## Demo transcript (real output, honest)

Actual top-3 results against the live corpus (`node query.mjs -h -k 3 "…"`):

```
$ node query.mjs -h "where do receipt schema versions live"
1. docs/01-canonical/SkyCruncher_Architecture.md:1799-1806  [CANONICAL]  score 20.84
   … > N.3 Receipt schema — 2.5.0 → 2.6.0 → 2.7.0 lineage
2. docs/ESCALATION_CONTROLLER_SPEC.md:76-85  [spec]  score 18.16
   … > 6. RECEIPT SCHEMA DELTA (LEANED per owner ruling 2026-07-11)
3. docs/01-canonical/SkyCruncher_Architecture.md:1853-1863  [CANONICAL]  score 17.57
   … > O.2 Receipt schema — 2.7.0 → 2.12.0 lineage

$ node query.mjs -h "gaia atlas junction trap"
1. CLAUDE.md:6-15  [CLAUDE]  score 12.67   (ORCHESTRATION — worktree junction traps)
2. CLAUDE.md:16-19  [CLAUDE]  score 11.87  (PINNED REFERENCE SOLVES)
3. docs/ATMOSPHERE_SEXTANT_SPEC.md:100-108  [spec]  score 8.18  (atlas BP-RP dependency)

$ node query.mjs -h "vignette correction layers"
1. CLAUDE.md:23-31  [CLAUDE]  score 8.60   (LAWS — two ledgers, vignette ×4)
2. docs/OPTICAL_WORKBENCH_SCHEMA.md:7-10  [spec]  score 7.77  (Two layers, never conflated)
3. docs/reference/WIDGET_LIBRARY.md:41-95  [REFERENCE]  score 5.69

$ node query.mjs -h "telescope interlocks"
1. tools/scope/README.md:1-10  [README]  score 11.05  (observatory control lane v1)
2. docs/02-specs/OBSERVATORY_CONTROL_SPEC.md:20-36  [spec]  score 8.87
3. docs/01-canonical/SkyCruncher_Architecture.md:1894-1915  [CANONICAL]  score 8.59

$ node query.mjs -h "forced photometry confirmation gate"
1. docs/01-canonical/SkyCruncher_Architecture.md:1667-1677  [CANONICAL]  score 19.60
   … > L.3 Module 6 — forced-photometry confirmation + deep_confirmed provenance
2. docs/01-canonical/SkyCruncher_Architecture.md:1644-1649  [CANONICAL]  score 19.60
3. docs/WHITEPAPER.md:226-233  [narrative]  score 15.04  (5.3 Deep-verification and forced confirmation)

$ node query.mjs -h "how to bake sourdough bread"       # garbage → honest refusal
REFUSED (below-threshold): no indexed source for this query
  query:     "how to bake sourdough bread"
  top score: 1.6709  (threshold 5)
```

All five real queries land on the right primary source; the garbage query refuses.
(These are honest — no cherry-picking; the same 5 canonical calibration queries the
brief named all return sensible pointers.)

## Near-miss ledger (gap telemetry, owner-ruled 2026-07-16)

A refusal whose top score lands in the suspicious band `[3.0, threshold)` is logged
(query + score + the top hit it almost returned) to the gitignored
`test_results/librarian/near_misses.jsonl` — "the catalog almost had this" is a
CORPUS-GAP signal to review in bulk (missing doc? chunking? vocabulary?).
Confident garbage below the floor is not logged. The near-hit lives in the LEDGER
ONLY and is redacted from every response (CLI and MCP) — surfacing an
almost-answer would invite consuming nearest-neighbour garbage, defeating the
refusal posture. Floor override: `LIBRARIAN_NEAR_MISS_FLOOR`. Logging is
best-effort and can never break a query.

## Non-goals (v1)

- **No generation / no answers.** Pointers only. It is a card catalog.
- **No file-watcher daemon.** Ever, on this box. Liveness is git-event-driven only.
- **No cloud calls / no embeddings.** v1 is lexical-only.
- **Not in the app bundle.** LanceDB is native Node-only; tools-lane only.

## Increment 4 — REPORTS corpus (`report_chunks`): DONE (2026-07-17)

A **third corpus** over the project's frozen one-shot docs/research that live
**GITIGNORED next to their run artifacts** under `test_results/**/*.md` — invisible
to `doc_chunks`/`code_chunks` because both are enumerated via `git ls-files`, and
these files carry **no git history at all** (proof failure that motivated this:
`librarian_query "seestar control alpaca"` missed
`test_results/demo_2026-07-24/SEESTAR_CONTROL_API.md` entirely). Same LanceDB
store, new table `report_chunks`; `doc_chunks`/`code_chunks` are untouched and
byte-identical.

**Three filesystem roots** (walked directly with `fs.readdirSync`, NOT
`git ls-files` — two roots are gitignored inside a tracked repo, the third is
outside any repo so there is nothing to `ls-files`):

- `ASTROLOGIC_DEPLOY:` this checkout's `test_results/**/*.md`
- `rest-integration:` the sibling `rest-integration` checkout's `test_results/**/*.md`
  (override root via `LIBRARIAN_REST_INTEGRATION_ROOT`)
- `test_artifacts:` `D:/AstroLogic/test_artifacts/**/*.md`
  (override via `LIBRARIAN_TEST_ARTIFACTS_ROOT`)

A root that doesn't exist on a given box is silently skipped (own-box
heterogeneity, e.g. no `D:` drive). **Hard exclusions:** non-`.md` files, any file
`>1MB`, and directories named `node_modules`/`.git`/`.lancedb`/`decoded`/`seams`/
`wcs`/`logs` (bulk-artifact siblings, pruned before the walk descends).

**Provenance & freshness:** the LanceDB `path` column is a composite
`<rootId>:<relPath>` key (unique across roots — two roots can carry the same
relative path without colliding). Each row also carries `root_id`, `rel_path`,
`abs_path`, and **`mtime`** (ISO, ferried from `fs.statSync`) in place of
`last_commit` — these files have no commits, so `mtime` is the only freshness
signal, and `query.mjs` results/human-output surface it explicitly instead of
silently reusing the (inapplicable) `last_commit` field.

**Build:** **314 files → 2826 chunks** across the three roots (measured
2026-07-17). Chunking reuses `chunkMarkdown` from `lib/corpus.mjs` unchanged.

**Liveness — MANUAL v1, by design, not a shortcut:** `hook_postcommit.mjs` is
UNCHANGED. A commit-driven hook cannot observe a file no commit ever touches (two
roots are gitignored, the third is outside any repo), so there is no git event to
hook. Run `node index_reports.mjs` to reconcile: it does a full filesystem walk
(cheap at this size) then hash-diffs against the stored table — upserts
changed/new files, hash-skips unchanged ones, and deletes rows for files removed
since the last run. `node index_reports.mjs --full` forces a hard drop+recreate
(matches the docs/code `runFull` semantics).

**Authority:** flat `REPORTS_AUTHORITY = 0.85` (class `REPORT`) — frozen one-shot
artifacts are real evidence but uncurated relative to tracked docs, so this sits
below every tracked-docs class (mirrors the code corpus's `TEST` tier logic).

**Query:** `node query.mjs --corpus reports "…"`. `--corpus both` is now a
**THREE-way** fan-out (`docs` + `code` + `reports`, previously two-way), each
still scored/thresholded independently — never a unified cross-corpus score.

### Reports-corpus calibration (honest, documented)

Calibrated on **11 real + 5 garbage** queries against the live 314-file/2826-chunk
corpus (smaller N than the docs/code calibrations — time-boxed v1; revisit if the
corpus grows materially). `REPORTS_DEFAULT_THRESHOLD = 3.4`.

**Real queries** (top-1 scores): `seestar control alpaca native` 18.44 ·
`color research sho hoo palette audit` 27.41 · `dsw crash diagnosis report` 27.48 ·
`archive index test results` 19.21 · `p1 wave typed receipts spec` 19.46 ·
`quad calibration density invariant verifier` 17.37 ·
`gaia migration pressure test overnight` 11.15 ·
`efficiency review pipeline bottleneck` 10.50 ·
`thesis dashboard wrap report` 10.84 ·
`differential solve report generation gap` 8.39 ·
`horsehead narrowband solved receipts` **4.09** (weakest real — see honest miss below).

**Garbage queries** (top-1 scores): `capital of france` 0.00 ·
`quarterly sales tax accounting spreadsheet` 1.47 ·
`how to bake sourdough bread` 2.13 ·
`best hiking trails national park weekend` 2.33 ·
`kubernetes cluster autoscaling` **2.73** (highest garbage).

**Separation:** empty gap `[2.73, 4.09]` — narrower than docs (`[3.89,8.60]`) or
code (`[3.36,9.31]`), honestly, because this corpus is smaller and denser
(2826 chunks over 314 files vs docs' 1177/82). Threshold `3.4` sits near the
gap's midpoint (margin `0.67` to garbage, `0.69` to the weakest real query). All
11 real return results, all 5 garbage refuse.

**Honest miss note:** `horsehead narrowband solved receipts` — the doc that
actually discusses Horsehead Hα (narrowband) frames with fitted-WCS solved
receipts (`quad_calibration_2026-07-17/REPORT.md`) does NOT rank #1 for this
query (rank 4/5 at default `k=5`, score 3.30); its vocabulary ("Ha", "truth
anchored", "fitted WCS") doesn't lexically overlap "narrowband"/"solved" as
tightly as three other docs that mention "Horsehead"/"solved"/"receipt" more
densely but less relevantly. The query still does NOT refuse (top score 4.09
clears 3.4) and the correct doc IS present in the default top-5 — same
pure-lexical-retrieval honesty precedent as the code corpus's documented misses
(README "Code-corpus calibration"): never softened to force a rank, recorded here
as calibration data instead.

## Files

| file | role |
|---|---|
| `index_docs.mjs` | build / incremental-upsert the LanceDB catalog (docs) |
| `index_code.mjs` | build / incremental-upsert the CODE catalog (`code_chunks`) |
| `index_reports.mjs` | build / reconcile the REPORTS catalog (`report_chunks`) — manual liveness |
| `query.mjs` | query CLI + pure `rankChunks` (BM25 + coverage + refusal); routes docs/code/reports/both |
| `hook_postcommit.mjs` | git post-commit/merge driver (canonical-gated; docs+code only — reports is manual) |
| `lib/corpus.mjs` | docs corpus enumeration, chunking, class/authority, hashing |
| `lib/code_corpus.mjs` | code corpus enumeration + comment-prose chunking |
| `lib/reports_corpus.mjs` | reports corpus filesystem walk (3 roots) + chunking + provenance |
| `lib/bm25.mjs` | tokenizer + hand-rolled BM25 (pure, no deps) |
| `librarian.test.mjs` | vitest suite (exclusion, chunking, BM25, refusal, round-trip) |

## Increment 2 — MCP exposure: DONE (2026-07-16)

`librarian_query {query, k?, threshold?}` is live on the stdio MCP server AND the
remote (Access-tunneled) surface — see `tools/mcp/server.mjs` + README. It spawns
`query.mjs` as a child process (native LanceDB isolated from the server), keeps
the pointers-only + refusal-on-garbage contract, and was smoke-tested end-to-end
(stdio round-trip, HTTP bearer round-trip, garbage-refusal negative control).
Liveness hooks (post-commit/post-merge) are installed in the canonical checkout.

## Increment 3 — CODE corpus (`code_chunks`): DONE (2026-07-17)

A **second corpus** over the **prose that lives in the code** — comment banners,
JSDoc, section headers, Rust `///`/`//!` docs — answering concept-phrased code
questions ("where do we correct star flux for vignette") that identifier-grep
cannot. Spec: `docs/CODE_LIBRARIAN_SPEC.md`. Separate LanceDB table `code_chunks`
in the SAME `.lancedb`; the docs catalog (`doc_chunks`) is untouched and
byte-identical. It is **NOT** identifier search, an AST index, or an answer
oracle — same card-catalog posture: pointers only, calibrated refusal.

**Query:** `node query.mjs --corpus code|docs|both "…"` (default `docs`, backward
compatible). `both` runs each corpus with its OWN score/threshold (never a
unified cross-corpus score). MCP `librarian_query` gains an optional
`corpus: "docs"|"code"|"both"` param (additive; docs default preserves callers).

### Corpus membership & chunker

Tracked `src/**` + `tools/**` files with extensions `.ts .tsx .mjs .js .rs
.wgsl`, minus `node_modules`, `@generated` head-scanned files, and — a build
decision — **the librarian's own lane** (`tools/librarian/**`): its test fixtures
embed deliberately-adversarial garbage strings ("how to bake sourdough bread at
home" in `librarian.test.mjs`) that would self-poison the refusal separation.
Build: **961 files → 3517 chunks** (survey projected 3524; deterministic across
rebuilds). Full rebuild ≈ 64 s (dominated by one `git log` per file); incremental
upsert of a commit-sized delta (12 changed files, real delete+add) ≈ **1.3 s**,
well under the 5 s budget. Mass-touch commits fall back to the dirty-list path.

A **chunk** = a contiguous comment run of ≥3 lines OR a ≥2-line ruled banner
block, plus up to 2 following non-blank code lines (the anchored signature —
pulls the documented symbol's identifiers into the chunk text). Banner detection
is **symbol-repetition** based (a comment line whose stripped body is ≥6 chars
with zero ASCII word-chars) — NOT a Unicode box-char class, which would silently
miss the 59 files carrying mojibake (double-encoded `═` → `â•`) banners.
Single-line inline-ruled section headers (`// ── Constants ──`) are NOT
standalone chunks (STRICT boundary) — their titles are harvested into the heading
chain of following chunks. Comment syntaxes `//`, `/* */`, `///`, `//!`;
lint-directive lines are stripped and break a run.

### Authority classes (calibration output)

| class | weight | examples |
|---|---|---|
| `CONTRACT` | 1.25 | `binary_layouts.ts`, `schema_versions.ts`, `pipeline_config.ts`, `src/engine/contracts/**`, `*.apispec.ts`, `*.capturespec.ts` |
| `ENGINE` | 1.10 | `src/**` stage/module/UI code |
| `LANE` | 1.00 | `tools/**` lane code |
| `TEST` | 0.85 | `*.test.*`, `*.spec.*` (apispec/capturespec route to CONTRACT first) |

### Ranking — filename relevance (code only)

`score = (BM25 + heading-boost + fileBoost·filenameMatches) × authority × coverage`

The code corpus adds a **filename-token boost** (`CODE_FILE_BOOST = 2.0`; per
distinct query term found in the file's basename) — standard code-search
practice: "rawler decoder arm" → `rawler_decoder.ts`. It is inside the
coverage-multiplied term, so a filename-only match with zero content coverage
still scores 0 (no false routing). `fileBoost` defaults to **0** for the docs
corpus, which makes the docs ranker **byte-identical to v1** (verified by diff and
a unit test). BM25 (`b=0.75`) and heading-boost (`1.6`) are unchanged/shared.

### Code-corpus calibration (honest, documented)

Calibrated on the prep set: **15 real** + **3 garbage** queries
(`test_results/code_librarian_prep_2026-07-17/calibration_set.json`,
ground-truth `answer_path:lines` verified by code reading).
`CODE_DEFAULT_THRESHOLD = 5.0`.

**Refusal separation (the primary deliverable — CLEAN):** all 15 real queries'
top-1 scores ≥ **9.31**; all 3 garbage top-1 ≤ **3.36** (`sourdough 3.36 ·
kubernetes 3.01 · capital-of-France 0.00`). Empty gap **[3.36, 9.31]**;
threshold 5.0 sits in it (margin 1.64 to garbage, 4.31 to the weakest real). All
15 real return results, all 3 garbage refuse.

**Top-3 recall (honest, below the ≥13/15 target):** **strict answer_path in
top-3 = 9/15** (top-1 = 5/15); including the calibration's OWN verified
alternative homes (`also_at`) = **10/15**.

| # | query | want (answer_path) | top-1 result | rank |
|--:|---|---|---|:--:|
| 0 | correct star flux for vignette | psf_field.ts | pipeline_config.ts `[CONTRACT]` | **MISS** |
| 1 | one-warp-max render rule | ImageProcessor.ts | sip_render_warp.test.ts | 2 |
| 2 | RA hours vs degrees boundary | fits_io.mjs | star_catalog_adapter.ts | **MISS** |
| 3 | ambiguous libraw mem_image dims | decode_cr2.mjs | format_registry.ts | **MISS** |
| 4 | UW blind solve budget | solver_entry.ts | solver_entry.ts | 1 |
| 5 | lens EXIF untrusted | lens_distortion.ts | lens_distortion.ts | 1 |
| 6 | receipt schema versions bumped | schema_versions.ts | schema_versions.ts | 1 |
| 7 | forced photometry set gate | forced_confirm.ts | ForcedPhotometryZWidget.tsx | **MISS** |
| 8 | step-1 re-entry forbidden | orchestrator_session.ts | orchestrator_session.ts | 1 |
| 9 | hybrid atlas row discriminated | star_catalog_adapter.ts | standard_stars.ts | **MISS** |
| 10 | api harness run serial | api_harness.config.ts | api_smoke.mjs | 3 |
| 11 | rawler vs libraw decoder arm | rawler_decoder.ts | metadata_reaper.ts | 3 |
| 12 | stacker WCS never fed to FITS writer | fits_io.mjs | fits_io.mjs | 1 |
| 13 | X-Trans routed to libraw | format_registry.ts | metadata_reaper.ts | 3 |
| 14 | dominant-channel decoded mosaic | decode_cr2.mjs | demosaic_reference.mjs | **MISS** |

**Honest miss analysis (calibration data, not hidden):** the 6 strict misses are
genuine hard cases, not a fixable ranking bug — softening the coverage penalty
does lift recall to ~10/15 but reopens the garbage gap, so it was rejected (LAW 2:
never weaken the refusal to pass a recall number). By type:
- **A higher-authority / primary sibling legitimately wins (#0, #11, #13).** #0's
  top-1 is `pipeline_config.ts` — an explicit `also_at`, and the calibration note
  itself says "the CONTRACT flag doc should outrank the ENGINE prose." #11's is
  `metadata_reaper.ts`, the actual decoder-arm branch (also an `also_at`). The
  ranker is arguably *correct*; the ground-truth is a secondary home.
- **Conceptual vocabulary the terse comment doesn't contain (#9).** Query says
  "hybrid / atlas / discriminated"; the code says "Gaia-format / HYG / catalog."
  No lexical retriever bridges that without stemming-beyond-morphology (tested;
  it does not help and widens garbage matches).
- **The answer lives partly in code, not comments (#2, #3, #14).** These files'
  banners compete with other legitimately-decode/RA-related banners; the
  distinguishing prose is thin or sits in string literals/identifiers a
  comment-prose librarian does not index by design.
- **Display widget outranks logic (#7).** `ForcedPhotometryZWidget.tsx` matches
  "forced photometry … confirmation" densely; UI-demotion was tested and did not
  flip it (other siblings still win).

Bottom line: the instrument's **refusal is honest and clean** (its core LAW-3
job), and it points to a *correct* file (answer or verified `also_at`) for 10/15
of a deliberately adversarial concept-query set; the strict 9/15 is the measured
reality of pure-lexical retrieval over terse code comments, recorded here as
calibration data. Override any query with `--threshold X`.

## Future directions (external feedback triaged 2026-07-16 — reviewed, NOT scheduled)

Kept — aligned with standing rulings, in rough leverage order:

1. **Receipt explainer ("explain my solve").** Pair librarian pointers with ONE
   specific receipt so an agent can explain a solve/refusal — e.g. why the trust
   ladder overrode a lying 50 mm EXIF — citing BOTH receipt fields and doc lines.
   Grounding rule (LAW 3): every claim in the explanation cites a receipt field or
   an indexed doc line; no free-form physics prose. Natural fit for the desktop
   app + the processing-packet deliverable.
2. **DAG/flowchart node lookup.** The interactive-DAG program (dag.skycruncher.io)
   calls `librarian_query` per node — click a stage, get its doc pointers. Cheap:
   rides the existing MCP tool, no new machinery.
3. **Workbench "why" tracing.** Answer "why was my lens profile demoted?" from the
   Optical Workbench deposit/ladder records + docs — same card-catalog contract,
   grounded in recorded ladder reasons, never reconstructed logic.
4. **Increment 3 candidate — code-symbol index.** Extend the corpus from docs to
   src/tools code at function/symbol granularity (shader + Rust boundaries
   included), LEXICAL FIRST. Requires its own threshold calibration (code tokens
   ≠ prose tokens). Embeddings (fill the `vector` column + ANN) remain a separate
   later increment, gated on a MEASURED lexical-retrieval failure, not vibes.

Discarded — with reasons, so it stays discarded:

- **File-watcher live-sync re-embedding**: rejected twice already (standing
  no-watcher-daemon ruling: chokidar × junctioned-worktree trap + daemon-leak
  incidents). Git-event liveness is the chosen design; it is proven firing.
- **Embeddings-by-default rewrite**: v1 lexical BM25+coverage meets the measured
  need with an honest refusal gap; native/embedding complexity needs evidence.
- **Auto-generated "self-healing" physics explanations** not grounded in receipts:
  violates honest-or-absent. (The feedback's own motivating example — a
  "wrong-signed k1" on the Rokinon — is factually stale: that sign conflict was a
  tangent-point reference artifact, corrected 2026-07-10; the nominal profile was
  approximately right. Exactly why ungrounded explanation is dangerous.)
