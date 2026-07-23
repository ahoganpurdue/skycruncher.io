/**
 * THEME STATE — unit tests (pure logic; node env, no DOM — DOM + storage stubbed
 * on globalThis, mirroring the workspace.test.ts idiom).
 *
 * Covers: default (dark), persistence + validation, brightness defaults + clamp,
 * dim-overlay polarity (lower brightness ⇒ more dim), documentElement stamping,
 * pub/sub, and storage-unavailable resilience (never throws).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    THEMES,
    DEFAULT_THEME,
    THEME_STORAGE_KEY,
    BRIGHTNESS_STORAGE_PREFIX,
    MIN_BRIGHTNESS,
    MAX_BRIGHTNESS,
    DEFAULT_BRIGHTNESS,
    isTheme,
    clampBrightness,
    getTheme,
    setTheme,
    getBrightness,
    setBrightness,
    dimOpacity,
    applyThemeToDocument,
    initTheme,
    subscribeThemeChange,
} from '../ui/theme/theme_state';

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
const stampedTheme = () =>
    (globalThis as any).document?.documentElement?.getAttribute('data-theme') ?? null;

beforeEach(() => { installLocalStorage(); installDocument(); });
afterEach(() => { delete (globalThis as any).localStorage; delete (globalThis as any).document; });

// ── default + persistence + validation ─────────────────────────────────────
describe('theme persistence + default', () => {
    it('defaults to dark when nothing is persisted', () => {
        expect(DEFAULT_THEME).toBe('dark');
        expect(getTheme()).toBe('dark');
    });

    it('round-trips every valid theme through storage', () => {
        for (const t of THEMES) {
            setTheme(t);
            expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(t);
            expect(getTheme()).toBe(t);
        }
    });

    it('falls back to dark for a corrupt / unknown persisted value', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
        expect(getTheme()).toBe('dark');
        localStorage.setItem(THEME_STORAGE_KEY, '');
        expect(getTheme()).toBe('dark');
    });

    it('coerces an invalid setTheme argument to the default', () => {
        setTheme('neon' as any);
        expect(getTheme()).toBe('dark');
        expect(stampedTheme()).toBe('dark');
    });

    it('isTheme guards the three valid values only', () => {
        expect(isTheme('dark') && isTheme('light') && isTheme('night')).toBe(true);
        for (const v of ['DARK', 'sepia', '', null, undefined, 1]) expect(isTheme(v)).toBe(false);
    });
});

// ── data-theme stamping ─────────────────────────────────────────────────────
describe('documentElement stamping', () => {
    it('setTheme stamps documentElement[data-theme]', () => {
        setTheme('night');
        expect(stampedTheme()).toBe('night');
        setTheme('light');
        expect(stampedTheme()).toBe('light');
    });

    it('applyThemeToDocument stamps the explicit theme', () => {
        applyThemeToDocument('night');
        expect(stampedTheme()).toBe('night');
    });

    it('initTheme reads persisted + stamps + returns it', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'light');
        expect(initTheme()).toBe('light');
        expect(stampedTheme()).toBe('light');
    });

    it('applyThemeToDocument is a no-op (no throw) when document is absent', () => {
        delete (globalThis as any).document;
        expect(() => applyThemeToDocument('night')).not.toThrow();
    });
});

// ── brightness defaults + clamp ─────────────────────────────────────────────
describe('brightness defaults + clamp', () => {
    it('per-theme defaults: day full, night 45', () => {
        expect(DEFAULT_BRIGHTNESS).toEqual({ dark: 100, light: 100, night: 45 });
        expect(getBrightness('dark')).toBe(100);
        expect(getBrightness('light')).toBe(100);
        expect(getBrightness('night')).toBe(45);
    });

    it('clampBrightness bounds to [10, 100], rounds, and maps non-finite → 100', () => {
        expect(clampBrightness(5)).toBe(MIN_BRIGHTNESS);      // 10
        expect(clampBrightness(150)).toBe(MAX_BRIGHTNESS);    // 100
        expect(clampBrightness(45)).toBe(45);
        expect(clampBrightness(45.6)).toBe(46);               // rounds
        expect(clampBrightness(NaN)).toBe(MAX_BRIGHTNESS);    // safe: no dim
        expect(clampBrightness(Infinity)).toBe(MAX_BRIGHTNESS);
    });

    it('persists per-theme brightness under the namespaced key (clamped)', () => {
        setBrightness('night', 30);
        expect(localStorage.getItem(BRIGHTNESS_STORAGE_PREFIX + 'night')).toBe('30');
        expect(getBrightness('night')).toBe(30);
        setBrightness('night', 999);
        expect(getBrightness('night')).toBe(100);
    });

    it('a corrupt stored brightness falls back to the per-theme default', () => {
        localStorage.setItem(BRIGHTNESS_STORAGE_PREFIX + 'night', 'bright');
        expect(getBrightness('night')).toBe(45);
    });
});

// ── dim-overlay polarity ────────────────────────────────────────────────────
describe('dim-overlay opacity polarity', () => {
    it('full brightness ⇒ 0 (no dim); lower brightness ⇒ more dim', () => {
        expect(dimOpacity('dark', 100)).toBe(0);
        expect(dimOpacity('night', 45)).toBeCloseTo(0.55, 10);
        expect(dimOpacity('night', 10)).toBeCloseTo(0.9, 10);
    });

    it('is monotonic decreasing in brightness (polarity holds)', () => {
        const seq = [100, 80, 60, 45, 20, 10].map((b) => dimOpacity('night', b));
        for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
    });

    it('default night dim (no persisted brightness) is 0.55', () => {
        expect(dimOpacity('night')).toBeCloseTo(0.55, 10);
    });

    it('clamps opacity to [0,1] even for out-of-range brightness', () => {
        expect(dimOpacity('night', -50)).toBeLessThanOrEqual(1);
        expect(dimOpacity('night', 500)).toBe(0);
    });
});

// ── pub/sub ─────────────────────────────────────────────────────────────────
describe('subscribeThemeChange', () => {
    it('notifies on theme + brightness changes, and stops after unsubscribe', () => {
        const cb = vi.fn();
        const unsub = subscribeThemeChange(cb);
        setTheme('light');
        setBrightness('night', 60);
        expect(cb).toHaveBeenCalledTimes(2);
        unsub();
        setTheme('dark');
        expect(cb).toHaveBeenCalledTimes(2); // no further calls
    });

    it('a throwing listener never breaks the others', () => {
        const good = vi.fn();
        const bad = () => { throw new Error('boom'); };
        const u1 = subscribeThemeChange(bad);
        const u2 = subscribeThemeChange(good);
        expect(() => setTheme('night')).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
        u1(); u2();
    });
});

// ── storage-unavailable resilience ──────────────────────────────────────────
describe('storage-unavailable resilience (never throws)', () => {
    it('getTheme / getBrightness / setTheme survive a throwing localStorage', () => {
        (globalThis as any).localStorage = {
            getItem: () => { throw new Error('blocked'); },
            setItem: () => { throw new Error('blocked'); },
        };
        expect(getTheme()).toBe('dark');
        expect(getBrightness('night')).toBe(45);
        expect(() => setTheme('night')).not.toThrow();
        expect(stampedTheme()).toBe('night'); // still stamps the live session
    });
});
