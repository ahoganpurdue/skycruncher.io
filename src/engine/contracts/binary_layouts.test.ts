import { describe, it, expect } from 'vitest';
import { BINARY_LAYOUTS, BINARY_LAYOUTS_VERSION, GOLDEN_VECTOR_STATUS } from './binary_layouts';

const REQUIRED_FIELDS = [
    'name',
    'version',
    'dtype',
    'strideRule',
    'endianness',
    'units',
    'coordinateConvention',
    'goldenVector',
    'goldenVectorStatus',
    'notes',
] as const;

const ENUMERATED_BOUNDARIES = [
    'libraw_mem_image',
    'atlas_rows',
    'starplates_blobs',
    'arrow_seam',
    'wgsl_structs',
    'wasm_typed_array',
    'fits_io',
];

/**
 * Still declaration-only, goldenVector stays null. atlas_rows GRADUATED to
 * MEASURED at surface 0.3.0 (its byte-proof golden vector was born), so it is
 * excluded here.
 */
const SEED_BOUNDARIES = ENUMERATED_BOUNDARIES.filter((n) => n !== 'atlas_rows');

/**
 * Boundaries carrying a MEASURED golden pointer:
 *  - rawler_cfa (0.2.0): pre-stage manifest, reproduced at wasm runtime.
 *  - atlas_rows (0.3.0): SHA-256 fingerprint of the frozen deep catalog,
 *    byte-proved 38/38 regenerable by tools/atlas/verify_atlas_repro.mjs.
 */
const MEASURED_BOUNDARIES = ['rawler_cfa', 'atlas_rows'];

describe('binary layout contracts (LAW 7 seed, declaration-only)', () => {
    it('has one entry per enumerated boundary', () => {
        const names = BINARY_LAYOUTS.map((e) => e.name);
        for (const n of [...ENUMERATED_BOUNDARIES, ...MEASURED_BOUNDARIES]) expect(names).toContain(n);
        // no duplicate names (each is a citation key)
        expect(new Set(names).size).toBe(names.length);
    });

    it('every entry has all required fields', () => {
        for (const e of BINARY_LAYOUTS) {
            for (const f of REQUIRED_FIELDS) expect(e).toHaveProperty(f);
        }
    });

    it('units are a non-empty string on every entry', () => {
        for (const e of BINARY_LAYOUTS) {
            expect(typeof e.units).toBe('string');
            expect(e.units.length).toBeGreaterThan(0);
        }
    });

    it('strideRule, dtype, endianness, coordinateConvention are non-empty on every entry', () => {
        for (const e of BINARY_LAYOUTS) {
            expect(e.strideRule.length).toBeGreaterThan(0);
            expect(e.dtype.length).toBeGreaterThan(0);
            expect(e.endianness.length).toBeGreaterThan(0);
            expect(e.coordinateConvention.length).toBeGreaterThan(0);
        }
    });

    it('goldenVector is null on every 0.1.0-SEED entry (still NOT MEASURED)', () => {
        for (const n of SEED_BOUNDARIES) {
            const e = BINARY_LAYOUTS.find((x) => x.name === n)!;
            expect(e.goldenVector).toBeNull();
            expect(e.goldenVectorStatus).toBe(GOLDEN_VECTOR_STATUS);
        }
    });

    it('rawler_cfa carries a MEASURED golden pointer (pre-stage manifest md5s)', () => {
        const e = BINARY_LAYOUTS.find((x) => x.name === 'rawler_cfa')!;
        expect(e).toBeTruthy();
        expect(e.goldenVector).not.toBeNull();
        // The committed golden-vector pointer (bytes are local/regenerable).
        expect(e.goldenVector!.manifestPath).toBe(
            'test_results/decoder_prestage/golden/IMG_1653.CR2.golden_manifest.json'
        );
        // Frozen pre-stage CFA md5 (full-frame u16 LE) — the row-91 ground truth.
        expect(e.goldenVector!.md5).toBe('968381f814547668c6a85b75f31038f2');
        expect(e.goldenVectorStatus).toContain('MEASURED');
        // Load-bearing contract sentences (units-first-class per LAW 7).
        expect(e.units).toContain('raw ADU');
        expect(e.strideRule).toContain('FULL sensor frame');
        expect(e.strideRule).toContain('optical-black');
    });

    it('atlas_rows carries a MEASURED golden pointer (byte-proof manifest, born 0.3.0)', () => {
        const e = BINARY_LAYOUTS.find((x) => x.name === 'atlas_rows')!;
        expect(e).toBeTruthy();
        expect(e.goldenVector).not.toBeNull();
        expect(e.goldenVector!.manifestPath).toBe('tools/atlas/atlas_repro_manifest.json');
        expect(e.goldenVector!.md5).toMatch(/^[0-9a-f]{32}$/);
        expect(e.goldenVectorStatus).toContain('MEASURED');
        // Load-bearing corrections: canonical JSON text + per-row RA-unit hybridity.
        expect(e.strideRule).toContain('JSON TEXT');
        expect(e.units).toContain('per-row');
    });

    it('surface version is 0.5.0 (mirrors surfaces.json binary_layouts)', () => {
        expect(BINARY_LAYOUTS_VERSION).toBe('0.5.0');
    });
});
