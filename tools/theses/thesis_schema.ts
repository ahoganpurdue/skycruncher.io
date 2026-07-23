// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/thesis_schema.ts — CSL THESIS FRAMEWORK v0 · declarative schema
// ═══════════════════════════════════════════════════════════════════════════
//
// The single, versioned, declarative shape of a Community Science Laboratory
// thesis (docs/COMMUNITY_SCIENCE_LAB.md). "The declarative schema IS the gate"
// (CSL interlocutor design): a hypothesis that cannot be expressed in
// hypothesis / equations-variables / domain-strata / frozen-criteria /
// derivative-corollaries / kill-clause CANNOT be submitted, and the mechanical
// grader (tools/theses/thesis_lint.mjs) refuses it with cited reasons.
//
// EPISTEMOLOGICAL FRAME (owner, 2026-07-10): *Bernoulli's Fallacy* is the
// governing text — a claim is never judged by P(data | hypothesis) alone. Base
// rates are explicit and STRATIFIED (base_rates_domain); domain of validity is a
// MANDATORY field; cross-stratum reconciliation is required; derivative
// predictions are the Bayesian consistency check ("for this to hold, what else
// must be true?"). Pre-registration freezes the test design BEFORE data access.
//
// SINGLE SOURCE FOR THE VERSION: THESIS_SCHEMA_VERSION lives HERE and nowhere
// else. The dep-free Node graders (thesis_lint.mjs / registry.mjs) regex-read
// this constant from this file (the same idiom tools/mcp/instrument_manifest.mjs
// uses to read RECEIPT_SCHEMA_VERSION), so the number is never duplicated.
//
// This module is type-only + one const (no runtime deps, browser-safe): the
// Toolchest API and a future UI can import the shape directly; tsc is its
// compile gate.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema generation. Bump on any change to the thesis shape. Additive field
 * additions are a PATCH/MINOR; a breaking reshape is a MAJOR (old theses must
 * remain re-runnable forever — the DDIA read-compat obligation at the platform
 * layer). A submitted thesis declares its own `schema_version`; the linter warns
 * on a mismatch with this current constant (unknown future versions are refused).
 *
 * 0.2.0 (2026-07-10, ADDITIVE — owner-confirmed AI-thesis pipeline is ACTIVE):
 * adds `submitter_class` (submitter provenance — AI-RESEARCHER never pools with
 * HUMAN in any aggregate; base-rate integrity, Bernoulli discipline) and
 * `time_budget` (declared run cost + lane). Both are REQUIRED going forward
 * (schema_version >= 0.2.0); their ABSENCE marks a legacy 0.1.0 entry, which
 * stays valid forever (DDIA read-compat: the reader accepts 0.1.0 AND 0.2.0). No
 * existing field changed — a pure MINOR bump.
 */
export const THESIS_SCHEMA_VERSION = '0.2.0';

/**
 * The set of schema generations the graders still ACCEPT (the DDIA read-compat
 * window). Every generation from the oldest supported up to THESIS_SCHEMA_VERSION
 * appears here — a version outside this set is an unknown generation and is
 * REFUSED. The dep-free Node linter keeps its own copy in sync via this file's
 * text (single source), the same regex idiom used for THESIS_SCHEMA_VERSION.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ['0.1.0', '0.2.0'];

/** Lifecycle status of a thesis. PRE-REGISTERED is the only registration-time
 *  status; RUNNING/PASS/FAIL/PARTIAL are reached ONLY via append-only stamps. */
export type ThesisStatus = 'PRE-REGISTERED' | 'RUNNING' | 'PASS' | 'FAIL' | 'PARTIAL';
export const THESIS_STATUSES: readonly ThesisStatus[] = ['PRE-REGISTERED', 'RUNNING', 'PASS', 'FAIL', 'PARTIAL'];

/** The statuses a stamp may transition a thesis TO (never back to PRE-REGISTERED). */
export type StampStatus = 'RUNNING' | 'PASS' | 'FAIL' | 'PARTIAL';
export const STAMP_STATUSES: readonly StampStatus[] = ['RUNNING', 'PASS', 'FAIL', 'PARTIAL'];

/** Coarse stage of the work (mirrors the honest status ladder, project-local). */
export type ThesisStage =
    | 'instrument-internal'   // stage-0 dogfood (an internal thesis about the instrument itself)
    | 'speculative'           // proposed, not yet frozen for test
    | 'pre-registered'        // criteria frozen, awaiting the run
    | 'tested'                // run on own images + representative sample
    | 'graduated';            // scored on holdout, promoted

