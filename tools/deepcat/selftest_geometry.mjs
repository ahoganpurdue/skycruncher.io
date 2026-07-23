// ═══════════════════════════════════════════════════════════════════════════
// DEEPCAT — geometry SIGN/DIRECTION self-test (acceptance gate for the ladder)
// ═══════════════════════════════════════════════════════════════════════════
// The forced-photometry depth study only means anything if projecting a catalog
// position THROUGH the fitted distortion moves the prediction TOWARD the detected
// star, not away from it. This exercises projectStarsGeom on a receipt's OWN
// matched_stars (catalog ra/dec vs the detected pixel the solver locked).
//
// WHAT THE FIT ACTUALLY TARGETED (learned the hard way, 2026-07-09): the engine
// fits SIP/TPS to  dx = detected − skyToLinearPixel(catalog)  over ONLY the
// REFINABLE matches (residual_arcsec < 999, non-planet). It does NOT fit the
// stored matched_stars.dx_px (that is the solver's verifier residual, a different
// quantity for UW solves). So the honest SIGN test compares the ladder against the
// LINEAR arm on the REFINABLE set — the exact domain the coefficients were fit in.
//
// FINDINGS THIS GATE ENCODES (evidence, not opinion):
//   • SIGN is correct — SIP reduces the refinable-set RMS (hard-asserted here).
//   • The matched residual is OUTLIER-dominated scatter, not smooth distortion, so
//     the SIP gain is SMALL in aggregate but unmistakable on clean high-distortion
//     edge stars (reported, not gated).
//   • TPS INTERPOLATES its ~100 knots (in-sample rms_after is tiny) but OVERFITS
//     out-of-sample — it can be worse than SIP on non-knot stars. Reported with a
//     WARN, never hard-failed: preferring TPS blindly is not evidence-supported.
//
// A SIP RISE (not fall) means the internal-convention sign is applied backwards —
// STOP and re-read src/engine/pipeline/export/sip_convention.ts. Exit non-zero
// only on a SIP sign violation.
//
// Usage: node tools/deepcat/selftest_geometry.mjs [--receipt <path>]
import fs from 'node:fs';
import path from 'node:path';
import { projectStarsGeom } from '../psf/forced_detect.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const RECEIPTS = arg('--receipt', null)
    ? [arg('--receipt', null)]
    : ['test_results/deep_cones/m66.receipt.json', 'test_results/deep_cones/cr2.receipt.json']
        .filter((p) => fs.existsSync(path.join(ROOT, p)));

// RMS (px→arcsec) of detected−projected over a star set, for one geometry tier.
function rmsFor({ stars, wcs, astrometry, geometry, pxScale }) {
    const { projected, geometry: tier, convergence } = projectStarsGeom({
        stars, wcs, astrometry, geometry, w: 1e9, h: 1e9, margin: -1e9,
    });
    let s = 0, n = 0, worst = 0;
    const abs = [];
    for (const p of projected) {
        const r2 = (p.x - p.x_det) ** 2 + (p.y - p.y_det) ** 2;
        s += r2; if (r2 > worst) worst = r2; abs.push(Math.sqrt(r2)); n++;
    }
    abs.sort((a, b) => a - b);
    return {
        tier, n, rmsArcsec: Math.sqrt(s / n) * pxScale,
        medArcsec: (abs[abs.length >> 1] || 0) * pxScale,
        worstArcsec: Math.sqrt(worst) * pxScale, convergence,
    };
}

let sipViolations = 0;
for (const rel of RECEIPTS) {
    const R = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const wc = R.wcs;
    const wcs = { crval: [wc.CRVAL1, wc.CRVAL2], crpix: [wc.CRPIX1, wc.CRPIX2], cd: [[wc.CD1_1, wc.CD1_2], [wc.CD2_1, wc.CD2_2]] };
    const astrometry = R.solution?.astrometry ?? null;
    const pxScale = R.solution?.pixel_scale ?? 1;
    const hasSip = !!(astrometry?.sip && Array.isArray(astrometry.sip.a));
    const hasTps = !!(astrometry?.tps && Array.isArray(astrometry.tps?.control_points) && astrometry.tps.control_points.length);

    // REFINABLE = the exact set the fit used (residual < 999, non-planet).
    const refinable = (R.solution?.matched_stars ?? []).filter(
        (m) => Number.isFinite(m.ra_deg) && Number.isFinite(m.dec_deg) && Number.isFinite(m.x) && Number.isFinite(m.y)
            && Number.isFinite(m.residual_arcsec) && m.residual_arcsec < 999 && !String(m.gaia_id || '').startsWith('planet_'),
    );
    const stars = refinable.map((m) => ({ ra_deg: m.ra_deg, dec_deg: m.dec_deg, x_det: m.x, y_det: m.y }));

    const lin = rmsFor({ stars, wcs, astrometry, geometry: 'linear', pxScale });
    const sip = hasSip ? rmsFor({ stars, wcs, astrometry, geometry: 'sip', pxScale }) : null;
    const tps = hasTps ? rmsFor({ stars, wcs, astrometry, geometry: 'tps', pxScale }) : null;

    console.log(`\n=== ${rel} ===`);
    console.log(`schema=${R.version}  refinable=${stars.length}  pxScale=${pxScale.toFixed(3)}"/px  sip=${hasSip} tps=${hasTps}`);
    console.log(`  linear  rms=${lin.rmsArcsec.toFixed(1)}"  median=${lin.medArcsec.toFixed(1)}"  worst=${lin.worstArcsec.toFixed(0)}"`);
    if (sip) console.log(`  sip     rms=${sip.rmsArcsec.toFixed(1)}"  median=${sip.medArcsec.toFixed(1)}"  worst=${sip.worstArcsec.toFixed(0)}"  iters<=${sip.convergence.maxIters} convFail=${sip.convergence.failures}`);
    if (tps) console.log(`  tps     rms=${tps.rmsArcsec.toFixed(1)}"  median=${tps.medArcsec.toFixed(1)}"  worst=${tps.worstArcsec.toFixed(0)}"  iters<=${tps.convergence.maxIters} convFail=${tps.convergence.failures}`);

    // ── SIP sign gate (hard) ──
    if (sip) {
        if (sip.rmsArcsec < lin.rmsArcsec) console.log(`  ✓ SIP reduces refinable-set RMS (sign correct; ${(lin.rmsArcsec - sip.rmsArcsec).toFixed(2)}" tighter)`);
        else { console.error(`  ✗ FAIL: SIP RMS ${sip.rmsArcsec.toFixed(1)}" ≥ linear ${lin.rmsArcsec.toFixed(1)}" — sign backwards?`); sipViolations++; }
    }
    // ── TPS report (soft; overfit is expected, not a failure) ──
    if (tps) {
        if (tps.rmsArcsec <= lin.rmsArcsec) console.log(`  ✓ TPS reduces refinable-set RMS`);
        else console.log(`  ⚠ TPS RMS ${tps.rmsArcsec.toFixed(1)}" > linear ${lin.rmsArcsec.toFixed(1)}" — knot OVERFIT (in-sample rms_after ${astrometry.tps.rms_after_arcsec?.toFixed(2)}" does not generalize); SIP-preferred for reprojection.`);
    }
}

if (!RECEIPTS.length) { console.error('no receipts found — run: npx vitest run -c tools/deepcat/emit.config.ts'); process.exit(3); }
console.log(`\n${sipViolations ? `SELFTEST FAILED (${sipViolations} SIP sign violation(s))` : 'SELFTEST PASSED — SIP sign correct (reduces residuals on the fit domain)'}`);
process.exit(sipViolations ? 1 : 0);
