import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { widgetOptions } from '../ui/dashboard/replay/WidgetSlot';
import { WIDGETS, setEnabledWidgets } from '../ui/widgets/registry';
import {
    isLayoutNode,
    loadLayout,
    saveLayout,
    LAYOUT_STORAGE_KEY,
    LAYOUT_SCHEMA_VERSION,
} from '../ui/dashboard/replay/layout_persist';
import { makeLeaf, splitLeaf } from '../ui/dashboard/replay/layout_tree';

/**
 * DOCK ↔ DASHBOARD UNIFICATION (A4 item 4) + versioned layout persistence
 * (A4 item 3). The replay dashboard's swap menu now honors the SAME persisted
 * selection state as the WidgetDock, and its layout persists through the shared
 * versioned surface (stale-schema blobs invalidate cleanly).
 */

function installLocalStorage() {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

beforeEach(() => installLocalStorage());
afterEach(() => { delete (globalThis as any).localStorage; });

describe('widgetOptions — shared dock/dashboard selection', () => {
    it('defaults to the full registry (nothing stored) in registry order', () => {
        expect(widgetOptions().map(o => o.id)).toEqual(WIDGETS.map(w => w.id));
    });

    it('scopes the swap menu to the dock enabled set when curated', () => {
        setEnabledWidgets(['solve_summary', 'psf_field']);
        expect(widgetOptions().map(o => o.id)).toEqual(['solve_summary', 'psf_field']);
    });

    it('falls back to the full registry when the enabled set is explicitly empty (never an empty menu)', () => {
        setEnabledWidgets([]); // user disabled everything in the dock
        expect(widgetOptions()).toHaveLength(WIDGETS.length);
    });
});

describe('layout_persist — versioned dashboard layout', () => {
    it('isLayoutNode accepts a valid leaf and split', () => {
        const leaf = makeLeaf('root', ['replay_timeline', 'solve_summary']);
        expect(isLayoutNode(leaf)).toBe(true);
        const split = splitLeaf(leaf, 'root', 'row', 'solve_summary', { splitId: 's', newLeafId: 'p' });
        expect(isLayoutNode(split)).toBe(true);
    });

    it('isLayoutNode rejects malformed / partial blobs', () => {
        expect(isLayoutNode(null)).toBe(false);
        expect(isLayoutNode({})).toBe(false);
        expect(isLayoutNode({ type: 'leaf', id: 'x' })).toBe(false);                       // no tabs/active
        expect(isLayoutNode({ type: 'split', id: 's', direction: 'diag', sizes: [1], children: [makeLeaf('a', ['x'])] })).toBe(false);
        expect(isLayoutNode({ type: 'split', id: 's', direction: 'row', sizes: [1, 1], children: [] })).toBe(false);
        expect(isLayoutNode({ type: 'split', id: 's', direction: 'row', sizes: [1, 1], children: [{}] })).toBe(false);
    });

    it('round-trips a saved layout', () => {
        const l = makeLeaf('root', ['replay_timeline']);
        saveLayout(l);
        expect(loadLayout(makeLeaf('fb', ['x']))).toEqual(l);
    });

    it('falls back to the default when nothing is stored', () => {
        const fb = makeLeaf('fb', ['x']);
        expect(loadLayout(fb)).toBe(fb);
    });

    it('INVALIDATES a stale-version blob (falls back to default, no broken restore)', () => {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ v: LAYOUT_SCHEMA_VERSION + 1, data: makeLeaf('old', ['y']) }));
        const fb = makeLeaf('fb', ['x']);
        expect(loadLayout(fb)).toBe(fb);
    });

    it('INVALIDATES a structurally-invalid tree at the current version (falls back)', () => {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ v: LAYOUT_SCHEMA_VERSION, data: { type: 'leaf', id: 'x' } }));
        const fb = makeLeaf('fb', ['x']);
        expect(loadLayout(fb)).toBe(fb);
    });
});
