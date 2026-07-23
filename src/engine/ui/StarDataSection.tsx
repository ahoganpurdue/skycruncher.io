import React, { useState, useEffect, useCallback, useRef } from 'react';
import { STAR_DATA_BASE_URL, QUAD_INDEX_PREFIX, ATLAS_PREFIX } from '../../config/starDataSource';
import {
    fetchStarDataStatus,
    parseStarDataReport,
    parseProgressEvent,
    summarizeStatus,
    statusFileLabel,
    resultFileLabel,
    formatBytes,
    progressPercent,
    progressCaption,
    summarizeReport,
    reportIsComplete,
    starDataArgs,
    type StarDataStatus,
    type StarDataReport,
    type StarDataProgress,
    type StarDataKind,
    type InvokeFn,
} from './starDataView';

/** Kind-specific copy + release prefix (the only per-kind differences). */
const KIND_META: Record<StarDataKind, { prefix: string; title: string; blurb: string; folderLabel: string }> = {
    index: {
        prefix: QUAD_INDEX_PREFIX,
        title: 'Star data (quad index)',
        blurb:
            'The g15u star index the solver reads. Downloads from the public star-data bucket ' +
            'into the Quad index folder above and verifies every file (sha-256).',
        folderLabel: 'index folder',
    },
    atlas: {
        prefix: ATLAS_PREFIX,
        title: 'Star atlas (~340 MB)',
        blurb:
            'The Gaia-pure deep-catalog sectors the confirm/display lane reads. Downloads from the ' +
            'public star-data bucket into the Atlas folder above and verifies every file (sha-256).',
        folderLabel: 'atlas folder',
    },
};

/**
 * STAR-DATA SECTION — in-app download of the greenfield g15u quad index (the
 * star data the solver reads) into the machine's index_root. Desktop-only; the
 * browser build renders an honest note and never touches the Tauri APIs.
 *
 * Reference CLI: tools/setup/fetch_index.mjs. Engine: the Tauri commands
 * `star_data_status` / `star_data_download` / `star_data_verify` /
 * `star_data_cancel` (src-tauri/src/star_data_fetch.rs). All parsing/formatting/
 * honesty lives in starDataView.ts (pure, unit-tested); this is a thin shell.
 *
 * LAW 3: no fake progress and no optimistic "done" — "done" is earned only when
 * every manifest file is sha-verified (reportIsComplete). Presence-by-size is
 * shown as its own state, never as verified.
 */

type ListenFn = (event: string, handler: (evt: unknown) => void) => Promise<() => void>;

interface Props {
    tauri: boolean;
    /** Which R2 release this section provisions (default 'index'). */
    kind?: StarDataKind;
    /** Destination folder to display (index_root for 'index', atlas_root for 'atlas'). */
    folderRoot: string | null;
    /** Test injection — bypasses the dynamic Tauri imports. */
    invokeFn?: InvokeFn;
    listenFn?: ListenFn;
}

type Busy = 'idle' | 'download' | 'verify';

