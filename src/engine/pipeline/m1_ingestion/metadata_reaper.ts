import exifr from 'exifr';
import { HardMetadata } from '../../types/schema';
import { TelemetryLogger } from '../../diagnostics/telemetry_logger';
import { PhotometryManager } from '../m8_photometry/photometry_manager';
import { ArrowMemory } from '../../core/ArrowMemory';
import { Table } from 'apache-arrow';
import { parseFitsHeader, decodeFitsImage, fitsHeaderToHardMetadata, BayerPattern } from './fits_decoder';
import { findSensorByCamera, getGainForSetting } from '../m2_hardware/sensor_db';
import { sniffFormatId } from './format_registry';
import { resolveSourceProvenance } from './source_provenance';
import { isRawlerDecoderEnabled, decodeRawlerForPipeline, type RawlerCfaRecord } from './rawler_decoder';

/**
 * [ENVIRONMENT] This module is isomorphic. When running in Node.js, 
 * the 'Worker' global must be polyfilled by the entry point (e.g., node_worker_polyfill.ts)
 * before any modules that depend on LibRaw are imported.
 */

/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * METADATA REAPER â€” The Forensic Autopsy
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Unified extraction of EXIF and RAW sensor data.
 */

// â”€â”€â”€ DEFAULTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Observer location has NO default: absent GPS => gps_lat/gps_lon = null with
// gps_source 'DEFAULT'. Honest-or-absent (LAW 3) — no fabricated coordinates.

// HONEST-ABSENT shape (owner ruling 2026-07-10, "enable graceful failure"):
// this used to fabricate a specific rig ('Canon 18MP APS-C CMOS' + the owner's
// actual 14mm f/2.8 lens) — a LAW-3 landmine if ever wired live. Every field is
// now the same honest-absent zero/empty the parseExif fallback uses. NOTE the
// timestamp: an EMPTY string, never wall-clock "now" — a fabricated present-tense
// timestamp silently passes the ephemeris trust gate (orchestrator_session
// step2) and poisons planet/alt-az work while LOOKING valid.
export function createDefaultHard(): HardMetadata {
    return {
        camera_model: 'Unknown',
        lens_model: 'Unknown Lens',
        focal_length: 0,
        aperture: 0,
        iso_gain: 0,
        exposure_time: 0,
        timestamp: '',
        gps_lat: null,
        gps_lon: null,
        timestamp_source: 'DEFAULT',
        gps_source: 'DEFAULT',
    };
}

/** Result of EXIF parsing with extracted metadata and raw tags. */
export interface ExifResult {
    hard: HardMetadata;
    rawTags: Record<string, string | number>;
    format: 'JPEG' | 'TIFF' | 'CR2' | 'NEF' | 'ARW' | 'RAF' | 'FITS' | 'UNKNOWN';
    isRaw: boolean;
    warnings: string[];
    sensorData?: {
        data: Float32Array | Uint16Array;
        width: number;
        height: number;
        stride?: number;
        isDemosaiced?: boolean;
        arrowTable?: Table;
        calibrationStrip?: Uint16Array; // [NEW] Optical black pixels from sensor margins
        bayerPattern?: BayerPattern;    // [FITS] CFA layout from the BAYERPAT card
        /** [RAIL #14] Additive rawler contract (flag-ON only; absent on the libraw path). */
        rawler?: RawlerCfaRecord;
    };
}

