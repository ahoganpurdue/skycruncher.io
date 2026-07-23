/**
 * withFlowchartFps — the sanctioned THIN FPS wrapper for the SVG flowchart.
 *
 * The owner's A/B wants an FPS/frame-time number on BOTH panes. Rather than reach
 * into `SolveFlowchartWidget.tsx` (kept byte-untouched), this decorates its
 * manifest at the registry level: same id / selector / tier, a "(SVG)" A/B label,
 * and an unobtrusive `FpsMeter` badge overlaid in the corner. Pure wrapper — it
 * renders the original component verbatim and adds only a display-cadence readout.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps } from '../registry';
import { FpsMeter } from './FpsMeter';

/** Wrap a widget manifest so its pane carries a corner FPS badge + an A/B title. */
export function withFlowchartFps<D>(base: WidgetManifest<D>): WidgetManifest<D> {
    const Original = base.render;
    const Wrapped: React.FC<WidgetRenderProps<D>> = ({ data }) => (
        <div className="relative h-full" data-testid="flowchart-svg-fps-wrap">
            <div
                className="absolute right-0 -top-0.5 z-20 pointer-events-none bg-space-900/80 rounded px-1"
            >
                <FpsMeter label="rAF" />
            </div>
            <Original data={data} />
        </div>
    );
    return { ...base, title: 'Solve Flowchart (SVG)', render: Wrapped };
}
