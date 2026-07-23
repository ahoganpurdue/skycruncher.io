/**
 * ★ SOLVE FLOWCHART (stats tier — default-dock) — the interactive end-to-end
 * pipeline map. Every solve step is a box, color-coded by language/runtime; the
 * solve-branch fan (quad_wasm / uw_sweep / uw_escalation) and the calibrate
 * umbrella are drawn as sub-columns. Hover a BOX → data captured (above) +
 * widgets it enables, with a REAL rendered thumbnail per enabled widget that has
 * data this run (text-only / NOT MEASURED otherwise; never a placeholder image).
 * Hover an ARROW → timing range (fast→avg→slow successful solve) + %/count
 * failing-here vs passing-through. The active box lights up live during a solve;
 * a failed stage paints red.
 *
 * Owner spec: docs/NEXT_MOVES.md §0 item 1. Substrate: capture_record (wave 1) +
 * capture_aggregate (wave 2) + capture_persist (A4 — the LOCAL cross-session
 * corpus). Layout/colors/tooltips live in the pure `flowchart_model.ts` (shared
 * with the headless preview generator — LAW 4); the enabled-widget preview logic
 * lives in the registry-aware `flowchart_previews.ts` (kept OUT of the model).
 *
 * Honest-or-absent (LAW 3): the local aggregate now spans EVERY run this box has
 * persisted, deduped by frame content-hash. Stages with no timing sample render
 * "NOT MEASURED" per box/arrow — never a placeholder. The global (community) tab
 * is wired but shows "NOT CONNECTED (index pending)".
 *
 * NOTE ON THE SELECTOR: this widget is STRUCTURAL — the DAG is always meaningful,
 * so the selector returns a non-null model even with an empty sample (the frame-
 * level NOT MEASURED is expressed per box/arrow inside, not by a null selector).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt, WidgetEvents } from '../registry';
import { WIDGETS } from '../registry';
import type { PipelineEvent } from '../../../events/pipeline_events';
import { exportAllRuns, buildCaptureRecord, type CaptureEnvelope } from '../../../events/capture_record';
import { loadAllPersistedRuns, installCapturePersistSink } from '../../../events/capture_persist';
import { aggregateCaptureRuns, type FlowchartAggregate } from '../../../events/capture_aggregate';
import { useReplayFrame } from '../../dashboard/replay/ReplayContext';
import {
    RUNTIME_META, STATUS_COLOR_VAR,
    computeLiveStatus, liveStatusFromReplay, statFor,
    buildNodeTooltip, buildEdgeTooltip, orientationForAspect,
    type LiveStatus, type Orientation, type Runtime,
} from './flowchart_model';
import {
    selectFlowGraph, annotateNode, receiptNodeStatus,
    type FlowGraph, type FlowVariant,
} from './flowchart_receipt';
import { normalizeGreenfieldReceipt, type GreenfieldReceipt } from '../data/greenfield_receipt';
import { buildEnabledWidgetPreviews } from './flowchart_previews';

/**
 * Container-aware orientation: observe the widget's own box and pick HORIZONTAL
 * (landscape / dashboard pane) vs VERTICAL (portrait / phones) from its aspect.
 * Falls back to horizontal (the default) where ResizeObserver is unavailable.
 */
function useContainerOrientation(ref: React.RefObject<HTMLElement | null>): Orientation {
    const [orientation, setOrientation] = useState<Orientation>('horizontal');
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setOrientation(orientationForAspect(el.clientWidth, el.clientHeight));
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return orientation;
}

export interface FlowchartWidgetData {
    aggregate: FlowchartAggregate;
    events: readonly PipelineEvent[];
    /** The current run's receipt — feeds the enabled-widget thumbnail previews. */
    receipt: WidgetReceipt;
}

const EMPTY_AGG: FlowchartAggregate = { run_count: 0, frame_count: 0, unhashed_count: 0, successful_frames: 0, stages: {} };

/**
 * PURE selector: fold the already-collected capture records into the flowchart
 * aggregate. Sources, in overlay order (later wins per run id, then content-hash
 * dedup collapses cross-session repeats):
 *   1. the DURABLE local corpus (`loadAllPersistedRuns` — every run this box has
 *      persisted across reloads/sessions),
 *   2. the in-memory ring (this session's completed runs),
 *   3. the live in-progress run derived from `events`.
 * Reads only already-collected data — never triggers collection or mutates.
 */
