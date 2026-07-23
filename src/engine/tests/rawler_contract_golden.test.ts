/**
 * rawler_cfa contract shape vs the COMMITTED golden manifest (LAW 7).
 *
 * The manifest (test_results/decoder_prestage/golden/IMG_1653.CR2.
 * golden_manifest.json) is the committed golden-vector pointer captured by the
 * pre-stage probe and reproduced bit-for-bit at wasm runtime by
 * src/engine/wasm_decode. This suite pins the SCHEMA ENTRY and the manifest to
 * each other so neither can drift silently. It does NOT decode anything (the
 * wasm pkg is a local build; real-decode conformance is the A/B lane's job —
 * tools/rawlab/ab_live.mjs).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BINARY_LAYOUTS, BINARY_LAYOUTS_VERSION } from '../contracts/binary_layouts';

const entry = BINARY_LAYOUTS.find((e) => e.name === 'rawler_cfa')!;
const manifestPath = path.resolve(process.cwd(), 'test_results/decoder_prestage/golden/IMG_1653.CR2.golden_manifest.json');

describe('rawler_cfa schema entry ↔ committed golden manifest', () => {
    it('schema entry exists at surface 0.5.0 with a measured pointer', () => {
        // Surface bumped 0.2.0 -> 0.3.0 when atlas_rows' golden vector was born
        // (atlas reproduce-first), 0.3.0 -> 0.4.0 when the seam_capsule entry
        // landed (additive), 0.4.0 -> 0.5.0 when the g15u_stars_arrow entry landed
        // (additive, confirm-lane Gaia-only cutover); rawler_cfa's pointer unchanged.
        expect(BINARY_LAYOUTS_VERSION).toBe('0.5.0');
        expect(entry).toBeTruthy();
        expect(entry.goldenVector).not.toBeNull();
    });

    it('the pointer path IS the committed manifest', () => {
        expect(entry.goldenVector!.manifestPath).toBe(
            'test_results/decoder_prestage/golden/IMG_1653.CR2.golden_manifest.json'
        );
        expect(fs.existsSync(manifestPath), `committed manifest missing at ${manifestPath}`).toBe(true);
    });

    it('schema md5s match the manifest md5s (CFA + companion demosaic luma)', () => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // CFA golden: full-frame u16 LE.
        expect(entry.goldenVector!.md5).toBe(manifest.cfa.md5);
        expect(manifest.cfa.md5).toBe('968381f814547668c6a85b75f31038f2');
        expect(manifest.cfa.dtype).toBe('u16_le');
        // Companion demosaic-luma golden recorded in the status string.
        expect(entry.goldenVectorStatus).toContain(manifest.demosaic_luma.md5);
        expect(manifest.demosaic_luma.md5).toBe('4f7560079a37316dae7595006bc46e1f');
    });

    it('contract dims/geometry in the schema match the manifest measurements', () => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // Full-frame dims ride the serialization sentence (5344x3516).
        expect(entry.goldenVector!.serialization).toContain(manifest.cfa.dims);
        expect(entry.goldenVector!.serialization).toContain(String(manifest.cfa.len_bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
        // len_bytes must equal dims * 2 (u16) — the stride rule's arithmetic.
        const [w, h] = manifest.cfa.dims.split('x').map(Number);
        expect(manifest.cfa.len_bytes).toBe(w * h * 2);
        // Pattern + active-area facts pinned in the strideRule sentence.
        expect(entry.strideRule).toContain(manifest.cfa.pattern); // GBRG
        expect(entry.strideRule).toContain(manifest.cfa.dims);    // 5344x3516
        // Per-frame black variability is documented with the golden frame's value.
        expect(entry.units).toContain(String(manifest.blacklevel_bayer[0])); // 2046
    });

    it('units are first-class and honest (raw ADU, pedestal, not scaled)', () => {
        expect(entry.units).toContain('raw ADU');
        expect(entry.units).toContain('NOT black-subtracted');
        expect(entry.dtype).toContain('cpp=1');
        expect(entry.coordinateConvention).toContain('y-down');
    });
});
