/**
 * M10 PSF FIELD — spatially-varying PSF characterization (Phase S · item 1).
 *
 * Pins the new engine module `psf_field.characterizePsfField`:
 *  1. REAL compiled wasm LM (`refine_stars_lm`, injected past the setup.ts
 *     mock via importActual+initSync — same bypass as wasm_core.test.ts)
 *     recovers a KNOWN round-Gaussian FWHM at the solved positions;
 *  2. it recovers a KNOWN elliptical PSF's ellipticity + orientation;
 *  3. the 3×3 region map is populated (the coma/astigmatism field);
 *  4. with NO compiled fitter (default mock env) it degrades HONESTLY to the
 *     moment measure and LABELS method MOMENT_FALLBACK — never a faked fit;
 *  5. honest absence (no stars / all-edge) → NOT_MEASURED, and a dims lie throws;
 *  6. PIXEL-ledger purity: the input luminance buffer is not mutated.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { characterizePsfField, type StampFitter } from '../pipeline/m10_psf/psf_field';

const FW = 2 * Math.sqrt(2 * Math.log(2)); // 2.3548

// ── synthetic field (deterministic) ────────────────────────────────────────
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Planted { x: number; y: number; amp: number; sx: number; sy: number; theta: number; }

/** Plant a rotated Gaussian using the EXACT Rust exponent convention
 * (photometry.rs: exp = a·dx² + b·dx·dy + c·dy²), so the fit must invert it. */
function plant(L: Float32Array, w: number, h: number, s: Planted): void {
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const a = (cos * cos) / (2 * s.sx * s.sx) + (sin * sin) / (2 * s.sy * s.sy);
    const b = -(sin * cos) / (s.sx * s.sx) + (sin * cos) / (s.sy * s.sy);
    const c = (sin * sin) / (2 * s.sx * s.sx) + (cos * cos) / (2 * s.sy * s.sy);
    const R = Math.ceil(5 * Math.max(s.sx, s.sy));
    for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            const x = Math.round(s.x) + dx, y = Math.round(s.y) + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const ex = a * dx * dx + b * dx * dy + c * dy * dy;
            if (ex > 12) continue;
            L[y * w + x] += s.amp * Math.exp(-ex);
        }
    }
}

function makeField(w: number, h: number, planted: Planted[], pedestal: number, noise: number, seed: number): Float32Array {
    const rng = mulberry32(seed);
    const L = new Float32Array(w * h);
    for (let i = 0; i < L.length; i++) L[i] = pedestal + noise * (rng() + rng() + rng() + rng() - 2) * 1.73;
    for (const s of planted) plant(L, w, h, s);
    return L;
}

/** A widely-spaced grid of identical stars (>=45px apart, >=30px margin). */
function grid(w: number, h: number, sx: number, sy: number, theta: number, seed = 5): { L: Float32Array; stars: Planted[] } {
    const rng = mulberry32(seed);
    const stars: Planted[] = [];
    for (let gy = 0; gy < 6; gy++) {
        for (let gx = 0; gx < 6; gx++) {
            stars.push({
                x: 35 + gx * 48 + Math.floor(rng() * 3),
                y: 35 + gy * 48 + Math.floor(rng() * 3),
                amp: 0.15 + rng() * 0.25, sx, sy, theta
            });
        }
    }
    return { L: makeField(w, h, stars, 0.1, 0.0008, seed), stars };
}

// ── REAL compiled wasm LM fitter (bypasses the setup.ts mock) ───────────────
let lmFit: StampFitter;
beforeAll(async () => {
    const wasm = await vi.importActual<any>('../wasm_compute/pkg/wasm_compute');
    const wasmUrl = new URL('../wasm_compute/pkg/wasm_compute_bg.wasm', import.meta.url);
    try { wasm.initSync({ module: readFileSync(fileURLToPath(wasmUrl)) }); } catch { /* already booted */ }
    lmFit = (px, sw, sh, params) => wasm.refine_stars_lm(px, sw, sh, params);
});

