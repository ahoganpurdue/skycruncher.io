import { describe, it, expect } from 'vitest';
import { OpticsManager } from '../core/optics_manager';
import { resolveOpticsFromExif, computeScaleFromOptics } from '../pipeline/m2_hardware/optics_resolver';

/**
 * Evidence for the ROADMAP-228b fix: the fabricated "50mm → 14mm" focal-length
 * hack becomes an evidence ladder (user hint > trusted EXIF > labelled wide-
 * field prior) plus a POST-solve physics recovery — WITHOUT shifting the
 * calibrated bundled-CR2 scale lock.
 */
describe('OpticsManager.getEffectiveFocalLength — evidence ladder', () => {
  // Bundled CR2 EXIF signature: 50mm / no lens / f0 (Canon EOS Rebel T6).
  const cr2Empty = { camera_model: 'Canon EOS Rebel T6', lens_model: '', focal_length: 50 };
  const cr2Unknown = { camera_model: 'Canon EOS Rebel T6', lens_model: 'Unknown Lens', focal_length: 50 };

  it('CALIBRATION ANCHOR: bundled CR2 (50mm/no-lens, no hint) resolves to exactly 14mm', () => {
    // Load-bearing for the byte-identical CR2 e2e: the step-4 EXIF_OPTICS lock
    // is 206.265*4.30/14 = 63.35282142857143"/px, which seeds the blind solve.
    expect(OpticsManager.getEffectiveFocalLength(cr2Empty)).toBe(14);
    expect(OpticsManager.getEffectiveFocalLength(cr2Unknown)).toBe(14);
    const opt = resolveOpticsFromExif(cr2Empty as any);
    expect(opt).not.toBeNull();
    expect(opt!.pixel_scale).toBe(computeScaleFromOptics(14, 4.30));
    expect(opt!.pixel_scale).toBeCloseTo(63.35282142857143, 10);
    expect(opt!.pixel_scale).toBeGreaterThanOrEqual(61); // e2e assertRange gate
    expect(opt!.pixel_scale).toBeLessThanOrEqual(66);
  });

  it('USER HINT (evidence) overrides the wide-field prior', () => {
    expect(OpticsManager.getEffectiveFocalLength({ ...cr2Empty, focal_length_hint_mm: 50 })).toBe(50);
    expect(OpticsManager.getEffectiveFocalLength({ ...cr2Empty, focal_length_hint_mm: 24 })).toBe(24);
    // Garbage hints are ignored (fall through to the ladder).
    expect(OpticsManager.getEffectiveFocalLength({ ...cr2Empty, focal_length_hint_mm: 0 })).toBe(14);
    expect(OpticsManager.getEffectiveFocalLength({ ...cr2Empty, focal_length_hint_mm: -5 })).toBe(14);
    expect(OpticsManager.getEffectiveFocalLength({ ...cr2Empty, focal_length_hint_mm: NaN })).toBe(14);
  });

  it('a genuinely reported lens at 50mm is trusted (NOT forced to 14 — misfire class)', () => {
    expect(OpticsManager.getEffectiveFocalLength(
      { camera_model: 'Canon EOS R5', lens_model: 'Canon RF 50mm F1.8 STM', focal_length: 50 }
    )).toBe(50);
  });

  it('a non-default focal length is always trusted, even with no lens model', () => {
    expect(OpticsManager.getEffectiveFocalLength({ camera_model: 'x', lens_model: '', focal_length: 200 })).toBe(200);
    expect(OpticsManager.getEffectiveFocalLength({ camera_model: 'x', lens_model: 'Unknown', focal_length: 14 })).toBe(14);
  });

  it('null metadata yields undefined (never a fabricated default)', () => {
    expect(OpticsManager.getEffectiveFocalLength(null)).toBeUndefined();
  });

  it('exposes named priors instead of bare magic literals', () => {
    expect(OpticsManager.WIDE_FIELD_FL_PRIOR_MM).toBe(14);
    expect(OpticsManager.FALLBACK_PITCH_UM).toBe(4.3);
  });
});

describe('OpticsManager.recoverFocalLengthFromScale — post-solve physics', () => {
  it('recovers the honest measured FL from the solved scale (FL = 206.265*pitch/scale)', () => {
    // Bundled CR2 true solved scale = 63.211494618201044"/px → FL ~ 14.03mm.
    const fl = OpticsManager.recoverFocalLengthFromScale(63.211494618201044, 4.30);
    expect(fl).toBeCloseTo(206.265 * 4.30 / 63.211494618201044, 12);
    expect(fl!).toBeGreaterThan(14.0);
    expect(fl!).toBeLessThan(14.1);
  });

  it('is honest-or-absent on missing/degenerate inputs', () => {
    expect(OpticsManager.recoverFocalLengthFromScale(0, 4.3)).toBeUndefined();
    expect(OpticsManager.recoverFocalLengthFromScale(63, undefined)).toBeUndefined();
    expect(OpticsManager.recoverFocalLengthFromScale(null, 4.3)).toBeUndefined();
    expect(OpticsManager.recoverFocalLengthFromScale(63, 0)).toBeUndefined();
  });
});
