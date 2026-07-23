// Unit tests for the lens-distortion RESOLUTION LADDER (NEXT_MOVES §8,
// Increment 2). resolveLensDistortion must return a profile ONLY from trusted
// evidence (user hint or a non-placeholder EXIF LensModel matching LENS_DB),
// and a NO-OP (null) otherwise.
//
// CRITICAL PROOF: the bundled CR2's real metadata (lying `focal_length:50`,
// no LensModel → 'Unknown Lens' placeholder, no user hint) must resolve to NO
// profile — this is the byte-identical-by-construction guarantee for the CR2
// e2e. If this ever returns non-null, the lying-EXIF landmine has fired.

import { describe, it, expect } from 'vitest';
import { resolveLensDistortion } from '../pipeline/m2_hardware/lens_distortion';
import { LENS_DB } from '../pipeline/m2_hardware/lens_profiles';

const ROKINON_MODEL = LENS_DB.ROKINON_14_MUSTACHE.model; // '14mm f/2.8 ED AS IF UMC'
const ROKINON_K1 = LENS_DB.ROKINON_14_MUSTACHE.distortion[14].k1; // -0.12

describe('resolveLensDistortion — the bundled-CR2 no-op guarantee (CRITICAL)', () => {
  it('returns NO profile for the bundled CR2 metadata (lying 50mm / Unknown Lens / no hint)', () => {
    // The exact shape the pipeline presents for the bundled CR2 (see the
    // metadata-reaper normalization + optics trust ladder).
    const bundledCr2 = { lens_model: 'Unknown Lens', focal_length: 50 };
    const res = resolveLensDistortion(bundledCr2);
    // Log the result so the no-op is visible in the test output (Increment 2
    // "log the result" requirement).
    // eslint-disable-next-line no-console
    console.log(`[LensResolver][PROOF] bundled CR2 {lens_model:'Unknown Lens', focal_length:50} → ${res === null ? 'NO PROFILE (no-op ✓)' : JSON.stringify(res)}`);
    expect(res).toBeNull();
  });

  it('rejects every placeholder / empty / untrusted lens model', () => {
    expect(resolveLensDistortion({ lens_model: 'Unknown Lens', focal_length: 50 })).toBeNull();
    expect(resolveLensDistortion({ lens_model: 'Unknown' })).toBeNull();
    expect(resolveLensDistortion({ lens_model: 'unknown lens' })).toBeNull(); // case-insensitive
    expect(resolveLensDistortion({ lens_model: '  ' })).toBeNull();
    expect(resolveLensDistortion({ lens_model: '' })).toBeNull();
    expect(resolveLensDistortion({})).toBeNull();
    expect(resolveLensDistortion(null)).toBeNull();
    expect(resolveLensDistortion(undefined)).toBeNull();
  });

  it('does NOT resolve a lens from the focal-length value alone', () => {
    // Even with a genuine-looking 14mm focal, an Unknown/absent lens model must
    // NOT resolve (this is exactly the FL-prior landmine).
    expect(resolveLensDistortion({ lens_model: 'Unknown Lens', focal_length: 14 })).toBeNull();
    expect(resolveLensDistortion({ focal_length: 14 })).toBeNull();
  });

  it('rejects a genuine but unknown-to-DB lens model', () => {
    expect(resolveLensDistortion({ lens_model: 'Nikon AF-S 24mm f/1.4G', focal_length: 24 })).toBeNull();
  });
});

describe('resolveLensDistortion — trusted EXIF LensModel', () => {
  it('resolves the Rokinon 14mm from a genuine EXIF LensModel', () => {
    const res = resolveLensDistortion({ lens_model: ROKINON_MODEL, focal_length: 14 });
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('EXIF_TRUSTED');
    expect(res!.lensKey).toBe('ROKINON_14_MUSTACHE');
    expect(res!.k1).toBeCloseTo(ROKINON_K1, 12);
    expect(res!.k2).toBeCloseTo(0.05, 12);
    expect(res!.focalLength).toBe(14);
  });

  it('interpolates a zoom lens by focal length from EXIF', () => {
    // CANON_RF_15_35 at 17.5mm → midpoint of 15/20mm coeffs.
    const res = resolveLensDistortion({ lens_model: LENS_DB.CANON_RF_15_35.model, focal_length: 17.5 });
    expect(res).not.toBeNull();
    expect(res!.k1).toBeCloseTo((-0.035 + -0.018) / 2, 6);
  });
});

