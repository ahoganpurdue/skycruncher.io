import React, { useState, useEffect, useRef } from 'react';
import { isTauriRuntime } from '../../config/storagePaths';
import { STAR_DATA_BASE_URL, QUAD_INDEX_PREFIX } from '../../config/starDataSource';
import {
    fetchStarDataStatus,
    shouldShowStarDataBanner,
    formatBytes,
    type StarDataStatus,
    type InvokeFn,
} from './starDataView';

/**
 * STAR-DATA BANNER — first-run landing nudge. When the solver's g15u quad index
 * is not fully present on this machine, show a small dismissible banner pointing
 * into the Settings modal so a fresh install knows solve capability is limited
 * until it downloads the star data.
 *
 * Desktop-only: the status probe is a Tauri command. In the browser build there
 * is no Tauri runtime, so the probe is never attempted and this renders nothing —
 * zero DOM change to the web bundle / e2e landing screen.
 *
 * LAW 3 (honest-or-absent): no fabricated progress and no fake "downloaded"
 * state. The banner reflects a real presence-by-size probe (shouldShowStarDataBanner)
 * and disappears once every manifest file is on disk. Dismiss is per-session.
 */
interface Props {
    /** Open the Settings modal (Storage & Star Data). */
    onOpenSettings: () => void;
    /** Test/override: force the runtime gate (defaults to isTauriRuntime()). */
    tauri?: boolean;
    /** Test injection — bypasses the dynamic Tauri import in fetchStarDataStatus. */
    invokeFn?: InvokeFn;
}

export function StarDataBanner({ onOpenSettings, tauri, invokeFn }: Props): React.ReactElement | null {
    const isTauri = tauri ?? isTauriRuntime();
    const [status, setStatus] = useState<StarDataStatus | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        if (!isTauri) return () => { aliveRef.current = false; };
        void (async () => {
            const out = await fetchStarDataStatus(STAR_DATA_BASE_URL, QUAD_INDEX_PREFIX, invokeFn);
            if (!aliveRef.current) return;
            // Honest: only a successful probe drives the banner. A failed invoke
            // (unknown state) shows nothing rather than a false alarm.
            if (out.kind === 'status') setStatus(out.status);
        })();
        return () => {
            aliveRef.current = false;
        };
    }, [isTauri, invokeFn]);

    if (!isTauri || dismissed || status == null || !shouldShowStarDataBanner(status)) {
        return null;
    }

    const sizeNote =
        status.file_count > 0 ? ` (~${formatBytes(status.total_bytes)})` : '';

    const wrap: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        width: '100%',
        maxWidth: 720,
        margin: '0 auto',
        padding: '10px 16px',
        background: 'var(--sc-card, #1a1f27)',
        border: '1px solid var(--sc-warn, #e0b050)',
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.4,
    };

    return (
        <div style={wrap} role="status" data-testid="star-data-banner">
            <span aria-hidden="true" style={{ fontSize: 16 }}>⭐</span>
            <span style={{ flex: 1 }}>
                <strong>Star data not yet downloaded{sizeNote}</strong> — solve capability
                limited until the quad index is on this machine. Open{' '}
                <em>Settings → Star data</em> to download it.
            </span>
            <button
                onClick={onOpenSettings}
                data-testid="star-data-banner-open"
                style={{
                    padding: '5px 12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: 'var(--sc-btn-fill, #2f6fd0)',
                    color: 'var(--sc-btn-fill-text, #fff)',
                    border: '1px solid var(--sc-btn-border, transparent)',
                    borderRadius: 6,
                    whiteSpace: 'nowrap',
                }}
            >
                Open Settings
            </button>
            <button
                onClick={() => setDismissed(true)}
                aria-label="Dismiss"
                data-testid="star-data-banner-dismiss"
                style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    fontSize: 18,
                    cursor: 'pointer',
                    opacity: 0.7,
                    lineHeight: 1,
                }}
            >
                ×
            </button>
        </div>
    );
}
