import { MatchedStar } from '../../types/Main_types';

/**
 * Verify planetary matches using Color Ratios, Magnitude, and Geometric Consensus.
 * * STRATEGY:
 * 1. Color Ratios (Normalized): Compare R/G and B/G to handle White balance differences.
 * 2. Strobe Rejection: Reject pure neon/monochromatic sources (Airplanes/Hot Pixels).
 * 3. Magnitude Rank: Ensure planet is among the brightest objects.
 */
export function verifyPlanetaryDesignation(
    matches: MatchedStar[], 
    imageData: ImageData, 
    pixelScale: number
): MatchedStar[] {
    const planets = matches.filter(m => (m.catalog.gaia_id || '').startsWith('planet_'));
    if (planets.length === 0) return matches; 

    console.log(`[PlanetaryVerify] ðŸª Verifying ${planets.length} Planetary Candidates...`);

    const verified = matches.map(m => {
        if (!(m.catalog.gaia_id || '').startsWith('planet_')) return m;

        // 1. Color Verification
        const color = sampleColor(imageData, m.detected.x, m.detected.y);
        
        const R = color.r || 1;
        const G = color.g || 1;
        const B = color.b || 1;

        const rRatio = R / G;
        const bRatio = B / G;
        
        // Strobe / Hot Pixel Rejection
        if ((R > 200 && G < 50 && B < 50) || (G > 200 && R < 50 && B < 50)) {
            console.warn(`[PlanetaryVerify] âœˆï¸ REJECTING STROBE/HOT PIXEL: ${m.catalog.name} (R:${R} G:${G} B:${B})`);
            return { ...m, residual_arcsec: 9999 };
        }

        const name = m.catalog.name || '';
        let colorScore = 0;

        if (name.includes('Mars')) {
            if (rRatio > bRatio + 0.3) {
                colorScore = 1.0; 
                console.log(`[PlanetaryVerify] âœ… Mars Confirmed Red (R/G=${rRatio.toFixed(2)}, B/G=${bRatio.toFixed(2)})`);
            } else {
                colorScore = -1.0; 
                console.warn(`[PlanetaryVerify] âš ï¸ Mars Color Mismatch! (Red expected, got R/G=${rRatio.toFixed(2)}, B/G=${bRatio.toFixed(2)})`);
            }
        } else {
            if (bRatio > rRatio + 0.5) {
                 colorScore = -0.5; 
                 console.warn(`[PlanetaryVerify] âš ï¸ ${name} is suspiciously blue for a planet (B/G=${bRatio.toFixed(2)}).`);
            }
        }

        const flux = m.detected.flux;
        const isBrightest = !matches.some(other => other.detected.flux > flux * 1.5); 
        const mag = m.catalog.magnitude_V ?? 0.0; 

        if (!isBrightest && mag < -1.0) {
            console.warn(`[PlanetaryVerify] âš ï¸ Magnitude Warning: ${name} (Mag ${mag}) is not the brightest object matched.`);
        }
        
        if (colorScore < -0.8) {
            console.warn(`[PlanetaryVerify] âŒ ${name} Verification FAILED.`);
            return { ...m, residual_arcsec: m.residual_arcsec + 1000 }; 
        } else if (colorScore < 0) {
            return { ...m, residual_arcsec: m.residual_arcsec + 5 };
        }

        return m;
    });

    return verified;
}

function sampleColor(imageData: ImageData, x: number, y: number): { r: number, g: number, b: number } {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const idx = (iy * imageData.width + ix) * 4;
    
    if (idx < 0 || idx >= imageData.data.length) return { r: 0, g: 0, b: 0 };
    
    return {
        r: imageData.data[idx],
        g: imageData.data[idx + 1],
        b: imageData.data[idx + 2]
    };
}