/**
 * Submitter provenance class (schema >= 0.2.0). The population a thesis belongs
 * to for base-rate accounting. AI-RESEARCHER submissions are NEVER pooled with
 * HUMAN submissions in any aggregate the tools compute — the two populations
 * carry different base rates and blind-pooling them corrupts the significance
 * math (Bernoulli discipline; owner ruling 2026-07-10). HYBRID-INTERLOCUTOR is
 * an AI+human co-developed thesis (kept in its own bucket, never folded into
 * either pure population).
 */
export type SubmitterClass = 'AI-RESEARCHER' | 'HUMAN' | 'HYBRID-INTERLOCUTOR';
export const SUBMITTER_CLASSES: readonly SubmitterClass[] = ['AI-RESEARCHER', 'HUMAN', 'HYBRID-INTERLOCUTOR'];

/** The execution lane a thesis run is budgeted for (schema >= 0.2.0). */
export type TimeBudgetLane = 'inline' | 'overnight';
export const TIME_BUDGET_LANES: readonly TimeBudgetLane[] = ['inline', 'overnight'];

/**
 * Declared time budget for the run (schema >= 0.2.0). `est_wall_minutes` is the
 * submitter's honest wall-clock estimate (> 0) — it feeds lane scheduling and,
 * for AI-bucket entries, the est-vs-actual telemetry that shapes the CSL.
 */
export interface TimeBudget {
    /** Estimated wall-clock minutes for one run (> 0). */
    est_wall_minutes: number;
    /** Which lane the run is scheduled on. */
    lane: TimeBudgetLane;
}

/**
 * One equation / variable in the thesis's mechanism. `frozen` marks a quantity
 * that is pre-registered and MUST NOT move (e.g. a calibrated gate the thesis
 * commits to leaving untouched); a non-frozen variable is a free parameter the
 * run is allowed to derive.
 */
export interface EquationVariable {
    /** Symbol or short name, e.g. "K", "SOLVER_UW_SWEEP_MIN_Z". */
    name: string;
    /** What it is / how it is computed. */
    definition: string;
    /** Physical units, or "dimensionless" / "count" / "σ" — never omitted. */
    units: string;
    /** true = pre-registered & immovable; false = free parameter the run derives. */
    frozen: boolean;
}

/** A prior-art citation. `source` names the citation KIND; `ref` locates it. */
export interface PriorArtCitation {
    /** 'file' (repo path), 'card' (docs/reference/CARD_*.md), 'url' (arxiv/etc.),
     *  or 'card-absent' (an explicit, honest statement that no card covers this). */
    source: 'file' | 'card' | 'url' | 'card-absent';
    /** The pointer: a repo path, a CARD id, a URL, or a CARD-ABSENT justification. */
    ref: string;
    /** The specific claim this citation supports or contradicts. */
    claim: string;
}

/**
 * Base-rate / domain structure (the Bernoulli discipline made a field). A claim
 * is evaluated WITHIN strata, never blind-pooled; the domain of validity is
 * physics-bounded; cross-stratum variation must be modelled, not waved away.
 */
export interface BaseRatesDomain {
    /** The hardware/sky strata the claim is evaluated within (>= 1 required). */
    strata: string[];
    /** The physics-bounded domain where the claim is asserted to hold (required). */
    domain_of_validity: string;
    /** How variation ACROSS strata is reconciled (the functional form of any
     *  dropoff reveals mechanism) — required for a multi-stratum claim. */
    cross_stratum_reconciliation: string;
}

/**
 * A pre-registered PASS criterion. ALL criteria freeze BEFORE implementation /
 * data access (`frozen: true` is REQUIRED). `measurable` is the quantitative
 * expression — it MUST carry a number and/or comparator (the linter rejects a
 * criterion that cannot be mechanically checked).
 */
export interface PassCriterion {
    /** Stable id, e.g. "P1". */
    id: string;
    /** Human description of the criterion. */
    description: string;
    /** The machine-checkable expression, e.g. "peakZ >= 4.5" — number/comparator required. */
    measurable: string;
    /** MUST be true — a criterion frozen at pre-registration time. */
    frozen: true;
}

/** An append-only verdict stamp (mirrors the registry's stamp chain in-doc). */
export interface VerdictStamp {
    /** The status this stamp asserts. */
    status: ThesisStatus;
    /** Who applied it (agent id / person / harness). */
    by: string;
    /** ISO-8601 timestamp. */
    at: string;
    /** Pointer to the evidence backing the verdict (path / hash / URL). */
    evidence_pointer: string;
}

