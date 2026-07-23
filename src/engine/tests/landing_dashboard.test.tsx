import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WIDGETS } from '../ui/widgets/registry';
import { WidgetDock } from '../ui/widgets/WidgetDock';
import { ReplayDashboard } from '../ui/dashboard/replay/ReplayDashboard';

/** In-memory localStorage stub (node env has none) — lets a test pick the dock
 *  weight knob so chart/heavy-tier widgets (e.g. scaffolds) actually render. */
function installLocalStorage(seed?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed ?? {}));
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

/**
 * LANDING DASHBOARD (v1.0.0 triage) — the owner expected a dashboard on launch,
 * so MainApp now co-mounts <ReplayDashboard/> and <WidgetDock receipt={null}/> on
 * the landing branch (below the upload hero). Both are lazy in MainApp, so we
 * server-render the components directly here (react-dom/server, node env — same
 * idiom as starplate_library_card.test.tsx).
 *
 * The load-bearing invariant (LAW 3): with a NULL receipt every widget frame must
 * self-gate to an honest NOT MEASURED / empty state — NEVER a fabricated number.
 */
describe('Landing dashboard on a null receipt (LAW 3 — honest-or-absent)', () => {
    it('no widget selector THROWS on a null receipt/events', () => {
        for (const w of WIDGETS) {
            expect(() => w.dataSelector(null, undefined), `selector "${w.id}" threw on null receipt`).not.toThrow();
        }
    });

    it('receipt-backed widget selectors return null (⇒ NOT MEASURED) on a null receipt', () => {
        // These three legitimately return a non-null shell whose OWN render shows
        // an honest empty state (structural DAG / context-fed timeline / env-fed
        // library) — verified by the dock render below. Every OTHER widget must
        // return null so the dock frame paints the single NOT MEASURED state.
        // solve_flowchart_webgpu reuses the SAME structural selectFlowchart selector as
        // solve_flowchart (its render self-gates to an honest WebGPU-unavailable state).
        // nebulosity_layers joined 2026-07-11 (wave2/widget-defaults): never-null by
        // design per the flowchart precedent — renders an explicit "DECOMPOSITION
        // NOT RUN" state (producer not yet wired to buildReceipt), verified in
        // nebulosity_layers_widget.test.ts.
        const NON_NULL_OK = new Set(['solve_flowchart', 'solve_flowchart_webgpu', 'replay_timeline', 'starplate_library', 'nebulosity_layers']);
        for (const w of WIDGETS) {
            if (NON_NULL_OK.has(w.id)) continue;
            expect(w.dataSelector(null, undefined), `selector "${w.id}" fabricated data on null receipt`).toBeNull();
        }
    });

    it('WidgetDock paints the AWAITING-SOLVE voice on the landing (null receipt, default stats knob)', () => {
        const markup = renderToStaticMarkup(<WidgetDock receipt={null} />);
        expect(markup).toContain('widget-dock');
        // R1: a null receipt is the landing / pre-first-solve case — live widgets
        // show AWAITING SOLVE (run a solve to populate), NOT the old wall of
        // NOT MEASURED. solve_summary is a live stats widget ⇒ awaiting-solve frame.
        expect(markup).toContain('AWAITING SOLVE');
        expect(markup).toContain('widget-awaiting-solve-solve_summary');
        // R3: every frame carries a keyboard-focusable intent-help control.
        expect(markup).toContain('widget-help-solve_summary');
        // LAW 3 (unchanged guarantee): the four headline numbers must NOT appear;
        // no live widget renders its data component on a null receipt.
        expect(markup).not.toContain('data-testid="widget-solve-summary"');
        // A live widget's awaiting state is NOT the old NOT MEASURED voice.
        expect(markup).not.toContain('widget-not-measured-solve_summary');
    });

    it('WidgetDock labels scaffolds PLANNED (not-yet-built), distinct from a live absent state (R2)', () => {
        // Scaffolds are chart/heavy tier — raise the weight knob so they render.
        installLocalStorage({ 'skycruncher.widgets.weight': 'heavy' });
        try {
            const markup = renderToStaticMarkup(<WidgetDock receipt={null} />);
            // R2: the 9 scaffolds render a PLANNED (not yet built) state + intent,
            // never a number, never pixel-identical to a genuinely-absent frame.
            expect(markup).toContain('PLANNED');
            expect(markup).toContain('widget-planned-aod_haze');
            // The scaffold is in the not-yet-built state, not a data render.
            expect(markup).toContain('Not yet built');
            // A live chart/heavy widget on a null receipt is still AWAITING SOLVE,
            // proving the two absence classes are visually distinct.
            expect(markup).toContain('widget-awaiting-solve-distortion_curves');
            expect(markup).not.toContain('widget-planned-distortion_curves');
        } finally {
            delete (globalThis as any).localStorage;
        }
    });

    afterEach(() => { delete (globalThis as any).localStorage; });

    it('ReplayDashboard renders its honest empty state with no live bus / receipt', () => {
        const markup = renderToStaticMarkup(<ReplayDashboard />);
        expect(markup).toContain('replay-dashboard');
        // No runs (live/past/dropped) → honest "No run selected" empty state,
        // never a fabricated timeline.
        expect(markup).toContain('No run selected');
    });
});
