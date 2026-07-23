import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HardwareProfile } from '../types/Main_types';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { getStepMeta } from './wizard_steps';
import { DistortionChart, VignetteChart, ResidualQuiver } from './calibration/CalibrationCharts';
import { buildQuiverModel } from './calibration/quiver_model';
import { fmtCoef } from './calibration/chart_math';
import { diagnosticsVisualsEnabled } from './diag_prefs';
import { PsfPanel } from './psf/PsfPanel';
import './styles/Symbols.css';

interface ForensicCalibrationProps {
    session: OrchestratorSession;
    isActive: boolean;
    /** Run-All: auto-start calibration and auto-confirm via the same handlers the buttons use. */
    autoRun?: boolean;
    onComplete: () => void;
}

/** Coefficient with its measured 1-sigma standard error (or honest absence). */
const CoefValue: React.FC<{ value: number | undefined | null; se?: number; className?: string }> = ({ value, se, className }) => (
    <span className={`font-mono text-data ${className ?? ''}`}>
        {fmtCoef(value)}
        {se != null && Number.isFinite(se) && (
            <span className="text-text-muted text-[0.7em]"> ±{fmtCoef(se, 2)}</span>
        )}
    </span>
);

export const ForensicCalibrationStep: React.FC<ForensicCalibrationProps> = ({ session, isActive, autoRun, onComplete }) => {
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [profile, setProfile] = useState<HardwareProfile | null>(session.hardwareProfile);

    // Back-navigation tolerance: calibration already ran if the session holds
    // a hardware profile — don't force a re-run to re-enable Finalize.
    const [hasRun, setHasRun] = useState(!!session.hardwareProfile);
    // AUTO only advances past a run this mount performed (Back must not bounce).
    const ranThisMount = useRef(false);

    // Performance gating (owner directive): chart/quiver rendering is a
    // MANUAL-flow default; AUTO runs show text stats only unless the
    // persisted full-diagnostics preference (or this-mount opt-in) says
    // otherwise. Geometry is computed lazily inside the chart components —
    // never in the pipeline hot path.
    const [chartsRequested, setChartsRequested] = useState(false);
    const chartsEnabled = diagnosticsVisualsEnabled(autoRun) || chartsRequested;

    const runCalibration = async () => {
        if (loading || hasRun) return;
        setLoading(true);
        const interval = setInterval(() => {
            setStatus(session.status);
        }, 50);

        try {
            const res = await session.step5_Calibrate();
            setProfile(res);
            setHasRun(true);
            ranThisMount.current = true;
        } catch (err) {
            console.error("Calibration failed:", err);
        } finally {
            clearInterval(interval);
            setLoading(false);
        }
    };

    // AUTO: start calibration through the same handler as the button.
    useEffect(() => {
        if (!autoRun || !isActive || hasRun || loading) return;
        runCalibration();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, isActive, hasRun, loading]);

    // AUTO: finalize once calibration (run by THIS mount) produced a profile.
    useEffect(() => {
        if (!autoRun || !isActive || loading || !profile || !ranThisMount.current) return;
        const id = setTimeout(() => onComplete(), 700);
        return () => clearTimeout(id);
    }, [autoRun, isActive, loading, profile, onComplete]);

    const solution = session.solution;
    const fit = profile?.fit_stats;
    const dist = profile?.distortion_profile;
    const astrometry = solution?.astrometry;

    // Quiver model built LAZILY: only when charts are enabled (perf gate) and
    // an M7 astrometric analysis exists. ~one projection per matched star.
    const quiverModel = useMemo(() => {
        if (!chartsEnabled || !astrometry || !solution) return null;
        const t0 = Date.now();
        const m = buildQuiverModel(solution);
        console.log(`[Step6Charts] quiver geometry ${String(Date.now() - t0)}ms (${m?.arrows.length ?? 0} arrows)`);
        return m;
    }, [chartsEnabled, astrometry, solution]);

    const distortionMeasured = !!fit && fit.n_matches >= 10 && fit.r_ref_px > 0;

    return (
        <div className="flex flex-col h-full animate-fadeIn overflow-hidden">
            <div className="p-8 pb-4 flex justify-between items-end shrink-0">
                <div>
                    <h2 className="text-2xl font-light text-text-primary mb-2">{getStepMeta(6).title}</h2>
                    <p className="text-text-secondary max-w-xl">
                        {getStepMeta(6).subtitle}
                    </p>
                </div>
                <div className="text-right">
                    <div className="text-xs text-text-muted uppercase font-bold tracking-widest">Unit Level</div>
                    <div className="text-xl text-data font-mono">{profile ? 'Profile Locked' : hasRun ? 'No Profile' : 'Awaiting Run'}</div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto wizard-step-scroll px-8 pb-4 relative">
                {!hasRun && !loading && (
                    <div className="h-full min-h-[320px] flex flex-col items-center justify-center bg-space-900/40 border border-line rounded-xl">
                        <button
                            data-testid="step6-start"
                            onClick={runCalibration}
                            className="group relative px-8 py-4 bg-accent-600 hover:bg-accent-500 text-white rounded-xl font-bold transition-all shadow-2xl overflow-hidden scale-animation"
                        >
                            <span className="relative z-10 flex items-center gap-3 text-sm tracking-widest uppercase">
                                <span className="icon-search"></span> Start Lens Profiling
                            </span>
                        </button>
                        <p className="mt-4 text-text-muted text-[10px] italic uppercase tracking-tighter">Fits distortion & shading models to star residuals.</p>
                    </div>
                )}

                {loading && (
                    <div className="h-full min-h-[320px] flex flex-col items-center justify-center space-y-4 bg-space-900/40 border border-line rounded-xl">
                        <div className="w-12 h-12 border-4 border-accent-500 border-t-transparent rounded-full animate-spin"></div>
                        <div className="text-accent-400 font-mono text-lg animate-pulse">{status || "Profiling Lens..."}</div>
                    </div>
                )}

                {profile && !loading && (
                    <div className="flex flex-col gap-4">
                        {/* ── MEASURED COEFFICIENTS ──────────────────────────── */}
                        <div className="grid grid-cols-4 gap-4">
                            <div className="bg-space-800 border border-line p-4 rounded-lg">
                                <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Distortion (radial polynomial)</h4>
                                {distortionMeasured ? (
                                    <>
                                        <div className="text-sm leading-6">
                                            <div>k₁ <CoefValue value={dist?.k1} se={fit?.k1_se} className="text-lg" /></div>
                                            <div>k₂ <CoefValue value={dist?.k2} se={fit?.k2_se} className="text-lg" /></div>
                                            {dist?.k3 !== 0 && <div>k₃ <CoefValue value={dist?.k3} /></div>}
                                        </div>
                                        <p className="text-[10px] text-text-muted mt-2 uppercase">Δr/r = k₁r² + k₂r⁴{dist?.k3 !== 0 ? ' + k₃r⁶' : ''} · r/r_ref · ±1σ</p>
                                    </>
                                ) : (
                                    <div className="text-sm font-mono text-text-muted">
                                        NOT MEASURED
                                        <p className="text-[10px] mt-2 uppercase normal-nums">Needs ≥10 matched-star residuals — this solve provided {fit?.n_matches ?? (solution?.matched_stars?.length ?? 0)}.</p>
                                    </div>
                                )}
                            </div>

                            <div className="bg-space-800 border border-line p-4 rounded-lg">
                                <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Vignette (flux falloff)</h4>
                                {distortionMeasured ? (
                                    <>
                                        <div className="text-sm leading-6">
                                            <div>v₁ <CoefValue value={profile.vignette_v1 ?? 0} se={fit?.v1_se} className="text-lg" /></div>
                                            <div className="text-text-secondary">
                                                corner <span className="font-mono text-data">{((profile.vignette_v1 ?? 0) * 100).toFixed(1)}%</span>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-text-muted mt-2 uppercase">I(r) = 1 + v₁r² from matched-star photometry · ±1σ</p>
                                    </>
                                ) : (
                                    <div className="text-sm font-mono text-text-muted">
                                        NOT MEASURED
                                        <p className="text-[10px] mt-2 uppercase">Same ≥10-residual requirement as distortion.</p>
                                    </div>
                                )}
                            </div>

                            <div className="bg-space-800 border border-line p-4 rounded-lg">
                                <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Fit Quality</h4>
                                {fit ? (
                                    <div className="text-sm leading-6 font-mono">
                                        <div><span className="text-data">{fit.n_inliers}</span><span className="text-text-muted">/{fit.n_matches} RANSAC inliers</span></div>
                                        <div><span className="text-text-muted">model RMS </span><span className="text-data">{fit.rms_error_px.toFixed(2)}px</span></div>
                                        {astrometry && (
                                            <div><span className="text-text-muted">M7 residual </span><span className="text-data">{astrometry.rms_arcsec.toFixed(2)}″</span></div>
                                        )}
                                        {astrometry?.sip && <div className="text-solve text-[10px] uppercase">SIP polynomial fitted</div>}
                                    </div>
                                ) : (
                                    <div className="text-sm font-mono text-text-muted">NO FIT RAN</div>
                                )}
                            </div>

                            <div className="bg-space-800 border border-line p-4 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest">Spectral Forensics</h4>
                                    {/* LAW 3: these are HEURISTIC inferences (FWHM/circularity/
                                        background ratios), not measured facts — the label must say so. */}
                                    <span data-testid="spectral-forensics-inferred" title="Inferred from shape/diffusion heuristics — not a measured value" className="px-1.5 py-px rounded bg-warn-dim text-warn text-[9px] font-bold uppercase tracking-wide">
                                        Inferred
                                    </span>
                                </div>
                                <div className="text-sm font-mono text-data">{profile.spectral_bias || 'Standard RGB'}</div>
                                <div className="text-[10px] font-mono text-text-muted mt-1">{profile.inferred_lens}</div>
                                {profile.detected_modifications && profile.detected_modifications.length > 0 && (
                                    <div className="flex gap-2 mt-2 flex-wrap">
                                        {profile.detected_modifications.map(mod => (
                                            <span key={mod} title="Inferred filter/modification (heuristic) — APPROXIMATE" className="px-2 py-0.5 bg-accent-glow text-accent-300 text-[9px] rounded-full border border-accent-500/30">
                                                {mod}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── INSTRUMENT CHARTS (perf-gated, lazily computed) ── */}
                        {chartsEnabled ? (
                            <>
                                {distortionMeasured && (
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-space-900/70 border border-line rounded-xl p-4">
                                            <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Distortion — radial shift</h4>
                                            <DistortionChart
                                                k1={dist!.k1} k2={dist!.k2} k3={dist!.k3 ?? 0}
                                                rRefPx={fit!.r_ref_px}
                                            />
                                        </div>
                                        <div className="bg-space-900/70 border border-line rounded-xl p-4">
                                            <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Vignette — relative illumination</h4>
                                            <VignetteChart v1={profile.vignette_v1 ?? 0} />
                                        </div>
                                    </div>
                                )}
                                {quiverModel && (
                                    <div className="bg-space-900/70 border border-line rounded-xl p-4">
                                        <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">
                                            Residual Vector Field — catalog-projected → observed
                                        </h4>
                                        <ResidualQuiver model={quiverModel} pixelScale={solution?.pixel_scale} />
                                    </div>
                                )}
                                {!distortionMeasured && !quiverModel && (
                                    <div className="bg-space-900/40 border border-line rounded-xl p-4 text-[11px] font-mono text-text-muted">
                                        No chartable measurements: the distortion/vignette fit needs ≥10 matched residuals
                                        and the vector field needs ≥15. The coefficients above are honest zeros, not measurements.
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="bg-space-900/40 border border-line rounded-xl p-4 flex items-center justify-between">
                                <div className="text-[11px] font-mono text-text-muted">
                                    CHARTS SKIPPED (AUTO mode) — text stats above are complete; visuals are opt-in for speed.
                                </div>
                                <button
                                    data-testid="step6-render-charts"
                                    onClick={() => setChartsRequested(true)}
                                    className="px-4 py-2 bg-space-800 hover:bg-space-750 border border-line text-text-secondary hover:text-text-primary rounded text-xs font-bold uppercase tracking-widest"
                                >
                                    Render charts
                                </button>
                            </div>
                        )}

                        {/* ── PSF / DECONVOLUTION DIAGNOSTICS (M10, optional) ── */}
                        <PsfPanel session={session} autoRun={autoRun} />
                    </div>
                )}
            </div>

            <div className="h-24 flex items-center justify-end px-8 shrink-0 border-t border-line-subtle bg-space-900/70">
                <button
                    data-testid="step6-confirm"
                    onClick={onComplete}
                    disabled={!hasRun || loading}
                    className="px-8 py-3 bg-accent-600 hover:bg-accent-500 disabled:bg-space-750 disabled:text-text-muted text-white rounded-lg font-bold transition-all"
                >
                    Finalize Profile <span className="icon-arrow-right"></span>
                </button>
            </div>
        </div>
    );
};
