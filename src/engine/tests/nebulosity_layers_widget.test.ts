/**
 * NEBULOSITY LAYERS WIDGET — selector unit tests (pure; node env, no DOM).
 *
 * Covers the honest producer-gap contract: the `nebulosity_layer` receipt block
 * is NOT wired into buildReceipt yet, so the selector must report present:false
 * on every real receipt today — while still lighting up (present:true) the moment
 * a well-formed block appears. Also proves the defensive shape guard and that the
 * module's own per-layer honest-or-absent flag survives into the widget data.
 */

import { describe, it, expect } from 'vitest';
import {
    selectNebulosityLayers,
    nebulosityLayersWidget,
    type NebulosityLayersData,
} from '../ui/widgets/widgets/NebulosityLayersWidget';
import {
    decomposeNebulosityLayers,
    buildNebulosityLayerReceipt,
} from '../pipeline/m10_psf/nebulosity_layer';

describe('selectNebulosityLayers — producer-gap honest state', () => {
    it('null receipt ⇒ present:false (never throws, never null)', () => {
        const d = selectNebulosityLayers(null);
        expect(d.present).toBe(false);
        expect(d.layers).toBeNull();
    });

    it('receipt without a nebulosity_layer block ⇒ present:false', () => {
        expect(selectNebulosityLayers({ solution: {} }).present).toBe(false);
        expect(selectNebulosityLayers({ nebulosity_layer: null }).present).toBe(false);
    });

    it('malformed block (missing/!shaped layers) ⇒ present:false (defensive guard)', () => {
        expect(selectNebulosityLayers({ nebulosity_layer: { method: 'x' } }).present).toBe(false);
        expect(selectNebulosityLayers({ nebulosity_layer: { layers: { star: {} } } }).present).toBe(false);
    });
});

describe('selectNebulosityLayers — present state from a real decomposition', () => {
    // Build a genuine receipt block from the real producer (structured, star field).
    const W = 48;
    const obs = new Float64Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        obs[y * W + x] = 10 + 3 * Math.sin(x / 6) * Math.cos(y / 6); // smooth diffuse
    }
    // a couple of compact bright stars
    obs[20 * W + 20] += 400; obs[21 * W + 20] += 250; obs[30 * W + 34] += 350;
    const decomp = decomposeNebulosityLayers(obs, W, W);
    const block = buildNebulosityLayerReceipt(decomp, obs);

    it('well-formed block ⇒ present:true with all four layers', () => {
        const d: NebulosityLayersData = selectNebulosityLayers({ nebulosity_layer: block });
        expect(d.present).toBe(true);
        expect(d.layers).not.toBeNull();
        expect(Object.keys(d.layers!)).toEqual(['star', 'nebulosity', 'sky_gradient', 'residual']);
        expect(d.method).toContain('starlet');
        expect(d.approximate).toBe(true);
    });

    it('preserves the module per-layer honest-or-absent flag (nebulosity may be present:false)', () => {
        const d = selectNebulosityLayers({ nebulosity_layer: block });
        // sky_gradient is always the DC floor ⇒ always present; residual too.
        expect(d.layers!.sky_gradient.present).toBe(true);
        expect(d.layers!.residual.present).toBe(true);
        // nebulosity.present mirrors the module's gate — we don't fabricate it.
        expect(typeof d.layers!.nebulosity.present).toBe('boolean');
        expect(d.layers!.nebulosity.present).toBe(block!.layers.nebulosity.present);
    });
});

describe('nebulosityLayersWidget manifest', () => {
    it('is a chart-tier, id-stable, intent-bearing live widget', () => {
        expect(nebulosityLayersWidget.id).toBe('nebulosity_layers');
        expect(nebulosityLayersWidget.weightTier).toBe('chart');
        expect(nebulosityLayersWidget.kind).toBeUndefined(); // defaults to 'live' ⇒ auto-graduates
        expect(nebulosityLayersWidget.intent.length).toBeGreaterThan(20);
    });
});
