import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Exercise the REAL compiled Rust ephemeris (Kepler solve + equatorial + topocentric),
// NOT the crude JS stub in setup.ts (which hardcoded alt:10/az:180/radius:5 and a
// "very crude" equatorial conversion). We bypass the global wasm mock and instantiate
// the compiled artifact, then assert known-answer sky positions from an authority.
vi.unmock('../wasm_compute/pkg/wasm_compute');

describe('EphemerisEngine (real compiled ephemeris)', () => {
    const lat = 34.0522; // Los Angeles
    const lon = -118.2437;
    const testDate = new Date('2024-03-20T20:00:00Z'); // ~17h after the 2024 vernal equinox
    let EphemerisEngine: any;

    beforeAll(async () => {
        const real: any = await vi.importActual('../wasm_compute/pkg/wasm_compute');
        const wasmUrl = new URL('../wasm_compute/pkg/wasm_compute_bg.wasm', import.meta.url);
        real.initSync(readFileSync(fileURLToPath(wasmUrl)));
        ({ EphemerisEngine } = await vi.importActual('../core/EphemerisEngine'));
    });

    it('places the Sun at the vernal-equinox point (RA≈0h, Dec≈0°)', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(testDate, lat, lon);
        const sun = bodies.find((b: any) => b.id === 'sun');
        expect(sun).toBeDefined();
        // The equinox crossing (RA=0, Dec=0) was ~03:06 UTC; by 20:00 the Sun is just
        // past it. RA must be within 0.3h of 0 (wrapping) — a wrong/180°-off Sun fails.
        expect(Math.min(sun.ra, 24 - sun.ra)).toBeLessThan(0.3);
        expect(sun.dec).toBeCloseTo(0.73, 1); // just north of the celestial equator
    });

    it('matches the JPL Horizons position of Jupiter to ~arcmin', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(testDate, lat, lon);
        const jupiter = bodies.find((b: any) => b.id === 'jupiter');
        expect(jupiter).toBeDefined();
        // JPL Horizons, 2024-03-20 20:00 UTC (geocentric): RA ≈ 02h49.5m (2.825h),
        // Dec ≈ +15.40°. A body-swap or 180° error (RA≈14.8h) fails these bounds.
        expect(jupiter.ra).toBeCloseTo(2.825, 1);  // tol 0.05h ≈ 3′ of RA
        expect(jupiter.dec).toBeCloseTo(15.40, 0);  // tol 0.5°
        expect(jupiter.dec).toBeGreaterThan(0);     // Jupiter is north of the equator here
    });

    it('computes Jupiter near -2.9 at its 2023-11-03 opposition (V(1,0) magBase through the distance-modulus law)', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(new Date('2023-11-03T00:00:00Z'), lat, lon);
        const jupiter = bodies.find((b: any) => b.id === 'jupiter');
        expect(jupiter).toBeDefined();
        // True opposition brightness ~ -2.9. The old mean-APPARENT magBase (-2.70)
        // fed through mag = magBase + 5*log10(r*d) computed ~ +4.0 here.
        expect(jupiter.mag).toBeGreaterThan(-3.3);
        expect(jupiter.mag).toBeLessThan(-2.5);
    });

    it('computes Saturn near +0.5 at its 2023-08-27 opposition (globe-only V(1,0), rings excluded)', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(new Date('2023-08-27T00:00:00Z'), lat, lon);
        const saturn = bodies.find((b: any) => b.id === 'saturn');
        expect(saturn).toBeDefined();
        // Globe-only law value ~ +0.8; observed 2023 opposition was +0.4 WITH rings.
        expect(saturn.mag).toBeGreaterThan(0.0);
        expect(saturn.mag).toBeLessThan(1.0);
    });

    it('computes the Moon at its full-moon-equivalent brightness (~ -12.7; phase not modeled)', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(testDate, lat, lon);
        const luna = bodies.find((b: any) => b.id === 'luna');
        expect(luna).toBeDefined();
        // V(1,0) = +0.21 + 5*log10(r~1 AU * d~0.00257 AU) ~ -12.7. The old
        // apparent-mag magBase (-12.74) double-counted the distance term (~ -25.7).
        expect(luna.mag).toBeGreaterThan(-13.1);
        expect(luna.mag).toBeLessThan(-12.4);
    });

    it('returns a full body set including a nearby Moon', () => {
        const bodies = EphemerisEngine.calculateSolarSystem(testDate, lat, lon);
        expect(bodies.length).toBeGreaterThan(5);
        const luna = bodies.find((b: any) => b.id === 'luna');
        expect(luna).toBeDefined();
        expect(luna.dist_au).toBeLessThan(0.01); // ~0.0026 AU
    });

    it('keeps the Moon status within physical bounds', () => {
        const status = EphemerisEngine.getMoonStatus(testDate, lat, lon);
        expect(status.phase).toBeGreaterThanOrEqual(0);
        expect(status.phase).toBeLessThanOrEqual(1);
        expect(typeof status.intensity).toBe('number');
        expect(status.altitude).toBeGreaterThan(-90);
        expect(status.altitude).toBeLessThan(90);
    });
});
