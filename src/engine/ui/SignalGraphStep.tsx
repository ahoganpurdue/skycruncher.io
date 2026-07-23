import React, { useEffect, useRef, useState, useMemo } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { SignalPacket, SignalPoint } from '../types/Main_types';
import { ScaleManager } from '../pipeline/m2_hardware/scale_manager';
import { computeHorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';
import {
    initHorizonEdit,
    moveHorizonNode,
    removeHorizonNode,
    insertHorizonNode,
    hitTestHorizonNode,
    nearestHorizonSegment,
    buildHorizonCorrection,
    type HorizonEditState,
} from '../pipeline/m4_signal_detect/horizon_editor';
import { computeCullingCounts } from '../pipeline/m4_signal_detect/culling_stats';
import { HorizonEditorPanel } from './HorizonEditorPanel';
import { getStepMeta } from './wizard_steps';

interface SignalGraphProps {
    session: OrchestratorSession;
    isActive: boolean;
    /** Run-All: auto-start extraction and auto-confirm via the same handlers the buttons use. */
    autoRun?: boolean;
    backgroundImageUrl?: string;
    onComplete: () => void;
    onImageClick: (x: number, y: number) => void;
}

export const SignalGraphStep: React.FC<SignalGraphProps> = ({ session, isActive, autoRun, backgroundImageUrl, onComplete, onImageClick }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [viewMode, setViewMode] = useState<'ALL' | 'CLEAN' | 'ANOMALY' | 'CONTEXT'>('ALL');
    const [showAtmospheric, setShowAtmospheric] = useState(true);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [signal, setSignal] = useState<SignalPacket | null>(session.signal);
    // Back-navigation tolerance: extraction already ran if the session holds
    // a signal (re-running would fail anyway — the raw buffer is released).
    const [hasRun, setHasRun] = useState(!!session.signal);
    // AUTO only advances past a run this mount performed — re-entering an
    // already-complete step via Back must NOT bounce forward.
    const ranThisMount = useRef(false);
    const [cullingThreshold, setCullingThreshold] = useState(40); 
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    // Overlay toggles: rows are rendered from the MEASURED per-reason counts
    // (computeCullingCounts) — this record only remembers which toggles the
    // user switched on. PLANET defaults on (candidates are science-relevant).
    const [cullingFilters, setCullingFilters] = useState<Record<string, boolean>>({
        'PLANET': true
    });
    // HORIZON EDITOR (recorded testimony — never mutates the automatic estimate).
    // Seed the working state from any correction the session already holds
    // (back-navigation / re-entry restores what the observer asserted).
    const [horizonEditing, setHorizonEditing] = useState(false);
    const [horizonEdit, setHorizonEdit] = useState<HorizonEditState | null>(() =>
        session.horizonCorrection
            ? {
                points: session.horizonCorrection.corrected.map(p => ({ ...p })),
                deltas: session.horizonCorrection.deltas.map(d => ({ ...d })),
            }
            : null
    );
    // Index of the node currently being dragged (ref — mid-drag mutation must
    // not trigger re-render churn; the move commits through setHorizonEdit).
    const horizonDragIndex = useRef<number | null>(null);

    // Pre-load background image
    useEffect(() => {
        const url = backgroundImageUrl || session.previewUrl;
        console.log(`[SignalGraph] Loading background: ${url ? url.substring(0, 30) + '...' : 'NONE'}`);
        if (url) {
            const img = new Image();
            img.src = url;
            img.onload = () => {
                console.log(`[SignalGraph] Background ready: ${img.width}x${img.height}`);
                setBgImage(img);
            };
            img.onerror = (e) => console.error("[SignalGraph] Background load failed:", e);
        }
    }, [backgroundImageUrl, session.previewUrl, session]); // session included for consistency

    // RUN EXTRACTION
    const runExtraction = async () => {
        if (loading || hasRun) return;
        setLoading(true);
        const interval = setInterval(() => {
            setStatus(session.status);
        }, 50);

        try {
            const res = await session.step2_Extract();
            setSignal(res);
            setHasRun(true);
            ranThisMount.current = true;
        } catch (err) {
            console.error("Extraction failed:", err);
        } finally {
            clearInterval(interval);
            setLoading(false);
        }
    };

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        // In horizon-edit mode the canvas belongs to the editor: swallow the
        // click so it never reaches onImageClick (byte-identical when not editing).
        if (horizonEditing) return;
        const canvas = canvasRef.current;
        if (!canvas || !session.scales) return;
        
        const rect = canvas.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

        const { x, y } = session.scales.canvasToNative(mouseX, mouseY, canvas.width, canvas.height);

        if (x >= 0 && x < session.scales.nativeW && y >= 0 && y < session.scales.nativeH) {
            onImageClick(x, y);
        }
    };

    const hasSignal = !!signal;

    // Detection-envelope horizon (owner design): the lowest sky-supported
    // detection per column, left to right, traces the terrain silhouette —
    // including towers that punch holes in the star field. Evidence-gated:
    // full-sky frames yield hasTerrainEvidence=false and draw nothing.
    const horizonEnvelope = useMemo(() => {
        if (!signal || !session.scales) return null;
        const pts = [...signal.clean_stars, ...(signal.anomalies ?? [])];
        if (pts.length < 24) return null;
        return computeHorizonEnvelope(pts, session.scales.nativeW, session.scales.nativeH);
    }, [signal, session.scales]);

    // The editor affordance exists ONLY with measured terrain evidence — the
    // exact gate the amber overlay draws on (honest-or-absent, LAW 3).
    const horizonEditable = !!horizonEnvelope?.hasTerrainEvidence;

    // Display record for the panel: {auto, deltas, corrected}. Null until the
    // observer actually corrects something. captured_at is stabilized from the
    // session's first-persisted value so it does not churn per render.
    const horizonCorrectionForDisplay = useMemo(() => {
        if (!horizonEnvelope || !horizonEdit || horizonEdit.deltas.length === 0 || !session.scales) return null;
        return buildHorizonCorrection(
            horizonEnvelope,
            horizonEdit,
            { width: session.scales.nativeW, height: session.scales.nativeH },
            session.horizonCorrection?.captured_at,
        );
    }, [horizonEnvelope, horizonEdit, session]);

    // Keep the session's testimony in sync with the working edit state. Cleared
    // to null on reset (honest-or-absent). This NEVER touches the auto estimate,
    // culling, or the solve — it only records what the observer asserted.
    useEffect(() => {
        session.setHorizonCorrection(horizonCorrectionForDisplay);
    }, [horizonCorrectionForDisplay, session]);

    // Canvas-pixel coords of a pointer event (matches handleClick's mapping).
    const eventToCanvasPx = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        return {
            px: (e.clientX - rect.left) * (canvas.width / rect.width),
            py: (e.clientY - rect.top) * (canvas.height / rect.height),
        };
    };

    const toggleHorizonEdit = () => setHorizonEditing(v => !v);
    const resetHorizonEdit = () => { horizonDragIndex.current = null; setHorizonEdit(null); };

    const onHorizonMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!horizonEditing || !horizonEnvelope || !session.scales) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { px, py } = eventToCanvasPx(e);
        const scales = session.scales;
        const project = (nx: number, ny: number) => scales.nativeToCanvas(nx, ny, canvas.width, canvas.height);
        const state = horizonEdit ?? initHorizonEdit(horizonEnvelope);
        const hit = hitTestHorizonNode(state.points, project, px, py, 10);
        if (e.shiftKey) {
            // shift-click ON a node → remove it; shift-click the line → add one.
            if (hit >= 0) {
                setHorizonEdit(removeHorizonNode(state, hit));
            } else {
                const seg = nearestHorizonSegment(state.points, project, px, py, 12);
                if (seg) setHorizonEdit(insertHorizonNode(state, seg.index, seg.x, seg.y));
            }
            return;
        }
        // Plain press on a node → begin dragging it.
        if (hit >= 0) {
            horizonDragIndex.current = hit;
            if (!horizonEdit) setHorizonEdit(state);
        }
    };

    const onHorizonMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!horizonEditing || horizonDragIndex.current == null || !horizonEnvelope || !session.scales) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { px, py } = eventToCanvasPx(e);
        const { x, y } = session.scales.canvasToNative(px, py, canvas.width, canvas.height);
        const idx = horizonDragIndex.current;
        setHorizonEdit(prev => moveHorizonNode(prev ?? initHorizonEdit(horizonEnvelope), idx, x, y));
    };

    const endHorizonDrag = () => { horizonDragIndex.current = null; };

    // Honest per-reason culling counts (owner-reported trust bug: these all
    // rendered 0 because anomalies[] alone misses planet-routed stars,
    // hard-REJECTED candidates, and the DEDUPLICATION bucket entirely).
    const cullingCounts = useMemo(() => computeCullingCounts(signal), [signal]);

    const culledStars = useMemo(() => {
        if (!signal || !signal.anomaly_grid || !signal.grid_w || !signal.cell_size) return signal?.clean_stars || [];
        
        return signal.clean_stars.filter(star => {
            const gx = Math.floor(star.x / signal.cell_size!);
            const gy = Math.floor(star.y / signal.cell_size!);
            const idx = gy * signal.grid_w! + gx;
            const density = signal.anomaly_grid![idx] || 0;
            return density <= cullingThreshold;
        });
    }, [signal, cullingThreshold]);

    // DRAWING LOGIC
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx || !signal || !session.scales) return;

        const drawSegmentedMasks = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, masks: any, scales: ScaleManager) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = masks.dim;
            tempCanvas.height = masks.dim;
            const tCtx = tempCanvas.getContext('2d')!;
            const imgData = tCtx.createImageData(masks.dim, masks.dim);
            const data = imgData.data;

            for (let i = 0; i < masks.dim * masks.dim; i++) {
                const topo = masks.topography[i];
                const manMade = masks.manMade[i];
                const arboreal = masks.arboreal[i];

                if (topo > 0.5) {
                    data[i * 4] = 139; data[i * 4 + 1] = 94; data[i * 4 + 2] = 60; data[i * 4 + 3] = 60; // Brown (Subtle)
                } else if (manMade > 0.5) {
                    data[i * 4] = 6; data[i * 4 + 1] = 182; data[i * 4 + 2] = 212; data[i * 4 + 3] = 80;  // Cyan (Subtle)
                } else if (arboreal > 0.5) {
                    data[i * 4] = 34; data[i * 4 + 1] = 197; data[i * 4 + 2] = 94; data[i * 4 + 3] = 60; // Green (Subtle)
                } else {
                    data[i * 4 + 3] = 0;
                }
            }
            tCtx.putImageData(imgData, 0, 0);

            // Rescale and draw to main canvas
            const canvasScale = Math.min(canvas.width / scales.previewW, canvas.height / scales.previewH);
            const ox = (canvas.width - scales.previewW * canvasScale) / 2;
            const oy = (canvas.height - scales.previewH * canvasScale) / 2;
            
            ctx.drawImage(tempCanvas, ox, oy, scales.previewW * canvasScale, scales.previewH * canvasScale);
        };

        const draw = () => {
            // Clear
            ctx.fillStyle = '#050505';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // 0. Draw Background Image
            if (bgImage) {
                ctx.globalAlpha = 1.0; // Draw full intensity image
                const canvasScale = Math.min(canvas.width / session.scales!.previewW, canvas.height / session.scales!.previewH);
                const ox = (canvas.width - session.scales!.previewW * canvasScale) / 2;
                const oy = (canvas.height - session.scales!.previewH * canvasScale) / 2;

                ctx.drawImage(bgImage, ox, oy, session.scales!.previewW * canvasScale, session.scales!.previewH * canvasScale);
                ctx.globalAlpha = 1.0;
            }

            // 1. Draw Atmospheric Gradients (Rayleigh / Light Pollution)
            if (showAtmospheric && signal.background_level_top !== undefined) {
                const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
                // Dynamically adjust opacity and color based on detected levels
                const topOpacity = Math.min(0.2, signal.background_level_top * 5);
                const botOpacity = Math.min(0.3, signal.background_level_bottom! * 7);
                
                grad.addColorStop(0, `rgba(30, 58, 138, ${topOpacity})`); // Rayleigh Blue
                grad.addColorStop(1, `rgba(251, 146, 60, ${botOpacity})`); // Light Pollution Amber
                
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // 2. Draw Horizon (deterministic detection envelope, computeHorizonEnvelope)
            if (signal.horizonVector && (viewMode === 'ALL' || viewMode === 'CONTEXT')) {
                // If we have segmentation masks, we can draw the detailed overlays
                if (signal.segmentationMasks) {
                    drawSegmentedMasks(ctx, canvas, signal.segmentationMasks, session.scales!);
                } else {
                    // Fallback to simple horizon fill (original logic)
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
                    ctx.beginPath();
                    const nativeW = session.scales!.nativeW;
                    const nativeH = session.scales!.nativeH;
                    const step = Math.max(1, Math.floor(nativeW / 200));
                    
                    let first = session.scales!.nativeToCanvas(0, nativeH, canvas.width, canvas.height);
                    ctx.moveTo(first.x, first.y);
                    
                    for (let x = 0; x <= nativeW; x += step) {
                        const hY = signal.horizonVector[Math.min(x, nativeW - 1)];
                        const { x: cx, y: cy } = session.scales!.nativeToCanvas(Math.min(x, nativeW - 1), hY, canvas.width, canvas.height);
                        ctx.lineTo(cx, cy);
                    }
                    
                    let last = session.scales!.nativeToCanvas(nativeW, nativeH, canvas.width, canvas.height);
                    ctx.lineTo(last.x, last.y);
                    ctx.closePath();
                    ctx.fill();
                }

                ctx.strokeStyle = '#34d399'; // --color-solve (detection-envelope horizon)
                ctx.lineWidth = 3;
                ctx.beginPath();
                
                // Draw high-res vector
                const nativeW = session.scales!.nativeW;
                const step = Math.max(1, Math.floor(nativeW / 200));
                for (let x = 0; x < nativeW; x += step) {
                    const { x: cx, y: cy } = session.scales!.nativeToCanvas(x, signal.horizonVector[x], canvas.width, canvas.height);
                    if (x === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                }
                
                ctx.stroke();
                
                // [STRICT] Glow for detection-envelope horizon
                ctx.strokeStyle = 'rgba(52, 211, 153, 0.3)'; // --color-solve @ 30%
                ctx.lineWidth = 6;
                ctx.stroke();
                
                // Label Horizon
                const midX = Math.floor(session.scales!.nativeW / 2);
                const midY = signal.horizonVector[midX];
                
                const { x: cx, y: cy } = session.scales!.nativeToCanvas(midX, midY, canvas.width, canvas.height);
                ctx.fillStyle = '#34d399'; // --color-solve
                ctx.font = 'bold 13px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 4;
                ctx.fillText('DETECTION-ENVELOPE HORIZON', cx, cy + 30);
                
                ctx.fillStyle = signal.segmentationMasks ? '#38bdf8' : 'rgba(248, 113, 113, 0.8)'; // --color-accent-400 / --color-danger
                ctx.font = '10px JetBrains Mono, monospace';
                ctx.fillText(signal.segmentationMasks ? 'GROUND MASK ACTIVE (MULTI-CLASS)' : 'GROUND EXCLUSION ZONE', cx, cy + 50);
                ctx.shadowBlur = 0;
            }

            // 2b. Detection-envelope horizon (owner design): stars as the
            // point nodes of the terrain silhouette. Drawn only with
            // measured evidence; amber to distinguish from the AI mask.
            if (horizonEnvelope?.hasTerrainEvidence && (viewMode === 'ALL' || viewMode === 'CONTEXT')) {
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 2;
                ctx.setLineDash([8, 5]);
                ctx.beginPath();
                horizonEnvelope.points.forEach((p, i) => {
                    const { x: cx, y: cy } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                    if (i === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                });
                ctx.stroke();
                ctx.setLineDash([]);
                // Measured nodes get ticks; interpolated spans stay bare.
                ctx.fillStyle = '#fbbf24';
                for (const p of horizonEnvelope.points) {
                    if (!p.measured) continue;
                    const { x: cx, y: cy } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
                }
                const mid = horizonEnvelope.points[Math.floor(horizonEnvelope.points.length / 2)];
                const { x: lx, y: ly } = session.scales!.nativeToCanvas(mid.x, mid.y, canvas.width, canvas.height);
                ctx.font = '10px JetBrains Mono, monospace';
                ctx.textAlign = 'center';
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 4;
                ctx.fillText(`DETECTION HORIZON (${Math.round(horizonEnvelope.coverage * 100)}% measured)`, lx, ly - 10);
                ctx.shadowBlur = 0;
            }

            // 2c. Observer horizon correction (testimony) + edit handles. The
            // corrected polyline is drawn in pink to distinguish the observer's
            // assertion from the amber automatic estimate; the auto envelope (2b)
            // stays visible underneath (both retained). Handles are live only in
            // edit mode.
            if ((horizonEditable && horizonEditing) || (horizonEdit && horizonEdit.deltas.length > 0)) {
                const editPts = horizonEdit?.points ?? horizonEnvelope!.points;
                if (horizonEdit && horizonEdit.deltas.length > 0) {
                    ctx.strokeStyle = '#f472b6'; // pink — observer testimony
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    editPts.forEach((p, i) => {
                        const { x: cx, y: cy } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
                    });
                    ctx.stroke();
                }
                if (horizonEditing) {
                    for (const p of editPts) {
                        const { x: cx, y: cy } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                        ctx.beginPath();
                        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(244, 114, 182, 0.9)';
                        ctx.fill();
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }
            }

            // 3. Draw Milky Way Structure (Stacked Ovals)
            if ((signal as any).milky_way_ellipses && (viewMode === 'ALL' || viewMode === 'CLEAN' || viewMode === 'CONTEXT')) {
                const ellipses = (signal as any).milky_way_ellipses;
                ellipses.forEach((e: any, i: number) => {
                    const { x, y } = session.scales!.nativeToCanvas(e.x, e.y, canvas.width, canvas.height);
                    const rx = e.rx * (canvas.width / 4000); // Scale radius
                    const ry = e.ry * (canvas.width / 4000);
                    
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(e.theta);
                    
                    // Faint atmospheric amber
                    ctx.fillStyle = 'rgba(251, 191, 36, 0.08)';
                    ctx.strokeStyle = 'rgba(251, 191, 35, 0.2)';
                    ctx.lineWidth = 1;

                    ctx.beginPath();
                    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();

                    // Label the backbone
                    if (i === Math.floor(ellipses.length / 2)) {
                        ctx.fillStyle = '#fbbf24';
                        ctx.font = 'bold 12px Inter, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('MILKY WAY STRUCTURE (TRACE)', x, y - ry - 10);
                    }
                });
            }


            // 4. Draw Stars & Anomalies
            if (viewMode === 'ALL' || viewMode === 'ANOMALY') {
                const visibleAnomalies = signal.anomalies.filter(a => a.culling_reason && cullingFilters[a.culling_reason]);

                // Draw Satellite Interval Lines first
                const satellites = visibleAnomalies.filter(a => a.culling_reason === 'SATELLITE');
                if (satellites.length > 3) {
                    ctx.strokeStyle = 'rgba(248, 113, 113, 0.4)'; // --color-danger @ 40%
                    ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    // Basic heuristic: connect them if they are in a cluster
                    satellites.sort((a,b) => a.x - b.x).forEach((p, i) => {
                         const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                         if (i === 0) ctx.moveTo(x, y);
                         else ctx.lineTo(x, y);
                    });
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                ctx.fillStyle = 'rgba(56, 189, 248, 0.05)'; 
                visibleAnomalies.forEach(p => {
                    const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                    ctx.beginPath();
                    ctx.arc(x, y, 2, 0, Math.PI * 2);
                    ctx.fill();
                });

                ctx.strokeStyle = '#f87171'; // --color-danger
                ctx.lineWidth = 1;
                visibleAnomalies.forEach(p => {
                    const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                    const size = 3;
                    ctx.beginPath();
                    ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size);
                    ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size);
                    ctx.stroke();

                    // Optional label for reason
                    if (viewMode === 'ANOMALY' || p.culling_reason === 'SATELLITE') {
                        ctx.fillStyle = '#f87171';
                        ctx.font = 'bold 8px Inter, sans-serif';
                        ctx.fillText(p.culling_reason === 'SATELLITE' ? 'TRAIL' : (p.culling_reason || ''), x + 5, y + 5);
                    }
                });
            }

            if (viewMode === 'ALL' || viewMode === 'CLEAN') {
                culledStars.forEach(p => {
                    const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                    const r = Math.max(1, Math.log10(p.flux) * 0.5); 
                    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
                    grad.addColorStop(0, '#fff');
                    grad.addColorStop(0.4, 'rgba(52, 211, 153, 0.8)'); // --color-solve @ 80%
                    grad.addColorStop(1, 'transparent');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
                    ctx.fill();
                });

                if (signal.planet_candidates) {
                    signal.planet_candidates.forEach(p => {
                        const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                        ctx.strokeStyle = '#38bdf8'; // --color-accent-400 (candidate, unverified)
                        ctx.lineWidth = 2;
                        ctx.setLineDash([2, 1]);
                        ctx.beginPath();
                        ctx.arc(x, y, 10, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);

                        ctx.fillStyle = 'rgba(56, 189, 248, 0.5)'; // --color-accent-400 @ 50%
                        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();

                        const label = (p as any).label || 'PLANET?';
                        ctx.fillStyle = '#7dd3fc'; // --color-accent-300
                        ctx.font = 'bold 10px Inter, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText(label, x, y - 18);
                    });
                }
            }
        };

        draw();
    }, [signal, viewMode, culledStars, bgImage, session.scales, showAtmospheric, cullingFilters, horizonEnvelope, horizonEditing, horizonEdit, horizonEditable]);

    const handleConfirm = () => {
        if (signal) {
            session.signal = { ...signal, clean_stars: culledStars };
        }
        onComplete();
    };

    // AUTO: start extraction through the same handler as the button.
    useEffect(() => {
        if (!autoRun || !isActive || hasRun || loading) return;
        runExtraction();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, hasRun, loading]);

    // AUTO: confirm once extraction (run by THIS mount) has produced signal.
    // Failure leaves signal null -> no advance (stop on failure).
    useEffect(() => {
        if (!autoRun || !isActive || loading || !signal || !ranThisMount.current) return;
        const id = setTimeout(() => handleConfirm(), 700);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, loading, signal, hasRun]);

    return (
        <>
        <div className="flex flex-col h-full overflow-hidden">
            <div className="p-8 pb-4 flex justify-between items-end shrink-0">
                <div>
                    <h2 className="text-2xl font-light text-text-primary mb-2">{getStepMeta(3).title}</h2>
                    <p className="text-text-secondary max-w-xl">
                        {getStepMeta(3).subtitle}
                    </p>
                </div>
                <div className="flex gap-4 text-right">
                    <div>
                        <div data-testid="step3-star-count" className="text-2xl text-data font-mono">{culledStars.length}</div>
                        <div className="text-xs text-text-muted uppercase tracking-wide">Stars</div>
                    </div>
                    <div>
                        {/* Pre-run there is no measurement — '--' sentinel, muted
                            (warn amber is earned only by a real anomaly count). */}
                        <div className={`text-2xl font-mono ${signal ? 'text-warn' : 'text-text-muted'}`}>{signal ? signal.anomalies.length : '--'}</div>
                        <div className="text-xs text-text-muted uppercase tracking-wide">Anomalies</div>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 relative bg-space-950/60 border-y border-line-subtle">
                <canvas
                    key={backgroundImageUrl || session.previewUrl || 'empty'}
                    ref={canvasRef}
                    width={1200}
                    height={600}
                    onClick={handleClick}
                    onMouseDown={onHorizonMouseDown}
                    onMouseMove={onHorizonMouseMove}
                    onMouseUp={endHorizonDrag}
                    onMouseLeave={endHorizonDrag}
                    className={`w-full h-full object-contain ${horizonEditing ? 'cursor-pointer' : 'cursor-crosshair'} transition-opacity duration-500 ${loading ? 'opacity-20' : 'opacity-100'}`}
                />

                {!hasRun && !loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm">
                        <button
                            data-testid="step3-start"
                            onClick={runExtraction}
                            className="px-12 py-6 bg-accent-600 hover:bg-accent-500 text-white rounded-xl font-bold transition-all shadow-2xl tracking-widest uppercase"
                        >
                            Start Signal Extraction
                        </button>
                    </div>
                )}

                {loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-black/60">
                        <div className="w-16 h-16 border-4 border-accent-500 border-t-transparent rounded-full animate-spin"></div>
                        <div className="text-accent-400 font-mono text-lg animate-pulse">{status || "Preparing..."}</div>
                    </div>
                )}
                
                <div className="absolute top-4 left-4 flex gap-2">
                    {['ALL', 'CLEAN', 'ANOMALY', 'CONTEXT'].map(mode => (
                        <button
                            key={mode}
                            onClick={() => setViewMode(mode as any)}
                            className={`px-3 py-1 text-xs font-bold rounded border backdrop-blur-md ${viewMode === mode ? 'bg-accent-600 text-white border-accent-500' : 'bg-space-900/70 text-text-secondary border-line hover:border-line-strong'}`}
                        >
                            {mode}
                        </button>
                    ))}
                    <button 
                        onClick={() => setShowAtmospheric(!showAtmospheric)}
                        className={`ml-4 px-3 py-1 text-[10px] font-bold rounded border backdrop-blur-md uppercase tracking-tighter ${showAtmospheric ? 'bg-accent-glow text-accent-400 border-accent-500/50' : 'bg-space-900/70 text-text-muted border-line'}`}
                    >
                        Atmosphere: {showAtmospheric ? 'ON' : 'OFF'}
                    </button>
                </div>

                {/* Horizon editor affordance — present ONLY with measured terrain
                    evidence (honest-or-absent). Edits are recorded testimony and
                    never touch the automatic estimate or the solve. */}
                {horizonEditable && (
                    <div className="absolute top-16 left-4 z-10">
                        <HorizonEditorPanel
                            envelope={horizonEnvelope}
                            correction={horizonCorrectionForDisplay}
                            editing={horizonEditing}
                            onToggleEdit={toggleHorizonEdit}
                            onReset={resetHorizonEdit}
                        />
                    </div>
                )}

                {hasSignal && (
                    <div className="absolute top-4 right-4 flex flex-col gap-2">
                        {/* Culling Level Slider */}
                        <div className="bg-space-900/80 backdrop-blur-md border border-line p-3 rounded-lg w-64 shadow-2xl">
                            <div className="flex justify-between items-center mb-2">
                                <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Density Culling</div>
                                <div className="text-xs font-mono text-data">{cullingThreshold}</div>
                            </div>
                            <input
                                type="range"
                                min="1"
                                max="50"
                                step="1"
                                value={cullingThreshold}
                                onChange={(e) => setCullingThreshold(parseInt(e.target.value))}
                                className="w-full h-1 bg-space-700 rounded-lg appearance-none cursor-pointer accent-accent-500"
                                title="Star Culling Threshold"
                                aria-label="Star Culling Threshold"
                            />
                        </div>

                        {/* Culling Inspector Toggles — real per-reason counts.
                            "visible" = culled points the overlay can draw;
                            "+N dropped" = candidates the m4 tally counted but
                            that were hard-rejected from every output list. */}
                        <div className="bg-space-900/80 backdrop-blur-md border border-line p-3 rounded-lg w-64 shadow-2xl" data-testid="step3-culling-inspector">
                            <div className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-3 border-b border-line-subtle pb-2">
                                Culling Inspector (Show Culled)
                            </div>
                            <div className="grid grid-cols-1 gap-1">
                                {cullingCounts.length === 0 && (
                                    <div className="text-[10px] text-text-muted font-mono px-2 py-1">
                                        No culled candidates recorded.
                                    </div>
                                )}
                                {cullingCounts.map(({ reason, visible, dropped }) => {
                                    const enabled = !!cullingFilters[reason];
                                    return (
                                        <button
                                            key={reason}
                                            data-testid={`step3-cull-${reason}`}
                                            onClick={() => setCullingFilters(prev => ({ ...prev, [reason]: !enabled }))}
                                            className={`flex items-center justify-between px-2 py-1 round text-[10px] font-medium transition-colors ${
                                                enabled ? 'bg-danger-dim text-danger border border-danger/30' : 'bg-space-800/60 text-text-muted border border-transparent hover:bg-space-750'
                                            }`}
                                        >
                                            <span>{reason.replace(/_/g, ' ')}</span>
                                            <span className="font-mono opacity-80">
                                                {visible}
                                                {dropped > 0 && (
                                                    <span className="opacity-60" title={`${dropped} candidates culled for this reason were dropped before the anomaly list (not drawable)`}> +{dropped} cut</span>
                                                )}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="h-20 shrink-0 flex items-center justify-end px-8 bg-space-900/70 border-t border-line-subtle">
                <button data-testid="step3-confirm" onClick={handleConfirm} disabled={!hasSignal || loading} className="px-6 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-space-750 disabled:text-text-muted text-white rounded-lg font-medium transition-all">
                    Confirm and Align
                </button>
            </div>
        </div>
        </>
    );
};
