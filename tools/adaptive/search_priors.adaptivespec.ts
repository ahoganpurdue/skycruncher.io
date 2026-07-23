/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEARCH-ORDER PRIORS — flag-ON demonstration (task #20, lane ① search priors).
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPERIMENTAL. Proves the priors lane ENGAGES with the flag ON, on a
 * receipt-backed frame, with log evidence — using the REAL engine reorder
 * function, the REAL bright-star anchor list the blind sweep walks, and a prior
 * model DERIVED FROM REAL BANKED RECEIPTS (tools/adaptive/derive_search_priors.mjs).
 *
 * Models the exact wall-time pathology the analytics flagged (D-priors-lane-go):
 * ~95% of solve wall-time is the blind sweep and the pinned UW solves lock at the
 * LAST anchor. Here a banked-lock center sits near the END of the sweep list;
 * with SOLVER_SEARCH_PRIORS ON it is reordered to the FRONT — the whole wasted
 * wall recovered — while the set of centers is preserved byte-for-byte (reorder
 * ONLY, nothing pruned, verify/thresholds untouched).
 *
 * Runs OUTSIDE the sacred `npx vitest run` gate (adaptive config, *.adaptivespec.ts):
 *   npx vitest run -c tools/adaptive/adaptive.config.ts tools/adaptive/search_priors.adaptivespec.ts
 * Needs a derived model JSON (local-only banked receipts). Absent ⇒ honest skip.
 */
import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { BRIGHT_STAR_ANCHORS } from '../../src/engine/pipeline/m6_plate_solve/bright_star_anchors';
import {
    orderCentersBySearchPriors,
    type SearchPriorModel,
} from '../../src/engine/pipeline/m6_plate_solve/search_priors';

const MODEL_PATH = process.env.SEARCH_PRIORS_MODEL ?? 'test_results/search_priors/model.json';
const hasModel = fs.existsSync(MODEL_PATH);

(hasModel ? describe : describe.skip)('SEARCH-ORDER PRIORS — flag-ON demo (EXPERIMENTAL)', () => {
    it('reads SOLVER_SEARCH_PRIORS=1 as ON (the solver gate opens)', async () => {
        vi.resetModules();
        process.env.SOLVER_SEARCH_PRIORS = '1';
        const { PIPELINE_CONSTANTS } = await import(
            '../../src/engine/pipeline/constants/pipeline_config'
        );
        expect(PIPELINE_CONSTANTS.SOLVER_SEARCH_PRIORS).toBe(true);
        delete process.env.SOLVER_SEARCH_PRIORS;
    });

    it('reorders a LAST-anchor banked lock to the FRONT, preserving the full set', () => {
        const envelope = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
        const model: SearchPriorModel = envelope.model;
        expect(model.regions.length).toBeGreaterThan(0);

        // The REAL bright-star anchor list the blind sweep walks, as centers.
        const centers: { ra: number; dec: number; name?: string }[] = BRIGHT_STAR_ANCHORS.map(
            (s) => ({ ra: s.ra_hours, dec: s.dec_degrees, name: s.name }),
        );
        // A banked lock (strongest region) sitting near the END of the sweep —
        // the "locks at the last anchor" wall the analytics identified.
        const top = model.regions[0];
        const bankedLock = { ra: top.ra, dec: top.dec, name: 'BANKED_LOCK' };
        centers.push(bankedLock);
        const rankBefore = centers.indexOf(bankedLock);

        const r = orderCentersBySearchPriors(centers, model);
        const rankAfter = r.ordered.indexOf(bankedLock);

        // Evidence (EXPERIMENTAL) — the log the flag-ON solver call-site emits.
        // eslint-disable-next-line no-console
        console.log(
            `[SEARCH-PRIORS] EXPERIMENTAL: source=${model.source} regions=${model.regions.length} | ` +
            `centers=${centers.length} reordered — BANKED_LOCK rank ${rankBefore} → ${rankAfter}, ` +
            `matched=${r.scored}, moved=${r.moved}, leader=${r.leaderLabel ?? '—'}. ` +
            `Reorder only; search space unchanged (was: last-anchor lock = full wasted sweep).`,
        );

        expect(r.engaged).toBe(true);
        expect(r.moved).toBeGreaterThan(0);
        expect(rankBefore).toBe(centers.length - 1); // started last
        expect(rankAfter).toBe(0);                    // now first
        // REORDER ONLY — nothing pruned: same count, same membership.
        expect(r.ordered).toHaveLength(centers.length);
        expect(new Set(r.ordered).size).toBe(centers.length);
        expect(r.ordered.every((c) => centers.includes(c))).toBe(true);
    });
});
