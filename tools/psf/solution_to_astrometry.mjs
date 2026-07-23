// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — plate-solve receipt -> measured astrometry JSON (solve socket)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/psf/solution_to_astrometry.mjs --in <receipt.json | summary.json>
//        [--out <astrometry.json>]     default: <in_dir>/astrometry.json
//        [--width W --height H]        required only for scalar summary input
//
// Closes the loop between the wizard plate solver and the PSF cleanup lane:
// reads the exported AstroPacket receipt (v2.x — the JSON the step-7 export
// downloads) or an e2e summary.json session snapshot, and emits the
// --astrometry JSON documented in tools/psf/corrections.mjs
// (SOLVE_SOCKET_CONTRACT):
//
//   {
//     wcs:        { crpix: [x, y], crval: [ra_deg, dec_deg], cd: [[..],[..]] },
//     distortion: { model: "brown-conrady" | "none", k1, k2,
//                   controlPoints: [{x, y, dx, dy}], fit: {...} },
//     psf_anchors: [{ x, y, ra, dec, mag, bp_rp, gaia_id }]
//   }
//
// UNIT LAND MINES (this codebase):
//   - the engine-internal fitted WCS (solution.wcs) stores crval[0] in HOURS;
//     the packet-level FITS-style `wcs` block stores CRVAL1 in DEGREES
//     (orchestrator_session.generateWCS multiplies by 15). This tool emits
//     DEGREES, per the socket contract.
//   - packet matched_stars carry catalog ra_deg/dec_deg (degrees); internal
//     MatchedStar.catalog rows may instead carry ra_hours/dec_degrees (and
//     `ra` in degrees — the exportPacket mapping `ra_deg: m.catalog.ra` pins
//     that). Both shapes are handled explicitly, no guessing.
//   - `bv` on packet matched stars is Gaia BP-RP mapped through
//     color_index_BV (see star_catalog_adapter.ts) — it is NOT Johnson B-V.
//     It is therefore emitted as `bp_rp` on psf_anchors, extending the
//     documented contract additively.
//
// DISTORTION FIT (Brown-Conrady, radial, about the FRAME CENTER — matching
// the corrections.mjs assumption, NOT about crpix):
//
//   The TAN projection of the catalog through the fitted linear WCS gives
//   the rectilinear ("corrected") pixel position of each matched star; the
//   detector measured the distorted ("native") position. With radii
//   normalized to the half-diagonal hd:
//
//       r_u = |projected - center| / hd      (undistorted / corrected)
//       r_d = |detected  - center| / hd      (distorted / native)
//
//   Brown-Conrady:  r_d = r_u * (1 + k1 r_u^2 + k2 r_u^4)
//   Radial residual: delta = r_d - r_u = k1 r_u^3 + k2 r_u^5
//
//   BUT the linear CD matrix was itself least-squares fitted to the
//   DISTORTED star positions, so it has already absorbed the mean radial
//   slope of the distortion into the plate scale. Fitting delta on
//   [r^3, r^5] alone would bias k1. We therefore fit
//
//       delta = a*r + k1*r^3 + k2*r^5
//
//   where the linear term `a` soaks up that scale absorption (a pure radial
//   scale change is degenerate with the WCS pixel scale — it is NOT a warp)
//   and only k1/k2 are exported. One 3-sigma reclip rejects mismatched
//   pairs. Tangential residuals (which a radial model cannot represent) are
//   measured and reported honestly, never fitted.
//
//   With < 20 pairs the fit is statistically meaningless for a 3-parameter
//   radial model on noisy centroids — model "none" is emitted honestly.

import fs from 'node:fs';
import path from 'node:path';

const D2R = Math.PI / 180;

// ── math primitives ─────────────────────────────────────────────────────────

/** Gnomonic (TAN) forward projection: (ra,dec) deg -> standard coords (deg). */
export function gnomonicForward(raDeg, decDeg, ra0Deg, dec0Deg) {
    const a = raDeg * D2R, a0 = ra0Deg * D2R, d = decDeg * D2R, d0 = dec0Deg * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    if (c <= 1e-9) return null; // behind the tangent plane
    return {
        xi: Math.cos(d) * Math.sin(a - a0) / c / D2R,
        eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R,
    };
}

