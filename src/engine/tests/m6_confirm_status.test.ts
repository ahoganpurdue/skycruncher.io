/**
 * SAFETY CATCHER (schema 2.10.0) — confirm_status classifier + receipt inclusion.
 *
 * The forced-photometry SET-LEVEL family-wise gate already decides CONFIRMED /
 * not; this suite pins the DERIVED four-state verdict that surfaces it, plus its
 * honest-or-absent presence in the receipt. NO gate math is exercised here — the
 * classifier only READS confirmForcedSet's existing outputs.
 *
 * Covered: (1) all four states + null/undefined input; (2) the INSUFFICIENT vs
 * NOT_RUN split keyed on examined>0 (confirmForcedSet's N<10 floor vs absent());
 * (3) the tier labels; (4) receipt inclusion with the right status + cited
 * setGateZ; (5) null-on-absence when there is no solve; (6) serializer survival.
 */
import { describe, it, expect } from 'vitest';
import {
    classifyConfirmStatus,
    confirmTierLabel,
    type DeepConfirmed,
} from '../pipeline/m6_plate_solve/confirm_status';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';
import type { PlateSolution } from '../types/Main_types';

const GATE_Z = PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z;

// ── deep_confirmed fixtures (the exact shapes solver_entry emits) ────────────

const base: DeepConfirmed = {
    provenance: 'CATALOG_FORCED_CONFIRMED',
    examined: 205, confirmed: 198, setExcessZ: 77.9, setGatePassed: true,
    approximate: false, grid: 'NATIVE_FLOAT_LUMINANCE',
    framePsf: { fwhmPx: 3.9, ellipticity: 0.12, source: 'psf_field' },
    confirmed_stars: [],
};

/** CONFIRMED — the M66/SeeStar sacred-run shape (set contrast ≫ gate). */
const CONFIRMED_DC = base;

/** REFUSED — evaluated with ≥10 targets, family-wise gate collapsed to zero. */
const REFUSED_DC: DeepConfirmed = {
    ...base, examined: 40, confirmed: 0, setExcessZ: 4.2, setGatePassed: false,
};

/** INSUFFICIENT_TARGETS — confirmForcedSet's OWN N<10 floor (CR2: 8 targets). */
const INSUFFICIENT_DC: DeepConfirmed = {
    ...base, examined: 8, confirmed: 0, setExcessZ: null, setGatePassed: false,
    not_measured: 'Too few candidates (8 < 10) for a set-level confirmation statistic — NOT MEASURED.',
};

/** NOT_RUN via absent() — stage skipped wholesale, examined === 0. */
const ABSENT_DC: DeepConfirmed = {
    ...base, examined: 0, confirmed: 0, setExcessZ: null, setGatePassed: false,
    framePsf: null, not_measured: 'No coherent native science buffer at post-solve — confirmation NOT MEASURED.',
};

// ── (1)-(2) classifier states ────────────────────────────────────────────────

