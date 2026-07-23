/**
 * -----------------------------------------------------------------
 * THEME STATE (RENDER plane — presentation only, Law 4)
 * -----------------------------------------------------------------
 * The single source of truth for the three render-plane themes introduced by
 * the 2026-07-21 restyle:
 *
 *   dark  (default) — the shipped World-1 instrument palette
 *   light           — daily-driver warm-paper daytime parity
 *   night           — STARGAZING red-space (dark-adaptation preserving)
 *
 * The visual swap itself is pure CSS: `<html data-theme>` selects a --sc-*
 * block in src/index.css. This module only PERSISTS the choice + per-theme
 * brightness, STAMPS documentElement, and notifies subscribers so the switcher
 * and the dim overlay stay in sync. It NEVER touches data, measurement, WCS,
 * or any receipt value — display consuming both ledgers, feeding neither.
 *
 * Storage mirrors the diag_prefs / render_prefs / workspace_store pattern:
 * try/catch localStorage, brand-neutral `skycruncher.ui.*` keys. Every read is
 * defensive — absent, corrupt, or storage-unavailable all fall back to the
 * honest default (dark, full brightness) and never throw.
 *
 * Night additionally implies a motion-kill; that is handled entirely by the
 * `[data-theme="night"] *` rule in src/index.css — this module does not fight it.
 *
 * POP-OUT SYNC (BroadcastChannel('sc-render-prefs')) is specified in the token
 * spec and is a FOLLOW-UP: child windows will apply theme at
 * documentElement[data-theme] and own a per-window dim overlay. Not wired here.
 */

export type Theme = 'dark' | 'light' | 'night';

export const THEMES: readonly Theme[] = ['dark', 'light', 'night'];

/** Default when nothing is persisted / storage is unavailable / value is corrupt. */
export const DEFAULT_THEME: Theme = 'dark';

export const THEME_STORAGE_KEY = 'skycruncher.ui.theme';
/** Per-theme brightness key: `skycruncher.ui.brightness.<theme>`. */
export const BRIGHTNESS_STORAGE_PREFIX = 'skycruncher.ui.brightness.';

/** Brightness is a whole percent in [MIN, MAX]. */
export const MIN_BRIGHTNESS = 10;
export const MAX_BRIGHTNESS = 100;

/**
 * Per-theme default brightness. Day themes render at full brightness (the dim
 * overlay is invisible); night defaults to 45 — a real, stated dark-adaptation
 * trade (see the night block legibility-floor comment in src/index.css).
 */
export const DEFAULT_BRIGHTNESS: Record<Theme, number> = {
    dark: 100,
    light: 100,
    night: 45,
};

export function isTheme(v: unknown): v is Theme {
    return v === 'dark' || v === 'light' || v === 'night';
}

// ── Density + peek render prefs (single source, for the pop-out snapshot) ─────
// The pop-out sync channel (render_prefs_channel.ts) broadcasts a snapshot of
// {theme, brightness, density, peek} per the token spec. theme + brightness
// already live above; density + peek live HERE so there is ONE render-pref
// source and any change fans out through notify() → the host re-broadcasts.
// These are RENDER-plane presentation prefs (never data/measurement). Their
// interactive surfaces (density control, calibrated-peek) are follow-ups; the
// getters below default honestly so the snapshot is complete today.

export type Density = 'comfortable' | 'compact';
export const DEFAULT_DENSITY: Density = 'comfortable';
export const DENSITY_STORAGE_KEY = 'skycruncher.ui.density';

export function isDensity(v: unknown): v is Density {
    return v === 'comfortable' || v === 'compact';
}

/** Read the persisted density, validated. Defaults to comfortable; never throws. */
export function getDensity(): Density {
    try {
        const raw = localStorage.getItem(DENSITY_STORAGE_KEY);
        return isDensity(raw) ? raw : DEFAULT_DENSITY;
    } catch {
        return DEFAULT_DENSITY;
    }
}

/** Persist density (coerced to a valid value) + notify. */
export function setDensity(d: Density): void {
    const v = isDensity(d) ? d : DEFAULT_DENSITY;
    try {
        localStorage.setItem(DENSITY_STORAGE_KEY, v);
    } catch {
        /* storage unavailable — still notify the live session */
    }
    notify();
}

/**
 * Peek prefs — the render-plane "peek" calibration carried on the sync channel:
 *   saved    = the peek-reveal brightness percent [MIN, MAX] (default full)
 *   duration = revert-hold duration in ms after a calibrated peek (default 8s)
 * The night preview-peek veil (NightPeek) is press-and-hold today; these prefs
 * feed the future calibrated-peek + let a child window mirror the host's choice.
 * Render-plane only; never a measurement.
 */
export interface PeekPrefs {
    saved: number;
    duration: number;
}
export const DEFAULT_PEEK: PeekPrefs = { saved: MAX_BRIGHTNESS, duration: 8000 };
export const PEEK_SAVED_STORAGE_KEY = 'skycruncher.ui.peek.saved';
export const PEEK_DURATION_STORAGE_KEY = 'skycruncher.ui.peek.duration';