/** Sky (deg) -> pixel through a linear TAN WCS {crpix, crval(deg), cd}. */
export function skyToPixel(raDeg, decDeg, wcs) {
    const p = gnomonicForward(raDeg, decDeg, wcs.crval[0], wcs.crval[1]);
    if (!p) return null;
    const [[c11, c12], [c21, c22]] = wcs.cd;
    const det = c11 * c22 - c12 * c21;
    if (Math.abs(det) < 1e-18) return null;
    // [xi, eta] = CD * (pix - crpix)  =>  pix = crpix + CD^-1 * [xi, eta]
    return {
        x: wcs.crpix[0] + (c22 * p.xi - c12 * p.eta) / det,
        y: wcs.crpix[1] + (-c21 * p.xi + c11 * p.eta) / det,
    };
}

/**
 * Least-squares fit of delta = sum_j coef_j * r^powers[j] with two 3-sigma
 * reclip rounds (matched pairs have heavy-tailed mismatch outliers).
 * rs/deltas in NORMALIZED radius units. Returns {coef, used, rms} with rms
 * of the post-fit residual (normalized units) or null when degenerate.
 * Normal equations solved by Gaussian elimination with partial pivoting
 * (k <= 3 here, conditioning is fine at these sizes).
 */
export function fitRadialOdd(rs, deltas, powers = [1, 3, 5]) {
    const n = rs.length, k = powers.length;
    let use = new Uint8Array(n).fill(1);
    let coef = null, rms = null, used = n;
    const evalModel = (c, r) => { let s = 0; for (let j = 0; j < k; j++) s += c[j] * Math.pow(r, powers[j]); return s; };
    for (let pass = 0; pass < 3; pass++) {
        // build normal equations  (X^T X) coef = X^T d
        const A = Array.from({ length: k }, () => new Float64Array(k));
        const b = new Float64Array(k);
        let m = 0;
        for (let i = 0; i < n; i++) {
            if (!use[i]) continue;
            const basis = powers.map((p) => Math.pow(rs[i], p));
            for (let r = 0; r < k; r++) {
                b[r] += deltas[i] * basis[r];
                for (let c = 0; c < k; c++) A[r][c] += basis[r] * basis[c];
            }
            m++;
        }
        if (m < 2 * k) return null;
        // Gaussian elimination with partial pivoting
        const M = A.map((row, i) => [...row, b[i]]);
        for (let col = 0; col < k; col++) {
            let piv = col;
            for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            if (Math.abs(M[piv][col]) < 1e-16) return null;
            [M[col], M[piv]] = [M[piv], M[col]];
            for (let r = 0; r < k; r++) {
                if (r === col) continue;
                const f = M[r][col] / M[col][col];
                for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c];
            }
        }
        coef = M.map((row, i) => row[k] / row[i]);
        let ss = 0, mm = 0;
        const res = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            res[i] = deltas[i] - evalModel(coef, rs[i]);
            if (use[i]) { ss += res[i] * res[i]; mm++; }
        }
        rms = Math.sqrt(ss / mm);
        used = mm;
        if (pass < 2) {
            const next = new Uint8Array(n);
            let kept = 0;
            for (let i = 0; i < n; i++) { next[i] = Math.abs(res[i]) <= 3 * rms ? 1 : 0; kept += next[i]; }
            if (kept >= 2 * k) use = next; // otherwise keep the un-clipped fit
        }
    }
    return { coef, used, rms };
}

// ── input-shape extraction (packet receipt / session snapshot) ──────────────

/** First finite value among candidates. */
const pick = (...vals) => vals.find((v) => Number.isFinite(v));

/**
 * Extract {wcs (deg), pairs, dims, provenance} from either supported shape.
 * pairs: [{x, y, ra, dec, mag, bp_rp, gaia_id, residual_arcsec}] (ra/dec deg)
 */
