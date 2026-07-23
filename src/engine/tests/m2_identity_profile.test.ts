// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL-TRAIN IDENTITY PROFILE — rung-0 keying + resolver (SOLVER_IDENTITY_PROFILE)
// ═══════════════════════════════════════════════════════════════════════════
// Covers the additive train-hash KEYING (deriveRigKey/extractDeposit carry it),
// the store-side identity resolver (placeholder ≥1 vs auto-pool ≥3), and the
// rung-0 precedence in resolveLensDistortion — including the load-bearing proof
// that an identity match SKIPS the generic LENS_DB/EXIF lookup (Feb spec). The
// closing block is the flag-ON demo: a synthetic measured profile seeded under
// the contrib X-T5 placeholder hash resolves to source='measured:identity'.

import { describe, it, expect } from 'vitest';
import {
    deriveRigKey,
    extractDeposit,
    resolveIdentityProfile,
    MemoryWorkbenchStorage,
    type ObservationDeposit,
} from '@/engine/pipeline/m2_hardware/workbench_store';
import { resolveLensDistortion, type IdentityDistortionProfile } from '@/engine/pipeline/m2_hardware/lens_distortion';
import { deriveOpticalTrainHash } from '@/engine/pipeline/m2_hardware/optical_train';
import { LENS_DB } from '@/engine/pipeline/m2_hardware/lens_profiles';

const ROKINON_MODEL = LENS_DB.ROKINON_14_MUSTACHE.model; // a genuine EXIF-resolvable lens
const CONTRIB_XT5_HASH = deriveOpticalTrainHash({ camera: 'Fujifilm X-T5', lens: 'XF23mmF1.4 R', filter: 'NONE' });

/** A measured-BC deposit optionally keyed to a train hash. */
function mkDeposit(k1: number, opts: { trainHash?: string | null; k2?: number | null; measured?: boolean; epoch?: number } = {}): ObservationDeposit {
    return {
        schema: '1.1.0', rig_key: 'BODY|LENS', key_quality: 'MODEL_ONLY',
        body: 'BODY', lens: 'LENS', body_serial: null,
        train_hash: opts.trainHash === undefined ? CONTRIB_XT5_HASH : opts.trainHash,
        epoch: opts.epoch ?? 0,
        captured_at: null, timestamp_trusted: true, deposited_at: 'now',
        receipt_hash: `r53_${k1}_${opts.epoch ?? 0}`,
        aperture: null, focal_length_mm: null, pixel_scale_arcsec: null, stars_matched: null,
        bc: {
            measured: opts.measured ?? true,
            k1: (opts.measured === false) ? null : k1,
            k2: opts.k2 === undefined ? null : opts.k2,
            k1_sigma: 1e-3, k2_sigma: null, n_pairs: 100, n_used: 100, r_max_sampled: 0.9,
            octant_counts: [1, 1, 1, 1, 1, 1, 1, 1], coverage_refused: null,
            mustache_verdict: null, not_measured: null,
        },
        sip: { present: false, a_order: null, b_order: null, rms_arcsec: null },
        tps: { present: false, control_count: null, rms_after_arcsec: null },
        psf: { measured: false, fwhm_median_maj_px: null, fwhm_median_min_px: null, ellipticity_median: null, n_fit: null, method: null },
        zero_point: null, zero_point_rmse: null,
        bc_rematch: { present: false, guard: null, applied: null, matched_before: null, matched_after: null, edge_before: null, edge_after: null },
    };
}

// ─── KEYING ROUND-TRIP ─────────────────────────────────────────────────────────
describe('train-hash keying is ADDITIVE (both keys coexist)', () => {
    it('deriveRigKey stamps the train_hash alongside the MODEL_ONLY rig_key', () => {
        const k = deriveRigKey({ camera_model: 'Fujifilm X-T5', lens_model: 'XF23mmF1.4 R', filter_type: 'NONE' });
        expect(k.key).toBe('Fujifilm X-T5|XF23mmF1.4 R'); // legacy key unchanged
        expect(k.quality).toBe('MODEL_ONLY');
        expect(k.train_hash).toBe(CONTRIB_XT5_HASH);         // additive second key
    });

    it('train_hash is null when the train has no identity (unchanged rig_key)', () => {
        const k = deriveRigKey(null);
        expect(k.key).toBe('UNKNOWN|UNKNOWN');
        expect(k.train_hash).toBeNull();
    });

    it('extractDeposit carries the train_hash from the receipt metadata', () => {
        const receipt = {
            metadata: { camera_model: 'Fujifilm X-T5', lens_model: 'XF23mmF1.4 R', filter_type: 'NONE', focal_length: 23 },
            solution: { ra_hours: 1, dec_degrees: 1, pixel_scale: 3, confidence: 0.5, stars_matched: 100 },
        };
        const d = extractDeposit(receipt)!;
        expect(d.train_hash).toBe(CONTRIB_XT5_HASH);
        expect(d.rig_key).toBe('Fujifilm X-T5|XF23mmF1.4 R'); // fallback tier intact
    });
});

