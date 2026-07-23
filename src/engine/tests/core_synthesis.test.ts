import { describe, it, expect } from 'vitest';
import { AtmosphericManager } from '../core/AtmosphericManager';
import { AstrometryEngine } from '../pipeline/m7_astrometry/astrometry_engine';
import { StatisticsProvider } from '../core/StatisticsProvider';
import { OpticsManager } from '../core/optics_manager';
import { SourceExtractor } from '../pipeline/m4_signal_detect/source_extractor';

/**
 * CORE SYNTHESIS VERIFICATION SUITE
 */
describe('Core Synthesis', () => {

    it('should compute air mass correctly', () => {
        const airMass90 = AtmosphericManager.computeAirMass(90);
        const airMass30 = AtmosphericManager.computeAirMass(30);
        expect(Math.abs(airMass90 - 1.0)).toBeLessThan(0.001);
        expect(airMass30).toBeGreaterThan(1.9);
        expect(airMass30).toBeLessThan(2.1);
    });

    it('should compute Rayleigh extinction and zenith multipliers (λ^-4 magnitudes)', () => {
        // Sea-level zenith optical depths (Allen): τ_r=0.044, τ_g=0.098, τ_b=0.235.
        // Extinction Δm = τ·X. Blue scatters MOST (λ^-4) ⇒ ext.b > ext.g > ext.r.
        const ext = AtmosphericManager.rayleighExtinction(1.0);
        expect(ext.r).toBeCloseTo(0.044, 6);
        expect(ext.g).toBeCloseTo(0.098, 6);
        expect(ext.b).toBeCloseTo(0.235, 6);
        expect(ext.b).toBeGreaterThan(ext.g);
        expect(ext.g).toBeGreaterThan(ext.r); // physically-backwards impl (b<r) fails here

        // Flux-restoration multiplier = 10^(0.4·τ·X). At X=1.5 (hand-computed):
        //   r=1.062674, g=1.144986, b=1.383566. Blue needs the biggest boost.
        const mult = AtmosphericManager.getZenithMultipliers(1.5);
        expect(mult.r).toBeCloseTo(1.062674, 5);
        expect(mult.g).toBeCloseTo(1.144986, 5);
        expect(mult.b).toBeCloseTo(1.383566, 5);
        expect(mult.b).toBeGreaterThan(mult.r);
        expect(mult.r).toBeGreaterThan(1.0);
    });

    it('should produce a valid quad hash', () => {
        const p1 = { x: 0, y: 0 };
        const p2 = { x: 100, y: 0 };
        const p3 = { x: 0, y: 100 };
        const p4 = { x: 100, y: 100 };
        const quad = AstrometryEngine.buildQuad([p1, p2, p3, p4], [1, 2, 3, 4]);
        expect(quad).toBeDefined();
        expect(quad!.hashKey).toBe('10,-10,10,10');
    });

    it('should produce correct triangle descriptors for a right isosceles triangle', () => {
        const p1 = { x: 0, y: 0 };
        const p2 = { x: 100, y: 0 };
        const p3 = { x: 0, y: 100 };
        const tri = AstrometryEngine.getTriangleDescriptor(p1, p2, p3);
        expect(tri.r1).toBeCloseTo(0.707, 2);
        expect(tri.r2).toBeCloseTo(0.707, 2);
    });

    it('should sigma-clip outliers to a robust background level and noise', () => {
        // MAD-based iterative sigma-clip (the CPU path; the mock has no
        // estimate_background_wasm). Hand-traced convergence for this array:
        //   median = 11, MAD = 1 ⇒ σ = 1·1.4826 = 1.4826.
        // The 1000 spike is clipped out. A stub that returns {median, sigma:0} — or
        // one that omits the 1.4826 MAD scale — fails the σ assertion.
        const data = new Float32Array([10, 11, 12, 1000, 11, 12, 10, 9, 11, 12]);
        const bg = StatisticsProvider.estimateBackground(data, 10, 1);
        expect(bg.median).toBeCloseTo(11, 6);
        expect(bg.sigma).toBeCloseTo(1.4826, 3);
    });

    it('recovers a KNOWN k1 from a Brown-Conrady radial stretch', () => {
        // Build measured = ideal·(1 + k1·(ideal/r_ref)²) with k1_true = 0.02, r_ref=100.
        // A correct least-squares solve must recover k1≈0.02 (and k2,k3≈0). The old
        // test used 5 points (below the 6-point floor) so the solver returned the
        // identity {k1:0} and the `k1>=0` assertion passed against NO fit at all.
        const k1_true = 0.02, r_ref = 100;
        const ideal = [10, 20, 30, 40, 50, 60];
        const measured = ideal.map(r => r * (1 + k1_true * (r / r_ref) ** 2));
        const dist = OpticsManager.solveDistortionPolynomial(ideal, measured, r_ref);
        expect(dist.k1).toBeCloseTo(0.02, 3);
        expect(dist.k2).toBeCloseTo(0, 2);
        expect(dist.k3).toBeCloseTo(0, 2);
    });

    it('localizes a synthetic star to the injected blob (not a spurious source)', () => {
        // 3×3 blob centred on pixel (5,5) over a flat 0.1 background.
        const lum = new Float32Array(100).fill(0.1);
        lum[44] = 0.8; lum[45] = 0.9; lum[46] = 0.8;
        lum[54] = 0.9; lum[55] = 1.0; lum[56] = 0.9;
        lum[64] = 0.8; lum[65] = 0.9; lum[66] = 0.8;
        const result = SourceExtractor.detectSources(lum, 10, 10, 3.0);
        // At least one detection, and EVERY detection must sit on the blob footprint
        // (cols/rows 3..7) — a detector that invents a source anywhere else, or drifts
        // off the blob, fails. (Exact count is left loose: under Vitest the mock lacks
        // extract_blobs so the crude JS fallback runs and may split the blob; the
        // shipped Rust path is exercised separately. See finding in the PR notes.)
        expect(result.stars.length).toBeGreaterThan(0);
        for (const s of result.stars) {
            expect(s.x).toBeGreaterThanOrEqual(3);
            expect(s.x).toBeLessThanOrEqual(7);
            expect(s.y).toBeGreaterThanOrEqual(3);
            expect(s.y).toBeLessThanOrEqual(7);
        }
    });

    it('should normalize ImageData luminance correctly', () => {
        const imageData = {
            width: 2,
            height: 1,
            data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
        } as ImageData;
        const normalizedLum = SourceExtractor.imageDataToluminance(imageData);
        expect(normalizedLum[0]).toBeCloseTo(1.0, 2);
        expect(normalizedLum[1]).toBeCloseTo(0.0, 2);
    });
});
