// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL TRAIN FINGERPRINTING — hash canonicalization + registry
// ═══════════════════════════════════════════════════════════════════════════
// Proves: (1) the synchronous pure-JS SHA-256 matches FIPS-180-4 test vectors;
// (2) the canonical camera|lens|filter recipe is deterministic + case/spacing-
// insensitive + treats an absent/NONE filter as the empty segment; (3) the
// placeholder-identity registry is self-consistent and excludes the SeeStar.

import { describe, it, expect } from 'vitest';
import {
    sha256HexString,
    normalizeTrainSegment,
    canonicalTrainString,
    deriveOpticalTrainHash,
    deriveTrainHashFromMetadata,
    isRegisteredTrainIdentity,
    lookupTrainIdentity,
    PLACEHOLDER_TRAIN_IDENTITIES,
    PLACEHOLDER_TRAIN_HASHES,
    TRAIN_HASH_VERSION,
} from '@/engine/pipeline/m2_hardware/optical_train';

describe('sha256HexString — FIPS-180-4 correctness (real SHA-256, not a toy hash)', () => {
    it('matches the canonical empty / abc / fox test vectors', () => {
        expect(sha256HexString('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256HexString('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        // multi-block (>55 bytes) exercises the padding path
        expect(sha256HexString('The quick brown fox jumps over the lazy dog'))
            .toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
    });
    it('emits a 64-char lowercase hex digest', () => {
        const h = sha256HexString('Canon EOS 5D Mark III');
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('canonical train recipe — the documented, unit-tested construction', () => {
    it('normalizeTrainSegment trims, collapses whitespace, case-folds', () => {
        expect(normalizeTrainSegment('  Canon   EOS  5D Mark III ')).toBe('canon eos 5d mark iii');
        expect(normalizeTrainSegment(null)).toBe('');
        expect(normalizeTrainSegment(undefined)).toBe('');
        expect(normalizeTrainSegment('')).toBe('');
    });

    it('canonicalTrainString joins camera|lens|filter, NONE/absent filter → empty segment', () => {
        expect(canonicalTrainString({ camera: 'Canon EOS 60Da', lens: '', filter: 'NONE' })).toBe('canon eos 60da||');
        expect(canonicalTrainString({ camera: 'Fujifilm X-T5', lens: 'XF23mmF1.4 R', filter: undefined }))
            .toBe('fujifilm x-t5|xf23mmf1.4 r|');
        expect(canonicalTrainString({ camera: 'A', lens: 'B', filter: 'CLS' })).toBe('a|b|cls');
    });

    it('is deterministic and case/spacing-insensitive', () => {
        const a = deriveOpticalTrainHash({ camera: 'Canon EOS 5D Mark III', lens: 'Rokinon 14mm', filter: 'NONE' });
        const b = deriveOpticalTrainHash({ camera: '  canon eos 5d   mark iii ', lens: 'ROKINON 14MM', filter: '' });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('NONE / empty / undefined filter all collapse to the same clear-train identity', () => {
        const none = deriveOpticalTrainHash({ camera: 'X', lens: 'Y', filter: 'NONE' });
        const empty = deriveOpticalTrainHash({ camera: 'X', lens: 'Y', filter: '' });
        const absent = deriveOpticalTrainHash({ camera: 'X', lens: 'Y' });
        expect(none).toBe(empty);
        expect(none).toBe(absent);
    });

    it('a real filter changes the identity (a filtered train is a different train)', () => {
        const clear = deriveOpticalTrainHash({ camera: 'X', lens: 'Y', filter: 'NONE' });
        const cls = deriveOpticalTrainHash({ camera: 'X', lens: 'Y', filter: 'CLS' });
        expect(cls).not.toBe(clear);
    });

    it('camera, lens and filter are independent segments (no boundary ambiguity)', () => {
        // "ab"+"c" must NOT equal "a"+"bc" — the '|' delimiter guarantees this.
        expect(deriveOpticalTrainHash({ camera: 'ab', lens: 'c', filter: 'NONE' }))
            .not.toBe(deriveOpticalTrainHash({ camera: 'a', lens: 'bc', filter: 'NONE' }));
    });

    it('recipe version is pinned', () => {
        expect(TRAIN_HASH_VERSION).toBe('1');
    });
});

describe('deriveTrainHashFromMetadata — honest absence for an unidentifiable train', () => {
    it('returns null when BOTH camera and lens are absent/placeholder', () => {
        expect(deriveTrainHashFromMetadata(null)).toBeNull();
        expect(deriveTrainHashFromMetadata({})).toBeNull();
        expect(deriveTrainHashFromMetadata({ camera_model: '', lens_model: '' })).toBeNull();
        expect(deriveTrainHashFromMetadata({ camera_model: 'Unknown', lens_model: 'Unknown Lens' })).toBeNull();
    });

    it('returns a hash when at least camera OR lens is a real identity', () => {
        const h = deriveTrainHashFromMetadata({ camera_model: 'Canon EOS 60Da', lens_model: 'Unknown Lens', filter_type: 'NONE' });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        // equals the direct hash over the same segments (filter_type NONE → empty)
        expect(h).toBe(deriveOpticalTrainHash({ camera: 'Canon EOS 60Da', lens: 'Unknown Lens', filter: 'NONE' }));
    });

    it('reads filter_type as the optical-filter segment', () => {
        const clear = deriveTrainHashFromMetadata({ camera_model: 'Cam', lens_model: 'Lens', filter_type: 'NONE' });
        const cls = deriveTrainHashFromMetadata({ camera_model: 'Cam', lens_model: 'Lens', filter_type: 'CLS' });
        expect(clear).not.toBe(cls);
    });
});

describe('placeholder identity registry — self-consistent, SeeStar excluded', () => {
    it('registers the five known data-source trains', () => {
        expect(PLACEHOLDER_TRAIN_IDENTITIES).toHaveLength(5);
        expect(PLACEHOLDER_TRAIN_HASHES.size).toBe(5);
    });

    it('each registry entry resolves through the canonical hash', () => {
        for (const id of PLACEHOLDER_TRAIN_IDENTITIES) {
            const h = deriveOpticalTrainHash({ camera: id.camera, lens: id.lens, filter: id.filter });
            expect(isRegisteredTrainIdentity(h)).toBe(true);
            expect(lookupTrainIdentity(h)?.label).toBe(id.label);
        }
    });

    it('the two contrib bodies are DISTINCT trains (same lens, different body)', () => {
        const xt5 = deriveOpticalTrainHash({ camera: 'Fujifilm X-T5', lens: 'XF23mmF1.4 R', filter: 'NONE' });
        const xt4 = deriveOpticalTrainHash({ camera: 'Fujifilm X-T4', lens: 'XF23mmF1.4 R', filter: 'NONE' });
        expect(xt5).not.toBe(xt4);
        expect(isRegisteredTrainIdentity(xt5)).toBe(true);
        expect(isRegisteredTrainIdentity(xt4)).toBe(true);
    });

    it('the SeeStar (multi-observer) is NOT a registered identity', () => {
        const seestar = deriveOpticalTrainHash({ camera: 'ZWO Seestar S50', lens: 'Seestar S50 250mm f/5', filter: 'NONE' });
        expect(isRegisteredTrainIdentity(seestar)).toBe(false);
    });

    it('an unknown hash is not registered and looks up to null', () => {
        expect(isRegisteredTrainIdentity('deadbeef')).toBe(false);
        expect(isRegisteredTrainIdentity(null)).toBe(false);
        expect(lookupTrainIdentity('deadbeef')).toBeNull();
    });
});
