/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * STANDARD STARS â€” Photometric reference Catalog
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * These are the "Standard Candles" of SKYCRUNCHER â€” stars with
 * well-characterized colors that serve as calibration anchors.
 *
 * When we measure a star's color through a user's camera and atmosphere,
 * we compare it to the KNOWN color of a nearby standard star.
 * The difference is the "Spectral Shift" â€” the systematic error
 * introduced by the atmosphere + hardware.
 *
 * B-V Color Index:
 *   Negative â†’ Blue/hot star (O, B types)
 *   0.00     â†’ White (A0V, Vega-like)
 *   Positive â†’ Red/cool star (K, M types)
 */

import { planckianXY } from '../../core/colormath';
import type { CatalogBand } from '../../types/Main_types';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface StandardStar {
  /** Common name */
  name: string;
  /** Gaia DR3 source ID (or legacy catalog ID) */
  gaia_id: string;
  /** Right Ascension in decimal hours (J2000) */
  ra_hours: number;
  /** Declination in decimal degrees (J2000) */
  dec_degrees: number;
  /** Visual magnitude (V-band) */
  magnitude_V: number;
  /** B-V color index */
  color_index_BV: number;
  /**
   * [SCHEMA B] Catalog photometric band the `magnitude_V` field actually holds,
   * discriminated per row (the hybrid-atlas trap antidote): Gaia rows carry Gaia G
   * in magnitude_V; legacy HYG / hardcoded standards carry Johnson V; the Tycho/Hip
   * bright supplement carries native VT/BT/Hp. NEVER pool across bands (the inter-
   * system offsets would masquerade as scatter). Optional (honest-absent when the
   * source band is unknown). See {@link CatalogBand}.
   */
  band?: CatalogBand;
  /**
   * [SCHEMA B] Tycho-2 B_T − V_T color, carried through additively from supplement
   * rows that provide it (NOT fabricated, NOT transformed into bp_rp — color
   * consumers may derive an APPROXIMATE index later under LAW 3). Absent otherwise.
   */
  bt_vt?: number;
  /** Spectral classification */
  spectral_type: string;
  /** Estimated effective temperature (Kelvin) */
  temperature_K: number;
  /** Expected CIE 1931 xy chromaticity (from Planckian approximation) */
  expected_xy: { x: number; y: number };
  /** Proper Motion in RA (mas/yr) * cos(dec) */
  pmra: number;
  /** Proper Motion in Dec (mas/yr) */
  pmdec: number;
  /** Radial Velocity (km/s) */
  rv_kms: number | null;
  /** Constellation (for user-facing display) */
  constellation: string;
  /** Optional: Spectral signature for planetary verification */
  spectral_signature?: { r: number; g: number; b: number };
  /** Pre-calculated cos(dec) in radians for fast radial lookups */
  cosDecRad?: number;
}

// â”€â”€â”€ CATALOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function star(
  name: string, gaia_id: string,
  ra_hours: number, dec_degrees: number,
  magnitude_V: number, color_index_BV: number,
  spectral_type: string, temperature_K: number,
  pmra: number, pmdec: number, rv_kms: number | null,
  constellation: string
): StandardStar {
  return {
    name, gaia_id, ra_hours, dec_degrees,
    magnitude_V, color_index_BV, spectral_type, temperature_K,
    // [SCHEMA B] Hardcoded bright standards carry Johnson V magnitudes.
    band: 'JohnsonV',
    pmra, pmdec, rv_kms,
    expected_xy: planckianXY(temperature_K),
    constellation,
  };
}

