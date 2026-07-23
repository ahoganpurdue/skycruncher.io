import { describe, it, expect } from 'vitest';
import { buildSyntheticFits } from './helpers/fits_builder';
import { parseFitsHeader, decodeFitsImage, fitsHeaderToHardMetadata } from '../pipeline/m1_ingestion/fits_decoder';
import { metadata_reaper } from '../pipeline/m1_ingestion/metadata_reaper';
import { PhotometryManager } from '../pipeline/m8_photometry/photometry_manager';

// Card values from the real in-repo sample:
// Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit
const SEESTAR_CARDS = {
    CREATOR: 'ZWO Seestar S30 Pro',
    INSTRUME: 'imx585',
    FOCALLEN: 160,
    XPIXSZ: 2.9,
    RA: 170.425003051758,
    DEC: 12.8419437408447,
    SITELAT: 46.2183990478516,
    SITELONG: -84.068000793457,
    'DATE-OBS': '2026-05-16T03:54:45.084869',
    GAIN: 200,
    EXPTIME: 60,
    BIAS: 1109,
    BAYERPAT: 'GRBG',
};

describe('M1 FITS Header Parser', () => {

    it('parses a header spanning two 2880-byte blocks and finds END', () => {
        // 7 base cards + 40 extras + END = 48 cards -> 2 header blocks
        const cards: Record<string, number> = {};
        for (let i = 0; i < 40; i++) cards[`TST${String(i).padStart(4, '0')}`] = i;

        const buf = buildSyntheticFits({ naxis: 2, width: 4, height: 4, cards });
        const header = parseFitsHeader(buf);

        expect(header).not.toBeNull();
        expect(header!.dataOffset).toBe(2 * 2880);
        expect(header!.cards.get('TST0000')).toBe(0);
        expect(header!.cards.get('TST0039')).toBe(39);
        expect(header!.naxis1).toBe(4);
        expect(header!.naxis2).toBe(4);
        expect(header!.bzero).toBe(32768);
        expect(header!.bscale).toBe(1);
    });

    it('parses a header spanning MORE than 64 blocks (deep-stack HISTORY logs) and finds END', () => {
        // Deep stacks legitimately emit thousands of HISTORY cards. 2400 extra
        // cards + 8 base + END => ~67 header blocks, past the old 64-block cap
        // that silently killed IC443 (89 blocks) and every other deep stack.
        const cards: Record<string, number> = {};
        for (let i = 0; i < 2400; i++) cards[`TST${String(i).padStart(4, '0')}`] = i;

        const buf = buildSyntheticFits({ naxis: 2, width: 4, height: 4, cards });
        const header = parseFitsHeader(buf);

        expect(header).not.toBeNull();
        expect(header!.dataOffset / 2880).toBeGreaterThan(64); // header exceeds the old cap
        expect(header!.cards.get('TST2399')).toBe(2399);       // last extra card was read
        const img = decodeFitsImage(buf);
        expect(img).not.toBeNull();                            // full decode, not just header
        expect(img!.kind).toBe('CFA');
    });

    it('terminates safely (returns null, no hang) on a malformed header with no END card', () => {
        // 4 blocks of ASCII spaces — a spec-legal SIMPLE card but END is never
        // emitted. The old fixed cap masked this; the file-size bound must still
        // guarantee termination rather than spinning past the buffer.
        const blocks = 4;
        const buf = new ArrayBuffer(blocks * 2880);
        const u8 = new Uint8Array(buf);
        u8.fill(0x20);
        const simple = "SIMPLE  =                    T";
        for (let i = 0; i < simple.length; i++) u8[i] = simple.charCodeAt(i);
        expect(parseFitsHeader(buf)).toBeNull(); // no END within the file bound
    });

    it('types card values: quoted strings (with escaped quotes), booleans, numbers', () => {
        const buf = buildSyntheticFits({
            naxis: 2, width: 2, height: 2,
            cards: { OBJECT: "M 66 / Leo's Triplet", TRACKING: true, STACKCNT: 738, TEMP: -9.5 },
        });
        const header = parseFitsHeader(buf)!;
        // The "/" inside the quoted string must NOT be treated as a comment split
        expect(header.cards.get('OBJECT')).toBe("M 66 / Leo's Triplet");
        expect(header.cards.get('TRACKING')).toBe(true);
        expect(header.cards.get('STACKCNT')).toBe(738);
        expect(header.cards.get('TEMP')).toBe(-9.5);
    });

    it('rejects unsupported headers and corrupt buffers', () => {
        // BITPIX override (base card is overwritten by the later duplicate)
        const bad = buildSyntheticFits({ naxis: 2, width: 2, height: 2, cards: { BITPIX: 8 } });
        expect(parseFitsHeader(bad)).toBeNull();

        // Garbage buffer smaller than one block
        expect(parseFitsHeader(new ArrayBuffer(100))).toBeNull();
    });
});

