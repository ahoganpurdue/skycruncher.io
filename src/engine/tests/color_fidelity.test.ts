import { describe, it, expect } from 'vitest';
import { fitColorRegression, computeColorFidelity, type ColorSample } from '../pipeline/m8_photometry/spcc_calibrator';

// Synthetic set with a NOISY predictor (instrumental color) so OLS attenuates:
//   catBpRp = 0.8*latent + 0.5   (true)
//   instColor = latent + zero-mean noise  -> OLS(catBpRp|instColor) biased low.
// Noise is small enough that the engine's 2.5σ clip keeps every point, so the
// survivor OLS slope IS the attenuated full-set slope.
function noisySamples(): ColorSample[] {
    const s: ColorSample[] = [];
    for (let i = 0; i < 12; i++) {
        const latent = i * 0.2;                 // 0 .. 2.2
        const noise = (i % 2 === 0 ? 0.15 : -0.15);
        s.push({ instColor: latent + noise, catBpRp: 0.8 * latent + 0.5 });
    }
    return s;
}

describe('computeColorFidelity — MEASURED report surface (§4.1)', () => {
    it('mirrors the engine survivor fit and reports the honest unclipped bracket', () => {
        const samples = noisySamples();
        const fit = fitColorRegression(samples);
        expect(fit.valid).toBe(true);
        const fid = computeColorFidelity(samples, fit);

        // headline r2 is the survivor OLS (continuity with the spcc block)
        expect(fid.r2_survivor).toBe(fit.r2);
        expect(fid.slope_ols).toBe(fit.slope);
        expect(fid.n_samples).toBe(12);

        // honest full-set stats are present + finite
        expect(Number.isFinite(fid.r2_unclipped)).toBe(true);
        expect(fid.r2_unclipped).toBeLessThanOrEqual(1);
        expect(Number.isFinite(fid.rmse_unclipped_mag)).toBe(true);

        // errors-in-variables: TLS slope is STEEPER than the attenuated OLS
        expect(fid.slope_tls).not.toBeNull();
        expect(fid.slope_bracket).not.toBeNull();
        expect(fid.slope_tls!).toBeGreaterThan(fid.slope_ols);
        expect(fid.attenuation_ratio!).toBeGreaterThan(1);
    });

    it('is EVIDENCE, never a gate (validated null, research bar)', () => {
        const fid = computeColorFidelity(noisySamples(), fitColorRegression(noisySamples()));
        expect(fid.validated).toBeNull();
        expect(fid.bar).toBe('RESEARCH_N1');
    });

    it('degrades honestly below 3 samples (no TLS bracket)', () => {
        const few: ColorSample[] = [{ instColor: 0, catBpRp: 0.5 }, { instColor: 1, catBpRp: 1.3 }];
        const fid = computeColorFidelity(few, { valid: true, slope: 0.8, intercept: 0.5, r2: 1, rmse: 0, n_used: 2 });
        expect(fid.n_samples).toBe(2);
        expect(fid.slope_tls).toBeNull();
        expect(fid.slope_bracket).toBeNull();
        expect(fid.attenuation_ratio).toBeNull();
        expect(fid.validated).toBeNull();
    });
});
