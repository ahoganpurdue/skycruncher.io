// M10 PSF — NEBULOSITY LAYER row-545 REMEDIATION tests.
//   item 1 — per-rig knob surface (nebulosityKnobsForRig): derivations tied to
//            PSF FWHM + frame scale, clamped, no NaN, monotone.
//   item 2 — EXTERNAL star mask: detected-star footprints excluded from the
//            nebulosity estimation; byte-identical OFF state; additive-complete ON;
//            star layer untouched by the external mask.
import { describe, it, expect } from 'vitest';
import {
    decomposeNebulosityLayers,
    reconstructLayers,
    nebulosityKnobsForRig,
    RIG_KNOB_PRESETS,
} from '../pipeline/m10_psf/nebulosity_layer';

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng: () => number): number { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** FNV-1a over the raw bytes of a Float32Array (byte-identity proof). */
function hashF32(a: Float32Array): string {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
}

const W = 96, CX = 48, CY = 48;
// A broad diffuse glow + a compact star on its peak + faint noise.
function makeField(seed = 5): Float32Array {
    const rng = mulberry32(seed);
    const obs = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const r2 = (x - CX) ** 2 + (y - CY) ** 2;
        obs[y * W + x] = 0.05 + 0.4 * Math.exp(-r2 / (2 * 20 * 20)) + 0.9 * Math.exp(-r2 / (2 * 1.3 * 1.3)) + 0.004 * gauss(rng);
    }
    return obs;
}

// ── item 1: per-rig knob surface ─────────────────────────────────────────────
describe('m10 nebulosity — nebulosityKnobsForRig (per-rig, item 1)', () => {
    it('derives clamped, self-consistent knobs from FWHM + frame scale', () => {
        const k = nebulosityKnobsForRig({ fwhmPx: 2.6, longSidePx: 3840 });
        expect(k.scales!).toBeGreaterThanOrEqual(5);
        expect(k.scales!).toBeLessThanOrEqual(8);
        expect(k.jLo!).toBeGreaterThanOrEqual(3);
        expect(k.jLo!).toBeLessThanOrEqual(k.scales! - 1);           // neb band ≥ 1 scale
        // starDilatePx covers the coarsest star-band à-trous ring radius 2^(jLo-1)
        expect(k.starDilatePx!).toBeGreaterThanOrEqual(Math.pow(2, k.jLo! - 1));
        expect(k.starDilatePx!).toBeGreaterThanOrEqual(3);            // never below the shipped floor
        expect(k.aMaxPx!).toBeGreaterThanOrEqual(300);               // never tighter than the default
        expect(k.minNebAreaPx!).toBeGreaterThanOrEqual(64);
        expect(k.starHaloDilatePx!).toBe(k.starDilatePx!);
        for (const v of [k.scales, k.jLo, k.starDilatePx, k.aMaxPx, k.minNebAreaPx, k.starHaloDilatePx]) {
            expect(Number.isFinite(v!)).toBe(true);
        }
    });

    it('J is monotone non-decreasing in frame long-side (larger FOV → more detail scales)', () => {
        const small = nebulosityKnobsForRig({ fwhmPx: 2.6, longSidePx: 2048 }).scales!;
        const large = nebulosityKnobsForRig({ fwhmPx: 2.6, longSidePx: 16384 }).scales!;
        expect(large).toBeGreaterThanOrEqual(small);
        expect(large).toBe(8);       // wide frame saturates the [5,8] clamp
    });

    it('jLo and aMaxPx are monotone non-decreasing in FWHM (bigger stars → wider star band + cap)', () => {
        const tight = nebulosityKnobsForRig({ fwhmPx: 2.0, longSidePx: 5000 });
        const fat = nebulosityKnobsForRig({ fwhmPx: 6.0, longSidePx: 5000 });
        expect(fat.jLo!).toBeGreaterThanOrEqual(tight.jLo!);
        expect(fat.aMaxPx!).toBeGreaterThanOrEqual(tight.aMaxPx!);
    });

    it('degenerate inputs fall back safely (no NaN, still valid opts)', () => {
        for (const p of [{ fwhmPx: 0, longSidePx: 0 }, { fwhmPx: NaN, longSidePx: NaN }, { fwhmPx: -3, longSidePx: -1 }]) {
            const k = nebulosityKnobsForRig(p as any);
            expect(Number.isFinite(k.scales!)).toBe(true);
            expect(k.jLo!).toBeGreaterThanOrEqual(3);
            expect(k.jLo!).toBeLessThanOrEqual(k.scales! - 1);
        }
    });

    it('derived knobs are valid opts: the decomposition still reconstructs additively', () => {
        const obs = makeField();
        const k = nebulosityKnobsForRig({ fwhmPx: 2.3, longSidePx: W });
        const d = decomposeNebulosityLayers(obs, W, W, k);
        const rec = reconstructLayers(d);
        let maxAbs = 0, lo = Infinity, hi = -Infinity;
        for (let i = 0; i < obs.length; i++) { const e = Math.abs(rec[i] - obs[i]); if (e > maxAbs) maxAbs = e; if (obs[i] < lo) lo = obs[i]; if (obs[i] > hi) hi = obs[i]; }
        expect(maxAbs / (hi - lo)).toBeLessThan(1e-4);
        expect(d.scales).toBe(k.scales);
        expect(d.jLo).toBe(k.jLo);
    });

    it('RIG_KNOB_PRESETS: default is null (shipped off state); named presets are physical', () => {
        expect(RIG_KNOB_PRESETS.default).toBeNull();
        for (const name of ['seestar_dso', 'dslr_widefield'] as const) {
            const p = RIG_KNOB_PRESETS[name]!;
            expect(p.fwhmPx).toBeGreaterThan(0);
            expect(p.longSidePx).toBeGreaterThan(0);
            // preset resolves to valid knobs
            const k = nebulosityKnobsForRig(p);
            expect(k.jLo!).toBeLessThanOrEqual(k.scales! - 1);
        }
    });
});

