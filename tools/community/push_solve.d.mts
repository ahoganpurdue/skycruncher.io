// Type declarations for the community solve-push core (push_solve.mjs).
// Keeps the tsc gate clean when .ts consumers (headless_driver.ts, the future
// desktop shell) import the module, and documents the public contract. Hand-written
// to mirror the runtime exports 1:1 (the .mjs stays the single source of behavior).

export function sha256Hex(data: Buffer | Uint8Array | string): string;
export function sha256File(p: string): string;
export function contentTypeForExt(ext: string): string;

export const SOLVES_PREFIX: string;
export function objectKey(frameSha12: string, artifactSha256: string, ext: string): string;
export function manifestKey(frameSha12: string): string;

export interface Quality {
  solved: boolean;
  stars_matched: number;
  confidence: number | null;
  confirm_status: string | null;
  confirm_set_excess_z: number | null;
  products: string[];
  product_count: number;
}
export function detectProducts(receipt: unknown): string[];
export function extractQuality(receipt: unknown): Quality;

export const QUALITY_ORDERING: readonly string[];
export function isStrictlyBetter(a: Quality, b: Quality): boolean;

export const MANIFEST_SCHEMA_VERSION: number;

export interface ArtifactRef {
  role: string;
  key: string;
  sha256: string;
  bytes: number;
  content_type: string;
}
export interface RunEntry {
  run_id: string;
  ts: string;
  engine_ref: string | null;
  receipt_schema_version: string | null;
  receipt_key: string;
  artifacts: ArtifactRef[];
  quality: Quality;
}
export function buildRunEntry(args: {
  receiptSha: string;
  receiptKey: string;
  receiptSchemaVersion: string | null;
  engineRef: string | null;
  quality: Quality;
  artifacts: ArtifactRef[];
  ts: string;
}): RunEntry;

export interface Manifest {
  schema_version: number;
  frame_sha: string;
  frame_sha12: string;
  quality_ordering: readonly string[];
  runs: RunEntry[];
  best: { run_id: string; receipt_key: string; quality: Quality } | null;
  updated_at: string;
}
export function mergeManifest(
  existing: Manifest | null | undefined,
  run: RunEntry,
  opts: { frameSha: string; frameSha12: string; now?: string | null },
): { manifest: Manifest; addedRun: boolean; bestRunId: string | null };

export interface S3Env { endpoint: string; accessKey: string; secretKey: string; bucket: string; }
export function s3EnvCommunity(): S3Env | null;

export interface R2Client {
  head(key: string): Promise<{ status: number; sha256: string | null }>;
  get(key: string): Promise<{ status: number; body: string | null }>;
  put(
    key: string,
    body: Buffer | Uint8Array,
    opts?: { contentType?: string; cacheControl?: string; meta?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number }>;
}
export function makeR2Client(env: S3Env): R2Client;

export interface PushSolveResult {
  frameSha12: string;
  uploaded: number;
  skipped: number;
  artifacts: ArtifactRef[];
  runEntry: RunEntry;
  addedRun?: boolean;
  becameBest?: boolean;
  manifestRuns?: number;
  quality: Quality;
  dryRun?: boolean;
}
export function pushSolve(args: {
  receiptBytes?: Buffer | Uint8Array | null;
  receiptPath?: string | null;
  frameSha: string;
  extras?: Array<{ path?: string; bytes?: Buffer | Uint8Array; ext?: string; role?: string; content_type?: string }>;
  engineRef?: string | null;
  client?: R2Client;
  dryRun?: boolean;
  log?: (msg: string) => void;
  now?: string | null;
}): Promise<PushSolveResult>;

export function gitShortSha(): string | null;

export function pushSolveFromReceipt(args: {
  receiptPath?: string | null;
  receiptBytes?: Buffer | Uint8Array | null;
  frameBytes?: Buffer | Uint8Array | null;
  frameSha?: string | null;
  extras?: Array<{ path?: string; bytes?: Buffer | Uint8Array; ext?: string; role?: string; content_type?: string }>;
  engineRef?: string | undefined;
  dryRun?: boolean;
  log?: (msg: string) => void;
  clientOverride?: R2Client | null;
  now?: string | null;
}): Promise<PushSolveResult | { noop: true }>;
