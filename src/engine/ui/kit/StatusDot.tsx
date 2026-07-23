import React from 'react';

/**
 * STATUS DOT — stage-state indicator dot.
 *
 * Hoisted verbatim from the `DOT` map + dot span in
 * inspector/PipelineInspector.tsx (StageTimeline) so a later refactor onto
 * the kit is a visual no-op.
 *
 * LAW 3: color is EARNED — `ok` green only on a verified completion,
 * `running` pulses accent (live, not success), `pending` is the not-yet-
 * earned grey.
 *
 * Reduced motion: `animate-pulse` is neutralized instrument-wide by the
 * global `@media (prefers-reduced-motion: reduce)` block in src/index.css;
 * state is always ALSO carried by color + the `data-state` attribute, never
 * by motion alone.
 */

export type StatusDotState = 'pending' | 'running' | 'ok' | 'failed';

const DOT: Record<StatusDotState, string> = {
    pending: 'bg-pending/50',
    running: 'bg-accent-400 animate-pulse',
    ok: 'bg-solve',
    failed: 'bg-danger',
};

export const StatusDot: React.FC<{ state: StatusDotState; testid?: string }> = ({ state, testid }) => (
    <span data-testid={testid} data-state={state} className={`w-2 h-2 rounded-full shrink-0 ${DOT[state]}`} />
);
