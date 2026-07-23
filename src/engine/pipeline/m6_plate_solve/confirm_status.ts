/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIRM STATUS — the "safety catcher" verdict (status plumbing, no gate math)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: NEITHER coordinate nor pixel math. Pure classification of an
 * ALREADY-COMPUTED result. Reads only the existing `deep_confirmed` block that
 * `confirmForcedSet` (forced_confirm.ts) produced; changes NO gate, NO
 * calibrated constant, NO accept/reject behavior.
 *
 * WHY THIS EXISTS. The forced-photometry SET-LEVEL family-wise gate already
 * decides CONFIRMED / not — but nothing downstream ASKS it. A solve whose
 * confirmation was REFUSED (evaluated, failed the family-wise excess gate) or
 * was never given enough reference stars for a set verdict currently displays
 * as a plain "solved" with a bare confidence number. That is exactly the
 * "false confidence" the owner ruled we must catch. This derives ONE four-state
 * verdict so the UI and the receipt read the same conclusion instead of each
 * re-deriving it (and possibly disagreeing).
 *
 * THE FOUR STATES (derived, never a new threshold):
 *   • CONFIRMED             — the set-level gate was EVALUATED and PASSED
 *                             (deep_confirmed.setGatePassed === true).
 *   • REFUSED               — EVALUATED with sufficient targets, gate FAILED
 *                             (setGatePassed === false, not the too-few branch).
 *   • INSUFFICIENT_TARGETS  — the confirmation pass RAN but had too few forced
 *                             targets for a set verdict. This is confirmForcedSet's
 *                             OWN existing N<10 floor (its `not_measured` marker),
 *                             surfaced — NOT a new constant minted here.
 *   • NOT_RUN               — the pass was skipped wholesale (no science buffer /
 *                             lens prior / no in-frame catalog / no solve).
 *
 * The set-gate Z THRESHOLD the verdict was judged against is CITED, never
 * re-derived: it is passed in from PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z
 * at the call site, so this module owns no calibrated value.
 */

import type { PlateSolution } from '../../types/Main_types';

export type ConfirmStatus =
    | 'CONFIRMED'
    | 'REFUSED'
    | 'INSUFFICIENT_TARGETS'
    | 'NOT_RUN'
    /** 2.18.0 (adjudication row 529): the set test was EVALUATED but admission was
     *  impossible BY CONSTRUCTION — the empirical p-floor sat above every BY rank
     *  threshold (fdr.underpowered). "Could not decide" is a claim about the TEST's
     *  resolution, not about the sky, and must never masquerade as REFUSED. With
     *  adaptive null resolution ON this state should be rare (cap-bound or degraded
     *  configs only). ADDITIVE value — the four original states are untouched. */
    | 'CONFIRM_UNDERPOWERED';

/** The `deep_confirmed` block shape (from confirmForcedSet → solver_entry). */
export type DeepConfirmed = NonNullable<PlateSolution['deep_confirmed']>;

export interface ConfirmStatusBlock {
    /** The four-state verdict. */
    status: ConfirmStatus;
    /** Set-level excess-Z of the confirmed count over the scrambled null; null
     *  when no set statistic was computed (too few targets / not run). */
    setExcessZ: number | null;
    /** Forced targets the confirmation pass examined (0 when the pass was skipped). */
    nTargets: number;
    /** Confirmed count after the family-wise gate (0 unless CONFIRMED). */
    confirmed: number;
    /** The RETIRED z threshold (phase-2 flip 2026-07-22) — CITED from
     *  PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z for continuity of the
     *  reported statistic; it no longer decides anything. */
    setGateZ: number;
    /** Honest reason carried from the stage (`not_measured` text) when present. */
    reason: string | null;
    /** PHASE-2 (schema 2.17.0): the deciding authority — 'FDR_BY' (or 'FDR_BH'
     *  if ever configured); null when the pass never computed a set statistic. */
    gate_authority: 'FDR_BY' | 'FDR_BH' | null;
    /** Stars confirmed by the FDR step-up (the deciding count); null when absent. */
    n_confirmed_fdr: number | null;
    /** The FDR level q the decision ran at; null when absent. */
    fdr_q: number | null;
}

