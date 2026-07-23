/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAPTURE AGGREGATE — per-stage / per-edge statistics over many capture records
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ★ solve-flowchart wave-2 substrate. `capture_record.ts` turns one run's
 * event stream into a per-stage JSONL. THIS module folds MANY such records into
 * the flowchart's hover statistics:
 *   - box hover  → the stage's representative verdict/counts/receipt-block
 *   - arrow hover → timing range (fastest → average → slowest SUCCESSFUL solve)
 *                   + % / count failing AT the stage vs passing through.
 *
 * OWNER-MANDATED DEDUP (spec §0): multiple runs of ONE frame must not skew the
 * stats. Dedup unit = frame content hash (`frame_sha`). All runs of a frame
 * collapse to its LATEST run; a `null` sha (browser upload / bundled frame — no
 * hash at solve time) is NOT deduped (each such run counts distinct, flagged via
 * `unhashed_count`).
 *
 * Honest-or-absent (LAW 3): a stage with no timing sample yields `null`
 * min/avg/max — the consumer renders "NOT MEASURED", never a placeholder.
 *
 * PURE + headless: Math only, no DOM, no I/O — node-unit-testable.
 */

import type { CaptureEnvelope } from './capture_record';
import type { StageVerdict } from './pipeline_events';

/** Per-stage rollup across the DEDUPED frame sample. */
export interface StageStat {
    stage_id: string;
    /** Deduped frames whose run reached (emitted an envelope for) this stage. */
    reached: number;
    /** Of `reached`, how many succeeded here (ok === true). */
    passed: number;
    /** Of `reached`, how many failed here (ok === false). */
    failed: number;
    /** Timing over SUCCESSFUL-solve frames only (ms). null ⇒ no sample (NOT MEASURED). */
    min_ms: number | null;
    avg_ms: number | null;
    max_ms: number | null;
    /** How many successful-solve frames contributed a timing sample. */
    timing_samples: number;
    /** Representative outcome — from the most-recent frame that has this stage. */
    verdict: StageVerdict | null;
    counts: Record<string, number>;
    payload_ref: string | null;
}

/** The whole-sample rollup consumed by the flowchart widget. */
export interface FlowchartAggregate {
    /** Raw runs supplied (before dedup). */
    run_count: number;
    /** Distinct frames (dedup units) after collapsing repeat runs by content hash. */
    frame_count: number;
    /** Deduped frames whose sha was null (unhashed — counted distinct, never merged). */
    unhashed_count: number;
    /** Deduped frames whose run ran to completion (reached `integrate` ok). */
    successful_frames: number;
    /** Per-stage rollup keyed by stage_id. */
    stages: Record<string, StageStat>;
}

/** One run reduced to metadata + a per-stage view (last envelope wins per stage). */
interface RunView {
    runId: string;
    frameSha: string | null;
    /** Ordering key: run completion time (latest run of a frame wins the dedup). */
    ts: number;
    /** stage_id → the run's authoritative envelope for that stage (max seq). */
    byStage: Map<string, CaptureEnvelope>;
    /** Ran to completion (integrate ok) ⇒ eligible for the "successful solve" timing sample. */
    succeeded: boolean;
}

/** Reduce a single run's envelopes to a RunView (collapsing dup stage rows). */
function toRunView(envs: readonly CaptureEnvelope[], idx: number): RunView | null {
    if (envs.length === 0) return null;

    let frameSha: string | null = null;
    let ts = 0;
    const byStage = new Map<string, CaptureEnvelope>();
    for (const e of envs) {
        if (e.frame_sha != null) frameSha = e.frame_sha;            // last non-null wins (async back-fill)
        if (e.t_end > ts) ts = e.t_end;
        const prev = byStage.get(e.stage_id);
        if (!prev || e.seq >= prev.seq) byStage.set(e.stage_id, e); // last (max seq) wins per stage
    }
    const runId = envs.find(e => e.run_id)?.run_id ?? `run_${idx}`;
    const integrate = byStage.get('integrate');
    const succeeded = integrate != null && integrate.ok === true;
    return { runId, frameSha, ts, byStage, succeeded };
}

/** Mean of a non-empty numeric array. */
function mean(xs: number[]): number {
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

/**
 * Fold many capture records (one inner array per run) into the flowchart rollup.
 * Deduped by frame content hash; timing restricted to successful solves.
 */
export function aggregateCaptureRuns(
    runs: readonly (readonly CaptureEnvelope[])[],
): FlowchartAggregate {
    // 1. Reduce each run; keep only non-empty.
    const views: RunView[] = [];
    runs.forEach((envs, i) => {
        const v = toRunView(envs, i);
        if (v) views.push(v);
    });

    // 2. Dedup: group by content hash; null sha never merges (unique key per run).
    const byKey = new Map<string, RunView>();
    for (const v of views) {
        const key = v.frameSha != null ? `sha:${v.frameSha}` : `run:${v.runId}`;
        const existing = byKey.get(key);
        if (!existing || v.ts >= existing.ts) byKey.set(key, v); // latest run of the frame wins
    }
    const frames = [...byKey.values()];
    const unhashed = frames.filter(f => f.frameSha == null).length;
    const successful = frames.filter(f => f.succeeded).length;

    // 3. Per-stage rollup across deduped frames.
    const stageIds = new Set<string>();
    for (const f of frames) for (const id of f.byStage.keys()) stageIds.add(id);

    const stages: Record<string, StageStat> = {};
    for (const id of stageIds) {
        const withStage = frames.filter(f => f.byStage.has(id));
        let passed = 0, failed = 0;
        const timingSamples: number[] = [];
        for (const f of withStage) {
            const env = f.byStage.get(id)!;
            if (env.ok) passed++; else failed++;
            if (f.succeeded && Number.isFinite(env.ms)) timingSamples.push(env.ms);
        }
        // Representative = most-recent frame that carries this stage.
        const rep = withStage.slice().sort((a, b) => b.ts - a.ts)[0]?.byStage.get(id) ?? null;

        stages[id] = {
            stage_id: id,
            reached: withStage.length,
            passed,
            failed,
            min_ms: timingSamples.length ? Math.min(...timingSamples) : null,
            avg_ms: timingSamples.length ? mean(timingSamples) : null,
            max_ms: timingSamples.length ? Math.max(...timingSamples) : null,
            timing_samples: timingSamples.length,
            verdict: rep?.verdict ?? null,
            counts: rep?.counts ?? {},
            payload_ref: rep?.payload_ref ?? null,
        };
    }

    return {
        run_count: views.length,
        frame_count: frames.length,
        unhashed_count: unhashed,
        successful_frames: successful,
        stages,
    };
}

/** Parse a capture-record JSONL blob into an envelope array (skips blank/bad lines). */
export function parseCaptureJsonl(text: string): CaptureEnvelope[] {
    const out: CaptureEnvelope[] = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            out.push(JSON.parse(t) as CaptureEnvelope);
        } catch {
            /* skip a malformed line — honest partial read, never a throw */
        }
    }
    return out;
}
