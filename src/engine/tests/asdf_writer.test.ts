import { describe, it, expect } from 'vitest';
import { serializeAsdf, asdfFileName } from '../pipeline/export/asdf_writer';

const BLOCK_MAGIC = [0xd3, 0x42, 0x4c, 0x4b];

function findMagic(buf: Uint8Array): number {
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === BLOCK_MAGIC[0] && buf[i + 1] === BLOCK_MAGIC[1] &&
            buf[i + 2] === BLOCK_MAGIC[2] && buf[i + 3] === BLOCK_MAGIC[3]) {
            return i;
        }
    }
    return -1;
}

/** The YAML/text portion of the stream (everything before the binary block). */
function textOf(buf: Uint8Array): string {
    const mi = findMagic(buf);
    return new TextDecoder().decode(buf.subarray(0, mi < 0 ? buf.length : mi));
}

function makeReceipt(extra: any = {}) {
    return {
        version: '2.2.0',
        solution: {
            spatial_hash: 'deadbeef',
            ra_hours: 11.34,
            astrometry: {
                sip: { a_order: 1, b_order: 1, a: [[0, 0], [0, 0]], b: [[0, 0.5], [0, 0]] },
            },
        },
        wcs: {
            CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
            CRPIX1: 100.5, CRPIX2: 50.25,
            CRVAL1: 170.1, CRVAL2: -22.4,
            CD1_1: 1e-4, CD1_2: 0, CD2_1: 0, CD2_2: 1e-4,
            SOURCE: 'FITTED',
        },
        metadata: { badNumber: NaN, note: 'has "quotes" and\nnewline' },
        // Heavy typed array — must be dropped (mirrors the JSON serializer).
        scienceBuffer: new Float32Array(9999),
        warnings: ['low_snr', 'clock_unset'],
        timestamp_trusted: true,
        planets: [],
        psf_field: null,
        ...extra,
    };
}