/** Clamp a peek duration to a sane [0, 60000] ms window; non-finite → default. */
export function clampPeekDuration(ms: number): number {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return DEFAULT_PEEK.duration;
    return Math.min(60000, Math.max(0, n));
}

/** Read peek prefs, each field validated; absent/corrupt → defaults. Never throws. */
export function getPeekPrefs(): PeekPrefs {
    try {
        const rawSaved = localStorage.getItem(PEEK_SAVED_STORAGE_KEY);
        const rawDur = localStorage.getItem(PEEK_DURATION_STORAGE_KEY);
        const saved = rawSaved == null ? DEFAULT_PEEK.saved : clampBrightness(parseInt(rawSaved, 10));
        const duration = rawDur == null ? DEFAULT_PEEK.duration : clampPeekDuration(parseInt(rawDur, 10));
        return { saved, duration };
    } catch {
        return { ...DEFAULT_PEEK };
    }
}

/** Persist a partial peek-prefs patch (clamped) + notify. */
export function setPeekPrefs(patch: Partial<PeekPrefs>): void {
    try {
        if (patch.saved != null) localStorage.setItem(PEEK_SAVED_STORAGE_KEY, String(clampBrightness(patch.saved)));
        if (patch.duration != null) localStorage.setItem(PEEK_DURATION_STORAGE_KEY, String(clampPeekDuration(patch.duration)));
    } catch {
        /* storage unavailable — still notify the live session */
    }
    notify();
}

/** Clamp any input to a whole percent in [MIN, MAX]; non-finite → MAX (no dim). */
export function clampBrightness(pct: number): number {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return MAX_BRIGHTNESS;
    return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, n));
}

/** Read the persisted theme, validated. Defaults to dark; never throws. */
export function getTheme(): Theme {
    try {
        const raw = localStorage.getItem(THEME_STORAGE_KEY);
        return isTheme(raw) ? raw : DEFAULT_THEME;
    } catch {
        return DEFAULT_THEME;
    }
}

function brightnessKey(theme: Theme): string {
    return BRIGHTNESS_STORAGE_PREFIX + theme;
}

/** Read a theme's brightness percent; absent/corrupt → the per-theme default. */
export function getBrightness(theme: Theme): number {
    try {
        const raw = localStorage.getItem(brightnessKey(theme));
        if (raw == null) return DEFAULT_BRIGHTNESS[theme];
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return DEFAULT_BRIGHTNESS[theme];
        return clampBrightness(n);
    } catch {
        return DEFAULT_BRIGHTNESS[theme];
    }
}

/**
 * Dim-overlay opacity for a theme: 1 - brightness/100, clamped to [0, 1].
 * POLARITY: lower brightness → MORE dim. Full brightness (100) → 0 (overlay
 * invisible / no-op); night default (45) → 0.55.
 */
export function dimOpacity(theme: Theme = getTheme(), brightness: number = getBrightness(theme)): number {
    const o = 1 - clampBrightness(brightness) / 100;
    return Math.min(1, Math.max(0, o));
}

/**
 * Stamp documentElement[data-theme]. SYNCHRONOUS on purpose: setAttribute lands
 * before the browser's next paint, so switching to night never flashes bright.
 * Guarded for headless/SSR (no document).
 */
export function applyThemeToDocument(theme: Theme = getTheme()): void {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.setAttribute('data-theme', theme);
}

/** Persist + stamp + notify. Invalid input is coerced to the default. */
export function setTheme(theme: Theme): void {
    const t = isTheme(theme) ? theme : DEFAULT_THEME;
    try {
        localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
        /* storage unavailable — still stamp so the live session reflects it */
    }
    applyThemeToDocument(t);
    notify();
}

/** Persist a theme's brightness (clamped) + notify. */
export function setBrightness(theme: Theme, pct: number): void {
    const v = clampBrightness(pct);
    try {
        localStorage.setItem(brightnessKey(theme), String(v));
    } catch {
        /* storage unavailable — the notify still updates the live overlay */
    }
    notify();
}

/**
 * Boot: read the persisted theme and stamp it synchronously (call from main.tsx
 * before the first render so night users never see a bright first paint).
 * Returns the resolved theme.
 */
export function initTheme(): Theme {
    const t = getTheme();
    applyThemeToDocument(t);
    return t;
}

// ── Reactive glue ───────────────────────────────────────────────────────────
// A tiny synchronous pub/sub so the switcher and the dim overlay re-read state
// on any change (theme or per-theme brightness). Render-prefs only.

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to theme/brightness changes; returns an unsubscribe fn. */
export function subscribeThemeChange(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function notify(): void {
    for (const l of listeners) {
        try { l(); } catch { /* a bad listener never breaks the others */ }
    }
}
