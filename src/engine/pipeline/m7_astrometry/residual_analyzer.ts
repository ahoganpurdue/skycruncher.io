
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * RESIDUAL ANALYZER & SIP FITTER â€” The Precision Tuner
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * ALGORITHM:
 * 1. Takes a linear Plate Solution (WCS).
 * 2. COMPARES detected star positions vs. projected catalog positions.
 * 3. CALCULATES Residual vectors (dx, dy).
 * 4. FITS a Simple Imaging Polynomial (SIP) to model the remaining distortion.
 * 
 * MATH:
 *   u, v = intermediate world coordinates (linear WCS)
 *   x, y = pixel coordinates
 *   
 *   u = CD1_1*(x-x0) + CD1_2*(y-y0) + A_order(u,v) ? No, SIP usually adds to Pixels.
 *   
 *   Standard SIP:
 *   x_corr = x + f(u,v) ... OR x + f(x,y)?
 *   
 *   Actually, SIP (Spitzer/FITS) usually defines:
 *   xi = CD1_1*(u) + CD1_2*(v) 
 *   where u = (x-x0) + f(x-x0, y-y0)
 * 
 *   We will implement a simple polynomial least-squares fit to minimize residuals.
 */

import { PlateSolution, MatchedStar } from '../../types/Main_types';
import { SkyTransform } from '../../core/SkyTransform';

export interface SIPCoefficients {
    a_order: number;
    b_order: number;
    a: number[][]; // A_pq where p+q <= order
    b: number[][];
}

export interface ResidualAnalysis {
    rms_arcsec: number;
    systematic_error_vector: { x: number, y: number }; // Average shift
    distortion_pattern_detected: boolean;
    sip_coefficients?: SIPCoefficients;
}

export class ResidualAnalyzer {

    /**
     * Analyze residuals and fit SIP coefficients using a Least-Squares matrix solver.
     * This models optical distortion by mapping linear WCS errors back to pixel space.
     */
    public static analyze(solution: PlateSolution, fitOrder: number = 3): ResidualAnalysis {
        const wcs = solution.wcs;
        // Planetary-verification sentinels (residual_arcsec 9999 / +1000
        // penalties, gaia_id 'planet_*') are flags, not astrometric
        // measurements — they would inject huge outliers into the SIP fit.
        const matches = (solution.matched_stars ?? []).filter(m =>
            Number.isFinite(m.residual_arcsec) &&
            m.residual_arcsec < 999 &&
            !(m.catalog?.gaia_id || '').startsWith('planet_')
        );
        if (!wcs || matches.length < 15) {
            return {
                rms_arcsec: 0,
                systematic_error_vector: { x: 0, y: 0 },
                distortion_pattern_detected: false
            };
        }
        const crpix = wcs.crpix;

        const dataPoints: { u: number, v: number, dx: number, dy: number }[] = [];
        let sumSqArcsec = 0;

        for (const m of matches) {
            const detected = m.detected;
            const catalog = m.catalog;

            // Gap 1: Derive the 2D error vector by projecting catalog RA/Dec back to Pixel Space
            const { x: expX, y: expY } = this.skyToLinearPixel(catalog.ra, catalog.dec, wcs);

            const dx = detected.x - expX;
            const dy = detected.y - expY;

            // Intermediate normalized coordinates (relative to CRPIX center)
            const u = detected.x - crpix[0];
            const v = detected.y - crpix[1];

            dataPoints.push({ u, v, dx, dy });

            const residualPx = Math.sqrt(dx * dx + dy * dy);
            const residualArcsec = residualPx * solution.pixel_scale;
            sumSqArcsec += residualArcsec * residualArcsec;
        }

        const rms = Math.sqrt(sumSqArcsec / matches.length);
        
        // If RMS is significant (> 1.2"), systematic distortion is likely present
        const distortion_detected = rms > 1.2; 
        let sip: SIPCoefficients | undefined = undefined;

        if (distortion_detected && matches.length > 20) {
            // performSIPFit returns null on a singular (rank-deficient) config;
            // leave `sip` undefined so sip_coefficients is ABSENT (honest-or-absent).
            const fit = this.performSIPFit(dataPoints, fitOrder);
            if (fit) sip = fit;
        }

        // Real mean residual vector (was a hardcoded {0,0} default).
        const meanDx = dataPoints.reduce((s, p) => s + p.dx, 0) / dataPoints.length;
        const meanDy = dataPoints.reduce((s, p) => s + p.dy, 0) / dataPoints.length;

        return {
            rms_arcsec: rms,
            systematic_error_vector: { x: meanDx, y: meanDy },
            distortion_pattern_detected: distortion_detected,
            sip_coefficients: sip
        };
    }

    /**
     * Map Equatorial coordinates to Linear Pixel coordinates using the CD matrix.
     * PUBLIC: the step-6 residual vector field projects catalog stars through
     * the SAME linear model the analyzer used (single source of truth for the
     * catalog->pixel convention: catalog ra in DEGREES, crval[0] in HOURS).
     */
    public static skyToLinearPixel(raDeg: number, decDeg: number, wcs: any): { x: number, y: number } {
        // gnomonic expects ra in hours
        const { xi, eta } = SkyTransform.gnomonicProject(raDeg / 15, decDeg, wcs.crval[0], wcs.crval[1]);
        
        // Invert the CD Matrix to solve for [dx, dy]
        const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
        const dx = (wcs.cd[1][1] * xi - wcs.cd[0][1] * eta) / det;
        const dy = (-wcs.cd[1][0] * xi + wcs.cd[0][0] * eta) / det;
        
        return {
            x: dx + wcs.crpix[0],
            y: dy + wcs.crpix[1]
        };
    }

