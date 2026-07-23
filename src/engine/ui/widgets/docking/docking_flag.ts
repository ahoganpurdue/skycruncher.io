/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOCKING FLAGS — Phase B in-window docking surface + ribbon (render layer)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two persisted UI flags for the dashboard docking build-out
 * (docs/02-specs/DASHBOARD_DOCKING_SPEC.md, Phase B). Both mirror the existing
 * raw-string flag convention (`skycruncher.widgets.dock` in registry.ts) —
 * '1'/'0' strings, try/catch-wrapped, headless/Node-safe.
 *
 *   • DOCKING enabled — DEFAULT OFF (opt-in). When off/absent the WidgetDock
 *     renders its byte-identical CSS grid; only an explicit '1' swaps in the
 *     dockview docking surface at the SAME mount points. This is the whole
 *     "zero DOM / byte-identical when off" contract: WidgetDock reads this ONCE
 *     and takes the legacy path unless it is '1'.
 *   • RIBBON collapsed — DEFAULT EXPANDED on the first-ever run (owner
 *     walkthrough 2026-07-21: a collapsed 12px strip is undiscoverable — the
 *     owner "couldn't even find the widgets"). Only an explicit persisted '1'
 *     — written the moment the user (or an auto-collapse after a chip drop)
 *     collapses it — keeps it collapsed on the next load. Absent / '0' / any
 *     other value ⇒ expanded. Collapse thus persists ONLY after a real collapse.
 *
 * These gate DISPLAY only. They never touch data collection (LAW: data
 * collection is decoupled from display) and carry no pipeline reach.
 */

/** DEFAULT-OFF mount flag for the Phase-B dockview docking surface. */
export const DOCKING_ENABLED_STORAGE_KEY = 'skycruncher.docking.enabled';

/** DEFAULT-COLLAPSED persisted state for the bottom widget ribbon (§6b). */
export const RIBBON_COLLAPSED_STORAGE_KEY = 'skycruncher.ribbon.collapsed';

/**
 * Per-load URL override for the docking surface: `?docking=1` forces it ON,
 * `?docking=0` forces it OFF, FOR THIS PAGE LOAD ONLY — a pure read, NO
 * localStorage write. Lets a walkthrough flip the surface without devtools.
 * Only the exact values '1'/'0' override; anything else (or an absent param)
 * ⇒ null ⇒ the persisted flag decides exactly as before. Headless-safe
 * (no window ⇒ null). Applies to the DOCKING flag only — nothing else.
 */
export function readDockingUrlOverride(): boolean | null {
    try {
        if (typeof window === 'undefined' || !window.location) return null;
        const v = new URLSearchParams(window.location.search).get('docking');
        if (v === '1') return true;
        if (v === '0') return false;
        return null;
    } catch {
        return null;
    }
}

/**
 * Is the dockview docking surface enabled? A `?docking=1|0` URL param overrides
 * for this load only (pure read, no write). Otherwise DEFAULT OFF (opt-in): only
 * the exact localStorage string '1' turns it on. Absent, '0', or any other value
 * ⇒ off ⇒ WidgetDock keeps its legacy grid (byte-identical). Storage-unavailable
 * ⇒ off. Absence of the URL param ⇒ existing behavior exactly.
 */
export function getDockingEnabled(): boolean {
    const override = readDockingUrlOverride();
    if (override !== null) return override;   // per-load URL override wins, no write
    try { return localStorage.getItem(DOCKING_ENABLED_STORAGE_KEY) === '1'; }
    catch { return false; }
}

export function setDockingEnabled(on: boolean): void {
    try { localStorage.setItem(DOCKING_ENABLED_STORAGE_KEY, on ? '1' : '0'); }
    catch { /* storage unavailable */ }
}

/**
 * Is the widget ribbon collapsed? DEFAULT EXPANDED on the first-ever run: only
 * the exact persisted string '1' collapses it (written when the user, or an
 * auto-collapse after a chip drop, collapses the ribbon). Absent / '0' / any
 * other value ⇒ expanded — so a fresh dashboard shows its add-widget palette and
 * the widgets are discoverable. Storage unavailable ⇒ expanded (never hide the
 * only affordance to add widgets behind an unreadable flag).
 */
export function getRibbonCollapsed(): boolean {
    try { return localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY) === '1'; }
    catch { return false; }
}

export function setRibbonCollapsed(collapsed: boolean): void {
    try { localStorage.setItem(RIBBON_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0'); }
    catch { /* storage unavailable */ }
}
