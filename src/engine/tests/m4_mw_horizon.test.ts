import { describe, it, expect } from 'vitest';
import { CelestialStructures } from '../pipeline/m4_signal_detect/CelestialStructures';
import type { Point } from '../types/Main_types';

/**
 * M4 item 4 — deferred Milky-Way trace (DETECT_MW_REAL_HORIZON).
 *
 * The trace/ellipse filters exclude MW points BELOW the horizon (ground
 * contamination). The flag defers the trace so it runs against the MEASURED
 * terrain silhouette instead of the height*0.8 placeholder. This locks the
 * rationale: the horizon input materially changes the trace, so tracing against
 * a real terrain vs a placeholder is not cosmetic. (The full deferral lives in
 * analyzeWithMasking, WASM-gated; here we prove the horizon-dependence directly.)
 */
const H = 1000;

// Uniform horizons: placeholder at 0.8H (legacy), terrain at 0.72H (measured).
const uniformHz = (y: number): Point[] => new Array(160).fill(0).map((_, i) => ({ x: i * (1000 / 160), y }));

describe('MW trace horizon-dependence (item 4 rationale)', () => {
    it('a lower measured terrain horizon excludes ground-band MW points the placeholder keeps', () => {
        const placeholderHz = uniformHz(H * 0.8);  // keeps p.y < 790
        const terrainHz = uniformHz(H * 0.72);      // keeps p.y < 710

        const pts: { x: number; y: number; brilliance: number }[] = [];
        for (let i = 0; i < 10; i++) {
            const x = 50 + i * 100;
            pts.push({ x, y: 300, brilliance: 1.0 });  // sky band — kept by both
            pts.push({ x, y: 750, brilliance: 2.0 });  // ground band — only placeholder keeps
        }

        const placeholderTrace = CelestialStructures.traceMilkyWayCenterline(pts, placeholderHz);
        const terrainTrace = CelestialStructures.traceMilkyWayCenterline(pts, terrainHz);

        expect(placeholderTrace.length).toBeGreaterThan(0);
        expect(terrainTrace.length).toBeGreaterThan(0);

        const meanY = (p: Point[]) => p.reduce((s, q) => s + q.y, 0) / p.length;
        // Placeholder pulls the centreline down into the ground band; the measured
        // terrain horizon keeps it up in the true sky — a material difference.
        expect(meanY(placeholderTrace)).toBeGreaterThan(meanY(terrainTrace) + 200);
        expect(meanY(terrainTrace)).toBeLessThan(400);
    });

    it('the ellipse generator is likewise horizon-gated (different point sets → different output)', () => {
        const placeholderHz = uniformHz(H * 0.8);
        const terrainHz = uniformHz(H * 0.72);
        const pts: { x: number; y: number; brilliance: number }[] = [];
        for (let i = 0; i < 20; i++) {
            pts.push({ x: 40 + i * 45, y: 250 + (i % 3) * 20, brilliance: 1.0 }); // sky
            pts.push({ x: 40 + i * 45, y: 760, brilliance: 1.5 });                 // ground band
        }
        const withPlaceholder = CelestialStructures.generateMilkyWayEllipses(pts, placeholderHz);
        const withTerrain = CelestialStructures.generateMilkyWayEllipses(pts, terrainHz);
        // Both produce ellipses, but from different filtered populations — the
        // centroids differ once the ground band is (not) admitted.
        expect(withPlaceholder.length).toBeGreaterThan(0);
        expect(withTerrain.length).toBeGreaterThan(0);
        const maxCy = (e: { y: number }[]) => Math.max(...e.map(q => q.y));
        expect(maxCy(withPlaceholder)).toBeGreaterThan(maxCy(withTerrain));
    });
});
