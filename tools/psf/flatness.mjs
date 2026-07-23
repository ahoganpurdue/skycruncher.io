// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — region-flatness audit (light-pollution seesaw / inversion check)
// ═══════════════════════════════════════════════════════════════════════════
// Answers ONE question with numbers instead of eyeballs: after the vignette
// gain and the background flatten, is the sky FLAT within noise (a correct
// leveling that merely LOOKS like a seesaw because dark regions rise and
// bright regions fall to the same pedestal), still tilted the ORIGINAL way
// (undercorrected), or tilted the OPPOSITE way (INVERTED — the correction
// went PAST flat, which is a bug)?
//
// Star masking: region medians are computed over 64-px CELL MEDIANS (step-3
// sampled). A point source cannot move a cell median — stars occupy a few
// dozen of ~450 sampled pixels per cell — and a region-level 2.5-sigma cell
// clip additionally drops cells swallowed by large bright structure
// (saturated blobs, towers). Everything stays in LINEAR units.

import { writePNG } from './imaging.mjs';

const medOf = (arr) => {
    const a = Float64Array.from(arr).sort();
    return a.length ? a[a.length >> 1] : NaN;
};

/**
 * Star-masked region-median matrix from a cellMedians() result.
 * @returns { nx, ny, med, sigmaMed, nCells } — sigmaMed is the standard error
 *          of the region median (1.2533 * cellSigma / sqrt(nCells)), where
 *          cellSigma is the MAD-based scatter of cell medians INSIDE the
 *          region. That scatter includes real small-scale sky structure, so
 *          it is an honest (conservative) noise floor for the region median.
 */
export function regionMatrixFromCells(cells, w, h, nx = 4, ny = 3) {
    const bins = Array.from({ length: nx * ny }, () => []);
    for (let i = 0; i < cells.med.length; i++) {
        const gx = Math.min(nx - 1, Math.floor((cells.cx[i] / w) * nx));
        const gy = Math.min(ny - 1, Math.floor((cells.cy[i] / h) * ny));
        bins[gy * nx + gx].push(cells.med[i]);
    }
    const med = new Float64Array(nx * ny), sigmaMed = new Float64Array(nx * ny);
    const nCells = new Int32Array(nx * ny);
    for (let r = 0; r < nx * ny; r++) {
        let v = bins[r];
        let m = medOf(v);
        const madSig = 1.4826 * medOf(v.map((x) => Math.abs(x - m)));
        const keep = v.filter((x) => Math.abs(x - m) <= 2.5 * Math.max(madSig, 1e-12));
        if (keep.length >= 8) v = keep; // clip only when enough cells survive
        m = medOf(v);
        const sig = 1.4826 * medOf(v.map((x) => Math.abs(x - m)));
        med[r] = m;
        sigmaMed[r] = 1.2533 * sig / Math.sqrt(Math.max(1, v.length));
        nCells[r] = v.length;
    }
    return { nx, ny, med, sigmaMed, nCells };
}

function invert3x3(M) {
    const [a, b, c, d, e, f, g, h, i] = M;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-14) return null;
    const inv = [
        A, -(b * i - c * h), (b * f - c * e),
        B, (a * i - c * g), -(a * f - c * d),
        C, -(a * h - b * g), (a * e - b * d),
    ];
    return inv.map((v) => v / det);
}

/**
 * Least-squares plane  v ~ c0 + c1*X + c2*Y  over region centers, with X and Y
 * normalized to [-1, 1] across the FULL grid extent (so tilt coefficients are
 * comparable between full-grid and row-subset fits).
 * @param rows optional row filter, e.g. [0, 1] = top two (sky) rows.
 * @param excludeRegions optional flat region indices to drop (e.g. a detected
 *        galactic-band region — real glow is SIGNAL and must not be judged as
 *        residual background tilt).
 * @returns { c0, c1, c2, n, residRms, sigmaC1, sigmaC2, covC1C2 } — coefficient
 *          sigmas from the residual scatter of the region medians around the
 *          plane (dof = n - 3), i.e. real region-to-region structure counts
 *          as noise.
 */
