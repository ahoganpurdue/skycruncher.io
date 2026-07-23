// ═══════════════════════════════════════════════════════════════════════════
// DRIFT-DEBLUR — synthetic known-kernel recovery + preservation proof
// ═══════════════════════════════════════════════════════════════════════════
// Proves the capability rigorously on a CONTROLLED synthetic star field:
//   (i)  inject a KNOWN sidereal-drift kernel into a clean field → deblur with
//        the EXACT same (calculated) kernel → the pre-drift compact PSF is
//        recovered (elongation removed; centroid unmoved).
//   (ii) the PreservationProof PASSES — flux conserved, centroids invariant,
//        reconvolution residual at the noise floor, forced photometry stable —
//        so classifyEpistemic promotes the op to VERIFIED_PRESERVING.
//  (iii) the DEFAULT-OFF gate and the NOT_CONFIRMED gate are honest-absent.
//   (iv) classifyEpistemic is NOT a rubber stamp: a proof with any failing
//        metric collapses to AESTHETIC (never silently accepted).
//
// The kernel here is the SAME uniform-line object the engine's psf_attribution
// stage emits (driftPsfKernel); this lane consumes it. PIXEL ledger only — no
// WCS / matched_stars / psf_field is re-run on the deblurred pixels.

import { describe, it, expect } from 'vitest';
import { measureStar } from '../pipeline/m10_psf/psf_core';
import { driftPsfKernel } from '../pipeline/m10_psf/psf_physics';
import {
    runDriftDeblur, rasterizeDriftKernel, convolvePlane, buildPreservationProof,
    serializeDeblurBlock,
    type SourcePos,
} from '../../../tools/deblur/drift_deblur.ts';
import { classifyEpistemic, emptyProof } from '../../../tools/denoise/ml_stubs/types.ts';

// ── deterministic PRNG + Gaussian noise (seeded → reproducible) ───────────────
function mulberry32(a: number) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rnd = mulberry32(20260707);
function gauss(): number {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── synthetic scene ───────────────────────────────────────────────────────────
const W = 160, H = 160;
const BG = 200;            // flat positive background (astro case: RL passes it through)
const PSF_SIGMA = 1.3;     // pre-drift Gaussian core, FWHM ≈ 3.06 px
const NOISE = 2.0;         // Gaussian read-noise-equivalent σ (ADU)
const DRIFT_LEN = 6.0;     // KNOWN sidereal trail length (px)
const DRIFT_PA = 30.0;     // KNOWN trail PA (deg, image-space)

// nine well-separated interior stars, varied brightness
const STARS: { x: number; y: number; amp: number }[] = [
    { x: 34, y: 32, amp: 6000 }, { x: 80, y: 30, amp: 3500 }, { x: 126, y: 36, amp: 4800 },
    { x: 30, y: 82, amp: 4200 }, { x: 82, y: 80, amp: 7000 }, { x: 128, y: 84, amp: 3000 },
    { x: 36, y: 128, amp: 5200 }, { x: 84, y: 126, amp: 3800 }, { x: 124, y: 124, amp: 4500 },
];
const SOURCES: SourcePos[] = STARS.map((s) => ({ x: s.x, y: s.y }));

function addGaussianStar(field: Float32Array, cx: number, cy: number, amp: number, sigma: number): void {
    const R = Math.ceil(sigma * 5);
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let j = -R; j <= R; j++) {
        const y = Math.round(cy) + j;
        if (y < 0 || y >= H) continue;
        for (let i = -R; i <= R; i++) {
            const x = Math.round(cx) + i;
            if (x < 0 || x >= W) continue;
            const dx = x - cx, dy = y - cy;
            field[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) * inv2s2);
        }
    }
}

function buildClean(): Float32Array {
    const f = new Float32Array(W * H).fill(BG);
    for (const s of STARS) addGaussianStar(f, s.x, s.y, s.amp, PSF_SIGMA);
    return f;
}