export const metadata_reaper = {
    /**
     * Extracts all forensic data from the binary buffer.
     * @param buffer Raw file buffer
     * @param logger Optional TelemetryLogger for diagnostics
     */
    async extract(buffer: ArrayBuffer, logger?: TelemetryLogger): Promise<ExifResult> {
        // 1. Parse EXIF / TIFF Headers
        const exifResult = await parseExif(buffer);
        
        // 2. RAW Data Inspection (if applicable)
        let isAlreadyRGB = false;
        let selectedIfdIndex = -1;
        let bufferDims = 'Unknown';
        let rawDataResult: Awaited<ReturnType<typeof extractRawSensorData>> = null;

        if (exifResult.isRaw) {
             rawDataResult = exifResult.format === 'FITS'
                 ? extractFitsSensorData(buffer)
                 : await extractRawSensorData(buffer);
             if (rawDataResult) {
                 isAlreadyRGB = rawDataResult.isDemosaiced || false;
                 selectedIfdIndex = rawDataResult.selectedIfdIndex;
                 bufferDims = `${rawDataResult.width}x${rawDataResult.height}`;
                 
                 // Attach to result
                 exifResult.sensorData = {
                     data: rawDataResult.data,
                     width: rawDataResult.width,
                     height: rawDataResult.height,
                     stride: rawDataResult.stride,
                     isDemosaiced: isAlreadyRGB,
                     arrowTable: rawDataResult.arrowTable,
                     calibrationStrip: rawDataResult.calibrationStrip,
                     bayerPattern: rawDataResult.bayerPattern,
                     rawler: rawDataResult.rawler // [RAIL #14] additive; undefined on the libraw path
                 };
             }
        } else {
             if (exifResult.rawTags.ImageWidth && exifResult.rawTags.ImageHeight) {
                 bufferDims = `${exifResult.rawTags.ImageWidth}x${exifResult.rawTags.ImageHeight}`;
             }
        }

        // 3. Telemetry Logging
        if (logger) {
            logger.logStage('ingest', 'SUCCESS', {
                exif_camera: exifResult.hard.camera_model,
                exif_focal_length: exifResult.hard.focal_length,
                ifd_selected_index: selectedIfdIndex,
                buffer_dimensions: bufferDims,
                is_already_rgb: isAlreadyRGB
            });
            logger.log('ingest', `Parsed ${exifResult.format} (${(buffer.byteLength/1024/1024).toFixed(1)}MB). GPS: ${exifResult.hard.gps_source}`);
        }

        return exifResult;
    },

    // Expose helpers for direct use if needed
    parseExif,
    extractRawSensorData,
    isRawFile
};

// â”€â”€â”€ INTERNAL HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Attach the frame's source provenance (origin audit trail) onto HardMetadata when
 * the injected intake-ledger resolver positively matches by content sha. The default
 * resolver returns null (browser + both pinned reference solves), so the field stays
 * ABSENT there — honest-or-absent, and hard metadata is byte-identical. Never throws.
 */
async function attachSourceProvenance(hard: HardMetadata, buffer: ArrayBuffer): Promise<void> {
    const prov = await resolveSourceProvenance(buffer);
    if (prov) hard.source_provenance = prov;
}

/** Result of the EXIF capture-time resolution ladder. `timestamp` is ISO 8601
 *  UTC, or '' (absent) when `source` is 'DEFAULT'. */
export interface ResolvedExifTimestamp {
    timestamp: string;
    source: 'EXIF' | 'DERIVED' | 'DEFAULT';
}

/**
 * Resolve the capture timestamp from EXIF date tags — honest-or-absent.
 *
 * Trust ladder (owner ruling 2026-07-10: "if EXIF time is busted and we can
 * accurately derive it, store the time with a DERIVED tag"):
 *   - The FIRST PRESENT field in DateTimeOriginal → CreateDate → ModifyDate
 *     order that parses cleanly keeps the historical 'EXIF' tag (this is the
 *     pre-existing cascade — CreateDate/ModifyDate were always 'EXIF' when
 *     DateTimeOriginal was absent).
 *   - When the first present field is CORRUPT (unset-clock placeholder,
 *     invalid Date), a LATER field that parses rescues the time as 'DERIVED'
 *     — an honest secondary-source derivation. DERIVED is HINT tier: it must
 *     never be treated as ephemeris-trusted (same tier as DEFAULT for
 *     planet/alt-az gating).
 *   - Nothing parseable → '' + 'DEFAULT' (absent). NEVER wall-clock "now":
 *     a fabricated present-tense time looks plausible and silently poisons
 *     every downstream ephemeris consumer.
 */
export function resolveExifTimestamp(rawTags: Record<string, any>): ResolvedExifTimestamp {
    const parseExifDate = (val: any): string | null => {
        if (val instanceof Date) {
            return !isNaN(val.getTime()) ? val.toISOString() : null;
        }
        if (typeof val === 'string') {
            const standardized = val.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
            const d = new Date(standardized);
            return !isNaN(d.getTime()) ? d.toISOString() : null;
        }
        return null;
    };

    const present = [rawTags.DateTimeOriginal, rawTags.CreateDate, rawTags.ModifyDate]
        .filter(v => v != null && v !== '');
    for (let i = 0; i < present.length; i++) {
        const iso = parseExifDate(present[i]);
        if (iso) return { timestamp: iso, source: i === 0 ? 'EXIF' : 'DERIVED' };
    }
    return { timestamp: '', source: 'DEFAULT' };
}

