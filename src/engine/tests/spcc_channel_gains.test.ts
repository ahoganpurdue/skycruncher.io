import { describe, it, expect } from 'vitest';
import { fitChannelGains, type ChannelGainSample, type ChannelGainConfig } from '../pipeline/m8_photometry/spcc_calibrator';

// ─── Synthetic instrument with a KNOWN per-channel imbalance ──────────────────
// The true instrumental colors track catalog BP-RP linearly:
//   y_br(x) = A_BR + B_BR·x   (b−r color),  y_gr(x) = A_GR + B_GR·x
// At the white reference x0=0 the colors are (A_BR, A_GR), so the gains that
// neutralize a white star (renormalized green=1) are:
//   g_R = 10^(-A_GR/2.5),  g_B = 10^((A_BR - A_GR)/2.5),  g_G = 1.
// Both axes carry EQUAL deterministic noise → the errors-in-variables regime
// where TLS is unbiased and OLS(y|x) attenuates the slope toward zero.
const A_BR = -0.30, B_BR = 1.0;
const A_GR = -0.12, B_GR = 1.0;
const TRUE_GR = Math.pow(10, -A_GR / 2.5);          // ≈ 1.117
const TRUE_GB = Math.pow(10, (A_BR - A_GR) / 2.5);  // ≈ 0.847

const CFG: ChannelGainConfig = {
    whiteRefBpRp: 0.0, minStars: 8, minR2: 0.5,
    slopeMin: 0.3, slopeMax: 3.0, minGain: 0.25, maxGain: 4.0, applyEnabled: true,
};

/** Deterministic pseudo-noise (no Math.random) — decorrelated phases. */
const noise = (i: number, phase: number, amp: number) => amp * Math.sin(i * phase + phase);

/** Build errors-in-variables samples: equal noise `amp` on catalog + instr color. */
function makeSamples(n: number, amp: number): ChannelGainSample[] {
    const out: ChannelGainSample[] = [];
    for (let i = 0; i < n; i++) {
        const latent = 0.3 + i * (1.4 / n);            // true color 0.3 .. ~1.7 (x̄ ≈ 1.0)
        const yBR = A_BR + B_BR * latent + noise(i, 2.3, amp);
        const yGR = A_GR + B_GR * latent + noise(i, 3.1, amp);
        const catBpRp = latent + noise(i, 1.7, amp);   // noisy catalog proxy (x-axis noise)
        const flux_r = 1;
        const flux_b = flux_r * Math.pow(10, -yBR / 2.5);
        const flux_g = flux_r * Math.pow(10, -yGR / 2.5);
        out.push({ flux_r, flux_g, flux_b, catBpRp });
    }
    return out;
}

/** Reference OLS gain derivation (the BIASED estimator the module must NOT use). */
function olsGains(samples: ChannelGainSample[]): { gR: number; gB: number; slopeBR: number } {
    const x = samples.map(s => s.catBpRp);
    const yBR = samples.map(s => -2.5 * Math.log10(s.flux_b / s.flux_r));
    const yGR = samples.map(s => -2.5 * Math.log10(s.flux_g / s.flux_r));
    const ols = (xs: number[], ys: number[]) => {
        const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        const intercept = (sy - slope * sx) / n;
        return { slope, intercept };
    };
    const fBR = ols(x, yBR), fGR = ols(x, yGR);
    const cBR0 = fBR.intercept, cGR0 = fGR.intercept; // at x0=0
    return { gR: Math.pow(10, -cGR0 / 2.5), gB: Math.pow(10, (cBR0 - cGR0) / 2.5), slopeBR: fBR.slope };
}

