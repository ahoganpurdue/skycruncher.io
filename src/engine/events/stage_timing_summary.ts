/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAGE TIMING SUMMARY — per-run rollup of the per-stage wall-clock timings
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The event bus (`pipeline_events.ts`) already emits `stage_finished{ms}` for
 * every stage (the `ms` is measured by `withStage` in orchestrator_session — a
 * `Date.now()` delta the run ALREADY computes). Efficiency review I1/I2
 * (`test_results/efficiency_review_2026-07-10/EFFICIENCY_REVIEW.md`) flagged
 * that this timing is "COMPUTED every run then DISCARDED" — no substrate ever
 * persisted a per-substage number, so every perf claim in the repo is
 * INFERRED/structural rather than clocked. This module is the fold that turns
 * the ephemeral event stream into ONE durable summary line per run.
 *
 * DESIGN CONSTRAINTS (mirror the bus + capture record):
 *   - PURE + BROWSER-SAFE: no DOM, no `node:fs`, no I/O. The Node consumer
 *     (`tools/api/headless_driver.ts`) and the e2e harness persist it; this
 *     module only computes. Keeping the fold here (engine `events/`) is the
 *     "emit-inside-stages" discipline — the timing is derived where the events
 *     are defined, not in an orchestrator or a tools lane.
 *   - O(events) BOOKKEEPING: a single linear pass over already-stamped events.
 *     ZERO per-pixel cost — the hot path never feeds this (LAW: charts never
 *     touch the hot path). It reads timestamps the run already produced.
 *   - RECEIPT-INERT: the summary is a SIDECAR. It is never folded into the
 *     receipt (receipts stay IEEE byte-identical; the api-smoke gate pins them
 *     exactly). Timings live in `test_results/perf/stage_timings.jsonl`.
 *   - HONEST-OR-ABSENT (LAW 3): an incomplete run (no `run_finished`) yields
 *     `ok=null` / `total_ms=null`, never a fabricated number.
 */

import type { PipelineEvent } from './pipeline_events';

/**
 * Bump when the on-disk line shape changes so a consumer can tell a v1 line
 * from a later one (the JSONL is append-only across sessions).
 */
export const STAGE_TIMING_SCHEMA_VERSION = 1;

/**
 * The per-run timing summary — the payload of one `stage_timings.jsonl` line.
 * The PERSISTING consumer adds context-specific `ts` (persist time) and
 * `source` (`headless` / `e2e:<scenario>`) around this object; those are not
 * part of the pure fold because they describe the writer, not the run.
 */
export interface StageTimingSummary {
    /** Schema version of this summary shape. */
    v: number;
    /** Run grouping key (promoted session id). null when never stamped. */
    run_id: string | null;
    /** Content SHA-256 of the source frame (dedup key). null = honestly unhashed. */
    frame_sha: string | null;
    /** Source frame format (`FITS` / `CR2` / …) from `run_started`. null when absent. */
    source_format: string | null;
    /** RAW decode arm in effect for this run (`rawler` / `libraw` / caller value). */
    decoder_arm: string;
    /** Did the run reach the success path (`run_finished.ok`)? null = never finished. */
    ok: boolean | null;
    /** Number of distinct stages that reported a `stage_finished`. */
    n_stages: number;
    /**
     * Total wall span of the run in ms: `max(stage_end) − min(stage_start)`
     * across all finished stages, where `stage_start = stage_finished.t − ms`.
     * This SPAN basis (not the sum of stage ms) is used so nested stages — the
     * calibrate umbrella wrapping psf_field / bc_rematch / forced_confirm — are
     * NOT double-counted, and so the browser (envelopes) and headless (events)
     * consumers compute an identical, comparable total. null when < 1 stage.
     */
    total_ms: number | null;
    /**
     * Per-stage duration map: stable `stage_id` → measured ms (`stage_finished.ms`).
     * Includes nested stages as distinct keys (richer than a top-level-only view).
     * Last write wins if a stage id repeats within a run.
     */
    stages: Record<string, number>;
}

/** Extra context the caller injects (the ambient config the event stream lacks). */
export interface StageTimingMeta {
    /** RAW decode arm — the caller reads `isRawlerDecoderEnabled()` and passes the label. */
    decoderArm: string;
}

/**
 * Fold a run's event stream into a single {@link StageTimingSummary} (pure).
 *
 * Linear pass:
 *   - `run_started`   → source_format (+ implicit run bracket)
 *   - `run_finished`  → ok
 *   - `stage_finished`→ stages[stage] = ms, and span endpoints (start = t − ms)
 *   - run_id: first non-null `runId` stamp; frame_sha: LAST non-null (async back-fill).
 *
 * Consumers persist the returned object as one JSONL line. Returns a summary
 * even for a partial/empty stream (honest nulls) so a crashed run is still
 * recorded rather than silently dropped.
 */
export function summarizeStageTimings(
    events: readonly PipelineEvent[],
    meta: StageTimingMeta,
): StageTimingSummary {
    let runId: string | null = null;
    let frameSha: string | null = null;
    let sourceFormat: string | null = null;
    let ok: boolean | null = null;
    const stages: Record<string, number> = {};
    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;
    let nStages = 0;

    for (const e of events) {
        if (runId == null && e.runId != null) runId = e.runId;
        if (e.frameSha != null) frameSha = e.frameSha; // async back-fill: last non-null wins

        if (e.kind === 'run_started') {
            if (e.sourceFormat != null) sourceFormat = e.sourceFormat;
        } else if (e.kind === 'run_finished') {
            ok = e.ok;
        } else if (e.kind === 'stage_finished') {
            if (!(e.stage in stages)) nStages++;
            stages[e.stage] = e.ms;
            const end = e.t;
            const start = e.t - e.ms;
            if (start < minStart) minStart = start;
            if (end > maxEnd) maxEnd = end;
        }
    }

    const total_ms = nStages > 0 && Number.isFinite(minStart) && Number.isFinite(maxEnd)
        ? maxEnd - minStart
        : null;

    return {
        v: STAGE_TIMING_SCHEMA_VERSION,
        run_id: runId,
        frame_sha: frameSha,
        source_format: sourceFormat,
        decoder_arm: meta.decoderArm,
        ok,
        n_stages: nStages,
        total_ms,
        stages,
    };
}