function addNoise(field: Float32Array, sigma: number): Float32Array {
    const out = new Float32Array(field.length);
    for (let i = 0; i < field.length; i++) out[i] = field[i] + sigma * gauss();
    return out;
}

// bright reference star (index 4, amp 7000)
const REF = STARS[4];

describe('drift-deblur — synthetic known-kernel recovery', () => {
    // clean → inject EXACT drift kernel → observed (drifted + noise)
    const clean = buildClean();
    const trueKernel = rasterizeDriftKernel(DRIFT_LEN, DRIFT_PA);
    const drifted = convolvePlane(clean, W, H, trueKernel);
    const observed = addNoise(drifted, NOISE);

    // the EXACT kernel the attribution stage would emit for this trail
    const attrKernel = driftPsfKernel(DRIFT_LEN, DRIFT_PA);

    it('injects a measurable elongation (the drift to be removed)', () => {
        const mClean = measureStar(clean, W, H, REF.x, REF.y, NOISE, 10)!;
        const mDrift = measureStar(observed, W, H, REF.x, REF.y, NOISE, 10)!;
        // clean star is round; drifted star is clearly elongated along the trail
        expect(mClean.ellipticity).toBeLessThan(0.1);
        expect(mDrift.ellipticity).toBeGreaterThan(0.35);
        expect(mDrift.fwhmMaj).toBeGreaterThan(mClean.fwhmMaj * 1.4);
        // eslint-disable-next-line no-console
        console.log(`[deblur] clean  maj=${mClean.fwhmMaj.toFixed(2)} min=${mClean.fwhmMin.toFixed(2)} e=${mClean.ellipticity.toFixed(3)}`);
        // eslint-disable-next-line no-console
        console.log(`[deblur] drift  maj=${mDrift.fwhmMaj.toFixed(2)} min=${mDrift.fwhmMin.toFixed(2)} e=${mDrift.ellipticity.toFixed(3)}`);
    });

    it('recovers the pre-drift compact PSF and PASSES the preservation proof → VERIFIED_PRESERVING', async () => {
        const { report, deblurred } = await runDriftDeblur({
            plane: observed, width: W, height: H,
            presence: 'CONFIRMED_PRESENT', driftKernel: attrKernel,
            sources: SOURCES, enabled: true, sigmaDamp: NOISE, iters: 100,
        });
        expect(deblurred).not.toBeNull();
        const d = deblurred!;

        const mClean = measureStar(clean, W, H, REF.x, REF.y, NOISE, 10)!;
        const mDrift = measureStar(observed, W, H, REF.x, REF.y, NOISE, 10)!;
        const mDeblur = measureStar(d, W, H, REF.x, REF.y, NOISE, 10)!;
        // eslint-disable-next-line no-console
        console.log(`[deblur] deblur maj=${mDeblur.fwhmMaj.toFixed(2)} min=${mDeblur.fwhmMin.toFixed(2)} e=${mDeblur.ellipticity.toFixed(3)}`);

        // (i) recovery: elongation collapses (0.383 → ~0.16), major axis pulled back
        // toward the pre-drift core (5.28 → ~4.31 px; clean core is 3.06 px).
        expect(mDeblur.ellipticity).toBeLessThan(0.20);
        expect(mDeblur.ellipticity).toBeLessThan(mDrift.ellipticity * 0.55);
        expect(mDeblur.fwhmMaj).toBeLessThan(mDrift.fwhmMaj * 0.90);
        expect(mDeblur.fwhmMaj).toBeGreaterThan(mClean.fwhmMaj * 0.5);
        expect(mDeblur.fwhmMaj).toBeLessThan(mClean.fwhmMaj * 1.6);

        // (ii) preservation proof numbers (report them)
        const p = report.preservation_proof!;
        // eslint-disable-next-line no-console
        console.log(`[deblur] proof flux_ratio=${p.flux_conservation.value} (tol ${p.flux_conservation.tolerance}, pass=${p.flux_conservation.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur] proof centroid_shift_px=${p.astrometric_invariance.value} (tol ${p.astrometric_invariance.tolerance}, pass=${p.astrometric_invariance.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur] proof reconv_resid/noise=${p.reconvolution_residual.value} (tol ${p.reconvolution_residual.tolerance}, pass=${p.reconvolution_residual.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur] proof forced_phot_sigma=${p.forced_photometry_recheck.value} (tol ${p.forced_photometry_recheck.tolerance}, pass=${p.forced_photometry_recheck.pass})`);

        expect(p.flux_conservation.pass).toBe(true);
        expect(p.astrometric_invariance.pass).toBe(true);
        expect(p.reconvolution_residual.pass).toBe(true);
        expect(p.forced_photometry_recheck.pass).toBe(true);

        // (iii) exact kernel + passing proof → VERIFIED_PRESERVING (measurement-grade)
        expect(report.epistemic_type).toBe('VERIFIED_PRESERVING');
        expect(report.label).toBe('MEASUREMENT_GRADE');
        expect(report.applied).toBe(true);

        // receipt block is present + serializes
        const block = serializeDeblurBlock(report);
        expect(block).not.toBeNull();
        expect(block!.epistemic_type).toBe('VERIFIED_PRESERVING');
        expect(block!.kernel.lengthPx).toBeCloseTo(DRIFT_LEN, 3);
    });
});

