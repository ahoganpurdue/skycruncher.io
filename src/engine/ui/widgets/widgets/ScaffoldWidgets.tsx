/**
 * SCAFFOLD WIDGETS (Phase 2) — registered, honest, NOT-YET-MEASURED.
 *
 * Each is a real registry entry whose `dataSelector` ALWAYS returns null, so the
 * dock frame renders the single canonical NOT MEASURED state (LAW 3). No scaffold
 * ever emits a number — several sit squarely in the codebase's original-sin
 * territory (a hardcoded fake aerosol_optical_depth once shown as "0.10"), so the
 * contract here is strict: intent only, zero fabricated data, until a real
 * measurement path lands and the selector is rewritten to read it.
 *
 * The one-line `intent` on each manifest is the single source of purpose,
 * surfaced by the review gallery and INTENTS.md. The shared render below is a
 * formality (the frame short-circuits on the null selector) that still shows the
 * intent + a NOT MEASURED banner if a caller renders it directly.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WeightTier, WidgetReceipt } from '../registry';

/** A scaffold carries no data — its render only ever sees this marker shape. */
export interface ScaffoldData { intent: string }

const ScaffoldRender: React.FC<WidgetRenderProps<ScaffoldData>> = ({ data }) => (
    <div className="flex flex-col gap-2" data-testid="widget-scaffold">
        <div className="text-[11px] font-mono text-text-muted py-3 text-center">NOT MEASURED</div>
        <div className="text-[10px] font-mono text-text-faint">{data.intent}</div>
    </div>
);

/**
 * Build a scaffold manifest. The selector is a PURE constant null (honest
 * absence) — a scaffold has, by definition, nothing measured to read yet.
 */
function makeScaffold(id: string, title: string, weightTier: WeightTier, intent: string): WidgetManifest<ScaffoldData> {
    return {
        id, title, intent, weightTier,
        // PLANNED, not absent: the dock frame reads `kind` to render a distinct
        // "not yet built" state so a future capability never masquerades as a
        // genuinely-absent measurement (LAW 3 empty-state taxonomy).
        kind: 'scaffold',
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        dataSelector: (_receipt: WidgetReceipt) => null,   // ALWAYS absent — never fabricate
        render: ScaffoldRender,
    };
}

export const SCAFFOLD_WIDGETS: WidgetManifest<ScaffoldData>[] = [
    makeScaffold('extinction_airmass', 'Extinction vs Airmass', 'chart',
        'FUTURE: measured atmospheric extinction (magnitudes lost per unit airmass) across the frame’s altitude range — a real per-frame transparency measurement, not a model constant.'),
    makeScaffold('lp_gradient_map', 'Light-Pollution Gradient', 'heavy',
        'FUTURE: 2D sky-background gradient surface from the measured background field — where light pollution rises across the frame.'),
    makeScaffold('rayleigh_mie', 'Rayleigh / Mie Split', 'chart',
        'FUTURE: decomposition of the measured sky background into Rayleigh (molecular) vs Mie (aerosol) scattering by color — physics, once a real spectral separation exists.'),
    makeScaffold('zodiacal_overlay', 'Zodiacal Light', 'heavy',
        'FUTURE: predicted zodiacal-light band overlaid on the frame from pointing + ecliptic geometry, compared against the measured background.'),
    makeScaffold('aod_haze', 'Aerosol / Haze (AOD)', 'chart',
        'FUTURE: aerosol optical depth / haze — HELD until a genuine measurement path exists. This is the original-sin slot (a fake AOD=0.10 was once displayed); it will show NOT MEASURED, never a placeholder number.'),
    makeScaffold('per_rig_workbench_trend', 'Per-Rig Trend', 'chart',
        'FUTURE: per-rig calibration trend across sessions (plate scale, distortion, PSF) from the Optical Workbench profile store, once it accumulates graduated per-cell history.'),
    makeScaffold('stack_registration_residuals', 'Stack Registration Residuals', 'chart',
        'FUTURE: per-sub registration residuals across a stack (alignment error vs frame index) from the stacker — how well the subs co-registered.'),
    makeScaffold('sextant_confidence', 'Sextant Confidence', 'chart',
        'FUTURE: derived observer-location confidence from plate-solve + trusted time + an up-reference (celestial navigation), with privacy tiers — never coordinates without consent.'),
    makeScaffold('bad_pixel_map', 'Bad-Pixel Map', 'heavy',
        'FUTURE: detected hot / cold / stuck pixel map from dark/bias statistics — the sensor defect map, once a calibration-frame path exists.'),
];
