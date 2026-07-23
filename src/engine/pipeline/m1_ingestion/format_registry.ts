/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INGESTION FORMAT REGISTRY — one entry per supported input format
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL-adjacent (this is the ingestion front door — it only *routes*;
 * the wrapped decode/reap functions own the actual PIXEL/COORDINATE work).
 *
 * SINGLE SOURCE OF TRUTH for "what formats can this instrument ingest?". Both
 * the pipeline (magic-byte dispatch via `sniffFormatId`) and the UI (accept
 * attribute, supported-formats copy, drop validation) derive from this table.
 * There are intentionally NO scattered `if (ext === '.cr2')` / `format ===
 * 'FITS'` conditionals in the front end anymore — add or change a format HERE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A FORMAT (the "cleanly add Sony ARW" contract)
 * ─────────────────────────────────────────────────────────────────────────
 * Adding a new RAW format should touch ONE registry object plus the two
 * pure functions it references. NO edits to MainUpload, the orchestrator,
 * or detectMagicFormatSync are required — the UI and dispatch derive from
 * this array.
 *
 *   1. Implement a decoder entry fn  -> sensor payload (the decode contract
 *      below; for a Bayer RAW this is the `extractRawSensorData` shape).
 *   2. Implement a metadata reaper entry fn -> `ExifResult` (EXIF/header
 *      autopsy: camera/lens/focal/timestamp/GPS + `format` + `isRaw`).
 *   3. Append ONE `FormatDescriptor` to `FORMAT_REGISTRY` below:
 *        { id, displayName, extensions, sniff, decode, reapMetadata,
 *          capabilities }
 *      - `sniff(bytes)` is a magic-byte check (NOT extension) — return true
 *        only on a positive container-signature match. Order matters: the
 *        FIRST descriptor whose sniff() returns true wins, so put the most
 *        specific signatures first (CR2's TIFF+"CR" marker before a bare
 *        TIFF fallback, etc.).
 *      - `capabilities` are HONEST descriptors of what the reaper can supply
 *        (honest-or-absent — do not claim GPS/timestamp trust the format
 *        can't back).
 *   4. Put its unit tests in `src/engine/tests/` — assert the sniff verdict
 *      (positive + negative), decode dims, and that dispatch routes the
 *      buffer to the right descriptor (see `format_registry.test.ts`).
 *
 * COMING CFA CONTRACT (task #14 — the Sony ARW entry lands BEHIND this):
 *   A Bayer decoder entry fn must become a DETERMINISTIC decode returning
 *   { CFA: Uint16Array, pattern: BayerPattern, levels: {black,white},
 *     WB: number[], crop: {x,y,w,h} } — so the native-grid detection +
 *     demosaic can be parameterized per format instead of guessed. Sony ARW
 *     should register once that contract exists; until then a new RAW that
 *     rides the existing LibRaw path only registers if LibRaw's magic-byte
 *     signature is added to its `sniff` (a bare TIFF-based RAW is NOT
 *     auto-detected today — see the CR2 note).
 *
 * BEHAVIOR-PRESERVING SEAM (2026-07-09): FITS + CR2 wrap the EXISTING entry
 * functions verbatim. `sniffFormatId` reproduces `detectMagicFormatSync`'s
 * FITS/CR2 verdicts byte-for-byte; the container/JPEG/TIFF/UNKNOWN fallback
 * stays in metadata_reaper (those are not ingestable science formats).
 */

import {
    extractRawSensorData,
    parseExif,
    extractFitsSensorData,
    parseFitsMetadata,
    type ExifResult,
} from './metadata_reaper';

/** Formats this instrument can INGEST (a subset of `ExifResult['format']`). */
export type RegistryFormatId = 'FITS' | 'CR2' | 'RAF' | 'TIFF' | 'JPEG';

/** Sensor payload shape returned by a decoder entry fn (nullable on failure). */
export type DecodeResult = Awaited<ReturnType<typeof extractRawSensorData>>;

/**
 * Ingest tier — the honesty contract (LAW 3) for what a format's numbers mean.
 *
 *  - 'science': a native sensor bitstream (linear, full bit depth, Bayer CFA or
 *    a demosaiced RGB cube) → the calibrated photometry / SPCC chain is valid.
 *    FITS + CR2.
 *  - 'demo': an already-RENDERED 8-bit sRGB frame (a phone JPEG, a photographic
 *    TIFF). This tier exists so a bar patron's phone photo INGESTS instead of
 *    hard-rejecting (Astronomy On Tap, event-funnel era). The plate SOLVE —
 *    detection + blind astrometry — is honest math on ANY source, so it runs
 *    for real. But the RADIOMETRY is APPROXIMATE: the pixels are 8-bit,
 *    gamma-encoded, white-balanced and tone-mapped, NOT linear sensor counts —
 *    so SPCC / calibrated-magnitude claims are NOT valid, and stripped EXIF
 *    means capture time / GPS are usually absent (untrusted). Every downstream
 *    surface reads this off the descriptor and labels the run DEMO-TIER.
 */
export type FormatTier = 'science' | 'demo';

/**
 * Honest capability descriptors — what the format's reaper can actually
 * supply (honest-or-absent; never claim data the container can't back).
 */
export interface FormatCapabilities {
    /** Reaper can surface observer geolocation from the file's own metadata. */
    exif_gps: boolean;
    /** How much to trust the embedded capture time (feeds the ephemeris gate). */
    trusted_timestamp_semantics: string;
    /** Format can carry a raw Bayer CFA mosaic (vs already-demosaiced RGB). */
    cfa: boolean;
}

export interface FormatDescriptor {
    /** Stable id; must be a member of `ExifResult['format']`. */
    id: RegistryFormatId;
    /**
     * Honesty tier (LAW 3). 'science' formats feed the calibrated photometry
     * chain; 'demo' formats ingest + solve for real but carry APPROXIMATE
     * radiometry (see `FormatTier`). Every downstream surface reads this here.
     */
    tier: FormatTier;
    /** Human-readable label — drives logs AND the UI supported-formats copy. */
    displayName: string;
    /** Lowercase file extensions WITHOUT the leading dot. */
    extensions: string[];
    /** Magic-byte signature check (NOT extension). First positive match wins. */
    sniff: (bytes: Uint8Array) => boolean;
    /** Decoder entry fn: source bitstream -> sensor payload. */
    decode: (buffer: ArrayBuffer) => DecodeResult | Promise<DecodeResult>;
    /** Metadata reaper entry fn: forensic EXIF/header autopsy -> ExifResult. */
    reapMetadata: (buffer: ArrayBuffer) => Promise<ExifResult>;
    /** Honest capability flags (see FormatCapabilities). */
    capabilities: FormatCapabilities;
}

// ─── Magic-byte sniffers (byte-identical to detectMagicFormatSync's checks) ───

/** FITS: the header opens with the literal card key "SIMPLE" (0x53494D50 4C45). */
function sniffFits(bytes: Uint8Array): boolean {
    if (bytes.length < 6) return false;
    return (
        bytes[0] === 0x53 && bytes[1] === 0x49 && bytes[2] === 0x4d &&
        bytes[3] === 0x50 && bytes[4] === 0x4c && bytes[5] === 0x45
    ); // "SIMPLE"
}

/** Canon CR2: TIFF container (II / MM) with the "CR" marker at byte offset 8. */
function sniffCr2(bytes: Uint8Array): boolean {
    if (bytes.length < 10) return false;
    const tiff =
        (bytes[0] === 0x49 && bytes[1] === 0x49) || // little-endian "II"
        (bytes[0] === 0x4d && bytes[1] === 0x4d);   // big-endian "MM"
    if (!tiff) return false;
    return bytes[8] === 0x43 && bytes[9] === 0x52; // "CR" (CR2 magic)
}

/**
 * Fujifilm RAF: the container opens with the fixed ASCII magic
 * "FUJIFILMCCD-RAW" at byte offset 0 (followed by a version string + the camera
 * model, e.g. "…0201FF179502X-T5"). Unique signature — no overlap with the
 * TIFF/CR2 II|MM sniffers, so ordering vs CR2/TIFF is immaterial for RAF.
 */
function sniffRaf(bytes: Uint8Array): boolean {
    if (bytes.length < 16) return false;
    // "FUJIFILMCCD-RAW" (15 bytes); byte 15 is a trailing space we don't require.
    const MAGIC = [
        0x46, 0x55, 0x4a, 0x49, 0x46, 0x49, 0x4c, 0x4d, // FUJIFILM
        0x43, 0x43, 0x44, 0x2d, 0x52, 0x41, 0x57,        // CCD-RAW
    ];
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
}

/** JPEG (demo tier): the SOI marker 0xFFD8 opens every JPEG stream. */
function sniffJpeg(bytes: Uint8Array): boolean {
    if (bytes.length < 3) return false;
    return bytes[0] === 0xff && bytes[1] === 0xd8; // SOI
}

/**
 * Bare TIFF (demo tier): a II/MM container with NO Canon "CR" marker. This is
 * the SAME II/MM signature CR2 uses, so this descriptor MUST sit AFTER CR2 in
 * `FORMAT_REGISTRY` (first positive sniff wins) — a real CR2 matches sniffCr2
 * first and never reaches here. A TIFF-based RAW (NEF/ARW) will also match this
 * signature; that is acceptable at demo tier because the browser raster decode
 * simply fails on a RAW container (honest-or-absent — the decode returns null
 * and the UI reports it, rather than minting fake pixels).
 */
function sniffTiff(bytes: Uint8Array): boolean {
    return (
        (bytes[0] === 0x49 && bytes[1] === 0x49) || // "II"
        (bytes[0] === 0x4d && bytes[1] === 0x4d)    // "MM"
    );
}

/**
 * Demo-tier decode: browser-native raster decode (createImageBitmap → 2D
 * canvas) of an already-rendered 8-bit sRGB frame into interleaved Float32 RGB
 * (values 0..1). Reuses the SINGLE live decoder that `stages/ingest` already
 * calls for JPEG/TIFF (`ImageProcessor.decodeFullResImage`), pulled via a
 * dynamic import so this module's STATIC graph stays UI-safe (no new coupling
 * for MainUpload / queue_state). Node / headless has no `createImageBitmap`, so
 * this honestly returns `null` there — demo tier is a browser affordance.
 *
 * LAW 3 caveat: the output is gamma-encoded 8-bit sRGB, NOT linear sensor
 * counts — the geometry/solve are honest, the radiometry is APPROXIMATE.
 */
async function decodeDemoImage(buffer: ArrayBuffer): Promise<DecodeResult> {
    const { ImageProcessor } = await import('../../core/ImageProcessor');
    const rgb = await ImageProcessor.decodeFullResImage(buffer);
    return rgb ? { ...rgb, selectedIfdIndex: 0 } : null;
}

/**
 * The registry. ORDER = dispatch priority (first positive sniff wins).
 * FITS + CR2 wrap the existing metadata_reaper entry functions verbatim —
 * the decode/reap arrows only forward the buffer (zero behavior change).
 */
export const FORMAT_REGISTRY: readonly FormatDescriptor[] = [
    {
        id: 'FITS',
        tier: 'science',
        displayName: 'FITS/FIT (SeeStar, ZWO)',
        extensions: ['fits', 'fit'],
        sniff: sniffFits,
        decode: (buffer) => extractFitsSensorData(buffer),
        reapMetadata: (buffer) => parseFitsMetadata(buffer),
        capabilities: {
            // GPS, when present, rides SITELAT/SITELONG header cards — the
            // common SeeStar/stacked export omits them, so treat as absent.
            exif_gps: false,
            trusted_timestamp_semantics:
                'DATE-OBS header card (observation start) — trusted when present',
            cfa: true, // NAXIS=2 Bayer sub-frame; stacked NAXIS=3 arrives demosaiced
        },
    },
    {
        id: 'CR2',
        tier: 'science',
        displayName: 'Canon CR2',
        extensions: ['cr2'],
        sniff: sniffCr2,
        decode: (buffer) => extractRawSensorData(buffer),
        reapMetadata: (buffer) => parseExif(buffer),
        capabilities: {
            exif_gps: true, // EXIF GPS IFD (bundled sample carries none)
            trusted_timestamp_semantics:
                'EXIF DateTimeOriginal — subject to unset-clock forensics (timestampTrusted gate)',
            cfa: true, // Bayer mosaic (LibRaw document-mode decode)
        },
    },
    {
        id: 'RAF',
        tier: 'science',
        displayName: 'Fujifilm RAF (X-Trans)',
        extensions: ['raf'],
        sniff: sniffRaf,
        // Same entry fns as CR2. `extractRawSensorData` routes RAF to the LIBRAW
        // arm unconditionally (X-Trans is unsupported on the rawler wasm rail),
        // and libraw returns the identical RGB16 interleaved mem_image contract.
        decode: (buffer) => extractRawSensorData(buffer),
        reapMetadata: (buffer) => parseExif(buffer),
        capabilities: {
            exif_gps: true, // RAF embeds an EXIF GPS IFD (honest-or-absent when unset)
            trusted_timestamp_semantics:
                'EXIF DateTimeOriginal — subject to unset-clock forensics (timestampTrusted gate)',
            cfa: true, // X-Trans mosaic; libraw document-mode delivers it as RGB16 mem_image
        },
    },
    // ─── DEMO-TIER formats (event-funnel: a phone photo ingests + solves for
    // real, radiometry APPROXIMATE — see FormatTier). Placed AFTER CR2 so a
    // Canon CR2 (which shares the II/MM TIFF signature) always wins first. ───
    {
        id: 'JPEG',
        tier: 'demo',
        displayName: 'JPEG (demo tier)',
        extensions: ['jpg', 'jpeg'],
        sniff: sniffJpeg,
        decode: (buffer) => decodeDemoImage(buffer),
        reapMetadata: (buffer) => parseExif(buffer),
        capabilities: {
            // Phone EXIF often carries a GPS IFD; honest-or-absent — the reaper
            // surfaces it only when present (zero-vector defaults are dropped).
            exif_gps: true,
            trusted_timestamp_semantics:
                'EXIF DateTimeOriginal when present — phone/social exports routinely strip it; untrusted unless it survives (timestampTrusted gate)',
            cfa: false, // already-demosaiced 8-bit sRGB, not a Bayer mosaic
        },
    },
    {
        id: 'TIFF',
        tier: 'demo',
        displayName: 'TIFF (demo tier)',
        extensions: ['tif', 'tiff'],
        sniff: sniffTiff,
        decode: (buffer) => decodeDemoImage(buffer),
        reapMetadata: (buffer) => parseExif(buffer),
        capabilities: {
            exif_gps: true,
            trusted_timestamp_semantics:
                'EXIF DateTimeOriginal when present — untrusted unless it survives (timestampTrusted gate)',
            cfa: false, // browser-decoded RGB (a CFA/RAW TIFF fails the raster decode honestly)
        },
    },
] as const;

// ─── Dispatch helpers (pipeline side — bytes always available) ───────────────

/**
 * Magic-byte dispatch: return the ingestable format id, or null when the
 * buffer matches no registered signature. This is the ONLY format-detection
 * primitive the ingestion front end should call; `detectMagicFormatSync`
 * delegates its FITS/CR2 verdict here.
 */
export function sniffFormatId(buffer: ArrayBuffer): RegistryFormatId | null {
    const bytes = new Uint8Array(buffer);
    for (const desc of FORMAT_REGISTRY) {
        if (desc.sniff(bytes)) return desc.id;
    }
    return null;
}

/** Look up a descriptor by its format id. */
export function getDescriptor(id: RegistryFormatId): FormatDescriptor {
    const desc = FORMAT_REGISTRY.find((d) => d.id === id);
    if (!desc) throw new Error(`No format descriptor registered for id "${id}"`);
    return desc;
}

/** Honesty tier for a registered format id ('science' vs 'demo'). */
export function getFormatTier(id: RegistryFormatId): FormatTier {
    return getDescriptor(id).tier;
}

/**
 * True when a format STRING (e.g. `detectMagicFormatSync`/`ExifResult.format`
 * output — which is wider than `RegistryFormatId`) names a registered DEMO-tier
 * format. The single predicate every downstream honesty surface calls; returns
 * false for science formats AND for unregistered strings ('UNKNOWN', 'NEF', …).
 */
export function isDemoTierFormat(format: string): boolean {
    return FORMAT_REGISTRY.find((d) => d.id === format)?.tier === 'demo';
}

// ─── UI derivation helpers (front end — filename known, bytes not yet read) ───

/** All supported extensions (lowercase, no dot), de-duplicated, order-stable. */
export function supportedExtensions(): string[] {
    const seen = new Set<string>();
    for (const desc of FORMAT_REGISTRY) {
        for (const ext of desc.extensions) seen.add(ext.toLowerCase());
    }
    return [...seen];
}

/** `accept` attribute string for <input type="file">, e.g. ".fits,.fit,.cr2". */
export function acceptAttribute(): string {
    return supportedExtensions().map((ext) => `.${ext}`).join(',');
}

/** Human-readable supported-formats label, e.g. "FITS/FIT (SeeStar, ZWO), Canon CR2". */
export function supportedFormatsLabel(): string {
    return FORMAT_REGISTRY.map((d) => d.displayName).join(', ');
}

/** True when a filename's extension matches a registered format. */
export function isSupportedFilename(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return supportedExtensions().includes(ext);
}
