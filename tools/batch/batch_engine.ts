// ═══════════════════════════════════════════════════════════════════════════
// BATCH ENGINE — runBatch : N files → N receipts (in ONE process)   task #24
// (module: tools/batch/batch_engine.ts — the engine; run_batch.mjs is the CLI)
// ═══════════════════════════════════════════════════════════════════════════
//
// The general batch processor the overnight rig, corpus sweep, and a future UI
// panel become MODES of. It drives the REAL calibrated wizard (headless_driver
// runWizardPipeline) over a list of files IN ONE PROCESS, with per-file fault
// isolation and the process-global-config discipline that a single-process,
// multi-solve loop requires.
//
// WHY THE ENGINE IS .ts (and run_batch.mjs is only a CLI): a plain .mjs cannot
// resolve the engine's `@/` alias or boot the compiled wasm, and — critically —
// cannot call runWizardPipeline + snapshotConfig/restoreConfig in ONE process
// (the whole point). So the ENGINE lives here (vitest/vite-hosted, exactly like
// solve_to_receipt.runspec.ts) and run_batch.mjs is the thin CLI that forks one
// vitest process against run_batch.runspec.ts to drive it. This mirrors the
// established run.mjs → run.config.ts → solve_to_receipt.runspec.ts seam. (The
// stem differs from run_batch.mjs so a bare import never resolves to the CLI.)
//
// ── CONCURRENCY = 1 (ENFORCED) ────────────────────────────────────────────────
// Two process-global singletons make this engine SEQUENTIAL-ONLY today:
//   1. PIPELINE_CONSTANTS — a shared mutable config object (pipeline_config.ts
//      §PROCESS-GLOBAL MUTATION HAZARD). We snapshot ALL its keys before every
//      solve and restore after, so one file's config can NEVER bleed into the
//      next (restoreConfig also clears the active-override record).
//   2. StarCatalogAdapter — a singleton with a STATIC setAtlasLoader and a
//      sector cache that accumulates unbounded across solves in one process
//      (star_catalog_adapter.ts:61-75). Sequential reuse is SAFE (each solve
//      loads what it needs); concurrent solves would race the loader + cache.
// Therefore runBatch asserts `opts.concurrency === 1` (or unset). Parallelism is
// FUTURE work gated behind remediating those singletons (per-solve loader
// injection + a bounded/keyed sector cache); do NOT lift this assert without it.

import fs from 'node:fs';
import path from 'node:path';

import { computePlan, configHash, frameIdOf } from './batch_plan.mjs';
import {
    snapshotConfig,
    restoreConfig,
    PIPELINE_CONSTANTS,
} from '@/engine/pipeline/constants/pipeline_config';
// [m11 STACK] The FLAG ONLY (a zero-import env read, DEFAULT OFF). The actual
// stacking machinery (./batch_stack → m11_stack) is LAZY-imported inside the
// flag branch below, so a flag-off batch never loads it — byte-identical by
// construction (stack_flag.ts INERTNESS CONTRACT).
import { isStackingEnabled } from '@/engine/pipeline/m11_stack/stack_flag';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';
import type { PipelineEvent } from '@/engine/events/pipeline_events';
import type { HardMetadata } from '@/engine/types/Main_types';
import type { RunWizardOptions, RunWizardResult } from '../api/headless_driver';

// ── event seam (task #25's visual panel consumes THIS stream) ─────────────────
// Batch-level events are discriminated by `kind` — the SAME discriminator the
// engine's PipelineEvent uses — so a consumer switches on one `kind` field over
// a single merged stream (batch frame boundaries + the per-solve pipeline
// events forwarded verbatim between file_started/file_completed). The `kind`
// values below never collide with any PipelineEvent kind.
export type BatchVerdict = 'solved' | 'no_solve' | 'error';

export type BatchEvent =
    | { kind: 'batch_started'; ts: number; total: number; config_hash: string; run_index: number }
    | { kind: 'file_started'; ts: number; index: number; total: number; frameId: string; file: string }
    | {
          kind: 'file_completed';
          ts: number;
          index: number;
          total: number;
          frameId: string;
          file: string;
          verdict: Exclude<BatchVerdict, 'error'>;
          ms: number;
          solution: BatchSolution | null;
      }
    | { kind: 'file_failed'; ts: number; index: number; total: number; frameId: string; file: string; error: string; ms: number }
    | {
          kind: 'batch_completed';
          ts: number;
          total: number;
          solved: number;
          no_solve: number;
          errored: number;
          skipped: number;
          ms: number;
      };

