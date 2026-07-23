import { describe, it, expect } from 'vitest';
import { SkyTransform, DistortionModel } from '../core/SkyTransform';

// NOTE: under Vitest, SkyTransform's wasm.* calls hit the JS mock in setup.ts (the mock
// formulas now match the compiled Rust — reconciled 2026-07). The *shipped* Rust core is
// asserted directly against known answers in wasm_core.test.ts. Here we pin the geometry
// with ABSOLUTE hand-derived values (not round-trip tautologies / self-referential ratios).
describe('SkyTransform', () => {
    it('should calculate angular separation correctly', () => {
        const sep = SkyTransform.calculateAngularSeparation(13.39875, 54.92527, 13.42042, 54.98805);
        expect(sep).toBeCloseTo(0.1966, 3);
    });

    it('should project the tangent point itself to (0,0)', () => {
        const proj = SkyTransform.gnomonicProject(10, 45, 10, 45);
        expect(proj.xi).toBeCloseTo(0, 6);
        expect(proj.eta).toBeCloseTo(0, 6);
    });

    it('projects a star 1°E / 0.5°N to an ABSOLUTE hand-derived ξ,η (degrees)', () => {
        // Tangent (10h=150°, 20°). Star +1° in RA (=+1/15 h) and +0.5° in Dec.
        // Textbook TAN projection ⇒ ξ = 0.9367859°, η = 0.5028758° (scratch-derived,
        // independent of this code). Replaces the old project→inverse round-trip,
        // which a shared forward/inverse sign error would pass.
        const proj = SkyTransform.gnomonicProject(10 + 1 / 15, 20.5, 10, 20);
        expect(proj.xi).toBeCloseTo(0.9367859, 4);
        expect(proj.eta).toBeCloseTo(0.5028758, 4);
        // Orientation: East offset → +ξ, North offset → +η (catches an axis/sign flip).
        expect(proj.xi).toBeGreaterThan(0);
        expect(proj.eta).toBeGreaterThan(0);
    });

    it('still round-trips project → inverse (self-consistency, secondary check)', () => {
        const proj = SkyTransform.gnomonicProject(10.5, 45.5, 10, 45);
        const inv = SkyTransform.inverseGnomonic(proj.xi, proj.eta, 10, 45);
        expect(inv.ra_hours).toBeCloseTo(10.5, 6);
        expect(inv.dec_degrees).toBeCloseTo(45.5, 6);
    });

    it('applies radial distortion to an ABSOLUTE hand-computed coordinate (ξ AND η)', () => {
        // Barrel distortion k1=-0.1 about r_ref=2°. Ideal projected point is the
        // ξ,η above (0.9367859°, 0.5028758°). With xn=ξ/2, yn=η/2, r²=xn²+yn²,
        // radial=1+k1·r², the distorted point is (0.910311°, 0.488664°) — computed
        // by hand, NOT by re-running the implementation's own factor. This catches a
        // wrong k1 sign, wrong r_ref semantics, and a broken η (tangential) path.
        const distortion: DistortionModel = { k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0, r_ref: 2 };
        const distorted = SkyTransform.gnomonicProject(10 + 1 / 15, 20.5, 10, 20, distortion);
        expect(distorted.xi).toBeCloseTo(0.910311, 5);
        expect(distorted.eta).toBeCloseTo(0.488664, 5);
        // k1<0 shrinks radius: both components must be smaller than the ideal.
        expect(distorted.xi).toBeLessThan(0.9367859);
        expect(distorted.eta).toBeLessThan(0.5028758);
    });

    // ─── fitWCS: the 6-DOF affine solver at the heart of plate solving ───
    const RA0 = 5.5;          // hours
    const DEC0 = 22.0;        // degrees
    const CD11 = -0.0002, CD12 = 0.00001, CD21 = 0.000012, CD22 = 0.0002; // deg/px
    const PIXELS = [
        { x: 100, y: 120 }, { x: 400, y: 150 }, { x: 250, y: 380 },
        { x: 480, y: 300 }, { x: 60, y: 420 },
    ];

    it('fitWCS recovers the CD matrix and crpix exactly (noise-free affine)', () => {
        const crpix: [number, number] = [256, 256];
        const sky = PIXELS.map(p => {
            const dx = p.x - crpix[0], dy = p.y - crpix[1];
            return { xi: CD11 * dx + CD12 * dy, eta: CD21 * dx + CD22 * dy };
        });

        const wcs = SkyTransform.fitWCS(PIXELS, sky, crpix, RA0, DEC0);
        expect(wcs).not.toBeNull();
        expect(wcs!.cd[0][0]).toBeCloseTo(CD11, 9);
        expect(wcs!.cd[0][1]).toBeCloseTo(CD12, 9);
        expect(wcs!.cd[1][0]).toBeCloseTo(CD21, 9);
        expect(wcs!.cd[1][1]).toBeCloseTo(CD22, 9);
        expect(wcs!.crpix[0]).toBeCloseTo(256, 6);
        expect(wcs!.crpix[1]).toBeCloseTo(256, 6);
        expect(wcs!.crval[0]).toBe(RA0);
        expect(wcs!.crval[1]).toBe(DEC0);
    });

    it('fitWCS absorbs a tangent-point offset without skewing CD (the cd21/translation bug case)', () => {
        // The tangent point (RA0/DEC0) actually lands at trueCrpix, but we hand the
        // solver a different crpix guess. The centroid-fit contract keeps crpix at the
        // guess and shifts crval instead (see fitWCS comment) — so assert the
        // convention-independent truths: CD is NOT skewed, and the returned WCS maps
        // trueCrpix back to RA0/DEC0.
        const guessCrpix: [number, number] = [256, 256];
        const trueCrpix: [number, number] = [300, 280];
        const sky = PIXELS.map(p => {
            const dx = p.x - trueCrpix[0], dy = p.y - trueCrpix[1];
            return { xi: CD11 * dx + CD12 * dy, eta: CD21 * dx + CD22 * dy };
        });

        const wcs = SkyTransform.fitWCS(PIXELS, sky, guessCrpix, RA0, DEC0);
        expect(wcs).not.toBeNull();
        // CD recovered despite the offset (the old bug skewed it here)
        expect(wcs!.cd[0][0]).toBeCloseTo(CD11, 9);
        expect(wcs!.cd[1][1]).toBeCloseTo(CD22, 9);
        // The fitted transform puts RA0/DEC0 where it truly lands. Tolerance is
        // 1e-5 deg (36 mas — ~100x finer than a SeeStar pixel): the synthetic sky
        // here is a pure affine, so the real gnomonic de-projection in the fold-back
        // legitimately differs by second-order tangent-plane curvature (~5e-7 deg).
        const back = SkyTransform.pixelToSky(trueCrpix[0], trueCrpix[1], wcs!);
        expect(back.ra_hours).toBeCloseTo(RA0, 5);
        expect(back.dec_degrees).toBeCloseTo(DEC0, 5);
    });

    it('fitWCS + pixelToSky round-trips real sky coordinates', () => {
        const crpix: [number, number] = [256, 256];
        const stars = [
            { ra: 5.500, dec: 22.000 }, { ra: 5.502, dec: 22.020 },
            { ra: 5.498, dec: 21.980 }, { ra: 5.503, dec: 21.990 },
            { ra: 5.497, dec: 22.015 },
        ];
        const invDet = 1 / (CD11 * CD22 - CD12 * CD21);

        // Project each star to {xi,eta} (deg), then place it at a pixel via CD^-1.
        const sky = stars.map(s => SkyTransform.gnomonicProject(s.ra, s.dec, RA0, DEC0));
        const pixels = sky.map(({ xi, eta }) => ({
            x: crpix[0] + invDet * (CD22 * xi - CD12 * eta),
            y: crpix[1] + invDet * (-CD21 * xi + CD11 * eta),
        }));

        const wcs = SkyTransform.fitWCS(pixels, sky, crpix, RA0, DEC0);
        expect(wcs).not.toBeNull();
        stars.forEach((s, i) => {
            const recovered = SkyTransform.pixelToSky(pixels[i].x, pixels[i].y, wcs!);
            expect(recovered.ra_hours).toBeCloseTo(s.ra, 4);
            expect(recovered.dec_degrees).toBeCloseTo(s.dec, 4);
        });
    });
});
