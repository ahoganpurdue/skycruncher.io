import { describe, it, expect } from 'vitest';
import type { CaptureEnvelope } from '../events/capture_record';
import {
    aggregateCaptureRuns,
    parseCaptureJsonl,
} from '../events/capture_aggregate';
import type { PipelineEvent } from '../events/pipeline_events';
import {
    FLOW_NODES,
    FLOW_EDGES,
    NODE_BY_ID,
    nodeBox,
    edgePathD,
    computeLiveStatus,
    buildNodeTooltip,
    buildEdgeTooltip,
    statFor,
    usedRuntimes,
    fmtMs,
    layoutDims,
    orientationForAspect,
    liveStatusFromReplay,
    type Orientation,
} from '../ui/widgets/widgets/flowchart_model';

/**
 * CAPTURE AGGREGATE + FLOWCHART MODEL — the ★ solve-flowchart wave-2 substrate.
 * Covers per-stage rollup, the owner-mandated content-hash dedup (repeat runs of
 * one frame count once; null sha never merges), successful-solve timing scoping,
 * LAW-3 NOT MEASURED honesty, and the pure DAG geometry / tooltip builders.
 */

let seq = 0;
function env(o: Partial<CaptureEnvelope> & { stage_id: string }): CaptureEnvelope {
    seq += 1;
    return {
        run_id: o.run_id ?? 'runA',
        frame_sha: o.frame_sha ?? null,
        stage_id: o.stage_id,
        seq: o.seq ?? seq,
        t_start: o.t_start ?? 0,
        t_end: o.t_end ?? 1,
        ms: o.ms ?? 1,
        ok: o.ok ?? true,
        verdict: o.verdict ?? null,
        counts: o.counts ?? {},
        warnings: o.warnings ?? [],
        payload_ref: o.payload_ref ?? null,
    };
}

/** A minimal successful run (reaches integrate ok). */
function successfulRun(runId: string, sha: string | null, solveMs: number): CaptureEnvelope[] {
    return [
        env({ run_id: runId, frame_sha: sha, stage_id: 'load', t_end: 1 }),
        env({ run_id: runId, frame_sha: sha, stage_id: 'solve.quad_wasm', ms: solveMs, verdict: 'PASS', counts: { matched: 272 }, payload_ref: 'solution', t_end: 2 }),
        env({ run_id: runId, frame_sha: sha, stage_id: 'integrate', ok: true, t_end: 3 }),
    ];
}