export async function parseExif(buffer: ArrayBuffer): Promise<ExifResult> {
    // FITS carries no EXIF/TIFF structure - route to the dedicated header parser.
    if (detectMagicFormatSync(buffer) === 'FITS') {
        const fitsResult = await parseFitsMetadata(buffer);
        await attachSourceProvenance(fitsResult.hard, buffer);
        return fitsResult;
    }

    const warnings: string[] = [];
    const hard: HardMetadata = {
        camera_model: 'Unknown',
        lens_model: 'Unknown',
        focal_length: 0,
        aperture: 0,
        iso_gain: 0,
        exposure_time: 0,
        // HONEST-ABSENT (owner ruling 2026-07-10: system time = HINT, not
        // mandate): no capture time ⇒ EMPTY, never wall-clock "now". A
        // fabricated "now" is present + plausible, so it sailed through the
        // ephemeris trust gate (orchestrator_session step2 checks
        // `metadata?.timestamp` then plausibility only) and computed
        // planet/alt-az anchors on processing time. Empty routes that gate to
        // its honest degrade branch: timestampTrusted=false + loud warning.
        timestamp: '',
        gps_lat: null,
        gps_lon: null,
        timestamp_source: 'DEFAULT',
        gps_source: 'DEFAULT',
    };

    let rawTags: Record<string, any> = {};
    // FIX (error-path only): the container format is decided from magic bytes
    // BEFORE the EXIF parse below — never inside its try. An exifr.parse() throw
    // must not be able to leave `format` at 'UNKNOWN', which flips isRaw=false and
    // routes a genuine RAW/FITS sensor frame down the non-RAW arm (the observed
    // RAF "not a RAW/FITS sensor format" misclassification → garbage arm + hang).
    // detectMagicFormatSync is the same pure, throw-free sniff already used above
    // for the FITS short-circuit; the in-try magic re-assert below stays the
    // happy-path final authority, so the SOLVED path is byte-identical.
    let format: ExifResult['format'] = detectMagicFormatSync(buffer);

    try {
        rawTags = await exifr.parse(buffer, {
            tiff: true,
            xmp: true,
            icc: false,
            ifd1: false,
            mergeOutput: true, 
            reviveValues: true,
            sanitize: true,
        }) || {};

        if (rawTags.Make) format = detectFormatFromMake(rawTags.Make);
        
        // Camera Model
        if (rawTags.Model) hard.camera_model = String(rawTags.Model);
        else if (rawTags.Make) hard.camera_model = String(rawTags.Make);
        else warnings.push('Camera model not found');

        // Orientation
        if (rawTags.Orientation) hard.orientation = Number(rawTags.Orientation);

        // Lens Model
        if (rawTags.LensModel && typeof rawTags.LensModel === 'string' && rawTags.LensModel.trim()) {
            hard.lens_model = rawTags.LensModel.trim();
        } else if (rawTags.LensInfo && Array.isArray(rawTags.LensInfo)) {
            const [minF, maxF, minAp] = rawTags.LensInfo as number[];
            const safeMinF = (!isNaN(minF)) ? minF : 0;
            const safeMaxF = (!isNaN(maxF)) ? maxF : 0;
            const safeMinAp = (!isNaN(minAp)) ? minAp : 0;
            
            if (safeMinF > 0) {
                const focalStr = (safeMinF === safeMaxF || safeMaxF <= 0) ? `${safeMinF}mm` : `${safeMinF}-${safeMaxF}mm`;
                const apStr = (safeMinAp > 0) ? ` f/${safeMinAp}` : '';
                hard.lens_model = `${focalStr}${apStr} Lens`;
            } else {
                 hard.lens_model = 'Unknown Lens';
            }
        } else {
            hard.lens_model = 'Unknown Lens';
            warnings.push('Lens model not found');
        }

        // Exposure Settings
        const focalRaw = Number(rawTags.FocalLength);
        if (!isNaN(focalRaw) && focalRaw > 0) hard.focal_length = focalRaw;
        const apertureRaw = Number(rawTags.FNumber);
        if (!isNaN(apertureRaw) && apertureRaw > 0) hard.aperture = apertureRaw;
        const isoRaw = Number(rawTags.ISO);
        if (!isNaN(isoRaw) && isoRaw > 0) hard.iso_gain = isoRaw;
        const expRaw = Number(rawTags.ExposureTime);
        if (!isNaN(expRaw) && expRaw > 0) hard.exposure_time = expRaw;

        // Timestamp — honest-or-absent + DERIVED rescue (owner ruling
        // 2026-07-10). parseExifDate previously substituted wall-clock "now"
        // on a parse failure while the caller kept source='EXIF' — a corrupt
        // DateTimeOriginal (the classic unset-clock placeholder) minted a
        // "trusted EXIF" processing-time timestamp. Resolution now lives in
        // resolveExifTimestamp (pure, tested): first present field parsing
        // clean = EXIF; a later field rescuing a busted primary = DERIVED
        // (hint tier); nothing parseable = absent ('' + DEFAULT).
        const resolvedTs = resolveExifTimestamp(rawTags);
        if (resolvedTs.source !== 'DEFAULT') {
            hard.timestamp = resolvedTs.timestamp;
            hard.timestamp_source = resolvedTs.source;
            if (resolvedTs.source === 'DERIVED') {
                warnings.push('Primary EXIF capture time unparseable — timestamp DERIVED from a secondary EXIF date field (hint tier, not ephemeris-trusted).');
            }
        } else if (rawTags.DateTimeOriginal != null || rawTags.CreateDate != null || rawTags.ModifyDate != null) {
            warnings.push('EXIF capture-time fields present but unparseable — timestamp absent (untrusted).');
        }

        // GPS
        if (typeof rawTags.latitude === 'number' && typeof rawTags.longitude === 'number') {
            if (Math.abs(rawTags.latitude) > 1e-7 || Math.abs(rawTags.longitude) > 1e-7) {
                hard.gps_lat = rawTags.latitude;
                hard.gps_lon = rawTags.longitude;
                hard.gps_source = 'EXIF';
            } else {
                warnings.push('Zero-vector GPS detected (camera default) â€” treating as missing');
                hard.gps_lat = null;
                hard.gps_lon = null;
                hard.gps_source = 'DEFAULT';
            }
        } else {
            warnings.push('No GPS data found â€” observer location absent (unmeasured)');
            hard.gps_lat = null;
            hard.gps_lon = null;
            hard.gps_source = 'DEFAULT';
        }

        const magicFormat = await detectMagicFormat(buffer);
        format = magicFormat !== 'UNKNOWN' ? magicFormat : format;

        // [PHOTOMETRY] Update active sensor profile
        PhotometryManager.setProfile({
            gain_e_adu: PhotometryManager.getGainForISO(hard.iso_gain),
            make: format === 'NEF' ? 'Nikon' : (format === 'CR2' ? 'Canon' : 'Generic')
        });

    } catch (err: any) {
        console.warn('EXIF parsing failed:', err);
        warnings.push(`EXIF parse error: ${err.message}`);
    }

    if (hard.focal_length === 0) warnings.push('Focal length missing â€” pixel scale cannot be computed');

    await attachSourceProvenance(hard, buffer);

    return {
        hard,
        rawTags,
        format,
        isRaw: isRawFormat(format),
        warnings,
    };
}