export function selectFlowchart(receipt: WidgetReceipt, events?: WidgetEvents): FlowchartWidgetData | null {
    const runs = new Map<string, CaptureEnvelope[]>();
    // 1. Durable local corpus (cross-session).
    try {
        let anon = 0;
        for (const envs of loadAllPersistedRuns()) {
            const runId = envs.find(e => e.run_id)?.run_id ?? `persisted_${anon++}`;
            runs.set(runId, envs);
        }
    } catch { /* persistence unavailable — fall through */ }
    // 2. In-memory ring (overlays persisted by run id).
    try {
        for (const [runId, envs] of Object.entries(exportAllRuns())) runs.set(runId, envs);
    } catch { /* store unavailable */ }
    // 3. Live in-progress / freshest run.
    if (events && events.length) {
        try {
            const live = buildCaptureRecord(events);
            const runId = live.find(e => e.run_id)?.run_id ?? events.find(e => e.runId)?.runId ?? null;
            if (runId && live.length) runs.set(runId, live);
        } catch { /* live derivation best-effort */ }
    }
    const aggregate = aggregateCaptureRuns([...runs.values()]);
    return { aggregate, events: events ?? [], receipt: receipt ?? null };
}

// ─── render ─────────────────────────────────────────────────────────────────

type Hover =
    | { type: 'node'; id: string }
    | { type: 'edge'; to: string }
    | null;

const cssVar = (v: string) => `var(${v})`;

const VARIANT_LABEL: Record<FlowVariant, string> = {
    greenfield: 'GREENFIELD · Rust core',
    legacy: 'LEGACY · browser solver',
};

