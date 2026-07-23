// Read the SIP (A/B order-4) + CRPIX + (for validation only) CRVAL/CD from the
// ORIGINAL TESS ffic HDU1 header. Parses raw FITS 80-char cards; never loads the
// image data into context. Writes tess_sip_header.json.
//
//   node tools/repro/tess_read_sip.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/AstroLogic/intake/nasa_esa_1to1/tess_ffic.fits';
const OUT_DIR = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/test_results/tess_sip_prewarp_2026-07-11';

const buf = fs.readFileSync(SRC);

// Parse a header starting at byte `start`; return {cards:Map, end:byteAfterHeader}.
function parseHeader(start) {
    const cards = new Map();
    let pos = start;
    for (;;) {
        for (let i = 0; i < 2880; i += 80) {
            const card = buf.subarray(pos + i, pos + i + 80).toString('latin1');
            const key = card.slice(0, 8).trim();
            if (key === 'END') return { cards, end: pos + 2880 };
            const eq = card.indexOf('=');
            if (eq === 8 || (eq > 0 && eq < 10)) {
                let val = card.slice(eq + 1);
                const slash = val.indexOf('/');
                if (slash >= 0 && val.indexOf("'") < 0) val = val.slice(0, slash);
                val = val.trim().replace(/^'|'$/g, '').trim();
                cards.set(key, val);
            }
        }
        pos += 2880;
        if (pos > buf.length) return { cards, end: pos };
    }
}

// HDU0 (empty, NAXIS=0 -> 0 data bytes), then HDU1 header immediately after.
const h0 = parseHeader(0);
const h1 = parseHeader(h0.end);
const H = h1.cards;
const num = (k) => (H.has(k) ? Number(H.get(k)) : undefined);

const aOrder = num('A_ORDER'), bOrder = num('B_ORDER');
function mat(prefix, order) {
    const m = Array.from({ length: order + 1 }, () => new Array(order + 1).fill(0));
    const consumed = [];
    for (let i = 0; i <= order; i++) for (let j = 0; j <= order; j++) {
        const k = `${prefix}_${i}_${j}`;
        if (H.has(k)) { m[i][j] = Number(H.get(k)); consumed.push(k); }
    }
    return { m, consumed };
}
const A = mat('A', aOrder), B = mat('B', bOrder);

const out = {
    src: SRC,
    ctype: [H.get('CTYPE1'), H.get('CTYPE2')],
    naxis: [num('NAXIS1'), num('NAXIS2')],
    // --- CONSUMED for the pre-warp (distortion + reference pixel only) ---
    crpix: [num('CRPIX1'), num('CRPIX2')],   // FITS 1-based reference pixel
    a_order: aOrder, b_order: bOrder,
    a: A.m, b: B.m,
    // --- WITHHELD from the blind solve; used ONLY for validation/diagnostics ---
    _validation_only: {
        crval_deg: [num('CRVAL1'), num('CRVAL2')],
        cd: [[num('CD1_1'), num('CD1_2')], [num('CD2_1'), num('CD2_2')]],
    },
    consumed_keywords: ['CRPIX1', 'CRPIX2', 'A_ORDER', 'B_ORDER', ...A.consumed, ...B.consumed],
    withheld_keywords: ['CRVAL1', 'CRVAL2', 'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2', 'CTYPE1', 'CTYPE2'],
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'tess_sip_header.json'), JSON.stringify(out, null, 2));
console.log(`CTYPE=${out.ctype.join(',')} NAXIS=${out.naxis.join('x')} A_ORDER=${aOrder} B_ORDER=${bOrder}`);
console.log(`CRPIX=[${out.crpix.join(', ')}]`);
console.log(`A nonzero: ${A.consumed.length} terms; B nonzero: ${B.consumed.length} terms`);
console.log(`A matrix:`); console.table(A.m);
console.log(`B matrix:`); console.table(B.m);
console.log(`consumed=${out.consumed_keywords.length} keywords; withheld(pose)=${out.withheld_keywords.join(',')}`);
