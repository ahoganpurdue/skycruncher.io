/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FITS WRITER — shared, dependency-free serializer for the SkyCruncher export
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: EXPORT — COORDINATE metadata (the fitted WCS keywords) + a PIXEL-ledger
 * payload pass-through (the measured frame, written verbatim). NO processing lives
 * here: no stretch, no fill, no resample, no WCS re-synthesis. The writer copies
 * the receipt's fitted WCS into FITS keyword cards and streams the image bytes.
 *
 * ONE implementation. The Tauri desktop app, the browser build and the headless
 * Node lane all run this same function (mirrors asdf_writer.ts). The per-surface
 * sinks are thin (save-dialog + writeFile / Blob download / fs.writeFileSync);
 * the byte production lives HERE so FITS never lives in two places.
 *
 * BYTE MACHINERY ported from `tools/stack/fits_io.mjs` (fitsCard / formatFitsNumber
 * with full float64 round-trip precision, 2880-byte header blocking, BITPIX=-32
 * big-endian planar payload, tail padding to a 2880 boundary).
 *
 * ═══ UNIT TRAP (pre-mapped) ═══════════════════════════════════════════════════
 * `receipt.wcs` is ALREADY in the FITS unit system: `stages/package.ts`
 * generateReceiptWcs converts the engine-internal RA (HOURS) to degrees (×15) and
 * writes CD in deg/px. `tools/stack/fits_io.mjs` wcsCards, by contrast, receives
 * an engine-internal WCS and does the ×15 ITSELF. THIS writer consumes
 * `receipt.wcs` keys VERBATIM — it must NEVER re-multiply CRVAL by 15 (that would
 * be a DOUBLE conversion). The only coordinate arithmetic here is CRPIX+1 (the
 * receipt carries engine 0-based pixel centers; FITS CRPIX is 1-based). See the
 * "De-dupe seam" note in `tools/stack/fits_io.mjs` for the two conversion
 * boundaries that must never both fire.
 *
 * ═══ EXPORT LAW: FITTED WCS ONLY ══════════════════════════════════════════════
 * REFUSES to serialize when `receipt.wcs` is absent or `receipt.wcs.SOURCE !==
 * 'FITTED'` (a SYNTHESIZED approximation is never written as if it verified stars).
 *
 * ═══ SIP SIGN CONVENTION (fixed at the boundary) ══════════════════════════════
 * The engine's SIP fit stores coefficients in the convention A_internal = OBSERVED
 * − IDEAL (residual_analyzer.ts). The FITS SIP standard's forward polynomial is
 * A_FITS = IDEAL − OBSERVED = −A_internal (same domain). The A_i_j / B_i_j cards
 * emitted here are therefore run through `export/sip_convention.ts` toFitsSip
 * (pure negation) so a reader that APPLIES them (astropy) moves star positions
 * TOWARD the catalog and IMPROVES the residuals. Emitting the raw internal
 * coefficients (the pre-fix bug) applied the distortion backwards and WORSENED
 * them. See sip_convention.ts for the full derivation.
 *
 * ═══ NON-FINITE PIXEL POLICY (deviation from fits_io.mjs, documented) ══════════
 * BITPIX=-32 frames use IEEE NaN as the FITS blank convention for floating-point
 * data. This writer PRESERVES NaN for non-finite input samples (out-of-footprint
 * markers, drizzle borders) so a reader's footprint mask survives. This DIFFERS
 * from `tools/stack/fits_io.mjs` writeFitsPlanar, which writes 0.0 for non-finite
 * samples (the stacker's own convention — 0 is its out-of-footprint marker on the
 * read side). Both are self-consistent; the export chooses the standards-blessed
 * NaN blank because a science FITS reader (astropy) treats NaN as masked and 0 as
 * a real zero-flux pixel.
 */

import { toFitsSip } from './sip_convention';

// ─── constants ────────────────────────────────────────────────────────────────

/** FITS logical record size: headers and the data segment are each padded to a
 * whole multiple of 2880 bytes (36 × 80-char cards). */
const FITS_BLOCK = 2880;
const FITS_CARD = 80;

// ─── public API ───────────────────────────────────────────────────────────────

