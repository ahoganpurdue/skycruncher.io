/**
 * Pure scrub-math tests for the ★ Replay Dashboard.
 *
 * The fixture below is a REAL headless SeeStar capture record (the 15-stage
 * run tools/capture writes to test_results/runs/*.jsonl) — nesting included
 * (`solve.quad_wasm` inside `solve`; the `calibrate` umbrella wrapping the
 * post-solve nodes), so the scrub math is exercised against production shape.
 */
import { describe, it, expect } from 'vitest';
import type { CaptureEnvelope } from '../../../events/capture_record';
import {
    deriveReplayFrame,
    runTimeBounds,
    stagePhaseAt,
    clampScrub,
    sliceEventsAtTime,
} from './replay_state';

// A trimmed but faithful slice of a real run (epoch-ms windows preserved).
const REC: CaptureEnvelope[] = [
    { run_id: 'r1', frame_sha: 'abc', stage_id: 'load', seq: 3, t_start: 1000, t_end: 1005, ms: 5, ok: true, verdict: null, counts: {}, warnings: [], payload_ref: null },
    { run_id: 'r1', frame_sha: 'abc', stage_id: 'extract', seq: 9, t_start: 1005, t_end: 2395, ms: 1390, ok: true, verdict: null, counts: {}, warnings: [], payload_ref: null },
    { run_id: 'r1', frame_sha: 'abc', stage_id: 'solve.quad_wasm', seq: 16, t_start: 4377, t_end: 4377, ms: 1643, ok: true, verdict: 'PASS', counts: { matched: 272 }, warnings: [], payload_ref: 'solution' },
    { run_id: 'r1', frame_sha: 'abc', stage_id: 'solve', seq: 21, t_start: 2397, t_end: 4378, ms: 1981, ok: true, verdict: null, counts: {}, warnings: [], payload_ref: null },
    { run_id: 'r1', frame_sha: 'abc', stage_id: 'integrate', seq: 44, t_start: 5456, t_end: 5459, ms: 3, ok: true, verdict: null, counts: {}, warnings: ['clock unset'], payload_ref: null },
];

describe('runTimeBounds', () => {
    it('spans the full record window', () => {
        expect(runTimeBounds(REC)).toEqual({ tStart: 1000, tEnd: 5459, totalMs: 4459 });
    });
    it('is all-zero for an empty record', () => {
        expect(runTimeBounds([])).toEqual({ tStart: 0, tEnd: 0, totalMs: 0 });
    });
});

describe('stagePhaseAt', () => {
    const load = REC[0]; // [1000, 1005]
    it('is pending strictly before the window', () => {
        expect(stagePhaseAt(load, 999)).toBe('pending');
    });
    it('is active at the opening edge (inclusive start)', () => {
        expect(stagePhaseAt(load, 1000)).toBe('active');
        expect(stagePhaseAt(load, 1004)).toBe('active');
    });
    it('is complete at the closing edge (inclusive end)', () => {
        expect(stagePhaseAt(load, 1005)).toBe('complete');
        expect(stagePhaseAt(load, 9999)).toBe('complete');
    });
    it('a zero-width window is complete the instant it is reached, never active', () => {
        const zw = REC[2]; // solve.quad_wasm [4377, 4377]
        expect(stagePhaseAt(zw, 4376)).toBe('pending');
        expect(stagePhaseAt(zw, 4377)).toBe('complete');
    });
});

describe('clampScrub', () => {
    it('clamps into the run window', () => {
        expect(clampScrub(500, { tStart: 1000, tEnd: 5459 })).toBe(1000);
        expect(clampScrub(9999, { tStart: 1000, tEnd: 5459 })).toBe(5459);
        expect(clampScrub(3000, { tStart: 1000, tEnd: 5459 })).toBe(3000);
    });
    it('degenerate window pins to start', () => {
        expect(clampScrub(3000, { tStart: 1000, tEnd: 1000 })).toBe(1000);
    });
});

