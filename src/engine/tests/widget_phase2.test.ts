/**
 * WIDGET REGISTRY — Phase 2 selector + math tests (pure; node env, no DOM).
 *
 * Contract coverage for every Phase-2 widget:
 *  - each data selector: null receipt ⇒ null (NOT MEASURED), present ⇒ data
 *  - scaffold selectors: ALWAYS null (honest absence, never fabricated)
 *  - the shared render-side math (widget_math): temperature locus, distortion
 *    evaluators (center ⇒ ~0), histogram/binning primitives.
 */

import { describe, it, expect } from 'vitest';

import { selectForcedPhotZ } from '../ui/widgets/widgets/ForcedPhotometryZWidget';
import { selectCullingWaterfall } from '../ui/widgets/widgets/CullingWaterfallWidget';
import { selectSolveTiming } from '../ui/widgets/widgets/SolveTimingWaterfallWidget';
import { selectColorColor } from '../ui/widgets/widgets/ColorColorPlanckianWidget';
import { selectDetectionDensity } from '../ui/widgets/widgets/DetectionDensityWidget';
import { selectBcEdge } from '../ui/widgets/widgets/BcEdgeRecoveryWidget';
import { selectDistortionCascade } from '../ui/widgets/widgets/DistortionCascade2dWidget';
import { SCAFFOLD_WIDGETS } from '../ui/widgets/widgets/ScaffoldWidgets';
import {
    finite, bvToKelvin, rgbColorIndex, measuredBcShiftPx, sipShiftPx, tpsShiftPx,
    logHistogram, binGrid,
} from '../ui/widgets/widget_math';

// ─── forced-photometry significance ────────────────────────────────────────

describe('selectForcedPhotZ', () => {
    it('null when absent / no confirmed stars', () => {
        expect(selectForcedPhotZ(null)).toBeNull();
        expect(selectForcedPhotZ({})).toBeNull();
        expect(selectForcedPhotZ({ deep_confirmed: { confirmed_stars: [] } })).toBeNull();
    });
    it('reads set gate + per-star snr + per-test tally', () => {
        const d = selectForcedPhotZ({
            deep_confirmed: {
                examined: 5, confirmed: 4, setExcessZ: 77.9, setGatePassed: true, approximate: false,
                confirmed_stars: [
                    { snr: 100, tests: { snr: 'PASS', localNull: 'PASS', color: 'NOT_MEASURED' } },
                    { snr: 10, tests: { snr: 'PASS', localNull: 'FAIL', color: 'NOT_MEASURED' } },
                ],
            },
        });
        expect(d).not.toBeNull();
        expect(d!.setExcessZ).toBe(77.9);
        expect(d!.setGatePassed).toBe(true);
        expect(d!.snr).toEqual([100, 10]);
        expect(d!.tally.snr).toEqual({ pass: 2, notMeasured: 0, total: 2 });
        expect(d!.tally.localNull).toEqual({ pass: 1, notMeasured: 0, total: 2 });
        expect(d!.tally.color).toEqual({ pass: 0, notMeasured: 2, total: 2 });
    });
});

// ─── culling waterfall ──────────────────────────────────────────────────────

describe('selectCullingWaterfall', () => {
    it('null when no signal / nothing to draw', () => {
        expect(selectCullingWaterfall(null)).toBeNull();
        expect(selectCullingWaterfall({})).toBeNull();
        expect(selectCullingWaterfall({ signal: { culling_tally: {} } })).toBeNull();
    });
    it('reconstructs detected = clean + culled, carries matched', () => {
        const d = selectCullingWaterfall({
            signal: { culling_tally: { LOW_SNR: 223, CIRCULARITY: 19, DEDUPLICATION: 269 }, clean_stars: new Array(698) },
            solution: { matched_stars: new Array(272) },
        });
        expect(d).not.toBeNull();
        expect(d!.clean).toBe(698);
        expect(d!.detected).toBe(698 + 223 + 19 + 269);
        expect(d!.matched).toBe(272);
        // buckets sorted desc, zero buckets dropped
        expect(d!.buckets[0]).toEqual({ reason: 'DEDUPLICATION', count: 269 });
    });
});

// ─── solve timing (events primary, solve_time_ms fallback) ─────────────────

