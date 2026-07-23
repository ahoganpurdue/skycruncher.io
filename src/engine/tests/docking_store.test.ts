import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DOCKING_SCHEMA_VERSION,
    DOCKING_PROFILE_STORAGE_KEY,
    isDockingData,
    loadDockingLayout,
    saveDockingLayout,
    clearDockingLayout,
    positionToDirection,
    makePanelId,
    RIBBON_WIDGET_MIME,
    WIDGET_PANEL_COMPONENT,
    DEFAULT_PANELS,
    RIBBON_Z_INDEX,
    computeRibbonFixedStyle,
    rectInViewport,
    popoutLayoutStorageKey,
    shouldBlockTabDrop,
    splitDirectionForShift,
} from '../ui/widgets/docking/docking_store';

/**
 * Profile schema v2 persistence (DASHBOARD_DOCKING_SPEC §7). Contracts:
 *   • round-trips a dockview layout blob;
 *   • a stale/corrupt blob signals a LOUD reset (wasReset=true, layout=null) —
 *     never a silent partial restore;
 *   • a clean first run (no blob) is NOT a reset (wasReset=false);
 *   • the version gate rejects any non-v2 envelope.
 */

// A minimal object shaped like dockview's SerializedDockview (grid + panels).
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

describe('docking_store — constants', () => {
    it('is Profile schema v2 with brand-neutral key + mime', () => {
        expect(DOCKING_SCHEMA_VERSION).toBe(2);
        expect(DOCKING_PROFILE_STORAGE_KEY).toBe('skycruncher.docking.profile');
        expect(RIBBON_WIDGET_MIME).toBe('application/x-skycruncher-widget');
        expect(WIDGET_PANEL_COMPONENT).toBe('widget');
    });
});

describe('docking_store — first-run seed layout (§7)', () => {
    it('seeds a legible handful of load-bearing widgets (not the 2-panel sparse layout)', () => {
        // Owner walkthrough regression: a fresh dock must NOT be near-empty.
        expect(DEFAULT_PANELS.length).toBeGreaterThanOrEqual(4);
        // The headline solve widgets are always present for parity with the grid.
        expect(DEFAULT_PANELS).toContain('solve_summary');
        expect(DEFAULT_PANELS).toContain('solve_flowchart');
        // A replay/greenfield representative so the "replay trio class" is seeded.
        expect(DEFAULT_PANELS).toContain('greenfield_solve_stats');
        expect(DEFAULT_PANELS).toContain('replay_timeline');
    });
    it('seeds NO heavy WebGL widgets on first paint (per-frame-work stays opt-in)', () => {
        // These heavy WebGL/canvas widgets are deliberately NOT seeded — they mount
        // only on explicit ribbon placement so the first paint is not a rAF storm.
        for (const heavy of ['flattening_cascade', 'lens_profile_3d', 'greenfield_replay', 'greenfield_sky_overlays', 'residual_quiver']) {
            expect(DEFAULT_PANELS).not.toContain(heavy);
        }
    });
    it('has no duplicate ids (each seeded panel is distinct)', () => {
        expect(new Set(DEFAULT_PANELS).size).toBe(DEFAULT_PANELS.length);
    });
});

describe('docking_store — viewport-fixed ribbon positioning (§6b)', () => {
    it('out-of-view surface ⇒ null (ribbon does not render / never covers page content)', () => {
        expect(computeRibbonFixedStyle(false, null)).toBeNull();
        expect(computeRibbonFixedStyle(false, { left: 100, width: 800 })).toBeNull();
    });

    it('in view + measured rect ⇒ fixed bar pinned to the container column', () => {
        const s = computeRibbonFixedStyle(true, { left: 120, width: 640 })!;
        expect(s).not.toBeNull();
        expect(s.position).toBe('fixed');
        expect(s.bottom).toBe(0);
        expect(s.left).toBe(120);
        expect(s.width).toBe(640);
        expect(s.right).toBeUndefined();          // width-anchored, not stretched
        expect(s.zIndex).toBe(RIBBON_Z_INDEX);
    });

    it('in view but rect unmeasured / degenerate ⇒ full-viewport fallback (never zero-width)', () => {
        for (const rect of [null, { left: 0, width: 0 }, { left: 50, width: -3 }]) {
            const s = computeRibbonFixedStyle(true, rect)!;
            expect(s.position).toBe('fixed');
            expect(s.bottom).toBe(0);
            expect(s.left).toBe(0);
            expect(s.right).toBe(0);              // left:0 + right:0 ⇒ spans the viewport
            expect(s.width).toBeUndefined();
        }
    });

    it('z-index sits above page content but below the modal layer (100/1000)', () => {
        expect(RIBBON_Z_INDEX).toBeGreaterThan(0);
        expect(RIBBON_Z_INDEX).toBeLessThan(100);
    });
});

