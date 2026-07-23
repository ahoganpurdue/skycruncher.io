/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * ASTRO-PACKET SERIALIZER â€” Lightweight Scientific Data Storage
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE VISION:
 * "Strip" a 50MB RAW file into a <100KB scientific packet.
 * Thousands of observations stored in the space of one photo.
 *
 * THE PACKET:
 * 1. Plate Solution (Where was the camera pointed?)
 * 2. Hardware Fingerprint (What camera/lens/filter was used?)
 * 3. Star List (Calculated photometry for every detected star)
 * 4. Sky Metrics (Background noise, seeing, cloud cover)
 * 5. Thumbnails (Tiny 64x64 patches of anomalous objects)
 */

import type { PlateSolution, DetectedStar } from '../../types/Main_types';
import type { ColorFidelity, SpccChannelGains } from '../m8_photometry/spcc_calibrator';
import type { AstroStateKey } from '../../types/schema';
import { SCIENCE_PACKET_VERSION } from '../stages/schema_versions';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface StarMeasurement extends DetectedStar {
    /** Calibrated B-V index */
    bv_calibrated: number;
    /** Fit scatter (SPCC color-regression RMSE); absent when no calibration ran */
    sigma?: number;
    /** Calibrated magnitude (instrumental + SPCC zero-point); absent when no
     *  zero-point fit ran — the catalog magnitude travels in `magnitude`. */
    mag_calibrated?: number;
    /** Background-subtracted per-channel aperture flux (ADU) — SPCC path only */
    flux_r?: number;
    flux_g?: number;
    flux_b?: number;
    /** Raw instrumental magnitude (pre zero-point) — SPCC path only */
    mag_instrumental?: number;
    /** True when any aperture pixel exceeded the saturation threshold */
    saturated?: boolean;
}

/** SPCC (Spectrophotometric Color Calibration) telemetry block */
export interface SpccBlock {
    /** 'SPCC_RGB' when the color regression converged; 'UNCALIBRATED' otherwise */
    source: 'SPCC_RGB' | 'UNCALIBRATED';
    color_slope: number;
    color_intercept: number;
    color_r2: number;
    color_rmse: number;
    zeropoint: number;
    zp_rmse: number;
    n_stars: number;
    air_mass: number;
    /** Color-fidelity report surface (§4.1): survivor vs unclipped r2/rmse + a
     *  TLS/EIV slope bracket. MEASURED evidence, never a gate; null when the color
     *  fit is invalid. Absent block entirely when SPCC did not run (FITS-only). */
    fidelity: ColorFidelity | null;
    /** SPCC-derived render-lane white-balance gains (§3.2): TLS-fit per-channel
     *  gains + quality gate + `applied` flag. ALWAYS recorded when SPCC ran
     *  (record-always, whether or not applied to pixels); null only if the gain
     *  fit could not run. The whole SPCC block is absent when SPCC did not run. */
    gains: SpccChannelGains | null;
    /** CELL ② — per-band vignette/transmission map DIVIDED into the extracted
     *  fluxes feeding the color/zp fits, or null when PSF_FLUX_VIGNETTE_CORRECT
     *  was OFF (default → null on the pinned SeeStar solve). Additive. */
    vignette?: Record<string, unknown> | null;
    /** CELL ③ — per-star atmospheric-extinction correction applied to the fluxes
     *  feeding the zero-point, or null when PSF_FLUX_EXTINCTION_CORRECT was OFF
     *  (default → null on the pinned SeeStar solve). Additive. */
    extinction?: {
        k: number; k_source: 'DEFAULT' | 'MEASURED'; airmass: number; applied: boolean; note: string;
    } | null;
}

/**
 * Global sky-quality metrics. Every field is optional and REAL-OR-ABSENT:
 * an absent field means "not measured on this path" — never a placeholder.
 */
export interface SkyMetrics {
    /** Average sky background (ADU) */
    background_level?: number;
    /** Read noise estimate (electrons) */
    noise_floor?: number;
    /** Median measured FWHM of photometry stars (pixels) */
    seeing_fwhm?: number;
    /** Estimated cloud coverage percentage (0-1) */
    cloud_cover?: number;
}

export interface AstroSciencePacket {
    version: string;
    id: string;
    timestamp: string;
    location: { lat: number; lon: number; alt: number };

    /** The "Where" (Plate Solution) */
    solution: PlateSolution;
    /** The "How" (Compressed StateKey) */
    state_key: AstroStateKey;
    /** The "Who" (Hardware Fingerprint) */
    fingerprint: string;

    /** Global sky quality */
    metrics: SkyMetrics;

    /** The Meat: Photometric data for every star */
    stars: StarMeasurement[];

    /** Optional: Tiny JPEGs of regions of interest (Base64) */
    thumbnails?: Record<string, string>;

    /** Optional: SPCC photometric calibration telemetry (FITS/RGB path) */
    spcc?: SpccBlock;
}

// â”€â”€â”€ SERIALIZATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Serialize an AstroPacket to a compact JSON string.
 */
export function serializePacket(packet: AstroSciencePacket): string {
    return JSON.stringify(packet);
}

/**
 * Compress a packet into a binary buffer using MsgPack-like encoding
 * or simple GZIP for transmission.
 *
 * @stub Simple JSON for now, will move to Protobuf/MsgPack for Phase 9.
 */
export async function compressPacket(packet: AstroSciencePacket): Promise<Uint8Array> {
    const str = serializePacket(packet);
    const encoder = new TextEncoder();
    return encoder.encode(str);
}

// â”€â”€â”€ PACKET BUILDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Construct an AstroPacket from independent pipeline results.
 */
export function buildAstroPacket(
    id: string,
    timestamp: string,
    location: { lat: number; lon: number; alt: number },
    solution: PlateSolution,
    stateKey: AstroStateKey,
    fingerprint: string,
    metrics: SkyMetrics,
    stars: StarMeasurement[],
    thumbnails?: Record<string, string>,
    spcc?: SpccBlock
): AstroSciencePacket {
    return {
        version: SCIENCE_PACKET_VERSION,
        id,
        timestamp,
        location,
        solution,
        state_key: stateKey,
        fingerprint,
        metrics,
        stars,
        thumbnails,
        spcc,
    };
}

/**
 * Estimate the weight of a packet vs a RAW file.
 */
export function computeCompressionEfficiency(
    rawSizeMb: number,
    packet: AstroSciencePacket
): number {
    const packetSizeKb = serializePacket(packet).length / 1024;
    const rawSizeKb = rawSizeMb * 1024;
    return rawSizeKb / (packetSizeKb || 1);
}

