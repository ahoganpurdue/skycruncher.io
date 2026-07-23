/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIDGET REGISTRY — Phase 1 (render layer only; UI ledger, no pipeline reach)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING (load-bearing): data collection is DECOUPLED from display.
 *   - `dataSelector` is a PURE READ over the already-collected receipt / event
 *     bus. It never triggers collection, never mutates, never fabricates.
 *   - Collection happens in the pipeline, independent of any widget or of
 *     display state — the receipt "manifest" is always fully populated by the
 *     time a widget reads it.
 *   - `weightTier` gates RENDER COST ONLY. It never gates data collection.
 *   - Display on/off is the only thing the frame decides.
 *
 * Honest-or-absent (LAW 3): a selector that returns null/undefined means the
 * measurement is ABSENT — the frame renders a single standard "NOT MEASURED"
 * state (enforced ONCE, at the dock frame level, never per-widget). A widget
 * must NEVER emit a placeholder number to avoid the empty state.
 *
 * This module is pure TS (no JSX) so its types + selection logic are unit-
 * testable in the node vitest environment without a DOM.
 */

import type { ComponentType } from 'react';
import type { PipelineEvent } from '../../events/pipeline_events';
import { solveSummaryWidget } from './widgets/SolveSummaryWidget';
import { distortionCurvesWidget } from './widgets/DistortionCurvesWidget';
import { psfFieldWidget } from './widgets/PsfFieldWidget';
// Phase 2 — data-backed widgets (each a pure read over the receipt / events).
import { forcedPhotometryZWidget } from './widgets/ForcedPhotometryZWidget';
import { cullingWaterfallWidget } from './widgets/CullingWaterfallWidget';
import { solveTimingWaterfallWidget } from './widgets/SolveTimingWaterfallWidget';
import { colorColorPlanckianWidget } from './widgets/ColorColorPlanckianWidget';
import { detectionDensityWidget } from './widgets/DetectionDensityWidget';
import { bcEdgeRecoveryWidget } from './widgets/BcEdgeRecoveryWidget';
import { distortionCascade2dWidget } from './widgets/DistortionCascade2dWidget';
// Multiscale nebulosity decomposition viewer (chart) — CONSUMES the
// `nebulosity_layer` receipt block from m10_psf/nebulosity_layer.ts. Producer is
// not yet wired into buildReceipt, so it renders an explicit DECOMPOSITION NOT
// RUN state today and auto-lights when the block lands (see its header comment).
import { nebulosityLayersWidget } from './widgets/NebulosityLayersWidget';
// Named-star overlay (chart) — labels the solved frame from the bundled reference.
import { starLabelsWidget } from './widgets/StarLabelsWidget';
// 3D Flattening Cascade + Lens Profile 3D (WebGL, heavy) — registry wiring deferred
// at their merge (0c27bcc); wired here per cascade/README.md.
import { cascadeExplorerWidget } from './cascade/CascadeExplorer';
import { lensProfile3dWidget } from './cascade/LensProfile3D';
// Phase 2 — scaffolds (registered, honest NOT MEASURED, intent-only until a real path lands).
import { SCAFFOLD_WIDGETS } from './widgets/ScaffoldWidgets';
// Star-plate library sync card — re-homed from a direct MainApp mount at the
// K: merge (2026-07-09). Env-driven (native store, not receipt); its manifest
// documents the selector deviation.
import { starplateLibraryWidget } from '../dashboard/StarplateLibraryCard';
// ★ End-to-end interactive solve flowchart (owner NON-NEGOTIABLE, NEXT_MOVES §0).
// Structural DAG over the capture-record aggregate (already-collected); stats tier.
import { solveFlowchartWidget } from './widgets/SolveFlowchartWidget';
// Replay Timeline (wave 3) — reference consumer of the Replay Dashboard time-
// slice contract; lights per-stage boxes from the scrub frame (via context).
import { replayTimelineWidget } from './widgets/ReplayTimelineWidget';
// WebGPU flowchart TWIN (A/B experiment, owner-requested 2026-07-10) + the thin
// FPS wrapper that instruments the SVG original for the side-by-side. See
// flowchart_webgpu/ — the twin reuses the IDENTICAL selectFlowchart selector.
import { solveFlowchartWebgpuWidget } from './flowchart_webgpu/SolveFlowchartWebGPU';
import { withFlowchartFps } from './flowchart_webgpu/withFlowchartFps';
// Consolidation delta (2026-07-12): two previously step-local viewers brought into
// the registry. Both are PURE receipt reads reusing the existing render components
// (LAW 4 — no new numeric logic). residual_quiver = the step-6 ResidualQuiver fed
// from the receipt's SCHEMA-A residual vectors; psf_attribution = the PsfPanel
// AttributionLedger fed from receipt.psf_attribution. (DistortionChart/VignetteChart
// are already live as `distortion_curves` above — not re-registered, no duplication.)
import { residualQuiverWidget } from './widgets/ResidualQuiverWidget';
import { psfAttributionWidget } from './widgets/PsfAttributionWidget';
// Consolidation delta (cont.): two dashboard fixed-panel cards whose receipt inputs
// are trivially clean single blocks — planetary_manifest ← receipt.planets,
// deep_confirm ← receipt.deep_confirmed. (The other dashboard cards — DataFlowDiagram
// [live manifest/stages], StarIntegrityList [nested MatchedStar ≠ flattened receipt],
// TelemetryBar, ConfirmTierBadge [redundant w/ deep_confirm + confirm_status] — and the
// PsfPanel image crops [need pixel buffers absent from the receipt] are FOUND, NOT YET
// PAYLOAD-DRIVEN; surfaced as such on the Widget Shelf, not registered.)
import { planetaryManifestWidget } from './widgets/PlanetaryManifestWidget';
import { deepConfirmWidget } from './widgets/DeepConfirmWidget';
// Greenfield solver-core widgets (2026-07-21) — render-plane readers of the greenfield
// receipt (`solution.greenfield_receipt`). All three are PURE receipt reads (LAW 1 render
// plane; solve byte-identical). solve_stats = all-real; replay = representative candidate
// stream synthesized from measured per-band telemetry with REAL green geometry; sky_overlays
// = TAN-WCS projection with honestly-disabled unavailable layers. See data/greenfield_receipt.ts.
import { greenfieldSolveStatsWidget } from './widgets/GreenfieldSolveStatsWidget';
import { greenfieldReplayWidget } from './widgets/GreenfieldReplayWidget';
import { greenfieldSkyOverlaysWidget } from './widgets/GreenfieldSkyOverlaysWidget';

