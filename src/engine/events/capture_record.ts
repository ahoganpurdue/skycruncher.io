/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAPTURE RECORD — per-run persistence substrate for the Glass Pipeline stream
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The event bus (`pipeline_events.ts`) already emits `stage_started` /
 * `stage_finished{ok,ms}` + findings + warnings — but MEMORY-ONLY (ring buffer,
 * lost on reload). This module is the ★ dashboard/flowchart wave-1 substrate:
 * it turns that ephemeral stream into a durable PER-STAGE capture record (one
 * envelope per stage per run) that both the interactive flowchart widget and
 * the replay dashboard's time-slider consume.
 *
 * DESIGN CONSTRAINTS (mirrors the bus):
 *   - HEADLESS-SAFE: no DOM required. The optional `window` mirror is a plain
 *     data object behind a `typeof` guard (never DOM manipulation) so Node /
 *     vitest never touch it.
 *   - ADDITIVE + NON-FATAL: the recorder is a bus subscriber; a throw here can
 *     never break emission (belt-and-suspenders try/catch on top of the bus's
 *     own per-subscriber guard). The solve numbers / receipts are untouched.
 *   - HONEST-OR-ABSENT (LAW 3): an unmeasured verdict is `null`, never a
 *     placeholder. Dedup is on `frame_sha`; a null sha is NOT deduped (counted
 *     distinct, flagged unhashed) — that discipline lives with the consumer.
 */

import type { PipelineEvent, PipelineEventBus, StageVerdict } from './pipeline_events';

/**
 * One JSONL row: the per-stage envelope. Field names are snake_case (the
 * on-disk / cross-tool contract); the recon-recommended shape verbatim.
 */
export interface CaptureEnvelope {
    /** Run grouping key (promoted session id). null when never stamped. */
    run_id: string | null;
    /** Content SHA-256 of the source frame (dedup key). null = honestly unhashed. */
    frame_sha: string | null;
    /** Stable stage id (the flowchart node id). */
    stage_id: string;
    /** Monotonic bus sequence of the closing `stage_finished` (ordering key). */
    seq: number;
    /** Epoch ms of the `stage_started` (wall-clock lower bound). */
    t_start: number;
    /** Epoch ms of the `stage_finished` (wall-clock upper bound). */
    t_end: number;
    /** Authoritative stage duration (ms) as measured by the emitter. */
    ms: number;
    /** Did the stage succeed. */
    ok: boolean;
    /** Honest outcome enum — null when the emitter surfaced none (NOT MEASURED). */
    verdict: StageVerdict | null;
    /** Integer counts surfaced for the flowchart (matched / n_used / …). */
    counts: Record<string, number>;
    /** Honest degradation notices attributed to this stage's window. */
    warnings: string[];
    /** Receipt block NAME this stage's data lands in (widget key), or null. */
    payload_ref: string | null;
}

type WarningEvent = Extract<PipelineEvent, { kind: 'warning' }>;

/**
 * Build the per-stage capture record from a run's event stream (pure).
 *
 * Pairs `stage_started` ↔ `stage_finished` by stage id using a LIFO stack (so
 * nested stages — the calibrate umbrella wrapping psf_field / bc_rematch /
 * forced_confirm — pair to their own opener). Warnings are attributed to the
 * stage whose [start, finish] seq window contains them and whose id matches
 * (or an unscoped warning). `run_id` is the first stamped id; `frame_sha` is
 * the LAST non-null stamp (it is back-filled async, so later stamps win).
 */
export function buildCaptureRecord(events: readonly PipelineEvent[]): CaptureEnvelope[] {
    let runId: string | null = null;
    let frameSha: string | null = null;
    for (const e of events) {
        if (runId == null && e.runId != null) runId = e.runId;
        if (e.frameSha != null) frameSha = e.frameSha; // async back-fill: last non-null wins
    }

    const warnings = events.filter((e): e is WarningEvent => e.kind === 'warning');
    const open: Array<{ stage: string; startSeq: number; startT: number }> = [];
    const envelopes: CaptureEnvelope[] = [];

    for (const e of events) {
        if (e.kind === 'stage_started') {
            open.push({ stage: e.stage, startSeq: e.seq, startT: e.t });
            continue;
        }
        if (e.kind !== 'stage_finished') continue;

        // Pop the most-recent still-open start with the same id (LIFO ⇒ nesting).
        let idx = -1;
        for (let i = open.length - 1; i >= 0; i--) {
            if (open[i].stage === e.stage) { idx = i; break; }
        }
        const started = idx >= 0 ? open.splice(idx, 1)[0] : undefined;
        const startSeq = started?.startSeq ?? e.seq;
        const startT = started?.startT ?? e.t;

        const stageWarnings = warnings
            .filter(w => w.seq > startSeq && w.seq <= e.seq && (w.stage == null || w.stage === e.stage))
            .map(w => w.message);

        envelopes.push({
            run_id: runId,
            frame_sha: frameSha,
            stage_id: e.stage,
            seq: e.seq,
            t_start: startT,
            t_end: e.t,
            ms: e.ms,
            ok: e.ok,
            verdict: e.verdict ?? null,
            counts: e.counts ?? {},
            warnings: stageWarnings,
            payload_ref: e.payloadRef ?? null,
        });
    }

    return envelopes;
}