describe('M1 FITS Image Decoder', () => {

    it('round-trips physical 1109 through the fast XOR path (BZERO=32768)', () => {
        const buf = buildSyntheticFits({ naxis: 2, width: 8, height: 8, pixelFn: () => 1109 });
        const img = decodeFitsImage(buf)!;

        expect(img.kind).toBe('CFA');
        expect(img.cfa![0]).toBe(1109);
        expect(img.cfa![63]).toBe(1109);
    });

    it('round-trips physical 1109 through the generic DataView path (BZERO=0)', () => {
        const buf = buildSyntheticFits({ naxis: 2, width: 8, height: 8, bzero: 0, pixelFn: () => 1109 });
        const img = decodeFitsImage(buf)!;

        expect(img.header.bzero).toBe(0);
        expect(img.cfa![0]).toBe(1109);
    });

    it('fast XOR path and generic path agree pixel-for-pixel', () => {
        const fn = (x: number, y: number) => (x * 997 + y * 131) % 30000;
        const fast = decodeFitsImage(buildSyntheticFits({ naxis: 2, width: 16, height: 16, pixelFn: fn }))!;
        const slow = decodeFitsImage(buildSyntheticFits({ naxis: 2, width: 16, height: 16, bzero: 0, pixelFn: fn }))!;

        expect(fast.cfa).toEqual(slow.cfa);
    });

    it('interleaves NAXIS=3 planes in R,G,B order with 0..1 normalization', () => {
        const w = 4, h = 2;
        const buf = buildSyntheticFits({
            naxis: 3, width: w, height: h,
            pixelFn: (x, y, p) => 1000 * (p + 1) + y * w + x,
        });
        const img = decodeFitsImage(buf)!;

        expect(img.kind).toBe('RGB_PLANAR');
        const rgb = img.rgbInterleaved!;
        expect(rgb.length).toBe(w * h * 3);
        // No BIAS card -> blackLevel 0 -> value = phys / 65535
        for (let i = 0; i < w * h; i++) {
            for (let p = 0; p < 3; p++) {
                expect(rgb[i * 3 + p]).toBeCloseTo((1000 * (p + 1) + i) / 65535, 6);
            }
        }
    });

    it('normalizes NAXIS=3 against the header BIAS and clamps to [0,1]', () => {
        const buf = buildSyntheticFits({
            naxis: 3, width: 2, height: 1, cards: { BIAS: 1109 },
            pixelFn: (x, _y, p) => (x === 0 ? (p === 0 ? 500 : 1109) : 65535),
        });
        const img = decodeFitsImage(buf)!;

        expect(img.blackLevel).toBe(1109);
        const rgb = img.rgbInterleaved!;
        expect(rgb[0]).toBe(0);              // 500 < BIAS -> clamped to 0
        expect(rgb[1]).toBe(0);              // 1109 - BIAS = 0
        expect(rgb[3]).toBeCloseTo(1, 6);    // 65535 -> 1
    });

    it('keeps NAXIS=2 CFA as physical Uint16 values (no normalization, rows as stored)', () => {
        const w = 6, h = 4;
        const buf = buildSyntheticFits({
            naxis: 2, width: w, height: h,
            cards: { BIAS: 1109, BAYERPAT: 'GRBG' },
            pixelFn: (x, y) => 1109 + y * w + x,
        });
        const img = decodeFitsImage(buf)!;

        expect(img.kind).toBe('CFA');
        expect(img.cfa).toBeInstanceOf(Uint16Array);
        expect(img.bayerPattern).toBe('GRBG');
        expect(img.blackLevel).toBe(1109);
        expect(img.whiteLevel).toBe(65535);
        for (let i = 0; i < w * h; i++) expect(img.cfa![i]).toBe(1109 + i);
    });

    it('decodes a BITPIX=32 (int32) NAXIS=3 cube via range normalization', () => {
        // Deep community stacks (andromeda/bubble/pleiades) emit 32-bit signed
        // integers folded through BZERO=2^31. The decoder must range-normalize
        // like the float path rather than reject them at BITPIX.
        const w = 4, h = 2;
        // Distinct positive physical values; global min at (p0,y0,x0)=5000,
        // global max at (p2,y1,x3)=5000+2000+400+300=7700.
        const phys = (x: number, y: number, p: number) => 5000 + p * 1000 + y * 400 + x * 100;
        const buf = buildSyntheticFits({
            naxis: 3, width: w, height: h, bitpix: 32, bzero: 2147483648, bscale: 1, pixelFn: phys,
        });
        const header = parseFitsHeader(buf)!;
        expect(header.bitpix).toBe(32);

        const img = decodeFitsImage(buf)!;
        expect(img).not.toBeNull();
        expect(img.kind).toBe('RGB_PLANAR');
        const rgb = img.rgbInterleaved!;
        expect(rgb.length).toBe(w * h * 3);
        // min physical -> 0, max physical -> 1, everything in [0,1] and ordered.
        expect(rgb[0 * 3 + 0]).toBe(0);                 // (p=0, i=0) = 5000 = min
        expect(rgb[7 * 3 + 2]).toBeCloseTo(1, 6);       // (p=2, i=7) = 7700 = max
        for (const v of rgb) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    });

    it('returns null when the data unit is truncated', () => {
        const buf = buildSyntheticFits({ naxis: 2, width: 100, height: 100 });
        const truncated = buf.slice(0, 2880 + 100);
        expect(parseFitsHeader(truncated)).not.toBeNull(); // header itself is intact
        expect(decodeFitsImage(truncated)).toBeNull();
    });
});

