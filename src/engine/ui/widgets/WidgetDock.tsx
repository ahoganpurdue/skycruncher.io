/**
 * WIDGET DOCK — Phase 1 minimal frame (render layer only).
 *
 * Renders the enabled registry widgets in a responsive CSS grid with a weight
 * knob (stats-only / +charts / +heavy). The knob gates RENDER only — data
 * collection happens upstream in the pipeline and is never gated by display.
 *
 * DEFAULT ON (opt-out): gated by the `skycruncher.widgets.dock` localStorage flag
 * (owner ruling 2026-07-09 — turn it on by default, flag preserved). When the
 * flag is explicitly '0' the dock renders NOTHING (returns null) — ZERO DOM
 * difference. This guard is the whole "flag-off renders nothing" contract, and
 * it lives in exactly one place: `getWidgetDockEnabled()`.
 *
 * Honest-or-absent (LAW 3): the NOT MEASURED empty state is enforced ONCE, here
 * at the frame level, whenever a widget's pure selector returns null/undefined.
 *
 * No drag / no popout in this phase.
 */

import React, { useMemo, useState } from 'react';
import { ZoomPanViewport } from './ZoomPanViewport';
import { getDockingEnabled } from './docking/docking_flag';
import {
    WIDGETS,
    allWidgetIds,
    selectWidgetsToRender,
    countHiddenByTier,
    getWidgetDockEnabled,
    resolveInitialWeightLevel,
    setWeightLevel,
    getEnabledWidgets,
    type WeightLevel,
    type WidgetManifest,
    type WidgetReceipt,
    type WidgetEvents,
} from './registry';

// Phase-B docking surface (DASHBOARD_DOCKING_SPEC). Lazy so dockview + its CSS
// stay OFF the module graph unless the (default-OFF) docking flag turns it on —
// this is what keeps the flag-off path byte-identical with zero dockview DOM.
const DockingSurface = React.lazy(() =>
    import('./docking/DockingSurface').then(m => ({ default: m.DockingSurface }))
);

/**
 * Suspense placeholder while the code-split docking surface chunk loads. It
 * reserves the same footprint as DockingSurface so the region never collapses to
 * empty DOM during the import (the racy-absence window). Honest-or-absent: it
 * says it is loading, never fakes a widget.
 */
const DockingSurfaceLoading: React.FC = () => (
    <div
        data-testid="docking-surface-loading"
        className="flex flex-col items-center justify-center rounded-xl border border-line bg-space-900/40 text-center gap-1.5"
        style={{ height: '68vh', minHeight: 420, maxHeight: 760 }}
    >
        <span className="text-text-muted text-[10px] font-mono font-bold uppercase tracking-widest">
            Loading dashboard…
        </span>
        <span className="text-text-faint text-[10px]">Preparing the docking surface and widget library.</span>
    </div>
);

export interface WidgetDockProps {
    /** The wizard receipt (buildReceipt output). Pure read by widget selectors. */
    receipt: WidgetReceipt;
    /** Optional pipeline event history for event-driven widgets. */
    events?: WidgetEvents;
}

const NOT_MEASURED = 'NOT MEASURED';

/**
 * Honest empty-state taxonomy (LAW 3 — R1/R2/R3): one mechanism, registry-
 * driven, so every widget's absence is honest ABOUT THE ABSENCE and never fake
 * data. Three classes, distinguished by cheap already-available signals:
 *   • PLANNED       — `manifest.kind === 'scaffold'`: no measurement path is
 *                     built yet (checked FIRST — a scaffold is never "awaiting a
 *                     solve", it is not yet built).
 *   • AWAITING SOLVE— live widget, null receipt (the landing / pre-first-solve):
 *                     it WILL populate from a live run; say so + what triggers it.
 *   • NOT MEASURED  — live widget, present receipt, selector null: genuinely
 *                     absent for THIS frame.
 * Every class also surfaces the manifest `intent` as one honest line of what the
 * widget WILL show — never a number, never imitation data.
 */
type EmptyKind = 'planned' | 'awaiting' | 'absent';
const EMPTY_LABEL: Record<EmptyKind, string> = {
    planned: 'PLANNED',
    awaiting: 'AWAITING SOLVE',
    absent: NOT_MEASURED,
};
const EMPTY_SUB: Record<EmptyKind, string> = {
    planned: 'Not yet built — no measurement path exists today.',
    awaiting: 'Run a solve to populate this widget.',
    absent: 'Not measured for this frame.',
};
const EMPTY_TESTID: Record<EmptyKind, string> = {
    planned: 'widget-planned',
    awaiting: 'widget-awaiting-solve',
    absent: 'widget-not-measured',
};
const EMPTY_LABEL_CLS: Record<EmptyKind, string> = {
    planned: 'bg-warn-dim text-warn',
    awaiting: 'bg-accent-glow text-accent-300',
    absent: 'text-text-muted',
};

