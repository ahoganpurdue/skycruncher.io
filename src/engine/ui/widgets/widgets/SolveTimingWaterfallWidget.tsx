/**
 * DATA-BACKED WIDGET (chart tier) — per-stage solve timing waterfall.
 *
 * PRIMARY source is the pipeline EVENT stream: every `stage_finished` event
 * carries `{ stage, ok, ms }` (pipeline_events.ts), and `stage_started` carries
 * a human `label`. This widget reads those durations directly — it never times
 * anything itself. FALLBACK: when no events are available (e.g. a receipt-only
 * gallery render), it uses `receipt.solution.solve_time_ms` as a single honest
 * "solve (total)" bar IF that value is > 0.
 *
 * Honest-or-absent: no stage events AND no positive solve_time_ms ⇒ null ⇒ the
 * dock frame shows NOT MEASURED. (Per-stage timings are NOT baked into the
 * receipt, so a receipt-only render will honestly show NOT MEASURED here.)
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt, WidgetEvents } from '../registry';
import { finite } from '../widget_math';
import { HBars, Readout, type HBar } from '../chart_primitives';

export interface SolveTimingData {
    stages: { stage: string; label: string; ms: number; ok: boolean }[];
    totalMs: number;
    /** True when the only datum was solution.solve_time_ms (no stage events). */
    fromTotalOnly: boolean;
}

/** PURE selector: pipeline events (or solve_time_ms fallback) → stage timings. */
export function selectSolveTiming(receipt: WidgetReceipt, events?: WidgetEvents): SolveTimingData | null {
    const labels = new Map<string, string>();
    const finished: { stage: string; ms: number; ok: boolean }[] = [];
    for (const e of events ?? []) {
        if (e.kind === 'stage_started') labels.set(e.stage, e.label);
        else if (e.kind === 'stage_finished') {
            const ms = finite(e.ms);
            if (ms != null) finished.push({ stage: e.stage, ms, ok: e.ok !== false });
        }
    }
    if (finished.length > 0) {
        const stages = finished.map(f => ({ stage: f.stage, label: labels.get(f.stage) ?? f.stage, ms: f.ms, ok: f.ok }));
        return { stages, totalMs: stages.reduce((s, x) => s + x.ms, 0), fromTotalOnly: false };
    }
    const total = finite(receipt?.solution?.solve_time_ms);
    if (total != null && total > 0) {
        return { stages: [{ stage: 'solve', label: 'solve (total)', ms: total, ok: true }], totalMs: total, fromTotalOnly: true };
    }
    return null;                                                 // honest absence
}

const SolveTimingRender: React.FC<WidgetRenderProps<SolveTimingData>> = ({ data }) => {
    const bars: HBar[] = data.stages.map(s => ({
        label: s.label.slice(0, 16),
        value: Math.round(s.ms),
        colorVar: s.ok ? '--chart-cat-1' : '--chart-cat-5',
    }));
    return (
        <div className="flex flex-col gap-3" data-testid="widget-solve-timing-waterfall">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Stages" value={data.fromTotalOnly ? 'total only' : String(data.stages.length)} />
                <Readout label="Total" value={`${Math.round(data.totalMs)} ms`} />
            </div>
            <HBars bars={bars} unit=" ms" testId="widget-timing-bars" />
            {data.fromTotalOnly && (
                <div className="text-[10px] font-mono text-text-muted">
                    Per-stage timings are event-only (not in the receipt) — showing solve_time_ms total.
                </div>
            )}
        </div>
    );
};

export const solveTimingWaterfallWidget: WidgetManifest<SolveTimingData> = {
    id: 'solve_timing_waterfall',
    title: 'Solve Timing',
    intent: 'Per-stage wall-clock time through the pipeline (ingest → detect → solve → characterize) from the event stream — where does a run spend its time?',
    dataSelector: selectSolveTiming,
    weightTier: 'chart',
    render: SolveTimingRender,
};
