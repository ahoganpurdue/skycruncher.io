/**
 * CONTROLLED EXPERIMENT — the regime thesis, isolated from the junk-abundance
 * confound, on synthetic frames where WE own the ground truth (no label noise).
 *
 * Separating power = precision a shape cut can buy WITHOUT sacrificing recall.
 * It is the product of TWO things: (a) is there junk to remove, and (b) can the
 * shape distinguish junk from stars. We hold (a) FIXED (identical bright junk in
 * both frames) and vary only the regime, so any difference is pure (b):
 *
 *   OVERSAMPLED  — stars are wide gaussians (FWHM≈4.5px); junk = tight FWHM≈2px
 *                  point sources. The fwhm-floor cut removes junk, keeps stars ⇒
 *                  HIGH power (measured: precision 0.5→1.0 at held recall).
 *   UNDERSAMPLED — stars are FWHM≈2px point sources TOO (identical morphology to
 *                  the junk). No cut removes junk without removing stars ⇒ ZERO
 *                  power (measured: any junk-removing floor also collapses recall).
 *
 * This is the mechanism proof. The real-frame runner then measures where NATURE
 * sits, and (via junk injection) confirms real oversampled star morphology has
 * the same high power.
 */
import { describe, it, expect } from 'vitest';
import { bootWasm, runDetection, baselineKnobs } from './detect_harness';
import type { GroundTruth } from './ground_truth';
import { scoreDetections, measureSeparatingPower, buildGrids } from './knob_optimizer';

const W = 600, H = 600;
const starPos = Array.from({ length: 40 }, (_, k) => ({ x: 40 + (k % 8) * 68, y: 40 + Math.floor(k / 8) * 68 }));
const junkPos = Array.from({ length: 40 }, (_, k) => ({ x: 74 + (k % 8) * 68, y: 74 + Math.floor(k / 8) * 68 }));

function base(): Float32Array {
    const lum = new Float32Array(W * H);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.10 + 0.0015 * Math.sin(i * 0.017);
    return lum;
}
function addGaussian(lum: Float32Array, x0: number, y0: number, amp: number, fwhm: number) {
    const sg = fwhm / 2.355, r = Math.ceil(sg * 4);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(x0) + dx, y = Math.round(y0) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        lum[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
    }
}
/** A tight but DETECTABLE point-source (fwhm≈2px) — the realistic thermal-junk /
 *  undersampled-star model. (Sub-2px 2-px clumps aren't extracted by the WASM
 *  kernel at all, so they can't test the shape cuts.) */
function addPoint(lum: Float32Array, x0: number, y0: number, amp: number) { addGaussian(lum, x0, y0, amp, 2.0); }
function truthFrom(stars: { x: number; y: number }[]): GroundTruth {
    // limitingMag high so any unmatched detection is a CONFIDENT FP (synthetic
    // frames have no real catalog-depth ambiguity — removes zeropoint fragility).
    return { stars: stars.map(s => ({ x: s.x, y: s.y, mag: 12 })), limitingMag: 25, source: 'CATALOG_PROJECTED', note: 'synthetic planted truth' };
}
const HOTPIX_OFF = (fl?: number) => ({ ...baselineKnobs(fl), hotpixMinDensityPerMP: Infinity });

describe('regime thesis — controlled synthetic experiment', () => {
    it('shape-knob separating power is HIGH oversampled, ~0 undersampled (junk held fixed)', () => {
        bootWasm();
        const JUNK_AMP = 2.5; // clearly detected + CONFIDENT false positives

        // OVERSAMPLED: wide gaussian stars, 2px junk
        const over = base();
        for (const p of starPos) addGaussian(over, p.x, p.y, 0.9, 4.5);
        for (const p of junkPos) addPoint(over, p.x, p.y, JUNK_AMP);
        const overDet = runDetection(over, W, H, HOTPIX_OFF(135)).detections;
        console.log(`[regime-exp] OVERSAMPLED detections=${overDet.length} (40 stars + 40 junk expected)`);
        const overSep = measureSeparatingPower({ lum: over, width: W, height: H, truth: truthFrom(starPos), matchRadiusPx: 4, knob: 'fwhmFloorPx', values: buildGrids(4.5, null).fwhmFloorPx });

        // UNDERSAMPLED: stars are 2px clumps — identical morphology to the junk
        const under = base();
        for (const p of starPos) addPoint(under, p.x, p.y, JUNK_AMP);
        for (const p of junkPos) addPoint(under, p.x, p.y, JUNK_AMP);
        const underDet = runDetection(under, W, H, HOTPIX_OFF(135)).detections;
        console.log(`[regime-exp] UNDERSAMPLED detections=${underDet.length} (40 stars + 40 junk expected)`);
        const underSep = measureSeparatingPower({ lum: under, width: W, height: H, truth: truthFrom(starPos), matchRadiusPx: 4, knob: 'fwhmFloorPx', values: buildGrids(2.0, null).fwhmFloorPx });

        console.log(`[regime-exp] OVERSAMPLED  fwhm-floor: power=${overSep.power} noCutP=${overSep.noCutPrecision} noCutR=${overSep.noCutRecall} precByVal=${JSON.stringify(overSep.precByValue)} recByVal=${JSON.stringify(overSep.recByValue)}`);
        console.log(`[regime-exp] UNDERSAMPLED fwhm-floor: power=${underSep.power} noCutP=${underSep.noCutPrecision} noCutR=${underSep.noCutRecall} precByVal=${JSON.stringify(underSep.precByValue)} recByVal=${JSON.stringify(underSep.recByValue)}`);

        // headline: shape cut buys precision (at held recall) when oversampled, not when undersampled
        expect(overSep.power).toBeGreaterThan(underSep.power);
        expect(overSep.power).toBeGreaterThan(0.1);       // real separating power
        expect(underSep.power).toBeLessThan(0.05);        // ~zero — junk ≈ stars
    });

    it('scoreDetections computes honest precision/recall/F1', () => {
        bootWasm();
        const stars20 = starPos.slice(0, 20);
        const lum = base();
        for (const p of stars20) addGaussian(lum, p.x, p.y, 0.6, 4.0);
        for (const p of junkPos.slice(0, 10)) addPoint(lum, p.x, p.y, 1.3);
        // hotpix masking OFF so the spike junk survives to be scored (else the
        // pre-pass removes it and precision is trivially 1).
        const dets = runDetection(lum, W, H, { ...baselineKnobs(135), hotpixMinDensityPerMP: Infinity }).detections;
        const score = scoreDetections(dets, truthFrom(stars20), 4);
        expect(score.detectedTruth).toBe(20);
        expect(score.recall).toBeCloseTo(1.0, 5);
        expect(score.precision).toBeGreaterThan(0);
        expect(score.precision).toBeLessThan(1);          // junk drags precision below 1
        console.log(`[score] tp=${score.tp} confFP=${score.confidentFP} ambigFP=${score.ambiguousFP} P=${score.precision} R=${score.recall} F1=${score.f1}`);
    });
});