export function StarDataSection({ tauri, kind = 'index', folderRoot, invokeFn, listenFn }: Props): React.ReactElement {
    const meta = KIND_META[kind];
    const prefix = meta.prefix;
    const [status, setStatus] = useState<StarDataStatus | null>(null);
    const [statusErr, setStatusErr] = useState<string | null>(null);
    const [busy, setBusy] = useState<Busy>('idle');
    const [progress, setProgress] = useState<StarDataProgress | null>(null);
    const [report, setReport] = useState<StarDataReport | null>(null);
    const [message, setMessage] = useState<string>('');
    const aliveRef = useRef(true);

    const getInvoke = useCallback(async (): Promise<InvokeFn> => {
        if (invokeFn) return invokeFn;
        return (await import('@tauri-apps/api/core')).invoke as InvokeFn;
    }, [invokeFn]);

    const getListen = useCallback(async (): Promise<ListenFn> => {
        if (listenFn) return listenFn;
        return (await import('@tauri-apps/api/event')).listen as unknown as ListenFn;
    }, [listenFn]);

    const refreshStatus = useCallback(async () => {
        const out = await fetchStarDataStatus(STAR_DATA_BASE_URL, prefix, invokeFn, kind);
        if (!aliveRef.current) return;
        if (out.kind === 'status') {
            setStatus(out.status);
            setStatusErr(null);
        } else {
            setStatus(null);
            setStatusErr(out.reason);
        }
    }, [invokeFn, kind, prefix]);

    useEffect(() => {
        aliveRef.current = true;
        if (tauri) void refreshStatus();
        return () => {
            aliveRef.current = false;
        };
    }, [tauri, refreshStatus]);

    const runPass = useCallback(
        async (mode: Busy) => {
            setBusy(mode);
            setReport(null);
            setProgress(null);
            setMessage(mode === 'download' ? 'Starting download…' : 'Verifying local files…');
            let unlisten: (() => void) | null = null;
            try {
                const inv = await getInvoke();
                const lis = await getListen();
                unlisten = await lis('star-data-progress', (evt: unknown) => {
                    const p = parseProgressEvent(evt);
                    if (p && aliveRef.current) setProgress(p);
                });
                const cmd = mode === 'download' ? 'star_data_download' : 'star_data_verify';
                const raw = await inv(cmd, starDataArgs(STAR_DATA_BASE_URL, prefix, kind));
                const rep = parseStarDataReport(raw);
                if (!aliveRef.current) return;
                if (rep == null) {
                    setMessage('Unexpected response from the download engine.');
                } else {
                    setReport(rep);
                    setMessage(summarizeReport(rep));
                }
            } catch (e) {
                if (aliveRef.current) setMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                if (unlisten) unlisten();
                if (aliveRef.current) {
                    setBusy('idle');
                    setProgress(null);
                    void refreshStatus();
                }
            }
        },
        [getInvoke, getListen, refreshStatus, prefix, kind],
    );

    const cancel = useCallback(async () => {
        try {
            const inv = await getInvoke();
            await inv('star_data_cancel');
            setMessage('Cancelling at the next safe point…');
        } catch {
            /* best-effort */
        }
    }, [getInvoke]);

    // ── styles (match the modal's dark inline aesthetic) ────────────────────────
    const section: React.CSSProperties = {
        marginTop: 18,
        paddingTop: 14,
        borderTop: '1px solid rgba(255,255,255,0.12)',
    };
    const mono: React.CSSProperties = {
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        opacity: 0.9,
        wordBreak: 'break-all',
    };
    const btn: React.CSSProperties = { padding: '5px 12px', cursor: 'pointer' };

    if (!tauri) {
        return (
            <div style={section} data-testid={`star-data-section-${kind}`}>
                <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{meta.title}</h3>
                <p style={{ color: 'var(--sc-warn, #e0b050)', margin: 0 }}>
                    Star-data download is available in the desktop app only.
                </p>
            </div>
        );
    }

    const totalLabel = status ? formatBytes(status.total_bytes) : null;
    const pct = progress ? progressPercent(progress.overall_done_bytes, progress.overall_total_bytes) : 0;
    const complete = report ? reportIsComplete(report) : false;

    return (
        <div style={section} data-testid={`star-data-section-${kind}`}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{meta.title}</h3>
            <p style={{ opacity: 0.7, margin: '0 0 8px', fontSize: 12 }}>{meta.blurb}</p>

            {folderRoot && <p style={mono}>{meta.folderLabel}: {folderRoot}</p>}

            {statusErr && (
                <p style={{ ...mono, color: 'var(--sc-warn, #e0b050)' }}>
                    Status unavailable: {statusErr}
                </p>
            )}

            {status && (
                <>
                    <p style={{ fontSize: 12, margin: '6px 0' }} data-testid={`star-data-status-summary-${kind}`}>
                        {status.release ? `${status.release} — ` : ''}
                        {summarizeStatus(status)}
                    </p>
                    {status.file_count > 0 && (
                        <div style={{ ...mono, maxHeight: 150, overflowY: 'auto', margin: '4px 0' }}>
                            {status.files.map((f) => (
                                <div key={f.file} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                                    <span>{f.file}</span>
                                    <span style={{ opacity: 0.75 }}>
                                        {formatBytes(f.bytes)} · {statusFileLabel(f.state)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            <div style={{ display: 'flex', gap: 10, margin: '10px 0', flexWrap: 'wrap' }}>
                <button
                    onClick={() => void runPass('download')}
                    disabled={busy !== 'idle' || !status || status.file_count === 0}
                    style={{ ...btn, fontWeight: 600 }}
                    data-testid={`star-data-download-btn-${kind}`}
                >
                    {busy === 'download'
                        ? 'Downloading…'
                        : `Download${totalLabel ? ` (${totalLabel})` : ''}`}
                </button>
                <button
                    onClick={() => void runPass('verify')}
                    disabled={busy !== 'idle' || !status || status.present_count === 0}
                    style={btn}
                    data-testid={`star-data-verify-btn-${kind}`}
                >
                    {busy === 'verify' ? 'Verifying…' : 'Verify'}
                </button>
                {busy !== 'idle' && (
                    <button onClick={() => void cancel()} style={btn} data-testid={`star-data-cancel-btn-${kind}`}>
                        Cancel
                    </button>
                )}
            </div>

            {busy !== 'idle' && progress && (
                <div style={{ margin: '6px 0' }} data-testid={`star-data-progress-${kind}`}>
                    <div
                        style={{
                            height: 8,
                            background: 'rgba(255,255,255,0.1)',
                            borderRadius: 4,
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            style={{
                                height: '100%',
                                width: `${pct}%`,
                                background: 'var(--sc-accent, #4a90d9)',
                                transition: 'width 120ms linear',
                            }}
                        />
                    </div>
                    <p style={{ fontSize: 11, opacity: 0.8, margin: '4px 0 0' }}>
                        {progressCaption(progress)} ({pct}%)
                    </p>
                </div>
            )}

            {report && (
                <div style={{ margin: '6px 0' }} data-testid={`star-data-report-${kind}`}>
                    <p
                        style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: complete
                                ? 'var(--sc-ok, #5fce7f)'
                                : report.cancelled
                                  ? 'var(--sc-warn, #e0b050)'
                                  : 'inherit',
                            margin: '0 0 4px',
                        }}
                    >
                        {summarizeReport(report)}
                    </p>
                    <div style={{ ...mono, maxHeight: 150, overflowY: 'auto' }}>
                        {report.files
                            .filter((f) => f.state !== 'verified')
                            .map((f) => (
                                <div key={f.file} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                                    <span>{f.file}</span>
                                    <span style={{ opacity: 0.8 }}>
                                        {resultFileLabel(f.state)}
                                        {f.reason ? ` — ${f.reason}` : ''}
                                    </span>
                                </div>
                            ))}
                    </div>
                </div>
            )}

            {message && !report && (
                <p style={{ fontSize: 12, opacity: 0.85, margin: '4px 0 0' }}>{message}</p>
            )}
        </div>
    );
}
