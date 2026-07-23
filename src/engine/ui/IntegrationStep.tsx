import React, { useEffect, useRef, useState } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { getStepMeta } from './wizard_steps';
import { ExportSelector } from './ExportSelector';
import { FinalImageView } from './FinalImageView';
import { AnnotationForm } from './AnnotationForm';
// savePacket() is superseded by the unified saveExport dispatcher (via ExportSelector).
import type { UserAnnotations } from '../pipeline/stages/user_annotations';
import { canvasToPngBytes, type ExportImage } from './utils/save_export';
import { formatRaSexagesimal, formatDecSexagesimal, coordHoverTitle } from './format/sexagesimal';
import './styles/Symbols.css';

interface IntegrationStepProps {
    session: OrchestratorSession;
    isActive: boolean;
    /**
     * Run-All: auto-start the final bundling. The EXPORT click stays manual —
     * it downloads a file and closes the wizard, which is a user decision.
     */
    autoRun?: boolean;
    onComplete: () => void;
}

export const IntegrationStep: React.FC<IntegrationStepProps> = ({ session, isActive, autoRun, onComplete }) => {
    const [loading, setLoading] = useState(false);
    const [hasRun, setHasRun] = useState(false);
    const [packet, setPacket] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const meta = getStepMeta(7);
    // The composited display canvas from the hero view, so the ExportSelector can
    // offer the render-plane PNG (exactly what is shown) through the unified sink.
    const renderCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const runIntegration = async () => {
        if (loading || hasRun) return;
        setLoading(true);
        setError(null);
        try {
            const result = await session.step6_Integrate();
            setPacket(result);
            setHasRun(true);
        } catch (err: any) {
            console.error("Integration failed:", err);
            setError(err?.message || 'Integration failed.');
        } finally {
            setLoading(false);
        }
    };

    // AUTO: start bundling through the same handler as the button.
    // Errors halt the cascade (no retry loop); export remains manual.
    useEffect(() => {
        if (!autoRun || !isActive || hasRun || loading || error) return;
        runIntegration();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, hasRun, loading, error]);

    return (
        <div className="flex flex-col h-full animate-fadeIn overflow-hidden">
            {/* PAYOFF — "here is your fixed image". The processed frame through the
                existing STF v2 display stretch, prominent + pan/zoomable, solve
                overlay optional. RENDER PLANE: display-only, never touches the
                solve/receipt (the pinned solves stay byte-identical). */}
            <FinalImageView
                session={session}
                registerCanvas={(el) => { renderCanvasRef.current = el; }}
            />

            {/* RESULTS + EXPORT — compact strip under the image. */}
            <div className="shrink-0 border-t border-line-subtle bg-space-900/60 overflow-y-auto" style={{ maxHeight: '46%' }}>
                <div className="px-8 py-5">
                    <div className="flex items-start justify-between gap-6 flex-wrap">
                        <div className="min-w-0">
                            <h2 className="text-xl font-light text-text-primary">{meta.title}</h2>
                            <p className="text-text-secondary text-xs max-w-lg mt-1">{meta.subtitle}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2 min-w-[14rem]">
                            {!hasRun && !loading && (
                                <button
                                    data-testid="step7-start"
                                    onClick={runIntegration}
                                    className="px-6 py-3 bg-accent-600 hover:bg-accent-500 text-white rounded-lg font-bold transition-all shadow-xl uppercase tracking-widest text-xs"
                                >
                                    <span className="icon-rocket"></span> Start Final Bundling
                                </button>
                            )}

                            {(loading || hasRun) && (
                                <div className="w-full space-y-2">
                                    <div className="w-full h-1 bg-space-700 rounded-full overflow-hidden">
                                        <div className={`h-full bg-accent-500 transition-all duration-300 progress-bar-width ${loading ? 'animate-pulse' : ''}`}></div>
                                    </div>
                                    <div className="flex justify-between text-[10px] font-mono text-text-muted uppercase">
                                        <span>{loading ? 'Compiling AstroPacket...' : 'Integration Complete'}</span>
                                        <span>{loading ? '...' : 'DONE'}</span>
                                    </div>
                                </div>
                            )}

                            {error && (
                                <div className="text-danger text-sm font-mono">{error}</div>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-left mt-5">
                        <div className="bg-space-800 border border-line p-3 rounded font-mono text-[10px]">
                            <div className="text-text-muted mb-1 uppercase tracking-wide">COORDINATES</div>
                            {/* Sentinel wears the muted voice, never the measured-number color (A.6).
                                Compact sexagesimal display; decimal originals on hover (title). */}
                            <div
                                data-testid="step7-coordinates"
                                title={session.solution ? coordHoverTitle(session.solution.ra_hours, session.solution.dec_degrees) : undefined}
                                className={`truncate ${session.solution ? 'text-data' : 'text-text-muted'}`}
                            >
                                {session.solution
                                    ? <>{formatRaSexagesimal(session.solution.ra_hours)} {formatDecSexagesimal(session.solution.dec_degrees)}</>
                                    : '--'}
                            </div>
                        </div>
                        <div className="bg-space-800 border border-line p-3 rounded font-mono text-[10px]">
                            <div className="text-text-muted mb-1 uppercase tracking-wide">SPATIAL HASH</div>
                            <div className={`truncate ${session.solution?.spatial_hash ? 'text-data' : 'text-text-muted'}`}>{session.solution?.spatial_hash || '--'}</div>
                        </div>
                    </div>

                    {packet && (
                        <div data-testid="step7-packet" className="mt-4 text-left bg-space-800 border border-line p-3 rounded font-mono text-[10px]">
                            <div className="text-text-muted mb-1 uppercase tracking-wide">PACKET</div>
                            {/* Honest-or-absent (LAW 3): an absent star list is '--', never a fake 0. */}
                            <div className="text-data">v{packet.version} - {packet.signal?.clean_stars?.length ?? '--'} stars - {packet.export_date}</div>
                        </div>
                    )}

                    {hasRun && (
                        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* Observer testimony (optional). Applied notes patch the
                                already-built receipt's additive user_annotations block
                                in place — no re-solve, no receipt rebuild, no workbench
                                re-deposit. Testimony only: never fed to the solve. */}
                            <AnnotationForm
                                current={packet?.user_annotations ?? null}
                                onApply={(a: UserAnnotations | null) => {
                                    session.setUserAnnotations(a);
                                    setPacket((p: any) => (p ? { ...p, user_annotations: a } : p));
                                }}
                            />

                            <div>
                                {/* Unified export surface. The receipt row keeps the
                                    step7-export testid + closes the wizard on success
                                    (the SeeStar e2e contract); other formats download
                                    without closing so the user can grab several. The
                                    render-plane PNG (exactly what the hero shows) is
                                    offered here through the same sink. */}
                                <ExportSelector
                                    receipt={packet}
                                    hasImage={!!session.getExportImage()}
                                    getImage={() => session.getExportImage() as ExportImage | null}
                                    hasRender={!!session.previewUrl}
                                    getRenderPng={async () => (renderCanvasRef.current ? await canvasToPngBytes(renderCanvasRef.current) : null)}
                                    testIds={{ receipt: 'step7-export' }}
                                    onExported={(fmt) => { if (fmt === 'receipt') onComplete(); }}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <style dangerouslySetInnerHTML={{ __html: `
                .progress-bar-width {
                    width: ${hasRun ? 100 : loading ? 60 : 0}%;
                }
            `}} />
        </div>
    );
};
