import React from 'react';
import './styles/Symbols.css';
import {
  MapPin, Clock, Eye, Scale,
  CheckCircle, ShieldCheck,
  Globe, Database
} from 'lucide-react';
import { AstroObservation, DerivedMetadata, HardMetadata, TimeValidationStatus } from '../types/schema';
import { TelemetryBar } from './dashboard/TelemetryBar';
import { PlanetaryManifest } from './dashboard/PlanetaryManifest';
import { StarIntegrityList } from './dashboard/StarIntegrityList';
import { DeepConfirmCard } from './dashboard/DeepConfirmCard';
import { DataFlowDiagram } from './dashboard/DataFlowDiagram';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { useMainTelemetry } from '../hooks/useMainTelemetry';
import { CoordinateSystem } from '../types/manifest';
// Export is now the unified saveExport dispatcher (via ExportSelector) — the
// FITS/ASDF byte production + Tauri-vs-browser sink live there, not inline here.
import { ExportSelector } from './ExportSelector';
import type { ExportImage } from './utils/save_export';

interface AnalysisPanelProps {
  observation: AstroObservation | null;
  session?: OrchestratorSession | null;
  processingTime?: number;
  onUpdateMetadata?: (updates: Partial<HardMetadata>) => void;
}

export function AnalysisPanel({ observation, session, processingTime, onUpdateMetadata }: AnalysisPanelProps) {
  const { logEvent, downloadLogs } = useMainTelemetry(session || null);

  // [export] Build the receipt ONCE per solve for the unified export selector.
  // exportPacket() carries a workbench deposit side-effect (browser IndexedDB), so
  // it runs in an effect keyed on the solve — never on every render. null until a
  // fitted-WCS solve exists (the export selector then shows honest DISABLED rows).
  const [panelReceipt, setPanelReceipt] = React.useState<any>(null);
  React.useEffect(() => {
    const solved = !!observation?.solution
      && observation?.manifest?.coordinateSystem === CoordinateSystem.Wcs
      && !!session;
    setPanelReceipt(solved ? session!.exportPacket() : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, observation?.solution, observation?.manifest?.coordinateSystem]);

  if (!observation || !observation.derived) return null;

  const { hard, derived, soft } = observation;
  const timeVal = derived.time_validation;

  // Location is absent when no trusted GPS source resolved (null coords).
  // Honest-or-absent: no fabricated default to "detect" anymore.
  const isLocationAbsent = hard.gps_source === 'DEFAULT' || hard.gps_lat == null || hard.gps_lon == null;

  // Helper to format DMS/HMS
  const formatCoord = (center: string) => {
    if (!center || center === 'UNSOLVED') return 'UNSOLVED';
    const parts = center.split(' ');
    if (parts.length < 6) return center;
    return {
      ra: `${parts[0]} ${parts[1]} ${parts[2]}`,
      dec: `${parts[3]} ${parts[4]} ${parts[5]}`
    };
  };

  const coords = formatCoord(derived.plate_center);

  // Real clean-star count. The wizard handoff stores the M4 clean-star count
  // as derived.stellar_density (untyped extension); the auto pipeline does not
  // carry the signal packet here, so fall back to the solver's verified-match
  // count. If no real count exists on this data path, this is null and the
  // TelemetryBar renders '--' — never 0-as-fact.
  const wizardStarCount: number | null | undefined = (derived as any)?.stellar_density;
  const cleanStarCount: number | null =
      wizardStarCount
      ?? observation.solution?.matched_stars?.length
      ?? observation.solution?.num_stars
      ?? null;

  // Catalog cross-match is only "verified" when a plate solve actually exists.
  const matchedStarCount = observation.solution?.matched_stars?.length
      ?? observation.solution?.num_stars ?? 0;
  const catalogStatus = observation.solution ? 'verified' : 'unverified';
  const catalogTooltip = observation.solution
      ? `Plate solve verified — ${matchedStarCount} catalog stars cross-matched (Gaia DR3 star store)`
      : 'No plate solution — catalog backcheck not performed';

  return (
    <div className="analysis-panel">
      <div className="panel-header">
        <h3><span className="icon-telescope"></span>Astro-Analysis</h3>
        <span className="duration-badge">{processingTime ? `${processingTime}ms` : ''}</span>
      </div>

      {observation.forensics && (
        <TelemetryBar
          metrics={observation.forensics}
          starCount={cleanStarCount}
          anomalyCount={observation.forensics.anomaly_counts.satellites + observation.forensics.anomaly_counts.hot_pixels + observation.forensics.anomaly_counts.terrestrial}
        />
      )}

      {/* Data Flow Summary */}
      <div className="mb-6">
        <DataFlowDiagram manifest={observation.manifest} />
      </div>

      <div className="metrics-grid">
        
        {/* 1. Location & Conditions */}
        <div className={`metric-card ${isLocationAbsent ? 'warn' : ''}`}>
          <div className="metric-icon"><MapPin size={16} /></div>
          <div className="metric-content">
            <span className="metric-label">Location</span>
            <div className="value-row">
                <span className="metric-value">
                {hard.gps_lat != null && hard.gps_lon != null
                    ? <>{hard.gps_lat.toFixed(4)}<span className="icon-degree"></span>, {hard.gps_lon.toFixed(4)}<span className="icon-degree"></span></>
                    : 'NOT MEASURED'}
                </span>
            </div>

            {isLocationAbsent && (
                <div className="fix-ui">
                    <span className="warning-text"><span className="icon-warn"></span>Observer location not provided</span>
                </div>
            )}

            {/* Wizard-session handoff has no atmospheric derivation — show honest placeholder */}
            <span className="metric-sub">Air Mass: {derived.air_mass != null ? derived.air_mass.toFixed(2) : '--'}</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-icon"><Eye size={16} /></div>
          <div className="metric-content">
            <span className="metric-label">Sky Quality</span>
            {/* Bortle class is user-provided; the wizard does not collect it
                (null) — show the honest placeholder instead of a default. */}
            <span className="metric-value">{soft.bortle_class != null ? `Bortle ${soft.bortle_class}` : '--'}</span>
            <span className="metric-sub">
              Rayleigh Coeff: {derived.rayleigh_coeff != null ? derived.rayleigh_coeff.toFixed(3) : '--'}
            </span>
          </div>
        </div>

        {/* 2. Plate Solution */}
        <div className="metric-card wide">
          <div className="metric-icon"><Globe size={16} /></div>
          <div className="metric-content">
            <div className="label-row">
                <span className="metric-label">Plate Solution (J2000)</span>
            </div>

            {coords !== 'UNSOLVED' && observation.manifest?.coordinateSystem === CoordinateSystem.Wcs && observation.solution && session && panelReceipt && (
                 <div className="asdf-export-row" style={{ marginTop: '8px' }}>
                     {/* Unified export surface — same saveExport dispatcher as step-7
                         (receipt/FITS/ASDF/Arrow), one Tauri-native save path. The
                         availability matrix shows DISABLED+reason rows honestly
                         (LAW 3); the receipt is built once per solve in the effect. */}
                     <ExportSelector
                         compact
                         receipt={panelReceipt}
                         hasImage={!!session.getExportImage()}
                         getImage={() => session.getExportImage() as ExportImage | null}
                     />
                 </div>
            )}

            {coords === 'UNSOLVED' ? (
               <span className="metric-value error">UNSOLVED</span>
            ) : (
               <div className="coord-grid">
                  <div>RA: <span className="mono">{typeof coords === 'string' ? coords : coords.ra}</span></div>
                  <div>Dec: <span className="mono">{typeof coords === 'string' ? '' : coords.dec}</span></div>
               </div>
            )}
            <span className="metric-sub">Scale: {derived.pixel_scale.toFixed(2)}"/px</span>
          </div>
        </div>

        {/* 3. Cronos Check (Time Validation) */}
        <div className={`metric-card extra-wide ${timeVal?.status === 'VALID' ? 'ok' : 'warn'}`}>
          <div className="metric-icon">
            <Clock size={16} />
          </div>
          <div className="metric-content">
            <div className="label-row">
                <span className="metric-label">Cronos Check (Temporal Validity)</span>
            </div>

            <div className="validation-row">
              <span className="status-pill">{timeVal?.status || 'UNKNOWN'}</span>
              <span className="status-msg">{timeVal?.message || 'No timestamp validation performed.'}</span>
            </div>

            <div className="metric-sub">
                {new Date(hard.timestamp).toLocaleString()}
            </div>
          </div>
        </div>

        {/* 5. Validation Sources — states are DERIVED from the actual solve.
            TNS and Swarm badges were removed: those services are not
            integrated, and we do not fake states for services that don't
            exist. */}
        <div className="validation-section">
           <h4><span className="icon-shield"></span>Trust & Validation (Backcheck)</h4>
           <div className="trust-grid">
              <TrustBadge
                 label="Gaia DR3"
                 icon={<Database size={12}/>}
                 status={catalogStatus}
                 tooltip={catalogTooltip}
              />
              {/* HYG v3.8 badge REMOVED (Gaia-only ruling 2026-07-22): no live
                  path reads HYG data — the badge described a retired catalog. */}
           </div>
           {/* W2.1 Deep Confirmation — renders NOTHING when
               solution.deep_confirmed is absent (honest absence). */}
           <DeepConfirmCard deep={observation.solution?.deep_confirmed} />
        </div>

        {/* 6. Forensic Deep-Dive (Manifests) */}
        {observation.derived.planetary_matches && (
          <div className="metric-card wide">
             <PlanetaryManifest planets={observation.derived.planetary_matches} />
          </div>
        )}

        {observation.solution?.matched_stars && (
          <div className="metric-card wide">
             <StarIntegrityList
                matches={observation.solution.matched_stars}
                forced={observation.solution.deep_forced}
             />
          </div>
        )}

      </div>

      <style>{`
        .analysis-panel {
          border: 1px solid var(--sc-line);
          max-height: 85vh;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--sc-line-strong) transparent;
        }
        .panel-header {
           display: flex;
           justify-content: space-between;
           align-items: center;
           margin-bottom: 12px;
           border-bottom: 1px solid var(--sc-line-subtle);
           padding-bottom: 8px;
        }
        .panel-header h3 { margin: 0; font-size: 0.95em; text-transform: uppercase; letter-spacing: 1px; color: var(--sc-accent); }
        .duration-badge { font-size: 0.8em; opacity: 0.6; font-family: monospace; }
        
        .metrics-grid {
           display: grid;
           grid-template-columns: 1fr 1fr;
           gap: 8px;
        }
        
        .metric-card {
           background: var(--sc-card);
           border-radius: 6px;
           padding: 8px;
           display: flex;
           gap: 8px;
           align-items: flex-start;
           position: relative;
        }
        .metric-card.wide, .metric-card.extra-wide { grid-column: span 2; }

        .metric-icon {
           opacity: 0.7;
           padding-top: 2px;
           color: var(--sc-accent);
        }
        
        .metric-content { display: flex; flex-direction: column; width: 100%; }
        .metric-label { font-size: 0.7em; text-transform: uppercase; opacity: 0.6; margin-bottom: 2px; }
        .metric-value { font-size: 0.9em; font-weight: 500; }
        .metric-sub { font-size: 0.75em; opacity: 0.5; margin-top: 2px; }
        
        .coord-grid { display: flex; justify-content: space-between; font-size: 0.9em; }
        .mono { font-family: var(--font-mono, monospace); color: var(--sc-data); }

        .metric-card.warn { border-left: 3px solid var(--sc-warn); background: var(--sc-warn-dim); }
        .metric-card.ok { border-left: 3px solid var(--sc-solve); background: var(--sc-solve-dim); }

        /* Fix UI Styles */
        .fix-ui { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
        .warning-text { font-size: 0.7em; color: var(--sc-warn); font-weight: bold; }
        .btn-group { display: flex; gap: 4px; }
        .btn-fix {
            background: var(--sc-card);
            border: 1px solid var(--sc-line);
            color: var(--sc-text);
            border-radius: 4px;
            padding: 2px 6px;
            font-size: 0.7em;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .btn-fix:hover { background: var(--sc-elev); }
        .btn-fix-text {
            background: none; border: none; color: var(--sc-accent); cursor: pointer; font-size: 0.7em; padding: 0;
            display: flex; align-items: center; gap: 4px;
            margin-left: auto;
        }
        .btn-fix-text:hover { text-decoration: underline; }

        .city-input-row, .time-input-row {
            display: flex; gap: 4px; margin-top: 4px;
        }
        .city-input-row input, .time-input-row input {
            background: var(--sc-card);
            border: 1px solid var(--sc-line);
            color: var(--sc-text);
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 0.8em;
            flex: 1;
        }
        .time-input-row input { color-scheme: dark; }

        .validation-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
        .status-pill {
           background: var(--sc-shell);
           padding: 2px 6px;
           border-radius: 4px;
           font-size: 0.7em;
           font-weight: bold;
           border: 1px solid var(--sc-line);
        }
        .status-msg { font-size: 0.8em; opacity: 0.8; }
        
        .validation-section {
           grid-column: span 2;
           margin-top: 8px;
           border-top: 1px solid var(--sc-line-subtle);
           padding-top: 8px;
        }
        /* Scoped to the DIRECT child header only: this unlayered rule would
           otherwise beat Tailwind utilities inside nested cards (e.g. the
           DeepConfirmCard caption) regardless of specificity. */
        .validation-section > h4 {
           margin: 0 0 8px 0;
           font-size: 0.8em;
           opacity: 0.7;
           text-transform: uppercase;
        }
        .trust-grid {
           display: flex;
           gap: 8px;
        }
        
        .trust-badge {
           display: flex;
           align-items: center;
           gap: 6px;
           background: var(--sc-shell);
           border: 1px solid var(--sc-line);
           padding: 4px 8px;
           border-radius: 4px;
           font-size: 0.75em;
           opacity: 0.6;
        }
        /* Status color is earned, never decorative: only a real solve gets
           solve-green. 'unverified' falls through to the dim base style. */
        .trust-badge.verified { border-color: var(--sc-solve); color: var(--sc-solve); opacity: 1; }
        .label-row { display: flex; justify-content: space-between; width: 100%; }

        .hint-container {
            margin-top: 8px;
            background: var(--sc-shell);
            padding: 8px;
            border-radius: 4px;
            border: 1px dashed var(--sc-line);
        }
        .clickable { cursor: pointer; user-select: none; }
        .spectroscopy-icon { font-size: 14px; }
        .preview-row { font-size: 0.8em; opacity: 0.7; margin-top: 4px; }
        .spectroscopy-details { margin-top: 8px; border-top: 1px solid var(--sc-line-subtle); padding-top: 8px; }
        .swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--sc-line-strong); }

        .batch-actions {
            grid-column: span 2;
            margin-top: 12px;
            background: var(--sc-accent-glow);
            border: 1px solid var(--sc-accent-ring);
            border-radius: 6px;
            padding: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .pending-summary { display: flex; align-items: center; gap: 8px; font-size: 0.85em; }
        .tag { background: var(--sc-accent-glow); padding: 2px 6px; border-radius: 3px; color: var(--sc-accent); font-weight: 500; }
        .action-buttons { display: flex; gap: 8px; }
        .btn-apply {
            background: var(--sc-btn-fill); color: var(--sc-btn-fill-text); border: 1px solid var(--sc-btn-border); padding: 6px 12px; border-radius: 4px;
            font-weight: 600; cursor: pointer; font-size: 0.9em;
        }
        .btn-apply:hover { filter: brightness(1.15); }
        .btn-discard {
            background: transparent; color: var(--sc-text-2); border: 1px solid var(--sc-line); padding: 6px 12px; border-radius: 4px;
            cursor: pointer; font-size: 0.9em;
        }
        .btn-discard:hover { background: var(--sc-card); }

        .highlight-change { color: var(--sc-accent); font-weight: bold; }
        .change-indicator { font-size: 0.7em; color: var(--sc-accent); font-style: italic; display: block; margin-top: 2px; }
        .pending-hint { margin-top: 4px; font-size: 0.85em; color: var(--sc-accent); background: var(--sc-accent-glow); padding: 4px; border-radius: 4px; }
      `}</style>
    </div>
  );
}

function TrustBadge({ label, icon, status, tooltip }: any) {
   return (
      <div className={`trust-badge ${status}`} title={tooltip}>
         {icon}
         <span>{label}</span>
      </div>
   );
}
