/**
 * R1 SOLVER-TRUTH GUARDS (owner-ruled fixes, 2026-07-10; ultracode held-#2/#3/#13)
 *
 *   RIDGE PARK (#2) — 'ridge_directed' is DORMANT (CD-sign bug, ROADMAP C8a;
 *     directedAnchor never plumbed) yet used to sit first in the FL>200mm
 *     chain, silently falling through to solve_planar_local while the winning
 *     label claimed "via ridge_directed" (false strategy label, LAW-3). The
 *     live chain now filters it (getLiveStrategyChain); the implementation is
 *     RETAINED in solver_strategies.ts / solver_ridge.rs / trySolveAtCenter.
 *
 *   SUN-VETO RETIREMENT (#3) — owner ruling 2026-07-10: "if we match the stars
 *     with confidence, we don't need to check if the sun is up. We can kill
 *     it." The ultra-wide sun-proximity veto layer (ephemeris sunPosition
 *     seeding, daytimeConfirmed derivation, SOLVER_UW_SUN_VETO_DEG) is removed
 *     as redundant — forced-photometry confirmation is the load-bearing FP
 *     catcher (A5 evidence; docs/NEXT_MOVES.md §6 history). The pure helper
 *     isSunVetoed stays RETAINED-UNWIRED with its own unit tests.
 *
 * These guards pin TRUTH LABELS and owner-ruled removals; no calibrated gate
 * value moves here (LAW-2 untouched).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getLiveStrategyChain } from '../pipeline/m6_plate_solve/solver_entry';
import { getSolverChain } from '../pipeline/m6_plate_solve/solver_strategies';
import { isSunVetoed } from '../pipeline/m6_plate_solve/fine_center_lever';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

const here = path.dirname(fileURLToPath(import.meta.url));
const solverEntrySrc = readFileSync(
    path.join(here, '../pipeline/m6_plate_solve/solver_entry.ts'), 'utf8');

describe('RIDGE PARK (held-#2): ridge_directed is out of the live chain', () => {
    it('FL>200mm live chain contains no ridge_directed and leads with planar_local', () => {
        const live = getLiveStrategyChain(250); // SeeStar S50 regime
        expect(live).not.toContain('ridge_directed');
        expect(live).toEqual(['planar_local']);
    });

    it('park filter is the ONLY delta vs getSolverChain (other FL regimes byte-equal)', () => {
        expect(getLiveStrategyChain(20)).toEqual(getSolverChain(20));   // ['spherical_global','planar_local']
        expect(getLiveStrategyChain(100)).toEqual(getSolverChain(100)); // ['planar_local','spherical_global']
        // The dormant implementation is RETAINED: the raw chain still knows ridge.
        expect(getSolverChain(250)).toContain('ridge_directed');
    });
});

describe('SUN-VETO RETIREMENT (held-#3, owner-ruled 2026-07-10)', () => {
    it('SOLVER_UW_SUN_VETO_DEG constant is retired from pipeline_config', () => {
        expect('SOLVER_UW_SUN_VETO_DEG' in PIPELINE_CONSTANTS).toBe(false);
    });

    it('solver_entry no longer wires the veto (no isSunVetoed call, no sunPosition option)', () => {
        // Call-site pattern (identifier immediately followed by "(") — the dated
        // retirement comments mention the name in prose only.
        expect(solverEntrySrc).not.toMatch(/\bisSunVetoed\(/);
        expect(solverEntrySrc).not.toMatch(/import[^;]*\bisSunVetoed\b/);
        expect(solverEntrySrc).not.toMatch(/\boptions\.sunPosition\b/);
        expect(solverEntrySrc).not.toMatch(/\boptions\.daytimeConfirmed\b/);
        // Live constant reference (PC.<name>) — the dated retirement comments
        // may cite the bare constant name in prose.
        expect(solverEntrySrc).not.toMatch(/PC\.SOLVER_UW_SUN_VETO_DEG\b/);
    });

    it('isSunVetoed helper is RETAINED-UNWIRED (documented function, not deleted)', () => {
        expect(typeof isSunVetoed).toBe('function');
        // Pure-function sanity (mirrors fine_center_lever.test.ts): pointing at
        // the injected Sun is "vetoed" by the helper — which nothing calls.
        expect(isSunVetoed(5.2, 20.0, { ra_hours: 5.2, dec_degrees: 20.0 }, 40)).toBe(true);
        expect(isSunVetoed(17.3, -22.5, { ra_hours: 5.2, dec_degrees: 20.0 }, 40)).toBe(false);
    });
});

describe('odds delete (held-#13, owner-ruled 2026-07-10)', () => {
    it('solver_entry no longer fabricates a synthetic odds field', () => {
        expect(solverEntrySrc).not.toMatch(/\bodds\s*:/);
        expect(solverEntrySrc).not.toMatch(/confidence\s*\*\s*1e9/);
    });
});
