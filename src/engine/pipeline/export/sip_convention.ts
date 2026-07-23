/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIP CONVENTION — the internal-fit → FITS-standard sign bridge (EXPORT-ONLY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure number transform — no DOM, no wasm, no I/O). Imported by
 * BOTH export serializers (fits_writer.ts, asdf_writer.ts) so the sign convention
 * is fixed in exactly ONE place and neither writer can re-derive it wrong.
 *
 * ─── WHY THIS EXISTS (the sign trap, stated precisely) ────────────────────────
 * The engine's SIP fitter (`m7_astrometry/residual_analyzer.ts`, performSIPFit +
 * the dataPoints assembly at ~L79-88,154-163) and its TPS companion
 * (`m6_plate_solve/tps_fitter.ts`, same convention by construction) fit the
 * displacement in ONE specific direction:
 *
 *     per matched star, with the linear WCS:
 *        u  = detected.x − CRPIX          (pixel offset from the reference pixel)
 *        v  = detected.y − CRPIX
 *        dx = detected.x − skyToLinearPixel(catalog).x   =  OBSERVED − IDEAL
 *        dy = detected.y − skyToLinearPixel(catalog).y
 *     and solves   a[p][q]  such that   dx ≈ Σ a[p][q] · u^p v^q .
 *
 * So the STORED coefficients (receipt.solution.astrometry.sip.a / .b) model
 *
 *        A_internal(u,v)  =  dx  =  OBSERVED − IDEAL .                         (1)
 *
 * The FITS SIP standard (Shupe et al. 2005) defines the FORWARD polynomial as the
 * correction that maps the OBSERVED (distorted) pixel offset to the IDEAL
 * (undistorted) one that then multiplies CD:
 *
 *        u' = u + Σ A_pq · u^p v^q ,   v' = v + Σ B_pq · u^p v^q               (2)
 *        (ξ,η) = CD · (u', v')
 *
 * i.e. FITS wants   u' = IDEAL,  so   A_FITS(u,v) = u' − u = IDEAL − OBSERVED.  (3)
 *
 * The two fits share the SAME domain (u = detected − CRPIX; FITS's u = p1 −
 * CRPIX1 is identical because p1 and CRPIX1 are both the engine value +1, so the
 * +1s cancel). Therefore, from (1) and (3):
 *
 *        A_FITS  =  IDEAL − OBSERVED  =  −(OBSERVED − IDEAL)  =  −A_internal.   (4)
 *
 * The conversion is a PURE COEFFICIENT NEGATION. This module owns that negation.
 * Emitting the internal coefficients verbatim as FITS A_i_j (the pre-fix bug)
 * makes astropy apply the distortion in the WRONG direction — it WORSENS the
 * catalog residuals instead of improving them (the M7 sign bug). The real-engine
 * conformance fixture (tools/fits + tools/asdf catalog-residual mode) is what
 * proves this negation is correct: astropy-applied SIP/TPS residuals must go DOWN
 * vs the linear WCS, not up.
 *
 * NOTE (internal consumers are self-consistent — do NOT touch them): every IN-APP
 * consumer of receipt.sip (ImageProcessor.applySipUndistort, lens_distortion_*,
 * cascade_math.sipDisplacement, tps_fitter's own eval) uses convention (1) end to
 * end, so they are correct as-is. The wrong sign only ever existed at the FITS/
 * ASDF SERIALIZATION boundary, which is the only thing this bridge corrects.
 */

/** The internal SIP block as stored on the receipt (convention (1) above). */
export interface InternalSip {
    a_order: number;
    b_order: number;
    a: number[][];
    b: number[][];
}

/** Negate one coefficient matrix (returns a fresh matrix; input untouched).
 * Non-finite / missing entries pass through as 0 so the shape is preserved. */
function negateMatrix(m: number[][]): number[][] {
    if (!Array.isArray(m)) return m;
    return m.map(row =>
        Array.isArray(row)
            ? row.map(v => (typeof v === 'number' && Number.isFinite(v) ? -v : v))
            : row
    );
}

/**
 * Convert a stored (internal-convention) SIP block into FITS-standard forward
 * coefficients by negating A and B — see equation (4) in the module header. The
 * orders are unchanged. Pure: returns a NEW block; the receipt's sip is never
 * mutated. Both fits_writer (A_i_j / B_i_j keyword cards) and asdf_writer (the
 * `wcs_fits` keyword fallback AND the native gwcs polynomial node) run their SIP
 * coefficients through here so the two exports are byte-consistent and both
 * FITS-conventional.
 */
export function toFitsSip(sip: InternalSip): InternalSip {
    return {
        a_order: sip.a_order,
        b_order: sip.b_order,
        a: negateMatrix(sip.a),
        b: negateMatrix(sip.b),
    };
}
