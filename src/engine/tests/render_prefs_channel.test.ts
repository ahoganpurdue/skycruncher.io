/**
 * RENDER-PREFS POP-OUT SYNC CHANNEL — unit tests (node env; DOM + storage
 * stubbed on globalThis, mirroring the theme_state.test.ts idiom). Node's global
 * BroadcastChannel is real, so the host↔child protocol is exercised with TWO
 * endpoints in ONE process — exactly the token-spec handshake.
 *
 * Covers: snapshot shape (render-pref fields only — NO measurement state),
 * the child-hello → host re-broadcast handshake, broadcast-on-change for every
 * render pref (theme / brightness / density / peek), dispose() unwiring, the
 * BroadcastChannel-absent no-op, and the message guard (only `hello` re-triggers).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    setTheme,
    setBrightness,
    setDensity,
    setPeekPrefs,
} from '../ui/theme/theme_state';
import {
    RENDER_PREFS_CHANNEL,
    buildSnapshot,
    isRenderPrefsMessage,
    createRenderPrefsHost,
    type RenderPrefsHost,
    type RenderPrefsMessage,
} from '../ui/theme/render_prefs_channel';

// ── in-memory localStorage + document stubs (node env has neither) ──────────
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
function installDocument() {
    const attrs = new Map<string, string>();
    (globalThis as any).document = {
        documentElement: {
            setAttribute: (k: string, v: string) => { attrs.set(k, v); },
            getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
        },
    };
}

// ── BroadcastChannel bookkeeping (Node refs the loop — close everything) ────
const openChannels: BroadcastChannel[] = [];
function mkChannel(): BroadcastChannel {
    const c = new BroadcastChannel(RENDER_PREFS_CHANNEL);
    openChannels.push(c);
    return c;
}
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
function nextMessage(ch: BroadcastChannel, timeoutMs = 500): Promise<RenderPrefsMessage> {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => { ch.onmessage = null; reject(new Error('timeout waiting for channel message')); }, timeoutMs);
        ch.onmessage = (e: MessageEvent) => { clearTimeout(to); ch.onmessage = null; resolve(e.data as RenderPrefsMessage); };
    });
}

let host: RenderPrefsHost | null = null;

beforeEach(() => {
    installLocalStorage();
    installDocument();
    setTheme('dark'); // deterministic starting theme (no listeners yet)
});
afterEach(() => {
    host?.dispose();
    host = null;
    for (const c of openChannels) { try { c.onmessage = null; c.close(); } catch { /* ignore */ } }
    openChannels.length = 0;
    delete (globalThis as any).localStorage;
    delete (globalThis as any).document;
});

// ── snapshot shape (render plane only — no measurement state) ────────────────
describe('buildSnapshot', () => {
    it('carries exactly {theme, brightness{dark,light,night}, density, peek{saved,duration}}', () => {
        const snap = buildSnapshot();
        // Law 4: the payload is a CLOSED shape — exactly the render-pref fields,
        // nowhere for a WCS / receipt / measurement value to hide.
        expect(Object.keys(snap).sort()).toEqual(['brightness', 'density', 'peek', 'theme']);
        expect(Object.keys(snap.brightness).sort()).toEqual(['dark', 'light', 'night']);
        expect(Object.keys(snap.peek).sort()).toEqual(['duration', 'saved']);
        // every leaf is a primitive render-pref (string theme/density, number brightness/peek).
        expect(typeof snap.theme).toBe('string');
        expect(typeof snap.density).toBe('string');
        for (const v of Object.values(snap.brightness)) expect(typeof v).toBe('number');
        for (const v of Object.values(snap.peek)) expect(typeof v).toBe('number');
    });

    it('reflects the current render prefs', () => {
        setTheme('night');
        setBrightness('night', 33);
        setDensity('compact');
        setPeekPrefs({ saved: 70, duration: 5000 });
        expect(buildSnapshot()).toEqual({
            theme: 'night',
            brightness: { light: 100, dark: 100, night: 33 },
            density: 'compact',
            peek: { saved: 70, duration: 5000 },
        });
    });
});

// ── host↔child handshake (two BroadcastChannel endpoints, one process) ──────
describe('createRenderPrefsHost handshake', () => {
    it('answers a child hello by re-broadcasting the current snapshot', async () => {
        setTheme('night');
        host = createRenderPrefsHost(mkChannel);
        expect(host).not.toBeNull();
        const child = mkChannel();
        const p = nextMessage(child);
        child.postMessage({ type: 'hello' } satisfies RenderPrefsMessage);
        const msg = await p;
        expect(msg.type).toBe('snapshot');
        expect(msg.type === 'snapshot' && msg.snapshot.theme).toBe('night');
    });

    it('broadcasts a fresh snapshot to children on ANY render-pref change', async () => {
        host = createRenderPrefsHost(mkChannel);
        const child = mkChannel();

        let p = nextMessage(child);
        setBrightness('night', 30);
        let msg = await p;
        expect(msg.type === 'snapshot' && msg.snapshot.brightness.night).toBe(30);

        p = nextMessage(child);
        setDensity('compact');
        msg = await p;
        expect(msg.type === 'snapshot' && msg.snapshot.density).toBe('compact');

        p = nextMessage(child);
        setPeekPrefs({ duration: 3000 });
        msg = await p;
        expect(msg.type === 'snapshot' && msg.snapshot.peek.duration).toBe(3000);

        p = nextMessage(child);
        setTheme('light');
        msg = await p;
        expect(msg.type === 'snapshot' && msg.snapshot.theme).toBe('light');
    });
});

// ── lifecycle + resilience ──────────────────────────────────────────────────
describe('createRenderPrefsHost lifecycle', () => {
    it('dispose() unwires: no further snapshots reach children', async () => {
        host = createRenderPrefsHost(mkChannel);
        const child = mkChannel();
        const received: RenderPrefsMessage[] = [];
        child.onmessage = (e: MessageEvent) => received.push(e.data as RenderPrefsMessage);

        host!.dispose();
        host = null;
        setTheme('light');
        setDensity('compact');
        await tick();
        expect(received).toHaveLength(0);
    });

    it('returns null (app unchanged) when BroadcastChannel is unavailable', () => {
        const saved = (globalThis as any).BroadcastChannel;
        delete (globalThis as any).BroadcastChannel;
        try {
            expect(createRenderPrefsHost()).toBeNull();
        } finally {
            (globalThis as any).BroadcastChannel = saved;
        }
    });

    it('only a hello re-triggers a broadcast (non-hello traffic is ignored)', async () => {
        const hostCh = mkChannel();
        const spy = vi.spyOn(hostCh, 'postMessage');
        host = createRenderPrefsHost(() => hostCh);
        const child = mkChannel();

        child.postMessage({ type: 'bogus' } as any);
        child.postMessage({ type: 'snapshot', snapshot: buildSnapshot() } satisfies RenderPrefsMessage);
        await tick();
        expect(spy).not.toHaveBeenCalled();

        child.postMessage({ type: 'hello' } satisfies RenderPrefsMessage);
        await tick();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ── message guard ───────────────────────────────────────────────────────────
describe('isRenderPrefsMessage', () => {
    it('narrows only snapshot | hello', () => {
        expect(isRenderPrefsMessage({ type: 'hello' })).toBe(true);
        expect(isRenderPrefsMessage({ type: 'snapshot', snapshot: buildSnapshot() })).toBe(true);
        for (const v of [null, undefined, 1, 'hello', {}, { type: 'bogus' }, { type: 1 }]) {
            expect(isRenderPrefsMessage(v)).toBe(false);
        }
    });
});
