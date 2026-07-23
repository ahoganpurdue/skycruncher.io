// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL WORKBENCH — store + collection-hook unit tests
// ═══════════════════════════════════════════════════════════════════════════
// Covers: rig keying (MODEL_ONLY vs SERIAL, focal-length NEVER a key), compact
// deposit extraction from a finished receipt, stable receipt hashing, weighted
// pooling + recompute, drift-fork epoch machinery, the browser localStorage
// fallback (with a fake Storage) incl. eviction cap, and — the load-bearing one —
// the collection hook's NEVER-FATAL + ZERO-MUTATION contract.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    deriveRigKey,
    extractDeposit,
    hashReceipt,
    weightedMeanSigma,
    detectDrift,
    assignEpoch,
    recomputeRigProfile,
    MemoryWorkbenchStorage,
    type ObservationDeposit,
    type WorkbenchStorage,
} from '@/engine/pipeline/m2_hardware/workbench_store';
import {
    LocalStorageWorkbenchStorage,
    type StorageLike,
} from '@/engine/pipeline/m2_hardware/workbench_storage_browser';
import {
    configureWorkbench,
    depositFromReceipt,
    currentWorkbenchStorage,
    __resetWorkbenchForTest,
} from '@/engine/pipeline/stages/workbench_deposit';

// ─── a realistic finished receipt (serialized-block shapes) ───────────────────
function makeReceipt(over: any = {}): any {
    return {
        version: '2.2.0',
        metadata: {
            camera_model: 'ZWO Seestar S50',
            lens_model: 'Seestar S50 250mm f/5',
            focal_length: 250,
            aperture: 5,
            timestamp: '2026-03-01T10:00:00Z',
            ...(over.metadata ?? {}),
        },
        solution: {
            ra_hours: 11.341253, dec_degrees: 12.9, pixel_scale: 3.6776, confidence: 0.831,
            stars_matched: 272,
            astrometry: {
                rms_arcsec: 0.92, distortion_detected: true,
                sip: { a_order: 2, b_order: 2, a: [[0, 0], [0, 0]], b: [[0, 0], [0, 0]] },
                tps: { control_count: 40, rms_after_arcsec: 0.5 },
            },
            bc_rematch: {
                attempted: true, applied: false, guard: 'KEPT_ORIGINAL', chain_stage: 'FINAL',
                matched_before: 272, matched_after: 272, edge_before: 10, edge_after: 10,
            },
            ...(over.solution ?? {}),
        },
        lens_distortion_measured: over.lens_distortion_measured !== undefined ? over.lens_distortion_measured : {
            provenance: 'MEASURED', model: 'brown-conrady',
            k1: -0.012, k2: 0.003,
            coefficients: { k1: { value: -1.2e-2, sigma: 1e-3 }, k2: { value: 3e-3, sigma: 5e-4 } },
            n_pairs: 200, n_used: 190, r_max_sampled: 0.92,
            octant_counts: [30, 25, 28, 26, 31, 24, 27, 29],
            coverage_refused: { k2: false, k3: true, tangential: false },
            mustache: { verdict: 'MUSTACHE MEASURED' },
            not_measured: null,
        },
        psf_field: over.psf_field !== undefined ? over.psf_field : {
            ledger: 'PIXEL', method: 'LM', grid: 'SCIENCE_NATIVE',
            n_input: 300, n_fit: 250, n_lm: 250, n_moment: 0,
            fwhm_median_maj_px: 3.1, fwhm_median_min_px: 2.9,
            ellipticity_median: 0.06, orientation_median_deg: 12,
            regions: [], approximate: [], not_measured: null,
        },
        spcc: over.spcc !== undefined ? over.spcc : {
            source: 'SPCC_RGB', color_slope: 1, color_intercept: 0, color_r2: 0.9,
            color_rmse: 0.1, zeropoint: 20.5, zp_rmse: 0.05, n_stars: 100, air_mass: 1.2,
        },
        timestamp_trusted: true,
        export_date: '2026-07-09T00:00:00.000Z',
    };
}