/**
 * Derive the four-state confirmation verdict from `solution.deep_confirmed`.
 * Pure and total. `dc` absent/null ⇒ NOT_RUN.
 *
 * Distinguishing INSUFFICIENT_TARGETS from NOT_RUN when both carry a
 * `not_measured` string: `absent()` (stage skipped) always reports
 * `examined === 0`, whereas confirmForcedSet's too-few-candidates floor ran the
 * forced pass and reports `examined` in 1..(N<10). So `examined > 0` with a
 * `not_measured` marker ⟺ the pass ran but had too few targets.
 *
 * @param dc       solution.deep_confirmed (the already-computed block)
 * @param setGateZ PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z (cited, not owned)
 */
export function classifyConfirmStatus(
    dc: DeepConfirmed | null | undefined,
    setGateZ: number,
): ConfirmStatusBlock {
    if (!dc) {
        return {
            status: 'NOT_RUN', setExcessZ: null, nTargets: 0, confirmed: 0, setGateZ,
            reason: null, gate_authority: null, n_confirmed_fdr: null, fdr_q: null,
        };
    }
    const nTargets = dc.examined ?? 0;
    const fdr = dc.fdr ?? null;
    const base = {
        setExcessZ: dc.setExcessZ ?? null,
        nTargets,
        confirmed: dc.confirmed ?? 0,
        setGateZ,
        reason: dc.not_measured ?? null,
        // PHASE-2 (2026-07-22): the FDR step-up is the deciding authority.
        gate_authority: fdr ? (fdr.method === 'BY' ? 'FDR_BY' as const : 'FDR_BH' as const) : null,
        n_confirmed_fdr: fdr ? fdr.n_confirmed_fdr : null,
        fdr_q: fdr ? fdr.q : null,
    };
    if (dc.setGatePassed) {
        // Gate evaluated AND passed (never carries not_measured — see confirmForcedSet).
        return { status: 'CONFIRMED', ...base };
    }
    if (dc.not_measured) {
        // examined>0 ⟺ ran the forced pass but too few targets for a set verdict
        // (confirmForcedSet N<10 floor); examined===0 ⟺ absent()/skipped wholesale.
        return { status: nTargets > 0 ? 'INSUFFICIENT_TARGETS' : 'NOT_RUN', ...base };
    }
    // 2.18.0: the gate failed with ZERO admissions AND the test itself was
    // structurally unable to admit (p-floor above every rank threshold) — honest
    // "could not decide", distinct from a genuine refusal (row 529).
    if (fdr && fdr.n_confirmed_fdr === 0 && fdr.underpowered) {
        return { status: 'CONFIRM_UNDERPOWERED', ...base };
    }
    // Evaluated with sufficient targets (N≥10) and the family-wise gate FAILED.
    return { status: 'REFUSED', ...base };
}

/**
 * The user-facing tier label. New display copy ONLY — NEVER a load-bearing
 * polled status value. Kept pure (no React) so the receipt/UI/tests share it.
 */
export function confirmTierLabel(status: ConfirmStatus): string {
    switch (status) {
        case 'CONFIRMED':
            return 'SOLVED — CONFIRMED';
        case 'REFUSED':
            return 'SOLVED — UNCONFIRMED (verification refused)';
        case 'INSUFFICIENT_TARGETS':
            return 'SOLVED — UNCONFIRMED (verification unavailable: too few reference stars)';
        case 'NOT_RUN':
            return 'SOLVED — UNCONFIRMED (verification unavailable)';
        case 'CONFIRM_UNDERPOWERED':
            return 'SOLVED — UNCONFIRMED (verification underpowered — could not decide)';
    }
}
