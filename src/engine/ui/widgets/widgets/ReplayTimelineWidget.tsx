/**
 * REPLAY TIMELINE WIDGET (id: `replay_timeline`).
 *
 * The reference consumer of the ★ Replay Dashboard time-slice contract: it reads
 * `useReplayFrame()` and lights one box per stage by its phase at the scrub time
 * — exactly the pattern wave-2's flowchart widget will use. Shown in a dashboard
 * pane it animates with the scrub; shown in the plain WidgetDock (no replay
 * provider) it degrades to a static complete-run timeline built from the event
 * history, or NOT MEASURED when neither is available (LAW 3).
 *
 * Registry-side this is a normal widget (pure selector + render component); the
 * replay-awareness lives entirely in the render via the context hook, so it does
 * not couple the registry to the dashboard.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps } from '../registry';
import type { PipelineEvent } from '../../../events/pipeline_events';
import { buildCaptureRecord } from '../../../events/capture_record';
import { useReplayFrame } from '../../dashboard/replay/ReplayContext';
import { deriveReplayFrame, type ReplayFrame, type ReplayStagePhase, type ReplayStageState } from '../../dashboard/replay/replay_state';

/** Selector payload: the raw events (used only for the standalone dock fallback). */
interface ReplayTimelineData {
    events: readonly PipelineEvent[] | null;
}

const PHASE_STYLE: Record<ReplayStagePhase, { dot: string; bar: string; label: string }> = {
    pending: { dot: 'bg-pending', bar: 'bg-space-700', label: 'text-text-faint' },
    active: { dot: 'bg-accent-400 animate-pulse', bar: 'bg-accent-500', label: 'text-accent-300' },
    complete: { dot: 'bg-solve', bar: 'bg-solve/60', label: 'text-text-secondary' },
};

const StageRow: React.FC<{ stage: ReplayStageState; window: { start: number; span: number } }> = ({ stage, window }) => {
    const style = PHASE_STYLE[stage.phase];
    const failed = stage.phase === 'complete' && stage.ok === false;
    const leftPct = window.span > 0 ? ((stage.tStart - window.start) / window.span) * 100 : 0;
    const widthPct = window.span > 0 ? Math.max(0.8, ((stage.tEnd - stage.tStart) / window.span) * 100) : 100;
    const matched = stage.counts.matched ?? stage.counts.n_stars ?? null;

    return (
        <div className="flex items-center gap-2" data-testid={`replay-stage-${stage.stageId}`} data-phase={stage.phase}>
            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${failed ? 'bg-danger' : style.dot}`} />
            <span className={`font-mono text-[10px] w-32 truncate shrink-0 ${style.label}`} title={stage.stageId}>
                {stage.stageId}
            </span>
            <div className="relative flex-1 h-2 rounded bg-space-850 overflow-hidden">
                <div
                    className={`absolute top-0 h-full rounded ${failed ? 'bg-danger' : style.bar}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
            </div>
            <span className="font-mono text-[9px] text-text-muted w-24 text-right shrink-0">
                {stage.phase === 'complete'
                    ? `${stage.ms != null ? Math.round(stage.ms) : '·'}ms${matched != null ? ` · ${matched}` : ''}`
                    : stage.phase === 'active'
                        ? 'running…'
                        : '—'}
            </span>
        </div>
    );
};

const TimelineView: React.FC<{ frame: ReplayFrame }> = ({ frame }) => {
    const window = { start: frame.tStart, span: Math.max(1, frame.totalMs) };
    const pct = frame.totalMs > 0 ? (frame.elapsedMs / frame.totalMs) * 100 : 100;
    return (
        <div className="flex flex-col gap-2" data-testid="replay-timeline">
            <div className="flex items-center justify-between font-mono text-[10px] text-text-muted">
                <span>{frame.live ? 'LIVE' : 'REPLAY'} · {(frame.elapsedMs / 1000).toFixed(2)}s / {(frame.totalMs / 1000).toFixed(2)}s</span>
                <span>
                    <span className="text-solve">{frame.completeCount}✓</span>{' '}
                    <span className="text-accent-300">{frame.activeCount}●</span>{' '}
                    <span className="text-text-faint">{frame.pendingCount}○</span>
                </span>
            </div>
            <div className="h-1 rounded bg-space-850 overflow-hidden">
                <div className="h-full bg-accent-500 transition-[width] duration-100" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-col gap-1.5 mt-1">
                {frame.stages.map(s => <StageRow key={s.stageId + s.seq} stage={s} window={window} />)}
            </div>
        </div>
    );
};

const ReplayTimelineRender: React.FC<WidgetRenderProps<ReplayTimelineData>> = ({ data }) => {
    // (B) EXPLICIT replay path — the live scrub frame from the dashboard context.
    const frame = useReplayFrame();
    if (frame && frame.stages.length > 0) return <TimelineView frame={frame} />;

    // (Standalone dock fallback) build a static complete-run frame from events.
    if (data.events && data.events.length > 0) {
        const record = buildCaptureRecord(data.events);
        if (record.length > 0) {
            const end = Math.max(...record.map(e => e.t_end));
            return <TimelineView frame={deriveReplayFrame(record, end)} />;
        }
    }

    return (
        <div className="text-[11px] font-mono text-text-muted py-8 text-center" data-testid="replay-timeline-empty">
            NOT MEASURED
        </div>
    );
};

/**
 * Selector: return the event history for the standalone fallback. Non-null so
 * the render component always mounts — its OWN honest empty state (above) covers
 * the no-data case, because the replay frame (its primary source) is delivered
 * by context, not by the selector.
 */
export const replayTimelineWidget: WidgetManifest<ReplayTimelineData> = {
    id: 'replay_timeline',
    title: 'Replay Timeline',
    intent: 'Per-stage solve timeline that lights up as the replay scrub advances — the reference consumer of the replay time-slice contract.',
    weightTier: 'chart',
    dataSelector: (_receipt, events) => ({ events: events ?? null }),
    render: ReplayTimelineRender,
};