/**
 * FITS analogue of parseExif: maps header cards onto HardMetadata and programs
 * the PhotometryManager from the header (BIAS/GAIN) instead of EXIF ISO.
 */
export async function parseFitsMetadata(buffer: ArrayBuffer): Promise<ExifResult> {
    const warnings: string[] = [];
    const hard: HardMetadata = {
        camera_model: 'Unknown',
        lens_model: 'Unknown',
        focal_length: 0,
        aperture: 0,
        iso_gain: 0,
        exposure_time: 0,
        // HONEST-ABSENT: empty, never wall-clock "now" (see parseExif — same
        // ephemeris-trust-gate poisoning). A parseable DATE-OBS overwrites this
        // via fitsHeaderToHardMetadata (timestamp_source 'FITS'); a FITS file
        // without one now degrades loudly instead of minting processing time.
        timestamp: '',
        gps_lat: null,
        gps_lon: null,
        timestamp_source: 'DEFAULT',
        gps_source: 'DEFAULT',
    };
    let rawTags: Record<string, any> = {};

    const header = parseFitsHeader(buffer);
    if (header) {
        const mapped = fitsHeaderToHardMetadata(header);
        Object.assign(hard, mapped.hard);
        rawTags = mapped.rawTags;
        warnings.push(...mapped.warnings);

        // [PHOTOMETRY] Update active sensor profile (FITS: header BIAS replaces
        // the optical-black strip; GAIN is a ZWO setting resolved via the sensor LUT)
        const biasCard = header.cards.get('BIAS');
        const pixSzCard = header.cards.get('XPIXSZ');
        const gainCard = header.cards.get('GAIN');
        const sensor = findSensorByCamera(hard.camera_model);
        const gainEAdu = (sensor && typeof gainCard === 'number' && Number.isFinite(gainCard))
            ? getGainForSetting(sensor, gainCard)
            : null;
        PhotometryManager.setProfile({
            make: 'ZWO',
            model: String(header.cards.get('INSTRUME') || 'FITS'),
            black_level: (typeof biasCard === 'number' && Number.isFinite(biasCard)) ? biasCard : 0,
            white_level: 65535,
            bit_depth: 16,
            pixel_size_um: (typeof pixSzCard === 'number' && pixSzCard > 0) ? pixSzCard : 2.9,
            gain_e_adu: gainEAdu ?? 0.05
        });
    } else {
        warnings.push('FITS header rejected (requires SIMPLE, BITPIX=16, NAXIS 2 or 3)');
    }

    if (hard.gps_source !== 'FITS') warnings.push('No GPS data found - observer location absent (unmeasured)');
    if (hard.focal_length === 0) warnings.push('Focal length missing - pixel scale cannot be computed');

    return {
        hard,
        rawTags,
        format: 'FITS',
        isRaw: true,
        warnings,
    };
}

