import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DOCKING_ENABLED_STORAGE_KEY,
    RIBBON_COLLAPSED_STORAGE_KEY,
    getDockingEnabled,
    setDockingEnabled,
    getRibbonCollapsed,
    setRibbonCollapsed,
    readDockingUrlOverride,
} from '../ui/widgets/docking/docking_flag';

/**
 * Phase-B docking flags (DASHBOARD_DOCKING_SPEC). The two contracts that matter:
 *   • docking surface is DEFAULT ON (opt-out, @492a985a — ratified for main at the
 *     owner walkthrough) — only the exact '0' disables it, so the flag-'0' path is
 *     the byte-identical legacy grid;
 *   • ribbon is DEFAULT EXPANDED on the first-ever run (owner walkthrough:
 *     undiscoverable collapsed) — only a persisted '1' keeps it collapsed.
 * Both are headless/Node-safe (no throw when localStorage is absent).
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

/** Fake a page URL so the ?docking= override can be exercised in Node. */
function setSearch(search: string) {
    (globalThis as any).window = { location: { search } };
}
function clearWindow() {
    delete (globalThis as any).window;
}

beforeEach(() => installLocalStorage());
afterEach(() => { delete (globalThis as any).localStorage; clearWindow(); });

describe('docking_flag — brand-neutral keys', () => {
    it('uses skycruncher.* keys', () => {
        expect(DOCKING_ENABLED_STORAGE_KEY).toBe('skycruncher.docking.enabled');
        expect(RIBBON_COLLAPSED_STORAGE_KEY).toBe('skycruncher.ribbon.collapsed');
    });
});

describe('docking_flag — docking enabled (DEFAULT ON)', () => {
    it('defaults ON when unset (opt-out)', () => {
        expect(getDockingEnabled()).toBe(true);
    });
    it('only the exact "0" turns it off', () => {
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, '1');
        expect(getDockingEnabled()).toBe(true);
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, 'true');   // not '0'
        expect(getDockingEnabled()).toBe(true);
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, '0');
        expect(getDockingEnabled()).toBe(false);
    });
    it('round-trips via the setter', () => {
        setDockingEnabled(true);
        expect(getDockingEnabled()).toBe(true);
        setDockingEnabled(false);
        expect(getDockingEnabled()).toBe(false);
    });
});

describe('docking_flag — ?docking= per-load URL override (no write)', () => {
    it('readDockingUrlOverride: "1"→true, "0"→false, absent/other→null', () => {
        setSearch('?docking=1');
        expect(readDockingUrlOverride()).toBe(true);
        setSearch('?docking=0');
        expect(readDockingUrlOverride()).toBe(false);
        setSearch('?other=1');            // param absent among others
        expect(readDockingUrlOverride()).toBeNull();
        setSearch('?docking=true');       // exact-value discipline — not '1'/'0'
        expect(readDockingUrlOverride()).toBeNull();
        setSearch('');                    // no query at all
        expect(readDockingUrlOverride()).toBeNull();
        clearWindow();                    // headless (no window)
        expect(readDockingUrlOverride()).toBeNull();
    });

    it('?docking=1 forces ON regardless of localStorage, WITHOUT writing it', () => {
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, '0');   // persisted OFF
        setSearch('?docking=1');
        expect(getDockingEnabled()).toBe(true);                   // override wins
        expect(localStorage.getItem(DOCKING_ENABLED_STORAGE_KEY)).toBe('0'); // untouched
    });

    it('?docking=0 forces OFF regardless of localStorage, WITHOUT writing it', () => {
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, '1');   // persisted ON
        setSearch('?docking=0');
        expect(getDockingEnabled()).toBe(false);                  // override wins
        expect(localStorage.getItem(DOCKING_ENABLED_STORAGE_KEY)).toBe('1'); // untouched
    });

    it('absence of the param ⇒ existing behavior exactly (localStorage decides)', () => {
        setSearch('?foo=bar');                                    // present URL, no docking param
        expect(getDockingEnabled()).toBe(true);                   // unset localStorage ⇒ on (opt-out default)
        localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, '0');
        expect(getDockingEnabled()).toBe(false);                  // persisted '0' ⇒ off
    });
});

describe('docking_flag — ribbon collapsed (DEFAULT EXPANDED on first run)', () => {
    it('defaults EXPANDED when unset (first-run discoverability)', () => {
        expect(getRibbonCollapsed()).toBe(false);
    });
    it('only a persisted "1" collapses it; "0"/other ⇒ expanded', () => {
        localStorage.setItem(RIBBON_COLLAPSED_STORAGE_KEY, '1');
        expect(getRibbonCollapsed()).toBe(true);
        localStorage.setItem(RIBBON_COLLAPSED_STORAGE_KEY, '0');
        expect(getRibbonCollapsed()).toBe(false);
        localStorage.setItem(RIBBON_COLLAPSED_STORAGE_KEY, 'anything');   // not '1'
        expect(getRibbonCollapsed()).toBe(false);
    });
    it('round-trips via the setter — collapse persists only after a real collapse', () => {
        setRibbonCollapsed(true);
        expect(getRibbonCollapsed()).toBe(true);
        setRibbonCollapsed(false);
        expect(getRibbonCollapsed()).toBe(false);
    });
});

describe('docking_flag — headless-safe (no localStorage)', () => {
    it('reads defaults and never throws without storage', () => {
        delete (globalThis as any).localStorage;
        expect(getDockingEnabled()).toBe(true);     // opt-out default ON; storage-unavailable ⇒ on
        expect(getRibbonCollapsed()).toBe(false);   // expanded ⇒ widgets discoverable
        expect(() => setDockingEnabled(true)).not.toThrow();
        expect(() => setRibbonCollapsed(false)).not.toThrow();
        installLocalStorage();
    });
});
