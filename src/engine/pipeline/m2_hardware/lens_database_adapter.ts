
import { LensfunIngestor, LensProfile } from './lensfun_ingestor';

/**
 * ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
 * LENS DATABASE ADAPTER ΓÇö The Distortion Oracle
 * ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
 * 
 * Provides generic distortion profiles (k1, k2, k3) for a given lens.
 * Uses Lensfun data as the source of truth.
 */

export interface DistortionProfile {
    k1: number;
    k2: number;
    k3: number;
    p1: number;
    p2: number;
    model: 'ptlens' | 'poly3' | 'poly5';
    source: string; // e.g., "Lensfun: Samyang 14mm"
}

export class LensDatabaseAdapter {

    private static db: LensProfile[] = [];
    private static isInitialized = false;

    /**
     * Initializes the database.
     * In a real app, this would load a cached JSON.
     * For this implementation, we ingest live (or mock if offline).
     */
    public static async init() {
        if (this.isInitialized) return;
        
        try {
            console.log('[LensDatabaseAdapter] Initializing...');
            this.db = await LensfunIngestor.ingest();
            this.isInitialized = true;
            console.log(`[LensDatabaseAdapter] Ready with ${this.db.length} profiles.`);
        } catch (err) {
            console.error('[LensDatabaseAdapter] Initialization failed:', err);
        }
    }

    /**
     * Retrieves the best matching distortion profile for a given lens and focal length.
     * Interpolates between available focal lengths if necessary.
     */
    public static getDistortionProfile(
        make: string, 
        model: string, 
        focalLength: number
    ): DistortionProfile | null {
        if (!this.isInitialized) {
            console.warn('[LensDatabaseAdapter] Database not initialized. Call init() first.');
            return null;
        }

        // 1. Find Profile
        // We use the Ingestor's helper which handles aliasing
        // But wait, `findProfile` was inside Ingestor. Let's make sure it's exported or move logic here.
        // It was `public static`.
        
        // We need to pass the DB instance to it? Or copy the logic?
        // `LensfunIngestor.findProfile(this.db, ...)` would be ideal if static helper.
        // I implemented it as `findProfile(db, make, model)`.
        
        const profile = LensfunIngestor.findProfile(this.db, make, model);
        
        if (!profile || !profile.calibration.distortion || profile.calibration.distortion.length === 0) {
            return null;
        }

        // 2. Find closest focal lengths
        const distortions = profile.calibration.distortion.sort((a, b) => a.focalLength - b.focalLength);
        
        // Exact match or single entry
        if (distortions.length === 1) {
            const d = distortions[0];
            return {
                k1: d.k1,
                k2: d.k2,
                k3: d.k3,
                p1: 0,
                p2: 0,
                model: d.model,
                source: `Lensfun: ${profile.make} ${profile.model}`
            };
        }

        // Interpolation
        // Find lower and upper bounds
        let lower = distortions[0];
        let upper = distortions[distortions.length - 1];

        for (let i = 0; i < distortions.length - 1; i++) {
            if (focalLength >= distortions[i].focalLength && focalLength <= distortions[i+1].focalLength) {
                lower = distortions[i];
                upper = distortions[i+1];
                break;
            }
        }

        // Extrapolation (clamp to nearest)
        if (focalLength <= lower.focalLength) return this.mapToProfile(lower, profile);
        if (focalLength >= upper.focalLength) return this.mapToProfile(upper, profile);

        // Linear Interpolation
        const t = (focalLength - lower.focalLength) / (upper.focalLength - lower.focalLength);
        
        return {
            k1: this.lerp(lower.k1, upper.k1, t),
            k2: this.lerp(lower.k2, upper.k2, t),
            k3: this.lerp(lower.k3, upper.k3, t),
            p1: 0,
            p2: 0,
            model: lower.model, // Assume model type doesn't change
            source: `Lensfun (Interpolated): ${profile.make} ${profile.model}`
        };
    }

    private static mapToProfile(d: { k1: number, k2: number, k3: number, model: any }, p: LensProfile): DistortionProfile {
        return {
            k1: d.k1,
            k2: d.k2,
            k3: d.k3,
            p1: 0,
            p2: 0,
            model: d.model,
            source: `Lensfun: ${p.make} ${p.model}`
        };
    }

    private static lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }
}