export type FitsPixelArray = Float32Array | Uint16Array | number[];

export interface FitsImage {
    /** The measured pixel samples. Written verbatim as BITPIX=-32 (float32). */
    data: FitsPixelArray;
    width: number;
    height: number;
    /** 1 = mono (NAXIS=2, [h,w]); 3 = interleaved RGB (de-interleaved to 3
     * PLANES, NAXIS=3 [3,h,w]). Default 1. FITS is planar; interleaved input is
     * reshaped (a pure reordering — no value changes the pixel ledger). */
    channels?: 1 | 3;
}

export interface FitsWriterOptions {
    /** Optional writer version → an ORIGIN provenance card. Omitted when unset. */
    libraryVersion?: string;
}

/**
 * Serialize a receipt + image into a complete FITS byte stream.
 *
 * Pure: `(receipt, image, opts) -> Uint8Array`. No I/O, no deps. The fitted WCS
 * goes to keyword cards (consumed VERBATIM from `receipt.wcs`); the image goes to
 * the BITPIX=-32 big-endian planar data segment. Throws (never emits a corrupt or
 * WCS-less/synthesized file) on: absent/synthesized WCS, non-finite WCS keyword,
 * shape/length mismatch.
 */
export function serializeFits(
    receipt: any,
    image: FitsImage,
    opts: FitsWriterOptions = {}
): Uint8Array {
    const wcs = receipt?.wcs;
    // EXPORT LAW: fitted WCS only. Never synthesize; never downgrade silently.
    if (!wcs) {
        throw new Error('FITS export refused: receipt has no WCS (nothing fitted to write).');
    }
    if (wcs.SOURCE !== 'FITTED') {
        throw new Error(
            `FITS export refused: receipt.wcs.SOURCE is ${JSON.stringify(wcs.SOURCE)} — ` +
            `only a FITTED WCS is written (a SYNTHESIZED approximation is never exported as science).`
        );
    }

    const channels = image.channels === 3 ? 3 : 1;
    const W = image.width | 0;
    const H = image.height | 0;
    if (!(W > 0) || !(H > 0)) {
        throw new Error(`FITS export refused: bad image dims ${W}x${H}.`);
    }
    const expected = W * H * channels;
    if (image.data.length !== expected) {
        throw new Error(
            `FITS export refused: image ${W}x${H}x${channels} implies ${expected} samples ` +
            `but the array has ${image.data.length}.`
        );
    }

    const cards = buildHeaderCards(receipt, W, H, channels, opts);
    const headerBytes = blockPad(cards.join(''));

    // ── data segment: BITPIX=-32, BIG-ENDIAN, planar ─────────────────────────
    const npix = W * H;
    const dataByteLen = npix * channels * 4;
    const tailPad = (FITS_BLOCK - (dataByteLen % FITS_BLOCK)) % FITS_BLOCK;

    const headerLen = headerBytes.length;
    const out = new Uint8Array(headerLen + dataByteLen + tailPad);
    // header (latin1 — every card char is ASCII).
    for (let i = 0; i < headerLen; i++) out[i] = headerBytes.charCodeAt(i) & 0xff;

    const dv = new DataView(out.buffer, out.byteOffset + headerLen, dataByteLen);
    const src = image.data;
    let off = 0;
    for (let p = 0; p < channels; p++) {
        for (let i = 0; i < npix; i++) {
            // channels===1 → src[i]; channels===3 interleaved → src[i*3 + p].
            const v = channels === 3 ? src[i * 3 + p] : src[i];
            // NON-FINITE POLICY: preserve NaN (FITS blank), NOT 0-fill.
            dv.setFloat32(off, Number.isFinite(v as number) ? (v as number) : NaN, false);
            off += 4;
        }
    }
    // tailPad bytes are already zero (fresh Uint8Array) — FITS pads the data
    // segment with zero bytes.
    return out;
}

/** Canonical FITS file name: `${baseName}_${spatial_hash | timestamp}.fits`. */
export function fitsFileName(receipt: any, baseName = 'skycruncher'): string {
    return `${baseName}_${receipt?.solution?.spatial_hash ?? Date.now()}.fits`;
}