describe('M1 FITS Metadata Mapping', () => {

    it('maps the SeeStar S30 Pro header cards onto HardMetadata', () => {
        const buf = buildSyntheticFits({ naxis: 3, width: 8, height: 4, cards: SEESTAR_CARDS });
        const { hard, rawTags } = fitsHeaderToHardMetadata(parseFitsHeader(buf)!);

        expect(hard.camera_model).toBe('ZWO Seestar S30 Pro');
        expect(hard.lens_model).toBe('FITS Optics'); // no TELESCOP card -> fallback
        expect(hard.focal_length).toBe(160);
        expect(hard.pixel_pitch_um).toBe(2.9);
        expect(hard.iso_gain).toBe(200);             // raw ZWO gain SETTING
        expect(hard.exposure_time).toBe(60);

        // RA is degrees in the header, hours in the hint contract
        expect(hard.ra_hint).toBeCloseTo(11.36166687, 5);
        expect(hard.dec_hint).toBeCloseTo(12.8419437408447, 6);

        expect(hard.gps_lat).toBeCloseTo(46.2183990478516, 6);
        expect(hard.gps_lon).toBeCloseTo(-84.068000793457, 6);
        expect(hard.gps_source).toBe('FITS');

        expect(hard.timestamp_source).toBe('FITS');
        expect(hard.timestamp!.endsWith('Z')).toBe(true);
        expect(Math.abs(Date.parse(hard.timestamp!) - Date.UTC(2026, 4, 16, 3, 54, 45, 84))).toBeLessThan(1000);

        expect(Math.abs(hard.pixel_scale! - 3.7386)).toBeLessThan(0.001);

        expect(hard.width).toBe(8);
        expect(hard.height).toBe(4);
        expect(rawTags.ImageWidth).toBe(8);
        expect(rawTags.ImageHeight).toBe(4);
        // All cards pass through into rawTags; BAYERPAT stays out of HardMetadata
        expect(rawTags.BAYERPAT).toBe('GRBG');
        expect(rawTags.SIMPLE).toBe('T');
    });

    it('falls back for identity fields and rejects implausible APERTURE', () => {
        const onlyInstrume = buildSyntheticFits({
            naxis: 2, width: 2, height: 2, cards: { INSTRUME: 'imx585', APERTURE: 500 },
        });
        const mapped = fitsHeaderToHardMetadata(parseFitsHeader(onlyInstrume)!);
        expect(mapped.hard.camera_model).toBe('FITS imx585');
        expect(mapped.hard.aperture).toBeUndefined();
        expect(mapped.warnings.some(w => w.includes('APERTURE'))).toBe(true);

        const bare = buildSyntheticFits({ naxis: 2, width: 2, height: 2 });
        const bareMapped = fitsHeaderToHardMetadata(parseFitsHeader(bare)!);
        expect(bareMapped.hard.camera_model).toBe('Unknown FITS Camera');
        expect(bareMapped.hard.gps_source).toBeUndefined(); // no SITELAT/SITELONG -> untouched
    });
});

