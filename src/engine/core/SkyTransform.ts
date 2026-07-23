/**
 * SKY TRANSFORM - Spherical Trigonometry & Projections
 * 
 * Centralized engine for projecting coordinates between the celestial sphere
 * (RA/Dec) and the tangent plane (Xi/Eta). Handles distortion correction.
 */

import { UnitConverter } from './UnitConverter';
import { AstrometryEngine } from '../pipeline/m7_astrometry/astrometry_engine';
import { OpticsManager, DistortionProfile } from './optics_manager';
import { WCSTransform } from '../types/Main_types';

// WebAssembly Compute Module
import * as wasm from '../wasm_compute/pkg/wasm_compute';

export type DistortionModel = DistortionProfile;

export class SkyTransform {
    private static readonly TWO_PI = Math.PI * 2;

    // --- SPHERICAL TRIGONOMETRY ---

    /**
     * Calculate internal angular separation between two points on the sphere.
     * @param ra1 - Point 1 RA in decimal hours
     * @param dec1 - Point 1 Dec in degrees
     * @param ra2 - Point 2 RA in decimal hours
     * @param dec2 - Point 2 Dec in degrees
     * @returns Separation in DEGREES.
     */
    public static calculateAngularSeparation(ra1: number, dec1: number, ra2: number, dec2: number): number {
        const ra1Rad = UnitConverter.hoursToRad(ra1);
        const dec1Rad = UnitConverter.degToRad(dec1);
        const ra2Rad = UnitConverter.hoursToRad(ra2);
        const dec2Rad = UnitConverter.degToRad(dec2);

        const sepRad = wasm.calculate_angular_separation(ra1Rad, dec1Rad, ra2Rad, dec2Rad);
        return UnitConverter.radToDeg(sepRad);
    }

    // --- GNOMONIC PROJECTION ( Sky <-> Tangent Plane ) ---

    /**
     * Standard Gnomonic (TAN) projection: Sky -> Tangent Plane.
     */
    public static gnomonicProject(
        raH: number, decD: number,
        ra0H: number, dec0D: number,
        distortion?: DistortionModel
    ): { xi: number; eta: number } {
        const raRad = UnitConverter.hoursToRad(raH);
        const decRad = UnitConverter.degToRad(decD);
        const ra0Rad = UnitConverter.hoursToRad(ra0H);
        const dec0Rad = UnitConverter.degToRad(dec0D);

        const proj = wasm.gnomonic_project(raRad, decRad, ra0Rad, dec0Rad);
        
        if (isNaN(proj[0])) {
            return { xi: NaN, eta: NaN };
        }

        let xiDeg = UnitConverter.radToDeg(proj[0]);
        let etaDeg = UnitConverter.radToDeg(proj[1]);

        if (distortion) {
            const flat = OpticsManager.applyDistortion(xiDeg, etaDeg, 0, 0, distortion);
            xiDeg = flat.x;
            etaDeg = flat.y;
        }

        return { xi: xiDeg, eta: etaDeg };
    }

    /**
     * Inverse Gnomonic: Tangent Plane -> Sky.
     */
    public static inverseGnomonic(
        xiDeg: number, etaDeg: number,
        ra0H: number, dec0D: number,
        distortion?: DistortionModel
    ): { ra_hours: number; dec_degrees: number } {
        let xi = xiDeg;
        let eta = etaDeg;

        if (distortion) {
            const ideal = OpticsManager.removeDistortion(xiDeg, etaDeg, 0, 0, distortion);
            xi = ideal.x;
            eta = ideal.y;
        }

        const xiRad = UnitConverter.degToRad(xi);
        const etaRad = UnitConverter.degToRad(eta);
        const ra0Rad = UnitConverter.hoursToRad(ra0H);
        const dec0Rad = UnitConverter.degToRad(dec0D);

        const sky = wasm.inverse_gnomonic(xiRad, etaRad, ra0Rad, dec0Rad);

        return {
            ra_hours: UnitConverter.radToHours(sky[0]),
            dec_degrees: UnitConverter.radToDeg(sky[1]),
        };
    }

    /**
     * O(N) FAST PATH: Bulk Pixel to Sky Transformation
     */
    public static bulkPixelsToSky(
        xyCoords: Float64Array,
        wcs: WCSTransform
    ): Float64Array {
        const crpixX = wcs.crpix[0];
        const crpixY = wcs.crpix[1];
        const crvalRaRad = UnitConverter.hoursToRad(wcs.crval[0]);
        const crvalDecRad = UnitConverter.degToRad(wcs.crval[1]);
        const cd11 = UnitConverter.degToRad(wcs.cd[0][0]);
        const cd12 = UnitConverter.degToRad(wcs.cd[0][1]);
        const cd21 = UnitConverter.degToRad(wcs.cd[1][0]);
        const cd22 = UnitConverter.degToRad(wcs.cd[1][1]);
        
        const skyRad = wasm.wcs_pixels_to_sky_bulk(
            xyCoords, crpixX, crpixY, crvalRaRad, crvalDecRad,
            cd11, cd12, cd21, cd22
        );

        const out = new Float64Array(skyRad.length);
        for(let i=0; i<skyRad.length; i+=2) {
            out[i] = UnitConverter.radToHours(skyRad[i]);
            out[i+1] = UnitConverter.radToDeg(skyRad[i+1]);
        }
        return out;
    }