export function fitRegionPlane(matrix, rows = null, excludeRegions = null) {
    const { nx, ny, med } = matrix;
    const X = [], Y = [], V = [];
    for (let gy = 0; gy < ny; gy++) {
        if (rows && !rows.includes(gy)) continue;
        for (let gx = 0; gx < nx; gx++) {
            if (excludeRegions && excludeRegions.includes(gy * nx + gx)) continue;
            X.push(nx > 1 ? (gx - (nx - 1) / 2) / ((nx - 1) / 2) : 0);
            Y.push(ny > 1 ? (gy - (ny - 1) / 2) / ((ny - 1) / 2) : 0);
            V.push(med[gy * nx + gx]);
        }
    }
    const n = V.length;
    if (n < 4) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0;
    for (let i = 0; i < n; i++) {
        sx += X[i]; sy += Y[i]; sxx += X[i] * X[i]; sxy += X[i] * Y[i]; syy += Y[i] * Y[i];
        sv += V[i]; svx += V[i] * X[i]; svy += V[i] * Y[i];
    }
    const Ainv = invert3x3([n, sx, sy, sx, sxx, sxy, sy, sxy, syy]);
    if (!Ainv) return null;
    const b = [sv, svx, svy];
    const c = [0, 0, 0];
    for (let r = 0; r < 3; r++) c[r] = Ainv[r * 3] * b[0] + Ainv[r * 3 + 1] * b[1] + Ainv[r * 3 + 2] * b[2];
    let ss = 0;
    for (let i = 0; i < n; i++) {
        const e = V[i] - (c[0] + c[1] * X[i] + c[2] * Y[i]);
        ss += e * e;
    }
    const s2 = ss / Math.max(1, n - 3);
    return {
        c0: c[0], c1: c[1], c2: c[2], n,
        residRms: Math.sqrt(s2),
        sigmaC1: Math.sqrt(s2 * Ainv[4]),
        sigmaC2: Math.sqrt(s2 * Ainv[8]),
        covC1C2: s2 * Ainv[5],
    };
}

/**
 * Verdict on the residual tilt. `proj` is the AFTER tilt projected onto the
 * BEFORE tilt's unit direction:
 *   proj within 2 sigma of 0  ->  A_FLAT_WITHIN_NOISE   (correct leveling)
 *   proj < 0 beyond 2 sigma   ->  B_INVERTED            (went PAST flat: bug)
 *   proj > 0 beyond 2 sigma   ->  UNDERCORRECTED_RESIDUAL_GRADIENT
 * beforeTiltZ says whether the reference direction itself is significant —
 * on an already-flat frame the verdict defaults to the after-tilt magnitude.
 */
export function tiltVerdict(before, after) {
    const magB = Math.hypot(before.c1, before.c2);
    const u = magB > 0 ? [before.c1 / magB, before.c2 / magB] : [1, 0];
    const proj = after.c1 * u[0] + after.c2 * u[1];
    const varProj = (u[0] * after.sigmaC1) ** 2 + (u[1] * after.sigmaC2) ** 2 + 2 * u[0] * u[1] * after.covC1C2;
    const sigmaProj = Math.sqrt(Math.max(1e-30, varProj));
    const z = proj / sigmaProj;
    const varB = (u[0] * before.sigmaC1) ** 2 + (u[1] * before.sigmaC2) ** 2 + 2 * u[0] * u[1] * before.covC1C2;
    const beforeTiltZ = varB > 0 ? magB / Math.sqrt(varB) : 0;
    let verdict;
    if (Math.abs(z) <= 2) verdict = 'A_FLAT_WITHIN_NOISE';
    else if (proj < 0) verdict = 'B_INVERTED';
    else verdict = 'UNDERCORRECTED_RESIDUAL_GRADIENT';
    return {
        verdict, proj, sigmaProj, z, beforeTiltZ,
        beforeTiltUnit: u,
        beforeTiltMag: magB,
        afterTiltMag: Math.hypot(after.c1, after.c2),
        beforePP: 2 * (Math.abs(before.c1) + Math.abs(before.c2)), // peak-to-peak over region centers
        afterPP: 2 * (Math.abs(after.c1) + Math.abs(after.c2)),
    };
}

/**
 * Render a scalar surface (evalAt(x, y) in native pixel coords) as a small
 * grayscale PNG, min..max normalized. Returns { min, max, ow, oh, flat }.
 * Used to show "what was subtracted/divided": background model + vignette gain.
 */
export function renderSurfacePNG(outPath, evalAt, w, h, outW = 420) {
    const scale = outW / w;
    const ow = outW, oh = Math.max(1, Math.round(h * scale));
    const vals = new Float64Array(ow * oh);
    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
            const v = evalAt((x + 0.5) / scale, (y + 0.5) / scale);
            vals[y * ow + x] = v;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
    }
    const span = mx - mn;
    const bytes = new Uint8Array(ow * oh * 3);
    for (let i = 0; i < ow * oh; i++) {
        const g = span > 1e-12 ? Math.round(255 * (vals[i] - mn) / span) : 128;
        bytes[i * 3] = g; bytes[i * 3 + 1] = g; bytes[i * 3 + 2] = g;
    }
    writePNG(outPath, bytes, ow, oh);
    return { min: mn, max: mx, ow, oh, flat: span <= 1e-12 };
}
