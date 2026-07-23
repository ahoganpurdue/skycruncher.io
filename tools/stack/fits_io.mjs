// ═══════════════════════════════════════════════════════════════════════════
// STACK LANE — FITS I/O (plane-level reads in ORIGINAL units + minimal writer)
// ═══════════════════════════════════════════════════════════════════════════
// The psf-lane decoder (tools/psf/decode_fits.mjs) normalizes to u16 for its
// relative-photometry pipeline; stacking needs the RAW float values (per-frame
// background subtraction + cross-frame flux normalization happen in original
// units), so this module reads planes without any normalization. Header
// parsing follows the proven corpus-runner pattern (2880-byte blocks, END).
//
// Validity convention for BITPIX=-32 frames: non-finite values AND exact 0.0
// are OUT-OF-FOOTPRINT markers (drizzle borders, mosaic canvas padding) and
// are stored as NaN so bilinear sampling auto-invalidates at footprint edges.
// Integer frames have no such convention — all pixels are valid.

import fs from 'node:fs';
import path from 'node:path';

/** Parse header cards via positional reads (no whole-file readFileSync). */
export function readFitsHeaderFd(fd) {
    const cards = {};
    const block = Buffer.alloc(2880);
    let hdrEnd = 0;
    outer: for (let b = 0; b < 1024; b++) {
        const got = fs.readSync(fd, block, 0, 2880, b * 2880);
        if (got < 2880) break;
        for (let i = 0; i < 2880; i += 80) {
            const card = block.subarray(i, i + 80).toString('latin1');
            const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^\/]+)/);
            if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
            if (card.startsWith('END')) { hdrEnd = (b + 1) * 2880; break outer; }
        }
    }
    if (!hdrEnd) throw new Error('FITS header END card not found');
    return { cards, hdrEnd };
}

/** Open a FITS file for plane-level access. Caller must close(). */
export function openFits(file) {
    const fd = fs.openSync(file, 'r');
    const { cards, hdrEnd } = readFitsHeaderFd(fd);
    const W = +cards.NAXIS1, H = +cards.NAXIS2;
    const NAXIS = +(cards.NAXIS ?? 2);
    const NP = NAXIS >= 3 ? +(cards.NAXIS3 ?? 1) : 1;
    const BITPIX = +(cards.BITPIX ?? 16);
    const BZERO = +(cards.BZERO ?? 0);
    if (!W || !H) { fs.closeSync(fd); throw new Error(`bad NAXIS1/NAXIS2 (${cards.NAXIS1} x ${cards.NAXIS2})`); }
    if (BITPIX !== 16 && BITPIX !== -32) { fs.closeSync(fd); throw new Error(`DECODE_UNSUPPORTED: BITPIX ${BITPIX} (this lane speaks 16 and -32)`); }
    if (NP !== 1 && NP !== 3) { fs.closeSync(fd); throw new Error(`DECODE_UNSUPPORTED: NAXIS3=${NP} planes`); }
    const bytesPer = BITPIX === -32 ? 4 : 2;
    const size = fs.fstatSync(fd).size;
    if (hdrEnd + W * H * NP * bytesPer > size) {
        fs.closeSync(fd);
        throw new Error(`DECODE_UNSUPPORTED: payload ${size - hdrEnd}B < expected for ${W}x${H}x${NP} bitpix=${BITPIX}`);
    }
    return {
        file, fd, cards, hdrEnd, W, H, NP, BITPIX, BZERO,
        close() { fs.closeSync(fd); },
    };
}

/**
 * Read one plane as Float32 in ORIGINAL units.
 * Float frames: non-finite and exact-0 pixels become NaN (footprint mask).
 */
