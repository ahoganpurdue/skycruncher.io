import { describe, it, expect } from 'vitest';
import { PipelineEventBus } from '../events/pipeline_events';
import { buildCaptureRecord } from '../events/capture_record';
import { aggregateCaptureRuns } from '../events/capture_aggregate';
import { emitSolveBranch } from '../pipeline/stages/solve';
import type { SolveResult } from '../types/Main_types';

/**
 * A3 — per-branch solve timing honesty (flowchart wave-1 caveat closure).
 *
 * `emitSolveBranch` must surface REAL wall-ms for EVERY solve branch that was
 * actually ATTEMPTED — the winner AND the losers — and stay silent for a branch
 * never tried (LAW 3: honest NOT MEASURED, never a fabricated 0 ms). Timing comes
 * from `diagnostics.branch_timing`, which the solver accrues from its already-
 * measured wall-clocks (wasmTimeMs / sweepMs / escMs).
 */

function fakeResult(o: { success: boolean; solution?: unknown; diagnostics: Record<string, unknown> }): SolveResult {
    return o as unknown as SolveResult;
}

/** Emit branch events into a fresh bus and reduce to the per-stage capture record. */
function collect(result: SolveResult) {
    const bus = new PipelineEventBus();
    bus.emit({ kind: 'run_started', mode: 'wizard' });
    emitSolveBranch(bus, result);
    bus.emit({ kind: 'run_finished', ok: true });
    const record = buildCaptureRecord(bus.getHistory());
    return Object.fromEntries(record.map(e => [e.stage_id, e]));
}

