---
trigger: always_on
---

SkyCruncher Architectural Adherence and Provenance Ruleset
(Corrected 2026-07-10, owner-approved: the prior version falsely claimed a "strict FSM" and an M1–M9 module cap. Evidence + decision record: test_results/ultracode_2026-07-10/ARCHITECTURE_RECONCILIATION.md.)

VOCABULARY — three distinct axes; never conflate them:
- **10 module directories** (`src/engine/pipeline/m1_*..m10_*`) — code organization.
- **~11 runtime stages** (`stages/*`, dispatched by `orchestrator_session.ts`) — execution order; authoritative walk in `docs/01-canonical/processing_flow.md`.
- **17 data-provenance domains** (enum taxonomy, architecture doc Appendix A.0) — lineage recording in receipts/capture records.

*****WE MAY ADD OR SPLIT MODULES AND ENUMS AT ANY TIME. IF YOU ENCOUNTER A NEW MODULE OR ENUM NOT LISTED HERE, ASSUME IT IS VALID. RECOMMEND NEW MODULES/ENUMS YOU THINK SHOULD EXIST.*****

1. Mandatory Module Tagging
Before planning, implementing, or modifying code, declare the module(s) your work impacts. Current modules (M1 through **M10**):

[M1: RAW Decoding/Ingestion] (m1_ingestion)
[M2: Hardware Profiling] (m2_hardware)
[M3: GPU Pre-Processing] (m3_gpu_preprocess)
[M4: Signal Detection] (m4_signal_detect)
[M5: Coordinate Flattening] (m5_coordinate_flatten)
[M6: Plate Solving] (m6_plate_solve)
[M7: Astrometric Refinement] (m7_astrometry)
[M8: Photometric Calibration] (m8_photometry)
[M9: Serialization & Export] (m9_export)
[M10: PSF Characterization] (m10_psf)

Commit tag format: `[Module: X]` (X may also be a lane name, e.g. Docs, tools, rawlab).

2. Provenance Recording (honest, not aspirational)
Data transitions ARE RECORDED via the provenance enums in receipts and capture records. Record states honestly; NEVER fabricate a state or claim a transition that did not execute (LAW 3). When your change moves data across a provenance boundary, note the affected enums and state change in your implementation notes ([Domain: EnumName] {A} -> {B}).

3. Execution Model — the honest statement
The pipeline is an **externally-sequenced step-runner**: ordering is enforced by the session/React callers, and the observable state stream is the PipelineEventBus. It is **NOT a strict FSM today** — there is no transition table, and no machine validates sequential maturity at runtime. Do not claim FSM behavior in code, comments, docs, or commit messages. Do not halt work over "FSM violations"; enforce ordering the way the code actually does (caller sequence + stage contracts + gates).

4. FSM STUB — revisit after codebase cleanup (owner directive 2026-07-10)
The FSM idea is not dead; it is re-founded on evidence when we're ready: a formal **provenance state-transition contract** (generative table, LAW-7 style, versioned in `src/engine/contracts/`) plus **mechanical conformance checking** of recorded transitions in capture records/receipts — validation layer first; runtime enforcement only as a later, separately-gated wave. Until that lands, all transition-validation language from this file's predecessor is void.
