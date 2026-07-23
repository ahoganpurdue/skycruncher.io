/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: DETECT — extraction + culling + curation (C1 consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (consumes pixel buffers, emits detections; never touches WCS).
 *
 * ONE home for the detection logic previously forked across the two
 * orchestrators. The two pipelines legitimately detect on DIFFERENT buffer
 * types today (preserved deliberately, not silently):
 *
 *   - Auto path (`detectStarsFromImage`): SourceExtractor on the preview
 *     ImageData, then raw-coordinate preservation + baseline lens flattening
 *     (the rectilinear sequence — flatten BEFORE metrology so Vector
 *     Consensus sees the true pinhole scale).
 *   - Wizard path (`detectSignal`): SignalProcessor on the science buffers —
 *     native Bayer (2x2 binned, Uint16) when available, luminance Float32
 *     otherwise. The branch predicate is exported (`isNativeBayer`) so the
 *     wizard's status strings use the same condition as the dispatch.
 *
 * `selectCuratedStars` is the curation half of landmine #3: BOTH pipelines
 * forward pre-detected stars to autoSolvePlate's third parameter
 * (`existingStars`) — verified same parameter, call sites in
 * orchestrator.ts (processedStars) and orchestrator_session.ts (curated).
 *
 * No orchestrator state reach-back; manifest transactions stay in callers.
 */

import { SourceExtractor } from '../m4_signal_detect/source_extractor';
import { SignalProcessor } from '../m4_signal_detect/signal_processor';
import { GenericFlattener } from '../m5_coordinate_flatten/generic_flattener';
import type { DistortionProfile } from '../m2_hardware/lens_database_adapter';
import type { DetectedStar, SignalPacket } from '../../types/Main_types';
import type { FlatteningStatus } from '../../types/Main_types';
import type { TelemetryLogger } from '../../diagnostics/telemetry_logger';
import type { ScaleManager } from '../m2_hardware/scale_manager';

// ——— AUTO PATH: ImageData extraction + baseline flattening ——————————————————

export interface ImageDetectOutput {
    /** Raw extractor output (stars in image space, pre-flattening). */
    result: { stars: DetectedStar[]; planets?: DetectedStar[]; anomalies?: DetectedStar[] };
    /** Detections with original sensor coordinates preserved (forensic traceability). */
    rawStars: DetectedStar[];
    /** Rectilinear-space detections (baseline profile applied, or a copy of rawStars). */
    flattenedStars: DetectedStar[];
}

/**
 * Extract stars from decoded ImageData and map them to rectilinear space
 * using the baseline lens profile (when one exists). This runs BEFORE any
 * metrology so downstream scale inference sees the true pinhole geometry.
 */
export async function detectStarsFromImage(
    image: ImageData,
    sigma: number,
    baselineDistortion: DistortionProfile | null
): Promise<ImageDetectOutput> {
    const result = await SourceExtractor.extractStars(image, sigma);
    const stars = result.stars;

    // Preserve raw coordinates for forensic traceability
    const rawStars: DetectedStar[] = stars.map(s => ({
        ...s,
        rawX: s.x,
        rawY: s.y,
        flatteningStatus: 'UNFLATTENED' as FlatteningStatus
    }));

    // Map to rectilinear space using the baseline profile
    let flattenedStars: DetectedStar[];
    if (baselineDistortion) {
        console.log(`[Orchestrator] Applying Baseline Flattening to ${rawStars.length} stars...`);
        flattenedStars = await GenericFlattener.flattenPoints(
            rawStars,
            image.width,
            image.height,
            baselineDistortion
        );
        flattenedStars.forEach(s => s.flatteningStatus = 'GENERIC_FLATTENED');
    } else {
        flattenedStars = [...rawStars];
    }

    return { result, rawStars, flattenedStars };
}

// ——— WIZARD PATH: science-buffer signal detection ————————————————————————————

export interface RawSensorLike {
    data: Uint16Array | Float32Array;
    width: number;
    height: number;
    stride?: number;
    isDemosaiced?: boolean;
}

/** True when native (un-demosaiced Uint16) Bayer detection applies. */
export function isNativeBayer(
    rawSensor: RawSensorLike | null
): rawSensor is RawSensorLike & { data: Uint16Array } {
    return !!rawSensor && !rawSensor.isDemosaiced && rawSensor.data instanceof Uint16Array;
}

export interface SignalDetectParams {
    /** Decoded sensor payload — drives the native-Bayer branch when eligible. */
    rawSensor: RawSensorLike | null;
    /** Luminance Float32 science buffer (w*h). */
    scienceBuffer: Float32Array;
    /** Preview-sized RGB Float32 (display buffer) — masking support, may be null. */
    previewFloat32: Float32Array | null;
    width: number;
    height: number;
    logger: TelemetryLogger;
    scales?: ScaleManager;
    focalLength?: number;
    metadata?: any;
    /**
     * Optional externally-measured terrain silhouette (per-pixel horizon y).
     * When omitted, SignalProcessor DERIVES one from the vanguard detections
     * (detection-envelope method), gated on measured terrain evidence. Supplied
     * here purely as an injection seam for a future boundary detector.
     */
    horizonVector?: Uint16Array;
}

/**
 * Detect signal (stars + anomalies) with 3-pass masking & morphological
 * filtering. Chooses native Bayer (2x2 binning) vs luminance detection —
 * the branch that used to live inline in OrchestratorSession.step2.
 *
 * The terrain silhouette used for foreground culling is normally DERIVED
 * inside SignalProcessor from the star field itself (detection-envelope,
 * evidence-gated). `p.horizonVector` overrides that when a dedicated boundary
 * detector supplies one; leaving it undefined is the standard path.
 */
export async function detectSignal(p: SignalDetectParams): Promise<SignalPacket> {
    if (isNativeBayer(p.rawSensor)) {
        console.log("[Session] Running NATIVE Bayer Signal Detection (2x2 Binning)...");
        return SignalProcessor.analyzeBayerNative(
            p.rawSensor.data,
            p.rawSensor.width,
            p.rawSensor.height,
            p.rawSensor.stride || p.rawSensor.width, // [FIX] Fallback to width if stride is undefined
            p.logger,
            p.scales,
            p.focalLength,
            p.metadata,
            p.horizonVector
        );
    }
    console.log("[Session] Running Standard luminance Detection...");
    return SignalProcessor.analyzeWithMasking(
        p.scienceBuffer,
        p.previewFloat32,
        p.width,
        p.height,
        p.logger,
        p.focalLength,
        p.metadata,
        p.horizonVector
    );
}

// ——— CURATION: forwarding detections to the solver (landmine #3) ————————————

/**
 * The double-extraction fix: forward the curated float-precision detections
 * to the solver instead of letting it re-extract from the 8-bit solve buffer
 * — but ONLY when they share the solve buffer's pixel space (unbinned
 * science buffer). Binned fallback paths return undefined (solver extracts).
 */
export function selectCuratedStars(
    scienceBuffer: Float32Array | null,
    imageWidth: number,
    imageHeight: number,
    signal: SignalPacket | null
): SignalPacket['clean_stars'] | undefined {
    return (!scienceBuffer || scienceBuffer.length === imageWidth * imageHeight)
        ? (signal?.clean_stars ?? undefined)
        : undefined;
}
