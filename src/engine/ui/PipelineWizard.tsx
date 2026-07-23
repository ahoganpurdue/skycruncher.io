import React, { useState, useEffect, useRef, useMemo } from 'react';
import { OrchestratorSession, SessionState } from '../pipeline/orchestrator_session';
import { SENSOR_DB, findSensorByCamera } from '../pipeline/m2_hardware/sensor_db';
import { LENS_DB, findLensByModel } from '../pipeline/m2_hardware/lens_profiles';
import { HardMetadata } from '../types/Main_types.ts';
import { SignalGraphStep } from './SignalGraphStep';
import { IngestionStep } from './IngestionStep';
import { AlignmentStep } from './AlignmentStep';
import { GeometricSolveStep } from './GeometricSolveStep';
import { ForensicCalibrationStep } from './ForensicCalibrationStep';
import { IntegrationStep } from './IntegrationStep';
import { usePipelineFSM } from '../hooks/usePipelineFSM';
import { usePipelineEvents } from '../hooks/usePipelineEvents';
import { getStepMeta } from './wizard_steps';
import { useMainTelemetry } from '../hooks/useMainTelemetry';
import { PipelineInspector } from './inspector/PipelineInspector';
import { foldPipelineEvents } from './inspector/inspector_model';
import { getFullDiagPref, setFullDiagPref } from './diag_prefs';
import { getOklabRenderPref, setOklabRenderPref } from './render_prefs';
import { getCorrectedViewPref, setCorrectedViewPref } from './render_prefs';
import { CorrectedViewPill } from './CorrectedViewPill';
import './styles/Symbols.css';

/**
 * PIPELINE WIZARD
 * 
 * Interactive stage-gated process for Astrometric Solving.
 */

const STEP_LABELS = ['Ingest', 'Context', 'Signal', 'Align', 'Solve', 'Calibrate', 'Export'];

const selectStyle: React.CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    background: 'var(--sc-panel)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    padding: '10px 32px 10px 12px',
    color: 'var(--sc-text)',
    fontSize: '14px',
    width: '100%',
    cursor: 'pointer',
    outline: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    backgroundSize: '12px',
};

const inputStyle: React.CSSProperties = {
    background: 'var(--sc-panel)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    padding: '10px 12px',
    color: 'var(--sc-text)',
    fontSize: '14px',
    fontFamily: 'monospace',
    width: '100%',
    outline: 'none',
};

const STYLES = {
    container: `
        fixed inset-0 z-50 flex items-center justify-center
        bg-[var(--sc-scrim)] backdrop-blur-md
    `,
    modal: `
        relative w-[90vw] h-[90vh] max-w-6xl
        bg-space-950 border border-line rounded-2xl
        shadow-[0_0_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden
    `,
    header: `
        relative z-10 h-16 border-b border-line-subtle flex items-center justify-between px-8
        bg-space-900/70
    `,
    body: `
        relative z-10 flex-1 flex overflow-hidden
    `,
    sidebar: `
        w-80 border-r border-line-subtle bg-space-900/40 p-6 flex flex-col gap-6
    `,
    main: `
        flex-1 relative flex flex-col overflow-hidden
    `,
    footer: `
        relative z-10 h-20 border-t border-line-subtle flex items-center justify-between px-8
        bg-space-900/70
    `,
    inputGroup: `flex flex-col gap-2`,
    label: `text-xs uppercase tracking-wide text-text-muted font-semibold`,
    input: `
        bg-space-800 border border-line rounded px-3 py-2 text-text-primary
        focus:outline-none focus:border-accent-500 focus:bg-accent-glow
        transition-all font-mono text-sm
    `,
    buttonPrimary: `
        px-6 py-2 bg-accent-600 hover:bg-accent-500 text-white rounded-lg
        font-medium transition-all
        disabled:bg-space-750 disabled:text-text-muted disabled:cursor-not-allowed
    `,
    buttonSecondary: `
        px-6 py-2 bg-space-800 hover:bg-space-750 border border-line text-text-secondary rounded-lg
        font-medium transition-all hover:text-text-primary
    `
};