describe('serializeAsdf — ASDF Standard 1.6.0 byte layout', () => {
    it('emits the exact ASDF file header lines', () => {
        const img = { data: new Uint16Array([1, 2, 3, 4, 5, 6]), width: 2, height: 3, channels: 1 as const };
        const out = serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' });
        const head = new TextDecoder().decode(out.subarray(0, 120));
        expect(head.startsWith(
            '#ASDF 1.0.0\n#ASDF_STANDARD 1.6.0\n%YAML 1.1\n%TAG ! tag:stsci.edu:asdf/\n--- !core/asdf-1.1.0\n'
        )).toBe(true);
    });

    it('writes the binary block magic + big-endian header fields', () => {
        const data = new Uint16Array([1, 2, 3, 4, 5, 6]); // 2x3 => shape [3,2]
        const img = { data, width: 2, height: 3, channels: 1 as const };
        const out = serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' });

        const mi = findMagic(out);
        expect(mi).toBeGreaterThan(0);

        const dv = new DataView(out.buffer, out.byteOffset);
        // header_size: uint16 BIG-ENDIAN == 48 (bytes after magic + size field)
        expect(dv.getUint16(mi + 4, false)).toBe(48);
        // flags: uint32 BE == 0
        expect(dv.getUint32(mi + 6, false)).toBe(0);
        // compression: 4 zero bytes
        expect([out[mi + 10], out[mi + 11], out[mi + 12], out[mi + 13]]).toEqual([0, 0, 0, 0]);
        // allocated / used / data size: uint64 BE (low word) == byteLength (12)
        const byteLen = data.byteLength;
        expect(dv.getUint32(mi + 14, false)).toBe(0);           // allocated high
        expect(dv.getUint32(mi + 18, false)).toBe(byteLen);     // allocated low
        expect(dv.getUint32(mi + 26, false)).toBe(byteLen);     // used low
        expect(dv.getUint32(mi + 34, false)).toBe(byteLen);     // data low
        // checksum: 16 zero bytes (all-zero = "no checksum")
        for (let k = 38; k < 54; k++) expect(out[mi + k]).toBe(0);
    });

    it('round-trips the array bytes little-endian at the block offset', () => {
        const data = new Uint16Array([0x1234, 0x5678, 0xABCD]);
        const img = { data, width: 3, height: 1, channels: 1 as const };
        const out = serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' });
        const mi = findMagic(out);
        const dataStart = mi + 54; // 4 magic + 2 size + 48 body
        const bytes = out.subarray(dataStart, dataStart + data.byteLength);
        // little-endian: 0x1234 -> [0x34, 0x12]
        expect(Array.from(bytes)).toEqual([0x34, 0x12, 0x78, 0x56, 0xCD, 0xAB]);
    });

    it('declares the ndarray with shape/datatype/byteorder', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '9.9.9' }));
        expect(text).toContain('data: !core/ndarray-1.1.0');
        expect(text).toContain('source: 0');
        expect(text).toContain('datatype: uint16');
        expect(text).toContain('byteorder: little');
        expect(text).toContain('shape: [3, 2]'); // [height, width]
        expect(text).toContain('asdf_library: !core/software-1.0.0 {name: "SkyCruncher", version: "9.9.9"}');
    });

    it('supports float32 and interleaved-RGB shape [h,w,3]', () => {
        const data = new Float32Array(2 * 2 * 3);
        const img = { data, width: 2, height: 2, channels: 3 as const };
        const out = serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' });
        const text = textOf(out);
        expect(text).toContain('datatype: float32');
        expect(text).toContain('shape: [2, 2, 3]');
        const mi = findMagic(out);
        const dv = new DataView(out.buffer, out.byteOffset);
        expect(dv.getUint32(mi + 34, false)).toBe(data.byteLength); // 48 bytes
    });

    it('writes wcs_fits (fallback) AND a native gwcs `wcs` transform side-by-side', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        // Fallback labeled FITS-keyword block still present…
        expect(text).toContain('wcs_fits:');
        expect(text).toContain('_label:');
        expect(text).toContain('CRVAL1: 170.1'); // degrees (×15 done upstream in the receipt)
        // …and the native, astropy-interpretable GWCS transform alongside it.
        expect(text).toContain('wcs: !<tag:stsci.edu:gwcs/wcs-1.4.0>');
        expect(text).toContain('!<tag:stsci.edu:gwcs/step-1.3.0>');
        expect(text).toContain('!<tag:stsci.edu:gwcs/frame2d-1.2.0>');
        expect(text).toContain('!<tag:stsci.edu:gwcs/celestial_frame-1.2.0>');
        expect(text).toContain('!<tag:astropy.org:astropy/coordinates/frames/icrs-1.1.0>');
    });

    it('composes the exact linear-TAN transform chain from the fitted WCS', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        // shift(-crpix) & shift(-crpix), 0-based (crpix = 100.5 / 50.25)
        expect(text).toContain('!transform/shift-1.4.0');
        expect(text).toContain('offset: -100.5');
        expect(text).toContain('offset: -50.25');
        // affine(CD) with the CD matrix inline as a core/ndarray
        expect(text).toContain('!transform/affine-1.5.0');
        expect(text).toContain('matrix: !core/ndarray-1.1.0');
        // gnomonic (Pix2Sky_TAN) then rotate3d(crval_ra, crval_dec, lon_pole=180)
        expect(text).toContain('!transform/gnomonic-1.4.0');
        expect(text).toContain('direction: "pix2sky"');
        expect(text).toContain('!transform/rotate3d-1.5.0');
        expect(text).toContain('direction: "native2celestial"');
        expect(text).toContain('phi: 170.1');  // crval RA (deg)
        expect(text).toContain('theta: -22.4'); // crval Dec (deg)
        expect(text).toContain('psi: 180');     // lon_pole
    });

    it('declares the gwcs + transform extensions in history when a gwcs wcs is emitted', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        expect(text).toContain('asdf://asdf-format.org/astronomy/gwcs/extensions/gwcs-1.4.0');
        expect(text).toContain('asdf://asdf-format.org/transform/extensions/transform-1.7.0');
    });

    it('folds SIP terms into wcs_fits AND emits a gwcs polynomial node when present', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        // wcs_fits fallback carries the SIP keywords…
        expect(text).toContain('CTYPE1: "RA---TAN-SIP"');
        expect(text).toContain('A_ORDER: 1');
        // FITS-convention NEGATION of the stored internal coefficient
        // (B_internal[0][1] = 0.5 → B_FITS = −0.5; see sip_convention.ts).
        expect(text).toContain('B_0_1: -0.5'); // only the non-zero coefficient, negated
        // …and the native gwcs chain carries the polynomial distortion node
        // (tag versions verified against the installed asdf-transform-schemas).
        expect(text).toContain('!transform/polynomial-1.3.0');
        expect(text).toContain('!transform/remap_axes-1.5.0');
        expect(text).toContain('coefficients: !core/ndarray-1.1.0'); // matrix form, not c<p>_<q>
    });

    it('omits the gwcs polynomial node when no SIP is fitted (honest-absent)', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const r = makeReceipt();
        delete r.solution.astrometry.sip;              // well-corrected optic
        const text = textOf(serializeAsdf(r, img, { libraryVersion: '1.0.0' }));
        expect(text).toContain('wcs: !<tag:stsci.edu:gwcs/wcs-1.4.0>'); // linear still emitted
        expect(text).not.toContain('!transform/polynomial-1.3.0');
        expect(text).not.toContain('RA---TAN-SIP');
    });

    it('carries a fitted TPS as a gwcs tabular lookup, taking precedence over SIP', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const r = makeReceipt();
        r.solution.astrometry.tps = {
            lambda: 1e-3, scale: 4, crpix: [100.5, 50.25],
            control_points: [[-0.5, -0.5], [0.5, 0.5], [0, 0]],
            weights_x: [0.01, -0.01, 0], weights_y: [0.005, -0.005, 0],
            affine: { dx: [0.3, 0.1, -0.05], dy: [-0.2, 0.04, 0.08] },
            rms_before_arcsec: 3, rms_after_arcsec: 0.2, control_count: 3,
        };
        const text = textOf(serializeAsdf(r, img, { libraryVersion: '1.0.0' }));
        // Native chain carries the TABULAR distortion node (verified tag/version)…
        expect(text).toContain('!transform/tabular-1.4.0');
        expect(text).toContain('method: linear');       // raw enum token, not quoted
        expect(text).toContain('bounds_error: false');
        expect(text).toContain('!transform/remap_axes-1.5.0');
        // …and the SIP polynomial node is REPLACED (exactly one model rides the
        // chain — never both, which would double-correct).
        expect(text).not.toContain('!transform/polynomial-1.3.0');
        expect(text).toContain('wcs: !<tag:stsci.edu:gwcs/wcs-1.4.0>');
        // wcs_fits fallback still carries the FITS-representable SIP keywords.
        expect(text).toContain('CTYPE1: "RA---TAN-SIP"');
    });

    it('omits the gwcs tabular node when no TPS is fitted (honest-absent)', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        expect(text).not.toContain('!transform/tabular-1.4.0');
    });

    it('omits both WCS blocks when unsolved (honest-absent)', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const r = makeReceipt();
        delete r.wcs;
        const text = textOf(serializeAsdf(r, img, { libraryVersion: '1.0.0' }));
        expect(text).toContain('wcs_fits: null');
        expect(text).not.toContain('gwcs/wcs-1.4.0');
    });

    it('lens-distortion slot is honest-absent (no measured producer today)', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        // default receipt: no measured coefficients → block must be absent
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        expect(text).not.toContain('com.skycruncher.lens_distortion');
        // a future producer supplying MEASURED coefficients → block appears
        const withMeas = makeReceipt({ lens_distortion_measured: { measured: true, k1: -0.01, k2: 0.002 } });
        const text2 = textOf(serializeAsdf(withMeas, img, { libraryVersion: '1.0.0' }));
        expect(text2).toContain('"com.skycruncher.lens_distortion":'); // dotted key is quoted
        expect(text2).toContain('_model: "brown_conrady"');
        expect(text2).toContain('k1: -0.01');
    });

    it('drops heavy typed-array keys and coerces non-finite numbers to null', () => {
        const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };
        const text = textOf(serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' }));
        expect(text).not.toContain('scienceBuffer');
        expect(text).toContain('badNumber: null'); // NaN -> null
        expect(text).toContain('note: "has \\"quotes\\" and\\nnewline"'); // safe double-quoting
        expect(text).toContain('warnings: ["low_snr", "clock_unset"]');
    });

    it('throws on a shape/length mismatch rather than emit a corrupt file', () => {
        const img = { data: new Uint16Array(5), width: 2, height: 3, channels: 1 as const };
        expect(() => serializeAsdf(makeReceipt(), img, { libraryVersion: '1.0.0' })).toThrow();
    });

    it('derives the file name from the spatial hash', () => {
        expect(asdfFileName(makeReceipt())).toBe('skycruncher_deadbeef.asdf');
    });
});

