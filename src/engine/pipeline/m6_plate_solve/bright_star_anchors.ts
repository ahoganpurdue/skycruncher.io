// ═══════════════════════════════════════════════════════════════════════════
// BUNDLED CLASSIC BRIGHT-STAR ANCHORS (ultra-wide fine-center lever)
// ═══════════════════════════════════════════════════════════════════════════
//
// Gaia SATURATES at the bright end: public/atlas/level_1_anchors.json is pure
// Gaia and its brightest row is mag_g 1.94 — the 0th/1st-magnitude naked-eye
// stars that anchor a landscape astro shot (Vega, Arcturus, Antares, Altair,
// Aldebaran, …) are effectively ABSENT from the catalog. So the bright-STAR
// anchor centers the fine-center lever grids around cannot come from the atlas;
// they must come from a bundled classic list. (Measured need: IMG_1757 required
// Altair injected, IMG_1241 required Aldebaran — see docs/CR2_SOLVER_FINDINGS.md
// §2d.)
//
// This is the single source of truth for that list. The headless UW harness
// (tools/dslr/uw_solve.uwspec.ts) carries an inline copy that this module was
// factored out of; keep them in sync (or point the harness here).
//
// Positions are J2000 RA (HOURS) / Dec (DEGREES) — the engine's internal
// convention (crval[0] is HOURS; degrees only at the FITS boundary).

export interface BrightStarAnchor {
    name: string;
    ra_hours: number;
    dec_degrees: number;
    /** Approx V magnitude — used only to order which anchors the budget spends first. */
    mag: number;
}

// Roughly brightness-ordered (brightest first) so budget-bounded refinement
// spends its center allowance on the most likely landscape anchors first.
export const BRIGHT_STAR_ANCHORS: BrightStarAnchor[] = [
    { name: 'Sirius', ra_hours: 6.752, dec_degrees: -16.716, mag: -1.46 },
    { name: 'Canopus', ra_hours: 6.399, dec_degrees: -52.696, mag: -0.74 },
    { name: 'Arcturus', ra_hours: 14.261, dec_degrees: 19.182, mag: -0.05 },
    { name: 'Vega', ra_hours: 18.616, dec_degrees: 38.784, mag: 0.03 },
    { name: 'Capella', ra_hours: 5.278, dec_degrees: 45.998, mag: 0.08 },
    { name: 'Rigel', ra_hours: 5.242, dec_degrees: -8.202, mag: 0.13 },
    { name: 'Procyon', ra_hours: 7.655, dec_degrees: 5.225, mag: 0.34 },
    { name: 'Betelgeuse', ra_hours: 5.919, dec_degrees: 7.407, mag: 0.42 },
    { name: 'Achernar', ra_hours: 1.629, dec_degrees: -57.237, mag: 0.46 },
    { name: 'Altair', ra_hours: 19.846, dec_degrees: 8.868, mag: 0.77 },
    { name: 'Aldebaran', ra_hours: 4.599, dec_degrees: 16.509, mag: 0.85 },
    { name: 'Antares', ra_hours: 16.490, dec_degrees: -26.432, mag: 1.09 },
    { name: 'Spica', ra_hours: 13.420, dec_degrees: -11.161, mag: 1.04 },
    { name: 'Pollux', ra_hours: 7.755, dec_degrees: 28.026, mag: 1.14 },
    { name: 'Fomalhaut', ra_hours: 22.961, dec_degrees: -29.622, mag: 1.16 },
    { name: 'Deneb', ra_hours: 20.690, dec_degrees: 45.280, mag: 1.25 },
    { name: 'Regulus', ra_hours: 10.140, dec_degrees: 11.967, mag: 1.35 },
    { name: 'Adhara', ra_hours: 6.977, dec_degrees: -28.972, mag: 1.50 },
    { name: 'Castor', ra_hours: 7.577, dec_degrees: 31.888, mag: 1.58 },
    { name: 'Shaula', ra_hours: 17.560, dec_degrees: -37.104, mag: 1.63 },
    { name: 'Bellatrix', ra_hours: 5.418, dec_degrees: 6.350, mag: 1.64 },
    { name: 'Elnath', ra_hours: 5.438, dec_degrees: 28.608, mag: 1.65 },
    { name: 'Alnilam', ra_hours: 5.604, dec_degrees: -1.202, mag: 1.69 },
    { name: 'Alnair', ra_hours: 22.137, dec_degrees: -46.961, mag: 1.74 },
    { name: 'Sabik', ra_hours: 17.173, dec_degrees: -15.725, mag: 2.43 },
    { name: 'Kaus Australis', ra_hours: 18.403, dec_degrees: -34.385, mag: 1.85 },
    { name: 'Nunki', ra_hours: 18.921, dec_degrees: -26.297, mag: 2.05 },
];