describe('aggregateCaptureRuns', () => {
    it('empty input → honest empty aggregate', () => {
        const agg = aggregateCaptureRuns([]);
        expect(agg.frame_count).toBe(0);
        expect(agg.run_count).toBe(0);
        expect(agg.successful_frames).toBe(0);
        expect(Object.keys(agg.stages)).toHaveLength(0);
    });

    it('single successful run rolls up per-stage stats + timing', () => {
        const agg = aggregateCaptureRuns([successfulRun('runA', 'sha1', 990)]);
        expect(agg.frame_count).toBe(1);
        expect(agg.run_count).toBe(1);
        expect(agg.successful_frames).toBe(1);
        const solve = agg.stages['solve.quad_wasm'];
        expect(solve.reached).toBe(1);
        expect(solve.passed).toBe(1);
        expect(solve.failed).toBe(0);
        expect(solve.verdict).toBe('PASS');
        expect(solve.counts.matched).toBe(272);
        expect(solve.payload_ref).toBe('solution');
        expect(solve.min_ms).toBe(990);
        expect(solve.avg_ms).toBe(990);
        expect(solve.max_ms).toBe(990);
        expect(solve.timing_samples).toBe(1);
    });

    it('DEDUP: repeat runs of one frame count once (latest wins)', () => {
        // Two runs of the SAME sha; the later run (higher t_end) is authoritative.
        const older = successfulRun('runA', 'shaX', 500).map(e => ({ ...e, t_end: e.t_end }));
        const newer = successfulRun('runB', 'shaX', 800).map(e => ({ ...e, t_end: e.t_end + 100 }));
        const agg = aggregateCaptureRuns([older, newer]);
        expect(agg.run_count).toBe(2);       // raw runs
        expect(agg.frame_count).toBe(1);     // deduped by content hash
        expect(agg.unhashed_count).toBe(0);
        // Timing reflects the LATEST run only (800), not a blend with 500.
        expect(agg.stages['solve.quad_wasm'].timing_samples).toBe(1);
        expect(agg.stages['solve.quad_wasm'].min_ms).toBe(800);
    });

    it('null-sha runs are NEVER deduped (counted distinct + flagged)', () => {
        const a = successfulRun('runA', null, 100);
        const b = successfulRun('runB', null, 200);
        const agg = aggregateCaptureRuns([a, b]);
        expect(agg.frame_count).toBe(2);
        expect(agg.unhashed_count).toBe(2);
        // two distinct frames contribute two timing samples
        expect(agg.stages['solve.quad_wasm'].timing_samples).toBe(2);
        expect(agg.stages['solve.quad_wasm'].min_ms).toBe(100);
        expect(agg.stages['solve.quad_wasm'].max_ms).toBe(200);
    });

    it('a stage that fails, in a run that never completes, has no timing sample', () => {
        const failing: CaptureEnvelope[] = [
            env({ run_id: 'runF', frame_sha: 'shaF', stage_id: 'load', t_end: 1 }),
            env({ run_id: 'runF', frame_sha: 'shaF', stage_id: 'solve', ok: false, verdict: 'FAIL', ms: 42, t_end: 2 }),
            // no integrate → run did not complete
        ];
        const agg = aggregateCaptureRuns([failing]);
        expect(agg.successful_frames).toBe(0);
        const solve = agg.stages['solve'];
        expect(solve.reached).toBe(1);
        expect(solve.failed).toBe(1);
        expect(solve.passed).toBe(0);
        // LAW 3: no successful-solve sample ⇒ NOT MEASURED timing (null), never 42.
        expect(solve.timing_samples).toBe(0);
        expect(solve.min_ms).toBeNull();
        expect(solve.avg_ms).toBeNull();
        expect(solve.max_ms).toBeNull();
    });

    it('multi-frame timing spans min/avg/max across distinct frames', () => {
        const agg = aggregateCaptureRuns([
            successfulRun('r1', 'sA', 100),
            successfulRun('r2', 'sB', 300),
        ]);
        expect(agg.frame_count).toBe(2);
        const s = agg.stages['solve.quad_wasm'];
        expect(s.min_ms).toBe(100);
        expect(s.max_ms).toBe(300);
        expect(s.avg_ms).toBe(200);
        expect(s.timing_samples).toBe(2);
    });
});

describe('parseCaptureJsonl', () => {
    it('parses valid lines and skips blank / malformed ones', () => {
        const jsonl = [
            JSON.stringify(env({ stage_id: 'load' })),
            '',
            '   ',
            '{not valid json',
            JSON.stringify(env({ stage_id: 'solve' })),
        ].join('\n');
        const rows = parseCaptureJsonl(jsonl);
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.stage_id)).toEqual(['load', 'solve']);
    });
});