// ─── contracts ────────────────────────────────────────────────────────────

/**
 * The wizard receipt is `buildReceipt`'s serializable output (typed `any` at
 * its source). A selector treats it as an opaque, read-only bag and reaches
 * only into documented blocks (`solution`, `hardware`, `psf_field`, …).
 */
export type WidgetReceipt = Record<string, any> | null | undefined;

/** The pipeline event history a selector may read (pure, never mutated). */
export type WidgetEvents = readonly PipelineEvent[] | undefined;

/** Render cost tier. `stats` = cheap text · `chart` = SVG · `heavy` = maps/grids. */
export type WeightTier = 'stats' | 'chart' | 'heavy';

/** Props every widget render component receives: its selected, non-null data. */
export interface WidgetRenderProps<D = unknown> {
    data: D;
}

export interface WidgetManifest<D = any> {
    /** Stable id — persistence key + registry lookup. */
    id: string;
    /** Human title shown in the frame header. */
    title: string;
    /**
     * One-line statement of what the widget shows / the question it answers.
     * Surfaced by the one-shot review gallery (and INTENTS.md) as the single
     * source of intent, so a SCAFFOLD's purpose reads honestly beside its NOT
     * MEASURED state. Never a number.
     */
    intent: string;
    /**
     * Empty-state lifecycle class (LAW-3 taxonomy — kills the landing "wall of
     * NOT MEASURED" by telling absence apart honestly):
     *   'live'     — a real measurement path exists. Absence ⇒ AWAITING SOLVE on
     *                a null receipt (run a solve to populate) or NOT MEASURED on a
     *                present receipt (absent for THIS frame).
     *   'scaffold' — no measurement path is built yet. The frame shows a PLANNED
     *                (not yet built) state + the intent, NEVER a number and NEVER
     *                pixel-identical to a genuinely-absent measurement.
     * Optional; defaults to 'live'. Pure display metadata — never gates data.
     */
    kind?: 'live' | 'scaffold';
    /**
     * PURE READ over the receipt / event bus. Returns the widget's data, or
     * null/undefined when the underlying measurement is ABSENT (⇒ the frame
     * shows an honest empty state per `kind`). MUST NOT collect, mutate, or fabricate.
     */
    dataSelector: (receipt: WidgetReceipt, events?: WidgetEvents) => D | null;
    /** Gates RENDER COST ONLY — never data collection. */
    weightTier: WeightTier;
    /** The render component. Receives the (guaranteed non-null) selected data. */
    render: ComponentType<WidgetRenderProps<D>>;
    /**
     * Opt OUT of the frame-level ZoomPanViewport (render-plane wheel/drag/pinch
     * zoom). Set on widgets that ALREADY own their own pointer zoom/rotate — the
     * WebGL cascades (flattening_cascade, lens_profile_3d) drive a camera via
     * cascade/webgl_surface.ts. The wrapper honours this with a pure pass-through
     * so there is no double-zoom. Optional; default (undefined/false) = wrapped.
     */
    ownsPointerZoom?: boolean;
}

