/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEARCH-ORDER PRIORS (lane ① — search priors ONLY) — EXPERIMENTAL, default OFF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DOCTRINE (CLAUDE.md LAW "ML = hint-recommender only"; NEXT_MOVES task #20):
 * a prior may ONLY reorder / prioritise the SEARCH — the sequence in which the
 * blind sweep visits candidate centers. It NEVER touches verification, the
 * acceptance thresholds, or the math gate. A prior-ordered solve that finds a
 * candidate still passes the identical verify ladder. Analytics finding (D-priors
 * -lane-go, 2026-07-12): ~95% of solve wall-time is the blind sweep, and the two
 * pinned CR2 UW solves lock at the LAST anchor — so moving a likely center to the
 * front of the budget-capped sweep is pure wall-time recovery with zero effect on
 * WHAT is accepted.
 *
 * PROPERTIES (all load-bearing — verified in search_priors.test.ts):
 *   · REORDER ONLY. The output is a stable PERMUTATION of the input: every center
 *     survives, nothing is pruned, the search SPACE is unchanged. Only visit order
 *     moves. (Budget-exhaustion wall-time may differ; the reachable set does not.)
 *   · IDENTITY on prior-miss. Absent/empty model, or a model no center matches,
 *     returns the input order byte-for-byte (stable sort, all-equal scores → the
 *     index tiebreak restores the original order). This is the fall-through: an
 *     un-primed frame runs the full sweep exactly as before.
 *   · ELEMENT-IDENTITY preserved. Centers are re-ordered by reference, so per-center
 *     flags the sweep relies on (e.g. `lever`) ride along untouched.
 *   · PURE. No I/O, no globals, no clock. The derivation of a model FROM banked
 *     receipts lives in tools/ (incubator pattern); the engine only CONSUMES a
 *     model handed to it via SolverOptions.searchPriors.
 *
 * The engine call-site (solver_entry.ts) is gated by PC.SOLVER_SEARCH_PRIORS
 * (env/config, default 0 → OFF) so the flag-OFF path never invokes this at all and
 * is bit-identical.
 */

/** One banked-prior sky region: the solver has historically locked near here. */
export interface SearchPriorRegion {
    /** Right ascension of the prior center, HOURS (internal convention). */
    ra: number;
    /** Declination of the prior center, DEGREES. */
    dec: number;
    /** Relative prior mass (> 0). Larger ⇒ stronger pull toward the front. */
    weight: number;
    /**
     * Influence radius, DEGREES. A candidate center beyond this from the region
     * contributes nothing from that region. Default SEARCH_PRIOR_DEFAULT_RADIUS_DEG.
     */
    radius_deg?: number;
    /** Optional provenance label (e.g. the receipt basename it was derived from). */
    label?: string;
}

/** A banked-receipt-derived model handed to the solver (SolverOptions.searchPriors). */
export interface SearchPriorModel {
    /** Provenance string for logs/receipts (e.g. "banked-receipts:population_run_2026-07-11"). */
    source?: string;
    /** The prior regions. Empty ⇒ identity (no reordering). */
    regions: SearchPriorRegion[];
}

/** Default influence radius when a region omits radius_deg. */
export const SEARCH_PRIOR_DEFAULT_RADIUS_DEG = 10;

export interface SearchPriorOrderResult<T> {
    /** Reordered centers — a stable permutation of the input (same element refs). */
    ordered: T[];
    /** True iff a non-empty model was supplied (the lane was actually active). */
    engaged: boolean;
    /** How many centers changed position vs the input order. */
    moved: number;
    /** How many centers matched at least one prior region (score > 0). */
    scored: number;
    /** The leading center's provenance label (if it matched a prior), for logs. */
    leaderLabel?: string;
}

/** Great-circle angular separation in DEGREES between two sky points (ra in HOURS). */
function angularSepDeg(raHoursA: number, decA: number, raHoursB: number, decB: number): number {
    const D2R = Math.PI / 180;
    const ra1 = raHoursA * 15 * D2R;
    const ra2 = raHoursB * 15 * D2R;
    const d1 = decA * D2R;
    const d2 = decB * D2R;
    // haversine — numerically stable for small separations (where prior pull matters).
    const dRa = ra2 - ra1;
    const dDec = d2 - d1;
    const h = Math.sin(dDec / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dRa / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / D2R;
}

/**
 * Prior score for a candidate center = max over regions of
 *   weight · max(0, 1 − dist/radius)          (linear falloff, 0 beyond radius)
 * The max (not sum) keeps a single strong nearby region from being diluted and
 * makes the score a monotone "closeness × confidence" that is easy to reason about.
 * Returns { score, label } so the leader's provenance can be logged.
 */
function priorScore(
    center: { ra: number; dec: number },
    regions: SearchPriorRegion[],
): { score: number; label?: string } {
    let best = 0;
    let label: string | undefined;
    for (const r of regions) {
        const radius = r.radius_deg && r.radius_deg > 0 ? r.radius_deg : SEARCH_PRIOR_DEFAULT_RADIUS_DEG;
        const d = angularSepDeg(center.ra, center.dec, r.ra, r.dec);
        if (d >= radius) continue;
        const s = r.weight * (1 - d / radius);
        if (s > best) {
            best = s;
            label = r.label;
        }
    }
    return { score: best, label };
}

/**
 * Reorder blind-sweep centers so those nearest high-weight banked priors are
 * visited FIRST. Pure, stable, permutation-only. See the file header for the
 * invariants. Identity when `model` is null/undefined/empty or when no center
 * matches any region.
 */
export function orderCentersBySearchPriors<T extends { ra: number; dec: number }>(
    centers: T[],
    model: SearchPriorModel | null | undefined,
): SearchPriorOrderResult<T> {
    if (!model || !model.regions || model.regions.length === 0) {
        return { ordered: centers, engaged: false, moved: 0, scored: 0 };
    }
    const regions = model.regions;
    // Score with a stable index tiebreak: equal scores keep original relative
    // order, so all-zero (prior-miss) is a strict identity permutation.
    const scored = centers.map((c, i) => {
        const { score, label } = priorScore(c, regions);
        return { c, i, score, label };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const ordered = scored.map((x) => x.c);
    let moved = 0;
    for (let i = 0; i < centers.length; i++) {
        if (ordered[i] !== centers[i]) moved++;
    }
    const scoredCount = scored.reduce((n, x) => n + (x.score > 0 ? 1 : 0), 0);
    const leaderLabel = scored.length && scored[0].score > 0 ? scored[0].label : undefined;
    return { ordered, engaged: true, moved, scored: scoredCount, leaderLabel };
}
