/**
 * ★ SOLVE FLOWCHART — WebGPU TWIN (A/B experiment, owner-requested 2026-07-10).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A HYBRID WebGPU parallel of the pure-SVG `solve_flowchart` widget, so the owner
 * can A/B render smoothness side-by-side with FPS numbers (not vibes). It renders
 * the DAG GEOMETRY on the GPU (instanced rounded-box quads with status border +
 * live "active" pulse, thick-line edges) via a hand-rolled WGSL pipeline; TEXT
 * labels + hover tooltips are a positioned DOM overlay. That split is deliberate:
 * raw-WebGPU text (MSDF atlases) is a disproportionate lift for an 18-node chart,
 * and the honest A/B target is paint smoothness, not glyph rendering. The subtitle
 * says "hybrid" so nothing is oversold.
 *
 * DATA CONTRACT — IDENTICAL to the SVG widget: it imports the SAME `selectFlowchart`
 * selector (zero divergence; the manifest below reuses it verbatim). Geometry is
 * the SAME `flowchart_model` (nodeBox / edgePathD), so the two renders line up.
 *
 * Honest availability gating (never a silent fallback): if `navigator.gpu` is
 * absent or the adapter/device request fails, it renders an explicit "WebGPU
 * unavailable" state — NEVER a blank canvas, NEVER a hidden SVG substitute (that
 * would defeat the A/B). PIXEL/render ledger, display-only — asserts nothing about
 * the solve.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps } from '../registry';
import {
    FLOW_NODES, NODE_BY_ID, nodeBox, layoutDims, orientationForAspect,
    computeLiveStatus, liveStatusFromReplay, statFor, buildNodeTooltip,
    type LiveStatus, type Orientation, type FlowNodeSpec,
} from '../widgets/flowchart_model';
import { selectFlowchart, type FlowchartWidgetData } from '../widgets/SolveFlowchartWidget';
import { useReplayFrame } from '../../dashboard/replay/ReplayContext';
import { WebGPUContext } from '../../../core/WebGPUContext';
import { FlowchartGpuRenderer, type FrameStats } from './flowchart_gpu_renderer';
import { buildFlowchartScene, resolveFlowchartPalette } from './flowchart_gpu_scene';
import { FpsMeter } from './FpsMeter';
import { useRafGate } from '../useRafGate';

const cssVar = (v: string) => `var(${v})`;
const DIAGRAM_H = 360;

type GpuState = 'init' | 'ready' | 'unavailable';

const initialGpuState = (): GpuState =>
    (typeof navigator !== 'undefined' && !!navigator.gpu) ? 'init' : 'unavailable';

const SolveFlowchartWebGPURender: React.FC<WidgetRenderProps<FlowchartWidgetData>> = ({ data }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<FlowchartGpuRenderer | null>(null);
    // Frame-level idle gate ONLY (renderer internals untouched): pause the WebGPU
    // rAF loop when the twin is off-screen / in a hidden dockview tab. Shares the
    // canvas container element with wrapRef via a merged callback ref below.
    const { ref: gateRef, active: rafActive } = useRafGate<HTMLDivElement>();

    const [gpuState, setGpuState] = useState<GpuState>(initialGpuState);
    const [errorMsg, setErrorMsg] = useState<string>('navigator.gpu not present');
    const [stats, setStats] = useState<FrameStats>({ fps: 0, encodeMs: 0 });
    const [box, setBox] = useState<{ w: number; h: number }>({ w: 640, h: DIAGRAM_H });
    const [hover, setHover] = useState<string | null>(null);
    const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    // Container size → orientation + overlay placement (single observer).
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const measure = () => setBox({ w: el.clientWidth || 640, h: el.clientHeight || DIAGRAM_H });
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const orientation: Orientation = orientationForAspect(box.w, box.h);
    const dims = useMemo(() => layoutDims(orientation), [orientation]);

    // Live per-stage status: a dashboard scrub frame wins, else the live event bus.
    const replayFrame = useReplayFrame();
    const live: Record<string, LiveStatus> = useMemo(
        () => (replayFrame ? liveStatusFromReplay(replayFrame.stages) : computeLiveStatus(data.events)),
        [replayFrame, data.events],
    );

    // GPU init — once. Honest degrade to 'unavailable' on any failure.
    useEffect(() => {
        if (initialGpuState() === 'unavailable') { setGpuState('unavailable'); return; }
        let disposed = false;
        let renderer: FlowchartGpuRenderer | null = null;
        (async () => {
            try {
                const device = await WebGPUContext.init();
                if (disposed) return;
                if (!device) { setErrorMsg('no WebGPU adapter/device on this system'); setGpuState('unavailable'); return; }
                const canvas = canvasRef.current;
                if (!canvas) { setErrorMsg('canvas not mounted'); setGpuState('unavailable'); return; }
                renderer = new FlowchartGpuRenderer(canvas, device);
                renderer.onFrameStats((s) => setStats(s));
                rendererRef.current = renderer;
                renderer.start();
                setGpuState('ready');
            } catch (e) {
                if (disposed) return;
                setErrorMsg(e instanceof Error ? e.message : 'WebGPU initialization failed');
                setGpuState('unavailable');
            }
        })();
        return () => {
            disposed = true;
            renderer?.dispose();
            rendererRef.current = null;
        };
    }, []);

    // Idle gate (frame level): stop the continuous WebGPU rAF loop while the twin
    // is not visible, restart when it returns. Public start()/stop() only.
    useEffect(() => {
        const renderer = rendererRef.current;
        if (gpuState !== 'ready' || !renderer) return;
        if (rafActive) renderer.start();
        else renderer.stop();
    }, [rafActive, gpuState]);

    // Rebuild the GPU scene whenever geometry / live status changes (theme-aware
    // palette re-read each rebuild). Cheap — 18 boxes + ~40 edge segments.
    useEffect(() => {
        const renderer = rendererRef.current;
        if (gpuState !== 'ready' || !renderer) return;
        const pal = resolveFlowchartPalette();
        renderer.setBackground(pal.background);
        renderer.setViewBox(dims.width, dims.height);
        const scene = buildFlowchartScene(orientation, live, pal);
        renderer.setScene(scene.instances, scene.nodeCount, scene.edgeVerts, scene.edgeVertexCount);
    }, [gpuState, orientation, dims.width, dims.height, live]);

    // Overlay geometry: aspect-fit the viewBox into the container (CSS px).
    const fit = useMemo(() => {
        const s = Math.min(box.w / dims.width, box.h / dims.height);
        return { s, offX: (box.w - dims.width * s) / 2, offY: (box.h - dims.height * s) / 2 };
    }, [box, dims]);

    const onMove = (e: React.MouseEvent) => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
    };

    if (gpuState === 'unavailable') {
        return (
            <div className="flex flex-col gap-2" data-testid="widget-solve-flowchart-webgpu" data-gpu-state="unavailable">
                <Header stats={null} />
                <div
                    className="rounded border border-line bg-space-900 grid place-items-center text-center p-6"
                    style={{ height: DIAGRAM_H }}
                    data-testid="flowchart-webgpu-unavailable"
                >
                    <div className="font-mono text-[11px] text-warn max-w-[420px]">
                        WebGPU unavailable on this system — {errorMsg}.
                        <div className="text-text-muted mt-1.5">
                            This experimental twin renders only on WebGPU (no silent fallback, by design).
                            The pure-SVG “Solve Flowchart” widget shows the identical DAG.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const hoveredSpec = hover ? NODE_BY_ID[hover] : null;

    return (
        <div className="flex flex-col gap-2" data-testid="widget-solve-flowchart-webgpu" data-gpu-state={gpuState}>
            <Header stats={stats} />
            <div
                ref={(el) => { wrapRef.current = el; gateRef.current = el; }}
                className="relative rounded border border-line overflow-hidden bg-space-900"
                style={{ height: DIAGRAM_H }}
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
            >
                <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" data-testid="flowchart-webgpu-canvas" />

                {/* DOM overlay: labels (pointer-events none) + hover hit targets. */}
                <div className="absolute inset-0" style={{ pointerEvents: 'none' }}>
                    {FLOW_NODES.map((spec) => {
                        const b = nodeBox(spec, orientation);
                        const left = fit.offX + b.x * fit.s;
                        const top = fit.offY + b.y * fit.s;
                        const w = b.w * fit.s;
                        const h = b.h * fit.s;
                        return (
                            <React.Fragment key={spec.id}>
                                <div
                                    className="absolute font-mono truncate"
                                    style={{
                                        left, top, width: w, height: h,
                                        lineHeight: `${h}px`, paddingLeft: 7,
                                        fontSize: Math.max(7, Math.min(9.5, 9.5 * fit.s + 3)),
                                        color: cssVar('--color-text-primary'),
                                    }}
                                >
                                    {spec.label}
                                </div>
                                <div
                                    className="absolute"
                                    style={{ left, top, width: w, height: h, cursor: 'help', pointerEvents: 'auto' }}
                                    data-testid={`flowchart-webgpu-node-${spec.id}`}
                                    onMouseEnter={() => setHover(spec.id)}
                                />
                            </React.Fragment>
                        );
                    })}
                </div>

                {hoveredSpec && (
                    <NodeTooltip spec={hoveredSpec} data={data} pos={pos} wrapW={box.w} />
                )}
            </div>

            <div className="text-[9px] font-mono text-text-muted leading-snug">
                Hybrid twin — GPU draws boxes/edges/pulse; DOM draws text + tooltips. Geometry &amp; data are identical to the
                SVG “Solve Flowchart”. FPS = display cadence · enc = GPU command encode time (CPU-side).
            </div>
        </div>
    );
};

