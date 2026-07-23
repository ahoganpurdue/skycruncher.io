/**
 * FinalImageView.tsx — the PAYOFF: "here is your fixed image".
 *
 * At the end of the pipeline the wizard used to present only receipts, tiles and
 * export machinery — never the processed frame itself. This view closes that gap:
 * it presents the calibrated frame through the SAME STF v2 display stretch the
 * wizard already produced (`session.previewUrl`), full-viewport-class, pan/zoomable
 * (composes ZoomPanViewport), with the plate-solution overlay optional/toggleable.
 *
 * LEDGER: RENDER PLANE — display only. Consumes what the pipeline already produced
 * (the STF-stretched preview + the matched-star geometry) and feeds NEITHER ledger.
 * No new science, no new pixel math, ONE existing draw — never touches the solve,
 * WCS, matched stars, or any receipt/measurement value. Byte-identical to the
 * pinned solves by construction (it renders AFTER the solve, reading finished data).
 *
 * HONEST-OR-ABSENT (LAW 3): the display stretch is labelled a RENDER product
 * ("Display stretch (screen transfer) — science data unchanged"). When no display
 * render exists for a run (preview generation was skipped, e.g. a headless caller),
 * the view says so rather than fabricating an image.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestratorSession } from '../pipeline/orchestrator_session';
import { ZoomPanViewport } from './widgets/ZoomPanViewport';
import { canvasToPngBytes, saveExport } from './utils/save_export';
import './styles/Symbols.css';

interface FinalImageViewProps {
    session: OrchestratorSession;
    /**
     * Lets the host (IntegrationStep) read the composited display canvas so the
     * step-7 ExportSelector can offer the render-plane PNG through the same unified
     * export sink. Called with the canvas element on mount, null on unmount.
     */
    registerCanvas?: (el: HTMLCanvasElement | null) => void;
}