describe('emitSolveBranch — per-branch timing (A3)', () => {
    it('narrow / quad-only solve: only quad_wasm emitted (PASS) with its OWN branch ms', () => {
        const byId = collect(fakeResult({
            success: true,
            solution: { matched_stars: new Array(272).fill({}) } as never,
            diagnostics: {
                solve_time_ms: 1000,
                matches_found: 272,
                forensics: [{ status: 'SUCCESS' }],
                branch_timing: { 'solve.quad_wasm': { ms: 640, attempts: 3 } },
            },
        }));
        expect(byId['solve.quad_wasm'].ok).toBe(true);
        expect(byId['solve.quad_wasm'].verdict).toBe('PASS');
        expect(byId['solve.quad_wasm'].ms).toBe(640);            // branch time, NOT whole-solve 1000
        expect(byId['solve.quad_wasm'].counts.attempts).toBe(3);
        expect(byId['solve.quad_wasm'].counts.matched).toBe(272);
        // Un-attempted branches: ABSENT (honest NOT MEASURED).
        expect(byId['solve.uw_sweep']).toBeUndefined();
        expect(byId['solve.uw_escalation']).toBeUndefined();
    });

    it('ultra-wide sweep win: the LOSING quad branch carries REAL ms (ok=false FAIL), winner PASS', () => {
        const byId = collect(fakeResult({
            success: true,
            solution: { matched_stars: new Array(55).fill({}) } as never,
            diagnostics: {
                solve_time_ms: 42000,
                matches_found: 55,
                forensics: [{ status: 'UW_SWEEP_PEAK' }, { status: 'SUCCESS_UW_SWEEP' }],
                branch_timing: {
                    'solve.quad_wasm': { ms: 1800, attempts: 30 },
                    'solve.uw_sweep': { ms: 5200, attempts: 48 },
                },
            },
        }));
        // Winner.
        expect(byId['solve.uw_sweep'].ok).toBe(true);
        expect(byId['solve.uw_sweep'].verdict).toBe('PASS');
        expect(byId['solve.uw_sweep'].ms).toBe(5200);
        expect(byId['solve.uw_sweep'].counts.matched).toBe(55);
        // Loser — ATTEMPTED, real ms > 0, FAIL (no longer NOT MEASURED).
        expect(byId['solve.quad_wasm'].ok).toBe(false);
        expect(byId['solve.quad_wasm'].verdict).toBe('FAIL');
        expect(byId['solve.quad_wasm'].ms).toBe(1800);
        expect(byId['solve.quad_wasm'].ms).toBeGreaterThan(0);
        expect(byId['solve.quad_wasm'].counts.attempts).toBe(30);
        // Escalation never ran → absent.
        expect(byId['solve.uw_escalation']).toBeUndefined();
    });

    it('aggregate: a LOSING branch on a SUCCESSFUL frame contributes a real timing sample', () => {
        const result = fakeResult({
            success: true,
            solution: { matched_stars: new Array(55).fill({}) } as never,
            diagnostics: {
                solve_time_ms: 42000, matches_found: 55,
                forensics: [{ status: 'SUCCESS_UW_ESCALATED' }],
                branch_timing: {
                    'solve.quad_wasm': { ms: 1800, attempts: 30 },
                    'solve.uw_sweep': { ms: 5200, attempts: 48 },
                    'solve.uw_escalation': { ms: 900, attempts: 2 },
                },
            },
        });
        const bus = new PipelineEventBus();
        bus.emit({ kind: 'run_started', mode: 'wizard' });
        emitSolveBranch(bus, result);
        // Close through integrate so the aggregate treats this as a successful solve.
        bus.emit({ kind: 'stage_started', stage: 'integrate', label: 'Integrate' });
        bus.emit({ kind: 'stage_finished', stage: 'integrate', ok: true, ms: 1 });
        bus.emit({ kind: 'run_finished', ok: true });
        const agg = aggregateCaptureRuns([buildCaptureRecord(bus.getHistory())]);

        // The losing quad branch now HAS a timing sample (was winner-only NOT MEASURED).
        expect(agg.stages['solve.quad_wasm'].timing_samples).toBe(1);
        expect(agg.stages['solve.quad_wasm'].min_ms).toBe(1800);
        expect(agg.stages['solve.quad_wasm'].failed).toBe(1);
        expect(agg.stages['solve.quad_wasm'].passed).toBe(0);
        // Winning escalation branch: PASS + its own timing.
        expect(agg.stages['solve.uw_escalation'].passed).toBe(1);
        expect(agg.stages['solve.uw_escalation'].min_ms).toBe(900);
    });

    it('winner with NO branch sample falls back to whole-solve time (never fabricates a branch ms)', () => {
        const byId = collect(fakeResult({
            success: true,
            solution: { matched_stars: [] } as never,
            diagnostics: {
                solve_time_ms: 777, matches_found: 0,
                forensics: [{ status: 'SUCCESS' }],
                branch_timing: {},                                // unexpected: winner accrued nothing
            },
        }));
        expect(byId['solve.quad_wasm'].ok).toBe(true);
        expect(byId['solve.quad_wasm'].ms).toBe(777);            // whole-solve fallback, honest
    });

    it('failed solve with no branch attempts emits nothing (no fake branches)', () => {
        const bus = new PipelineEventBus();
        emitSolveBranch(bus, fakeResult({
            success: false,
            diagnostics: { solve_time_ms: 90000, matches_found: 0, forensics: [], branch_timing: {} },
        }));
        const stageEvents = bus.getHistory().filter(e => e.kind === 'stage_started' || e.kind === 'stage_finished');
        expect(stageEvents).toHaveLength(0);
    });

    it('failed solve that DID attempt branches surfaces them all as ok=false FAIL with real ms', () => {
        const byId = collect(fakeResult({
            success: false,
            diagnostics: {
                solve_time_ms: 90000, matches_found: 0,
                forensics: [{ status: 'UW_SWEEP_PEAK' }],
                branch_timing: {
                    'solve.quad_wasm': { ms: 2100, attempts: 40 },
                    'solve.uw_sweep': { ms: 6000, attempts: 60 },
                },
            },
        }));
        for (const id of ['solve.quad_wasm', 'solve.uw_sweep']) {
            expect(byId[id].ok).toBe(false);
            expect(byId[id].verdict).toBe('FAIL');
            expect(byId[id].ms).toBeGreaterThan(0);
        }
        expect(byId['solve.uw_escalation']).toBeUndefined();
    });
});
