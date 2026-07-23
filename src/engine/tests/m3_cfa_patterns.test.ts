import { describe, it, expect } from 'vitest';
import { DemosaicEngine } from '../pipeline/m3_gpu_preprocess/demosaic_engine';
import { bayerPatternToOffsets, DEFAULT_DEMOSAIC_PARAMS, type DemosaicParams } from '../pipeline/m3_gpu_preprocess/demosaic_pipeline';

const BIAS = 1000;
const R_VAL = BIAS + 3000;
const G_VAL = BIAS + 2000;
const B_VAL = BIAS + 1000;

/**
 * Build an 8×8 CFA where each photosite carries the physical value of its
 * channel role under the given pattern offsets (R at ((x+ox)&1)==0 && ((y+oy)&1)==0).
 */
function buildCfa(ox: number, oy: number): Uint16Array {
    const w = 8, h = 8;
    const cfa = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const evenCol = (x + ox) % 2 === 0;
            const evenRow = (y + oy) % 2 === 0;
            if (evenRow && evenCol) cfa[y * w + x] = R_VAL;
            else if (!evenRow && !evenCol) cfa[y * w + x] = B_VAL;
            else cfa[y * w + x] = G_VAL;
        }
    }
    return cfa;
}

describe('M3 CFA Patterns — parameterized bilinear demosaic', () => {
    it('maps BAYERPAT strings to RGGB-parity offsets', () => {
        expect(bayerPatternToOffsets('RGGB')).toEqual({ x: 0, y: 0 });
        expect(bayerPatternToOffsets('GRBG')).toEqual({ x: 1, y: 0 });
        expect(bayerPatternToOffsets('GBRG')).toEqual({ x: 0, y: 1 });
        expect(bayerPatternToOffsets('BGGR')).toEqual({ x: 1, y: 1 });
        expect(bayerPatternToOffsets('grbg')).toEqual({ x: 1, y: 0 }); // case-insensitive
        expect(bayerPatternToOffsets('')).toEqual({ x: 0, y: 0 });     // default
    });

    it('defaults reproduce the legacy hardcoded constants', () => {
        expect(DEFAULT_DEMOSAIC_PARAMS).toEqual({
            cfaOffsetX: 0, cfaOffsetY: 0,
            blackLevel: 2048, whiteLevel: 16383,
            wbR: 2.1, wbG: 1.0, wbB: 1.4,
        });
    });

    for (const pattern of ['RGGB', 'GRBG', 'GBRG', 'BGGR'] as const) {
        it(`decodes ${pattern} channels correctly with matching offsets`, () => {
            const { x: ox, y: oy } = bayerPatternToOffsets(pattern);
            const cfa = buildCfa(ox, oy);
            const params: DemosaicParams = {
                cfaOffsetX: ox, cfaOffsetY: oy,
                blackLevel: BIAS, whiteLevel: BIAS + 16383,
                wbR: 1.0, wbG: 1.0, wbB: 1.0,
            };
            const out = DemosaicEngine.demosaicBilinear(cfa, 8, 8, 8, params);
            const ns = 1 / 16383;

            // Every interior pixel must decode to the pure channel values,
            // because each channel is spatially constant in the synthetic CFA.
            for (let y = 1; y < 7; y++) {
                for (let x = 1; x < 7; x++) {
                    const idx = (y * 8 + x) * 3;
                    expect(out[idx]).toBeCloseTo(3000 * ns, 5);     // R
                    expect(out[idx + 1]).toBeCloseTo(2000 * ns, 5); // G
                    expect(out[idx + 2]).toBeCloseTo(1000 * ns, 5); // B
                }
            }
        });
    }

    it('RGGB with no params equals the explicit-default output (regression)', () => {
        // Deterministic pseudo-random raw values in the 14-bit range
        const raw = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
            raw[i] = 2048 + Math.floor(12000 * Math.abs(Math.sin(i * 12.9898 + 78.233)));
        }
        const legacy = DemosaicEngine.demosaicBilinear(raw, 8, 8, 8);
        const withDefaults = DemosaicEngine.demosaicBilinear(raw, 8, 8, 8, DEFAULT_DEMOSAIC_PARAMS);
        expect(withDefaults).toEqual(legacy);

        // Hand-computed legacy spot check at (2,2): RED photosite under RGGB
        const i = 2 * 8 + 2;
        const nsLegacy = 1 / (16383 - 2048);
        const expR = Math.max(0, (raw[i] - 2048) * nsLegacy * 2.1);
        const expG = Math.max(0, ((raw[i - 1] + raw[i + 1] + raw[i - 8] + raw[i + 8]) / 4 - 2048) * nsLegacy * 1.0);
        const expB = Math.max(0, ((raw[i - 9] + raw[i - 7] + raw[i + 7] + raw[i + 9]) / 4 - 2048) * nsLegacy * 1.4);
        const outIdx = (2 * 8 + 2) * 3;
        expect(legacy[outIdx]).toBeCloseTo(expR, 6);
        expect(legacy[outIdx + 1]).toBeCloseTo(expG, 6);
        expect(legacy[outIdx + 2]).toBeCloseTo(expB, 6);
    });
});
