import React from 'react';
import { 
  Database, 
  Cpu, 
  Search, 
  Compass, 
  Sun, 
  Package, 
  Activity,
  ShieldCheck,
  FlaskConical,
  ArrowRight
} from 'lucide-react';
import { PipelineManifest } from '../../types/manifest';
import { PipelineStageResult } from '../../types/schema';

interface StageNode {
  id: string;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const FLOW_STAGES: StageNode[] = [
  { id: 'gate', label: 'Gate', icon: <ShieldCheck size={14} />, description: 'Integrity' },
  { id: 'ingest', label: 'Ingest', icon: <Database size={14} />, description: 'EXIF/RAW' },
  { id: 'demosaic', label: 'Demosaic', icon: <Cpu size={14} />, description: 'WebGPU' },
  { id: 'extraction', label: 'Signal', icon: <Activity size={14} />, description: 'Star Detect' },
  { id: 'plate_solve', label: 'Solver', icon: <Compass size={14} />, description: 'Astrametry' },
  { id: 'photometry', label: 'Science', icon: <Sun size={14} />, description: 'Calibration' },
  { id: 'serialize', label: 'Export', icon: <Package size={14} />, description: 'Manifest' },
];

interface ManifestNode {
  key: keyof PipelineManifest;
  label: string;
  description: string;
  successValue: string | string[];
}

const MANIFEST_POINTS: ManifestNode[] = [
  { key: 'memoryState', label: 'MEM', description: 'Residency', successValue: ['ARROW_SHARED_BUFFER', 'WEBGPU_VRAM'] },
  { key: 'dataSource', label: 'SRC', description: 'Bit Depth', successValue: ['RAW', 'FITS', 'TIFF'] },
  { key: 'normalizationState', label: 'NRM', description: 'Normalization', successValue: 'NORMALIZED' },
  { key: 'coordinateSystem', label: 'GEO', description: 'Domain', successValue: ['WCS', 'RA_DEC'] },
  { key: 'starRepresentation', label: 'KRN', description: 'PSF Model', successValue: 'PSF' },
  { key: 'hardwareProfile', label: 'SNR', description: 'QE Map', successValue: ['EXIF_INFERRED', 'FULLY_CALIBRATED'] },
  { key: 'temporalState', label: 'TMP', description: 'J2000 Clock', successValue: 'JD_VALIDATED' },
  { key: 'segmentation', label: 'MSK', description: 'Sky Isolation', successValue: 'SKY_ISOLATED' },
  { key: 'terrestrialLoc', label: 'LOC', description: 'GPS Lock', successValue: 'VALIDATED' },
  { key: 'planetaryDetection', label: 'PLN', description: 'Solar Sys', successValue: 'CONFIRMED' },
  { key: 'astronomicalLoc', label: 'AST', description: 'Plate Solver', successValue: 'FINALIZED' },
  { key: 'photometricSolution', label: 'PHO', description: 'Photometry', successValue: 'ZERO_POINT_VALIDATED' },
  { key: 'starCount', label: 'DEN', description: 'Point Sources', successValue: ['SECOND_PASS', 'DEEP_SKY_PASS'] },
  { key: 'verification', label: 'INT', description: 'Trust Score', successValue: 'BV_CONFIRMED' },
  { key: 'signalState', label: 'SIG', description: 'Sky BG', successValue: 'BACKGROUND_NEUTRALIZED' },
  { key: 'locationCorrection', label: 'FLT', description: 'Vignette', successValue: ['INITIAL_FLATTENING', 'TPS'] },
  { key: 'shapeCorrection', label: 'OPT', description: 'Coma Correct', successValue: 'POINTIFIED' },
  { key: 'colorCorrection', label: 'PLK', description: 'B-V Calib', successValue: 'PLANCKIAN_VERIFIED' },
  { key: 'distortionCorrection', label: 'MAN', description: 'Warp Field', successValue: 'ENTIRE_CAPTURE' },
  { key: 'resamplingKernel', label: 'RSM', description: 'Resampling', successValue: ['LANCZOS_3_HIGH_FIDELITY', 'FLUX_PRESERVING'] },
];

interface DataFlowDiagramProps {
  manifest?: PipelineManifest;
  stages?: PipelineStageResult<any>[];
  activeStage?: string;
}

export const DataFlowDiagram: React.FC<DataFlowDiagramProps> = ({ manifest, stages = [], activeStage }) => {
  const getStageStatus = (id: string) => {
    const stage = stages.find(s => s.stage === id);
    if (stage) return stage.status === 'OK' ? 'SUCCESS' : 'FAILED';
    if (activeStage === id) return 'RUNNING';
    return 'PENDING';
  };

  const getManifestStatus = (node: ManifestNode) => {
    if (!manifest) return 'PENDING';
    const value = manifest[node.key] as string;
    const isSuccess = Array.isArray(node.successValue) 
      ? node.successValue.includes(value) 
      : value === node.successValue;

    if (isSuccess) return 'SUCCESS';
    if (value !== 'UNDETECTED' && value !== 'UNCORRECTED' && value !== 'BLIND' && value !== 'UNSEGMENTED' && value !== 'JS_HEAP') {
        return 'RUNNING';
    }
    return 'PENDING';
  };

  const getStatusStyle = (status: string, small = false) => {
    switch (status) {
      case 'RUNNING':
        return {
          borderColor: 'var(--sc-warn)',
          backgroundColor: 'var(--sc-warn-dim)',
          color: 'var(--sc-warn)',
          boxShadow: !small ? '0 0 15px var(--sc-warn-dim)' : 'none',
          animation: 'pulse 2s infinite'
        };
      case 'SUCCESS':
        return {
          borderColor: 'var(--sc-solve)',
          backgroundColor: 'var(--sc-solve-dim)',
          color: 'var(--sc-solve)',
          boxShadow: '0 0 10px var(--sc-solve-dim)'
        };
      case 'FAILED':
        return {
          borderColor: 'var(--sc-danger)',
          backgroundColor: 'var(--sc-danger-dim)',
          color: 'var(--sc-danger)',
          boxShadow: '0 0 15px var(--sc-danger-dim)'
        };
      default:
        return {
          borderColor: 'var(--sc-line-subtle)',
          backgroundColor: 'var(--sc-card)',
          color: 'var(--sc-pending)',
          filter: 'grayscale(1)',
          opacity: 0.4
        };
    }
  };

  return (
    <div className="df-container">
      <style>{`
        .df-container {
          width: 100%;
          padding: 24px;
          background: var(--sc-panel);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border: 1px solid var(--sc-line);
          border-radius: 16px;
          display: flex;
          flex-direction: column;
          gap: 32px;
          position: relative;
          color: var(--sc-text);
          font-family: inherit;
        }
        .df-layer-header {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 3px;
          color: var(--sc-muted);
          text-transform: uppercase;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 8px;
        }
        .df-flow-list {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 0 8px 8px 8px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .df-flow-list::-webkit-scrollbar { display: none; }
        .df-node {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 12px;
          border-radius: 12px;
          border: 1px solid transparent;
          min-width: 100px;
          transition: all 0.5s ease;
          text-align: center;
        }
        .df-node-label { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-top: 8px; }
        .df-node-desc { font-size: 8px; opacity: 0.5; text-transform: uppercase; margin-top: 2px; }
        
        .df-manifest-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
          gap: 8px;
          padding: 0 8px;
        }
        .df-manifest-node {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 6px;
          border-radius: 8px;
          border: 1px solid transparent;
          text-align: center;
          transition: all 0.3s ease;
        }
        .df-manifest-label { font-size: 9px; font-weight: 700; }
        .df-manifest-val { font-size: 6px; opacity: 0.4; text-transform: uppercase; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .df-status-dot { width: 4px; height: 4px; border-radius: 50%; margin-top: 4px; }
        
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }
      `}</style>
      
      {/* LAYER 1: PIPELINE FLOW LOGIC */}
      <div>
        <div className="df-layer-header">
            <Activity size={12} style={{ color: 'var(--sc-accent)' }} /> Pipeline Execution Flow
        </div>
        
        <div className="df-flow-list">
          {FLOW_STAGES.map((stage, idx) => {
            const status = getStageStatus(stage.id);
            const isLast = idx === FLOW_STAGES.length - 1;
            return (
              <React.Fragment key={stage.id}>
                <div className="df-node" style={getStatusStyle(status)}>
                  {stage.icon}
                  <div className="df-node-label">{stage.label}</div>
                  <div className="df-node-desc">{stage.description}</div>
                </div>
                {!isLast && <ArrowRight size={14} style={{ color: 'var(--sc-line)', flexShrink: 0 }} />}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* LAYER 2: SCIENTIFIC MANIFEST STATUS */}
      <div style={{ paddingTop: '24px', borderTop: '1px solid var(--sc-line-subtle)' }}>
        <div className="df-layer-header">
            <FlaskConical size={12} style={{ color: 'var(--sc-info)' }} /> Scientific Provenance Manifest (20-Point)
        </div>

        <div className="df-manifest-grid">
          {MANIFEST_POINTS.map((point) => {
            const status = getManifestStatus(point);
            const val = manifest ? (manifest[point.key] as string) : 'UNDETECTED';
            return (
              <div key={point.key} className="df-manifest-node" style={getStatusStyle(status, true)}>
                <div className="df-manifest-label">{point.label}</div>
                <div className="df-manifest-val" title={val}>
                   {val.replace(/_/g, ' ')}
                </div>
                <div className="df-status-dot" style={{ backgroundColor: status === 'SUCCESS' ? 'var(--sc-solve)' : status === 'RUNNING' ? 'var(--sc-warn)' : 'transparent' }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
