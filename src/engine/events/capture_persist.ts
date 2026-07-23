/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAPTURE PERSISTENCE — durable localStorage retention of completed runs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `capture_record.ts` retains completed runs in a bounded IN-MEMORY ring (lost on
 * reload). The ★ solve-flowchart's local aggregate should span EVERY run this
 * box has seen — across reloads and sessions — so this module mirrors each
 * completed run into a versioned localStorage blob (A4 item 2). It is a pure
 * CONSUMER of the capture pipeline (registers a sink; reads the in-memory store)
 * — it never touches capture-record EMISSION or the solve.
 *
 * SUBSTRATE: `capture_aggregate.ts` still owns the dedup-by-frame_sha math; this
 * module only ENUMERATES/LOADS the persisted records that feed that math, keeping
 * `capture_aggregate.ts` pure (no I/O).
 *
 * DISCIPLINE:
 *   - VERSIONED (`widget_persist`): a schema bump invalidates a stale blob
 *     instead of crashing the aggregate.
 *   - BOUNDED (`PERSIST_RUNS_CAP`): a long-lived box can't grow the blob without
 *     limit; oldest runs are dropped first (insertion order).
 *   - NON-FATAL: every storage touch is guarded — persistence never disrupts a
 *     solve, and a corrupt blob degrades to an empty sample (⇒ NOT MEASURED),
 *     never a throw (LAW 3).
 */

import type { CaptureEnvelope } from './capture_record';
import { registerCaptureSink, exportAllRuns } from './capture_record';
import { readVersioned, writeVersioned, clearKey } from '../ui/widgets/widget_persist';

/** Versioned key for the persisted run map (namespaced with the dock/dashboard surface). */
export const CAPTURE_PERSIST_KEY = 'skycruncher.capture.runs';
/** Bump to invalidate every persisted capture blob (schema migration / cleanup). */
export const CAPTURE_PERSIST_VERSION = 1;
/** Max distinct runs retained on disk (oldest dropped first). */
export const PERSIST_RUNS_CAP = 60;

/** On-disk shape: runId → its per-stage capture record. */
export type PersistedRunMap = Record<string, CaptureEnvelope[]>;

/** Structural guard: a plain object whose every value is an array (defensive). */
function isPersistedRunMap(x: unknown): x is PersistedRunMap {
    if (x == null || typeof x !== 'object' || Array.isArray(x)) return false;
    for (const v of Object.values(x as Record<string, unknown>)) {
        if (!Array.isArray(v)) return false;
    }
    return true;
}

/** Read the persisted run map (empty on absence / stale version / corruption). */
export function loadPersistedRunMap(): PersistedRunMap {
    return readVersioned<PersistedRunMap>(CAPTURE_PERSIST_KEY, CAPTURE_PERSIST_VERSION, isPersistedRunMap) ?? {};
}

/**
 * Enumerate every locally-persisted run as `CaptureEnvelope[][]` — the exact
 * input shape `aggregateCaptureRuns` folds. Empty when nothing is persisted
 * (⇒ the flowchart shows NOT MEASURED per box).
 */
export function loadAllPersistedRuns(): CaptureEnvelope[][] {
    return Object.values(loadPersistedRunMap()).filter(envs => envs.length > 0);
}

/**
 * Persist one completed run (idempotent per runId — the freshest record wins and
 * moves to the tail). Bounded: drops the oldest runs beyond the cap. No-op for an
 * empty run or a missing id.
 */
export function persistRun(runId: string | null | undefined, envelopes: readonly CaptureEnvelope[]): void {
    if (!runId || envelopes.length === 0) return;
    const map = loadPersistedRunMap();
    delete map[runId];                    // re-insert so the updated run is freshest (tail)
    map[runId] = envelopes.slice();
    const keys = Object.keys(map);
    if (keys.length > PERSIST_RUNS_CAP) {
        for (const k of keys.slice(0, keys.length - PERSIST_RUNS_CAP)) delete map[k]; // drop oldest (front)
    }
    writeVersioned(CAPTURE_PERSIST_KEY, CAPTURE_PERSIST_VERSION, map);
}

/** Drop every persisted run (explicit reset / tests). */
export function clearPersistedRuns(): void {
    clearKey(CAPTURE_PERSIST_KEY);
}

// ─── sink install (browser wiring) ──────────────────────────────────────────

let installed = false;

/**
 * Register a capture sink that mirrors each completed run to localStorage, and
 * BACKFILL any runs already completed in-memory before this mounted (so the
 * first wizard solve — which finishes before the post-solve dashboard mounts —
 * is captured too). Idempotent: repeated calls (dock + dashboard both mounting)
 * install exactly one sink. Returns an unsubscribe that resets the guard.
 */
export function installCapturePersistSink(): () => void {
    if (installed) return () => { /* already installed elsewhere */ };
    installed = true;
    // Backfill the in-memory ring (runs completed before this sink existed).
    try {
        for (const [runId, envs] of Object.entries(exportAllRuns())) persistRun(runId, envs);
    } catch {
        /* in-memory store unavailable — nothing to backfill */
    }
    const off = registerCaptureSink((runId, envelopes) => {
        try { persistRun(runId, envelopes); } catch { /* never break a run */ }
    });
    return () => { installed = false; off(); };
}