describe('flowchart_model — DAG structure', () => {
    it('every edge endpoint resolves to a real node', () => {
        for (const e of FLOW_EDGES) {
            expect(NODE_BY_ID[e.from], `edge from ${e.from}`).toBeDefined();
            expect(NODE_BY_ID[e.to], `edge to ${e.to}`).toBeDefined();
        }
    });

    it('exposes the solve-branch fan and the calibrate umbrella children', () => {
        const ids = new Set(FLOW_NODES.map(n => n.id));
        for (const id of ['solve.quad_wasm', 'solve.uw_sweep', 'solve.uw_escalation']) expect(ids.has(id)).toBe(true);
        for (const id of ['m7_refine', 'render_apply_sip', 'spcc', 'psf_field', 'psf_attribution', 'bc_measure', 'bc_rematch', 'forced_confirm']) {
            expect(ids.has(id)).toBe(true);
        }
        expect(usedRuntimes()).toContain('wasm');
        expect(usedRuntimes()).toContain('typescript');
    });

    it('geometry: node boxes and edge paths are well-formed', () => {
        for (const n of FLOW_NODES) {
            const b = nodeBox(n);
            expect(b.w).toBeGreaterThan(0);
            expect(b.h).toBeGreaterThan(0);
            expect(b.cx).toBe(b.x + b.w / 2);
        }
        for (const e of FLOW_EDGES) {
            expect(edgePathD(e).startsWith('M')).toBe(true);
        }
    });
});

describe('flowchart_model — orientation (container-aware layout)', () => {
    it('orientationForAspect: landscape/square → horizontal, portrait → vertical, degenerate → horizontal', () => {
        expect(orientationForAspect(1200, 400)).toBe('horizontal'); // landscape pane
        expect(orientationForAspect(500, 500)).toBe('horizontal');  // square defaults landscape
        expect(orientationForAspect(360, 720)).toBe('vertical');    // phone / portrait
        expect(orientationForAspect(0, 0)).toBe('horizontal');      // degenerate → default
        expect(orientationForAspect(NaN, 100)).toBe('horizontal');
        expect(orientationForAspect(-10, 100)).toBe('horizontal');
    });

    it('horizontal is the DEFAULT and is wider than tall; vertical is taller than wide', () => {
        const h = layoutDims('horizontal');
        const v = layoutDims('vertical');
        expect(layoutDims()).toEqual(h);                 // default === horizontal
        expect(h.width).toBeGreaterThan(h.height);
        expect(v.height).toBeGreaterThan(v.width);
    });

    it.each(['horizontal', 'vertical'] as const)('geometry well-formed + inside the viewBox (%s)', (o: Orientation) => {
        const dims = layoutDims(o);
        for (const n of FLOW_NODES) {
            const b = nodeBox(n, o);
            expect(b.w).toBeGreaterThan(0);
            expect(b.h).toBeGreaterThan(0);
            expect(b.cx).toBe(b.x + b.w / 2);
            expect(b.cy).toBe(b.y + b.h / 2);
            expect(b.x).toBeGreaterThanOrEqual(0);
            expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.x + b.w).toBeLessThanOrEqual(dims.width);
            expect(b.y + b.h).toBeLessThanOrEqual(dims.height);
        }
        for (const e of FLOW_EDGES) {
            expect(edgePathD(e, o).startsWith('M')).toBe(true);
        }
    });

    it('horizontal: spine on one top row; solve fan + calibrate umbrella stack below their parent column', () => {
        const spineYs = new Set(FLOW_NODES.filter(n => n.col === 0).map(n => nodeBox(n, 'horizontal').y));
        expect(spineYs.size).toBe(1); // the whole backbone shares one horizontal row
        const spineY = [...spineYs][0];

        const solveX = nodeBox(NODE_BY_ID['solve'], 'horizontal').x;
        const fan = ['solve.quad_wasm', 'solve.uw_sweep', 'solve.uw_escalation'].map(id => nodeBox(NODE_BY_ID[id], 'horizontal'));
        for (const b of fan) expect(b.x).toBe(solveX);            // aligned under solve
        expect(fan[0].y).toBeGreaterThan(spineY);                 // hang below the spine
        for (let i = 1; i < fan.length; i++) expect(fan[i].y).toBeGreaterThan(fan[i - 1].y); // stacked

        const calX = nodeBox(NODE_BY_ID['calibrate'], 'horizontal').x;
        for (const id of ['m7_refine', 'spcc', 'psf_field', 'bc_measure', 'forced_confirm']) {
            expect(nodeBox(NODE_BY_ID[id], 'horizontal').x).toBe(calX); // umbrella column
        }
    });
});

