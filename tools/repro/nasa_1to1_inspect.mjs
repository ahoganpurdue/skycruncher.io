// NASA 1:1 — multi-HDU FITS header walker (no python on box).
// Walks 2880-byte blocks HDU by HDU, dumps keyword cards, computes data spans
// (handles BITPIX*|NAXIS| + PCOUNT/GCOUNT for bintables). Read-only inspection.
import fs from 'node:fs';

function parseHeaderAt(fd, startBlock) {
    const cards = {};
    const order = [];
    const block = Buffer.alloc(2880);
    let blk = startBlock, ended = false;
    for (; !ended; blk++) {
        const got = fs.readSync(fd, block, 0, 2880, blk * 2880);
        if (got < 2880) return null;
        for (let i = 0; i < 2880; i += 80) {
            const card = block.subarray(i, i + 80).toString('latin1');
            const kw = card.slice(0, 8).trim();
            if (kw === 'END') { ended = true; break; }
            if (!kw || kw === 'COMMENT' || kw === 'HISTORY') continue;
            if (card.slice(8, 10) !== '= ') continue;
            let raw = card.slice(10);
            // split value/comment at first / outside quotes
            let inq = false, end = raw.length;
            for (let j = 0; j < raw.length; j++) {
                const c = raw[j];
                if (c === "'") inq = !inq;
                else if (c === '/' && !inq) { end = j; break; }
            }
            let v = raw.slice(0, end).trim();
            if (v.startsWith("'")) v = v.slice(1, v.lastIndexOf("'")).trim();
            if (!(kw in cards)) order.push(kw);
            cards[kw] = v;
        }
    }
    const hdrEndBlock = blk; // block AFTER END
    return { cards, order, startBlock, hdrEndBlock };
}

function dataBlocks(cards) {
    const bitpix = Math.abs(+(cards.BITPIX ?? 0));
    const naxis = +(cards.NAXIS ?? 0);
    if (naxis === 0) return 0;
    let npix = 1;
    for (let a = 1; a <= naxis; a++) npix *= +(cards['NAXIS' + a] ?? 1);
    const pcount = +(cards.PCOUNT ?? 0), gcount = +(cards.GCOUNT ?? 1);
    const bytes = (bitpix / 8) * gcount * (pcount + npix);
    return Math.ceil(bytes / 2880);
}

const file = process.argv[2];
const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
console.log(`FILE ${file}  size=${size}  blocks=${size / 2880}`);
let blk = 0, hdu = 0;
while (blk * 2880 < size && hdu < 10) {
    const h = parseHeaderAt(fd, blk);
    if (!h) break;
    const dblks = dataBlocks(h.cards);
    console.log(`\n===== HDU ${hdu}  hdrBlocks=${h.hdrEndBlock - h.startBlock}  dataBlocks=${dblks}  dataOffset=${h.hdrEndBlock * 2880} =====`);
    const want = process.argv[3] === 'full' ? h.order : h.order.filter(k =>
        /^(SIMPLE|XTENSION|BITPIX|NAXIS|NAXIS\d|PCOUNT|GCOUNT|EXTNAME|EXTVER|ZIMAGE|ZCMPTYPE|ZBITPIX|ZNAXIS\d?|TELESCOP|INSTRUME|FILTER|CAMERA|CCD|SECTOR|CRVAL\d|CRPIX\d|CD\d_\d|CDELT\d|CTYPE\d|CUNIT\d|CROTA\d|PC\d_\d|A_ORDER|B_ORDER|WCSAXES|EQUINOX|RADESYS|LONPOLE|LATPOLE|RA|DEC|RA_TARG|DEC_TARG|RA_NOM|DEC_NOM|RA_OBJ|DEC_OBJ|CRVAL1A|FOCALLEN|XPIXSZ|YPIXSZ|PIXSCAL\d?|GAIN|EXPTIME|EXPOSURE|DATE-OBS|MJD-OBS|BZERO|BSCALE|OBJECT|BJDREFI|TSTART|TSTOP)$/.test(k));
    for (const k of want) console.log(`  ${k.padEnd(9)}= ${h.cards[k]}`);
    blk = h.hdrEndBlock + dblks;
    hdu++;
}
fs.closeSync(fd);
