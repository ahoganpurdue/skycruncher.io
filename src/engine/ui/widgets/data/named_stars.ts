/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NAMED-STAR REFERENCE LIST (UI render layer only — a NAME LOOKUP, not a catalog)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *   The shipped atlas sectors (`public/atlas/sectors/level_3_sector_*.json`) are
 *   Gaia-format rows — `{id, ra, dec, mag_g, bp_rp, pm_ra, pm_dec, source_id}`.
 *   The HYG `proper` name column was NOT carried through the rebucket, so an atlas
 *   / matched star has no human name. Gaia also SATURATES at the bright end (its
 *   brightest row is ~mag_g 1.94), so the 0th/1st-magnitude naked-eye stars a
 *   viewer actually recognises (Vega, Arcturus, Antares, …) are effectively ABSENT
 *   from the matched set entirely. Name labels therefore need a small bundled
 *   reference list.
 *
 * WHAT IT IS (and is NOT)
 *   - A compact reference of the brightest, classically-named stars: proper name,
 *     Bayer designation, approximate J2000 position, approximate V magnitude.
 *   - Used ONLY to (a) attach a NAME to an atlas/matched star that is co-located
 *     within a tolerance (the label anchors to the ATLAS star's fitted position —
 *     see StarLabelsWidget), and (b) place an honestly-labelled "catalog-predicted"
 *     marker via the solution's own empirical sky→pixel map.
 *   - It is NEVER a source of solve/verify truth and never feeds the pipeline.
 *
 * SOURCE BASIS
 *   Positions/magnitudes are HYG-derived (Hipparcos/Yale Bright Star Catalog
 *   lineage), the same lineage as `m6_plate_solve/bright_star_anchors.ts` (whose 27
 *   vetted anchors are a subset here). Coordinates are rounded to ~0.001 h / ~0.001°
 *   — ample for a name-lookup tolerance of a few arc-minutes, NOT an astrometric
 *   source. Magnitudes are approximate (used only for declutter priority + display).
 *
 * UNITS (engine-internal convention, per CLAUDE.md UNIT/FORMAT TRAPS)
 *   ra_hours = J2000 right ascension in HOURS · dec_degrees = J2000 declination in
 *   DEGREES · mag = approximate V magnitude (brighter = smaller).
 *
 * TOLERANCE RATIONALE
 *   Naked-eye named stars are sparsely separated (nearest-neighbour spacing ≫ 1°),
 *   so a tight ~3′ anchor tolerance (StarLabelsWidget.ANCHOR_TOL_DEG) cannot
 *   accidentally attach the wrong name; a coordinate typo simply fails to anchor
 *   (no false label) rather than mislabelling.
 */

export interface NamedStar {
    /** Proper name (preferred label). */
    proper: string;
    /** Bayer designation "greek-letter Con", e.g. "α Lyr" (fallback label). */
    bayer: string;
    /** J2000 RA in HOURS. */
    ra_hours: number;
    /** J2000 Dec in DEGREES. */
    dec_degrees: number;
    /** Approximate V magnitude (declutter priority + display only). */
    mag: number;
}

