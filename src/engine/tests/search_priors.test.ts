import { describe, it, expect } from 'vitest';
import {
    orderCentersBySearchPriors,
    SEARCH_PRIOR_DEFAULT_RADIUS_DEG,
    type SearchPriorModel,
} from '../pipeline/m6_plate_solve/search_priors';

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH-ORDER PRIORS (task #20 — lane ① search priors ONLY).
// These lock the load-bearing invariants of the reorder that the flag-gated
// blind-sweep call-site (solver_entry.ts) relies on:
//   · identity on prior-miss (the full-sweep fall-through),
//   · REORDER ONLY — a stable permutation, nothing pruned, search space intact,
//   · element-identity preserved (per-center `lever` flags ride along),
//   · stable tiebreak (equal scores keep original order),
//   · reordering actually ENGAGES for a banked-receipt-derived prior.
// The reorder never touches verification/thresholds — there is nothing here that
// can change WHAT the sweep accepts, only the ORDER it visits.
// ═══════════════════════════════════════════════════════════════════════════

type C = { ra: number; dec: number; name?: string; lever?: boolean };

const centers = (): C[] => [
    { ra: 2, dec: 10, name: 'A' },
    { ra: 6, dec: -30, name: 'B' },
    { ra: 12, dec: 40, name: 'C' },
    { ra: 17.6, dec: -22.5, name: 'D' }, // near the CR2 pinned solve center (17.5956h)
    { ra: 20, dec: 5, name: 'E' },
];

const sortedSet = (cs: C[]) => cs.map((c) => c.name).sort();

describe('orderCentersBySearchPriors — identity / fall-through', () => {
    it('returns the input array unchanged when the model is null (prior-miss)', () => {
        const input = centers();
        const r = orderCentersBySearchPriors(input, null);
        expect(r.engaged).toBe(false);
        expect(r.moved).toBe(0);
        expect(r.ordered).toBe(input); // same reference — a strict no-op
    });

    it('returns identity when the model has no regions', () => {
        const input = centers();
        const model: SearchPriorModel = { regions: [] };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.engaged).toBe(false);
        expect(r.ordered).toBe(input);
    });

    it('is an identity PERMUTATION when regions are supplied but nothing matches', () => {
        const input = centers();
        // A region on the far side of the sky from every center (radius 2°).
        const model: SearchPriorModel = { regions: [{ ra: 9, dec: -80, weight: 1, radius_deg: 2 }] };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.engaged).toBe(true);
        expect(r.scored).toBe(0);
        expect(r.moved).toBe(0);
        // Order byte-for-byte preserved (the full sweep runs unchanged).
        expect(r.ordered.map((c) => c.name)).toEqual(input.map((c) => c.name));
    });
});

describe('orderCentersBySearchPriors — reorder only (never prunes)', () => {
    it('moves the center nearest a banked prior to the FRONT and preserves the set', () => {
        const input = centers();
        // Prior derived from the CR2 pinned solve (RA 17.5956h ≈ Sagittarius); a
        // 5° radius picks up center D (17.6h, -22.5°) and nothing else.
        const model: SearchPriorModel = {
            source: 'banked-receipts:cr2-pin',
            regions: [{ ra: 17.5956, dec: -22.5, weight: 10, radius_deg: 5, label: 'CR2-pin' }],
        };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.engaged).toBe(true);
        expect(r.scored).toBe(1);
        expect(r.moved).toBeGreaterThan(0);
        expect(r.ordered[0].name).toBe('D'); // matched center now leads the sweep
        expect(r.leaderLabel).toBe('CR2-pin');
        // Reorder ONLY: same members, same count — nothing pruned.
        expect(r.ordered).toHaveLength(input.length);
        expect(sortedSet(r.ordered)).toEqual(sortedSet(input));
    });

    it('preserves element identity so per-center flags (lever) ride along', () => {
        const input: C[] = [
            { ra: 2, dec: 10, name: 'A', lever: false },
            { ra: 17.6, dec: -22.5, name: 'D', lever: true },
        ];
        const dRef = input[1];
        const model: SearchPriorModel = { regions: [{ ra: 17.6, dec: -22.5, weight: 1, radius_deg: 3 }] };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.ordered[0]).toBe(dRef); // exact same object, not a copy
        expect(r.ordered[0].lever).toBe(true);
    });

    it('orders multiple matches by descending prior strength', () => {
        const input: C[] = [
            { ra: 0, dec: 0, name: 'far' },
            { ra: 5.0, dec: 0, name: 'weakHit' },
            { ra: 10.0, dec: 0, name: 'strongHit' },
        ];
        const model: SearchPriorModel = {
            regions: [
                { ra: 5.0, dec: 0, weight: 1, radius_deg: 4 },   // weak
                { ra: 10.0, dec: 0, weight: 100, radius_deg: 4 }, // strong
            ],
        };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.ordered.map((c) => c.name)).toEqual(['strongHit', 'weakHit', 'far']);
        expect(r.scored).toBe(2);
    });
});

describe('orderCentersBySearchPriors — stability', () => {
    it('keeps original relative order among equal-score (unmatched) centers', () => {
        const input: C[] = [
            { ra: 1, dec: 0, name: 'x1' },
            { ra: 2, dec: 0, name: 'x2' },
            { ra: 3, dec: 0, name: 'x3' },
            { ra: 20, dec: 60, name: 'hit' },
        ];
        const model: SearchPriorModel = { regions: [{ ra: 20, dec: 60, weight: 1, radius_deg: 2 }] };
        const r = orderCentersBySearchPriors(input, model);
        // hit leads; the three zero-score centers keep their input order behind it.
        expect(r.ordered.map((c) => c.name)).toEqual(['hit', 'x1', 'x2', 'x3']);
    });

    it('uses the module default radius when a region omits radius_deg', () => {
        const input: C[] = [
            { ra: 0, dec: -60, name: 'origin' }, // >> default radius from the region → no score
            // ~ (SEARCH_PRIOR_DEFAULT_RADIUS_DEG - 1)° away in dec → inside default radius.
            { ra: 0, dec: SEARCH_PRIOR_DEFAULT_RADIUS_DEG - 1, name: 'inside' },
        ];
        const model: SearchPriorModel = { regions: [{ ra: 0, dec: SEARCH_PRIOR_DEFAULT_RADIUS_DEG - 1, weight: 1 }] };
        const r = orderCentersBySearchPriors(input, model);
        expect(r.ordered[0].name).toBe('inside');
        expect(r.scored).toBe(1);
    });
});
