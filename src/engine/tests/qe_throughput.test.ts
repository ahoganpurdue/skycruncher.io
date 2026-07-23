/**
 * CELL ④ — SENSOR QE THROUGHPUT (SPCC per-band flux divide-out; STAR-DATA ledger).
 * Load-bearing invariant (mirrors CELLS ②③): flag OFF (default) / no resolvable
 * qe_curve ⇒ inert ⇒ SPCC fluxes untouched ⇒ both pinned reference solves
 * byte-identical. Flag ON ⇒ the divide-out shifts the instrumental colors/mags by
 * a fixed per-band offset and records honest, APPROXIMATE-labeled provenance.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    isQeThroughputEnabled, computeQeThroughput, QE_BAND_WAVELENGTHS_NM, type QeThroughput,
} from '../pipeline/m8_photometry/qe_throughput';
import { computeSpccCalibration } from '../pipeline/m8_photometry/spcc_calibrator';
import { interpolateQE, findSensorByCamera, type SensorProfile } from '../pipeline/m2_hardware/sensor_db';
import { runSpcc } from '../pipeline/stages/science';

afterEach(() => { vi.unstubAllEnvs(); });

// ── flat-background interleaved RGB frame with a hard-edged disc star ──
function frameWithStar(w: number, h: number, bg: [number, number, number], star: {
    cx: number; cy: number; r: number; amp: [number, number, number];
}): Float32Array {
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
    for (let y = Math.floor(star.cy - star.r); y <= Math.ceil(star.cy + star.r); y++) {
        for (let x = Math.floor(star.cx - star.r); x <= Math.ceil(star.cx + star.r); x++) {
            const dx = x - star.cx, dy = y - star.cy;
            if (dx * dx + dy * dy <= star.r * star.r) {
                const idx = (y * w + x) * 3;
                rgb[idx] += star.amp[0]; rgb[idx + 1] += star.amp[1]; rgb[idx + 2] += star.amp[2];
            }
        }
    }
    return rgb;
}

const W = 64, H = 64;
const makeFrame = () => ({
    data: frameWithStar(W, H, [0.1, 0.12, 0.08], { cx: 32, cy: 32, r: 2, amp: [0.3, 0.5, 0.2] }),
    width: W, height: H,
});
const matched = [{ detected: { x: 32, y: 32, fwhm: 3.0 }, catalog: { mag: 10, bv: 0.5 } }];

// A hand-built throughput with EXACT known factors (independent of any DB curve).
const QE: QeThroughput = {
    factor: { r: 2, g: 1, b: 4 },
    qe: { r: 0.5, g: 1, b: 0.25 },
    wavelengthNm: { ...QE_BAND_WAVELENGTHS_NM },
    sensorModel: 'TEST SENSOR',
    approximate: true,
};

// ══════════════ isQeThroughputEnabled — default OFF, 'true'/'1' ══════════════
describe('CELL ④ — isQeThroughputEnabled', () => {
    it('default (unset) ⇒ false', () => {
        expect(isQeThroughputEnabled()).toBe(false);
    });
    it("'true' and '1' ⇒ true; 'false'/'0'/junk ⇒ false", () => {
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', 'true');
        expect(isQeThroughputEnabled()).toBe(true);
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', '1');
        expect(isQeThroughputEnabled()).toBe(true);
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', 'false');
        expect(isQeThroughputEnabled()).toBe(false);
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', '0');
        expect(isQeThroughputEnabled()).toBe(false);
    });
});

// ══════════════ computeQeThroughput — pure per-band divide-out ══════════════
describe('CELL ④ — computeQeThroughput (pure)', () => {
    const profile = findSensorByCamera('ZWO ASI2600MC Pro')!; // IMX571 (datasheet, not approximate)

    it('factor = 1/QE at the R/G/B representative wavelengths', () => {
        const t = computeQeThroughput(profile)!;
        expect(t).not.toBeNull();
        expect(t.factor.r).toBeCloseTo(1 / interpolateQE(profile.qe_curve, 620), 9);
        expect(t.factor.g).toBeCloseTo(1 / interpolateQE(profile.qe_curve, 530), 9);
        expect(t.factor.b).toBeCloseTo(1 / interpolateQE(profile.qe_curve, 450), 9);
        expect(t.qe.g).toBeCloseTo(interpolateQE(profile.qe_curve, 530), 9);
        expect(t.wavelengthNm).toEqual({ r: 620, g: 530, b: 450 });
        expect(t.sensorModel).toBe('Sony IMX571');
    });

    it('carries the APPROXIMATE label straight from sensor_db qe_approximate', () => {
        // IMX571 is datasheet-grounded (unmarked) ⇒ approximate false.
        expect(computeQeThroughput(findSensorByCamera('ZWO ASI2600MC Pro'))!.approximate).toBe(false);
        // IMX585 (Seestar S30 Pro) qe_curve is a placeholder ⇒ approximate true.
        expect(computeQeThroughput(findSensorByCamera('ZWO Seestar S30 Pro'))!.approximate).toBe(true);
        // Canon DSLR family qe_curve copied ⇒ approximate true.
        expect(computeQeThroughput(findSensorByCamera('Canon EOS 5D Mark III'))!.approximate).toBe(true);
    });

    it('honest SKIP (null) when no profile / no qe_curve', () => {
        expect(computeQeThroughput(null)).toBeNull();
        expect(computeQeThroughput(undefined)).toBeNull();
        expect(computeQeThroughput({ qe_curve: [] } as unknown as SensorProfile)).toBeNull();
    });

    it('dead band (QE ≤ 0.01) ⇒ factor clamps to 1 (never amplify noise)', () => {
        const dead = { sensor_model: 'DEAD', qe_curve: [{ nm: 400, efficiency: 0 }, { nm: 800, efficiency: 0 }] } as unknown as SensorProfile;
        const t = computeQeThroughput(dead)!;
        expect(t.factor).toEqual({ r: 1, g: 1, b: 1 });
    });
});

// ══════════════ computeSpccCalibration — flag OFF byte-identical ══════════════
describe('CELL ④ — computeSpccCalibration is byte-identical with the flag OFF', () => {
    it('flag OFF: passing a qeThroughput leaves instColor identical + cal.qe null', () => {
        const base = computeSpccCalibration(matched, makeFrame(), null, 1); // no qe arg
        const withQe = computeSpccCalibration(matched, makeFrame(), null, 1, null, null, QE); // qe passed, flag OFF
        expect(withQe.qe ?? null).toBeNull();                 // provenance absent when OFF
        expect(withQe.stars[0].instColor).toBe(base.stars[0].instColor); // IEEE-identical
        expect(withQe.stars[0].mInst).toBe(base.stars[0].mInst);
    });
});

// ══════════════ computeSpccCalibration — flag ON divide-out + provenance ══════════════
describe('CELL ④ — computeSpccCalibration applies the divide-out under the flag', () => {
    it('flag ON: instColor shifts by −2.5·log10(factor_b/factor_r); provenance honest', () => {
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', 'true');
        const base = computeSpccCalibration(matched, makeFrame(), null, 1); // baseline (no correction)
        const on = computeSpccCalibration(matched, makeFrame(), null, 1, null, null, QE);

        // instColor = −2.5·log10(fB/fR); dividing out per-band QE multiplies
        // fB by factor.b and fR by factor.r ⇒ a constant color offset.
        const expectedShift = -2.5 * Math.log10(QE.factor.b / QE.factor.r);
        expect(on.stars[0].instColor!).toBeCloseTo(base.stars[0].instColor! + expectedShift, 9);

        // Honest-or-absent provenance carrying the APPROXIMATE label.
        expect(on.qe).not.toBeNull();
        expect(on.qe!.applied).toBe(true);
        expect(on.qe!.factor).toEqual(QE.factor);
        expect(on.qe!.approximate).toBe(true);
        expect(on.qe!.note).toContain('APPROXIMATE');
        expect(on.qe!.sensor_model).toBe('TEST SENSOR');
    });
});

// ══════════════ runSpcc seam — flag-off identity + flag-on resolution ══════════════
describe('CELL ④ — runSpcc resolves QE from the camera model only under the flag', () => {
    it('flag OFF: cameraModel is inert — cal.qe null, block carries no qe key', () => {
        const noModel = runSpcc(matched, makeFrame(), null, 1, true, 1.0);
        const withModel = runSpcc(matched, makeFrame(), null, 1, true, 1.0, undefined, 'ZWO Seestar S30 Pro');
        expect(withModel.cal!.qe ?? null).toBeNull();
        // per-star fluxes/colors identical → SPCC block identical
        expect(withModel.block!.color_intercept).toBe(noModel.block!.color_intercept);
        expect('qe' in (withModel.block as object)).toBe(false); // no receipt-schema change
    });

    it('flag ON: resolves the profile → cal.qe populated with the APPROXIMATE label', () => {
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', 'true');
        const r = runSpcc(matched, makeFrame(), null, 1, true, 1.0, undefined, 'ZWO Seestar S30 Pro');
        expect(r.cal!.qe).not.toBeNull();
        expect(r.cal!.qe!.applied).toBe(true);
        expect(r.cal!.qe!.approximate).toBe(true); // IMX585 placeholder curve
        expect(r.cal!.qe!.sensor_model).toBe('Sony IMX585');
    });

    it('flag ON but unknown body ⇒ honest SKIP (cal.qe null, no correction)', () => {
        vi.stubEnv('VITE_SPCC_QE_THROUGHPUT', 'true');
        const skip = runSpcc(matched, makeFrame(), null, 1, true, 1.0, undefined, 'Nonexistent Body 9000');
        const base = runSpcc(matched, makeFrame(), null, 1, true, 1.0);
        expect(skip.cal!.qe ?? null).toBeNull();
        expect(skip.block!.color_intercept).toBe(base.block!.color_intercept); // untouched
    });
});
