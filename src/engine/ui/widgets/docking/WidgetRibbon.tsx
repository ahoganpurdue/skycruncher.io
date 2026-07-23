/**
 * WIDGET RIBBON — the add-widget palette (DASHBOARD_DOCKING_SPEC §6b).
 *
 * A collapsed-by-default strip along the bottom of the docking surface. The
 * FULL registry (~34) is available as chips; a chip is dragged into the dock
 * (dockview external drop → place or tab-stack) and a placed panel dragged back
 * onto the ribbon is removed from the layout.
 *
 * Honest-or-absent (LAW 3): chips are TEXT/BADGES ONLY — title, weight-tier
 * badge, live/scaffold marker. They NEVER render a preview or a number; a
 * null-selector widget is still listed and, once placed, shows its own honest
 * empty state (AWAITING SOLVE / NOT MEASURED) through WidgetFrame.
 *
 * Perf: collapsed costs zero widget render; expanding renders only chips (no
 * data collection). Weight rules apply only when a widget is PLACED — the
 * ribbon lists every widget regardless of tier.
 *
 * Zoom exemption: wheel over the ribbon scrolls the ribbon horizontally (it
 * lives OUTSIDE the docked panels, so it is not under any ZoomPanViewport).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPanelData } from 'dockview-react';
import { WIDGETS } from '../registry';
import { RIBBON_WIDGET_MIME, computeRibbonFixedStyle, type RibbonRect } from './docking_store';
import { getRibbonCollapsed, setRibbonCollapsed } from './docking_flag';

export interface WidgetRibbonProps {
    /** Remove a placed panel by id (panel-tab dragged onto the ribbon). */
    onRemovePanel: (panelId: string) => void;
    /**
     * The docking surface container. The fixed ribbon anchors its left+width to
     * this element's viewport rect so it spans the surface's own column, not the
     * whole browser. Absent ⇒ full-viewport fallback.
     */
    containerRef?: React.RefObject<HTMLElement | null>;
    /**
     * Whether the docking surface is at least partially in view (SPEC §6b). When
     * false the ribbon is NOT rendered, so a viewport-fixed bar never covers page
     * content the user is reading while the dashboard is far off-screen. Default
     * true (render) so any standalone use keeps working.
     */
    visible?: boolean;
    /**
     * Export the current workspace to a `.skyworkspace.json` (WIDGET_ECOSYSTEM_
     * DESIGN §2). Rendered as a handle-row entry only when provided — the MAIN
     * surface passes it; a popout surface omits it (ephemeral sub-workspace).
     */
    onExportWorkspace?: () => void;
    /** Import a `.skyworkspace.json` and apply it as the active workspace (§2.2). */
    onImportWorkspace?: () => void;
}

/** One draggable chip — pure metadata, never a preview. */
const WidgetChip: React.FC<{ id: string; title: string; tier: string; scaffold: boolean; onDragComplete: () => void }> = ({
    id, title, tier, scaffold, onDragComplete,
}) => {
    const onDragStart = (e: React.DragEvent) => {
        // The MIME dockview's onUnhandledDragOver/onDidDrop keys off (docking_store).
        e.dataTransfer.setData(RIBBON_WIDGET_MIME, id);
        e.dataTransfer.setData('text/plain', title);   // human fallback
        e.dataTransfer.effectAllowed = 'copy';
    };
    return (
        <button
            type="button"
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragComplete}
            data-testid={`ribbon-chip-${id}`}
            data-widget-id={id}
            title={`Drag “${title}” into the dashboard`}
            className="shrink-0 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-line bg-space-800 hover:bg-space-700 cursor-grab active:cursor-grabbing"
        >
            <span className="text-[10px] font-bold uppercase tracking-wide text-text-secondary whitespace-nowrap">{title}</span>
            <span className="text-[8px] font-mono uppercase tracking-widest text-text-faint">{tier}</span>
            <span
                className={`text-[8px] font-mono uppercase tracking-widest ${scaffold ? 'text-text-faint' : 'text-accent-300'}`}
                data-testid={`ribbon-chip-marker-${id}`}
            >
                {scaffold ? 'SCAFFOLD' : 'LIVE'}
            </span>
        </button>
    );
};