export const STANDARD_STARS: StandardStar[] = [
  // 1. Vega (Î± Lyr) â€” The Primary Anchor
  star("Vega", "2911883357283452032", 18.6156, 38.7837, 0.03, 0.00, "A0V", 9602, 201.03, 287.47, -13.9, "Lyra"),

  // 2. Sirius (Î± CMa) â€” Brightest star, A1V
  star("Sirius", "2947050466531873024", 6.7525, -16.7161, -1.46, 0.00, "A1V", 9940, -546.01, -1223.07, -5.5, "Canis Major"),

  // 3. Arcturus (Î± Boo) â€” Red Giant, K0III calibration
  star("Arcturus", "1475855745484881792", 14.2612, 19.1825, -0.05, 1.23, "K0III", 4286, -1093.39, -1999.40, -5.2, "BoÃ¶tes"),

  // 4. Capella (Î± Aur) â€” G-type giant
  star("Capella", "1994682052187261056", 5.278, 45.996, 0.08, 0.08, "G3III", 4970, 75.52, -427.13, 30.2, "Auriga"),

  // 5. Rigel (Î² Ori) â€” Blue Supergiant
  star("Rigel", "3028285552945229696", 5.242, -8.201, 0.13, -0.03, "B8Ia", 12100, 1.31, -0.50, 20.7, "Orion"),

  // 6. Procyon (Î± CMi) â€” F5V subgiant
  star("Procyon", "3093220461873523712", 7.655, 5.225, 0.34, 0.42, "F5V", 6530, -716.57, -1036.80, -3.2, "Canis Minor"),

  // 7. Betelgeuse (Î± Ori) â€” Red Supergiant (Variable)
  star("Betelgeuse", "3021798319693798400", 5.919, 7.407, 0.50, 1.85, "M1Ia", 3500, 27.54, 8.95, 21.9, "Orion"),

  // 8. Altair (Î± Aql) â€” Rapid rotator A7V
  star("Altair", "4250005232938479744", 19.846, 8.868, 0.76, 0.22, "A7V", 7700, 536.23, 385.29, -26.1, "Aquila"),

  // 9. Aldebaran (Î± Tau) â€” K5III standard
  star("Aldebaran", "3295834927581137920", 4.599, 16.509, 0.85, 1.54, "K5III", 3910, 62.78, -189.36, 54.3, "Taurus"),

  // 10. Spica (Î± Vir) â€” B1V standard
  star("Spica", "3641870295174526464", 13.419, -11.161, 0.97, -0.13, "B1V", 22400, -42.50, -31.73, 1.0, "Virgo"),

  // 11. Antares (Î± Sco) â€” M1Ib standard
  star("Antares", "6048123019859155072", 16.490, -26.432, 1.06, 1.87, "M1Ib", 3400, -10.16, -23.21, -3.4, "Scorpius"),

  // 12. Pollux (Î² Gem) â€” K0IIIb standard
  star("Pollux", "2059341496660634624", 7.755, 28.026, 1.14, 1.00, "K0III", 4666, -626.55, -45.80, 3.2, "Gemini"),

  // 13. Fomalhaut (Î± PsA) â€” A3V standard
  star("Fomalhaut", "6572520845558962688", 22.960, -29.622, 1.16, 0.09, "A3V", 8590, 329.22, -164.22, 6.5, "Piscis Austrinus"),

  // 14. Deneb (Î± Cyg) â€” A2Ia standard
  star("Deneb", "2058449767672227200", 20.690, 45.280, 1.25, 0.09, "A2Ia", 8525, 1.56, 1.55, -4.5, "Cygnus"),

  // 15. Regulus (Î± Leo) â€” B7V standard
  star("Regulus", "3882772719623865600", 10.139, 11.967, 1.35, -0.11, "B7V", 12460, -249.43, 5.91, 5.9, "Leo"),

  // 16. Adhara (Îµ CMa) â€” B2II standard
  star("Adhara", "2954845511520697344", 6.977, -28.972, 1.50, -0.21, "B2II", 22200, -2.75, -2.57, 27.3, "Canis Major"),

  // 17. Castor (Î± Gem) â€” A1V binary system
  star("Castor", "3376044738555801600", 7.576, 31.888, 1.58, 0.04, "A1V", 10300, -191.53, -145.24, 6.0, "Gemini"),

  // 18. Gacrux (Î³ Cru) â€” M3.5III standard (Southern)
  star("Gacrux", "6072186837865203712", 12.519, -57.113, 1.63, 1.59, "M3.5III", 3626, 27.94, -263.85, 20.3, "Crux"),

  // 19. Shaula (Î» Sco) â€” B1.5IV standard
  star("Shaula", "6023772274438159360", 17.561, -37.104, 1.62, -0.22, "B1.5IV", 25000, -9.62, -31.39, -3.0, "Scorpius"),

  // 20. Bellatrix (Î³ Ori) â€” B2III standard
  star("Bellatrix", "3027581706689855872", 5.418, 6.349, 1.64, -0.22, "B2III", 22000, -8.11, -12.91, 18.2, "Orion"),

  // Remaining stars from original list, updated with PM/RV
  star('Canopus',    'Gaia_DR3_5235691432000000',
    6.3992, -52.6956, -0.74, +0.15, 'F0Ib', 7400, 19.93, 23.24, 20.5, 'Carina'),

  star('Mira',       'Gaia_DR3_2461000000000000',
    2.3227, -2.9764, +3.04, +1.53, 'M5-9IIIe', 3200, 10.5, -239.5, 63.8, 'Cetus'),

  // â”€â”€ BLUE STANDARDS (Hot stars, test for atmospheric blue extinction) â”€â”€


  star('Alnilam',    'Gaia_DR3_1793036000000000',
    5.6036, -1.2019, +1.69, -0.18, 'B0Ia', 27500, 1.45, -0.55, 27.3, 'Orion'),

  // â”€â”€ POLARIS (Navigation anchor, always visible from Northern Hemisphere) â”€â”€

  star('Polaris',    'Gaia_DR3_585349871319052544',
    2.5303, +89.2641, +1.98, +0.64, 'F7Ib', 6015, 44.48, -11.85, -17.0, 'Ursa Minor'),

  // Sol removed â€” ephemeris handles dynamic Sun position
];

// â”€â”€â”€ LOOKUP HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Find a standard star by common name (case-insensitive). */
export function findStarByName(name: string): StandardStar | null {
  const search = name.toLowerCase();
  return STANDARD_STARS.find(s => s.name.toLowerCase() === search) ?? null;
}

/** Find the nearest standard star to a given RA/Dec (for calibration). */
export function findNearestStar(
  raHours: number,
  decDegrees: number
): StandardStar {
  let best = STANDARD_STARS[0];
  let bestDist = Infinity;

  for (const star of STANDARD_STARS) {
    // Simple angular separation (sufficient for "nearest bright star")
    const dRA = (star.ra_hours - raHours) * 15; // Convert hour-angle to degrees
    const dDec = star.dec_degrees - decDegrees;
    const dist = Math.sqrt(dRA * dRA + dDec * dDec);
    if (dist < bestDist) {
      bestDist = dist;
      best = star;
    }
  }

  return best;
}

/**
 * Find all standard stars within a given angular radius of a position.
 * Used for multi-star calibration of a wide-field image.
 */
export function findStarsInField(
  raHours: number,
  decDegrees: number,
  radiusDegrees: number
): StandardStar[] {
  return STANDARD_STARS.filter(s => {
    const dRA = (s.ra_hours - raHours) * 15;
    const dDec = s.dec_degrees - decDegrees;
    return Math.sqrt(dRA * dRA + dDec * dDec) <= radiusDegrees;
  });
}