const SolveFlowchartRender: React.FC<WidgetRenderProps<FlowchartWidgetData>> = ({ data }) => {
    const [scope, setScope] = useState<'user' | 'community'>('user');
    const [hover, setHover] = useState<Hover>(null);
    const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const orientation = useContainerOrientation(rootRef);

    // RECEIPT-DRIVEN: pick the graph THIS receipt's solve actually took (greenfield
    // Rust core vs the legacy browser solver) — never a fixed map. Both graphs share
    // the same layout engine so geometry can't drift.
    const graph = useMemo(() => selectFlowGraph(data.receipt), [data.receipt]);
    const gf: GreenfieldReceipt | null = useMemo(
        () => (graph.variant === 'greenfield' ? normalizeGreenfieldReceipt(data.receipt) : null),
        [graph, data.receipt],
    );
    const dims = useMemo(() => graph.layout.layoutDims(orientation), [graph, orientation]);

    // Install the durable-persistence sink once (idempotent, process-global). The
    // flowchart is stats-tier / default-enabled, so this mounts whenever the dock
    // shows — backfilling the in-memory ring and mirroring future runs to disk so
    // the aggregate survives reloads. Never unsubscribed (harmless + bounded).
    useEffect(() => { installCapturePersistSink(); }, []);

    // (B) EXPLICIT replay path: inside a dashboard pane the scrub frame drives the
    // box lighting; outside a dashboard the hook returns null and we fall back to
    // the live event bus (A).
    const replayFrame = useReplayFrame();

    const community = scope === 'community';
    const agg = community ? EMPTY_AGG : data.aggregate;
    // Box lighting: greenfield lights from THIS receipt's own evidence (no legacy
    // event bus fires for a Rust-core solve); legacy keeps the replay-scrub / live
    // event bus it was built on.
    const live: Record<string, LiveStatus> = useMemo(
        () => (community ? {}
            : graph.variant === 'greenfield' ? receiptNodeStatus(graph, data.receipt)
            : replayFrame ? liveStatusFromReplay(replayFrame.stages)
            : computeLiveStatus(data.events)),
        [community, graph, data.receipt, replayFrame, data.events],
    );

    const onMove = (e: React.MouseEvent) => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
    };

    const sample = `${agg.frame_count} frame${agg.frame_count === 1 ? '' : 's'} · ${agg.run_count} run${agg.run_count === 1 ? '' : 's'} (deduped by content hash)`
        + (agg.unhashed_count > 0 ? ` · ${agg.unhashed_count} unhashed` : '');

    // Legend runtimes come from the ACTIVE graph's nodes (no dead swatches).
    const runtimes = useMemo<Runtime[]>(() => {
        const order: Runtime[] = ['typescript', 'wasm', 'webgpu', 'mixed'];
        const present = new Set(graph.nodes.map(n => n.runtime));
        return order.filter(r => present.has(r));
    }, [graph]);

    return (
        <div ref={rootRef} className="flex flex-col gap-2 h-full min-h-0" data-testid="widget-solve-flowchart" data-orientation={orientation} data-variant={graph.variant}>
            {/* scope toggle + variant badge + sample line */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                    <div className="inline-flex rounded-lg border border-line overflow-hidden" role="group" aria-label="Data scope">
                        {(['user', 'community'] as const).map(s => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setScope(s)}
                                data-testid={`flowchart-scope-${s}`}
                                aria-pressed={scope === s}
                                className={`px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest ${
                                    scope === s ? 'bg-accent-600 text-white' : 'bg-space-800 text-text-secondary hover:text-text-primary'
                                }`}
                            >
                                {s === 'user' ? 'This box' : 'Community'}
                            </button>
                        ))}
                    </div>
                    <span
                        data-testid="flowchart-variant"
                        title="The engine THIS receipt's solve ran on — the diagram shows that path, not a fixed map."
                        className="text-[8.5px] font-bold uppercase tracking-widest px-2 py-1 rounded-md border"
                        style={{
                            color: cssVar(graph.variant === 'greenfield' ? STATUS_COLOR_VAR.done : '--color-text-secondary'),
                            borderColor: cssVar(graph.variant === 'greenfield' ? STATUS_COLOR_VAR.done : '--color-line'),
                        }}
                    >
                        {VARIANT_LABEL[graph.variant]}
                    </span>
                </div>
                <span className="text-[9px] font-mono text-text-muted">{community ? 'community index' : sample}</span>
            </div>

            {community && (
                <div className="text-[10px] font-mono text-text-muted border border-line rounded-md px-2 py-1.5" data-testid="flowchart-community-banner">
                    NOT CONNECTED (community index pending) — local runs are the only sample today.
                </div>
            )}

            {/* runtime legend */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {runtimes.map(rt => (
                    <span key={rt} className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: cssVar(RUNTIME_META[rt].colorVar) }} />
                        <span className="text-[8.5px] font-mono uppercase tracking-wider text-text-muted">{RUNTIME_META[rt].label}</span>
                    </span>
                ))}
                <span className="inline-flex items-center gap-1 ml-1">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: cssVar(STATUS_COLOR_VAR.active) }} />
                    <span className="text-[8.5px] font-mono uppercase tracking-wider text-text-muted">{graph.variant === 'greenfield' ? 'ran' : 'live'}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: cssVar(STATUS_COLOR_VAR.failed) }} />
                    <span className="text-[8.5px] font-mono uppercase tracking-wider text-text-muted">failed</span>
                </span>
            </div>

            {/* the diagram */}
            <div
                ref={wrapRef}
                className="relative overflow-auto"
                style={{ maxHeight: 540 }}
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
            >
                <style>{'@keyframes flowchartPulse{0%,100%{opacity:.35}50%{opacity:1}}'}</style>
                <svg
                    viewBox={`0 0 ${dims.width} ${dims.height}`}
                    className="w-full h-auto select-none"
                    style={{ minWidth: 320 }}
                    role="img"
                    aria-label={`End-to-end ${graph.variant} solve pipeline flowchart`}
                >
                    <defs>
                        <marker id="fc-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
                            <path d="M0,0 L6,3 L0,6 Z" fill={cssVar('--color-line-strong')} />
                        </marker>
                    </defs>

                    {/* edges (draw first, under the boxes) */}
                    {graph.edges.map((edge, i) => {
                        const d = graph.layout.edgePathD(edge, orientation);
                        const destLive = live[edge.to];
                        const stroke = destLive === 'active' ? STATUS_COLOR_VAR.active
                            : destLive === 'failed' ? STATUS_COLOR_VAR.failed
                            : '--color-line-strong';
                        const dashed = graph.nodeById[edge.to]?.optional;
                        const active = hover?.type === 'edge' && hover.to === edge.to;
                        return (
                            <g key={`e${i}`}>
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={cssVar(stroke)}
                                    strokeWidth={active ? 2.4 : 1.3}
                                    strokeDasharray={dashed ? '3 3' : undefined}
                                    markerEnd="url(#fc-arrow)"
                                    style={{ transition: 'stroke-width 120ms' }}
                                />
                                {/* fat transparent hit-target for hover */}
                                <path
                                    d={d}
                                    fill="none"
                                    stroke="transparent"
                                    strokeWidth={12}
                                    style={{ cursor: 'help' }}
                                    onMouseEnter={() => setHover({ type: 'edge', to: edge.to })}
                                />
                            </g>
                        );
                    })}

                    {/* nodes */}
                    {graph.nodes.map(spec => {
                        const b = graph.layout.nodeBox(spec, orientation);
                        const rt = RUNTIME_META[spec.runtime];
                        const st = live[spec.id] ?? 'idle';
                        // Legacy nodes carry cross-run aggregate history; greenfield nodes light
                        // purely from THIS receipt (`st`), so their aggregate stat is absent.
                        const stat = graph.variant === 'legacy' ? statFor(agg, spec.id) : undefined;
                        const measured = graph.variant === 'greenfield' ? (st === 'done') : (!!stat && stat.reached > 0);
                        const failedHist = !!stat && stat.failed > 0 && stat.passed === 0;
                        const borderVar = st === 'active' ? STATUS_COLOR_VAR.active
                            : st === 'failed' || failedHist ? STATUS_COLOR_VAR.failed
                            : rt.colorVar;
                        const dotVar = st === 'active' ? STATUS_COLOR_VAR.active
                            : st === 'failed' || failedHist ? STATUS_COLOR_VAR.failed
                            : st === 'done' || measured ? STATUS_COLOR_VAR.done
                            : STATUS_COLOR_VAR.idle;
                        const hovered = hover?.type === 'node' && hover.id === spec.id;
                        return (
                            <g
                                key={spec.id}
                                onMouseEnter={() => setHover({ type: 'node', id: spec.id })}
                                style={{ cursor: 'help' }}
                                data-testid={`flowchart-node-${spec.id}`}
                            >
                                <rect
                                    x={b.x} y={b.y} width={b.w} height={b.h} rx={5}
                                    fill={cssVar(rt.colorVar)} fillOpacity={hovered ? 0.28 : 0.14}
                                    stroke={cssVar(borderVar)} strokeWidth={hovered ? 2 : 1.2}
                                    strokeDasharray={spec.optional && !measured && st === 'idle' ? '4 3' : undefined}
                                />
                                {st === 'active' && (
                                    <rect
                                        x={b.x - 1.5} y={b.y - 1.5} width={b.w + 3} height={b.h + 3} rx={6.5}
                                        fill="none" stroke={cssVar(STATUS_COLOR_VAR.active)} strokeWidth={1.5}
                                        style={{ animation: 'flowchartPulse 1.1s ease-in-out infinite' }}
                                    />
                                )}
                                <text
                                    x={b.x + 8} y={b.cy + 3.5}
                                    style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', fill: cssVar('--color-text-primary') }}
                                >
                                    {spec.label}
                                </text>
                                {/* status dot */}
                                <circle cx={b.x + b.w - 8} cy={b.y + 8} r={3} fill={cssVar(dotVar)} />
                            </g>
                        );
                    })}
                </svg>

                {hover && (
                    <FlowchartTooltip
                        hover={hover}
                        agg={agg}
                        graph={graph}
                        gf={gf}
                        pos={pos}
                        wrapW={wrapRef.current?.clientWidth ?? dims.width}
                        receipt={community ? null : data.receipt}
                        events={community ? undefined : data.events}
                    />
                )}
            </div>

            <div className="text-[9px] font-mono text-text-muted leading-snug">
                {graph.variant === 'greenfield'
                    ? 'This diagram shows the path THIS solve took on the greenfield Rust core (receipt-driven). Stages with no evidence read NOT RUN.'
                    : <>Deduped per frame content-hash (repeat runs of one image count once). Timing = successful solves only.
                        {community ? '' : ` ${agg.successful_frames}/${agg.frame_count} frame(s) ran to completion.`}</>}
            </div>
        </div>
    );
};

