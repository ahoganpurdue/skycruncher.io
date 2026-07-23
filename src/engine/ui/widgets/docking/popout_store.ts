/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POPOUT STORE — per-widget popout window bounds (Profile schema v2, additive)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase C persistence (DASHBOARD_DOCKING_SPEC §7): a popout window restores its
 * last position/size when reopened. This is an ADDITIVE sibling of the docking
 * layout profile — same versioned-envelope surface (`widget_persist`), same
 * schema version constant (`DOCKING_SCHEMA_VERSION`), a SEPARATE key so bounds
 * churn (drag/resize) never rewrites the layout blob and vice-versa. Bounds are
 * keyed by WIDGET id (not panel id) so a widget popped, closed, and popped again
 * reopens where the user last left it.
 *
 * Single-writer (SPEC §7): only the MAIN window persists. Never throws — a
 * corrupt/stale blob simply yields no restored bounds and the popout opens at
 * the default position (`DEFAULT_POPOUT_BOUNDS`); honest absence, never a crash.
 *
 * PURE-ish: the only ambient dependency is `localStorage` (through
 * `widget_persist`, all try/caught) → headless/Node-safe, unit-tested.
 */

import { readVersioned, writeVersioned, clearKey } from '../widget_persist';
import { DOCKING_SCHEMA_VERSION } from './docking_store';
import { isValidBounds, type PopoutBounds } from './popout_bridge';

/** localStorage key for popout window bounds (brand-neutral, LAW 6). */
export const POPOUT_BOUNDS_STORAGE_KEY = 'skycruncher.docking.popouts';

/** The stored payload: a map of widget id → last window bounds. */
export interface PopoutBoundsProfile {
    bounds: Record<string, PopoutBounds>;
}

/** Structural gate — a `bounds` object whose every value is valid bounds. */
export function isPopoutBoundsProfile(d: unknown): d is PopoutBoundsProfile {
    if (!d || typeof d !== 'object') return false;
    const bounds = (d as { bounds?: unknown }).bounds;
    if (!bounds || typeof bounds !== 'object') return false;
    // Every entry must be valid bounds — one bad entry invalidates the blob so
    // we reset cleanly rather than restore a half-garbage map.
    return Object.values(bounds as Record<string, unknown>).every(isValidBounds);
}

/**
 * Load the full widget→bounds map. A missing/corrupt/stale blob yields `{}`
 * (honest absence — popouts open at the default). Never throws.
 */
export function loadPopoutBounds(): Record<string, PopoutBounds> {
    const data = readVersioned<PopoutBoundsProfile>(
        POPOUT_BOUNDS_STORAGE_KEY,
        DOCKING_SCHEMA_VERSION,
        isPopoutBoundsProfile,
    );
    return data ? { ...data.bounds } : {};
}

/**
 * Persist bounds for one widget (read-modify-write, preserving other widgets'
 * bounds). Single-writer (main). Best-effort — never throws. Invalid bounds are
 * ignored (we never persist a 0×0 / off-screen blob).
 */
export function savePopoutBoundsFor(widgetId: string, bounds: PopoutBounds): void {
    if (!widgetId || !isValidBounds(bounds)) return;
    const current = loadPopoutBounds();
    current[widgetId] = bounds;
    writeVersioned<PopoutBoundsProfile>(POPOUT_BOUNDS_STORAGE_KEY, DOCKING_SCHEMA_VERSION, { bounds: current });
}

/** Drop all persisted popout bounds (explicit reset). Never throws. */
export function clearPopoutBounds(): void {
    clearKey(POPOUT_BOUNDS_STORAGE_KEY);
}
