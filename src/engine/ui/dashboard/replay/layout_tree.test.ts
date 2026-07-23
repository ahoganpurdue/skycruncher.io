/** Pure layout-tree transform tests (no DOM) — the ★ Replay Dashboard shell. */
import { describe, it, expect } from 'vitest';
import {
    makeLeaf,
    findLeaf,
    countLeaves,
    leafIds,
    splitLeaf,
    closeLeaf,
    swapWidget,
    addTab,
    setActiveTab,
    closeTab,
    resizeSplit,
    type LayoutNode,
} from './layout_tree';

describe('makeLeaf / findLeaf', () => {
    it('builds a leaf and finds it', () => {
        const l = makeLeaf('a', ['solve_summary']);
        expect(findLeaf(l, 'a')).toBe(l);
        expect(findLeaf(l, 'zzz')).toBeNull();
    });
    it('clamps an out-of-range active index', () => {
        expect(makeLeaf('a', ['x', 'y'], 9).active).toBe(1);
        expect(makeLeaf('a', ['x', 'y'], -3).active).toBe(0);
        expect(makeLeaf('a', [], 2).active).toBe(0);
    });
});

describe('splitLeaf', () => {
    it('wraps a leaf in a split with a fresh sibling', () => {
        const root = makeLeaf('a', ['w1']);
        const next = splitLeaf(root, 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        expect(next.type).toBe('split');
        const split = next as Extract<LayoutNode, { type: 'split' }>;
        expect(split.direction).toBe('row');
        expect(split.children.map(c => c.id)).toEqual(['a', 'b']);
        expect(countLeaves(next)).toBe(2);
        expect(findLeaf(next, 'b')!.tabs).toEqual(['w2']);
    });
    it('honours before=true (new leaf first)', () => {
        const root = makeLeaf('a', ['w1']);
        const next = splitLeaf(root, 'a', 'col', 'w2', { splitId: 's1', newLeafId: 'b' }, true);
        expect((next as any).children.map((c: any) => c.id)).toEqual(['b', 'a']);
    });
    it('is a no-op for an unknown leaf id', () => {
        const root = makeLeaf('a', ['w1']);
        const next = splitLeaf(root, 'nope', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        expect(next).toEqual(root);
    });
    it('does not mutate the input tree', () => {
        const root = makeLeaf('a', ['w1']);
        const snap = JSON.stringify(root);
        splitLeaf(root, 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        expect(JSON.stringify(root)).toBe(snap);
    });
});

describe('closeLeaf', () => {
    it('collapses a 2-child split to the survivor', () => {
        const root = splitLeaf(makeLeaf('a', ['w1']), 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        const next = closeLeaf(root, 'b');
        expect(next.type).toBe('leaf');
        expect((next as any).id).toBe('a');
    });
    it('never removes the last remaining pane (root leaf)', () => {
        const root = makeLeaf('a', ['w1']);
        expect(closeLeaf(root, 'a')).toBe(root);
    });
    it('drops one child of a 3-way split and renormalizes sizes', () => {
        let root: LayoutNode = makeLeaf('a', ['w1']);
        root = splitLeaf(root, 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        // Split leaf b again to make s1 hold [a, s2{b,c}] then... simpler: build a flat 3-way manually.
        const flat: LayoutNode = {
            type: 'split', id: 's', direction: 'row', sizes: [1, 1, 1],
            children: [makeLeaf('a', ['w1']), makeLeaf('b', ['w2']), makeLeaf('c', ['w3'])],
        };
        const next = closeLeaf(flat, 'b') as any;
        expect(next.type).toBe('split');
        expect(next.children.map((c: any) => c.id)).toEqual(['a', 'c']);
        expect(next.sizes.reduce((x: number, y: number) => x + y, 0)).toBeCloseTo(1);
    });
});

describe('swapWidget / addTab / setActiveTab / closeTab', () => {
    it('swaps the active tab widget', () => {
        const root = makeLeaf('a', ['w1', 'w2'], 1);
        const next = swapWidget(root, 'a', 'wX');
        expect((next as any).tabs).toEqual(['w1', 'wX']);
    });
    it('adds a tab and focuses it', () => {
        const root = makeLeaf('a', ['w1']);
        const next = addTab(root, 'a', 'w2') as any;
        expect(next.tabs).toEqual(['w1', 'w2']);
        expect(next.active).toBe(1);
    });
    it('sets the active tab (clamped)', () => {
        const root = makeLeaf('a', ['w1', 'w2', 'w3']);
        expect((setActiveTab(root, 'a', 2) as any).active).toBe(2);
        expect((setActiveTab(root, 'a', 99) as any).active).toBe(2);
    });
    it('closing a tab shifts active left when needed', () => {
        const root = makeLeaf('a', ['w1', 'w2', 'w3'], 2);
        const next = closeTab(root, 'a', 2) as any;
        expect(next.tabs).toEqual(['w1', 'w2']);
        expect(next.active).toBe(1);
    });
    it('closing the last tab in a leaf closes the leaf', () => {
        const root = splitLeaf(makeLeaf('a', ['w1']), 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        const next = closeTab(root, 'b', 0);
        expect(next.type).toBe('leaf');
        expect((next as any).id).toBe('a');
    });
});

describe('resizeSplit', () => {
    it('normalizes committed sizes', () => {
        const root: LayoutNode = {
            type: 'split', id: 's', direction: 'row', sizes: [1, 1],
            children: [makeLeaf('a', ['w1']), makeLeaf('b', ['w2'])],
        };
        const next = resizeSplit(root, 's', [3, 1]) as any;
        expect(next.sizes[0]).toBeCloseTo(0.75);
        expect(next.sizes[1]).toBeCloseTo(0.25);
    });
    it('ignores a size array of the wrong length', () => {
        const root: LayoutNode = {
            type: 'split', id: 's', direction: 'row', sizes: [1, 1],
            children: [makeLeaf('a', ['w1']), makeLeaf('b', ['w2'])],
        };
        expect(resizeSplit(root, 's', [1, 1, 1])).toEqual(root);
    });
});

describe('leafIds', () => {
    it('enumerates every leaf id depth-first', () => {
        const root = splitLeaf(makeLeaf('a', ['w1']), 'a', 'row', 'w2', { splitId: 's1', newLeafId: 'b' });
        expect(leafIds(root).sort()).toEqual(['a', 'b']);
    });
});