// ─── header assembly ──────────────────────────────────────────────────────────

/**
 * Build the ordered FITS keyword cards: mandatory geometry, then the fitted WCS
 * (consumed VERBATIM from receipt.wcs), then SIP (honest-absent), provenance
 * COMMENTs, and END. The receipt.wcs values are already in FITS units (deg / CD
 * deg-per-px, 0-based crpix) — the ONLY arithmetic is CRPIX+1.
 */
function buildHeaderCards(
    receipt: any,
    W: number,
    H: number,
    channels: number,
    opts: FitsWriterOptions
): string[] {
    const wcs = receipt.wcs;
    const sip = receipt?.solution?.astrometry?.sip;
    const hasSip = !!(sip && Array.isArray(sip.a) && Array.isArray(sip.b));
    const hasTps = receipt?.solution?.astrometry?.tps != null;

    // Fitted WCS scalars — all must be finite (never write a corrupt WCS).
    const crpix1 = requireFinite(wcs.CRPIX1, 'CRPIX1');
    const crpix2 = requireFinite(wcs.CRPIX2, 'CRPIX2');
    const crval1 = requireFinite(wcs.CRVAL1, 'CRVAL1');   // ALREADY degrees — do NOT ×15
    const crval2 = requireFinite(wcs.CRVAL2, 'CRVAL2');
    const cd11 = requireFinite(wcs.CD1_1, 'CD1_1');
    const cd12 = requireFinite(wcs.CD1_2, 'CD1_2');
    const cd21 = requireFinite(wcs.CD2_1, 'CD2_1');
    const cd22 = requireFinite(wcs.CD2_2, 'CD2_2');

    // CTYPE: SIP promotes the projection to the -SIP variant so a reader applies
    // the polynomial (plain TAN when no fitted SIP).
    const ctype1 = hasSip ? 'RA---TAN-SIP' : (wcs.CTYPE1 ?? 'RA---TAN');
    const ctype2 = hasSip ? 'DEC--TAN-SIP' : (wcs.CTYPE2 ?? 'DEC--TAN');

    const cards: string[] = [
        fitsCard('SIMPLE', true, 'SkyCruncher FITS export (fitted WCS)'),
        fitsCard('BITPIX', -32, 'IEEE single-precision float'),
        fitsCard('NAXIS', channels > 1 ? 3 : 2),
        fitsCard('NAXIS1', W),
        fitsCard('NAXIS2', H),
        ...(channels > 1 ? [fitsCard('NAXIS3', channels, 'planar RGB')] : []),
        fitsCard('BZERO', 0),
        fitsCard('BSCALE', 1),
        // ── fitted WCS (VERBATIM from receipt.wcs; CRPIX+1 is the sole change) ──
        fitsCard('CTYPE1', ctype1, 'gnomonic (RA)'),
        fitsCard('CTYPE2', ctype2, 'gnomonic (Dec)'),
        fitsCard('CUNIT1', 'deg'),
        fitsCard('CUNIT2', 'deg'),
        fitsCard('CRPIX1', crpix1 + 1, 'FITS 1-based (engine 0-based +1)'),
        fitsCard('CRPIX2', crpix2 + 1, 'FITS 1-based (engine 0-based +1)'),
        fitsCard('CRVAL1', crval1, 'deg (receipt already hours*15)'),
        fitsCard('CRVAL2', crval2, 'deg'),
        fitsCard('CD1_1', cd11),
        fitsCard('CD1_2', cd12),
        fitsCard('CD2_1', cd21),
        fitsCard('CD2_2', cd22),
        fitsCard('EQUINOX', numOr(wcs.EQUINOX, 2000.0)),
        fitsCard('RADESYS', strOr(wcs.RADESYS, 'ICRS')),
    ];

    // ── SIP forward coefficients (honest-absent; forward-only) ──────────────────
    if (hasSip) {
        // Negate to FITS convention (A_FITS = IDEAL − OBSERVED = −A_internal) so a
        // reader applying the polynomial corrects TOWARD the catalog — the raw
        // stored coefficients are OBSERVED − IDEAL (see sip_convention.ts).
        const fitsSip = toFitsSip(sip);
        cards.push(fitsCard('A_ORDER', fitsSip.a_order | 0, 'SIP forward order (RA)'));
        cards.push(fitsCard('B_ORDER', fitsSip.b_order | 0, 'SIP forward order (Dec)'));
        emitSipCards('A', fitsSip.a, cards);
        emitSipCards('B', fitsSip.b, cards);
        // We fit NO inverse (AP_*/BP_*): state it so a reader knows to invert
        // the forward polynomial numerically rather than expecting an inverse.
        cards.push(commentCard('SIP forward-only: AP_/BP_ inverse omitted (readers invert numerically).'));
        cards.push(commentCard('SIP A/B are FITS-convention (IDEAL-OBSERVED); engine fit stores OBSERVED-IDEAL.'));
    }

    // TPS has NO standard FITS representation — the spline distortion rides the
    // ASDF/GWCS export as a tabular lookup, NOT these headers. Note it so a FITS
    // reader knows a richer distortion model exists elsewhere.
    if (hasTps) {
        cards.push(commentCard('higher-order distortion (TPS) available in ASDF export.'));
    }

    // WCS provenance + convention note (mirrors generateReceiptWcs's COMMENT).
    cards.push(fitsCard('SOURCE', 'FITTED', 'WCS provenance (SkyCruncher fitted)'));
    cards.push(commentCard('SkyCruncher fitted WCS; pixels y-down (CD carries parity as fitted).'));
    if (opts.libraryVersion) {
        cards.push(fitsCard('ORIGIN', `SkyCruncher ${opts.libraryVersion}`.slice(0, 66)));
    }

    // Source provenance — the ORIGIN of the frame's bytes (Google Drive / URL /
    // local-drop), matched at ingest against the intake content-sha ledger. HISTORY
    // cards (honest-absent: nothing emitted when the origin is unknown). Long URIs
    // are split across continuation HISTORY cards — see emitProvenanceCards.
    emitProvenanceCards(receipt, cards);

    // Refined final-astrometry product (schema 2.20.0) — the SECOND, provenance-
    // tagged WCS. Emitted as FITS alternate WCS 'A' + HISTORY, NEVER overwriting
    // the primary (solve) WCS above. Honest-absent when the block is missing.
    emitFinalAstrometryCards(receipt, cards);

    cards.push('END'.padEnd(FITS_CARD));
    return cards;
}

