/**
 * ═══════════════════════════════════════════════════════════════════════════
 * usePopoutManager — the MAIN-window popout producer/controller (Phase C)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DASHBOARD_DOCKING_SPEC §5. The main window is the SINGLE producer of shared
 * state and the SOLE owner of window lifecycle. This hook:
 *   • popOut(panelId,widgetId)  — removes the panel from the dock (never live in
 *     two windows) and opens a `WebviewWindow` at `#/popout?panel=…` sized from
 *     persisted bounds; tracks a PopoutRecord for the ghost chip.
 *   • broadcasts {receipt,events,replayFrame} to every popout — on each popout's
 *     `READY` and whenever the state changes (serialised ONCE via popout_bridge).
 *   • returnPanel(label) / on popout CLOSED — re-adds the widget to the dock
 *     (honest return) and drops the record; idempotent (both paths converge).
 *   • persists popout bounds on the popout's `BOUNDS` events.
 *
 * The pure decision logic (labels, URL, serialisation, bounds, records) lives in
 * popout_bridge.ts and is unit-tested; this file is the THIN Tauri glue and is
 * verified in the live 2-monitor walkthrough (it cannot run headless). Every
 * Tauri call is guarded by `isTauriRuntime()` — on the browser tier the hook is
 * inert and `isDesktop` is false, so the UI hides the popout affordance
 * entirely (honest-or-absent, SPEC §5).
 *
 * Ledger: RENDER PLANE — display/window orchestration only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { WebviewWindow as WebviewWindowType } from '@tauri-apps/api/webviewWindow';
import { isTauriRuntime } from '../../dashboard/solve_queue/connectors';
import { WIDGETS } from '../registry';
import {
    POPOUT_EVENT,
    popoutLabel,
    popoutUrl,
    serializeBridgePayload,
    boundsOrDefault,
    tearOffBounds,
    addPopoutRecord,
    removePopoutRecord,
    hasPopoutLabel,
    type PopoutRecord,
    type PopoutBounds,
} from './popout_bridge';
import { loadPopoutBounds, savePopoutBoundsFor } from './popout_store';

const titleById = new Map(WIDGETS.map(w => [w.id, w.title]));

export interface PopoutManagerOptions {
    receipt: unknown;
    events: unknown;
    replayFrame: unknown;
    /** Remove a panel from the dock as it pops out. Returns true if it existed. */
    removePanel: (panelId: string) => boolean;
    /** Re-add a widget panel to the dock when its popout returns/closes. */
    addPanel: (widgetId: string) => void;
    /**
     * Whether this surface OWNS window lifecycle (SPEC §5b). The MAIN surface is
     * the single producer/owner (default true). A POPOUT surface passes false so
     * its manager stays fully inert — it never spawns further OS windows, never
     * registers the READY/CLOSED/BOUNDS listeners (that is the popout HOST's job),
     * and popOut is a no-op (only main owns lifecycle — no nested popout-in-popout).
     */
    enabled?: boolean;
}

export interface PopoutManager {
    /** True only inside the Tauri desktop shell — gates the popout affordance. */
    isDesktop: boolean;
    /** Live popouts (for ghost-chip rendering in the main surface). */
    records: PopoutRecord[];
    /**
     * Pop a dock panel out into its own OS window. No-op in the browser / when
     * disabled. `origin` (logical screen px) opens the window at a tear-off drop
     * point (SPEC §5b); absent ⇒ persisted/default position.
     */
    popOut: (panelId: string, widgetId: string, origin?: { x: number; y: number }) => void;
    /** Return a popped-out widget to the dock and close its window. */
    returnPanel: (label: string) => void;
}

