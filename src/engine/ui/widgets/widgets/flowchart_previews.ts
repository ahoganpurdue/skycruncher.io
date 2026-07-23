/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENABLED-WIDGET PREVIEWS — the ★ flowchart box-hover "enables widgets" panel
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A4 item 1. When a stage box is hovered, list the widgets that stage ENABLES —
 * and for each, decide HONESTLY whether it has data for the current run by
 * running its own pure `dataSelector(receipt, events)`:
 *   - non-null ⇒ a REAL thumbnail is renderable (the React layer mounts the
 *     widget at reduced scale).
 *   - null     ⇒ text-only listing (NOT MEASURED). Never a placeholder image
 *     (LAW 3).
 *
 * PURITY / DI: manifests are PASSED IN (never imported), so this stays out of the
 * registry's WebGL module graph and is node-unit-testable without a DOM. It lives
 * OUTSIDE `flowchart_model.ts` on purpose — the model is shared with the headless
 * preview generator (LAW 4) and must stay registry-free.
 */

import type { FlowNodeSpec } from './flowchart_model';
import type { WidgetManifest, WidgetReceipt, WidgetEvents, WeightTier } from '../registry';

export interface EnabledWidgetPreview {
    /** Widget id (registry key). */
    id: string;
    /** Human title (falls back to the id when no manifest is registered). */
    title: string;
    /** Render cost tier of the widget. */
    tier: WeightTier;
    /** The stage's data exists for this run ⇒ a real thumbnail can render. */
    hasData: boolean;
    /**
     * Mount a live thumbnail? true only when data exists AND the tier is light
     * enough to render inside a hover popup — heavy / WebGL widgets are listed as
     * "data ready" text rather than mounted in a tooltip (stability). Honest
     * either way; never a fake image.
     */
    thumbnail: boolean;
    /** True when the enabled id has no registered manifest (honest: name only). */
    missing: boolean;
}

/**
 * Build the enabled-widget preview list for one stage (pure). `hasData` is a
 * pure read of each widget's selector against the current receipt/events; a
 * selector that throws is treated as absent (never a fabricated positive).
 */
export function buildEnabledWidgetPreviews(
    spec: FlowNodeSpec,
    manifests: readonly WidgetManifest[],
    receipt: WidgetReceipt,
    events: WidgetEvents,
): EnabledWidgetPreview[] {
    const byId = new Map(manifests.map(m => [m.id, m]));
    const out: EnabledWidgetPreview[] = [];
    for (const id of spec.widgets) {
        const m = byId.get(id);
        if (!m) {
            out.push({ id, title: id, tier: 'stats', hasData: false, thumbnail: false, missing: true });
            continue;
        }
        let hasData = false;
        try {
            hasData = m.dataSelector(receipt, events) != null;
        } catch {
            hasData = false; // a throwing selector is honest absence, never a fake positive
        }
        out.push({
            id,
            title: m.title,
            tier: m.weightTier,
            hasData,
            thumbnail: hasData && m.weightTier !== 'heavy',
            missing: false,
        });
    }
    return out;
}