/**
 * Emit the REFINED final-astrometry product (schema 2.20.0) as FITS alternate WCS
 * 'A' + provenance HISTORY, or NOTHING when the receipt carries no
 * `final_astrometry` block (honest-or-absent). This is a SECOND, provenance-tagged
 * WCS — it NEVER overwrites the primary (solve) WCS. Linear terms come from the
 * refined block's own wcs (engine convention: crval[0] HOURS → ×15 deg; crpix
 * 0-based → +1). The refined SIP is documented in HISTORY + carried
 * machine-readable in the receipt's `final_astrometry` block — it is NOT emitted
 * as alternate-WCS polynomial keywords (the SIP 'A'/'B' prefixes collide with the
 * alt-WCS version letter 'A', and alt-WCS SIP has no standard), so CTYPE?A stay
 * plain -TAN: the alt-WCS is the refined LINEAR WCS, honestly.
 */
function emitFinalAstrometryCards(receipt: any, out: string[]): void {
    const fa = receipt?.final_astrometry;
    if (!fa || typeof fa !== 'object' || !fa.wcs || typeof fa.wcs !== 'object') return;
    const w = fa.wcs;
    const crpix = w.crpix, crval = w.crval, cd = w.cd;
    const finite = (x: any) => typeof x === 'number' && Number.isFinite(x);
    if (!Array.isArray(crpix) || !Array.isArray(crval) || !Array.isArray(cd) ||
        !Array.isArray(cd[0]) || !Array.isArray(cd[1])) return;
    if (![crpix[0], crpix[1], crval[0], crval[1], cd[0][0], cd[0][1], cd[1][0], cd[1][1]].every(finite)) {
        return; // honest-absent on a corrupt block — never write a broken second WCS
    }
    const fmt = (x: any) => (typeof x === 'number' && Number.isFinite(x)) ? x.toFixed(3) : 'n/a';

    out.push(commentCard('SkyCruncher REFINED astrometry = alternate WCS "A" (a PRODUCT below,'));
    out.push(commentCard('never the solve WCS above): PSF centroids + diff refraction + SNR weight.'));
    out.push(fitsCard('WCSNAMEA', 'SKYCRUNCHER-REFINED-FINAL-ASTROMETRY', 'refined data-fidelity WCS'));
    out.push(fitsCard('CTYPE1A', 'RA---TAN', 'refined WCS linear (SIP in receipt)'));
    out.push(fitsCard('CTYPE2A', 'DEC--TAN', 'refined WCS linear (SIP in receipt)'));
    out.push(fitsCard('CUNIT1A', 'deg'));
    out.push(fitsCard('CUNIT2A', 'deg'));
    out.push(fitsCard('CRPIX1A', crpix[0] + 1, 'FITS 1-based (engine 0-based +1)'));
    out.push(fitsCard('CRPIX2A', crpix[1] + 1, 'FITS 1-based (engine 0-based +1)'));
    out.push(fitsCard('CRVAL1A', crval[0] * 15, 'deg (engine crval hours*15)'));
    out.push(fitsCard('CRVAL2A', crval[1], 'deg'));
    out.push(fitsCard('CD1_1A', cd[0][0]));
    out.push(fitsCard('CD1_2A', cd[0][1]));
    out.push(fitsCard('CD2_1A', cd[1][0]));
    out.push(fitsCard('CD2_2A', cd[1][1]));
    out.push(fitsCard('EQUINOXA', 2000.0));
    out.push(fitsCard('RADESYSA', 'ICRS'));
    out.push(historyCard('SkyCruncher REFINED final-astrometry (WCS A) — a PRODUCT, not the solve WCS.'));
    if (fa.sip && typeof fa.sip.a_order === 'number') {
        out.push(historyCard(`  refined SIP order ${fa.sip.a_order} — full coefficients in the receipt final_astrometry.`));
    }
    if (fa.rms && typeof fa.rms === 'object') {
        out.push(historyCard(`  RMS linear=${fmt(fa.rms.linearArcsec)}" refined=${fmt(fa.rms.refinedArcsec)}" (arcsec).`));
    }
    if (fa.refraction && typeof fa.refraction === 'object') {
        out.push(historyCard(`  differential refraction ${fa.refraction.applied ? 'APPLIED' : 'skipped'} (Bennett, APPROXIMATE).`));
    }
}

