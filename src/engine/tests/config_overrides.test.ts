// Unit tests for the CONFIG-AS-ARGUMENT override seam (NEXT_MOVES §11b):
// applyConfigOverrides / getActiveConfigOverrides / snapshotConfig / restoreConfig
// (src/engine/pipeline/constants/pipeline_config.ts).
//
// These are pure singleton-mutation helpers (no wasm/IO). Because they mutate
// the process-global PIPELINE_CONSTANTS, every test snapshots + restores the
// keys it touches so the suite leaves the calibrated config byte-identical
// (the same discipline a real multi-solve-in-process caller must follow).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    PIPELINE_CONSTANTS,
    applyConfigOverrides,
    getActiveConfigOverrides,
    snapshotConfig,
    restoreConfig,
} from '../pipeline/constants/pipeline_config';

const TOUCHED = ['SOLVER_UW_SWEEP_MIN_Z', 'SOLVER_MIN_MATCHES', 'PACKET_VERSION'];

describe('config-as-argument override seam (§11b)', () => {
    let snap: Record<string, unknown>;

    beforeEach(() => {
        snap = snapshotConfig(TOUCHED);
    });
    afterEach(() => {
        // restoreConfig also clears the active-override record → next test is clean.
        restoreConfig(snap);
    });

    it('empty / null / undefined overrides are a strict no-op (config byte-identical)', () => {
        const before = snapshotConfig(TOUCHED);
        expect(applyConfigOverrides(null)).toEqual({ applied: [], rejected: [] });
        expect(applyConfigOverrides(undefined)).toEqual({ applied: [], rejected: [] });
        expect(applyConfigOverrides({})).toEqual({ applied: [], rejected: [] });
        expect(snapshotConfig(TOUCHED)).toEqual(before);
        // No override applied ⇒ receipt stamp stays absent (a calibrated run).
        expect(getActiveConfigOverrides()).toBeNull();
    });

    it('a known override applies to the live constant AND is recorded for the stamp', () => {
        const orig = PIPELINE_CONSTANTS.SOLVER_UW_SWEEP_MIN_Z;
        const res = applyConfigOverrides({ SOLVER_UW_SWEEP_MIN_Z: 4.0 });
        expect(res).toEqual({ applied: ['SOLVER_UW_SWEEP_MIN_Z'], rejected: [] });
        expect(PIPELINE_CONSTANTS.SOLVER_UW_SWEEP_MIN_Z).toBe(4.0);
        expect(PIPELINE_CONSTANTS.SOLVER_UW_SWEEP_MIN_Z).not.toBe(orig);
        // The stamp carries the applied {key:value} (a COPY, not a live ref).
        const active = getActiveConfigOverrides();
        expect(active).toEqual({ SOLVER_UW_SWEEP_MIN_Z: 4.0 });
        active!.SOLVER_UW_SWEEP_MIN_Z = 999;
        expect(getActiveConfigOverrides()).toEqual({ SOLVER_UW_SWEEP_MIN_Z: 4.0 });
    });

    it('restoreConfig reverts the value and clears the active-override record', () => {
        const orig = PIPELINE_CONSTANTS.SOLVER_MIN_MATCHES;
        const capture = snapshotConfig(['SOLVER_MIN_MATCHES']);
        applyConfigOverrides({ SOLVER_MIN_MATCHES: 6 });
        expect(PIPELINE_CONSTANTS.SOLVER_MIN_MATCHES).toBe(6);
        expect(getActiveConfigOverrides()).not.toBeNull();

        restoreConfig(capture);
        expect(PIPELINE_CONSTANTS.SOLVER_MIN_MATCHES).toBe(orig);
        expect(getActiveConfigOverrides()).toBeNull();
    });

    it('an unknown key is rejected + warned, never silently created', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = applyConfigOverrides({ TOTALLY_NOT_A_KNOB: 42 });
        expect(res).toEqual({ applied: [], rejected: ['TOTALLY_NOT_A_KNOB'] });
        expect(Object.prototype.hasOwnProperty.call(PIPELINE_CONSTANTS, 'TOTALLY_NOT_A_KNOB')).toBe(false);
        expect(getActiveConfigOverrides()).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('a type-mismatched value is rejected (no garbage into a numeric knob)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const orig = PIPELINE_CONSTANTS.SOLVER_MIN_MATCHES;
        const res = applyConfigOverrides({ SOLVER_MIN_MATCHES: 'lots' as unknown as number });
        expect(res.rejected).toContain('SOLVER_MIN_MATCHES');
        expect(res.applied).toEqual([]);
        expect(PIPELINE_CONSTANTS.SOLVER_MIN_MATCHES).toBe(orig);
        warn.mockRestore();
    });

    it('mixed known + unknown: applies the good, rejects the bad, records only the good', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = applyConfigOverrides({ SOLVER_UW_SWEEP_MIN_Z: 4.0, BOGUS: 1 });
        expect(res.applied).toEqual(['SOLVER_UW_SWEEP_MIN_Z']);
        expect(res.rejected).toEqual(['BOGUS']);
        expect(getActiveConfigOverrides()).toEqual({ SOLVER_UW_SWEEP_MIN_Z: 4.0 });
        warn.mockRestore();
    });
});