export function isRawFile(buffer: ArrayBuffer): boolean {
    const view = new DataView(buffer);
    if (view.byteLength < 4) return false;
    const format = detectMagicFormatSync(buffer);
    return isRawFormat(format);
}

function isRawFormat(format: string): boolean {
    return ['CR2', 'NEF', 'ARW', 'RAF', 'FITS'].includes(format);
}

function detectFormatFromMake(make: string): ExifResult['format'] {
    const m = make.toUpperCase();
    if (m.includes('CANON')) return 'CR2';
    if (m.includes('NIKON')) return 'NEF';
    if (m.includes('SONY')) return 'ARW';
    if (m.includes('FUJI')) return 'RAF';
    return 'TIFF';
}

export function detectMagicFormatSync(buffer: ArrayBuffer): ExifResult['format'] {
    const view = new DataView(buffer);
    if (view.byteLength < 12) return 'UNKNOWN';

    // Ingestable RAW/FITS formats dispatch through the format registry (single
    // source of truth). Byte-identical to the former inline FITS/CR2 checks.
    const registered = sniffFormatId(buffer);
    if (registered) return registered;

    // Non-ingestable container fallbacks stay here (not registry formats):
    // a bare TIFF (no CR2 marker) and browser-decodable JPEG.
    const byte0 = view.getUint8(0);
    const byte1 = view.getUint8(1);

    if ((byte0 === 0x49 && byte1 === 0x49) || (byte0 === 0x4D && byte1 === 0x4D)) {
        return 'TIFF';
    }

    if (byte0 === 0xFF && byte1 === 0xD8) return 'JPEG';

    return 'UNKNOWN';
}

async function detectMagicFormat(buffer: ArrayBuffer): Promise<ExifResult['format']> {
    return detectMagicFormatSync(buffer);
}

