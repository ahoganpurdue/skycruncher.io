<!-- CANONICAL/POLICY · documentation structure + lifecycle + linking + citation rules · ADVISORY until owner approval, binding after · created 2026-07-11 (meta-doc wave) · owner: ahogan -->
# Documentation Policy — structure, lifecycle, linking, citation

**Status: ADVISORY.** This policy describes the documentation system as it actually operates and
proposes the smallest set of hard rules that keep it honest. It becomes **binding on owner
approval**; until then it changes nothing by itself. Companion surfaces: [`docs/00-README-STRUCTURE.md`](../00-README-STRUCTURE.md)
(the folder scheme + public/local litmus + hold-list — authoritative for WHERE files live) and [`docs/INDEX.md`](../INDEX.md)
(the per-file discovery table). This file is authoritative for LIFECYCLE, LINKING,
and CITATION rules.

Design stance: **fewer, harder rules beat many soft ones.** Everything below is either a hard rule
(numbered) or a described convention (prose). Hard rules are the ones whose violation has already
cost solves, data, or owner time at least once.

---

## 1. The taxonomy as it actually is

Nine tiers exist today. The folder scheme, hold-list, and numbered-prefix rationale are specified in
[`docs/00-README-STRUCTURE.md`](../00-README-STRUCTURE.md) — not repeated here. The tier table below adds the two columns that
file cares less about: what each tier is FOR and which authority class it carries under the
staleness protocol (§5).

| Tier | Home | For | Authority class |
|---|---|---|---|
| CANONICAL / POLICY | `docs/01-canonical/` (+ held root docs) | foundational rules, methodology, architecture-as-is | docs-authoritative (LAWS/specs) |
| SPEC / PLAN | `docs/02-specs/` (+ held root specs) | designs being built; intent, not state | docs-authoritative for the DESIGN; any embedded status line is code-authoritative |
| LEDGER | `docs/03-ledgers/` (reserved; members held at root: [GATES](../GATES.md), [AGENT_TIMING_LOG](../AGENT_TIMING_LOG.md), [COMPAT_MATRIX](../COMPAT_MATRIX.md), …) | append-mostly measured records | code-authoritative (regenerate/append, never hand-edit history) |
| RESEARCH | `docs/04-research/` | durable, public, methodology-grade findings | code-authoritative for claims about the repo; frozen otherwise |
| REFERENCE | `docs/reference/` | lookup material: algorithm cards (`CARD_*.md`, code-globbed), perf notes | docs-authoritative for math; regenerate on formula changes |
| ARCHIVE | `docs/archive/` | frozen one-shot audits/tombstones — records, not guidance | frozen: never edited, only bannered (§3) |
| LOCAL | `docs/local/` (gitignored) | strategy, events, grants, owner-voice — never ships | owner-only; agents never untrack |
| MEMORY | `~/.claude/projects/<project>/memory/` | orchestrator session-to-session working memory | not documentation — no tracked doc may depend on it (§4) |
| DASHBOARD FEEDS | `test_results/theses/dashboard/` (+ `tools/theses/dashboard/publish_docs.mjs` curation) | machine feeds: owner decisions, work items, published-doc snapshots | code-authoritative; curated by the orchestrator, ruled by the owner |

Dated run output (`test_results/YYYY-MM-DD_topic/`) is scratch evidence, not a tier — durable pieces
get PROMOTED out of it (§2), originals stay in place as evidence.

## 2. Lifecycle — where a doc is born, and the three graduation rules

**Birth:** apply the public/local litmus FIRST ([`00-README-STRUCTURE.md`](../00-README-STRUCTURE.md) §3 — one line:
*helps a stranger build or trust the instrument → public; reveals strategy, contacts, money,
calendar → local; IN DOUBT → LOCAL*). Then pick the tier by what the doc IS (rules → 01, design →
02, measured record → ledger, findings → 04/local, lookup → reference). New tracked docs get a
one-line row in `docs/INDEX.md` and a first-line HTML header comment carrying class · revision
trigger · owner (the standing convention visible on every tracked doc).

**HARD RULE 1 — the graduation chain is one-directional and explicit:**
- **ROADMAP → NEXT_MOVES:** roadmap items are IDEAS. The moment an item becomes an executable
  commitment it graduates to [`NEXT_MOVES.md`](../NEXT_MOVES.md) §0 and OUT of ROADMAP (already the standing rule,
  [`ROADMAP.md:4`](../ROADMAP.md)). No item lives in both as a commitment.
