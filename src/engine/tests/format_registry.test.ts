import { describe, it, expect } from 'vitest';
import { detectMagicFormatSync } from '../pipeline/m1_ingestion/metadata_reaper';
import {
    sniffFormatId,
    supportedExtensions,
    acceptAttribute,
    supportedFormatsLabel,
    isSupportedFilename,
    getFormatTier,
    isDemoTierFormat,
    FORMAT_REGISTRY,
} from '../pipeline/m1_ingestion/format_registry';

/** Build a fixed-size ArrayBuffer with `bytes` written at the front (rest 0). */
function mkBuf(bytes: number[], size = 16): ArrayBuffer {
    const u8 = new Uint8Array(size);
    u8.set(bytes.slice(0, size));
    return u8.buffer;
}

// Container signatures (magic bytes only — no payload).
const FITS = mkBuf([0x53, 0x49, 0x4d, 0x50, 0x4c, 0x45, 0x20, 0x20, 0x3d]); // "SIMPLE  ="
const CR2_LE = mkBuf([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52]); // II + "CR"@8
const CR2_BE = mkBuf([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x43, 0x52]); // MM + "CR"@8
const TIFF = mkBuf([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]); // II, no "CR"
const JPEG = mkBuf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
// Fujifilm RAF: "FUJIFILMCCD-RAW" magic at offset 0 (real file continues with a
// version string + model, e.g. DSCF4954.RAF = "…0201FF179502X-T5").
const RAF = mkBuf([0x46, 0x55, 0x4a, 0x49, 0x46, 0x49, 0x4c, 0x4d, 0x43, 0x43, 0x44, 0x2d, 0x52, 0x41, 0x57, 0x20]); // "FUJIFILMCCD-RAW "
const UNKNOWN = mkBuf([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
const SHORT = mkBuf([0x53, 0x49, 0x4d, 0x50, 0x4c, 0x45], 6); // "SIMPLE" but < 12 bytes

/**
 * ORACLE = the exact former inline detectMagicFormatSync body (pre-registry).
 * The registry-driven implementation must remain byte-identical to this for
 * every buffer — this is the dispatch-equivalence guard.
 */
function oracle(buffer: ArrayBuffer): string {
    const view = new DataView(buffer);
    if (view.byteLength < 12) return 'UNKNOWN';
    if (view.getUint32(0) === 0x53494d50 && view.getUint16(4) === 0x4c45) return 'FITS';
    const b0 = view.getUint8(0);
    const b1 = view.getUint8(1);
    if ((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d)) {
        if (view.getUint8(8) === 0x43 && view.getUint8(9) === 0x52) return 'CR2';
        return 'TIFF';
    }
    if (b0 === 0xff && b1 === 0xd8) return 'JPEG';
    return 'UNKNOWN';
}

describe('format_registry — magic-byte sniff', () => {
    it('sniffFormatId identifies registered formats and only those', () => {
        expect(sniffFormatId(FITS)).toBe('FITS');
        expect(sniffFormatId(CR2_LE)).toBe('CR2');
        expect(sniffFormatId(CR2_BE)).toBe('CR2');
        // Demo-tier formats (2026-07-11): TIFF/JPEG now ingest at demo tier
        // (event-funnel — a phone photo solves for real, radiometry approximate).
        expect(sniffFormatId(TIFF)).toBe('TIFF');
        expect(sniffFormatId(JPEG)).toBe('JPEG');
        // RAF (Fuji X-Trans) — unique "FUJIFILMCCD-RAW" magic, science tier.
        expect(sniffFormatId(RAF)).toBe('RAF');
        expect(sniffFormatId(UNKNOWN)).toBeNull();
    });

    it('a Canon CR2 (II/MM + "CR"@8) wins over the bare-TIFF demo sniff', () => {
        // Ordering guard: CR2 shares the II/MM signature, so it MUST resolve
        // before the demo TIFF descriptor or every CR2 would mis-route to demo.
        expect(sniffFormatId(CR2_LE)).toBe('CR2');
        expect(sniffFormatId(CR2_BE)).toBe('CR2');
    });

    it('registry order is FITS, CR2, RAF, then the demo formats (first positive sniff wins)', () => {
        expect(FORMAT_REGISTRY.map((d) => d.id)).toEqual(['FITS', 'CR2', 'RAF', 'JPEG', 'TIFF']);
    });
});

describe('format_registry — honesty tier (LAW 3)', () => {
    it('FITS + CR2 + RAF are science tier; TIFF + JPEG are demo tier', () => {
        expect(getFormatTier('FITS')).toBe('science');
        expect(getFormatTier('CR2')).toBe('science');
        expect(getFormatTier('RAF')).toBe('science');
        expect(getFormatTier('JPEG')).toBe('demo');
        expect(getFormatTier('TIFF')).toBe('demo');
    });

    it('isDemoTierFormat flags only registered demo formats', () => {
        expect(isDemoTierFormat('JPEG')).toBe(true);
        expect(isDemoTierFormat('TIFF')).toBe(true);
        expect(isDemoTierFormat('FITS')).toBe(false);
        expect(isDemoTierFormat('CR2')).toBe(false);
        expect(isDemoTierFormat('RAF')).toBe(false);
        // Wider ExifResult['format'] strings that are NOT registered:
        expect(isDemoTierFormat('NEF')).toBe(false);
        expect(isDemoTierFormat('UNKNOWN')).toBe(false);
    });

    it('demo-tier descriptors are already-demosaiced RGB (cfa false)', () => {
        for (const id of ['JPEG', 'TIFF'] as const) {
            const desc = FORMAT_REGISTRY.find((d) => d.id === id)!;
            expect(desc.capabilities.cfa).toBe(false);
        }
    });
});

describe('format_registry — detectMagicFormatSync dispatch equivalence', () => {
    for (const [name, buf] of Object.entries({ FITS, CR2_LE, CR2_BE, TIFF, JPEG, UNKNOWN, SHORT })) {
        it(`matches the pre-registry oracle for ${name}`, () => {
            expect(detectMagicFormatSync(buf)).toBe(oracle(buf));
        });
    }
});

describe('format_registry — UI derivation (single source of truth)', () => {
    it('accept attribute + supported extensions derive from the registry', () => {
        expect(supportedExtensions()).toEqual(['fits', 'fit', 'cr2', 'raf', 'jpg', 'jpeg', 'tif', 'tiff']);
        expect(acceptAttribute()).toBe('.fits,.fit,.cr2,.raf,.jpg,.jpeg,.tif,.tiff');
    });

    it('supported-formats label lists the registered display names (demo tier labeled)', () => {
        expect(supportedFormatsLabel()).toBe(
            'FITS/FIT (SeeStar, ZWO), Canon CR2, Fujifilm RAF (X-Trans), JPEG (demo tier), TIFF (demo tier)'
        );
    });

    it('isSupportedFilename validates by extension, case-insensitive', () => {
        expect(isSupportedFilename('capture.CR2')).toBe(true);
        expect(isSupportedFilename('DSCF4954.RAF')).toBe(true);
        expect(isSupportedFilename('M66.fits')).toBe(true);
        expect(isSupportedFilename('sub.fit')).toBe(true);
        // Demo-tier phone/scan formats now accepted:
        expect(isSupportedFilename('phone.jpg')).toBe(true);
        expect(isSupportedFilename('phone.JPEG')).toBe(true);
        expect(isSupportedFilename('scan.tiff')).toBe(true);
        expect(isSupportedFilename('scan.TIF')).toBe(true);
        // Still rejected (not registered):
        expect(isSupportedFilename('photo.png')).toBe(false);
        expect(isSupportedFilename('scan.nef')).toBe(false);
        expect(isSupportedFilename('noext')).toBe(false);
    });
});
