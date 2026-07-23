// Decisive diagnostic: hand solverkit's VALIDATOR the TRUE pose and measure the
// verify sigma on RAW vs SIP-CORRECTED detections. This isolates "did distortion
// defeat the geometric verify, and does the pre-warp fix it" from generator luck.
//
// The TRUE WCS here is LINEAR (crval,crpix,cd — no SIP). RAW detections are
// distorted, so a linear WCS should verify them poorly; SIP-corrected detections
// live on the undistorted TAN grid, so the SAME linear WCS should verify them
// strongly. crval/cd are used ONLY as a validation probe, never fed to a blind
// solve. Sweeps verify catalog depth (mag<=6 = band-index depth; mag<=9/11 = deep).
//
//   node tools/repro/tess_prewarp_verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWCS } from '../solverkit/ransac.mjs';
import { loadCatalog, cdMetrics, fmt } from '../solverkit/common.mjs';
import { VERIFY_NET } from '../solverkit/contract.mjs';

const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'test_results/tess_sip_prewarp_2026-07-11');
const hdr = JSON.parse(fs.readFileSync(path.join(DIR, 'tess_sip_header.json'), 'utf8'));
const CRVAL = hdr._validation_only.crval_deg, CD = hdr._validation_only.cd, CRPIX = hdr.crpix;

const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).detections
    .map((d) => ({ x: d.x, y: d.y, flux: d.flux, fwhm: d.fwhm }));
const raw = load('tess_raw_fits.app.json');
const cor = load('tess_corrected.app.json');
const W = hdr.naxis[0], H = hdr.naxis[1];

// TRUE linear WCS in solverkit convention (crpix shared FITS 1-based frame w/ dets)
const trueWcs = { crval: [CRVAL[0], CRVAL[1]], crpix: [CRPIX[0], CRPIX[1]], cd: CD };
const m = cdMetrics(CD);
console.log(`TRUE linear WCS: crval=[${CRVAL.map((v) => v.toFixed(4)).join(',')}] scale=${m.scale.toFixed(2)}"/px rot=${m.rotation.toFixed(1)} parity=${m.parity}`);
console.log(`RAW dets=${raw.length}  CORRECTED dets=${cor.length}  frame ${W}x${H}\n`);

const results = {};
for (const mag of [6, 9, 11]) {
    const fovR = (Math.hypot(W, H) / 2) * m.scale / 3600 + 2;
    const { stars } = loadCatalog({ raDeg: CRVAL[0], decDeg: CRVAL[1], radiusDeg: fovR, magLimit: mag });
    const opts = { w: W, h: H, tolBasePx: 8, tolSlope: VERIFY_NET.WIDE_NET_SLOPE, inlierTolPx: 12, nullK: 128 };
    const vr = validateWCS(trueWcs, raw, stars, opts);
    const vc = validateWCS(trueWcs, cor, stars, opts);
    console.log(`── verify catalog mag<=${mag} (${stars.length} stars in field) ──`);
    console.log(`  RAW       : matched=${String(vr.inliers).padStart(3)}  sigma=${fmt(vr.sigma, 1).padStart(6)}  (null ${fmt(vr.nullMean, 1)}±${fmt(vr.nullStd, 1)})  accepted=${vr.accepted}`);
    console.log(`  CORRECTED : matched=${String(vc.inliers).padStart(3)}  sigma=${fmt(vc.sigma, 1).padStart(6)}  (null ${fmt(vc.nullMean, 1)}±${fmt(vc.nullStd, 1)})  accepted=${vc.accepted}  [GATE: σ≥5 & inliers≥8]`);
    results[`mag${mag}`] = {
        catalog_stars: stars.length,
        raw: { matched: vr.inliers, sigma: vr.sigma, accepted: vr.accepted },
        corrected: { matched: vc.inliers, sigma: vc.sigma, accepted: vc.accepted },
    };
}
fs.writeFileSync(path.join(DIR, 'prewarp_verify_at_truth.json'), JSON.stringify({
    generated: '2026-07-11', probe: 'TRUE linear WCS handed to validator (validation only)',
    true_scale_arcsec_px: m.scale, gate: { z: 5.0, min_inliers: 8 }, results,
}, null, 2));
console.log(`\nwrote prewarp_verify_at_truth.json`);
