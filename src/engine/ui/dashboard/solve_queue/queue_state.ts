/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE QUEUE — pure state machine (BULK INGESTOR, A2/R6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The "headless baked into the dashboard": a re-mappable-source bulk ingestor
 * that runs the REAL wizard pipeline per file SEQUENTIALLY (one fresh
 * OrchestratorSession each — the session releases its raw buffer after ingest
 * and step-1 re-entry is forbidden by design, so runs never share a session).
 *
 * This module is the PURE core — zero DOM, zero pipeline imports beyond the
 * ingestion format registry (the single source of truth for "what can this
 * instrument ingest?"). It owns the queue item model + the honest status
 * transitions; the runner (queue_runner.ts) drives sessions and the React pane
 * (SolveQueuePane.tsx) renders it. Kept pure so the state machine is unit-
 * testable under the node vitest env with no browser.
 *
 * HONEST-OR-ABSENT (LAW 3): a solved item carries its measured RA/scale/matched;
 * a failed/unsupported item carries an honest verdict string. Numbers are NEVER
 * placeholders — `result` is null until a real solution lands, `error` is null
 * until a real failure/unsupported verdict lands. There are no progress-percent
 * fabrications here (the UI shows real stage labels off the bus, not a fake bar).
 */

import { isSupportedFilename } from '../../../pipeline/m1_ingestion/format_registry';

/**
 * Honest per-file lifecycle. These are the QUEUE's OWN status strings — the
 * pipeline's `session.status` polled contract is load-bearing and untouched;
 * this vocabulary is additive and local to the ingestor pane.
 */
export type QueueItemStatus =
    | 'queued'       // accepted, waiting its turn (sequential — never parallel)
    | 'running'      // its session is stepping load→…→integrate right now
    | 'solved'       // reached a geometric lock; `result` populated
    | 'failed'       // ran but produced no lock (or a stage threw); `error` set
    | 'unsupported'; // extension not in the ingestion format registry; skipped honestly

/** The measured result line for a solved file (all real, from the PlateSolution). */
export interface QueueSolveResult {
    /** Plate-center RA in HOURS (internal convention — see UNIT TRAPS). */
    raHours: number;
    /** Plate-center Dec in degrees. */
    decDeg: number;
    /** Locked pixel scale, arcsec/px. */
    scaleArcsecPerPx: number;
    /** Catalog stars matched by the solver. */
    matched: number;
    /** Solver confidence [0,1]. */
    confidence: number;
}

export interface QueueItem {
    /** Stable id assigned at enqueue (monotonic within a queue instance). */
    id: string;
    /** Display name (source filename). */
    name: string;
    /** Byte size from the File/Blob/SourceFile (honest; 0 when unknown). */
    sizeBytes: number;
    /** Where this file came from (connector id) — provenance for the row. */
    sourceId: string;
    /** Detected ingestable format id once the runner sniffs bytes; null until then. */
    format: string | null;
    status: QueueItemStatus;
    /** Populated only on `solved` (LAW 3: null otherwise, never a placeholder). */
    result: QueueSolveResult | null;
    /** Populated only on `failed`/`unsupported` — honest verdict text. */
    error: string | null;
    /** Capture-record run id (stamped by the runner); null until it runs. */
    runId: string | null;
    /** Content SHA-256 (dedup / replay key); null until computed / unavailable. */
    frameSha: string | null;
    /** Live stage label off the bus while running (honest, real stage); null otherwise. */
    stageNote: string | null;
}

/** Aggregate tally for the pane header (honest counts, no fabrication). */
export interface QueueSummary {
    total: number;
    queued: number;
    running: number;
    solved: number;
    failed: number;
    unsupported: number;
}

/**
 * Build a fresh queue item from a filename + size. Classifies by EXTENSION
 * against the ingestion format registry — the runner later confirms via a
 * magic-byte sniff. An extension the registry does not know becomes
 * `unsupported` immediately (honest skip; the pipeline would only reject it
 * later with a "non-sensor file" warning, so we never enqueue false hope).
 */
export function createQueueItem(
    id: string,
    name: string,
    sizeBytes: number,
    sourceId: string,
): QueueItem {
    const supported = isSupportedFilename(name);
    return {
        id,
        name,
        sizeBytes,
        sourceId,
        format: null,
        status: supported ? 'queued' : 'unsupported',
        result: null,
        error: supported ? null : 'Unsupported format (not an ingestable science file)',
        runId: null,
        frameSha: null,
        stageNote: null,
    };
}

/** Immutably patch one item by id (no-op when id is absent). */
export function patchItem(
    items: readonly QueueItem[],
    id: string,
    patch: Partial<QueueItem>,
): QueueItem[] {
    return items.map((it) => (it.id === id ? { ...it, ...patch } : it));
}

/** Transition an item into `running`, stamping its capture-record identity. */
export function markRunning(
    items: readonly QueueItem[],
    id: string,
    ctx: { runId: string; frameSha: string | null; format: string | null },
): QueueItem[] {
    return patchItem(items, id, {
        status: 'running',
        runId: ctx.runId,
        frameSha: ctx.frameSha,
        format: ctx.format,
        result: null,
        error: null,
        stageNote: null,
    });
}

/** Update the live stage note of a running item (honest real stage label). */
export function setStageNote(items: readonly QueueItem[], id: string, note: string): QueueItem[] {
    return patchItem(items, id, { stageNote: note });
}

/** Transition an item into `solved` with its measured result line. */
export function markSolved(items: readonly QueueItem[], id: string, result: QueueSolveResult): QueueItem[] {
    return patchItem(items, id, { status: 'solved', result, error: null, stageNote: null });
}

/** Transition an item into `failed` with an honest verdict string. */
export function markFailed(items: readonly QueueItem[], id: string, error: string): QueueItem[] {
    return patchItem(items, id, { status: 'failed', result: null, error, stageNote: null });
}

/** The id of the first item still `queued`, or null when the queue is drained. */
export function nextQueuedId(items: readonly QueueItem[]): string | null {
    for (const it of items) if (it.status === 'queued') return it.id;
    return null;
}

/** True when no item is `queued` or `running` (the runner may stop). */
export function isQueueDrained(items: readonly QueueItem[]): boolean {
    for (const it of items) if (it.status === 'queued' || it.status === 'running') return false;
    return true;
}

/** Honest aggregate tally for the pane header. */
export function queueSummary(items: readonly QueueItem[]): QueueSummary {
    const s: QueueSummary = { total: items.length, queued: 0, running: 0, solved: 0, failed: 0, unsupported: 0 };
    for (const it of items) s[it.status] += 1;
    return s;
}

/**
 * Extract the honest result line from a solved PlateSolution. Mirrors the
 * `solution_locked` finding's field derivation (matched_stars length, with the
 * diagnostics fallback) so the queue row matches what the flowchart reports.
 */
export interface SolutionLike {
    ra_hours: number;
    dec_degrees: number;
    pixel_scale: number;
    confidence: number;
    matched_stars?: { length: number } | null;
    diagnostics?: { stars_matched?: number } | null;
}

export function resultFromSolution(sol: SolutionLike): QueueSolveResult {
    return {
        raHours: sol.ra_hours,
        decDeg: sol.dec_degrees,
        scaleArcsecPerPx: sol.pixel_scale,
        matched: sol.matched_stars?.length ?? sol.diagnostics?.stars_matched ?? 0,
        confidence: sol.confidence,
    };
}

/**
 * ─── SOLVE QUEUE → LIVE-STACK SIDECAR (Solve Queue emits, live_stack consumes) ───
 *
 * A solved queue item writes this JSON next to its source frame as
 * `<frameBasename>.solve.json` (desktop only — see SolveQueuePane). The live-stack
 * follower's acceptance gate reads EXACTLY these fields and re-stacks a frame only
 * when `accepted === true`:
 *
 *   tools/stack/live_stack.mjs:126-142 (`acceptedSolve`) + its bound-contract
 *   comment at 126-129: `{ accepted:true, raHours, decDeg, scaleArcsecPerPx,
 *   matched, confidence }` — "mirrors QueueSolveResult". The `frame` basename is
 *   provenance, matching the mockproof sidecar shape (live_stack_mockproof.mjs:112).
 *
 * Every number is a MEASURED PlateSolution value carried on the QueueSolveResult;
 * this is only ever built for a genuinely `solved` item (LAW 3 — never a
 * placeholder, `accepted` is a literal `true`, never a fabricated pass).
 */
export interface SolveSidecar {
    /** Literal true — the live-stack gate accepts a frame ONLY when this is true. */
    accepted: true;
    /** Source frame basename (provenance; mirrors the mockproof sidecar). */
    frame: string;
    raHours: number;
    decDeg: number;
    scaleArcsecPerPx: number;
    matched: number;
    confidence: number;
}

/** Build the live-stack acceptance sidecar from a solved queue result (pure). */
export function buildSolveSidecar(frameName: string, result: QueueSolveResult): SolveSidecar {
    return {
        accepted: true,
        frame: frameName,
        raHours: result.raHours,
        decDeg: result.decDeg,
        scaleArcsecPerPx: result.scaleArcsecPerPx,
        matched: result.matched,
        confidence: result.confidence,
    };
}
