/**
 * ═══════════════════════════════════════════════════════════════════════════
 * USER TARGET HINT — the structured VALUE behind an assisted:user solve
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure classification of an already-resolved hint value).
 *
 * When a caller supplied an explicit target hint on upload and it seeded the
 * winning search — solve_provenance.solved_via='assisted:user', which is exactly
 * the CONFIG hint rung firing (stages/solve.resolveWizardHints) — this records the
 * hint VALUE as supplied (HINT_TAXONOMY §3, ROADMAP:47 "record the hint testimony"):
 * the display label, RA (hours) and Dec (degrees) the user gave. Every field is
 * `assumed:true` — a hint is a search PRIOR, never a measurement (acceptance
 * consults the verify σ gate ALONE; a hint only SHRINKS the pose-hypothesis count,
 * so false-accept exposure goes DOWN, not up).
 *
 * HONEST-OR-ABSENT (LAW 3): null on a blind solve (source ≠ CONFIG) and null when
 * no caller hint was supplied. `CallerTargetHint` carries no field of view, so
 * `fov_deg` is honestly null (never fabricated). The azimuth-mode sentinel
 * (ra === -1) and non-finite coordinates are guarded out — the SAME guard
 * resolveWizardHints applies before a hint can enter the CONFIG rung — so a hint
 * that could not have seeded the solve never appears here.
 */

import type { CallerTargetHint } from './solve';
import type { HintProvenanceSource } from './solve_provenance';

export interface UserTargetHint {
    /** Display label the user supplied (e.g. 'M31'), or null when none. */
    target_name: string | null;
    /** RA in HOURS as supplied (catalog/hint convention). */
    ra_hours: number | null;
    /** Dec in DEGREES as supplied. */
    dec_degrees: number | null;
    /** Field of view (deg) — NOT part of CallerTargetHint, so always null (honest-absent). */
    fov_deg: number | null;
    /** A hint is a search prior, never a measurement. Always true. */
    assumed: true;
}

/**
 * Build the `user_target_hint` block, or null when the solve was not seeded by an
 * explicit user target (source ≠ CONFIG) or no caller hint was supplied. Guards the
 * azimuth-mode sentinel (ra === -1) and non-finite coordinates exactly as
 * resolveWizardHints does, so the block is present iff the hint genuinely COULD have
 * entered the CONFIG rung that produced solved_via='assisted:user'.
 */
export function buildUserTargetHint(
    source: HintProvenanceSource | null | undefined,
    callerHint: CallerTargetHint | null | undefined,
): UserTargetHint | null {
    if (source !== 'CONFIG' || !callerHint) return null;
    const { ra, dec, label } = callerHint;
    if (ra === -1 || !Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    return {
        target_name: label ?? null,
        ra_hours: ra,
        dec_degrees: dec,
        fov_deg: null,
        assumed: true,
    };
}
