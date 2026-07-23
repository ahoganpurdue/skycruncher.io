/**
 * Synthetic in-memory FITS builder for decoder tests.
 *
 * Writes spec-compliant 80-char header cards (keyword padded to 8 bytes,
 * "= " value indicator, numeric values right-aligned to byte 30), an END
 * card, 2880-byte block padding, and big-endian int16 data folded through
 * BZERO (physical value v is stored as (v - bzero) / bscale).
 */

export interface SyntheticFitsOptions {
    naxis: 2 | 3;
    width: number;
    height: number;
    /** Extra header cards. Re-specifying a base card (e.g. BITPIX) overrides it. */
    cards?: Record<string, string | number | boolean>;
    /** Physical pixel value generator; plane is 0..2 for naxis=3, always 0 for naxis=2. */
    pixelFn?: (x: number, y: number, plane: number) => number;
    /** BZERO written into both the header and the data fold (default 32768). */
    bzero?: number;
    /** BSCALE written into both the header and the data fold (default 1). */
    bscale?: number;
    /** Sample format: 16 = int16 (default), 32 = int32 big-endian. */
    bitpix?: 16 | 32;
}

const BLOCK_SIZE = 2880;
const CARD_SIZE = 80;

function formatCard(keyword: string, value?: string | number | boolean): string {
    const key = keyword.padEnd(8, ' ').slice(0, 8);
    if (value === undefined) return key.padEnd(CARD_SIZE, ' '); // END / bare keyword

    let vstr: string;
    if (typeof value === 'string') {
        vstr = `'${value.replace(/'/g, "''")}'`;
    } else if (typeof value === 'boolean') {
        vstr = (value ? 'T' : 'F').padStart(20, ' ');
    } else {
        vstr = String(value).padStart(20, ' ');
    }
    return `${key}= ${vstr}`.padEnd(CARD_SIZE, ' ').slice(0, CARD_SIZE);
}

export function buildSyntheticFits(opts: SyntheticFitsOptions): ArrayBuffer {
    const { naxis, width, height, pixelFn } = opts;
    const bitpix = opts.bitpix ?? 16;
    const bytesPerSample = bitpix === 16 ? 2 : 4;
    const bzero = opts.bzero ?? 32768;
    const bscale = opts.bscale ?? 1;
    const planes = naxis === 3 ? 3 : 1;

    const cards: string[] = [
        formatCard('SIMPLE', true),
        formatCard('BITPIX', bitpix),
        formatCard('NAXIS', naxis),
        formatCard('NAXIS1', width),
        formatCard('NAXIS2', height),
    ];
    if (naxis === 3) cards.push(formatCard('NAXIS3', 3));
    cards.push(formatCard('BZERO', bzero));
    cards.push(formatCard('BSCALE', bscale));
    for (const [key, value] of Object.entries(opts.cards ?? {})) {
        cards.push(formatCard(key, value));
    }
    cards.push(formatCard('END'));

    const headerBytes = Math.ceil(cards.length / 36) * BLOCK_SIZE;
    const nPix = width * height * planes;
    const dataBytes = Math.ceil((nPix * bytesPerSample) / BLOCK_SIZE) * BLOCK_SIZE;

    const buffer = new ArrayBuffer(headerBytes + dataBytes);
    const u8 = new Uint8Array(buffer);
    u8.fill(0x20, 0, headerBytes); // header block padding is ASCII spaces

    const headerText = cards.join('');
    for (let i = 0; i < headerText.length; i++) u8[i] = headerText.charCodeAt(i) & 0x7f;

    // Data unit: big-endian int, physical -> stored fold (trailing pad stays 0)
    const dv = new DataView(buffer, headerBytes);
    let i = 0;
    for (let p = 0; p < planes; p++) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const phys = pixelFn ? pixelFn(x, y, p) : 0;
                const stored = Math.round((phys - bzero) / bscale);
                if (bitpix === 16) dv.setInt16(i * bytesPerSample, stored, false);
                else dv.setInt32(i * bytesPerSample, stored, false);
                i++;
            }
        }
    }
    return buffer;
}
