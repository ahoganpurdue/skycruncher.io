import { EphemerisEngine } from '../../core/EphemerisEngine';

/**
 * EphemerisAdapter: Predicts the "Natural" light sources in the sky.
 * Part of Phase 15: Environmental Forensics.
 */
export class EphemerisAdapter {
    /**
     * Calculates Sun/Moon status to set the "Natural Baseline" for the SkyCruncher.
     */
    public static getCelestialContext(lat: number, lon: number, date: Date) {
        const status = EphemerisEngine.getMoonStatus(date, lat, lon);

        return {
            is_daylight: status.is_daylight,
            is_twilight: status.is_twilight,
            moon_phase: status.phase,
            moon_altitude: status.altitude,
            moon_intensity: status.intensity,
            natural_glow_vector: status.altitude > 0 ? { alt: status.altitude, az: status.azimuth } : null
        };
    }

    // Removed stubs in favor of EphemerisEngine
}

