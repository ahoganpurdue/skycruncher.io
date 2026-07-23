/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPLAY STATE — pure scrub math for the ★ Replay Dashboard (wave 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Given a run's per-stage capture record (CaptureEnvelope[], wave-1 substrate)
 * and a scrub time `t` (epoch ms), derive the "state at time t": which stages
 * are complete / active / pending, elapsed ms, verdicts so far, and the
 * time-filtered record slice. This is the contract the time-slider scrubs and
 * that widgets in dashboard panes consume (see ReplayContext + WidgetSlot).
 *
 * PURITY (LAW: the scrub math is pure, unit-tested without a DOM):
 *   - No React, no window, no Date.now — every output is a pure function of
 *     (envelopes, t). The React layer owns the clock; this owns the math.
 *
 * HONEST-OR-ABSENT (LAW 3):
 *   - A stage not yet reached at `t` is `pending` with a null verdict — NEVER a
 *     fabricated timing. A verdict the emitter never surfaced stays null. We do
 *     not interpolate durations or invent counts between events.
 *
 * WAVE-2 CONTRACT: the flowchart widget consumes `ReplayFrame.stages` to light
 * its boxes during replay — a stage's `phase` drives box color, `verdict`/`ok`
 * its pass/fail state, `counts` its hover data. `recordSlice` is the set of
 * envelopes already complete at `t` (safe to aggregate). Keep this shape stable.
 */

import type { CaptureEnvelope } from '../../../events/capture_record';
import type { PipelineEvent, StageVerdict } from '../../../events/pipeline_events';

/** A stage's lifecycle phase relative to the scrub position. */
export type ReplayStagePhase = 'pending' | 'active' | 'complete';

/** Per-stage state at a scrub time — the flowchart's per-box input (wave 2). */
export interface ReplayStageState {
    /** Stable stage id (the flowchart node id). */
    stageId: string;
    /** Ordering key: seq of the closing `stage_finished`. */
    seq: number;
    /** Phase at the scrub time. */
    phase: ReplayStagePhase;
    /** Absolute stage window (epoch ms). */
    tStart: number;
    tEnd: number;
    /**
     * The full envelope, always present (the record is known up-front — only the
     * PHASE moves with the scrub). Widgets should gate detail rendering on
     * `phase === 'complete'` to honour the replay illusion.
     */
    envelope: CaptureEnvelope;
    /** Honest verdict once complete; null before completion or when unmeasured. */
    verdict: StageVerdict | null;
    /** Emitter-authoritative duration (ms). Revealed only once complete. */
    ms: number | null;
    /** Did the stage succeed. null until complete. */
    ok: boolean | null;
    /** Integer counts surfaced for the flowchart. Empty until complete. */
    counts: Record<string, number>;
    /** Honest degradation notices in this stage's window. Empty until complete. */
    warnings: string[];
}

/** The full derived state at a scrub time — the time-slice contract. */
export interface ReplayFrame {
    /** Run grouping key. null when the record never stamped one. */
    runId: string | null;
    /** Frame content hash (dedup key). null = honestly unhashed. */
    frameSha: string | null;
    /** Absolute scrub time (epoch ms), clamped into the run window. */
    t: number;
    /** t − runStart, clamped to [0, totalMs]. */
    elapsedMs: number;
    /** Full run wall-clock duration (runEnd − runStart). 0 for an empty record. */
    totalMs: number;
    /** Absolute run window (epoch ms). Both 0 for an empty record. */
    tStart: number;
    tEnd: number;
    /** Every stage with its phase at `t`, sorted by tStart then seq. */
    stages: ReplayStageState[];
    /** Envelopes complete at `t` (t_end ≤ t) — the aggregatable slice. */
    recordSlice: CaptureEnvelope[];
    /** Whether the scrub is pinned to the live tail (React sets this). */
    live: boolean;
    /** Convenience tallies (== stages filtered by phase). */
    completeCount: number;
    activeCount: number;
    pendingCount: number;
}

/** Absolute run window from a capture record (pure). Empty ⇒ all zeros. */
export function runTimeBounds(envelopes: readonly CaptureEnvelope[]): {
    tStart: number;
    tEnd: number;
    totalMs: number;
} {
    if (envelopes.length === 0) return { tStart: 0, tEnd: 0, totalMs: 0 };
    let tStart = Infinity;
    let tEnd = -Infinity;
    for (const e of envelopes) {
        if (e.t_start < tStart) tStart = e.t_start;
        if (e.t_end > tEnd) tEnd = e.t_end;
    }
    return { tStart, tEnd, totalMs: Math.max(0, tEnd - tStart) };
}

/** Phase of a single stage window at time `t` (pure). */
export function stagePhaseAt(env: CaptureEnvelope, t: number): ReplayStagePhase {
    if (t < env.t_start) return 'pending';
    // A zero-width window (t_start == t_end) is complete the instant it is reached.
    if (t >= env.t_end) return 'complete';
    return 'active';
}

/** Clamp a scrub time into a run's window. */
export function clampScrub(t: number, bounds: { tStart: number; tEnd: number }): number {
    if (bounds.tEnd <= bounds.tStart) return bounds.tStart;
    if (t < bounds.tStart) return bounds.tStart;
    if (t > bounds.tEnd) return bounds.tEnd;
    return t;
}

/** First stamped run id / last non-null frame sha (mirrors buildCaptureRecord). */
function recordIdentity(envelopes: readonly CaptureEnvelope[]): {
    runId: string | null;
    frameSha: string | null;
} {
    let runId: string | null = null;
    let frameSha: string | null = null;
    for (const e of envelopes) {
        if (runId == null && e.run_id != null) runId = e.run_id;
        if (e.frame_sha != null) frameSha = e.frame_sha;
    }
    return { runId, frameSha };
}

/**
 * Derive the full replay state at scrub time `t` from a capture record (PURE).
 *
 * `t` is clamped into the run window first. Stages are returned sorted by
 * tStart then seq (wall-clock order — the record itself is ordered by the
 * closing seq, which can differ for nested umbrellas like `calibrate`).
 */
export function deriveReplayFrame(
    envelopes: readonly CaptureEnvelope[],
    t: number,
    opts: { live?: boolean } = {},
): ReplayFrame {
    const { tStart, tEnd, totalMs } = runTimeBounds(envelopes);
    const { runId, frameSha } = recordIdentity(envelopes);
    const scrub = clampScrub(t, { tStart, tEnd });

    const stages: ReplayStageState[] = envelopes
        .map((env): ReplayStageState => {
            const phase = stagePhaseAt(env, scrub);
            const complete = phase === 'complete';
            return {
                stageId: env.stage_id,
                seq: env.seq,
                phase,
                tStart: env.t_start,
                tEnd: env.t_end,
                envelope: env,
                verdict: complete ? env.verdict : null,
                ms: complete ? env.ms : null,
                ok: complete ? env.ok : null,
                counts: complete ? env.counts : {},
                warnings: complete ? env.warnings : [],
            };
        })
        .sort((a, b) => (a.tStart - b.tStart) || (a.seq - b.seq));

    const recordSlice = envelopes.filter(e => e.t_end <= scrub);

    let completeCount = 0;
    let activeCount = 0;
    let pendingCount = 0;
    for (const s of stages) {
        if (s.phase === 'complete') completeCount++;
        else if (s.phase === 'active') activeCount++;
        else pendingCount++;
    }

    return {
        runId,
        frameSha,
        t: scrub,
        elapsedMs: Math.max(0, scrub - tStart),
        totalMs,
        tStart,
        tEnd,
        stages,
        recordSlice,
        live: opts.live ?? false,
        completeCount,
        activeCount,
        pendingCount,
    };
}

/**
 * Time-filter a raw pipeline event history to `t` (events with `e.t <= t`).
 * Event-driven widget selectors receive THIS slice so they re-derive as the
 * scrub advances (a widget reading `bus.getHistory()` sees only what "had
 * happened" by the scrub time). Pure.
 */
export function sliceEventsAtTime(
    events: readonly PipelineEvent[] | undefined,
    t: number,
): readonly PipelineEvent[] | undefined {
    if (!events) return undefined;
    return events.filter(e => e.t <= t);
}
