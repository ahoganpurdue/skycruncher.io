/**
 * DOCKING SURFACE — the in-window dockview host (DASHBOARD_DOCKING_SPEC Phase B).
 *
 * When the docking flag is ON, this REPLACES the WidgetDock CSS grid at the same
 * mount points (SPEC §9 Q4). It provides drag-dock + tab stacks over the full
 * registry, the bottom widget ribbon (§6b), and Profile-v2 layout persistence.
 *
 * Chrome ownership (SPEC §6): dockview owns placement / sashes / tab bars /
 * close; each panel body is a WidgetFrame (SOLE owner of title/help/weight/
 * empty-state) via WidgetPanel; ZoomPanViewport composes unchanged inside.
 *
 * Persistence (SPEC §7, LAW 3): the dockview layout is saved through Profile
 * schema v2 (docking_store). On mount a stored blob is restored; a stale/failed
 * blob resets **LOUDLY** (console.warn) to the default layout — never a silent
 * partial render.
 *
 * Standing laws (SPEC §8): panels never feed the pipeline hot path; weight tiers
 * gate render only; data collection is never gated by display; the wizard and
 * status strings are untouched (this is a separate render-plane surface).
 *
 * Ledger: RENDER PLANE — display only.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DockviewReact, themeAbyss } from 'dockview-react';
import type {
    DockviewApi,
    DockviewReadyEvent,
    DockviewDidDropEvent,
    DockviewDndOverlayEvent,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { WIDGETS, type WidgetReceipt, type WidgetEvents } from '../registry';
import { useInViewport } from '../useInViewport';
import { WidgetPanel, DockingDataProvider } from './WidgetPanel';
import { WidgetRibbon } from './WidgetRibbon';
import {
    loadDockingLayout,
    saveDockingLayout,
    clearDockingLayout,
    positionToDirection,
    makePanelId,
    RIBBON_WIDGET_MIME,
    WIDGET_PANEL_COMPONENT,
    DEFAULT_PANELS,
    DOCKING_PROFILE_STORAGE_KEY,
    shouldBlockTabDrop,
    splitDirectionForShift,
    type DropPosition,
    type DropOverlayKind,
} from './docking_store';
import { isOutsideWindow, type PopoutBounds } from './popout_bridge';
import { usePopoutManager } from './usePopoutManager';
import { PopoutActionsProvider, PopoutHeaderAction } from './PopoutButton';
import { useReplayContext } from '../../dashboard/replay/ReplayContext';
import { buildWorkspaceEnvelope, serializeWorkspace, parseWorkspace } from './workspace_file';
import { exportWorkspaceFile, importWorkspaceFile } from './workspace_io';
import pkg from '../../../../../package.json';

/** App version for `.skyworkspace.json` provenance (never a gate). */
const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';

export interface DockingSurfaceProps {
    receipt: WidgetReceipt;
    events?: WidgetEvents;
    /**
     * localStorage key for this surface's persisted layout (SPEC §5b). Defaults
     * to the MAIN-window key; a popout passes its per-window key
     * (`popoutLayoutStorageKey(seedWidgetId)`) so its multi-widget tree persists
     * separately from the main dashboard's.
     */
    layoutStorageKey?: string;
    /**
     * First-run seed panels (SPEC §5b). Defaults to `DEFAULT_PANELS` (the main
     * dashboard's legible handful); a popout seeds with just the widget it was
     * torn from (`[widgetId]`, or `[]` when unknown → empty surface + ribbon CTA).
     */
    seedPanels?: readonly string[];
    /**
     * Whether this surface owns window lifecycle (SPEC §5b). Default true (MAIN).
     * A POPOUT surface passes false: no popout button, no header/tab tear-off,
     * and its popout manager stays inert — a popout never spawns further windows.
     */
    popoutEnabled?: boolean;
    /**
     * Fill the host viewport instead of the fixed 68vh dashboard band (SPEC §5b).
     * A popout window passes true so its surface fills the window and is always in
     * view (→ its ribbon always renders).
     */
    fillViewport?: boolean;
}

/** dockview component registry — one renderer for every widget. */
const COMPONENTS = { [WIDGET_PANEL_COMPONENT]: WidgetPanel };

