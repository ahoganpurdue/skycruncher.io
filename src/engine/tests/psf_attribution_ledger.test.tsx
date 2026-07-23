import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttributionLedger, attrTierTone, ATTR_TIER_TONE } from '../ui/psf/AttributionLedger';
import type { PsfAttributionLike } from '../ui/psf/AttributionLedger';
import type { ChipTone } from '../ui/kit';

/**
 * PSF ATTRIBUTION LEDGER (gallery W2.2) — server-render (node env, no DOM)
 * assertions that (1) chip tone maps from the PIPELINE-AUTHORED tier /
 * presence labels, all earned; (2) rows render only for tiers present in
 * the receipt block, absent block = whole ledger absent; (3) honest-absence
 * renders the `--` sentinel, never a fabricated number (LAW 3).
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// Token classes per tone — hoisted verbatim from kit/Chip.tsx TONES.
const TONE_CLASSES: Record<ChipTone, string> = {
    solve: 'bg-solve-dim text-solve',
    warn: 'bg-warn-dim text-warn',
    danger: 'bg-danger-dim text-danger',
    accent: 'bg-accent-glow text-accent-300',
    info: 'bg-info-dim text-info',
    neutral: 'bg-space-750 text-text-secondary',
};

// ── fixtures (shapes mirror stages/psf_attribution.ts sections) ────────────

const measuredFull: NonNullable<PsfAttributionLike['measured']> = {
    majFwhmPx: 5.61, minFwhmPx: 4.02, ellipticity: 0.283, orientationDeg: 47.3,
    anisotropyPx: 1.59, source: 'psf_field_moments', nFit: 198,
};

const driftNotConfirmed: NonNullable<PsfAttributionLike['drift']> = {
    tier: 'CALCULATED', presence: 'NOT_CONFIRMED',
    calculatedPx: 3.42, calculatedArcsec: 8.19, paDeg: 91.2, decDegUsed: 12.99,
    exposureSec: 10, directionSource: 'WCS_CD',
    directionDeviationDeg: 43.9, magnitudeRatio: 0.465,
    explainedPx: null, residualCorePx: null, kernel: null,
    note: 'Measured elongation does NOT match the calculated drift (dirΔ=43.9°>tol, majΔ ok) — drift not confirmed; elongation attributed elsewhere (tracked/guiding/other).',
};

const driftConfirmed: NonNullable<PsfAttributionLike['drift']> = {
    ...driftNotConfirmed,
    tier: 'CONFIRMED', presence: 'CONFIRMED_PRESENT',
    explainedPx: 3.42, residualCorePx: 4.44,
    note: 'Measured elongation matches the CALCULATED drift in magnitude AND direction — drift confirmed present and trusted as EXACT for its component (test-then-trust).',
};

const diffractionCalc: NonNullable<PsfAttributionLike['diffraction']> = {
    tier: 'CALCULATED',
    floorArcsec: { r: 3.87, g: 3.11, b: 2.75 },
    floorPx: { r: 1.62, g: 1.38, b: 1.19 },
    rayleighArcsecG: 3.71, apertureDiameterMm: 30.0, limitedGreen: true,
    note: 'Diffraction-limited FWHM floor (1.028·λ/D), per channel. A lower bound on the measured PSF — never a subtraction.',
};

const seeingApprox: NonNullable<PsfAttributionLike['seeing']> = {
    tier: 'APPROXIMATE', arcsec: 2.31, px: 0.96, airmass: 1.41,
    thetaZenithAssumedArcsec: 2.0,
    note: 'Airmass-scaled seeing θ_zenith·(sec z)^0.6 with an ASSUMED θ_zenith (2.0″). APPROXIMATE.',
};

const refractionApprox: NonNullable<PsfAttributionLike['refraction']> = {
    tier: 'APPROXIMATE', gatedOn: 'timestampTrusted && GPS present',
    targetAltitudeDeg: 44.9, airmass: 1.41,
    fieldDifferentialArcsec: 1.02, fieldDifferentialPx: 0.42,
    zenithParallacticDeg: 12.3, zenithPaImageDeg: 100.2,
    note: 'Field-level differential refraction (Bennett).',
};

const comaRejected: NonNullable<PsfAttributionLike['coma']> = {
    tier: 'FITTED',
    fit: { coeffPerPx: null, rSquared: -14.93, medianRadialDeviationDeg: 61.2, nRegions: 8, patternConsistent: false },
    note: 'Coma FORM checked against the measured 3×3 field; pattern NOT consistent (elongation not radial/growing) — no coma coefficient asserted.',
};

const comaFitted: NonNullable<PsfAttributionLike['coma']> = {
    tier: 'FITTED',
    fit: { coeffPerPx: 0.184, rSquared: 0.91, medianRadialDeviationDeg: 11.4, nRegions: 8, patternConsistent: true },
    note: 'Measured field matches the immutable coma FORM.',
};

const fieldRotationDeferred: NonNullable<PsfAttributionLike['fieldRotation']> = {
    tier: 'NOT_MEASURED',
    note: 'Field rotation DEFERRED — requires a mount type (alt-az vs equatorial) absent from EXIF.',
};

const fullBlock: PsfAttributionLike = {
    grid: 'SCIENCE_NATIVE',
    measured: measuredFull,
    drift: driftNotConfirmed,
    diffraction: diffractionCalc,
    seeing: seeingApprox,
    refraction: refractionApprox,
    coma: comaRejected,
    fieldRotation: fieldRotationDeferred,
};

// ── tone mapping (label → earned tone) ─────────────────────────────────────

describe('AttributionLedger tone mapping', () => {
    const EXPECTED: Record<string, ChipTone> = {
        MEASURED: 'solve',
        CONFIRMED: 'solve',
        CONFIRMED_PRESENT: 'solve',
        CALCULATED: 'accent',
        FITTED: 'accent',
        'FIT REJECTED': 'danger',
        APPROXIMATE: 'warn',
        NOT_CONFIRMED: 'warn',
        INFERRED: 'info',
        NEGLIGIBLE: 'neutral',
        NOT_MEASURED: 'neutral',
    };

    it.each(Object.entries(EXPECTED))('maps pipeline label %s → %s', (label, tone) => {
        expect(attrTierTone(label)).toBe(tone);
    });

    it('the exported map carries exactly the known labels', () => {
        expect(Object.keys(ATTR_TIER_TONE).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it('an unknown label falls back to neutral — never an unearned color', () => {
        expect(attrTierTone('SOMETHING_NEW')).toBe('neutral');
    });
});

// ── absence (LAW 3) ────────────────────────────────────────────────────────

describe('AttributionLedger absence', () => {
    it('absent block ⇒ whole ledger absent (renders nothing)', () => {
        expect(html(<AttributionLedger attribution={null} />)).toBe('');
        expect(html(<AttributionLedger attribution={undefined} />)).toBe('');
    });

    it('block with no tier sections ⇒ renders nothing', () => {
        expect(html(<AttributionLedger attribution={{ grid: 'SCIENCE_NATIVE' }} />)).toBe('');
    });
});

// ── full receipt: one row per tier ─────────────────────────────────────────

describe('AttributionLedger full receipt', () => {
    const out = html(<AttributionLedger attribution={fullBlock} />);

    it('renders one row per tier present', () => {
        for (const key of ['anisotropy', 'drift', 'diffraction', 'seeing', 'refraction', 'coma', 'field_rotation']) {
            expect(out).toContain(`data-testid="psf-attr-row-${key}"`);
        }
    });

    it('anisotropy: measured value in px with an earned MEASURED (solve) chip', () => {
        expect(out).toContain('1.59');
        expect(out).toContain('MEASURED');
        expect(out).toContain(TONE_CLASSES.solve);
        expect(out).toContain('n=198 stars');
    });

    it('drift: CALCULATED (accent) tier chip PLUS NOT_CONFIRMED (warn) presence chip', () => {
        expect(out).toContain('CALCULATED');
        expect(out).toContain(TONE_CLASSES.accent);
        expect(out).toContain('NOT_CONFIRMED');
        expect(out).toContain(TONE_CLASSES.warn);
        expect(out).toContain('3.42'); // calculated drift px, still shown honestly
        expect(out).toContain('drift not confirmed'); // pipeline-authored note
    });

    it('seeing + refraction: APPROXIMATE (warn) with assumed-constant context', () => {
        expect(out).toContain('APPROXIMATE');
        expect(out).toContain('θ_zenith 2″ ASSUMED · airmass 1.41');
        expect(out).toContain('plate stretch toward zenith (Bennett, plate-level)');
        expect(out).toContain('0.42');
    });

    it('diffraction: green floor value with per-channel context', () => {
        expect(out).toContain('1.38');
        expect(out).toContain('1.028·λ/D green floor');
        expect(out).toContain('minor FWHM at green floor'); // limitedGreen === true, earned
    });

    it('coma fit-rejected: danger chip, -- sentinel, no coefficient claimed', () => {
        expect(out).toContain('FIT REJECTED');
        expect(out).toContain(TONE_CLASSES.danger);
        expect(out).toContain('pattern inconsistent, R²=-14.93 — no coefficient claimed');
        expect(out).not.toContain('0.184'); // no coefficient anywhere
    });

    it('field rotation: NOT_MEASURED (neutral) with the mount-type reason and -- value', () => {
        expect(out).toContain('NOT_MEASURED');
        expect(out).toContain(TONE_CLASSES.neutral);
        expect(out).toContain('requires a mount type');
        expect(out).toContain('--');
    });
});

// ── earned-solve and fitted-coma paths ─────────────────────────────────────

describe('AttributionLedger earned tiers', () => {
    it('drift CONFIRMED renders a single solve chip (presence flag is redundant, not duplicated)', () => {
        const out = html(<AttributionLedger attribution={{ drift: driftConfirmed }} />);
        expect(out).toContain('CONFIRMED');
        expect(out).toContain(TONE_CLASSES.solve);
        expect(out).not.toContain('CONFIRMED_PRESENT');
    });

    it('coma pattern-consistent claims the coefficient under a FITTED (accent) chip', () => {
        const out = html(<AttributionLedger attribution={{ coma: comaFitted }} />);
        expect(out).toContain('FITTED');
        expect(out).toContain(TONE_CLASSES.accent);
        expect(out).toContain('0.184');
        expect(out).toContain('R²=0.91');
        expect(out).toContain('form-exact, magnitude-empirical');
    });

    it('drift NEGLIGIBLE adds a neutral presence chip', () => {
        const out = html(
            <AttributionLedger
                attribution={{ drift: { ...driftNotConfirmed, presence: 'NEGLIGIBLE', calculatedPx: 0.12, note: 'Calculated drift 0.12px is below the ~0.5px measurement floor — cannot be confirmed or refuted.' } }}
            />
        );
        expect(out).toContain('NEGLIGIBLE');
        expect(out).toContain(TONE_CLASSES.neutral);
        expect(out).toContain('0.12');
    });
});

// ── partial-tier receipts ──────────────────────────────────────────────────

describe('AttributionLedger partial-tier receipts', () => {
    it('renders only the tiers present in the block', () => {
        const out = html(<AttributionLedger attribution={{ drift: driftNotConfirmed, coma: comaRejected }} />);
        expect(out).toContain('data-testid="psf-attr-row-drift"');
        expect(out).toContain('data-testid="psf-attr-row-coma"');
        for (const key of ['anisotropy', 'diffraction', 'seeing', 'refraction', 'field_rotation']) {
            expect(out).not.toContain(`data-testid="psf-attr-row-${key}"`);
        }
    });

    it('accepts the receipt-serialized field_rotation key (snake_case)', () => {
        const out = html(<AttributionLedger attribution={{ field_rotation: fieldRotationDeferred }} />);
        expect(out).toContain('data-testid="psf-attr-row-field_rotation"');
        expect(out).toContain('NOT_MEASURED');
    });

    it('explicitly null sections are treated as absent', () => {
        const out = html(<AttributionLedger attribution={{ drift: driftNotConfirmed, seeing: null, coma: null }} />);
        expect(out).toContain('data-testid="psf-attr-row-drift"');
        expect(out).not.toContain('data-testid="psf-attr-row-seeing"');
        expect(out).not.toContain('data-testid="psf-attr-row-coma"');
    });
});

// ── honest absence inside present tiers ────────────────────────────────────

describe('AttributionLedger NOT_MEASURED tiers', () => {
    it('NOT_MEASURED drift renders the -- sentinel and its honest reason', () => {
        const out = html(
            <AttributionLedger
                attribution={{
                    drift: {
                        tier: 'NOT_MEASURED', presence: 'NOT_MEASURED',
                        calculatedPx: null, calculatedArcsec: null, paDeg: null, decDegUsed: null,
                        exposureSec: null, directionSource: null, directionDeviationDeg: null,
                        magnitudeRatio: null, explainedPx: null, residualCorePx: null, kernel: null,
                        note: 'Sidereal drift NOT ATTRIBUTED.',
                        notMeasured: 'Exposure time / Dec / pixel scale unavailable — sidereal drift NOT CALCULABLE.',
                    },
                }}
            />
        );
        expect(out).toContain('NOT_MEASURED');
        expect(out).toContain(TONE_CLASSES.neutral);
        expect(out).toContain('--');
        expect(out).toContain('sidereal drift NOT CALCULABLE');
        // no fabricated number: the value cell is the sentinel, not a 0
        expect(out).not.toContain('0.00');
    });

    it('measured section with null anisotropy renders NOT_MEASURED, not a value', () => {
        const out = html(
            <AttributionLedger
                attribution={{
                    measured: { majFwhmPx: null, minFwhmPx: null, ellipticity: null, orientationDeg: null, anisotropyPx: null, source: 'NOT_MEASURED', nFit: 0 },
                    notMeasured: 'No measured PSF field or no solution — PSF attribution NOT MEASURED.',
                }}
            />
        );
        expect(out).toContain('NOT_MEASURED');
        expect(out).toContain('--');
        expect(out).toContain('PSF attribution NOT MEASURED');
        expect(out).not.toContain(TONE_CLASSES.solve); // MEASURED (solve) is earned — absent here
    });
});
