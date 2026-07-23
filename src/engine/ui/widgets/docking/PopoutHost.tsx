/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POPOUT HOST — the popped-out window's React root (#/popout, Phase C)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DASHBOARD_DOCKING_SPEC §5. Reached ONLY via `#/popout?panel=<widgetId>&window=
 * <label>` inside a Tauri `WebviewWindow` the MAIN window created. Mounts EXACTLY
 * ONE registry widget through the SAME `WidgetFrame` the dock uses (honest-or-
 * absent — WidgetShelf is the existence proof for single-widget receipt render).
 *
 * SUBSCRIBER ONLY (SPEC §5): it never produces shared state. It emits READY once
 * its listener is armed, then renders whatever the main window bridges over
 * `POPOUT_EVENT.RECEIPT`. Its only outbound signals are lifecycle: BOUNDS (as it
 * moves/resizes, so main can persist position) and CLOSED (on unload, so main
 * returns the panel — belt-and-suspenders with main's `tauri://destroyed`).
 *
 * Replay: if the bridge carries a `replayFrame`, we re-provide it through
 * `ReplayProvider` so a popped-out replay-aware widget lights up exactly as in a
 * dashboard; absent ⇒ it degrades honestly to null (same as the plain dock).
 *
 * Bounds are read from the DOM (`window.screenX/outerWidth`, logical px) — which
 * matches the units of the WebviewWindow constructor main uses to restore them,
 * and needs no window-size Tauri permission.
 *
 * Ledger: RENDER PLANE — display only.
 */

import React, { useEffect, useState } from 'react';
import { WIDGETS } from '../registry';
import { DockingSurface } from './DockingSurface';
import { popoutLayoutStorageKey } from './docking_store';
import { ReplayProvider } from '../../dashboard/replay/ReplayContext';
import type { ReplayContextValue } from '../../dashboard/replay/ReplayContext';
import type { ReplayFrame } from '../../dashboard/replay/replay_state';
import type { WidgetReceipt, WidgetEvents } from '../registry';
import { isTauriRuntime } from '../../dashboard/solve_queue/connectors';
import {
    POPOUT_EVENT,
    MAIN_WINDOW_LABEL,
    parsePopoutParams,
    parseBridgePayload,
    isValidBounds,
    type BridgePayload,
    type PopoutBounds,
} from './popout_bridge';

const byId = new Map(WIDGETS.map(w => [w.id, w]));

/** StrictMode double-mount guard — the READY handshake must fire once. */
let ARMED = false;

/** Read this window's bounds from the DOM (logical px). null if unavailable. */
function readDomBounds(): PopoutBounds | null {
    try {
        const b = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
        return isValidBounds(b) ? b : null;
    } catch {
        return null;
    }
}

export const PopoutHost: React.FC = () => {
    const { widgetId, windowLabel } = parsePopoutParams(window.location.hash);
    const manifest = widgetId ? byId.get(widgetId) : undefined;

    const [receipt, setReceipt] = useState<WidgetReceipt>(null);
    const [events, setEvents] = useState<WidgetEvents | undefined>(undefined);
    const [frame, setFrame] = useState<ReplayFrame | null>(null);

    useEffect(() => {
        if (!isTauriRuntime()) return;        // browser: no bridge (desktop-only)
        if (ARMED) return;
        ARMED = true;

        let bounceTimer: ReturnType<typeof setTimeout> | null = null;
        const unlisteners: Array<() => void> = [];

        (async () => {
            try {
                const { listen, emitTo } = await import('@tauri-apps/api/event');
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');

                // Subscribe to the bridged state.
                unlisteners.push(await listen<BridgePayload>(POPOUT_EVENT.RECEIPT, (e) => {
                    const s = parseBridgePayload(e.payload);
                    setReceipt((s.receipt ?? null) as WidgetReceipt);
                    setEvents((s.events ?? undefined) as WidgetEvents | undefined);
                    setFrame((s.replayFrame ?? null) as ReplayFrame | null);
                }));

                // Live bounds tracking → main persists position (best-effort).
                const emitBounds = () => {
                    const b = readDomBounds();
                    if (b) void emitTo(MAIN_WINDOW_LABEL, POPOUT_EVENT.BOUNDS, { widgetId, bounds: b }).catch(() => {});
                };
                const debounced = () => { if (bounceTimer) clearTimeout(bounceTimer); bounceTimer = setTimeout(emitBounds, 400); };
                try {
                    const cur = getCurrentWebviewWindow();
                    unlisteners.push(await cur.onMoved(() => debounced()));
                    unlisteners.push(await cur.onResized(() => debounced()));
                } catch { /* window events unavailable — bounds fall back to CLOSED */ }

                // Listener armed → ask main for the current state.
                await emitTo(MAIN_WINDOW_LABEL, POPOUT_EVENT.READY, { window: windowLabel, panel: widgetId });
            } catch { /* event/webview API unavailable — render honest empty */ }
        })();

        // On unload → return the panel + persist final bounds (secondary to
        // main's tauri://destroyed; async delivery is best-effort).
        const onUnload = () => {
            const bounds = readDomBounds();
            import('@tauri-apps/api/event')
                .then(({ emitTo }) => emitTo(MAIN_WINDOW_LABEL, POPOUT_EVENT.CLOSED, { label: windowLabel, widgetId, bounds }))
                .catch(() => {});
        };
        window.addEventListener('beforeunload', onUnload);

        return () => {
            window.removeEventListener('beforeunload', onUnload);
            if (bounceTimer) clearTimeout(bounceTimer);
            unlisteners.forEach(u => { try { u(); } catch { /* ignore */ } });
        };
    }, [widgetId, windowLabel]);

    // A popout is a FULL recursive docking workspace (SPEC §5b): its own dockview
    // tree + its own ribbon, seeded with the widget it was torn from and free to
    // grow (drag more chips from the ribbon into splits/tabs). It is a SUBSCRIBER
    // (popoutEnabled=false) — the bridged {receipt,events} feed every docked widget
    // identically through DockingDataContext; the surface never spawns further OS
    // windows. Its layout persists per-window, keyed by the seed widget. An unknown
    // widget id seeds nothing → the surface shows its honest "drag a widget" CTA.
    const surface = (
        <DockingSurface
            receipt={receipt}
            events={events}
            layoutStorageKey={popoutLayoutStorageKey(widgetId)}
            seedPanels={manifest ? [widgetId] : []}
            popoutEnabled={false}
            fillViewport
        />
    );

    // Re-provide the replay frame so popped-out replay-aware widgets stay lit;
    // absent ⇒ ReplayProvider not mounted ⇒ honest degrade to null.
    const content: React.ReactNode = frame
        ? <ReplayProvider value={{ frame, receipt, events } as ReplayContextValue}>{surface}</ReplayProvider>
        : surface;

    return (
        <div
            data-testid="popout-host"
            style={{
                height: '100vh',
                display: 'flex',
                flexDirection: 'column',
                background: 'radial-gradient(circle at 50% 0%, #12141c 0%, #05060a 60%)',
                color: '#e8ecf4',
                fontFamily: "'Inter', system-ui, sans-serif",
            }}
        >
            <div style={{ flex: '0 0 auto', fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase', color: '#5d6880', padding: '8px 12px 6px', fontFamily: 'monospace' }}>
                Popped-out workspace{manifest ? ` — ${manifest.title}` : ''}
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: '0 8px 8px', display: 'flex', flexDirection: 'column' }}>
                {content}
            </div>
        </div>
    );
};

export default PopoutHost;