export function usePopoutManager(opts: PopoutManagerOptions): PopoutManager {
    const isDesktop = isTauriRuntime();
    const enabled = opts.enabled !== false;         // default ON (main surface owns lifecycle)
    const [records, setRecords] = useState<PopoutRecord[]>([]);

    // Refs so the (once-registered) event listeners always see fresh state.
    const recordsRef = useRef<PopoutRecord[]>(records);
    recordsRef.current = records;
    // Serialise ONCE per state change (the receipt can be ~1 MB — never twice).
    const payload = useMemo(
        () => serializeBridgePayload(opts.receipt, opts.events, opts.replayFrame),
        [opts.receipt, opts.events, opts.replayFrame],
    );
    const payloadRef = useRef(payload);
    payloadRef.current = payload;
    const optsRef = useRef(opts);
    optsRef.current = opts;

    /** Live WebviewWindow handles by label (so main can close/emit precisely). */
    const windowsRef = useRef<Map<string, WebviewWindowType>>(new Map());

    /** Re-add the widget to the dock and drop its record. Idempotent. */
    const restore = useCallback((label: string) => {
        const rec = recordsRef.current.find(r => r.label === label);
        if (!rec) return;                                   // already restored
        setRecords(prev => removePopoutRecord(prev, label));
        windowsRef.current.delete(label);
        optsRef.current.addPanel(rec.widgetId);             // honest return to the dock
    }, []);

    // ── Register the cross-window listeners ONCE (desktop + enabled only) ────
    useEffect(() => {
        if (!isDesktop || !enabled) return;
        let disposed = false;
        const unlisteners: UnlistenFn[] = [];
        (async () => {
            try {
                const { listen, emitTo } = await import('@tauri-apps/api/event');

                // A popout armed its listener → send it the current state.
                unlisteners.push(await listen<{ window?: string }>(POPOUT_EVENT.READY, async (e) => {
                    const label = e.payload?.window;
                    if (!label) return;
                    try { await emitTo(label, POPOUT_EVENT.RECEIPT, payloadRef.current); } catch { /* window gone */ }
                }));

                // A popout is unloading (beforeunload) → persist its final bounds
                // and return its panel. Secondary to `tauri://destroyed` below
                // (beforeunload async delivery is best-effort); restore is
                // idempotent so a double-signal is harmless.
                unlisteners.push(await listen<{ label?: string; widgetId?: string; bounds?: PopoutBounds }>(POPOUT_EVENT.CLOSED, (e) => {
                    const p = e.payload ?? {};
                    if (p.widgetId && p.bounds) savePopoutBoundsFor(p.widgetId, p.bounds);
                    if (p.label) restore(p.label);
                }));

                // A popout moved/resized → persist its bounds (by widget id).
                unlisteners.push(await listen<{ widgetId?: string; bounds?: PopoutBounds }>(POPOUT_EVENT.BOUNDS, (e) => {
                    const { widgetId, bounds } = e.payload ?? {};
                    if (widgetId && bounds) savePopoutBoundsFor(widgetId, bounds);
                }));
            } catch { /* event API unavailable — hook stays inert */ }
            if (disposed) unlisteners.forEach(u => { try { u(); } catch { /* ignore */ } });
        })();
        return () => { disposed = true; unlisteners.forEach(u => { try { u(); } catch { /* ignore */ } }); };
    }, [isDesktop, enabled, restore]);

    // ── Broadcast state to every open popout when it changes ─────────────────
    useEffect(() => {
        if (!isDesktop || !enabled || records.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const { emitTo } = await import('@tauri-apps/api/event');
                const payload = payloadRef.current;
                for (const rec of recordsRef.current) {
                    if (cancelled) return;
                    try { await emitTo(rec.label, POPOUT_EVENT.RECEIPT, payload); } catch { /* window gone */ }
                }
            } catch { /* event API unavailable */ }
        })();
        return () => { cancelled = true; };
        // Re-broadcast when a popout opens/closes or the serialised state changes.
    }, [isDesktop, enabled, records, payload]);

    // ── popOut ───────────────────────────────────────────────────────────────
    const popOut = useCallback((panelId: string, widgetId: string, origin?: { x: number; y: number }) => {
        if (!isTauriRuntime() || !enabled) return;           // browser tier / popout surface: no popout
        const label = popoutLabel(panelId);
        if (hasPopoutLabel(recordsRef.current, label)) {     // already out → focus it
            const existing = windowsRef.current.get(label);
            if (existing) { void existing.setFocus().catch(() => {}); }
            return;
        }
        // Remove from the dock FIRST so the widget is never live in both windows.
        optsRef.current.removePanel(panelId);
        // Size always from persisted bounds; POSITION from the tear-off drop point
        // when torn off (SPEC §5b), else the persisted/default position.
        const persisted = loadPopoutBounds()[widgetId];
        const bounds = origin ? tearOffBounds(origin, persisted) : boundsOrDefault(persisted);
        const url = popoutUrl(window.location.href, widgetId, label);
        const title = `SkyCruncher — ${titleById.get(widgetId) ?? widgetId}`;
        (async () => {
            try {
                const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                const w = new WebviewWindow(label, {
                    url, title,
                    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                });
                windowsRef.current.set(label, w);
                w.once('tauri://error', () => {
                    // Creation failed — undo the ghost + restore the panel (honest).
                    windowsRef.current.delete(label);
                    restore(label);
                });
                // PRIMARY close detection: the OS window was destroyed (user hit ✕
                // or main called close()). Reliable, unlike the popout's async
                // beforeunload CLOSED. restore() is idempotent across both paths.
                void w.once('tauri://destroyed', () => restore(label));
            } catch {
                restore(label);                              // never leave a ghost with no window
            }
        })();
        setRecords(prev => addPopoutRecord(prev, { panelId, widgetId, label }));
    }, [isDesktop, enabled, restore]);

    // ── returnPanel (ghost-chip "return" button) ─────────────────────────────
    const returnPanel = useCallback((label: string) => {
        const w = windowsRef.current.get(label);
        if (w) { void w.close().catch(() => {}); }           // triggers CLOSED too — restore is idempotent
        restore(label);
    }, [restore]);

    return { isDesktop, records, popOut, returnPanel };
}
