import React, { useState, useCallback, useRef, useEffect } from 'react';
import { MainUpload } from './engine/ui/MainUpload';
import { AnalysisPanel } from './engine/ui/AnalysisPanel';
import { ProcessingResult, ImageDimensions, AstroObservation, HardMetadata, TimeValidationStatus } from './engine/Mainlogic_entry';
// Lazy-loaded: the wizard pulls in the entire stage graph (OrchestratorSession +
// apache-arrow + ~50 modules). It is only rendered AFTER a file is selected
// (showWizard starts false), so defer it out of the boot module graph.
const PipelineWizard = React.lazy(() =>
  import('./engine/ui/PipelineWizard').then(m => ({ default: m.PipelineWizard }))
);
// Lazy-loaded for the same reason as the wizard: the widget dock pulls in the
// full widget registry graph (19 widgets incl. WebGL cascades). It only renders
// in the post-solve dashboard, so keep it out of the boot module graph.
const WidgetDock = React.lazy(() =>
  import('./engine/ui/widgets/WidgetDock').then(m => ({ default: m.WidgetDock }))
);
// Lazy-loaded (same rationale as the dock): the replay dashboard pulls in the
// full widget registry graph. Post-solve surface only, flag-gated ON.
const ReplayDashboard = React.lazy(() =>
  import('./engine/ui/dashboard/replay/ReplayDashboard').then(m => ({ default: m.ReplayDashboard }))
);
// Lazy-loaded (same rationale): the compact Live Solve Map HUD reuses the
// solve_flowchart render + selector, which pull the widget registry graph. It
// only mounts alongside the wizard (during a solve), so keep it off the boot path.
const LiveSolveFlowchart = React.lazy(() =>
  import('./engine/ui/dashboard/LiveSolveFlowchart').then(m => ({ default: m.LiveSolveFlowchart }))
);
// Lazy-loaded (same rationale as the dock/replay): the Solve Queue bulk-
// ingestor pane drives the full pipeline per file, so its stage/registry
// graph stays out of the boot module graph until the landing pane mounts.
const SolveQueuePane = React.lazy(() =>
  import('./engine/ui/dashboard/solve_queue/SolveQueuePane').then(m => ({ default: m.SolveQueuePane }))
);
// Lazy-loaded: the storage settings modal (portability — map data locations on
// this machine). Only rendered on click, and it lazily pulls the Tauri fs/dialog
// plugins inside its own handlers, so keep it off the boot module graph.
const StorageSettingsModal = React.lazy(() =>
  import('./engine/ui/StorageSettingsModal').then(m => ({ default: m.StorageSettingsModal }))
);
import { savePacket } from './engine/ui/utils/save_packet';
// First-run landing nudge (desktop-only): renders nothing in the browser build
// (no Tauri runtime → no status probe), so the web bundle / e2e is unchanged.
// Light module graph (pure starDataView + sync isTauriRuntime); Tauri APIs are
// only dynamically imported when the probe actually runs on desktop.
import { StarDataBanner } from './engine/ui/StarDataBanner';
import type { OrchestratorSession } from './engine/pipeline/orchestrator_session';
import { ThemeSwitcher } from './engine/ui/theme/ThemeSwitcher';
import { ThemeDimOverlay } from './engine/ui/theme/ThemeDimOverlay';
import { NightPeek } from './engine/ui/theme/NightPeek';
import { createRenderPrefsHost } from './engine/ui/theme/render_prefs_channel';
import './engine/ui/styles/Symbols.css';

/**
 * SKYCRUNCHER - STANDALONE PORTAL
 * A dedicated interface for the data pipeline, separate from the Physics Engine.
 */
