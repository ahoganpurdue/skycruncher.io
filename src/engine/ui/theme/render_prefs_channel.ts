/**
 * -----------------------------------------------------------------
 * RENDER-PREFS POP-OUT SYNC CHANNEL (RENDER plane — presentation only, Law 4)
 * -----------------------------------------------------------------
 * Implements the token-spec pop-out protocol
 * (docs/local/design_restyle_2026-07-21/skycruncher-tokens.css):
 *
 *   BroadcastChannel('sc-render-prefs') carries a snapshot of
 *     { theme, brightness:{light,dark,night}, density, peek:{saved,duration} }.
 *   The HOST (the main window) broadcasts the snapshot whenever a render pref
 *   changes. A CHILD window posts { type: 'hello' } on load; the host answers
 *   by re-broadcasting the current snapshot. Child windows then apply theme at
 *   documentElement[data-theme] and own a PER-WINDOW dim overlay — a pop-out can
 *   never become the bright white rectangle at the telescope.
 *
 * INVARIANT (Law 4): NO measurement / WCS / receipt state ever crosses this
 * channel. The snapshot is drawn ENTIRELY from theme_state (the render-pref
 * single source); this module carries render presentation prefs and nothing
 * else. The payload shape is closed and typed so a review can see there is no
 * data field to smuggle a measurement through.
 *
 * The MAIN window is wired as host now (createRenderPrefsHost, mounted by
 * MainApp). Child-window CONSUMPTION ships with the docking program's popouts;
 * measured 2026-07-21 that BroadcastChannel is available across Tauri webview
 * windows. Everything here is defensive: absent BroadcastChannel (old webview /
 * SSR / headless) → createRenderPrefsHost returns null and the app is unchanged.
 */

import {
    type Theme,
    type Density,
    type PeekPrefs,
    getTheme,
    getBrightness,
    getDensity,
    getPeekPrefs,
    subscribeThemeChange,
} from './theme_state';

/** The channel name is fixed by the token spec — host and children must agree. */
export const RENDER_PREFS_CHANNEL = 'sc-render-prefs';

/** The full render-pref snapshot broadcast to child windows. Render plane only. */
export interface RenderPrefsSnapshot {
    theme: Theme;
    /** Per-theme brightness percent (the day themes are always full). */
    brightness: { light: number; dark: number; night: number };
    density: Density;
    peek: PeekPrefs;
}

/**
 * The closed message union on the channel. `snapshot` flows host→child;
 * `hello` flows child→host. There is deliberately no other message type — and
 * no field for measurement/receipt state.
 */
export type RenderPrefsMessage =
    | { type: 'snapshot'; snapshot: RenderPrefsSnapshot }
    | { type: 'hello' };

/**
 * Assemble the current snapshot from theme_state (the render-pref single
 * source). Pure read; never throws (each getter is itself defensive).
 */
export function buildSnapshot(): RenderPrefsSnapshot {
    return {
        theme: getTheme(),
        brightness: {
            light: getBrightness('light'),
            dark: getBrightness('dark'),
            night: getBrightness('night'),
        },
        density: getDensity(),
        peek: getPeekPrefs(),
    };
}

/** Narrow an unknown channel payload to a RenderPrefsMessage (defensive). */
export function isRenderPrefsMessage(v: unknown): v is RenderPrefsMessage {
    if (v == null || typeof v !== 'object') return false;
    const t = (v as { type?: unknown }).type;
    return t === 'snapshot' || t === 'hello';
}

/** The host handle: broadcast on demand, dispose to unwire cleanly. */
export interface RenderPrefsHost {
    /** Post the current snapshot to all child windows. */
    broadcast(): void;
    /** Unsubscribe from render-pref changes and close the channel. */
    dispose(): void;
}

/**
 * Wire the MAIN window as the render-prefs host:
 *   - broadcasts the snapshot whenever any render pref changes
 *     (subscribeThemeChange fires for theme/brightness/density/peek);
 *   - re-broadcasts when a child posts `hello` (the handshake).
 *
 * BroadcastChannel never delivers a message to the instance that sent it, so
 * the host never hears its own snapshots — only children's `hello`s.
 *
 * Returns null (a no-op, app unchanged) when BroadcastChannel is unavailable or
 * construction throws. `channelFactory` is a seam for tests (two endpoints in
 * one process); production omits it and gets a real channel.
 */
export function createRenderPrefsHost(
    channelFactory?: () => BroadcastChannel,
): RenderPrefsHost | null {
    if (typeof BroadcastChannel === 'undefined') return null;

    let channel: BroadcastChannel;
    try {
        channel = channelFactory ? channelFactory() : new BroadcastChannel(RENDER_PREFS_CHANNEL);
    } catch {
        return null;
    }

    const broadcast = (): void => {
        try {
            const msg: RenderPrefsMessage = { type: 'snapshot', snapshot: buildSnapshot() };
            channel.postMessage(msg);
        } catch {
            /* channel closed / serialization refused — never fatal to the app */
        }
    };

    // Child hello → answer with the current snapshot (the handshake).
    channel.onmessage = (e: MessageEvent): void => {
        if (isRenderPrefsMessage(e?.data) && e.data.type === 'hello') broadcast();
    };

    // Any render-pref change → re-broadcast to every child.
    const unsubscribe = subscribeThemeChange(broadcast);

    return {
        broadcast,
        dispose(): void {
            try { unsubscribe(); } catch { /* already gone */ }
            try { channel.onmessage = null; } catch { /* ignore */ }
            try { channel.close(); } catch { /* ignore */ }
        },
    };
}
