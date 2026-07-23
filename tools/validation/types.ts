// ─────────────────────────────────────────────────────────────────────────────
// Validation & Graduation Harness — core types (spec: docs/VALIDATION_HARNESS.md)
//
// Pure, headless, zero app-risk. This file is the vocabulary shared by the
// ledger, policy engine, runner, grader and registry. NOTHING here imports a
// calibrated path — the harness proves candidates OFF vs ON via an env-var
// binding, it never edits solver source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Image-type cohort. Outcomes, deltas, efficiency and verdicts are ALL cohorted
 * by this — a per-type verdict NEVER pools across types. Extensible: the union
 * documents the known regimes but any string is accepted (`FITS_OTHER`, …).
 */
export const KNOWN_IMAGE_TYPES = [
  'FITS_SEESTAR',
  'CR2_DSLR',
  'FITS_OTHER',
  'RAW_OTHER',
] as const;
export type ImageType = (typeof KNOWN_IMAGE_TYPES)[number] | (string & {});

/** Candidate problem domain (seed set; extensible). */
export type Domain = 'SOLVER' | 'CONFIRMATION' | 'DETECTION' | 'RENDER';

/**
 * The mechanical verdict — per image_type AND global. Never a judgment call.
 * - GRADUATE          : net_improvements ≥ K AND regressions == 0 over ≥ N_min inputs.
 * - KEEP-EVAL         : safe, enough data, but not yet enough net improvement.
 * - BLOCKED           : ≥1 regression observed (net-harm is first-class).
 * - INSUFFICIENT-DATA : < N_min distinct inputs (honest-or-absent, never a guessed PASS).
 * - N/A               : image_type is not in the candidate's applicability set.
 */
export type Verdict =
  | 'GRADUATE'
  | 'KEEP-EVAL'
  | 'BLOCKED'
  | 'INSUFFICIENT-DATA'
  | 'N/A';

/** Lifecycle state of a candidate binding, resolved PER image_type. */
export type BindingState = 'OFF' | 'EVAL' | 'ON';

/**
 * The RUNTIME override binding. The convention (spec §Core abstractions) is an
 * env-var read at the real config site (e.g. `envInt('SOLVER_UW_ANCHOR_CANDIDATES',3)`).
 * The runner flips this env var per-trial WITHOUT mutating source — reversible,
 * parallel-safe, byte-identical when unset. `defaultByType` is the LIVE per-type
 * default (what ships today); `EVAL` is a process state, not a stored default.
 */
export interface Binding {
  /** Env var read at the config site to override the default. */
  envVar: string;
  /** Value that reproduces baseline / OFF behavior (byte-identical when unset). */
  offValue: string;
  /** Value that engages the candidate / ON behavior. */
  onValue: string;
  /** Live shipped default per image_type (OFF or ON). Absent type ⇒ OFF. */
  defaultByType: Partial<Record<ImageType, 'OFF' | 'ON'>>;
}

/** Cost proxies read from solver forensics (per arm). Summed → a scalar cost. */
export interface Cost {
  centers_tried: number;
  sweeps: number;
  escalations: number;
  catalog_pages: number;
}

/**
 * Processing efficiency for a trial — recorded for BOTH arms REGARDLESS of
 * graduation (this profiles the toolchain, not just the candidate). Wall ms are
 * DATA fields (noisy) — aggregate as MEDIANS, never gate on a single time.
 */
export interface Efficiency {
  baseline_ms: number;
  candidate_ms: number;
  /** Cost proxies for the candidate (ON) arm. */
  cost: Cost;
  /** Which solver tool produced the lock in the ON arm (forensic SUCCESS_* tag). */
  locking_tool: string;
}

/**
 * computeDelta(baseline, candidate) → labelled improvements / regressions.
 * Counts drive the policy (`net_improvements = improvements.length`,
 * `regressions = regressions.length`); the labels record WHICH one, for the trail.
 */
export interface Delta {
  improvements: string[];
  regressions: string[];
}

/** A single measured run of the pipeline for one arm (domain-agnostic raw form). */
export interface RunResult {
  /** Wall time (ms) — a DATA field. Synthetic runs report a deterministic value. */
  wall_ms: number;
  /** Cost proxies from forensics (partial ⇒ missing fields default to 0). */
  cost?: Partial<Cost>;
  /** Forensic SUCCESS_* tag of the tool that locked, or 'none'. */
  locking_tool?: string;
  /** Domain payload — extractOutcome maps this to the typed outcome. */
  [k: string]: unknown;
}

/** Input to a trial. Keyed by `id` (idempotency); tagged by `image_type`. */
export interface RunInput {
  id: string;
  image_type: ImageType;
  /** Opaque payload consumed by the run function (e.g. a file path, or mock arms). */
  [k: string]: unknown;
}

/** Runs the pipeline for the CURRENT env-binding arm and returns a raw result. */
export type RunFn = (input: RunInput) => RunResult | Promise<RunResult>;

/** Graduation thresholds + the per-cohort criterion (PURE — see policy.ts). */
export interface Policy {
  /** Minimum distinct inputs of a type before a non-INSUFFICIENT verdict. */
  nMin: Partial<Record<ImageType, number>>;
  /** Fallback N_min when a type has no explicit entry. */
  nMinDefault: number;
  /** Required net improvements to GRADUATE. */
  k: number;
  /**
   * Regression labels that count as blocking. Empty ⇒ ANY regression blocks
   * (the spec default — `regressions == 0` is required unconditionally). A
   * non-empty allowlist lets a candidate treat only specific labels as blockers.
   */
  blockingRegressions?: string[];
}

/** A logged A/B trial — one line of the append-only ledger. */
export interface Trial<O = unknown> {
  candidate_id: string;
  input_id: string;
  image_type: ImageType;
  /** Domain outcome, OFF arm. */
  baseline: O;
  /** Domain outcome, ON arm. */
  candidate: O;
  delta: Delta;
  efficiency: Efficiency;
  /** Recorded timestamp (DATA field — never control flow). */
  ts: number;
}

/**
 * A promotion candidate. `extractOutcome`/`computeDelta` are domain logic;
 * `policy` is the pure verdict criterion; `binding` is the reversible A/B lever.
 */
export interface Candidate<O = unknown> {
  id: string;
  description: string;
  domain: Domain;
  /** image_types this candidate can engage on. Others record N/A, not a null. */
  applicability: Set<ImageType>;
  binding: Binding;
  // Method syntax (bivariant params) is DELIBERATE: it lets domain-typed
  // candidates (Candidate<SolverOutcome>, Candidate<ConfirmationOutcome>) live
  // together in a single Candidate[] registry without variance errors.
  extractOutcome(runResult: RunResult): O;
  computeDelta(baseline: O, candidate: O): Delta;
  policy: Policy;
  /**
   * Honest current state for descriptor-only candidates whose live A/B is
   * orchestrator-owned (calibrated path). Shown by the registry until a real
   * ledger exists. Keyed by image_type.
   */
  seedVerdicts?: Partial<Record<ImageType, Verdict>>;
}
