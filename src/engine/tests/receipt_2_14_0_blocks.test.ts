/**
 * RECEIPT SCHEMA 2.14.0 — three additive, honest-or-absent blocks.
 *
 * Pins the additive train 2.13.0 → 2.14.0 (rawler_calibration + user_target_hint +
 * nebulosity_layer). All three are pure post-decode/post-solve SURFACING, so the
 * SOLVE stays byte-identical (proven on both sacred paths by the *.apispec headless
 * smokes — the version-pin lines there rebaseline with this bump). Here we assert:
 *   • present-when-expected / null-when-absent for each block (LAW 3), and
 *   • buildFailureReceipt (the no-solve product) carries the version + the three
 *     blocks consistently.
 */
import { describe, it, expect } from 'vitest';
import {
    buildReceipt,
    buildFailureReceipt,
    type ReceiptInputs,
    type FailureReceiptInputs,
} from '../pipeline/stages/package';
import { RECEIPT_SCHEMA_VERSION } from '../pipeline/stages/schema_versions';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import {
    summarizeRawlerCalibration,
    type RawlerCfaRecord,
} from '../pipeline/m1_ingestion/rawler_decoder';
import { buildUserTargetHint } from '../pipeline/stages/user_target_hint';
import {
    decomposeNebulosityLayers,
    buildNebulosityLayerReceipt,
} from '../pipeline/m10_psf/nebulosity_layer';
import type { PlateSolution } from '../types/Main_types';
import type { CallerTargetHint } from '../pipeline/stages/solve';

// ── minimal fixtures (mirror m6_pipeline_provenance.test.ts) ──────────────────

