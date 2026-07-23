import { SignalPoint, SolarBody } from '../../types/Main_types';
import { StarCatalogAdapter } from '../m6_plate_solve/star_catalog_adapter';
import { AstrometryEngine } from './astrometry_engine';
import { UnitConverter } from '../../core/UnitConverter';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { OpticsManager } from '../../core/optics_manager';

/**
 * METROLOGY SERVICE â€” The Mechanical "Ruler" of the Pipeline
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * RESPONSIBILITY:
 * 1. Agnostic Scale inference (The Tri-Lock): Determine arcsec/px without EXIF.
 * 2. Ephemeris Guest List: Identify planets/moons/satellites in the FOV.
 * 3. Optical Drift Analysis: Detect lens distortion before it hits the solver.
 */
export class MetrologyService {

    /**
     * TRI-LOCK SCALE SOLVER
     * Uses ratios of side lengths of Vanguard triangles to match the catalog.
     * Scale-invariant, Rotation-invariant, Translation-invariant.
     */
    public static async solveScale(vanguard: SignalPoint[], focalLengthHint?: number, pixelPitchHint?: number): Promise<number | null> {
        if (vanguard.length < 3) return null;
        
        let targetScale: number | null = null;
        // Last-resort PRIORS (named + documented, NOT measurements): only used
        // when the caller passed no EXIF-derived hint. See OpticsManager for the
        // misfire caveats (wide-field FL prior; APS-C pitch mis-scales FF bodies).
        const assumedFocalLength = focalLengthHint || OpticsManager.WIDE_FIELD_FL_PRIOR_MM;
        const assumedPitch = pixelPitchHint || OpticsManager.FALLBACK_PITCH_UM;
        // arcsec/px = (pixel_size / focal_length) * 206265
        targetScale = (assumedPitch / (assumedFocalLength * 1000)) * 206265;
        console.log(`[Metrology] Seeding Tri-Lock with scale hint: ${targetScale.toFixed(2)}"/px (${assumedFocalLength}mm @ ${assumedPitch.toFixed(2)}um)`);

        // Ensure catalog Level 1 (Anchors) is available
        const adapter = StarCatalogAdapter.getinstance();
        await adapter.loadCatalog();
        const catalog = adapter.getStars().filter(s => s.magnitude_V < 3.5);

        // Sort vanguard by flux (brightest first) and take top 8
        const anchors = [...vanguard]
            .sort((a, b) => b.flux - a.flux)
            .slice(0, 8);

        // â”€â”€ WASM Dispatch â”€â”€
        const wasm = await import('@/engine/wasm_compute/pkg/wasm_compute');
        await wasm.default(); // Initialize WASM memory

        const anchorsX = new Float64Array(anchors.length);
        const anchorsY = new Float64Array(anchors.length);
        const anchorsB = new Float64Array(anchors.length);
        for (let i = 0; i < anchors.length; i++) {
            anchorsX[i] = anchors[i].x;
            anchorsY[i] = anchors[i].y;
            anchorsB[i] = anchors[i].flux;
        }

        const atlasRa = new Float64Array(catalog.length);
        const atlasDec = new Float64Array(catalog.length);
        const atlasMag = new Float64Array(catalog.length);
        for (let i = 0; i < catalog.length; i++) {
            atlasRa[i] = catalog[i].ra_hours * 15; // Convert hours to degrees for WASM
            atlasDec[i] = catalog[i].dec_degrees;
            atlasMag[i] = catalog[i].magnitude_V;
        }

        const startTime = performance.now();
        const result = wasm.solve_blind(anchorsX, anchorsY, anchorsB, atlasRa, atlasDec, atlasMag, targetScale || 0.0);
        const elapsed = performance.now() - startTime;

        if (result.match_count > 0 && result.scale > 0.0) {
            console.log(`[Metrology] [LOCK] WASM Tri-Lock Confirmed: ${result.scale.toFixed(2)}"/px (${result.match_count} matches) in ${elapsed.toFixed(1)}ms`);
            return result.scale;
        }
        
        console.warn(`[Metrology] WASM Tri-Lock failed to find scale in ${elapsed.toFixed(1)}ms`);
        return null;
    }

    /**
     * EPHEMERIS GUEST LIST
     */
    public static async getGuestList(date: Date, lat: number, lon: number): Promise<SolarBody[]> {
        // Retrieve visible bodies from SolarSystem
        const { SolarSystem } = await import('../m6_plate_solve/solar_system');
        return SolarSystem.getVisibleBodies(date, lat, lon)
            .filter(b => (b.altitude ?? -90) > -1.0);
    }
}

