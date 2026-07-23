/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LIVE SOLVE FLOWCHART — compact floating HUD co-mounted with the wizard
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ★ solve flowchart is default-visible in the ReplayDashboard, but the
 * PipelineWizard is a full-screen modal that occludes that dashboard WHILE a
 * solve runs. This compact, collapsible HUD floats above the wizard (z above the
 * modal) so the DAG lights up LIVE as stages emit — the "watch it solve" surface
 * the owner asked for.
 *
 * ── Design guarantees ──────────────────────────────────────────────────────
 *  - LIVE: fed by the ACTIVE session event bus (lifted to App scope in MainApp).
 *    Subscription goes through the SHARED `usePipelineEvents` hook, so the 120ms
 *    coalescing law is preserved — no per-event render (diag_prefs hot-path law;
 *    weightTier gates RENDER only).
 *  - LAW 4 (no code in two places): reuses the EXACT `solve_flowchart` render
 *    component + `selectFlowchart` selector. Zero divergence from the dashboard
 *    flowchart geometry/model — this is a thin placement wrapper, nothing more.
 *  - LAW 3 (honest-or-absent): `selectFlowchart` is a PURE read of already-
 *    collected data. The structural DAG paints per-box NOT MEASURED / idle until
 *    a stage actually emits; nothing here fabricates a number.
 *  - PIXEL/render ledger, display-only. Asserts nothing about the solve.
 */

import React, { useMemo, useState } from 'react';
import type { PipelineEventBus } from '../../events/pipeline_events';
import { usePipelineEvents } from '../../hooks/usePipelineEvents';
import { selectFlowchart, solveFlowchartWidget } from '../widgets/widgets/SolveFlowchartWidget';

/** The pure-SVG flowchart render component (NOT the FPS-wrapped A/B variant). */
const FlowchartRender = solveFlowchartWidget.render;

export interface LiveSolveFlowchartProps {
    /** The active session's event bus (null before the session initializes). */
    bus: PipelineEventBus | null;
}

const LiveSolveFlowchartInner: React.FC<{ bus: PipelineEventBus }> = ({ bus }) => {
    const [collapsed, setCollapsed] = useState(false);
    // Coalesced (120ms) subscription — the shared hook is the ONLY event path,
    // so the hot-path-never-feeds-charts law is honored by construction.
    const events = usePipelineEvents(bus);
    // PURE read; structural selector returns a non-null model even with no
    // events (per-box NOT MEASURED lives inside the render, LAW 3).
    const data = useMemo(() => selectFlowchart(null, events), [events]);
    const emitted = events.length;

    return (
        <div
            className="fixed left-4 bottom-24 z-[60] w-[360px] max-w-[90vw] rounded-xl border border-line bg-space-900/95 shadow-2xl backdrop-blur-md"
            data-testid="live-solve-flowchart"
        >
            <button
                type="button"
                onClick={() => setCollapsed(c => !c)}
                aria-expanded={!collapsed}
                data-testid="live-solve-flowchart-toggle"
                className="w-full flex items-center justify-between gap-2 px-3 py-2 border-b border-line hover:bg-space-800/60 transition-colors"
            >
                <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-accent-400 animate-pulse" aria-hidden="true" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Live Solve Map</span>
                </span>
                <span className="inline-flex items-center gap-2">
                    <span className="text-[9px] font-mono text-text-muted tabular-nums" data-testid="live-solve-flowchart-events">
                        {emitted} evt{emitted === 1 ? '' : 's'}
                    </span>
                    <span className="text-[10px] font-mono text-text-muted">{collapsed ? '▸' : '▾'}</span>
                </span>
            </button>
            {!collapsed && (
                <div className="p-2 overflow-auto" style={{ maxHeight: '42vh' }} data-testid="live-solve-flowchart-body">
                    {data ? <FlowchartRender data={data} /> : null}
                </div>
            )}
        </div>
    );
};

/**
 * Public entry: renders NOTHING until the session bus exists (honest absence —
 * no bus ⇒ no live surface, never a fabricated one).
 */
export const LiveSolveFlowchart: React.FC<LiveSolveFlowchartProps> = ({ bus }) => {
    if (!bus) return null;
    return <LiveSolveFlowchartInner bus={bus} />;
};

export default LiveSolveFlowchart;
