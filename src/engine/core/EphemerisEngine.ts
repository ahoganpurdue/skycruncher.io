import { CELESTIAL_DB, CelestialConstants, OrbitalElements } from './celestial_data';
import { SolarBody } from '../types/Main_types';
import { TimeService } from './TimeService';
import { UnitConverter } from './UnitConverter';

// WebAssembly Compute Module
import * as wasm from '@/engine/wasm_compute/pkg/wasm_compute';

interface Vector3 { x: number; y: number; z: number; }

const FAINT_MOON_MAG_CUTOFF = 12;

let _cache: { key: string; result: SolarBody[] } | null = null;

export class EphemerisEngine {

    /**
     * Solves for the geocentric position and physical properties of all bodies.
     * Results are cached by (date, lat, lon) — safe to call from multiple pipeline stages.
     */
    public static calculateSolarSystem(date: Date, lat: number, lon: number): SolarBody[] {
        const cacheKey = `${date.getTime()}|${lat}|${lon}`;
        if (_cache && _cache.key === cacheKey) return _cache.result;
        const result = this._computeSolarSystem(date, lat, lon);
        _cache = { key: cacheKey, result };
        return result;
    }

    private static _computeSolarSystem(date: Date, lat: number, lon: number): SolarBody[] {
        if (isNaN(date.getTime())) {
            console.warn(`[EphemerisEngine] Invalid date passed to ephemeris calculation.`);
            return [];
        }

        const d = TimeService.toDayssinceJ2000(date);
        const jd = TimeService.toJulianDate(date);
        
        // Prepare batch for WASM
        const wasmBodies = Object.values(CELESTIAL_DB).map(c => ({
            id: c.id,
            name: c.name,
            type: c.type,
            orbits_id: c.orbits_id || null,
            radius_km: c.radius_km,
            mass_kg: c.mass_kg,
            bv_index: c.bv_index,
            n: c.orbit?.N ?? 0,
            i: c.orbit?.i ?? 0,
            w: c.orbit?.w ?? 0,
            a: c.orbit?.a ?? 0,
            e: c.orbit?.e ?? 0,
            m: this.epochAdjustedMeanAnomaly(c, d),
            mag_base: c.orbit?.magBase ?? 20
        }));

        // Execute batch solve
        const wasmResults = (wasm as any).batch_solve_ephemeris(wasmBodies, lat, lon, d, jd);

        // Map results back to SolarBody[]
        const bodies: SolarBody[] = wasmResults.map((res: any) => {
            const c = CELESTIAL_DB[res.id];
            return {
                id: res.id,
                name: c.name,
                type: c.type,
                ra: res.ra,
                dec: res.dec,
                mag: res.mag,
                dist_au: res.dist_au,
                radius_arcsec: res.radius_arcsec,
                radius_km: c.radius_km,
                mass_kg: c.mass_kg,
                color: this.bvToHex(c.bv_index),
                altitude: res.alt,
                azimuth: res.az
            };
        });

        return bodies;
    }

    public static getMoonStatus(date: Date, lat: number, lon: number) {
        const jd = TimeService.toJulianDate(date);
        const d = jd - TimeService.J2000;
        
        // Simple Moon Phase (Synodic month: 29.53059 days)
        const lunarAge = (d % 29.530589) / 29.530589;
        const phaseIntensity = 1 - Math.abs(lunarAge - 0.5) * 2;

        const bodies = this.calculateSolarSystem(date, lat, lon);
        const moon = bodies.find(b => b.id === 'luna');
        const sun = bodies.find(b => b.id === 'sun');

        return {
            phase: lunarAge,
            intensity: phaseIntensity,
            altitude: moon?.altitude ?? -90,
            azimuth: moon?.azimuth ?? 0,
            is_daylight: (sun?.altitude ?? -90) > -0.83,
            is_twilight: (sun?.altitude ?? -90) > -18 && (sun?.altitude ?? -90) <= -0.83
        };
    }

    // â”€â”€â”€ PRIVATE MATH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * The Kepler solver (WASM and its test mock) derives mean motion from
     * Kepler's third law with the SUN's GM: n = 0.9856/a^1.5 deg/day. For
     * satellites (Moon, Galilean moons, ...) the central body is not the Sun,
     * so that rate is wrong by sqrt(M_sun/M_parent) - the Moon would advance
     * ~7564 deg/day instead of 13.06 deg/day (i.e. a random position).
     *
     * Rather than rebuild the WASM, pre-compensate the epoch mean anomaly so
     * that M' + n_wasm*d === M + n_true*(d + 1.5) for the requested date d.
     *
     * The extra +1.5 days: the CELESTIAL_DB elements are Schlyter-epoch
     * (d0 = JD 2451543.5, 1999-12-31 00:00 UTC — e.g. Neptune M=260.2471,
     * Moon M=115.3654 match Schlyter's tables exactly), while TimeService
     * measures d from J2000 (JD 2451545.0). Harmless for planets (<1 deg)
     * but a ~19.6 deg error for the fast-moving Moon.
     */
    private static epochAdjustedMeanAnomaly(c: any, d: number): number {
        const M = c.orbit?.M ?? 0;
        const a = c.orbit?.a ?? 0;
        if (a <= 0) return M;

        const SCHLYTER_EPOCH_OFFSET_DAYS = 1.5; // J2000 - JD2451543.5
        const SUN_MASS_KG = 1.989e30;
        const parentId = c.orbits_id;
        const nWasm = 0.9856076686 / Math.pow(a, 1.5);
        // Heliocentric bodies: the WASM rate is already correct. The Moon uses
        // the standard (Schlyter) anomalistic rate; other satellites scale by
        // the parent mass (their positions are decorative markers).
        const nTrue = (!parentId || parentId === 'sun')
            ? nWasm
            : (c.id === 'luna'
                ? 13.0649929509
                : nWasm * Math.sqrt((CELESTIAL_DB[parentId]?.mass_kg ?? SUN_MASS_KG) / SUN_MASS_KG));

        let mPrime = (M + nTrue * SCHLYTER_EPOCH_OFFSET_DAYS + (nTrue - nWasm) * d) % 360;
        if (mPrime < 0) mPrime += 360;
        return mPrime;
    }

    private static bvToHex(bv: number): string {
        if (bv < 0.0) return '#9bb0ff';
        if (bv < 0.3) return '#aabfff';
        if (bv < 0.5) return '#cad7ff';
        if (bv < 0.6) return '#f8f7ff';
        if (bv <= 0.8) return '#fff4ea';
        if (bv < 1.1) return '#ffd2a1';
        if (bv < 1.5) return '#ffcc6f';
        return '#ff6f35';
    }
}

