/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE QUEUE — sequential runner (drives the REAL pipeline, one file at a time)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs the REAL wizard pipeline per file, NEVER in parallel (solves are
 * memory-heavy and the sacred byte-identity assumes an undisturbed run). Each
 * file gets a FRESH OrchestratorSession (step-1 re-entry is forbidden by design
 * — the session releases its raw buffer after ingest), stepped
 * load→extract→metrology→solve→calibrate→integrate exactly as
 * tools/api/headless_driver.ts does in Node — this is the browser lane.
 *
 * CAPTURE / REPLAY (mission point 3): the session already stamps
 * `setRunContext({runId})` + attaches a CaptureRecorder in its constructor, so a
 * SOLVED run flushes to the in-memory capture store on step6's `run_finished`
 * and is immediately replayable + feeds flowchart stats. We additionally:
 *   (a) re-stamp a STABLE, frame-sha-derived runId + the frameSha BEFORE step1,
 *       so the very first event carries them (no async back-fill gap); and
 *   (b) for a FAILED/partial run — step5_Calibrate throws when the solve found
 *       no lock, so step6 never fires — emit a synthetic `run_finished{ok:false}`
 *       on the session's PUBLIC bus so the (partial) run is ALSO captured and
 *       replayable. This consumes the bus + capture_record; it never forks them
 *       and never touches orchestrator_session, so the pinned solves stay
 *       byte-identical (this path runs ONLY in the queue, never the wizard).
 *
 * Testability: the session factory + sha fn are injected, so the sequential
 * state machine is exercised with a fake session under the node vitest env — no
 * wasm, no atlas, no browser.
 */

import {
    type QueueItem,
    type QueueSolveResult,
    type SolutionLike,
    markRunning,
    markSolved,
    markFailed,
    setStageNote,
    nextQueuedId,
    resultFromSolution,
} from './queue_state';

/** The minimal slice of OrchestratorSession the runner drives (keeps it decoupled + fakeable). */
export interface RunnerSession {
    readonly events: {
        setRunContext: (ctx: { runId?: string; frameSha?: string | null }) => void;
        subscribe: (fn: (e: { kind: string; label?: string; stage?: string }) => void) => () => void;
        emit: (e: { kind: string; ok?: boolean }) => unknown;
    };
    readonly solution: SolutionLike | null;
    readonly status: string;
    readonly sourceFormat: string;
    step1_Load: () => Promise<unknown>;
    step2_Extract: (overrides?: unknown) => Promise<unknown>;
    step3_Metrology: () => Promise<unknown>;
    step4_Solve: () => Promise<unknown>;
    step5_Calibrate: () => Promise<unknown>;
    step6_Integrate: () => Promise<unknown>;
}

export interface RunnerDeps {
    /** Construct a fresh session for a source buffer (real: new OrchestratorSession). */
    createSession: (buffer: ArrayBuffer) => RunnerSession | Promise<RunnerSession>;
    /** Content SHA-256 of the frame (real: capture_record.sha256Hex). null-safe. */
    computeSha: (buffer: ArrayBuffer) => Promise<string | null>;
    /** Clock injection (tests). */
    now?: () => number;
}

/** The outcome of a single file run (one row's terminal state). */
export interface RunOneOutcome {
    status: 'solved' | 'failed';
    runId: string;
    frameSha: string | null;
    format: string | null;
    result: QueueSolveResult | null;
    error: string | null;
}

/** Live progress hooks for the pane (all optional; pure logic never needs them). */
export interface RunHooks {
    /** Fired when a file transitions to running (runId/frameSha/format known). */
    onStart?: (ctx: { runId: string; frameSha: string | null; format: string | null }) => void;
    /** Fired on each real stage_started — carries the honest stage label (no fabrication). */
    onStage?: (note: string) => void;
    /** Fired on the terminal outcome. */
    onDone?: (outcome: RunOneOutcome) => void;
}

/** Derive a stable, frame-content-keyed run id (falls back to the clock when unhashed). */
export function deriveRunId(frameSha: string | null, now: () => number): string {
    return `queue_${frameSha ? frameSha.slice(0, 12) : String(now())}`;
}

function messageOf(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err ?? 'unknown error');
}

/**
 * Run ONE file end-to-end. Resolves with the terminal outcome; NEVER rejects
 * (a thrown stage becomes a `failed` outcome) so the sequential loop can not be
 * derailed by one bad frame. Emits a synthetic `run_finished{ok:false}` for any
 * run that does not reach step6, so every file is captured + replayable.
 */
