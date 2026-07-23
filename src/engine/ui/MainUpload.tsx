import React, { useState, useCallback } from 'react';
import { Upload, Search } from 'lucide-react';
import { TargetHintInput } from './TargetHintInput';
import {
  acceptAttribute,
  isSupportedFilename,
  supportedFormatsLabel,
} from '../pipeline/m1_ingestion/format_registry';
import { resolveSampleFrame } from '../../config/sampleFrameSource';
import './styles/Symbols.css';

// Single source of truth: the ingestion format registry. Adding Sony ARW
// (or any format) is one registry entry — this UI needs ZERO edits.
const ACCEPT_ATTR = acceptAttribute();
const SUPPORTED_LABEL = supportedFormatsLabel();

interface MainUploadProps {
  onFileSelect: (file: File, hint?: { ra: number; dec: number; label: string }) => void;
}

export function MainUpload({ onFileSelect }: MainUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  // Inline, dismissible notice — replaces blocking alert() popups on the
  // landing surface (drop errors, geocode misses, sample-load failure).
  const [uiError, setUiError] = useState<string | null>(null);

  const [targetHint, setTargetHint] = useState<{ ra: number; dec: number; label: string } | undefined>(undefined);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (isSupportedFilename(file.name)) {
         setUiError(null);
         onFileSelect(file, targetHint);
      } else {
         setUiError(`"${file.name}" is not a supported file type. Supported formats: ${SUPPORTED_LABEL}.`);
      }
    }
  }, [onFileSelect, targetHint]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
        onFileSelect(e.target.files[0], targetHint); 
    }
  }, [onFileSelect, targetHint]);
  
  const handleHintSubmit = useCallback((ra: number, dec: number, label: string) => {
      if (ra === -1) {
         setTargetHint({ 
             ra: -1, 
             dec: dec, 
             label 
         });
      } else {
         setTargetHint({ ra, dec, label });
      }
  }, []);

  const handleLoadSample = useCallback(async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      setIsLoadingSample(true);
      // Config seam: default (VITE_SAMPLE_FRAME_URL unset) = the bundled SeeStar
      // M66 FITS + M66 hint, byte-identical to the previous literal. A configured
      // remote URL is fetched instead and solved blind (unknown frame identity).
      const source = resolveSampleFrame();
      try {
          const response = await fetch(source.url);
          if (!response.ok) throw new Error('Failed to fetch sample file');

          const blob = await response.blob();
          const file = new File([blob], source.name, source.mime ? { type: source.mime } : undefined);

          onFileSelect(file, source.hint);
      } catch (err) {
          console.error(`Error loading sample (${source.url}):`, err);
          setUiError('Could not load the sample frame. You can still drop your own file to solve.');
      } finally {
          setIsLoadingSample(false);
      }
  }, [onFileSelect]);

  return (
    <div 
      className={`astro-upload-zone ${isDragging ? 'dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input 
        type="file" 
        id="astro-file-input" 
        style={{ display: 'none' }} 
        onChange={handleFileSelect}
        accept={ACCEPT_ATTR}
      />
      
        <label htmlFor="astro-file-input" className="upload-label">
          <Upload size={34} className="upload-icon" />
          <div className="upload-text">
            <strong>Drop a File to Solve</strong>
            <span>or click to browse</span>

            <div className="upload-box">
              <input
                type="file"
                accept={ACCEPT_ATTR}
                onChange={handleFileSelect}
                id="file-upload"
                hidden
              />
            </div>

            {/* Optional search-hint affordance — a subtle secondary action below
                the primary drop copy (it used to float directly under the title). */}
            <TargetHintInput onHintSubmit={handleHintSubmit} />

            {targetHint && (
                <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--sc-accent-hi)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Search size={12} />
                    <span>Target Hint Active: <strong>{targetHint.label}</strong></span>
                    <button
                        onClick={(e) => { e.preventDefault(); setTargetHint(undefined); }}
                        className="hint-clear-btn"
                        title="Remove the target hint"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', marginLeft: 4 }}
                    >
                        (Clear)
                    </button>
                </div>
            )}
          </div>
          <div className="upload-hint">Supported: {SUPPORTED_LABEL}</div>

          {uiError && (
            <div
              className="upload-error"
              role="alert"
              data-testid="upload-error"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <span>{uiError}</span>
              <button
                aria-label="Dismiss"
                title="Dismiss"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setUiError(null); }}
              >
                &times;
              </button>
            </div>
          )}

          {/* Booth-obvious one-click "Watch a live solve": runs the bundled
              SeeStar M66 frame through the REAL wizard pipeline (the wizard step
              animation is the live view). Honest — a real deterministic solve
              with real receipt numbers, zero canned data (LAW 3). */}
          <div className="sample-button-container" style={{ marginTop: 12 }} data-testid="demo-solve-affordance">
             <button
                onClick={handleLoadSample}
                disabled={isLoadingSample}
                className="btn-load-sample btn-watch-live"
                data-testid="watch-live-solve"
             >
                {isLoadingSample ? (
                  <><span className="icon-rocket"></span> Starting live solve…</>
                ) : (
                  <>&#9654; Watch a Live Solve</>
                )}
             </button>
             <div style={{ fontSize: '0.72em', marginTop: 6, opacity: 0.7, maxWidth: 340, lineHeight: 1.4 }}>
                Runs the bundled SeeStar M66 frame through the real pipeline — a live plate solve with real receipt numbers, zero canned data.
             </div>
          </div>
        </label>

       <style>{`
         .astro-upload-zone {
            border: 2px dashed var(--sc-line-strong);
            border-radius: 12px;
            padding: 22px 24px;
            text-align: center;
            transition: all 0.2s;
            background: var(--sc-panel);
            color: var(--sc-text-2);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            cursor: pointer;
         }
         .astro-upload-zone:hover, .astro-upload-zone.dragging {
            border-color: var(--sc-accent-ring);
            background: var(--sc-accent-glow);
            color: var(--sc-text);
         }
          .upload-icon { margin-bottom: 8px; opacity: 0.7; }
          .hint-clear-btn { color: var(--sc-text-2); }
          .hint-clear-btn:hover { color: var(--sc-text); text-decoration: underline; }
          .upload-error {
              display: flex;
              align-items: center;
              gap: 10px;
              margin-top: 14px;
              padding: 8px 12px;
              max-width: 420px;
              border: 1px solid var(--sc-danger);
              background: var(--sc-danger-dim);
              border-radius: 6px;
              color: var(--sc-danger);
              font-size: 0.8em;
              text-align: left;
              cursor: default;
          }
          .upload-error button {
              background: none;
              border: none;
              color: var(--sc-danger);
              font-size: 1.1em;
              cursor: pointer;
              padding: 0 4px;
              line-height: 1;
              flex-shrink: 0;
          }
          .upload-error button:hover { color: var(--sc-text); }
          .upload-text strong { display: block; font-size: 1.15em; margin-bottom: 2px; }
          .upload-hint { font-size: 0.8em; opacity: 0.5; margin-top: 8px; }

          .btn-load-sample {
              background: var(--sc-btn-fill);
              border: 1px solid var(--sc-btn-border);
              color: var(--sc-btn-fill-text);
              padding: 10px 20px;
              border-radius: 8px;
              font-weight: bold;
              cursor: pointer;
              transition: all 0.2s;
              box-shadow: 0 4px 15px var(--sc-accent-glow);
              letter-spacing: 0.5px;
              text-transform: uppercase;
              font-size: 0.75em;
              display: flex;
              align-items: center;
              gap: 8px;
          }
          .btn-load-sample:hover:not(:disabled) {
              transform: translateY(-2px);
              box-shadow: 0 6px 20px var(--sc-accent-glow);
              filter: brightness(1.15);
          }
          .btn-watch-live {
              font-size: 0.9em;
              padding: 11px 24px;
              gap: 10px;
          }
          .btn-load-sample:disabled {
              opacity: 0.5;
              cursor: not-allowed;
          }
        `}</style>
    </div>
  );
}