describe('M1 Metadata Reaper FITS routing', () => {

    it('parseExif routes FITS and programs the PhotometryManager profile', async () => {
        const buf = buildSyntheticFits({ naxis: 3, width: 8, height: 4, cards: SEESTAR_CARDS });
        const result = await metadata_reaper.parseExif(buf);

        expect(result.format).toBe('FITS');
        expect(result.isRaw).toBe(true);
        expect(result.hard.camera_model).toBe('ZWO Seestar S30 Pro');
        expect(result.hard.iso_gain).toBe(200);
        expect(result.hard.gps_source).toBe('FITS');

        const profile = PhotometryManager.getProfile();
        expect(profile.black_level).toBe(1109);
        expect(profile.white_level).toBe(65535);
        expect(profile.bit_depth).toBe(16);
        expect(profile.model).toBe('imx585');
        expect(profile.pixel_size_um).toBe(2.9);
        // GAIN=200 via the IMX585 LUT: 0.65 native / 2^4 = 0.040625 e-/16-bit-ADU
        expect(profile.gain_e_adu).toBeCloseTo(0.040625, 4);
    });

    it('extract() returns interleaved RGB sensorData for a NAXIS=3 cube', async () => {
        const w = 8, h = 4;
        const buf = buildSyntheticFits({
            naxis: 3, width: w, height: h, cards: SEESTAR_CARDS, pixelFn: () => 2000,
        });
        const result = await metadata_reaper.extract(buf);
        const sd = result.sensorData!;

        expect(sd.isDemosaiced).toBe(true);
        expect(sd.data).toBeInstanceOf(Float32Array);
        expect(sd.data.length).toBe(w * h * 3);
        expect(sd.stride).toBe(w);
        expect(sd.bayerPattern).toBe('GRBG');
        expect(sd.arrowTable).toBeDefined();
    });

    it('extract() returns physical CFA sensorData for a NAXIS=2 sub-frame', async () => {
        const w = 8, h = 4;
        const buf = buildSyntheticFits({
            naxis: 2, width: w, height: h, cards: SEESTAR_CARDS, pixelFn: () => 1500,
        });
        const result = await metadata_reaper.extract(buf);
        const sd = result.sensorData!;

        expect(sd.isDemosaiced).toBe(false);
        expect(sd.data).toBeInstanceOf(Uint16Array);
        expect(sd.data[0]).toBe(1500);
        expect(sd.stride).toBe(w);
        expect(sd.bayerPattern).toBe('GRBG');
        expect(sd.arrowTable).toBeDefined();
    });
});
