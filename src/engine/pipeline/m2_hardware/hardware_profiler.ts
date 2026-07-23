import { OpticsManager } from '../../core/optics_manager';
import { 
    PlateSolution, 
    StarMeasurement, 
    HardwareProfile, 
    SignalPacket,
    HardMetadata,
    SignalPoint
} from '../../types/Main_types';

export interface StarResidual {
    measured_x: number;
    measured_y: number;
    ideal_x: number;      // Where the catalog says it should be
    ideal_y: number;
    r_ideal: number;      // distance from center in ideal space
    measured_flux: number;
    catalog_mag: number;
}

export class HardwareProfiler {
    
    /**
     * The Master Analysis: Derives k1/k2 and Vignetting from post-solve residuals.
     * Also reports honest fit diagnostics (inlier count, normalization radius,
     * OLS standard errors) so the UI can print uncertainty, not just a number.
     */
    public static analyze(matches: StarResidual[]): {
        distortion: { k1: number, k2: number, k3: number, p1: number, p2: number },
        vignetting: { v1: number },
        rms_error_pixels: number,
        n_inliers: number,
        r_ref_px: number,
        k1_se?: number,
        k2_se?: number,
        v1_se?: number
    } {
        if (matches.length < 10) {
            return {
                distortion: { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
                vignetting: { v1: 0 },
                rms_error_pixels: 0,
                n_inliers: 0,
                r_ref_px: 0
            };
        }

        // 1. RANSAC OUTLIER REJECTION (The "bouncer")
        // purges hot pixels/cosmic rays before regression
        const inliers = this.filterOutliersRANSAC(matches);
        console.log(`[HardwareProfiler] RANSAC: ${inliers.length} inliers found from ${matches.length} candidates.`);

        // 2. DISTORTION REGRESSION (The "Mustache" Solver)
        const idealRadii = inliers.map(m => m.r_ideal);
        const measuredRadii = inliers.map(m => Math.sqrt(m.measured_x**2 + m.measured_y**2));
        const r_ref = Math.max(...idealRadii, 1);
        const distortion = OpticsManager.solveDistortionPolynomial(idealRadii, measuredRadii, r_ref);
        const distSe = this.distortionStandardErrors(idealRadii, measuredRadii, r_ref, distortion);

        // 3. VIGNETTING REGRESSION (The "Shading" Solver)
        const v_radii = inliers.map(m => m.r_ideal / r_ref);
        const centerStars = matches.filter(m => m.r_ideal < 500);
        const baseIntensity = centerStars.length > 0
            ? centerStars.reduce((sum, m) => sum + (m.measured_flux / Math.pow(2.512, -m.catalog_mag)), 0) / centerStars.length
            : 1.0;
        const v_intensities = inliers.map(m => m.measured_flux / (baseIntensity * Math.pow(2.512, -m.catalog_mag)));
        const vignette = OpticsManager.solveVignettingProfile(v_radii, v_intensities);
        const v1 = vignette.coeffs[1] || 0;
        const v1_se = this.vignetteStandardError(v_radii, v_intensities, v1);

        return {
            distortion,
            vignetting: { v1 },
            rms_error_pixels: this.calculateRMSE(matches, distortion, r_ref),
            n_inliers: inliers.length,
            r_ref_px: r_ref,
            k1_se: distSe?.k1_se,
            k2_se: distSe?.k2_se,
            v1_se
        };
    }

    /**
     * OLS standard errors for the radial distortion fit
     * y = k1 r^2 + k2 r^4 + k3 r^6 (y = r_meas/r_ideal - 1, r normalized to
     * r_ref) — sigma * sqrt(diag((X^T X)^-1)) over the same points fed to
     * OpticsManager.solveDistortionPolynomial. Undefined when the system is
     * ill-conditioned or under-determined (honest-or-absent).
     */
    private static distortionStandardErrors(
        idealRadii: number[], measuredRadii: number[], r_ref: number,
        fit: { k1: number, k2: number, k3: number }
    ): { k1_se: number, k2_se: number } | null {
        const n = idealRadii.length;
        if (n < 5) return null;
        // Normal matrix (3x3, symmetric) and residual sum of squares
        let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, ssr = 0;
        for (let i = 0; i < n; i++) {
            const ru = idealRadii[i] / r_ref;
            if (!(ru > 1e-9)) return null;
            const rd = measuredRadii[i] / r_ref;
            const x1 = ru * ru, x2 = x1 * x1, x3 = x2 * x1;
            const y = (rd / ru) - 1;
            a11 += x1 * x1; a12 += x1 * x2; a13 += x1 * x3;
            a22 += x2 * x2; a23 += x2 * x3; a33 += x3 * x3;
            const e = y - (fit.k1 * x1 + fit.k2 * x2 + fit.k3 * x3);
            ssr += e * e;
        }
        const dof = n - 3;
        if (dof < 2) return null;
        const sigma2 = ssr / dof;
        // Invert the symmetric 3x3 via cofactors
        const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
        if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
        const inv11 = (a22 * a33 - a23 * a23) / det;
        const inv22 = (a11 * a33 - a13 * a13) / det;
        if (inv11 < 0 || inv22 < 0) return null; // numerically broken inverse
        return {
            k1_se: Math.sqrt(sigma2 * inv11),
            k2_se: Math.sqrt(sigma2 * inv22)
        };
    }

    /**
     * OLS standard error for the one-parameter vignette fit
     * (I - 1) = v1 * r^2: se = sigma / sqrt(sum(x^2)).
     */
    private static vignetteStandardError(radiiNorm: number[], intensities: number[], v1: number): number | undefined {
        const n = radiiNorm.length;
        if (n < 5) return undefined;
        let sxx = 0, ssr = 0;
        for (let i = 0; i < n; i++) {
            const x = radiiNorm[i] * radiiNorm[i];
            const y = intensities[i] - 1.0;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
            sxx += x * x;
            const e = y - v1 * x;
            ssr += e * e;
        }
        if (sxx <= 0 || n - 1 < 2) return undefined;
        const se = Math.sqrt((ssr / (n - 1)) / sxx);
        return Number.isFinite(se) ? se : undefined;
    }

    public static generateReport(
        solution: PlateSolution, 
        rawMetadata: HardMetadata, 
        stars: StarMeasurement[],
        signal: SignalPacket 
    ): HardwareProfile {
        
        const mods: string[] = [];
        let spectralBias = "Standard RGB";

        // 1. INFER FOCAL LENGTH (Physics vs Metadata)
        const pixelSizeUm = rawMetadata.pixel_pitch_um || 4.3; 
        const physicsFL = (206265 * (pixelSizeUm / 1000)) / solution.pixel_scale;
        
        // 2. CALCULATE DISTORTION (K1/K2)
        // Projection center: the solver's WCS is {crpix, crval, cd} (array form,
        // solve-buffer pixel space) — the old `wcs.CRPIX1` key never existed on
        // any producer (scalar CRPIX1/CRPIX2 appear only on the serialized
        // receipt, package.ts), so it silently fell back to a hardcoded 4K
        // center (2000,1500) and every radius fed to the distortion/vignette
        // fit was geometry-poisoned. Prefer the fitted crpix, then the real
        // frame center.
        const crpix = solution.wcs?.crpix as [number, number] | undefined;
        const centerX = (typeof crpix?.[0] === 'number' ? crpix[0] : undefined)
            ?? (rawMetadata.width && rawMetadata.width > 0 ? rawMetadata.width / 2 : 2000);
        const centerY = (typeof crpix?.[1] === 'number' ? crpix[1] : undefined)
            ?? (rawMetadata.height && rawMetadata.height > 0 ? rawMetadata.height / 2 : 1500);

        // Planetary-verification sentinels (9999 / +1000 penalties) are flags,
        // not measurements — the same filter the solve-step UI applies. Feeding
        // them to RANSAC/regression corrupts the profile.
        const measuredMatches = (solution.matched_stars ?? []).filter(m =>
            Number.isFinite(m.residual_arcsec) &&
            m.residual_arcsec < 999 &&
            !(m.catalog?.gaia_id || '').startsWith('planet_')
        );

        let k1 = 0, k2 = 0, k3 = 0, v1 = 0;
        let fitStats: HardwareProfile['fit_stats'];
        if (measuredMatches.length >= 10) {
            const residuals: StarResidual[] = measuredMatches.map(m => {
                const rx = (m.detected as any).rawX ?? m.detected.x;
                const ry = (m.detected as any).rawY ?? m.detected.y;
                const dx_raw = rx - centerX;
                const dy_raw = ry - centerY;
                const r_measured = Math.sqrt(dx_raw * dx_raw + dy_raw * dy_raw);
                
                // Ideal position is defined by catalog RA/Dec + Plate Scale
                // We derive the ideal radius by removing the verified residual
                const r_ideal = r_measured - (m.residual_arcsec / solution.pixel_scale);

                // [SCHEMA A · honest-or-absent] Prefer the REAL 2D residual vector
                // the solver captured at verify time (MatchedStar.residual). The
                // radial-from-center synthesis below is an ASSUMPTION — it points every
                // vector at the frame centre, which is exactly WRONG for refraction
                // (real refraction residuals point at the zenith). Retained ONLY for
                // residual-absent (legacy) receipts; never overwrite a measured vector.
                if (!m.residual) {
                    m.residual = {
                        dx: dx_raw * (m.residual_arcsec / (r_measured || 1)),
                        dy: dy_raw * (m.residual_arcsec / (r_measured || 1))
                    };
                }

                return {
                    measured_x: dx_raw,
                    measured_y: dy_raw,
                    ideal_x: dx_raw, // Placeholder, regression uses r_ideal
                    ideal_y: dy_raw,
                    r_ideal: r_ideal || 1,
                    measured_flux: m.detected.flux,
                    catalog_mag: m.catalog.mag
                };
            });
            const forensic = this.analyze(residuals);
            k1 = forensic.distortion.k1;
            k2 = forensic.distortion.k2;
            k3 = forensic.distortion.k3; // fitted alongside k1/k2 — was silently zeroed
            v1 = forensic.vignetting.v1;
            fitStats = {
                n_matches: measuredMatches.length,
                n_inliers: forensic.n_inliers,
                r_ref_px: forensic.r_ref_px,
                rms_error_px: forensic.rms_error_pixels,
                k1_se: forensic.k1_se,
                k2_se: forensic.k2_se,
                v1_se: forensic.v1_se
            };
        } else {
            k1 = this.calculateDistortionCoefficient(solution.pixel_scale, stars);
        }

        // 3. SPECTRAL FORENSICS (Color)
        const { r_bias, g_bias, b_bias, is_narrowband } = this.analyzeSpectrum(stars);
        const avgBias = 1.0 - b_bias; // Legacy field mapping
        
        if (is_narrowband) {
            mods.push("Narrowband / Duo-Band Filter detected");
            spectralBias = "Extreme Red/Teal Isolation";
        } else if (r_bias > 1.8) {
            mods.push("Astro-Modified Sensor (IR/UV Cut Removed)");
            spectralBias = "Deep Red (H-alpha) enhanced";
        } else if (g_bias < 0.5 && r_bias > 1.2 && b_bias > 1.2) {
            mods.push("Broadband Light Pollution Filter (Teal/Magenta Cast)");
        }

        // 4. SPATIAL FORENSICS (Shape/Diffusion)
        const brightestStars = signal.clean_stars.slice(0, 20);
        const faintStars = signal.clean_stars.slice(-100);
        
        const avgBrightFWHM = brightestStars.length > 0 
            ? brightestStars.reduce((sum: number, s: SignalPoint) => sum + s.fwhm, 0) / brightestStars.length 
            : 0;
        const avgFaintFWHM = faintStars.length > 0 
            ? faintStars.reduce((sum: number, s: SignalPoint) => sum + s.fwhm, 0) / faintStars.length 
            : 1; 

        if (avgBrightFWHM > (avgFaintFWHM * 5.0)) {
            mods.push("Diffusion / Black Mist Filter");
        }

        const lowCircularityBrights = brightestStars.filter(s => s.circularity < 0.4).length;
        if (lowCircularityBrights > 10) {
            mods.push("Starburst / Cross-Screen Filter (or extreme aperture diffraction)");
        }

        if (signal.background_level_top !== undefined && signal.background_level_bottom !== undefined) {
             if (signal.background_level_top < (signal.background_level_bottom * 0.4)) {
                mods.push("Graduated Neutral Density (GND) Filter (or severe horizon obstruction)");
            }
        }

        return {
            inferred_lens: `${physicsFL.toFixed(1)}mm f/Inferred`,
            distortion_profile: { k1, k2, k3, p1: 0, p2: 0 },
            chromatic_aberration: { r_shift: 0, b_shift: avgBias },
            sensor_response: { r_bias, g_bias, b_bias },
            gps_drift_km: 0,
            timestamp_error_sec: 0,
            detected_modifications: mods,
            spectral_bias: spectralBias,
            vignette_v1: v1,
            fit_stats: fitStats
        };
    }

    private static filterOutliersRANSAC(matches: StarResidual[]): StarResidual[] {
        let bestInliers: StarResidual[] = [];
        const iterations = 50;
        const threshold = 2.0; // Px error threshold for inlier

        for (let i = 0; i < iterations; i++) {
            // Pick 3 random points for a simple k1-only model
            const sample = this.getRandomSample(matches, 3);
            const k1_estimate = this.estimateSimpleK1(sample);

            const inliers = matches.filter(m => {
                const r2 = m.r_ideal ** 2;
                const r_expected = m.r_ideal * (1 + k1_estimate * r2);
                const r_measured = Math.sqrt(m.measured_x ** 2 + m.measured_y ** 2);
                return Math.abs(r_measured - r_expected) < threshold;
            });

            if (inliers.length > bestInliers.length) {
                bestInliers = inliers;
            }
        }
        return bestInliers;
    }

    private static getRandomSample<T>(arr: T[], n: number): T[] {
        const result = new Array(n);
        let len = arr.length;
        const taken = new Array(len);
        if (n > len) return arr;
        while (n--) {
            const x = Math.floor(Math.random() * len);
            result[n] = arr[x in taken ? taken[x] : x];
            taken[x] = --len in taken ? taken[len] : len;
        }
        return result;
    }

    private static estimateSimpleK1(sample: StarResidual[]): number {
        // Fits y = k1 * x where y = (r_meas/r_ideal - 1) and x = r_ideal^2
        let sum_xy = 0, sum_xx = 0;
        for (const m of sample) {
            const r2 = m.r_ideal ** 2;
            const y = (Math.sqrt(m.measured_x ** 2 + m.measured_y ** 2) / m.r_ideal) - 1;
            sum_xy += r2 * y;
            sum_xx += r2 * r2;
        }
        return sum_xx !== 0 ? sum_xy / sum_xx : 0;
    }

    /**
     * Radial-model residual RMS in PIXELS. The polynomial was fitted on radii
     * NORMALIZED to r_ref — evaluating it on raw pixel radii (the old code)
     * produced astronomically wrong "RMS" values (~1e22 px) the moment the
     * number was actually displayed. Same normalization as the fit, always.
     */
    private static calculateRMSE(matches: StarResidual[], dist: { k1: number, k2: number, k3?: number }, r_ref: number): number {
        if (!(r_ref > 0)) return 0;
        let sumSqErr = 0;
        for (const m of matches) {
            const rn2 = (m.r_ideal / r_ref) ** 2;
            const r_expected = m.r_ideal * (1 + dist.k1 * rn2 + dist.k2 * rn2 ** 2 + (dist.k3 ?? 0) * rn2 ** 3);
            const r_measured = Math.sqrt(m.measured_x ** 2 + m.measured_y ** 2);
            sumSqErr += (r_measured - r_expected) ** 2;
        }
        return Math.sqrt(sumSqErr / matches.length);
    }

    private static calculateDistortionCoefficient(_centerScale: number, _stars: StarMeasurement[]): number {
        // Honest-or-absent: without >=10 matched-star residuals there is no
        // distortion MEASUREMENT. The old fabricated -0.05 rendered as a real
        // curve in the step-6 UI. Zero means "no measurable distortion".
        return 0;
    }

    private static analyzeSpectrum(stars: StarMeasurement[]) {
        const whiteStars = stars.filter(s => 
            s.catalog_bv !== undefined && s.catalog_bv > 0.5 && s.catalog_bv < 0.7
        ).map(s => ({ r: s.flux_r || 0, g: s.flux_g || 0, b: s.flux_b || 0 }));

        const bias = OpticsManager.analyzeSpectralBias(whiteStars);
        
        return {
            r_bias: bias.r,
            g_bias: bias.g,
            b_bias: bias.b,
            is_narrowband: false // Simplified for now
        };
    }
}


