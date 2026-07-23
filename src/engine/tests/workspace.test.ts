/**
 * WORKSPACE DASHBOARD v1 — unit tests (pure logic; node env, no DOM).
 *
 * Covers:
 *  - layout_tree: every tree transform (split / add / move / close / resize /
 *    setActive), serialize round-trips, and the collapse invariants
 *    (no empty non-root leaves, no single-child splits, sizes sum→1).
 *  - workspace_store: persistence round-trip, corrupt-state + version-gate
 *    fallback (never throws), named-workspace CRUD, DEFAULT-OFF flag.
 *  - type_map: resolution reasons + the "switched — undo" affordance object,
 *    apply/undo, mapping CRUD.
 *  - WorkspaceHost: DEFAULT OFF ⇒ renders nothing (zero DOM, hook-free off-path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
    type LayoutNode,
    makeLeaf,
    makeSplit,
    isSplit,
    isLeaf,
    findNode,
    collectLeaves,
    splitLeaf,
    addWidget,
    setActiveTab,
    closeTab,
    moveTabToLeaf,
    resizeSplit,
    directionForArrow,
    normalizeSizes,
    treeInvariantViolations,
    isWellFormed,
    hasEmptyLeaves,
    __resetNodeIds,
} from '../ui/workspace/layout_tree';

import {
    type Profile,
    WORKSPACE_SCHEMA_VERSION,
    WORKSPACE_STORAGE_KEY,
    defaultProfile,
    makeWorkspace,
    isValidProfile,
    loadProfile,
    saveProfile,
    getWorkspaceEnabled,
    setWorkspaceEnabled,
    getActiveWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setActiveWorkspace,
    updateWorkspace,
    setActiveWindowLayout,
    __resetWorkspaceIds,
} from '../ui/workspace/workspace_store';

import {
    resolveWorkspaceForUpload,
    applySwitch,
    undoSwitch,
    setTypeMapping,
    clearTypeMapping,
    asImageType,
} from '../ui/workspace/type_map';

import { WorkspaceHost } from '../ui/workspace/WorkspaceHost';

// ─── in-memory localStorage stub (node env has none) ───────────────────────────

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

beforeEach(() => { installLocalStorage(); __resetNodeIds(); __resetWorkspaceIds(); });
afterEach(() => { delete (globalThis as any).localStorage; });

// A small fixture tree: root split[row] of two leaves.
function twoLeafRow(): LayoutNode {
    const a = makeLeaf(['solve_summary'], { id: 'A' });
    const b = makeLeaf(['psf_field'], { id: 'B' });
    return makeSplit('row', [a, b], { id: 'S', sizes: [0.5, 0.5] });
}

// ─── layout_tree: constructors + size helpers ──────────────────────────────────

describe('layout_tree constructors', () => {
    it('makeLeaf clamps active into range and copies tabs', () => {
        expect(makeLeaf([], { active: 3 }).active).toBe(0);
        const l = makeLeaf(['a', 'b', 'c'], { active: 99 });
        expect(l.active).toBe(2);
        expect(l.tabs).toEqual(['a', 'b', 'c']);
    });

    it('makeSplit defaults to even, normalized sizes', () => {
        const s = makeSplit('col', [makeLeaf(['a']), makeLeaf(['b']), makeLeaf(['c'])]);
        expect(s.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
        expect(s.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    });

    it('normalizeSizes renormalizes and rejects degenerate inputs', () => {
        expect(normalizeSizes([2, 2])).toEqual([0.5, 0.5]);
        expect(normalizeSizes([0, 0])).toEqual([0.5, 0.5]);       // degenerate → even
        expect(normalizeSizes([3, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    });
});

// ─── layout_tree: lookup ────────────────────────────────────────────────────────

describe('layout_tree lookup', () => {
    it('findNode + collectLeaves walk the tree', () => {
        const t = twoLeafRow();
        expect(findNode(t, 'S')).not.toBeNull();
        expect(isSplit(findNode(t, 'S')!)).toBe(true);
        expect(findNode(t, 'A')).not.toBeNull();
        expect(findNode(t, 'nope')).toBeNull();
        expect(collectLeaves(t).map(l => l.id)).toEqual(['A', 'B']);
    });
});

// ─── layout_tree: splitLeaf (keyboard grammar) ─────────────────────────────────

describe('splitLeaf', () => {
    it('directionForArrow maps arrows to direction + side', () => {
        expect(directionForArrow('ArrowRight')).toEqual({ direction: 'row', insertBefore: false });
        expect(directionForArrow('ArrowLeft')).toEqual({ direction: 'row', insertBefore: true });
        expect(directionForArrow('ArrowDown')).toEqual({ direction: 'col', insertBefore: false });
        expect(directionForArrow('ArrowUp')).toEqual({ direction: 'col', insertBefore: true });
        expect(directionForArrow('Enter')).toBeNull();
    });

    it('wraps a leaf in a split with the existing leaf + a fresh leaf, 50/50', () => {
        const leaf = makeLeaf(['solve_summary'], { id: 'L' });
        const out = splitLeaf(leaf, 'L', 'row', { newLeafId: 'NEW', splitId: 'SP' });
        expect(isSplit(out)).toBe(true);
        const s = out as any;
        expect(s.direction).toBe('row');
        expect(s.sizes).toEqual([0.5, 0.5]);
        expect(s.children.map((c: any) => c.id)).toEqual(['L', 'NEW']);
        expect(isWellFormed(out)).toBe(true);
        // the fresh pane starts EMPTY (honest NOT-MEASURED target, not pruned)
        expect(hasEmptyLeaves(out)).toBe(true);
    });

    it('insertBefore places the fresh leaf first', () => {
        const leaf = makeLeaf(['a'], { id: 'L' });
        const out = splitLeaf(leaf, 'L', 'col', { insertBefore: true, newLeafId: 'NEW' }) as any;
        expect(out.children.map((c: any) => c.id)).toEqual(['NEW', 'L']);
    });

    it('carries newTabs onto the fresh leaf; unknown/non-leaf ids are no-ops', () => {
        const t = twoLeafRow();
        const out = splitLeaf(t, 'A', 'row', { newTabs: ['detection_density'], newLeafId: 'N' });
        const fresh = findNode(out, 'N');
        expect(isLeaf(fresh!) && (fresh as any).tabs).toEqual(['detection_density']);
        // splitting a split id or a missing id returns the tree unchanged
        expect(splitLeaf(t, 'S', 'row')).toBe(t);
        expect(splitLeaf(t, 'ghost', 'row')).toBe(t);
    });
});

// ─── layout_tree: addWidget / setActiveTab ─────────────────────────────────────

describe('addWidget + setActiveTab', () => {
    it('addWidget appends a tab, optionally activating it', () => {
        const t = twoLeafRow();
        const out = addWidget(t, 'A', 'culling_waterfall', { activate: true });
        const a = findNode(out, 'A') as any;
        expect(a.tabs).toEqual(['solve_summary', 'culling_waterfall']);
        expect(a.active).toBe(1);
        // original untouched (purity)
        expect((findNode(t, 'A') as any).tabs).toEqual(['solve_summary']);
    });

    it('setActiveTab clamps to a valid index', () => {
        const t = addWidget(twoLeafRow(), 'A', 'x');
        expect((findNode(setActiveTab(t, 'A', 1), 'A') as any).active).toBe(1);
        expect((findNode(setActiveTab(t, 'A', 99), 'A') as any).active).toBe(1);
        expect((findNode(setActiveTab(t, 'A', -5), 'A') as any).active).toBe(0);
    });
});

// ─── layout_tree: closeTab + collapse invariants ───────────────────────────────

describe('closeTab collapse', () => {
    it('removes a tab and adjusts active', () => {
        let t: LayoutNode = makeLeaf(['a', 'b', 'c'], { id: 'L', active: 2 });
        t = closeTab(t, 'L', 1);                 // remove 'b'
        const l = findNode(t, 'L') as any;
        expect(l.tabs).toEqual(['a', 'c']);
        expect(l.active).toBe(1);                // was 2, one removed before it
        expect(isWellFormed(t)).toBe(true);
    });

    it('closing the last tab of a leaf collapses the split and unwraps to the sibling', () => {
        const t = twoLeafRow();                  // S[row]( A, B )
        const out = closeTab(t, 'A', 0);         // A empties → prune → unwrap to B
        expect(isLeaf(out)).toBe(true);
        expect((out as any).id).toBe('B');
        expect(isWellFormed(out)).toBe(true);
        expect(hasEmptyLeaves(out)).toBe(false); // close-collapse leaves no empty panes
    });

    it('emptying the whole tree yields one canonical empty leaf (still well-formed)', () => {
        const single = makeLeaf(['only'], { id: 'L' });
        const out = closeTab(single, 'L', 0);
        expect(isLeaf(out)).toBe(true);
        expect((out as any).tabs).toEqual([]);
        expect(isWellFormed(out)).toBe(true);    // lone empty ROOT is allowed
    });

    it('out-of-range / bad ids are no-ops', () => {
        const t = twoLeafRow();
        expect(closeTab(t, 'A', 9)).toBe(t);
        expect(closeTab(t, 'ghost', 0)).toBe(t);
    });
});

// ─── layout_tree: moveTabToLeaf (tab-group + reorder) ──────────────────────────

describe('moveTabToLeaf', () => {
    it('moves a widget to another leaf (viz-on-viz tab group) and collapses the emptied source', () => {
        const t = twoLeafRow();                          // A:[solve_summary]  B:[psf_field]
        const out = moveTabToLeaf(t, 'A', 0, 'B');       // A empties, unwrap to B
        expect(isLeaf(out)).toBe(true);
        expect((out as any).id).toBe('B');
        expect((out as any).tabs).toEqual(['psf_field', 'solve_summary']);
        expect((out as any).active).toBe(1);             // moved tab becomes active
        expect(isWellFormed(out)).toBe(true);
        expect(hasEmptyLeaves(out)).toBe(false);         // emptied source pruned
    });

    it('keeps both leaves when the source retains tabs', () => {
        const a = makeLeaf(['s1', 's2'], { id: 'A' });
        const b = makeLeaf(['p1'], { id: 'B' });
        const t = makeSplit('row', [a, b], { id: 'S' });
        const out = moveTabToLeaf(t, 'A', 0, 'B');
        expect(isSplit(out)).toBe(true);
        expect((findNode(out, 'A') as any).tabs).toEqual(['s2']);
        expect((findNode(out, 'B') as any).tabs).toEqual(['p1', 's1']);
        expect(isWellFormed(out)).toBe(true);
    });

    it('same-leaf move reorders tabs', () => {
        const l = makeLeaf(['a', 'b', 'c'], { id: 'L' });
        const out = moveTabToLeaf(l, 'L', 0, 'L', { toIndex: 2 });
        expect((out as any).tabs).toEqual(['b', 'c', 'a']);
    });

    it('bad ids / indices are no-ops', () => {
        const t = twoLeafRow();
        expect(moveTabToLeaf(t, 'A', 9, 'B')).toBe(t);
        expect(moveTabToLeaf(t, 'ghost', 0, 'B')).toBe(t);
        expect(moveTabToLeaf(t, 'A', 0, 'S')).toBe(t);   // destination not a leaf
    });
});

// ─── layout_tree: resizeSplit ──────────────────────────────────────────────────

describe('resizeSplit', () => {
    it('sets normalized sizes on a split', () => {
        const t = twoLeafRow();
        const out = resizeSplit(t, 'S', [3, 1]) as any;
        expect(out.sizes[0]).toBeCloseTo(0.75);
        expect(out.sizes[1]).toBeCloseTo(0.25);
        expect(out.sizes.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1);
        expect(isWellFormed(out)).toBe(true);
    });

    it('length mismatch or non-split id is a no-op', () => {
        const t = twoLeafRow();
        expect(resizeSplit(t, 'S', [1, 1, 1])).toBe(t);
        expect(resizeSplit(t, 'A', [1])).toBe(t);
    });
});

// ─── layout_tree: invariants + serialize round-trip ────────────────────────────

describe('invariants + serialization', () => {
    it('treeInvariantViolations flags single-child splits and bad sizes (empty leaves are legal panes)', () => {
        const singleChild = { kind: 'split', id: 'S', direction: 'row', sizes: [1], children: [makeLeaf(['a'])] } as any;
        expect(treeInvariantViolations(singleChild).some(v => v.includes('child'))).toBe(true);
        const badSum = { kind: 'split', id: 'S', direction: 'row', sizes: [0.2, 0.2], children: [makeLeaf(['a']), makeLeaf(['b'])] } as any;
        expect(treeInvariantViolations(badSum).some(v => v.includes('sum'))).toBe(true);
        // an empty leaf is a legitimate honest pane — structurally valid, but detectable
        const emptyChild = makeSplit('row', [makeLeaf([], { id: 'E' }), makeLeaf(['b'])], { id: 'S' });
        expect(isWellFormed(emptyChild)).toBe(true);
        expect(hasEmptyLeaves(emptyChild)).toBe(true);
    });

    it('a well-formed tree JSON round-trips to a deep-equal tree', () => {
        const t = twoLeafRow();
        const round = JSON.parse(JSON.stringify(t));
        expect(round).toEqual(t);
        expect(isWellFormed(round)).toBe(true);
    });
});

// ─── workspace_store: persistence + fallback ───────────────────────────────────

describe('workspace_store persistence', () => {
    it('defaultProfile is valid, versioned, and self-consistent', () => {
        const p = defaultProfile();
        expect(p.version).toBe(WORKSPACE_SCHEMA_VERSION);
        expect(isValidProfile(p)).toBe(true);
        expect(getActiveWorkspace(p)).not.toBeNull();
    });

    it('loadProfile returns the default when nothing is stored', () => {
        expect(loadProfile()).toEqual(defaultProfile());
    });

    it('save → load round-trips an equal profile', () => {
        const p = createWorkspace(defaultProfile(), 'FITS view', { id: 'wsp-f', tabs: ['psf_field'] });
        saveProfile(p);
        expect(loadProfile()).toEqual(p);
    });

    it('corrupt JSON falls back to the default and NEVER throws', () => {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, '{ this is not json ');
        expect(() => loadProfile()).not.toThrow();
        expect(loadProfile()).toEqual(defaultProfile());
    });

    it('unknown schema version is rejected (forward-compat gate)', () => {
        const future = { ...defaultProfile(), version: 999 };
        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(future));
        expect(isValidProfile(future)).toBe(false);
        expect(loadProfile()).toEqual(defaultProfile());
    });

    it('structurally invalid profiles fall back to the default', () => {
        for (const bad of [
            {},
            { version: WORKSPACE_SCHEMA_VERSION, workspaces: [] },
            { version: WORKSPACE_SCHEMA_VERSION, workspaces: [{ id: 'x' }], typeMap: {}, activeWorkspace: 'x' },
            { version: WORKSPACE_SCHEMA_VERSION, workspaces: [makeWorkspace('a', [], { id: 'a' })], typeMap: { CR2: null, FITS: null, ASDF: null }, activeWorkspace: 'MISSING' },
        ]) {
            localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(bad));
            expect(isValidProfile(bad)).toBe(false);
            expect(loadProfile()).toEqual(defaultProfile());
        }
    });

    it('storage-unavailable getters are safe', () => {
        delete (globalThis as any).localStorage;
        expect(() => loadProfile()).not.toThrow();
        expect(loadProfile()).toEqual(defaultProfile());
        expect(getWorkspaceEnabled()).toBe(false);
        installLocalStorage();
    });
});

// ─── workspace_store: mount flag (DEFAULT OFF) ─────────────────────────────────

describe('workspace mount flag', () => {
    it('is DEFAULT OFF and round-trips', () => {
        expect(getWorkspaceEnabled()).toBe(false);   // fresh storage
        setWorkspaceEnabled(true);
        expect(getWorkspaceEnabled()).toBe(true);
        setWorkspaceEnabled(false);
        expect(getWorkspaceEnabled()).toBe(false);
    });
});

// ─── workspace_store: named-workspace CRUD ─────────────────────────────────────

describe('named-workspace CRUD', () => {
    it('create adds + activates a new named workspace', () => {
        const p = createWorkspace(defaultProfile(), 'CR2 rig', { id: 'wsp-cr2' });
        expect(p.workspaces).toHaveLength(2);
        expect(p.activeWorkspace).toBe('wsp-cr2');
        expect(getActiveWorkspace(p)!.name).toBe('CR2 rig');
    });

    it('rename changes the name only', () => {
        let p = createWorkspace(defaultProfile(), 'x', { id: 'wsp-x' });
        p = renameWorkspace(p, 'wsp-x', 'renamed');
        expect(p.workspaces.find(w => w.id === 'wsp-x')!.name).toBe('renamed');
    });

    it('delete reassigns active + refuses to delete the last workspace', () => {
        let p = createWorkspace(defaultProfile(), 'second', { id: 'wsp-2' }); // active = wsp-2
        p = deleteWorkspace(p, 'wsp-2');
        expect(p.workspaces.map(w => w.id)).toEqual(['wsp-default']);
        expect(p.activeWorkspace).toBe('wsp-default');
        const before = p;
        expect(deleteWorkspace(before, 'wsp-default')).toBe(before);        // never zero
    });

    it('deleting a type-mapped workspace clears its mapping', () => {
        let p = createWorkspace(defaultProfile(), 'fits', { id: 'wsp-f', activate: false });
        p = setTypeMapping(p, 'FITS', 'wsp-f');
        p = deleteWorkspace(p, 'wsp-f');
        expect(p.typeMap.FITS).toBeNull();
    });

    it('setActiveWorkspace / updateWorkspace / setActiveWindowLayout are pure and guarded', () => {
        let p = createWorkspace(defaultProfile(), 'b', { id: 'wsp-b', activate: false });
        expect(setActiveWorkspace(p, 'ghost')).toBe(p);          // unknown id ⇒ no-op
        p = setActiveWorkspace(p, 'wsp-b');
        expect(p.activeWorkspace).toBe('wsp-b');
        p = updateWorkspace(p, 'wsp-b', w => ({ ...w, name: 'B2' }));
        expect(p.workspaces.find(w => w.id === 'wsp-b')!.name).toBe('B2');
        const newRoot = makeLeaf(['detection_density'], { id: 'R' });
        p = setActiveWindowLayout(p, 'wsp-b', newRoot);
        expect(p.workspaces.find(w => w.id === 'wsp-b')!.windows[0]).toEqual(newRoot);
    });
});

// ─── type_map: resolution + undo affordance ────────────────────────────────────

describe('type_map resolution', () => {
    function twoWorkspaceProfile(): Profile {
        let p = defaultProfile();                                   // active = wsp-default
        p = createWorkspace(p, 'FITS view', { id: 'wsp-f', activate: false });
        return p;
    }

    it('no mapping ⇒ not switched (reason no_mapping)', () => {
        const r = resolveWorkspaceForUpload(twoWorkspaceProfile(), 'CR2');
        expect(r.switched).toBe(false);
        expect(r.reason).toBe('no_mapping');
    });

    it('mapping to a different workspace ⇒ switched with full undo affordance object', () => {
        let p = twoWorkspaceProfile();
        p = setTypeMapping(p, 'FITS', 'wsp-f');
        const r = resolveWorkspaceForUpload(p, 'FITS');
        expect(r).toMatchObject({
            switched: true,
            reason: 'switched',
            imageType: 'FITS',
            targetWorkspaceId: 'wsp-f',
            targetWorkspaceName: 'FITS view',
            previousWorkspaceId: 'wsp-default',   // the undo target
        });
    });

    it('mapping to the already-active workspace ⇒ not switched (already_active)', () => {
        let p = twoWorkspaceProfile();
        p = setTypeMapping(p, 'CR2', 'wsp-default');   // already active
        const r = resolveWorkspaceForUpload(p, 'CR2');
        expect(r.switched).toBe(false);
        expect(r.reason).toBe('already_active');
    });

    it('mapping to a deleted workspace ⇒ not switched (stale_mapping)', () => {
        let p = twoWorkspaceProfile();
        p = setTypeMapping(p, 'FITS', 'wsp-f');
        p = deleteWorkspace(p, 'wsp-f');               // clears the mapping…
        // …force a stale pointer to exercise the guard directly:
        const stale = { ...p, typeMap: { ...p.typeMap, FITS: 'wsp-gone' } };
        const r = resolveWorkspaceForUpload(stale, 'FITS');
        expect(r.switched).toBe(false);
        expect(r.reason).toBe('stale_mapping');
    });

    it('applySwitch activates the target; undoSwitch restores the previous', () => {
        let p = twoWorkspaceProfile();
        p = setTypeMapping(p, 'FITS', 'wsp-f');
        const r = resolveWorkspaceForUpload(p, 'FITS');
        const switched = applySwitch(p, r);
        expect(switched.activeWorkspace).toBe('wsp-f');
        const undone = undoSwitch(switched, r);
        expect(undone.activeWorkspace).toBe('wsp-default');
        // applySwitch on a non-switch result is a no-op
        const noop = resolveWorkspaceForUpload(p, 'CR2');
        expect(applySwitch(p, noop)).toBe(p);
    });

    it('setTypeMapping rejects unknown workspaces; clearTypeMapping nulls it; ASDF is a legal key', () => {
        let p = twoWorkspaceProfile();
        expect(setTypeMapping(p, 'CR2', 'ghost')).toBe(p);         // unknown ⇒ no-op
        p = setTypeMapping(p, 'ASDF', 'wsp-f');                    // ASDF legal today
        expect(p.typeMap.ASDF).toBe('wsp-f');
        p = clearTypeMapping(p, 'ASDF');
        expect(p.typeMap.ASDF).toBeNull();
    });

    it('asImageType guards ingest labels', () => {
        expect(asImageType('CR2')).toBe('CR2');
        expect(asImageType('FITS')).toBe('FITS');
        expect(asImageType('ASDF')).toBe('ASDF');
        expect(asImageType('jpeg')).toBeNull();
    });
});

// ─── WorkspaceHost: DEFAULT OFF ⇒ zero DOM (hook-free off-path) ─────────────────

describe('WorkspaceHost default-off contract', () => {
    it('renders nothing when the flag is off (zero DOM)', () => {
        expect(getWorkspaceEnabled()).toBe(false);
        // The off-path calls no hooks, so invoking the component directly is safe
        // and proves it returns null (no element ⇒ no DOM).
        expect(WorkspaceHost({ receipt: null } as any)).toBeNull();
    });

    it('flag-on flips the guard (returns a non-null element description)', () => {
        setWorkspaceEnabled(true);
        expect(WorkspaceHost({ receipt: null } as any)).not.toBeNull();
    });
});