export function extractSolution(doc, { argW = null, argH = null } = {}) {
    // shape discovery: packet receipt (v2.x) vs e2e summary.json snapshot
    const isPacket = !!(doc.version && doc.solution);
    const session = doc.finalSession ?? null;
    const sol = isPacket ? doc.solution : session?.solution;
    if (!sol) throw new Error('no solution found: input is neither a packet receipt (version+solution) nor an e2e summary (finalSession.solution)');

    // dims: packet metadata carries width/height; scalar snapshots do not
    const w = pick(doc.metadata?.width, session?.metadata?.width, argW ? +argW : NaN);
    const h = pick(doc.metadata?.height, session?.metadata?.height, argH ? +argH : NaN);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
        throw new Error('image dimensions unavailable in input — pass --width and --height');
    }

    // ── WCS (emit degrees) ──
    let wcs = null, wcsSource = null;
    const fitsBlock = doc.wcs && Number.isFinite(doc.wcs.CRVAL1) ? doc.wcs : null;
    const internal = sol.wcs && Array.isArray(sol.wcs.crval) ? sol.wcs : null;
    if (fitsBlock) {
        // packet-level FITS-style block: CRVAL already degrees
        wcs = {
            crpix: [fitsBlock.CRPIX1, fitsBlock.CRPIX2],
            crval: [fitsBlock.CRVAL1, fitsBlock.CRVAL2],
            cd: [[fitsBlock.CD1_1, fitsBlock.CD1_2], [fitsBlock.CD2_1, fitsBlock.CD2_2]],
        };
        wcsSource = `packet wcs block (SOURCE=${fitsBlock.SOURCE ?? 'unknown'})`;
    } else if (internal) {
        // engine-internal fitted WCS: crval[0] is HOURS (documented convention)
        wcs = {
            crpix: [internal.crpix[0], internal.crpix[1]],
            crval: [internal.crval[0] * 15, internal.crval[1]],
            cd: [[internal.cd[0][0], internal.cd[0][1]], [internal.cd[1][0], internal.cd[1][1]]],
        };
        wcsSource = 'solution.wcs (internal fitted; crval[0] hours -> deg)';
    } else if (Number.isFinite(sol.ra_hours) && Number.isFinite(sol.pixel_scale)) {
        // scalar synthesis — mirrors orchestrator_session.generateWCS fallback
        const scaleDeg = sol.pixel_scale / 3600;
        const rotRad = (sol.roll_degrees ?? sol.rotation ?? 0) * D2R;
        const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
        wcs = {
            crpix: [w / 2, h / 2],
            crval: [sol.ra_hours * 15, sol.dec_degrees],
            cd: [[-scaleDeg * cosR, scaleDeg * sinR], [scaleDeg * sinR, scaleDeg * cosR]],
        };
        wcsSource = 'SYNTHESIZED from scalar solution (no fitted matrix in input)';
    } else {
        throw new Error('no usable WCS: input has neither a wcs block nor scalar ra/dec/scale');
    }

    // ── matched pairs (both shapes; sentinel-filtered like exportPacket) ──
    const rawStars = sol.matched_stars ?? [];
    const pairs = [];
    for (const m of rawStars) {
        // packet shape: flat {x, y, ra_deg, dec_deg, mag, bv, gaia_id}
        // internal shape: {detected:{x,y}, catalog:{ra|ra_hours|ra_deg, ...}}
        const det = m.detected ?? m;
        const cat = m.catalog ?? m;
        const x = pick(det.x, det.rawX), y = pick(det.y, det.rawY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const ra = pick(
            cat.ra_deg,
            Number.isFinite(cat.ra_hours) ? cat.ra_hours * 15 : NaN,
            cat.ra, // exportPacket pins catalog.ra as degrees (`ra_deg: m.catalog.ra`)
        );
        const dec = pick(cat.dec_deg, cat.dec_degrees, cat.dec);
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
        const gaiaId = cat.gaia_id ?? null;
        if (typeof gaiaId === 'string' && gaiaId.startsWith('planet_')) continue;
        // Sentinel filtering, deliberately NARROWER than exportPacket's
        // `residual < 999` stat filter: planetary_verification.ts writes
        // residual_arcsec = 9999 EXACTLY for strobe/hot-pixel rejections and
        // +1000 only onto planet-named rows (excluded above by id). Genuine
        // ultra-wide matches carry residuals of hundreds-to-thousands of
        // arcsec BECAUSE of lens distortion — that is the very signal the
        // radial fit measures, so it must not be pre-filtered; the fit's own
        // 3-sigma reclip handles true mismatches.
        const resid = m.residual_arcsec;
        if (Number.isFinite(resid) && resid >= 9999) continue;
        pairs.push({
            x, y, ra, dec,
            mag: pick(cat.magnitude_V, cat.mag) ?? null,
            // BP-RP: prefer an explicit field; `bv`/`color_index_BV` in this
            // codebase are BP-RP mapped (star_catalog_adapter), NOT Johnson B-V
            bp_rp: pick(cat.bp_rp, cat.bv, cat.color_index_BV) ?? null,
            gaia_id: gaiaId,
            residual_arcsec: Number.isFinite(resid) ? resid : null,
        });
    }

    return {
        wcs, wcsSource, pairs, w, h,
        solutionSummary: {
            ra_hours: sol.ra_hours, dec_degrees: sol.dec_degrees,
            pixel_scale: sol.pixel_scale,
            stars_matched: sol.stars_matched ?? sol.matched ?? rawStars.length,
            mean_residual_arcsec: sol.mean_residual_arcsec ?? null,
            sip_present: !!sol.astrometry?.sip,
        },
    };
}