export async function runOneFile(
    buffer: ArrayBuffer,
    deps: RunnerDeps,
    hooks?: RunHooks,
): Promise<RunOneOutcome> {
    const now = deps.now ?? Date.now;
    let frameSha: string | null = null;
    try {
        frameSha = await deps.computeSha(buffer);
    } catch {
        frameSha = null; // honest-unhashed; not fatal
    }
    const runId = deriveRunId(frameSha, now);

    const session = await deps.createSession(buffer);
    session.events.setRunContext({ runId, frameSha });

    // Surface REAL stage labels off the bus (honest progress — no percent bar).
    const off = session.events.subscribe((e) => {
        if (e.kind === 'stage_started') hooks?.onStage?.(e.label ?? e.stage ?? 'working');
    });

    let reachedIntegrate = false;
    let error: string | null = null;
    try {
        hooks?.onStart?.({ runId, frameSha, format: null });
        await session.step1_Load();
        await session.step2_Extract();
        await session.step3_Metrology();
        await session.step4_Solve();
        // step5 throws when there is no lock — gate on the honest solution first.
        if (session.solution) {
            await session.step5_Calibrate();
            await session.step6_Integrate(); // emits run_finished{ok:true}
            reachedIntegrate = true;
        }
    } catch (err) {
        error = messageOf(err);
    } finally {
        off();
    }

    const format = session.sourceFormat && session.sourceFormat !== 'UNKNOWN' ? session.sourceFormat : null;

    let outcome: RunOneOutcome;
    if (reachedIntegrate && session.solution) {
        outcome = { status: 'solved', runId, frameSha, format, result: resultFromSolution(session.solution), error: null };
    } else {
        // Failed / partial: emit run_finished so the capture record flushes and
        // the run is replayable (step6 never ran). PUBLIC bus API — never forks
        // capture_record, never mutates the solve.
        try { session.events.emit({ kind: 'run_finished', ok: false }); } catch { /* non-fatal */ }
        const verdict = error ?? (session.status || 'Plate solve failed — no geometric lock.');
        outcome = { status: 'failed', runId, frameSha, format, result: null, error: verdict };
    }

    hooks?.onDone?.(outcome);
    return outcome;
}

/** Callback the queue-processing loop uses to publish each item-state transition. */
export type QueueUpdate = (items: QueueItem[]) => void;

/**
 * Fired AFTER an item transitions to `solved` (post-publish), carrying the
 * freshly-solved item + its measured result. The pane uses it to emit the
 * live-stack acceptance sidecar next to the frame (desktop only). A throwing or
 * slow callback NEVER derails the sequential loop — its result is caught and
 * discarded (the solve is already committed; a side-effect can only be additive).
 */
export type QueueSolvedHook = (item: QueueItem, result: QueueSolveResult) => void | Promise<void>;

/**
 * Process a whole queue SEQUENTIALLY: pick the next `queued` item, read its
 * bytes lazily, run it, publish transitions, repeat until drained. Returns the
 * final item array. A `shouldStop` predicate lets the pane cancel between files
 * (never mid-solve — we do not interrupt a running session). `onSolved` fires
 * once per solved item for additive side-effects (e.g. the live-stack sidecar).
 */
export async function processQueue(
    initial: readonly QueueItem[],
    readBuffer: (item: QueueItem) => Promise<ArrayBuffer>,
    deps: RunnerDeps,
    publish: QueueUpdate,
    shouldStop?: () => boolean,
    onSolved?: QueueSolvedHook,
): Promise<QueueItem[]> {
    let items = [...initial];
    for (;;) {
        if (shouldStop?.()) break;
        const id = nextQueuedId(items);
        if (id == null) break;
        const item = items.find((it) => it.id === id)!;

        let buffer: ArrayBuffer;
        try {
            buffer = await readBuffer(item);
        } catch (err) {
            items = markFailed(items, id, `Could not read source: ${messageOf(err)}`);
            publish(items);
            continue;
        }

        const outcome = await runOneFile(buffer, deps, {
            onStart: (ctx) => {
                items = markRunning(items, id, ctx);
                publish(items);
            },
            onStage: (note) => {
                items = setStageNote(items, id, note);
                publish(items);
            },
        });

        items =
            outcome.status === 'solved'
                ? markSolved(items, id, outcome.result!)
                : markFailed(items, id, outcome.error ?? 'failed');
        // Ensure the runId/frameSha stamped at start survive the terminal patch.
        items = items.map((it) => (it.id === id ? { ...it, runId: outcome.runId, frameSha: outcome.frameSha, format: outcome.format } : it));
        publish(items);

        // Additive side-effect on a genuine solve (never blocks/derails the loop).
        if (outcome.status === 'solved' && outcome.result && onSolved) {
            const solvedItem = items.find((it) => it.id === id)!;
            try {
                await onSolved(solvedItem, outcome.result);
            } catch { /* sidecar/side-effect failure must never fail the solve */ }
        }
    }
    return items;
}
