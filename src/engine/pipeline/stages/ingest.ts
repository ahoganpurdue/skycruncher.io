/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: INGEST — decode -> science buffers (C1 consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (decodes the source bitstream into sensor/RGB buffers).
 *
 * BUFFER OWNERSHIP CONTRACT (divergence #10):
 *   - This stage BORROWS `rawBuffer` for the duration of the call and
 *     retains NO reference to it. The caller owns the release: the wizard
 *     session nulls its `rawBuffer` before step 2 returns — which is WHY
 *     step-1 re-entry is forbidden (the Back button hides step 1).
 *   - The returned `fullRGB` may alias the decoder's own buffer (FITS
 *     stacked cubes) — treat it as the single owned copy, do not mutate.
 *   - `rgbBuffer` (GPU) is returned only when the WebGPU demosaic ran; the
 *     caller owns its lifetime (preview generation consumes it).
 *
 * DELIBERATE NON-ADOPTION (documented, not silent): runPipeline keeps its
 * own ingest chain (metadata extract -> stamping -> raw_extraction ->
 * FITS-parameterized demosaic) — those runStage boundaries are load-bearing
 * telemetry stage IDs, its demosaic is FITS-CFA parameterized (header Bayer
 * pattern + BIAS levels) where the wizard's is not, and its Arrow/GPU-VRAM
 * residency flow has no wizard equivalent. Folding them would change
 * telemetry contracts and buffer lifetimes on a path no E2E guards. As a
 * one-shot fold, runPipeline also retains nothing after return — "release
 * early" has no observable meaning there (the CALLER owns the ArrayBuffer).
 *
 * KNOWN DORMANT DIVERGENCE (not in the original landmine map): the wizard
 * demosaic below passes no FITS CFA parameters — a FITS SUB-FRAME (CFA)
 * upload through the wizard would demosaic with DSLR defaults. Stacked
 * FITS (the supported wizard flow) arrives already demosaiced, so the
 * branch is dormant today. Unify with runPipeline's parameterization when
 * the wizard officially accepts CFA FITS.
 */

import { metadata_reaper, extractRawSensorData } from '../m1_ingestion/metadata_reaper';
import { isRawlerDecoderEnabled, type RawlerCfaRecord } from '../m1_ingestion/rawler_decoder';
import { demosaicWebGPU } from '../m3_gpu_preprocess/demosaic_pipeline';
import type { ComputeRouteStamp } from '../m3_gpu_preprocess/compute_routes';
import { computeRouteStamp } from '../m3_gpu_preprocess/compute_routes';
import { BayerStorageService } from '../m3_gpu_preprocess/bayer_storage_service';
import { ImageProcessor } from '../../core/ImageProcessor';

export interface DecodedSensorPayload {
    data: Uint16Array | Float32Array;
    width: number;
    height: number;
    stride: number;
    isDemosaiced: boolean;
    /**
     * True when the "demosaiced" RGB is really a per-site single-colour CFA
     * mosaic (LibRaw noInterpolation output). Routes the detection-luminance
     * reduction away from Rec.709 weights, which would imprint a 2px period-2
     * checkerboard. Set by metadata_reaper.convertMemImageToRgb; absent/false
     * for genuinely demosaiced RGB (FITS RGB cubes, JPEG).
     */
    cfaMosaicLuma?: boolean;
    /**
     * [RAIL #14] Additive rawler decode calibration record (WB / levels / CFA
     * pattern / optical-black harvest). Present ONLY on a cache-miss rawler decode
     * (extractRawSensorData → decodeRawlerForPipeline); absent on the libraw path,
     * FITS, demo-tier, AND on a cache HIT (the Bayer cache stores pixels only, not
     * this record). The session reduces it to the lean receipt calibration. */
    rawler?: RawlerCfaRecord;
}

export interface DecodedScienceFrame {
    /** Decoded sensor payload (cache-backed) — drives native-Bayer detection. */
    rawSensor: DecodedSensorPayload;
    /** Full-resolution interleaved linear RGB (may alias the decoder buffer). */
    fullRGB: Float32Array;
    width: number;
    height: number;
    /** GPU-resident RGB — present only when the WebGPU demosaic ran. */
    rgbBuffer?: GPUBuffer;
    /** [COMPUTE-ROUTE OBSERVABILITY] Honest stamps for the demosaic seam: either the
     *  route the WebGPU demosaic ACTUALLY took (native_wgpu / webgpu / cpu) or a
     *  'skipped' stamp when the payload arrived already demosaiced (the invisible
     *  skip both sacred lanes take). The session merges these into the receipt's
     *  `compute_routes` block. */
    computeRoutes: ComputeRouteStamp[];
}

/**
 * Cheap content fingerprint for the decode-cache key: 32-bit FNV-1a over a
 * BOUNDED sample of the buffer (4KB head + 4KB tail + ≤2048 strided middle
 * probes + the length), so two DIFFERENT frames that happen to share
 * byteLength and a missing/equal EXIF timestamp can no longer collide onto
 * one cache row and hand the second frame the FIRST frame's pixels
 * (ultracode HELD #17). NOT cryptographic and NOT exhaustive — a cache-key
 * discriminator only (the exhaustive content sha lives in the
 * source-provenance resolver; hashing a full 30MB RAW here would tax the
 * ingest hot path for no cache benefit).
 */
export function contentFingerprint(buffer: ArrayBuffer): string {
    const view = new Uint8Array(buffer);
    const n = view.length;
    let h = 0x811c9dc5 >>> 0;                       // FNV-1a offset basis
    const mix = (byte: number) => {
        h = Math.imul(h ^ byte, 0x01000193) >>> 0;  // FNV-1a prime
    };
    const edge = Math.min(4096, n);
    for (let i = 0; i < edge; i++) mix(view[i]);                       // head
    for (let i = Math.max(edge, n - 4096); i < n; i++) mix(view[i]);   // tail
    if (n > 8192) {                                                    // strided middle
        const stride = Math.max(1, Math.floor((n - 8192) / 2048));
        for (let i = 4096; i < n - 4096; i += stride) mix(view[i]);
    }
    mix(n & 0xff); mix((n >>> 8) & 0xff); mix((n >>> 16) & 0xff); mix((n >>> 24) & 0xff);
    return h.toString(16).padStart(8, '0');
}

/** Decode-cache key: length + content fingerprint + capture timestamp. */
export function bayerCacheKey(rawBuffer: ArrayBuffer, metadataTimestamp: string | undefined): string {
    return `bayer_${rawBuffer.byteLength}_${contentFingerprint(rawBuffer)}_${metadataTimestamp || 'unknown'}`;
}

/**
 * [COMPUTE-ROUTE OBSERVABILITY] Honest reason for a SKIPPED demosaic — WHY the
 * payload was already demosaiced when it reached this stage. Names the producer:
 *   • FITS stacks arrive already demosaiced ⇒ 'pre_demosaiced_stacked'
 *   • RAW DSLR frames decode straight to RGB via the active decoder arm — rawler
 *     (default) or libraw (cold path / forced for X-Trans RAF) ⇒ arm-named
 *   • non-RAW browser-decoded inputs (JPEG/TIFF) ⇒ 'pre_demosaiced_browser'
 * Never a lie (LAW 3): the arm is read from the SAME flag the decode branch used.
 */
export function preDemosaicReason(sourceFormat: string): string {
    if (sourceFormat === 'FITS') return 'pre_demosaiced_stacked';
    // RAF (Fuji X-Trans) is FORCED onto libraw (the rawler rail has no X-Trans);
    // other RAW DSLR formats follow the default flag.
    const RAW_FORMATS = new Set(['CR2', 'CR3', 'NEF', 'ARW', 'RAF', 'DNG']);
    if (RAW_FORMATS.has(sourceFormat)) {
        return (sourceFormat === 'RAF' || !isRawlerDecoderEnabled())
            ? 'pre_demosaiced_libraw'
            : 'pre_demosaiced_rawler';
    }
    // JPEG / TIFF / UNKNOWN → browser (ImageProcessor.decodeFullResImage) produced RGB.
    return 'pre_demosaiced_browser';
}

/**
 * Decode the source bitstream into science buffers: cache-first sensor
 * decode (LibRaw / FITS / browser JPEG), then the "double-jeopardy" check —
 * already-demosaiced payloads pass through, Bayer payloads go through the
 * WebGPU demosaic. Status strings are produced HERE (injected onStatus)
 * so the copy cannot fork.
 */
export async function decodeScienceFrame(
    rawBuffer: ArrayBuffer,
    sourceFormat: string,
    metadataTimestamp: string | undefined,
    onStatus?: (status: string) => void
): Promise<DecodedScienceFrame> {
    // [NATIVE OPTIMIZATION] Check Cache First. Key carries a content
    // fingerprint — byteLength+timestamp alone collided across frames.
    // (Old-format keys simply miss and re-decode: a cache, not a contract.)
    const cacheKey = bayerCacheKey(rawBuffer, metadataTimestamp);
    let rawSensor: DecodedSensorPayload | null = await BayerStorageService.retrieve(cacheKey);

    if (rawSensor) {
        console.log(`[Session] Cache hit for image buffer. Skipping decoding.`);
    } else {
        console.log(`[Session] Cache MISS. Decoding bitstream...`);

        // [FIX] Separate RAW vs JPEG decoding paths
        const isRaw = await metadata_reaper.isRawFile(rawBuffer);

        if (isRaw) {
            if (sourceFormat === 'FITS') {
                console.log(`[Session] FITS image detected. Decoding directly...`);
                onStatus?.("Decoding FITS image...");
            } else {
                // Name the decode arm ACTUALLY used: rawler is the DEFAULT arm
                // since the 2026-07-11 cutover; libraw is the cold path
                // (VITE_DECODER_RAWLER=0). extractRawSensorData branches on the
                // same flag, so the status never lies about which decoder ran.
                // RAF (Fuji X-Trans) is FORCED onto the libraw arm there — the
                // rawler rail has no X-Trans — so provenance must say 'LibRaw'
                // for RAF even when the rawler default is on.
                const decoderArm = (sourceFormat === 'RAF' || !isRawlerDecoderEnabled()) ? 'LibRaw' : 'rawler';
                console.log(`[Session] File is RAW. Using ${decoderArm} for sensor data...`);
                onStatus?.(`Decoding RAW sensor data (${decoderArm})...`);
            }
            rawSensor = await extractRawSensorData(rawBuffer);
        } else {
            console.log(`[Session] File is NOT RAW (JPEG/TIFF). Using browser decoder for full resolution...`);
            // Use core ImageProcessor for full res decoding
            rawSensor = await ImageProcessor.decodeFullResImage(rawBuffer);
        }

        if (!rawSensor) throw new Error("Failed to decode sensor data.");

        // Store for future passes (Plate Solving, Calibration)
        await BayerStorageService.store(cacheKey, rawSensor.data, rawSensor.width, rawSensor.height, rawSensor.stride, rawSensor.isDemosaiced, rawSensor.cfaMosaicLuma);
    }

    // FIX: The "Double-Jeopardy" Check.
    // Detect if buffer is already demosaiced RGB (Length = W*H*3 or Flagged)
    const isLengthRGB = rawSensor.data.length === (rawSensor.width * rawSensor.height * 3);
    const isFlaggedRGB = !!rawSensor.isDemosaiced;

    if (isLengthRGB || isFlaggedRGB) {
        if (sourceFormat === 'FITS') {
            console.log("[Session] Image already demosaiced (stacked FITS). Demosaic skipped.");
            onStatus?.("Image already demosaiced (stacked FITS)...");
        } else {
            console.log("[Session] Using Decoded RGB (Demosaic Skipped)...");
            onStatus?.("Using Decoded RGB...");
        }
        // [FIX] Force reconciliation of flag if length matches RGB
        if (isLengthRGB) rawSensor.isDemosaiced = true;

        return {
            rawSensor,
            fullRGB: rawSensor.data instanceof Float32Array ? rawSensor.data : new Float32Array(rawSensor.data),
            width: rawSensor.width,
            height: rawSensor.height,
            // [COMPUTE-ROUTE OBSERVABILITY] The demosaic compute step did NOT run —
            // the payload was already demosaiced (the invisible skip both sacred lanes
            // take). Stamp it loud; the reason names the producer honestly.
            computeRoutes: [computeRouteStamp('demosaic', 'skipped', preDemosaicReason(sourceFormat))],
        };
    }

    console.log("[Session] Data is Bayer Pattern. Running WebGPU Demosaic...");
    onStatus?.("Demosaicing (WebGPU)...");
    const demosaicResult = await demosaicWebGPU(rawSensor.data, rawSensor.width, rawSensor.height, rawSensor.stride);
    return {
        rawSensor,
        fullRGB: demosaicResult.data,
        width: demosaicResult.width,
        height: demosaicResult.height,
        rgbBuffer: demosaicResult.rgbBuffer,
        // [COMPUTE-ROUTE OBSERVABILITY] The route the demosaic ACTUALLY took.
        computeRoutes: [demosaicResult.route],
    };
}
