/**
 * ExportSelector.tsx — the unified export surface (step-7 + desktop AnalysisPanel).
 *
 * Renders the availability matrix from `save_export.ts` as one menu of formats:
 * an ENABLED button when the run can honestly produce the format, or a DISABLED
 * row + the human reason otherwise (LAW 3). Clicking dispatches through the single
 * `saveExport` sink (runtime-appropriate: Tauri save-dialog on desktop, Blob
 * download in the browser). PNG / C2PA render as declared-coming (disabled).
 *
 * This component owns NO wizard-lifecycle behavior — the receipt row's optional
 * `data-testid` and the `onExported` callback let the host (IntegrationStep) keep
 * the "receipt export closes the wizard" contract the SeeStar e2e depends on.
 */
import React, { useState } from 'react';
import {
    EXPORT_FORMATS,
    exportAvailability,
    saveExport,
    type ExportFormat,
    type ExportImage,
} from './utils/save_export';

interface ExportSelectorProps {
    receipt: any;
    /** Is the science frame in memory? (session.getExportImage() != null) */
    hasImage: boolean;
    /** Lazily fetch the science frame at click time (FITS/ASDF only). */
    getImage?: () => ExportImage | null;
    /** Is a rendered display canvas available? (enables the render-plane PNG row) */
    hasRender?: boolean;
    /** Lazily encode the rendered display canvas at click time (PNG only). */
    getRenderPng?: () => Promise<Uint8Array | null>;
    baseName?: string;
    /** Optional per-format `data-testid` (e.g. { receipt: 'step7-export' }). */
    testIds?: Partial<Record<ExportFormat, string>>;
    /** Fired after a successful export (host may close the wizard on 'receipt'). */
    onExported?: (format: ExportFormat) => void;
    /** Compact desktop variant (AnalysisPanel) vs full step-7 layout. */
    compact?: boolean;
}

export const ExportSelector: React.FC<ExportSelectorProps> = ({
    receipt, hasImage, getImage, hasRender, getRenderPng, baseName, testIds, onExported, compact,
}) => {
    const [busy, setBusy] = useState<ExportFormat | null>(null);
    const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const matrix = exportAvailability(receipt, { hasImage, hasRender });

    const handle = async (format: ExportFormat) => {
        if (busy) return;
        setBusy(format);
        setMessage(null);
        try {
            const renderPng = format === 'png' ? (await getRenderPng?.() ?? null) : null;
            await saveExport(format, { receipt, image: getImage?.() ?? null, renderPng, baseName });
            const meta = EXPORT_FORMATS.find(f => f.id === format);
            setMessage({ kind: 'ok', text: `Exported ${meta?.label ?? format}.` });
            onExported?.(format);
        } catch (err: any) {
            setMessage({ kind: 'err', text: err?.message || `${format} export failed.` });
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className={`export-selector ${compact ? 'compact' : ''}`} data-testid="export-selector">
            {!compact && (
                <div className="export-selector-title">Export</div>
            )}
            <div className="export-rows">
                {EXPORT_FORMATS.map((fmt) => {
                    const row = matrix[fmt.id];
                    const enabled = row.available && !busy;
                    return (
                        <button
                            key={fmt.id}
                            type="button"
                            data-testid={testIds?.[fmt.id]}
                            disabled={!row.available}
                            aria-disabled={!row.available}
                            title={row.reason ?? fmt.blurb}
                            onClick={() => enabled && handle(fmt.id)}
                            className={`export-row ${row.available ? 'is-available' : 'is-disabled'} ${row.coming ? 'is-coming' : ''}`}
                        >
                            <span className="export-row-main">
                                <span className="export-row-label">
                                    {fmt.label}
                                    {row.coming && <span className="export-row-tag">coming</span>}
                                </span>
                                <span className="export-row-blurb">
                                    {row.available ? fmt.blurb : (row.reason ?? fmt.blurb)}
                                </span>
                            </span>
                            <span className="export-row-action">
                                {busy === fmt.id ? '…' : (row.available ? 'Export' : '—')}
                            </span>
                        </button>
                    );
                })}
            </div>

            {message && (
                <div
                    data-testid="export-status"
                    className={`export-status ${message.kind === 'err' ? 'err' : 'ok'}`}
                >
                    {message.text}
                </div>
            )}

            <style>{`
                .export-selector { width: 100%; text-align: left; }
                .export-selector-title {
                    font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.15em;
                    color: var(--sc-muted); margin-bottom: 8px;
                }
                .export-rows { display: flex; flex-direction: column; gap: 6px; }
                .export-row {
                    display: flex; align-items: center; justify-content: space-between;
                    gap: 12px; width: 100%; text-align: left;
                    background: rgba(255,255,255,0.04);
                    border: 1px solid rgba(255,255,255,0.10);
                    border-radius: 6px; padding: 10px 12px; cursor: pointer;
                    transition: background 0.15s, border-color 0.15s;
                }
                .export-row.is-available:hover { background: rgba(85,170,255,0.12); border-color: rgba(85,170,255,0.4); }
                .export-row.is-disabled { cursor: not-allowed; opacity: 0.55; }
                .export-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
                .export-row-label {
                    font-size: 0.85em; font-weight: 600; color: var(--sc-text);
                    display: flex; align-items: center; gap: 8px;
                }
                .export-row-tag {
                    font-size: 0.6em; text-transform: uppercase; letter-spacing: 0.1em;
                    background: rgba(255,255,255,0.1); border-radius: 3px; padding: 1px 5px;
                    color: var(--sc-muted); font-weight: 500;
                }
                .export-row-blurb {
                    font-size: 0.72em; color: var(--sc-muted);
                    overflow: hidden; text-overflow: ellipsis;
                }
                .export-row-action {
                    font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.1em;
                    font-family: monospace; color: var(--sc-accent); flex-shrink: 0;
                }
                .export-row.is-disabled .export-row-action { color: var(--sc-muted); }
                .export-status {
                    margin-top: 8px; font-size: 0.72em; font-family: monospace;
                    padding: 6px 8px; border-radius: 4px;
                }
                .export-status.ok { color: var(--sc-solve); background: rgba(85,221,153,0.08); }
                .export-status.err { color: var(--sc-danger); background: rgba(255,119,119,0.08); }
                .export-selector.compact .export-row { padding: 6px 8px; }
                .export-selector.compact .export-row-blurb { display: none; }
            `}</style>
        </div>
    );
};