// ─── STORE-SIDE IDENTITY RESOLVER ──────────────────────────────────────────────
describe('resolveIdentityProfile — placeholder (≥1) vs auto-pool (≥3) tiers', () => {
    it('placeholder tier: a SINGLE measured deposit resolves a profile', () => {
        const prof = resolveIdentityProfile([mkDeposit(-0.12)], CONTRIB_XT5_HASH, { placeholderTier: true });
        expect(prof).not.toBeNull();
        expect(prof!.tier).toBe('placeholder');
        expect(prof!.k1).toBeCloseTo(-0.12, 9);
        expect(prof!.n).toBe(1);
        expect(prof!.train_hash).toBe(CONTRIB_XT5_HASH);
        expect(prof!.receipt_hashes).toHaveLength(1);
    });

    it('placeholder tier: an unmeasured-only deposit resolves nothing (honest absence)', () => {
        expect(resolveIdentityProfile([mkDeposit(0, { measured: false })], CONTRIB_XT5_HASH, { placeholderTier: true })).toBeNull();
    });

    it('auto-pool tier: below 3 agreeing deposits → null; ≥3 → pooled', () => {
        expect(resolveIdentityProfile([mkDeposit(-0.12), mkDeposit(-0.11)], CONTRIB_XT5_HASH, { placeholderTier: false })).toBeNull();
        const pooled = resolveIdentityProfile(
            [mkDeposit(-0.12), mkDeposit(-0.11), mkDeposit(-0.13)], CONTRIB_XT5_HASH, { placeholderTier: false });
        expect(pooled).not.toBeNull();
        expect(pooled!.tier).toBe('auto_pool');
        expect(pooled!.k1).toBeCloseTo(-0.12, 6); // median
        expect(pooled!.n).toBe(3);
    });

    it('filters strictly by train hash — a different train never contributes', () => {
        const otherHash = deriveOpticalTrainHash({ camera: 'Canon EOS 60Da', lens: '', filter: 'NONE' });
        const deposits = [mkDeposit(-0.12, { trainHash: otherHash })];
        expect(resolveIdentityProfile(deposits, CONTRIB_XT5_HASH, { placeholderTier: true })).toBeNull();
    });

    it('pools MEDIAN k2 only over the k2-fitted subset', () => {
        const noK2 = resolveIdentityProfile([mkDeposit(-0.12)], CONTRIB_XT5_HASH, { placeholderTier: true });
        expect(noK2!.k2_fitted).toBe(false);
        expect(noK2!.k2).toBe(0);
        const withK2 = resolveIdentityProfile([mkDeposit(-0.12, { k2: 0.05 })], CONTRIB_XT5_HASH, { placeholderTier: true });
        expect(withK2!.k2_fitted).toBe(true);
        expect(withK2!.k2).toBeCloseTo(0.05, 9);
    });
});