describe('deriveReplayFrame — state at time t', () => {
    it('t at run start: everything pending except stages opening exactly at start', () => {
        const f = deriveReplayFrame(REC, 1000);
        expect(f.t).toBe(1000);
        expect(f.elapsedMs).toBe(0);
        expect(f.totalMs).toBe(4459);
        // load opens at 1000 (active); the rest are pending.
        const byId = Object.fromEntries(f.stages.map(s => [s.stageId, s.phase]));
        expect(byId.load).toBe('active');
        expect(byId.extract).toBe('pending');
        expect(byId.solve).toBe('pending');
        expect(f.recordSlice.length).toBe(0);
    });

    it('mid-run: completed / active / pending split is honest', () => {
        // t=2000: load complete, extract active (1005..2395), solve pending.
        const f = deriveReplayFrame(REC, 2000);
        const byId = Object.fromEntries(f.stages.map(s => [s.stageId, s.phase]));
        expect(byId.load).toBe('complete');
        expect(byId.extract).toBe('active');
        expect(byId.solve).toBe('pending');
        expect(byId['solve.quad_wasm']).toBe('pending');
        expect(f.completeCount).toBe(1);
        expect(f.activeCount).toBe(1);
        expect(f.pendingCount).toBe(3);
        // recordSlice = only stages with t_end <= 2000 (load).
        expect(f.recordSlice.map(e => e.stage_id)).toEqual(['load']);
    });

    it('verdict/counts/ms are HIDDEN until a stage completes (no fabrication)', () => {
        const f = deriveReplayFrame(REC, 4377); // solve.quad_wasm just completed
        const qw = f.stages.find(s => s.stageId === 'solve.quad_wasm')!;
        expect(qw.phase).toBe('complete');
        expect(qw.verdict).toBe('PASS');
        expect(qw.counts).toEqual({ matched: 272 });
        expect(qw.ms).toBe(1643);
        // `solve` umbrella still active at 4377 (ends 4378) → verdict null, counts empty.
        const solve = f.stages.find(s => s.stageId === 'solve')!;
        expect(solve.phase).toBe('active');
        expect(solve.verdict).toBeNull();
        expect(solve.counts).toEqual({});
        expect(solve.ms).toBeNull();
    });

    it('warnings only surface once the stage completes', () => {
        const before = deriveReplayFrame(REC, 5458).stages.find(s => s.stageId === 'integrate')!;
        expect(before.phase).toBe('active');
        expect(before.warnings).toEqual([]);
        const after = deriveReplayFrame(REC, 5459).stages.find(s => s.stageId === 'integrate')!;
        expect(after.phase).toBe('complete');
        expect(after.warnings).toEqual(['clock unset']);
    });

    it('t at run end: all complete, elapsed == total', () => {
        const f = deriveReplayFrame(REC, 5459);
        expect(f.completeCount).toBe(5);
        expect(f.activeCount).toBe(0);
        expect(f.pendingCount).toBe(0);
        expect(f.elapsedMs).toBe(4459);
        expect(f.recordSlice.length).toBe(5);
    });

    it('clamps out-of-range scrub times', () => {
        expect(deriveReplayFrame(REC, -1e9).t).toBe(1000);
        expect(deriveReplayFrame(REC, 1e12).t).toBe(5459);
    });

    it('sorts stages by wall-clock start, not by seq (nesting order differs)', () => {
        const f = deriveReplayFrame(REC, 5459);
        const order = f.stages.map(s => s.stageId);
        // solve (t_start 2397) precedes solve.quad_wasm (t_start 4377) despite
        // the record listing quad_wasm first (seq 16 < 21).
        expect(order.indexOf('solve')).toBeLessThan(order.indexOf('solve.quad_wasm'));
    });

    it('carries run identity + live flag', () => {
        const f = deriveReplayFrame(REC, 3000, { live: true });
        expect(f.runId).toBe('r1');
        expect(f.frameSha).toBe('abc');
        expect(f.live).toBe(true);
    });

    it('empty record ⇒ zeroed frame, no throw', () => {
        const f = deriveReplayFrame([], 123);
        expect(f.totalMs).toBe(0);
        expect(f.stages).toEqual([]);
        expect(f.recordSlice).toEqual([]);
        expect(f.runId).toBeNull();
    });
});

describe('sliceEventsAtTime', () => {
    const events = [
        { kind: 'run_started', t: 1000, seq: 1 },
        { kind: 'stage_started', t: 1005, seq: 2 },
        { kind: 'stage_finished', t: 2395, seq: 3 },
    ] as any;
    it('keeps only events at or before t', () => {
        expect(sliceEventsAtTime(events, 1005)!.map((e: any) => e.seq)).toEqual([1, 2]);
        expect(sliceEventsAtTime(events, 9999)!.length).toBe(3);
        expect(sliceEventsAtTime(events, 0)!.length).toBe(0);
    });
    it('passes undefined through (no event history available)', () => {
        expect(sliceEventsAtTime(undefined, 100)).toBeUndefined();
    });
});
