// ═══════════════════════════════════════════════════════════════════════════
// SYNTH LANE — RIG PROFILES (measured transforms AS GENERATORS)
// ═══════════════════════════════════════════════════════════════════════════
// A "rig profile" is the set of MEASURED (or nominal) transforms a real optical
// train imposes, packaged so the reverse pipeline can RUN them FORWARD to synth
// a frame. v0 carries the geometric ones (plate scale + Brown-Conrady radial
// distortion + a parameterized elliptical PSF + a vignette gain). The v1 slots
// (a donor psf_field, a pooled vignette fit, a measured extinction k) are named
// here so a real measurement drops straight in.
//
// HONESTY LABELS (per component):
//   • plate scale / geometry  → REAL (derived from FOCALLEN/XPIXSZ, the same
//     metrology the wizard reads back).
//   • Brown-Conrady k1/k2      → MEASURED for the pooled-Rokinon copy (see SOURCE
//     below); NOMINAL/APPROXIMATE for the others.
//   • PSF FWHM / ellipticity   → SYNTHETIC-ENGINEERING (a plausible parameter,
//     not a measured psf_field — that is the v1 donor slot).
//   • vignette a2/a4           → SYNTHETIC-ENGINEERING (nominal; pooled-fit slot).
//
// The BC math is REUSED, not reimplemented: makeBrownConrady lives in
// tools/psf/corrections.mjs (the incubator original that lens_distortion.ts is a
// port of). projectStars (tools/psf/forced_detect.mjs) applies coordFn.toNative
// to map the ideal rectilinear projection → the distorted native sensor grid —
// the exact FORWARD of the solver's un-distort prior, so a same-k1/k2 solve
// recovers the injected linear WCS.

const ARCSEC_PER_RAD = 206264.806; // 206265 arcsec/radian (Meeus / IAU)

/**
 * MEASURED pooled Brown-Conrady radial coefficients for the bundled 14mm
 * Rokinon copy.
 * SOURCE: CLAUDE.md CURRENT FRONTIER + memory measured-bc-architecture-ruling —
 * cross-frame pooled fit k1=+0.0329, k2=+0.0020 (this copy's fitted forward
 * distortion; the LENS_DB book value −0.12 is WRONG-SIGNED for this copy, a
 * documented finding). The pooled_profile.json artifact
 * (test_results/bc_profile_transfer/pooled_profile.json) is gitignored/local and
 * absent from a fresh worktree, so the value is inlined here with this citation.
 */
export const POOLED_BC_ROKINON_14 = Object.freeze({
  k1: 0.0329,
  k2: 0.0020,
  provenance: 'MEASURED_POOLED (Rokinon 14mm copy; SOURCE: CLAUDE.md frontier / measured-bc ruling)',
});

/** arcsec/px from focal length (mm) + pixel pitch (µm). The metrology identity. */
export function scaleFromOptics(focalLenMm, pixelPitchUm) {
  return (pixelPitchUm / focalLenMm) * (ARCSEC_PER_RAD / 1000);
}

/** focal length (mm) that yields `scaleArcsec` at `pixelPitchUm` — the inverse. */
export function focalLenForScale(scaleArcsec, pixelPitchUm) {
  return (pixelPitchUm / scaleArcsec) * (ARCSEC_PER_RAD / 1000);
}

// ── PRESET RIGS ──────────────────────────────────────────────────────────────
// Three regimes for the closed-loop acceptance: a narrow SeeStar-class scope
// (should solve like M66), a medium refractor, and a wide DSLR field WITH real
// Brown-Conrady distortion (the stress case — solve-or-honest-fail).
//
// Every geometric value is REAL (a self-consistent scale + optics). PSF and
// vignette are SYNTHETIC-ENGINEERING. bc = the forward distortion this rig
// imposes (identity when null).

export const RIGS = Object.freeze({
  // NARROW — SeeStar S30-class: matches the bundled M66 geometry (the frame the
  // narrow-FITS quad solve is proven on). Negligible distortion (BC off).
  narrow_seestar: {
    label: 'narrow_seestar',
    note: 'SeeStar S30-class 160mm; mirrors the bundled M66 solve geometry',
    width: 2160, height: 3840,          // NAXIS1 x NAXIS2 (portrait, as SeeStar)
    focalLenMm: 160, pixelPitchUm: 2.90, // → scale ≈ 3.739"/px (metrology prior)
    bc: null,                            // SeeStar optics: distortion negligible
    psf: { fwhmPx: 3.2, ellipticity: 0.06, thetaDeg: 20 }, // SYNTHETIC-ENGINEERING
    vignette: { a2: -0.06, a4: -0.02 },  // SYNTHETIC-ENGINEERING (gentle)
    instrume: 'imx585', telescop: 'SYNTH S30',
  },
  // MEDIUM — a short refractor / small scope: ~2x wider FOV than narrow.
  medium_refractor: {
    label: 'medium_refractor',
    note: 'short refractor 80mm; medium FOV, mild distortion',
    width: 2400, height: 1800,
    focalLenMm: 80, pixelPitchUm: 2.90,  // → scale ≈ 7.48"/px
    bc: { k1: 0.008, k2: 0.001, provenance: 'NOMINAL/APPROXIMATE (illustrative mild pincushion)' },
    psf: { fwhmPx: 2.8, ellipticity: 0.08, thetaDeg: -35 },
    vignette: { a2: -0.10, a4: -0.03 },
    instrume: 'imx585', telescop: 'SYNTH REFRACTOR-80',
  },
  // WIDE — 14mm DSLR-class field WITH the measured Rokinon Brown-Conrady forward
  // distortion. The stress regime: wide + real distortion. Reported honestly.
  // magLimit is pulled BRIGHT (9.5): a real ultra-wide blind solve works on a
  // bright-star subset, and the atlas-deep 46°/25k-detection field overruns the
  // narrow-quad FITS path (the UW anchor-sweep path is CR2-lane, out of the FITS
  // lane run.mjs speaks). A bright subset gives a CLEAN solve-or-no-solve verdict
  // within budget instead of a timeout.
  wide_dslr14: {
    label: 'wide_dslr14',
    note: '14mm ultra-wide DSLR-class; MEASURED pooled Rokinon BC distortion applied; bright-subset',
    width: 1800, height: 1200,
    focalLenMm: 14, pixelPitchUm: 4.29,  // → scale ≈ 63.2"/px (CR2-class)
    magLimit: 9.5,                       // bright subset (see note)
    bc: { ...POOLED_BC_ROKINON_14 },
    psf: { fwhmPx: 2.4, ellipticity: 0.12, thetaDeg: 10 },
    vignette: { a2: -0.22, a4: -0.08 },
    instrume: 'SYNTH DSLR', telescop: 'SYNTH ROKINON-14',
  },
});

/** Resolve a rig by key, or throw with the known keys. */
export function resolveRig(key) {
  const r = RIGS[key];
  if (!r) throw new Error(`unknown rig '${key}' (known: ${Object.keys(RIGS).join(', ')})`);
  return r;
}
