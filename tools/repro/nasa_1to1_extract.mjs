// NASA 1:1 — extract blind solve-input frames (no python).
//  TESS: read multi-ext HDU1 (calibrated science, BITPIX=-32, 2136x2078),
//        TRIM to the 2048x2048 science region, write a single-HDU BITPIX=-32
//        file with a MINIMAL header (blind: no WCS/pointing/scale keywords).
//  ZTF : primary HDU is already single-HDU BITPIX=-32; rewrite a minimal-header
//        copy so no WCS survives into the blind input.
// Verified by re-reading each output with openFits() from tools/stack/fits_io.mjs.
import fs from 'node:fs';
import { openFits, readPlaneRaw, writeFitsPlanar } from '../stack/fits_io.mjs';

const INTAKE = 'D:/AstroLogic/intake/nasa_esa_1to1';

// ── TESS: read ext-1 float32 raw (big-endian), faithful (no 0->NaN folding) ──
function readExt1RawTess() {
    const file = `${INTAKE}/tess_ffic.fits`;
    const fd = fs.openSync(file, 'r');
    // From inspect: HDU1 header spans blocks 1..6 -> data starts block 7 = 20160.
    const dataOffset = 20160, W = 2136, H = 2078;
    const bytes = W * H * 4;
    const buf = Buffer.alloc(bytes);
    let off = 0;
    while (off < bytes) off += fs.readSync(fd, buf, off, Math.min(1 << 24, bytes - off), dataOffset + off);
    fs.closeSync(fd);
    const dv = new DataView(buf.buffer, buf.byteOffset, bytes);
    const plane = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) plane[i] = dv.getFloat32(i * 4, false);
    return { plane, W, H };
}

function trimTess(plane, W, H) {
    // TESS calibrated FFI layout: 2136 cols = 44 leading virtual + 2048 science
    // (cols 45..2092, 1-based) + 44 trailing; 2078 rows = 2048 science (1..2048)
    // + 30 virtual rows at top. Science region -> 0-based cols [44..2091],
    // rows [0..2047]. We keep the offset so NASA's WCS can be evaluated at the
    // exact original pixel during comparison.
    const COL0 = 44, ROW0 = 0, SW = 2048, SH = 2048;
    const out = new Float32Array(SW * SH);
    for (let y = 0; y < SH; y++) {
        const srcRow = (ROW0 + y) * W;
        const dstRow = y * SW;
        for (let x = 0; x < SW; x++) out[dstRow + x] = plane[srcRow + (COL0 + x)];
    }
    return { out, SW, SH, COL0, ROW0 };
}

console.log('=== TESS ext-1 extraction ===');
const t = readExt1RawTess();
let finite = 0, mn = Infinity, mx = -Infinity;
for (let i = 0; i < t.plane.length; i++) { const v = t.plane[i]; if (Number.isFinite(v)) { finite++; if (v < mn) mn = v; if (v > mx) mx = v; } }
console.log(`  ext1 full ${t.W}x${t.H}  finite=${finite}/${t.plane.length}  range=[${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
const tr = trimTess(t.plane, t.W, t.H);
const tessOut = `${INTAKE}/tess_ext1_sci_blind.fits`;
writeFitsPlanar(tessOut, [tr.out], tr.SW, tr.SH, [
    ['OBJECT', 'TESS-S01-C4-CCD2-BLIND', 'WCS-stripped science trim'],
    ['ORIGIN', 'SkyCruncher nasa_1to1 extract'],
    ['COMMENT_1', 0, `science trim cols[${tr.COL0}..${tr.COL0 + tr.SW - 1}] rows[${tr.ROW0}..${tr.ROW0 + tr.SH - 1}] of 2136x2078`],
]);
console.log(`  wrote ${tessOut}  ${tr.SW}x${tr.SH}  (science trim col0=${tr.COL0} row0=${tr.ROW0})`);

// ── ZTF: minimal-header copy of primary HDU (strip WCS) ──
console.log('=== ZTF primary rewrite (blind) ===');
const zf = openFits(`${INTAKE}/ztf_sciimg.fits`);
console.log(`  primary ${zf.W}x${zf.H} bitpix=${zf.BITPIX} NP=${zf.NP}`);
const zplane = readPlaneRaw(zf, 0);
zf.close();
const ztfOut = `${INTAKE}/ztf_sci_blind.fits`;
writeFitsPlanar(ztfOut, [zplane], 3072, 3080, [
    ['OBJECT', 'ZTF-c11-q3-zr-BLIND', 'WCS-stripped primary copy'],
    ['ORIGIN', 'SkyCruncher nasa_1to1 extract'],
]);
console.log(`  wrote ${ztfOut}  3072x3080`);

// ── Verify both re-read cleanly with openFits() ──
console.log('=== verify re-read ===');
for (const [name, p, ew, eh] of [['TESS', tessOut, 2048, 2048], ['ZTF', ztfOut, 3072, 3080]]) {
    const f = openFits(p);
    const ok = f.W === ew && f.H === eh && f.BITPIX === -32 && f.NP === 1;
    // confirm blind: no WCS keywords present
    const wcsKeys = Object.keys(f.cards).filter(k => /^(CRVAL|CRPIX|CD\d|CTYPE|CDELT|CUNIT|CROTA|PC\d|A_|B_|WCSAXES|LONPOLE|LATPOLE|RADESYS|EQUINOX)/.test(k));
    console.log(`  ${name}: ${f.W}x${f.H} bitpix=${f.BITPIX} ok=${ok}  residualWcsKeys=[${wcsKeys.join(',')}]  cards=[${Object.keys(f.cards).join(',')}]`);
    f.close();
}
console.log('DONE');
