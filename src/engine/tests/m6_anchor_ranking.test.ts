import { describe, it, expect } from 'vitest';
import { rankAnchorsByFlux } from '../pipeline/m6_plate_solve/solver_entry';

// NEXT_MOVES §2a top-N anchor candidates. The lever replaces the single
// flux-argmax anchor with the top-N flux-ranked hygiene-passing detections.
// The load-bearing invariant is BYTE-IDENTICAL: candidate #0 must be the exact
// object the pre-§2a argmax reduce returned, so n=1 (and anchor #0 at any n)
// changes nothing in the solve path. These tests pin that against the literal
// old reduce, plus the ranking + immutability contract.

type Det = { x: number; y: number; flux?: number; tag: string };

// The exact pre-§2a anchor selector, reproduced here as the oracle.
const oldArgmax = (arr: Det[]): Det | null =>
    arr.reduce((best, s) => ((s.flux || 0) > (best?.flux || 0) ? s : best), null as Det | null);

const det = (tag: string, flux?: number): Det => ({ x: 0, y: 0, flux, tag });

describe('rankAnchorsByFlux (NEXT_MOVES §2a top-N anchor candidates)', () => {
    it('candidate #0 IS the former flux-argmax (byte-identical anchor)', () => {
        const arr = [det('a', 5), det('b', 130), det('c', 4.9), det('d', 12)];
        const ranked = rankAnchorsByFlux(arr, 3);
        expect(ranked[0]).toBe(oldArgmax(arr)); // same object reference
        expect(ranked[0].tag).toBe('b');
    });

    it('breaks flux ties first-in-original-order, matching the old strict-> reduce', () => {
        // Two detections share the max flux; the old reduce keeps the FIRST seen
        // (strict >, so a later equal never replaces). A stable descending sort
        // must land that same element at [0].
        const arr = [det('lo', 3), det('tieA', 130), det('mid', 40), det('tieB', 130)];
        const ranked = rankAnchorsByFlux(arr, 3);
        expect(ranked[0]).toBe(oldArgmax(arr));
        expect(ranked[0].tag).toBe('tieA');
    });

    it('n=1 returns exactly the single argmax (pre-§2a behavior)', () => {
        const arr = [det('a', 5), det('b', 130), det('c', 4.9)];
        const ranked = rankAnchorsByFlux(arr, 1);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]).toBe(oldArgmax(arr));
    });

    it('returns up to n candidates in flux-descending order', () => {
        const arr = [det('a', 5), det('b', 130), det('c', 4.9), det('d', 12), det('e', 60)];
        const ranked = rankAnchorsByFlux(arr, 3);
        expect(ranked.map(r => r.tag)).toEqual(['b', 'e', 'd']);
        expect(ranked).toHaveLength(3);
    });

    it('caps at the available count when fewer than n candidates exist', () => {
        const arr = [det('a', 5), det('b', 130)];
        expect(rankAnchorsByFlux(arr, 3).map(r => r.tag)).toEqual(['b', 'a']);
    });

    it('treats missing/undefined flux as 0 (same coalescing as the old reduce)', () => {
        const arr = [det('none'), det('b', 8), det('alsoNone')];
        const ranked = rankAnchorsByFlux(arr, 3);
        expect(ranked[0]).toBe(oldArgmax(arr));
        expect(ranked[0].tag).toBe('b');
    });

    it('empty input yields an empty list (anchor mode never engages)', () => {
        expect(rankAnchorsByFlux([] as Det[], 3)).toEqual([]);
    });

    it('coerces n<1 to 1 rather than returning an empty slice', () => {
        const arr = [det('a', 5), det('b', 130)];
        expect(rankAnchorsByFlux(arr, 0)).toHaveLength(1);
        expect(rankAnchorsByFlux(arr, 0)[0].tag).toBe('b');
    });

    it('does not mutate the caller array (order preserved)', () => {
        const arr = [det('a', 5), det('b', 130), det('c', 4.9)];
        const before = arr.map(d => d.tag);
        rankAnchorsByFlux(arr, 3);
        expect(arr.map(d => d.tag)).toEqual(before);
    });
});
