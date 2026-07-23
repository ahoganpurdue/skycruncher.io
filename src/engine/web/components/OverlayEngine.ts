/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * OVERLAY ENGINE â€” Star Positioning & Label Logic
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * Pure logic module (no React). Manages:
 *   - Star selection and ranking for the overlay
 *   - Pixel positioning via WCS transform
 *   - JPEG re-mapping (scaling WCS coords to different image dimensions)
 *   - Star data formatting for hover popups
 *   - Canvas export (bake labels into image)
 *
 * This is separated from the React component so it can be tested
 * independently and potentially used in non-React contexts (e.g., Node.js
 * batch processing, video frame labeling).
 */

import type { PlateSolution, MatchedStar } from '../../types/Main_types';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A star ready for overlay display, positioned in pixel coordinates. */
export interface OverlayStar {
    /** Star index in the matched star list */
    index: number;
    /** Pixel X position on the image */
    x: number;
    /** Pixel Y position on the image */
    y: number;
    /** Display name (proper name or Gaia ID) */
    name: string;
    /** Visual magnitude */
    magnitude: number;
    /** B-V color index (determines marker color) */
    bv: number;
    /** Spectral type (e.g., "G2V", "M1III") */
    spectralType: string;
    /** distance in light-years (null if unknown) */
    distanceLy: number | null;
    /** Gaia DR3 source ID */
    gaiaId: string;
    /** Right Ascension (hours) */
    ra: number;
    /** Declination (degrees) */
    dec: number;
    /** Marker radius in pixels (scaled by magnitude) */
    markerRadius: number;
    /** Marker color as CSS string (derived from B-V index) */
    markerColor: string;
    /** Whether this is a planetary match */
    isPlanet: boolean;
    /** X residual component (catalog - detected) */
    dx?: number;
    /** Y residual component (catalog - detected) */
    dy?: number;
}

/** Data for the star hover/click popup. */
export interface StarPopupData {
    name: string;
    gaiaId: string;
    ra: string;
    dec: string;
    magnitude: string;
    bvIndex: string;
    spectralType: string;
    distance: string;
    constellation: string;
}

/** Dimensions for image scaling. */
export interface ImageDimensions {
    width: number;
    height: number;
}

// â”€â”€â”€ B-V TO COLOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Convert B-V color index to an RGB CSS color string.
 * Uses Ballesteros (2012) approximation for star colors.
 *
 * B-V < 0.0  â†’ Blue-white (O/B stars)
 * B-V â‰ˆ 0.0  â†’ White (A stars)
 * B-V â‰ˆ 0.5  â†’ Yellow-white (F/G stars)
 * B-V â‰ˆ 1.0  â†’ Orange (K stars)
 * B-V > 1.5  â†’ Red (M stars)
 */
