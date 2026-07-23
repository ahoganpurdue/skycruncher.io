// ═══════════════════════════════════════════════════════════════════════════
// CFA-LUMINANCE PERIOD-2 PARITY — the 2px checkerboard fix
// ═══════════════════════════════════════════════════════════════════════════
// A LibRaw noInterpolation frame is a per-site single-colour CFA mosaic served
// as interleaved "RGB" (each pixel: one dominant channel, the others ~0).
// Reducing it to detection luminance with Rec.709 weights (0.72 on a green
// site vs 0.07 on a blue site) imprints a 2px period-2 (Nyquist) checkerboard
// on the detection buffer. Equal channel weights recover the smooth per-site
// value. This guards that invariant on the REAL shipped reducer.
import { describe, it, expect } from 'vitest';
import {
    reduceToLuminance, period2ParityAmplitude, LUMA_REC709, LUMA_EQUAL,
} from '../pipeline/m4_signal_detect/luminance_reduce';

/** Build an interleaved one-hot RGGB mosaic: each pixel lights ONLY its CFA
 *  colour channel (the other two are `leak`*value). RGGB tile:
 *  (0,0)=R (1,0)=G (0,1)=G (1,1)=B. */
function makeOneHotRGGB(width: number, height: number, value: number, leak = 0): Float32Array {
    const rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            const isR = (x & 1) === 0 && (y & 1) === 0;
            const isB = (x & 1) === 1 && (y & 1) === 1;
            const ch = isR ? 0 : isB ? 2 : 1; // else green
            rgb[i] = leak * value; rgb[i + 1] = leak * value; rgb[i + 2] = leak * value;
            rgb[i + ch] = value;
        }
    }
    return rgb;
}

describe('CFA-luminance period-2 parity', () => {
    const W = 64, H = 64;

    it('Rec.709 weights imprint a strong checkerboard on a one-hot CFA mosaic', () => {
        const rgb = makeOneHotRGGB(W, H, 0.5);
        const lum = reduceToLuminance(rgb, LUMA_REC709);
        const parity = period2ParityAmplitude(lum, W, H);
        // 0.72G vs 0.21R vs 0.07B across the 2x2 tile => large Nyquist term.
        expect(parity).toBeGreaterThan(0.3);
    });

    it('equal weights eliminate the checkerboard (parity ~ 0) on the same mosaic', () => {
        const rgb = makeOneHotRGGB(W, H, 0.5);
        const lum = reduceToLuminance(rgb, LUMA_EQUAL);
        const parity = period2ParityAmplitude(lum, W, H);
        expect(parity).toBeLessThan(1e-6);
    });

    it('equal weights cut parity by >90% vs Rec.709 even with realistic 2% cross-leak', () => {
        const rgb = makeOneHotRGGB(W, H, 0.5, 0.02); // ~2% leak like the real CR2
        const pRec = period2ParityAmplitude(reduceToLuminance(rgb, LUMA_REC709), W, H);
        const pEq = period2ParityAmplitude(reduceToLuminance(rgb, LUMA_EQUAL), W, H);
        expect(pRec).toBeGreaterThan(0.3);
        expect(1 - pEq / pRec).toBeGreaterThan(0.9);
    });

    it('a genuinely demosaiced (neutral gray) RGB frame has no checkerboard under either weighting', () => {
        // Every channel populated equally => no per-site colour, no parity.
        const rgb = new Float32Array(W * H * 3).fill(0.4);
        expect(period2ParityAmplitude(reduceToLuminance(rgb, LUMA_REC709), W, H)).toBeLessThan(1e-6);
        expect(period2ParityAmplitude(reduceToLuminance(rgb, LUMA_EQUAL), W, H)).toBeLessThan(1e-6);
    });

    it('Rec.709 reduction is BIT-identical to the historical inline loop (default path)', () => {
        const rgb = Float32Array.from([0.1, 0.2, 0.3, 0.9, 0.8, 0.7]);
        const lum = reduceToLuminance(rgb, LUMA_REC709);
        // Replicate the pre-refactor computeluminance exactly: same expression
        // order, same Float32Array storage truncation. Must be BIT-equal —
        // this is what keeps the default (flag-off) path byte-identical.
        const legacy = new Float32Array(2);
        for (let i = 0; i < 2; i++) {
            legacy[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
        }
        expect(lum[0]).toBe(legacy[0]);
        expect(lum[1]).toBe(legacy[1]);
    });
});