describe('docking_store — rectInViewport (ribbon in-view gate math)', () => {
    const VW = 1280, VH = 800;

    it('a host rect fully inside the viewport ⇒ in view', () => {
        expect(rectInViewport({ top: 16, bottom: 560, left: 100, right: 1180 }, VW, VH)).toBe(true);
    });
    it('a host entirely above / below / left / right ⇒ out of view', () => {
        expect(rectInViewport({ top: -900, bottom: -100, left: 100, right: 700 }, VW, VH)).toBe(false); // above
        expect(rectInViewport({ top: 900, bottom: 1400, left: 100, right: 700 }, VW, VH)).toBe(false);  // below
        expect(rectInViewport({ top: 16, bottom: 560, left: -800, right: -20 }, VW, VH)).toBe(false);   // left
        expect(rectInViewport({ top: 16, bottom: 560, left: 1300, right: 2000 }, VW, VH)).toBe(false);  // right
    });
    it('partial overlap at an edge ⇒ in view (threshold-0 semantics)', () => {
        expect(rectInViewport({ top: -50, bottom: 40, left: 100, right: 700 }, VW, VH)).toBe(true);
    });
    it('nearPx widens the gate so a just-below host counts as "near view"', () => {
        const justBelow = { top: 820, bottom: 1000, left: 100, right: 700 };
        expect(rectInViewport(justBelow, VW, VH, 0)).toBe(false);
        expect(rectInViewport(justBelow, VW, VH, 120)).toBe(true);
    });
    it('a degenerate/unmeasurable viewport ⇒ assume visible (never hide unmeasured)', () => {
        expect(rectInViewport({ top: 900, bottom: 1000, left: 0, right: 10 }, 0, 0)).toBe(true);
        expect(rectInViewport({ top: 900, bottom: 1000, left: 0, right: 10 }, VW, 0)).toBe(true);
    });
});

describe('docking_store — always-rendered-host invariant (no self-gating deadlock)', () => {
    it('a null ribbon recovers once the ALWAYS-rendered host re-enters the viewport', () => {
        // The visibility flag is computed from the HOST (surface container) rect,
        // NOT from the ribbon — so it stays computable while the ribbon is unmounted.
        const VW = 1280, VH = 800;

        // 1) Host below the fold ⇒ not in view ⇒ ribbon not rendered.
        const hostBelow = { top: 2000, bottom: 2600, left: 0, right: 1280 };
        const visible1 = rectInViewport(hostBelow, VW, VH, 120);
        expect(visible1).toBe(false);
        expect(computeRibbonFixedStyle(visible1, null)).toBeNull();   // ribbon absent

        // 2) Host scrolled into view (measured from the host, which ALWAYS renders)
        //    ⇒ in view ⇒ ribbon renders. This is exactly the flip that deadlocked
        //    when the observer watched the ribbon's own (null) element.
        const hostInView = { top: 16, bottom: 560, left: 0, right: 1280 };
        const visible2 = rectInViewport(hostInView, VW, VH, 120);
        expect(visible2).toBe(true);
        expect(computeRibbonFixedStyle(visible2, { left: 0, width: 1280 })).not.toBeNull();
    });

    it('mount race: degenerate host rect at first evaluate, grown rect later → flips true', () => {
        // The failure the ResizeObserver-on-host + deferred evaluate fixes: IO fires
        // ONE initial callback while dockview is still initializing, so the first
        // evaluate() sees a not-yet-laid-out host and reads OUT of view; the host
        // then GROWS into its real rect but IO never re-fires (intersection status
        // unchanged) and an idle page has no scroll/resize. RO-on-host / deferred
        // rAF is the missing trigger.
        const VW = 1280, VH = 800;
        // First evaluate — the not-yet-laid-out host reads as out of view (a ~0-height
        // box well past the near threshold: top 2000 > vh+nearPx = 920).
        const atMount = { top: 2000, bottom: 2000, left: 0, right: 0 };
        expect(rectInViewport(atMount, VW, VH, 120)).toBe(false);
        // RO (host size change) / deferred evaluate re-runs on the settled ~418px
        // rect — now on screen ⇒ in view ⇒ ribbon renders.
        const afterLayout = { top: 16, bottom: 434, left: 0, right: 1280 };
        expect(rectInViewport(afterLayout, VW, VH, 120)).toBe(true);
    });
});