function solution(extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        odds: 1, confidence: 0.9, num_stars: 0, matched_stars: [],
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

function baseInputs(extra: Partial<ReceiptInputs> = {}): ReceiptInputs {
    return {
        metadata: null, signal: null, solution: solution(), planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, decoderArm: null, imageWidth: 1000, imageHeight: 1000,
        ...extra,
    };
}

function baseFailureInputs(extra: Partial<FailureReceiptInputs> = {}): FailureReceiptInputs {
    return {
        metadata: null, signal: null, solveDiagnostics: null, stageTimings: null,
        stageReached: 'solve', stageOfDeath: 'solve', failReason: 'no geometric lock',
        frameSha256: null, sourceFormat: 'CR2', warnings: [], timestampTrusted: false,
        decoderArm: 'rawler', imageWidth: 100, imageHeight: 100,
        ...extra,
    };
}

/** A full rawler CFA record with a heavy raw OB `pixels` buffer (to prove the drop). */
function rawlerRecord(): RawlerCfaRecord {
    return {
        decoder: 'rawler-0.7.2',
        demosaic: 'integer-bilinear-v1',
        fullWidth: 5202, fullHeight: 3464,
        pattern: 'GBRG', patternActive: 'RGGB',
        levels: { black: [2047, 2047, 2047, 2047], white: [15000] },
        wb: [2.1, 1.0, 1.5, null],
        activeArea: { x: 0, y: 0, w: 5184, h: 3456 },
        cropArea: { x: 8, y: 4, w: 5184, h: 3456 },
        obAreas: [{
            rect: { x: 0, y: 0, w: 4, h: 4 },
            pixels: new Uint16Array([2050, 2048, 2046, 2049, 2047, 2045, 2051, 2048,
                2046, 2049, 2047, 2050, 2048, 2046, 2049, 2047]),
            mean: 2047.9, std: 1.8, min: 2045, max: 2051, n: 16,
        }],
        valueDomain: 'raw_adu_pedestal_over_65535',
    };
}

// ── version ───────────────────────────────────────────────────────────────────

describe('receipt 2.14.0 blocks — version (train continues at 2.16.0)', () => {
    it('RECEIPT_SCHEMA_VERSION is 2.16.0 (2.14.0 blocks still present, additive; 2.16.0 adds compute_routes)', () => {
        expect(RECEIPT_SCHEMA_VERSION).toBe('2.20.0');
    });
    it('buildReceipt + buildFailureReceipt both stamp the current version', () => {
        expect(buildReceipt(baseInputs()).version).toBe('2.20.0');
        expect(buildFailureReceipt(baseFailureInputs()).version).toBe('2.20.0');
    });
});

// ── block 1: rawler_calibration ────────────────────────────────────────────────

describe('rawler_calibration — summarizeRawlerCalibration (lean reduction)', () => {
    it('null/undefined record ⇒ null (libraw cold path / FITS / demo-tier)', () => {
        expect(summarizeRawlerCalibration(null)).toBeNull();
        expect(summarizeRawlerCalibration(undefined)).toBeNull();
    });

    it('maps the calibration fields and DROPS the heavy raw OB pixel buffers (stats only)', () => {
        const c = summarizeRawlerCalibration(rawlerRecord())!;
        expect(c.decoder).toBe('rawler-0.7.2');
        expect(c.demosaic).toBe('integer-bilinear-v1');
        expect(c.full_width).toBe(5202);
        expect(c.full_height).toBe(3464);
        expect(c.pattern).toBe('GBRG');
        expect(c.pattern_active).toBe('RGGB');
        expect(c.black_levels).toEqual([2047, 2047, 2047, 2047]);
        expect(c.white_levels).toEqual([15000]);
        expect(c.wb).toEqual([2.1, 1.0, 1.5, null]);
        expect(c.active_area).toEqual({ x: 0, y: 0, w: 5184, h: 3456 });
        expect(c.value_domain).toBe('raw_adu_pedestal_over_65535');
        // OB harvest: geometry + stats survive, the raw `pixels` buffer is GONE.
        expect(c.ob_areas).toHaveLength(1);
        expect(c.ob_areas[0]).toEqual({
            rect: { x: 0, y: 0, w: 4, h: 4 }, mean: 2047.9, std: 1.8, min: 2045, max: 2051, n: 16,
        });
        expect('pixels' in (c.ob_areas[0] as unknown as Record<string, unknown>)).toBe(false);
    });
});

describe('rawler_calibration — receipt surfacing (honest-or-absent)', () => {
    it('present when HardMetadata carries the calibration (rawler arm)', () => {
        const calib = summarizeRawlerCalibration(rawlerRecord());
        const r = buildReceipt(baseInputs({ metadata: { rawler_calibration: calib } as any }));
        expect(r.rawler_calibration).not.toBeNull();
        expect(r.rawler_calibration.decoder).toBe('rawler-0.7.2');
        expect(r.rawler_calibration.wb).toEqual([2.1, 1.0, 1.5, null]);
    });
    it('null when metadata is null / carries no calibration (libraw cold path / FITS)', () => {
        expect(buildReceipt(baseInputs({ metadata: null })).rawler_calibration).toBeNull();
        expect(buildReceipt(baseInputs({ metadata: { camera_model: 'x' } as any })).rawler_calibration).toBeNull();
    });
    it('banked on the no-solve receipt too when a rawler decode ran before the fail', () => {
        const calib = summarizeRawlerCalibration(rawlerRecord());
        const r = buildFailureReceipt(baseFailureInputs({ metadata: { rawler_calibration: calib } as any }));
        expect(r.rawler_calibration).not.toBeNull();
        expect(r.rawler_calibration.decoder).toBe('rawler-0.7.2');
    });
});

// ── block 2: user_target_hint ───────────────────────────────────────────────────

const hint = (extra: Partial<CallerTargetHint> = {}): CallerTargetHint =>
    ({ ra: 1.5, dec: 20, label: 'M31', ...extra });

describe('user_target_hint — buildUserTargetHint (pure)', () => {
    it('CONFIG + a real hint ⇒ the supplied value under assumed:true, fov honestly null', () => {
        expect(buildUserTargetHint('CONFIG', hint())).toEqual({
            target_name: 'M31', ra_hours: 1.5, dec_degrees: 20, fov_deg: null, assumed: true,
        });
    });
    it('null label ⇒ target_name null (no fabrication)', () => {
        expect(buildUserTargetHint('CONFIG', hint({ label: undefined }))!.target_name).toBeNull();
    });
    it('blind / metadata / unknown source ⇒ null (only CONFIG seeds assisted:user)', () => {
        expect(buildUserTargetHint('BLIND', hint())).toBeNull();
        expect(buildUserTargetHint('FITS_HEADER', hint())).toBeNull();
        expect(buildUserTargetHint('ZENITH', hint())).toBeNull();
        expect(buildUserTargetHint(undefined, hint())).toBeNull();
        expect(buildUserTargetHint(null, hint())).toBeNull();
    });
    it('no caller hint ⇒ null', () => {
        expect(buildUserTargetHint('CONFIG', null)).toBeNull();
        expect(buildUserTargetHint('CONFIG', undefined)).toBeNull();
    });
    it('guards the azimuth-mode sentinel (ra===-1) and non-finite coords (same guard as resolveWizardHints)', () => {
        expect(buildUserTargetHint('CONFIG', hint({ ra: -1, dec: 120 }))).toBeNull();
        expect(buildUserTargetHint('CONFIG', hint({ ra: NaN }))).toBeNull();
        expect(buildUserTargetHint('CONFIG', hint({ dec: Infinity }))).toBeNull();
    });
});

describe('user_target_hint — receipt surfacing', () => {
    it('present when a CONFIG hint seeded the solve (⟺ solved_via=assisted:user)', () => {
        const r = buildReceipt(baseInputs({ hintSource: 'CONFIG', callerHint: hint() }));
        expect(r.user_target_hint).toEqual({
            target_name: 'M31', ra_hours: 1.5, dec_degrees: 20, fov_deg: null, assumed: true,
        });
        // value companion is consistent with the solve_provenance category.
        expect(r.solve_provenance).toEqual({ solved_via: 'assisted:user' });
    });
    it('null on a blind solve', () => {
        expect(buildReceipt(baseInputs({ hintSource: 'BLIND', callerHint: null })).user_target_hint).toBeNull();
    });
    it('null when there is no solve (the block is about an assisted SOLVE)', () => {
        expect(buildReceipt(baseInputs({ solution: null, hintSource: 'CONFIG', callerHint: hint() })).user_target_hint).toBeNull();
    });
});

// ── block 3: nebulosity_layer ────────────────────────────────────────────────────

describe('nebulosity_layer — producer-gap honesty', () => {
    it('null on every real receipt today (no producer stage wired ⇒ DECOMPOSITION NOT RUN)', () => {
        expect(buildReceipt(baseInputs()).nebulosity_layer).toBeNull();
        expect(buildReceipt(baseInputs({ nebulosityDecomposition: null })).nebulosity_layer).toBeNull();
    });
    it('lights up when a decomposition IS supplied (forward-compat: producer stage lands)', () => {
        // Tiny synthetic native-grid luminance frame with a compact bright core.
        const w = 24, h = 24;
        const obs = new Float32Array(w * h);
        for (let i = 0; i < obs.length; i++) obs[i] = 10 + (i % 7);
        obs[12 * w + 12] = 400; obs[12 * w + 13] = 380; obs[13 * w + 12] = 360;
        const decomp = decomposeNebulosityLayers(obs, w, h);
        const r = buildReceipt(baseInputs({ nebulosityDecomposition: decomp }));
        expect(r.nebulosity_layer).not.toBeNull();
        expect(r.nebulosity_layer.ledger).toBe('PIXEL');
        expect(r.nebulosity_layer.grid).toBe('native');
        expect(r.nebulosity_layer.approximate).toBe(true);
        expect(r.nebulosity_layer.layers).toHaveProperty('star');
        expect(r.nebulosity_layer.layers).toHaveProperty('nebulosity');
        // The widget selector reads exactly this key (NebulosityLayersWidget.tsx).
        expect(buildNebulosityLayerReceipt(decomp)).not.toBeNull();
    });
});

// ── failure receipt: all three consistent + serializer survival ──────────────────

describe('buildFailureReceipt — 2.14.0 blocks honest-or-absent', () => {
    it('user_target_hint + nebulosity_layer are always null on the no-solve product', () => {
        const r = buildFailureReceipt(baseFailureInputs());
        expect(r.user_target_hint).toBeNull();
        expect(r.nebulosity_layer).toBeNull();
        expect(r.rawler_calibration).toBeNull(); // no metadata calibration on this input
    });
    it('round-trips through the canonical serializer with the version + blocks intact', () => {
        const calib = summarizeRawlerCalibration(rawlerRecord());
        const parsed = JSON.parse(serializeReceipt(
            buildFailureReceipt(baseFailureInputs({ metadata: { rawler_calibration: calib } as any })),
        ));
        expect(parsed.version).toBe('2.20.0');
        expect(parsed.kind).toBe('no_solve');
        expect(parsed.rawler_calibration.decoder).toBe('rawler-0.7.2');
        expect(parsed.user_target_hint).toBeNull();
        expect(parsed.nebulosity_layer).toBeNull();
    });
});