/** External links (prior-art + future-state publication + accreditation). */
export interface ThesisLinks {
    arxiv: string[];
    researchgate: string[];
    orcid: string[];
    institutions: string[];
}

/**
 * A record of any deviation from the pre-registered design (empty = ran exactly
 * as registered). Filled by the test runner, NOT the submitter.
 */
export interface DeviationEntry {
    /** ISO-8601 timestamp of the deviation. */
    at: string;
    /** What deviated and why (e.g. a fallback parameterization was used). */
    note: string;
}

/**
 * A full CSL thesis. Field order mirrors the reference fixture
 * (test_results/theses/THESIS-2026-07-10-001-bright-pool-sweep.md) so the md
 * human-record and this machine-record read the same top to bottom.
 */
export interface Thesis {
    /** The schema generation this document targets (validated against THESIS_SCHEMA_VERSION). */
    schema_version: string;
    /** Stable, human-legible id, e.g. "THESIS-2026-07-10-001". */
    id: string;
    /** One-line title. */
    title: string;
    /** Who submitted it (agent id / person / ORCID). */
    submitter: string;
    /** Coarse lifecycle stage. */
    stage: ThesisStage;

    /** Submitter provenance class (schema >= 0.2.0; REQUIRED at 0.2.0+). Absent
     *  marks a legacy 0.1.0 entry. AI-RESEARCHER never pools with HUMAN. */
    submitter_class?: SubmitterClass;
    /** Declared run cost + lane (schema >= 0.2.0; REQUIRED at 0.2.0+). Absent
     *  marks a legacy 0.1.0 entry. */
    time_budget?: TimeBudget;

    /** The claim, in one falsifiable sentence. */
    hypothesis: string;
    /** The mechanism — WHY the hypothesis should hold, from measured diagnosis. */
    reasoning_mechanism: string;

    /** The equations/variables of the mechanism (structured, frozen-flagged). */
    equations_variables: EquationVariable[];

    /** Prior-art citations (>= 1, or an explicit card-absent entry). */
    prior_art: PriorArtCitation[];

    /** Base-rate / domain structure (mandatory — Bernoulli discipline). */
    base_rates_domain: BaseRatesDomain;

    /** Pre-registered, frozen, measurable PASS criteria (>= 1). */
    pass_criteria: PassCriterion[];

    /** Corollaries: "for this to hold, what else must be true?" (>= 1 required). */
    derivative_predictions: string[];

    /** The headline prediction on record (what the submitter expects to happen). */
    predictions_on_record: string;

    /** The falsifier: the condition under which the thesis is declared FAILED. */
    kill_clause: string;

    /** Deviations from the registered design (initialized empty). */
    deviations_log: DeviationEntry[];

    /** Lifecycle status (PRE-REGISTERED at submission). */
    status: ThesisStatus;

    /** Append-only verdict stamps carried in the document. */
    verdict_stamps: VerdictStamp[];

    /** External links. */
    links: ThesisLinks;
}

/**
 * The top-level fields a thesis MUST declare (the completeness contract the
 * linter enforces). Exported for documentation + for any TS-side validator; the
 * Node linter keeps its own copy in sync via this file's text (single source).
 */
export const REQUIRED_THESIS_FIELDS: readonly (keyof Thesis)[] = [
    'schema_version',
    'id',
    'title',
    'submitter',
    'stage',
    'hypothesis',
    'reasoning_mechanism',
    'equations_variables',
    'prior_art',
    'base_rates_domain',
    'pass_criteria',
    'derivative_predictions',
    'predictions_on_record',
    'kill_clause',
    'deviations_log',
    'status',
    'verdict_stamps',
    'links',
];

/** A freshly-minted, empty thesis skeleton (the form an interlocutor fills in). */
export function emptyThesis(): Thesis {
    return {
        schema_version: THESIS_SCHEMA_VERSION,
        id: '',
        title: '',
        submitter: '',
        stage: 'speculative',
        submitter_class: 'HUMAN',
        time_budget: { est_wall_minutes: 0, lane: 'inline' },
        hypothesis: '',
        reasoning_mechanism: '',
        equations_variables: [],
        prior_art: [],
        base_rates_domain: { strata: [], domain_of_validity: '', cross_stratum_reconciliation: '' },
        pass_criteria: [],
        derivative_predictions: [],
        predictions_on_record: '',
        kill_clause: '',
        deviations_log: [],
        status: 'PRE-REGISTERED',
        verdict_stamps: [],
        links: { arxiv: [], researchgate: [], orcid: [], institutions: [] },
    };
}
