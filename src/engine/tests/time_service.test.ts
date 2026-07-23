import { describe, it, expect } from 'vitest';
import { TimeService } from '../core/TimeService';

describe('TimeService', () => {
    it('should convert Date to Julian Date', () => {
        const date = new Date('2000-01-01T12:00:00Z');
        const jd = TimeService.toJulianDate(date);
        expect(jd).toBe(2451545.0);
    });

    it('should compute GMST correctly', () => {
        const jd = 2451545.0; // J2000
        const gmst = TimeService.getGMST_Deg(jd);
        expect(gmst).toBeCloseTo(280.46, 1);
    });

    it('computes Alt/Az to a hand-derived value for fixed inputs', () => {
        // Fixed inputs → a single computable horizontal coordinate. Independently
        // derived from the standard equatorial→horizontal transform (LMST from the
        // documented GMST formula, then sin(alt)=sinφsinδ+cosφcosδcos(H)):
        //   GMST = 68.46175°, LMST = 310.46175°, H = LMST − RA.
        //   altitude = −32.8831°, azimuth = 338.0235° (measured N→E).
        // The old test asserted only toBeDefined() — a NaN or swapped alt/az passed.
        const altAz = TimeService.computeAltAz(10.0, 20.0, 34.0, -118.0, 2459000.0);
        expect(altAz.altitude).toBeCloseTo(-32.8831, 3);
        expect(altAz.azimuth).toBeCloseTo(338.0235, 3);
    });

    it('Alt/Az inverts back to the input RA/Dec (transform consistency)', () => {
        const jd = 2459000.0;
        const { altitude, azimuth } = TimeService.computeAltAz(10.0, 20.0, 34.0, -118.0, jd);
        const eq = TimeService.horizontalToEquatorial(altitude, azimuth, 34.0, -118.0, jd);
        expect(eq.ra).toBeCloseTo(10.0, 4);
        expect(eq.dec).toBeCloseTo(20.0, 4);
    });
});
