// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — lens corrections + solve socket
// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURE: coordinate manipulations and pixel manipulations are kept
// strictly separate.
//   - VIGNETTE is a PIXEL-lane operation: multiplicative radial gain on
//     values; no positions move. Runs FIRST (before any additive background
//     work) because falloff is multiplicative physics.
//   - DISTORTION is a COORDINATE FUNCTION, not an image warp: Brown-Conrady
//     k1/k2 forward/inverse transforms applied to star POSITIONS. The single
//     permitted pixel resample happens once, at the final render stage, on
//     the star-subtracted background layer only (smooth structure).
//
// SOLVE SOCKET: `--astrometry <file.json>` replaces the APPROXIMATE_PROFILE
// corrections with measured ones through the same getCorrections() seam.
// Contract (documented now; nothing produces it yet):
//   {
//     wcs:        { crpix: [x, y], crval: [ra_deg, dec_deg],
//                   cd: [[cd11, cd12], [cd21, cd22]] },
//     distortion: { model: "brown-conrady" | "tps",
//                   k1, k2,                  // brown-conrady, r normalized to half-diagonal
//                   controlPoints?: [...] }, // tps only (not implemented yet)
//     vignette?:  { a2, a4 },                // gain(r) = 1 + a2 r^2 + a4 r^4
//     psf_anchors?: [{ x, y, ra, dec, mag }]
//   }

import fs from 'node:fs';

export const SOLVE_SOCKET_CONTRACT = {
    wcs: { crpix: '[x, y] px', crval: '[ra_deg, dec_deg]', cd: '[[cd11, cd12], [cd21, cd22]] deg/px' },
    distortion: {
        model: '"brown-conrady" | "tps"',
        k1: 'number (r normalized to half-diagonal)',
        k2: 'number',
        controlPoints: 'tps only: [{x, y, dx, dy}] (NOT IMPLEMENTED — reserved)',
    },
    vignette: { a2: 'number, gain(r) = 1 + a2 r^2 + a4 r^4', a4: 'number' },
    psf_anchors: '[{x, y, ra, dec, mag}] — catalog-matched stars for celestial-mechanics-informed PSF (reserved)',
};

// Rokinon/Samyang 14mm f/2.8 published-neighborhood defaults. APPROXIMATE.
export const APPROXIMATE_PROFILE = {
    lens: 'Rokinon/Samyang 14mm f/2.8 (APPROXIMATE_PROFILE)',
    vignette: { a2: 0.7, a4: 0.6 },
    distortion: { model: 'brown-conrady', k1: -0.12, k2: 0.05 },
};

// ── Brown-Conrady coordinate function ───────────────────────────────────────
// Native (as-captured, distorted) radius r_d relates to corrected
// (rectilinear, undistorted) radius r_u by  r_d = r_u * (1 + k1 r_u^2 + k2 r_u^4),
// r normalized to the half-diagonal, optical center assumed at frame center.
//
// INCUBATOR DUPLICATION (CLAUDE.md LAW 4): `makeBrownConrady` is faithfully
// ported to the live engine at `src/engine/pipeline/m2_hardware/lens_distortion.ts`
// (`makeBrownConradyDistortion`) — the solve-path lens-prior consumer (NEXT_MOVES
// §8). This lane stays the fast-iteration incubator + CLI driver; keep the two
// in sync when the radial model changes.

export function makeBrownConrady(k1, k2, w, h) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const hd = Math.hypot(cx, cy);
    const invHd = 1 / hd;

    /** corrected -> native (direct evaluation). out = [xn, yn]. */
    function toNative(xc, yc, out) {
        const nx = (xc - cx) * invHd, ny = (yc - cy) * invHd;
        const r2 = nx * nx + ny * ny;
        const f = 1 + k1 * r2 + k2 * r2 * r2;
        out[0] = cx + nx * f * hd;
        out[1] = cy + ny * f * hd;
        return out;
    }

    /** native -> corrected (fixed-point inversion of the radial model). */
    function toCorrected(xn, yn, out) {
        const dx = (xn - cx) * invHd, dy = (yn - cy) * invHd;
        const rd = Math.hypot(dx, dy);
        let ru = rd;
        for (let i = 0; i < 10; i++) {
            const f = 1 + k1 * ru * ru + k2 * ru * ru * ru * ru;
            ru = f > 1e-6 ? rd / f : rd;
        }
        const s = rd > 1e-12 ? ru / rd : 1;
        out[0] = cx + dx * s * hd;
        out[1] = cy + dy * s * hd;
        return out;
    }

    /** displacement |native - corrected| in px at normalized radius r. */
    function shiftAt(r) {
        const f = 1 + k1 * r * r + k2 * r * r * r * r;
        return Math.abs(1 - f) * r * hd;
    }

    return { model: 'brown-conrady', k1, k2, cx, cy, halfDiagPx: hd, toNative, toCorrected, shiftAt };
}