/** An honest absence block: a labelled state + why + the intent-as-help line. */
const EmptyStateBlock: React.FC<{ id: string; kind: EmptyKind; intent: string }> = ({ id, kind, intent }) => (
    <div className="flex flex-col items-center gap-1.5 py-5 text-center" data-testid={`${EMPTY_TESTID[kind]}-${id}`}>
        <span className={`text-[10px] font-mono font-bold uppercase tracking-widest px-1.5 py-px rounded ${EMPTY_LABEL_CLS[kind]}`}>
            {EMPTY_LABEL[kind]}
        </span>
        <span className="text-[10px] text-text-faint">{EMPTY_SUB[kind]}</span>
        <span className="text-[10px] text-text-faint italic max-w-[38ch]">{intent}</span>
    </div>
);

/** One widget frame. The empty-state taxonomy is enforced HERE, once, per widget.
 *  Exported so the read-only Widget Shelf (`WidgetShelf.tsx`, a receipt-drop viewer)
 *  reuses the IDENTICAL honest-or-absent frame + selector-null taxonomy instead of
 *  duplicating LAW-3 logic (the "enforce ONCE" contract stays in this one place). */
export const WidgetFrame: React.FC<{ manifest: WidgetManifest; receipt: WidgetReceipt; events?: WidgetEvents }> = ({ manifest, receipt, events }) => {
    const data = manifest.dataSelector(receipt, events);
    const Render = manifest.render;
    // scaffold → PLANNED wins over any receipt state; else null-receipt →
    // AWAITING SOLVE; else absent-this-frame → NOT MEASURED.
    const emptyKind: EmptyKind =
        manifest.kind === 'scaffold' ? 'planned' : receipt == null ? 'awaiting' : 'absent';
    // Frame-level zoom (owner directive 2026-07-21: widgets too small). The
    // ZoomPanViewport wrapping the Render mount reports {scale, reset} back up so
    // the reset + % chrome can live in this header. Widgets that own their own
    // pointer zoom (WebGL cascades) opt out via `manifest.ownsPointerZoom`.
    const ownsZoom = !!manifest.ownsPointerZoom;
    const [zoom, setZoom] = useState<{ scale: number; reset: () => void }>({ scale: 1, reset: () => {} });
    const showZoomChrome = !ownsZoom && Math.abs(zoom.scale - 1) > 1e-3;
    return (
        <section
            className="bg-space-900/70 border border-line rounded-xl p-4 flex flex-col gap-3"
            data-testid={`widget-frame-${manifest.id}`}
            data-weight-tier={manifest.weightTier}
        >
            <header className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                    <h3 className="text-text-muted text-[10px] font-bold uppercase tracking-widest truncate">{manifest.title}</h3>
                    {/* R3: intent as keyboard-accessible header help — a real focusable
                        control whose accessible name IS the manifest intent (not a bare
                        title=), so every frame is self-documenting with zero new data. */}
                    <button
                        type="button"
                        data-testid={`widget-help-${manifest.id}`}
                        aria-label={`What this shows: ${manifest.intent}`}
                        title={manifest.intent}
                        className="shrink-0 w-4 h-4 rounded-full border border-line text-text-faint text-[9px] leading-none flex items-center justify-center hover:text-text-primary focus-visible:text-text-primary"
                    >
                        ?
                    </button>
                    {/* Zoom chrome — reset + %, only while zoomed (scale ≠ 1). Matches the
                        "?" help control's token classes exactly (no bespoke hex). */}
                    {showZoomChrome && (
                        <span className="flex items-center gap-1 shrink-0">
                            <span
                                data-testid={`widget-zoom-level-${manifest.id}`}
                                className="text-text-faint text-[9px] font-mono tabular-nums"
                            >
                                {Math.round(zoom.scale * 100)}%
                            </span>
                            <button
                                type="button"
                                onClick={() => zoom.reset()}
                                data-testid={`widget-zoom-reset-${manifest.id}`}
                                aria-label="Reset zoom"
                                title="Reset zoom"
                                className="w-4 h-4 rounded-full border border-line text-text-faint text-[9px] leading-none flex items-center justify-center hover:text-text-primary focus-visible:text-text-primary"
                            >
                                ⟲
                            </button>
                        </span>
                    )}
                </div>
                <span className="text-text-faint text-[9px] font-mono uppercase tracking-widest shrink-0">{manifest.weightTier}</span>
            </header>
            {manifest.kind === 'scaffold' || data == null ? (
                <EmptyStateBlock id={manifest.id} kind={emptyKind} intent={manifest.intent} />
            ) : (
                <ZoomPanViewport
                    disabled={ownsZoom}
                    onZoomStateChange={setZoom}
                    data-testid={`widget-zoom-viewport-${manifest.id}`}
                >
                    <Render data={data} />
                </ZoomPanViewport>
            )}
        </section>
    );
};