describe('docking_store — isDockingData structural gate', () => {
    it('accepts a layout with grid + panels, rejects garbage', () => {
        expect(isDockingData({ layout: fakeLayout() })).toBe(true);
        expect(isDockingData(null)).toBe(false);
        expect(isDockingData({})).toBe(false);
        expect(isDockingData({ layout: {} })).toBe(false);
        expect(isDockingData({ layout: { grid: {} } })).toBe(false);         // no panels
        expect(isDockingData({ layout: { panels: {} } })).toBe(false);       // no grid
        expect(isDockingData('a string')).toBe(false);
    });
});

describe('docking_store — persistence round-trip', () => {
    it('saves and restores a layout (wasReset=false)', () => {
        const layout = fakeLayout(3);
        saveDockingLayout(layout);
        const loaded = loadDockingLayout();
        expect(loaded.wasReset).toBe(false);
        expect(loaded.layout).toEqual(layout);
    });

    it('clean first run (no blob) → null layout, NOT a reset', () => {
        const loaded = loadDockingLayout();
        expect(loaded.layout).toBeNull();
        expect(loaded.wasReset).toBe(false);
    });

    it('clearDockingLayout drops the persisted layout', () => {
        saveDockingLayout(fakeLayout());
        clearDockingLayout();
        const loaded = loadDockingLayout();
        expect(loaded.layout).toBeNull();
        expect(loaded.wasReset).toBe(false);
    });
});

describe('docking_store — LOUD reset on stale/corrupt blobs (SPEC §7)', () => {
    it('corrupt JSON → reset (layout=null, wasReset=true)', () => {
        localStorage.setItem(DOCKING_PROFILE_STORAGE_KEY, '{not json');
        const loaded = loadDockingLayout();
        expect(loaded.layout).toBeNull();
        expect(loaded.wasReset).toBe(true);
    });

    it('wrong schema version → reset', () => {
        // Envelope with v=1 (workspace v1) must not restore as a v2 layout.
        localStorage.setItem(DOCKING_PROFILE_STORAGE_KEY, JSON.stringify({ v: 1, data: { layout: fakeLayout() } }));
        const loaded = loadDockingLayout();
        expect(loaded.layout).toBeNull();
        expect(loaded.wasReset).toBe(true);
    });

    it('valid envelope but mis-shaped layout → reset', () => {
        localStorage.setItem(DOCKING_PROFILE_STORAGE_KEY, JSON.stringify({ v: 2, data: { layout: { nope: true } } }));
        const loaded = loadDockingLayout();
        expect(loaded.layout).toBeNull();
        expect(loaded.wasReset).toBe(true);
    });
});

describe('docking_store — drop geometry', () => {
    it('maps dockview drop positions to panel directions', () => {
        expect(positionToDirection('center')).toBe('within');   // tab stack
        expect(positionToDirection('top')).toBe('above');
        expect(positionToDirection('bottom')).toBe('below');
        expect(positionToDirection('left')).toBe('left');
        expect(positionToDirection('right')).toBe('right');
    });
});

