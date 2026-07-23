/**
 * HORIZON EDITOR — pure editing logic + observer-testimony record.
 *
 * Pins: (1) the reducers (init/move/remove/insert) are immutable and record a
 * node-level delta per edit; (2) the geometry helpers (hit-test, nearest-segment)
 * work against a supplied projection; (3) buildHorizonCorrection is honest-or-
 * absent (null when nothing was corrected) and assembles {auto, deltas, corrected}
 * with a deterministic captured_at; (4) the NEVER-OVERWRITE guarantee — the
 * recorded automatic snapshot is an independent copy that later edits cannot reach.
 */
import { describe, it, expect } from 'vitest';
import type { HorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';
import {
    initHorizonEdit,
    moveHorizonNode,
    removeHorizonNode,
    insertHorizonNode,
    hitTestHorizonNode,
    nearestHorizonSegment,
    buildHorizonCorrection,
    type HorizonEditState,
    type HorizonProject,
} from '../pipeline/m4_signal_detect/horizon_editor';

const AT = '2026-07-11T00:00:00.000Z';
const IDENTITY: HorizonProject = (nx, ny) => ({ x: nx, y: ny });

function envelope(): HorizonEnvelope {
    return {
        points: [
            { x: 0, y: 100, measured: true },
            { x: 100, y: 100, measured: true },
            { x: 200, y: 100, measured: false },
            { x: 300, y: 100, measured: true },
        ],
        coverage: 0.75,
        hasTerrainEvidence: true,
    };
}

// ── (1) reducers ──────────────────────────────────────────────────────────

describe('initHorizonEdit', () => {
    it('deep-copies the auto points and starts with no deltas (source untouched)', () => {
        const env = envelope();
        const s = initHorizonEdit(env);
        expect(s.deltas).toEqual([]);
        expect(s.points).toHaveLength(4);
        expect(s.points).not.toBe(env.points);
        expect(s.points[0]).not.toBe(env.points[0]);
        s.points[0].y = 999;
        expect(env.points[0].y).toBe(100); // the envelope is never mutated
    });
});

describe('moveHorizonNode', () => {
    it('moves a node and records a move delta with from/to; input state untouched', () => {
        const s0 = initHorizonEdit(envelope());
        const s1 = moveHorizonNode(s0, 1, 150, 220);
        expect(s1.points[1]).toEqual({ x: 150, y: 220, measured: true });
        expect(s1.deltas).toEqual([{ kind: 'move', from: { x: 100, y: 100 }, to: { x: 150, y: 220 } }]);
        // immutability of the prior state
        expect(s0.points[1]).toEqual({ x: 100, y: 100, measured: true });
        expect(s0.deltas).toHaveLength(0);
    });

    it('ignores an out-of-range index (returns the same state)', () => {
        const s0 = initHorizonEdit(envelope());
        expect(moveHorizonNode(s0, 99, 0, 0)).toBe(s0);
        expect(moveHorizonNode(s0, -1, 0, 0)).toBe(s0);
    });
});

describe('removeHorizonNode', () => {
    it('drops a node and records a remove delta', () => {
        const s1 = removeHorizonNode(initHorizonEdit(envelope()), 2);
        expect(s1.points.map(p => p.x)).toEqual([0, 100, 300]);
        expect(s1.deltas).toEqual([{ kind: 'remove', from: { x: 200, y: 100 } }]);
    });

    it('refuses to drop below 2 points (a polyline needs 2)', () => {
        const s: HorizonEditState = {
            points: [{ x: 0, y: 10, measured: true }, { x: 10, y: 10, measured: true }],
            deltas: [],
        };
        expect(removeHorizonNode(s, 0)).toBe(s);
    });
});

describe('insertHorizonNode', () => {
    it('inserts an observer-asserted (unmeasured) node and records an add delta', () => {
        const s1 = insertHorizonNode(initHorizonEdit(envelope()), 2, 150, 180);
        expect(s1.points).toHaveLength(5);
        expect(s1.points[2]).toEqual({ x: 150, y: 180, measured: false });
        expect(s1.deltas).toEqual([{ kind: 'add', to: { x: 150, y: 180 } }]);
    });

    it('clamps the insertion index into range', () => {
        const s1 = insertHorizonNode(initHorizonEdit(envelope()), 99, 400, 90);
        expect(s1.points[s1.points.length - 1]).toEqual({ x: 400, y: 90, measured: false });
    });
});

// ── (2) geometry helpers ────────────────────────────────────────────────────

describe('hitTestHorizonNode', () => {
    it('returns the nearest node within radius, else -1', () => {
        const pts = envelope().points;
        expect(hitTestHorizonNode(pts, IDENTITY, 102, 103, 10)).toBe(1); // near (100,100)
        expect(hitTestHorizonNode(pts, IDENTITY, 150, 100, 10)).toBe(-1); // between nodes, too far
    });
});

describe('nearestHorizonSegment', () => {
    it('returns the closest on-line point in NATIVE coords with an insert index', () => {
        const pts = envelope().points; // all y=100
        const seg = nearestHorizonSegment(pts, IDENTITY, 150, 130, 40);
        expect(seg).not.toBeNull();
        expect(seg!.index).toBe(2); // between points[1] and points[2] → insert before index 2
        expect(seg!.x).toBeCloseTo(150, 5);
        expect(seg!.y).toBeCloseTo(100, 5); // projects onto the horizontal line
    });

    it('returns null beyond maxDist', () => {
        expect(nearestHorizonSegment(envelope().points, IDENTITY, 150, 300, 40)).toBeNull();
    });
});

// ── (3)-(4) testimony record ────────────────────────────────────────────────

describe('buildHorizonCorrection', () => {
    it('honest-or-absent: null when nothing was corrected (no deltas)', () => {
        const env = envelope();
        expect(buildHorizonCorrection(env, initHorizonEdit(env), { width: 300, height: 200 }, AT)).toBeNull();
    });

    it('assembles {auto, deltas, corrected} with provenance + deterministic captured_at', () => {
        const env = envelope();
        const s = moveHorizonNode(initHorizonEdit(env), 0, 5, 150);
        const rec = buildHorizonCorrection(env, s, { width: 300, height: 200 }, AT);
        expect(rec).not.toBeNull();
        expect(rec!.provenance).toBe('user');
        expect(rec!.captured_at).toBe(AT);
        expect(rec!.image).toEqual({ width: 300, height: 200 });
        expect(rec!.deltas).toHaveLength(1);
        expect(rec!.corrected[0]).toEqual({ x: 5, y: 150, measured: true });
        expect(rec!.auto.coverage).toBe(0.75);
        expect(rec!.auto.hasTerrainEvidence).toBe(true);
        expect(rec!.auto.points[0]).toEqual({ x: 0, y: 100, measured: true });
    });

    it('NEVER-OVERWRITE: the auto snapshot is an independent copy later edits cannot reach', () => {
        const env = envelope();
        const s = moveHorizonNode(initHorizonEdit(env), 0, 5, 150);
        const rec = buildHorizonCorrection(env, s, { width: 300, height: 200 }, AT)!;
        // mutate the corrected polyline AND the source envelope after capture
        rec.corrected[0].y = -1;
        env.points[0].y = -2;
        // the recorded automatic estimate stays exactly as it was captured
        expect(rec.auto.points[0].y).toBe(100);
    });

    it('captured_at falls back to a valid ISO stamp when not injected', () => {
        const env = envelope();
        const s = removeHorizonNode(initHorizonEdit(env), 0);
        const rec = buildHorizonCorrection(env, s, { width: 300, height: 200 })!;
        expect(Number.isNaN(Date.parse(rec.captured_at))).toBe(false);
    });
});
