/**
 * LENSFUN VIGNETTING INGEST — parse + breakpoint selection.
 *
 * Locks the pa-model ingest that finished the `vignetting?: any // To be
 * implemented` stub (lensfun_ingestor.ts). Coverage: DOM-free XML tag parse,
 * model gating (only "pa"), the ∞-focus distance sentinel, and nearest-breakpoint
 * selection by (focal, aperture) with the choice recorded.
 *
 * FIXTURE PROVENANCE: the raw XF23mmF2 lensfun k1/k2/k3 were NOT banked (the
 * row-509 artifact deviation_stats.json holds only EVALUATED edge intensities, not
 * the polynomial coefficients), so the coefficients below are SYNTHETIC — chosen so
 * the f/2 breakpoint reproduces the banked f/2 edge attenuation (lf_edge_I ≈ 0.356
 * at r = 0.821 ⇒ r² ≈ 0.674): att(0.674) = 1 − 1.02·0.674 + 0.08·0.454 ≈ 0.349.
 * They are NOT the real Lensfun DB values.
 */
import { describe, it, expect } from 'vitest';
import {
    LensfunIngestor,
    type LensfunVignetting,
} from '../pipeline/m2_hardware/lensfun_ingestor';

// Synthetic XF23mmF2-shaped lens node (pa model; monotone: wider aperture → less
// falloff). distance="1000" is the lensfun ∞-focus sentinel.
const XF23_FRAGMENT = `
<lens>
  <maker>Fujifilm</maker>
  <model>XF 23mm F2 R WR</model>
  <mount>Fujifilm X</mount>
  <cropfactor>1.5</cropfactor>
  <calibration>
    <distortion model="poly3" focal="23" k1="-0.01"/>
    <vignetting model="pa" focal="23" aperture="2"   distance="1000" k1="-1.02" k2="0.08" k3="0"/>
    <vignetting model="pa" focal="23" aperture="2.8" distance="1000" k1="-0.62" k2="0.05" k3="0"/>
    <vignetting model="pa" focal="23" aperture="4"   distance="1000" k1="-0.38" k2="0.03" k3="0"/>
  </calibration>
</lens>`;

describe('lensfun vignetting — parseVignettingTags (DOM-free XML)', () => {
    it('parses all three pa breakpoints as APPROXIMATE', () => {
        const vig = LensfunIngestor.parseVignettingTags(XF23_FRAGMENT);
        expect(vig).not.toBeNull();
        expect(vig!.model).toBe('pa');
        expect(vig!.tier).toBe('APPROXIMATE');
        expect(vig!.breakpoints).toHaveLength(3);
    });

    it('reads the f/2 wide-open breakpoint coefficients exactly', () => {
        const vig = LensfunIngestor.parseVignettingTags(XF23_FRAGMENT)!;
        const f2 = vig.breakpoints.find((b) => b.aperture === 2)!;
        expect(f2.focal).toBe(23);
        expect(f2.k1).toBe(-1.02);
        expect(f2.k2).toBe(0.08);
        expect(f2.k3).toBe(0);
    });

    it('maps the lensfun "1000" distance to the ∞ sentinel', () => {
        const vig = LensfunIngestor.parseVignettingTags(XF23_FRAGMENT)!;
        expect(vig.breakpoints.every((b) => b.distance === Infinity)).toBe(true);
    });

    it('reproduces the banked f/2 edge attenuation at r²≈0.674 (grounding cross-check)', () => {
        const f2 = LensfunIngestor.parseVignettingTags(XF23_FRAGMENT)!.breakpoints.find((b) => b.aperture === 2)!;
        const r2 = 0.674; // r ≈ 0.821 (the row-509 measured-domain edge)
        const att = 1 + f2.k1 * r2 + f2.k2 * r2 * r2 + f2.k3 * r2 ** 3;
        // Synthetic coeffs land att ≈ 0.349, within 0.01 of the banked lf_edge_I =
        // 0.3559506918230613 (~2%) — a book-prior-level grounding, not a fit.
        expect(Math.abs(att - 0.3559506918230613)).toBeLessThan(0.01);
    });

    it('returns null when a fragment carries no vignetting (honest absence)', () => {
        expect(LensfunIngestor.parseVignettingTags('<lens><maker>X</maker></lens>')).toBeNull();
    });

    it('keeps a finite focus distance as-is', () => {
        const vig = LensfunIngestor.parseVignettingTags(
            '<vignetting model="pa" focal="23" aperture="2" distance="0.5" k1="-0.9" k2="0" k3="0"/>',
        )!;
        expect(vig.breakpoints[0].distance).toBe(0.5);
    });
});