const LEVELS: { level: WeightLevel; label: string }[] = [
    { level: 'stats', label: 'Stats only' },
    { level: 'chart', label: '+ Charts' },
    { level: 'heavy', label: '+ Heavy' },
];

/** The dock body (only mounted when the flag is on — hooks live here). */
const WidgetDockBody: React.FC<WidgetDockProps> = ({ receipt, events }) => {
    // Initial level = the persisted choice if any, else the phase default (post-solve
    // → 'chart' so just-measured chart data is visible; landing → 'stats'). A stored
    // choice always wins; the default only applies mount-time when nothing is stored.
    const [level, setLevelState] = useState<WeightLevel>(() => resolveInitialWeightLevel(receipt != null));
    const enabled = useMemo(() => getEnabledWidgets(allWidgetIds()), []);
    const visible = useMemo(() => selectWidgetsToRender(WIDGETS, { enabled, level }), [enabled, level]);
    // Discoverability hint: how many enabled widgets the knob is hiding at `level`.
    // Pure display count — never touches collection (weightTier gates RENDER only).
    const hidden = useMemo(() => countHiddenByTier(WIDGETS, { enabled, level }), [enabled, level]);

    const setLevel = (l: WeightLevel) => { setWeightLevel(l); setLevelState(l); };

    return (
        <div className="flex flex-col gap-4 p-4" data-testid="widget-dock">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-text-muted text-[10px] font-bold uppercase tracking-widest mr-1">Widgets</span>
                <div className="inline-flex rounded-lg border border-line overflow-hidden" role="group" aria-label="Widget weight">
                    {LEVELS.map(({ level: l, label }) => (
                        <button
                            key={l}
                            type="button"
                            onClick={() => setLevel(l)}
                            data-testid={`widget-weight-${l}`}
                            aria-pressed={level === l}
                            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest ${
                                level === l ? 'bg-accent-600 text-white' : 'bg-space-800 text-text-secondary hover:text-text-primary'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {hidden.total > 0 && (
                    <button
                        type="button"
                        // Raise ONE tier toward revealing more: stats→chart when chart
                        // widgets are hidden, else →heavy. Display-only convenience.
                        onClick={() => setLevel(hidden.chart > 0 ? 'chart' : 'heavy')}
                        data-testid="widget-weight-hint"
                        className="text-[10px] font-mono text-text-faint hover:text-text-secondary underline decoration-dotted underline-offset-2"
                        title="These widgets are collected and ready — the weight knob only gates rendering. Raise it to draw them."
                    >
                        +{hidden.total} more hidden
                        {hidden.chart > 0 ? ` · ${hidden.chart} chart` : ''}
                        {hidden.heavy > 0 ? ` · ${hidden.heavy} heavy` : ''} — raise weight to reveal
                    </button>
                )}
            </div>

            {visible.length === 0 ? (
                <div className="text-[11px] font-mono text-text-muted">No widgets enabled at this weight.</div>
            ) : (
                <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                    {visible.map(w => (
                        <WidgetFrame key={w.id} manifest={w} receipt={receipt} events={events} />
                    ))}
                </div>
            )}
        </div>
    );
};

/**
 * Public entry. Flag guard first (DEFAULT ON, opt-out): when the flag is '0',
 * renders nothing (zero DOM). No hooks are called on the off path, so this is
 * hooks-rules safe.
 */
export const WidgetDock: React.FC<WidgetDockProps> = ({ receipt, events }) => {
    if (!getWidgetDockEnabled()) return null;
    // Phase-B (SPEC §9 Q4): when the docking flag is ON the dockview surface
    // REPLACES the grid at this same mount point. DEFAULT OFF ⇒ this branch is
    // never taken and the legacy grid below renders byte-identically.
    if (getDockingEnabled()) {
        // Honest loading state instead of `fallback={null}`: the docking surface
        // (dockview + its CSS) is a code-split chunk, so during the async import
        // the DOM would otherwise be EMPTY — a walkthrough probe caught exactly
        // that window (ribbonFound:false, no visible surface). A placeholder that
        // reserves the surface footprint keeps the region present the whole time,
        // then the ribbon + seeded panels + CTA paint the moment the chunk lands.
        return (
            <React.Suspense fallback={<DockingSurfaceLoading />}>
                <DockingSurface receipt={receipt} events={events} />
            </React.Suspense>
        );
    }
    return <WidgetDockBody receipt={receipt} events={events} />;
};