interface WizardProps {
    file: File;
    /** Explicit user target hint from the upload surface (search PRIOR only). */
    hint?: { ra: number; dec: number; label: string } | null;
    backgroundImageUrl?: string;
    onClose: () => void;
    onComplete: (session: OrchestratorSession) => void;
    /**
     * Fired once, as soon as the OrchestratorSession initializes (BEFORE the
     * solve completes). Lets the App lift the active session event bus to its
     * scope so a live solve surface (the compact Live Solve Map HUD) can
     * subscribe while this modal occupies the screen. Optional — a caller that
     * only wants the final result can omit it.
     */
    onSessionReady?: (session: OrchestratorSession) => void;
    /**
     * Fired when a stage FATALLY fails (e.g. the RAW decode/extract returns null
     * or throws — historically a SILENT wedge: the step only console.error'd, so
     * the user saw the app "stuck" with no message). The App records the honest
     * message and surfaces it on the landing after the wizard closes. Optional.
     */
    onError?: (message: string) => void;
}

/** localStorage key for the Run-All ("AUTO") toggle — persisted per owner mandate. */
const AUTORUN_STORAGE_KEY = 'skycruncher.wizard.autorun';

/**
 * RECENT USER LOCATIONS — honest replacement for the old fixed
 * Tokyo/London/New York/Sydney placeholder chips (LAW 3: no fabricated
 * suggestions). We remember only locations the USER actually entered
 * (successful city search), so the "helper" surfaces real prior input
 * instead of a canned list. gps_source stays 'USER' when re-applied.
 */
const RECENT_LOCATIONS_KEY = 'skycruncher.wizard.recentLocations';
const RECENT_LOCATIONS_MAX = 5;

interface RecentLocation { label: string; lat: number; lon: number; }