describe('flowchart_model — replay-frame box lighting', () => {
    it('liveStatusFromReplay: pending→idle, active→active, complete ok→done, complete !ok→failed', () => {
        const map = liveStatusFromReplay([
            { stageId: 'load', phase: 'complete', ok: true },
            { stageId: 'solve', phase: 'complete', ok: false },
            { stageId: 'calibrate', phase: 'active', ok: null },
            { stageId: 'psf', phase: 'pending', ok: null },
        ]);
        expect(map['load']).toBe('done');
        expect(map['solve']).toBe('failed');
        expect(map['calibrate']).toBe('active');
        expect(map['psf']).toBe('idle');
        expect(map['integrate']).toBeUndefined(); // absent stage ⇒ idle by absence
    });

    it('empty frame ⇒ empty map (honest: no stage lit)', () => {
        expect(liveStatusFromReplay([])).toEqual({});
    });
});

describe('flowchart_model — live status + tooltips', () => {
    const bus = (kinds: PipelineEvent[]): PipelineEvent[] => kinds;
    function ev(kind: string, extra: Record<string, unknown>): PipelineEvent {
        return { kind, t: 0, seq: seq++, ...extra } as unknown as PipelineEvent;
    }

    it('computeLiveStatus: active (open), done (ok), failed (not ok), scoped to current run', () => {
        const events = bus([
            ev('run_started', { mode: 'wizard' }),
            ev('stage_started', { stage: 'load', label: 'Load' }),
            ev('stage_finished', { stage: 'load', ok: true, ms: 2 }),
            ev('stage_started', { stage: 'solve', label: 'Solve' }),
            ev('stage_finished', { stage: 'solve', ok: false, ms: 5 }),
            ev('stage_started', { stage: 'calibrate', label: 'Calibrate' }), // still open
        ]);
        const st = computeLiveStatus(events);
        expect(st['load']).toBe('done');
        expect(st['solve']).toBe('failed');
        expect(st['calibrate']).toBe('active');
        expect(st['integrate']).toBeUndefined(); // never seen ⇒ idle by absence
    });

    it('buildNodeTooltip: measured stage shows captured data + enabled widgets', () => {
        const agg = aggregateCaptureRuns([successfulRun('r', 'sha', 990)]);
        const spec = NODE_BY_ID['solve'];
        const t = buildNodeTooltip(spec, statFor(agg, 'solve.quad_wasm')); // stat has data
        expect(t.measured).toBe(true);
        expect(t.captured.some(l => l.includes('verdict: PASS'))).toBe(true);
        expect(t.enables).toContain('solve_summary');
    });

    it('buildNodeTooltip: unmeasured stage is honestly NOT MEASURED', () => {
        const agg = aggregateCaptureRuns([]);
        const spec = NODE_BY_ID['solve.uw_escalation'];
        const t = buildNodeTooltip(spec, statFor(agg, spec.id));
        expect(t.measured).toBe(false);
        expect(t.captured).toContain('NOT MEASURED');
    });

    it('buildEdgeTooltip: measured flow % + NOT MEASURED when absent', () => {
        const agg = aggregateCaptureRuns([successfulRun('r', 'sha', 990)]);
        const measured = buildEdgeTooltip(NODE_BY_ID['solve.quad_wasm'], statFor(agg, 'solve.quad_wasm'));
        expect(measured.measured).toBe(true);
        expect(measured.flow).toContain('pass-through 1');
        const absent = buildEdgeTooltip(NODE_BY_ID['psf'], statFor(agg, 'psf'));
        expect(absent.measured).toBe(false);
        expect(absent.timing).toContain('NOT MEASURED');
    });

    it('fmtMs formats honestly (dash for null)', () => {
        expect(fmtMs(null)).toBe('—');
        expect(fmtMs(990.6)).toBe('991');
        expect(fmtMs(2.5)).toBe('2.5');
    });
});
