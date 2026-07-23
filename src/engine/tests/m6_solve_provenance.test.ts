/**
 * SOLVE PROVENANCE (schema 2.11.0) — Escalation Controller spec §7 "Monday slice".
 *
 * The LEAN provenance (owner-ruled 2026-07-11): ONE field on success (solved_via)
 * + richer-on-failure failed_attempts, NO per-rung taxonomy, NO wall clock in any
 * asserted field. This suite pins:
 *   (a) the 2.11.0 receipt constant;
 *   (b) a solve carries a VALID solved_via (and the honest per-source mapping);
 *   (c) failed_attempts is ABSENT on a clean solve;
 *   (d) NO key of solve_provenance carries a timing value (determinism, spec §6);
 * plus: honest-or-absent (no solve / unknown source → null, never a guessed
 * 'blind'), the forward-compatible failed_attempts shape (+ its timing quarantine),
 * and serializer survival. NO real solve is run — pure classification of an
 * already-resolved hint source.
 */
import { describe, it, expect } from 'vitest';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import { RECEIPT_SCHEMA_VERSION } from '../pipeline/stages/schema_versions';
import {
    deriveSolvedVia,
    buildSolveProvenance,
    type HintProvenanceSource,
    type SolvedVia,
    type SolveFailedAttempt,
} from '../pipeline/stages/solve_provenance';
import type { PlateSolution } from '../types/Main_types';

const VALID_SOLVED_VIA: readonly SolvedVia[] = ['blind', 'assisted:user', 'assisted:metadata', 'assisted:tool'];

/** The honest source → solved_via mapping (spec §3). */
const MAPPING: ReadonlyArray<[HintProvenanceSource, SolvedVia]> = [
    ['BLIND', 'blind'],
    ['CONFIG', 'assisted:user'],
    ['FITS_HEADER', 'assisted:metadata'],
    ['ZENITH', 'assisted:metadata'],
];

// ── fixtures (the exact PlateSolution shape solver_entry emits) ──────────────

function solution(extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        odds: 1, confidence: 0.9, num_stars: 0, matched_stars: [],
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

function receiptFor(
    sol: PlateSolution | null,
    hintSource?: HintProvenanceSource | null,
    solveFailedAttempts?: SolveFailedAttempt[],
): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution: sol, planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, imageWidth: 1000, imageHeight: 1000,
        hintSource, solveFailedAttempts,
    };
    return buildReceipt(i);
}

/** Recursively assert no key anywhere in the block reads as a wall-clock/timing
 *  value (spec §6 determinism quarantine). */
const TIMING_KEY = /(^|_)(ms|msec|time|times|duration|elapsed|wall|clock|epoch|started|finished|timestamp|when|at)($|_)/i;
function assertNoTimingKeys(obj: unknown, path: string): void {
    if (obj === null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
        expect(TIMING_KEY.test(k), `timing-ish key "${k}" found at ${path}`).toBe(false);
        assertNoTimingKeys(v, `${path}.${k}`);
    }
}

// ── (a) the version constant ────────────────────────────────────────────────

describe('solve_provenance — receipt schema version', () => {
    it('(a) RECEIPT_SCHEMA_VERSION tracks the additive train (2.11.0 solve_provenance → 2.12.0 user_annotations → 2.13.0 pipeline_provenance → 2.14.0 rawler_calibration + user_target_hint + nebulosity_layer → 2.15.0 star-data correction cells → 2.16.0 compute_routes)', () => {
        expect(RECEIPT_SCHEMA_VERSION).toBe('2.20.0');
    });
});

// ── the pure mapping ────────────────────────────────────────────────────────

describe('deriveSolvedVia — honest source → category mapping', () => {
    it.each(MAPPING)('maps %s → %s', (source, expected) => {
        expect(deriveSolvedVia(source)).toBe(expected);
    });

    it('never emits assisted:tool from the wizard ladder (no producer wired today)', () => {
        for (const [source] of MAPPING) {
            expect(deriveSolvedVia(source)).not.toBe('assisted:tool');
        }
    });

    it('returns null for an unknown/absent source — never a guessed "blind"', () => {
        expect(deriveSolvedVia(null)).toBeNull();
        expect(deriveSolvedVia(undefined)).toBeNull();
        // A stray non-enum string must not silently become blind either.
        expect(deriveSolvedVia('GARBAGE' as HintProvenanceSource)).toBeNull();
    });
});