describe('classifyConfirmStatus — four states', () => {
    it('CONFIRMED when the set gate passed', () => {
        const b = classifyConfirmStatus(CONFIRMED_DC, GATE_Z);
        expect(b.status).toBe('CONFIRMED');
        expect(b.setExcessZ).toBe(77.9);
        expect(b.nTargets).toBe(205);
        expect(b.confirmed).toBe(198);
        expect(b.setGateZ).toBe(GATE_Z); // cited, never re-derived
        expect(b.reason).toBeNull();
    });

    it('REFUSED when evaluated with sufficient targets but the gate failed', () => {
        const b = classifyConfirmStatus(REFUSED_DC, GATE_Z);
        expect(b.status).toBe('REFUSED');
        expect(b.setExcessZ).toBe(4.2);
        expect(b.nTargets).toBe(40);
        expect(b.confirmed).toBe(0);
        expect(b.reason).toBeNull(); // the N≥10 gate-fail path carries no not_measured
    });

    it('INSUFFICIENT_TARGETS when the pass ran but had too few forced targets (N<10)', () => {
        const b = classifyConfirmStatus(INSUFFICIENT_DC, GATE_Z);
        expect(b.status).toBe('INSUFFICIENT_TARGETS');
        expect(b.nTargets).toBe(8);
        expect(b.setExcessZ).toBeNull();
        expect(b.reason).toContain('Too few candidates');
    });

    it('NOT_RUN when the confirmation pass was skipped wholesale (examined 0)', () => {
        const b = classifyConfirmStatus(ABSENT_DC, GATE_Z);
        expect(b.status).toBe('NOT_RUN');
        expect(b.nTargets).toBe(0);
        expect(b.reason).toContain('No coherent native science buffer');
    });

    it('NOT_RUN when deep_confirmed is null or undefined', () => {
        expect(classifyConfirmStatus(null, GATE_Z).status).toBe('NOT_RUN');
        expect(classifyConfirmStatus(undefined, GATE_Z).status).toBe('NOT_RUN');
        const b = classifyConfirmStatus(null, GATE_Z);
        expect(b.setExcessZ).toBeNull();
        expect(b.nTargets).toBe(0);
        expect(b.setGateZ).toBe(GATE_Z);
    });

    it('does NOT re-derive the gate: setGateZ is echoed from the argument verbatim', () => {
        expect(classifyConfirmStatus(CONFIRMED_DC, 99).setGateZ).toBe(99);
    });
});

// ── (3) tier labels ──────────────────────────────────────────────────────────

describe('confirmTierLabel — user-facing tier copy', () => {
    it('maps each state to its exact phrase', () => {
        expect(confirmTierLabel('CONFIRMED')).toBe('SOLVED — CONFIRMED');
        expect(confirmTierLabel('REFUSED')).toBe('SOLVED — UNCONFIRMED (verification refused)');
        expect(confirmTierLabel('INSUFFICIENT_TARGETS')).toBe(
            'SOLVED — UNCONFIRMED (verification unavailable: too few reference stars)');
        expect(confirmTierLabel('NOT_RUN')).toBe('SOLVED — UNCONFIRMED (verification unavailable)');
    });
});

// ── (4)-(6) receipt inclusion + null-on-absence + serializer survival ────────

function solution(extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        odds: 1, confidence: 0.9, num_stars: 0, matched_stars: [],
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

function receiptFor(sol: PlateSolution | null): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution: sol, planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, imageWidth: 1000, imageHeight: 1000,
    };
    return buildReceipt(i);
}

describe('buildReceipt — confirm_status inclusion', () => {
    it('CONFIRMED solve surfaces confirm_status with the cited set-gate Z', () => {
        const r = receiptFor(solution({ deep_confirmed: CONFIRMED_DC }));
        expect(r.confirm_status).not.toBeNull();
        expect(r.confirm_status.status).toBe('CONFIRMED');
        expect(r.confirm_status.nTargets).toBe(205);
        expect(r.confirm_status.setGateZ).toBe(GATE_Z);
    });

    it('too-few-targets solve surfaces INSUFFICIENT_TARGETS with the target count', () => {
        const r = receiptFor(solution({ deep_confirmed: INSUFFICIENT_DC }));
        expect(r.confirm_status.status).toBe('INSUFFICIENT_TARGETS');
        expect(r.confirm_status.nTargets).toBe(8);
    });

    it('solve WITHOUT a confirmation block surfaces an explicit NOT_RUN (absence made visible)', () => {
        const r = receiptFor(solution({ deep_confirmed: undefined }));
        expect(r.confirm_status).not.toBeNull();
        expect(r.confirm_status.status).toBe('NOT_RUN');
        expect(r.confirm_status.nTargets).toBe(0);
    });

    it('NO solve → confirm_status is null (honest-or-absent, nothing to confirm)', () => {
        const r = receiptFor(null);
        expect(r.confirm_status).toBeNull();
    });

    it('survives the receipt serializer as plain data', () => {
        const r = receiptFor(solution({ deep_confirmed: REFUSED_DC }));
        const round = JSON.parse(serializeReceipt(r));
        expect(round.confirm_status.status).toBe('REFUSED');
        expect(round.confirm_status.setExcessZ).toBe(4.2);
        expect(round.confirm_status.setGateZ).toBe(GATE_Z);
    });
});
