import { describe, it, expect } from 'vitest';
import { serializeFits, fitsFileName, type FitsImage } from '../pipeline/export/fits_writer';

const BLOCK = 2880;
const CARD = 80;

/** Parse FITS header cards (key → raw value text) up to the END card, and return
 * the byte offset where the data segment begins (a whole 2880 multiple). */
function parseHeader(buf: Uint8Array): { cards: Record<string, string>; comments: string[]; dataStart: number } {
    const cards: Record<string, string> = {};
    const comments: string[] = [];
    const text = new TextDecoder('latin1').decode(buf);
    let dataStart = 0;
    outer: for (let b = 0; b * BLOCK < buf.length; b++) {
        for (let i = 0; i < BLOCK; i += CARD) {
            const start = b * BLOCK + i;
            const card = text.slice(start, start + CARD);
            if (card.startsWith('END') && card.slice(3).trim() === '') {
                dataStart = (b + 1) * BLOCK;
                break outer;
            }
            if (card.startsWith('COMMENT')) { comments.push(card.slice(7).trim()); continue; }
            const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^/]*)/);
            if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
        }
    }
    return { cards, comments, dataStart };
}

/** Read the big-endian float32 data segment as an array. */
function readData(buf: Uint8Array, dataStart: number, count: number): number[] {
    const dv = new DataView(buf.buffer, buf.byteOffset + dataStart);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(dv.getFloat32(i * 4, false));
    return out;
}

function makeReceipt(extra: any = {}) {
    return {
        version: '2.3.0',
        solution: {
            spatial_hash: 'cafebabe',
            ra_hours: 11.34,
            astrometry: { rms_arcsec: 0.5 },
        },
        wcs: {
            CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
            CRPIX1: 100, CRPIX2: 50,          // engine 0-based
            CRVAL1: 170.1188, CRVAL2: -22.4,  // ALREADY degrees
            // negative-determinant CD (a parity flip) — sign carry must be exact
            CD1_1: -1.021e-3, CD1_2: 3.5e-4, CD2_1: 3.5e-4, CD2_2: 1.021e-3,
            EQUINOX: 2000.0, RADESYS: 'ICRS', SOURCE: 'FITTED',
        },
        ...extra,
    };
}

const monoImg = (w: number, h: number, fill?: (i: number) => number): FitsImage => {
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = fill ? fill(i) : i * 0.5 + 0.25;
    return { data, width: w, height: h, channels: 1 };
};

describe('serializeFits — byte layout + WCS carry', () => {
    it('pads the header AND the whole stream to a 2880 multiple', () => {
        const out = serializeFits(makeReceipt(), monoImg(8, 6));
        const { dataStart } = parseHeader(out);
        expect(dataStart % BLOCK).toBe(0);
        expect(out.length % BLOCK).toBe(0);
        // data segment (8*6*4 = 192 bytes) padded up to one 2880 block.
        expect(out.length).toBe(dataStart + BLOCK);
    });

    it('writes mandatory geometry cards for a mono BITPIX=-32 frame', () => {
        const out = serializeFits(makeReceipt(), monoImg(8, 6));
        const { cards } = parseHeader(out);
        expect(cards.SIMPLE).toBe('T');
        expect(cards.BITPIX).toBe('-32');
        expect(cards.NAXIS).toBe('2');
        expect(cards.NAXIS1).toBe('8');
        expect(cards.NAXIS2).toBe('6');
        expect(cards.NAXIS3).toBeUndefined();
    });

    it('converts CRPIX to 1-based but carries CRVAL/CD VERBATIM (no ×15)', () => {
        const r = makeReceipt();
        const out = serializeFits(r, monoImg(8, 6));
        const { cards } = parseHeader(out);
        // CRPIX +1 (engine 0-based → FITS 1-based)
        expect(Number(cards.CRPIX1)).toBe(101);
        expect(Number(cards.CRPIX2)).toBe(51);
        // CRVAL consumed verbatim — NOT re-multiplied by 15 (already degrees)
        expect(Number(cards.CRVAL1)).toBe(170.1188);
        expect(Number(cards.CRVAL2)).toBe(-22.4);
    });

    it('carries the CD matrix sign-exact (negative determinant / parity flip)', () => {
        const out = serializeFits(makeReceipt(), monoImg(8, 6));
        const { cards } = parseHeader(out);
        expect(Number(cards.CD1_1)).toBe(-1.021e-3);
        expect(Number(cards.CD1_2)).toBe(3.5e-4);
        expect(Number(cards.CD2_1)).toBe(3.5e-4);
        expect(Number(cards.CD2_2)).toBe(1.021e-3);
        // determinant stays negative (parity preserved)
        const det = Number(cards.CD1_1) * Number(cards.CD2_2) - Number(cards.CD1_2) * Number(cards.CD2_1);
        expect(det).toBeLessThan(0);
    });

    it('round-trips full float64 precision on a WCS keyword', () => {
        const r = makeReceipt();
        r.wcs.CRVAL1 = 170.11880123456789;
        const out = serializeFits(r, monoImg(4, 4));
        const { cards } = parseHeader(out);
        // 16 significant figures survive (toExponential(15) = full float64 mantissa)
        expect(Number(cards.CRVAL1)).toBe(170.11880123456789);
    });

    it('writes EQUINOX / RADESYS / SOURCE provenance', () => {
        const out = serializeFits(makeReceipt(), monoImg(4, 4));
        const { cards } = parseHeader(out);
        expect(Number(cards.EQUINOX)).toBe(2000);
        expect(cards.RADESYS).toBe('ICRS');
        expect(cards.SOURCE).toBe('FITTED');
    });

    it('emits an ORIGIN card only when a libraryVersion is supplied', () => {
        const withVer = serializeFits(makeReceipt(), monoImg(4, 4), { libraryVersion: '9.9.9' });
        expect(parseHeader(withVer).cards.ORIGIN).toContain('SkyCruncher 9.9.9');
        const without = serializeFits(makeReceipt(), monoImg(4, 4));
        expect(parseHeader(without).cards.ORIGIN).toBeUndefined();
    });
});