export const FinalImageView: React.FC<FinalImageViewProps> = ({ session, registerCanvas }) => {
    const heroRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    // The clean fixed image is the payoff — the solve overlay is opt-in.
    const [overlayOn, setOverlayOn] = useState(false);
    // APPLIED-SCIENCE view is the DEFAULT (measurements as displayed); the user can
    // flip to the un-corrected original. Only meaningful when a correction applied.
    const [showOriginal, setShowOriginal] = useState(false);
    const [zoom, setZoom] = useState<{ scale: number; reset: () => void }>({ scale: 1, reset: () => {} });
    const [cssSize, setCssSize] = useState<{ w: number; h: number } | null>(null);
    const [savingPng, setSavingPng] = useState(false);
    const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const previewUrl = session.previewUrl;
    const solution = session.solution;
    const scales = session.scales;
    // Which per-frame-fitted distortion model the corrected preview applied (null =
    // none qualified → warp-free STF; honest-or-absent, no fake "corrected" label).
    const warpApplied = session.renderWarpApplied;
    // Set when a model was selected but the render admission gate REFUSED it (would
    // extrapolate outside its fit support) — the preview then stays the original and
    // the caption states, dryly, that the distortion model is not valid frame-wide.
    const warpRefused = session.renderWarpRefused;
    const previewUrlOriginal = session.previewUrlOriginal;
    // The toggle only exists when a correction actually ran AND we cached the original.
    const canToggleOriginal = !!(warpApplied && previewUrlOriginal);
    // What the canvas shows: applied-science (corrected previewUrl) by default; the
    // cached un-corrected URL when the user flipped to "Original". Zero recompute.
    const shownUrl = canToggleOriginal && showOriginal ? previewUrlOriginal : previewUrl;
    const colorLabel = session.previewColorInfo?.label ?? null;

    // Backing-store resolution = the preview's native render resolution, so the STF
    // preview is drawn 1:1 (crisp) and the canvas matches the preview aspect exactly
    // (letterbox offsets collapse to zero, keeping the overlay mapping exact).
    const backing = useMemo(() => {
        if (scales && scales.previewW > 0 && scales.previewH > 0) return { w: scales.previewW, h: scales.previewH };
        if (bgImage) return { w: bgImage.naturalWidth, h: bgImage.naturalHeight };
        return null;
    }, [scales, bgImage]);

    // Load the STF-stretched display preview (a JPEG data URL from ImageProcessor).
    // `shownUrl` is the applied-science corrected render by default, or the cached
    // un-corrected original when the toggle is flipped — swapping is a pure src change.
    useEffect(() => {
        if (!shownUrl) return;
        const img = new Image();
        img.src = shownUrl;
        img.onload = () => setBgImage(img);
        img.onerror = (e) => console.error('[FinalImageView] preview load failed:', e);
    }, [shownUrl]);

    // Contain-fit the display box to the hero region (aspect-preserving), tracked
    // live so the image stays fully visible as the modal / window resizes.
    useEffect(() => {
        const el = heroRef.current;
        if (!el || !backing) return;
        const ar = backing.w / backing.h;
        const compute = () => {
            const cw = el.clientWidth;
            const ch = el.clientHeight;
            if (cw <= 0 || ch <= 0) return;
            let w = cw;
            let h = cw / ar;
            if (h > ch) { h = ch; w = ch * ar; }
            setCssSize({ w: Math.round(w), h: Math.round(h) });
        };
        compute();
        const ro = new ResizeObserver(compute);
        ro.observe(el);
        return () => ro.disconnect();
    }, [backing]);

    // Register / release the composited canvas up to the host (for the PNG export row).
    const setCanvas = useCallback((el: HTMLCanvasElement | null) => {
        canvasRef.current = el;
        registerCanvas?.(el);
    }, [registerCanvas]);

    // Compose the display: STF preview base + (optional) plate-solution overlay.
    // Reuses the proven GeometricSolveStep overlay mapping (nativeToCanvas).
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !backing) return;
        if (canvas.width !== backing.w) canvas.width = backing.w;
        if (canvas.height !== backing.h) canvas.height = backing.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.fillStyle = '#05060a'; // --color-space-950
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (bgImage) {
            ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
        }

        if (overlayOn && solution?.matched_stars && scales) {
            // Verified catalog matches (dim centres + rings) — geometry only, read
            // from the finished solution. Never recomputed here.
            ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            solution.matched_stars.forEach((m) => {
                const { x, y } = scales.nativeToCanvas(m.detected.x, m.detected.y, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(x, y, 1.5, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.strokeStyle = '#34d399'; // --color-solve (verified catalog match)
            ctx.lineWidth = 1;
            solution.matched_stars.forEach((m) => {
                const { x, y } = scales.nativeToCanvas(m.detected.x, m.detected.y, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.stroke();
            });
        }
    }, [bgImage, backing, overlayOn, solution, scales]);

    const handleSavePng = async () => {
        const canvas = canvasRef.current;
        if (!canvas || savingPng) return;
        setSavingPng(true);
        setSaveMsg(null);
        try {
            const renderPng = await canvasToPngBytes(canvas);
            // Render-plane PNG through the unified export sink (Tauri save-dialog on
            // desktop / Blob download in the browser). The minimal receipt shape just
            // supplies the spatial-hash filename tag; the PNG needs no receipt/WCS.
            await saveExport('png', { receipt: solution ? { solution } : null, renderPng });
            setSaveMsg({ kind: 'ok', text: 'Saved display PNG.' });
        } catch (err: any) {
            setSaveMsg({ kind: 'err', text: err?.message || 'PNG save failed.' });
        } finally {
            setSavingPng(false);
        }
    };

    // Honest absence — no fabricated image when the run produced no display render.
    if (!previewUrl) {
        return (
            <div
                data-testid="step7-final-image-absent"
                className="flex-1 min-h-0 flex items-center justify-center text-text-muted text-sm px-8 text-center"
            >
                Display render not available for this run (preview generation was skipped).
            </div>
        );
    }

    const zoomed = zoom.scale > 1.001;
    const hasMatches = !!solution?.matched_stars?.length;

    return (
        <div
            ref={heroRef}
            data-testid="step7-final-image"
            className="relative flex-1 min-h-0 bg-space-950 overflow-hidden"
        >
            <div className="absolute inset-0 flex items-center justify-center">
                <ZoomPanViewport onZoomStateChange={setZoom} data-testid="step7-image-zoom">
                    <canvas
                        ref={setCanvas}
                        style={{
                            width: cssSize ? `${cssSize.w}px` : '0px',
                            height: cssSize ? `${cssSize.h}px` : '0px',
                            display: 'block',
                        }}
                    />
                </ZoomPanViewport>
            </div>

            {/* TOOLBAR — chrome stays fixed above the zoom transform. */}
            <div className="absolute top-3 right-3 flex items-center gap-2">
                {zoomed && (
                    <span className="flex items-center gap-1.5 bg-space-900/80 backdrop-blur-md border border-line rounded px-2 py-1 text-[10px] font-mono text-text-secondary">
                        {Math.round(zoom.scale * 100)}%
                        <button
                            type="button"
                            onClick={() => zoom.reset()}
                            title="Reset zoom"
                            aria-label="Reset zoom"
                            className="w-4 h-4 rounded-full border border-line text-text-faint text-[9px] leading-none flex items-center justify-center hover:text-text-primary"
                        >
                            ⟲
                        </button>
                    </span>
                )}
                {canToggleOriginal && (
                    <button
                        type="button"
                        data-testid="step7-applied-science-toggle"
                        role="switch"
                        aria-checked={!showOriginal}
                        onClick={() => setShowOriginal((v) => !v)}
                        title={`${warpApplied!.label}. Toggle between the applied-science corrected render (measured distortion removed) and the original un-corrected display.`}
                        className={`px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors ${
                            !showOriginal
                                ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                                : 'border-line bg-space-900/70 text-text-muted hover:text-text-secondary hover:border-line-strong'
                        }`}
                    >
                        {showOriginal ? 'Original' : `Applied ✓`}
                    </button>
                )}
                {hasMatches && (
                    <button
                        type="button"
                        data-testid="step7-overlay-toggle"
                        role="switch"
                        aria-checked={overlayOn}
                        onClick={() => setOverlayOn((v) => !v)}
                        title="Toggle the plate-solution overlay (verified catalog matches)."
                        className={`px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors ${
                            overlayOn
                                ? 'border-solve/60 bg-solve-dim text-solve'
                                : 'border-line bg-space-900/70 text-text-muted hover:text-text-secondary hover:border-line-strong'
                        }`}
                    >
                        {overlayOn ? 'Stars ✓' : 'Stars'}
                    </button>
                )}
                <button
                    type="button"
                    data-testid="step7-save-png"
                    onClick={handleSavePng}
                    disabled={savingPng}
                    title="Save a PNG of exactly what is shown (display render)."
                    className="px-2.5 py-1 rounded border border-line bg-space-900/70 text-[10px] font-semibold uppercase tracking-widest text-accent-300 hover:text-accent-200 disabled:opacity-50"
                >
                    {savingPng ? 'Saving…' : 'Save PNG'}
                </button>
            </div>

            {/* HONEST RENDER-PLANE LABEL (LAW 3) — names each applied correction; no
                fake "corrected" label when no per-frame-fitted model exists. */}
            <div
                data-testid="step7-render-caption"
                className="absolute bottom-3 left-3 max-w-[72%] bg-space-900/75 backdrop-blur-md border border-line rounded px-2.5 py-1.5"
            >
                {warpApplied && !showOriginal ? (
                    <div className="text-[10px] text-accent-300 leading-tight">
                        Applied science &mdash; {warpApplied.label}
                        {typeof warpApplied.rms_arcsec === 'number' && Number.isFinite(warpApplied.rms_arcsec)
                            ? ` (fit RMS ${warpApplied.rms_arcsec.toFixed(2)}″)`
                            : ''}
                        .
                    </div>
                ) : warpApplied && showOriginal ? (
                    <div className="text-[10px] text-text-secondary leading-tight">
                        Original (un-corrected) display &mdash; measured distortion NOT removed.
                    </div>
                ) : warpRefused ? (
                    <div data-testid="step7-render-refused" className="text-[10px] text-text-secondary leading-tight">
                        Distortion model not valid across this frame &mdash; showing original.
                        <span className="text-text-muted"> ({warpRefused.reason === 'HULL_COVERAGE'
                            ? `fit covers only ${(warpRefused.metrics.hull_coverage * 100).toFixed(0)}% of the frame`
                            : warpRefused.reason === 'CORNER_EXTRAPOLATION'
                                ? `corners extrapolate ${warpRefused.metrics.corner_ratio.toFixed(0)}× the measured range`
                                : warpRefused.reason === 'RMS_CEILING'
                                    ? `fit residual ${warpRefused.metrics.rms_px.toFixed(1)} px too large`
                                    : 'insufficient fit support'})</span>
                    </div>
                ) : null}
                <div className="text-[10px] text-text-secondary leading-tight">
                    Display stretch (screen transfer) &mdash; science data unchanged.
                </div>
                {colorLabel && (
                    <div className="text-[9px] text-text-muted font-mono mt-0.5">{colorLabel}</div>
                )}
            </div>

            {saveMsg && (
                <div
                    data-testid="step7-save-png-status"
                    className={`absolute bottom-3 right-3 text-[10px] font-mono px-2 py-1 rounded ${
                        saveMsg.kind === 'err' ? 'text-danger bg-danger/10' : 'text-solve bg-solve-dim'
                    }`}
                >
                    {saveMsg.text}
                </div>
            )}
        </div>
    );
};

export default FinalImageView;