// ─── KEYING ───────────────────────────────────────────────────────────────────
describe('deriveRigKey', () => {
    it('degrades to MODEL_ONLY (body model × lens) when no serial is surfaced', () => {
        const k = deriveRigKey({ camera_model: 'Canon EOS 5D3', lens_model: 'Samyang 14mm', focal_length: 14 });
        expect(k.quality).toBe('MODEL_ONLY');
        expect(k.body_serial).toBeNull();
        expect(k.key).toBe('Canon EOS 5D3|Samyang 14mm');
    });

    it('uses SERIAL quality when a serial is present, and NEVER keys on focal length', () => {
        const base = { camera_model: 'Canon EOS 5D3', lens_model: 'Samyang 14mm', serial_number: 'SN-42' };
        const k = deriveRigKey({ ...base, focal_length: 14 });
        expect(k.quality).toBe('SERIAL');
        expect(k.body_serial).toBe('SN-42');
        expect(k.key).toContain('SN-42');
        // focal length is NEVER a key component: same rig at a different FL → same key
        expect(deriveRigKey({ ...base, focal_length: 400 }).key).toBe(k.key);
    });

    it('normalizes missing identity to UNKNOWN (never throws)', () => {
        const k = deriveRigKey(null);
        expect(k.key).toBe('UNKNOWN|UNKNOWN');
        expect(k.quality).toBe('MODEL_ONLY');
    });
});

// ─── EXTRACTION ─────────────────────────────────────────────────────────────
describe('extractDeposit', () => {
    it('maps every measured block into a compact row (focal length recorded, not keyed)', () => {
        const d = extractDeposit(makeReceipt())!;
        expect(d).not.toBeNull();
        expect(d.rig_key).toBe('ZWO Seestar S50|Seestar S50 250mm f/5');
        expect(d.key_quality).toBe('MODEL_ONLY');
        expect(d.focal_length_mm).toBe(250);          // FL recorded for context...
        // ...but never a key component: a differing focal_length yields the same rig_key
        const dFl = extractDeposit(makeReceipt({ metadata: { focal_length: 130 } }))!;
        expect(dFl.rig_key).toBe(d.rig_key);
        expect(dFl.focal_length_mm).toBe(130);
        expect(d.bc.measured).toBe(true);
        expect(d.bc.k1).toBeCloseTo(-0.012, 6);
        expect(d.bc.k2).toBeCloseTo(0.003, 6);
        expect(d.bc.k1_sigma).toBeCloseTo(1e-3, 9);
        expect(d.bc.n_used).toBe(190);
        expect(d.bc.octant_counts).toHaveLength(8);
        expect(d.sip.present).toBe(true);
        expect(d.sip.a_order).toBe(2);
        expect(d.sip.rms_arcsec).toBeCloseTo(0.92, 6);
        expect(d.tps.present).toBe(true);
        expect(d.tps.control_count).toBe(40);
        expect(d.psf.measured).toBe(true);
        expect(d.psf.fwhm_median_maj_px).toBeCloseTo(3.1, 6);
        expect(d.zero_point).toBeCloseTo(20.5, 6);
        expect(d.bc_rematch.present).toBe(true);
        expect(d.bc_rematch.guard).toBe('KEPT_ORIGINAL');
        expect(d.pixel_scale_arcsec).toBeCloseTo(3.6776, 4);
        expect(d.stars_matched).toBe(272);
        expect(d.receipt_hash).toMatch(/^r53_/);
    });

    it('returns null when there is no solution (nothing to pool)', () => {
        expect(extractDeposit({ solution: null })).toBeNull();
        expect(extractDeposit(null)).toBeNull();
    });

    it('honours not_measured BC + absent psf/spcc (honest-absent, not fabricated)', () => {
        const d = extractDeposit(makeReceipt({
            lens_distortion_measured: { not_measured: 'insufficient matched pairs', k1: null, k2: null, coefficients: {}, n_pairs: 4, n_used: 0, octant_counts: [0, 0, 0, 0, 0, 0, 0, 0] },
            psf_field: { method: 'NOT_MEASURED', not_measured: 'no science buffer' },
            spcc: null,
        }))!;
        expect(d.bc.measured).toBe(false);
        expect(d.bc.k1).toBeNull();
        expect(d.bc.not_measured).toBe('insufficient matched pairs');
        expect(d.psf.measured).toBe(false);
        expect(d.zero_point).toBeNull();
    });
});

