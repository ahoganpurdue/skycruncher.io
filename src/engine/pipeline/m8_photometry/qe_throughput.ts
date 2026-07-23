/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CELL ④ — SENSOR QE THROUGHPUT (SPCC per-band flux divide-out; STAR-DATA ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sensor's quantum-efficiency curve (sensor_db `qe_curve`) is a per-band
 * throughput term: a photon of wavelength λ is recorded with efficiency QE(λ),
 * so the extracted per-band flux is biased by the sensor's spectral response.
 * To recover the pre-sensor per-band flux we DIVIDE OUT the QE at each band's
 * representative wavelength — exactly the "undo the filter" idiom of
 * `filter_profiles.computeFilterInverse` (multiply observed RGB by 1/response),
 * applied here to the sensor's QE instead of a filter's transmission.
 *
 * MEASUREMENT-LEVEL correction (LAW 1, four-layer PSF doctrine): the EXTRACTION
 * still happens on untouched native pixels at the coordinate-supplied position;
 * only the EXTRACTED per-band quantity is corrected (`flux *= factor`). NEVER a
 * buffer pre-warp. Representative wavelengths mirror computeFilterInverse:
 *   R = 620 nm · G = 530 nm · B = 450 nm.
 *
 * DEFAULT OFF. `VITE_SPCC_QE_THROUGHPUT=true` (or '1') turns the divide-out on
 * inside `computeSpccCalibration`. Read at CALL time (never cached at module
 * load) so a harness can toggle per-run — same seam discipline as
 * `isRawlerDecoderEnabled` / `isStackingEnabled`, with the OFF arm as the
 * byte-identical default (any env-read error → false).
 *
 * HONESTY (LAW 3): the `approximate` flag is carried straight from the resolved
 * sensor profile's `qe_approximate` marker (sensor_db) into the returned block,
 * so any reported product keeps the APPROXIMATE label. A body whose profile does
 * not resolve, or carries no `qe_curve`, yields `null` — an honest SKIP, never a
 * fabricated correction.
 *
 * Browser: vite env exposure (import.meta.env). Node: process.env fallback.
 */

import { interpolateQE, type SensorProfile } from '../m2_hardware/sensor_db';

/** CELL ④ representative band wavelengths (nm), mirroring computeFilterInverse. */
export const QE_BAND_WAVELENGTHS_NM = { r: 620, g: 530, b: 450 } as const;

/** Per-band QE throughput divide-out context. */
export interface QeThroughput {
    /** Multiplicative divide-out factor per band = 1/QE(λ_band). Multiply the
     *  extracted flux by this to remove the sensor's spectral-response bias. */
    factor: { r: number; g: number; b: number };
    /** Raw interpolated QE at each band's representative wavelength. */
    qe: { r: number; g: number; b: number };
    /** Representative wavelength (nm) used per band. */
    wavelengthNm: { r: number; g: number; b: number };
    /** Sensor chip model (provenance). */
    sensorModel: string;
    /** TRUE when the source qe_curve is datasheet-approximate / borrowed /
     *  placeholder (sensor_db `qe_approximate`). Honest label — carried through
     *  to any reported product. */
    approximate: boolean;
}

/**
 * Is the CELL ④ QE-throughput divide-out enabled? DEFAULT OFF. Read at call
 * time; browser `import.meta.env` first, then Node `process.env`. Any error →
 * false (the OFF arm is the byte-identical default).
 */
export function isQeThroughputEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_SPCC_QE_THROUGHPUT;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_SPCC_QE_THROUGHPUT;
        }
        return v === '1' || v === 'true';
    } catch {
        return false;
    }
}

/**
 * Build the per-band QE throughput context from a resolved sensor profile.
 * Mirrors `filter_profiles.computeFilterInverse`: interpolate the response at
 * three representative wavelengths and return 1/response divide-out factors,
 * clamping a near-zero response to a factor of 1 (never amplify noise on a dead
 * band). Returns `null` — an honest SKIP — when no profile resolves or the
 * profile carries no usable qe_curve.
 */
export function computeQeThroughput(profile: SensorProfile | null | undefined): QeThroughput | null {
    if (!profile || !profile.qe_curve || profile.qe_curve.length === 0) return null;

    const curve = profile.qe_curve;
    const qeR = interpolateQE(curve, QE_BAND_WAVELENGTHS_NM.r);
    const qeG = interpolateQE(curve, QE_BAND_WAVELENGTHS_NM.g);
    const qeB = interpolateQE(curve, QE_BAND_WAVELENGTHS_NM.b);

    // Same guard as computeFilterInverse (pass > 0.01 ? 1/pass : 1): a dead band
    // stays a no-op factor of 1 rather than exploding the flux.
    const factor = (qe: number): number => (qe > 0.01 && Number.isFinite(qe) ? 1.0 / qe : 1.0);

    return {
        factor: { r: factor(qeR), g: factor(qeG), b: factor(qeB) },
        qe: { r: qeR, g: qeG, b: qeB },
        wavelengthNm: { ...QE_BAND_WAVELENGTHS_NM },
        sensorModel: profile.sensor_model,
        approximate: profile.qe_approximate === true,
    };
}
