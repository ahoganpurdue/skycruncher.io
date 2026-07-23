import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    POPOUT_BOUNDS_STORAGE_KEY,
    isPopoutBoundsProfile,
    loadPopoutBounds,
    savePopoutBoundsFor,
    clearPopoutBounds,
} from '../ui/widgets/docking/popout_store';
import { DOCKING_SCHEMA_VERSION } from '../ui/widgets/docking/docking_store';
import { DEFAULT_POPOUT_BOUNDS } from '../ui/widgets/docking/popout_bridge';

/**
 * POPOUT STORE — per-widget window bounds persistence (Profile v2 additive,
 * DASHBOARD_DOCKING_SPEC §7). Contracts:
 *   • round-trips a widget→bounds map under the SAME schema version as the dock
 *     layout, on a SEPARATE key;
 *   • a stale/corrupt/mis-shaped blob resets cleanly to {} (honest absence —
 *     popout opens at the default), never a throw;
 *   • single-writer read-modify-write preserves other widgets' bounds;
 *   • invalid bounds are never persisted (no 0×0 / off-screen blob);
 *   • headless-safe (no localStorage ⇒ {} + no-op).
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

const GOOD = { x: 300, y: 200, width: 800, height: 640 };
const GOOD2 = { x: 40, y: 60, width: 760, height: 620 };

beforeEach(() => installLocalStorage());
afterEach(() => { delete (globalThis as any).localStorage; });

describe('popout_store — constants + structural gate', () => {
    it('uses the brand-neutral key and the shared docking schema version', () => {
        expect(POPOUT_BOUNDS_STORAGE_KEY).toBe('skycruncher.docking.popouts');
        expect(DOCKING_SCHEMA_VERSION).toBe(2);
    });

    it('isPopoutBoundsProfile accepts a valid map, rejects any bad entry', () => {
        expect(isPopoutBoundsProfile({ bounds: { solve_summary: GOOD } })).toBe(true);
        expect(isPopoutBoundsProfile({ bounds: {} })).toBe(true);       // empty map is valid
        expect(isPopoutBoundsProfile(null)).toBe(false);
        expect(isPopoutBoundsProfile({})).toBe(false);                  // no bounds field
        expect(isPopoutBoundsProfile({ bounds: { a: { x: 0, y: 0, width: 5, height: 5 } } })).toBe(false); // one bad entry
    });
});

describe('popout_store — round-trip + read-modify-write', () => {
    it('saves and restores bounds keyed by widget id', () => {
        savePopoutBoundsFor('solve_summary', GOOD);
        expect(loadPopoutBounds()).toEqual({ solve_summary: GOOD });
    });

    it('a second save preserves the first widget (read-modify-write)', () => {
        savePopoutBoundsFor('solve_summary', GOOD);
        savePopoutBoundsFor('solve_flowchart', GOOD2);
        expect(loadPopoutBounds()).toEqual({ solve_summary: GOOD, solve_flowchart: GOOD2 });
    });

    it('re-saving the same widget overwrites just that entry', () => {
        savePopoutBoundsFor('solve_summary', GOOD);
        const moved = { x: 900, y: 10, width: 900, height: 700 };
        savePopoutBoundsFor('solve_summary', moved);
        expect(loadPopoutBounds()).toEqual({ solve_summary: moved });
    });
});

describe('popout_store — never persists garbage bounds', () => {
    it('ignores invalid bounds (0×0 / below-min) and a blank widget id', () => {
        savePopoutBoundsFor('solve_summary', { x: 0, y: 0, width: 0, height: 0 } as any);
        savePopoutBoundsFor('', GOOD);
        expect(loadPopoutBounds()).toEqual({});
    });
});

describe('popout_store — LOUD-safe reset on stale/corrupt blobs', () => {
    it('corrupt JSON → {} (default), never a throw', () => {
        localStorage.setItem(POPOUT_BOUNDS_STORAGE_KEY, '{not json');
        expect(loadPopoutBounds()).toEqual({});
    });

    it('wrong schema version → {}', () => {
        localStorage.setItem(POPOUT_BOUNDS_STORAGE_KEY, JSON.stringify({ v: 1, data: { bounds: { a: GOOD } } }));
        expect(loadPopoutBounds()).toEqual({});
    });

    it('valid envelope but mis-shaped bounds → {}', () => {
        localStorage.setItem(POPOUT_BOUNDS_STORAGE_KEY, JSON.stringify({ v: DOCKING_SCHEMA_VERSION, data: { bounds: { a: { nope: true } } } }));
        expect(loadPopoutBounds()).toEqual({});
    });

    it('clearPopoutBounds drops the blob', () => {
        savePopoutBoundsFor('solve_summary', GOOD);
        clearPopoutBounds();
        expect(loadPopoutBounds()).toEqual({});
    });
});

describe('popout_store — headless-safe', () => {
    it('no localStorage ⇒ {} load, no-op save, no throw; default is the fallback', () => {
        delete (globalThis as any).localStorage;
        expect(loadPopoutBounds()).toEqual({});
        expect(() => savePopoutBoundsFor('solve_summary', GOOD)).not.toThrow();
        expect(() => clearPopoutBounds()).not.toThrow();
        expect(DEFAULT_POPOUT_BOUNDS.width).toBeGreaterThanOrEqual(240);
        installLocalStorage();
    });
});