// ─── RECEIPT HASH ─────────────────────────────────────────────────────────────
describe('hashReceipt', () => {
    it('is stable across the export_date wall-clock stamp (content, not clock)', () => {
        const a = makeReceipt();
        const b = makeReceipt();
        b.export_date = '2099-01-01T00:00:00.000Z';
        expect(hashReceipt(a)).toBe(hashReceipt(b));
    });
    it('changes when science content changes', () => {
        const a = makeReceipt();
        const b = makeReceipt();
        b.solution.ra_hours = 12.0;
        expect(hashReceipt(a)).not.toBe(hashReceipt(b));
    });
    it('never throws on typed arrays / cyclic-free live refs', () => {
        const r = makeReceipt();
        (r as any).blob = new Float32Array([1, 2, 3]);
        expect(() => hashReceipt(r)).not.toThrow();
    });
});

// ─── POOLING + RECOMPUTE ─────────────────────────────────────────────────────
describe('weightedMeanSigma + recomputeRigProfile', () => {
    it('single frame → mean defined, dispersion honest-absent (null)', () => {
        const r = weightedMeanSigma([-0.012], [1000]);
        expect(r.mean).toBeCloseTo(-0.012, 9);
        expect(r.sigma).toBeNull();
        expect(r.n).toBe(1);
    });
    it('pools two identical-rig deposits: N=2, k1 mean = deposit value, coverage union filled', () => {
        const d1 = extractDeposit(makeReceipt())!;
        const d2 = extractDeposit(makeReceipt())!;
        const prof = recomputeRigProfile([d1, d2])!;
        expect(prof.n_deposits).toBe(2);
        expect(prof.epochs).toHaveLength(1);
        const e0 = prof.epochs[0];
        expect(e0.epoch).toBe(0);
        expect(e0.n).toBe(2);
        expect(e0.k1_mean!).toBeCloseTo(-0.012, 6);   // recompute yields the deposit values
        expect(e0.k1_sigma!).toBeCloseTo(0, 9);        // identical fits → zero spread
        expect(e0.coverage_octants_union).toBe(8);
        expect(e0.receipt_hashes).toHaveLength(2);
        expect(prof.application).toBe('NONE');         // NO application — ladder-gated
    });
});

// ─── DRIFT / EPOCH FORK ───────────────────────────────────────────────────────
function mkDeposit(k1: number, sigma = 1e-3, nUsed = 100, epoch = 0): ObservationDeposit {
    return {
        schema: '1.0.0', rig_key: 'BODY|LENS', key_quality: 'MODEL_ONLY',
        body: 'BODY', lens: 'LENS', body_serial: null, epoch,
        captured_at: null, timestamp_trusted: true, deposited_at: 'now', receipt_hash: 'r53_x',
        aperture: null, focal_length_mm: null, pixel_scale_arcsec: null, stars_matched: null,
        bc: { measured: true, k1, k2: null, k1_sigma: sigma, k2_sigma: null, n_pairs: nUsed, n_used: nUsed, r_max_sampled: 0.9, octant_counts: [1, 1, 1, 1, 1, 1, 1, 1], coverage_refused: null, mustache_verdict: null, not_measured: null },
        sip: { present: false, a_order: null, b_order: null, rms_arcsec: null },
        tps: { present: false, control_count: null, rms_after_arcsec: null },
        psf: { measured: false, fwhm_median_maj_px: null, fwhm_median_min_px: null, ellipticity_median: null, n_fit: null, method: null },
        zero_point: null, zero_point_rmse: null,
        bc_rematch: { present: false, guard: null, applied: null, matched_before: null, matched_after: null, edge_before: null, edge_after: null },
    };
}

