// Type declarations for the shared batch-engine planning core (batch_plan.mjs).
// Keeps the tsc gate clean when .ts consumers (batch_engine.ts, unit tests)
// import the module, and documents the pure-function contract. Hand-written to
// mirror the runtime exports 1:1 (the .mjs stays the single source of behavior).

export const FAILURE: {
  readonly OK: 'ok';
  readonly NO_DUMP: 'no-dump';
  readonly OOM: 'oom';
  readonly NO_TRUTH: 'no-truth';
  readonly SOLVE_FAIL: 'solve-fail';
  readonly RENDER_FAIL: 'render-fail';
};

export const BATCH_DEFAULTS: { readonly mp_ceiling: number };

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