describe('serializeFits — pixel payload (byte-exact, NaN-preserving)', () => {
    it('round-trips Float32 samples byte-exact, big-endian', () => {
        const img = monoImg(4, 4, i => (i - 7) * 3.14159);
        const out = serializeFits(makeReceipt(), img);
        const { dataStart } = parseHeader(out);
        const got = readData(out, dataStart, 16);
        for (let i = 0; i < 16; i++) {
            expect(got[i]).toBe(Math.fround((i - 7) * 3.14159));
        }
    });

    it('PRESERVES NaN for non-finite samples (FITS blank; NOT 0-fill)', () => {
        const data = new Float32Array([1.5, NaN, Infinity, -Infinity, 0, 42.25]);
        const out = serializeFits(makeReceipt(), { data, width: 3, height: 2, channels: 1 });
        const { dataStart } = parseHeader(out);
        const got = readData(out, dataStart, 6);
        expect(got[0]).toBe(1.5);
        expect(Number.isNaN(got[1])).toBe(true);   // NaN preserved
        expect(Number.isNaN(got[2])).toBe(true);   // Infinity → NaN (non-finite blank)
        expect(Number.isNaN(got[3])).toBe(true);   // -Infinity → NaN
        expect(got[4]).toBe(0);                     // a real 0 stays 0 (NOT a blank)
        expect(got[5]).toBe(42.25);
    });

    it('de-interleaves 3-channel RGB into planar NAXIS=3 planes', () => {
        // interleaved [r0,g0,b0, r1,g1,b1, ...] for a 2x1 image
        const data = new Float32Array([10, 20, 30, 11, 21, 31]);
        const out = serializeFits(makeReceipt(), { data, width: 2, height: 1, channels: 3 });
        const { cards, dataStart } = parseHeader(out);
        expect(cards.NAXIS).toBe('3');
        expect(cards.NAXIS3).toBe('3');
        const got = readData(out, dataStart, 6);
        // planar: R-plane [10,11], G-plane [20,21], B-plane [30,31]
        expect(got).toEqual([10, 11, 20, 21, 30, 31]);
    });
});

describe('serializeFits — SIP mapping (honest-absent)', () => {
    const sipReceipt = () => makeReceipt({
        solution: {
            spatial_hash: 'sip1',
            astrometry: {
                rms_arcsec: 3.0,
                distortion_detected: true,
                sip: {
                    a_order: 2, b_order: 2,
                    a: [[0, 0, 3.0e-5], [0, 1.5e-5, 0], [-2.0e-5, 0, 0]],
                    b: [[0, 0, -2.5e-5], [1.2e-5, 0, 0], [4.0e-6, 0, 0]],
                },
            },
        },
    });

    it('with SIP: promotes CTYPE to -SIP and emits A/B order + nonzero terms', () => {
        const out = serializeFits(sipReceipt(), monoImg(8, 6));
        const { cards, comments } = parseHeader(out);
        expect(cards.CTYPE1).toBe('RA---TAN-SIP');
        expect(cards.CTYPE2).toBe('DEC--TAN-SIP');
        expect(cards.A_ORDER).toBe('2');
        expect(cards.B_ORDER).toBe('2');
        // A nonzero term is emitted, a zero term is skipped. The emitted value is
        // the FITS-convention NEGATION of the stored internal coefficient
        // (A_FITS = IDEAL − OBSERVED = −A_internal; see sip_convention.ts): the
        // receipt stores a[2][0] = −2.0e-5, so the FITS card is +2.0e-5.
        expect(Number(cards.A_2_0)).toBe(2.0e-5);   // = −(internal −2.0e-5)
        expect(cards.A_0_0).toBeUndefined();  // zero term skipped
        expect(Number(cards.B_2_0)).toBe(-4.0e-6);  // = −(internal 4.0e-6)
        // forward-only + convention honesty comments present
        expect(comments.some(c => /forward-only/i.test(c))).toBe(true);
        expect(comments.some(c => /FITS-convention.*IDEAL-OBSERVED/i.test(c))).toBe(true);
    });

    it('without SIP: plain TAN, zero SIP cards, no forward-only comment', () => {
        const out = serializeFits(makeReceipt(), monoImg(8, 6));
        const { cards, comments } = parseHeader(out);
        expect(cards.CTYPE1).toBe('RA---TAN');
        expect(cards.CTYPE2).toBe('DEC--TAN');
        expect(cards.A_ORDER).toBeUndefined();
        expect(cards.A_2_0).toBeUndefined();
        expect(comments.some(c => /forward-only/i.test(c))).toBe(false);
    });

    it('with TPS: adds an "available in ASDF export" comment (no FITS TPS keywords)', () => {
        const r = makeReceipt({
            solution: { spatial_hash: 'tps1', astrometry: { rms_arcsec: 3.0, tps: { scale: 4 } } },
        });
        const { comments } = parseHeader(serializeFits(r, monoImg(8, 6)));
        expect(comments.some(c => /TPS.*ASDF export/i.test(c))).toBe(true);
    });

    it('without TPS: no TPS comment', () => {
        const { comments } = parseHeader(serializeFits(makeReceipt(), monoImg(8, 6)));
        expect(comments.some(c => /TPS/i.test(c))).toBe(false);
    });
});

