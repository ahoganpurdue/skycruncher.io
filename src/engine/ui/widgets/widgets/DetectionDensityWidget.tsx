/**
 * DATA-BACKED WIDGET (heavy tier) — detection vs match spatial density.
 *
 * PURE READ over `receipt.signal.clean_stars` (surviving detections, with x/y),
 * `receipt.solution.matched_stars` (the ones that actually matched a catalog
 * star), and `receipt.metadata` (frame w/h). It bins detections into a spatial
 * grid (seq ramp = detection density) and overplots matched stars, making the
 * m4 RECALL DEFICIT visible: cells dense with detections but sparse with matches
 * are where real point sources exist that the solver never used.
 *
 * Honest-or-absent: no detection positions and no matched positions ⇒ null ⇒
 * the dock frame shows NOT MEASURED.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite, binGrid } from '../widget_math';
import { Readout } from '../chart_primitives';

interface XY { x: number; y: number }
export interface DetectionDensityData {
    w: number; h: number;
    detected: XY[];
    matched: XY[];
    gx: number; gy: number;
}

const xyList = (arr: any): XY[] =>
    (Array.isArray(arr) ? arr : [])
        .map(p => ({ x: finite(p?.x), y: finite(p?.y) }))
        .filter((p): p is XY => p.x != null && p.y != null);

/** PURE selector: signal + solution + metadata → density inputs, or null. */
export function selectDetectionDensity(receipt: WidgetReceipt): DetectionDensityData | null {
    const detected = xyList(receipt?.signal?.clean_stars);
    const matched = xyList(receipt?.solution?.matched_stars);
    if (detected.length === 0 && matched.length === 0) return null;    // honest absence
    const w = finite(receipt?.metadata?.width)
        ?? Math.max(1, ...detected.concat(matched).map(p => p.x)) + 1;
    const h = finite(receipt?.metadata?.height)
        ?? Math.max(1, ...detected.concat(matched).map(p => p.y)) + 1;
    const gx = 9;
    const gy = Math.max(4, Math.min(24, Math.round(gx * h / Math.max(1, w))));
    return { w, h, detected, matched, gx, gy };
}

const SEQ = ['--chart-seq-1', '--chart-seq-2', '--chart-seq-3', '--chart-seq-4', '--chart-seq-5'];

const DetectionDensityRender: React.FC<WidgetRenderProps<DetectionDensityData>> = ({ data }) => {
    const { w, h, detected, matched, gx, gy } = data;
    const cells = useMemo(() => binGrid(detected, w, h, gx, gy), [detected, w, h, gx, gy]);
    const matchCells = useMemo(() => binGrid(matched, w, h, gx, gy), [matched, w, h, gx, gy]);
    const maxCell = Math.max(1, ...cells);
    const deficitCells = cells.reduce((acc, d, i) => acc + (d >= 3 && matchCells[i] === 0 ? 1 : 0), 0);

    // Render frame — SVG in image aspect, capped height.
    const VW = 240;
    const VH = Math.round(VW * h / Math.max(1, w));
    const cw = VW / gx, ch = VH / gy;
    const recall = detected.length > 0 ? (100 * matched.length / detected.length) : null;

    return (
        <div className="flex flex-col gap-3" data-testid="widget-detection-density">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Detected" value={String(detected.length)} />
                <Readout label="Matched" value={String(matched.length)} />
                {recall != null && <Readout label="Recall" value={`${recall.toFixed(0)}%`} />}
                <Readout label="Dense-unmatched cells" value={String(deficitCells)} title="cells with ≥3 detections but 0 matches" />
            </div>
            <svg viewBox={`0 0 ${VW} ${VH}`} width={VW} className="h-auto select-none border border-line rounded"
                 role="img" aria-label="detection density heatmap with matched stars overplotted" data-testid="widget-density-svg">
                {cells.map((d, i) => {
                    const cx = (i % gx) * cw, cy = Math.floor(i / gx) * ch;
                    const t = d / maxCell;
                    const idx = d === 0 ? -1 : Math.min(SEQ.length - 1, Math.floor(t * SEQ.length));
                    return <rect key={i} x={cx} y={cy} width={cw} height={ch}
                                 fill={idx < 0 ? 'transparent' : `var(${SEQ[idx]})`} fillOpacity={idx < 0 ? 0 : 0.85} />;
                })}
                {/* matched stars overplotted (solve green) */}
                {matched.map((p, i) => (
                    <circle key={i} cx={p.x / w * VW} cy={p.y / h * VH} r={0.9} fill="var(--chart-cat-3)" fillOpacity={0.9} />
                ))}
            </svg>
            <div className="text-[10px] font-mono text-text-muted">blue density = surviving detections · green dots = matched · dark-but-dotless = recall deficit</div>
        </div>
    );
};

export const detectionDensityWidget: WidgetManifest<DetectionDensityData> = {
    id: 'detection_density',
    title: 'Detection Density',
    intent: 'Spatial density of surviving detections with matched stars overplotted — makes the m4 recall deficit visible: where are there real point sources the solver never matched?',
    dataSelector: selectDetectionDensity,
    weightTier: 'heavy',
    render: DetectionDensityRender,
};