/**
 * Emit HISTORY cards recording the frame's source provenance (origin / uri /
 * fetched_at / intake_sha256), or NOTHING when the receipt carries no matched block
 * (honest-or-absent — an unknown origin is never fabricated into a card). A FITS card
 * is 80 chars and the HISTORY text field is cols 9-80 (72 chars), so a long URI is
 * chunked across continuation cards (a reader concatenates the `uri`/`uri(cont)`
 * lines). Every value is stringified defensively; nothing here is a measurement.
 */
function emitProvenanceCards(receipt: any, out: string[]): void {
    const sp = receipt?.source_provenance;
    if (!sp || typeof sp !== 'object') return;
    const populated = sp.origin != null || sp.uri != null || sp.fetched_at != null || sp.intake_sha256 != null;
    if (!populated) return; // honest-absent: unknown origin

    out.push(historyCard('SkyCruncher source provenance (frame-byte origin):'));
    if (sp.origin != null) emitProvenanceField(out, 'origin', String(sp.origin));
    if (sp.fetched_at != null) emitProvenanceField(out, 'fetched_at', String(sp.fetched_at));
    if (sp.intake_sha256 != null) emitProvenanceField(out, 'intake_sha256', String(sp.intake_sha256));
    if (sp.uri != null) emitProvenanceField(out, 'uri', String(sp.uri));
}

/**
 * Emit `HISTORY   <key>= <value>`, chunking a value too long for the 72-char
 * HISTORY text field across `<key>(cont)= …` continuation cards (a reader
 * concatenates the pieces in emission order). Guarantees NO card exceeds 80 bytes,
 * so a 64-char intake sha or a 100+ char Drive URL round-trips WITHOUT truncation
 * (silent truncation would be dishonest provenance).
 */
