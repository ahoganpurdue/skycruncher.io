import { describe, it, expect } from 'vitest';
import { OpticsManager, DistortionProfile } from '../core/optics_manager';

describe('OpticsManager', () => {
    const profile: DistortionProfile = {
        k1: -0.1,
        k2: 0.05,
        k3: 0,
        p1: 0,
        p2: 0,
        r_ref: 1000
    };

    it('should maintain center point (0,0) in distortion', () => {
        const p = OpticsManager.applyDistortion(500, 500, 1000, 1000, profile);
        expect(p.x).toBeCloseTo(500);
        expect(p.y).toBeCloseTo(500);
    });

    it('applies radial Brown-Conrady distortion to a hand-computed displacement', () => {
        // Point at (600,0) about center (0,0), r_ref=1000 ⇒ xn=0.6, yn=0, r²=0.36.
        //   radial = 1 + k1·r² + k2·r⁴ = 1 - 0.1(0.36) + 0.05(0.36²) = 0.97048
        //   x' = 0.6·0.97048·1000 = 582.288
        // Absolute value (not a self-referential ratio): a wrong k1 SIGN gives x'>600
        // (pincushion), which this fails.
        const p = OpticsManager.applyDistortion(600, 0, 0, 0, profile);
        expect(p.x).toBeCloseTo(582.288, 3);
        expect(p.y).toBeCloseTo(0, 6);
    });

    it('applies tangential (decentering) terms to a hand-computed displacement', () => {
        // Pure tangential profile p1=0.01, p2=0.02, r_ref=1000, point (600,300):
        //   xn=0.6, yn=0.3, r²=0.45
        //   dx_t = 2·p1·xn·yn + p2·(r²+2xn²) = 0.0036 + 0.02·1.17 = 0.0270
        //   dy_t = p1·(r²+2yn²) + 2·p2·xn·yn = 0.0063 + 0.0072 = 0.0135
        //   x' = (0.6+0.0270)·1000 = 627.0 , y' = (0.3+0.0135)·1000 = 313.5
        const tangential: DistortionProfile = { k1: 0, k2: 0, k3: 0, p1: 0.01, p2: 0.02, r_ref: 1000 };
        const p = OpticsManager.applyDistortion(600, 300, 0, 0, tangential);
        expect(p.x).toBeCloseTo(627.0, 3);
        expect(p.y).toBeCloseTo(313.5, 3);
    });

    it('round-trips distortion → undistortion (inverse-consistency, secondary)', () => {
        const x = 800, y = 800, width = 1000, height = 1000;
        const distorted = OpticsManager.applyDistortion(x, y, width, height, profile);
        const ideal = OpticsManager.removeDistortion(distorted.x, distorted.y, width, height, profile);
        expect(ideal.x).toBeCloseTo(x, 1);
        expect(ideal.y).toBeCloseTo(y, 1);
    });

    it('should calculate refraction correctly', () => {
        // At 45 degrees, refraction is approx 1 arcminute (60 arcseconds)
        const ref = OpticsManager.calculateAtmosphericRefraction(45);
        expect(ref).toBeGreaterThan(50);
        expect(ref).toBeLessThan(70);

        // Near horizon, refraction increases
        const refLow = OpticsManager.calculateAtmosphericRefraction(5);
        expect(refLow).toBeGreaterThan(ref);
    });

    it('should calculate FOV correctly', () => {
        // 50mm on 36mm sensor (full frame) is approx 40 degrees horizontal
        const fov = OpticsManager.getFov(50, 36);
        expect(fov).toBeCloseTo(39.6, 1);
    });
});