// ─── tooltip ────────────────────────────────────────────────────────────────

const TooltipCard: React.FC<{ pos: { x: number; y: number }; wrapW: number; children: React.ReactNode }> = ({ pos, wrapW, children }) => {
    const W = 232;
    const left = Math.min(pos.x + 14, Math.max(4, wrapW - W - 4));
    return (
        <div
            className="absolute z-10 pointer-events-none bg-space-900 border border-line-strong rounded-md px-2.5 py-2 shadow-lg"
            style={{ left, top: pos.y + 12, width: W, maxHeight: 460, overflow: 'hidden' }}
            data-testid="flowchart-tooltip"
        >
            {children}
        </div>
    );
};

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="mt-1.5 first:mt-0">
        <div className="text-[8px] font-bold uppercase tracking-widest text-text-faint mb-0.5">{label}</div>
        {children}
    </div>
);

/**
 * A REAL thumbnail of an enabled widget that has data this run: mount its render
 * component at half scale in a bounded, non-interactive box. An ErrorBoundary
 * degrades a throwing widget to an honest text line (never a fake image, LAW 3).
 */
class ThumbBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
    constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
        super(props);
        this.state = { failed: false };
    }
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const WidgetThumbnail: React.FC<{ manifest: WidgetManifest; receipt: WidgetReceipt; events: WidgetEvents; title: string }> = ({ manifest, receipt, events, title }) => {
    const data = manifest.dataSelector(receipt, events);
    if (data == null) return null; // gated by hasData upstream; honest guard
    const Render = manifest.render;
    const fallback = (
        <div className="text-[8px] font-mono text-text-faint px-1 py-2" data-testid={`flowchart-thumb-fallback-${manifest.id}`}>
            · {title} — preview unavailable
        </div>
    );
    return (
        <div className="rounded border border-line overflow-hidden bg-space-950/60 mb-1" data-testid={`flowchart-thumb-${manifest.id}`}>
            <div className="text-[7.5px] font-mono uppercase tracking-wider text-text-faint px-1 pt-1">{title}</div>
            <div style={{ height: 84, overflow: 'hidden' }}>
                <div style={{ transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', pointerEvents: 'none' }}>
                    <ThumbBoundary fallback={fallback}>
                        <Render data={data} />
                    </ThumbBoundary>
                </div>
            </div>
        </div>
    );
};

const MAX_THUMBS = 3;

const FlowchartTooltip: React.FC<{
    hover: Hover;
    agg: FlowchartAggregate;
    graph: FlowGraph;
    gf: GreenfieldReceipt | null;
    pos: { x: number; y: number };
    wrapW: number;
    receipt: WidgetReceipt;
    events: WidgetEvents;
}> = ({ hover, agg, graph, gf, pos, wrapW, receipt, events }) => {
    // Enabled-widget previews are keyed on the hovered NODE + the data — stable
    // across mousemove re-renders, so thumbnails don't remount as the tooltip
    // follows the cursor.
    const nodeId = hover?.type === 'node' ? hover.id : null;
    const previews = useMemo(() => {
        if (!nodeId) return [];
        const spec = graph.nodeById[nodeId];
        return spec ? buildEnabledWidgetPreviews(spec, WIDGETS, receipt, events) : [];
    }, [nodeId, graph, receipt, events]);

    if (!hover) return null;
    if (hover.type === 'node') {
        const spec = graph.nodeById[hover.id];
        if (!spec) return null;
        const t = buildNodeTooltip(spec, statFor(agg, spec.id));
        // THIS SOLVE — receipt-driven, honest-or-absent (the primary content).
        const ann = annotateNode(spec, graph.variant, receipt, gf);
        const manifestById = new Map(WIDGETS.map(w => [w.id, w]));
        let thumbsShown = 0;
        return (
            <TooltipCard pos={pos} wrapW={wrapW}>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-text-primary">{t.title}</span>
                    <span className="text-[8px] font-mono uppercase tracking-wider text-text-muted">{t.runtimeLabel}{t.optional ? ' · opt' : ''}</span>
                </div>
                <div className="text-[8.5px] font-mono text-text-muted italic mt-0.5">{spec.note}</div>
                <Section label="this solve">
                    {ann.lines.map((l, i) => (
                        <div key={i} data-testid={`flowchart-ann-${spec.id}-${i}`}
                             className={`text-[9px] font-mono ${l.measured ? 'text-data' : 'text-text-faint'}`}>{l.text}</div>
                    ))}
                </Section>
                {/* Legacy-only cross-run HISTORY — the capture aggregate is keyed on legacy
                    stage ids, so it is meaningful only for the legacy graph. */}
                {graph.variant === 'legacy' && (
                    <Section label="history (this box)">
                        {t.captured.map((l, i) => (
                            <div key={i} className={`text-[9px] font-mono ${l === 'NOT MEASURED' || l.endsWith('NOT MEASURED') ? 'text-text-faint' : 'text-data'}`}>{l}</div>
                        ))}
                    </Section>
                )}
                <Section label="enables widgets">
                    {previews.length === 0 && (
                        <div className="text-[9px] font-mono text-text-faint" data-testid="flowchart-enables-none">(enables no widget yet)</div>
                    )}
                    {previews.map((p) => {
                        const m = manifestById.get(p.id);
                        if (p.thumbnail && m && thumbsShown < MAX_THUMBS) {
                            thumbsShown++;
                            return <WidgetThumbnail key={p.id} manifest={m} receipt={receipt} events={events} title={p.title} />;
                        }
                        const status = p.missing ? '(not registered)'
                            : p.hasData ? (p.tier === 'heavy' ? 'data ready (heavy — open in dashboard)' : 'data ready')
                            : 'NOT MEASURED';
                        return (
                            <div
                                key={p.id}
                                className={`text-[9px] font-mono ${p.hasData ? 'text-text-secondary' : 'text-text-faint'}`}
                                data-testid={`flowchart-enable-${p.id}`}
                            >
                                · {p.title} — {status}
                            </div>
                        );
                    })}
                </Section>
            </TooltipCard>
        );
    }
    const destSpec = graph.nodeById[hover.to];
    if (!destSpec) return null;
    // Greenfield edges: the aggregate is empty for a Rust-core solve, so show the
    // destination stage's THIS-SOLVE receipt evidence instead of legacy timing stats.
    if (graph.variant === 'greenfield') {
        const ann = annotateNode(destSpec, 'greenfield', receipt, gf);
        return (
            <TooltipCard pos={pos} wrapW={wrapW}>
                <div className="text-[10px] font-bold text-text-primary">→ {destSpec.label}</div>
                <Section label="this solve">
                    {ann.lines.map((l, i) => (
                        <div key={i} className={`text-[9px] font-mono ${l.measured ? 'text-data' : 'text-text-faint'}`}>{l.text}</div>
                    ))}
                </Section>
            </TooltipCard>
        );
    }
    const t = buildEdgeTooltip(destSpec, statFor(agg, destSpec.id));
    return (
        <TooltipCard pos={pos} wrapW={wrapW}>
            <div className="text-[10px] font-bold text-text-primary">{t.title}</div>
            <Section label="timing (successful solves)">
                <div className={`text-[9px] font-mono ${t.measured ? 'text-data' : 'text-text-faint'}`}>{t.timing}</div>
            </Section>
            <Section label="flow through this stage">
                <div className={`text-[9px] font-mono ${t.measured ? 'text-data' : 'text-text-faint'}`}>{t.flow}</div>
            </Section>
        </TooltipCard>
    );
};

export const solveFlowchartWidget: WidgetManifest<FlowchartWidgetData> = {
    id: 'solve_flowchart',
    title: 'Solve Flowchart',
    intent: 'The end-to-end solve pipeline as an interactive DAG, RECEIPT-DRIVEN — it draws the path THIS solve actually took: the greenfield Rust core (detections → band coding → verify → fine consensus → accept/abort → shared post-solve) or the legacy browser solver, selected per receipt. Each box is color-coded by runtime and annotated from the receipt (timings, compute-route stamps on GPU seams, confirm outcome); stages with no evidence read NOT RUN. Hover a box for its this-solve data + enabled-widget thumbnails. The legacy graph also folds cross-run history persisted on this box.',
    dataSelector: selectFlowchart,
    weightTier: 'stats',
    render: SolveFlowchartRender,
};
