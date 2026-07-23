// NASA 1:1 — build the comparison (ours vs published mission WCS).
// NASA/Caltech WCS is read LIVE from the ORIGINAL headers (no hand transcription).
// Our side is read from the solve_*.json the headless runner emitted.
// Honest-or-absent: our unsolved quantities are recorded as NOT MEASURED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTAKE = 'D:/AstroLogic/intake/nasa_esa_1to1';
const OUT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'test_results/nasa_1to1_2026-07-11');

// ---- read a specific HDU header (0-based) ----
function headerOfHdu(file, wantHdu) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const block = Buffer.alloc(2880);
    let blk = 0, hdu = 0, result = null;
    while (blk * 2880 < size) {
        const cards = {}; let ended = false, start = blk;
        for (; !ended; blk++) {
            if (fs.readSync(fd, block, 0, 2880, blk * 2880) < 2880) { ended = true; break; }
            for (let i = 0; i < 2880; i += 80) {
                const card = block.subarray(i, i + 80).toString('latin1');
                const kw = card.slice(0, 8).trim();
                if (kw === 'END') { ended = true; break; }
                if (!kw || kw === 'COMMENT' || kw === 'HISTORY' || card.slice(8, 10) !== '= ') continue;
                let raw = card.slice(10), inq = false, e = raw.length;
                for (let j = 0; j < raw.length; j++) { const c = raw[j]; if (c === "'") inq = !inq; else if (c === '/' && !inq) { e = j; break; } }
                let v = raw.slice(0, e).trim();
                if (v.startsWith("'")) v = v.slice(1, v.lastIndexOf("'")).trim();
                cards[kw] = v;
            }
        }
        if (hdu === wantHdu) { result = cards; break; }
        // advance past data
        const bitpix = Math.abs(+(cards.BITPIX ?? 0)), naxis = +(cards.NAXIS ?? 0);
        let npix = naxis ? 1 : 0; for (let a = 1; a <= naxis; a++) npix *= +(cards['NAXIS' + a] ?? 1);
        const pc = +(cards.PCOUNT ?? 0), gc = +(cards.GCOUNT ?? 1);
        blk = (blk) + Math.ceil((bitpix / 8) * gc * (pc + npix) / 2880);
        hdu++;
    }
    fs.closeSync(fd);
    return result;
}

// ---- WCS derivations from a CD matrix ----
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function cdDerive(c) {
    const CD = [[+c.CD1_1, +c.CD1_2], [+c.CD2_1, +c.CD2_2]];
    const det = CD[0][0] * CD[1][1] - CD[0][1] * CD[1][0];
    const scale = Math.sqrt(Math.abs(det)) * 3600;               // arcsec/px
    const rotX = Math.atan2(CD[1][0], CD[0][0]) * R2D;           // deg
    const rotY = Math.atan2(-CD[0][1], CD[1][1]) * R2D;          // deg
    const parity = det < 0 ? 'flipped(det<0)' : 'direct(det>0)';
    return { CD, det, scale, rotX, rotY, rot_mean: (rotX + rotY) / 2, parity };
}
// gnomonic (TAN, SIP ignored — sub-arcsec near reference) sky at pixel (1-based)
function tanPix2Sky(c, px, py) {
    const dx = px - (+c.CRPIX1), dy = py - (+c.CRPIX2);
    const xi = (+c.CD1_1 * dx + +c.CD1_2 * dy) * D2R;   // native intermediate (rad)
    const eta = (+c.CD2_1 * dx + +c.CD2_2 * dy) * D2R;
    const ra0 = +c.CRVAL1 * D2R, dec0 = +c.CRVAL2 * D2R;
    const r = Math.hypot(xi, eta); const cr = Math.atan(r);
    let ra, dec;
    if (r === 0) { ra = ra0; dec = dec0; }
    else {
        dec = Math.asin(Math.cos(cr) * Math.sin(dec0) + (eta * Math.sin(cr) * Math.cos(dec0)) / r);
        ra = ra0 + Math.atan2(xi * Math.sin(cr), r * Math.cos(dec0) * Math.cos(cr) - eta * Math.sin(dec0) * Math.sin(cr));
    }
    return { ra_deg: ((ra * R2D) % 360 + 360) % 360, dec_deg: dec * R2D };
}
function galactic(raDeg, decDeg) {
    const raG = 192.85948 * D2R, decG = 27.12825 * D2R, lNCP = 122.93192 * D2R;
    const ra = raDeg * D2R, dec = decDeg * D2R;
    const b = Math.asin(Math.sin(dec) * Math.sin(decG) + Math.cos(dec) * Math.cos(decG) * Math.cos(ra - raG));
    const l = lNCP - Math.atan2(Math.cos(dec) * Math.sin(ra - raG),
        Math.sin(dec) * Math.cos(decG) - Math.cos(dec) * Math.sin(decG) * Math.cos(ra - raG));
    return { l_deg: ((l * R2D) % 360 + 360) % 360, b_deg: b * R2D };
}
function angSep(ra1, d1, ra2, d2) { // arcsec
    const a1 = ra1 * D2R, b1 = d1 * D2R, a2 = ra2 * D2R, b2 = d2 * D2R;
    const c = Math.sin(b1) * Math.sin(b2) + Math.cos(b1) * Math.cos(b2) * Math.cos(a1 - a2);
    return Math.acos(Math.min(1, Math.max(-1, c))) * R2D * 3600;
}