    /**
     * PUBLIC weighted-SIP entry (the terminal `final_astrometry` pass reuses the
     * SAME fitter — LAW 4, no duplicated SIP math). Callers build the residual
     * data points (u,v = det − crpix; dx,dy = det − linear-predicted) EXACTLY as
     * {@link analyze} does above, and may supply an OPTIONAL per-point weight
     * (index-aligned; SNR-honest inverse-variance). `weights` UNDEFINED ⇒ the
     * ordinary-least-squares path {@link analyze} uses, byte-identical. Returns
     * null on a singular/rank-deficient configuration (honest-absent, never NaN).
     */
    public static fitSip(
        points: { u: number, v: number, dx: number, dy: number }[],
        order: number,
        weights?: number[],
    ): SIPCoefficients | null {
        return this.performSIPFit(points, order, weights);
    }

    /**
     * Perform Multiple Linear Regression to find A and B polynomial coefficients.
     * Gap 2:strictly fit order 2 and higher.
     */
    private static performSIPFit(points: { u: number, v: number, dx: number, dy: number }[], order: number, weights?: number[]): SIPCoefficients | null {
        const terms: { p: number, q: number }[] = [];
        for (let p = 0; p <= order; p++) {
            for (let q = 0; q <= order; q++) {
                // FITS Standard: SIP omits 0th and 1st order (CRPIX and CD handle those)
                if (p + q >= 2 && p + q <= order) {
                    terms.push({ p, q });
                }
            }
        }

        const m = terms.length;
        const aCoeffs = this.solveLeastSquares(points, terms, 'dx', weights);
        const bCoeffs = this.solveLeastSquares(points, terms, 'dy', weights);

        // Singular normal matrix (rank-deficient point config) → abstain. Returning
        // null keeps the SIP fit ABSENT rather than emitting NON-FINITE coefficients.
        if (aCoeffs === null || bCoeffs === null) return null;

        const aMatrix = Array(order + 1).fill(0).map(() => Array(order + 1).fill(0));
        const bMatrix = Array(order + 1).fill(0).map(() => Array(order + 1).fill(0));

        for (let i = 0; i < m; i++) {
            const { p, q } = terms[i];
            aMatrix[p][q] = aCoeffs[i];
            bMatrix[p][q] = bCoeffs[i];
        }

        return {
            a_order: order,
            b_order: order,
            a: aMatrix,
            b: bMatrix
        };
    }

    /**
     * Constructs Normal Equations and solves for the coefficient vector.
     */
    private static solveLeastSquares(points: any[], terms: { p: number, q: number }[], key: 'dx' | 'dy', weights?: number[]): number[] | null {
        const M = terms.length;
        const A = Array(M).fill(0).map(() => Array(M).fill(0));
        const B = Array(M).fill(0);

        // WEIGHTED normal equations Σ w·φ_iφ_j and Σ w·φ_i·y. When `weights` is
        // absent the accumulation is the ORIGINAL unweighted statement verbatim
        // (`sum += termI*termJ`), so every existing caller (analyze / calibrate /
        // bc_rematch) stays IEEE byte-identical — the vitest battery proves it.
        for (let i = 0; i < M; i++) {
            for (let j = 0; j < M; j++) {
                let sum = 0;
                for (let n = 0; n < points.length; n++) {
                    const p = points[n];
                    const termI = Math.pow(p.u, terms[i].p) * Math.pow(p.v, terms[i].q);
                    const termJ = Math.pow(p.u, terms[j].p) * Math.pow(p.v, terms[j].q);
                    sum += weights ? termI * termJ * weights[n] : termI * termJ;
                }
                A[i][j] = sum;
            }

            let sumY = 0;
            for (let n = 0; n < points.length; n++) {
                const p = points[n];
                const termI = Math.pow(p.u, terms[i].p) * Math.pow(p.v, terms[i].q);
                const y = (key === 'dx' ? p.dx : p.dy);
                sumY += weights ? termI * y * weights[n] : termI * y;
            }
            B[i] = sumY;
        }

        return this.gaussianElimination(A, B);
    }

    /**
     * Gap 3: Lightweight Gaussian Elimination Matrix Solver.
     * Returns the solved coefficient vector, or `null` when the normal matrix is
     * (near-)singular — see the pivot guard below.
     */
    private static gaussianElimination(A: number[][], B: number[]): number[] | null {
        const n = B.length;
        for (let i = 0; i < n; i++) {
            // Partial Pivoting
            let max = Math.abs(A[i][i]);
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > max) {
                    max = Math.abs(A[k][i]);
                    maxRow = k;
                }
            }

            // Singular guard (mirrors tps_fitter.ts solveLinear `if (max < 1e-12)
            // return null`): a pivot magnitude below 1e-12 means this column is
            // rank-deficient (e.g. a collinear / coincident point configuration).
            // Without this, the elimination divides by ~0 and emits NON-FINITE SIP
            // coefficients. Abstain honestly so the fit is ABSENT, never fake
            // (LAW 3: unmeasured = absent; no NaN/Infinity ever reaches a receipt).
            if (max < 1e-12) return null; // singular

            const tempA = A[maxRow]; A[maxRow] = A[i]; A[i] = tempA;
            const tempB = B[maxRow]; B[maxRow] = B[i]; B[i] = tempB;

            for (let k = i + 1; k < n; k++) {
                const factor = A[k][i] / A[i][i];
                B[k] -= factor * B[i];
                for (let j = i; j < n; j++) {
                    A[k][j] -= factor * A[i][j];
                }
            }
        }

        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let sum = 0;
            for (let j = i + 1; j < n; j++) {
                sum += A[i][j] * x[j];
            }
            x[i] = (B[i] - sum) / A[i][i];
        }
        return x;
    }
}

