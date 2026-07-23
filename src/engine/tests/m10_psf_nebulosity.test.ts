/**
 * M10 PSF — NEBULOSITY-PRESERVATION proof (owner rule: Hα/OIII/dust ARE
 * signal; deconvolution must never flatten or ring real astronomical color).
 *
 * The "preservation test image" is a deterministic synthetic frame: a broad
 * diffuse glow (nebulosity) with a compact star sitting on its peak. We run
 * BOTH the plain damped RL and the nebulosity-PROTECTED RL and assert:
 *   1. the protected pass still SHARPENS the star (FWHM drops);
 *   2. the extended nebulosity is PRESERVED — far-field diffuse mean unchanged
 *      within ~2%, and NO dark ring is carved below the true diffuse floor
 *      near the star (the classic RL over-shoot that eats nebulosity);
 *   3. protection is a strict improvement over plain RL on the diffuse floor.
 */
import { describe, it, expect } from 'vitest';
import { measureStar, pixelNoiseSigma } from '../pipeline/m10_psf/psf_core';
import {
    richardsonLucyWindow, richardsonLucyWindowProtected, boxBlur, convolve2d
} from '../pipeline/m10_psf/rl_deconv';

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const W = 121, CX = 60, CY = 60;
const NEB_SIGMA = 26, NEB_AMP = 0.42, PED = 0.05; // broad diffuse glow
const STAR_SIGMA = 2.0, STAR_AMP = 0.9;            // compact source on the peak

/** The NOISELESS diffuse-only floor (nebulosity + pedestal, no star). */
function nebulosityFloor(): Float32Array {
    const f = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const r2 = (x - CX) ** 2 + (y - CY) ** 2;
        f[y * W + x] = PED + NEB_AMP * Math.exp(-r2 / (2 * NEB_SIGMA * NEB_SIGMA));
    }
    return f;
}

/** obs = floor + compact star + faint noise. */
function makeField(seed = 5): { obs: Float32Array; floor: Float32Array } {
    const rng = mulberry32(seed);
    const floor = nebulosityFloor();
    const obs = Float32Array.from(floor);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const r2 = (x - CX) ** 2 + (y - CY) ** 2;
        obs[y * W + x] += STAR_AMP * Math.exp(-r2 / (2 * STAR_SIGMA * STAR_SIGMA));
        obs[y * W + x] += 0.0006 * (rng() + rng() + rng() + rng() - 2) * 1.73;
    }
    return { obs, floor };
}

/** The true PSF as a normalized discrete Gaussian kernel. */
function trueKernel(sigma = STAR_SIGMA, ks = 13) {
    const kR = (ks - 1) / 2;
    const K = new Float64Array(ks * ks);
    let s = 0;
    for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) {
        const v = Math.exp(-(((i - kR) ** 2 + (j - kR) ** 2)) / (2 * sigma * sigma));
        K[j * ks + i] = v; s += v;
    }
    for (let i = 0; i < K.length; i++) K[i] /= s;
    return { k: K, size: ks };
}

/** mean of (est − floor) over an annulus rLo..rHi around the star. */
function annulusStats(est: Float32Array, floor: Float32Array, rLo: number, rHi: number) {
    let sum = 0, n = 0, minDev = Infinity, sumFloor = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const r = Math.hypot(x - CX, y - CY);
        if (r < rLo || r > rHi) continue;
        const dev = est[y * W + x] - floor[y * W + x];
        sum += dev; sumFloor += floor[y * W + x]; n++;
        if (dev < minDev) minDev = dev;
    }
    return { meanDev: sum / n, minDev, meanFloor: sumFloor / n, n };
}

describe('m10 nebulosity protection', () => {
    it('boxBlur preserves a flat field and the mean of a smooth field', () => {
        const flat = new Float32Array(W * W).fill(0.3);
        const b = boxBlur(flat, W, W, 10);
        for (let i = 0; i < b.length; i += 777) expect(b[i]).toBeCloseTo(0.3, 6);
        // mean of a smooth blurred field is conserved
        const { floor } = makeField();
        const bf = boxBlur(floor, W, W, 6);
        const m1 = floor.reduce((s, v) => s + v, 0) / floor.length;
        const m2 = bf.reduce((s, v) => s + v, 0) / bf.length;
        expect(Math.abs(m1 - m2) / m1).toBeLessThan(0.02);
    });

    it('protected RL sharpens the star AND preserves the nebulosity floor', async () => {
        const { obs, floor } = makeField();
        const kernel = trueKernel();
        const before = measureStar(obs, W, W, CX, CY, pixelNoiseSigma(obs), 7)!;

        const prot = await richardsonLucyWindowProtected({
            obs, w: W, h: W, kernel, iters: 12, sigmaDamp: pixelNoiseSigma(obs)
        });
        const after = measureStar(prot.estimate, W, W, CX, CY, pixelNoiseSigma(prot.estimate), 7)!;

        // 1. the star tightened
        expect(after.fwhmMaj).toBeLessThan(before.fwhmMaj);

        // 2a. nebulosity preserved in a border-safe, star-free annulus
        // (box-blur clamp biases the diffuse estimate within ~diffuseRadius of
        // the window edge — the same border caveat psf_stage already labels).
        const far = annulusStats(prot.estimate, floor, 22, 32);
        expect(Math.abs(far.meanDev) / far.meanFloor).toBeLessThan(0.02);

        // 2b. no DARK RING carved below the true diffuse floor near the star
        const near = annulusStats(prot.estimate, floor, 9, 16);
        expect(near.minDev).toBeGreaterThan(-0.05 * near.meanFloor);
    });

    it('protection strictly beats plain RL on the diffuse floor (near the star)', async () => {
        const { obs, floor } = makeField();
        const kernel = trueKernel();
        const sig = pixelNoiseSigma(obs);

        const plain = await richardsonLucyWindow({ obs, w: W, h: W, kernel, iters: 12, sigmaDamp: sig });
        const prot = await richardsonLucyWindowProtected({ obs, w: W, h: W, kernel, iters: 12, sigmaDamp: sig });

        const nearPlain = annulusStats(plain.estimate, floor, 9, 16);
        const nearProt = annulusStats(prot.estimate, floor, 9, 16);

        // protected keeps the diffuse floor closer to truth than plain RL does,
        // and does not dig a deeper dark ring than plain.
        expect(Math.abs(nearProt.meanDev)).toBeLessThanOrEqual(Math.abs(nearPlain.meanDev) + 1e-6);
        expect(nearProt.minDev).toBeGreaterThanOrEqual(nearPlain.minDev - 1e-6);
    });

    it('the recovered diffuse component matches a direct box blur of the input', async () => {
        const { obs } = makeField();
        const kernel = trueKernel();
        const prot = await richardsonLucyWindowProtected({ obs, w: W, h: W, kernel, iters: 8, sigmaDamp: pixelNoiseSigma(obs) });
        const direct = boxBlur(obs, W, W, prot.diffuseRadius);
        // the preserved diffuse IS the box blur — no hidden reshaping
        for (let i = 0; i < obs.length; i += 997) expect(prot.diffuse[i]).toBeCloseTo(direct[i], 6);
        // sanity: convolve2d exists as the RL engine's kernel op (import guard)
        expect(typeof convolve2d).toBe('function');
    });
});