describe('selectSolveTiming', () => {
    it('null with no events and no positive solve_time_ms', () => {
        expect(selectSolveTiming(null)).toBeNull();
        expect(selectSolveTiming({ solution: { solve_time_ms: 0 } })).toBeNull();
    });
    it('single total bar from solve_time_ms when no events', () => {
        const d = selectSolveTiming({ solution: { solve_time_ms: 1234 } });
        expect(d).not.toBeNull();
        expect(d!.fromTotalOnly).toBe(true);
        expect(d!.totalMs).toBe(1234);
        expect(d!.stages).toHaveLength(1);
    });
    it('per-stage bars from stage_finished events (labels from stage_started)', () => {
        const events: any = [
            { kind: 'stage_started', stage: 'detect', label: 'Detect signal' },
            { kind: 'stage_finished', stage: 'detect', ok: true, ms: 40 },
            { kind: 'stage_finished', stage: 'solve', ok: true, ms: 120 },
        ];
        const d = selectSolveTiming({ solution: { solve_time_ms: 999 } }, events);
        expect(d!.fromTotalOnly).toBe(false);
        expect(d!.stages.map(s => s.label)).toEqual(['Detect signal', 'solve']);
        expect(d!.totalMs).toBe(160);
    });
});

// ─── color-color ────────────────────────────────────────────────────────────

describe('selectColorColor', () => {
    it('null when no star carries both catalog + measured color', () => {
        expect(selectColorColor(null)).toBeNull();
        expect(selectColorColor({ solution: { matched_stars: [{ bv: 1.0 }] } })).toBeNull(); // missing measured_bv
    });
    it('pairs catalog bv with measured_bv, keeps rgb', () => {
        const d = selectColorColor({ solution: { matched_stars: [
            { bv: 1.5, measured_bv: 0.04, peak_rgb: [0.9, 0.8, 1] },
            { bv: 0.2, measured_bv: -0.02 },
        ] } });
        expect(d!.n).toBe(2);
        expect(d!.points[0]).toMatchObject({ catBv: 1.5, measBv: 0.04 });
        expect(d!.points[0].rgb).toEqual([0.9, 0.8, 1]);
        expect(d!.points[1].rgb).toBeNull();
    });
});

// ─── detection density ──────────────────────────────────────────────────────

describe('selectDetectionDensity', () => {
    it('null when no detection or matched positions', () => {
        expect(selectDetectionDensity(null)).toBeNull();
        expect(selectDetectionDensity({ signal: { clean_stars: [] }, solution: { matched_stars: [] } })).toBeNull();
    });
    it('collects positions + frame dims', () => {
        const d = selectDetectionDensity({
            metadata: { width: 2160, height: 3840 },
            signal: { clean_stars: [{ x: 10, y: 20 }, { x: 100, y: 200 }] },
            solution: { matched_stars: [{ x: 10, y: 20 }] },
        });
        expect(d!.w).toBe(2160); expect(d!.h).toBe(3840);
        expect(d!.detected).toHaveLength(2);
        expect(d!.matched).toHaveLength(1);
        expect(d!.gy).toBeGreaterThan(d!.gx);         // portrait ⇒ more rows
    });
});

// ─── bc edge recovery ───────────────────────────────────────────────────────

describe('selectBcEdge', () => {
    it('null when no measured BC / not_measured set', () => {
        expect(selectBcEdge(null)).toBeNull();
        expect(selectBcEdge({ lens_distortion_measured: { not_measured: 'thin coverage' } })).toBeNull();
        expect(selectBcEdge({ lens_distortion_measured: { frame_center: [1, 1] } })).toBeNull(); // no half_diag
    });
    it('reads coefficients, frame center, coverage; bc_rematch absent', () => {
        const d = selectBcEdge({
            metadata: { width: 2160, height: 3840 },
            lens_distortion_measured: {
                k1: 0.0016, k2: -0.0006, coefficients: { k1: { value: 0.0016 }, k2: { value: -0.0006 } },
                frame_center: [1079.5, 1919.5], half_diag_px: 2202, n_pairs: 272, n_used: 247,
                rms_2d_px: 2.9417, baseline_rms_2d_px: 2.9628, octant_counts: [15], octant_labels: ['E'],
            },
            solution: { matched_stars: [{ x: 100, y: 200 }] },
        });
        expect(d).not.toBeNull();
        expect(d!.halfDiag).toBe(2202);
        expect(d!.rematchPresent).toBe(false);
        expect(d!.matched).toHaveLength(1);
    });
});

// ─── distortion cascade ─────────────────────────────────────────────────────

describe('selectDistortionCascade', () => {
    it('null when no distortion representation present', () => {
        expect(selectDistortionCascade(null)).toBeNull();
        expect(selectDistortionCascade({ metadata: { width: 100, height: 100 } })).toBeNull();
    });
    it('gathers whichever stages exist (nominal + sip here)', () => {
        const d = selectDistortionCascade({
            metadata: { width: 2160, height: 3840 },
            hardware: { distortion_profile: { k1: 0.01, k2: -0.02, k3: 0.01 }, fit_stats: { r_ref_px: 2155 } },
            wcs: { CRPIX1: 1080, CRPIX2: 1920 },
            solution: { astrometry: { sip: { a: [[0, 0], [1e-6, 0]], b: [[0, 1e-6], [0, 0]] } } },
        });
        expect(d).not.toBeNull();
        expect(d!.nominal).not.toBeNull();
        expect(d!.sip).not.toBeNull();
        expect(d!.measured).toBeNull();
        expect(d!.tps).toBeNull();
    });
});

