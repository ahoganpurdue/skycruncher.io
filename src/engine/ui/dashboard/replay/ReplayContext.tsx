/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPLAY CONTEXT — the pane/widget time-slice contract (★ Replay Dashboard)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The dashboard provides one `ReplayContextValue` for the whole tree; every
 * widget slot reads it. There are TWO consumption paths, both documented here
 * because WAVE-2's flowchart widget is the reference consumer:
 *
 *  (A) IMPLICIT (any existing registry widget, zero changes):
 *      the WidgetSlot passes `receipt` + a TIME-SLICED `events` array
 *      (`sliceEventsAtTime(events, frame.t)`) straight into the widget's
 *      `dataSelector(receipt, events)`. An event-driven widget therefore
 *      re-derives itself as the scrub advances — it only ever "sees" the events
 *      that had happened by the scrub time. No widget code changes.
 *
 *  (B) EXPLICIT (a replay-aware widget — the wave-2 flowchart):
 *      the widget's render component calls `useReplayFrame()` to read the full
 *      derived `ReplayFrame` (per-stage `phase`/`verdict`/`counts`), and lights
 *      its boxes from `frame.stages`. Falls back to null when rendered OUTSIDE a
 *      dashboard (e.g. in the plain WidgetDock), so a replay-aware widget must
 *      degrade honestly there.
 *
 * Honest-or-absent (LAW 3): `receipt` is null for a JSONL-only past run (no
 * live receipt) ⇒ receipt-backed widgets render NOT MEASURED. The frame itself
 * is always real — never a fabricated timeline.
 */

import React, { createContext, useContext } from 'react';
import type { WidgetReceipt } from '../../widgets/registry';
import type { PipelineEvent } from '../../../events/pipeline_events';
import type { ReplayFrame } from './replay_state';

export interface ReplayContextValue {
    /** The derived state at the current scrub time. null before a run is chosen. */
    frame: ReplayFrame | null;
    /** The selected run's receipt (buildReceipt output), or null when unavailable. */
    receipt: WidgetReceipt;
    /** The selected run's FULL raw event history, or undefined (JSONL-only runs). */
    events: readonly PipelineEvent[] | undefined;
}

const ReplayContext = createContext<ReplayContextValue | null>(null);

export const ReplayProvider: React.FC<{ value: ReplayContextValue; children: React.ReactNode }> = ({ value, children }) => (
    <ReplayContext.Provider value={value}>{children}</ReplayContext.Provider>
);

/** Full context (frame + receipt + events). null outside a dashboard. */
export function useReplayContext(): ReplayContextValue | null {
    return useContext(ReplayContext);
}

/**
 * The wave-2 contract hook: the derived `ReplayFrame` at the scrub time, or null
 * when rendered outside a replay dashboard. A replay-aware widget lights its
 * boxes from `frame.stages` and MUST degrade honestly when this is null.
 */
export function useReplayFrame(): ReplayFrame | null {
    return useContext(ReplayContext)?.frame ?? null;
}
