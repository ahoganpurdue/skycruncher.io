// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — FITS decode (SeeStar shapes), same output contract as decode_cr2
// ═══════════════════════════════════════════════════════════════════════════
// Self-contained single-HDU FITS reader, borrowed from the proven decoder in
// tools/corpus/run_corpus.mjs (which triaged the whole SeeStar corpus):
//   - BITPIX 16 (big-endian int16 + BZERO offset, the SeeStar stacked shape)
//   - BITPIX -32 (big-endian float; Siril/community stacks) — normalized to
//     [0,1] by the observed finite range, then scaled to u16. Everything
//     downstream of the decoder is relative photometry on a linear scale, so
//     a global affine normalization is lossless for this lane's purposes.
//   - NAXIS=2 mono (replicated to R=G=B) and NAXIS=3 PLANAR RGB (three
//     w*h planes back to back — NOT interleaved; SeeStar stacked cubes).
//
// Output contract matches decodeCR2: { w, h, rgb16 (interleaved Uint16 x3),
// meta }. A demosaiced FITS payload has no Bayer pattern, so measure_and_
// clean's detectPattern() lands in its splitRGB branch by construction.
//
// HONESTY GUARD: NAXIS=2 files carrying a BAYERPAT card are raw CFA
// sub-frames, not mono — decoding them as mono luminance would feed the PSF
// pipeline half-sampled stars. We refuse rather than pretend.

import fs from 'node:fs';

/** Parse 2880-byte header blocks until END. Returns { cards, hdrEnd }. */
export function parseFitsHeader(buf) {
    const cards = {};
    let hdrEnd = 0;
    outer: for (let b = 0; b + 2880 <= buf.length; b += 2880) {
        for (let i = b; i < b + 2880; i += 80) {
            const card = buf.subarray(i, i + 80).toString('latin1');
            const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^\/]+)/);
            if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
            if (card.startsWith('END')) { hdrEnd = b + 2880; break outer; }
        }
    }
    if (!hdrEnd) throw new Error('FITS header END card not found');
    return { cards, hdrEnd };
}

/**
 * Decode a FITS file into { w, h, rgb16, meta } (decodeCR2-compatible).
 * rgb16: interleaved [R,G,B] Uint16 triplets, w*h*3 elements.
 */
export function decodeFITS(filePath) {
    const buf = fs.readFileSync(filePath);
    const { cards, hdrEnd } = parseFitsHeader(buf);

    const W = +cards.NAXIS1, H = +cards.NAXIS2;
    const NAXIS = +(cards.NAXIS ?? 2);
    const NP = NAXIS >= 3 ? +(cards.NAXIS3 ?? 1) : 1;
    const BITPIX = +(cards.BITPIX ?? 16);
    const BZERO = +(cards.BZERO ?? 0);
    if (!W || !H) throw new Error(`bad NAXIS1/NAXIS2 (${cards.NAXIS1} x ${cards.NAXIS2})`);
    if (BITPIX !== 16 && BITPIX !== -32) throw new Error(`DECODE_UNSUPPORTED: BITPIX ${BITPIX} (this lane speaks 16 and -32)`);
    if (NP !== 1 && NP !== 3) throw new Error(`DECODE_UNSUPPORTED: NAXIS3=${NP} planes (mono or planar RGB only)`);
    if (NP === 1 && cards.BAYERPAT) {
        throw new Error(`DECODE_UNSUPPORTED: NAXIS=2 with BAYERPAT=${cards.BAYERPAT} is a raw CFA sub-frame — mono decode would half-sample every star (CFA FITS demosaic not implemented in this lane)`);
    }

    const npix = W * H;
    const bytesPer = BITPIX === -32 ? 4 : 2;
    const expected = hdrEnd + npix * NP * bytesPer;
    if (expected > buf.length) {
        throw new Error(`DECODE_UNSUPPORTED: payload ${buf.length - hdrEnd}B < expected ${expected - hdrEnd}B for ${W}x${H}x${NP} bitpix=${BITPIX} (multi-HDU or exotic layout)`);
    }

    // plane reader -> u16 value
    let readPlane;
    if (BITPIX === -32) {
        // observed finite range over ALL planes (full scan — exactness over
        // the corpus tool's sampled scan; one pass over <=200MB is cheap here)
        let lo = Infinity, hi = -Infinity;
        const total = npix * NP;
        for (let i = 0; i < total; i++) {
            const v = buf.readFloatBE(hdrEnd + i * 4);
            if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        if (!Number.isFinite(lo) || hi - lo <= 0) throw new Error('degenerate float FITS (no finite range)');
        const scale = 65535 / (hi - lo);
        readPlane = (idx) => {
            const v = buf.readFloatBE(hdrEnd + idx * 4);
            if (!Number.isFinite(v)) return 0;
            const t = (v - lo) * scale;
            return t < 0 ? 0 : (t > 65535 ? 65535 : Math.round(t));
        };
    } else {
        readPlane = (idx) => {
            const t = buf.readInt16BE(hdrEnd + idx * 2) + BZERO;
            return t < 0 ? 0 : (t > 65535 ? 65535 : t);
        };
    }

    const rgb16 = new Uint16Array(npix * 3);
    if (NP === 3) {
        // PLANAR planes (R, G, B back to back) -> interleaved triplets
        for (let i = 0; i < npix; i++) {
            rgb16[i * 3] = readPlane(i);
            rgb16[i * 3 + 1] = readPlane(npix + i);
            rgb16[i * 3 + 2] = readPlane(2 * npix + i);
        }
    } else {
        // mono -> replicate (luminance-preserving under any RGB weighting)
        for (let i = 0; i < npix; i++) {
            const v = readPlane(i);
            rgb16[i * 3] = v; rgb16[i * 3 + 1] = v; rgb16[i * 3 + 2] = v;
        }
    }

    const meta = {
        width: W, height: H,
        format: 'FITS',
        bitpix: BITPIX, planes: NP, bzero: BZERO,
        planar: NP === 3,
        cards,
    };
    return { w: W, h: H, rgb16, meta };
}