- **NEXT_MOVES → history:** completed work graduates to git history + the Architecture appendix
  (the "GRADUATED" pattern, e.g. `ROADMAP.md:10`); docs keep at most a dated pointer.
- **test_results → docs:** promotion copies the durable piece to `docs/04-research/` (public) or
  `docs/local/` (local); the dated original stays as evidence; anything swept off K: gets an
  `test_results/ARCHIVE_INDEX.md` row.

**Archive trigger:** a one-shot audit/design is DONE and no longer steers work → `docs/archive/`
with its header comment marking it frozen. Archive docs are never revised — a superseded archive doc
gets a one-line banner pointing at the successor, nothing else.

## 3. Honesty conventions carried into docs

- **Honest-or-absent applies to docs** exactly as to UI (LAW 3): no aspirational claims dressed as
  state. Unbuilt = "NOT BUILT", unmeasured = "NOT MEASURED", stale-but-kept = dated record.
- **Document drift is a bug** ([`ROADMAP.md`](../ROADMAP.md) operating discipline #4) — fixing a stale status claim
  requires citing the evidence (commit SHA / code path) in the fix's commit message.
- **Plain language** (owner ruling 2026-07-11): no AI-proprietary jargon in docs. Banned example:
  "ceremony" — write *procedure*, *gated swap*, *rebaseline pass*. Boring standard terms win.
- **"Canonical", never "canon"** (Canon-camera collision — standing rule, CLAUDE.md).
- **Rendering-tech rule** (owner ruling `D-webgpu-default`, 2026-07-11): new widgets and
  dashboard items are **WebGPU where it makes sense**; when a call splits between WebGPU and
  WebGL, prefer WebGPU; a WebGL choice ships only with a **documented why** in the owning
  spec/widget doc (the ratified WebGL2 cascade tier in `WEBGPU_RENDER_PLAN.md` §6.3/§7.5 is
  the template). DOM/SVG remains fine for non-GPU surfaces.
- **Stub discipline** (owner grant 2026-07-11): a stub reference card is honest only if it carries
  an explicit `**STUB — NOT YET WRITTEN**` marker with its creation date and a concrete fill
  trigger. A stub that could be mistaken for reference material is a LAW-3 violation. Every stub is
  a recorded debt (§8).

## 4. Linking policy (codifies the 2026-07-11 vault-linking wave)

**HARD RULE 2 — the Related footer:** every tracked doc ends with a `## Related` section: markdown
relative links, each with an em-dash one-line reason stating the actual relationship
("— the gate numbers this doc's tests feed", not "— see also"). Evidence-based: link only docs with
a real dependency, feed, or sibling relationship. New docs ship with the footer; the wave that
linked 64 docs (islands 70→1, commit `971c8e5`) is the reference implementation.

**HARD RULE 3 — tracked docs never link `docs/local/` or memory files.** Both are gitignored: the
link breaks in every clone, and a local-tier path in a public doc leaks the existence and shape of
strategy material. Where the relationship matters, use a *pointer by name only* ("ledger:
`COLOR_SWEEP_ADDON_LEDGER.md`, local, pointer only" — the standing ROADMAP pattern). The same rule
applies to `test_results/` paths in any doc that ships publicly: name + date, not a clickable
promise.

In-body path references are part of the contract: a moved/renamed doc updates its referrers in the
same commit and proves zero dangling ([`00-README-STRUCTURE.md`](../00-README-STRUCTURE.md) §5). Historical ledger rows citing
old paths are commit-anchored records and are never rewritten.

## 5. Citation rules — numbers are never hand-copied

**HARD RULE 4 — single sources for load-bearing numbers:**

| Number | Sole source | Cite as |
|---|---|---|
| Gate/regression counts (tsc, vitest, api smoke) | [`docs/GATES.md`](../GATES.md) (machine-regenerated by `node tools/gates/check_gates.mjs`) | "see GATES.md" or a dated record "N as of <date> @<sha>" |
| Receipt schema version | `RECEIPT_SCHEMA_VERSION` in `src/engine/pipeline/stages/schema_versions.ts` | cite the const, never the value as current |
| Thesis schema + verdicts | `THESIS_SCHEMA_VERSION` in `tools/theses/thesis_schema.ts`; hash-chained registry `test_results/theses/registry.jsonl` | cite const / registry id |
| Pinned reference solves | CLAUDE.md "PINNED REFERENCE SOLVES" section | never restate the digits elsewhere as current |
| Surface versions | the unified version manifest (`versions` module) | cite the manifest |
| Owner rulings | `test_results/theses/dashboard/owner_decisions.json` (+ `owner_responses.jsonl`) | cite the decision id (e.g. `D-clockdrive-name`) |

An undated copied number that can drift IS rot. A dated number with its commit is a record and is
fine. Agent timing estimates are calibrated numbers (CLAUDE.md, recal 2026-07-11) — same rule.

**Staleness protocol** (memory: staleness-tag-protocol; restated here so the tracked tree carries
it): drift gets tagged one of **NONE / code→docs / docs→code / docs+code**. LAWS and specs are
**docs-authoritative** — code contradicting them is the bug, and a doc-vs-LAW conflict is FLAGGED
to the owner, never silently rewritten. Status lines and ledgers are **code-authoritative** — a
stale status claim is corrected against code/git evidence with the commit cited.

## 6. Clockdrive — the orchestration system, named

**Clockdrive** (owner ruling `D-clockdrive-name`, 2026-07-11) is the name of this project's AI
orchestration system: the live orchestrator, the worktree-isolated agent waves and their profiles,
the gate battery discipline, the ledgers (`agent_runs.jsonl`, `AGENT_TIMING_LOG.md`, the timing/
estimate calibration), the owner dashboard + decision feeds, and the hook layer that wires them.
Named for the telescope mount's clock drive — the deterministic motor that keeps the instrument
tracking the sky unattended. No AI mystique: it is machinery with receipts.

Scope boundary: **Clockdrive is the build system, not the instrument.** The plate-solver product
keeps its own (pivoting) name; Clockdrive names how the software is BUILT and operated. Where it
applies: docs and the whitepaper may say "Clockdrive" for the orchestration system from now on;
dashboard labels and any remaining "the orchestration system"/"agentic ops" phrasings converge in
**one uniform label pass, never piecemeal** (same discipline as the LAW-6 brand rename). The
system-of-record doc for Clockdrive's shape is `docs/OPERATIONS_MAP.md`; CLAUDE.md's ORCHESTRATION
section remains the operating rulebook. Remaining standardization work is tracked as a ROADMAP item
(tagged, this wave).

## 7. Dashboard feeds and the documents tab

`tools/theses/dashboard/publish_docs.mjs` publishes curated docs to the owner dashboard with a
`category` field mirroring the folder scheme (`canonical / plan / research / ledger /
session-report`; reference cards = `reference`). Work items (`work_items.json`) carry an explicit
`tags:[]` using the shared dashboard vocabulary — **CSL, Project Management, Solver, Deconvolution,
Color, Access, Testing, Infra, Atlas/Data, Release, UI/Dashboard** — with an auto-tag heuristic as
fallback (`ui/app.js` `TAG_VOCAB`/`AUTO_TAG_RULES`). Docs that want deliberate grouping carry
explicit tags in their header comment (the reference cards do, as of this wave); everything else
may rely on the heuristic. The vocabulary is the dashboard's — extend it there first, docs follow.

## 8. Known debts (rot-sweep appendix, 2026-07-11)

Applied fixes from this wave are cited in their commit messages (branch `worktree-agent-ad64b668284f8e43c`).
Open items — owner/orchestrator triage, this wave deliberately did NOT touch them:

- **[INDEX.md](../INDEX.md) row for this file + the new stub card** — INDEX.md held by an unmerged branch; the
  orchestrator adds the rows at merge.
- **GRANT_LANDSCAPE.md duplicate**: lives in BOTH `docs/local/` (15.5 KB, curated) and
  `test_results/grants_2026-07-11/` (14.8 KB, run artifact). Recommended single home:
  **`docs/local/`** (strategy-tier per the litmus); the test_results copy stays only as the dated
  run's evidence per §2 — if the two have diverged, docs/local wins and the run copy gets a
  one-line "superseded by docs/local" banner (owner call, since docs/local is owner-tier).
- **`docs/archive/` is two populations** and the docs describe it inconsistently: the directory is
  in `.gitignore`, but ~10 archive docs are grandfathered TRACKED members (they took Related
  footers in `971c8e5` and need `git add -f` to re-stage), while others were genuinely local-only
  and are now GONE from disk (`LAZARUS_REVILL/PROCESSING_FLOW_AUDIT/processing_flow_v2026-02-26.md`
  — this wave annotated their in-prose referrers "local archive, no longer on disk"). CLAUDE.md's
  "gitignored under docs/archive/" and 00-README-STRUCTURE's "gitignored-but-tracked" each capture
  half. Recommend: an owner/orchestrator ruling on ONE archive regime (track everything frozen, or
  local-only with an index), then a one-line CLAUDE.md wording fix (orchestrator-only file).
- **CLAUDE.md internal contradiction (routing table)**: the "Headless API / Toolchest" row still
  says "FITS lane only (CR2/RAW out of scope)" while the PINNED REFERENCE SOLVES section and
  `tools/api/headless_driver.ts:13` ("Scope: FITS **and** CR2/RAW", @8b57464/@1753e96) say the CR2
  headless lane is a standing pinned gate. Recommend orchestrator fix (file is orchestrator-only).
- **[WHITEPAPER](../WHITEPAPER.md) rawler narrative**: this wave added currency notes (§1/§2.2/§4.3) marking libraw as
  cold path, but the paper still has no section DESCRIBING the rawler default arm. Owner-tier
  writing task; pairs with the Clockdrive label pass.
- **Archive dead pointers, frozen files (flag-only)**: `docs/archive/SOLVER_TOOLSET.md:12,13,36,37`
  cites `docs/CR2_SOLVER_FINDINGS.md` (actual home `docs/archive/…`) and the vanished
  `LAZARUS_REVIVAL.md` ×3. Frozen record — recommend a one-line top banner naming the successors
  rather than body edits.
- **Clockdrive label pass** — whitepaper + dashboard labels still say generic "orchestration"
  phrasing; single uniform pass pending ([ROADMAP](../ROADMAP.md) item, tagged this wave). The dashboard fixture
  `tools/theses/dashboard/ui/fixture/work_items.json:19,52` also carries the banned term
  "ceremony" (plain-language rule) — dashboard tree untouchable for doc waves, fold into the same
  label pass.
- **Code debts spotted in passing (for a future surgeon, not doc fixes)**:
  `src/engine/pipeline/shaders/unified_calibration.wgsl` is consumed ONLY by `tools/renderlab`
  (a src-tree shader owned by a tools lane — LAW-4 two-places smell);
  `core/WebGPUContext.ts:79-101` carries a dead ONNX monkeypatch (ONNX deleted 2026-07-06).
  Also owner-pending: the WebGL2 middle tier migrate-vs-ratify decision (`WEBGPU_RENDER_PLAN.md`
  §6.3 vs §7.5, reconciled this wave to state both honestly).
- **Stub cards created this wave** (each honest-marked per §3): `docs/reference/CARD_STACKING_DRIZZLE.md`
  (tags: Solver, Infra) — fill trigger: Phase K in-app port (LAW-4 incubator→engine) or the next
  `tools/stack/` algorithm change. (Sole stub — the other candidate domain, distortion models, is
  already covered inside CARD_ASTROMETRY_WCS.)
- Cluster-specific stale-claim fixes from the rot sweep: see the per-cluster commit messages of
  this wave (the sweep ledger) — CANONICAL @59bce43, SPECS @a222c3c, ROOT+REFERENCE @986d832,
  cards+stub @0219f88.

## Related
- [00-README-STRUCTURE.md](../00-README-STRUCTURE.md) — the folder scheme, public/local litmus, and hold-list this policy builds on
- [INDEX.md](../INDEX.md) — the per-file discovery table every new tracked doc registers in
- [GATES.md](../GATES.md) — the machine-regenerated single source this policy's citation rules protect
- [OPERATIONS_MAP.md](../OPERATIONS_MAP.md) — the system-of-record for Clockdrive's shape (§6)
- [ROADMAP.md](../ROADMAP.md) — carries the idea-tier and the graduation rule this policy hardens (§2)
- [SkyCruncher_Architecture.md](SkyCruncher_Architecture.md) — the what-IS record that completed work graduates into
