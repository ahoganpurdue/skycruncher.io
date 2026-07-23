import { describe, it, expect } from 'vitest';
import { buildEnabledWidgetPreviews } from '../ui/widgets/widgets/flowchart_previews';
import type { WidgetManifest, WeightTier } from '../ui/widgets/registry';
import type { FlowNodeSpec } from '../ui/widgets/widgets/flowchart_model';

/**
 * ENABLED-WIDGET PREVIEWS (A4 item 1 — popup honesty). A stage box's hover panel
 * renders a REAL thumbnail only when the enabled widget actually has data this
 * run (light tier), and honest text otherwise (NOT MEASURED) — never a
 * placeholder image (LAW 3). Manifests are injected (DI) so this is a pure,
 * registry-free unit.
 */

function manifest(id: string, tier: WeightTier, selects: boolean): WidgetManifest {
    return {
        id,
        title: id.toUpperCase(),
        intent: 'test manifest',
        weightTier: tier,
        dataSelector: () => (selects ? { ok: true } : null),
        render: (() => null) as unknown as WidgetManifest['render'],
    };
}

function spec(widgets: string[]): FlowNodeSpec {
    return { id: 's', label: 'S', runtime: 'typescript', col: 0, row: 0, receiptBlock: null, widgets, note: '' };
}

const manifests: WidgetManifest[] = [
    manifest('has_stats', 'stats', true),
    manifest('has_heavy', 'heavy', true),
    manifest('no_data', 'chart', false),
];

describe('buildEnabledWidgetPreviews', () => {
    it('light widget WITH data ⇒ hasData true + a real thumbnail', () => {
        const [p] = buildEnabledWidgetPreviews(spec(['has_stats']), manifests, {}, undefined);
        expect(p.hasData).toBe(true);
        expect(p.thumbnail).toBe(true);
        expect(p.missing).toBe(false);
    });

    it('HEAVY widget with data ⇒ hasData true but NO tooltip thumbnail (text listing)', () => {
        const [p] = buildEnabledWidgetPreviews(spec(['has_heavy']), manifests, {}, undefined);
        expect(p.hasData).toBe(true);
        expect(p.thumbnail).toBe(false); // heavy/WebGL never mounted in a hover popup
    });

    it('widget WITHOUT data ⇒ hasData false, no thumbnail (honest NOT MEASURED)', () => {
        const [p] = buildEnabledWidgetPreviews(spec(['no_data']), manifests, {}, undefined);
        expect(p.hasData).toBe(false);
        expect(p.thumbnail).toBe(false);
    });

    it('unregistered enabled id ⇒ missing, name-only, never a fake positive', () => {
        const [p] = buildEnabledWidgetPreviews(spec(['ghost']), manifests, {}, undefined);
        expect(p.missing).toBe(true);
        expect(p.hasData).toBe(false);
        expect(p.thumbnail).toBe(false);
        expect(p.title).toBe('ghost');
    });

    it('a THROWING selector is treated as honest absence (no fabricated thumbnail)', () => {
        const boom: WidgetManifest = {
            id: 'boom', title: 'Boom', intent: 'x', weightTier: 'stats',
            dataSelector: () => { throw new Error('selector blew up'); },
            render: (() => null) as unknown as WidgetManifest['render'],
        };
        const [p] = buildEnabledWidgetPreviews(spec(['boom']), [boom], {}, undefined);
        expect(p.hasData).toBe(false);
        expect(p.thumbnail).toBe(false);
    });

    it('preserves the stage widget order and covers each enabled id', () => {
        const out = buildEnabledWidgetPreviews(spec(['no_data', 'has_stats', 'has_heavy']), manifests, {}, undefined);
        expect(out.map(p => p.id)).toEqual(['no_data', 'has_stats', 'has_heavy']);
    });
});
