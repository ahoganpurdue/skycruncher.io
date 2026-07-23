import { CELESTIAL_DB } from '../../core/celestial_data';
import { SolarBody } from '../../types/Main_types';
import { EphemerisEngine } from '../../core/EphemerisEngine';
import { SkyTransform } from '../../core/SkyTransform';
import { PlanetaryAnchor } from './planetary_adapter';

export class SolarSystem {
    
    /**
     * Calculates positions for ALL bodies using the core EphemerisEngine.
     */
    public static getHierarchy(date: Date, lat: number, lon: number): SolarBody[] {
        const bodies = EphemerisEngine.calculateSolarSystem(date, lat, lon);
        
        const bodyMap: Record<string, SolarBody> = {};
        const rootBodies: SolarBody[] = [];

        // 1. Map all bodies
        bodies.forEach(b => {
            bodyMap[b.id] = b;
        });

        // 2. Construct Hierarchy Tree
        for (const [id, body] of Object.entries(bodyMap)) {
            const c = CELESTIAL_DB[id];
            if (c.orbits_id && c.orbits_id !== 'sun' && c.orbits_id !== 'earth') {
                const parent = bodyMap[c.orbits_id];
                if (parent) {
                    if (!parent.children) parent.children = [];
                    parent.children.push(body);
                } else {
                    rootBodies.push(body);
                }
            } else if (id !== 'earth') {
                rootBodies.push(body);
            }
        }

        return rootBodies.sort((a, b) => a.mag - b.mag);
    }

    public static getVisibleBodies(date: Date, lat: number, lon: number): SolarBody[] {
        return this.getHierarchy(date, lat, lon);
    }

    public static isOcculting(starRA: number, starDec: number, body: SolarBody): boolean {
        const distDeg = SkyTransform.calculateAngularSeparation(starRA, starDec, body.ra, body.dec);
        const radiusDeg = body.radius_arcsec / 3600;
        return distDeg < (radiusDeg * 1.1);
    }

    public static getCelestialContext(lat: number, lon: number, date: Date) {
        const status = EphemerisEngine.getMoonStatus(date, lat, lon);
        
        return {
            is_daylight: status.is_daylight,
            is_twilight: status.is_twilight,
            moon_phase: status.phase,
            moon_altitude: status.altitude,
            moon_illumination: status.intensity,
            moon_vector: status.altitude > 0 ? { alt: status.altitude, az: status.azimuth } : null
        };
    }

    /**
     * Convert SolarBody[] from EphemerisEngine into PlanetaryAnchor[] for the solver.
     * Filters to above-horizon planets only when the altitude is meaningful —
     * i.e. when the caller had a REAL observer site. Without GPS the ephemeris
     * ran at a fictional (0,0), and that horizon filter silently deleted
     * Jupiter from the beach-frame sweep while it was the brightest object in
     * the image. Planet RA/Dec are site-independent (parallax matters only
     * for the Moon), so anchors stay valid without a site.
     */
    public static toAnchors(bodies: SolarBody[], requireAboveHorizon: boolean = true): PlanetaryAnchor[] {
        return bodies
            .filter(b => b.type === 'PLANET' && b.id !== 'earth')
            .filter(b => !requireAboveHorizon || (b.altitude ?? 0) > 0)
            .map(b => ({
                name: b.name,
                ra_hours: b.ra,
                dec_degrees: b.dec,
                magnitude_V: b.mag,
                color_index_BV: 0,
                spectral_type: 'Planet',
                gaia_id: `planet_${b.id}`,
                pmra: 0,
                pmdec: 0,
                rv_kms: 0,
                temperature_K: 0,
                expected_xy: { x: 0.33, y: 0.33 },
                constellation: '',
                is_dynamic_anchor: true,
                spectral_signature: undefined
            }));
    }
}