// ─── RESOLVER RUNG-0 PRECEDENCE + SKIP-LENS_DB ─────────────────────────────────
describe('resolveLensDistortion rung-0 (identity) — top rung, skips generic DB', () => {
    const identity: IdentityDistortionProfile = { k1: -0.099, k2: 0.02, trainHash: CONTRIB_XT5_HASH, lensModel: 'XF23mmF1.4 R', focalLength: 23 };

    it('a matched identity returns source=measured:identity with the MEASURED coeffs', () => {
        const res = resolveLensDistortion({ lens_model: 'Unknown Lens', focal_length: 50 }, null, identity);
        expect(res).not.toBeNull();
        expect(res!.provenance).toBe('measured:identity');
        expect(res!.lensKey).toBe('measured:identity');
        expect(res!.k1).toBeCloseTo(-0.099, 9);
        expect(res!.k2).toBeCloseTo(0.02, 9);
    });

    it('SKIPS the generic LENS_DB/EXIF lookup even when EXIF WOULD resolve a nominal', () => {
        // A genuine ROKINON EXIF that (without identity) resolves to EXIF_TRUSTED.
        const exifOnly = resolveLensDistortion({ lens_model: ROKINON_MODEL, focal_length: 14 });
        expect(exifOnly!.provenance).toBe('EXIF_TRUSTED'); // control: EXIF path is live
        // WITH the identity, the LENS_DB nominal is skipped — identity wins.
        const withIdentity = resolveLensDistortion({ lens_model: ROKINON_MODEL, focal_length: 14 }, null, identity);
        expect(withIdentity!.provenance).toBe('measured:identity');
        expect(withIdentity!.k1).toBeCloseTo(-0.099, 9); // measured, NOT the LENS_DB -0.12
    });

    it('outranks an explicit user hint (identity = the previously-calibrated setup)', () => {
        const res = resolveLensDistortion(null, { lensKey: 'ROKINON_14_MUSTACHE' }, identity);
        expect(res!.provenance).toBe('measured:identity');
    });

    it('FALLS THROUGH to the existing ladder when identity is absent (byte-identical path)', () => {
        // no identity → the CR2 no-op guarantee still holds
        expect(resolveLensDistortion({ lens_model: 'Unknown Lens', focal_length: 50 }, null, null)).toBeNull();
        expect(resolveLensDistortion({ lens_model: 'Unknown Lens', focal_length: 50 })).toBeNull();
        // no identity + genuine EXIF → EXIF_TRUSTED as before
        expect(resolveLensDistortion({ lens_model: ROKINON_MODEL, focal_length: 14 }, null, undefined)!.provenance).toBe('EXIF_TRUSTED');
    });

    it('a non-finite identity k1 falls through (no fabricated identity prior)', () => {
        const bad: IdentityDistortionProfile = { k1: NaN, k2: 0, trainHash: CONTRIB_XT5_HASH };
        expect(resolveLensDistortion({ lens_model: 'Unknown Lens' }, null, bad)).toBeNull();
    });
});

// ─── FLAG-ON DEMO (store → identity resolver → resolver rung-0) ─────────────────
describe('flag-ON demo — seeded contrib X-T5 measured profile resolves to measured:identity', () => {
    it('a synthetic measured deposit under the contrib X-T5 train hash drives a rung-0 resolution', () => {
        // Seed the store exactly as a finished solve would (extractDeposit stamps the hash).
        const storage = new MemoryWorkbenchStorage();
        const seededReceipt = {
            metadata: { camera_model: 'Fujifilm X-T5', lens_model: 'XF23mmF1.4 R', filter_type: 'NONE', focal_length: 23 },
            solution: { ra_hours: 1, dec_degrees: 1, pixel_scale: 3, confidence: 0.8, stars_matched: 150 },
            lens_distortion_measured: { k1: -0.088, k2: 0.03, coefficients: { k1: { sigma: 1e-3 } }, n_pairs: 120, n_used: 110, r_max_sampled: 0.95, octant_counts: [2, 2, 2, 2, 2, 2, 2, 2] },
        };
        const deposit = extractDeposit(seededReceipt)!;
        expect(deposit.train_hash).toBe(CONTRIB_XT5_HASH);
        storage.append(deposit);

        // A NEW frame from the SAME optical train (registered → placeholder tier).
        const frameMeta = { camera_model: 'Fujifilm X-T5', lens_model: 'XF23mmF1.4 R', filter_type: 'NONE', focal_length: 23 };
        const trainHash = deriveRigKey(frameMeta).train_hash!;
        expect(trainHash).toBe(CONTRIB_XT5_HASH);

        const profile = resolveIdentityProfile(storage.all(), trainHash, { placeholderTier: true });
        expect(profile).not.toBeNull();
        expect(profile!.k1).toBeCloseTo(-0.088, 9);

        // Build the rung-0 candidate and resolve → source=measured:identity, LENS_DB skipped.
        const identity: IdentityDistortionProfile = { k1: profile!.k1, k2: profile!.k2, trainHash, lensModel: 'XF23mmF1.4 R', focalLength: 23 };
        const resolution = resolveLensDistortion(frameMeta, null, identity);
        expect(resolution!.provenance).toBe('measured:identity');
        expect(resolution!.k1).toBeCloseTo(-0.088, 9);
        // eslint-disable-next-line no-console
        console.log(`[IdentityProfile][DEMO] contrib X-T5 train ${trainHash.slice(0, 12)}… → source='${resolution!.provenance}' k1=${resolution!.k1} (generic LENS_DB skipped)`);
    });
});