// Brightness-ordered is not required (the widget sorts by mag for declutter); the
// list is grouped roughly by region for human maintainability.
export const NAMED_STARS: NamedStar[] = [
    // ── 1st magnitude & brighter (naked-eye anchors) ──────────────────────────
    { proper: 'Sirius', bayer: 'α CMa', ra_hours: 6.752, dec_degrees: -16.716, mag: -1.46 },
    { proper: 'Canopus', bayer: 'α Car', ra_hours: 6.399, dec_degrees: -52.696, mag: -0.74 },
    { proper: 'Rigil Kentaurus', bayer: 'α Cen', ra_hours: 14.660, dec_degrees: -60.834, mag: -0.27 },
    { proper: 'Arcturus', bayer: 'α Boo', ra_hours: 14.261, dec_degrees: 19.182, mag: -0.05 },
    { proper: 'Vega', bayer: 'α Lyr', ra_hours: 18.616, dec_degrees: 38.784, mag: 0.03 },
    { proper: 'Capella', bayer: 'α Aur', ra_hours: 5.278, dec_degrees: 45.998, mag: 0.08 },
    { proper: 'Rigel', bayer: 'β Ori', ra_hours: 5.242, dec_degrees: -8.202, mag: 0.13 },
    { proper: 'Procyon', bayer: 'α CMi', ra_hours: 7.655, dec_degrees: 5.225, mag: 0.34 },
    { proper: 'Betelgeuse', bayer: 'α Ori', ra_hours: 5.919, dec_degrees: 7.407, mag: 0.42 },
    { proper: 'Achernar', bayer: 'α Eri', ra_hours: 1.629, dec_degrees: -57.237, mag: 0.46 },
    { proper: 'Hadar', bayer: 'β Cen', ra_hours: 14.064, dec_degrees: -60.373, mag: 0.61 },
    { proper: 'Altair', bayer: 'α Aql', ra_hours: 19.846, dec_degrees: 8.868, mag: 0.77 },
    { proper: 'Acrux', bayer: 'α Cru', ra_hours: 12.443, dec_degrees: -63.099, mag: 0.77 },
    { proper: 'Aldebaran', bayer: 'α Tau', ra_hours: 4.599, dec_degrees: 16.509, mag: 0.85 },
    { proper: 'Antares', bayer: 'α Sco', ra_hours: 16.490, dec_degrees: -26.432, mag: 1.09 },
    { proper: 'Spica', bayer: 'α Vir', ra_hours: 13.420, dec_degrees: -11.161, mag: 1.04 },
    { proper: 'Pollux', bayer: 'β Gem', ra_hours: 7.755, dec_degrees: 28.026, mag: 1.14 },
    { proper: 'Fomalhaut', bayer: 'α PsA', ra_hours: 22.961, dec_degrees: -29.622, mag: 1.16 },
    { proper: 'Deneb', bayer: 'α Cyg', ra_hours: 20.690, dec_degrees: 45.280, mag: 1.25 },
    { proper: 'Mimosa', bayer: 'β Cru', ra_hours: 12.795, dec_degrees: -59.689, mag: 1.25 },
    { proper: 'Regulus', bayer: 'α Leo', ra_hours: 10.140, dec_degrees: 11.967, mag: 1.35 },

    // ── 2nd magnitude ─────────────────────────────────────────────────────────
    { proper: 'Adhara', bayer: 'ε CMa', ra_hours: 6.977, dec_degrees: -28.972, mag: 1.50 },
    { proper: 'Castor', bayer: 'α Gem', ra_hours: 7.577, dec_degrees: 31.888, mag: 1.58 },
    { proper: 'Gacrux', bayer: 'γ Cru', ra_hours: 12.519, dec_degrees: -57.113, mag: 1.63 },
    { proper: 'Shaula', bayer: 'λ Sco', ra_hours: 17.560, dec_degrees: -37.104, mag: 1.63 },
    { proper: 'Bellatrix', bayer: 'γ Ori', ra_hours: 5.418, dec_degrees: 6.350, mag: 1.64 },
    { proper: 'Elnath', bayer: 'β Tau', ra_hours: 5.438, dec_degrees: 28.608, mag: 1.65 },
    { proper: 'Miaplacidus', bayer: 'β Car', ra_hours: 9.220, dec_degrees: -69.717, mag: 1.68 },
    { proper: 'Alnilam', bayer: 'ε Ori', ra_hours: 5.604, dec_degrees: -1.202, mag: 1.69 },
    { proper: 'Alnair', bayer: 'α Gru', ra_hours: 22.137, dec_degrees: -46.961, mag: 1.74 },
    { proper: 'Alnitak', bayer: 'ζ Ori', ra_hours: 5.679, dec_degrees: -1.943, mag: 1.77 },
    { proper: 'Regor', bayer: 'γ Vel', ra_hours: 8.158, dec_degrees: -47.337, mag: 1.75 },
    { proper: 'Alioth', bayer: 'ε UMa', ra_hours: 12.900, dec_degrees: 55.960, mag: 1.77 },
    { proper: 'Kaus Australis', bayer: 'ε Sgr', ra_hours: 18.403, dec_degrees: -34.385, mag: 1.85 },
    { proper: 'Mirfak', bayer: 'α Per', ra_hours: 3.405, dec_degrees: 49.861, mag: 1.79 },
    { proper: 'Dubhe', bayer: 'α UMa', ra_hours: 11.062, dec_degrees: 61.751, mag: 1.79 },
    { proper: 'Wezen', bayer: 'δ CMa', ra_hours: 7.140, dec_degrees: -26.393, mag: 1.83 },
    { proper: 'Alkaid', bayer: 'η UMa', ra_hours: 13.792, dec_degrees: 49.313, mag: 1.86 },
    { proper: 'Sargas', bayer: 'θ Sco', ra_hours: 17.622, dec_degrees: -42.998, mag: 1.86 },
    { proper: 'Avior', bayer: 'ε Car', ra_hours: 8.375, dec_degrees: -59.510, mag: 1.86 },
    { proper: 'Menkalinan', bayer: 'β Aur', ra_hours: 5.995, dec_degrees: 44.947, mag: 1.90 },
    { proper: 'Atria', bayer: 'α TrA', ra_hours: 16.811, dec_degrees: -69.028, mag: 1.91 },
    { proper: 'Alhena', bayer: 'γ Gem', ra_hours: 6.629, dec_degrees: 16.399, mag: 1.93 },
    { proper: 'Peacock', bayer: 'α Pav', ra_hours: 20.427, dec_degrees: -56.735, mag: 1.94 },
    { proper: 'Alsephina', bayer: 'δ Vel', ra_hours: 8.745, dec_degrees: -54.708, mag: 1.93 },
    { proper: 'Mirzam', bayer: 'β CMa', ra_hours: 6.378, dec_degrees: -17.956, mag: 1.98 },
    { proper: 'Alphard', bayer: 'α Hya', ra_hours: 9.460, dec_degrees: -8.659, mag: 1.98 },
    { proper: 'Polaris', bayer: 'α UMi', ra_hours: 2.530, dec_degrees: 89.264, mag: 1.98 },
    { proper: 'Algieba', bayer: 'γ Leo', ra_hours: 10.333, dec_degrees: 19.842, mag: 2.01 },
    { proper: 'Hamal', bayer: 'α Ari', ra_hours: 2.119, dec_degrees: 23.462, mag: 2.00 },
    { proper: 'Diphda', bayer: 'β Cet', ra_hours: 0.726, dec_degrees: -17.987, mag: 2.04 },
    { proper: 'Nunki', bayer: 'σ Sgr', ra_hours: 18.921, dec_degrees: -26.297, mag: 2.05 },
    { proper: 'Menkent', bayer: 'θ Cen', ra_hours: 14.111, dec_degrees: -36.370, mag: 2.06 },
    { proper: 'Mintaka', bayer: 'δ Ori', ra_hours: 5.533, dec_degrees: -0.299, mag: 2.23 },
    { proper: 'Saiph', bayer: 'κ Ori', ra_hours: 5.796, dec_degrees: -9.670, mag: 2.06 },
    { proper: 'Alpheratz', bayer: 'α And', ra_hours: 0.140, dec_degrees: 29.090, mag: 2.06 },
    { proper: 'Mirach', bayer: 'β And', ra_hours: 1.162, dec_degrees: 35.621, mag: 2.07 },
    { proper: 'Kochab', bayer: 'β UMi', ra_hours: 14.845, dec_degrees: 74.156, mag: 2.08 },
    { proper: 'Rasalhague', bayer: 'α Oph', ra_hours: 17.582, dec_degrees: 12.560, mag: 2.08 },
    { proper: 'Almach', bayer: 'γ And', ra_hours: 2.065, dec_degrees: 42.330, mag: 2.10 },
    { proper: 'Denebola', bayer: 'β Leo', ra_hours: 11.818, dec_degrees: 14.572, mag: 2.11 },
    { proper: 'Tiaki', bayer: 'β Gru', ra_hours: 22.711, dec_degrees: -46.885, mag: 2.11 },
    { proper: 'Algol', bayer: 'β Per', ra_hours: 3.136, dec_degrees: 40.956, mag: 2.12 },
    { proper: 'Tarazed', bayer: 'γ Aql', ra_hours: 19.771, dec_degrees: 10.613, mag: 2.72 },
    { proper: 'Naos', bayer: 'ζ Pup', ra_hours: 8.060, dec_degrees: -40.003, mag: 2.21 },
    { proper: 'Aspidiske', bayer: 'ι Car', ra_hours: 9.285, dec_degrees: -59.275, mag: 2.21 },
    { proper: 'Suhail', bayer: 'λ Vel', ra_hours: 9.133, dec_degrees: -43.433, mag: 2.21 },
    { proper: 'Sadr', bayer: 'γ Cyg', ra_hours: 20.371, dec_degrees: 40.257, mag: 2.23 },
    { proper: 'Alphecca', bayer: 'α CrB', ra_hours: 15.578, dec_degrees: 26.715, mag: 2.22 },
    { proper: 'Mizar', bayer: 'ζ UMa', ra_hours: 13.399, dec_degrees: 54.925, mag: 2.04 },
    { proper: 'Eltanin', bayer: 'γ Dra', ra_hours: 17.943, dec_degrees: 51.489, mag: 2.24 },
    { proper: 'Schedar', bayer: 'α Cas', ra_hours: 0.675, dec_degrees: 56.537, mag: 2.24 },
    { proper: 'Caph', bayer: 'β Cas', ra_hours: 0.153, dec_degrees: 59.150, mag: 2.28 },
    { proper: 'Merak', bayer: 'β UMa', ra_hours: 11.031, dec_degrees: 56.383, mag: 2.37 },
    { proper: 'Dschubba', bayer: 'δ Sco', ra_hours: 16.005, dec_degrees: -22.622, mag: 2.29 },
    { proper: 'Larawag', bayer: 'ε Sco', ra_hours: 16.836, dec_degrees: -34.293, mag: 2.29 },
    { proper: 'Ankaa', bayer: 'α Phe', ra_hours: 0.438, dec_degrees: -42.306, mag: 2.40 },
    { proper: 'Girtab', bayer: 'κ Sco', ra_hours: 17.708, dec_degrees: -39.030, mag: 2.39 },
    { proper: 'Enif', bayer: 'ε Peg', ra_hours: 21.736, dec_degrees: 9.875, mag: 2.39 },
    { proper: 'Scheat', bayer: 'β Peg', ra_hours: 23.063, dec_degrees: 28.083, mag: 2.42 },
    { proper: 'Sabik', bayer: 'η Oph', ra_hours: 17.173, dec_degrees: -15.725, mag: 2.43 },
    { proper: 'Phecda', bayer: 'γ UMa', ra_hours: 11.897, dec_degrees: 53.695, mag: 2.44 },
    { proper: 'Aludra', bayer: 'η CMa', ra_hours: 7.402, dec_degrees: -29.303, mag: 2.45 },
    { proper: 'Markab', bayer: 'α Peg', ra_hours: 23.079, dec_degrees: 15.205, mag: 2.49 },
    { proper: 'Alderamin', bayer: 'α Cep', ra_hours: 21.309, dec_degrees: 62.585, mag: 2.45 },
    { proper: 'Aljanah', bayer: 'ε Cyg', ra_hours: 20.770, dec_degrees: 33.970, mag: 2.48 },
    { proper: 'Navi', bayer: 'γ Cas', ra_hours: 0.945, dec_degrees: 60.717, mag: 2.47 },

    // ── selected fainter but famous / recognisable stars ──────────────────────
    { proper: 'Menkar', bayer: 'α Cet', ra_hours: 3.038, dec_degrees: 4.090, mag: 2.53 },
    { proper: 'Zosma', bayer: 'δ Leo', ra_hours: 11.235, dec_degrees: 20.524, mag: 2.56 },
    { proper: 'Acrab', bayer: 'β Sco', ra_hours: 16.090, dec_degrees: -19.805, mag: 2.56 },
    { proper: 'Zubeneschamali', bayer: 'β Lib', ra_hours: 15.283, dec_degrees: -9.383, mag: 2.61 },
    { proper: 'Unukalhai', bayer: 'α Ser', ra_hours: 15.738, dec_degrees: 6.426, mag: 2.63 },
    { proper: 'Sheratan', bayer: 'β Ari', ra_hours: 1.911, dec_degrees: 20.808, mag: 2.64 },
    { proper: 'Ruchbah', bayer: 'δ Cas', ra_hours: 1.430, dec_degrees: 60.235, mag: 2.68 },
    { proper: 'Gienah', bayer: 'γ Crv', ra_hours: 12.263, dec_degrees: -17.542, mag: 2.59 },
    { proper: 'Ascella', bayer: 'ζ Sgr', ra_hours: 19.043, dec_degrees: -29.880, mag: 2.60 },
    { proper: 'Kaus Media', bayer: 'δ Sgr', ra_hours: 18.350, dec_degrees: -29.828, mag: 2.70 },
    { proper: 'Lesath', bayer: 'υ Sco', ra_hours: 17.512, dec_degrees: -37.296, mag: 2.70 },
    { proper: 'Zubenelgenubi', bayer: 'α Lib', ra_hours: 14.848, dec_degrees: -16.042, mag: 2.75 },
    { proper: 'Megrez', bayer: 'δ UMa', ra_hours: 12.257, dec_degrees: 57.033, mag: 3.31 },
    { proper: 'Albireo', bayer: 'β Cyg', ra_hours: 19.512, dec_degrees: 27.960, mag: 3.08 },
    { proper: 'Alcyone', bayer: 'η Tau', ra_hours: 3.791, dec_degrees: 24.105, mag: 2.87 },
    { proper: 'Mira', bayer: 'ο Cet', ra_hours: 2.322, dec_degrees: -2.977, mag: 3.04 },
];