export async function extractRawSensorData(buffer: ArrayBuffer): Promise<{ data: Uint16Array | Float32Array; width: number; height: number; stride: number; isDemosaiced: boolean; selectedIfdIndex: number; sensorHints?: any; arrowTable?: Table; calibrationStrip?: Uint16Array; bayerPattern?: BayerPattern; cfaMosaicLuma?: boolean; rawler?: RawlerCfaRecord } | null> {
    try {
        // FITS: LibRaw cannot decode it - route to the pure-TS decoder.
        const magicFormat = detectMagicFormatSync(buffer);
        if (magicFormat === 'FITS') return extractFitsSensorData(buffer);

        // [RAF / Fuji X-Trans — per-format libraw override] The rawler wasm rail
        // hardcodes a 2×2 Bayer CFA (src/engine/wasm_decode lib.rs) and has NO
        // X-Trans support, so a Fuji RAF MUST decode on the libraw arm regardless
        // of the rawler default. libraw's document mode returns the SAME RGB16
        // interleaved mem_image contract as CR2 (verified on the X-T5 RAF
        // DSCF4954: active 7752×5178, u16 count == w·h·3 exactly). Honest
        // per-format arm selection until a general seam exists; the ingest-stage
        // decoder_arm provenance mirrors this ('LibRaw' for RAF, ingest.ts).
        const forceLibrawArm = magicFormat === 'RAF';

        // [DECODER-CUTOVER #14 PARALLEL RAIL] Flag-selected rawler arm, DEFAULT
        // OFF. Unset/absent flag ⇒ this branch is dead code and the libraw path
        // below runs byte-identically (both pinned reference solves). Flag ON is
        // an A/B-lane decision (tools/rawlab/ab_live.mjs) — never a gate config.
        // RAF bypasses it unconditionally (forceLibrawArm) — no X-Trans on rawler.
        if (!forceLibrawArm && isRawlerDecoderEnabled()) {
            console.log('[MetadataReaper] VITE_DECODER_RAWLER is ON — decoding via the rawler wasm rail (libraw bypassed).');
            return decodeRawlerForPipeline(buffer);
        }

        console.log(`[MetadataReaper] Starting RAW extraction (${(buffer.byteLength/1024/1024).toFixed(1)}MB)...`);
        
        // [ARCHITECTURAL SHIFT] Using LibRaw WASM for true native decoding
        console.log(`[MetadataReaper] Importing libraw-wasm...`);
        const LibRawModule = await import('libraw-wasm');
        const LibRaw = (LibRawModule as any).default || LibRawModule;
        
        const raw = new LibRaw();

        // ── CFA-TYPE DECODE GATE (owner directive 2026-07-13) ────────────────────
        // Document mode (noInterpolation:true) is CORRECT for a 2×2 BAYER CFA: the
        // engine reads the dominant-channel mem_image directly (convertMemImageToRgb
        // collapses it to a smooth gray luminance — no artifact). But a NON-Bayer
        // mosaic leaves a periodic CFA GRID under document mode that FLOODS detection:
        // on Fuji X-Trans (6×6 CFA) the grid dominates the top-flux ranking so
        // quads_detected=0 and the frame cannot lock (MEASURED on the contributed X-T5 RAF
        // DSCF4954: baseline/poly2/mesh lift all quads=0 at 1.19M/458K/360K dets;
        // the X-Trans demosaic probe proved a FULL decode eliminates the grid —
        // tools/lift/xtrans_probe.liftspec.ts crops). So X-Trans MUST be fully
        // demosaiced (libraw auto-selects the CFA-appropriate algorithm — Markesteijn
        // for X-Trans); convertMemImageToRgb already DETECTS genuinely-demosaiced RGB
        // (all channels populated → channel-preserving branch + REC709 luma). BAYER
        // stays document mode → CR2/SeeStar byte-identical.
        //
        // UNVERIFIED (no test frame yet): QUAD-BAYER / Tetracell sensors (Sony
        // IMX-class 2×2 same-colour grouping) almost certainly need the SAME full
        // demosaic — their document-mode output blocks detection the same way. When
        // such a frame lands, add its predicate to NEEDS_FULL_DEMOSAIC below (keep
        // Bayer on document mode — that is what protects the sacred pins).
        const NEEDS_FULL_DEMOSAIC =
            magicFormat === 'RAF';   // Fuji X-Trans (6×6). TODO(quad-bayer): || isQuadBayerSensor(...)

        // 1. Open with Strict Scientific Parameters.
        // Bayer: RAW filter array (document mode). X-Trans/non-Bayer: full demosaic.
        await raw.open(new Uint8Array(buffer), {
            noInterpolation: !NEEDS_FULL_DEMOSAIC, // Bayer='Document Mode' (byte-identical); X-Trans=full Markesteijn demosaic
            outputBps: 16,         // 16-bit linear integers
            noAutoBright: true,    // Preserve photometry
            useCameraWb: false,    // RAW values only
            useAutoWb: false
        });

        // 2. Extract the Data
        console.log("   [LibRaw] Requesting imageData()...");
        const rawData = await raw.imageData();

        // Deep inspection for boundary validation
        console.log("Boundary Object Details:", {
            type: typeof rawData,
            isArray: Array.isArray(rawData),
            isView: ArrayBuffer.isView(rawData),
            length: (rawData as any)?.length,
            byteLength: (rawData as any)?.byteLength,
            bufferLength: (rawData as any)?.buffer?.byteLength
        });

        // Failsafe to prevent the NaN cascade
        if (!rawData || (rawData.byteLength === 0 && !(rawData as any).data)) {
            throw new Error("WASM Bridge completely failed to populate the buffer.");
        }

        const meta = await raw.metadata();
        // [FIX] Use Active Image Area dimensions.
        // raw_width/raw_height includes dark-reference padding (e.g. ~160px for Canon T6).
        // Using raw dimensions here causes a cumulative "diagonal shear" (~2.6Â°) 
        // that is misidentified as rotation by the plate solver.
        const width = meta?.width || (meta as any).raw_width || meta?.imageSize?.width || 0;
        const height = meta?.height || (meta as any).raw_height || meta?.imageSize?.height || 0;
        
        // 3. Stride Detection (The LibRaw Stride is in Bytes, not Elements)
        // [FIX] Divide byte-stride (raw_pitch) by 2 for Uint16Array element-wise indexing.
        // Always wrap rows at raw_width even if we only harvest the active width.
        const rawWidth = (meta as any).raw_width || width;
        const stride = (meta as any).raw_pitch ? ((meta as any).raw_pitch / 2) : rawWidth;
        
        console.log(`   [LibRaw] Sensor Metadata: Active=${width}x${height}, elementStride=${stride} (RawWidth=${rawWidth})`);

        // 4. Securely cast to Uint16Array
        let cfaBuffer: Uint16Array;
        if (ArrayBuffer.isView(rawData) && rawData instanceof Uint16Array) {
            cfaBuffer = rawData;
        } else if ((rawData as any).data instanceof Uint16Array) {
            cfaBuffer = (rawData as any).data;
        } else {
            const bufferSource = (rawData as any).buffer || rawData;
            const offset = (rawData as any).byteOffset || 0;
            const length = (rawData as any).length || (bufferSource.byteLength / 2);
            cfaBuffer = new Uint16Array(bufferSource, offset, length);
        }

        // 5. [LIBRAW-WASM 1.1.x CONTRACT] Payload layout detection.
        // Verified against the bundled Canon T6 CR2 (tools/dslr/decode_cr2_smoke.mjs):
        // imageData() returns dcraw_make_mem_image output — ACTIVE-AREA (meta.width
        // x meta.height), 3-channel interleaved Uint16, black-subtracted and scaled
        // to 16-bit — even with noInterpolation (document mode places each pixel's
        // value in its own CFA color channel; the other two channels are zero).
        // meta.raw_pitch does NOT exist in this binding, so the legacy CFA-mosaic
        // branch below (raw_width-strided single channel + optical-black margins)
        // only applies to bindings that expose the true mosaic.
        if (cfaBuffer.length === width * height * 3) {
            return convertMemImageToRgb(cfaBuffer, width, height);
        }

        // 5b. Harvest Calibration Strip (Optical Black pixels)
        // If rawWidth > width, there are dark reference pixels on the right.
        let calibrationStrip: Uint16Array | undefined;
        if (rawWidth > width) {
            const marginWidth = Math.min(256, rawWidth - width); 
            calibrationStrip = new Uint16Array(marginWidth * height);
            for (let y = 0; y < height; y++) {
                const srcStart = y * stride + width;
                const dstStart = y * marginWidth;
                calibrationStrip.set(cfaBuffer.subarray(srcStart, srcStart + marginWidth), dstStart);
            }
            console.log(`   [LibRaw] Harvested ${marginWidth}px wide black calibration strip.`);
        }

        // 6. Sensor Characteristics (e.g., Canon Rebel T6)
        const sensorHints = PhotometryManager.getProfile();

        // [ZERO COPY] Encapsulate raw sensor integers directly into an Arrow IPC Table
        const arrowTable = ArrowMemory.createRawBuffer(cfaBuffer, width, height, stride);

        return {
            data: cfaBuffer,
            width,
            height,
            stride, // CRITICAL: Row-wrapping fix
            isDemosaiced: false,
            selectedIfdIndex: 0,
            sensorHints,
            arrowTable,
            calibrationStrip
        };
    } catch (err) {
        console.error('extractRawSensorData error:', err);
        return null;
    }
}