/** The single merged stream a consumer taps: batch frame boundaries + the
 *  wizard's own per-solve events forwarded verbatim. Both carry `kind`. */
export type BatchStreamEvent = BatchEvent | PipelineEvent;

/** The comparable solve summary lifted from a receipt (the golden-equivalence
 *  fields). null on a no-solve (receipt.solution === null) or an error. */
export interface BatchSolution {
    ra_hours: number | null;
    dec_degrees: number | null;
    pixel_scale: number | null;
    stars_matched: number | null;
    confidence: number | null;
}

/** One honest row per file the batch attempted (never a fabricated success). */
export interface BatchFileResult {
    file: string;
    frameId: string;
    verdict: BatchVerdict;
    ok: boolean;
    /** Path to the written receipt, or null on a thrown solve (honest-absent). */
    receiptPath: string | null;
    schema_version: string | null;
    solution: BatchSolution | null;
    error: string | null;
    ms: number;
}

/** A file the plan chose NOT to solve (resume-current, or an eligibility skip). */
export interface BatchSkippedRow {
    frameId: string;
    file: string | null;
    reason: string;
    taxonomy: string;
}

/** [m11 STACK] Honest outcome block of the flag-gated post-batch drizzle step.
 *  Present on the ledger ONLY when VITE_STACK_ENABLED is on (flag-off ledgers
 *  are byte-identical — the key does not exist). Type-only import: erased at
 *  runtime, so the off arm still never loads batch_stack. */
export type BatchStackLedgerBlock =
    | (import('./batch_stack').StackStepSummary & { capture_skips: Array<{ frameId: string; reason: string }> })
    | { status: 'skipped'; reason: string; capture_skips: Array<{ frameId: string; reason: string }> }
    | { status: 'error'; error: string; capture_skips: Array<{ frameId: string; reason: string }> };

export interface BatchLedger {
    started_at: number;
    finished_at: number;
    config_hash: string;
    run_index: number;
    counts: { total: number; solved: number; no_solve: number; errored: number; skipped: number };
    results: BatchFileResult[];
    skipped: BatchSkippedRow[];
    /** Per-frame checkpoint state to chain into the NEXT run's resume plan. */
    frames: Record<string, { config_hash: string; status: 'complete'; last_run_index: number; verdict: BatchVerdict }>;
    /** [m11 STACK] Only present when the stacking flag is ON (additive). */
    stack?: BatchStackLedgerBlock;
}

/** Injectable solve — defaults to the REAL wizard (lazy-imported so a unit test
 *  that supplies a mock never pulls in the compiled wasm / orchestrator). */
export type BatchSolveFn = (buffer: ArrayBuffer, opts: RunWizardOptions) => Promise<RunWizardResult>;

export interface RunBatchOptions {
    /** Directory the browser's `/atlas/...` URLs resolve against (e.g. `<repo>/public`). */
    atlasRoot: string;
    /** Where receipts + the JSONL ledger land. Default: <repo>/test_results/batch. */
    outDir?: string;
    /** Pre-loaded wasm bytes forwarded to the driver (defaults to the pkg artifact). */
    wasmBytes?: BufferSource;
    /** step2 metadata overrides forwarded to every solve. */
    overrides?: Partial<HardMetadata>;
    /** Live tap of the merged stream (batch events + forwarded pipeline events). */
    onEvent?: (e: BatchStreamEvent) => void;
    /** Knobs hashed for idempotency (default { schema: 'batch/1' }). */
    config?: Record<string, unknown>;
    /** Prior run's `frames` map (BatchLedger.frames) to resume against. */
    checkpoint?: { run_index?: number; frames?: Record<string, unknown> } | null;
    /** true → skip files whose receipt is already current under this config hash. */
    resume?: boolean;
    /** Force a re-run: true = all, Set = these frame ids (overrides resume-skip). */
    force?: boolean | Set<string>;
    /** Cap the run slice to the first N files of the rotation order. */
    limit?: number;
    /** MUST be 1 or unset — see the CONCURRENCY=1 note. Any other value throws. */
    concurrency?: number;
    /** Test seam: defaults to the real runWizardPipeline (lazy-imported). */
    solveFn?: BatchSolveFn;
    /** Test seam: file → ArrayBuffer (default fs.readFileSync). */
    readFile?: (file: string) => ArrayBuffer;
    /** Test seam: monotonic clock for event timestamps (default Date.now). */
    now?: () => number;
    /** [m11 STACK] Options for the flag-gated post-batch drizzle step — read
     *  ONLY when VITE_STACK_ENABLED is on (m11_stack/stack_flag.ts). Params
     *  default to DEFAULT_DRIZZLE_PARAMS (documented Fruchter-Hook values);
     *  outDir defaults to <outDir>/stack — pass a D: path for full-size
     *  products (storage law: >10 MB artifacts never land on K:). */
    stack?: {
        params?: { scaleFactor: number; pixfrac: number };
        outDir?: string;
        cleanupScratch?: boolean;
    };
}

