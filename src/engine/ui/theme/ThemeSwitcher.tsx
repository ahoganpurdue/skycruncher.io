import React, { useSyncExternalStore } from 'react';
import {
    type Theme,
    getTheme,
    setTheme,
    getBrightness,
    setBrightness,
    subscribeThemeChange,
    MIN_BRIGHTNESS,
    MAX_BRIGHTNESS,
} from './theme_state';

/**
 * THEME SWITCHER (RENDER plane) — the header control that swaps the three
 * render-plane themes, mirroring the design mockup's app header (screen 2a/3b):
 * a segmented Light · Dark · ✦ Stargazing control on the right of the header,
 * with a per-mode Brightness slider that appears only in night.
 *
 * Entering night never flashes bright: setTheme() stamps documentElement
 * synchronously (before the next paint) and night's page surface is already
 * dark. Large tap targets (≥ 32px) per the density floor. Tailwind utilities
 * bound to @theme tokens — the filled/active button uses the --sc-btn-* tokens
 * so it stays correct in every theme. Presentation only; no data touched.
 */

const OPTIONS: { theme: Theme; label: string; title: string }[] = [
    { theme: 'light', label: 'Light', title: 'Light theme — warm-paper daytime' },
    { theme: 'dark', label: 'Dark', title: 'Dark theme — instrument default' },
    { theme: 'night', label: '✦ Stargazing', title: 'Stargazing — red-space, preserves dark adaptation' },
];

export const ThemeSwitcher: React.FC = () => {
    const theme = useSyncExternalStore(subscribeThemeChange, getTheme, () => 'dark' as Theme);
    const nightBrightness = useSyncExternalStore(
        subscribeThemeChange,
        () => getBrightness('night'),
        () => getBrightness('night'),
    );

    return (
        <div className="flex items-center gap-4" data-testid="theme-switcher">
            {theme === 'night' && (
                <label className="flex items-center gap-2" data-testid="theme-brightness">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                        Brightness
                    </span>
                    <input
                        type="range"
                        min={MIN_BRIGHTNESS}
                        max={MAX_BRIGHTNESS}
                        value={nightBrightness}
                        aria-label="Night brightness"
                        onChange={(e) => setBrightness('night', Number(e.currentTarget.value))}
                        className="w-[110px] accent-accent-500"
                    />
                    <span className="font-mono text-xs tabular-nums text-data w-9 text-right">
                        {nightBrightness}%
                    </span>
                </label>
            )}
            <div
                role="group"
                aria-label="Theme"
                className="inline-flex overflow-hidden rounded-lg border border-line"
            >
                {OPTIONS.map((o) => {
                    const active = theme === o.theme;
                    return (
                        <button
                            key={o.theme}
                            type="button"
                            title={o.title}
                            aria-pressed={active}
                            data-testid={`theme-btn-${o.theme}`}
                            onClick={() => setTheme(o.theme)}
                            className={
                                'min-h-[32px] px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap ' +
                                'transition-colors ' +
                                (active
                                    ? 'bg-[var(--sc-btn-fill)] text-[var(--sc-btn-fill-text)]'
                                    : 'bg-space-800 text-text-secondary hover:text-text-primary')
                            }
                        >
                            {o.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