/** Serialize envelopes as JSONL (trailing newline when non-empty). */
export function serializeCaptureRecordJsonl(envelopes: CaptureEnvelope[]): string {
    if (envelopes.length === 0) return '';
    return envelopes.map(x => JSON.stringify(x)).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// SINK REGISTRY + IN-MEMORY STORE (browser retention / Node file writers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A capture sink is invoked once per finished run with the built envelopes.
 * The Node file writer (tools/capture) registers one; the browser needs none
 * (the in-memory store below IS its exportable sink).
 */
export type CaptureSink = (
    runId: string,
    envelopes: CaptureEnvelope[],
    rawEvents: readonly PipelineEvent[],
) => void;

const sinks: CaptureSink[] = [];

/** Register a sink; returns an unsubscribe. */
export function registerCaptureSink(fn: CaptureSink): () => void {
    sinks.push(fn);
    return () => {
        const i = sinks.indexOf(fn);
        if (i >= 0) sinks.splice(i, 1);
    };
}

/** Retain the last N completed runs (bounded so a long browser session can't leak). */
const CAPTURE_RUNS_CAP = 20;
const completedRuns = new Map<string, CaptureEnvelope[]>();

/** The browser's exportable object: the finished capture record for a run. */
export function getCompletedRun(runId: string): CaptureEnvelope[] | undefined {
    return completedRuns.get(runId);
}
/** All retained run ids, oldest → newest. */
export function listCompletedRuns(): string[] {
    return [...completedRuns.keys()];
}
/** Snapshot of every retained run (the replay UI's export). */
export function exportAllRuns(): Record<string, CaptureEnvelope[]> {
    return Object.fromEntries(completedRuns);
}
/** Drop all retained runs (tests / explicit UI reset). */
export function clearCompletedRuns(): void {
    completedRuns.clear();
}

/**
 * Dev-only diagnostic for the recorder's never-fatal catches. The non-fatal
 * contract is INTENTIONAL (instrumentation must never break emission) and every
 * catch below stays a swallow — but a totally silent failure made a broken sink
 * or a broken buildCaptureRecord unfindable even in dev (ultracode G6 finding).
 * Vite dev / vitest expose `import.meta.env.DEV`; plain Node has no
 * `import.meta.env`, so the optional chain keeps production + headless quiet.
 * The helper itself must never throw — it lives inside catch blocks.
 */
function devDebug(where: string, err: unknown): void {
    try {
        if ((import.meta as { env?: Record<string, unknown> }).env?.DEV) {
            console.debug(`[CaptureRecorder] non-fatal failure in ${where}:`, err);
        }
    } catch { /* diagnostics are best-effort by the same contract */ }
}

/**
 * Subscribes to a bus and, on `run_finished`, flushes the run's events into the
 * per-stage capture record: stores it in the bounded in-memory store (browser
 * export), mirrors it onto `window.__SKYCRUNCHER_CAPTURE__` when a window exists,
 * and invokes every registered sink (Node file writer). Fully non-fatal.
 */
export class CaptureRecorder {
    private buffer: PipelineEvent[] = [];
    private readonly unsubscribe: () => void;
    private readonly bus: PipelineEventBus;

    /**
     * FRAME_SHA WRITE-RACE BARRIER (DDIA population-gate must-fix). The content
     * hash is computed OFF the ingest hot path (async digest) and back-filled
     * onto the bus via `setRunContext({frameSha})`, so a fast run can reach
     * `run_finished` BEFORE the digest resolves. Flushing then would persist a
     * capture record whose `frame_sha` — the dedup / integrity key DB population
     * relies on — is null. This barrier holds the run_finished flush until the
     * digest has SETTLED, so nothing is stored / mirrored / sunk with a missing
     * hash.
     *
     * `frameShaSettled` defaults TRUE: when no producer arms the barrier (the
     * raw-bus unit tests, the queue_runner path that pre-hashes synchronously,
     * or a run with no source buffer ⇒ honest-absent), the flush stays fully
     * SYNCHRONOUS — byte-identical to the pre-fix behavior. Only `awaitFrameSha`
     * with a digest still in flight defers a flush.
     */
    private frameShaSettled = true;
    private frameShaBarrier: Promise<void> | null = null;
    private resolveFrameShaBarrier: (() => void) | null = null;

    constructor(bus: PipelineEventBus) {
        this.bus = bus;
        this.unsubscribe = bus.subscribe((e) => this.onEvent(e));
    }

    /**
     * Arm the write-race barrier with the frame-sha digest promise BEFORE the
     * run can finish (the producer calls this in its constructor, right where it
     * fires the digest). The barrier settles when the digest resolves OR rejects
     * (reject ⇒ honest-absent null — but the flush still provably WAITED for the
     * digest to settle first). Non-blocking: the digest itself never blocks
     * decode; only the instrumentation flush is deferred. Idempotent: a fresh
     * call re-arms for a new run on the same recorder.
     */
    awaitFrameSha(digest: Promise<unknown>): void {
        this.frameShaSettled = false;
        this.frameShaBarrier = new Promise<void>((resolve) => {
            this.resolveFrameShaBarrier = resolve;
        });
        const settle = (): void => {
            this.frameShaSettled = true;
            const resolve = this.resolveFrameShaBarrier;
            this.resolveFrameShaBarrier = null;
            if (resolve) resolve();
        };
        // Settle on BOTH fates; a digest failure is honest-absent, not a hang.
        digest.then(settle, settle);
    }

    private onEvent(e: PipelineEvent): void {
        try {
            if (e.kind === 'run_started') this.buffer = [];
            this.buffer.push(e);
            if (e.kind === 'run_finished') {
                // Snapshot NOW so a later run_started can never mutate this run's
                // events out from under a deferred flush.
                const events = this.buffer.slice();
                if (this.frameShaSettled || this.frameShaBarrier == null) {
                    this.flush(events); // settled (or never armed) ⇒ synchronous
                } else {
                    // BARRIER: hold the flush until the frame_sha digest settles,
                    // so no record is ever stored / sunk with a null dedup key.
                    this.frameShaBarrier.then(() => this.flush(events));
                }
            }
        } catch (err) {
            // Instrumentation must NEVER break emission (LAW: additive).
            devDebug('onEvent', err);
        }
    }

    private flush(events: PipelineEvent[]): void {
        try {
            const envelopes = buildCaptureRecord(events);
            // Overlay the SETTLED content hash from the run context. Events
            // emitted before the async digest resolved carry a null frame_sha
            // stamp, but the barrier guarantees the digest has settled by the
            // time this flush runs, so the bus holds the authoritative sha.
            // Back-fill any null envelope so the persisted dedup / integrity key
            // is never missing when the hash is in fact known.
            const settledSha = this.bus.getRunContext().frameSha ?? null;
            if (settledSha != null) {
                for (const env of envelopes) {
                    if (env.frame_sha == null) env.frame_sha = settledSha;
                }
            }
            const runId =
                envelopes.find(x => x.run_id)?.run_id ??
                events.find(e => e.runId)?.runId ??
                `run_${Date.now()}`;

            completedRuns.set(runId, envelopes);
            while (completedRuns.size > CAPTURE_RUNS_CAP) {
                const oldest = completedRuns.keys().next().value;
                if (oldest === undefined) break;
                completedRuns.delete(oldest);
            }

            // Browser replay mirror — a plain data object, guarded (no DOM).
            try {
                const g = globalThis as { window?: { __SKYCRUNCHER_CAPTURE__?: Record<string, CaptureEnvelope[]> } };
                if (typeof g.window !== 'undefined' && g.window) {
                    g.window.__SKYCRUNCHER_CAPTURE__ = g.window.__SKYCRUNCHER_CAPTURE__ || {};
                    g.window.__SKYCRUNCHER_CAPTURE__[runId] = envelopes;
                }
            } catch (err) {
                /* window mirror is best-effort */
                devDebug('window mirror', err);
            }

            for (const sink of sinks) {
                try {
                    sink(runId, envelopes, events);
                } catch (err) {
                    /* one sink's failure never breaks the run or other sinks */
                    devDebug('sink', err);
                }
            }
        } catch (err) {
            /* swallow: the recorder never disrupts the pipeline */
            devDebug('flush', err);
        }
    }

    /** Detach from the bus (session teardown / tests). */
    dispose(): void {
        try { this.unsubscribe(); } catch (err) { /* idempotent */ devDebug('dispose', err); }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FRAME SHA — cross-env content hash (browser SubtleCrypto + Node ≥18 global)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SHA-256 (lowercase hex) of a buffer using the platform WebCrypto — available
 * in browsers and Node ≥18 via `globalThis.crypto.subtle`, so no node:crypto
 * import (which would break the browser bundle). Returns null when unavailable
 * (honest-absent) rather than throwing. Async by design so ingest is never
 * blocked on a large frame's digest.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string | null> {
    try {
        const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
        if (!subtle) return null;
        const digest = await subtle.digest('SHA-256', buffer);
        const bytes = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return hex;
    } catch {
        return null;
    }
}