    // --- WCS & COORDINATE SYNTHESIS ---

    public static calculateCDMatrix(scaleArcsec: number, rotationDeg: number, parity: number): [[number, number], [number, number]] {
        const cd = wasm.calculate_cd_matrix(scaleArcsec, rotationDeg, parity);
        const r2d = UnitConverter.RAD2DEG;
        return [
            [cd[0] * r2d, cd[1] * r2d],
            [cd[2] * r2d, cd[3] * r2d]
        ];
    }

    public static createWCSTransform(
        raHours: number, 
        decDeg: number, 
        scaleArcsec: number, 
        rotationDeg: number, 
        parity: number, 
        crpix: [number, number]
    ): WCSTransform {
        return {
            crval: [raHours, decDeg],
            crpix: crpix,
            cd: this.calculateCDMatrix(scaleArcsec, rotationDeg, parity)
        };
    }

    public static fitWCS(
        pixelStars: { x: number; y: number }[],
        skyStars: { xi: number; eta: number }[],
        crpix: [number, number],
        ra0H: number,
        dec0D: number,
    ): WCSTransform | null {
        const n = pixelStars.length;
        if (n < 3) return null;
        // Defense-in-depth: mismatched arrays mean the caller broke the
        // pixel<->sky pairing contract — refuse rather than crash/mis-fit.
        if (skyStars.length !== n) {
            console.warn(`[SkyTransform] fitWCS array mismatch: ${n} pixel vs ${skyStars.length} sky — refusing fit.`);
            return null;
        }

        // TRANSLATION-AWARE FIT: fit_wcs_bulk models [xi,eta] = CD*[dx,dy] with
        // NO offset term, i.e. it assumes crpix maps exactly to (ra0,dec0).
        // When the true image center is offset from the hint (routine for FITS
        // header hints), that assumption biases the CD fit - a correct quad
        // yields a wrong scale/rotation and dies at the scale gate.
        // Fix: fit about the data centroids (offset-free by construction),
        // then recover the sky position of crpix as the true crval.
        let mx = 0, my = 0, mxi = 0, meta = 0;
        for (let i = 0; i < n; i++) {
            mx += pixelStars[i].x; my += pixelStars[i].y;
            mxi += skyStars[i].xi; meta += skyStars[i].eta;
        }
        mx /= n; my /= n; mxi /= n; meta /= n;

        const pixelX = new Float64Array(n);
        const pixelY = new Float64Array(n);
        const skyXi = new Float64Array(n);
        const skyEta = new Float64Array(n);

        for (let i = 0; i < n; i++) {
            pixelX[i] = pixelStars[i].x;
            pixelY[i] = pixelStars[i].y;
            skyXi[i] = skyStars[i].xi - mxi;
            skyEta[i] = skyStars[i].eta - meta;
        }

        const cdMatrix = (wasm as any).fit_wcs_bulk(
            pixelX,
            pixelY,
            skyXi,
            skyEta,
            mx,
            my
        );

        if (!cdMatrix || cdMatrix.length === 0) return null;

        // Sky offset (deg, tangent plane about ra0/dec0) of the requested crpix
        // under the fitted linear map, then de-project to get the true crval.
        const dxc = crpix[0] - mx;
        const dyc = crpix[1] - my;
        const xiC = mxi + cdMatrix[0] * dxc + cdMatrix[1] * dyc;
        const etaC = meta + cdMatrix[2] * dxc + cdMatrix[3] * dyc;
        const center = this.inverseGnomonic(xiC, etaC, ra0H, dec0D);

        return {
            crpix,
            crval: [center.ra_hours, center.dec_degrees],
            cd: [[cdMatrix[0], cdMatrix[1]], [cdMatrix[2], cdMatrix[3]]],
        };
    }

    public static upscaleWCS(wcs: WCSTransform, compressionRatio: number): WCSTransform {
        return {
            ...wcs,
            crpix: [
                wcs.crpix[0] * compressionRatio,
                wcs.crpix[1] * compressionRatio
            ],
            cd: [
                [wcs.cd[0][0] / compressionRatio, wcs.cd[0][1] / compressionRatio],
                [wcs.cd[1][0] / compressionRatio, wcs.cd[1][1] / compressionRatio]
            ]
        };
    }

    public static pixelToSky(
        x: number, y: number, wcs: WCSTransform
    ): { ra_hours: number; dec_degrees: number } {
        const dx = x - wcs.crpix[0];
        const dy = y - wcs.crpix[1];
        const xi = wcs.cd[0][0] * dx + wcs.cd[0][1] * dy;
        const eta = wcs.cd[1][0] * dx + wcs.cd[1][1] * dy;
        return this.inverseGnomonic(xi, eta, wcs.crval[0], wcs.crval[1]);
    }

    public static pixelScaleFromCD(cd: [[number, number], [number, number]]): number {
        const d2r = UnitConverter.DEG2RAD;
        return wasm.pixel_scale_from_cd(cd[0][0]*d2r, cd[0][1]*d2r, cd[1][0]*d2r, cd[1][1]*d2r);
    }

    public static rotationFromCD(cd: [[number, number], [number, number]]): number {
        return wasm.rotation_from_cd(cd[0][0], cd[0][1]);
    }
}
