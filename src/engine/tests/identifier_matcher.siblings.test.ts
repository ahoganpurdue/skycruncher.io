/**
 * SIBLING-COLLISION SUITE — run against the shared matcher post-migration.
 *
 * Locks the identifier→registry lookups against the loose-substring bug class:
 * an identifier string resolved to the WRONG sibling registry entry (silently
 * applying entity B's numbers to identity A). Sensor cases (M1) + the rule-3
 * absent-sibling residual; lens cases (M2) exercise the lens-domain matcher.
 */
import { describe, it, expect } from 'vitest';
import { findSensorByCamera } from '../pipeline/m2_hardware/sensor_db';
import { findLensByModel } from '../pipeline/m2_hardware/lens_profiles';
import { LensfunIngestor, type LensProfile as LensfunProfile } from '../pipeline/m2_hardware/lensfun_ingestor';

describe('siblings — sensor 5D family (full-EXIF resolves, bare/absent → honest null)', () => {
  it('full EXIF bodies route to their own profile', () => {
    expect(findSensorByCamera('Canon EOS 5D Mark II')!.pixel_size_um).toBe(6.41);
    expect(findSensorByCamera('Canon EOS 5D Mark III')!.pixel_size_um).toBe(6.25);
  });

  it('bare "5D Mark II" ties 5D2/5D3 at tier 2 → null (never a coin flip)', () => {
    expect(findSensorByCamera('5D Mark II')).toBeNull();
  });

  it('absent 5D Mark IV → null, never a silent 5D3 route', () => {
    expect(findSensorByCamera('Canon EOS 5D Mark IV')).toBeNull();
  });
});

describe('siblings — rule-3 absent-sibling residual (the #5 fix)', () => {
  it('"Canon EOS R6" (absent) → null, never the R6 II sensor (CANON_FF_BSI 4.39µm)', () => {
    // Before the guard: a clean prefix of exactly ONE longer sibling with no
    // competitor returned that sibling's profile confidently (~33% scale error).
    expect(findSensorByCamera('Canon EOS R6')).toBeNull();
  });

  it('the real "Canon EOS R6 II" still resolves (tier-1 exact, unbroken)', () => {
    const p = findSensorByCamera('Canon EOS R6 II');
    expect(p).not.toBeNull();
    expect(p!.pixel_size_um).toBe(4.39);
  });

  it('"Canon EOS Rebel T7i" (absent) → null, never the T7 profile', () => {
    expect(findSensorByCamera('Canon EOS Rebel T7i')).toBeNull();
  });

  it('a full EXIF body that drops only filler (brand/EOS) still resolves', () => {
    // "EOS Rebel T6" ⊂ "Canon EOS Rebel T6": differs only by the filler token
    // "canon" — core token-sets are equal, so the match stays CONFIDENT.
    expect(findSensorByCamera('EOS Rebel T6')!.pixel_size_um).toBe(4.30);
  });
});

describe('siblings — Seestar S30 / S30 Pro / S50 (distinct sensors)', () => {
  it('S30 → IMX662, S30 Pro → IMX585, S50 → IMX462', () => {
    expect(findSensorByCamera('ZWO Seestar S30')!.sensor_model).toBe('Sony IMX662');
    expect(findSensorByCamera('ZWO Seestar S30 Pro')!.sensor_model).toBe('Sony IMX585');
    expect(findSensorByCamera('ZWO Seestar S50')!.sensor_model).toContain('IMX462');
  });
});

// ─── LENS DOMAIN (M2 — the HIGH live fix: bare focal is NOT identity) ─────────

describe('siblings — lens near-names', () => {
  it('bare "14mm" → null (Sigma vs Rokinon tie — not the first-iterated Sigma)', () => {
    expect(findLensByModel('14mm')).toBeNull();
  });

  it('brand + focal resolve to the right 14mm lens', () => {
    expect(findLensByModel('Sigma 14mm F1.8 DG HSM Art')!.manufacturer).toBe('Sigma');
    expect(findLensByModel('Rokinon 14mm F2.8')!.manufacturer).toContain('Rokinon');
  });

  it('"Samyang 14mm" resolves the Rokinon/Samyang profile via brand alias (k1 −0.12, not Sigma −0.042)', () => {
    const p = findLensByModel('Samyang 14mm');
    expect(p).not.toBeNull();
    expect(p!.manufacturer).toContain('Samyang');
    expect(p!.distortion[14].k1).toBe(-0.12);
  });

  it('exact full-model strings resolve (tier-1)', () => {
    expect(findLensByModel('14mm f/2.8 ED AS IF UMC')!.manufacturer).toContain('Rokinon');
    expect(findLensByModel('RF 15-35mm f/2.8L IS USM')!.manufacturer).toBe('Canon');
  });

  it('bare "35mm" → null (never the 135mm telephoto via substring)', () => {
    expect(findLensByModel('35mm')).toBeNull();
  });

  it('a brand with no DB entry → null even when the focal exists elsewhere', () => {
    // Canon RF 15-35 covers focal 24, but the Nikon brand disagrees → no fallback.
    expect(findLensByModel('Nikon AF-S 24mm f/1.4G')).toBeNull();
  });

  it('reaper synth string "14mm f/2.8 Lens" stays null', () => {
    expect(findLensByModel('14mm f/2.8 Lens')).toBeNull();
  });
});

// ─── LENSFUN INGESTOR (M5 — dead-path insurance) ─────────────────────────────

describe('siblings — lensfun findProfile (numeric focal, not substring)', () => {
  function lens(make: string, model: string, aliases: string[] = []): LensfunProfile {
    return { make, model, mount: 'EF', cropFactor: 1, calibration: { distortion: [] }, aliases };
  }
  const db: LensfunProfile[] = [
    lens('Samyang', '35mm F1.4', ['Rokinon', 'Bower', 'Walimex']),
    lens('Samyang', '135mm F2.0 ED UMC', ['Rokinon', 'Bower', 'Walimex']),
  ];

  it('"35mm" resolves the 35mm lens, NEVER the 135mm (the 35 ⊂ 135 substring bug)', () => {
    const p = LensfunIngestor.findProfile(db, 'Samyang', '35mm');
    expect(p?.model).toBe('35mm F1.4');
  });

  it('"135mm" resolves the telephoto', () => {
    expect(LensfunIngestor.findProfile(db, 'Samyang', '135mm')?.model).toBe('135mm F2.0 ED UMC');
  });

  it('a Rokinon query resolves the Samyang profile via brand alias', () => {
    expect(LensfunIngestor.findProfile(db, 'Rokinon', '35mm')?.model).toBe('35mm F1.4');
  });
});
