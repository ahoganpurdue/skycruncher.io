/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NODE CAPTURE SINK — the filesystem writer for the per-run capture record
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `capture_record.ts` already builds a durable per-stage CaptureEnvelope[] on
 * every run and fans it out to registered sinks; `capture_persist.ts` is the
 * BROWSER sink (localStorage). This is the missing NODE sink the code comment in
 * `capture_record.ts` (the "Node file writer (tools/capture)") anticipates —
 * efficiency-review candidate I1 / C6a.
 *
 * WHY IT MATTERS (the enabler): per-orchestrator-stage timing AND the A3
 * per-BRANCH timing (`solve.uw_sweep` / `solve.uw_escalation` — accrued into
 * `diagnostics.branch_timing` and surfaced as branch envelopes by
 * `stages/solve.ts:emitSolveBranch`) are COMPUTED on every Node solve and then
 * DISCARDED, because nothing in Node writes the record to disk. Registering this
 * sink turns any headless run (Toolchest driver, corpus sweep, the pinned e2e
 * frames) into a persisted `<dir>/<run_id>.jsonl` — the MEASURED substrate the
 * flowchart hover timings (fastest→avg→slowest) and the master-widget data plane
 * fold. This is the prerequisite for every optimization claim getting a measured
 * basis (EFFICIENCY_REVIEW §2: "attribute-before-optimize").
 *
 * DESIGN (mirrors the browser sink's discipline):
 *   - EXTENDS the existing A4 corpus mechanism — same `buildCaptureRecord` output,
 *     same JSONL serializer, same `test_results/runs/<run_id>.jsonl` layout the
 *     replay dashboard's time-slider already scrubs (LAW 4: no parallel format).
 *   - ADDITIVE + NON-FATAL: a failed write (permissions, missing dir, bad runId)
 *     is swallowed and returns null — instrumentation must NEVER break a solve.
 *   - HONEST-OR-ABSENT (LAW 3): an empty record or a missing runId writes NOTHING
 *     (absent, never a zero-length placeholder file).
 *   - No receipt contact, no solve-path contact, no WCS/matched-star contact. The
 *     persisted envelope is the EXISTING CaptureEnvelope contract (its on-disk key
 *     set is already pinned by tools/capture/headless_capture.capspec.ts) — this
 *     module introduces NO new format, so it needs NO B5 version-manifest entry and
 *     is NOT a LAW-7 enumerated binary boundary (it is JSON text, not packed bytes).
 *
 * NODE-ONLY: imports `node:fs`/`node:path`, so it lives in tools/ (never imported
 * by the browser bundle) — the browser retention path stays `capture_persist.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    registerCaptureSink,
    serializeCaptureRecordJsonl,
    type CaptureEnvelope,
} from '@/engine/events/capture_record';

/** Minimal fs surface the writer needs — injectable so unit tests stay hermetic. */
export interface CaptureFsLike {
    mkdirSync: (p: string, opts: { recursive: boolean }) => unknown;
    writeFileSync: (p: string, data: string, enc: 'utf8') => void;
}

export interface NodeCaptureSinkOptions {
    /**
     * Directory the per-run JSONL is written under (created recursively). The A4
     * corpus default is `<repo>/test_results/runs`; the caller owns the choice so
     * an e2e run can drop it INTO its own `<run>/` output dir instead.
     */
    dir: string;
    /**
     * Fixed output filename. When omitted, `<run_id>.jsonl` (the A4 corpus layout).
     * Pass e.g. `'capture.jsonl'` for the per-run-subdir layout (`<run>/capture.jsonl`).
     */
    filename?: string;
    /** Injected fs (defaults to `node:fs`) — tests pass a spy to avoid disk. */
    fsImpl?: CaptureFsLike;
    /** Post-write hook (test assertions / telemetry): the absolute path just written. */
    onWrite?: (outPath: string, runId: string, envelopes: readonly CaptureEnvelope[]) => void;
}

/** Filesystem-safe basename fragment from a run id (session ids are generally safe, but be defensive). */
function safeName(runId: string): string {
    return runId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'run';
}

/** Resolve the output path for a run given the options. */
export function captureOutPath(opts: Pick<NodeCaptureSinkOptions, 'dir' | 'filename'>, runId: string): string {
    return path.join(opts.dir, opts.filename ?? `${safeName(runId)}.jsonl`);
}

/**
 * Write one run's capture record to disk as JSONL. Non-fatal: returns the written
 * path, or null when there was nothing to write (empty record / missing runId) or
 * the write failed. Never throws.
 */
export function writeCaptureRecord(
    dir: string,
    runId: string | null | undefined,
    envelopes: readonly CaptureEnvelope[],
    opts?: Omit<NodeCaptureSinkOptions, 'dir'>,
): string | null {
    try {
        if (!runId || envelopes.length === 0) return null; // honest-absent: write nothing
        const fsi = opts?.fsImpl ?? fs;
        fsi.mkdirSync(dir, { recursive: true });
        const outPath = captureOutPath({ dir, filename: opts?.filename }, runId);
        fsi.writeFileSync(outPath, serializeCaptureRecordJsonl([...envelopes]), 'utf8');
        return outPath;
    } catch {
        return null; // instrumentation must never break the run
    }
}

/**
 * Register a global Node CaptureSink that mirrors every completed run to
 * `<dir>/<run_id>.jsonl`. Returns an unregister (call it in test teardown / when
 * a caller wraps a single run). Idempotent-safe to install more than once (each
 * install is a distinct sink; unregister the one you installed).
 */
export function installNodeCaptureSink(opts: NodeCaptureSinkOptions): () => void {
    return registerCaptureSink((runId, envelopes) => {
        const outPath = writeCaptureRecord(opts.dir, runId, envelopes, {
            filename: opts.filename,
            fsImpl: opts.fsImpl,
        });
        if (outPath && opts.onWrite) {
            try { opts.onWrite(outPath, runId, envelopes); } catch { /* hook is best-effort */ }
        }
    });
}
