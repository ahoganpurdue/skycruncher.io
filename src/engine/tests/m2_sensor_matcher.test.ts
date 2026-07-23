import { describe, it, expect } from 'vitest';
import { findSensorByCamera } from '../pipeline/m2_hardware/sensor_db';

// ─────────────────────────────────────────────────────────────────────────────
// findSensorByCamera disambiguation (ultracode HELD #1, owner ruling
// 2026-07-10): the old body-LENGTH specificity scoring routed
// 'Canon EOS 5D Mark II' to the 5D Mark III profile (longer body string won a
// bidirectional substring test) — a silent ~2.56% scale error. The matcher is
// now exact-first, overlap-scored, and refuses ambiguity (honest UNKNOWN,
// never a wrong profile).
// ─────────────────────────────────────────────────────────────────────────────

describe('findSensorByCamera — Canon 5D family disambiguation', () => {
    it('routes the 5D Mark II to the 5D Mark II profile (the historical mis-route)', () => {
        const p = findSensorByCamera('Canon EOS 5D Mark II');
        expect(p).not.toBeNull();
        expect(p!.pixel_size_um).toBe(6.41);
        expect(p!.resolution).toEqual({ width: 5616, height: 3744 });
    });

    it('routes the 5D Mark III to the 5D Mark III profile', () => {
        const p = findSensorByCamera('Canon EOS 5D Mark III');
        expect(p).not.toBeNull();
        expect(p!.pixel_size_um).toBe(6.25);
        expect(p!.resolution).toEqual({ width: 5760, height: 3840 });
    });

    it('resolves the (astro) body variants exactly', () => {
        expect(findSensorByCamera('Canon EOS 5D Mark II (astro)')!.pixel_size_um).toBe(6.41);
        expect(findSensorByCamera('Canon EOS 5D Mark III (astro)')!.pixel_size_um).toBe(6.25);
    });

    it('returns honest UNKNOWN (null) for the 5D Mark IV — no DB profile, never a neighbor', () => {
        expect(findSensorByCamera('Canon EOS 5D Mark IV')).toBeNull();
    });

    it('refuses an ambiguous bare fragment rather than guessing a profile', () => {
        // '5d mark ii' substring-matches BOTH the 5D2 and 5D3 bodies with equal
        // overlap — the old code silently picked the Mk III. Honest UNKNOWN now.
        expect(findSensorByCamera('5D Mark II')).toBeNull();
    });
});

describe('findSensorByCamera — Seestar S30/S30 Pro (different sensors)', () => {
    it('routes the non-Pro S30 to IMX662 (old code misrouted it to the Pro/IMX585)', () => {
        const p = findSensorByCamera('ZWO Seestar S30');
        expect(p).not.toBeNull();
        expect(p!.sensor_model).toBe('Sony IMX662');
    });

    it('routes the S30 Pro to IMX585', () => {
        const p = findSensorByCamera('ZWO Seestar S30 Pro');
        expect(p).not.toBeNull();
        expect(p!.sensor_model).toBe('Sony IMX585');
    });

    it('keeps the pinned-solve S50 routing intact (IMX462)', () => {
        expect(findSensorByCamera('ZWO Seestar S50')!.sensor_model).toContain('IMX462');
        expect(findSensorByCamera('Seestar S50')!.sensor_model).toContain('IMX462');
    });
});

describe('findSensorByCamera — Canon 60D / 60Da (Cocoon astro rig)', () => {
    // The Cocoon 60Da lights carry the EXIF TIFF Model tag "Canon EOS 60D"
    // (verified via exifr on L_0020..L_0030); LibRaw's color path reports the
    // "60Da" variant string. Both must resolve the 18MP APS-C profile so the
    // EXIF_OPTICS scale rung fires instead of the phantom blind Tri-Lock.
    it('resolves the exact EXIF string "Canon EOS 60D" (the string that bites)', () => {
        const p = findSensorByCamera('Canon EOS 60D');
        expect(p).not.toBeNull();
        expect(p!.pixel_size_um).toBe(4.30);
        expect(p!.resolution).toEqual({ width: 5184, height: 3456 });
        expect(p!.bayer_pattern).toBe('RGGB');
    });

    it('resolves the LibRaw "Canon EOS 60Da" variant string to the same profile', () => {
        const p = findSensorByCamera('Canon EOS 60Da');
        expect(p).not.toBeNull();
        expect(p!.pixel_size_um).toBe(4.30);
        expect(p!.resolution).toEqual({ width: 5184, height: 3456 });
    });

    it('does not collide with the 6D full-frame profile (60D !== 6D)', () => {
        // '6D' vs '60D' must stay distinct — the 6D keeps its 6.55um full-frame pitch.
        const six = findSensorByCamera('Canon EOS 6D');
        expect(six!.pixel_size_um).toBe(6.55);
        expect(six!.resolution).toEqual({ width: 5472, height: 3648 });
    });
});

describe('findSensorByCamera — absence honesty', () => {
    it('returns null for unknown bodies and empty input', () => {
        expect(findSensorByCamera('Unknown')).toBeNull();
        expect(findSensorByCamera('')).toBeNull();
        expect(findSensorByCamera('   ')).toBeNull();
    });
});
