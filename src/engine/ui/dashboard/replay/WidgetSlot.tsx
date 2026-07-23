/**
 * WIDGET SLOT — the generic, registry-driven pane body (★ Replay Dashboard).
 *
 * Renders ANY registered widget generically: look up the manifest by id, run
 * its pure `dataSelector(receipt, events)` against the CURRENT replay context,
 * and either render it or the single NOT MEASURED empty state (LAW 3, enforced
 * once, here — mirrors WidgetDock's WidgetFrame). This genericity is the whole
 * point of the widget-registry modularization: a widget registered by wave 2
 * (or any future wave) drops into a slot with zero slot changes.
 *
 * TIME-SLICE: the `events` handed to the selector are sliced to the scrub time
 * (`sliceEventsAtTime`), so event-driven widgets replay honestly. `receipt` is
 * whole-run (you cannot reconstruct a partial receipt) — receipt widgets show
 * their final state, which is the honest thing a receipt can say.
 *
 * A4 item 4 (dock↔dashboard unification): the swap/add menu (`widgetOptions`)
 * now honors the SAME selection state as the WidgetDock — the dock's persisted
 * enabled-widget set — so the two surfaces are one coherent world rather than
 * parallel ones. Both already share the widget REGISTRY; this shares the
 * SELECTION. A widget already placed in a pane still renders even if later
 * disabled (this only scopes the ADD/SWAP menu, never the render path).
 */

import React, { useMemo } from 'react';
import { WIDGETS, getEnabledWidgets, allWidgetIds, type WidgetManifest } from '../../widgets/registry';
import { useReplayContext } from './ReplayContext';
import { sliceEventsAtTime } from './replay_state';

const NOT_MEASURED = 'NOT MEASURED';

export function findManifest(id: string): WidgetManifest | undefined {
    return WIDGETS.find(w => w.id === id);
}

/**
 * Registry widgets as { id, title } for the swap dropdown (stable registry
 * order), SCOPED to the dock's enabled-widget selection (shared selection
 * state). Falls back to the full registry when the enabled set is empty, so the
 * menu is never empty (you always need something swappable).
 */
export function widgetOptions(): { id: string; title: string }[] {
    let enabled: Set<string>;
    try {
        enabled = new Set(getEnabledWidgets(allWidgetIds()));
    } catch {
        enabled = new Set(allWidgetIds());
    }
    const scoped = WIDGETS.filter(w => enabled.has(w.id)).map(w => ({ id: w.id, title: w.title }));
    return scoped.length ? scoped : WIDGETS.map(w => ({ id: w.id, title: w.title }));
}

export const WidgetSlot: React.FC<{ widgetId: string }> = ({ widgetId }) => {
    const ctx = useReplayContext();
    const manifest = findManifest(widgetId);

    const scrubT = ctx?.frame?.t ?? Infinity;
    const eventSlice = useMemo(
        () => sliceEventsAtTime(ctx?.events, scrubT),
        [ctx?.events, scrubT],
    );

    if (!manifest) {
        return (
            <div className="text-[11px] font-mono text-danger p-4" data-testid={`widget-slot-unknown-${widgetId}`}>
                Unknown widget: {widgetId}
            </div>
        );
    }

    const data = manifest.dataSelector(ctx?.receipt ?? null, eventSlice);
    const Render = manifest.render;

    return (
        <div
            className="h-full overflow-auto p-3"
            data-testid={`widget-slot-${manifest.id}`}
            data-weight-tier={manifest.weightTier}
        >
            {data == null ? (
                <div
                    className="text-[11px] font-mono text-text-muted py-8 text-center"
                    data-testid={`widget-not-measured-${manifest.id}`}
                >
                    {NOT_MEASURED}
                </div>
            ) : (
                <Render data={data} />
            )}
        </div>
    );
};
