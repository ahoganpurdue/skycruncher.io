// ═══════════════════════════════════════════════════════════════════════════
// TESS SIP PRE-WARP — feed a frame's MEASURED distortion (SIP A/B + CRPIX) into
// the detection COORDINATE stream, producing an undistorted TAN-plane detection
// list for the blind solver. COORDINATE ledger only (LAW 1): positions are
// remapped through a polynomial; no pixel is resampled.
//
// CONSUMES from the original TESS header: CRPIX (reference pixel) + A_i_j/B_i_j
// (SIP order-4 distortion). WITHHOLDS: CRVAL, CD (the pose) from the solve — they
// are used ONLY for the offline validation block below (clearly labelled).
//
//   node tools/repro/tess_sip_prewarp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAtlasRegion, tanForward, angSepDeg } from '../psf/forced_detect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'test_results', 'tess_sip_prewarp_2026-07-11');
const D2R = Math.PI / 180;

const dets = JSON.parse(fs.readFileSync(path.join(DIR, 'tess_raw_dets.app.json'), 'utf8')).detections;
const hdr = JSON.parse(fs.readFileSync(path.join(DIR, 'tess_sip_header.json'), 'utf8'));
const [CRPIX1, CRPIX2] = hdr.crpix;
const A = hdr.a, B = hdr.b;
const CRVAL = hdr._validation_only.crval_deg;   // VALIDATION ONLY
const CD = hdr._validation_only.cd;             // VALIDATION ONLY
const ORIG_W = hdr.naxis[0], ORIG_H = hdr.naxis[1]; // 2136 x 2078

// ── SIP forward polynomial: f(u,v) = Σ A_ij u^i v^j  (FITS-standard, Shupe 2005)
function sipPoly(coef, u, v) {
    let s = 0;
    for (let i = 0; i < coef.length; i++) {
        const row = coef[i]; if (!row) continue;
        for (let j = 0; j < row.length; j++) {
            const c = row[j];
            if (c) s += c * Math.pow(u, i) * Math.pow(v, j);
        }
    }
    return s;
}
// pixel(FITS 1-based) -> undistorted pixel offset (u',v') about CRPIX. Pose-free.
function sipCorrect(xf, yf) {
    const u = xf - CRPIX1, v = yf - CRPIX2;
    const up = u + sipPoly(A, u, v);
    const vp = v + sipPoly(B, u, v);
    return { up, vp };
}
// TAN deprojection: intermediate world (xi,eta deg) about crval -> (ra,dec) deg.
function tanInverse(xi, eta, ra0, dec0) {
    const x = xi * D2R, y = eta * D2R;
    const r = Math.hypot(x, y);
    if (r < 1e-12) return { ra: ra0, dec: dec0 };
    const c = Math.atan(r), sc = Math.sin(c), cc = Math.cos(c);
    const d0 = dec0 * D2R;
    const dec = Math.asin(cc * Math.sin(d0) + (y * sc * Math.cos(d0)) / r) / D2R;
    let ra = ra0 + Math.atan2(x * sc, r * Math.cos(d0) * cc - y * Math.sin(d0) * sc) / D2R;
    ra = ((ra % 360) + 360) % 360;
    return { ra, dec };
}
// FULL truth WCS forward (SIP+CD+TAN): detection pixel -> sky. VALIDATION ONLY.
function pixToSkyFull(xf, yf) {
    const { up, vp } = sipCorrect(xf, yf);
    const xi = CD[0][0] * up + CD[0][1] * vp;   // deg
    const eta = CD[1][0] * up + CD[1][1] * vp;  // deg
    return tanInverse(xi, eta, CRVAL[0], CRVAL[1]);
}
// LINEAR truth WCS forward (NO SIP): raw pixel -> sky. VALIDATION ONLY.
function pixToSkyLinear(xf, yf) {
    const u = xf - CRPIX1, v = yf - CRPIX2;
    const xi = CD[0][0] * u + CD[0][1] * v, eta = CD[1][0] * u + CD[1][1] * v;
    return tanInverse(xi, eta, CRVAL[0], CRVAL[1]);
}