describe('psf_field: REAL wasm LM recovers a known PSF', () => {
    it('recovers a round-Gaussian FWHM at the solved positions', () => {
        const sigma = 1.9;                       // FWHM ≈ 4.474 px
        const w = 340, h = 340;
        const { L, stars } = grid(w, h, sigma, sigma, 0);
        const report = characterizePsfField({
            lum: L, width: w, height: h,
            stars: stars.map(s => ({ x: s.x, y: s.y })),
            fit: lmFit
        });

        expect(report.ledger).toBe('PIXEL');
        expect(report.method).toBe('WASM_LM_GAUSSIAN');
        expect(report.nFit).toBeGreaterThanOrEqual(30);
        expect(report.nLm).toBeGreaterThanOrEqual(Math.floor(report.nFit * 0.7));

        const expected = FW * sigma;
        expect(report.fwhmMedianMajPx).not.toBeNull();
        expect(report.fwhmMedianMajPx!).toBeGreaterThan(expected * 0.9);
        expect(report.fwhmMedianMajPx!).toBeLessThan(expected * 1.1);
        // round source ⇒ low ellipticity
        expect(report.ellipticityMedian!).toBeLessThan(0.15);
    });

    it('recovers a known ellipticity + orientation (astigmatism/coma proxy)', () => {
        const sx = 2.7, sy = 1.4, theta = (30 * Math.PI) / 180; // major axis PA = 30°
        const w = 340, h = 340;
        const { L, stars } = grid(w, h, sx, sy, theta, 11);
        const report = characterizePsfField({
            lum: L, width: w, height: h,
            stars: stars.map(s => ({ x: s.x, y: s.y })),
            fit: lmFit
        });

        expect(report.method).toBe('WASM_LM_GAUSSIAN');
        const expEll = 1 - sy / sx;              // ≈ 0.481
        expect(report.ellipticityMedian!).toBeGreaterThan(expEll - 0.12);
        expect(report.ellipticityMedian!).toBeLessThan(expEll + 0.12);
        // orientation folded to [0,180): recovered near 30°
        expect(Math.abs(report.orientationMedianDeg! - 30)).toBeLessThan(12);
    });

    it('populates the 3×3 region map (spatially-varying field)', () => {
        const { L, stars } = grid(340, 340, 1.9, 1.9, 0, 7);
        const report = characterizePsfField({
            lum: L, width: 340, height: 340,
            stars: stars.map(s => ({ x: s.x, y: s.y })), fit: lmFit
        });
        expect(report.regions).toHaveLength(9);
        const populated = report.regions.filter(r => r.n > 0 && r.fwhmMedianPx != null);
        expect(populated.length).toBeGreaterThanOrEqual(7); // corners + center measured
        for (const r of populated) {
            expect(r.fwhmMedianPx!).toBeGreaterThan(0);
            expect(r.orientationMedianDeg).not.toBeNull();
        }
        // background subtraction is disclosed, never silent
        expect(report.approximate.some(a => /background/i.test(a))).toBe(true);
    });
});

describe('psf_field: honest degradation (no GPU / no compiled fitter)', () => {
    it('falls back to moment measures and LABELS it when no fitter is present', () => {
        // No `fit` injected ⇒ the module resolves the DEFAULT fitter, which in
        // the vitest env is the mocked wasm (no refine_stars_lm) ⇒ MOMENT_FALLBACK.
        const sigma = 1.9;
        const { L, stars } = grid(340, 340, sigma, sigma, 0, 3);
        const report = characterizePsfField({
            lum: L, width: 340, height: 340,
            stars: stars.map(s => ({ x: s.x, y: s.y }))
        });
        expect(report.method).toBe('MOMENT_FALLBACK');
        expect(report.nLm).toBe(0);
        expect(report.nMoment).toBe(report.nFit);
        expect(report.nFit).toBeGreaterThanOrEqual(30);
        const expected = FW * sigma;
        expect(report.fwhmMedianMajPx!).toBeGreaterThan(expected * 0.85);
        expect(report.fwhmMedianMajPx!).toBeLessThan(expected * 1.15);
        expect(report.approximate.some(a => /MOMENT_FALLBACK/.test(a))).toBe(true);
    });

    it('an injected fitter that throws degrades to moments, labeled', () => {
        const { L, stars } = grid(300, 300, 1.9, 1.9, 0, 9);
        const boom: StampFitter = () => { throw new Error('no-op'); };
        const report = characterizePsfField({
            lum: L, width: 300, height: 300,
            stars: stars.map(s => ({ x: s.x, y: s.y })), fit: boom
        });
        expect(report.method).toBe('MOMENT_FALLBACK');
        expect(report.approximate.some(a => /threw/.test(a))).toBe(true);
        expect(report.nFit).toBeGreaterThan(0);
    });
});

describe('psf_field: honest absence + input safety', () => {
    it('no solved positions ⇒ NOT_MEASURED (never a fabricated field)', () => {
        const L = new Float32Array(100 * 100).fill(0.1);
        const report = characterizePsfField({ lum: L, width: 100, height: 100, stars: [] });
        expect(report.method).toBe('NOT_MEASURED');
        expect(report.notMeasured).toMatch(/No solved star positions/);
        expect(report.fwhmMedianMajPx).toBeNull();
        expect(report.nFit).toBe(0);
    });

    it('all-edge positions ⇒ NOT_MEASURED with the reason counted', () => {
        const L = new Float32Array(100 * 100).fill(0.1);
        const report = characterizePsfField({
            lum: L, width: 100, height: 100,
            stars: [{ x: 1, y: 1 }, { x: 99, y: 50 }, { x: 50, y: 2 }]
        });
        expect(report.method).toBe('NOT_MEASURED');
        expect(report.rejected.edge).toBe(3);
    });

    it('refuses a dims lie', () => {
        expect(() => characterizePsfField({ lum: new Float32Array(100), width: 20, height: 20, stars: [] }))
            .toThrow(/buffer length/);
    });

    it('does not mutate the input luminance buffer (PIXEL ledger read-only)', () => {
        const { L, stars } = grid(300, 300, 1.9, 1.9, 0, 21);
        const before = Float32Array.from(L);
        characterizePsfField({ lum: L, width: 300, height: 300, stars: stars.map(s => ({ x: s.x, y: s.y })), fit: lmFit });
        expect(L).toEqual(before);
    });
});
