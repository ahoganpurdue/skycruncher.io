import React, { useState, useEffect, useCallback } from 'react';
import {
    resolveStoragePaths,
    writeStorageConfig,
    isTauriRuntime,
    subRootDefaults,
    type StorageRoots,
    type ResolvedStoragePaths,
} from '../../config/storagePaths';
import { StarDataSection } from './StarDataSection';

/**
 * STORAGE SETTINGS — map where SkyCruncher keeps its data on THIS machine.
 *
 * Minimal desktop panel over the per-machine storage config
 * (%LOCALAPPDATA%\io.skycruncher.app\storage.json — resolver in
 * src/config/storagePaths.ts). Shows the roots, remaps them with the native
 * Tauri folder picker, and writes storage.json. Function over polish (owner:
 * "map capture/storage locations"); the greenfield solver + tools read the same
 * file. Portability groundwork for the laptop dress rehearsal.
 */

interface RootRow {
    key: keyof StorageRoots;
    label: string;
    note: string;
}

const ROWS: RootRow[] = [
    { key: 'data_root', label: 'Data root', note: 'Base folder; the others default under it.' },
    { key: 'index_root', label: 'Quad index', note: 'g15u star index the solver reads (≈1 GB).' },
    { key: 'atlas_root', label: 'Star atlas', note: 'Legacy catalog for headless tools.' },
    { key: 'intake_root', label: 'Intake', note: 'Raw frame deliveries (live capture watcher).' },
    { key: 'capture_root', label: 'Capture', note: 'Live capture session output.' },
    { key: 'export_root', label: 'Exports', note: 'Default save/export location.' },
];

async function pickDirectory(title: string): Promise<string | null> {
    try {
        const dialog = await import('@tauri-apps/plugin-dialog');
        const picked = await dialog.open({ directory: true, multiple: false, title });
        return typeof picked === 'string' ? picked : null;
    } catch {
        return null;
    }
}

export function StorageSettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
    const tauri = isTauriRuntime();
    const [resolved, setResolved] = useState<ResolvedStoragePaths | null>(null);
    const [roots, setRoots] = useState<StorageRoots | null>(null);
    const [status, setStatus] = useState<string>(tauri ? 'Loading…' : '');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!tauri) return;
        let live = true;
        resolveStoragePaths()
            .then((r) => {
                if (!live) return;
                setResolved(r);
                setRoots({
                    data_root: r.data_root,
                    intake_root: r.intake_root,
                    capture_root: r.capture_root,
                    index_root: r.index_root,
                    atlas_root: r.atlas_root,
                    export_root: r.export_root,
                });
                setStatus(`Loaded (source: ${r.source})`);
            })
            .catch((e) => live && setStatus(`Could not read config: ${String(e)}`));
        return () => {
            live = false;
        };
    }, [tauri]);

    const change = useCallback(
        async (key: keyof StorageRoots, label: string) => {
            const dir = await pickDirectory(`Choose ${label} folder`);
            if (!dir) return;
            setRoots((prev) => (prev ? { ...prev, [key]: dir } : prev));
            setStatus('Unsaved changes');
        },
        [],
    );

    const resetDefaults = useCallback(() => {
        setRoots((prev) => {
            if (!prev) return prev;
            return { data_root: prev.data_root, ...subRootDefaults(prev.data_root) };
        });
        setStatus('Reset sub-folders under the data root (unsaved)');
    }, []);

    const save = useCallback(async () => {
        if (!roots) return;
        setSaving(true);
        setStatus('Saving…');
        try {
            const path = await writeStorageConfig(roots);
            setStatus(`Saved to ${path}. New solves + sessions use these locations; restart the app if a live capture is running.`);
        } catch (e) {
            setStatus(`Save failed: ${String(e)}`);
        } finally {
            setSaving(false);
        }
    }, [roots]);

    const overlay: React.CSSProperties = {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
    };
    const panel: React.CSSProperties = {
        background: 'var(--sc-surface, #12161c)',
        color: 'var(--sc-text, #e6edf3)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: '20px 22px',
        width: 'min(680px, 92vw)',
        maxHeight: '88vh',
        overflowY: 'auto',
        fontSize: 13,
        boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
    };
    const rowStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '140px 1fr auto',
        gap: 10,
        alignItems: 'center',
        padding: '8px 0',
        borderTop: '1px solid rgba(255,255,255,0.06)',
    };
    const pathBox: React.CSSProperties = {
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        opacity: 0.9,
        wordBreak: 'break-all',
    };

    return (
        <div style={overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings — storage and star data">
            <div style={panel} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h2 style={{ margin: 0, fontSize: 16 }}>Settings — Storage &amp; Star Data</h2>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 20, cursor: 'pointer' }} aria-label="Close">×</button>
                </div>
                <p style={{ opacity: 0.75, marginTop: 6 }}>
                    Where SkyCruncher keeps its data on this machine. Saved to a per-machine config
                    the solver and tools both read.
                </p>

                {!tauri && (
                    <p style={{ color: 'var(--sc-warn, #e0b050)' }}>
                        Storage mapping is available in the desktop app only (native folder picker + config file).
                    </p>
                )}

                {tauri && roots && (
                    <>
                        {resolved && (
                            <p style={pathBox}>config file: {resolved.config_path}</p>
                        )}
                        {ROWS.map((r) => (
                            <div key={r.key} style={rowStyle}>
                                <div>
                                    <div style={{ fontWeight: 600 }}>{r.label}</div>
                                    <div style={{ opacity: 0.6, fontSize: 11 }}>{r.note}</div>
                                </div>
                                <div style={pathBox}>{roots[r.key]}</div>
                                <button
                                    onClick={() => change(r.key, r.label)}
                                    disabled={saving}
                                    style={{ padding: '4px 10px', cursor: 'pointer' }}
                                >
                                    Change…
                                </button>
                            </div>
                        ))}
                        <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
                            <button onClick={resetDefaults} disabled={saving} style={{ padding: '6px 12px', cursor: 'pointer' }}>
                                Reset sub-folders
                            </button>
                            <button
                                onClick={save}
                                disabled={saving}
                                style={{ padding: '6px 16px', cursor: 'pointer', fontWeight: 600 }}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </>
                )}

                <StarDataSection tauri={tauri} kind="index" folderRoot={roots?.index_root ?? null} />
                <StarDataSection tauri={tauri} kind="atlas" folderRoot={roots?.atlas_root ?? null} />

                {status && <p style={{ opacity: 0.85, marginTop: 12, fontSize: 12 }}>{status}</p>}
            </div>
        </div>
    );
}
