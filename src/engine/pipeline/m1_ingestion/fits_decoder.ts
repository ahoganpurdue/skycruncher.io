import { HardMetadata } from '../../types/schema';
import { computePixelScale } from '../m2_hardware/hardware_adapter';

/**
 * FITS DECODER - Pure-TS ingestion for astro-camera FITS files (SeeStar S30 Pro et al.)
 *
 * Handles the two shapes the SeeStar emits:
 *   NAXIS=3 - stacked planar RGB cube (already demosaiced)
 *   NAXIS=2 - single Bayer CFA sub-frame
 *
 * Data is BITPIX=16 big-endian int16 with the conventional BZERO=32768 fold
 * to unsigned 16-bit physical values. No WASM, no dependencies - runs in
 * Vitest's Node environment and the browser alike.
 */

const BLOCK_SIZE = 2880;
const CARD_SIZE = 80;
const CARDS_PER_BLOCK = 36;

export type BayerPattern = 'RGGB' | 'GRBG' | 'GBRG' | 'BGGR';

const BAYER_PATTERNS: readonly BayerPattern[] = ['RGGB', 'GRBG', 'GBRG', 'BGGR'];

export interface FitsHeader {
    /** All keyword cards (typed values). COMMENT/HISTORY/blank cards are skipped. */
    cards: Map<string, string | number | boolean>;
    bitpix: number;
    naxis: number;
    naxis1: number;
    naxis2: number;
    naxis3: number;
    /** Physical = stored * bscale + bzero (default 0) */
    bzero: number;
    /** Physical = stored * bscale + bzero (default 1) */
    bscale: number;
    /** Byte offset of the primary data unit (headerBlocks * 2880) */
    dataOffset: number;
}

export interface FitsImage {
    header: FitsHeader;
    kind: 'RGB_PLANAR' | 'CFA';
    /** NAXIS=3 only: interleaved RGB normalized to 0..1 (w*h*3) */
    rgbInterleaved?: Float32Array;
    /** NAXIS=2 only: physical 16-bit values, NOT normalized */
    cfa?: Uint16Array;
    width: number;
    height: number;
    /** Header BIAS card (0 when absent) */
    blackLevel: number;
    whiteLevel: number;
    /** From the BAYERPAT card (surfaced even for stacked cubes) */
    bayerPattern?: BayerPattern;
}

// --- HEADER PARSING ---------------------------------------------------------

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
}

/**
 * Parse the text after the "= " value indicator (card bytes 10..79).
 * Splits value from comment at the first "/" OUTSIDE single quotes, then types:
 * quoted string ('' is an escaped quote, trailing pad spaces stripped),
 * T/F boolean, otherwise numeric via parseFloat.
 */
function parseCardValue(text: string): string | number | boolean | undefined {
    let inQuotes = false;
    let valueEnd = text.length;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") inQuotes = !inQuotes; // an escaped '' toggles twice - net unchanged
        else if (ch === '/' && !inQuotes) { valueEnd = i; break; }
    }
    const raw = text.slice(0, valueEnd).trim();
    if (!raw) return undefined; // undefined-value card

    if (raw.startsWith("'")) {
        const closing = raw.lastIndexOf("'");
        const inner = closing > 0 ? raw.slice(1, closing) : raw.slice(1);
        // FITS strings are right-padded with spaces inside the quotes
        return inner.replace(/''/g, "'").replace(/\s+$/, '');
    }
    if (raw === 'T') return true;
    if (raw === 'F') return false;
    return parseFloat(raw);
}

