/**
 * WIDGET PANEL — the dockview panel renderer for a single registry widget.
 *
 * Chrome ownership (DASHBOARD_DOCKING_SPEC §6, LAW-3 one-enforcement-point):
 *   • dockview owns the tab bar / sash / close / placement around this panel.
 *   • WidgetFrame (WidgetDock.tsx) stays the SOLE owner of the widget's title,
 *     intent-help, weight badge, and the honest-or-absent empty-state taxonomy.
 *     We render it UNCHANGED inside the panel — never a fork, never a second
 *     NOT-MEASURED div. ZoomPanViewport composes inside it exactly as in the
 *     grid (WebGL wheel-owning widgets stay exempt via manifest.ownsPointerZoom).
 *
 * Live data flows through React context (DockingDataContext), not dockview
 * `params`: the receipt/events change over the run (null on landing → populated
 * post-solve) and every mounted panel must re-render when they do. dockview-
 * react renders panels within the same React tree, so context propagates. Only
 * the STABLE identity (`widgetId`) rides in dockview `params` (so it survives
 * toJSON/fromJSON).
 */

import React, { createContext, useContext } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { WidgetFrame } from '../WidgetDock';
import { WIDGETS, type WidgetReceipt, type WidgetEvents } from '../registry';

interface DockingData {
    receipt: WidgetReceipt;
    events?: WidgetEvents;
}

/** Live receipt/events for every docked panel (null receipt ⇒ AWAITING SOLVE). */
export const DockingDataContext = createContext<DockingData>({ receipt: null, events: undefined });

export const DockingDataProvider: React.FC<{ value: DockingData; children: React.ReactNode }> = ({ value, children }) => (
    <DockingDataContext.Provider value={value}>{children}</DockingDataContext.Provider>
);

const byId = new Map(WIDGETS.map(w => [w.id, w]));

/** dockview panel props carry the widget's stable id in `params`. */
export type WidgetPanelParams = { widgetId: string };

/**
 * The dockview component renderer (registered as WIDGET_PANEL_COMPONENT).
 * Resolves the manifest from `params.widgetId` and hands off to WidgetFrame.
 */
export const WidgetPanel: React.FC<IDockviewPanelProps<WidgetPanelParams>> = (props) => {
    const widgetId = props.params?.widgetId;
    const manifest = widgetId ? byId.get(widgetId) : undefined;
    const { receipt, events } = useContext(DockingDataContext);

    if (!manifest) {
        // Honest absence — a persisted layout referenced a widget id that no
        // longer exists in the registry. Never fabricate; say what happened.
        return (
            <div
                data-testid={`widget-panel-unknown-${widgetId ?? 'none'}`}
                className="flex flex-col items-center gap-1.5 py-6 text-center"
            >
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-text-muted">
                    WIDGET UNAVAILABLE
                </span>
                <span className="text-[10px] text-text-faint italic max-w-[38ch]">
                    {widgetId
                        ? `“${widgetId}” is not in the current widget registry.`
                        : 'No widget id was supplied for this panel.'}
                </span>
            </div>
        );
    }

    return (
        <div className="h-full overflow-auto p-2" data-testid={`widget-panel-${manifest.id}`}>
            <WidgetFrame manifest={manifest} receipt={receipt} events={events} />
        </div>
    );
};

export default WidgetPanel;
