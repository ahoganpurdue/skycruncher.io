import { describe, it, expect } from 'vitest';
import { createDefaultHard, resolveExifTimestamp, parseExif } from '../pipeline/m1_ingestion/metadata_reaper';

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp honesty (owner rulings 2026-07-10):
//   1. System wall-clock time is a HINT, never a mandate — a frame with no
//      capture time must carry timestamp='' (absent), NOT a fabricated "now"
//      that sails through the ephemeris trust gate looking valid.
//   2. A corrupt primary EXIF time rescued from a secondary EXIF date field is
//      tagged 'DERIVED' (hint tier) — never 'EXIF', never wall-clock.
//   3. createDefaultHard is honest-absent: no fabricated rig, no minted time.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_EXIF_STR = '2024:06:15 04:12:33';
const VALID_ISO = new Date('2024-06-15T04:12:33').toISOString();
// The classic unset-clock placeholder — must never parse.
const CORRUPT_STR = '0000:00:00 00:00:00';

describe('resolveExifTimestamp — honest-or-absent + DERIVED rescue', () => {
    it('tags a clean DateTimeOriginal as EXIF', () => {
        const r = resolveExifTimestamp({ DateTimeOriginal: VALID_EXIF_STR });
        expect(r.source).toBe('EXIF');
        expect(r.timestamp).toBe(VALID_ISO);
    });

    it('keeps the historical EXIF tag for the CreateDate rung when DateTimeOriginal is absent', () => {
        const r = resolveExifTimestamp({ CreateDate: VALID_EXIF_STR });
        expect(r.source).toBe('EXIF');
        expect(r.timestamp).toBe(VALID_ISO);
    });

    it('rescues a corrupt DateTimeOriginal from CreateDate as DERIVED (never EXIF)', () => {
        const r = resolveExifTimestamp({ DateTimeOriginal: CORRUPT_STR, CreateDate: VALID_EXIF_STR });
        expect(r.source).toBe('DERIVED');
        expect(r.timestamp).toBe(VALID_ISO);
    });

    it('rescues an Invalid-Date object primary from ModifyDate as DERIVED', () => {
        const r = resolveExifTimestamp({
            DateTimeOriginal: new Date(NaN),
            ModifyDate: new Date('2023-01-20T10:00:00Z'),
        });
        expect(r.source).toBe('DERIVED');
        expect(r.timestamp).toBe('2023-01-20T10:00:00.000Z');
    });

    it('returns honest-absent ("", DEFAULT) when every present field is corrupt', () => {
        const r = resolveExifTimestamp({ DateTimeOriginal: CORRUPT_STR, CreateDate: new Date(NaN) });
        expect(r.source).toBe('DEFAULT');
        expect(r.timestamp).toBe('');
    });

    it('returns honest-absent ("", DEFAULT) when no date field exists — NEVER wall-clock now', () => {
        const r = resolveExifTimestamp({});
        expect(r.source).toBe('DEFAULT');
        expect(r.timestamp).toBe('');
    });

    it('never substitutes processing wall-clock time for a corrupt field', () => {
        const before = Date.now();
        const r = resolveExifTimestamp({ DateTimeOriginal: CORRUPT_STR });
        expect(r.timestamp).toBe(''); // absent, not "now"
        // Paranoia: even if a future edit reintroduced a fallback, it must not
        // land within the test's own execution window.
        if (r.timestamp !== '') {
            expect(Math.abs(Date.parse(r.timestamp) - before)).toBeGreaterThan(60_000);
        }
    });
});

describe('parseExif — no-EXIF frames carry an absent timestamp', () => {
    it('a garbage buffer yields timestamp="" with DEFAULT source (ephemeris gate degrades honestly)', async () => {
        const res = await parseExif(new ArrayBuffer(64));
        expect(res.hard.timestamp_source).toBe('DEFAULT');
        expect(res.hard.timestamp).toBe('');
    });
});

describe('createDefaultHard — honest-absent shape (no fabricated rig)', () => {
    it('carries zeroed optics and an unknown body, not a specific rig', () => {
        const hard = createDefaultHard();
        expect(hard.focal_length).toBe(0);
        expect(hard.aperture).toBe(0);
        expect(hard.camera_model).toBe('Unknown');
        // The retired fabrication was the owner's actual rig — neither string
        // may resurface as a "default".
        expect(hard.camera_model).not.toContain('Canon');
        expect(hard.lens_model).not.toContain('14mm');
    });

    it('carries an absent timestamp, not a minted wall-clock time', () => {
        const hard = createDefaultHard();
        expect(hard.timestamp).toBe('');
        expect(hard.timestamp_source).toBe('DEFAULT');
    });
});