/**
 * Convert libraw-wasm's dcraw_make_mem_image payload (active-area interleaved
 * Uint16 RGB) into the demosaiced-RGB contract both orchestrators already
 * handle (same rails as the FITS NAXIS=3 cube: normalized Float32, RGB Arrow
 * buffer, demosaic skipped downstream).
 *
 * Document mode (noInterpolation) is one-hot per pixel: the CFA site's value
 * sits in its own color channel, the other two are exact zeros. Passing that
 * through as-is would give detection a CFA-weighted checkerboard luminance
 * (0.72*v on green sites vs 0.07*v on blue). Instead each pixel becomes a
 * neutral gray triplet of its site value — a smooth, photometry-preserving
 * luminance surface. If the binding ever returns genuinely demosaiced RGB
 * (all channels populated), channels are preserved and just normalized.
 */
function convertMemImageToRgb(
    mem: Uint16Array,
    width: number,
    height: number
): NonNullable<Awaited<ReturnType<typeof extractRawSensorData>>> {
    const pixelCount = width * height;

    // One-hot probe: document-mode mosaics have ~0 pixels with 2+ lit channels.
    // The strict >0 test is FRAGILE: LibRaw noInterpolation output carries a
    // small (~1-2%) cross-leak into the off-channels, so ~half the pixels show
    // 2+ *nonzero* channels and isDocumentMode reads false — even though each
    // site is still dominated by ONE CFA colour. We ALSO measure the median
    // (2nd-largest / largest) channel ratio: ~0 for one-hot, small (<~0.15) for
    // a leaky CFA mosaic, large for a genuinely demosaiced RGB frame. That
    // ratio is what routes the DETECTION luminance (see cfaMosaicLuma below),
    // independent of the exact-zero isDocumentMode gate.
    let multiChannel = 0;
    let probed = 0;
    const ratios: number[] = [];
    for (let p = 0; p < pixelCount; p += 997) {
        const i = p * 3;
        const a = mem[i], b = mem[i + 1], c = mem[i + 2];
        const lit = (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0) + (c > 0 ? 1 : 0);
        if (lit >= 2) multiChannel++;
        probed++;
        const mx = a > b ? (a > c ? a : c) : (b > c ? b : c);
        if (mx > 0) {
            const mid = a + b + c - mx - Math.min(a, b, c); // second-largest
            ratios.push(mid / mx);
        }
    }
    const isDocumentMode = probed > 0 && (multiChannel / probed) < 0.02;
    // Leak-tolerant CFA-mosaic verdict: a per-site single-colour frame reduced
    // to luminance by Rec.709 weights (0.72G vs 0.07B) imprints a 2px period-2
    // checkerboard on detection. cfaMosaicLuma flags that so the luminance
    // reduction can use equal channel weights (checkerboard-free). RGB output
    // is UNCHANGED — the colour/preview path is untouched.
    ratios.sort((x, y) => x - y);
    const medRatio = ratios.length ? ratios[ratios.length >> 1] : 1;
    const CFA_MOSAIC_RATIO_MAX = 0.15; // measured CR2 median ~0.00; genuine RGB >> 0.15
    const cfaMosaicLuma = medRatio < CFA_MOSAIC_RATIO_MAX;

    const rgb = new Float32Array(pixelCount * 3);
    const inv = 1 / 65535;
    if (isDocumentMode) {
        for (let p = 0; p < pixelCount; p++) {
            const i = p * 3;
            const v = Math.min(1, (mem[i] + mem[i + 1] + mem[i + 2]) * inv);
            rgb[i] = v;
            rgb[i + 1] = v;
            rgb[i + 2] = v;
        }
    } else {
        for (let i = 0; i < rgb.length; i++) rgb[i] = mem[i] * inv;
    }

    console.log(`   [LibRaw] mem_image payload: ${width}x${height}x3 Uint16 (${isDocumentMode ? 'document-mode mosaic -> gray luminance' : 'demosaiced RGB'}). Normalized Float32, demosaic skipped downstream.`);
    console.log(`   [LibRaw] CFA-mosaic verdict: cfaMosaicLuma=${cfaMosaicLuma} (median 2nd/max channel ratio=${medRatio.toFixed(4)}; <${CFA_MOSAIC_RATIO_MAX} => per-site single-colour, luminance parity-guarded).`);
    console.log('   [LibRaw] Black level already subtracted by LibRaw; optical-black strip not present in active-area output.');

    return {
        data: rgb,
        width,
        height,
        stride: width,
        isDemosaiced: true,
        selectedIfdIndex: 0,
        sensorHints: PhotometryManager.getProfile(),
        arrowTable: ArrowMemory.createRgbBuffer(rgb, width, height),
        calibrationStrip: undefined,
        cfaMosaicLuma
    };
}