const Header: React.FC<{ stats: FrameStats | null }> = ({ stats }) => (
    <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
            Solve Flowchart — WebGPU (hybrid, experimental)
        </div>
        <div className="flex items-center gap-3">
            <FpsMeter label="rAF" />
            <span className="font-mono text-[9px] text-data tabular-nums" data-testid="flowchart-webgpu-encode">
                enc: {stats && stats.encodeMs > 0 ? `${stats.encodeMs.toFixed(2)} ms` : '—'}
            </span>
        </div>
    </div>
);

const NodeTooltip: React.FC<{ spec: FlowNodeSpec; data: FlowchartWidgetData; pos: { x: number; y: number }; wrapW: number }> = ({ spec, data, pos, wrapW }) => {
    const t = buildNodeTooltip(spec, statFor(data.aggregate, spec.id));
    const W = 232;
    const left = Math.min(pos.x + 14, Math.max(4, wrapW - W - 4));
    return (
        <div
            className="absolute z-10 pointer-events-none bg-space-900 border border-line-strong rounded-md px-2.5 py-2 shadow-lg"
            style={{ left, top: pos.y + 12, width: W, maxHeight: 380, overflow: 'hidden' }}
            data-testid="flowchart-webgpu-tooltip"
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-text-primary">{t.title}</span>
                <span className="text-[8px] font-mono uppercase tracking-wider text-text-muted">
                    {t.runtimeLabel}{t.optional ? ' · opt' : ''}
                </span>
            </div>
            <div className="text-[8.5px] font-mono text-text-muted italic mt-0.5">{spec.note}</div>
            <div className="text-[8px] font-bold uppercase tracking-widest text-text-faint mt-1.5 mb-0.5">data captured</div>
            {t.captured.map((l, i) => (
                <div key={i} className={`text-[9px] font-mono ${l === 'NOT MEASURED' || l.endsWith('NOT MEASURED') ? 'text-text-faint' : 'text-data'}`}>{l}</div>
            ))}
            <div className="text-[8px] font-bold uppercase tracking-widest text-text-faint mt-1.5 mb-0.5">enables widgets</div>
            {t.enables.map((l, i) => (
                <div key={i} className="text-[9px] font-mono text-text-secondary">· {l}</div>
            ))}
        </div>
    );
};

export const solveFlowchartWebgpuWidget: WidgetManifest<FlowchartWidgetData> = {
    id: 'solve_flowchart_webgpu',
    title: 'Solve Flowchart (WebGPU · hybrid)',
    intent: 'A WebGPU-rendered twin of the ★ Solve Flowchart for a live A/B of render smoothness: the DAG geometry (boxes, edges, active-stage pulse) is drawn by a hand-rolled WGSL pipeline while text/tooltips stay in a DOM overlay (hybrid). Identical selector + geometry to the SVG widget; both panes show FPS/frame-time. Renders an honest “WebGPU unavailable” state where WebGPU is absent (no silent fallback).',
    dataSelector: selectFlowchart,
    weightTier: 'stats',
    render: SolveFlowchartWebGPURender,
};

export default SolveFlowchartWebGPURender;
