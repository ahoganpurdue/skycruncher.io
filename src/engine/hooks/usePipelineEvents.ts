import { useEffect, useState } from 'react';
import { PipelineEventBus, PipelineEvent } from '../events/pipeline_events';

/**
 * usePipelineEvents — batched React subscription to the Glass Pipeline bus.
 *
 * - Late-mount safe: replays `bus.getHistory()` (ring buffer) on subscribe,
 *   so an inspector opened mid-run still sees the full story.
 * - Burst safe: the solver can emit hundreds of `solve_candidate` findings
 *   in one tick. Emissions are coalesced — at most one state update per
 *   COALESCE_MS window, snapshotting the bus history (the history IS the
 *   source of truth; we never accumulate events ourselves).
 */
const COALESCE_MS = 120;

export function usePipelineEvents(bus: PipelineEventBus | null | undefined): readonly PipelineEvent[] {
    const [events, setEvents] = useState<readonly PipelineEvent[]>(() => (bus ? [...bus.getHistory()] : []));

    useEffect(() => {
        if (!bus) {
            setEvents([]);
            return;
        }
        // Sync anything emitted between render and effect.
        setEvents([...bus.getHistory()]);

        let timer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        const unsubscribe = bus.subscribe(() => {
            if (timer != null) return; // flush already scheduled for this window
            timer = setTimeout(() => {
                timer = null;
                if (!disposed) setEvents([...bus.getHistory()]);
            }, COALESCE_MS);
        });

        return () => {
            disposed = true;
            unsubscribe();
            if (timer != null) clearTimeout(timer);
        };
    }, [bus]);

    return events;
}