// ── candidate detector->FITS-pixel mappings (trim: cols[44..2091], rows[0..2047])
//    empirically resolved by max catalog matches under the FULL truth WCS.
const MAPPINGS = {
    'x+45,y+1 (no flip)':      (d) => ({ xf: d.x + 45, yf: d.y + 1 }),
    'x+45,y-flip 2048-y':      (d) => ({ xf: d.x + 45, yf: 2048 - d.y }),
    'x-flip 2092-x,y+1':       (d) => ({ xf: 2092 - d.x, yf: d.y + 1 }),
    'x-flip 2092-x,y-flip':    (d) => ({ xf: 2092 - d.x, yf: 2048 - d.y }),
};

// catalog around the TRUE center (validation): deep-ish for match discrimination
const TRUE_CTR = { ra: 89.714, dec: -75.396 };
const { stars } = loadAtlasRegion({ root: ROOT, raDeg: TRUE_CTR.ra, decDeg: TRUE_CTR.dec, radiusDeg: 12, magLimit: 11 });

function countSkyMatches(pixToSky, mapFn, tolArcsec) {
    let matched = 0; const seps = [];
    for (const d of dets) {
        const { xf, yf } = mapFn(d);
        const sky = pixToSky(xf, yf);
        let best = Infinity;
        for (const s of stars) {
            const sep = angSepDeg(sky.ra, sky.dec, s.ra_deg, s.dec_deg) * 3600;
            if (sep < best) best = sep;
        }
        if (best < tolArcsec) { matched++; seps.push(best); }
    }
    const med = seps.length ? seps.sort((a, b) => a - b)[Math.floor(seps.length / 2)] : null;
    return { matched, medianSepArcsec: med };
}

console.log(`catalog: ${stars.length} stars (mag<=11) within 12deg of true center; ${dets.length} detections`);
console.log(`\n── MAPPING RESOLUTION (matches vs catalog under FULL truth WCS, tol 45") ──`);
let bestMap = null;
for (const [name, fn] of Object.entries(MAPPINGS)) {
    const full = countSkyMatches(pixToSkyFull, fn, 45);
    const lin = countSkyMatches(pixToSkyLinear, fn, 45);
    console.log(`  ${name.padEnd(24)} FULL(SIP)=${String(full.matched).padStart(3)} (med ${full.medianSepArcsec?.toFixed(1) ?? '—'}")  LINEAR(noSIP)=${String(lin.matched).padStart(3)}`);
    if (!bestMap || full.matched > bestMap.full.matched) bestMap = { name, fn, full, lin };
}
console.log(`  → WINNER: "${bestMap.name}" (FULL ${bestMap.full.matched} matches)`);

// ── Diagnostic: does SIP correction actually reduce residuals vs the LINEAR WCS?
//    Under the winning mapping, compare corrected-detections-vs-linear-WCS to
//    raw-detections-vs-linear-WCS. If SIP is right + material, corrected should
//    match the LINEAR catalog far better than raw does.
const mapFn = bestMap.fn;
// corrected detection sky = LINEAR forward of the SIP-corrected pixel offset
function correctedToSky(d) {
    const { xf, yf } = mapFn(d);
    const { up, vp } = sipCorrect(xf, yf);
    const xi = CD[0][0] * up + CD[0][1] * vp, eta = CD[1][0] * up + CD[1][1] * vp;
    return tanInverse(xi, eta, CRVAL[0], CRVAL[1]);
}
function matchSkyFn(skyFn, tol) {
    let m = 0; const seps = [];
    for (const d of dets) {
        const sky = skyFn(d);
        let best = Infinity;
        for (const s of stars) { const sep = angSepDeg(sky.ra, sky.dec, s.ra_deg, s.dec_deg) * 3600; if (sep < best) best = sep; }
        if (best < tol) { m++; seps.push(best); }
    }
    seps.sort((a, b) => a - b);
    return { matched: m, med: seps.length ? seps[Math.floor(seps.length / 2)] : null };
}
console.log(`\n── SIP EFFECT (winning mapping; tol sweep) ──`);
for (const tol of [10, 20, 45]) {
    const raw = matchSkyFn((d) => pixToSkyLinear(mapFn(d).xf, mapFn(d).yf), tol);
    const cor = matchSkyFn(correctedToSky, tol);
    console.log(`  tol ${String(tol).padStart(2)}": RAW-vs-linearWCS=${String(raw.matched).padStart(3)} (med ${raw.med?.toFixed(1) ?? '—'}")   CORRECTED-vs-linearWCS=${String(cor.matched).padStart(3)} (med ${cor.med?.toFixed(1) ?? '—'}")`);
}