/** Identity coordinate function (used when distortion is disabled). */
export function makeIdentityCoordFn(w, h) {
    const id = (x, y, out) => { out[0] = x; out[1] = y; return out; };
    return { model: 'identity', k1: 0, k2: 0, cx: (w - 1) / 2, cy: (h - 1) / 2, halfDiagPx: Math.hypot((w - 1) / 2, (h - 1) / 2), toNative: id, toCorrected: id, shiftAt: () => 0 };
}

// ── vignette (pixel lane) ───────────────────────────────────────────────────

export const vignetteGain = (a2, a4) => (r2) => 1 + a2 * r2 + a4 * r2 * r2;

/**
 * Fit gain(r) = 1 + a2 r^2 + a4 r^4 against the frame's own sky:
 * observed_cells ~ plane(x,y) / gain(r). Grid search (a2, a4); for each
 * candidate multiply cell medians by gain and fit a robust plane (one 2.5-
 * sigma reclip); minimize clipped RMS. The linear plane absorbs the light-
 * pollution gradient so it is not mistaken for falloff.
 */
export function fitVignetteFromFrame(cells, w, h) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const hd2 = cx * cx + cy * cy;
    const n = cells.med.length;
    const r2 = new Float64Array(n), xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dx = cells.cx[i] - cx, dy = cells.cy[i] - cy;
        r2[i] = (dx * dx + dy * dy) / hd2;
        xs[i] = dx / cx; ys[i] = dy / cy;
    }

    function planeRms(v) {
        // least-squares plane c0 + c1 x + c2 y with one 2.5-sigma reclip
        const use = new Uint8Array(n).fill(1);
        let coef = null;
        for (let pass = 0; pass < 2; pass++) {
            let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0, m = 0;
            for (let i = 0; i < n; i++) {
                if (!use[i]) continue;
                s0++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
                sv += v[i]; svx += v[i] * xs[i]; svy += v[i] * ys[i]; m++;
            }
            // solve 3x3
            const A = [s0, sx, sy, sx, sxx, sxy, sy, sxy, syy];
            const b = [sv, svx, svy];
            // Cramer via manual elimination (3x3)
            const det = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
            const D = det(A);
            if (Math.abs(D) < 1e-12) return { rms: Infinity, coef: [0, 0, 0] };
            const rep = (M, col, vec) => { const C = M.slice(); C[col] = vec[0]; C[col + 3] = vec[1]; C[col + 6] = vec[2]; return C; };
            coef = [det(rep(A, 0, b)) / D, det(rep(A, 1, b)) / D, det(rep(A, 2, b)) / D];
            let ss = 0;
            const res = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                res[i] = v[i] - (coef[0] + coef[1] * xs[i] + coef[2] * ys[i]);
                if (use[i]) ss += res[i] * res[i];
            }
            const sigma = Math.sqrt(ss / Math.max(1, m));
            if (pass === 0) for (let i = 0; i < n; i++) use[i] = Math.abs(res[i]) <= 2.5 * sigma ? 1 : 0;
            else return { rms: sigma, coef };
        }
    }

    const v = new Float64Array(n);
    let best = { a2: 0, a4: 0, rms: Infinity, coef: [0, 0, 0] };
    let profileRms = null;
    const evalCand = (a2, a4) => {
        for (let i = 0; i < n; i++) v[i] = cells.med[i] * (1 + a2 * r2[i] + a4 * r2[i] * r2[i]);
        return planeRms(v);
    };
    for (let a2 = 0; a2 <= 1.6001; a2 += 0.08) {
        for (let a4 = 0; a4 <= 1.6001; a4 += 0.08) {
            const { rms, coef } = evalCand(a2, a4);
            if (rms < best.rms) best = { a2: +a2.toFixed(2), a4: +a4.toFixed(2), rms, coef };
        }
    }
    profileRms = evalCand(APPROXIMATE_PROFILE.vignette.a2, APPROXIMATE_PROFILE.vignette.a4).rms;

    // corner/center sky medians (raw and corrected) for the report
    const centerVals = [], cornerVals = [], cornerCorr = [];
    const gBest = vignetteGain(best.a2, best.a4);
    for (let i = 0; i < n; i++) {
        if (r2[i] < 0.04) centerVals.push(cells.med[i]);
        if (r2[i] > 0.72) { cornerVals.push(cells.med[i]); cornerCorr.push(cells.med[i] * gBest(r2[i])); }
    }
    const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    const c0 = med(centerVals), cB = med(cornerVals), cA = med(cornerCorr);
    return {
        a2: best.a2, a4: best.a4, fitRms: best.rms, profileRms,
        atGridBound: best.a2 >= 1.6 || best.a4 >= 1.6,
        cornerCenterRatioBefore: cB / c0,
        cornerCenterRatioAfter: cA / c0,
        stopsBefore: Math.log2(c0 / cB),
        stopsAfter: Math.log2(c0 / cA),
    };
}