describe('serializeFits — refined final_astrometry (alternate WCS "A", schema 2.20.0)', () => {
    const faBlock = {
        provenance: 'REFINED_FINAL_ASTROMETRY',
        wcs: {
            crpix: [100, 50], crval: [11.34, -22.4], // crval[0] in HOURS (engine)
            cd: [[-1.021e-3, 3.5e-4], [3.5e-4, 1.021e-3]],
        },
        sip: { a_order: 3, b_order: 3, a: [], b: [] },
        rms: { linearArcsec: 12.5, refinedArcsec: 9.25 },
        refraction: { applied: false },
    };

    it('emits alternate WCS "A" cards marked refined, never touching the primary WCS', () => {
        const r = makeReceipt({ final_astrometry: faBlock });
        const { cards, comments } = parseHeader(serializeFits(r, monoImg(8, 6)));
        expect(cards.WCSNAMEA).toBe('SKYCRUNCHER-REFINED-FINAL-ASTROMETRY');
        expect(cards.CTYPE1A).toBe('RA---TAN'); // linear (alt-WCS SIP is non-standard)
        // crval HOURS → ×15 deg; crpix 0-based → +1; CD verbatim.
        expect(Number(cards.CRVAL1A)).toBe(11.34 * 15);
        expect(Number(cards.CRPIX1A)).toBe(101);
        expect(Number(cards.CD1_1A)).toBe(-1.021e-3);
        // the PRIMARY (solve) WCS is untouched — never overwritten.
        expect(Number(cards.CRVAL1)).toBe(170.1188);
        expect(cards.CTYPE1).toBe('RA---TAN');
        expect(comments.some(c => /REFINED.*PRODUCT|PRODUCT.*never the solve WCS/i.test(c))).toBe(true);
    });

    it('is honest-absent: no alternate WCS when the block is missing (byte-identical)', () => {
        const { cards } = parseHeader(serializeFits(makeReceipt(), monoImg(8, 6)));
        expect(cards.WCSNAMEA).toBeUndefined();
        expect(cards.CRVAL1A).toBeUndefined();
    });

    it('is honest-absent on a corrupt refined block (non-finite CD) — no broken second WCS', () => {
        const bad = { ...faBlock, wcs: { ...faBlock.wcs, cd: [[NaN, 0], [0, 1e-3]] } };
        const { cards } = parseHeader(serializeFits(makeReceipt({ final_astrometry: bad }), monoImg(8, 6)));
        expect(cards.WCSNAMEA).toBeUndefined();
    });
});

describe('serializeFits — refusal paths (export law: fitted WCS only)', () => {
    it('refuses when receipt.wcs is absent', () => {
        const r: any = makeReceipt();
        delete r.wcs;
        expect(() => serializeFits(r, monoImg(4, 4))).toThrow(/no WCS/i);
    });

    it('refuses a SYNTHESIZED WCS (never exported as science)', () => {
        const r = makeReceipt();
        r.wcs.SOURCE = 'SYNTHESIZED';
        expect(() => serializeFits(r, monoImg(4, 4))).toThrow(/SYNTHESIZED|only a FITTED/i);
    });

    it('refuses a non-finite WCS keyword', () => {
        const r = makeReceipt();
        r.wcs.CRVAL1 = NaN;
        expect(() => serializeFits(r, monoImg(4, 4))).toThrow(/non-finite/i);
    });

    it('refuses an image length that mismatches the declared shape', () => {
        const bad: FitsImage = { data: new Float32Array(10), width: 4, height: 4, channels: 1 };
        expect(() => serializeFits(makeReceipt(), bad)).toThrow(/implies 16 samples/i);
    });
});

describe('fitsFileName', () => {
    it('uses the spatial hash when present', () => {
        expect(fitsFileName(makeReceipt())).toBe('skycruncher_cafebabe.fits');
    });
    it('honours a custom base name', () => {
        expect(fitsFileName(makeReceipt(), 'm66')).toBe('m66_cafebabe.fits');
    });
});