/**
 * Decode FITS sensor data into the exact contract extractRawSensorData returns.
 * NAXIS=3 -> normalized interleaved Float32 RGB (isDemosaiced: true, RGB Arrow buffer).
 * NAXIS=2 -> physical Uint16 CFA (isDemosaiced: false, RAW Arrow buffer).
 */
export function extractFitsSensorData(buffer: ArrayBuffer): Awaited<ReturnType<typeof extractRawSensorData>> {
    console.log(`[MetadataReaper] Starting FITS extraction (${(buffer.byteLength/1024/1024).toFixed(1)}MB)...`);

    const image = decodeFitsImage(buffer);
    if (!image) {
        console.error('extractFitsSensorData: FITS decode failed (unsupported header or truncated data)');
        return null;
    }

    const sensorHints = PhotometryManager.getProfile();

    if (image.kind === 'RGB_PLANAR') {
        const rgb = image.rgbInterleaved!;
        console.log(`   [FITS] Planar RGB cube ${image.width}x${image.height}x3 -> interleaved Float32 (already demosaiced)`);
        return {
            data: rgb,
            width: image.width,
            height: image.height,
            stride: image.width,
            isDemosaiced: true,
            selectedIfdIndex: 0,
            sensorHints,
            arrowTable: ArrowMemory.createRgbBuffer(rgb, image.width, image.height),
            bayerPattern: image.bayerPattern,
            calibrationStrip: undefined
        };
    }

    const cfa = image.cfa!;
    console.log(`   [FITS] Bayer CFA ${image.width}x${image.height} (pattern=${image.bayerPattern ?? 'UNKNOWN'})`);
    return {
        data: cfa,
        width: image.width,
        height: image.height,
        stride: image.width,
        isDemosaiced: false,
        selectedIfdIndex: 0,
        sensorHints,
        arrowTable: ArrowMemory.createRawBuffer(cfa, image.width, image.height, image.width),
        bayerPattern: image.bayerPattern,
        calibrationStrip: undefined
    };
}