describe('docking_store — panel ids', () => {
    it('makePanelId embeds the widget id and is collision-resistant', () => {
        const a = makePanelId('solve_summary');
        const b = makePanelId('solve_summary');
        expect(a.startsWith('solve_summary__')).toBe(true);
        expect(a).not.toBe(b);
    });
});

describe('docking_store — per-popout-window layout key (SPEC §5b, Profile v2 additive)', () => {
    it('keys by the SEED widget id under the main profile namespace', () => {
        expect(popoutLayoutStorageKey('solve_summary')).toBe('skycruncher.docking.profile.popout.solve_summary');
        // Distinct seeds ⇒ distinct keys; all under the main profile namespace but
        // never the main key itself (main and popouts persist separately).
        expect(popoutLayoutStorageKey('solve_flowchart')).not.toBe(popoutLayoutStorageKey('solve_summary'));
        expect(popoutLayoutStorageKey('solve_summary')).not.toBe(DOCKING_PROFILE_STORAGE_KEY);
        expect(popoutLayoutStorageKey('solve_summary').startsWith(DOCKING_PROFILE_STORAGE_KEY)).toBe(true);
    });

    it('an empty seed id yields a stable, non-colliding key', () => {
        expect(popoutLayoutStorageKey('')).toBe('skycruncher.docking.profile.popout.__none__');
    });

    it('a popout layout round-trips under its own key, isolated from the main layout', () => {
        const mainLayout = fakeLayout(5);
        const popoutLayout = fakeLayout(2);
        const key = popoutLayoutStorageKey('solve_summary');
        saveDockingLayout(mainLayout);                     // main (default key)
        saveDockingLayout(popoutLayout, key);              // popout (per-window key)
        // Each key restores its own tree — no cross-contamination.
        expect(loadDockingLayout().layout).toEqual(mainLayout);
        expect(loadDockingLayout(key).layout).toEqual(popoutLayout);
        // Clearing the popout key leaves the main layout intact.
        clearDockingLayout(key);
        expect(loadDockingLayout(key).layout).toBeNull();
        expect(loadDockingLayout().layout).toEqual(mainLayout);
    });
});

describe('docking_store — shift-split (SPEC §5b: force split, never tab)', () => {
    it('with shift held, tab/header/center overlays are BLOCKED (only splits remain)', () => {
        expect(shouldBlockTabDrop('tab', 'center', true)).toBe(true);            // tab strip
        expect(shouldBlockTabDrop('header_space', 'center', true)).toBe(true);   // empty header
        expect(shouldBlockTabDrop('content', 'center', true)).toBe(true);        // content centre = within/tab
    });

    it('with shift held, edge SPLIT overlays are still allowed', () => {
        for (const pos of ['top', 'bottom', 'left', 'right'] as const) {
            expect(shouldBlockTabDrop('content', pos, true)).toBe(false);
        }
        expect(shouldBlockTabDrop('edge', 'right', true)).toBe(false);
    });

    it('without shift, nothing is blocked (tabbing works normally)', () => {
        expect(shouldBlockTabDrop('tab', 'center', false)).toBe(false);
        expect(shouldBlockTabDrop('content', 'center', false)).toBe(false);
    });

    it('splitDirectionForShift remaps a shift+center ribbon drop to a split, else passthrough', () => {
        expect(splitDirectionForShift('center', true)).toBe('right');   // forced split
        expect(splitDirectionForShift('center', false)).toBe('center'); // normal tab
        expect(splitDirectionForShift('left', true)).toBe('left');      // already a split → unchanged
        expect(splitDirectionForShift('bottom', true)).toBe('bottom');
    });
});

describe('docking_store — headless-safe', () => {
    it('no localStorage ⇒ null load, no-op save, no throw', () => {
        delete (globalThis as any).localStorage;
        expect(loadDockingLayout()).toEqual({ layout: null, wasReset: false });
        expect(() => saveDockingLayout(fakeLayout())).not.toThrow();
        expect(() => clearDockingLayout()).not.toThrow();
        installLocalStorage();
    });
});
