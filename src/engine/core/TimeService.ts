/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * TIME SERVICE â€” Temporal & Astronomical Engine
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralized service for precise astronomical time calculations, Epoch
 * precession, and coordinate transformations. Standardizes on Meeus/IAU models.
 * 
 * referenceS:
 * - Meeus, "Astronomical Algorithms"
 * - Lieske (1979) / IAU 2006 precession models
 */

import { UnitConverter } from './UnitConverter';

export class TimeService {
    /** Julian Date of J2000.0 epoch (2000-01-01 12:00:00 UTC) */
    public static readonly J2000 = 2451545.0;

    /** Degrees to radians */
    private static readonly DEG2RAD = Math.PI / 180;
    /** Radians to degrees */
    private static readonly RAD2DEG = 180 / Math.PI;

    // â”€â”€â”€ JULIAN DATE ENGINE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Convert JS Date or Date string to Julian Date (JD).
     */
    public static toJulianDate(date: Date | string): number {
        const d = typeof date === 'string' ? new Date(date) : date;
        return (d.getTime() / 86400000) + 2440587.5;
    }

    /**
     * Convert Julian Date to Julian Centuries (T) since J2000.0.
     */
    public static toJuliancenturies(jd: number): number {
        return (jd - this.J2000) / 36525.0;
    }

    /**
     * Convert Julian Date to Julian Years since J2000.0.
     */
    public static toJulianYears(jd: number): number {
        return (jd - this.J2000) / 365.25;
    }

    /**
     * Days since J2000.0 (used by simplified solar system models).
     */
    public static toDayssinceJ2000(date: Date | string): number {
        const jd = this.toJulianDate(date);
        return jd - this.J2000;
    }

    // â”€â”€â”€ SIDEREAL TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Compute Greenwich Mean Sidereal Time (GMST) in degrees.
     */
    public static getGMST_Deg(jd: number): number {
        const T = this.toJuliancenturies(jd);
        // IAU 1982 formula for GMST at 0h UT
        let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 
                   0.000387933 * T * T - T * T * T / 38710000;
        return (gmst % 360 + 360) % 360;
    }

    public static getLMST_Deg(jd: number, lonDeg: number): number {
        return (this.getGMST_Deg(jd) + lonDeg % 360 + 360) % 360;
    }