export interface RunBatchResult {
    ledger: BatchLedger;
    receipts: Array<{ frameId: string; file: string; receipt: unknown }>;
}

const DEFAULT_CONFIG = Object.freeze({ schema: 'batch/1' });

function readFileToArrayBuffer(file: string): ArrayBuffer {
    const buf = fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Lazy default solve: import the wasm-booting driver ONLY when no mock is given. */
async function defaultSolveFn(buffer: ArrayBuffer, opts: RunWizardOptions): Promise<RunWizardResult> {
    const { runWizardPipeline } = await import('../api/headless_driver');
    return runWizardPipeline(buffer, opts);
}

/** Lift the comparable solve summary from a receipt (honest-absent → nulls). */
function solutionOf(receipt: any): BatchSolution | null {
    const s = receipt?.solution;
    if (s == null) return null;
    return {
        ra_hours: s.ra_hours ?? null,
        dec_degrees: s.dec_degrees ?? null,
        pixel_scale: s.pixel_scale ?? null,
        stars_matched: s.stars_matched ?? null,
        confidence: s.confidence ?? null,
    };
}

/**
 * Run the calibrated wizard over `files` in ONE process → N receipts.
 *
 * Guarantees:
 *  • per-file try/catch: one bad frame is an honest `error` row, never fatal;
 *  • snapshotConfig(ALL keys) → solve → restoreConfig around EVERY file, so the
 *    process-global config cannot bleed across solves (the discipline the golden
 *    equivalence vs fork-per-file proves);
 *  • resume-by-config-hash via computePlan (reuse the shared batch planner);
 *  • receipts (canonical bytes) + a JSONL ledger under outDir;
 *  • an event seam (batch_started/file_started/file_completed/file_failed/
 *    batch_completed + forwarded pipeline events) — the visual panel's input.
 */
export async function runBatch(files: string[], opts: RunBatchOptions): Promise<RunBatchResult> {
    if (opts.concurrency != null && opts.concurrency !== 1) {
        throw new Error(
            `[batch] concurrency=${opts.concurrency} is unsupported: runBatch is SEQUENTIAL-ONLY ` +
                `(PIPELINE_CONSTANTS + StarCatalogAdapter are process-global singletons). ` +
                `Parallelism is gated behind singleton remediation — see the CONCURRENCY=1 note.`,
        );
    }

    const now = opts.now ?? Date.now;
    const readFile = opts.readFile ?? readFileToArrayBuffer;
    const solveFn = opts.solveFn ?? defaultSolveFn;
    const config = opts.config ?? DEFAULT_CONFIG;
    const outDir = opts.outDir ?? path.join(process.cwd(), 'test_results', 'batch');
    const snapshotKeys = Object.keys(PIPELINE_CONSTANTS as Record<string, unknown>);

    // Map each frame id → its file path (first occurrence wins, mirroring
    // computePlan's dedup). A batch has no detection-dump concept, so every file
    // is eligible; megapixels is unknown (0) so the OOM gate never fires unless a
    // config sets mp_ceiling.
    const fileOf = new Map<string, string>();
    const manifestImages = files.map((f) => {
        const id = frameIdOf(f);
        if (!fileOf.has(id)) fileOf.set(id, f);
        return { path: f, megapixels: 0, image_type: 'BATCH' };
    });

    const receiptPathOf = (id: string) => path.join(outDir, `${id}.receipt.json`);
    // Reuse the shared planner ONLY for the resume/skip DECISION (which frames are
    // current under this config hash). We do NOT take its rotation ORDER: rotation
    // (never→stale→current) is an overnight-slice concern; a generic batch processes
    // in the caller's INPUT order, which is predictable + intuitive. `limit` is
    // therefore applied to the input-ordered slice below, NOT inside computePlan.
    const plan = computePlan({
        manifestImages,
        checkpoint: opts.checkpoint ?? null,
        config,
        hasDump: () => true,
        artifactsPresent: (id: string) => fs.existsSync(receiptPathOf(id)),
        // resume=true → honor the current-skip; otherwise force every file to run.
        opts: { force: opts.resume === true ? (opts.force ?? false) : (opts.force ?? true) },
    });

    // Files needing a run, in INPUT order (deduped by frame id), capped by limit.
    const toRunSet = new Set<string>(plan.toRun);
    const seenRun = new Set<string>();
    let runIds: string[] = [];
    for (const f of files) {
        const id = frameIdOf(f);
        if (seenRun.has(id)) continue;
        seenRun.add(id);
        if (toRunSet.has(id)) runIds.push(id);
    }
    if (typeof opts.limit === 'number' && opts.limit >= 0) runIds = runIds.slice(0, opts.limit);

    fs.mkdirSync(outDir, { recursive: true });
    const ledgerPath = path.join(outDir, 'batch_ledger.jsonl');
    const emit = (e: BatchStreamEvent) => opts.onEvent?.(e);

    const startedAt = now();
    emit({ kind: 'batch_started', ts: startedAt, total: runIds.length, config_hash: plan.hash, run_index: plan.runIndex });

    // ── [m11 STACK — FLAG-GATED, DEFAULT OFF] ────────────────────────────────
    // This env read is the ONLY stacking code that executes on the off arm.
    const stackOn = isStackingEnabled();
    let stackMod: typeof import('./batch_stack') | null = null;
    const stackCaptured: Array<import('./batch_stack').CapturedFrame> = [];
    const stackSkips: Array<{ frameId: string; reason: string }> = [];
    const stackScratchDir = path.join(opts.stack?.outDir ?? path.join(outDir, 'stack'), 'scratch');

    const results: BatchFileResult[] = [];
    const receipts: RunBatchResult['receipts'] = [];
    const frames: BatchLedger['frames'] = {};
    // Fresh ledger file for this run (append per-file lines as they complete).
    fs.writeFileSync(ledgerPath, '');

    for (let i = 0; i < runIds.length; i++) {
        const frameId = runIds[i];
        const file = fileOf.get(frameId)!;
        emit({ kind: 'file_started', ts: now(), index: i, total: runIds.length, frameId, file });

        const t0 = now();
        // Snapshot the ENTIRE config surface, then guarantee restore in `finally`
        // even if the solve throws — no override or in-solve mutation escapes.
        const snap = snapshotConfig(snapshotKeys);
        let row: BatchFileResult;
        try {
            const ab = readFile(file);
            const res = await solveFn(ab, {
                atlasRoot: opts.atlasRoot,
                wasmBytes: opts.wasmBytes,
                overrides: opts.overrides,
                // Forward the wizard's own events into the merged stream.
                onEvent: (e: PipelineEvent) => emit(e),
            });
            const receipt = res.receipt;

            const receiptPath = receiptPathOf(frameId);
            fs.writeFileSync(receiptPath, serializeReceipt(receipt), 'utf8');
            const solution = solutionOf(receipt);
            const verdict: Exclude<BatchVerdict, 'error'> = solution ? 'solved' : 'no_solve';
            const ms = now() - t0;
            row = {
                file,
                frameId,
                verdict,
                ok: true,
                receiptPath,
                schema_version: (receipt as any)?.version ?? null,
                solution,
                error: null,
                ms,
            };
            receipts.push({ frameId, file, receipt });

            // [m11 STACK] Capture the solved frame's luminance plane + fitted-WCS
            // provenance for the post-batch drizzle. Lazy module load; every
            // failure degrades to an honest skip record, never a failed file.
            if (stackOn && verdict === 'solved') {
                try {
                    stackMod ??= await import('./batch_stack');
                    const cap = stackMod.captureFrame(
                        stackScratchDir, frameId, file,
                        res.session as unknown as import('./batch_stack').StackCaptureSession,
                        receipt,
                    );
                    if (cap.captured) stackCaptured.push(cap.captured);
                    else stackSkips.push({ frameId, reason: cap.reason ?? 'not stackable' });
                } catch (err) {
                    stackSkips.push({ frameId, reason: `capture error: ${err instanceof Error ? err.message : String(err)}` });
                }
            }

            emit({ kind: 'file_completed', ts: now(), index: i, total: runIds.length, frameId, file, verdict, ms, solution });
        } catch (err) {
            const ms = now() - t0;
            const message = err instanceof Error ? err.message : String(err);
            row = { file, frameId, verdict: 'error', ok: false, receiptPath: null, schema_version: null, solution: null, error: message, ms };
            emit({ kind: 'file_failed', ts: now(), index: i, total: runIds.length, frameId, file, error: message, ms });
        } finally {
            restoreConfig(snap);
        }

        results.push(row);
        frames[frameId] = { config_hash: plan.hash, status: 'complete', last_run_index: plan.runIndex, verdict: row.verdict };
        fs.appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
    }

    // Honest skip rows: eligible files NOT in this run slice (resume-current, or
    // trimmed by --limit) + eligibility skips (plan.skipped = OOM/no-dump, only if a
    // config sets mp_ceiling). Deduped by frame id, in input order.
    const ranSet = new Set(runIds);
    const skipEligibleId = new Set(plan.skipped.map((s: { id: string }) => s.id));
    const skipped: BatchSkippedRow[] = [];
    const seenSkip = new Set<string>();
    for (const f of files) {
        const id = frameIdOf(f);
        if (seenSkip.has(id) || ranSet.has(id) || skipEligibleId.has(id)) continue;
        seenSkip.add(id);
        // Not run and not an eligibility skip → the planner deemed it current, or
        // --limit trimmed it. Distinguish by whether the plan wanted to run it.
        const reason = toRunSet.has(id) ? 'limit-trimmed' : 'resume-current';
        skipped.push({ frameId: id, file: fileOf.get(id) ?? null, reason, taxonomy: 'ok' });
    }
    for (const s of plan.skipped as Array<{ id: string; skip_reason: string; taxonomy: string }>) {
        skipped.push({ frameId: s.id, file: fileOf.get(s.id) ?? null, reason: s.skip_reason, taxonomy: s.taxonomy });
    }

    // ── [m11 STACK] post-batch drizzle (flag ON only; NEVER-FATAL) ───────────
    // Multi-frame stacking runs AFTER the per-file loop (stacking is a batch/
    // session-level product — the wizard is single-frame by design). Any
    // failure becomes an honest {status:'error'} ledger block, never a failed
    // batch (workbench_deposit never-fatal precedent).
    let stackBlock: BatchStackLedgerBlock | undefined;
    if (stackOn) {
        try {
            if (stackCaptured.length >= 2) {
                stackMod ??= await import('./batch_stack');
                const summary = await stackMod.runStackStep(stackCaptured, {
                    stackOutDir: opts.stack?.outDir ?? path.join(outDir, 'stack'),
                    params: opts.stack?.params,
                    cleanupScratch: opts.stack?.cleanupScratch ?? false,
                });
                stackBlock = { ...summary, capture_skips: stackSkips };
            } else {
                stackBlock = {
                    status: 'skipped',
                    reason: `only ${stackCaptured.length} stackable solved frame(s) captured (need >=2)`,
                    capture_skips: stackSkips,
                };
            }
        } catch (err) {
            stackBlock = {
                status: 'error',
                error: err instanceof Error ? err.message : String(err),
                capture_skips: stackSkips,
            };
        }
    }

    const counts = {
        total: results.length,
        solved: results.filter((r) => r.verdict === 'solved').length,
        no_solve: results.filter((r) => r.verdict === 'no_solve').length,
        errored: results.filter((r) => r.verdict === 'error').length,
        skipped: skipped.length,
    };
    const finishedAt = now();
    emit({ kind: 'batch_completed', ts: finishedAt, total: counts.total, solved: counts.solved, no_solve: counts.no_solve, errored: counts.errored, skipped: counts.skipped, ms: finishedAt - startedAt });

    const ledger: BatchLedger = {
        started_at: startedAt,
        finished_at: finishedAt,
        config_hash: plan.hash,
        run_index: plan.runIndex,
        counts,
        results,
        skipped,
        frames,
        // [m11 STACK] key present ONLY when the flag is on — a flag-off ledger
        // (and its serialized bytes) is unchanged.
        ...(stackBlock !== undefined ? { stack: stackBlock } : {}),
    };
    fs.writeFileSync(path.join(outDir, 'batch_summary.json'), JSON.stringify(ledger, null, 2));

    return { ledger, receipts };
}
