// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — catalog-forced deep detection (CATALOG_FORCED tier)
// ═══════════════════════════════════════════════════════════════════════════
// Blind detection asks "where are the stars?"; forced detection asks "the
// catalog says a star is HERE — how much flux is at that exact position?"
// Fixing the position removes the position-search trials penalty, so a
// far lower significance bar (~2 sigma) is honest: the hypothesis was
// formed BEFORE looking at the pixels.
//
// REUSABLE BY DESIGN: the same primitive is the plate solver's sub-threshold
// candidate verification amplifier (given a hypothesized WCS, forced
// photometry at catalog positions turns N faint coincidences into a joint
// detection statistic). Nothing in here knows about measure_and_clean.
//
// Provenance: every forced measurement is tagged CATALOG_FORCED — these are
// aperture flux measurements at catalog-predicted positions, NEVER blind
// discoveries, and downstream consumers must not launder them into one.
//
// MATH (documented per owner law: coordinate work and pixel work separate):
//   position lane: catalog (ra,dec) -> gnomonic TAN about crval -> CD^-1 ->
//     rectilinear pixel -> optional Brown-Conrady toNative() -> native pixel.
//   pixel lane: matched-aperture photometry on the native grid —
//     aperture radius r_ap = max(2, 0.68*FWHM, 1.2*posRms) px
//       (0.68*FWHM maximizes SNR for a Gaussian PSF; the posRms term keeps
//        the aperture from missing the star when the astrometric model
//        itself carries pixel-scale error — wider aperture = honest SNR
//        loss, never a recentering step that would bias faint fluxes up)
//     background = sigma-clipped median of annulus [r_ap+3, r_ap+8] (widened
//       until >= 40 px), local so nebulosity/gradients cancel
//     flux = sum(aperture) - n_ap * bg_median
//     noise = sigma_local * sqrt(n_ap + n_ap^2 / n_ann)   [aperture noise +
//       background-estimate noise propagated through the subtraction]
//     snr = flux / noise; accepted at snr >= threshold (default 2)

import fs from 'node:fs';
import path from 'node:path';
// Canonical TPS forward evaluator (pure, Math-only leaf — ZERO transitive engine/
// wasm imports). Shared so the tools lane evaluates the receipt's tabular spline
// with the IDENTICAL kernel the engine fitter/ASDF writer use (LAW 4: one impl).
// Node 24 strips the .ts on import; vite resolves it natively.
import { evalTpsField } from '../../src/engine/pipeline/m6_plate_solve/tps_eval.ts';

const D2R = Math.PI / 180;

// ── atlas loading (same discriminators as tools/corpus/run_corpus.mjs) ──────

// Atlas rows come in TWO shapes (level_3 sector files mix both): Gaia rows
// (mag_g/source_id) store ra in DEGREES; HYG rows (mag/spect) store ra in
// HOURS. Parsing HYG hours as degrees scatters every bright star ~150 deg.
const normRow = (s) => (s.mag_g !== undefined || s.source_id !== undefined)
    ? { ra_deg: s.ra, dec_deg: s.dec, mag: s.mag_g ?? 99, bp_rp: s.bp_rp ?? null, gaia_id: s.source_id ? `Gaia_${s.source_id}` : null }
    : { ra_deg: s.ra * 15, dec_deg: s.dec, mag: s.mag ?? 99, bp_rp: null, gaia_id: s.id != null ? `HYG_${s.id}` : null };

export function angSepDeg(ra1, dec1, ra2, dec2) {
    const a1 = ra1 * D2R, a2 = ra2 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2))) / D2R;
}

/** 6x6 sector id (30 deg dec bands x 4h RA slices) — mirrors run_corpus. */
export const sectorId = (raH, dec) =>
    Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30)) * 6
    + Math.min(5, Math.floor(((raH % 24) + 24) % 24 / 4));

/**
 * Approximate min angular separation between a point and a lat-lon sector
 * rectangle: clamp the point into the rectangle (circular in RA) and take
 * the separation to the clamped point. Exact when the point is inside
 * (returns 0); near-exact elsewhere at these sector sizes — the caller's
 * +3 deg margin absorbs the spherical-rectangle corner error.
 */