describe('buildSolveProvenance — lean block assembly', () => {
    it('null when the source is not honestly known (no guessed label)', () => {
        expect(buildSolveProvenance(null)).toBeNull();
        expect(buildSolveProvenance(undefined)).toBeNull();
    });

    it('a clean solve carries solved_via with NO failed_attempts key', () => {
        const p = buildSolveProvenance('BLIND')!;
        expect(p.solved_via).toBe('blind');
        expect('failed_attempts' in p).toBe(false);
        expect(Object.keys(p)).toEqual(['solved_via']);
    });

    it('an empty failed-attempt list still omits the key (absent, not [])', () => {
        const p = buildSolveProvenance('CONFIG', [])!;
        expect('failed_attempts' in p).toBe(false);
    });

    it('forward-compat: a genuine failed attempt is recorded (richer-on-failure)', () => {
        const p = buildSolveProvenance('CONFIG', [{ outcome_why: 'centers-exhausted', sigma_reached: 3.1 }])!;
        expect(p.solved_via).toBe('assisted:user');
        expect(p.failed_attempts).toEqual([{ outcome_why: 'centers-exhausted', sigma_reached: 3.1 }]);
    });

    it('(d) timing quarantine: any stray timing key on a failed attempt is STRIPPED', () => {
        const dirty = { outcome_why: 'scale-never-locked', sigma_reached: 2.0, wall_ms: 1234, elapsed_ms: 99 } as unknown as SolveFailedAttempt;
        const p = buildSolveProvenance('BLIND', [dirty])!;
        expect(Object.keys(p.failed_attempts![0]).sort()).toEqual(['outcome_why', 'sigma_reached']);
        assertNoTimingKeys(p, 'solve_provenance');
    });

    it('non-finite sigma_reached collapses to null (honest-absent)', () => {
        const p = buildSolveProvenance('BLIND', [{ outcome_why: 'detection-starved', sigma_reached: NaN }])!;
        expect(p.failed_attempts![0].sigma_reached).toBeNull();
    });
});

// ── receipt inclusion via buildReceipt ──────────────────────────────────────

describe('buildReceipt — solve_provenance inclusion', () => {
    it('(b) a solve carries a VALID solved_via for every honest source', () => {
        for (const [source, expected] of MAPPING) {
            const r = receiptFor(solution(), source);
            expect(r.solve_provenance).not.toBeNull();
            expect(VALID_SOLVED_VIA).toContain(r.solve_provenance.solved_via);
            expect(r.solve_provenance.solved_via).toBe(expected);
        }
    });

    it('(c) failed_attempts is ABSENT on a clean solve', () => {
        const r = receiptFor(solution(), 'FITS_HEADER');
        expect(r.solve_provenance.solved_via).toBe('assisted:metadata');
        expect('failed_attempts' in r.solve_provenance).toBe(false);
    });

    it('(d) NO key of solve_provenance carries a timing value (clean + failed)', () => {
        assertNoTimingKeys(receiptFor(solution(), 'BLIND').solve_provenance, 'solve_provenance');
        const withFail = receiptFor(solution(), 'BLIND', [{ outcome_why: 'centers-exhausted', sigma_reached: 4.2 }]);
        assertNoTimingKeys(withFail.solve_provenance, 'solve_provenance');
        // Exact allowed key set — the strongest form of the determinism guarantee.
        expect(Object.keys(withFail.solve_provenance).sort()).toEqual(['failed_attempts', 'solved_via']);
    });

    it('NO solve → solve_provenance is null (honest-or-absent, nothing to record)', () => {
        expect(receiptFor(null, 'BLIND').solve_provenance).toBeNull();
    });

    it('solve present but hint source unknown → null (never a guessed "blind")', () => {
        expect(receiptFor(solution(), null).solve_provenance).toBeNull();
        expect(receiptFor(solution(), undefined).solve_provenance).toBeNull();
    });

    it('survives the receipt serializer as plain JSON data', () => {
        const r = receiptFor(solution(), 'CONFIG', [{ outcome_why: 'detection-starved', sigma_reached: 1.5 }]);
        const round = JSON.parse(serializeReceipt(r));
        expect(round.solve_provenance.solved_via).toBe('assisted:user');
        expect(round.solve_provenance.failed_attempts[0].outcome_why).toBe('detection-starved');
        expect(round.solve_provenance.failed_attempts[0].sigma_reached).toBe(1.5);
        assertNoTimingKeys(round.solve_provenance, 'solve_provenance');
    });
});