// ── item 2: external star mask ───────────────────────────────────────────────
describe('m10 nebulosity — external star mask (item 2)', () => {
    it('OFF state is byte-identical: no detections / empty detections / all-zero mask == default', () => {
        const obs = makeField();
        const base = hashF32(reconstructLayers(decomposeNebulosityLayers(obs, W, W)));
        const empty = hashF32(reconstructLayers(decomposeNebulosityLayers(obs, W, W, { starDetections: [] })));
        const zeros = hashF32(reconstructLayers(decomposeNebulosityLayers(obs, W, W, { starMaskExternal: new Uint8Array(W * W) })));
        expect(empty).toBe(base);
        expect(zeros).toBe(base);
        // and the star layer itself is byte-identical (the external mask only guards nebulosity)
        const s0 = hashF32(decomposeNebulosityLayers(obs, W, W).star.data!);
        const s1 = hashF32(decomposeNebulosityLayers(obs, W, W, { starDetections: [{ x: CX, y: CY, radiusPx: 8 }] }).star.data!);
        expect(s1).toBe(s0);
    });

    it('an all-covering external mask drives nebulosity honest-absent AND stays additive-complete', () => {
        const obs = makeField();
        const all = new Uint8Array(W * W).fill(1);
        const d = decomposeNebulosityLayers(obs, W, W, { starMaskExternal: all });
        expect(d.nebulosity.data).toBeNull();          // nothing survives the exclusion → honest absent
        expect(d.nebulosity.support_frac).toBe(0);
        const rec = reconstructLayers(d);              // coefficients fell through to residual, not lost
        let maxAbs = 0, lo = Infinity, hi = -Infinity;
        for (let i = 0; i < obs.length; i++) { const e = Math.abs(rec[i] - obs[i]); if (e > maxAbs) maxAbs = e; if (obs[i] < lo) lo = obs[i]; if (obs[i] > hi) hi = obs[i]; }
        expect(maxAbs / (hi - lo)).toBeLessThan(1e-4);
    });

    it('a detected-star disc removes nebulosity support inside its footprint', () => {
        const obs = makeField();
        const rDet = 18;
        const d0 = decomposeNebulosityLayers(obs, W, W);
        const dM = decomposeNebulosityLayers(obs, W, W, { starDetections: [{ x: CX, y: CY, radiusPx: rDet }], starHaloDilatePx: 2 });
        const inDisc = (i: number) => { const x = i % W, y = (i - x) / W; return (x - CX) ** 2 + (y - CY) ** 2 <= rDet * rDet; };
        let base = 0, masked = 0;
        const m0 = d0.nebulosity.support_mask, mM = dM.nebulosity.support_mask;
        for (let i = 0; i < W * W; i++) { if (inDisc(i)) { if (m0[i]) base++; if (mM[i]) masked++; } }
        expect(masked).toBe(0);                        // the star footprint is fully excluded from nebulosity
        expect(dM.nebulosity.support_frac).toBeLessThanOrEqual(d0.nebulosity.support_frac);
    });

    it('starMaskExternal.length shorter than the frame is tolerated (partial coverage, no crash)', () => {
        const obs = makeField();
        const short = new Uint8Array(10).fill(1);       // covers only the first 10 pixels
        const d = decomposeNebulosityLayers(obs, W, W, { starMaskExternal: short });
        const rec = reconstructLayers(d);
        let maxAbs = 0; for (let i = 0; i < obs.length; i++) maxAbs = Math.max(maxAbs, Math.abs(rec[i] - obs[i]));
        expect(maxAbs).toBeLessThan(1e-3);
    });
});
