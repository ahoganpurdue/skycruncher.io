/**
 * PlanetaryAdapter: Calculates high-luminosity moving anchors for the Plate Solver.
 * Uses orbital elements for J2000.0 epoch.
 */

import { StandardStar } from './standard_stars';

export interface PlanetaryAnchor extends StandardStar {
    is_dynamic_anchor: boolean;
    spectral_signature?: { r: number; g: number; b: number };
}

export class PlanetaryAdapter {
    // Orbital Elements (Semi-major axis, Eccentricity, Inclination, L_mean, Perihelion, Node)
    private static ELEMENTS = {
        VENUS:   { a: 0.7233, e: 0.0067, i: 3.394, L: 181.98, p: 131.53, n: 76.68, mag: -4.4, color: { r: 0.35, g: 0.35, b: 0.30 } },
        MARS:    { a: 1.5236, e: 0.0934, i: 1.850, L: 355.45, p: 336.04, n: 49.57, mag: -2.0, color: { r: 0.65, g: 0.25, b: 0.10 } },
        JUPITER: { a: 5.2033, e: 0.0483, i: 1.305, L:  34.40, p:  14.75, n: 100.55, mag: -2.7, color: { r: 0.45, g: 0.40, b: 0.15 } },
        SATURN:  { a: 9.5370, e: 0.0541, i: 2.484, L:  49.94, p:  92.43, n: 113.72, mag: 0.5,  color: { r: 0.55, g: 0.40, b: 0.05 } },
        MERCURY: { a: 0.3870, e: 0.2056, i: 7.004, L: 252.25, p:  77.45, n: 48.33,  mag: 0.0,  color: { r: 0.35, g: 0.33, b: 0.32 } }
    };

    /**
     * Calculates planetary positions for the given timestamp.
     * Optionally filters by observer location to return only visible planets (Alt > 0).
     */
    public static getVisiblePlanets(date: Date, observer?: { lat: number, lon: number }): PlanetaryAnchor[] {
        const d = (date.getTime() - new Date('2000-01-01T12:00:00Z').getTime()) / (1000 * 60 * 60 * 24);
        const planets: PlanetaryAnchor[] = [];

        // Calculate Earth's heliocentric position first (to find geocentric vectors)
        const earth = this.calcHeliocentric(1.0000, 0.0167, 0.000, 100.46 + 0.9856 * d, 102.94, 0, d);

        for (const [name, el] of Object.entries(this.ELEMENTS)) {
            // 1. Heliocentric Position
            const helio = this.calcHeliocentric(el.a, el.e, el.i, el.L + (0.9856 / (Math.pow(el.a, 1.5))) * d, el.p, el.n, d);

            // 2. Geocentric Position (Vector Subtraction)
            const geo = { x: helio.x - earth.x, y: helio.y - earth.y, z: helio.z - earth.z };

            // 3. Convert to Equatorial (Rotate by Earth's Tilt ~23.44Â°)
            const eq = this.rotateEclipticToEquatorial(geo);

            // 4. Convert to RA/Dec
            const dist = Math.sqrt(eq.x**2 + eq.y**2 + eq.z**2);
            const dec = Math.asin(eq.z / dist) * (180 / Math.PI);
            let ra = Math.atan2(eq.y, eq.x) * (180 / Math.PI);
            if (ra < 0) ra += 360;

            const raHours = ra / 15;

            if (observer) {
                // Horizon Check
                // We need Alt/Az.
                // Approximation: Sidereal Time -> Hour Angle -> Alt/Az
                // simple LST calculation
                const gst = 18.697374558 + 24.06570982441908 * d; // GMST
                const lst = (gst + observer.lon / 15) % 24;
                const ha = (lst - raHours) * 15; // degrees

                const sinAlt = Math.sin(dec * Math.PI/180) * Math.sin(observer.lat * Math.PI/180) +
                               Math.cos(dec * Math.PI/180) * Math.cos(observer.lat * Math.PI/180) * Math.cos(ha * Math.PI/180);
                const alt = Math.asin(sinAlt) * (180/Math.PI);

                if (alt < 0) continue; // Below horizon
            }

            planets.push({
                name: name,
                ra_hours: raHours,
                dec_degrees: dec,
                magnitude_V: el.mag,
                color_index_BV: 0.0, // Placeholder
                spectral_type: 'Planet',
                gaia_id: `planet_${name.toLowerCase()}`,
                pmra: 0,
                pmdec: 0,
                rv_kms: 0,
                temperature_K: 0,
                expected_xy: { x: 0.33, y: 0.33 },
                constellation: '',
                is_dynamic_anchor: true,
                spectral_signature: el.color
            });
        }
        return planets;
    }

    private static calcHeliocentric(a: number, e: number, i: number, L: number, p: number, n: number, d: number) {
        const M = (L - p) * (Math.PI / 180);
        const i_rad = i * (Math.PI / 180);
        const p_rad = p * (Math.PI / 180);
        const n_rad = n * (Math.PI / 180);

        // Solve Kepler's Equation (Approx)
        // M = E - e sin E  => E approx M + e sin M (first order)
        // Better iteration:
        let E = M;
        for(let k=0; k<3; k++) {
             E = M + e * Math.sin(E);
        }
        
        // Orbital Plane
        const x_orb = a * (Math.cos(E) - e);
        const y_orb = a * Math.sqrt(1.0 - e**2) * Math.sin(E);

        // Transform to Ecliptic
        const x = (Math.cos(n_rad) * Math.cos(p_rad - n_rad) - Math.sin(n_rad) * Math.sin(p_rad - n_rad) * Math.cos(i_rad)) * x_orb +
                  (-Math.cos(n_rad) * Math.sin(p_rad - n_rad) - Math.sin(n_rad) * Math.cos(p_rad - n_rad) * Math.cos(i_rad)) * y_orb;

        const y = (Math.sin(n_rad) * Math.cos(p_rad - n_rad) + Math.cos(n_rad) * Math.sin(p_rad - n_rad) * Math.cos(i_rad)) * x_orb +
                  (-Math.sin(n_rad) * Math.sin(p_rad - n_rad) + Math.cos(n_rad) * Math.cos(p_rad - n_rad) * Math.cos(i_rad)) * y_orb;

        const z = (Math.sin(p_rad - n_rad) * Math.sin(i_rad)) * x_orb +
                  (Math.cos(p_rad - n_rad) * Math.sin(i_rad)) * y_orb;
                  
        return { x, y, z };
    }

    private static rotateEclipticToEquatorial(v: {x:number, y:number, z:number}) {
        const eps = 23.439 * (Math.PI / 180); // Obliquity of the Ecliptic
        return {
            x: v.x,
            y: v.y * Math.cos(eps) - v.z * Math.sin(eps),
            z: v.y * Math.sin(eps) + v.z * Math.cos(eps)
        };
    }
}