export function bvToColor(bv: number): string {
    // Clamp B-V to valid range
    const t = Math.max(-0.4, Math.min(bv, 2.0));

    let r: number, g: number, b: number;

    if (t < 0.0) {
        // Hot blue stars
        r = 0.6 + t * 0.5;
        g = 0.7 + t * 0.3;
        b = 1.0;
    } else if (t < 0.4) {
        // White to yellow-white
        r = 1.0;
        g = 1.0 - t * 0.3;
        b = 1.0 - t * 1.5;
    } else if (t < 1.0) {
        // Yellow to orange
        r = 1.0;
        g = 0.88 - (t - 0.4) * 0.6;
        b = 0.4 - (t - 0.4) * 0.5;
    } else {
        // Orange to red
        r = 1.0;
        g = Math.max(0.15, 0.52 - (t - 1.0) * 0.4);
        b = Math.max(0.0, 0.1 - (t - 1.0) * 0.1);
    }

    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Get a glow color (slightly brighter, more saturated) for the star marker's
 * outer ring / drop-shadow.
 */
export function bvToGlowColor(bv: number): string {
    const base = bvToColor(bv);
    // Parse hex and brighten
    const r = Math.min(255, parseInt(base.slice(1, 3), 16) + 40);
    const g = Math.min(255, parseInt(base.slice(3, 5), 16) + 40);
    const b = Math.min(255, parseInt(base.slice(5, 7), 16) + 40);
    return `rgb(${r}, ${g}, ${b})`;
}

// â”€â”€â”€ STAR NAME LOOKUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Common star names by approximate RA/Dec.
 * This is a simplified lookup â€” in production, you'd query the HYG catalog.
 */
const NAMED_STARS: { name: string; ra: number; dec: number; radius: number }[] = [
    { name: 'Sirius',      ra: 6.752,  dec: -16.72,  radius: 0.5 },
    { name: 'Betelgeuse',  ra: 5.919,  dec:   7.41,  radius: 0.5 },
    { name: 'Rigel',       ra: 5.242,  dec:  -8.20,  radius: 0.5 },
    { name: 'Vega',        ra: 18.615, dec:  38.78,  radius: 0.5 },
    { name: 'Capella',     ra: 5.278,  dec:  46.00,  radius: 0.5 },
    { name: 'Arcturus',    ra: 14.261, dec:  19.18,  radius: 0.5 },
    { name: 'Procyon',     ra: 7.655,  dec:   5.22,  radius: 0.5 },
    { name: 'Altair',      ra: 19.846, dec:   8.87,  radius: 0.5 },
    { name: 'Aldebaran',   ra: 4.599,  dec:  16.51,  radius: 0.5 },
    { name: 'Spica',       ra: 13.420, dec: -11.16,  radius: 0.5 },
    { name: 'Antares',     ra: 16.490, dec: -26.43,  radius: 0.5 },
    { name: 'Pollux',      ra: 7.755,  dec:  28.03,  radius: 0.5 },
    { name: 'Fomalhaut',   ra: 22.961, dec: -29.62,  radius: 0.5 },
    { name: 'Deneb',       ra: 20.690, dec:  45.28,  radius: 0.5 },
    { name: 'Regulus',     ra: 10.140, dec:  11.97,  radius: 0.5 },
    { name: 'Castor',      ra: 7.577,  dec:  31.89,  radius: 0.5 },
    { name: 'Bellatrix',   ra: 5.419,  dec:   6.35,  radius: 0.5 },
    { name: 'Polaris',     ra: 2.530,  dec:  89.26,  radius: 0.5 },
    { name: 'Canopus',     ra: 6.399,  dec: -52.70,  radius: 0.5 },
    { name: 'Achernar',    ra: 1.629,  dec: -57.24,  radius: 0.5 },
];

/**
 * Look up a common star name by RA/Dec proximity.
 */
function lookupStarName(raHours: number, decDeg: number): string | null {
    for (const star of NAMED_STARS) {
        const raDist = Math.abs(raHours - star.ra);
        const decDist = Math.abs(decDeg - star.dec);
        if (raDist < star.radius && decDist < star.radius) {
            return star.name;
        }
    }
    return null;
}

// â”€â”€â”€ CORE FUNCTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Select and position the top N brightest stars for the overlay.
 *
 * @param solution - Plate solution with matched stars and WCS
 * @param maxStars - Maximum number of stars to display (default: 20)
 * @returns Sorted array of OverlayStar objects, positioned in pixel coords
 */
export function computeOverlayStars(
    solution: PlateSolution,
    maxStars: number = 20
): OverlayStar[] {
    if (!solution.matched_stars || solution.matched_stars.length === 0) return [];

    // Deduplicate by Gaia ID (or name/position if missing)
    const uniqueStars = new Map<string, MatchedStar>();
    for (const star of solution.matched_stars) {
        // Use Gaia ID as primary key, fallback to RA/Dec string
        const ra = star.catalog.ra_hours ?? 0;
        const dec = star.catalog.dec_degrees ?? 0;
        const key = star.catalog.gaia_id || `${ra.toFixed(4)}_${dec.toFixed(4)}`;
        if (!uniqueStars.has(key)) {
            uniqueStars.set(key, star);
        }
    }

    // Sort by brightness (lower magnitude = brighter)
    const sorted = Array.from(uniqueStars.values())
        .sort((a, b) => a.catalog.mag - b.catalog.mag)
        .slice(0, maxStars);

    // Magnitude range for scaling marker sizes
    const magMin = sorted[0]?.catalog.mag ?? 0;
    const magMax = sorted[sorted.length - 1]?.catalog.mag ?? 6;
    const magRange = Math.max(magMax - magMin, 0.1);

    return sorted.map((matched: MatchedStar, index: number): OverlayStar => {
        // Estimate B-V from magnitude (simplified â€” real version uses photometry)
        const bv = estimateBV(matched.catalog.mag);

        // Marker radius: brighter stars get larger markers (inverted scale)
        const brightnessNorm = 1 - (matched.catalog.mag - magMin) / magRange;
        const markerRadius = 4 + brightnessNorm * 12; // 4px to 16px

        // Try to find a common name
        const ra = matched.catalog.ra_hours ?? 0;
        const dec = matched.catalog.dec_degrees ?? 0;
        
        const name = matched.catalog.name
            || lookupStarName(ra, dec)
            || `Gaia ${matched.catalog.gaia_id ?? 'Unknown'}`;

        return {
            index,
            x: matched.detected.x,
            y: matched.detected.y,
            name,
            magnitude: matched.catalog.mag,
            bv,
            spectralType: guessSpectralType(bv),
            distanceLy: null, // Would come from catalog lookup
            gaiaId: matched.catalog.gaia_id ?? 'Unknown',
            ra: ra,
            dec: dec,
            markerRadius,
            markerColor: bvToColor(bv),
            isPlanet: matched.catalog.gaia_id?.startsWith('planet_') || false,
            dx: matched.residual?.dx,
            dy: matched.residual?.dy
        };
    });
}

/**
 * Re-map overlay star positions from the RAW image to a JPEG of different dimensions.
 * Uses simple proportional scaling since the WCS is the same.
 *
 * @param stars          - Stars from computeOverlayStars (RAW positions)
 * @param rawDimensions  - Original RAW image dimensions
 * @param jpegDimensions - JPEG image dimensions
 * @returns Stars with updated x/y positions for the JPEG
 */
export function mapOverlayToJPEG(
    stars: OverlayStar[],
    rawDimensions: ImageDimensions,
    jpegDimensions: ImageDimensions,
    uiScale?: number
): OverlayStar[] {
    // 1. Native -> Preview
    const factor = uiScale ?? (jpegDimensions.width / rawDimensions.width);
    const pW = rawDimensions.width * factor;
    const pH = rawDimensions.height * factor;

    // 2. Preview -> Canvas (Proportional fit)
    const canvasScale = Math.min(jpegDimensions.width / pW, jpegDimensions.height / pH);
    const ox = (jpegDimensions.width - pW * canvasScale) / 2;
    const oy = (jpegDimensions.height - pH * canvasScale) / 2;

    const totalScale = factor * canvasScale;

    return stars.map(star => ({
        ...star,
        x: star.x * totalScale + ox,
        y: star.y * totalScale + oy,
        markerRadius: star.markerRadius * totalScale,
        dx: star.dx ? star.dx * totalScale : undefined,
        dy: star.dy ? star.dy * totalScale : undefined
    }));
}

/**
 * Generate formatted popup data for a star.
 */
export function generateStarPopup(star: OverlayStar): StarPopupData {
    const raH = Math.floor(star.ra);
    const raM = Math.floor((star.ra - raH) * 60);
    const raS = ((star.ra - raH - raM / 60) * 3600).toFixed(1);

    const decSign = star.dec >= 0 ? '+' : '-';
    const decD = Math.floor(Math.abs(star.dec));
    const decM = Math.floor((Math.abs(star.dec) - decD) * 60);

    return {
        name: star.name,
        gaiaId: star.gaiaId,
        ra: `${raH}h ${raM}m ${raS}s`,
        dec: `${decSign}${decD}° ${decM}'`,
        magnitude: star.magnitude.toFixed(2),
        bvIndex: star.bv.toFixed(3),
        spectralType: star.spectralType,
        distance: star.distanceLy !== null
            ? `${star.distanceLy.toFixed(1)} ly`
            : 'Unknown',
        constellation: '--', // Would come from constellation boundary lookup
    };
}

/**
 * Bake star labels and markers onto a canvas for PNG export.
 * This creates the "Astro-Postcard" â€” the exportable tagged image.
 *
 * @param canvas - Target canvas element (should already have the image drawn)
 * @param stars  - Positioned overlay stars
 * @param options - Export options
 * @returns The canvas context (caller can toBlob() for download)
 */
export function bakeOverlayToCanvas(
    canvas: HTMLCanvasElement,
    stars: OverlayStar[],
    options: {
        showBadge?: boolean;
        contributorName?: string;
        isContributor?: boolean;
    } = {}
): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Draw star markers and labels
    for (const star of stars) {
        // Outer glow
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.markerRadius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = bvToGlowColor(star.bv);
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4;
        ctx.stroke();

        // Inner ring
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.markerRadius, 0, Math.PI * 2);
        ctx.strokeStyle = star.markerColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.stroke();

        // Center dot
        ctx.beginPath();
        ctx.arc(star.x, star.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = star.markerColor;
        ctx.globalAlpha = 1.0;
        ctx.fill();

        // Label
        ctx.font = '11px "Inter", "Segoe UI", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 3;

        // Position label to the right of the marker, offset slightly
        const labelX = star.x + star.markerRadius + 6;
        const labelY = star.y + 4;
        ctx.fillText(star.name, labelX, labelY);

        // Magnitude below the name
        ctx.font = '9px "Inter", "Segoe UI", sans-serif';
        ctx.fillStyle = '#aaaacc';
        ctx.fillText(`mag ${star.magnitude.toFixed(1)}`, labelX, labelY + 13);

        ctx.shadowBlur = 0;
    }

    // Scientific Contributor badge (if opted in)
    if (options.showBadge && options.isContributor) {
        const badgeY = canvas.height - 40;
        const badgeX = canvas.width - 220;

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(10, 12, 30, 0.7)';
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, 210, 30, 6);
        ctx.fill();

        ctx.globalAlpha = 1.0;
        ctx.font = 'bold 10px "Inter", sans-serif';
        ctx.fillStyle = '#7dd3fc';
        ctx.fillText('â­ Scientific Contributor', badgeX + 10, badgeY + 19);

        if (options.contributorName) {
            ctx.font = '9px "Inter", sans-serif';
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(options.contributorName, badgeX + 160, badgeY + 19);
        }
    }

    // SKYCRUNCHER watermark
    ctx.globalAlpha = 0.5;
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('SKYCRUNCHER', 10, canvas.height - 10);
    ctx.globalAlpha = 1.0;

    return ctx;
}

// â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Estimate B-V color index from magnitude.
 * This is a rough approximation â€” proper photometry uses multi-band data.
 */
function estimateBV(magnitude: number): number {
    // Use magnitude as a rough proxy for B-V
    // (brighter main-sequence stars tend to be bluer)
    if (magnitude < 1) return -0.1;  // Bright blue
    if (magnitude < 3) return 0.3;   // Yellow-white
    if (magnitude < 5) return 0.7;   // Yellow-orange
    return 1.2;                       // Red
}

/**
 * Guess spectral type from B-V color index.
 */
function guessSpectralType(bv: number): string {
    if (bv < -0.3) return 'O';
    if (bv < -0.1) return 'B';
    if (bv <  0.0) return 'A0V';
    if (bv <  0.3) return 'A5V';
    if (bv <  0.5) return 'F5V';
    if (bv <  0.7) return 'G2V';
    if (bv <  1.0) return 'K0III';
    if (bv <  1.5) return 'K5III';
    return 'M2III';
}