// ─── scaffolds always absent ────────────────────────────────────────────────

describe('scaffold widgets', () => {
    it('there are exactly 9, each with an intent and a constant-null selector', () => {
        expect(SCAFFOLD_WIDGETS).toHaveLength(9);
        for (const w of SCAFFOLD_WIDGETS) {
            expect(w.intent.length).toBeGreaterThan(0);
            // always NOT MEASURED, whatever the receipt
            expect(w.dataSelector(null)).toBeNull();
            expect(w.dataSelector({ solution: { matched_stars: [{ x: 1, y: 2 }] } })).toBeNull();
        }
    });
});

// ─── widget_math (pure) ─────────────────────────────────────────────────────

describe('widget_math', () => {
    it('finite guards non-numbers', () => {
        expect(finite(3)).toBe(3);
        expect(finite(NaN)).toBeNull();
        expect(finite('x')).toBeNull();
        expect(finite(undefined)).toBeNull();
    });
    it('bvToKelvin: hotter (bluer) ⇒ higher K, cooler ⇒ lower', () => {
        const hot = bvToKelvin(0.0)!, cool = bvToKelvin(1.5)!;
        expect(hot).toBeGreaterThan(cool);
        expect(hot).toBeGreaterThan(5000);   // B−V=0 ≈ ~7000K
        expect(bvToKelvin(null)).toBeNull();
    });
    it('rgbColorIndex: bluer ⇒ more negative, needs positive R and B', () => {
        expect(rgbColorIndex([1, 0.8, 1])! < rgbColorIndex([1, 0.8, 0.2])!).toBe(true);
        expect(rgbColorIndex([0, 0.5, 1])).toBeNull();
        expect(rgbColorIndex(null)).toBeNull();
    });
    it('measuredBcShiftPx: ~0 at optical center, grows off-axis', () => {
        const coeffs = { k1: { value: 0.0016 }, k2: { value: -0.0006 } };
        const atCenter = measuredBcShiftPx(1000, 1000, coeffs, 1000, 1000, 2000);
        const offAxis = measuredBcShiftPx(2000, 2000, coeffs, 1000, 1000, 2000);
        expect(atCenter).toBeCloseTo(0, 6);
        expect(offAxis).toBeGreaterThan(atCenter);
    });
    it('sipShiftPx: 0 at crpix, non-zero off-crpix, no-op without coeffs', () => {
        const a = [[0, 0], [1e-6, 0]], b = [[0, 1e-6], [0, 0]];
        expect(sipShiftPx(500, 500, a, b, 500, 500)).toBeCloseTo(0, 9);
        expect(sipShiftPx(1500, 1500, a, b, 500, 500)).toBeGreaterThan(0);
        expect(sipShiftPx(1500, 1500, null, null, 500, 500)).toBe(0);
    });
    it('tpsShiftPx: no control points ⇒ 0, affine-only evaluates', () => {
        expect(tpsShiftPx(10, 10, null)).toBe(0);
        const tps = { scale: 100, crpix: [0, 0] as [number, number], control_points: [[0, 0]], weights_x: [0], weights_y: [0], affine: { dx: [2, 0, 0] as [number, number, number], dy: [0, 0, 0] as [number, number, number] } };
        expect(tpsShiftPx(0, 0, tps)).toBeCloseTo(2, 6); // affine dx0=2, kernel 0
    });
    it('logHistogram: bins positive values, null on empty', () => {
        expect(logHistogram([], 5)).toBeNull();
        expect(logHistogram([-1, 0], 5)).toBeNull();
        const h = logHistogram([1, 10, 100, 1000], 4)!;
        expect(h.counts.reduce((s, c) => s + c, 0)).toBe(4);
        expect(h.lo).toBe(1); expect(h.hi).toBe(1000);
    });
    it('binGrid: row-major counts, clamps out-of-frame', () => {
        const counts = binGrid([{ x: 0, y: 0 }, { x: 99, y: 99 }, { x: 200, y: 200 }], 100, 100, 2, 2);
        expect(counts).toHaveLength(4);
        expect(counts[0]).toBe(1);          // top-left
        expect(counts[3]).toBe(2);          // bottom-right (99,99 + clamped 200,200)
    });
});