describe('serializeAsdf — refusal path (EXPORT LAW: fitted WCS only, mirrors fits_writer)', () => {
    const img = { data: new Uint16Array(6), width: 2, height: 3, channels: 1 as const };

    it('refuses a SYNTHESIZED WCS (never exported as an interpretable GWCS)', () => {
        const r = makeReceipt();
        r.wcs.SOURCE = 'SYNTHESIZED';
        expect(() => serializeAsdf(r, img, { libraryVersion: '1.0.0' })).toThrow(/SYNTHESIZED|only a FITTED/i);
    });

    it('refuses a WCS with a missing SOURCE tag (provenance-unknown is not FITTED)', () => {
        const r: any = makeReceipt();
        delete r.wcs.SOURCE;
        expect(() => serializeAsdf(r, img, { libraryVersion: '1.0.0' })).toThrow(/only a FITTED/i);
    });

    it('still exports an UNSOLVED receipt (no wcs at all) with the WCS blocks honestly absent', () => {
        const r: any = makeReceipt();
        delete r.wcs;
        const text = textOf(serializeAsdf(r, img, { libraryVersion: '1.0.0' }));
        expect(text).toContain('wcs_fits: null');
        expect(text).not.toContain('!<tag:stsci.edu:gwcs/wcs-1.4.0>');
    });
});
