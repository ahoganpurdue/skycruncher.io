// ═══════════════════════════════════════════════════════════════════════════
// DRIFT-DEBLUR — REAL FRAME: the bundled Canon CR2 (drift CONFIRMED_PRESENT)
// ═══════════════════════════════════════════════════════════════════════════
// The bundled sample_observation.cr2 is a 20s UNTRACKED tripod Milky Way shot
// (Canon T6, real 14mm lens behind a lying 50mm EXIF). It blind-solves
// (dec=-33.83°, 63.211"/px), and psf_attribution CONFIRMS sidereal drift:
//   calcPx = 15.041·cos(-33.83°)·20 / 63.211 ≈ 3.95 px, drift PA ≈ 156.2°;
//   measured elongation matches in magnitude (predMaj 7.96 vs measured 8.28,
//   fracErr 0.038) AND direction (dirDev 13.0° ≤ 22°) → CONFIRMED_PRESENT.
//   Morphology is DRIFT (orientation ~constant across the field; ellipticity
//   flat with the CENTER among the highest — coma would vanish at center).
//
// So this is the ONE real corpus frame that SOLVES *and* has confirmed drift.
// HONEST SCOPE: it is a 110°-diagonal ULTRA-WIDE, so the exact drift kernel is
// spatially VARYING (PA + magnitude drift across the field). A single global
// kernel is only locally valid → we deblur a CENTER CROP (where the confirming
// elongation lives and the global PA is a good local approximation). A full-frame
// application would need a spatially-varying kernel (future work).
//
// ESTIMATOR CAVEAT (carried forward): the direction leg passes with the CIRCULAR
// MEAN orientation (143.2° → dirDev 13.0°). A plain folded MEDIAN (130°) would
// give 25.7° and FAIL — circular mean is the correct estimator for an angular
// quantity, so the CONFIRMED_PRESENT verdict stands, but the pass is estimator-
// sensitive and is noted, not hidden.
//
// Skips in a clean clone (CR2 is gitignored/local). Point at it with CR2_FILE=…
// or drop it at public/demo/sample_observation.cr2.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { measureStar, findMaxima, pixelNoiseSigma, robustStats } from '../pipeline/m10_psf/psf_core';
import { driftPsfKernel, siderealTrailArcsec } from '../pipeline/m10_psf/psf_physics';
import { runDriftDeblur, type SourcePos } from '../../../tools/deblur/drift_deblur.ts';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped headless .mjs decode lane (plain-node libraw path)
import { decodeCR2, detectPattern, cfaChannelStats, fixHotPixelsCFA, demosaicBilinear, terminateDecodeWorkers } from '../../../tools/psf/decode_cr2.mjs';

const CR2 = process.env.CR2_FILE || 'public/demo/sample_observation.cr2';
const HAVE = fs.existsSync(CR2);

// attribution-confirmed drift kernel for this frame (see header)
const DEC_DEG = -33.83, EXP_S = 20, SCALE = 63.211;
const DRIFT_PA_DEG = 156.2;   // RA-axis line PA from the fitted WCS CD matrix

const LW = [0.2126, 0.7152, 0.0722] as const;
function luminanceOf(R: Float32Array, G: Float32Array, B: Float32Array): Float32Array {
    const L = new Float32Array(R.length);
    for (let i = 0; i < R.length; i++) L[i] = LW[0] * R[i] + LW[1] * G[i] + LW[2] * B[i];
    return L;
}
function cropCenter(L: Float32Array, w: number, h: number, cw: number, ch: number) {
    const x0 = (w - cw) >> 1, y0 = (h - ch) >> 1;
    const out = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) {
        const src = (y0 + j) * w + x0;
        for (let i = 0; i < cw; i++) out[j * cw + i] = L[src + i];
    }
    return out;
}

