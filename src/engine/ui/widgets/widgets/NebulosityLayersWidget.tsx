/**
 * DATA-BACKED WIDGET (chart tier) — MULTISCALE NEBULOSITY DECOMPOSITION viewer.
 *
 * Consumes the `nebulosity_layer` receipt block produced by
 * `m10_psf/nebulosity_layer.ts` (the additive-complete starlet decomposition:
 * star / nebulosity / sky_gradient / residual, PIXEL ledger, native grid). It is
 * a layer-toggle readout: pick a layer, read its integrated flux / support /
 * SNR / scale band, with a support-fraction overview across all four layers.
 *
 * ── PRODUCER-GAP FLAG (honest, load-bearing) ────────────────────────────────
 * As of this widget's landing the decomposition producer is NOT wired into
 * `buildReceipt` (stages/package.ts) — `nebulosity_layer.ts:460-468` documents
 * that wiring as a separate increment that must bump RECEIPT_SCHEMA_VERSION. So
 * `receipt.nebulosity_layer` is ABSENT on every real receipt today. This widget
 * therefore renders an explicit "DECOMPOSITION NOT RUN — producer not wired to
 * receipt" state rather than a generic empty state, so the gap is legible and the
 * widget stays honest (LAW 3). It CONSUMES `receipt.nebulosity_layer` as-is: the
 * moment the producer is wired, the same selector lights the layer view up — no
 * widget change needed.
 *
 * ── WHY NOT WebGPU (render-tech policy D-webgpu-default) ─────────────────────
 * WebGPU is preferred for NEW visuals, but only summary SCALARS reach the
 * receipt (integrated_flux / support_frac / snr / scale_band / significance) —
 * the decomposed pixel arrays (Float32Array) are deliberately NOT serialized
 * (nebulosity_layer.ts `NebulosityLayerReceipt`). With no per-pixel field to
 * composite, there is nothing for the GPU to do; this is a DOM/SVG scalar-readout
 * surface, which WIDGET_LIBRARY.md §6 explicitly permits. If a future receipt
 * revision exports per-layer pixel buffers, a WebGPU layer-compositor becomes the
 * right call — FLAGGED here, not built (no data to feed it, and building it would
 * mean invoking engine stages the widget must not touch).
 *
 * Selector never returns null (structural surface — same pattern the flowchart
 * widgets use): honest absence is expressed INSIDE the render (`present:false`)
 * so the producer-gap message can be specific, not a generic "NOT MEASURED".
 */

