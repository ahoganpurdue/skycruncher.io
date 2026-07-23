/**
 * -----------------------------------------------------------------
 * WIZARD STEP METADATA - Single source of truth for step copy
 * -----------------------------------------------------------------
 * Consumed by PipelineWizard (header/pips) and every step component.
 * Visual steps are 1-indexed; visual step N maps to session method
 * N-1 from step 3 onward (visual step 2 is a pure metadata form).
 */

export interface WizardStepMeta {
    id: number;
    title: string;
    subtitle: string;
}

export const STEP_META: WizardStepMeta[] = [
    {
        id: 1,
        title: 'Load & Inspect',
        subtitle: 'Reading file headers and preparing the science buffers.'
    },
    {
        id: 2,
        title: 'Observation Details',
        subtitle: 'Verify the time, location, and hardware context of the observation. Accurate time and location drive the ephemeris and atmospheric corrections.'
    },
    {
        id: 3,
        title: 'Star Detection',
        subtitle: 'Identify stars, planets, and atmospheric context before alignment.'
    },
    {
        id: 4,
        title: 'Scale & Ephemeris',
        subtitle: 'Lock the pixel scale and compute which solar-system bodies are expected in this field.'
    },
    {
        id: 5,
        title: 'Plate Solve',
        subtitle: 'Match detected star patterns against the Gaia-derived index to determine exactly where the image points (WCS).'
    },
    {
        id: 6,
        title: 'Optical Calibration',
        subtitle: 'Fit distortion and vignetting models to star residuals to profile this specific optical train.'
    },
    {
        id: 7,
        title: 'Export',
        subtitle: 'Bundle the WCS solution, calibration profile, and measurements into a verifiable AstroPacket.'
    }
];

export function getStepMeta(step: number): WizardStepMeta {
    return STEP_META[step - 1] ?? STEP_META[0];
}
