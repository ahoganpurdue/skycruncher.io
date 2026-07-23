import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    SKYWORKSPACE_VERSION,
    SKYWORKSPACE_KIND,
    SKYWORKSPACE_EXT,
    SKYWORKSPACE_DEFAULT_FILENAME,
    buildWorkspaceEnvelope,
    serializeWorkspace,
    parseWorkspace,
    parseWorkspaceObject,
} from '../ui/widgets/docking/workspace_file';
import {
    DOCKING_SCHEMA_VERSION,
    isDockingData,
    saveDockingLayout,
    loadDockingLayout,
} from '../ui/widgets/docking/docking_store';

/**
 * `.skyworkspace.json` export/import v0 (WIDGET_ECOSYSTEM_DESIGN §2). Contracts:
 *   • round-trip (build → serialize → parse) restores a byte-identical layout,
 *     and that layout re-persists through the docking store byte-identically;
 *   • validation REUSES the store's own gates (DOCKING_SCHEMA_VERSION +
 *     isDockingData) — a foreign / too-new / malformed file is a LOUD, itemised
 *     rejection, never a silent partial apply;
 *   • parse never throws (bad JSON degrades to a reason).
 */

// Minimal object shaped like dockview's SerializedDockview (grid + panels) — the
// exact fixture the docking_store test uses, so round-trip parity is comparable.
function fakeLayout(nPanels = 1): any {
    const panels: Record<string, unknown> = {};
    for (let i = 0; i < nPanels; i++) panels[`p${i}`] = { id: `p${i}`, contentComponent: 'widget' };
    return { grid: { root: { type: 'branch', data: [] }, width: 800, height: 600, orientation: 'HORIZONTAL' }, panels };
}

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

describe('workspace_file — constants', () => {
    it('exposes a versioned, brand-neutral file format identity', () => {
        expect(SKYWORKSPACE_VERSION).toBe('1.0.0');
        expect(SKYWORKSPACE_KIND).toBe('skycruncher.workspace');
        expect(SKYWORKSPACE_EXT).toBe('skyworkspace.json');
        expect(SKYWORKSPACE_DEFAULT_FILENAME.endsWith('.skyworkspace.json')).toBe(true);
    });
});

describe('workspace_file — envelope shape (task §1)', () => {
    it('wraps the CURRENT layout as the exact Profile-v2 on-disk shape', () => {
        const layout = fakeLayout(3);
        const env = buildWorkspaceEnvelope(layout, { appVersion: '9.9.9', now: new Date('2026-07-22T00:00:00Z') });
        expect(env.skyworkspace_version).toBe('1.0.0');
        expect(env.kind).toBe('skycruncher.workspace');
        expect(env.app_version).toBe('9.9.9');        // provenance only
        expect(env.exported_at).toBe('2026-07-22T00:00:00.000Z');
        // The inner profile is the identical { v, data:{layout} } the store persists.
        expect(env.profile.v).toBe(DOCKING_SCHEMA_VERSION);
        expect(env.profile.data.layout).toEqual(layout);
        expect(isDockingData(env.profile.data)).toBe(true);
    });

    it('serializeWorkspace emits pretty JSON parseable back to the envelope', () => {
        const env = buildWorkspaceEnvelope(fakeLayout(), { appVersion: '1.1.0' });
        const text = serializeWorkspace(env);
        expect(text).toContain('"skyworkspace_version": "1.0.0"');
        expect(JSON.parse(text)).toEqual(env);
    });
});

describe('workspace_file — round-trip (export → import → identical state)', () => {
    it('parse of a freshly-built envelope restores a byte-identical layout', () => {
        const layout = fakeLayout(5);
        const text = serializeWorkspace(buildWorkspaceEnvelope(layout, { appVersion: '1.1.0' }));
        const parsed = parseWorkspace(text);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.layout).toEqual(layout);
    });

    it('the imported layout re-persists through the docking store identically', () => {
        // "identical store state": import → save through the store → load equals the
        // original layout, proving the file carries exactly what the store persists.
        const layout = fakeLayout(4);
        const text = serializeWorkspace(buildWorkspaceEnvelope(layout, { appVersion: '1.1.0' }));
        const parsed = parseWorkspace(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        saveDockingLayout(parsed.layout);
        const loaded = loadDockingLayout();
        expect(loaded.wasReset).toBe(false);
        expect(loaded.layout).toEqual(layout);
    });
});

describe('workspace_file — invalid-envelope rejection (LOUD, never partial)', () => {
    it('non-JSON text → parse_error (no throw)', () => {
        const r = parseWorkspace('{not json');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('parse_error');
    });

    it('JSON that is not an object → not_object', () => {
        for (const raw of ['42', '"a string"', 'null', 'true', '[1,2,3]']) {
            const r = parseWorkspace(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe(raw === '[1,2,3]' ? 'wrong_kind' : 'not_object');
        }
    });

    it('missing / foreign kind → wrong_kind', () => {
        const good = buildWorkspaceEnvelope(fakeLayout(), { appVersion: '1.1.0' });
        expect(parseWorkspaceObject({ ...good, kind: 'other.app.workspace' }).ok).toBe(false);
        const r = parseWorkspaceObject({ ...good, kind: undefined });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('wrong_kind');
    });

    it('valid envelope but malformed inner layout → malformed_profile', () => {
        const r = parseWorkspaceObject({
            skyworkspace_version: SKYWORKSPACE_VERSION,
            kind: SKYWORKSPACE_KIND,
            app_version: '1.1.0',
            exported_at: '2026-07-22T00:00:00.000Z',
            profile: { v: DOCKING_SCHEMA_VERSION, data: { layout: { nope: true } } },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('malformed_profile');
    });
});

describe('workspace_file — version-mismatch loud path', () => {
    it('a too-new / unknown FILE version is rejected (never guessed)', () => {
        const good = buildWorkspaceEnvelope(fakeLayout(), { appVersion: '1.1.0' });
        const r = parseWorkspaceObject({ ...good, skyworkspace_version: '2.0.0' });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toBe('unsupported_version');
            expect(r.detail).toContain('2.0.0');       // itemised — names the offending version
        }
    });

    it('an inner PROFILE schema version mismatch is rejected via the store gate', () => {
        // Mirrors docking_store's own "wrong schema version → reset": a v1 profile
        // must NOT restore under the running v2 gate.
        const r = parseWorkspaceObject({
            skyworkspace_version: SKYWORKSPACE_VERSION,
            kind: SKYWORKSPACE_KIND,
            app_version: '1.1.0',
            exported_at: '2026-07-22T00:00:00.000Z',
            profile: { v: DOCKING_SCHEMA_VERSION + 1, data: { layout: fakeLayout() } },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('profile_version');
    });
});