/** Apply gain(r) in place to all channels (pixel lane; native geometry). */
export function applyVignette(channels, w, h, a2, a4) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const invHd2 = 1 / (cx * cx + cy * cy);
    const [R, G, B] = channels;
    for (let y = 0; y < h; y++) {
        const dy2 = (y - cy) * (y - cy);
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const r2 = ((x - cx) * (x - cx) + dy2) * invHd2;
            const g = 1 + a2 * r2 + a4 * r2 * r2;
            R[row + x] *= g; G[row + x] *= g; B[row + x] *= g;
        }
    }
}

// ── the seam ────────────────────────────────────────────────────────────────

/**
 * Resolve the correction set from a source. Profile-based and measured
 * corrections present the SAME interface downstream; a plate solve later
 * plugs in through --astrometry without touching consumers.
 *
 * @param {object} opts
 * @param {string|null} opts.astrometryPath  --astrometry JSON (or null)
 * @param {number} opts.w  @param {number} opts.h  native frame dims
 * @param {function|null} opts.measureVignette  callback () => frame-fit result
 */
export function getCorrections({ astrometryPath, w, h, measureVignette }) {
    let astro = null;
    if (astrometryPath) {
        astro = JSON.parse(fs.readFileSync(astrometryPath, 'utf8'));
    }

    // distortion
    let distortion;
    if (astro?.distortion) {
        const d = astro.distortion;
        if (d.model === 'tps') {
            console.warn('[corrections] tps distortion model is reserved but NOT implemented — falling back to APPROXIMATE_PROFILE brown-conrady');
            const p = APPROXIMATE_PROFILE.distortion;
            distortion = { ...makeBrownConrady(p.k1, p.k2, w, h), provenance: 'APPROXIMATE_PROFILE (tps input not implemented)' };
        } else {
            distortion = { ...makeBrownConrady(d.k1 ?? 0, d.k2 ?? 0, w, h), provenance: 'MEASURED_ASTROMETRY' };
        }
    } else {
        const p = APPROXIMATE_PROFILE.distortion;
        distortion = { ...makeBrownConrady(p.k1, p.k2, w, h), provenance: 'APPROXIMATE_PROFILE' };
    }

    // vignette
    let vignette;
    if (astro?.vignette && Number.isFinite(astro.vignette.a2)) {
        vignette = { a2: astro.vignette.a2, a4: astro.vignette.a4 ?? 0, provenance: 'MEASURED_ASTROMETRY', frameFit: null };
    } else if (measureVignette) {
        const fit = measureVignette();
        vignette = {
            a2: fit.a2, a4: fit.a4,
            provenance: 'MEASURED_FROM_FRAME (seeded by APPROXIMATE_PROFILE, grid-search bounded [0,1.6])',
            frameFit: fit,
        };
    } else {
        vignette = { ...APPROXIMATE_PROFILE.vignette, provenance: 'APPROXIMATE_PROFILE', frameFit: null };
    }

    return {
        source: astro ? 'MEASURED_ASTROMETRY' : 'APPROXIMATE_PROFILE',
        vignette,
        distortion,
        wcs: astro?.wcs ?? null,
        psf_anchors: astro?.psf_anchors ?? null,
    };
}