describe('detectDrift + assignEpoch (comparative, not a calibrated gate)', () => {
    it('no drift with < 2 prior fits (dispersion undefined)', () => {
        expect(assignEpoch([mkDeposit(-0.010)], mkDeposit(-0.010))).toBe(0);
    });
    it('a consistent new fit stays in the current epoch', () => {
        const prior = [mkDeposit(-0.010), mkDeposit(-0.011), mkDeposit(-0.012)];
        expect(assignEpoch(prior, mkDeposit(-0.0115))).toBe(0);
    });
    it('a sign flip clearing dispersion forks a new epoch', () => {
        const prior = [mkDeposit(-0.010), mkDeposit(-0.012)];
        expect(detectDrift([-0.010, -0.012], [1e6, 1e6], 0.05).drift).toBe(true);
        expect(assignEpoch(prior, mkDeposit(0.05))).toBe(1);
    });
    it('a >3σ same-sign departure forks a new epoch', () => {
        const prior = [mkDeposit(-0.0100), mkDeposit(-0.0110), mkDeposit(-0.0120)];
        expect(assignEpoch(prior, mkDeposit(-0.0500))).toBe(1);
    });
});

// ─── BROWSER localStorage FALLBACK (fake Storage in node) ─────────────────────
function fakeStorage(): StorageLike {
    const m = new Map<string, string>();
    return { getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => { m.set(k, v); } };
}

describe('LocalStorageWorkbenchStorage', () => {
    it('round-trips deposits and filters by rig key', () => {
        const s = new LocalStorageWorkbenchStorage(fakeStorage(), 100);
        s.append(mkDeposit(-0.01)); // rig_key BODY|LENS
        const other = mkDeposit(-0.02); (other as any).rig_key = 'OTHER|LENS';
        s.append(other);
        expect(s.list()).toHaveLength(2);
        expect(s.list('BODY|LENS')).toHaveLength(1);
    });
    it('enforces the oldest-first eviction cap (mechanics)', () => {
        const s = new LocalStorageWorkbenchStorage(fakeStorage(), 3);
        for (let i = 0; i < 5; i++) { const d = mkDeposit(-0.01); d.receipt_hash = `h${i}`; s.append(d); }
        const rows = s.list();
        expect(rows).toHaveLength(3);
        expect(rows.map(r => r.receipt_hash)).toEqual(['h2', 'h3', 'h4']); // oldest (h0,h1) evicted
    });
});

// ─── COLLECTION HOOK: never-fatal + zero-mutation + accrual ────────────────────
describe('depositFromReceipt collection hook', () => {
    beforeEach(() => __resetWorkbenchForTest());

    it('accrues one row per solve into the injected storage (default-on)', () => {
        const store = new MemoryWorkbenchStorage();
        configureWorkbench({ storage: store });
        depositFromReceipt(makeReceipt());
        depositFromReceipt(makeReceipt());
        const rows = store.all();
        expect(rows).toHaveLength(2);
        expect(rows[0].rig_key).toBe(rows[1].rig_key);         // same rig, stable key
        expect(rows.every(r => r.epoch === 0)).toBe(true);      // consistent fits, no fork
    });

    it('is a no-op when no storage backend exists (honest absence)', () => {
        __resetWorkbenchForTest();
        expect(() => depositFromReceipt(makeReceipt())).not.toThrow();
        expect(currentWorkbenchStorage()).toBeNull();           // node env: no browser storage
    });

    it('NEVER-FATAL: a throwing storage (list) does not throw and does not mutate the receipt', () => {
        const throwing: WorkbenchStorage = {
            list() { throw new Error('boom-list'); },
            append() { throw new Error('boom-append'); },
        };
        configureWorkbench({ storage: throwing });
        const receipt = makeReceipt();
        const before = JSON.stringify(receipt);
        expect(() => depositFromReceipt(receipt)).not.toThrow();
        expect(JSON.stringify(receipt)).toBe(before);           // byte-identical receipt
    });

    it('NEVER-FATAL: a throwing append (after a clean list) is swallowed, receipt untouched', () => {
        const throwing: WorkbenchStorage = {
            list() { return []; },
            append() { throw new Error('boom-append'); },
        };
        configureWorkbench({ storage: throwing });
        const receipt = makeReceipt();
        const before = JSON.stringify(receipt);
        expect(() => depositFromReceipt(receipt)).not.toThrow();
        expect(JSON.stringify(receipt)).toBe(before);
    });

    it('honours the enabled flag (default-on; explicit off = no deposit)', () => {
        const store = new MemoryWorkbenchStorage();
        configureWorkbench({ storage: store, enabled: false });
        depositFromReceipt(makeReceipt());
        expect(store.all()).toHaveLength(0);
    });
});