describe('lensfun vignetting — parseVignettingModel gating', () => {
    it('rejects a non-pa model (lensfun ships only "pa")', () => {
        expect(LensfunIngestor.parseVignettingModel({ model: 'acm', focal: '23', aperture: '2' })).toBeNull();
    });

    it('rejects an unkeyed entry (missing focal or aperture) rather than mis-selecting it', () => {
        expect(LensfunIngestor.parseVignettingModel({ model: 'pa', aperture: '2', k1: '-0.5' })).toBeNull();
        expect(LensfunIngestor.parseVignettingModel({ model: 'pa', focal: '23', k1: '-0.5' })).toBeNull();
    });

    it('coerces missing k-coefficients to 0', () => {
        const bp = LensfunIngestor.parseVignettingModel({ model: 'pa', focal: '23', aperture: '2' })!;
        expect(bp).toMatchObject({ focal: 23, aperture: 2, k1: 0, k2: 0, k3: 0 });
    });
});

describe('lensfun vignetting — selectVignetting (nearest breakpoint, recorded)', () => {
    const vig = LensfunIngestor.parseVignettingTags(XF23_FRAGMENT)!;

    it('exact (focal, aperture) → that breakpoint, exact=true, zero deltas', () => {
        const sel = LensfunIngestor.selectVignetting(vig, 23, 2)!;
        expect(sel.breakpoint.aperture).toBe(2);
        expect(sel.exact).toBe(true);
        expect(sel.focalDeltaMm).toBe(0);
        expect(sel.apertureDelta).toBe(0);
    });

    it('non-exact aperture → nearest aperture, delta recorded', () => {
        // f/3.5: |3.5-2.8|=0.7 vs |3.5-4|=0.5 → picks f/4
        const sel = LensfunIngestor.selectVignetting(vig, 23, 3.5)!;
        expect(sel.breakpoint.aperture).toBe(4);
        expect(sel.apertureDelta).toBe(0.5);
        expect(sel.exact).toBe(false);
    });

    it('records a focal delta when the requested focal is absent', () => {
        const sel = LensfunIngestor.selectVignetting(vig, 50, 2)!;
        expect(sel.breakpoint.focal).toBe(23);
        expect(sel.focalDeltaMm).toBe(-27);
    });

    it('focal is the primary key; aperture only breaks focal ties', () => {
        // Two focals, same apertures. Request (30, 2): |30-23|=7 vs |30-35|=5 → 35mm wins
        // even though its f/2 aperture ties the 23mm f/2 aperture.
        const twoFocal: LensfunVignetting = {
            model: 'pa', tier: 'APPROXIMATE',
            breakpoints: [
                { focal: 23, aperture: 2, distance: Infinity, k1: -1.0, k2: 0, k3: 0 },
                { focal: 35, aperture: 2, distance: Infinity, k1: -0.6, k2: 0, k3: 0 },
            ],
        };
        const sel = LensfunIngestor.selectVignetting(twoFocal, 30, 2)!;
        expect(sel.breakpoint.focal).toBe(35);
        expect(sel.focalDeltaMm).toBe(5);
    });

    it('returns null on an empty/absent model', () => {
        expect(LensfunIngestor.selectVignetting(null, 23, 2)).toBeNull();
        expect(LensfunIngestor.selectVignetting({ model: 'pa', tier: 'APPROXIMATE', breakpoints: [] }, 23, 2)).toBeNull();
    });
});
