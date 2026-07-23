import React, { useEffect, useState, useRef } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { SolarBody } from '../types/Main_types';
import { getStepMeta } from './wizard_steps';
import './styles/Symbols.css';

interface AlignmentStepProps {
    session: OrchestratorSession;
    isActive: boolean;
    /** Run-All: auto-start metrology and auto-confirm via the same handlers the buttons use. */
    autoRun?: boolean;
    backgroundImageUrl?: string;
    onComplete: () => void;
    onImageClick: (x: number, y: number) => void;
}

export const AlignmentStep: React.FC<AlignmentStepProps> = ({ session, isActive, autoRun, backgroundImageUrl, onComplete, onImageClick }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [bodies, setBodies] = useState<SolarBody[]>(session.guestList);
    const [loading, setLoading] = useState(false);
    const [selectedBody, setSelectedBody] = useState<string | null>(null);

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
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

    // Back-navigation tolerance: metrology already ran if the session holds
    // a scale lock — don't force a re-run to re-enable Confirm on re-entry.
    const [hasRun, setHasRun] = useState(session.scaleLock != null);
    const [status, setStatus] = useState('');
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    // AUTO only advances past a run this mount performed (Back must not bounce).
    const ranThisMount = useRef(false);

    // Pre-load the user's preview image once; it is the base layer of the canvas.
    useEffect(() => {
        const url = backgroundImageUrl || session.previewUrl;
        if (!url) return;
        const img = new Image();
        img.src = url;
        img.onload = () => setBgImage(img);
        img.onerror = (e) => console.error("[AlignmentStep] Background load failed:", e);
    }, [backgroundImageUrl, session.previewUrl, session]);

    const runAlignment = async () => {
        if (loading || hasRun) return;
        setLoading(true);
        const interval = setInterval(() => {
            setStatus(session.status);
        }, 50);

        try {
            await session.step3_Metrology();
            setBodies(session.guestList);
            setHasRun(true);
            ranThisMount.current = true;
        } catch (err) {
            console.error("Metrology failed:", err);
        } finally {
            clearInterval(interval);
            setLoading(false);
        }
    };

    // AUTO: start metrology through the same handler as the button.
    useEffect(() => {
        if (!autoRun || !isActive || hasRun || loading) return;
        runAlignment();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, hasRun, loading]);

    // AUTO: confirm once metrology (run by THIS mount) completed.
    useEffect(() => {
        if (!autoRun || !isActive || loading || !hasRun || !ranThisMount.current) return;
        const id = setTimeout(() => onComplete(), 700);
        return () => clearTimeout(id);
    }, [autoRun, isActive, loading, hasRun, onComplete]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !session || !session.signal) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            const { signal } = session;
            if (!signal || !session.scales) return;

            ctx.fillStyle = '#05060a'; // --color-space-950
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Base layer: the user's actual image, drawn to cover exactly the
            // letterboxed preview frame that nativeToCanvas maps into — so the
            // detection rings land ON their stars.
            if (bgImage) {
                const scale = Math.min(canvas.width / session.scales.previewW, canvas.height / session.scales.previewH);
                const ox = (canvas.width - session.scales.previewW * scale) / 2;
                const oy = (canvas.height - session.scales.previewH * scale) / 2;
                ctx.drawImage(bgImage, ox, oy, session.scales.previewW * scale, session.scales.previewH * scale);
            }

            // Detection rings: transparent fill so the real star shows through.
            ctx.strokeStyle = '#34d399'; // --color-solve
            ctx.lineWidth = 1;
            signal.clean_stars.forEach(p => {
                const { x, y } = session.scales!.nativeToCanvas(p.x, p.y, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(x, y, 2.5, 0, Math.PI*2);
                ctx.stroke();
            });

            // Note: expected solar-system bodies are listed in the panel below.
            // Their pixel positions are only known after the plate solve (step 5),
            // so nothing is drawn for them here.
        };

        draw();
    }, [bodies, session, isActive, bgImage]);

    if (!isActive) return null;

    return (
        <div className="flex flex-col h-full overflow-hidden animate-fadeIn">
            <div className="flex justify-between items-center px-6 pt-6 pb-3 shrink-0">
                <h3 className="text-xl font-light text-text-primary">{getStepMeta(4).title}</h3>
                <div className="text-xs text-text-muted uppercase tracking-widest">Step 04</div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto wizard-step-scroll px-6 pb-2">
                <div className="bg-space-850/70 rounded-xl p-6 border border-line backdrop-blur-sm relative min-h-[380px] flex flex-col">
                {loading ? (
                    <div className="flex flex-col items-center justify-center flex-1 space-y-4">
                        <div className="w-8 h-8 border-2 border-accent-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-accent-400 font-mono text-sm">Calculating Ephemeris...</p>
                    </div>
                ) : (
                    <>
                    <div className="flex-1 relative mb-6 rounded-lg overflow-hidden border border-line-subtle bg-space-950">
                        <canvas 
                            ref={canvasRef}
                            width={1600}
                            height={800}
                            onClick={handleClick}
                            className={`w-full h-full object-contain cursor-crosshair transition-opacity duration-500 ${loading ? 'opacity-20' : 'opacity-100'}`}
                        />
                        
                        {!hasRun && !loading && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
                                <button
                                    data-testid="step4-start"
                                    onClick={runAlignment}
                                    className="px-10 py-5 bg-accent-600 hover:bg-accent-500 text-white rounded-xl font-bold transition-all shadow-2xl uppercase tracking-widest text-sm"
                                >
                                    <span className="icon-planet"></span> Start Alignment Calculation
                                </button>
                                <p className="mt-4 text-text-muted text-xs italic">Cross-references stars against VSOP87 planetary ephemeris.</p>
                            </div>
                        )}

                        {loading && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-black/60">
                                <div className="w-12 h-12 border-4 border-accent-500 border-t-transparent rounded-full animate-spin"></div>
                                <div className="text-accent-400 font-mono text-lg animate-pulse">{status || "Computing Trajectories..."}</div>
                            </div>
                        )}

                        <div className="absolute top-4 left-4 text-[10px] font-bold text-text-muted tracking-[0.2em] uppercase">
                            Detected Star Field
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                             <h4 className="text-sm font-semibold text-text-muted mb-2 uppercase tracking-wide">Solar System Objects</h4>
                             <div className="grid grid-cols-2 gap-2 max-h-[150px] overflow-y-auto pr-2 custom-scrollbar">
                                {bodies.map(body => (
                                    <div
                                        key={body.id}
                                        onClick={() => setSelectedBody(body.id)}
                                        className={`p-2 rounded border cursor-pointer transition-all duration-200
                                            ${selectedBody === body.id
                                                ? 'bg-accent-glow border-accent-500/50'
                                                : 'bg-space-800/60 border-line hover:border-accent-500/40'
                                            }`}
                                    >
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs font-mono text-data">{body.name}</span>
                                            <span className="text-[10px] text-text-muted">Mag {body.mag.toFixed(1)}</span>
                                        </div>
                                    </div>
                                ))}
                             </div>
                        </div>

                        <div className="bg-space-800/70 rounded-lg p-4 border border-line text-[11px] leading-relaxed text-text-secondary">
                            <strong className="text-text-muted block mb-1 uppercase tracking-wide">Scale & Ephemeris</strong>
                            {hasRun ? (
                                <>
                                    {session.scaleLock != null && session.scaleLock > 0 ? (
                                        <span data-testid="step4-scale-lock" className="block mb-1">
                                            Pixel scale: <strong>{session.scaleLock.toFixed(2)}"/px</strong>
                                            {session.metadata?.pixel_scale && session.metadata.pixel_scale > 0
                                                ? ' (from file header - blind triangulation skipped)'
                                                : ' (triangulated from star geometry)'}
                                        </span>
                                    ) : (
                                        <span className="block mb-1">Pixel scale could not be determined - the solver will estimate it.</span>
                                    )}
                                    {bodies.length > 0
                                        ? <span>{bodies.length} solar-system {bodies.length === 1 ? 'body is' : 'bodies are'} expected in the sky at this time and location: {bodies.map(b => b.name).join(', ')}. Positions are confirmed after the plate solve.</span>
                                        : <span>No solar-system bodies are expected in this field at the observation time.</span>}
                                </>
                            ) : (
                                <span>Locks the image scale (from the file header when available, otherwise blind triangulation) and computes the VSOP87 ephemeris guest list for the observation time and location.</span>
                            )}
                        </div>
                    </div>
                    </>
                )}
                </div>
            </div>

            <div className="shrink-0 flex justify-end px-6 py-4 border-t border-line-subtle bg-space-900/70">
                <button
                    data-testid="step4-confirm"
                    onClick={onComplete}
                    disabled={!hasRun || loading}
                    className="px-8 py-3 bg-accent-600 hover:bg-accent-500 text-white rounded-lg font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] disabled:bg-space-750 disabled:text-text-muted disabled:cursor-not-allowed"
                >
                    Confirm Alignment
                </button>
            </div>
        </div>
    );
};
