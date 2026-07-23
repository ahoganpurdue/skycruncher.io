import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    readVersioned,
    writeVersioned,
    clearKey,
    PERSIST_NAMESPACE,
} from '../ui/widgets/widget_persist';

/**
 * VERSIONED UI PERSISTENCE (A4 item 3/4 substrate). The one contract that
 * matters: a stored blob restores ONLY when its envelope version matches (and
 * the optional guard passes); a stale version / corrupt JSON / failed guard all
 * invalidate cleanly to null (caller falls back), never a throw and never a
 * half-migrated object.
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

describe('widget_persist — versioned localStorage envelope', () => {
    it('exposes the shared namespace', () => {
        expect(PERSIST_NAMESPACE).toBe('skycruncher');
    });

    it('round-trips a payload at the matching version', () => {
        writeVersioned('k', 1, { a: 1, b: ['x'] });
        expect(readVersioned('k', 1)).toEqual({ a: 1, b: ['x'] });
    });

    it('returns null when the key is unset', () => {
        expect(readVersioned('missing', 1)).toBeNull();
    });

    it('INVALIDATES on version mismatch (stale schema ⇒ null, not a broken restore)', () => {
        writeVersioned('k', 1, { a: 1 });
        expect(readVersioned('k', 2)).toBeNull();
    });

    it('applies the optional validator (rejects a wrong-shaped payload)', () => {
        const isStr = (x: unknown): x is string => typeof x === 'string';
        writeVersioned('k', 1, { a: 1 });
        expect(readVersioned('k', 1, isStr)).toBeNull();   // object fails a string guard
        writeVersioned('k', 1, 'hi');
        expect(readVersioned('k', 1, isStr)).toBe('hi');
    });

    it('corrupt / non-envelope JSON → null (never throws)', () => {
        localStorage.setItem('k', '{not valid json');
        expect(readVersioned('k', 1)).toBeNull();
        localStorage.setItem('k2', '"just a string, no envelope"');
        expect(readVersioned('k2', 1)).toBeNull();
    });

    it('is headless-safe: no localStorage ⇒ read null, write no-op (no throw)', () => {
        delete (globalThis as any).localStorage;
        expect(readVersioned('k', 1)).toBeNull();
        expect(() => writeVersioned('k', 1, { a: 1 })).not.toThrow();
        expect(() => clearKey('k')).not.toThrow();
        installLocalStorage();
    });

    it('clearKey removes the persisted key', () => {
        writeVersioned('k', 1, { a: 1 });
        clearKey('k');
        expect(readVersioned('k', 1)).toBeNull();
    });
});
