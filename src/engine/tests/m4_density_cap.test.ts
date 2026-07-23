import { describe, it, expect } from 'vitest';
import { applyDensityCap, densityCapCount } from '../pipeline/m4_signal_detect/detection_guard';

/**
 * M4 density-guard CAP mode (DETECT_DENSITY_GUARD_MODE=1) — the pure selection
 * logic. When ON, the guard keeps the top-N-by-flux deep candidates at the
 * density boundary (N = densityCapCount) and stamps the faint tail HIGH_DENSITY
 * instead of throwing. This locks that contract; the throw path stays default.
 */
describe('M4 density-cap selection', () => {
    it('keeps the brightest N and drops the faint tail when M > N', () => {
        const w = 50, h = 50;
        const n = densityCapCount(w, h);
        const m = n + 50;
        // flux = index (0..m-1); brightest are the highest indices.
        const cands = Array.from({ length: m }, (_, i) => ({ flux: i, id: i }));
        const cap = applyDensityCap(cands, w, h);

        expect(cap.n).toBe(n);
        expect(cap.m).toBe(m);
        expect(cap.kept.length).toBe(n);
        expect(cap.dropped.length).toBe(m - n);
        // Strict flux separation: every kept candidate is brighter than every dropped one.
        const minKept = Math.min(...cap.kept.map(c => c.flux));
        const maxDropped = Math.max(...cap.dropped.map(c => c.flux));
        expect(minKept).toBeGreaterThan(maxDropped);
        // The dropped tail is exactly the faintest (m-n) candidates.
        expect(cap.dropped.map(c => c.flux).sort((a, b) => a - b))
            .toEqual(Array.from({ length: m - n }, (_, i) => i));
    });

    it('is a no-op (keeps all, drops none) when M <= N', () => {
        const w = 50, h = 50;
        const cands = Array.from({ length: 10 }, (_, i) => ({ flux: i }));
        const cap = applyDensityCap(cands, w, h);
        expect(cap.kept).toBe(cands);        // same reference — untouched
        expect(cap.dropped.length).toBe(0);
        expect(cap.m).toBe(10);
    });

    it('cap target N is exactly the density-boundary count (density threshold × MP)', () => {
        const w = 2596, h = 1731; // Carina binned
        expect(densityCapCount(w, h)).toBe(applyDensityCap([], w, h).n);
        expect(densityCapCount(w, h)).toBeGreaterThan(0);
    });

    it('is deterministic (stable brightest-first selection)', () => {
        const w = 40, h = 40;
        const n = densityCapCount(w, h);
        const cands = Array.from({ length: n + 20 }, (_, i) => ({ flux: (i * 7) % 101, id: i }));
        const a = applyDensityCap(cands, w, h);
        const b = applyDensityCap(cands, w, h);
        expect(a.kept.map(c => c.flux)).toEqual(b.kept.map(c => c.flux));
        expect(a.dropped.map(c => c.id)).toEqual(b.dropped.map(c => c.id));
    });
});
