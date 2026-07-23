/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPLAY DASHBOARD — wave 3 of the ★ owner-priority flowchart/dashboard program
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A window-splittable, widget-swapping dashboard that replays a solve run with a
 * speed-scrubbing time slider — for BOTH the live/current run (streamed off the
 * session event bus) and any past run (in-memory retention or a dropped
 * runs/*.jsonl artifact). Extends docs/WORKSPACE_DASHBOARD_DESIGN.md (v1): a
 * hand-rolled layout tree + tabs + swap slots + localStorage save/restore, no
 * new dependency.
 *
 * Owner ruling 2026-07-09: this is POST-SOLVE / standalone — it does NOT overlay
 * the wizard steps. Mounted beside the WidgetDock in MainApp, flag-gated ON.
 *
 * DATA FLOW:  session bus / completedRuns / JSONL → CaptureEnvelope[] →
 *   deriveReplayFrame(envelopes, scrubT) → ReplayProvider → every WidgetSlot.
 * The scrub math is pure (replay_state.ts); this component owns only the clock,
 * the layout tree, and the run selection.
 *
 * A4: layout persistence is now VERSIONED (`layout_persist` → the shared
 * `widget_persist` surface) so a future schema change invalidates cleanly; and
 * this surface also installs the durable capture-persistence sink so the
 * flowchart's local corpus spans reloads.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineEventBus } from '../../../events/pipeline_events';
import { buildCaptureRecord } from '../../../events/capture_record';
import { installCapturePersistSink } from '../../../events/capture_persist';
import { usePipelineEvents } from '../../../hooks/usePipelineEvents';
import type { WidgetReceipt } from '../../widgets/registry';
import {
    type LayoutNode,
    type SplitDirection,
    makeLeaf,
    splitLeaf,
    closeLeaf,
    swapWidget,
    addTab,
    setActiveTab,
    closeTab,
    resizeSplit,
    countLeaves,
} from './layout_tree';
import { loadLayout, saveLayout } from './layout_persist';
import { deriveReplayFrame, runTimeBounds } from './replay_state';
import { listPastRuns, type RunHandle } from './runs_source';
import { ReplayProvider } from './ReplayContext';
import { SplitPaneView, type PaneActions } from './SplitPaneView';
import { TimeSlider } from './TimeSlider';
import { RunPicker } from './RunPicker';
import { useReplayClock } from './useReplayClock';

// ─── flag (DEFAULT ON, opt-out — mirrors the WidgetDock flag) ───────────────
export const REPLAY_DASHBOARD_STORAGE_KEY = 'skycruncher.replay.dashboard';
export function getReplayDashboardEnabled(): boolean {
    try { return localStorage.getItem(REPLAY_DASHBOARD_STORAGE_KEY) !== '0'; } catch { return true; }
}
export function setReplayDashboardEnabled(on: boolean): void {
    try { localStorage.setItem(REPLAY_DASHBOARD_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

const DEFAULT_WIDGET = 'replay_timeline';
/** ★ The end-to-end solve DAG — default-visible per owner priority (NEXT_MOVES §0). */
const FLOWCHART_WIDGET = 'solve_flowchart';

/**
 * The default three-pane layout: the ★ solve flowchart as the prominent full-
 * width TOP pane (owner priority — default-visible DAG), with the replay
 * timeline + solve summary in a row beneath it. The SVG flowchart is the
 * default; the WebGPU twin (`solve_flowchart_webgpu`) stays opt-in behind its
 * own navigator.gpu availability gate — reachable via the pane swap menu, never
 * defaulted (it self-renders an honest "WebGPU unavailable" state otherwise).
 */
function defaultLayout(): LayoutNode {
    // col split: flowchart on top, [timeline | summary] row below.
    const withRow = splitLeaf(
        makeLeaf('root', [FLOWCHART_WIDGET]), 'root', 'col', DEFAULT_WIDGET,
        { splitId: 's0', newLeafId: 'p1' },
    );
    return splitLeaf(withRow, 'p1', 'row', 'solve_summary', { splitId: 's1', newLeafId: 'p2' });
}

export interface ReplayDashboardProps {
    /** The current session's event bus (live/current run). null when none. */
    liveBus?: PipelineEventBus | null;
    /** The current run's receipt for receipt-backed widgets. null for JSONL runs. */
    receipt?: WidgetReceipt;
    /**
     * When set to a captured run id, focus (select) that run on mount and
     * whenever the id CHANGES — the per-row "Receipt" affordance in the Solve
     * Queue uses this to open the dashboard on one specific run rather than the
     * whole-session default. Applied only when the id resolves to a real run;
     * it never fights a subsequent manual selection (keyed on the id, not on the
     * run list), so the user can still browse other runs freely.
     */
    focusRunId?: string | null;
}

const ReplayDashboardBody: React.FC<ReplayDashboardProps> = ({ liveBus, receipt, focusRunId }) => {
    const liveEvents = usePipelineEvents(liveBus ?? null);
    const liveEnvelopes = useMemo(() => buildCaptureRecord(liveEvents), [liveEvents]);
    const liveRunId = liveEnvelopes.find(e => e.run_id)?.run_id ?? (liveEvents.length ? 'live' : null);

    // Install the durable capture-persistence sink once (idempotent, process-
    // global) so the flowchart's local corpus survives reloads whenever a post-
    // solve surface is mounted — the dashboard OR the dock.
    useEffect(() => { installCapturePersistSink(); }, []);

    const [loadedRuns, setLoadedRuns] = useState<RunHandle[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Assemble the run list: LIVE (if any events), PAST (in-memory), LOADED.
    const pastRuns = useMemo(() => listPastRuns(), [liveRunId, loadedRuns.length]);
    const runs: RunHandle[] = useMemo(() => {
        const out: RunHandle[] = [];
        if (liveRunId && liveEnvelopes.length > 0) {
            out.push({ id: liveRunId, kind: 'live', label: `${liveRunId} (current)`, envelopes: liveEnvelopes });
        }
        for (const r of pastRuns) if (!out.some(o => o.id === r.id)) out.push(r);
        for (const r of loadedRuns) if (!out.some(o => o.id === r.id)) out.push(r);
        return out;
    }, [liveRunId, liveEnvelopes, pastRuns, loadedRuns]);

    // Auto-select: prefer the live run, else the first available.
    useEffect(() => {
        if (selectedId && runs.some(r => r.id === selectedId)) return;
        setSelectedId(runs[0]?.id ?? null);
    }, [runs, selectedId]);

    // Focus a specific run when the caller sets/changes focusRunId (the Solve
    // Queue's per-row "Receipt" affordance). Keyed on the id alone so it applies
    // exactly when the request changes — never on unrelated re-renders — and so
    // it does not fight a subsequent manual run selection.
    const runsRef = useRef(runs);
    runsRef.current = runs;
    useEffect(() => {
        if (!focusRunId) return;
        if (runsRef.current.some(r => r.id === focusRunId)) setSelectedId(focusRunId);
    }, [focusRunId]);

    const selected = runs.find(r => r.id === selectedId) ?? null;
    const isLive = selected?.kind === 'live';
    const envelopes = selected?.envelopes ?? (isLive ? liveEnvelopes : []);

    const bounds = useMemo(() => {
        const b = runTimeBounds(envelopes);
        return { tStart: b.tStart, tEnd: b.tEnd, totalMs: b.totalMs };
    }, [envelopes]);

    const clock = useReplayClock({ tStart: bounds.tStart, tEnd: bounds.tEnd });

    // Live runs pin the scrub to the tail; past runs use the clock position.
    const scrubT = isLive ? bounds.tEnd : clock.t;
    const frame = useMemo(
        () => deriveReplayFrame(envelopes, scrubT, { live: isLive }),
        [envelopes, scrubT, isLive],
    );

    // Receipt/events flow to widgets ONLY for the live/current run (past &
    // loaded runs have no live receipt or raw events → honest NOT MEASURED).
    const ctxValue = useMemo(() => ({
        frame,
        receipt: isLive ? (receipt ?? null) : null,
        events: isLive ? liveEvents : undefined,
    }), [frame, isLive, receipt, liveEvents]);

    // ─── layout tree state + persistence (VERSIONED via layout_persist) ───
    const [layout, setLayout] = useState<LayoutNode>(() => loadLayout(defaultLayout()));
    const idc = useRef(1);
    const nextId = (p: string) => `${p}${idc.current++}`;
    useEffect(() => { saveLayout(layout); }, [layout]);

    const actions: PaneActions = useMemo(() => ({
        split: (leafId: string, dir: SplitDirection) =>
            setLayout(t => splitLeaf(t, leafId, dir, DEFAULT_WIDGET, { splitId: nextId('s'), newLeafId: nextId('p') })),
        close: (leafId: string) => setLayout(t => closeLeaf(t, leafId)),
        swap: (leafId: string, widgetId: string) => setLayout(t => swapWidget(t, leafId, widgetId)),
        addTab: (leafId: string) => setLayout(t => addTab(t, leafId, DEFAULT_WIDGET)),
        setActive: (leafId: string, idx: number) => setLayout(t => setActiveTab(t, leafId, idx)),
        closeTab: (leafId: string, idx: number) => setLayout(t => closeTab(t, leafId, idx)),
        resize: (splitId: string, sizes: number[]) => setLayout(t => resizeSplit(t, splitId, sizes)),
    }), []);

    const paneCount = countLeaves(layout);
    const resetLayout = () => setLayout(makeLeaf('root', [DEFAULT_WIDGET]));

    return (
        <ReplayProvider value={ctxValue}>
            <div className="flex flex-col border border-line rounded-xl overflow-hidden bg-space-900/70" data-testid="replay-dashboard" style={{ height: 520 }}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-line bg-space-900/80 shrink-0">
                    <h3 className="text-text-secondary text-[11px] font-bold uppercase tracking-widest">Replay Dashboard</h3>
                    <div className="flex items-center gap-3">
                        <span className="text-text-faint text-[9px] font-mono">{paneCount} panes</span>
                        <button type="button" onClick={resetLayout} data-testid="replay-reset-layout"
                            className="text-[9px] font-mono text-text-muted hover:text-text-primary uppercase tracking-widest">Reset layout</button>
                    </div>
                </div>

                <RunPicker
                    runs={runs}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onLoad={h => setLoadedRuns(prev => (prev.some(p => p.id === h.id) ? prev : [...prev, h]))}
                />

                <div className="flex-1 min-h-0 p-1.5 bg-space-950/40">
                    {selected ? (
                        <SplitPaneView node={layout} actions={actions} canClose={paneCount > 1} />
                    ) : (
                        <div className="h-full flex items-center justify-center text-[11px] font-mono text-text-muted" data-testid="replay-no-run">
                            No run selected — process a file or drop a runs/*.jsonl artifact.
                        </div>
                    )}
                </div>

                <TimeSlider
                    clock={clock}
                    bounds={{ tStart: bounds.tStart, tEnd: bounds.tEnd }}
                    elapsedMs={frame.elapsedMs}
                    totalMs={frame.totalMs}
                    live={isLive}
                    disabled={!selected || bounds.totalMs === 0}
                />
            </div>
        </ReplayProvider>
    );
};

/** Public entry — flag guard first (DEFAULT ON, opt-out). Renders nothing when off. */
export const ReplayDashboard: React.FC<ReplayDashboardProps> = (props) => {
    if (!getReplayDashboardEnabled()) return null;
    return <ReplayDashboardBody {...props} />;
};

export default ReplayDashboard;