// ---- NASA sides ----
const tessH = headerOfHdu(`${INTAKE}/tess_ffic.fits`, 1);
const ztfH = headerOfHdu(`${INTAKE}/ztf_sciimg.fits`, 0);

function nasaSide(name, c, fullW, fullH, ctrPx, ctrPy, note) {
    const d = cdDerive(c);
    const ctr = tanPix2Sky(c, ctrPx, ctrPy);
    const crvalGal = galactic(+c.CRVAL1, +c.CRVAL2);
    return {
        frame: name,
        ctype: [c.CTYPE1, c.CTYPE2],
        distortion: (c.A_ORDER ? `SIP order ${c.A_ORDER}` : (String(c.CTYPE1).includes('TPV') ? 'TPV (PV terms)' : 'none')),
        crval_deg: [+c.CRVAL1, +c.CRVAL2],
        crval_ra_hours: +c.CRVAL1 / 15,
        crpix: [+c.CRPIX1, +c.CRPIX2],
        cd_matrix: d.CD,
        pixel_scale_arcsec_px: d.scale,
        rotation_deg: { from_cd_x: d.rotX, from_cd_y: d.rotY, mean: d.rot_mean },
        parity: d.parity,
        frame_center_pixel_1based: [ctrPx, ctrPy],
        frame_center_sky_deg: [ctr.ra_deg, ctr.dec_deg],
        galactic_at_crval: crvalGal,
        full_dims: [fullW, fullH],
        note,
    };
}

// TESS: blind input was trimmed 2048x2048 (col0=44,row0=0). Its geometric center
// (trimmed 1-based 1024.5,1024.5) maps to full-frame 1-based (1068.5, 1024.5).
const tessCtr = [44 + 1024.5, 0 + 1024.5];
const tess = nasaSide('TESS-S1-C4-CCD2', tessH, 2136, 2078, tessCtr[0], tessCtr[1],
    'TAN-SIP; frame_center_sky ignores SIP (|offset|~24px from CRPIX -> <1" error).');
const ztf = nasaSide('ZTF-c11-q3-zr', ztfH, 3072, 3080, 1536.5, 1540.5,
    'TPV; frame_center evaluated at CRPIX so distortion=0 there.');

// ---- our sides ----
function ourSide(tag) {
    const p = `${OUT}/solve_${tag}.json`;
    if (!fs.existsSync(p)) return { present: false };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
        present: true, mode: j.mode, solved: j.solved, wall_s: (j.wall_ms / 1000),
        detections: j.detections?.clean_stars ?? j.signal?.clean_stars ?? null,
        candidates: j.solve_candidate_count ?? null,
        status: j.status, scale_hint: j.scale_hint_arcsec_px,
        solution: j.solution_scalars ? {
            ra_deg: j.solution_scalars.ra_deg, dec_deg: j.solution_scalars.dec_degrees,
            scale: j.solution_scalars.pixel_scale_arcsec_px, matched: j.solution_scalars.stars_matched,
            conf: j.solution_scalars.confidence,
        } : null,
    };
}
const ours = {
    tess_blind: ourSide('tess_blind'), tess_hinted: ourSide('tess_hinted'),
    ztf_blind: ourSide('ztf_blind'), ztf_hinted: ourSide('ztf_hinted'),
};

const measurements = {
    generated: '2026-07-11',
    method: 'SkyCruncher real headless wizard pipeline (tools/api/headless_driver runWizardPipeline) on WCS-stripped blind frames; NASA/Caltech WCS read live from original headers.',
    nasa: { tess, ztf },
    ours,
    field_galactic: {
        tess_b_deg: tess.galactic_at_crval.b_deg, ztf_b_deg: ztf.galactic_at_crval.b_deg,
    },
    comparison_outcome: 'NO SkyCruncher geometric lock on either frame (blind or hinted). All ours-vs-NASA deltas = NOT MEASURED (no solution produced). Failure modes measured per frame (see RESULTS.md).',
};
fs.writeFileSync(`${OUT}/measurements.json`, JSON.stringify(measurements, null, 2));
console.log('wrote measurements.json');
console.log(`TESS scale=${tess.pixel_scale_arcsec_px.toFixed(4)}"/px rot=${tess.rotation_deg.mean.toFixed(3)} b=${tess.galactic_at_crval.b_deg.toFixed(2)} parity=${tess.parity}`);
console.log(`ZTF  scale=${ztf.pixel_scale_arcsec_px.toFixed(4)}"/px rot=${ztf.rotation_deg.mean.toFixed(3)} b=${ztf.galactic_at_crval.b_deg.toFixed(2)} parity=${ztf.parity}`);
console.log(`TESS frame-center sky = ${tess.frame_center_sky_deg.map(x=>x.toFixed(4))}`);
console.log(`ZTF  frame-center sky = ${ztf.frame_center_sky_deg.map(x=>x.toFixed(4))}`);