const byId = new Map(WIDGETS.map(w => [w.id, w]));

/** True iff a native drag carries a ribbon-widget chip. */
function dragHasWidgetChip(nativeEvent: DragEvent | PointerEvent): boolean {
    const dt = (nativeEvent as DragEvent).dataTransfer;
    return !!dt && Array.from(dt.types).includes(RIBBON_WIDGET_MIME);
}

/** Add one widget panel by id (used for both the default seed and ribbon drops). */
function addWidgetPanel(
    api: DockviewApi,
    widgetId: string,
    at?: { group: DockviewDidDropEvent['group']; position: DropPosition },
): void {
    const manifest = byId.get(widgetId);
    if (!manifest) return;                       // unknown id ⇒ honest no-op
    api.addPanel({
        id: makePanelId(widgetId),
        component: WIDGET_PANEL_COMPONENT,
        title: manifest.title,
        params: { widgetId },
        position: at?.group
            ? { referenceGroup: at.group, direction: positionToDirection(at.position) }
            : undefined,
    });
}

function seedDefaultLayout(api: DockviewApi, panels: readonly string[]): void {
    for (const wid of panels) addWidgetPanel(api, wid);
}

/** This window's rect in logical screen px — the tear-off outside-window test (SPEC §5b). */
function readWindowRect(): PopoutBounds {
    return { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
}

export const DockingSurface: React.FC<DockingSurfaceProps> = ({
    receipt,
    events,
    layoutStorageKey = DOCKING_PROFILE_STORAGE_KEY,
    seedPanels = DEFAULT_PANELS,
    popoutEnabled = true,
    fillViewport = false,
}) => {
    const apiRef = useRef<DockviewApi | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The panel currently being header/tab-dragged (SPEC §5b tear-off). Captured at
    // drag START via dockview's typed `onWillDragPanel`, read on the window `dragend`,
    // cleared after. Ref (not state) — a drag must not re-render mid-gesture.
    const dragPanelRef = useRef<{ panelId: string; widgetId: string } | null>(null);
    // The ribbon is a viewport-fixed bar (SPEC §6b) gated on the surface being at
    // least partially (within 120px "near view") in the viewport. The observer is
    // attached — via `surfaceInViewRef`, a CALLBACK ref — to the ALWAYS-rendered
    // surface container, so the ribbon (rendered null while out of view) can never
    // deadlock its own visibility. `surfaceRef` is the same host, reused by the
    // ribbon to measure its left+width. Robust to inner-scroll-container scrolling.
    const { setRef: surfaceInViewRef, ref: surfaceRef, inView: surfaceInView } = useInViewport<HTMLDivElement>(120);
    // Drives the honest empty-state CTA (SPEC §7, LAW 3): true whenever the dock
    // holds zero panels for ANY reason — first-run before the seed, a user who
    // removed everything, or a persisted-empty layout. A collapsed 12px ribbon was
    // the only affordance an owner walkthrough could find; the CTA points at it.
    const [panelCount, setPanelCount] = useState<number>(0);
    // Transient status line for workspace export/import (§ WIDGET_ECOSYSTEM_DESIGN
    // §2). Honest-or-absent: an error tone carries the LOUD rejection detail, never
    // a silent partial apply. Auto-clears. Main surface only (popoutEnabled).
    const [wsNotice, setWsNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

    const refreshCount = useCallback(() => {
        const api = apiRef.current;
        setPanelCount(api ? api.panels.length : 0);
    }, []);

    const scheduleSave = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            const cur = apiRef.current;
            if (cur) saveDockingLayout(cur.toJSON(), layoutStorageKey);
        }, 300);
    }, [layoutStorageKey]);

    // Auto-clear the workspace status line after a few seconds.
    useEffect(() => {
        if (!wsNotice) return;
        const t = setTimeout(() => setWsNotice(null), 6000);
        return () => clearTimeout(t);
    }, [wsNotice]);

    // EXPORT (WIDGET_ECOSYSTEM_DESIGN §2): serialize the CURRENT dockview layout to
    // a `.skyworkspace.json` envelope and hand it to the platform save seam. Main
    // surface only — v0 scopes to this surface's layout (popouts persist under
    // their own per-seed keys and are NOT bundled; §2.3 single-workspace v0).
    const handleExportWorkspace = useCallback(async () => {
        const api = apiRef.current;
        if (!api) return;
        try {
            const envelope = buildWorkspaceEnvelope(api.toJSON(), { appVersion: APP_VERSION });
            const res = await exportWorkspaceFile(serializeWorkspace(envelope));
            if (res.status === 'saved') setWsNotice({ tone: 'ok', text: 'Workspace exported.' });
        } catch (err) {
            console.warn('[docking] workspace export failed:', err);
            setWsNotice({ tone: 'error', text: 'Workspace export failed — see console.' });
        }
    }, []);

    // IMPORT (WIDGET_ECOSYSTEM_DESIGN §2.2): open a `.skyworkspace.json`, validate
    // it with the docking store's OWN gates (parseWorkspace reuses DOCKING_SCHEMA_
    // VERSION + isDockingData), then apply as the active workspace. Invalid / foreign
    // / too-new ⇒ a LOUD honest error, never a silent partial apply. fromJSON is the
    // last authoritative gate: an unacceptable-but-structurally-valid blob resets
    // LOUDLY to the default layout (identical to the onReady restore path).
    const handleImportWorkspace = useCallback(async () => {
        const api = apiRef.current;
        if (!api) return;
        let picked;
        try {
            picked = await importWorkspaceFile();
        } catch (err) {
            console.warn('[docking] workspace import dialog failed:', err);
            setWsNotice({ tone: 'error', text: 'Could not open the workspace file.' });
            return;
        }
        if (picked.status !== 'loaded') return;          // user cancelled — silent
        const parsed = parseWorkspace(picked.text);
        if (!parsed.ok) {
            console.warn(`[docking] workspace import rejected (${parsed.reason}): ${parsed.detail}`);
            setWsNotice({ tone: 'error', text: parsed.detail });
            return;
        }
        try {
            api.clear();
            api.fromJSON(parsed.layout);
            scheduleSave();
            refreshCount();
            setWsNotice({ tone: 'ok', text: `Imported “${picked.name}”.` });
        } catch (err) {
            console.warn('[docking] imported layout failed to apply — resetting to default layout.', err);
            api.clear();
            seedDefaultLayout(api, seedPanels);
            scheduleSave();
            refreshCount();
            setWsNotice({ tone: 'error', text: 'Imported layout could not be applied — reset to default.' });
        }
    }, [scheduleSave, refreshCount, seedPanels]);

    const onReady = useCallback((event: DockviewReadyEvent) => {
        const api = event.api;
        apiRef.current = api;

        // Restore, or reset LOUDLY to the default layout (SPEC §7).
        const { layout, wasReset } = loadDockingLayout(layoutStorageKey);
        if (layout) {
            try {
                api.fromJSON(layout);
            } catch (err) {
                // A structurally-plausible but dockview-unacceptable blob: drop it
                // and rebuild default. LOUD — never a silent partial render.
                console.warn('[docking] persisted layout failed to restore — resetting to default layout.', err);
                clearDockingLayout(layoutStorageKey);
                api.clear();
                seedDefaultLayout(api, seedPanels);
            }
        } else {
            if (wasReset) {
                console.warn('[docking] persisted layout was invalid — resetting to default layout.');
                clearDockingLayout(layoutStorageKey);
            }
            seedDefaultLayout(api, seedPanels);
        }

        // Accept ribbon-chip external drags so the drop overlay shows.
        api.onUnhandledDragOver((e: DockviewDndOverlayEvent) => {
            if (dragHasWidgetChip(e.nativeEvent)) e.accept();
        });
        // SHIFT-SPLIT (SPEC §5b): while shift is held, suppress the tab/center drop
        // overlay so only edge SPLIT zones accept the drop — "shift = never tab",
        // uniform across internal tab moves AND external ribbon-chip drags. The live
        // modifier reads off the drag-over nativeEvent (dockview permits it).
        api.onWillShowOverlay((e) => {
            if (shouldBlockTabDrop(e.kind as DropOverlayKind, e.position as DropPosition, e.nativeEvent.shiftKey)) {
                e.preventDefault();
            }
        });
        // TEAR-OFF (SPEC §5b, main surface only): record the header/tab-dragged panel
        // at drag START; the window `dragend` handler decides tear-off vs normal drop.
        if (popoutEnabled) {
            api.onWillDragPanel((e) => {
                const wid = (e.panel.params as { widgetId?: string } | undefined)?.widgetId;
                dragPanelRef.current = wid ? { panelId: e.panel.id, widgetId: wid } : null;
            });
        }
        // Persist on any layout change (add / move / tab / resize / remove) and
        // keep the empty-state CTA in sync with the live panel count.
        api.onDidLayoutChange(() => { scheduleSave(); refreshCount(); });
        refreshCount();
    }, [scheduleSave, refreshCount, layoutStorageKey, seedPanels, popoutEnabled]);

    // A ribbon chip dropped onto the dock → place a new widget panel. Shift forces a
    // split rather than a tab (SPEC §5b; belt-and-suspenders with the overlay guard).
    const onDidDrop = useCallback((event: DockviewDidDropEvent) => {
        if (event.getData()) return;              // internal dockview move — dockview handled it
        const widgetId = (event.nativeEvent as DragEvent).dataTransfer?.getData(RIBBON_WIDGET_MIME);
        if (!widgetId) return;
        const shift = (event.nativeEvent as DragEvent).shiftKey ?? false;
        const position = splitDirectionForShift(event.position as DropPosition, shift);
        addWidgetPanel(event.api, widgetId, { group: event.group, position });
    }, []);

    // Remove a placed panel by id. Returns true iff it existed (the popout
    // manager needs to know it actually removed a live panel).
    const removePanelById = useCallback((panelId: string): boolean => {
        const api = apiRef.current;
        const panel = api?.getPanel(panelId);
        if (api && panel) { api.removePanel(panel); return true; }
        return false;
    }, []);

    // A placed panel-tab dragged onto the ribbon → remove it from the layout.
    const onRemovePanel = useCallback((panelId: string) => { removePanelById(panelId); }, [removePanelById]);

    // Re-add a widget to the dock (popout return / close). New panel id — the
    // widget comes back live; the old popped panel id is gone by design.
    const addWidgetById = useCallback((widgetId: string) => {
        const api = apiRef.current;
        if (api) addWidgetPanel(api, widgetId);
    }, []);

    // Popout controller (SPEC §5). Forwards a replay frame if this surface is
    // mounted inside a dashboard (null in the plain dock — honest degrade).
    const replay = useReplayContext();
    const popout = usePopoutManager({
        receipt,
        events,
        replayFrame: replay?.frame ?? null,
        removePanel: removePanelById,
        addPanel: addWidgetById,
        enabled: popoutEnabled,
    });

    // TEAR-OFF (SPEC §5b): a header/tab drag released OUTSIDE this window becomes an
    // OS window at the drop point. A CAPTURE-phase window `dragend` (beats dockview's
    // target-phase transfer-clear) reads the panel captured at drag start + the release
    // screen coords; outside ⇒ popOut with the drop origin. Inside ⇒ untouched (dockview
    // handles its own drop). Desktop + main-surface only; the ref is always cleared.
    const popOut = popout.popOut;
    const canTearOff = popoutEnabled && popout.isDesktop;
    useEffect(() => {
        if (!canTearOff) return;
        const onDragEnd = (e: DragEvent) => {
            const rec = dragPanelRef.current;
            dragPanelRef.current = null;                      // always clear after a gesture
            if (!rec) return;
            if (isOutsideWindow(e.screenX, e.screenY, readWindowRect())) {
                popOut(rec.panelId, rec.widgetId, { x: e.screenX, y: e.screenY });
            }
        };
        window.addEventListener('dragend', onDragEnd, { capture: true });
        return () => window.removeEventListener('dragend', onDragEnd, { capture: true } as EventListenerOptions);
    }, [canTearOff, popOut]);

    useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

    return (
        <DockingDataProvider value={{ receipt, events }}>
            <PopoutActionsProvider value={{ isDesktop: popoutEnabled && popout.isDesktop, popOut: popout.popOut }}>
                <div
                    ref={surfaceInViewRef}
                    data-testid="docking-surface"
                    className={fillViewport
                        ? 'flex flex-col overflow-hidden h-full'
                        : 'flex flex-col rounded-xl border border-line overflow-hidden'}
                    style={fillViewport
                        ? { height: '100%', flex: 1, minHeight: 0 }
                        : { height: '68vh', minHeight: 420, maxHeight: 760 }}
                >
                    <div className="relative flex-1 min-h-0">
                        <DockviewReact
                            components={COMPONENTS}
                            onReady={onReady}
                            onDidDrop={onDidDrop}
                            rightHeaderActionsComponent={popoutEnabled ? PopoutHeaderAction : undefined}
                            theme={themeAbyss}
                        />
                        {panelCount === 0 && (
                            <div
                                data-testid="docking-empty-cta"
                                // pointer-events-none so it never blocks a chip drop onto the
                                // empty dock underneath; purely a signpost toward the ribbon.
                                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center pointer-events-none"
                            >
                                <span className="text-text-muted text-[11px] font-bold uppercase tracking-widest">
                                    No widgets placed
                                </span>
                                <span className="text-text-faint text-[12px] max-w-[44ch]">
                                    Open the widget library below and drag a widget here to build your dashboard.
                                </span>
                                <span className="text-accent-300 text-[11px] font-mono uppercase tracking-widest">
                                    ↓ Widgets
                                </span>
                            </div>
                        )}
                    </div>
                    {/* Ghost strip: popped-out widgets show as ghosted chips here (never
                        live in both windows, SPEC §5); "return" re-docks + closes. */}
                    {popout.records.length > 0 && (
                        <div
                            data-testid="popout-ghost-strip"
                            className="flex items-center gap-2 px-3 py-1.5 border-t border-line bg-space-900/60 overflow-x-auto"
                        >
                            <span className="shrink-0 text-text-faint text-[9px] font-mono uppercase tracking-widest">Popped out</span>
                            {popout.records.map(r => (
                                <span
                                    key={r.label}
                                    data-testid={`popout-ghost-${r.widgetId}`}
                                    className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-dashed border-line bg-space-800/40 opacity-70"
                                >
                                    <span className="text-[10px] font-bold uppercase tracking-wide text-text-muted whitespace-nowrap">
                                        {byId.get(r.widgetId)?.title ?? r.widgetId}
                                    </span>
                                    <button
                                        type="button"
                                        data-testid={`popout-return-${r.widgetId}`}
                                        onClick={() => popout.returnPanel(r.label)}
                                        title="Return to dashboard"
                                        aria-label={`Return ${byId.get(r.widgetId)?.title ?? r.widgetId} to the dashboard`}
                                        className="text-[9px] font-mono uppercase tracking-widest text-accent-300 hover:text-accent-200"
                                    >
                                        return
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    {/* Workspace export/import status line — honest-or-absent: an error
                        tone carries the LOUD rejection detail (never a silent partial). */}
                    {wsNotice && (
                        <div
                            data-testid="workspace-notice"
                            data-tone={wsNotice.tone}
                            className={`px-3 py-1.5 border-t text-[11px] font-mono ${
                                wsNotice.tone === 'error'
                                    ? 'border-danger/40 bg-danger/10 text-danger'
                                    : 'border-line bg-space-900/60 text-accent-300'
                            }`}
                        >
                            {wsNotice.text}
                        </div>
                    )}
                    <WidgetRibbon
                        onRemovePanel={onRemovePanel}
                        containerRef={surfaceRef}
                        visible={surfaceInView}
                        // Workspace controls live in the ribbon chrome, MAIN surface only
                        // (a popout is an ephemeral sub-workspace; v0 shares the main one).
                        onExportWorkspace={popoutEnabled ? handleExportWorkspace : undefined}
                        onImportWorkspace={popoutEnabled ? handleImportWorkspace : undefined}
                    />
                </div>
            </PopoutActionsProvider>
        </DockingDataProvider>
    );
};

export default DockingSurface;