describe.skipIf(!HAVE)('drift-deblur on the bundled CR2 — real confirmed-drift frame', () => {
    it('deblurs the CONFIRMED_PRESENT drift with the exact kernel → preservation proof', async () => {
        // ── decode → CFA repair → demosaic → luminance (matches the measurement lane) ──
        const abs = path.resolve(CR2);
        const { w, h, rgb16 } = await decodeCR2(abs);
        const layout = detectPattern(rgb16, w, h);
        const stats = cfaChannelStats(rgb16, w, h, layout.pat);
        fixHotPixelsCFA(rgb16, w, h, layout.pat, stats);
        const [R, G, B] = demosaicBilinear(rgb16, w, h, layout.pat);
        terminateDecodeWorkers();   // release the libraw decode worker pool
        const L = luminanceOf(R, G, B);

        // center crop where the single global drift kernel is locally valid
        const CW = 640, CH = 640;
        const crop = cropCenter(L, w, h, CW, CH);

        // the EXACT kernel: length from immutable celestial mechanics, PA from WCS
        const calcPx = siderealTrailArcsec(DEC_DEG, EXP_S) / SCALE;
        expect(calcPx).toBeCloseTo(3.953, 2);   // ties the kernel to the physics
        const driftKernel = driftPsfKernel(calcPx, DRIFT_PA_DEG);

        // proof sources: brightest well-measured stars in the crop
        const sigmaN = pixelNoiseSigma(crop);
        const { med } = robustStats(crop);
        const peaks = findMaxima(crop, CW, CH, med + 8 * sigmaN, 2000, 14);
        const sources: SourcePos[] = [];
        for (const p of peaks) {
            const m = measureStar(crop, CW, CH, p.x, p.y, sigmaN, 10);
            if (m && Number.isFinite(m.fwhmMaj) && m.fwhmMaj > 1.5 && m.fwhmMaj < 30 && m.peakAboveBg > 12 * sigmaN) {
                sources.push({ x: m.cx, y: m.cy });
                if (sources.length >= 40) break;
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] frame ${w}x${h}, crop ${CW}x${CH}, ${sources.length} proof sources, calcPx=${calcPx.toFixed(3)} PA=${DRIFT_PA_DEG}`);
        expect(sources.length).toBeGreaterThan(8);

        const { report, deblurred } = await runDriftDeblur({
            plane: crop, width: CW, height: CH,
            presence: 'CONFIRMED_PRESENT', driftKernel, sources,
            enabled: true, iters: 30, sigmaDamp: sigmaN,
        });
        expect(deblurred).not.toBeNull();

        const p = report.preservation_proof!;
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] flux_ratio=${p.flux_conservation.value} (pass=${p.flux_conservation.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] centroid_shift_px=${p.astrometric_invariance.value} (pass=${p.astrometric_invariance.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] reconv_resid/noise=${p.reconvolution_residual.value} (pass=${p.reconvolution_residual.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] forced_phot_sigma=${p.forced_photometry_recheck.value} (pass=${p.forced_photometry_recheck.pass})`);
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] epistemic=${report.epistemic_type} label=${report.label}`);

        // median (robust) vs max centroid shift + flux spread across sources —
        // shows whether the misfit is broad or a few locally-mis-PA/edge outliers.
        const shifts: number[] = [], fratios: number[] = [];
        for (const s of sources) {
            const a = measureStar(crop, CW, CH, Math.round(s.x), Math.round(s.y), sigmaN, 10);
            const b = measureStar(deblurred!, CW, CH, Math.round(s.x), Math.round(s.y), sigmaN, 10);
            if (a && b) shifts.push(Math.hypot(a.cx - b.cx, a.cy - b.cy));
        }
        shifts.sort((x, y) => x - y);
        const medShift = shifts[shifts.length >> 1];
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] centroid shift median=${medShift.toFixed(3)}px max=${shifts[shifts.length - 1].toFixed(3)}px (n=${shifts.length})`);

        // measured recovery on the brightest source
        const bright = sources.slice().sort((a, b) => {
            const ma = measureStar(crop, CW, CH, Math.round(a.x), Math.round(a.y), sigmaN, 10);
            const mb = measureStar(crop, CW, CH, Math.round(b.x), Math.round(b.y), sigmaN, 10);
            return (mb?.peakAboveBg ?? 0) - (ma?.peakAboveBg ?? 0);
        })[0];
        const mBefore = measureStar(crop, CW, CH, Math.round(bright.x), Math.round(bright.y), sigmaN, 10)!;
        const mAfter = measureStar(deblurred!, CW, CH, Math.round(bright.x), Math.round(bright.y), sigmaN, 10)!;
        // eslint-disable-next-line no-console
        console.log(`[deblur-cr2] bright star maj ${mBefore.fwhmMaj.toFixed(2)}→${mAfter.fwhmMaj.toFixed(2)} ellip ${mBefore.ellipticity.toFixed(3)}→${mAfter.ellipticity.toFixed(3)}`);

        // ── honest real-frame verdict ─────────────────────────────────────────
        // The deblur RUNS and reduces elongation; the exact kernel is self-consistent
        // (reconv at the noise floor) and does not corrupt catalog flux (forced-phot).
        expect(report.applied).toBe(true);
        expect(p.reconvolution_residual.pass).toBe(true);
        expect(p.forced_photometry_recheck.pass).toBe(true);
        expect(mAfter.ellipticity).toBeLessThanOrEqual(mBefore.ellipticity + 1e-6);

        // But on a 110° ULTRA-WIDE frame a SINGLE global kernel is only locally
        // valid, and real stars carry optics/tracking the pure-drift kernel omits →
        // the STRICT per-source measurement-grade bar (flux 2% / centroid 0.1px) is
        // NOT met → classifyEpistemic correctly FLAGS it AESTHETIC (never silently
        // accepted). The epistemic verdict must MIRROR the proof (the guard invariant):
        const allPass = p.flux_conservation.pass && p.astrometric_invariance.pass &&
            p.reconvolution_residual.pass && p.forced_photometry_recheck.pass;
        expect(report.epistemic_type).toBe(allPass ? 'VERIFIED_PRESERVING' : 'AESTHETIC');
    }, 240_000);
});

if (!HAVE) {
    // eslint-disable-next-line no-console
    console.warn(`[deblur-cr2.test] CR2 absent (${CR2}) — real-frame deblur skipped (local-only asset).`);
}
