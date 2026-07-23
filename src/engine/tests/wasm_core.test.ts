/**
 * REAL COMPILED-RUST WCS CORE — known-answer coverage against the SHIPPED artifact.
 *
 * WHY THIS FILE EXISTS: `src/engine/tests/setup.ts` vi.mocks the wasm module with a
 * pure-JS reimplementation, so every OTHER test that touches `wasm.*` validates the
 * MOCK, never the compiled Rust the app actually ships. This file bypasses the mock
 * (`vi.importActual` + `initSync` on the real `.wasm` bytes) and asserts the core
 * astrometry functions against INDEPENDENTLY hand-derived known answers. It is the
 * only unit-level guard on the Rust `sky_transform.rs` core.
 *
 * The expected numbers below are derived from textbook TAN-projection / WCS formulas
 * (see scratch derivations in the PR notes), NOT read back from the artifact.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

// The real module — resolved past the global mock.
let wasm: any;

beforeAll(async () => {
    wasm = await vi.importActual<any>('../wasm_compute/pkg/wasm_compute');
    const wasmUrl = new URL('../wasm_compute/pkg/wasm_compute_bg.wasm', import.meta.url);
    wasm.initSync(readFileSync(fileURLToPath(wasmUrl)));
});

describe('REAL wasm: calculate_cd_matrix (Rust WCS convention)', () => {
    // Rust convention (sky_transform.rs:127-142):
    //   CD1_1 = +s·cos(rot)      CD1_2 = -s·sin(rot)
    //   CD2_1 = -s·sin(rot)·parity  CD2_2 = -s·cos(rot)·parity
    // where s = (scale_arcsec/3600)·DEG2RAD  (radians/pixel).
    // NOTE: the JS mock historically encoded the NEGATED convention
    // ([-p·s·cos, +p·s·sin, s·sin, s·cos]) — this test pins the real one so a
    // wrong (mock-style) matrix can never read as green through the artifact.
    const s = (3.6 / 3600) * D2R; // 1.7453292519943295e-5 rad/px

    it('rotation 0, parity +1 → diag(+s, -s) (NOT the mock diag(-s, +s))', () => {
        const cd = Array.from(wasm.calculate_cd_matrix(3.6, 0, 1)) as number[];
        expect(cd[0]).toBeCloseTo(+s, 12);   // CD1_1 positive
        expect(cd[1]).toBeCloseTo(0, 12);
        expect(cd[2]).toBeCloseTo(0, 12);
        expect(cd[3]).toBeCloseTo(-s, 12);   // CD2_2 negative (the mock had it positive)
        // Sign convention is the discriminator: mock ⇒ cd[0]<0, cd[3]>0.
        expect(cd[0]).toBeGreaterThan(0);
        expect(cd[3]).toBeLessThan(0);
    });

    it('rotation 30°, parity +1 → hand-derived rotated matrix', () => {
        const cd = Array.from(wasm.calculate_cd_matrix(3.6, 30, 1)) as number[];
        const c = Math.cos(30 * D2R), sn = Math.sin(30 * D2R);
        expect(cd[0]).toBeCloseTo(+s * c, 12);   //  1.5114994701951816e-5
        expect(cd[1]).toBeCloseTo(-s * sn, 12);  // -8.726646259971647e-6
        expect(cd[2]).toBeCloseTo(-s * sn, 12);
        expect(cd[3]).toBeCloseTo(-s * c, 12);
    });

    it('parity -1 flips the sign of the second row', () => {
        const cd = Array.from(wasm.calculate_cd_matrix(3.6, 0, -1)) as number[];
        expect(cd[0]).toBeCloseTo(+s, 12);
        expect(cd[3]).toBeCloseTo(+s, 12); // -s·cos·(-1) = +s
    });
});

describe('REAL wasm: pixel_scale_from_cd (mean column norm, NOT sqrt|det|)', () => {
    it('recovers 7.219268"/px for an unequal-scale diagonal CD', () => {
        // CD = [3e-5, 0, 0, 4e-5] rad/px. Column norms 3e-5 and 4e-5 → mean 3.5e-5.
        //   Rust:  (3.5e-5)·RAD2DEG·3600 = 7.219268"  ← asserted here
        //   Mock:  sqrt(|det|)=sqrt(1.2e-9)=3.4641e-5 → 7.1452"  (would FAIL this)
        const scale = wasm.pixel_scale_from_cd(3e-5, 0, 0, 4e-5);
        expect(scale).toBeCloseTo(7.219268, 5);
        // Explicitly reject the sqrt|det| answer so a convention regression bites.
        const sqrtDet = Math.sqrt(Math.abs(3e-5 * 4e-5)) * R2D * 3600; // 7.1452
        expect(Math.abs(scale - sqrtDet)).toBeGreaterThan(0.05);
    });

    it('round-trips the scale used to build a rotated CD', () => {
        const cd = wasm.calculate_cd_matrix(3.6, 30, 1);
        expect(wasm.pixel_scale_from_cd(cd[0], cd[1], cd[2], cd[3])).toBeCloseTo(3.6, 9);
    });
});

describe('REAL wasm: gnomonic_project (TAN) absolute known answer', () => {
    it('projects a star 1°E / 0.5°N of the tangent point to hand-derived ξ,η', () => {
        // Tangent (ra0,dec0)=(10°,20°); star (11°,20.5°). Textbook TAN gives
        //   ξ = 0.0163500 rad, η = 0.0087768 rad  (independent scratch derivation).
        const [xi, eta] = Array.from(wasm.gnomonic_project(11 * D2R, 20.5 * D2R, 10 * D2R, 20 * D2R)) as number[];
        expect(xi).toBeCloseTo(0.0163500, 6);
        expect(eta).toBeCloseTo(0.0087768, 6);
        // Axes are not swapped: E offset dominates ξ, N offset dominates η.
        expect(xi).toBeGreaterThan(eta);
    });

    it('tangent point projects to the origin', () => {
        const [xi, eta] = Array.from(wasm.gnomonic_project(10 * D2R, 20 * D2R, 10 * D2R, 20 * D2R)) as number[];
        expect(xi).toBeCloseTo(0, 12);
        expect(eta).toBeCloseTo(0, 12);
    });

    it('inverse_gnomonic round-trips the projected coordinate back to the sky', () => {
        const raIn = 11 * D2R, decIn = 20.5 * D2R, ra0 = 10 * D2R, dec0 = 20 * D2R;
        const [xi, eta] = Array.from(wasm.gnomonic_project(raIn, decIn, ra0, dec0)) as number[];
        const [ra, dec] = Array.from(wasm.inverse_gnomonic(xi, eta, ra0, dec0)) as number[];
        expect(ra).toBeCloseTo(raIn, 10);
        expect(dec).toBeCloseTo(decIn, 10);
    });
});

describe('REAL wasm: calculate_angular_separation', () => {
    it('haversine of a 0.1°/0.1° step ≈ 0.1·√2 degrees', () => {
        const sepDeg = wasm.calculate_angular_separation(0, 0, 0.1 * D2R, 0.1 * D2R) * R2D;
        expect(sepDeg).toBeCloseTo(0.1 * Math.SQRT2, 5); // 0.14142136°
    });

    it('matches the SkyTransform 0.1966° case at full precision', () => {
        const sepDeg = wasm.calculate_angular_separation(
            (13.39875 / 24) * 2 * Math.PI, 54.92527 * D2R,
            (13.42042 / 24) * 2 * Math.PI, 54.98805 * D2R
        ) * R2D;
        expect(sepDeg).toBeCloseTo(0.1966, 3);
    });
});