function rectMinSepDeg(raDeg, decDeg, ra0, ra1, dec0, dec1) {
    const ra = ((raDeg % 360) + 360) % 360;
    let raC;
    if (ra >= ra0 && ra <= ra1) raC = ra;
    else {
        const d0 = Math.min(Math.abs(ra - ra0), 360 - Math.abs(ra - ra0));
        const d1 = Math.min(Math.abs(ra - ra1), 360 - Math.abs(ra - ra1));
        raC = d0 <= d1 ? ra0 : ra1;
    }
    const decC = Math.max(dec0, Math.min(dec1, decDeg));
    return angSepDeg(ra, decDeg, raC, decC);
}

/**
 * Load every atlas star within radiusDeg of (raDeg, decDeg), mag <= magLimit.
 * Sector selection = clamped-point distance to each sector rectangle (an
 * early 3x3 boundary-sampling version famously excluded the sector the
 * target itself sat in). L1/L2 (bright anchors/pattern) always load.
 */
export function loadAtlasRegion({ root, raDeg, decDeg, radiusDeg, magLimit = Infinity }) {
    const atlasDir = path.join(root, 'public', 'atlas');
    const rows = [];
    for (const f of ['level_1_anchors.json', 'level_2_pattern.json']) {
        const p = path.join(atlasDir, f);
        if (fs.existsSync(p)) rows.push(...JSON.parse(fs.readFileSync(p, 'utf8')).map(normRow));
    }
    const sectorsLoaded = [];
    for (let band = 0; band < 6; band++) {
        for (let slice = 0; slice < 6; slice++) {
            const id = band * 6 + slice;
            const dec0 = -90 + band * 30, dec1 = dec0 + 30;
            const ra0 = slice * 60, ra1 = ra0 + 60; // deg
            let minSep = rectMinSepDeg(raDeg, decDeg, ra0, ra1, dec0, dec1);
            // polar caps: a band touching a pole is inside any circle over it
            if (band === 0 && decDeg - radiusDeg <= -60) minSep = 0;
            if (band === 5 && decDeg + radiusDeg >= 60) minSep = 0;
            if (minSep > radiusDeg + 3) continue;
            const p = path.join(atlasDir, 'sectors', `level_3_sector_${id}.json`);
            if (!fs.existsSync(p)) continue;
            sectorsLoaded.push(id);
            for (const raw of JSON.parse(fs.readFileSync(p, 'utf8'))) {
                const s = normRow(raw);
                if (s.mag <= magLimit) rows.push(s);
            }
        }
    }
    // radius + magnitude filter + dedupe (L1/L2 stars repeat in sectors)
    const seen = new Set();
    const stars = [];
    for (const s of rows) {
        if (s.mag > magLimit) continue;
        if (angSepDeg(s.ra_deg, s.dec_deg, raDeg, decDeg) > radiusDeg) continue;
        const key = s.gaia_id ?? `${s.ra_deg.toFixed(5)}_${s.dec_deg.toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stars.push(s);
    }
    return { stars, sectorsLoaded };
}

// ── projection (coordinate lane only — no pixels touched) ───────────────────

/** Gnomonic TAN forward: (ra,dec) deg -> standard coords (deg), null behind. */
export function tanForward(raDeg, decDeg, ra0Deg, dec0Deg) {
    const a = raDeg * D2R, a0 = ra0Deg * D2R, d = decDeg * D2R, d0 = dec0Deg * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    if (c <= 1e-9) return null;
    return {
        xi: Math.cos(d) * Math.sin(a - a0) / c / D2R,
        eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R,
    };
}

/**
 * Project catalog stars into NATIVE pixel space:
 * TAN through the linear WCS gives the rectilinear position; the optional
 * coordFn (Brown-Conrady from corrections.mjs) then maps corrected -> native
 * via toNative(). Returns in-frame stars with pixel positions attached.
 */
export function projectStars({ stars, wcs, coordFn = null, w, h, margin = 10 }) {
    const [[c11, c12], [c21, c22]] = wcs.cd;
    const det = c11 * c22 - c12 * c21;
    if (Math.abs(det) < 1e-18) throw new Error('degenerate CD matrix');
    const out = [];
    const pt = [0, 0];
    for (const s of stars) {
        const p = tanForward(s.ra_deg, s.dec_deg, wcs.crval[0], wcs.crval[1]);
        if (!p) continue;
        let x = wcs.crpix[0] + (c22 * p.xi - c12 * p.eta) / det;
        let y = wcs.crpix[1] + (-c21 * p.xi + c11 * p.eta) / det;
        if (coordFn) { coordFn.toNative(x, y, pt); x = pt[0]; y = pt[1]; }
        if (x < margin || y < margin || x >= w - margin || y >= h - margin) continue;
        out.push({ ...s, x, y });
    }
    return out;
}

// ── fitted-distortion forward (SIP / TPS) — the export-boundary bug is fixed ────
// The receipt's distortion blocks are stored in the ENGINE-INTERNAL convention (1)
// (src/engine/pipeline/export/sip_convention.ts): the polynomial/spline value IS
// the OBSERVED − IDEAL pixel displacement, evaluated at u,v = detected − crpix.
// (FITS-standard export negates this — that negation is EXPORT-ONLY and is NOT
// applied here; we consume the internal receipt block directly.) To go the
// forward direction catalog→detected we solve  obs = ideal + D(obs − crpix)  by
// fixed-point iteration (D converges in 2–4 steps for our fields).

/** Evaluate a SIP coefficient matrix  Σ_{p,q} a[p][q]·u^p·v^q  (internal
 *  convention (1): the value is the OBSERVED−IDEAL pixel offset). u,v are RAW
 *  pixel offsets from crpix (NOT normalized — SIP is unnormalized by construction). */
export function sipPoly(coef, u, v) {
    if (!Array.isArray(coef)) return 0;
    let s = 0;
    let up = 1; // u^p
    for (let p = 0; p < coef.length; p++) {
        const row = coef[p];
        if (Array.isArray(row)) {
            let vq = 1; // v^q
            for (let q = 0; q < row.length; q++) {
                const c = row[q];
                if (c) s += c * up * vq;
                vq *= v;
            }
        }
        up *= u;
    }
    return s;
}

/** Forward SIP: map an IDEAL (linear-WCS) pixel to the DETECTED pixel via
 *  obs = ideal + A_internal(obs − crpix) fixed-point. crpix is the linear-WCS
 *  reference pixel the SIP was fit against (engine 0-based). Returns
 *  { x, y, iters, converged }. */
export function sipForward(sip, crpix, xIdeal, yIdeal, { maxIter = 8, tol = 0.01 } = {}) {
    let ox = xIdeal, oy = yIdeal, converged = false, iters = 0;
    for (let it = 0; it < maxIter; it++) {
        const u = ox - crpix[0], v = oy - crpix[1];
        const nx = xIdeal + sipPoly(sip.a, u, v);
        const ny = yIdeal + sipPoly(sip.b, u, v);
        iters = it + 1;
        const done = Math.abs(nx - ox) < tol && Math.abs(ny - oy) < tol;
        ox = nx; oy = ny;
        if (done) { converged = true; break; }
    }
    return { x: ox, y: oy, iters, converged };
}

/** Forward TPS: same fixed-point using the shared engine evaluator on NORMALIZED
 *  offsets  p̃ = (pixel − tps.crpix)/tps.scale. Convention (1) by construction
 *  (tps_fitter.ts). Returns { x, y, iters, converged }. */
export function tpsForward(tps, xIdeal, yIdeal, { maxIter = 8, tol = 0.01 } = {}) {
    const un = tps.control_points.map((c) => c[0]);
    const vn = tps.control_points.map((c) => c[1]);
    const cx = tps.crpix[0], cy = tps.crpix[1], sc = tps.scale;
    let ox = xIdeal, oy = yIdeal, converged = false, iters = 0;
    for (let it = 0; it < maxIter; it++) {
        const u = (ox - cx) / sc, v = (oy - cy) / sc;
        const nx = xIdeal + evalTpsField(u, v, un, vn, tps.weights_x, tps.affine.dx);
        const ny = yIdeal + evalTpsField(u, v, un, vn, tps.weights_y, tps.affine.dy);
        iters = it + 1;
        const done = Math.abs(nx - ox) < tol && Math.abs(ny - oy) < tol;
        ox = nx; oy = ny;
        if (done) { converged = true; break; }
    }
    return { x: ox, y: oy, iters, converged };
}

/**
 * Project catalog stars into NATIVE pixel space through the fitted-distortion
 * LADDER: TPS (if present) > SIP (if present) > linear. `astrometry` is
 * receipt.solution.astrometry ({ sip?, tps? }). `geometry` selects the tier:
 *   'auto'   walk the ladder (TPS→SIP→linear),
 *   'tps'    TPS if present else fall back down the ladder,
 *   'sip'    SIP if present else linear,
 *   'linear' force the linear WCS (reproducible baseline arm).
 * Returns { projected, geometry, convergence } — `geometry` RECORDS the tier
 * actually used (honest labeling; never claims a tier the receipt cannot supply).
 * `projected` is the same shape projectStars returns ({ ...star, x, y }) so it is
 * a drop-in for forcedMeasure.
 */
export function projectStarsGeom({ stars, wcs, astrometry = null, geometry = 'auto', w, h, margin = 10 }) {
    const [[c11, c12], [c21, c22]] = wcs.cd;
    const det = c11 * c22 - c12 * c21;
    if (Math.abs(det) < 1e-18) throw new Error('degenerate CD matrix');

    const sip = astrometry && astrometry.sip && Array.isArray(astrometry.sip.a) ? astrometry.sip : null;
    const tps = astrometry && astrometry.tps && Array.isArray(astrometry.tps.control_points)
        && astrometry.tps.control_points.length ? astrometry.tps : null;

    // Resolve the tier honestly against what the receipt actually carries.
    let tier;
    if (geometry === 'linear') tier = 'linear';
    else if (geometry === 'sip') tier = sip ? 'sip' : 'linear';
    else if (geometry === 'tps') tier = tps ? 'tps' : (sip ? 'sip' : 'linear');
    else tier = tps ? 'tps' : (sip ? 'sip' : 'linear'); // auto

    const out = [];
    let convFailures = 0, maxIters = 0;
    for (const s of stars) {
        const p = tanForward(s.ra_deg, s.dec_deg, wcs.crval[0], wcs.crval[1]);
        if (!p) continue;
        // IDEAL (linear-WCS) pixel — the CD^-1 image of the gnomonic position.
        const xi = wcs.crpix[0] + (c22 * p.xi - c12 * p.eta) / det;
        const yi = wcs.crpix[1] + (-c21 * p.xi + c11 * p.eta) / det;
        let x = xi, y = yi;
        if (tier === 'sip') {
            const r = sipForward(sip, wcs.crpix, xi, yi);
            x = r.x; y = r.y; if (!r.converged) convFailures++; if (r.iters > maxIters) maxIters = r.iters;
        } else if (tier === 'tps') {
            const r = tpsForward(tps, xi, yi);
            x = r.x; y = r.y; if (!r.converged) convFailures++; if (r.iters > maxIters) maxIters = r.iters;
        }
        if (x < margin || y < margin || x >= w - margin || y >= h - margin) continue;
        out.push({ ...s, x, y });
    }
    return {
        projected: out,
        geometry: tier,
        convergence: { failures: convFailures, maxIters, sipPresent: !!sip, tpsPresent: !!tps },
    };
}

// ── forced aperture photometry (pixel lane, native grid) ────────────────────

/**
 * Matched-aperture forced photometry at FIXED positions (no recentering —
 * see header). L = background-flattened luminance.
 * Returns one entry per position:
 *   { x, y, mag, gaia_id, bp_rp, flux, snr, n_ap, bg, sigma_local,
 *     accepted, provenance: 'CATALOG_FORCED' }
 */
export function forcedMeasure({ L, w, h, positions, fwhmPx, posRmsPx = 0, snrThreshold = 2, sigmaPix = null }) {
    const rAp = Math.max(2, 0.68 * fwhmPx, 1.2 * posRmsPx);
    const rIn0 = rAp + 3;
    const out = [];
    for (const p of positions) {
        const cx = Math.round(p.x), cy = Math.round(p.y);
        // aperture sum
        const RA = Math.ceil(rAp);
        if (cx < RA + 1 || cy < RA + 1 || cx >= w - RA - 1 || cy >= h - RA - 1) continue;
        let apSum = 0, nAp = 0;
        for (let dy = -RA; dy <= RA; dy++) {
            for (let dx = -RA; dx <= RA; dx++) {
                if (dx * dx + dy * dy > rAp * rAp) continue;
                apSum += L[(cy + dy) * w + cx + dx];
                nAp++;
            }
        }
        // annulus, widened until >= 40 px inside the frame
        let rIn = rIn0, rOut = rIn0 + 5;
        let ann = [];
        for (let tries = 0; tries < 3; tries++) {
            ann.length = 0;
            const RO = Math.ceil(rOut);
            for (let dy = -RO; dy <= RO; dy++) {
                const Y = cy + dy;
                if (Y < 0 || Y >= h) continue;
                for (let dx = -RO; dx <= RO; dx++) {
                    const X = cx + dx;
                    if (X < 0 || X >= w) continue;
                    const r2 = dx * dx + dy * dy;
                    if (r2 < rIn * rIn || r2 > rOut * rOut) continue;
                    ann.push(L[Y * w + X]);
                }
            }
            if (ann.length >= 40) break;
            rOut += 3;
        }
        if (ann.length < 12) continue;
        // sigma-clipped background (median/MAD, one clip round)
        ann.sort((a, b) => a - b);
        let med = ann[ann.length >> 1];
        let dev = ann.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
        let sig = 1.4826 * dev[dev.length >> 1];
        const kept = ann.filter((v) => Math.abs(v - med) <= 3 * sig);
        if (kept.length >= 12) {
            med = kept[kept.length >> 1];
            dev = kept.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
            sig = 1.4826 * dev[dev.length >> 1];
        }
        const sigmaLocal = Math.max(sig, sigmaPix != null ? 0.5 * sigmaPix : 0, 1e-9);
        // STRUCTURED-BACKGROUND GUARD (same law as the render stage): a
        // 2-sigma flux claim assumes the annulus is noise-like sky. Terrain,
        // foliage and nebular filaments make "flux above annulus" trivially
        // true — such positions are marked structured and never accepted.
        const structured = sigmaPix != null && sig > 3 * sigmaPix;
        const flux = apSum - nAp * med;
        const noise = sigmaLocal * Math.sqrt(nAp + (nAp * nAp) / kept.length);
        const snr = flux / noise;
        out.push({
            x: p.x, y: p.y, mag: p.mag ?? null, gaia_id: p.gaia_id ?? null, bp_rp: p.bp_rp ?? null,
            flux, snr, n_ap: nAp, bg: med, sigma_local: sigmaLocal,
            structured,
            accepted: !structured && snr >= snrThreshold,
            provenance: 'CATALOG_FORCED',
        });
    }
    return { rApPx: rAp, results: out };
}

// ── recovery statistics / limiting magnitude ─────────────────────────────────

/**
 * Recovery fraction per magnitude bin over entries [{mag, recovered:bool}].
 * Limiting magnitude follows the survey m50 convention — the LAST 50%
 * crossing approached from the faint side: the faintest bin (>= minPerBin
 * entries) whose recovery fraction still clears 0.5. Bright-end dropouts
 * (horizon-occluded bright stars, saturated blobs) then cannot censor the
 * whole curve — an early bright-first version reported "limiting mag 3" on
 * a horizon frame because one 1-of-5 occluded bin broke its scan while
 * recovery genuinely held >= 50% out to mag 7.5.
 * Censoring honesty: when the FAINTEST qualified bin itself clears 0.5 the
 * limit is only a lower bound (the catalog ran out before the frame did).
 */
export function recoveryByMagnitude(entries, { binWidth = 0.5, minPerBin = 5 } = {}) {
    const withMag = entries.filter((e) => Number.isFinite(e.mag));
    if (!withMag.length) return { bins: [], limitingMag: null, censored: null };
    const binOf = (m) => Math.floor(m / binWidth) * binWidth;
    const map = new Map();
    for (const e of withMag) {
        const b = binOf(e.mag);
        let s = map.get(b);
        if (!s) { s = { magLo: b, magHi: b + binWidth, probed: 0, recovered: 0 }; map.set(b, s); }
        s.probed++;
        if (e.recovered) s.recovered++;
    }
    const bins = [...map.values()].sort((a, b) => a.magLo - b.magLo)
        .map((b) => ({ ...b, fraction: +(b.recovered / b.probed).toFixed(3) }));
    let limitingMag = null;
    for (let i = bins.length - 1; i >= 0; i--) { // faint -> bright
        const b = bins[i];
        if (b.probed < minPerBin) continue;
        if (b.fraction >= 0.5) { limitingMag = b.magHi; break; }
    }
    const lastQualified = [...bins].reverse().find((b) => b.probed >= minPerBin);
    const censored = limitingMag != null && lastQualified != null && lastQualified.magHi === limitingMag;
    return { bins, limitingMag, censored };
}
