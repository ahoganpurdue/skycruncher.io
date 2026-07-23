/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOCKING STORE — Profile schema v2 (dockview layout persistence)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Persists the dockview `toJSON()` blob under the shared versioned-envelope
 * surface (widget_persist.ts). This is **Profile schema v2** — the versioned
 * successor to workspace_store's v1 hand-rolled layout tree (DASHBOARD_DOCKING_
 * SPEC §7 + Decision 1 (ii): the v1 tree is superseded; its Profile/named-
 * workspace concepts carry over, the layout ENGINE is now dockview).
 *
 * HARD GUARANTEE (SPEC §7, LAW 3 honest-or-absent): a stale/corrupt/failed
 * layout blob resets **LOUDLY** to the default layout — never a silent partial
 * render. `loadDockingLayout()` returns `{ layout, wasReset }`; `wasReset` is
 * true exactly when a stored blob existed but did not validate, so the caller
 * (DockingSurface) logs the reset and builds the default layout instead.
 *
 * Phase B stores a single default workspace's layout. Named/type-mapped
 * workspaces (v1's typeMap) are Phase D — the envelope's `data` shape can grow
 * additively without a version bump for additive fields, or with a v3 bump for
 * a breaking one.
 *
 * PURE-ish: only ambient dependency is `localStorage` (through widget_persist,
 * try/caught) — headless/Node-safe. The only dockview coupling is a TYPE-ONLY
 * import of `SerializedDockview` (erased at runtime; no dockview module loads in
 * Node), so this module and its unit test never pull the dockview runtime.
 */

import type { SerializedDockview } from 'dockview-core';
import { readVersioned, writeVersioned, clearKey } from '../widget_persist';

/** Profile schema version — v2 (v1 = workspace_store's layout tree, superseded). */
export const DOCKING_SCHEMA_VERSION = 2;

/** localStorage key for the persisted dockview layout (brand-neutral). */
export const DOCKING_PROFILE_STORAGE_KEY = 'skycruncher.docking.profile';

/**
 * The versioned payload we store. Wrapped (not the bare layout) so Phase D can
 * add named workspaces / typeMap additively beside `layout`.
 */
export interface DockingData {
    /** dockview `api.toJSON()` output — the full serialized layout incl. panels. */
    layout: SerializedDockview;
}

/**
 * Cheap structural gate for a persisted layout blob. The AUTHORITATIVE
 * validation is dockview's own `fromJSON` (try/caught at the call site) — this
 * only rejects obviously-wrong shapes early so a garbage blob never even
 * reaches dockview. A real `SerializedDockview` always carries `grid` + `panels`.
 */
export function isDockingData(d: unknown): d is DockingData {
    if (!d || typeof d !== 'object') return false;
    const layout = (d as { layout?: unknown }).layout as
        | { grid?: unknown; panels?: unknown }
        | undefined;
    return !!layout
        && typeof layout === 'object'
        && !!layout.grid && typeof layout.grid === 'object'
        && !!layout.panels && typeof layout.panels === 'object';
}

export interface LoadedLayout {
    /** The restored layout, or `null` ⇒ the caller builds the default layout. */
    layout: SerializedDockview | null;
    /**
     * True iff a stored blob EXISTED but failed to validate — the LOUD-reset
     * signal (SPEC §7). Distinguishes "corrupt → reset" from a clean first run
     * (no blob), which is not a reset.
     */
    wasReset: boolean;
}

/**
 * Per-popout-window layout key (SPEC §5b — Profile v2 ADDITIVE: same schema
 * version, a NEW key namespace, no version bump). A popout is a full docking
 * workspace; its layout persists SEPARATELY from the main window's, keyed by the
 * SEED widget id — windows are ephemeral (`popout-<panelId>` regenerates each
 * pop) so the seed widget is the reproducible identity (mirrors how popout_store
 * keys BOUNDS by widget id). Reopening a popout for the same seed restores its
 * whole multi-widget tree. Brand-neutral (LAW 6). PURE.
 */
export function popoutLayoutStorageKey(widgetId: string): string {
    const safe = widgetId || '__none__';
    return `${DOCKING_PROFILE_STORAGE_KEY}.popout.${safe}`;
}

/**
 * Load the persisted layout for `storageKey` (default = the MAIN window key). A
 * present-but-invalid blob yields `{ layout: null, wasReset: true }` so the
 * caller resets loudly; a clean first run (no key) yields
 * `{ layout: null, wasReset: false }`. Never throws.
 */
export function loadDockingLayout(storageKey: string = DOCKING_PROFILE_STORAGE_KEY): LoadedLayout {
    let rawPresent = false;
    try { rawPresent = localStorage.getItem(storageKey) != null; }
    catch { rawPresent = false; }
    const data = readVersioned<DockingData>(
        storageKey,
        DOCKING_SCHEMA_VERSION,
        isDockingData,
    );
    if (data) return { layout: data.layout, wasReset: false };
    return { layout: null, wasReset: rawPresent };
}

/** Persist the current dockview layout under `storageKey`. Best-effort (never throws). */
export function saveDockingLayout(layout: SerializedDockview, storageKey: string = DOCKING_PROFILE_STORAGE_KEY): void {
    writeVersioned<DockingData>(storageKey, DOCKING_SCHEMA_VERSION, { layout });
}

/** Drop the persisted layout for `storageKey` (explicit reset after a failed `fromJSON`). */
export function clearDockingLayout(storageKey: string = DOCKING_PROFILE_STORAGE_KEY): void {
    clearKey(storageKey);
}

/**
 * First-run seed layout (DASHBOARD_DOCKING_SPEC §7). A handful of the most
 * load-bearing widgets so a fresh dashboard is legible instead of near-empty
 * (owner walkthrough 2026-07-21 — "couldn't even find the widgets"). Every id is
 * a legacy-default-VISIBLE tier (stats/chart — what the WidgetDock grid shows
 * before the weight knob is raised) so docking parity is intuitive; NO heavy
 * WebGL is seeded (that stays a deliberate ribbon opt-in, keeping the first paint
 * off the per-frame-work path). Kept HERE (not in DockingSurface) so it is unit-
 * testable without pulling the dockview runtime.
 */
export const DEFAULT_PANELS: readonly string[] = [
    'solve_summary',        // stats — headline solve numbers
    'solve_flowchart',      // stats — the ★ DAG
    'greenfield_solve_stats', // chart — all-real greenfield solve/replay stats
    'replay_timeline',      // chart — replay context timeline
    'deep_confirm',         // chart — forced-photometry confirmation
];

// ─── drag-and-drop shared constants + geometry (pure) ───────────────────────

/**
 * Custom drag MIME for ribbon chip → dockview external drops. dockview's
 * `onUnhandledDragOver` inspects `dataTransfer.types` for this to show the drop
 * overlay; `onDidDrop` reads the widget id back out of it.
 */
export const RIBBON_WIDGET_MIME = 'application/x-skycruncher-widget';

/** dockview component-renderer id every widget panel uses. */
export const WIDGET_PANEL_COMPONENT = 'widget';

/**
 * dockview drop-overlay Position ('top'|'bottom'|'left'|'right'|'center') → the
 * panel-add Direction ('above'|'below'|'left'|'right'|'within'). Kept local (no
 * dockview runtime import) — the literal unions mirror dockview-core's `Position`
 * / `Direction`, tsc-checked at the DockingSurface call site.
 */
export type DropPosition = 'top' | 'bottom' | 'left' | 'right' | 'center';
export type PanelDirection = 'left' | 'right' | 'above' | 'below' | 'within';

const POSITION_TO_DIRECTION: Record<DropPosition, PanelDirection> = {
    center: 'within',
    top: 'above',
    bottom: 'below',
    left: 'left',
    right: 'right',
};

export function positionToDirection(p: DropPosition): PanelDirection {
    return POSITION_TO_DIRECTION[p] ?? 'within';
}

// ─── shift-split (SPEC §5b — force a split, never a tab, while shift is held) ──

/**
 * dockview's drop-overlay location kind (mirrors dockview-core's
 * `DockviewGroupDropLocation`; kept local — no dockview runtime import, string
 * union tsc-checked at the DockingSurface `onWillShowOverlay` call site).
 *   • 'tab'          — dropping onto the tab strip (always tabs).
 *   • 'header_space' — the empty header area (tabs).
 *   • 'content'      — the 5-zone content overlay (center = within/tab; edges = split).
 *   • 'edge'         — the whole-dockview edge zones (always split).
 */
export type DropOverlayKind = 'tab' | 'header_space' | 'content' | 'edge';

/**
 * Should this drop-overlay location be SUPPRESSED because shift is forcing a
 * split? (SPEC §5b.) True iff shift is held AND the location would create a TAB
 * (`kind==='tab'`/`'header_space'`, or the content-center `position==='center'`).
 * Suppressing those overlays via `preventDefault()` leaves only the edge SPLIT
 * zones acceptable — "shift = never tab", uniform across internal tab moves and
 * external ribbon-chip drags. PURE (no dockview types) so it is unit-testable.
 */
export function shouldBlockTabDrop(kind: DropOverlayKind, position: DropPosition, shiftKey: boolean): boolean {
    if (!shiftKey) return false;
    return kind === 'tab' || kind === 'header_space' || position === 'center';
}

/**
 * Defensive remap for the EXTERNAL ribbon-chip path (`onDidDrop`): a shift+center
 * drop that still reaches us (overlay suppression is the primary guard) is placed
 * as a split rather than a tab. Non-shift or non-center drops pass through
 * unchanged. PURE.
 */
export function splitDirectionForShift(position: DropPosition, shiftKey: boolean): DropPosition {
    return shiftKey && position === 'center' ? 'right' : position;
}

/** A stable, collision-resistant panel id for a freshly-placed widget. */
export function makePanelId(widgetId: string): string {
    return `${widgetId}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ─── viewport-anchored ribbon positioning (SPEC §6b — "bottom of the SCREEN") ──

/**
 * The ribbon's stacking order as a viewport-fixed bar. ABOVE normal page content
 * (which sits at the auto/0 layer) but BELOW the app's modal/overlay layer (the
 * processing overlay + dialogs live at z-index 100/1000). A mid value keeps the
 * add-widget palette reachable without ever masking a modal.
 */
export const RIBBON_Z_INDEX = 40;

/** Horizontal anchor for the fixed ribbon, measured from the surface container. */
export interface RibbonRect {
    /** Container left edge in viewport px (getBoundingClientRect().left). */
    left: number;
    /** Container width in viewport px. */
    width: number;
}

/**
 * The fixed-position style for the ribbon, or `null` when it must not render.
 * PURE (no DOM / no React) so the anchor logic is unit-testable headlessly.
 *
 *   • `visible === false` (docking surface out of view) ⇒ `null`: the ribbon is
 *     not rendered at all, so it never covers page content the user is reading
 *     while the dashboard is far off-screen.
 *   • measured container rect ⇒ pinned to that rect's left+width (aligns the bar
 *     to the surface's own column, not the whole browser).
 *   • no/degenerate rect (pre-measure, zero width) ⇒ full-viewport fallback
 *     (`left:0,right:0`) so the bar is still reachable, never zero-width.
 * Always `position:fixed; bottom:0` — anchored to the viewport bottom.
 */
export interface RibbonFixedStyle {
    position: 'fixed';
    bottom: 0;
    zIndex: number;
    left: number;
    width?: number;
    right?: number;
}
export function computeRibbonFixedStyle(visible: boolean, rect: RibbonRect | null): RibbonFixedStyle | null {
    if (!visible) return null;
    const base = { position: 'fixed', bottom: 0, zIndex: RIBBON_Z_INDEX } as const;
    if (rect && rect.width > 0) return { ...base, left: rect.left, width: rect.width };
    return { ...base, left: 0, right: 0 };
}

/** A viewport-coordinate rect (getBoundingClientRect subset) for the in-view test. */
export interface ViewRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/**
 * Is `rect` (a getBoundingClientRect, i.e. VIEWPORT coordinates) at least
 * partially inside the viewport, expanded by `nearPx` on every edge so "near
 * view" counts too? PURE (no DOM) so the in-view decision that gates the ribbon
 * is unit-testable headlessly — this is the invariant that must recover the
 * ribbon from its `null` state once the ALWAYS-rendered surface host enters view.
 *
 * Standard inclusive AABB overlap test. A degenerate viewport (0 w/h — e.g. a
 * headless/unmeasured environment) ⇒ `true`: never hide the ribbon because we
 * could not measure. Because the input rect comes from the surface CONTAINER (an
 * element that always renders), this stays computable independent of whether the
 * ribbon itself is currently mounted — no self-gating deadlock is possible.
 */
export function rectInViewport(rect: ViewRect, viewportW: number, viewportH: number, nearPx = 0): boolean {
    if (!(viewportW > 0) || !(viewportH > 0)) return true;   // unmeasurable ⇒ assume visible
    return rect.bottom >= -nearPx
        && rect.top <= viewportH + nearPx
        && rect.right >= -nearPx
        && rect.left <= viewportW + nearPx;
}