function loadRecentLocations(): RecentLocation[] {
    try {
        const raw = localStorage.getItem(RECENT_LOCATIONS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((r: any) => r && typeof r.label === 'string' && Number.isFinite(r.lat) && Number.isFinite(r.lon))
            .slice(0, RECENT_LOCATIONS_MAX);
    } catch { return []; }
}

function pushRecentLocation(loc: RecentLocation): RecentLocation[] {
    const label = loc.label.trim();
    if (!label || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return loadRecentLocations();
    const next = [{ ...loc, label }, ...loadRecentLocations().filter(r => r.label.toLowerCase() !== label.toLowerCase())]
        .slice(0, RECENT_LOCATIONS_MAX);
    try { localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
}

export const PipelineWizard: React.FC<WizardProps> = ({ file, hint, backgroundImageUrl, onClose, onComplete, onSessionReady, onError }) => {
    const {
        step,
        session,
        metadata,
        isInitializing,
        nextStep,
        prevStep,
        setStep,
        updateMetadata
    } = usePipelineFSM(file, hint);

    const { downloadLogs } = useMainTelemetry(session);

    // ── GLASS PIPELINE (Phase U) ──────────────────────────────────────────
    // One batched subscription powers the header event count, the Back
    // guard (no navigation mid-stage), and the inspector drawer.
    const events = usePipelineEvents(session?.events);
    const inspectorModel = useMemo(() => foldPipelineEvents(events), [events]);
    const [inspectorOpen, setInspectorOpen] = useState(false);

    // Step-2 geocode feedback: inline notice instead of blocking alert() popups.
    const [geoNotice, setGeoNotice] = useState<string | null>(null);

    // Recent USER-entered locations (honest replacement for placeholder cities).
    const [recentLocations, setRecentLocations] = useState<RecentLocation[]>(() => loadRecentLocations());

    // Lift the active session bus to App scope the moment the session resolves
    // (fires once — `session` is created once per file). This lets a live solve
    // surface subscribe to the bus WHILE this modal is on screen, so the ★ solve
    // flowchart can light up during the run instead of only post-solve.
    useEffect(() => {
        if (session) onSessionReady?.(session);
    }, [session, onSessionReady]);

    // Run-All toggle. OFF = manual click-through (default).
    const [autoRun, setAutoRun] = useState<boolean>(() => {
        try { return localStorage.getItem(AUTORUN_STORAGE_KEY) === '1'; } catch { return false; }
    });
    const toggleAutoRun = () => setAutoRun(v => {
        const next = !v;
        try { localStorage.setItem(AUTORUN_STORAGE_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
        return next;
    });

    // Full-diagnostics override (owner performance directive): AUTO runs skip
    // expensive diagnostic visuals unless this persisted opt-in is on.
    const [fullDiag, setFullDiag] = useState<boolean>(() => getFullDiagPref());
    const toggleFullDiag = () => setFullDiag(v => {
        const next = !v;
        setFullDiagPref(next);
        return next;
    });

    // Oklab color (RENDER-LAYER ONLY, PIXEL ledger): routes the preview
    // auto-stretch through the OkLCh path. Purely aesthetic — never touches the
    // solve, WCS, matched stars, or any receipt/measurement value. Persisted
    // opt-in, DEFAULT OFF (flag off ⇒ preview bytes match the pre-Oklab STF v2).
    const [oklab, setOklab] = useState<boolean>(() => getOklabRenderPref());
    const toggleOklab = () => setOklab(v => {
        const next = !v;
        setOklabRenderPref(next);
        return next;
    });

    // Corrected view (RENDER PLANE ONLY): re-displays the post-solve preview
    // through the frame's fitted SIP distortion so measured distortion is
    // visually removed. APPROXIMATE — consumes the coordinate + pixel ledgers,
    // feeds NEITHER (never touches the solve, WCS, matched stars, or any
    // receipt/measurement). Persisted opt-in, DEFAULT OFF ⇒ the OFF path never
    // allocates the warp and the preview renders byte-identically.
    const [correctedView, setCorrectedView] = useState<boolean>(() => getCorrectedViewPref());
    const toggleCorrectedView = () => setCorrectedView(v => {
        const next = !v;
        setCorrectedViewPref(next);
        return next;
    });
    // Fitted-distortion availability for the current solution (recomputes as the
    // solve emits stage events — `solution` is mutated in place, so `events` is
    // the re-render trigger). Null before a session exists.
    const correctedInfo = useMemo(
        () => (session ? session.getCorrectedViewInfo() : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [session, events],
    );
    // The de-distorted preview URL, computed ONLY when the toggle is ON and a
    // fitted distortion is available. OFF ⇒ null, so the warp is never allocated
    // and the display falls back to the un-warped preview (byte-identical).
    const correctedUrl = useMemo(
        () => {
            if (!correctedView) return null;
            if (!session || !correctedInfo?.available) return null;
            return session.renderCorrectedPreviewUrl();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [correctedView, correctedInfo?.available, session, session?.previewUrl, events],
    );

    // AUTO advance for step 2 (the metadata form has no run stage — its
    // "completion" is the pre-filled form). Direction-guarded so pressing
    // Back into the form does NOT bounce straight forward again.
    const lastStepRef = useRef(step);
    useEffect(() => {
        const cameFrom = lastStepRef.current;
        lastStepRef.current = step;
        if (!autoRun || step !== 2 || !session) return;
        if (cameFrom > 2) return; // user backed into the form — let them edit
        const id = setTimeout(() => nextStep(), 800);
        return () => clearTimeout(id);
    }, [step, autoRun, session, nextStep]);

    // MAGNIFIER STATE
    const [magnifier, setMagnifier] = useState<{
        x: number, y: number, data: ImageData | null
    }>({ x: 0, y: 0, data: null });
    const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (magnifier.data && magnifierCanvasRef.current) {
            const ctx = magnifierCanvasRef.current.getContext('2d');
            if (ctx) ctx.putImageData(magnifier.data, 0, 0);
        }
    }, [magnifier]);

    const handleImageClick = (imgX: number, imgY: number) => {
        if (!session) return;
        const crop = session.getCrop(imgX, imgY, 512);
        setMagnifier({ x: imgX, y: imgY, data: crop });
    };

    if (isInitializing || !session) {
        return (
            <div className={STYLES.container}>
                <div className="text-text-secondary text-xl animate-pulse">Initializing Session...</div>
            </div>
        );
    }

    const handleCameraSelect = (model: string) => {
        const sensor = findSensorByCamera(model);
        if (sensor && metadata) {
            updateMetadata({
                camera_model: sensor.sensor_model,
                pixel_pitch_um: sensor.pixel_size_um
            });
        } else {
            updateMetadata({ camera_model: model });
        }
    };

    const handleLensSelect = (model: string) => {
        const lens = findLensByModel(model);
        if (lens && metadata) {
            updateMetadata({
                lens_model: lens.model,
                focal_length: lens.focal_lengths[0]
            });
        } else {
            updateMetadata({ lens_model: model });
        }
    };

    const renderStep1 = () => {
        if (!metadata) return null;
        return (
            <div className="flex flex-col h-full">
                <div className="p-8 pb-4">
                    <h2 className="text-2xl font-light text-text-primary mb-2">{getStepMeta(2).title}</h2>
                    <p className="text-text-secondary max-w-2xl">
                        {getStepMeta(2).subtitle} The camera/lens info is used only for tagging.
                    </p>
                </div>

                <div className="flex-1 grid grid-cols-2 gap-12 p-8 pt-4 overflow-y-auto">
                    <div className="flex flex-col gap-6">
                        <h3 className="text-lg text-text-primary font-medium border-b border-line pb-2">
                            Spatiotemporal
                        </h3>
                        
                        <div className={STYLES.inputGroup}>
                            <div className="flex items-center justify-between">
                                <label className={STYLES.label}>Location & Time</label>
                            </div>
                            
                            <input
                                placeholder="Search City (e.g. London, UK)..."
                                style={{...inputStyle, fontFamily: 'inherit'}}
                                onKeyDown={async (e) => {
                                    if (e.key === 'Enter') {
                                        const target = e.currentTarget;
                                        const query = target.value;
                                        if (!query) return;
                                        target.disabled = true;
                                        setGeoNotice(null);

                                        const { getCoordinatesFromCity } = await import('../utils/geocode');
                                        const coords = await getCoordinatesFromCity(query);

                                        if (coords) {
                                            updateMetadata({
                                                gps_lat: coords.lat,
                                                gps_lon: coords.lon,
                                                gps_source: 'USER'
                                            });
                                            // Remember this REAL user entry for the recent-locations helper.
                                            setRecentLocations(pushRecentLocation({ label: query.trim(), lat: coords.lat, lon: coords.lon }));
                                        } else {
                                            setGeoNotice(`Could not find "${query}" — try "City, Country".`);
                                        }
                                        if (target) {
                                            target.disabled = false;
                                            target.value = ''; 
                                        }
                                    }
                                }}
                            />

                            {geoNotice && (
                                <div role="alert" data-testid="geo-notice" className="flex items-center justify-between gap-2 text-xs text-warn bg-warn-dim border border-warn/30 rounded px-2 py-1.5">
                                    <span>{geoNotice}</span>
                                    <button aria-label="Dismiss" title="Dismiss" className="shrink-0 hover:text-text-primary" onClick={() => setGeoNotice(null)}>&times;</button>
                                </div>
                            )}

                            <div className="mt-4">
                                <div className="flex items-center justify-between">
                                    <label className={STYLES.label} htmlFor="timestamp-input">Timestamp (UTC)</label>
                                    {/* Time provenance badge — mirrors the GPS badges. A fallback
                                        wall-clock time LOOKS valid; it must wear its warning. */}
                                    <span data-testid="time-source-badge" className={`text-[10px] px-1.5 rounded ${(metadata.timestamp_source === 'EXIF' || metadata.timestamp_source === 'FITS') ? 'bg-solve-dim text-solve' : 'bg-warn-dim text-warn'}`}>
                                        {metadata.timestamp_source === 'FITS' ? 'FITS HEADER'
                                            : metadata.timestamp_source === 'EXIF' ? 'EXIF'
                                            : metadata.timestamp_source === 'USER' ? 'USER'
                                            : 'DEFAULT — VERIFY'}
                                    </span>
                                </div>
                                <input
                                    id="timestamp-input"
                                    className={`${STYLES.input} mt-1 w-full ${(metadata.timestamp_source !== 'EXIF' && metadata.timestamp_source !== 'FITS' && metadata.timestamp_source !== 'USER') ? 'border-warn/50' : ''}`}
                                    type="datetime-local"
                                    value={metadata.timestamp ? metadata.timestamp.slice(0, 16) : ''}
                                    onChange={e => {
                                        // Guard: clearing the picker yields '' → Invalid Date,
                                        // and toISOString() on it throws. Ignore invalid input;
                                        // the controlled value snaps back to the last valid time.
                                        const d = new Date(e.target.value);
                                        if (!isNaN(d.getTime())) updateMetadata({ timestamp: d.toISOString(), timestamp_source: 'USER' });
                                    }}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className={STYLES.inputGroup}>
                                <div className="flex items-center justify-between">
                                    <label className={STYLES.label} htmlFor="lat-input">Latitude</label>
                                    <span data-testid="gps-source-badge-lat" className={`text-[10px] px-1.5 rounded ${(metadata.gps_source === 'EXIF' || metadata.gps_source === 'FITS') ? 'bg-solve-dim text-solve' : 'bg-warn-dim text-warn'}`}>
                                        {metadata.gps_source === 'FITS' ? 'FITS HEADER' : (metadata.gps_source || 'USER')}
                                    </span>
                                </div>
                                <input
                                    id="lat-input"
                                    className={`${STYLES.input} ${metadata.gps_source === 'DEFAULT' ? 'border-warn/50' : ''}`}
                                    type="number" step="0.0001"
                                    value={metadata.gps_lat ?? ''}
                                    onChange={e => updateMetadata({ gps_lat: parseFloat(e.target.value), gps_source: 'USER' })}
                                />
                            </div>
                            <div className={STYLES.inputGroup}>
                                <div className="flex items-center justify-between">
                                    <label className={STYLES.label} htmlFor="lon-input">Longitude</label>
                                    <span data-testid="gps-source-badge-lon" className={`text-[10px] px-1.5 rounded ${(metadata.gps_source === 'EXIF' || metadata.gps_source === 'FITS') ? 'bg-solve-dim text-solve' : 'bg-warn-dim text-warn'}`}>
                                        {metadata.gps_source === 'FITS' ? 'FITS HEADER' : (metadata.gps_source || 'USER')}
                                    </span>
                                </div>
                                <input
                                    id="lon-input"
                                    className={`${STYLES.input} ${metadata.gps_source === 'DEFAULT' ? 'border-warn/50' : ''}`}
                                    type="number" step="0.0001"
                                    value={metadata.gps_lon ?? ''}
                                    onChange={e => updateMetadata({ gps_lon: parseFloat(e.target.value), gps_source: 'USER' })}
                                />
                            </div>
                        </div>

                        {metadata.gps_source === 'DEFAULT' && (
                            <div className="bg-warn-dim border border-warn/30 p-3 rounded text-xs text-warn animate-pulse">
                                <span className="icon-warn"></span> <strong>No EXIF GPS found.</strong> Observer location is absent (unmeasured). Enter coordinates below for atmospheric correction.
                            </div>
                        )}

                        <div className="bg-space-800 border border-line p-4 rounded text-sm text-text-secondary" data-testid="gps-helper">
                            <strong className="block mb-1 text-text-primary"><span className="icon-bulb"></span> GPS Helper</strong>
                            {recentLocations.length > 0 ? (
                                <>
                                    Recent locations you entered — reuse one, or type a city / coordinates above.
                                    <div className="flex gap-2 mt-2 flex-wrap">
                                        {recentLocations.map(loc => (
                                            <button
                                                key={loc.label}
                                                data-testid="gps-recent-location"
                                                title={`${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`}
                                                className="px-2 py-1 bg-space-750 hover:bg-space-700 border border-line rounded text-xs text-text-secondary hover:text-text-primary"
                                                onClick={() => {
                                                    setGeoNotice(null);
                                                    updateMetadata({ gps_lat: loc.lat, gps_lon: loc.lon, gps_source: 'USER' });
                                                    setRecentLocations(pushRecentLocation(loc));
                                                }}
                                            >
                                                {loc.label}
                                            </button>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <span className="text-text-muted">
                                    No saved locations yet. Search a city above or type coordinates directly —
                                    your entries are remembered here for next time.
                                </span>
                            )}
                        </div>

                        {metadata.gps_source === 'EXIF' && (
                        <div className="bg-solve-dim border border-solve/30 p-3 rounded-lg text-xs text-solve/80 flex items-center gap-2">
                            <span className="text-solve">&#10003;</span>
                            GPS coordinates locked from file metadata
                        </div>
                        )}
                    </div>

                    <div className="flex flex-col gap-6">
                        <h3 className="text-lg text-text-primary font-medium border-b border-line pb-2">
                            Hardware Tag
                        </h3>
                        
                        <div className={STYLES.inputGroup}>
                            <label className={STYLES.label} htmlFor="camera-input">Camera Model</label>
                            <select
                                id="camera-input"
                                style={selectStyle}
                                value={metadata.camera_model || ''}
                                onChange={e => handleCameraSelect(e.target.value)}
                            >
                                <option value="">Unknown / Manual</option>
                                {Object.values(SENSOR_DB).map((s: any) => (
                                    <option key={s.sensor_model} value={s.sensor_model}>{s.sensor_model}</option>
                                ))}
                            </select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className={STYLES.inputGroup}>
                                <label className={STYLES.label} htmlFor="lens-input">Lens Tag</label>
                                <select
                                    id="lens-input"
                                    style={selectStyle}
                                    value={metadata.lens_model || ''}
                                    onChange={e => handleLensSelect(e.target.value)}
                                >
                                    <option value="">Unknown / Manual</option>
                                    {Object.values(LENS_DB).map((l: any) => (
                                        <option key={l.model} value={l.model}>{l.model}</option>
                                    ))}
                                </select>
                            </div>
                            <div className={STYLES.inputGroup}>
                                <label className={STYLES.label} htmlFor="focal-input">Focal Length (mm)</label>
                                <input
                                    id="focal-input"
                                    style={inputStyle}
                                    type="number"
                                    placeholder="Reported in EXIF"
                                    /* Honest-or-absent (LAW 3): absent focal length shows the
                                       empty field + placeholder, never a fake literal 0. Data
                                       keeps the existing 0-as-absent convention (never NaN). */
                                    value={metadata.focal_length || ''}
                                    onChange={e => {
                                        const v = parseFloat(e.target.value);
                                        updateMetadata({ focal_length: Number.isFinite(v) ? v : 0 });
                                    }}
                                />
                            </div>
                        </div>

                        <div className="bg-space-800 border border-line p-4 rounded text-sm text-text-secondary">
                            <strong className="block mb-1 text-text-primary"><span className="icon-warn"></span> Solver Independence</strong>
                            The focal length entered here is a metadata tag only.
                            The solver derives the true focal length independently
                            from the measured star angles.
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const handleNext = () => {
        if (step === 7) {
            onComplete(session);
        } else {
            nextStep();
        }
    };

    return (
        <div className={STYLES.container}>
            <div className={STYLES.modal}>
                {/* HEADER */}
                <div className={STYLES.header}>
                    <div className="flex items-center gap-4 min-w-0">
                        <h1 className="text-xl font-bold text-text-primary tracking-wide whitespace-nowrap">
                            SKYCRUNCHER
                        </h1>
                        <span className="text-accent-400">/</span>
                        <span className="text-text-secondary font-mono text-sm truncate" title={file.name}>{file.name}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {/* Run-All: drives the SAME step handlers the buttons use. */}
                        <button
                            data-testid="wizard-autorun"
                            role="switch"
                            aria-checked={autoRun}
                            onClick={toggleAutoRun}
                            title="Run All: each completed step automatically starts the next. Stops on failure."
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors
                                ${autoRun
                                    ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                                    : 'border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong'}`}
                        >
                            <span className={`w-1.5 h-1.5 rounded-full ${autoRun ? 'bg-accent-400 animate-pulse' : 'bg-pending/60'}`} />
                            Auto
                        </button>

                        {/* Full diagnostics in AUTO: expensive visuals (charts,
                            quiver, PSF strips) are skipped during AUTO runs for
                            speed unless this persisted opt-in is enabled. */}
                        {autoRun && (
                            <button
                                data-testid="wizard-fulldiag"
                                role="switch"
                                aria-checked={fullDiag}
                                onClick={toggleFullDiag}
                                title="Full diagnostics in AUTO: also generate charts and PSF visuals during automated runs (slower)."
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors
                                    ${fullDiag
                                        ? 'border-warn/60 bg-warn-dim text-warn'
                                        : 'border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong'}`}
                            >
                                Diag
                            </button>
                        )}

                        {/* Glass Pipeline inspector toggle with live event count. */}
                        <button
                            data-testid="inspector-toggle"
                            aria-pressed={inspectorOpen}
                            onClick={() => setInspectorOpen(v => !v)}
                            title="Pipeline inspector: stage timeline, findings, warnings, provenance"
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors
                                ${inspectorOpen
                                    ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                                    : 'border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong'}`}
                        >
                            Inspector
                            <span className="font-mono text-[10px] tabular-nums normal-case tracking-normal">{events.length}</span>
                        </button>

                        {/* Oklab color: render-layer aesthetic option for the
                            preview stretch (perceptual OkLCh). Never affects
                            measurements — solve/WCS/matched stars are untouched. */}
                        <button
                            data-testid="wizard-oklab"
                            role="switch"
                            aria-checked={oklab}
                            onClick={toggleOklab}
                            title="Oklab color (render only): route the preview stretch through the perceptual OkLCh path. Aesthetic — never affects the solve or any measurement."
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors
                                ${oklab
                                    ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                                    : 'border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong'}`}
                        >
                            Oklab
                        </button>

                        {/* Corrected view: render-layer toggle that re-displays
                            the solved preview through the fitted SIP distortion
                            (APPROXIMATE). Shown only on the post-solve step where
                            the preview canvas lives; honest "NOT AVAILABLE" when
                            no fitted distortion exists. Never touches the solve. */}
                        {step === 5 && session.solution && correctedInfo && (
                            <CorrectedViewPill
                                info={correctedInfo}
                                on={correctedView}
                                onToggle={toggleCorrectedView}
                            />
                        )}

                        <div className="w-px h-4 bg-line" />

                        <span className="text-[10px] text-accent-400 uppercase tracking-widest font-semibold whitespace-nowrap">
                            {step}/7 - {getStepMeta(step).title}
                        </span>
                        <div className="flex gap-1">
                        {[1,2,3,4,5,6,7].map(i => (
                            <div key={i}
                                title={`${i}. ${getStepMeta(i).title}`}
                                className={`
                                w-6 h-1 rounded-full transition-all duration-500
                                ${i <= step ? (i === step && isInitializing ? 'bg-accent-400 animate-pulse' : 'bg-accent-500') : 'bg-space-700'}
                            `}/>
                        ))}
                        </div>
                    </div>
                </div>

                <div className={STYLES.body}>
                    <div className={STYLES.main}>
                        {step === 1 && (
                            <IngestionStep
                                session={session}
                                autoRun={autoRun}
                                onComplete={() => {
                                    nextStep();
                                }}
                            />
                        )}
                        {step === 2 && renderStep1()}
                        {step === 3 && (
                            <SignalGraphStep
                                session={session}
                                isActive={step === 3}
                                autoRun={autoRun}
                                backgroundImageUrl={backgroundImageUrl}
                                onComplete={handleNext}
                                onImageClick={handleImageClick}
                                onError={onError}
                            />
                        )}
                        {step === 4 && (
                            <AlignmentStep
                                session={session}
                                isActive={step === 4}
                                autoRun={autoRun}
                                backgroundImageUrl={backgroundImageUrl}
                                onComplete={handleNext}
                                onImageClick={handleImageClick}
                            />
                        )}
                        {step === 5 && (
                            <GeometricSolveStep
                                session={session}
                                isActive={step === 5}
                                autoRun={autoRun}
                                onComplete={handleNext}
                                correctedPreviewUrl={correctedUrl}
                            />
                        )}
                        {step === 6 && (
                            <ForensicCalibrationStep
                                session={session}
                                isActive={step === 6}
                                autoRun={autoRun}
                                onComplete={handleNext}
                            />
                        )}
                        {step === 7 && (
                            <IntegrationStep
                                session={session}
                                isActive={step === 7}
                                autoRun={autoRun}
                                onComplete={handleNext}
                            />
                        )}
                    </div>

                    {/* GLASS PIPELINE INSPECTOR — overlay drawer; step layout
                        underneath keeps its geometry (canvases untouched). */}
                    {inspectorOpen && (
                        <PipelineInspector
                            model={inspectorModel}
                            eventCount={events.length}
                            onClose={() => setInspectorOpen(false)}
                        />
                    )}
                </div>

                {magnifier.data && (
                    <div className="absolute bottom-24 right-8 z-[60] flex flex-col gap-2">
                        <div className="bg-space-900/90 border border-line rounded-lg overflow-hidden shadow-2xl">
                            <canvas
                                ref={magnifierCanvasRef}
                                width={512}
                                height={384}
                                className="w-64 h-48 bg-space-950"
                            />
                            <div className="p-2 bg-space-850 border-t border-line-subtle text-[10px] text-text-muted flex justify-between uppercase tracking-tighter">
                                <span>1:1 Science Buffer</span>
                                <span className="font-mono text-data">{Math.round(magnifier.x)}, {Math.round(magnifier.y)}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => setMagnifier({ ...magnifier, data: null })}
                            className="bg-space-800 hover:bg-space-750 text-text-secondary hover:text-text-primary text-[10px] py-1 rounded border border-line font-medium"
                        >
                            CLOSE MAGNIFIER
                        </button>
                    </div>
                )}

                <div className={STYLES.footer}>
                    <div className="flex gap-4">
                        <button data-testid="wizard-cancel" onClick={onClose} className={STYLES.buttonSecondary}>
                            Cancel
                        </button>
                        {/* Back: hidden on step 1; step 2's predecessor cannot be
                            re-entered (IngestionStep re-runs step1_Load on mount and
                            the source buffer is released after extraction), so it is
                            disabled there. Also disabled while a stage is running. */}
                        {step > 1 && (
                            <button
                                data-testid="wizard-back"
                                onClick={prevStep}
                                disabled={step <= 2 || inspectorModel.stageRunning || isInitializing}
                                title={step <= 2
                                    ? 'Ingestion cannot be re-entered: the source buffer is released after extraction.'
                                    : inspectorModel.stageRunning
                                        ? 'A stage is running — wait for it to finish.'
                                        : 'Return to the previous step (results are kept)'}
                                className={`${STYLES.buttonSecondary} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-secondary`}
                            >
                                &larr; Back
                            </button>
                        )}
                        <button 
                            onClick={downloadLogs}
                            className="px-4 py-2 bg-space-800 hover:bg-space-750 text-text-secondary rounded border border-line text-xs font-mono transition-colors"
                            title="Download Telemetry JSON"
                        >
                            <span className="icon-file"></span> Download Log
                        </button>
                    </div>

                    {step === 2 && (
                        <button 
                            data-testid="wizard-next-step"
                            onClick={handleNext} 
                            className={STYLES.buttonPrimary}
                        >
                            Next Step <span className="icon-arrow-right"></span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
