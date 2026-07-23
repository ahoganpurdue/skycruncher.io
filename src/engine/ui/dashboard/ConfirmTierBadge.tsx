import React from 'react';
import type { PlateSolution } from '../../types/Main_types';
import { PIPELINE_CONSTANTS } from '../../pipeline/constants/pipeline_config';
import {
    classifyConfirmStatus,
    confirmTierLabel,
    type ConfirmStatus,
} from '../../pipeline/m6_plate_solve/confirm_status';

/**
 * CONFIRM TIER BADGE — the user-visible "safety catcher".
 *
 * The forced-photometry SET-LEVEL family-wise gate already decides CONFIRMED /
 * not, but until now nothing user-visible ASKED it: a solve whose verification
 * was REFUSED (16-176° off-sky false positives from the A5 sweep) or never ran
 * displayed as a plain "solved" with a bare confidence number. This badge
 * surfaces the tier so that confidence is never shown without its verification
 * verdict beside it.
 *
 * LAW 3 (honest-or-absent) + LOAD-BEARING-STATUS discipline:
 *  - The tier phrase is NEW display copy — NEVER a polled status contract value.
 *  - The verdict is DERIVED (shared classifier — one source of truth with the
 *    receipt's `confirm_status` block); this badge computes NO gate math.
 *  - No solve → no deep_confirmed → the badge is honestly absent (renders null)
 *    when `deep == null`. A solve that ran without confirmation surfaces the
 *    explicit NOT_RUN tier — the absence is made visible, not silent.
 */

export type DeepConfirmed = NonNullable<PlateSolution['deep_confirmed']>;

/** Tone-colored text token per state (existing kit color tokens; tone EARNED). */
const TONE_TEXT: Record<ConfirmStatus, string> = {
    CONFIRMED: 'text-solve',
    REFUSED: 'text-danger',
    INSUFFICIENT_TARGETS: 'text-warn',
    NOT_RUN: 'text-text-secondary',
    // 2.18.0: the test could not decide (resolution), distinct from a refusal.
    CONFIRM_UNDERPOWERED: 'text-warn',
};

interface ConfirmTierBadgeProps {
    /** solution.deep_confirmed (already-computed). Absent/null → renders null. */
    deep: DeepConfirmed | null | undefined;
    /** True when there is no solve at all — render nothing (nothing to confirm). */
    hideWhenNull?: boolean;
    /**
     * True while the forced-photometry confirmation stage is RUNNING but has not
     * yet produced `deep`. Lets the badge show a live "confirming…" state instead
     * of a premature verdict. The caller derives this from the pipeline event bus
     * (forced_confirm stage_started with no matching stage_finished). When a
     * verdict exists (`deep != null`) the verdict always wins over in-flight.
     */
    inFlight?: boolean;
    className?: string;
}

export function ConfirmTierBadge({ deep, hideWhenNull = true, inFlight = false, className }: ConfirmTierBadgeProps) {
    // No verdict yet, but the confirmation pass is RUNNING → honest live state
    // (being computed, not "unavailable"). Wins over hideWhenNull so the badge is
    // visible while it works, then flips to the real tier when the result lands.
    if (deep == null && inFlight) {
        return (
            <div className={className} data-testid="confirm-tier-badge" data-confirm-status="CONFIRMING">
                <span className="text-[11px] font-bold uppercase tracking-wide text-text-secondary animate-pulse">
                    Confirming…
                </span>
            </div>
        );
    }

    // No confirmation block, not in flight, caller wants absence hidden → nothing.
    if (deep == null && hideWhenNull) return null;

    const block = classifyConfirmStatus(deep, PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z);
    const label = confirmTierLabel(block.status);

    return (
        <div
            className={className}
            data-testid="confirm-tier-badge"
            data-confirm-status={block.status}
        >
            <span className={`text-[11px] font-bold uppercase tracking-wide ${TONE_TEXT[block.status]}`}>
                {label}
            </span>
        </div>
    );
}
