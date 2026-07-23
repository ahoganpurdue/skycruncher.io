<!-- LEDGER · owner-decision docket maintenance · hand (orchestrator-editorial) — future: mech regen -->
# Owner-decision docket — maintenance

`test_results/theses/dashboard/owner_decisions.json` is an **EDITORIAL LEDGER**, not generated
output. Like `docs/AGENT_TIMING_LOG.md`, the orchestrator updates it by hand **at each relay**:
when an owner decision is asked, ruled, superseded, or its blocking surface changes, edit the
JSON in the same breath as the relay message. `generated_at` = time of last curation pass.
A future mechanical generator may replace the hand pass; until then this file is the contract.

## Update rules
- OWNER decisions only — never orchestrator to-dos. Every entry cites a real repo-relative doc.
- `recommendation` is null unless a recommendation exists ON RECORD in the cited source
  (never invent one at curation time).
- Ruled items are DELETED, not state-flipped — the registry/wrap reports are the record of
  rulings; this file is only the live docket.
- Contract (renderer depends on exact shape): `id` (D-slug), `title`, `category`
  (`ruling|supply|sign-off|review`), `state` (`OPEN|BLOCKED|ANSWER-PENDING`), `asked_on`,
  `blocking` (one line), `summary` (2-3 sentences, owner register, honest), `source`,
  `recommendation` (line or null).

## Implementation lifecycle (additive `implementation` field)
A **ruled** decision (terminal `state`, i.e. it has left the docket via a WRAP/registry
ruling) may carry an additive object so the owner can see, on the Decisions tab, what was
DECIDED but not yet BUILT:
```
"implementation": {
  "status":   "implemented" | "pending" | "owner-side" | "obsolete",
  "evidence": "<commit hash / artifact path / one-liner>",
  "updated":  "YYYY-MM-DD"
}
```
- `implemented` — shipped; `evidence` cites the commit/artifact (renderer shows it in the chip tooltip).
- `pending` — ruled, not built yet. **Absence of the whole field is treated identically** — a
  ruled decision with no `implementation` renders as *awaiting implementation*, NEVER as
  implemented (honest-or-absent, LAW 3). Never omit the field to imply "done".
- `owner-side` — ruled; the remaining step is the owner's, not the orchestrator's.
- `obsolete` — ruled but overtaken; renders dimmed.

Renderer buckets (Decisions tab): the resolved pool splits into **Ruled — awaiting
implementation** (`pending` OR field absent), **Owner-side**, **Implemented**, and
**Obsolete** (dimmed). The group header carries a rollup summary
(e.g. `25 ruled: 18 implemented · 5 awaiting · 2 owner-side`). Sub-tier `children[]` entries
carry their OWN `implementation` field; a parent's rollup shows child counts but a parent's
status is its own field only — **never auto-inferred from its children**. Same hand-curation
discipline as the rest of this file: set/refresh `implementation.updated` in the same breath
as the relay that changes build state. (Ruled items are still eventually DELETED per the
Update rules above; `implementation` is the tracking surface while they linger post-ruling.)

## Source docs to re-walk on a full refresh (freshness pass — verify, drop ruled)
1. `test_results/session_wrap_<latest>/WRAP_REPORT.md` §6 (the ranked morning packet).
2. `CLAUDE.md` — OWNER-CONFIRM NAG LIST + OWNER-DECISION QUEUE / frontier sections.
3. `docs/NEXT_MOVES.md` §0 (live queue; confirms which rulings LANDED — the drop list).
4. `test_results/owner_proxy_*/ADJUDICATION_PACKAGE.md` (scorecards awaiting CONFIRM/OVERTURN/MODIFY).
5. `test_results/pm_fables_*/` + wrap §6 item 4 (proxy question batches, V-numbered).
6. Any measurement artifact with a blank OWNER SIGN-OFF block (e.g.
   `test_results/recal_sweep_*/RECAL_TABLE.md`).
7. `docs/INDEX.md` (archive-candidate approvals; also the code-authoritative card rule).
8. Live thesis/decoder state (`test_results/theses/registry.jsonl`,
   `test_results/decoder_*/`) — decisions here supersede fast; verify verdicts before carrying.
9. Memory: session-close agenda + owner nag protocol (owner-parked items surface at wrap only).