describe('SPCC channel gains — TLS estimator (§3.2)', () => {
    it('recovers the injected gains via TLS where OLS attenuates (errors-in-variables)', () => {
        const samples = makeSamples(24, 0.12);
        const fit = fitChannelGains(samples, CFG);

        expect(fit.method).toBe('TLS');
        expect(fit.gate.passed).toBe(true);
        expect(fit.applied).toBe(true);
        // green is the anchor — exactly 1 by construction
        expect(fit.gains[1]).toBe(1);

        // TLS recovers the injected white-balance gains within tolerance.
        expect(fit.gains[0]).toBeGreaterThan(TRUE_GR * 0.9);
        expect(fit.gains[0]).toBeLessThan(TRUE_GR * 1.1);
        expect(fit.gains[2]).toBeGreaterThan(TRUE_GB * 0.9);
        expect(fit.gains[2]).toBeLessThan(TRUE_GB * 1.1);

        // OLS is the biased estimator: its gains are FARTHER from truth than TLS.
        const ols = olsGains(samples);
        const tlsErrR = Math.abs(fit.gains[0] - TRUE_GR);
        const olsErrR = Math.abs(ols.gR - TRUE_GR);
        const tlsErrB = Math.abs(fit.gains[2] - TRUE_GB);
        const olsErrB = Math.abs(ols.gB - TRUE_GB);
        expect(olsErrR).toBeGreaterThan(tlsErrR);
        expect(olsErrB).toBeGreaterThan(tlsErrB);
        // OLS attenuates the slope below the true 1.0 (the documented ~33% bias direction).
        expect(ols.slopeBR).toBeLessThan(fit.slope_br);
        expect(fit.slope_br).toBeGreaterThan(0.75);
    });

    it('records nStars / r² / uncertainty honestly', () => {
        const fit = fitChannelGains(makeSamples(24, 0.12), CFG);
        expect(fit.nStars).toBeGreaterThanOrEqual(8);
        expect(fit.r2).toBeGreaterThan(0.5);
        expect(fit.uncertainty[1]).toBe(0);              // green anchor ⇒ exact
        expect(fit.uncertainty[0]).toBeGreaterThan(0);
        expect(fit.uncertainty[2]).toBeGreaterThan(0);
    });

    it('is RECORD-ONLY when the apply flag is off (gate can still pass)', () => {
        const fit = fitChannelGains(makeSamples(24, 0.12), { ...CFG, applyEnabled: false });
        expect(fit.gate.passed).toBe(true);
        expect(fit.applied).toBe(false);                 // reversibility: flag kills application
        expect(fit.gains[1]).toBe(1);                    // gains still recorded
    });

    it('refuses below the minimum star count (honest-absent, identity gains)', () => {
        const fit = fitChannelGains(makeSamples(5, 0.12), CFG);
        expect(fit.gate.passed).toBe(false);
        expect(fit.applied).toBe(false);
        expect(fit.gains).toEqual([1, 1, 1]);
        expect(fit.gate.reason).toContain('n<8');
    });

    it('refuses on a low-r² (color-uncorrelated) set', () => {
        // Instrumental color independent of catalog color → r² ≈ 0.
        const samples: ChannelGainSample[] = [];
        for (let i = 0; i < 20; i++) {
            const catBpRp = 0.3 + i * 0.07;
            const yBR = 0.05 * Math.sin(i * 5.0);        // no dependence on catBpRp
            const yGR = 0.05 * Math.cos(i * 4.0);
            samples.push({ flux_r: 1, flux_b: Math.pow(10, -yBR / 2.5), flux_g: Math.pow(10, -yGR / 2.5), catBpRp });
        }
        const fit = fitChannelGains(samples, CFG);
        expect(fit.gate.passed).toBe(false);
        expect(fit.applied).toBe(false);
        expect(fit.gate.reason).toMatch(/r2|slope/);
    });

    it('refuses when the g−r slope breaches the shared bound the b−r slope is held to (HELD #22)', () => {
        // b−r tracks catalog color cleanly (slope 1.0, in-bounds) while g−r is
        // nearly FLAT (slope 0.1 < slopeMin 0.3) — a channel decoupled from
        // color. The g−r fit still sets gR/gB via cGR0, so it must be held to
        // the SAME slope bound (previously unguarded).
        const samples: ChannelGainSample[] = [];
        for (let i = 0; i < 24; i++) {
            const latent = 0.3 + i * (1.4 / 24);
            const yBR = A_BR + 1.0 * latent + noise(i, 2.3, 0.01);
            const yGR = A_GR + 0.1 * latent + noise(i, 3.1, 0.01);
            const catBpRp = latent + noise(i, 1.7, 0.01);
            samples.push({
                flux_r: 1,
                flux_b: Math.pow(10, -yBR / 2.5),
                flux_g: Math.pow(10, -yGR / 2.5),
                catBpRp,
            });
        }
        const fit = fitChannelGains(samples, CFG);
        expect(fit.slope_br).toBeGreaterThan(0.75);   // b−r itself is healthy
        expect(fit.slope_gr).toBeLessThan(CFG.slopeMin); // the breach
        expect(fit.gate.passed).toBe(false);
        expect(fit.applied).toBe(false);              // honest fallback: recorded, never applied
        expect(fit.gate.reason).toContain('slope_gr');
    });

    it('never throws and drops non-positive-flux samples', () => {
        const bad: ChannelGainSample[] = [
            { flux_r: 0, flux_g: 1, flux_b: 1, catBpRp: 0.5 },
            { flux_r: 1, flux_g: -1, flux_b: 1, catBpRp: 0.8 },
            { flux_r: 1, flux_g: 1, flux_b: 1, catBpRp: NaN },
        ];
        const fit = fitChannelGains(bad, CFG);
        expect(fit.gate.passed).toBe(false);
        expect(fit.gains[1]).toBe(1);
    });
});
