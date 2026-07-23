/**
 * POPOUT BUTTON — the dockview panel-header action (DASHBOARD_DOCKING_SPEC §6).
 *
 * Chrome ownership (LAW-3, SPEC §6): the POPOUT button is dockview chrome — it
 * lives in the group header's right actions, beside close, NOT inside WidgetFrame
 * (WidgetFrame stays the sole owner of title/help/weight/empty-state). It acts on
 * the group's ACTIVE panel, reading its stable `widgetId` from the panel params.
 *
 * Browser tier (SPEC §5, honest-or-absent): the affordance is ABSENT entirely
 * when not in the Tauri desktop shell — `isDesktop` is false there, so this
 * renders nothing (no degraded popup).
 *
 * dockview renders header actions within the same React tree, so the popOut
 * callback reaches here through `PopoutActionsContext` (same pattern WidgetPanel
 * uses for live receipt/events).
 *
 * Ledger: RENDER PLANE.
 */

import React, { createContext, useContext } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';

export interface PopoutActions {
    /** True only inside the Tauri desktop shell (gates the affordance). */
    isDesktop: boolean;
    /** Pop the given dock panel out into its own OS window (optional tear-off origin, SPEC §5b). */
    popOut: (panelId: string, widgetId: string, origin?: { x: number; y: number }) => void;
}

const PopoutActionsContext = createContext<PopoutActions | null>(null);
export const PopoutActionsProvider = PopoutActionsContext.Provider;
export function usePopoutActions(): PopoutActions | null {
    return useContext(PopoutActionsContext);
}

/** dockview `rightHeaderActionsComponent` — a popout button for the active panel. */
export const PopoutHeaderAction: React.FC<IDockviewHeaderActionsProps> = (props) => {
    const actions = usePopoutActions();
    // Browser tier / no manager ⇒ absent (honest-or-absent, no degraded popup).
    if (!actions || !actions.isDesktop) return null;

    const panel = props.activePanel;
    const widgetId = (panel?.params as { widgetId?: string } | undefined)?.widgetId;
    const panelId = panel?.id;
    if (!panel || !widgetId || !panelId) return null;

    return (
        <button
            type="button"
            data-testid={`popout-btn-${panelId}`}
            title={`Pop “${panel.title ?? widgetId}” out into its own window`}
            aria-label="Pop out into its own window"
            onClick={() => actions.popOut(panelId, widgetId)}
            className="h-full px-2 inline-flex items-center justify-center text-text-faint hover:text-text-primary focus-visible:text-text-primary text-[13px] leading-none"
        >
            {/* U+29C9 — two joined squares, the conventional "pop out" glyph. */}
            ⧉
        </button>
    );
};

export default PopoutHeaderAction;
