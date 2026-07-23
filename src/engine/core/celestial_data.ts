import { CelestialCategory } from '../types/Main_types';

/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * CELESTIAL DATA â€” The "Graph"
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Single source of truth for all solar system objects.
 * Physical constants are strict (SI units).
 */

export interface OrbitalElements {
    N: number; // Longitude of ascending node
    i: number; // Inclination
    w: number; // Argument of perihelion
    a: number; // Semi-major axis (AU)
    e: number; // Eccentricity
    M: number; // Mean anomaly
    magBase: number; // V(1,0) absolute magnitude: apparent = magBase + 5*log10(r_helio*d_geo), NO phase term (APPROXIMATE). Satellites: derived H = m_opposition - 5*log10(a_parent*(a_parent-1))
}

export interface CelestialConstants {
    id: string;
    name: string;
    type: CelestialCategory;
    orbits_id: string | null; // The relational tag (e.g., 'sun', 'jupiter')
    
    // â”€â”€â”€ PHYSICAL CONSTANTS â”€â”€â”€
    radius_km: number;
    mass_kg: number;
    albedo: number;       // Reflectivity (0 to 1)
    bv_index: number;     // Astrophysical Color (B-V)
    
    // â”€â”€â”€ ORBITAL CONSTANTS â”€â”€â”€
    orbit: OrbitalElements | null; // Null for the Sun
}

