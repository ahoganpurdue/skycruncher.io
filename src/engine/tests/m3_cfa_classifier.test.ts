import { describe, it, expect } from 'vitest';
import { DemosaicEngine } from '../pipeline/m3_gpu_preprocess/demosaic_engine';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

/**
 * M3 CFA classifier — std-Bayer / mono / quad-Bayer discrimination on the RAW
 * frame before 2x2 binning. Every case below has a HAND-COMPUTED answer.
 *
 * Fixed channel levels (pedestal BLACK subtracted only in the normaliser):
 *   R=4000  G=3000  B=2000  BLACK=1000
 * The classifier is pattern-agnostic: it measures phase-mean SEPARATION, not
 * which phase is which colour.
 *
 * Phase indexing (matches classifyCFA): for block (bx,by) the four photosites are
 *   p0=(2by  , 2bx  )  p1=(2by  , 2bx+1)  p2=(2by+1, 2bx)  p3=(2by+1, 2bx+1)
 */

const R = 4000, G = 3000, B = 2000, BLACK = 1000;

/** Standard 2x2 CFA. layout maps [p0,p1,p2,p3] photosite roles to values. */
function buildStdBayer(w: number, h: number, layout: [number, number, number, number]): Uint16Array {
    const cfa = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y & 1) * 2 + (x & 1); // 0,1,2,3 for the four 2x2 phases
            cfa[y * w + x] = layout[idx];
        }
    }
    return cfa;
}

/** Quad-Bayer: each 2x2 BLOCK is a single colour; blocks form a super-RGGB. */
function buildQuadBayer(w: number, h: number, layout: [number, number, number, number]): Uint16Array {
    const cfa = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const bx = x >> 1, by = y >> 1;
            const idx = (by & 1) * 2 + (bx & 1); // super-cell phase -> block colour
            cfa[y * w + x] = layout[idx];
        }
    }
    return cfa;
}

describe('M3 CFA classifier — std-Bayer / mono / quad-Bayer', () => {
    it('classifies a standard RGGB 2x2 CFA as std-bayer (hand-computed L0=1.0, L1=0)', () => {
        // RGGB: p0=R, p1=G, p2=G, p3=B. Phase means = [4000,3000,3000,2000].
        // mu=3000, denom0=mu-BLACK=2000, L0=(4000-2000)/2000 = 1.0.
        // Every 2x2 block sums to R+G+G+B -> uniform -> L1=0.
        const cfa = buildStdBayer(16, 16, [R, G, G, B]);
        const v = DemosaicEngine.classifyCFA(cfa, 16, 16, 16, BLACK);
        expect(v.klass).toBe('std-bayer');
        expect(v.supported).toBe(true);
        expect(v.phaseSpreadL0).toBeCloseTo(1.0, 6);
        expect(v.phaseSpreadL1).toBeCloseTo(0.0, 6);
        expect(v.blocksSampled).toBe(8 * 8);
    });

    it('is pattern-agnostic — a BGGR 2x2 CFA is also std-bayer (same spread)', () => {
        // BGGR: p0=B, p1=G, p2=G, p3=R -> means [2000,3000,3000,4000], L0=1.0.
        const cfa = buildStdBayer(16, 16, [B, G, G, R]);
        const v = DemosaicEngine.classifyCFA(cfa, 16, 16, 16, BLACK);
        expect(v.klass).toBe('std-bayer');
        expect(v.phaseSpreadL0).toBeCloseTo(1.0, 6);
    });

    it('classifies a uniform monochrome frame as mono (L0=0, L1=0)', () => {
        const cfa = new Uint16Array(16 * 16).fill(2500);
        const v = DemosaicEngine.classifyCFA(cfa, 16, 16, 16, BLACK);
        expect(v.klass).toBe('mono');
        expect(v.supported).toBe(true);
        expect(v.phaseSpreadL0).toBeCloseTo(0.0, 6);
        expect(v.phaseSpreadL1).toBeCloseTo(0.0, 6);
    });

    it('classifies a mildly gradient mono frame as mono (spread << L0 threshold)', () => {
        // Horizontal ramp value = 2000 + 2*x. Even cols {2006 avg}, odd {2008 avg}
        // -> L0 = 2/1007 ~ 0.002, far below the 0.035 std-bayer threshold.
        const w = 16, h = 16;
        const cfa = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cfa[y * w + x] = 2000 + 2 * x;
        const v = DemosaicEngine.classifyCFA(cfa, w, h, w, BLACK);
        expect(v.klass).toBe('mono');
        expect(v.phaseSpreadL0).toBeLessThan(PIPELINE_CONSTANTS.CFA_CLASSIFY_L0_THRESHOLD);
        expect(v.phaseSpreadL1).toBeLessThan(PIPELINE_CONSTANTS.CFA_CLASSIFY_L1_THRESHOLD);
    });

    it('classifies quad-Bayer (2x2 same-colour super-cells) and flags it unsupported (L0=0, L1=1.0)', () => {
        // Super-cell phases -> block colours: [R,G,G,B]. Pixel-level phase means
        // all average R,G,G,B equally -> L0=0. Binned image = the block-colour
        // grid = a half-res Bayer mosaic -> bm=[4000,3000,3000,2000], L1=1.0.
        const cfa = buildQuadBayer(16, 16, [R, G, G, B]);
        const v = DemosaicEngine.classifyCFA(cfa, 16, 16, 16, BLACK);
        expect(v.klass).toBe('quad-bayer');
        expect(v.supported).toBe(false);
        expect(v.phaseSpreadL0).toBeCloseTo(0.0, 6);
        expect(v.phaseSpreadL1).toBeCloseTo(1.0, 6);
    });

    it('handles stride padding correctly (padded rows are not sampled)', () => {
        // width 16, stride 20 (4px right padding, left as 0). std-bayer content in
        // the first 16 columns must still classify std-bayer with L0=1.0.
        const w = 16, h = 16, stride = 20;
        const cfa = new Uint16Array(stride * h); // padding stays 0
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y & 1) * 2 + (x & 1);
                cfa[y * stride + x] = [R, G, G, B][idx];
            }
        }
        const v = DemosaicEngine.classifyCFA(cfa, w, h, stride, BLACK);
        expect(v.klass).toBe('std-bayer');
        expect(v.phaseSpreadL0).toBeCloseTo(1.0, 6);
    });

    it('degrades honestly on a frame too small to classify (defaults to mono)', () => {
        const v = DemosaicEngine.classifyCFA(new Uint16Array(1), 1, 1, 1, BLACK);
        expect(v.klass).toBe('mono');
        expect(v.blocksSampled).toBe(0);
        expect(v.reason).toMatch(/too small/i);
    });
});