    // â”€â”€â”€ COORDINATE PRECESSION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Precess J2000 coordinates to the Equinox of Date (IAU 2006).
     * Uses Lieske (1979) angles for high precision.
     */
    public static precessJ2000ToDate(raHours: number, decDeg: number, jd: number): { ra: number; dec: number } {
        const T = this.toJuliancenturies(jd);

        // Precession angles (in degrees)
        const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) / 3600.0;
        const z    = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) / 3600.0;
        const theta= (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) / 3600.0;

        const raRad = UnitConverter.hoursToRad(raHours);
        const decRad = UnitConverter.degToRad(decDeg);
        const zetaRad = UnitConverter.degToRad(zeta);
        const zRad = UnitConverter.degToRad(z);
        const thetaRad = UnitConverter.degToRad(theta);

        const A = Math.cos(decRad) * Math.sin(raRad + zetaRad);
        const B = Math.cos(thetaRad) * Math.cos(decRad) * Math.cos(raRad + zetaRad)
                - Math.sin(thetaRad) * Math.sin(decRad);
        const C = Math.sin(thetaRad) * Math.cos(decRad) * Math.cos(raRad + zetaRad)
                + Math.cos(thetaRad) * Math.sin(decRad);

        const raNewRad = Math.atan2(A, B) + zRad;
        const decNewRad = Math.asin(Math.max(-1, Math.min(1, C)));

        let raNew = UnitConverter.radToHours(raNewRad);
        raNew = (raNew + 24) % 24;

        return {
            ra: raNew,
            dec: UnitConverter.radToDeg(decNewRad)
        };
    }

    /**
     * Precess coordinates from Equinox of Date to J2000.0.
     */
    public static precessDateToJ2000(raHours: number, decDeg: number, date: Date | string): { ra: number; dec: number } {
        const jd = this.toJulianDate(date);
        const jdJ2000 = this.J2000;
        const deltaJD = jdJ2000 - jd;
        // Inverse precession is approximately precession with negative JD offset
        const jdInv = jdJ2000 + deltaJD; 
        
        return this.precessJ2000ToDate(raHours, decDeg, jdInv);
    }

    /**
     * Apply proper motion to a star's J2000 coordinates.
     * @param pmra - Proper motion in RA (mas/year) * cos(dec)
     * @param pmdec - Proper motion in Dec (mas/year)
     */
    public static applyProperMotion(
        raJ2000: number, decJ2000: number, 
        pmra: number, pmdec: number, 
        yearssinceJ2000: number
    ): { ra: number; dec: number } {
        const pmraDeg = pmra / 3600000.0; 
        const pmdecDeg = pmdec / 3600000.0;

        const decRad = UnitConverter.degToRad(decJ2000);
        const cosDec = Math.cos(decRad);
        
        const raChangeDeg = Math.abs(cosDec) > 1e-6 ? pmraDeg * yearssinceJ2000 / cosDec : 0;
        const decChangeDeg = pmdecDeg * yearssinceJ2000;

        return {
            ra: (raJ2000 + (raChangeDeg / 15.0) + 24) % 24,
            dec: Math.max(-90, Math.min(90, decJ2000 + decChangeDeg))
        };
    }

    // â”€â”€â”€ HORIZONTAL TRANSFORMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * RA/Dec to Alt/Az.
     */
    public static computeAltAz(
        raHours: number, decDeg: number,
        latDeg: number, lonDeg: number,
        jd: number
    ): { altitude: number; azimuth: number } {
        const lmstDeg = this.getLMST_Deg(jd, lonDeg);
        const decRad = UnitConverter.degToRad(decDeg);
        const lmstRad = UnitConverter.degToRad(lmstDeg);
        const latRad = UnitConverter.degToRad(latDeg);
        const raRad = UnitConverter.hoursToRad(raHours);
        
        const ha = lmstRad - raRad;
        
        const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(ha);
        const alt = Math.asin(sinAlt);
        
        const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(alt));
        let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
        
        if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
        
        return {
            altitude: UnitConverter.radToDeg(alt),
            azimuth: UnitConverter.radToDeg(az)
        };
    }

    public static computeAltAzWithLMST(
        raHours: number, decDeg: number,
        latDeg: number, lmstDeg: number
    ): { altitude: number; azimuth: number } {
        const decRad = UnitConverter.degToRad(decDeg);
        const lmstRad = UnitConverter.degToRad(lmstDeg);
        const latRad = UnitConverter.degToRad(latDeg);
        const raRad = UnitConverter.hoursToRad(raHours);
        const ha = lmstRad - raRad;
        const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(ha);
        const alt = Math.asin(sinAlt);
        const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(alt));
        let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
        if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
        return { altitude: UnitConverter.radToDeg(alt), azimuth: UnitConverter.radToDeg(az) };
    }

    /**
     * Alt/Az to RA/Dec.
     */
    public static horizontalToEquatorial(
        altitudeDeg: number, azimuthDeg: number,
        latDeg: number, lonDeg: number,
        jd: number
    ): { ra: number; dec: number } {
        const lmstDeg = this.getLMST_Deg(jd, lonDeg);

        const h = UnitConverter.degToRad(altitudeDeg);
        const A = UnitConverter.degToRad(azimuthDeg);
        const phi = UnitConverter.degToRad(latDeg);
        const lmstRad = UnitConverter.degToRad(lmstDeg);

        const sinDec = Math.sin(phi) * Math.sin(h) + Math.cos(phi) * Math.cos(h) * Math.cos(A);
        const dec = Math.asin(sinDec);

        const cosHA = (Math.sin(h) - Math.sin(phi) * sinDec) / (Math.cos(phi) * Math.cos(dec));
        const ha = Math.acos(Math.max(-1, Math.min(1, cosHA)));

        let raRad;
        if (Math.sin(A) < 0) {
            raRad = lmstRad - ha;
        } else {
            raRad = lmstRad + ha;
        }

        return {
            ra: UnitConverter.radToHours(raRad),
            dec: UnitConverter.radToDeg(dec)
        };
    }
}