import React, { useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import type { NebulosityLayerReceipt, NebulosityLayerReceiptLayer } from '../../../pipeline/m10_psf/nebulosity_layer';
import { finite } from '../widget_math';
import { Readout, HBars, type HBar } from '../chart_primitives';

type LayerKey = 'star' | 'nebulosity' | 'sky_gradient' | 'residual';

const LAYER_ORDER: readonly LayerKey[] = ['star', 'nebulosity', 'sky_gradient', 'residual'];
const LAYER_LABEL: Record<LayerKey, string> = {
    star: 'Star',
    nebulosity: 'Nebulosity',
    sky_gradient: 'Sky gradient',
    residual: 'Residual',
};
const LAYER_COLOR: Record<LayerKey, string> = {
    star: '--chart-cat-1',
    nebulosity: '--chart-cat-3',
    sky_gradient: '--chart-cat-5',
    residual: '--chart-cat-2',
};

export interface NebulosityLayersData {
    /** True when a real nebulosity_layer receipt block is present (producer wired + run). */
    present: boolean;
    method: string | null;
    sigmaNoise: number | null;
    reconMaxAbsErr: number | null;
    /** Per-layer summary (null when the block is absent). */
    layers: Record<LayerKey, NebulosityLayerReceiptLayer> | null;
    approximate: boolean;
}

/** Defensive shape guard for one receipt layer (never trusts the bag blindly). */
function isReceiptLayer(v: any): v is NebulosityLayerReceiptLayer {
    return v != null && typeof v === 'object'
        && typeof v.present === 'boolean'
        && typeof v.significance_flag === 'boolean'
        && Array.isArray(v.scale_band);
}

/**
 * PURE selector over `receipt.nebulosity_layer`. NEVER null (structural surface):
 * returns `{ present:false }` when the block is absent so the render shows the
 * specific producer-gap state. When present, surfaces the per-layer summary.
 */
export function selectNebulosityLayers(receipt: WidgetReceipt): NebulosityLayersData {
    const blk = receipt?.nebulosity_layer as NebulosityLayerReceipt | null | undefined;
    const L = blk?.layers;
    if (!blk || !L || !LAYER_ORDER.every(k => isReceiptLayer((L as any)[k]))) {
        return { present: false, method: null, sigmaNoise: null, reconMaxAbsErr: null, layers: null, approximate: false };
    }
    return {
        present: true,
        method: typeof blk.method === 'string' ? blk.method : null,
        sigmaNoise: finite(blk.sigma_noise),
        reconMaxAbsErr: finite(blk.reconstruction_max_abs_err),
        layers: {
            star: L.star, nebulosity: L.nebulosity, sky_gradient: L.sky_gradient, residual: L.residual,
        },
        approximate: blk.approximate === true,
    };
}

const num = (v: number | null, digits = 3): string =>
    v == null ? '—' : Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : v.toFixed(digits);

/** Honest per-layer status: present + significant, present-only, or absent. */
function layerStatus(l: NebulosityLayerReceiptLayer): { label: string; cls: string } {
    if (!l.present) return { label: 'ABSENT (honest-or-absent gate)', cls: 'text-text-faint' };
    if (!l.significance_flag) return { label: 'present · below significance', cls: 'text-text-muted' };
    return { label: 'present · significant', cls: 'text-data' };
}

const NebulosityLayersRender: React.FC<WidgetRenderProps<NebulosityLayersData>> = ({ data }) => {
    const [sel, setSel] = useState<LayerKey>('nebulosity');

    if (!data.present || !data.layers) {
        // Producer-gap honest state — specific, not a generic empty block.
        return (
            <div className="flex flex-col items-center gap-1.5 py-4 text-center" data-testid="widget-nebulosity-layers-absent">
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest px-1.5 py-px rounded text-text-muted bg-space-800">
                    DECOMPOSITION NOT RUN
                </span>
                <span className="text-[10px] text-text-faint max-w-[40ch]">
                    The multiscale starlet decomposition producer exists (m10_psf/nebulosity_layer.ts,
                    unit-tested) but is not yet wired into the receipt — no <span className="font-mono">nebulosity_layer</span> block
                    reaches this widget. Layers will render here once the producer is attached to buildReceipt.
                </span>
            </div>
        );
    }

    const layers = data.layers;
    const bars: HBar[] = LAYER_ORDER.map(k => ({
        label: LAYER_LABEL[k],
        value: Number((layers[k].support_frac * 100).toFixed(2)),
        colorVar: LAYER_COLOR[k],
    }));
    const s = layers[sel];
    const st = layerStatus(s);

    return (
        <div className="flex flex-col gap-3" data-testid="widget-nebulosity-layers">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="σ noise" value={num(data.sigmaNoise)} title="Estimated pixel noise σ from the finest starlet scale" />
                <Readout label="Recon err" value={num(data.reconMaxAbsErr)} title="Max |reconstruction − input| — additive-complete check" />
            </div>

            {/* Layer toggle — star / nebulosity / sky gradient / residual. */}
            <div className="inline-flex flex-wrap rounded-lg border border-line overflow-hidden" role="group" aria-label="Nebulosity layer">
                {LAYER_ORDER.map(k => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setSel(k)}
                        data-testid={`nebulosity-layer-${k}`}
                        aria-pressed={sel === k}
                        className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${
                            sel === k ? 'bg-accent-600 text-white' : 'bg-space-800 text-text-secondary hover:text-text-primary'
                        }`}
                    >
                        {LAYER_LABEL[k]}
                    </button>
                ))}
            </div>

            {/* Selected layer readout — honest per-layer absence preserved. */}
            <div className="flex flex-col gap-1.5 bg-space-900/60 rounded-lg p-2.5" data-testid="nebulosity-selected">
                <div className={`text-[10px] font-mono ${st.cls}`}>{LAYER_LABEL[sel]}: {st.label}</div>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                    <Readout label="Integrated flux" value={s.present ? num(finite(s.integrated_flux)) : '—'} />
                    <Readout label="Support" value={s.present ? `${(s.support_frac * 100).toFixed(2)}%` : '—'} />
                    <Readout label="SNR (Σ|w|/σ)" value={s.present ? num(finite(s.snr), 1) : '—'} />
                    <Readout label="Scale band" value={`[${s.scale_band[0]}, ${s.scale_band[1]}]`} title="Inclusive starlet scale band (0 = coarse residual)" />
                </div>
            </div>

            {/* Support-fraction overview across all four layers. */}
            <HBars bars={bars} unit="%" testId="nebulosity-support-bars" />

            {data.approximate && (
                <div className="text-[10px] font-mono text-warn">
                    APPROXIMATE — starlet scale-cut / κ are per-rig knobs, not calibrated gate constants.
                </div>
            )}
        </div>
    );
};

export const nebulosityLayersWidget: WidgetManifest<NebulosityLayersData> = {
    id: 'nebulosity_layers',
    title: 'Nebulosity Layers',
    intent: 'Multiscale starlet decomposition of the native-grid luminance into additive layers (star / nebulosity / sky gradient / residual) — toggle a layer to read its integrated flux, support and SNR. Consumes the nebulosity_layer receipt block; shows an explicit DECOMPOSITION NOT RUN state while the producer is unwired.',
    dataSelector: selectNebulosityLayers,
    weightTier: 'chart',
    render: NebulosityLayersRender,
};

export default NebulosityLayersRender;