// ─── weight knob ──────────────────────────────────────────────────────────

export const WEIGHT_TIERS: readonly WeightTier[] = ['stats', 'chart', 'heavy'];
const TIER_RANK: Record<WeightTier, number> = { stats: 0, chart: 1, heavy: 2 };

/**
 * Weight knob level — the MAX tier the dock will render, named by that tier:
 *   'stats'  → stats-only
 *   'chart'  → + charts
 *   'heavy'  → + heavy
 */
export type WeightLevel = WeightTier;

/** Does the weight knob at `level` admit a widget of `tier` for RENDER? */
export function tierAdmittedByLevel(tier: WeightTier, level: WeightLevel): boolean {
    return TIER_RANK[tier] <= TIER_RANK[level];
}

// ─── enabledWidgets persisted preference (mirrors ui/diag_prefs.ts) ────────

export const ENABLED_WIDGETS_STORAGE_KEY = 'skycruncher.widgets.enabled';

/**
 * Parse the persisted CSV of enabled ids. Pure — testable without a DOM.
 *   null (key unset) → null, meaning "no stored choice, use the default set".
 *   "" (explicit empty) → [] (user disabled everything).
 */
export function parseEnabledWidgets(raw: string | null): string[] | null {
    if (raw == null) return null;
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** Enabled widget ids, falling back to `defaults` when nothing is persisted. */
export function getEnabledWidgets(defaults: string[]): string[] {
    try {
        const parsed = parseEnabledWidgets(localStorage.getItem(ENABLED_WIDGETS_STORAGE_KEY));
        return parsed ?? defaults;
    } catch {
        return defaults;
    }
}

export function setEnabledWidgets(ids: string[]): void {
    try { localStorage.setItem(ENABLED_WIDGETS_STORAGE_KEY, ids.join(',')); } catch { /* storage unavailable */ }
}

// ─── weight-level persisted preference ─────────────────────────────────────

export const WIDGET_WEIGHT_STORAGE_KEY = 'skycruncher.widgets.weight';

/** Is `v` a valid persisted weight level? */
function isWeightLevel(v: unknown): v is WeightLevel {
    return v === 'stats' || v === 'chart' || v === 'heavy';
}

/**
 * The RAW stored weight level, or null when no valid choice is persisted. Lets a
 * caller tell "user has never chosen" apart from "user chose 'stats'", which the
 * phase-aware default (below) needs — a stored choice ALWAYS wins over a default.
 */
export function getStoredWeightLevel(): WeightLevel | null {
    try {
        const v = localStorage.getItem(WIDGET_WEIGHT_STORAGE_KEY);
        return isWeightLevel(v) ? v : null;
    } catch {
        return null;
    }
}

/** Persisted weight knob level; defaults to the cheapest tier ('stats'). */
export function getWeightLevel(): WeightLevel {
    return getStoredWeightLevel() ?? 'stats';
}

export function setWeightLevel(level: WeightLevel): void {
    try { localStorage.setItem(WIDGET_WEIGHT_STORAGE_KEY, level); } catch { /* storage unavailable */ }
}

/**
 * Per-PHASE default weight level (display-only; never touches collection).
 * Rationale (WIDGET_LIBRARY.md §7 rec #4): at the cheapest 'stats' level only
 * ~4/17 live widgets render, so the chart-tier population data a solve just
 * produced (color–color, forced-photometry, culling, timing…) lands INVISIBLE on
 * a fresh view. So:
 *   - landing (no receipt yet) → 'stats' — nothing measured, keep it cheap/quiet.
 *   - post-solve (receipt present) → 'chart' — reveal the just-measured chart data,
 *     while 'heavy' (PSF grid / WebGL cascades / density maps) stays opt-in.
 * This is a DEFAULT only: a persisted user choice always wins (see resolve* below).
 */
export function defaultWeightLevelForPhase(hasReceipt: boolean): WeightLevel {
    return hasReceipt ? 'chart' : 'stats';
}

/**
 * The initial weight level for the dock: the user's persisted choice if any,
 * else the phase default. Persisted ALWAYS wins — a default never overrides an
 * explicit knob setting.
 */
export function resolveInitialWeightLevel(hasReceipt: boolean): WeightLevel {
    return getStoredWeightLevel() ?? defaultWeightLevelForPhase(hasReceipt);
}

/**
 * How many ENABLED widgets are hidden purely by the weight knob at `level`,
 * broken out by the tier that would reveal them. PURE — a display-discoverability
 * count over the registry + enabled set; it reads no data and gates nothing.
 * (Powers the in-dock "raise the weight to see N more" hint — WIDGET_LIBRARY §7 #4.)
 */
export function countHiddenByTier(
    registry: readonly WidgetManifest[],
    opts: { enabled: readonly string[]; level: WeightLevel },
): { chart: number; heavy: number; total: number } {
    const enabledSet = new Set(opts.enabled);
    let chart = 0, heavy = 0;
    for (const w of registry) {
        if (!enabledSet.has(w.id)) continue;
        if (tierAdmittedByLevel(w.weightTier, opts.level)) continue; // already visible
        if (w.weightTier === 'chart') chart++;
        else if (w.weightTier === 'heavy') heavy++;
    }
    return { chart, heavy, total: chart + heavy };
}

// ─── dock flag (DEFAULT ON, opt-out; mirrors ui/diag_prefs.ts) ─────────────

export const WIDGET_DOCK_STORAGE_KEY = 'skycruncher.widgets.dock';

/**
 * Is the widget dock mounted at all? DEFAULT ON (opt-out) — owner ruling
 * 2026-07-09 ("WidgetDock Mount — turn it on"): the dock renders unless the flag
 * is explicitly set to '0'. The flag is preserved so it can still be turned off.
 * When '0' the dock renders NOTHING (zero DOM difference) — the single render
 * guard the "flag-off renders nothing" contract still rests on.
 */
export function getWidgetDockEnabled(): boolean {
    try { return localStorage.getItem(WIDGET_DOCK_STORAGE_KEY) !== '0'; } catch { return true; }
}

export function setWidgetDockEnabled(on: boolean): void {
    try { localStorage.setItem(WIDGET_DOCK_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

// ─── the registry ─────────────────────────────────────────────────────────

/**
 * The typed registry array. Each entry is a parallel-new widget reading the
 * already-collected receipt / event bus (no pipeline reach). Phase 1 exemplars +
 * Phase 2 data-backed widgets + Phase 2 scaffolds (honest NOT MEASURED, intent-only).
 *   Phase 1: solve_summary (stats) · distortion_curves (chart) · psf_field (heavy)
 *   Phase 2 data: forced_photometry_z, culling_waterfall, solve_timing_waterfall,
 *     color_color_planckian (chart) · detection_density, bc_edge_recovery,
 *     distortion_cascade_2d (heavy)
 *   Named overlay: star_labels (chart)
 *   3D cascade (WebGL, heavy): flattening_cascade, lens_profile_3d
 *   Phase 2 scaffolds: 9 future measurements (see ScaffoldWidgets.tsx)
 */
export const WIDGETS: WidgetManifest[] = [
    solveSummaryWidget,
    distortionCurvesWidget,
    psfFieldWidget,
    forcedPhotometryZWidget,
    cullingWaterfallWidget,
    solveTimingWaterfallWidget,
    colorColorPlanckianWidget,
    detectionDensityWidget,
    bcEdgeRecoveryWidget,
    distortionCascade2dWidget,
    nebulosityLayersWidget,
    starLabelsWidget,
    cascadeExplorerWidget,   // id: 'flattening_cascade'
    lensProfile3dWidget,     // id: 'lens_profile_3d'
    starplateLibraryWidget,  // id: 'starplate_library' (env-driven; see its manifest)
    withFlowchartFps(solveFlowchartWidget), // id: 'solve_flowchart' (★ DAG; stats) — SVG original + thin FPS badge for the A/B
    solveFlowchartWebgpuWidget, // id: 'solve_flowchart_webgpu' (WebGPU hybrid twin; stats — A/B experiment)
    residualQuiverWidget,    // id: 'residual_quiver' (heavy; step-6 quiver from receipt residual vectors)
    psfAttributionWidget,    // id: 'psf_attribution' (chart; PSF physics ledger from receipt.psf_attribution)
    planetaryManifestWidget, // id: 'planetary_manifest' (chart; solar-system anchors from receipt.planets)
    deepConfirmWidget,       // id: 'deep_confirm' (chart; forced-photometry confirmation from receipt.deep_confirmed)
    ...SCAFFOLD_WIDGETS,
    replayTimelineWidget,    // id: 'replay_timeline' (wave 3; replay-context aware)
    greenfieldSolveStatsWidget, // id: 'greenfield_solve_stats' (chart; all-real greenfield receipt stats)
    greenfieldReplayWidget,     // id: 'greenfield_replay' (heavy; canvas replay — representative candidates + real green geometry)
    greenfieldSkyOverlaysWidget, // id: 'greenfield_sky_overlays' (heavy; TAN-WCS overlays, honestly-gated layers)
];

/** All registered widget ids (the default enabled set). */
export function allWidgetIds(): string[] {
    return WIDGETS.map(w => w.id);
}

/**
 * PURE display selection: which manifests to render given the enabled set + the
 * weight knob. This decides DISPLAY only — data collection is untouched. A
 * widget is rendered iff it is enabled AND its tier is admitted by the knob.
 */
export function selectWidgetsToRender(
    registry: readonly WidgetManifest[],
    opts: { enabled: readonly string[]; level: WeightLevel }
): WidgetManifest[] {
    const enabledSet = new Set(opts.enabled);
    return registry.filter(w => enabledSet.has(w.id) && tierAdmittedByLevel(w.weightTier, opts.level));
}
