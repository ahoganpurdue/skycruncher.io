/**
 * DATA-BACKED WIDGET (chart tier) — detection → culling → matched waterfall.
 *
 * PURE READ over `receipt.signal` (culling_tally + clean_stars) and
 * `receipt.solution.matched_stars`. The waterfall reconstructs the honest funnel
 * from MEASURED counts only:
 *   detected(= clean survivors + Σ cull buckets) → −each bucket → clean → matched
 * Every bar is a real tally (culling_tally is counted at assignment time,
 * signal_processor.ts) — nothing is interpolated.
 *
 * Honest-or-absent: no signal block, or neither a tally nor a survivor count ⇒
 * null ⇒ the dock frame shows NOT MEASURED.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite } from '../widget_math';
import { HBars, Readout, type HBar } from '../chart_primitives';

export interface CullingWaterfallData {
    detected: number;
    clean: number;
    matched: number | null;
    buckets: { reason: string; count: number }[];
}

/** PURE selector: receipt.signal + solution → funnel counts, or null. */
export function selectCullingWaterfall(receipt: WidgetReceipt): CullingWaterfallData | null {
    const sig = receipt?.signal;
    if (!sig) return null;
    const tally: Record<string, unknown> = sig.culling_tally ?? {};
    const buckets = Object.entries(tally)
        .map(([reason, v]) => ({ reason, count: finite(v) ?? 0 }))
        .filter(b => b.count > 0)
        .sort((a, b) => b.count - a.count);
    const clean = finite(Array.isArray(sig.clean_stars) ? sig.clean_stars.length : sig.clean_stars);
    const culled = buckets.reduce((s, b) => s + b.count, 0);
    if (clean == null && culled === 0) return null;              // nothing to draw
    const cleanN = clean ?? 0;
    const matched = finite(receipt?.solution?.matched_stars?.length ?? receipt?.solution?.stars_matched);
    return { detected: cleanN + culled, clean: cleanN, matched, buckets };
}

const CullingWaterfallRender: React.FC<WidgetRenderProps<CullingWaterfallData>> = ({ data }) => {
    const bars: HBar[] = [
        { label: 'detected', value: data.detected, colorVar: '--chart-cat-1' },
        ...data.buckets.map(b => ({ label: `− ${b.reason}`, value: b.count, colorVar: '--chart-cat-2' })),
        { label: 'clean (survived)', value: data.clean, colorVar: '--chart-cat-6' },
        ...(data.matched != null ? [{ label: 'matched', value: data.matched, colorVar: '--chart-cat-3' }] : []),
    ];
    const recall = data.matched != null && data.clean > 0 ? (100 * data.matched / data.clean) : null;
    return (
        <div className="flex flex-col gap-3" data-testid="widget-culling-waterfall">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Detected" value={String(data.detected)} />
                <Readout label="Culled" value={String(data.detected - data.clean)} />
                <Readout label="Matched" value={data.matched == null ? '—' : String(data.matched)} />
                {recall != null && <Readout label="Match/clean" value={`${recall.toFixed(0)}%`} />}
            </div>
            <HBars bars={bars} testId="widget-culling-bars" />
            <div className="text-[10px] font-mono text-text-muted">counts measured at culling assignment time · amber = rejected bucket</div>
        </div>
    );
};

export const cullingWaterfallWidget: WidgetManifest<CullingWaterfallData> = {
    id: 'culling_waterfall',
    title: 'Culling Waterfall',
    intent: 'The detection funnel — raw detections minus each cull bucket (circularity, dedup, low-SNR…) down to clean survivors and finally matched stars. Where does signal get thrown away?',
    dataSelector: selectCullingWaterfall,
    weightTier: 'chart',
    render: CullingWaterfallRender,
};
