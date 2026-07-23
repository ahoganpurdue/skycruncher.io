import { describe, it, expect } from 'vitest';
import {
    runOneFile,
    processQueue,
    deriveRunId,
    type RunnerSession,
    type RunnerDeps,
} from '../ui/dashboard/solve_queue/queue_runner';
import { createQueueItem, type QueueItem } from '../ui/dashboard/solve_queue/queue_state';

// ── a fake event bus that records emits + fans out to subscribers ──
function makeFakeBus() {
    const subs = new Set<(e: any) => void>();
    const emitted: any[] = [];
    let ctx: { runId?: string; frameSha?: string | null } = {};
    return {
        setRunContext: (c: { runId?: string; frameSha?: string | null }) => { ctx = { ...ctx, ...c }; },
        subscribe: (fn: (e: any) => void) => { subs.add(fn); return () => subs.delete(fn); },
        emit: (e: any) => { emitted.push(e); for (const fn of subs) fn(e); return e; },
        _emitted: emitted,
        _ctx: () => ctx,
    };
}

const SEESTAR_SOLUTION = {
    ra_hours: 11.341253475172621,
    dec_degrees: 13.0,
    pixel_scale: 3.6776147325019153,
    confidence: 0.83108935,
    matched_stars: { length: 272 },
};

// Fake session that solves: mirrors the real step order + emits stage_started
// and (on the success path) run_finished{ok:true} via step6.
class SolvingSession implements RunnerSession {
    events = makeFakeBus();
    solution: any = null;
    status = '';
    sourceFormat = 'FITS';
    async step1_Load() { this.events.emit({ kind: 'run_started' }); this.events.emit({ kind: 'stage_started', stage: 'load', label: 'Load' }); }
    async step2_Extract() { this.events.emit({ kind: 'stage_started', stage: 'extract', label: 'Extract' }); }
    async step3_Metrology() { this.events.emit({ kind: 'stage_started', stage: 'metrology', label: 'Metrology' }); }
    async step4_Solve() { this.events.emit({ kind: 'stage_started', stage: 'solve', label: 'Solve' }); this.solution = SEESTAR_SOLUTION; }
    async step5_Calibrate() { if (!this.solution) throw new Error('Step 4 (Solve) must be complete before calibration.'); }
    async step6_Integrate() { this.events.emit({ kind: 'run_finished', ok: true }); }
}

// Fake session that finds no lock: solution stays null, step4 sets the honest
// status string (real behavior); step5 would throw but the runner gates on it.
class FailingSession implements RunnerSession {
    events = makeFakeBus();
    solution: any = null;
    status = '';
    sourceFormat = 'FITS';
    async step1_Load() { this.events.emit({ kind: 'run_started' }); }
    async step2_Extract() {}
    async step3_Metrology() {}
    async step4_Solve() { this.status = 'Plate solve failed - no geometric lock.'; }
    async step5_Calibrate() { throw new Error('Step 4 (Solve) must be complete before calibration.'); }
    async step6_Integrate() {}
}

// Fake session where a stage throws (e.g. a corrupt decode).
class ThrowingSession implements RunnerSession {
    events = makeFakeBus();
    solution: any = null;
    status = '';
    sourceFormat = 'CR2';
    async step1_Load() { this.events.emit({ kind: 'run_started' }); }
    async step2_Extract() { throw new Error('decode boom'); }
    async step3_Metrology() {}
    async step4_Solve() {}
    async step5_Calibrate() {}
    async step6_Integrate() {}
}

const shaOf = async (_b: ArrayBuffer) => 'abcdef0123456789';