export default function MainApp() {
  const [astroData, setAstroData] = useState<AstroObservation | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawDims, setRawDims] = useState<ImageDimensions>({ width: 0, height: 0 });

  // Lifted State
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  // Explicit user target hint from the upload surface (TargetHintInput), or null.
  // Forwarded to the wizard/session as a search PRIOR — never a measurement.
  const [targetHint, setTargetHint] = useState<{ ra: number; dec: number; label: string } | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  // Storage settings modal (portability — map data locations on this machine).
  const [showStorageSettings, setShowStorageSettings] = useState(false);
  const [locationOverride, setLocationOverride] = useState<{ lat: number; lon: number; name: string } | undefined>(undefined);
  const sessionRef = useRef<OrchestratorSession | null>(null);
  // Active session event bus, lifted out of the wizard the moment the session
  // initializes (via PipelineWizard.onSessionReady) so the Live Solve Map HUD
  // can subscribe DURING the solve — the wizard modal otherwise occludes the
  // default-visible dashboard flowchart. Cleared on reset/close.
  const [activeBus, setActiveBus] = useState<OrchestratorSession['events'] | null>(null);
  const handleSessionReady = useCallback((session: OrchestratorSession) => {
    setActiveBus(session.events);
  }, []);

  // Render-prefs pop-out host (render plane, Law 4): the main window broadcasts
  // its theme/brightness/density/peek snapshot on the 'sc-render-prefs' channel
  // and answers child 'hello's, so a docked pop-out mirrors the instrument's
  // look and can never become the bright rectangle at the telescope. No
  // measurement state crosses this channel. No-op when BroadcastChannel is
  // unavailable (createRenderPrefsHost returns null). Mount-lifetime; disposed
  // on unmount so the subscription + channel are released.
  useEffect(() => {
    const host = createRenderPrefsHost();
    return () => host?.dispose();
  }, []);

  // Widget dock receipt: rebuilt once per completed solve (astroData changes
  // exactly once per run). exportPacket is a pure read of the session state
  // plus a never-fatal side-channel workbench deposit, so it runs in an effect
  // (post-render) — never during render, never on every dashboard re-render.
  const [dockReceipt, setDockReceipt] = useState<any>(null);
  useEffect(() => {
    setDockReceipt(astroData && sessionRef.current ? sessionRef.current.exportPacket() : null);
  }, [astroData]);

  const handleAstroComplete = useCallback((res: ProcessingResult) => {
      // Guard: ensure hard metadata exists (Metadata Reaper may still be async).
      // HONEST fallback: no fabricated hardware. UNKNOWN camera, zeroed optics,
      // and NULL observer coordinates (absent, not a fake default) — AnalysisPanel
      // detects the absent location via gps_source and renders "NOT MEASURED",
      // so nothing here can render as if it were measured.
      const hard: HardMetadata = res?.hard ?? {
          camera_model: 'UNKNOWN',
          lens_model: 'UNKNOWN',
          focal_length: 0,
          aperture: 0,
          iso_gain: 0,
          exposure_time: 0,
          timestamp: new Date().toISOString(),
          timestamp_source: 'DEFAULT',
          gps_lat: null,
          gps_lon: null,
          gps_source: 'DEFAULT',
      };

      // Map ProcessingResult to AstroObservation for display
      const obs: AstroObservation = {
          id: `TEMP_${Date.now()}`,
          hard,
          soft: res?.soft ?? {
              is_stacked: false,
              stack_frame_count: null,
              tracking_mount: 'NONE' as any,
              filter_type: 'NONE' as any,
              calibration_frames: [],
              // Not user-provided on this path — honest null renders as '--'
              bortle_class: null as unknown as number,
              contribute_to_archive: false,
          },
          derived: res?.derived ? {
              ...res.derived,
              planetary_matches: res.planets
          } : null,
          forensics: res?.forensics ?? null,
          solution: res?.solution ?? null,
          preview_url: res?.preview_url ?? null,
          stateKey: res?.packet?.state_key ?? null,
          stages: res?.stages ?? [],
          manifest: res?.manifest
      };
      (window as any).astroPreviewUrl = obs.preview_url;
      setAstroData(obs);
      
      // If the pipeline extracted a preview (e.g. from RAW demosaic or thumbnail), use it
      if (res?.preview_url) {
         // Revoke previous blob URL to free memory
         setPreviewUrl(prev => {
             if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
             return res.preview_url!;
         });
      }

      // Update RAW dimensions for the overlay mapping:
      // We prioritize the centralized ScaleManager metadata if available.
      if (res.scales?.sensor_width) {
          setRawDims({ width: res.scales.sensor_width, height: res.scales.sensor_height });
      } else if (res.hard?.width && res.hard?.height) {
          setRawDims({ width: res.hard.width, height: res.hard.height });
      }
  }, []);

  // Effect to sync pipeline result to astroData
  const handleFileSelect = useCallback((file: File, hint?: { ra: number, dec: number, label: string }) => {
    setCurrentFile(file);
    // Carry the upload hint forward to the wizard/session instead of dropping it
    // (search PRIOR only; the solver ranks it via the CONFIG hint rung).
    setTargetHint(hint ?? null);
    setShowWizard(true);
    setActiveBus(null); // new file → no live bus until this run's session is ready
    setPreviewUrl(null);
  }, []);

  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;

    if (rawDims.width === 0) {
       setRawDims({ width: naturalWidth, height: naturalHeight });
    }
  };

  const reset = () => {
    sessionRef.current = null;
    setAstroData(null);
    setPreviewUrl(null);
    setCurrentFile(null);
    setTargetHint(null);
    setShowWizard(false);
    setActiveBus(null); // drop the live-HUD bus for the finished/abandoned run
    setRawDims({ width: 0, height: 0 });
    setLocationOverride(undefined); // Clear location
  };

  return (
    <div className="astro-app-root">
       {/* ── HEADER ── */}
       <div className="astro-header">
          <div className="logo">SKYCRUNCHER <span className="beta-tag">BETA</span></div>
          <div className="header-right">
              {/* Theme switcher (restyle 2026-07-21) — Light · Dark · ✦ Stargazing,
                  mirroring the design mockup's header placement (screen 2a/3b), with
                  the night brightness slider. Render plane only. */}
              <ThemeSwitcher />
              {/* Settings — storage locations + star-data / quad download. Labeled
                  (not a bare glyph) so a first-run user can discover it; opens the
                  Settings modal (desktop: native folder picker + R2 download). */}
              <button
                 className="settings-btn"
                 title="Settings — storage locations & star-data download"
                 aria-label="Settings — storage locations and star-data download"
                 onClick={() => setShowStorageSettings(true)}
              >
                 <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>⚙</span>
                 <span>Settings</span>
              </button>
              {/* Status glyph ships in all themes (● earned / ◌ absent) via the
                  [data-sc-glyph] ::before in index.css — the string is untouched
                  (machine-read, load-bearing), the glyph is pure CSS content. */}
              <div className="status" data-sc-glyph={astroData ? 'solve' : 'absent'}>
                 {astroData ? 'ANALYSIS COMPLETE' : 'WAITING FOR DATA'}
              </div>
          </div>
       </div>

       {/* Storage settings modal (portability). Lazy; only mounts when opened. */}
       {showStorageSettings && (
          <React.Suspense fallback={null}>
             <StorageSettingsModal onClose={() => setShowStorageSettings(false)} />
          </React.Suspense>
       )}

       {/* ── MAIN CONTENT ── */}
       <div className="astro-content">

          {/* 1. UPLOAD ZONE + LANDING DASHBOARD (Visible when no data) */}
          {!astroData && !showWizard && (
             <div className="landing-root">
                {/* First-run star-data nudge (desktop-only; null in the browser build).
                    Points a fresh install into Settings → Star data when the solver's
                    quad index is not yet on this machine. Dismissible; honest sizes. */}
                <StarDataBanner onOpenSettings={() => setShowStorageSettings(true)} />
                <div className="upload-container">
                   <div className="hero-text">
                      Processing Pipeline v1.0
                      <div className="sub-text">Raw/FITS Ingestion • Plate Solving • Calibration</div>
                   </div>
                   <MainUpload
                      onFileSelect={(file, hint) => {
                          handleFileSelect(file, hint);
                      }}
                   />
                   {/* Solve Queue — BULK INGESTOR (A2/R6): drop / pick-from-source,
                       runs the REAL pipeline per file sequentially, each run captured
                       + replayable. DEFAULT ON (opt-out via skycruncher.solvequeue.pane);
                       self-gates to null when off. Lazy — heavy graph off the boot path. */}
                   <React.Suspense fallback={null}>
                      <SolveQueuePane />
                   </React.Suspense>
                </div>

                {/* LANDING DASHBOARD (v1.0.0 triage): the owner expected a dashboard
                    on launch, not only after a solve. Co-mount the replay dashboard
                    (honest empty state / past runs / dropped runs*.jsonl per
                    ReplayDashboard) and the widget dock with a NULL receipt — every
                    widget frame self-gates to NOT MEASURED on a null receipt (LAW 3;
                    verified: receipt-backed selectors return null, the structural
                    flowchart paints per-box NOT MEASURED, nothing fabricates a
                    number). Upload stays primary (above); both self-gate to null when
                    their opt-out flags are set, so this adds ZERO surface when off. */}
                {(() => {
                   // Honest-or-absent (LAW 3): frame AND render the secondary dashboard
                   // section only when at least one panel will actually paint. Both are
                   // DEFAULT ON; a user who opts out of BOTH gets no dangling "preview"
                   // heading over an empty section. Canonical getters live in
                   // ReplayDashboard / WidgetDock — the flag keys are read literally here
                   // to keep their heavy lazy module graph off the boot path.
                   let replayOn = true, dockOn = true;
                   try {
                      replayOn = localStorage.getItem('skycruncher.replay.dashboard') !== '0';
                      dockOn = localStorage.getItem('skycruncher.widgets.dock') !== '0';
                   } catch { /* storage unavailable → treat as default ON */ }
                   if (!replayOn && !dockOn) return null;
                   return (
                      <div className="landing-dashboard" aria-label="Instrument dashboard preview">
                         <div className="landing-dashboard-intro">
                            <span className="ld-eyebrow">Instrument Dashboard</span>
                            <span className="ld-note">
                               Preview — every panel fills with real measurements once you run a solve.
                               Empty now is expected, not an error.
                            </span>
                         </div>
                         <React.Suspense fallback={null}>
                            <ReplayDashboard />
                         </React.Suspense>
                         <React.Suspense fallback={null}>
                            <WidgetDock receipt={null} />
                         </React.Suspense>
                      </div>
                   );
                })()}
             </div>
          )}

          {/* 2. PIPELINE WIZARD OVERLAY */}
          {showWizard && currentFile && (
            <React.Suspense fallback={
              <div className="processing-overlay">
                  <div className="spinner"></div>
                  <div className="progress-text"><strong>Loading pipeline…</strong></div>
              </div>
            }>
              <PipelineWizard
                  file={currentFile}
                  hint={targetHint}
                  onSessionReady={handleSessionReady}
                  onClose={() => { setActiveBus(null); setShowWizard(false); }}
                  onComplete={(session) => {
                      sessionRef.current = session;
                      setShowWizard(false);
                      // Use the session results if available
                      if (session.metadata && session.solution) {
                          handleAstroComplete({
                              hard: session.metadata,
                              soft: {
                                  is_stacked: false,
                                  stack_frame_count: null,
                                  tracking_mount: 'NONE' as any,
                                  filter_type: 'NONE' as any,
                                  calibration_frames: [],
                                  // The wizard does not collect sky quality —
                                  // honest null renders as '--', not a fake class
                                  bortle_class: null as unknown as number,
                                  contribute_to_archive: true
                              },
                              derived: {
                                  plate_center: `${session.solution.ra_hours.toFixed(4)}h ${session.solution.dec_degrees.toFixed(4)}°`,
                                  field_rotation: session.solution.rotation,
                                  pixel_scale: session.scaleLock || 0,
                                  sky_mask: null,
                                  // Real M4 clean-star count; null (not 0) when
                                  // the signal packet is unavailable
                                  stellar_density: session.signal ? session.signal.clean_stars.length : null,
                                  airglow_index: 0
                              },
                              packet: {
                                  signature: 'Verifiable_Packet',
                                  timestamp: new Date().toISOString(),
                                  state_key: 'VALIDATED'
                              },
                              preview_url: session.previewUrl,
                              solution: session.solution,
                              forensics: session.forensics,
                              planets: session.planets,
                              scales: session.scales?.getFrontendExport(),
                              stages: [],
                              total_duration_ms: 0,
                              overlay_state: {
                                  showConstellations: true,
                                  showStars: true,
                                  showGrid: true,
                                  showDSCOVR: false
                              }
                          } as unknown as ProcessingResult);
                      }
                  }}
              />
            </React.Suspense>
          )}

          {/* LIVE SOLVE MAP — compact floating flowchart HUD, co-mounted with the
              wizard so the ★ solve DAG lights up LIVE during the run (the modal
              above occludes the default-visible dashboard flowchart). Fed by the
              lifted active bus; self-gates to null until the session initializes
              (LAW 3). Lazy — its registry graph stays off the boot path. */}
          {showWizard && activeBus && (
            <React.Suspense fallback={null}>
              <LiveSolveFlowchart bus={activeBus} />
            </React.Suspense>
          )}

          {/* 2. DASHBOARD (Visible when data exists) */}
          {astroData && (
             <div className="analysis-container">

                {/* Visual Preview */}
                <div className="image-viewport-container">
                   {previewUrl ? (
                      <div className="image-wrapper" style={{ position: 'relative' }}>
                        {/* NightPeek (render plane, Law 4): in the stargazing theme the
                            preview shows red-channel-only + dimmed; press-and-hold reveals
                            true color. A pure pass-through (no wrapper/overlay) off-night,
                            so dark/light DOM + behavior are unchanged. */}
                        <NightPeek style={{ maxWidth: '100%' }}>
                          <img
                             src={previewUrl}
                             alt="Observation Preview"
                             className="astro-preview-img"
                             onLoad={onImageLoad}
                          />
                        </NightPeek>
                        {/* Honest color provenance (COLOR_MATH_PROGRAM labeling law): the
                            DERIVED render mode + measured SPCC fidelity, or NOT MEASURED. */}
                        {(() => {
                          const ci = sessionRef.current?.previewColorInfo;
                          const spcc = sessionRef.current?.spccBlock;
                          const fid = spcc?.fidelity;
                          const gains = spcc?.gains;
                          return (
                            <div
                              className="color-provenance-badge"
                              data-testid="color-provenance-badge"
                              style={{ position: 'absolute', bottom: 6, left: 6, display: 'flex',
                                       flexDirection: 'column', gap: 2, fontSize: 10,
                                       fontFamily: 'var(--font-mono, monospace)', lineHeight: 1.35,
                                       background: 'var(--sc-scrim)', color: 'var(--color-data)',
                                       padding: '3px 7px', borderRadius: 4, pointerEvents: 'none',
                                       maxWidth: '90%' }}
                            >
                              <span data-testid="preview-color-mode">
                                {ci ? ci.label : 'COLOR: NOT MEASURED'}
                              </span>
                              <span data-testid="preview-spcc">
                                {spcc && spcc.source === 'SPCC_RGB'
                                  ? `SPCC r2=${spcc.color_r2.toFixed(3)} (${spcc.n_stars} stars)`
                                    + (fid ? ` · TLS slope ${fid.slope_tls != null ? fid.slope_tls.toFixed(2) : 'NA'}` : '')
                                  : 'SPCC: NOT MEASURED'}
                              </span>
                              {/* §3.2 SPCC-grounded WB honesty (COLOR_MATH_PROGRAM labeling law):
                                  DERIVED when the TLS gains were applied to the render, else the
                                  honest heuristic label with the recorded-not-applied reason. */}
                              {gains && (
                                <span data-testid="preview-spcc-wb">
                                  {gains.applied
                                    ? `DERIVED: SPCC-calibrated WB (TLS, N=${gains.nStars}, r²=${gains.r2.toFixed(3)})`
                                    : `WB: star-ensemble heuristic · SPCC gains recorded, not applied (${gains.gate.reason})`}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                       <div className="no-preview-placeholder">
                          <div className="placeholder-icon"><span className="icon-camera"></span></div>
                          <div>RAW File — No Preview Available</div>
                          <div className="sub">Demosaic stage may have failed. Check console for details.</div>
                       </div>
                    )}
                </div>

                <AnalysisPanel
                    observation={astroData}
                    onUpdateMetadata={(updates) => {
                        // Keep the optimistic update logic for quick UI feedback
                        if (!astroData) return;
                        const newHard = { ...astroData.hard, ...updates };
                        setAstroData((prev: AstroObservation | null) => prev ? ({ ...prev, hard: newHard }) : null);
                    }}
                />

                {/* Widget dock (DEFAULT ON, opt-out via skycruncher.widgets.dock).
                    Self-gating: renders nothing when the flag is '0'. Lazy so its
                    registry graph stays out of the boot bundle. */}
                <React.Suspense fallback={null}>
                    <WidgetDock receipt={dockReceipt} />
                </React.Suspense>

                {/* Replay Dashboard (wave 3): post-solve, window-splittable,
                    widget-swapping, speed-scrubbing replay of this run + past
                    runs. DEFAULT ON (opt-out via skycruncher.replay.dashboard);
                    self-gates to null when off. Lazy — registry graph stays out
                    of the boot bundle. */}
                <React.Suspense fallback={null}>
                    <ReplayDashboard liveBus={sessionRef.current?.events} receipt={dockReceipt} />
                </React.Suspense>

                <div className="action-row">
                    <button
                      className="btn-reset"
                      onClick={reset}
                    >
                      Process Another File
                    </button>
                   <button
                     className="btn-export"
                     disabled={!sessionRef.current}
                     title={sessionRef.current ? 'Download JSON receipt' : 'No wizard session available — run the pipeline wizard to enable export'}
                     onClick={() => {
                         if (sessionRef.current) savePacket(sessionRef.current.exportPacket());
                     }}
                   >
                     EXPORT JSON RECEIPT
                   </button>
                </div>
             </div>
          )}

       </div>

       {/* Full-viewport dim overlay (render plane) — mounted ONCE at the app
           root; opacity = the active theme's per-theme brightness. Invisible at
           full brightness (day default), dims night. pointer-events:none. */}
       <ThemeDimOverlay />

       {/* ── CSS ── */}
       <style>{`
          .astro-app-root {
             width: 100vw;
             height: 100vh;
             background: var(--sc-page);
             color: var(--sc-text);
             font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
             display: flex;
             flex-direction: column;
             overflow: hidden;
          }
          .astro-header {
             height: 60px;
             border-bottom: 1px solid var(--sc-line-subtle);
             display: flex;
             justify-content: space-between;
             align-items: center;
             padding: 0 24px;
             background: var(--sc-shell);
             backdrop-filter: blur(10px);
          }
           .logo {
             font-weight: 800;
             letter-spacing: 2px;
             font-size: 1.1em;
             color: var(--sc-text);
          }
          .beta-tag {
             font-size: 0.5em;
             background: var(--sc-accent-glow);
             color: var(--sc-accent-hi);
             border: 1px solid var(--sc-line);
             padding: 2px 4px;
             border-radius: 2px;
             margin-left: 8px;
             vertical-align: middle;
          }

          .status {
             font-family: var(--font-mono, monospace);
             font-size: 0.8em;
             opacity: 0.5;
          }
          .status-processing {
             color: var(--sc-accent-hi);
          }

          .header-right {
             display: flex;
             align-items: center;
             gap: 20px;
          }

          .settings-btn {
             display: inline-flex;
             align-items: center;
             gap: 6px;
             background: var(--sc-card);
             border: 1px solid var(--sc-line);
             color: var(--sc-text-2);
             font-family: var(--font-sans, inherit);
             font-size: 12px;
             font-weight: 600;
             letter-spacing: 0.3px;
             padding: 5px 12px;
             border-radius: 6px;
             cursor: pointer;
             transition: all 0.2s;
          }
          .settings-btn:hover {
             background: var(--sc-accent-glow);
             border-color: var(--sc-accent-ring);
             color: var(--sc-accent);
          }

          .btn-download-log {
             background: var(--sc-card);
             border: 1px solid var(--sc-line);
             color: var(--sc-accent);
             font-family: var(--font-mono, monospace);
             font-size: 10px;
             padding: 4px 10px;
             border-radius: 4px;
             cursor: pointer;
             transition: all 0.2s;
          }
          .btn-download-log:hover {
             background: var(--sc-accent-glow);
             border-color: var(--sc-accent-ring);
          }

          .astro-content {
             flex: 1;
             display: flex;
             justify-content: center;
             align-items: center;
             position: relative;
          }

          .error-banner {
             position: absolute;
             top: 80px;
             left: 50%;
             transform: translateX(-50%);
             width: 90%;
             max-width: 600px;
             background: var(--sc-card);
             border: 1px solid var(--sc-danger);
             color: var(--sc-danger);
             padding: 16px 24px;
             border-radius: 8px;
             display: flex;
             align-items: center;
             gap: 16px;
             z-index: 1000;
             box-shadow: 0 4px 20px rgba(0,0,0,0.5);
             animation: slideDown 0.3s ease-out;
          }
          .error-icon { font-size: 1.5em; }
          .error-content { flex: 1; }
          .error-content strong { display: block; margin-bottom: 2px; }
          .error-content p { margin: 0; font-size: 0.9em; opacity: 0.9; }
          .btn-error-close {
             background: var(--sc-danger-dim);
             border: 1px solid var(--sc-danger);
             color: var(--sc-danger);
             padding: 6px 12px;
             border-radius: 4px;
             cursor: pointer;
             font-weight: 600;
          }
          .btn-error-close:hover { background: var(--sc-danger); color: var(--sc-btn-fill-text); }

          .landing-root {
             width: 100%;
             max-height: 100%;
             overflow-y: auto;
             display: flex;
             flex-direction: column;
             align-items: center;
             gap: 40px;
             padding: 24px 0 48px;
          }
          .landing-dashboard {
             width: 100%;
             max-width: 1000px;
             display: flex;
             flex-direction: column;
             gap: 24px;
             padding: 0 24px;
          }
          .landing-dashboard-intro {
             display: flex;
             flex-direction: column;
             gap: 4px;
             padding-top: 20px;
             border-top: 1px solid var(--sc-line-subtle);
          }
          .ld-eyebrow {
             font-size: 0.7rem;
             font-weight: 700;
             letter-spacing: 2px;
             text-transform: uppercase;
             color: var(--sc-muted);
          }
          .ld-note {
             font-size: 0.78rem;
             line-height: 1.45;
             color: var(--sc-text-2);
             max-width: 640px;
          }

          .upload-container {
             display: flex;
             flex-direction: column;
             align-items: center;
             gap: 32px;
             animation: fadeIn 0.5s ease-out;
          }

          .hero-text {
             text-align: center;
             font-size: 1.5em;
             font-weight: 300;
             color: var(--sc-text);
          }
          .sub-text {
             font-size: 0.6em;
             opacity: 0.5;
             margin-top: 8px;
             letter-spacing: 1px;
             text-transform: uppercase;
          }
           
           .processing-overlay {
               position: absolute;
               top: 50%; left: 50%;
               transform: translate(-50%, -50%);
               background: var(--sc-panel);
               padding: 40px;
               border-radius: 12px;
               border: 1px solid var(--sc-line);
               display: flex;
               flex-direction: column;
               align-items: center;
               gap: 16px;
               z-index: 100;
           }
           .spinner {
               width: 30px; height: 30px;
               border: 3px solid var(--sc-line);
               border-top-color: var(--sc-accent);
               border-radius: 50%;
               animation: spin 1s linear infinite;
           }
           .progress-bar-track { width: 200px; height: 4px; background: var(--sc-line); border-radius: 2px; overflow: hidden; }
           .progress-bar-fill { height: 100%; background: var(--sc-accent); transition: width 0.3s; width: var(--progress-width, 0%); }
           @keyframes spin { to { transform: rotate(360deg); } }

          .analysis-container {
             width: 100%;
             max-width: 800px;
             padding: 24px;
             animation: slideUp 0.4s ease-out;
             overflow-y: auto;
             max-height: 100%;
          }

          .image-viewport-container {
             width: 100%;
             display: flex;
             justify-content: center;
             background: var(--sc-shell);
             border-radius: 8px;
             padding: 16px;
             margin-bottom: 24px;
             overflow: hidden;
          }

          .image-wrapper {
             position: relative;
             display: inline-block;
          }

          .astro-preview-img {
             max-width: 100%;
             height: auto;
             display: block;
             border-radius: 4px;
             box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          }
          
          .action-row {
             display: flex;
             justify-content: flex-end;
             gap: 16px;
             margin-top: 24px;
             padding-bottom: 40px;
          }

          .btn-reset, .btn-export {
             padding: 12px 24px;
             border-radius: 6px;
             border: none;
             cursor: pointer;
             font-weight: 600;
             transition: all 0.2s;
          }
          .btn-reset {
             background: var(--sc-card);
             color: var(--sc-text-2);
          }
          .btn-reset:hover { background: var(--sc-elev); }

           .btn-overlay {
              background: var(--sc-accent-glow);
              border: 1px solid var(--sc-accent-ring);
              color: var(--sc-accent);
              margin-right: 12px;
               padding: 12px 24px;
             border-radius: 6px;
             cursor: pointer;
              font-weight: 600;
           }
           .btn-overlay.active {
              background: var(--sc-btn-fill);
              color: var(--sc-btn-fill-text);
           }
           .btn-overlay:hover {
              background: var(--sc-accent-glow);
           }

           .btn-export {
              background: var(--sc-btn-fill);
              color: var(--sc-btn-fill-text);
              border: 1px solid var(--sc-btn-border);
           }
           .btn-export:hover { filter: brightness(1.15); }
           .btn-export:disabled { opacity: 0.4; cursor: not-allowed; }

          @keyframes fadeIn {
             from { opacity: 0; transform: scale(0.98); }
             to { opacity: 1; transform: scale(1); }
          }
          @keyframes slideUp {
             from { opacity: 0; transform: translateY(20px); }
             to { opacity: 1; transform: translateY(0); }
          }
       `}</style>
    </div>
  );
}
