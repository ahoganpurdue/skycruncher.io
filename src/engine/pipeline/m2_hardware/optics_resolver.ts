/**
 * ═════════════════════════════════════════════════════════════════════
 * OPTICS RESOLVER — EXIF-derived pixel scale (ROADMAP Phase B, B2)
 * ═════════════════════════════════════════════════════════════════════
 *
 * Kills the 15-second blind Tri-Lock default for DSLR frames: when the
 * file carries no header pixel scale (FITS XPIXSZ/FOCALLEN path) but DOES
 * carry an EXIF focal length and a camera body we have a sensor profile
 * for, the pixel scale is plain geometry:
 *
 *     scale ["/px] = 206.265 × pitch [µm] / FL [mm]
 *
 * (Same formula as m2_hardware/hardware_adapter.computePixelScale — the
 * 206265"/rad small-angle constant with the µm→mm folding pre-applied.)
 *
 * The EXIF focal length is NOMINAL (lens-reported, zoom-quantized), so
 * this result seeds the solver but does NOT earn the FITS-header trust
 * skip: Vector Consensus remains the refiner on the DSLR path.
 */

import { HardMetadata } from '../../types/schema';
import { OpticsManager } from '../../core/optics_manager';
import type { OpticsHint } from '../../core/optics_hint_provider';
import { findSensorByCamera } from './sensor_db';

/** Result of a successful EXIF→sensor-DB optics resolution. */
export interface ResolvedOptics {
    /** Pixel scale in arcsec/px (206.265 × pitch / FL). */
    pixel_scale: number;
    /** Sensor pixel pitch in µm, sourced from SENSOR_DB. */
    pixel_pitch_um: number;
    /** Provenance marker: EXIF focal length + sensor-database pitch. */
    source: 'EXIF_SENSOR_DB';
    /**
     * The labelled ASSUMPTION (if any) that produced the focal length used for
     * this scale — null when the FL was trusted evidence. Carried so the scale
     * lock can record the assumption in the receipt (`optics_hints`).
     */
    hint: OpticsHint | null;
}

/**
 * Pure pixel-scale geometry: 206.265 × pitch(µm) / FL(mm) = arcsec/px.
 * Returns Infinity/NaN garbage only if fed garbage — callers gate FL > 0.
 */
export function computeScaleFromOptics(focalLengthMm: number, pixelPitchUm: number): number {
    return 206.265 * pixelPitchUm / focalLengthMm;
}

/**
 * Resolve pixel scale from EXIF metadata + the sensor database.
 *
 * - Focal length goes through OpticsManager.getEffectiveFocalLength so the
 *   dummy-50mm manual-lens pattern (FL=50, no lens model) is corrected first.
 * - Pixel pitch comes from SENSOR_DB via the camera body string.
 *
 * Returns null when the focal length is absent/non-positive, the camera
 * model is empty (an empty search term would substring-match EVERY sensor
 * profile), or no sensor profile exists for the body.
 */
export function resolveOpticsFromExif(hard: HardMetadata): ResolvedOptics | null {
    // Hint-aware resolve: value_mm is byte-identical to getEffectiveFocalLength(hard);
    // .hint carries any labelled assumption (wide-field prior) for the receipt.
    const fl = OpticsManager.resolveFocalLengthWithHint(hard);
    const focalLength = fl.value_mm;
    if (focalLength === undefined || !(focalLength > 0)) return null;

    const cameraModel = hard.camera_model?.trim();
    if (!cameraModel) return null;

    const profile = findSensorByCamera(cameraModel);
    if (!profile || !(profile.pixel_size_um > 0)) return null;

    return {
        pixel_scale: computeScaleFromOptics(focalLength, profile.pixel_size_um),
        pixel_pitch_um: profile.pixel_size_um,
        source: 'EXIF_SENSOR_DB',
        hint: fl.hint,
    };
}
