// Type declarations for the overnight pipeline's pure rotation/planning core
// (rotation.mjs). Keeps the tsc gate clean when the .ts unit tests import the
// module, and documents the pure-function contract. Hand-written to mirror the
// runtime exports 1:1 (the .mjs stays the single source of behavior).

export const FAILURE: {
  readonly OK: 'ok';
  readonly NO_DUMP: 'no-dump';
  readonly OOM: 'oom';
  readonly NO_TRUTH: 'no-truth';
  readonly SOLVE_FAIL: 'solve-fail';
  readonly RENDER_FAIL: 'render-fail';
};

export interface OvernightConfig {
  schema: string;
  candidate: string;
  arms: { off: number; on: number };
  budget_ms: number;
  mp_ceiling: number;
  render: { stretch_a: number; lo_pct: number; hi_pct: number };
  [k: string]: unknown;
}
export const DEFAULT_CONFIG: OvernightConfig;

export function canonicalize(value: unknown): unknown;
export function configHash(config: unknown): string;
export function frameIdOf(imgPath: string): string;

export interface Eligibility {
  eligible: boolean;
  skip_reason: string;
  taxonomy: string;
}
export function classifyEligibility(
  entry: { megapixels?: number | null },
  opts: { mpCeiling: number; hasDump: boolean },
): Eligibility;

export function frameStatus(
  cpEntry: { config_hash?: string; status?: string } | null | undefined,
  currentHash: string,
  artifactsPresent: boolean,
): 'never' | 'stale' | 'current';

export function orderForRotation(
  frames: string[],
  statusOf: (id: string) => string,
  lastRunOf: (id: string) => number,
): string[];

export function nextRunIndex(checkpoint: { run_index?: number } | null | undefined): number;

export interface PlanEligible {
  id: string;
  image_type: string;
  megapixels: number | null;
  status: 'never' | 'stale' | 'current';
  last_run_index: number;
}
export interface PlanSkipped {
  id: string;
  image_type: string;
  megapixels: number | null;
  taxonomy: string;
  skip_reason: string;
}
export interface Plan {
  hash: string;
  runIndex: number;
  eligible: PlanEligible[];
  skipped: PlanSkipped[];
  ordered: string[];
  toRun: string[];
}
export interface ComputePlanArgs {
  manifestImages: Array<{
    path: string;
    megapixels?: number | null;
    image_type?: string;
    [k: string]: unknown;
  }>;
  checkpoint: { run_index?: number; frames?: Record<string, unknown> } | null | undefined;
  config: unknown;
  hasDump: (id: string) => boolean;
  artifactsPresent: (id: string) => boolean;
  opts?: { limit?: number; frames?: string[]; force?: boolean | Set<string> };
}
export function computePlan(args: ComputePlanArgs): Plan;

export function decideTruthAction(
  installGreen: boolean,
  mode: string,
  cachedVerdict: string | null | undefined,
): 'off' | 'no-truth' | 'cached' | 'use';

export interface SolveArm {
  locked: boolean;
  matched?: number;
  ms?: number | null;
  sigma?: number | null;
}
export interface SolveClass {
  taxonomy: string;
  reason: string;
  off: SolveArm | null;
  on: SolveArm | null;
}
export function classifySolve(rawOff: unknown, rawOn: unknown): SolveClass;

/** Whether the CR2 anchor-lever A/B solve applies to a frame (CR2_DSLR only; FITS solve is n/a). */
export function isCr2SolveApplicable(imageType: string | null | undefined): boolean;

/** Whether the FITS solve-vs-truth A/B applies to a frame (FITS_SEESTAR/FITS_OTHER). */
export function isFitsSolveApplicable(imageType: string | null | undefined): boolean;

export interface FitsTruthDetail {
  verdict?: string | null;
  tier?: string | null;
}
export interface FitsTruthReconciliation {
  verdict: string | null;
  tier: string | null;
  taxonomy: string;
}
/**
 * Reconcile a FITS frame's recorded truth from the oracle verdict + the FITS-rail
 * merge detail (see rotation.mjs). A resolved rail verdict is authoritative; absent
 * one, honest-absent (oracle verdict + taxonomy unchanged).
 */
export function reconcileFitsTruth(
  oracleVerdict: string | null | undefined,
  currentTaxonomy: string,
  railDetail: FitsTruthDetail | null | undefined,
): FitsTruthReconciliation;

/** Decide whether the loop auto-invokes the intake fetcher at start (opt-in + safe). */
export function decideIntakeAction(args: {
  enabled: boolean;
  configPath: string | null;
  configExists: boolean;
}): { run: boolean; reason: string; config: string | null };

/** Harvest-before-clear gate: green light only when durable derived artifacts exist (NEVER deletes). */
export function canClearRaw(
  frameId: string,
  artifacts?: { hasDetectionDump?: boolean; hasLedgerEntry?: boolean },
): { ok: boolean; missing: string[] };