export function readPlaneRaw(f, planeIdx) {
    const { fd, hdrEnd, W, H, BITPIX, BZERO } = f;
    const npix = W * H;
    const bytesPer = BITPIX === -32 ? 4 : 2;
    const bytes = npix * bytesPer;
    const buf = Buffer.alloc(bytes);
    let off = 0;
    while (off < bytes) off += fs.readSync(fd, buf, off, Math.min(1 << 24, bytes - off), hdrEnd + planeIdx * bytes + off);
    const out = new Float32Array(npix);
    if (BITPIX === -32) {
        const dv = new DataView(buf.buffer, buf.byteOffset, bytes);
        for (let i = 0; i < npix; i++) {
            const v = dv.getFloat32(i * 4, false);
            out[i] = (Number.isFinite(v) && v !== 0) ? v : NaN;
        }
    } else {
        const dv = new DataView(buf.buffer, buf.byteOffset, bytes);
        for (let i = 0; i < npix; i++) out[i] = dv.getInt16(i * 2, false) + BZERO;
    }
    return out;
}

/**
 * Luminance normalized to [0,1] by the observed finite range over all planes —
 * the exact transform the proven corpus solver detects/solves on. Returned
 * separately from raw planes because solving and stacking live in different
 * unit systems by design (coordinate ledger vs pixel ledger).
 */