// ── EMIT solverkit detection files (both in the original FITS pixel frame) ──────
// RAW arm: detector coords mapped to FITS pixels, NO distortion correction.
// CORRECTED arm: same, then SIP forward -> undistorted TAN-plane pixels (CRPIX+u').
const rawOut = dets.map((d) => { const { xf, yf } = mapFn(d); return { x: xf, y: yf, flux: d.flux, fwhm: d.fwhm }; });
const corOut = dets.map((d) => { const { xf, yf } = mapFn(d); const { up, vp } = sipCorrect(xf, yf); return { x: CRPIX1 + up, y: CRPIX2 + vp, flux: d.flux, fwhm: d.fwhm }; });

const base = { width: ORIG_W, height: ORIG_H, scaleArcsecPerPx: null, planets: [] };
fs.writeFileSync(path.join(DIR, 'tess_raw_fits.app.json'), JSON.stringify({ ...base, source: `raw dets in FITS pixels, mapping="${bestMap.name}"`, n: rawOut.length, detections: rawOut }, null, 1));
fs.writeFileSync(path.join(DIR, 'tess_corrected.app.json'), JSON.stringify({ ...base, source: `SIP-corrected (CRPIX+A/B forward) undistorted TAN-plane pixels, mapping="${bestMap.name}"`, n: corOut.length, detections: corOut }, null, 1));

// validation record
fs.writeFileSync(path.join(DIR, 'prewarp_validation.json'), JSON.stringify({
    generated: '2026-07-11',
    consumed_keywords: hdr.consumed_keywords,
    withheld_keywords: hdr.withheld_keywords,
    true_center: TRUE_CTR,
    catalog_stars: stars.length,
    n_detections: dets.length,
    winning_mapping: bestMap.name,
    mapping_matches: Object.fromEntries(Object.entries(MAPPINGS).map(([n, fn]) => [n, countSkyMatches(pixToSkyFull, fn, 45).matched])),
    sip_effect: [10, 20, 45].map((tol) => ({ tol, raw: matchSkyFn((d) => pixToSkyLinear(mapFn(d).xf, mapFn(d).yf), tol).matched, corrected: matchSkyFn(correctedToSky, tol).matched })),
}, null, 2));

console.log(`\nwrote: tess_raw_fits.app.json (${rawOut.length}), tess_corrected.app.json (${corOut.length}), prewarp_validation.json`);
const cx = corOut.reduce((a, d) => Math.min(a, d.x), Infinity), cX = corOut.reduce((a, d) => Math.max(a, d.x), -Infinity);
const cy = corOut.reduce((a, d) => Math.min(a, d.y), Infinity), cY = corOut.reduce((a, d) => Math.max(a, d.y), -Infinity);
console.log(`corrected coord bbox: x[${cx.toFixed(0)},${cX.toFixed(0)}] y[${cy.toFixed(0)},${cY.toFixed(0)}]  (frame ${ORIG_W}x${ORIG_H})`);
