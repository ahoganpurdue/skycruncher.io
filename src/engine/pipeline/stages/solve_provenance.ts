/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE PROVENANCE — lean success/failure provenance (Escalation §7 Monday slice)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (reads the hint-resolution provenance; no pixel math).
 *
 * Owner ruling 2026-07-11 (docs/ESCALATION_CONTROLLER_SPEC §3, verbatim):
 *   "if it solves, it solves… forced photometry confirms it's correct — then
 *    we're good. no need to record 100 different tags, just enough info to
 *    identify where we have room for improvement on our detection."
 *
 * The LEAN design:
 *   • ONE field on success — `solved_via` — the CATEGORY of search prior that
 *     was active when the solve locked. A hinted solve is NOT a lesser solve:
 *     acceptance never consults the hint, the verify σ gate is the SOLE arbiter,
 *     and a hint only SHRINKS the pose-hypothesis count (false-accept exposure
 *     goes DOWN, not up). Purpose: denominator integrity for our own blind-rate
 *     capability claims + the detection-improvement map. NO per-rung taxonomy.
 *   • FAILURES recorded richer than successes — `failed_attempts` carries the
 *     short WHY of an earlier attempt that failed before a later one recovered
 *     (that is where the improvement information lives). Absent on a clean
 *     solve. NO wall clocks — determinism: timing never enters an asserted field.
 *
 * MONDAY SLICE SCOPE (spec §7): provenance RECORDING only. There is no escalation
 * LOOP yet (post-event), so `failed_attempts` has no producer today and is
 * therefore always absent — the SHAPE exists and is forward-compatible; nothing
 * fabricates a failure that did not happen (honest-or-absent, LAW 3).
 */

/** The four honest solve-provenance categories (spec §3). `assisted:tool` is
 *  reserved for an autonomous producer/tool hint — NO such producer is wired
 *  into the solve path today, so it is never emitted (honest-absent, not a guess). */
export type SolvedVia = 'blind' | 'assisted:user' | 'assisted:metadata' | 'assisted:tool';

/** The hint-resolution rung that seeded the search — mirrors
 *  `WizardHintResolution['source']` in stages/solve (kept as a local literal
 *  union so this pure module has no dependency on the solve stage). */
export type HintProvenanceSource = 'CONFIG' | 'FITS_HEADER' | 'ZENITH' | 'BLIND';

/** Short, diagnostic failure reason (spec §3/§6) — NO rung enums, NO timing. */
export type SolveFailedOutcomeWhy = 'scale-never-locked' | 'centers-exhausted' | 'detection-starved';

/** One earlier attempt that failed before a later attempt recovered the solve.
 *  `sigma_reached` is the best verification σ that attempt reached (null if it
 *  never produced one). NO wall-clock field — determinism (spec §6). */
export interface SolveFailedAttempt {
    outcome_why: SolveFailedOutcomeWhy;
    sigma_reached: number | null;
}

/** The lean receipt provenance block. `failed_attempts` is present ONLY when a
 *  prior attempt genuinely failed before recovery (absent on a clean solve). */
export interface SolveProvenance {
    solved_via: SolvedVia;
    failed_attempts?: SolveFailedAttempt[];
}

/**
 * Map the hint-resolution rung that seeded the winning search to a solved_via
 * category. HONEST-OR-ABSENT: an unrecognised/absent source returns `null` —
 * we never default to a guessed 'blind' (absent beats a wrong label).
 *
 *   BLIND        → 'blind'              (no prior; >3 centers, 180° radius)
 *   CONFIG       → 'assisted:user'      (explicit user target hint on upload, @609c132)
 *   FITS_HEADER  → 'assisted:metadata'  (telescope GOTO pointing in the FITS header)
 *   ZENITH       → 'assisted:metadata'  (observer GPS + trusted clock → zenith prior)
 *
 * `assisted:tool` is NOT reachable from the wizard hint ladder today (no
 * autonomous producer is wired into the solve path — every banked producer is
 * FAIL/unrun per the escalation spec), so it is never returned.
 */
export function deriveSolvedVia(source: HintProvenanceSource | null | undefined): SolvedVia | null {
    switch (source) {
        case 'BLIND': return 'blind';
        case 'CONFIG': return 'assisted:user';
        case 'FITS_HEADER': return 'assisted:metadata';
        case 'ZENITH': return 'assisted:metadata';
        default: return null; // honest-absent — no guessed label
    }
}

/**
 * Build the lean solve-provenance block from the winning hint source (+ any
 * genuinely-failed earlier attempts). Returns `null` when the source is not
 * honestly known (never a guessed 'blind'). `failed_attempts` is attached ONLY
 * when the caller supplies a non-empty list (absent on a clean solve). The
 * output carries NO timing value — determinism (spec §6): the copy below keeps
 * ONLY the two diagnostic fields, so an accidental timing key upstream can never
 * leak into this asserted block.
 */
export function buildSolveProvenance(
    source: HintProvenanceSource | null | undefined,
    failedAttempts?: readonly SolveFailedAttempt[] | null,
): SolveProvenance | null {
    const solvedVia = deriveSolvedVia(source);
    if (solvedVia === null) return null;
    const block: SolveProvenance = { solved_via: solvedVia };
    if (failedAttempts && failedAttempts.length > 0) {
        block.failed_attempts = failedAttempts.map(a => ({
            outcome_why: a.outcome_why,
            sigma_reached: (typeof a.sigma_reached === 'number' && Number.isFinite(a.sigma_reached))
                ? a.sigma_reached
                : null,
        }));
    }
    return block;
}