describe('drift-deblur — honest-absent gates', () => {
    const clean = buildClean();
    const observed = addNoise(convolvePlane(clean, W, H, rasterizeDriftKernel(DRIFT_LEN, DRIFT_PA)), NOISE);
    const attrKernel = driftPsfKernel(DRIFT_LEN, DRIFT_PA);

    it('DEFAULT-OFF: enabled unset → no deblur, null block', async () => {
        const { report, deblurred } = await runDriftDeblur({
            plane: observed, width: W, height: H,
            presence: 'CONFIRMED_PRESENT', driftKernel: attrKernel, sources: SOURCES,
            // enabled omitted → DEFAULT-OFF
        });
        expect(deblurred).toBeNull();
        expect(report.applied).toBe(false);
        expect(report.epistemic_type).toBeNull();
        expect(serializeDeblurBlock(report)).toBeNull();
    });

    it('NOT_CONFIRMED drift: enabled but presence not confirmed → honest-absent', async () => {
        const { report, deblurred } = await runDriftDeblur({
            plane: observed, width: W, height: H,
            presence: 'NOT_CONFIRMED', driftKernel: attrKernel, sources: SOURCES, enabled: true,
        });
        expect(deblurred).toBeNull();
        expect(report.applied).toBe(false);
        expect(report.presence).toBe('NOT_CONFIRMED');
        expect(serializeDeblurBlock(report)).toBeNull();
    });
});

describe('drift-deblur — classifyEpistemic is not a rubber stamp', () => {
    it('an empty (unmeasured) proof → AESTHETIC', () => {
        expect(classifyEpistemic(emptyProof())).toBe('AESTHETIC');
    });

    it('a proof with ANY failing metric collapses to AESTHETIC', () => {
        const clean = buildClean();
        const observed = addNoise(convolvePlane(clean, W, H, rasterizeDriftKernel(DRIFT_LEN, DRIFT_PA)), NOISE);
        // a genuinely-passing proof (deblur output vs input, same-kernel self-consistency)
        const kernel = rasterizeDriftKernel(DRIFT_LEN, DRIFT_PA);
        // fabricate a proof where every metric ran+passed, then break ONE:
        const proof = buildPreservationProof({
            before: observed, after: observed, w: W, h: H, kernel,
            sources: SOURCES, sigmaN: NOISE, apR: 8, boxR: 8,
        });
        // (identity after==before trivially passes flux/centroid/forced; that's fine —
        //  this test only exercises the classifier's veto on a failed metric)
        proof.reconvolution_residual = { ...proof.reconvolution_residual, pass: false };
        expect(classifyEpistemic(proof)).toBe('AESTHETIC');
    });
});