describe('resolveLensDistortion — user hint (manual glass) overrides a lying EXIF', () => {
  it('resolves via an explicit LENS_DB key even against the lying CR2 EXIF', () => {
    const res = resolveLensDistortion(
      { lens_model: 'Unknown Lens', focal_length: 50 }, // the lying bundled CR2 EXIF
      { lensKey: 'ROKINON_14_MUSTACHE' },
    );
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('USER_HINT');
    expect(res!.lensKey).toBe('ROKINON_14_MUSTACHE');
    expect(res!.k1).toBeCloseTo(ROKINON_K1, 12);
  });

  it('resolves via a free-text lens-model hint', () => {
    const res = resolveLensDistortion(null, { lensModel: ROKINON_MODEL });
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('USER_HINT');
    expect(res!.lensKey).toBe('ROKINON_14_MUSTACHE');
  });

  it('honors an explicit hint focal length for a zoom', () => {
    const res = resolveLensDistortion(null, { lensKey: 'CANON_RF_15_35', focalLength: 24 });
    expect(res).not.toBeNull();
    expect(res!.focalLength).toBe(24);
    expect(res!.k1).toBeCloseTo(-0.008, 12); // exact 24mm sample
  });

  it('falls through to the (guarded) EXIF rung when a hint does not resolve', () => {
    // Unresolvable hint + placeholder EXIF → still NO profile (no fabrication).
    expect(resolveLensDistortion({ lens_model: 'Unknown Lens' }, { lensModel: 'NoSuchGlass' })).toBeNull();
    // Unresolvable hint + genuine EXIF → resolves from EXIF.
    const res = resolveLensDistortion({ lens_model: ROKINON_MODEL, focal_length: 14 }, { lensModel: 'NoSuchGlass' });
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('EXIF_TRUSTED');
  });
});

describe('resolveLensDistortion — Fujinon XF23mmF2 R WR (2026-07-13 campaign prior)', () => {
  const FUJI_MODEL = LENS_DB.FUJINON_XF23_F2.model; // 'XF23mmF2 R WR'
  const FUJI_K1 = LENS_DB.FUJINON_XF23_F2.distortion[23].k1; // -0.0420 (lensfun ptlens -> half-diag shape fit)
  const FUJI_K2 = LENS_DB.FUJINON_XF23_F2.distortion[23].k2; // +0.0375

  it('resolves from the exact Fuji EXIF/override LensModel (the campaign injection route)', () => {
    // The campaign sets overrides.lens_model = 'XF23mmF2 R WR' (the exact Fuji
    // EXIF form) -> EXIF_TRUSTED branch -> tier-1 exact match.
    const res = resolveLensDistortion({ lens_model: FUJI_MODEL, focal_length: 23 });
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('EXIF_TRUSTED');
    expect(res!.lensKey).toBe('FUJINON_XF23_F2');
    expect(res!.k1).toBeCloseTo(FUJI_K1, 12);
    expect(res!.k2).toBeCloseTo(FUJI_K2, 12);
    expect(res!.focalLength).toBe(23);
  });

  it('resolves the brand+focal (tier-2) long-form model string', () => {
    // A make-prefixed free-text form still resolves via matchLens tier-2
    // (brand 'Fujifilm' + focal 23mm), so a verbose LensModel also engages.
    const res = resolveLensDistortion({ lens_model: 'Fujifilm XF 23mm f/2 R WR', focal_length: 23 });
    expect(res).not.toBeNull();
    expect(res!.lensKey).toBe('FUJINON_XF23_F2');
  });

  it('also resolves via an explicit user hint (lensKey)', () => {
    const res = resolveLensDistortion(null, { lensKey: 'FUJINON_XF23_F2' });
    expect(res).not.toBeNull();
    expect(res!.provenance).toBe('USER_HINT');
    expect(res!.k1).toBeCloseTo(FUJI_K1, 12);
  });

  it('does NOT silently substitute the distinct XF 23mm f/1.4 sibling (real Fuji EXIF form)', () => {
    // The f/1.4 is a DIFFERENT lens (different distortion); it is not in the DB,
    // so it must resolve to NO profile rather than borrow the f/2 prior. Fuji's
    // real EXIF LensModel is the COMPACT form 'XF23mmF1.4 R' — no brand token and
    // '23mm' is not a whole-token focal, so matchLens finds no tier-1/tier-2 hit.
    expect(resolveLensDistortion({ lens_model: 'XF23mmF1.4 R', focal_length: 23 })).toBeNull();
    // KNOWN LIMITATION (documented, not asserted): a VERBOSE brand+spaced-focal
    // string like 'Fujifilm XF 23mm f/1.4 R' WOULD collide with the f/2 entry via
    // matchLens tier-2 (brand 'Fujifilm' + focal 23mm — the matcher is aperture-
    // blind). Fuji never writes that form to EXIF, and the campaign injects the
    // exact compact model, so the realistic paths are safe. Disambiguating
    // aperture belongs in identifier_matcher (out of scope here), not this entry.
  });
});