/**
 * The ribbon — a VIEWPORT-FIXED bar along the bottom of the screen (SPEC §6b),
 * NOT an in-flow element at the bottom of the docking section (an in-flow ribbon
 * sat several screens below the fold under the landing content — owner re-verify
 * 2026-07-21). It anchors `position:fixed; bottom:0` to the surface container's
 * left+width, and is rendered ONLY while the docking surface is at least
 * partially in view (`visible`), so it never covers page content while the
 * dashboard is far off-screen. Collapsed = a thin fixed strip (grab handle +
 * count); expanded = the horizontally-scrollable chip rail. Collapse state is
 * persisted (`skycruncher.ribbon.collapsed`, default EXPANDED on first run);
 * toggled on click or Alt+W; auto-collapses after a chip drag completes.
 */
export const WidgetRibbon: React.FC<WidgetRibbonProps> = ({ onRemovePanel, containerRef, visible = true, onExportWorkspace, onImportWorkspace }) => {
    const [collapsed, setCollapsed] = useState<boolean>(() => getRibbonCollapsed());
    const [removeArmed, setRemoveArmed] = useState(false);
    const [rect, setRect] = useState<RibbonRect | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    const apply = useCallback((next: boolean) => {
        setCollapsed(next);
        setRibbonCollapsed(next);
    }, []);
    const toggle = useCallback(() => apply(!collapsed), [apply, collapsed]);

    // Track the surface container's horizontal rect so the fixed bar spans that
    // column (not the whole browser). Only while visible; re-measure on scroll /
    // resize / container resize. getBoundingClientRect gives viewport coords,
    // which is exactly what a position:fixed bar needs.
    useEffect(() => {
        if (!visible) return;
        const el = containerRef?.current;
        if (!el) { setRect(null); return; }
        const measure = () => {
            const r = el.getBoundingClientRect();
            setRect({ left: r.left, width: r.width });
        };
        measure();
        // CAPTURE-phase scroll so a scroll inside an INNER container (window.scrollY
        // stays 0) still re-anchors the fixed bar — scroll does not bubble, but the
        // capture phase sees it from any descendant scroller.
        window.addEventListener('scroll', measure, { capture: true, passive: true });
        window.addEventListener('resize', measure);
        let ro: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
        return () => {
            window.removeEventListener('scroll', measure, { capture: true } as EventListenerOptions);
            window.removeEventListener('resize', measure);
            ro?.disconnect();
        };
    }, [visible, containerRef]);

    // Wheel over the ribbon → scroll the chip rail horizontally, NEVER the page.
    // A NATIVE non-passive listener is required to preventDefault (React's onWheel
    // is passive). Bound only while a rail exists (expanded); collapsed strip lets
    // the wheel fall through so the page still scrolls normally under a 30px bar.
    useEffect(() => {
        const root = rootRef.current;
        if (!root || collapsed || !visible) return;
        const onWheelNative = (e: WheelEvent) => {
            const rail = railRef.current;
            if (!rail) return;
            const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (delta === 0) return;
            rail.scrollLeft += delta;
            e.preventDefault();            // the page must not scroll while over the rail
        };
        root.addEventListener('wheel', onWheelNative, { passive: false });
        return () => root.removeEventListener('wheel', onWheelNative);
    }, [collapsed, visible]);

    // Hotkey: Alt+W toggles the ribbon (mnemonic: Widgets). Guarded so it never
    // hijacks typing in a field.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!e.altKey || (e.key !== 'w' && e.key !== 'W')) return;
            const t = e.target as HTMLElement | null;
            const tag = t?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
            e.preventDefault();
            apply(!collapsed);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [apply, collapsed]);

    // Ribbon as a drop target for a placed panel's tab → remove from layout.
    // dockview stashes the dragged PanelTransfer in its LocalSelectionTransfer
    // singleton, readable during dragover via getPanelData().
    const onDragOver = (e: React.DragEvent) => {
        const data = getPanelData();
        if (!data || data.panelId == null) return;   // not a dockview panel drag
        e.preventDefault();                            // allow the drop
        e.dataTransfer.dropEffect = 'move';
        if (!removeArmed) setRemoveArmed(true);
    };
    const onDragLeave = () => setRemoveArmed(false);
    const onDrop = (e: React.DragEvent) => {
        const data = getPanelData();
        setRemoveArmed(false);
        if (!data || data.panelId == null) return;
        e.preventDefault();
        onRemovePanel(data.panelId);
    };

    const count = WIDGETS.length;

    // Out of view ⇒ don't render at all (a viewport-fixed bar must not linger over
    // page content while the dashboard is off-screen). All hooks ran above, so this
    // late return is hooks-rules safe.
    const fixedStyle = computeRibbonFixedStyle(visible, rect);
    if (!fixedStyle) return null;

    return (
        <div
            ref={rootRef}
            data-testid="widget-ribbon"
            data-collapsed={collapsed ? '1' : '0'}
            data-remove-armed={removeArmed ? '1' : '0'}
            data-fixed="1"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={fixedStyle as React.CSSProperties}
            className={`border-t border-line bg-space-900/95 shadow-[0_-4px_16px_rgba(0,0,0,0.35)] ${removeArmed ? 'ring-1 ring-inset ring-danger/70' : ''}`}
        >
            {/* Handle row — the toggle spans most of the strip; workspace export/import
                sit at the far right as sibling entries (main surface only). */}
            <div className="w-full flex items-center">
                <button
                    type="button"
                    onClick={toggle}
                    data-testid="ribbon-handle"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand widget ribbon' : 'Collapse widget ribbon'}
                    className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left hover:bg-space-800"
                >
                    <span className="text-text-faint text-[11px] leading-none">{collapsed ? '▲' : '▼'}</span>
                    <span className="text-text-muted text-[10px] font-bold uppercase tracking-widest">Widgets</span>
                    <span className="text-text-faint text-[10px] font-mono">{count}</span>
                    {removeArmed && (
                        <span className="text-danger text-[10px] font-mono uppercase tracking-widest ml-2">drop to remove</span>
                    )}
                    <span className="ml-auto text-text-faint text-[9px] font-mono uppercase tracking-widest">Alt+W</span>
                </button>
                {(onExportWorkspace || onImportWorkspace) && (
                    <div data-testid="ribbon-workspace-controls" className="shrink-0 flex items-center gap-1 pl-2 pr-2">
                        {onExportWorkspace && (
                            <button
                                type="button"
                                data-testid="ribbon-export-workspace"
                                onClick={onExportWorkspace}
                                title="Export this workspace to a .skyworkspace.json file"
                                className="px-2 py-1 rounded-md border border-line bg-space-800 hover:bg-space-700 text-[9px] font-mono uppercase tracking-widest text-text-muted"
                            >
                                Export
                            </button>
                        )}
                        {onImportWorkspace && (
                            <button
                                type="button"
                                data-testid="ribbon-import-workspace"
                                onClick={onImportWorkspace}
                                title="Import a .skyworkspace.json file as the active workspace"
                                className="px-2 py-1 rounded-md border border-line bg-space-800 hover:bg-space-700 text-[9px] font-mono uppercase tracking-widest text-text-muted"
                            >
                                Import
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Chip rail — only mounted when expanded (collapsed = zero chip DOM). */}
            {!collapsed && (
                <div
                    ref={railRef}
                    data-testid="ribbon-rail"
                    className="flex items-center gap-2 px-3 pb-2 overflow-x-auto"
                    style={{ scrollbarWidth: 'thin' }}
                >
                    {WIDGETS.map(w => (
                        <WidgetChip
                            key={w.id}
                            id={w.id}
                            title={w.title}
                            tier={w.weightTier}
                            scaffold={w.kind === 'scaffold'}
                            onDragComplete={() => apply(true)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default WidgetRibbon;