export function parseFitsHeader(buffer: ArrayBuffer): FitsHeader | null {
    const bytes = new Uint8Array(buffer);
    const cards = new Map<string, string | number | boolean>();
    let ended = false;
    let headerBlocks = 0;

    // FITS headers are UNBOUNDED per spec: deep stacks legitimately log thousands
    // of HISTORY cards (observed: 3143 cards -> 89 header blocks in a 13 h IC443
    // stack). The only sane safety bound is the file itself — a header cannot span
    // more 2880-byte blocks than the file physically contains. This admits
    // arbitrarily long real headers AND guarantees termination on a malformed file
    // whose END card is missing (the loop exhausts the buffer and returns null).
    const maxHeaderBlocks = Math.ceil(bytes.length / BLOCK_SIZE);

    for (let block = 0; block < maxHeaderBlocks && !ended; block++) {
        const blockStart = block * BLOCK_SIZE;
        if (blockStart + BLOCK_SIZE > bytes.length) return null; // truncated before END
        headerBlocks++;

        for (let c = 0; c < CARDS_PER_BLOCK; c++) {
            const card = readAscii(bytes, blockStart + c * CARD_SIZE, CARD_SIZE);
            const keyword = card.slice(0, 8).trim();

            if (keyword === 'END') { ended = true; break; }
            if (!keyword || keyword === 'COMMENT' || keyword === 'HISTORY') continue;
            if (card.slice(8, 10) !== '= ') continue; // no value indicator

            const value = parseCardValue(card.slice(10));
            if (value !== undefined) cards.set(keyword, value);
        }
    }
    if (!ended) return null; // corrupt: END never found within the block budget

    if (!cards.has('SIMPLE')) return null;

    // BITPIX 16 = SeeStar-native int16 (+BZERO fold). BITPIX -32 = IEEE
    // float32 — what Siril and most community stacking tools emit. BITPIX 32 =
    // 32-bit signed integer (deep stacks: andromeda/bubble/pleiades emit this
    // with BZERO=2^31, i.e. unsigned-32 physical). Rejecting these silently
    // degraded every processed corpus file to the EXIF fallback
    // (absent-location/wall-clock/unknown camera) despite pristine headers.
    const bitpix = cards.get('BITPIX');
    if (bitpix !== 16 && bitpix !== -32 && bitpix !== 32) return null;

    const naxis = cards.get('NAXIS');
    if (naxis !== 2 && naxis !== 3) return null;

    const naxis1 = typeof cards.get('NAXIS1') === 'number' ? (cards.get('NAXIS1') as number) : 0;
    const naxis2 = typeof cards.get('NAXIS2') === 'number' ? (cards.get('NAXIS2') as number) : 0;
    const naxis3 = typeof cards.get('NAXIS3') === 'number' ? (cards.get('NAXIS3') as number) : 0;
    if (naxis === 3 && naxis3 !== 3) return null;

    const bzero = typeof cards.get('BZERO') === 'number' ? (cards.get('BZERO') as number) : 0;
    const bscale = typeof cards.get('BSCALE') === 'number' ? (cards.get('BSCALE') as number) : 1;

    return {
        cards,
        bitpix,
        naxis,
        naxis1,
        naxis2,
        naxis3,
        bzero,
        bscale,
        dataOffset: headerBlocks * BLOCK_SIZE,
    };
}

// --- IMAGE DECODING ---------------------------------------------------------