/** Full conversion: doc -> astrometry socket JSON (pure; no I/O). */
export function convertToAstrometry(doc, opts = {}) {
    const { wcs, wcsSource, pairs, w, h, solutionSummary } = extractSolution(doc, opts);

    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const hd = Math.hypot(cx, cy);

    // project every matched catalog star through the linear WCS
    const rs = [], deltas = [], tangential = [], controlPoints = [];
    let projected = 0;
    for (const p of pairs) {
        const proj = skyToPixel(p.ra, p.dec, wcs);
        if (!proj) continue;
        projected++;
        const ux = proj.x - cx, uy = proj.y - cy;      // corrected (rectilinear)
        const dxn = p.x - cx, dyn = p.y - cy;          // native (distorted)
        const ru = Math.hypot(ux, uy) / hd;
        const rd = Math.hypot(dxn, dyn) / hd;
        rs.push(ru);
        deltas.push(rd - ru);
        // tangential residual: component of (detected - projected) perpendicular
        // to the radial direction at the projected point (px)
        if (ru > 1e-6) {
            const tx = -uy / (ru * hd), ty = ux / (ru * hd); // unit tangent
            tangential.push((p.x - proj.x) * tx + (p.y - proj.y) * ty);
        }
        // raw pair displacement for the future tps path: corrected -> native
        controlPoints.push({
            x: +proj.x.toFixed(3), y: +proj.y.toFixed(3),
            dx: +(p.x - proj.x).toFixed(3), dy: +(p.y - proj.y).toFixed(3),
        });
    }

    const rms = (arr) => arr.length ? Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length) : null;
    const radialRmsBeforePx = rms(deltas.map((d) => d * hd));
    const tangentialRmsPx = rms(tangential);

    // ── Brown-Conrady k1/k2 (see header math) ──
    // MODEL SELECTION BY RADIAL COVERAGE: the r^5 term is pinned by corner
    // stars. When the matched set never reaches r ~ 0.8 (e.g. an ultra-wide
    // blind solve that only verifies central-field stars), a fitted quintic
    // is pure extrapolation outside the sampled disc — an early fit on this
    // corpus produced k2 = -0.66, i.e. a fictitious 1200 px corner warp the
    // consumer would happily apply. Below the coverage bar we fit r^3 only.
    const rMaxSampled = rs.length ? Math.max(...rs) : 0;
    const useQuintic = rMaxSampled >= 0.8;
    let distortion;
    if (projected < 20) {
        distortion = {
            model: 'none', k1: 0, k2: 0,
            controlPoints,
            fit: {
                n_pairs: projected,
                note: `only ${projected} projected pairs — a multi-parameter radial fit on noisy centroids would be numerology; distortion honestly omitted (threshold: 20)`,
            },
        };
    } else {
        const powers = useQuintic ? [1, 3, 5] : [1, 3];
        const fit = fitRadialOdd(rs, deltas, powers);
        if (!fit) {
            distortion = {
                model: 'none', k1: 0, k2: 0, controlPoints,
                fit: { n_pairs: projected, note: 'radial fit degenerate (normal equations singular)' },
            };
        } else {
            const [a, k1, k2 = 0] = fit.coef;
            const shiftAt = (r) => Math.abs(k1 * r * r + k2 * r ** 4) * r * hd;
            distortion = {
                model: 'brown-conrady',
                k1: +k1.toFixed(5),
                k2: +k2.toFixed(5),
                controlPoints,
                fit: {
                    n_pairs: projected,
                    n_used_after_reclip: fit.used,
                    r_normalization: 'half-diagonal',
                    center: 'frame center (assumption shared with corrections.mjs)',
                    model: `delta_r = a*r ${useQuintic ? '+ k1*r^3 + k2*r^5' : '+ k1*r^3'} (normalized radii); a is degenerate with plate scale and NOT exported`,
                    quintic_term: useQuintic ? 'fitted' : `omitted: sampled radius reaches only ${rMaxSampled.toFixed(3)} (< 0.8) — no corner leverage, r^5 would be pure extrapolation`,
                    linear_term_absorbed_a: +a.toFixed(5),
                    r_max_sampled: +rMaxSampled.toFixed(3),
                    radial_rms_before_px: +radialRmsBeforePx.toFixed(3),
                    radial_rms_after_px: +(fit.rms * hd).toFixed(3),
                    tangential_rms_px: tangentialRmsPx != null ? +tangentialRmsPx.toFixed(3) : null,
                    tangential_note: 'tangential residual is OUTSIDE the radial Brown-Conrady model — reported, never fitted',
                    shift_at_r_max_px: +shiftAt(rMaxSampled).toFixed(1),
                    shift_at_corner_px_EXTRAPOLATED: +shiftAt(1).toFixed(1),
                    extrapolation_warning: rMaxSampled < 0.95
                        ? `model measured on r in [0, ${rMaxSampled.toFixed(3)}]; corner behavior (r -> 1) is extrapolated, not measured`
                        : null,
                },
            };
        }
    }

    // ── psf_anchors (contract + additive bp_rp/gaia_id extension) ──
    const psf_anchors = pairs.map((p) => ({
        x: +p.x.toFixed(3), y: +p.y.toFixed(3),
        ra: +p.ra.toFixed(6), dec: +p.dec.toFixed(6),   // degrees
        mag: p.mag,
        bp_rp: p.bp_rp,                                  // Gaia BP-RP (mapped color_index_BV)
        gaia_id: p.gaia_id,
    }));

    const scaleArcsec = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0])) * 3600;

    return {
        // NOTE: vignette deliberately ABSENT — a plate solve measures geometry,
        // not photometric falloff; omitting it keeps the consumer's own
        // frame-fit vignette path active (getCorrections seam).
        wcs,
        distortion,
        psf_anchors,
        provenance: {
            tool: 'tools/psf/solution_to_astrometry.mjs',
            generated: new Date().toISOString(),
            wcs_source: wcsSource,
            wcs_units: 'crval degrees; cd deg/px; pixel origin 0-based y-down (engine convention)',
            image_dims: [w, h],
            wcs_pixel_scale_arcsec: +scaleArcsec.toFixed(4),
            matched_pairs_in_input: pairs.length,
            pairs_projected: projected,
            solution: solutionSummary,
        },
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const args = process.argv.slice(2);
    const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
    const IN = argVal('--in', null);
    if (!IN) { console.error('usage: node tools/psf/solution_to_astrometry.mjs --in <receipt.json|summary.json> [--out out.json] [--width W --height H]'); process.exit(1); }
    const OUT = argVal('--out', path.join(path.dirname(path.resolve(IN)), 'astrometry.json'));
    const ARG_W = argVal('--width', null);
    const ARG_H = argVal('--height', null);
    const doc = JSON.parse(fs.readFileSync(IN, 'utf8'));
    const out = convertToAstrometry(doc, { argW: ARG_W, argH: ARG_H });
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    const d = out.distortion;
    console.log(`wcs: crval [${out.wcs.crval[0].toFixed(4)}, ${out.wcs.crval[1].toFixed(4)}] deg, scale ${out.provenance.wcs_pixel_scale_arcsec}"/px  [${out.provenance.wcs_source}]`);
    console.log(`pairs: ${out.provenance.matched_pairs_in_input} matched, ${out.provenance.pairs_projected} projected`);
    if (d.model === 'brown-conrady') {
        console.log(`distortion: k1=${d.k1} k2=${d.k2} (linear absorbed a=${d.fit.linear_term_absorbed_a}; quintic ${d.fit.quintic_term === 'fitted' ? 'fitted' : 'omitted'})`);
        console.log(`  radial rms ${d.fit.radial_rms_before_px} -> ${d.fit.radial_rms_after_px} px (${d.fit.n_used_after_reclip}/${d.fit.n_pairs} after reclip); tangential rms ${d.fit.tangential_rms_px} px (unmodeled)`);
        console.log(`  sampled r <= ${d.fit.r_max_sampled}; shift ${d.fit.shift_at_r_max_px} px @r_max, ${d.fit.shift_at_corner_px_EXTRAPOLATED} px @corner (EXTRAPOLATED)`);
    } else {
        console.log(`distortion: ${d.model} — ${d.fit.note}`);
    }
    console.log(`psf_anchors: ${out.psf_anchors.length} (with bp_rp where present)`);
    console.log(`written: ${OUT}`);
}