function emitProvenanceField(out: string[], key: string, value: string): void {
    const head = `  ${key}= `;
    const cont = `  ${key}(cont)= `;
    const BUDGET = 72; // cols 9-80 of an 80-char card, after the 8-char "HISTORY "
    const firstMax = BUDGET - head.length;
    if (value.length <= firstMax) {
        out.push(historyCard(`${head}${value}`));
        return;
    }
    out.push(historyCard(`${head}${value.slice(0, firstMax)}`));
    const contMax = BUDGET - cont.length;
    for (let i = firstMax; i < value.length; i += contMax) {
        out.push(historyCard(`${cont}${value.slice(i, i + contMax)}`));
    }
}

/** Emit `${prefix}_i_j` cards for a SIP A/B matrix, skipping zero / non-finite
 * terms (mirrors asdf_writer's emitSipTerms). coeff[p][q] = coefficient of
 * u^p v^q — the exact FITS SIP keyword layout. */
function emitSipCards(prefix: string, coeffs: number[][], out: string[]): void {
    if (!Array.isArray(coeffs)) return;
    for (let i = 0; i < coeffs.length; i++) {
        const row = coeffs[i];
        if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length; j++) {
            const v = row[j];
            if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
                out.push(fitsCard(`${prefix}_${i}_${j}`, v));
            }
        }
    }
}

// ─── card byte machinery (ported from tools/stack/fits_io.mjs) ────────────────

/** One 80-char FITS card. Booleans → T/F, strings → single-quoted, numbers →
 * formatFitsNumber (full float64 precision), all right-justified in the value
 * field. Ported verbatim from tools/stack/fits_io.mjs fitsCard. */
function fitsCard(key: string, value: string | number | boolean, comment?: string): string {
    let v: string;
    if (typeof value === 'string') v = `'${value.slice(0, 66)}'`.padEnd(20);
    else if (typeof value === 'boolean') v = (value ? 'T' : 'F').padStart(20);
    else v = formatFitsNumber(value).padStart(20);
    let card = `${key.padEnd(8)}= ${v}`;
    if (comment) card += ` / ${comment}`;
    return card.slice(0, FITS_CARD).padEnd(FITS_CARD);
}

/** A COMMENT card (keyword COMMENT, free text in cols 9-80, no `=`). */
function commentCard(text: string): string {
    return `COMMENT ${text}`.slice(0, FITS_CARD).padEnd(FITS_CARD);
}

/** A HISTORY card (keyword HISTORY, free text in cols 9-80, no `=`). Used for
 *  processing/origin provenance, mirroring commentCard's byte layout. */
function historyCard(text: string): string {
    return `HISTORY ${text}`.slice(0, FITS_CARD).padEnd(FITS_CARD);
}

/** Format a number for a FITS card value. Integers stay compact; everything else
 * uses toExponential(16) → 17 significant decimal figures, which is the IEEE-754
 * double GUARANTEE for a bit-exact decimal round-trip (a WCS keyword survives
 * re-parse with zero loss). DEVIATION from tools/stack/fits_io.mjs formatFitsNumber,
 * which uses toExponential(15) (16 sig figs — ~1e-14 deg on a CRVAL, negligible
 * for the stacker but NOT bit-exact). The one extra digit is what makes the
 * design's stated "full float64 round-trip precision" literally true. */
function formatFitsNumber(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return n.toExponential(16).toUpperCase();
}

// ─── header padding + small guards ────────────────────────────────────────────

/** Pad a header card string to a whole multiple of 2880 bytes with ASCII spaces
 * (FITS pads header records with blanks). */
function blockPad(header: string): string {
    return header.padEnd(Math.ceil(header.length / FITS_BLOCK) * FITS_BLOCK);
}

function requireFinite(v: any, key: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`FITS export refused: WCS keyword ${key} is non-finite (${v}).`);
    }
    return v;
}

function numOr(v: any, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strOr(v: any, fallback: string): string {
    return typeof v === 'string' && v.length > 0 ? v : fallback;
}