export function readLuminanceNormalized(f) {
    const { W, H, NP } = f;
    const npix = W * H;
    const lumW = NP === 3 ? [0.2126, 0.7152, 0.0722] : [1];
    const acc = new Float64Array(npix);
    let lo = Infinity, hi = -Infinity;
    const planes = [];
    for (let p = 0; p < NP; p++) {
        const pl = readPlaneRaw(f, p);
        for (let i = 0; i < npix; i++) {
            const v = pl[i];
            if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        planes.push(pl);
    }
    if (!Number.isFinite(lo) || hi - lo <= 0) throw new Error('degenerate FITS (no finite range)');
    const inv = 1 / (hi - lo);
    for (let p = 0; p < NP; p++) {
        const pl = planes[p], wgt = lumW[p];
        for (let i = 0; i < npix; i++) {
            const v = pl[i];
            acc[i] += (Number.isFinite(v) ? (v - lo) * inv : 0) * wgt;
        }
    }
    const lum = new Float32Array(npix);
    for (let i = 0; i < npix; i++) lum[i] = acc[i];
    return { lum, lo, hi };
}

// ── minimal FITS writer ─────────────────────────────────────────────────────

function fitsCard(key, value, comment) {
    let v;
    if (typeof value === 'string') v = `'${value.slice(0, 66)}'`.padEnd(20);
    else if (typeof value === 'boolean') v = (value ? 'T' : 'F').padStart(20);
    else v = formatFitsNumber(value).padStart(20);
    let card = `${key.padEnd(8)}= ${v}`;
    if (comment) card += ` / ${comment}`;
    return card.slice(0, 80).padEnd(80);
}

function formatFitsNumber(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    // full float64 precision — WCS keywords must round-trip
    let s = n.toExponential(15).toUpperCase();
    return s;
}

/**
 * Emit the 80-byte card(s) for ONE [key, value, comment?] entry.
 *
 * HISTORY / COMMENT are FITS free-text cards with NO "= value" indicator; their
 * text starts at column 9 and wraps across as many 80-byte cards as needed
 * (FITS-legal). Everything else is a standard "KEY = value / comment" card via
 * fitsCard. ADDITIVE: no non-HISTORY/COMMENT caller is affected, so existing
 * writer outputs stay byte-identical (verified: the stack/repro/synth/seestar
 * callers all pass keyword cards, never HISTORY/COMMENT).
 */
function commentCards(key, value, comment) {
    const K = String(key).toUpperCase();
    if (K === 'HISTORY' || K === 'COMMENT') {
        const text = comment != null ? `${value} ${comment}` : String(value);
        const chunks = [];
        for (let i = 0; i < text.length || chunks.length === 0; i += 72) chunks.push(text.slice(i, i + 72));
        return chunks.map((ch) => `${K.padEnd(8)}${ch}`.slice(0, 80).padEnd(80));
    }
    return [fitsCard(key, value, comment)];
}

/**
 * Write float32 planar FITS (BITPIX=-32, NAXIS=2 or 3).
 * cards: array of [key, value, comment?] appended after the geometry block.
 * Data streamed in chunks — a 1 GB stack must not need a 1 GB staging Buffer.
 */
export function writeFitsPlanar(outPath, planes, W, H, cards = []) {
    const NP = planes.length;
    const headerCards = [
        fitsCard('SIMPLE', true, 'tools/stack minimal writer'),
        fitsCard('BITPIX', -32),
        fitsCard('NAXIS', NP > 1 ? 3 : 2),
        fitsCard('NAXIS1', W),
        fitsCard('NAXIS2', H),
        ...(NP > 1 ? [fitsCard('NAXIS3', NP)] : []),
        fitsCard('BZERO', 0),
        fitsCard('BSCALE', 1),
        ...cards.flatMap(([k, v, c]) => commentCards(k, v, c)),
        'END'.padEnd(80),
    ];
    let header = headerCards.join('');
    header = header.padEnd(Math.ceil(header.length / 2880) * 2880);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const fd = fs.openSync(outPath, 'w');
    try {
        fs.writeSync(fd, Buffer.from(header, 'latin1'));
        const CHUNK_PX = 1 << 21; // 8 MB staging
        const stage = Buffer.alloc(CHUNK_PX * 4);
        const dv = new DataView(stage.buffer, stage.byteOffset);
        let written = 0;
        for (const plane of planes) {
            for (let i = 0; i < plane.length; i += CHUNK_PX) {
                const n = Math.min(CHUNK_PX, plane.length - i);
                for (let j = 0; j < n; j++) {
                    const v = plane[i + j];
                    dv.setFloat32(j * 4, Number.isFinite(v) ? v : 0, false);
                }
                fs.writeSync(fd, stage, 0, n * 4);
                written += n * 4;
            }
        }
        const pad = (2880 - (written % 2880)) % 2880;
        if (pad) fs.writeSync(fd, Buffer.alloc(pad));
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * WCS keyword cards for an output grid. INTERNAL convention: crval[0] in
 * HOURS (matches SkyTransform / the solve machinery); FITS standard wants
 * CRVAL1 in DEGREES — the conversion lives HERE and only here. Internal
 * crpix is 0-based pixel-center; FITS CRPIX is 1-based.
 *
 * ═══ DE-DUPE SEAM — TWO conversion boundaries, never both ══════════════════
 * There are TWO paths that turn an internal WCS into FITS keywords, and each
 * does the HOURS→degrees (×15) conversion at a DIFFERENT boundary — so no value
 * is ever double-converted:
 *   1. STACKER path (HERE): input `wcs.crval[0]` is engine-internal HOURS; this
 *      function multiplies by 15 (line below). Consumers pass an engine WCS.
 *   2. RECEIPT/EXPORT path (`stages/package.ts` generateReceiptWcs): converts
 *      ×15 there, so `receipt.wcs.CRVAL1` is ALREADY degrees. The shared FITS
 *      writer `src/engine/pipeline/export/fits_writer.ts` therefore consumes
 *      `receipt.wcs` VERBATIM and must NEVER re-multiply by 15 (it only adds the
 *      CRPIX+1). See that file's UNIT TRAP header.
 * Rule of thumb: this stacker function eats HOURS; the export writer eats
 * DEGREES. They are NOT interchangeable — do not feed a receipt.wcs to wcsCards
 * (it would ×15 an already-degrees CRVAL) or an engine WCS to the export writer.
 */
export function wcsCards(wcs) {
    return [
        ['CTYPE1', 'RA---TAN', 'gnomonic'],
        ['CTYPE2', 'DEC--TAN'],
        ['CUNIT1', 'deg'],
        ['CUNIT2', 'deg'],
        ['CRVAL1', wcs.crval[0] * 15, 'deg (internal hours * 15)'],
        ['CRVAL2', wcs.crval[1], 'deg'],
        ['CRPIX1', wcs.crpix[0] + 1, 'FITS 1-based'],
        ['CRPIX2', wcs.crpix[1] + 1, 'FITS 1-based'],
        ['CD1_1', wcs.cd[0]],
        ['CD1_2', wcs.cd[1]],
        ['CD2_1', wcs.cd[2]],
        ['CD2_2', wcs.cd[3]],
    ];
}
