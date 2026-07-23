/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: CALIBRATE — hardware profiling + astrometric refinement (C1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (consumes the solved WCS + matched-star residuals;
 * star flux samples are read-only forensic inputs, never written back).
 *
 * ONE implementation of the post-solve calibration work that both pipelines
 * perform (or should):
 *
 *   - `applyAstrometricRefinement`: ResidualAnalyzer residual RMS + SIP
 *     polynomial fit, LANDED on `solution.astrometry` (both paths used to
 *     compute-then-drop this at various points in history). Non-fatal by
 *     contract (session semantics adopted): an analysis failure warns and
 *     returns null, it never kills the pipeline.
 *   - `buildStarMeasurements` + `generateHardwareProfile`: the spectral-
 *     forensics input mapping (per-channel peak samples peeked from the
 *     linear frame + catalog color, riding on the matched detections) and
 *     the HardwareProfiler report.
 *
 * WCS key convention (design-doc landmine, calibrate stage): the engine's
 * fitted WCS uses `crpix[0]` / `crpix[1]` ARRAY keys — NOT FITS-style
 * CRPIX1/CRPIX2 header names. FITS-card naming appears only at receipt
 * serialization (generateWCS / package stage).
 */

import { HardwareProfiler } from '../m2_hardware/hardware_profiler';
import { ResidualAnalyzer, type ResidualAnalysis } from '../m7_astrometry/residual_analyzer';
import { fitTpsGated } from '../m6_plate_solve/tps_fitter';
import type {
    HardMetadata,
    HardwareProfile,
    PlateSolution,
    SignalPacket,
    SignalPoint,
    StarMeasurement
} from '../../types/Main_types';

// ——— ASTROMETRIC REFINEMENT (M7) —————————————————————————————————————————————

/**
 * Run the M7 residual analysis + SIP fit and land it on
 * `solution.astrometry` (mutates the solution — that IS the landing).
 * Returns the analysis for caller-side logging, or null on (non-fatal)
 * failure.
 */
export function applyAstrometricRefinement(solution: PlateSolution): ResidualAnalysis | null {
    try {
        const analysis = ResidualAnalyzer.analyze(solution);
        solution.astrometry = {
            rms_arcsec: analysis.rms_arcsec,
            distortion_detected: analysis.distortion_pattern_detected,
            sip: analysis.sip_coefficients
        };

        // TPS distortion fit — a non-polynomial companion to SIP, carried into
        // ASDF/GWCS as a tabular lookup. FIRE-GATE is the SAME as SIP (reused, not
        // reinvented): rms > 1.2" (distortion_pattern_detected) AND > 20 matched
        // stars. The SeeStar/M66 frame FIRES (rms ≈ 31") but is now EMISSION-GATED:
        // fitTpsGated runs out-of-sample CV — an interpolating spline whose in-sample
        // rms_after (≈3") does NOT generalize (measured OOS ≈ 35") is REFUSED
        // (tps:null) with a `tps_gate` verdict recording why (honest-or-absent). The
        // SIP block and every asserted SOLVE field are untouched — TPS is a post-
        // solve COORDINATE observation, so the pinned SeeStar/CR2 numbers stay
        // byte-identical (only the honest TPS emission changes). Non-fatal: any
        // failure here defaults to no TPS and never disturbs the SIP block.
        if (analysis.distortion_pattern_detected && countRefinablePairs(solution) > 20) {
            try {
                const { tps, gate } = fitTpsGated(solution);
                solution.astrometry.tps = tps;            // model when admitted, else null (explicit)
                solution.astrometry.tps_gate = gate;      // ALWAYS recorded — the WHY (honest evidence)
            } catch (tErr) {
                console.warn('[Calibrate] M6 TPS gate failed (non-fatal):', tErr);
            }
        }
        return analysis;
    } catch (err) {
        console.warn('[Calibrate] M7 residual analysis failed (non-fatal):', err);
        return null;
    }
}

/**
 * Count matched stars usable for a distortion fit, using the EXACT filter the SIP
 * fitter applies (planet sentinels + residual ≥ 999 excluded). Kept identical to
 * ResidualAnalyzer.analyze so the TPS fire gate mirrors SIP's `matches > 20`.
 */
function countRefinablePairs(solution: PlateSolution): number {
    return (solution.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) &&
        m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_')
    ).length;
}

// ——— HARDWARE PROFILING (M2 forensics) ———————————————————————————————————————

/**
 * Spectral-forensics input: the solved matched stars carry everything the
 * profiler needs — peeked per-channel peak values (the step-2 spectral LUT
 * rides along on the detected SignalPoint) + catalog color. Detections
 * without per-channel samples are dropped (they carry no spectral signal).
 */
export function buildStarMeasurements(solution: PlateSolution): StarMeasurement[] {
    return (solution.matched_stars ?? [])
        .map(m => {
            const d = m.detected as unknown as SignalPoint;
            return {
                x: d.x,
                y: d.y,
                flux: d.flux ?? 0,
                fwhm: d.fwhm ?? 0,
                flux_r: d.peak_rgb?.[0],
                flux_g: d.peak_rgb?.[1],
                flux_b: d.peak_rgb?.[2],
                measured_bv: d.measured_bv,
                catalog_bv: m.catalog.bv,
                circularity: d.circularity,
                theta: d.theta
            };
        })
        .filter(s => s.flux_r !== undefined);
}

/** Forensic hardware report from the solved plate + signal statistics. */
export function generateHardwareProfile(
    solution: PlateSolution,
    metadata: HardMetadata,
    signal: SignalPacket
): HardwareProfile {
    return HardwareProfiler.generateReport(
        solution,
        metadata,
        buildStarMeasurements(solution),
        signal
    );
}