describe('solve queue — sequential runner', () => {
    it('deriveRunId keys on the frame sha, else the clock', () => {
        expect(deriveRunId('abcdef0123456789', () => 999)).toBe('queue_abcdef012345');
        expect(deriveRunId(null, () => 999)).toBe('queue_999');
    });

    it('a solved file yields the measured result + run_finished{ok:true} (replayable)', async () => {
        const session = new SolvingSession();
        const deps: RunnerDeps = { createSession: () => session, computeSha: shaOf };
        const stages: string[] = [];
        const outcome = await runOneFile(new ArrayBuffer(8), deps, { onStage: (n) => stages.push(n) });

        expect(outcome.status).toBe('solved');
        expect(outcome.result?.matched).toBe(272);
        expect(outcome.result?.raHours).toBe(11.341253475172621);
        expect(outcome.result?.scaleArcsecPerPx).toBe(3.6776147325019153);
        expect(outcome.runId).toBe('queue_abcdef012345');
        expect(outcome.frameSha).toBe('abcdef0123456789');
        expect(outcome.format).toBe('FITS');
        // run context stamped BEFORE step1 (no async back-fill gap).
        expect(session.events._ctx()).toEqual({ runId: 'queue_abcdef012345', frameSha: 'abcdef0123456789' });
        // honest real stage labels surfaced (no fabricated percent).
        expect(stages).toEqual(['Load', 'Extract', 'Metrology', 'Solve']);
        // step6 emitted run_finished{ok:true}; NO synthetic ok:false was added.
        const finishes = session.events._emitted.filter((e) => e.kind === 'run_finished');
        expect(finishes).toEqual([{ kind: 'run_finished', ok: true }]);
    });

    it('a no-lock file fails honestly AND emits a synthetic run_finished{ok:false} (replayable)', async () => {
        const session = new FailingSession();
        const deps: RunnerDeps = { createSession: () => session, computeSha: shaOf };
        const outcome = await runOneFile(new ArrayBuffer(8), deps);

        expect(outcome.status).toBe('failed');
        expect(outcome.result).toBeNull();
        expect(outcome.error).toMatch(/no geometric lock/);
        // The runner emitted run_finished{ok:false} so the partial run is captured.
        const finishes = session.events._emitted.filter((e) => e.kind === 'run_finished');
        expect(finishes).toEqual([{ kind: 'run_finished', ok: false }]);
    });

    it('a thrown stage becomes a failed outcome (never rejects) + run_finished{ok:false}', async () => {
        const session = new ThrowingSession();
        const deps: RunnerDeps = { createSession: () => session, computeSha: shaOf };
        const outcome = await runOneFile(new ArrayBuffer(8), deps);

        expect(outcome.status).toBe('failed');
        expect(outcome.error).toMatch(/decode boom/);
        expect(session.events._emitted.some((e) => e.kind === 'run_finished' && e.ok === false)).toBe(true);
    });

    it('falls back to a clock-derived runId when the sha is unavailable', async () => {
        const session = new SolvingSession();
        const deps: RunnerDeps = { createSession: () => session, computeSha: async () => null, now: () => 4242 };
        const outcome = await runOneFile(new ArrayBuffer(8), deps);
        expect(outcome.runId).toBe('queue_4242');
        expect(outcome.frameSha).toBeNull();
    });

    it('processQueue runs queued files SEQUENTIALLY and leaves unsupported ones untouched', async () => {
        let items: QueueItem[] = [
            createQueueItem('a', 'one.fits', 4, 'drop'),
            createQueueItem('b', 'skip.png', 4, 'drop'),   // unsupported → never run
            createQueueItem('c', 'two.fits', 4, 'drop'),
            createQueueItem('d', 'nolock.fits', 4, 'drop'),
        ];

        // Track concurrency: assert no two sessions run at once.
        let active = 0;
        let maxActive = 0;
        const createSession = (): RunnerSession => {
            const s = new SolvingSession();
            const origSolve = s.step4_Solve.bind(s);
            s.step4_Solve = async () => { active++; maxActive = Math.max(maxActive, active); await origSolve(); active--; };
            return s;
        };
        // 'd' should fail (no lock): route by name via a factory closure.
        const factory = (buf: ArrayBuffer): RunnerSession => buf.byteLength === 999 ? new FailingSession() : createSession();

        const readBuffer = async (it: QueueItem) => new ArrayBuffer(it.name === 'nolock.fits' ? 999 : 8);
        const deps: RunnerDeps = { createSession: factory, computeSha: shaOf };

        let published = 0;
        const final = await processQueue(items, readBuffer, deps, () => { published++; });

        const byId = Object.fromEntries(final.map((it) => [it.id, it]));
        expect(byId['a'].status).toBe('solved');
        expect(byId['b'].status).toBe('unsupported'); // untouched
        expect(byId['c'].status).toBe('solved');
        expect(byId['d'].status).toBe('failed');
        expect(byId['d'].error).toMatch(/no geometric lock/);
        expect(maxActive).toBe(1); // NEVER parallel
        expect(published).toBeGreaterThan(0);
        // solved rows carry a runId (replayable capture record).
        expect(byId['a'].runId).toBe('queue_abcdef012345');
    });

    it('processQueue can be cancelled between files (never mid-solve)', async () => {
        let items: QueueItem[] = [
            createQueueItem('a', 'one.fits', 4, 'drop'),
            createQueueItem('b', 'two.fits', 4, 'drop'),
        ];
        const deps: RunnerDeps = { createSession: () => new SolvingSession(), computeSha: shaOf };
        let ran = 0;
        const readBuffer = async () => { ran++; return new ArrayBuffer(8); };
        // Stop after the first file completes.
        const final = await processQueue(items, readBuffer, deps, () => {}, () => ran >= 1);
        // 'a' processed, 'b' left queued (cancel honored between files).
        const byId = Object.fromEntries(final.map((it) => [it.id, it]));
        expect(byId['a'].status).toBe('solved');
        expect(byId['b'].status).toBe('queued');
    });
});
