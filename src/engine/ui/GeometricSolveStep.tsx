import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PlateSolution } from '../types/Main_types';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { usePlateSolver } from '../hooks/usePlateSolver';
import { usePipelineEvents } from '../hooks/usePipelineEvents';
import { getStepMeta } from './wizard_steps';
import { ConfirmTierBadge } from './dashboard/ConfirmTierBadge';
import { formatRaSexagesimal, formatDecSexagesimal, coordHoverTitle } from './format/sexagesimal';
import './styles/Symbols.css';

interface GeometricSolveProps {
    session: OrchestratorSession;
    isActive: boolean;
    /** Run-All: auto-start the solve and auto-confirm via the same handlers the buttons use. */
    autoRun?: boolean;
    onComplete: () => void;
    /**
     * CORRECTED VIEW override (render plane only). When non-null, this fitted-SIP
     * de-distorted preview URL replaces `session.previewUrl` as the canvas base
     * layer. Undefined/null (the DEFAULT) ⇒ the un-warped preview renders exactly
     * as before — byte-identical. Never affects the solve/overlay geometry.
     */
    correctedPreviewUrl?: string | null;
}

export const GeometricSolveStep: React.FC<GeometricSolveProps> = ({ session, isActive, autoRun, onComplete, correctedPreviewUrl }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const {
        solve,
        isSolving: loading,
        status,
        solution,
        error
    } = usePlateSolver(session);

    const [hasRun, setHasRun] = useState(!!session.solution);
    // AUTO only advances past a solve this mount performed (Back must not bounce).
    const ranThisMount = useRef(false);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const meta = getStepMeta(5);

    // ── Live forced-photometry confirmation surfacing ─────────────────────────
    // The confirmation stage writes solution.deep_confirmed IN PLACE after the
    // solve resolves; usePlateSolver's `solution` ref is stable, so the badge
    // never re-rendered when the verdict arrived (it froze on the pre-verdict
    // state). Subscribing to the event bus gives the re-render, and we read the
    // verdict live from the session. `confirmInFlight` shows an honest
    // "confirming…" while the stage runs; before/without it the badge is
    // honestly absent (no premature "verification unavailable").
    const events = usePipelineEvents(session.events);
    const liveDeep = (session.solution ?? solution)?.deep_confirmed ?? null;
    const confirmInFlight = useMemo(() => {
        let running = false;
        for (const e of events) {
            if (e.kind === 'stage_started' && e.stage === 'forced_confirm') running = true;
            else if (e.kind === 'stage_finished' && e.stage === 'forced_confirm') running = false;
        }
        return running;
    }, [events]);

    // Pre-load the user's preview image; it is the base layer of the canvas.
    // CORRECTED VIEW (render plane): when the toggle supplies a de-distorted URL
    // it overrides the un-warped preview. Null/undefined ⇒ session.previewUrl,
    // byte-identical to the pre-feature behavior.
    useEffect(() => {
        const url = correctedPreviewUrl ?? session.previewUrl;
        if (!url) return;
        const img = new Image();
        img.src = url;
        img.onload = () => setBgImage(img);
        img.onerror = (e) => console.error("[GeometricSolve] Background load failed:", e);
    }, [correctedPreviewUrl, session.previewUrl, session]);

    // Astrometric residual from the verified catalog matches.
    //
    // AUDIT (Phase U): the previous readout ("RESIDUAL RMS: 8.93px") was
    // sqrt(mean(residual²)) over ALL matches. The verifier's match set is a
    // per-detection nearest-neighbour pairing inside a 120″ net
    // (SOLVER_VERIFICATION_RADIUS_ARCSEC floor ≈ 33 px on a 3.68″/px field)
    // that keeps duplicate and radius-cap pairings — squaring lets that tail
    // dominate (RMS 32.8″ vs the 13.5″ mean the WASM verifier logs for the
    // same set ⇒ 8.93 px vs 3.7 px). Planet candidates additionally carry
    // sentinel penalties (+5 / +1000 / 9999″) from color verification —
    // flags, not measurements. Display the MEAN over non-sentinel star
    // matches (the same statistic as the WASM verify diagnostic), labeled
    // truthfully, in both px and arcsec.
    const residualStats = useMemo(() => {
        if (!solution || !(solution.pixel_scale > 0)) return null;
        const matches = (solution.matched_stars ?? []).filter(m =>
            Number.isFinite(m.residual_arcsec) &&
            m.residual_arcsec < 999 && // planetary-verification sentinels are flags, not measurements
            !(m.catalog?.gaia_id || '').startsWith('planet_')
        );
        if (!matches.length) return null;
        const meanArcsec = matches.reduce((s, m) => s + m.residual_arcsec, 0) / matches.length;
        return { meanArcsec, meanPx: meanArcsec / solution.pixel_scale };
    }, [solution]);

    const handleRunSolve = async () => {
        if (loading || hasRun) return;
        await solve();
        setHasRun(true);
        ranThisMount.current = true;
    };

    // AUTO: start the solve through the same handler as the button.
    useEffect(() => {
        if (!autoRun || !isActive || hasRun || loading) return;
        handleRunSolve();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, hasRun, loading]);

    // AUTO: confirm only on a successful solve run by THIS mount.
    // A failed solve (hasRun && !solution) halts the cascade honestly.
    useEffect(() => {
        if (!autoRun || !isActive || loading || !solution || !ranThisMount.current) return;
        const id = setTimeout(() => onComplete(), 700);
        return () => clearTimeout(id);
    }, [autoRun, isActive, loading, solution, onComplete]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Background
        ctx.fillStyle = '#05060a'; // --color-space-950
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (!session.scales) return;

        // 0. Base layer: the user's actual image, drawn to cover exactly the
        // letterboxed preview frame that nativeToCanvas maps into — so the
        // matched rings land ON their stars.
        if (bgImage) {
            const scale = Math.min(canvas.width / session.scales.previewW, canvas.height / session.scales.previewH);
            const ox = (canvas.width - session.scales.previewW * scale) / 2;
            const oy = (canvas.height - session.scales.previewH * scale) / 2;
            ctx.drawImage(bgImage, ox, oy, session.scales.previewW * scale, session.scales.previewH * scale);
        }

        if (!solution) return;

        // 1. Draw All Detected Stars (Dim)
        if (solution.matched_stars) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            solution.matched_stars.forEach(m => {
                const { x, y } = session.scales!.nativeToCanvas(m.detected.x, m.detected.y, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(x, y, 1.5, 0, Math.PI * 2);
                ctx.fill();
            });

            // 2. Draw Successful Matches (Verified Rings)
            ctx.strokeStyle = '#34d399'; // --color-solve (verified catalog match)
            ctx.lineWidth = 1;
            solution.matched_stars.forEach(m => {
                const { x, y } = session.scales!.nativeToCanvas(m.detected.x, m.detected.y, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.stroke();
            });

            // 3. Draw Geometric Quads (The "Skeleton")
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)'; // --color-accent-400 @ 40%
            ctx.lineWidth = 0.5;
            for (let i = 0; i < Math.min(solution.matched_stars.length, 12); i += 4) {
               if (i + 1 >= solution.matched_stars.length) break;
               
               const p1 = session.scales!.nativeToCanvas(solution.matched_stars[i].detected.x, solution.matched_stars[i].detected.y, canvas.width, canvas.height);
               const p2 = session.scales!.nativeToCanvas(solution.matched_stars[i+1].detected.x, solution.matched_stars[i+1].detected.y, canvas.width, canvas.height);
               
               ctx.beginPath();
               ctx.moveTo(p1.x, p1.y);
               ctx.lineTo(p2.x, p2.y);
               
               if (i + 2 < solution.matched_stars.length) {
                   const p3 = session.scales!.nativeToCanvas(solution.matched_stars[i+2].detected.x, solution.matched_stars[i+2].detected.y, canvas.width, canvas.height);
                   ctx.lineTo(p3.x, p3.y);
                   if (i + 3 < solution.matched_stars.length) {
                       const p4 = session.scales!.nativeToCanvas(solution.matched_stars[i+3].detected.x, solution.matched_stars[i+3].detected.y, canvas.width, canvas.height);
                       ctx.lineTo(p4.x, p4.y);
                   }
               }
               ctx.closePath();
               ctx.stroke();
            }
        }

        // Overlay text info. RA/DEC live in the HTML overlay box (compact
        // sexagesimal + decimals on hover); the canvas keeps scale/rotation,
        // whose glyphs render reliably in the canvas monospace font.
        ctx.fillStyle = '#c7d5f0'; // --color-data
        ctx.font = '10px "JetBrains Mono", "Consolas", monospace';
        ctx.fillText(`PXL SCALE: ${solution.pixel_scale.toFixed(3)}"/px`, 20, canvas.height - 30);
        ctx.fillText(`ROTATION: ${solution.rotation.toFixed(2)}\u00B0`, 20, canvas.height - 15);

    }, [solution, session.scales, bgImage]);

    return (
        <div className="flex flex-col h-full animate-fadeIn overflow-hidden">
            <div className="p-8 pb-4 flex justify-between items-end shrink-0">
                <div>
                    <h2 className="text-2xl font-light text-text-primary mb-2">{meta.title}</h2>
                    <p className="text-text-secondary max-w-xl">
                        {meta.subtitle}
                    </p>
                </div>
                <div className="text-right">
                    {/* No solve yet = no confidence exists — '--' sentinel, never 0.0%-as-fact.
                        Sentinel wears the muted voice, not the measured-number color (A.6). */}
                    <div className={`text-2xl font-mono ${solution ? 'text-data' : 'text-text-muted'}`}>{solution ? `${(solution.confidence * 100).toFixed(1)}%` : '--'}</div>
                    <div className="text-xs text-text-muted uppercase font-bold tracking-wide">Lock Score (heuristic)</div>
                    {/* [SAFETY CATCHER] Confidence is never shown with a STALE or
                        premature verdict. The badge reads the live confirmation
                        result and re-renders when it lands: hidden until the
                        confirmation runs (honest absence — verification is a later
                        stage, not "unavailable"), "confirming…" while it runs, then
                        the earned tier. */}
                    {solution && (
                        <ConfirmTierBadge
                            deep={liveDeep}
                            inFlight={confirmInFlight}
                            hideWhenNull
                            className="mt-1.5 max-w-[16rem] ml-auto"
                        />
                    )}
                </div>
            </div>

            <div className="flex-1 min-h-0 relative bg-space-950/60 border border-line-subtle mx-8 rounded-lg overflow-hidden">
                <canvas
                    ref={canvasRef}
                    width={1000}
                    height={500}
                    className={`w-full h-full object-contain transition-opacity duration-500 ${loading ? 'opacity-20' : 'opacity-100'}`}
                />

                {!hasRun && !loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm">
                        <button
                            data-testid="step5-start"
                            onClick={handleRunSolve}
                            className="group relative px-10 py-5 bg-accent-600 hover:bg-accent-500 text-white rounded-xl font-bold transition-all shadow-2xl overflow-hidden scale-animation"
                        >
                            <span className="relative z-10 flex items-center gap-3 text-lg tracking-widest uppercase">
                                <span className="icon-search"></span> Start Geometric Solve
                            </span>
                        </button>
                        {error && <p className="mt-4 text-danger text-sm font-bold">{error}</p>}
                        <p className="mt-4 text-text-muted text-sm italic">Matches detected quads against the Gaia-derived celestial index.</p>
                    </div>
                )}

                {loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-black/60">
                        <div className="w-16 h-16 border-4 border-accent-500 border-t-transparent rounded-full animate-spin"></div>
                        <div className="text-accent-400 font-mono text-lg animate-pulse">{status || "Solving Quads..."}</div>
                    </div>
                )}

                {hasRun && !loading && !solution && (
                    <div data-testid="step5-failure" className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-space-950/80 backdrop-blur-sm border border-danger/30">
                        <div className="text-danger font-bold text-lg">Plate solve failed</div>
                        <div className="text-text-secondary font-mono text-sm max-w-md text-center">
                            {error || session.status || 'No geometric lock was found.'}
                        </div>
                        <button
                            data-testid="step5-retry"
                            onClick={() => { setHasRun(false); }}
                            className="mt-2 px-6 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-sm font-bold"
                        >
                            Retry Solve
                        </button>
                    </div>
                )}

                {solution && (
                <div className="absolute top-4 left-4 bg-space-900/80 backdrop-blur-md p-3 border border-line rounded font-mono text-[10px] text-text-muted">
                    {/* Compact sexagesimal (RA is HOURS internally); decimals on hover. */}
                    <div className="mb-1" title={coordHoverTitle(solution.ra_hours, solution.dec_degrees)}>
                        <div className="flex justify-between gap-8">
                            <span>RA:</span>
                            <span data-testid="step5-ra" className="text-data">{formatRaSexagesimal(solution.ra_hours)}</span>
                        </div>
                        <div className="flex justify-between gap-8">
                            <span>DEC:</span>
                            <span data-testid="step5-dec" className="text-data">{formatDecSexagesimal(solution.dec_degrees)}</span>
                        </div>
                    </div>
                    <div className="flex justify-between gap-8 mb-1">
                        <span>MATCHED STARS:</span>
                        <span data-testid="step5-matched-stars" className={solution.matched_stars ? 'text-data' : 'text-text-muted'}>{solution.matched_stars?.length ?? '--'}</span>
                    </div>
                    <div className="flex justify-between gap-8 mb-1">
                        <span>MEAN RESIDUAL:</span>
                        <span data-testid="step5-residual" className={residualStats != null ? 'text-data' : 'text-text-muted'}>
                            {residualStats != null
                                ? `${residualStats.meanPx.toFixed(1)}px · ${residualStats.meanArcsec.toFixed(1)}″`
                                : '--'}
                        </span>
                    </div>
                    <div className="flex justify-between gap-8">
                        <span>ORIENTATION:</span>
                        <span className="text-data">{solution.parity > 0 ? 'NORMAL' : 'FLIPPED'}</span>
                    </div>
                </div>
                )}
            </div>

            <div className="h-24 shrink-0 flex items-center justify-end px-8 gap-4 border-t border-line-subtle bg-space-900/70">
                <div className="text-xs text-text-muted italic max-w-xs text-right mr-4 leading-tight">
                    {solution
                        ? 'Spatial metadata has been injected into the science buffer. Proceeding to unit-level lens profiling...'
                        : 'A successful solve is required before optical calibration.'}
                </div>
                <button
                    data-testid="step5-confirm"
                    onClick={onComplete}
                    disabled={!solution || loading}
                    className="px-8 py-3 bg-accent-600 hover:bg-accent-500 disabled:bg-space-750 disabled:text-text-muted text-white rounded-lg font-bold transition-all"
                >
                    Confirm Geometry <span className="icon-arrow-right"></span>
                </button>
            </div>
        </div>
    );
};