export const CELESTIAL_DB: Record<string, CelestialConstants> = {
    sun: {
        id: 'sun', name: 'Sun', type: 'STAR', orbits_id: null,
        radius_km: 696340, mass_kg: 1.989e30, albedo: 1.0, bv_index: 0.65,
        orbit: null
    },
    mercury: {
        id: 'mercury', name: 'Mercury', type: 'PLANET', orbits_id: 'sun',
        radius_km: 2439, mass_kg: 3.30e23, albedo: 0.142, bv_index: 0.91,
        orbit: { N: 48.3313, i: 7.0047, w: 29.1241, a: 0.387098, e: 0.205635, M: 168.6562, magBase: -0.42 }
    },
    venus: {
        id: 'venus', name: 'Venus', type: 'PLANET', orbits_id: 'sun',
        radius_km: 6051, mass_kg: 4.87e24, albedo: 0.77, bv_index: 0.80,
        orbit: { N: 76.6799, i: 3.3946, w: 54.8910, a: 0.723330, e: 0.006773, M: 48.0052,  magBase: -4.40 }
    },
    earth: { // Needed for computations, even if we are ON it
        id: 'earth', name: 'Earth', type: 'PLANET', orbits_id: 'sun',
        radius_km: 6371, mass_kg: 5.97e24, albedo: 0.306, bv_index: 0.65, // Avg
        orbit: { N: 0, i: 0, w: 102.9404, a: 1.00000011, e: 0.016709, M: 357.51716, magBase: -3.0 } // magBase unused: batch_solve_ephemeris skips Earth
    },
    mars: {
        id: 'mars', name: 'Mars', type: 'PLANET', orbits_id: 'sun',
        radius_km: 3389, mass_kg: 6.42e23, albedo: 0.25, bv_index: 1.36,
        orbit: { N: 49.5574, i: 1.8497, w: 286.5016, a: 1.523688, e: 0.093405, M: 18.6021, magBase: -1.52 }
    },
    jupiter: {
        id: 'jupiter', name: 'Jupiter', type: 'PLANET', orbits_id: 'sun',
        radius_km: 69911, mass_kg: 1.898e27, albedo: 0.52, bv_index: 0.88,
        orbit: { N: 100.4542, i: 1.3030, w: 273.8777, a: 5.202561, e: 0.048498, M: 19.8950, magBase: -9.40 }
    },
    saturn: {
        id: 'saturn', name: 'Saturn', type: 'PLANET', orbits_id: 'sun',
        radius_km: 58232, mass_kg: 5.68e26, albedo: 0.47, bv_index: 1.04,
        orbit: { N: 113.6634, i: 2.4886, w: 339.3939, a: 9.55475,  e: 0.055546, M: 316.9670, magBase: -8.88 } // globe only, ring contribution excluded
    },
    uranus: {
        id: 'uranus', name: 'Uranus', type: 'PLANET', orbits_id: 'sun',
        radius_km: 25362, mass_kg: 8.68e25, albedo: 0.51, bv_index: 0.56,
        orbit: { N: 74.0005, i: 0.7733, w: 96.6612, a: 19.18171, e: 0.047318, M: 142.5905, magBase: -7.19 }
    },
    neptune: {
        id: 'neptune', name: 'Neptune', type: 'PLANET', orbits_id: 'sun',
        radius_km: 24622, mass_kg: 1.02e26, albedo: 0.41, bv_index: 0.41,
        orbit: { N: 131.7806, i: 1.7700, w: 272.8461, a: 30.05826, e: 0.008606, M: 260.2471, magBase: -6.87 }
    },
    pluto: {
        id: 'pluto', name: 'Pluto', type: 'DWARF_PLANET', orbits_id: 'sun',
        radius_km: 1188, mass_kg: 1.30e22, albedo: 0.50, bv_index: 0.82,
        orbit: { N: 110.30347, i: 17.14175, w: 224.06676, a: 39.48168677, e: 0.24880766, M: 14.86, magBase: -0.45 } // H_V; the old 14.3 was the perihelion-era mean apparent mag
    },
    // Galilean Moons (Approximate Elements relative to Jupiter)
    
    // â”€â”€â”€ EARTH MOON â”€â”€â”€
    luna: {
        id: 'luna', name: 'Moon', type: 'MOON', orbits_id: 'earth',
        radius_km: 1737, mass_kg: 7.34e22, albedo: 0.12, bv_index: 0.92, // Grayish
        // Orbit relative to Earth (Simplified Keplerian)
        orbit: { N: 125.08, i: 5.14, w: 318.06, a: 0.00257, e: 0.0549, M: 115.3654, magBase: 0.21 } // V(1,0): law yields the FULL-MOON value (~ -12.7 at mean distance); phase not modeled
    },

    // â”€â”€â”€ MARS MOONS â”€â”€â”€
    phobos: {
        id: 'phobos', name: 'Phobos', type: 'MOON', orbits_id: 'mars',
        radius_km: 11, mass_kg: 1.06e16, albedo: 0.07, bv_index: 0.70,
        orbit: { N: 0, i: 1.09, w: 0, a: 0.000062, e: 0.0151, M: 0, magBase: 11.8 } // Very faint
    },
    deimos: {
        id: 'deimos', name: 'Deimos', type: 'MOON', orbits_id: 'mars',
        radius_km: 6, mass_kg: 1.47e15, albedo: 0.08, bv_index: 0.70,
        orbit: { N: 0, i: 0.93, w: 0, a: 0.000156, e: 0.0002, M: 0, magBase: 12.9 }
    },

    // â”€â”€â”€ JUPITER MINOR MOONS â”€â”€â”€
    amalthea: {
        id: 'amalthea', name: 'Amalthea', type: 'MOON', orbits_id: 'jupiter',
        radius_km: 83.5, mass_kg: 2.08e18, albedo: 0.09, bv_index: 1.5, // Very Red
        orbit: { N: 0, i: 0.37, w: 0, a: 0.0012, e: 0.003, M: 0, magBase: 7.4 }
    },
    thebe: {
        id: 'thebe', name: 'Thebe', type: 'MOON', orbits_id: 'jupiter',
        radius_km: 49, mass_kg: 4.3e17, albedo: 0.047, bv_index: 0.7,
        orbit: { N: 0, i: 1.07, w: 0, a: 0.00148, e: 0.017, M: 0, magBase: 9.3 }
    },
    himalia: {
        id: 'himalia', name: 'Himalia', type: 'MOON', orbits_id: 'jupiter',
        radius_km: 85, mass_kg: 4.2e18, albedo: 0.04, bv_index: 0.62,
        orbit: { N: 0, i: 27.5, w: 0, a: 0.076, e: 0.16, M: 0, magBase: 7.9 }
    },
    
    // â”€â”€â”€ SATURN MOONS â”€â”€â”€
    titan: {
        id: 'titan', name: 'Titan', type: 'MOON', orbits_id: 'saturn',
        radius_km: 2575, mass_kg: 1.35e23, albedo: 0.22, bv_index: 1.3, // Orange haze
        orbit: { N: 0, i: 0.33, w: 0, a: 0.0081, e: 0.0288, M: 0, magBase: -1.3 }
    },
    enceladus: {
        id: 'enceladus', name: 'Enceladus', type: 'MOON', orbits_id: 'saturn',
        radius_km: 252, mass_kg: 1.08e20, albedo: 0.99, bv_index: 0.60, // Icy white
        orbit: { N: 0, i: 0.00, w: 0, a: 0.0016, e: 0.0047, M: 0, magBase: 2.1 }
    },
    mimas: {
        id: 'mimas', name: 'Mimas', type: 'MOON', orbits_id: 'saturn',
        radius_km: 198, mass_kg: 3.7e19, albedo: 0.96, bv_index: 0.60,
        orbit: { N: 0, i: 1.53, w: 0, a: 0.0012, e: 0.0202, M: 0, magBase: 3.3 }
    },
    rhea: {
        id: 'rhea', name: 'Rhea', type: 'MOON', orbits_id: 'saturn',
        radius_km: 764, mass_kg: 2.3e21, albedo: 0.70, bv_index: 0.65,
        orbit: { N: 0, i: 0.35, w: 0, a: 0.0035, e: 0.0010, M: 0, magBase: 0.1 }
    },
    iapetus: {
        id: 'iapetus', name: 'Iapetus', type: 'MOON', orbits_id: 'saturn',
        radius_km: 734, mass_kg: 1.8e21, albedo: 0.04, bv_index: 0.70, // Two-faced
        orbit: { N: 0, i: 14.72, w: 0, a: 0.0238, e: 0.0283, M: 0, magBase: 1.5 }
    },
    dione: {
        id: 'dione', name: 'Dione', type: 'MOON', orbits_id: 'saturn',
        radius_km: 561, mass_kg: 1.1e21, albedo: 0.70, bv_index: 0.60,
        orbit: { N: 0, i: 0.02, w: 0, a: 0.0025, e: 0.0022, M: 0, magBase: 0.8 }
    },
    tethys: {
        id: 'tethys', name: 'Tethys', type: 'MOON', orbits_id: 'saturn',
        radius_km: 533, mass_kg: 6.17e20, albedo: 0.80, bv_index: 0.60,
        orbit: { N: 0, i: 1.09, w: 0, a: 0.0020, e: 0.0000, M: 0, magBase: 0.6 }
    },

    // â”€â”€â”€ URANUS MOONS â”€â”€â”€
    titania: {
        id: 'titania', name: 'Titania', type: 'MOON', orbits_id: 'uranus',
        radius_km: 788, mass_kg: 3.5e21, albedo: 0.27, bv_index: 0.65,
        orbit: { N: 0, i: 0.34, w: 0, a: 0.0029, e: 0.0011, M: 0, magBase: 1.0 }
    },
    oberon: {
        id: 'oberon', name: 'Oberon', type: 'MOON', orbits_id: 'uranus',
        radius_km: 761, mass_kg: 3.0e21, albedo: 0.23, bv_index: 0.65,
        orbit: { N: 0, i: 0.05, w: 0, a: 0.0039, e: 0.0014, M: 0, magBase: 1.4 }
    },
    umbriel: {
        id: 'umbriel', name: 'Umbriel', type: 'MOON', orbits_id: 'uranus',
        radius_km: 584, mass_kg: 1.2e21, albedo: 0.21, bv_index: 0.65,
        orbit: { N: 0, i: 0.12, w: 0, a: 0.0018, e: 0.0039, M: 0, magBase: 2.3 }
    },
    ariel: {
        id: 'ariel', name: 'Ariel', type: 'MOON', orbits_id: 'uranus',
        radius_km: 578, mass_kg: 1.35e21, albedo: 0.39, bv_index: 0.65,
        orbit: { N: 0, i: 0.26, w: 0, a: 0.0013, e: 0.0012, M: 0, magBase: 1.4 }
    },
    miranda: {
        id: 'miranda', name: 'Miranda', type: 'MOON', orbits_id: 'uranus',
        radius_km: 235, mass_kg: 6.6e19, albedo: 0.32, bv_index: 0.65,
        orbit: { N: 0, i: 4.33, w: 0, a: 0.0008, e: 0.0013, M: 0, magBase: 3.8 }
    },

    // â”€â”€â”€ NEPTUNE MOONS â”€â”€â”€
    triton: {
        id: 'triton', name: 'Triton', type: 'MOON', orbits_id: 'neptune',
        radius_km: 1353, mass_kg: 2.14e22, albedo: 0.76, bv_index: 0.70, // Retrograde orbit
        orbit: { N: 0, i: 156.8, w: 0, a: 0.0023, e: 0.0000, M: 0, magBase: -1.3 }
    },

    // â”€â”€â”€ SATURN MINOR MOONS â”€â”€â”€
    hyperion: {
        id: 'hyperion', name: 'Hyperion', type: 'MOON', orbits_id: 'saturn',
        radius_km: 135, mass_kg: 5.6e18, albedo: 0.3, bv_index: 1.0, // Sponge-like
        orbit: { N: 0, i: 0.56, w: 0, a: 0.0099, e: 0.123, M: 0, magBase: 4.6 }
    },
    phoebe: {
        id: 'phoebe', name: 'Phoebe', type: 'MOON', orbits_id: 'saturn',
        radius_km: 106, mass_kg: 8.3e18, albedo: 0.06, bv_index: 0.6, // Dark
        orbit: { N: 0, i: 173.0, w: 0, a: 0.086, e: 0.164, M: 0, magBase: 6.9 }
    },
    janus: {
        id: 'janus', name: 'Janus', type: 'MOON', orbits_id: 'saturn',
        radius_km: 89, mass_kg: 1.9e18, albedo: 0.7, bv_index: 0.6,
        orbit: { N: 0, i: 0.16, w: 0, a: 0.0010, e: 0.0068, M: 0, magBase: 4.9 }
    },
    epimetheus: {
        id: 'epimetheus', name: 'Epimetheus', type: 'MOON', orbits_id: 'saturn',
        radius_km: 58, mass_kg: 5.2e17, albedo: 0.7, bv_index: 0.6,
        orbit: { N: 0, i: 0.35, w: 0, a: 0.0010, e: 0.0098, M: 0, magBase: 5.9 }
    }
};