export function decodeFitsImage(buffer: ArrayBuffer): FitsImage | null {
    const header = parseFitsHeader(buffer);
    if (!header) return null;

    const width = header.naxis1;
    const height = header.naxis2;
    if (width <= 0 || height <= 0) return null;

    const planes = header.naxis === 3 ? 3 : 1;
    const planeSize = width * height;
    const wideSample = header.bitpix === -32 || header.bitpix === 32; // 4-byte samples
    const bytesPerSample = wideSample ? 4 : 2;
    if (header.dataOffset + planeSize * planes * bytesPerSample > buffer.byteLength) return null; // truncated data

    const biasCard = header.cards.get('BIAS');
    const blackLevel = typeof biasCard === 'number' && Number.isFinite(biasCard) ? biasCard : 0;
    const whiteLevel = 65535;

    const bayerCard = header.cards.get('BAYERPAT');
    const bayerTrimmed = typeof bayerCard === 'string' ? bayerCard.trim() : '';
    const bayerPattern = BAYER_PATTERNS.find(p => p === bayerTrimmed);

    // ── WIDE-SAMPLE FITS (BITPIX=-32 float32 OR BITPIX=32 int32): Siril /
    // community-stack output. Float values are nominally 0..1 but not
    // guaranteed; int32 stacks fold through BZERO=2^31 to a huge unsigned
    // range. Either way we normalize by the OBSERVED range so arbitrary
    // scalings land in our [0,1] contract. NaN → 0. The float32 reader path is
    // unchanged (byte-identical); int32 only swaps the raw sample accessor.
    if (wideSample) {
        const fview = new DataView(buffer);
        const readRaw = header.bitpix === -32
            ? (byteOff: number): number => fview.getFloat32(byteOff, false)
            : (byteOff: number): number => fview.getInt32(byteOff, false);
        const total = planeSize * planes;
        let lo = Infinity, hi = -Infinity;
        const stride = Math.max(1, Math.floor(total / 200_000));
        for (let i = 0; i < total; i += stride) {
            const v = readRaw(header.dataOffset + i * 4) * header.bscale + header.bzero;
            if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        if (!Number.isFinite(lo) || hi - lo <= 0) return null;
        const inv = 1 / (hi - lo);
        const readNorm = (idx: number): number => {
            const v = readRaw(header.dataOffset + idx * 4) * header.bscale + header.bzero;
            if (!Number.isFinite(v)) return 0;
            const t = (v - lo) * inv;
            return t < 0 ? 0 : (t > 1 ? 1 : t);
        };
        if (planes === 3) {
            const rgb = new Float32Array(planeSize * 3);
            for (let p = 0; p < 3; p++) {
                for (let i = 0; i < planeSize; i++) rgb[i * 3 + p] = readNorm(p * planeSize + i);
            }
            return { header, kind: 'RGB_PLANAR', rgbInterleaved: rgb, width, height, blackLevel: 0, whiteLevel: 65535, bayerPattern };
        }
        // Float CFA sub (Siril-calibrated singles): fold back to the Uint16 contract.
        const cfaF = new Uint16Array(planeSize);
        for (let i = 0; i < planeSize; i++) cfaF[i] = Math.round(readNorm(i) * 65535);
        return { header, kind: 'CFA', cfa: cfaF, width, height, blackLevel: 0, whiteLevel: 65535, bayerPattern };
    }

    const bytes = new Uint8Array(buffer);
    // Fast path: big-endian int16 + BZERO=32768 fold. XOR of the sign bit IS the
    // +32768 offset on two's-complement, so no DataView / no per-pixel arithmetic.
    const fastPath = header.bzero === 32768 && header.bscale === 1;
    const view = fastPath ? null : new DataView(buffer);

    if (planes === 3) {
        // Plane order is assumed R,G,B (SeeStar stacked cubes). If E2E shows
        // swapped R/B, the fix is this channel map: rgb[i*3 + p].
        const rgb = new Float32Array(planeSize * 3);
        const invRange = 1 / (whiteLevel - blackLevel);

        for (let p = 0; p < 3; p++) {
            const base = header.dataOffset + p * planeSize * 2;
            if (fastPath) {
                for (let i = 0; i < planeSize; i++) {
                    const off = base + i * 2;
                    const phys = (((bytes[off] << 8) | bytes[off + 1]) ^ 0x8000);
                    const v = (phys - blackLevel) * invRange;
                    rgb[i * 3 + p] = v < 0 ? 0 : (v > 1 ? 1 : v);
                }
            } else {
                for (let i = 0; i < planeSize; i++) {
                    const off = base + i * 2;
                    let phys = view!.getInt16(off, false) * header.bscale + header.bzero;
                    phys = phys < 0 ? 0 : (phys > 65535 ? 65535 : phys);
                    const v = (phys - blackLevel) * invRange;
                    rgb[i * 3 + p] = v < 0 ? 0 : (v > 1 ? 1 : v);
                }
            }
        }
        return { header, kind: 'RGB_PLANAR', rgbInterleaved: rgb, width, height, blackLevel, whiteLevel, bayerPattern };
    }

    // NAXIS=2: raw CFA in physical units - normalization happens downstream
    // (demosaic / PhotometryManager), matching the LibRaw DSLR contract.
    const cfa = new Uint16Array(planeSize);
    const base = header.dataOffset;
    if (fastPath) {
        for (let i = 0; i < planeSize; i++) {
            const off = base + i * 2;
            cfa[i] = ((bytes[off] << 8) | bytes[off + 1]) ^ 0x8000;
        }
    } else {
        for (let i = 0; i < planeSize; i++) {
            const off = base + i * 2;
            const phys = view!.getInt16(off, false) * header.bscale + header.bzero;
            cfa[i] = phys < 0 ? 0 : (phys > 65535 ? 65535 : phys);
        }
    }
    return { header, kind: 'CFA', cfa, width, height, blackLevel, whiteLevel, bayerPattern };
}

// --- METADATA MAPPING -------------------------------------------------------

/**
 * Map FITS header cards onto the HardMetadata contract.
 * BAYERPAT is deliberately NOT mapped here - it travels on FitsImage/sensorData.
 */
export function fitsHeaderToHardMetadata(header: FitsHeader): {
    hard: Partial<HardMetadata>;
    rawTags: Record<string, string | number>;
    warnings: string[];
} {
    const hard: Partial<HardMetadata> = {};
    const rawTags: Record<string, string | number> = {};
    const warnings: string[] = [];

    for (const [key, value] of header.cards) {
        rawTags[key] = typeof value === 'boolean' ? (value ? 'T' : 'F') : value;
    }

    const str = (key: string): string | undefined => {
        const v = header.cards.get(key);
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const num = (key: string): number | undefined => {
        const v = header.cards.get(key);
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    // Identity
    const creator = str('CREATOR');
    const instrume = str('INSTRUME');
    hard.camera_model = creator ?? (instrume ? `FITS ${instrume}` : 'Unknown FITS Camera');
    hard.lens_model = str('TELESCOP') ?? 'FITS Optics';

    // Optics / exposure
    const focalLen = num('FOCALLEN');
    if (focalLen !== undefined && focalLen > 0) hard.focal_length = focalLen;

    const pixSz = num('XPIXSZ');
    if (pixSz !== undefined && pixSz > 0) hard.pixel_pitch_um = pixSz;

    // Raw ZWO gain SETTING (not ISO, not e-/ADU) - never feed to getGainForISO.
    const gain = num('GAIN');
    if (gain !== undefined) hard.iso_gain = gain;

    const exposure = num('EXPTIME') ?? num('EXPOSURE');
    if (exposure !== undefined && exposure > 0) hard.exposure_time = exposure;

    // FITS APERTURE is often a diameter in mm; only accept plausible f-numbers.
    const aperture = num('APERTURE');
    if (aperture !== undefined) {
        if (aperture > 0.5 && aperture < 64) hard.aperture = aperture;
        else warnings.push(`FITS APERTURE=${aperture} outside plausible f-number range (0.5..64) - ignored`);
    }

    // Timestamp: a bare ISO string parses as LOCAL time in JS, but FITS
    // DATE-OBS is UTC by convention - force 'Z' when no TZ designator exists.
    //
    // STACK TIME SEMANTICS (multi-hour sessions): for stacked output the
    // ephemeris-correct instant is the INTEGRATION MIDPOINT, not DATE-OBS.
    // When DATE-END exists we can compute the midpoint deterministically.
    // Without it we would have to GUESS whether DATE-OBS marks the first
    // sub, the last sub, or the save time (SeeStar firmware varies) - so we
    // keep DATE-OBS as-is and record the ambiguity as a warning instead of
    // silently "correcting" in an unknown direction. STACKCNT/LIVETIME are
    // captured for downstream consumers either way.
    const parseFitsDate = (s: string): Date | null => {
        const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
        const d = new Date(hasTz ? s : `${s}Z`);
        return isNaN(d.getTime()) ? null : d;
    };
    const dateObs = str('DATE-OBS');
    const dateEnd = str('DATE-END');
    const stackCnt = num('STACKCNT') ?? num('NSTACK');
    if (stackCnt !== undefined && stackCnt > 0) (hard as any).stack_count = stackCnt;
    const liveTime = num('LIVETIME') ?? num('TOTALEXP');
    if (liveTime !== undefined && liveTime > 0) (hard as any).total_integration_s = liveTime;

    // Siril convention: EXPSTART/EXPEND as Julian Dates. Only midpoint when
    // the span is a single session (<=2 days) — multi-month project stacks
    // (observed: 446-day M51 composites) have no meaningful single instant.
    const jdToDate = (jd: number): Date => new Date((jd - 2440587.5) * 86400000);
    const expStartJd = num('EXPSTART');
    const expEndJd = num('EXPEND');

    if (dateObs) {
        const start = parseFitsDate(dateObs);
        if (start) {
            let end = dateEnd ? parseFitsDate(dateEnd) : null;
            if (!end && expStartJd !== undefined && expEndJd !== undefined
                && expEndJd > expStartJd && (expEndJd - expStartJd) <= 2) {
                end = jdToDate(expEndJd);
            }
            if (end && end.getTime() > start.getTime()) {
                // Deterministic midpoint - the honest instant for a stack.
                hard.timestamp = new Date((start.getTime() + end.getTime()) / 2).toISOString();
                hard.timestamp_source = 'FITS';
                warnings.push(`Stack timestamp set to DATE-OBS/DATE-END midpoint (span ${((end.getTime() - start.getTime()) / 3.6e6).toFixed(2)}h).`);
            } else {
                hard.timestamp = start.toISOString();
                hard.timestamp_source = 'FITS';
                if ((stackCnt ?? 1) > 1) {
                    const spanH = ((stackCnt! * (hard.exposure_time ?? 0)) / 3600).toFixed(2);
                    warnings.push(`Stacked file (${stackCnt} frames, ~${spanH}h integration) has no DATE-END - timestamp is DATE-OBS and may be offset from the integration midpoint. Ephemeris/alt-az results carry that uncertainty; the plate solve is unaffected (time-independent).`);
                }
            }
        } else {
            warnings.push(`FITS DATE-OBS '${dateObs}' is not a parsable timestamp - ignored`);
        }
    } else if (expStartJd !== undefined && Number.isFinite(expStartJd) && expStartJd > 2400000) {
        // No DATE-OBS at all but a Julian start exists (some Siril exports).
        hard.timestamp = jdToDate(expStartJd).toISOString();
        hard.timestamp_source = 'FITS';
        warnings.push('Timestamp derived from EXPSTART (Julian Date) - no DATE-OBS present.');
    }

    // Site GPS - only trusted when BOTH coordinates are present.
    const siteLat = num('SITELAT');
    const siteLon = num('SITELONG');
    if (siteLat !== undefined && siteLon !== undefined) {
        hard.gps_lat = siteLat;
        hard.gps_lon = siteLon;
        hard.gps_source = 'FITS';
    }

    // GOTO pointing hints: header RA is in DEGREES, the hint contract is HOURS.
    const ra = num('RA');
    if (ra !== undefined) hard.ra_hint = ra / 15;
    const dec = num('DEC');
    if (dec !== undefined) hard.dec_hint = dec;

    // Geometry (also mirrored into rawTags for the solver's sensor-width sniff)
    hard.width = header.naxis1;
    hard.height = header.naxis2;
    rawTags.ImageWidth = header.naxis1;
    rawTags.ImageHeight = header.naxis2;

    // Derived pixel scale (arcsec/px) - the solver's highest-leverage input.
    if (focalLen !== undefined && focalLen > 0 && pixSz !== undefined && pixSz > 0) {
        hard.pixel_scale = computePixelScale(focalLen, pixSz);
    }

    return { hard, rawTags, warnings };
}
