import { describe, it, expect, beforeAll } from 'vitest';
import { ImageProcessor } from '../core/ImageProcessor';
import {
    linearSrgbToOklab,
    oklabToLinearSrgb,
    linearSrgbToOklch,
    oklchToLinearSrgb,
    gamutClipPreserveHue,
    inSrgbGamut,
    encodeSrgb,
} from '../core/oklab';

beforeAll(() => {
    if (typeof globalThis.ImageData === 'undefined') {
        (globalThis as any).ImageData = class ImageData {
            data: Uint8ClampedArray; width: number; height: number;
            constructor(data: Uint8ClampedArray, width: number, height: number) {
                this.data = data; this.width = width; this.height = height;
            }
        };
    }
});

// ── deterministic synthetic astro-ish frame (dark colored sky + bright stars,
//    some saturated cores) — must match the buffer the golden hash was captured
//    from. See handoff: golden 19382209 captured pre-change against STF v2.
function makeFrame(w: number, h: number): Float32Array {
    const buf = new Float32Array(w * h * 3);
    const rnd = (i: number) => {
        const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
        return s - Math.floor(s);
    };
    for (let p = 0; p < w * h; p++) {
        const i = p * 3;
        buf[i]     = 0.050 + 0.010 * rnd(p + 1);
        buf[i + 1] = 0.060 + 0.010 * rnd(p + 2);
        buf[i + 2] = 0.055 + 0.010 * rnd(p + 3);
    }
    const stars = [
        { x: 10, y: 10, a: 0.7, cr: 1.0, cg: 0.9, cb: 0.6 },
        { x: 40, y: 20, a: 1.2, cr: 0.6, cg: 0.8, cb: 1.0 },
        { x: 25, y: 45, a: 0.5, cr: 1.0, cg: 0.5, cb: 0.4 },
        { x: 55, y: 55, a: 1.5, cr: 0.9, cg: 0.95, cb: 1.0 },
        { x: 18, y: 58, a: 0.9, cr: 0.7, cg: 1.0, cb: 0.8 },
    ];
    for (const s of stars) {
        for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
                const x = s.x + dx, y = s.y + dy;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                const g = s.a * Math.exp(-(dx * dx + dy * dy) / (2 * 1.2 * 1.2));
                const i = (y * w + x) * 3;
                buf[i]     += g * s.cr;
                buf[i + 1] += g * s.cg;
                buf[i + 2] += g * s.cb;
            }
        }
    }
    return buf;
}

function fnv1a(bytes: Uint8ClampedArray): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

// Golden hash of the flag-OFF render of makeFrame(64,64), captured from the
// pre-Oklab STF v2 code path. Flag-off identity is proven against this constant.
const GOLDEN_FLAG_OFF = '19382209';

describe('oklab: transform correctness', () => {
    it('linearSrgb → Oklab → linearSrgb round-trips in-gamut colors', () => {
        const colors: Array<[number, number, number]> = [
            [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.5, 0.5, 0.5],
            [0.8, 0.1, 0.05], [0.05, 0.3, 0.9], [0.2, 0.7, 0.4], [0.9, 0.85, 0.2],
        ];
        for (const [r, g, b] of colors) {
            const [L, a, bb] = linearSrgbToOklab(r, g, b);
            const [r2, g2, b2] = oklabToLinearSrgb(L, a, bb);
            expect(r2).toBeCloseTo(r, 6);
            expect(g2).toBeCloseTo(g, 6);
            expect(b2).toBeCloseTo(b, 6);
        }
    });

    it('achromatic linear grays map to zero chroma', () => {
        for (const v of [0.05, 0.2, 0.5, 0.9]) {
            const [, C] = linearSrgbToOklch(v, v, v);
            expect(C).toBeLessThan(1e-6);
        }
    });

    it('encodeSrgb is monotone and clamps to [0,1]', () => {
        expect(encodeSrgb(-0.5)).toBe(0);         // input clamped low
        expect(encodeSrgb(1.5)).toBeCloseTo(1, 9); // input clamped high (OETF of 1 ≈ 1, sub-ULP)
        expect(encodeSrgb(0)).toBe(0);
        expect(encodeSrgb(1)).toBeCloseTo(1, 9);
        expect(encodeSrgb(0.5)).toBeGreaterThan(encodeSrgb(0.25));
    });
});

describe('oklab: hue preservation under gamut projection (CSL shape)', () => {
    it('projection holds hue EXACTLY and lands in-gamut', () => {
        // High-chroma OkLCh colors, out of the sRGB gamut for most hues.
        for (let k = 0; k < 24; k++) {
            const h = (k / 24) * 2 * Math.PI - Math.PI;
            const L = 0.4 + 0.5 * ((k % 5) / 5); // spread lightness 0.4..0.9
            const C = 0.6;                        // deliberately out of gamut
            const [Lc, Cc, hc] = gamutClipPreserveHue(L, C, h);
            // hue is NEVER rotated — the provable property.
            expect(hc).toBe(h);
            // lightness only clamped to [0,1] (here already inside).
            expect(Lc).toBeCloseTo(L, 12);
            // result must be inside the sRGB gamut.
            expect(inSrgbGamut(oklchToLinearSrgb(Lc, Cc, hc), 2e-4)).toBe(true);
        }
    });

    it('leaves already-in-gamut colors untouched (hue and chroma)', () => {
        const [L, C, h] = linearSrgbToOklch(0.3, 0.4, 0.5);
        const [Lc, Cc, hc] = gamutClipPreserveHue(L, C, h);
        expect(hc).toBe(h);
        expect(Cc).toBe(C);
        expect(Lc).toBe(L);
    });

    it('clamps out-of-range lightness while preserving hue', () => {
        const hi = gamutClipPreserveHue(1.5, 0.2, 0.7);
        expect(hi[0]).toBe(1);
        expect(hi[2]).toBe(0.7);
        expect(inSrgbGamut(oklchToLinearSrgb(hi[0], hi[1], hi[2]), 2e-4)).toBe(true);
        const lo = gamutClipPreserveHue(-0.3, 0.2, 0.7);
        expect(lo[0]).toBe(0);
        expect(lo[2]).toBe(0.7);
    });
});

describe('oklab: chroma monotonicity under gamut projection (CSL shape)', () => {
    it('output chroma never exceeds input chroma', () => {
        for (let k = 0; k < 12; k++) {
            const h = (k / 12) * 2 * Math.PI;
            for (const C of [0.02, 0.1, 0.25, 0.5, 1.0]) {
                const [, Cc] = gamutClipPreserveHue(0.6, C, h);
                expect(Cc).toBeLessThanOrEqual(C + 1e-9);
            }
        }
    });

    it('clipped chroma is monotone non-decreasing in requested chroma', () => {
        const h = 0.9, L = 0.55;
        const inputs = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.2];
        let prev = -Infinity;
        // Tolerance covers the bisection residual (~C_max/2^24 ≈ 1e-7): past the
        // cusp the boundary estimate wobbles at sub-1e-7, never a real reversal.
        for (const C of inputs) {
            const [, Cc] = gamutClipPreserveHue(L, C, h);
            expect(Cc).toBeGreaterThanOrEqual(prev - 1e-6);
            prev = Cc;
        }
        // Beyond the cusp it saturates at the gamut boundary (not unbounded).
        const [, big] = gamutClipPreserveHue(L, 5.0, h);
        const [, boundary] = gamutClipPreserveHue(L, 0.8, h);
        expect(big).toBeCloseTo(boundary, 4);
    });
});

describe('ImageProcessor OkLCh render path (flag-gated)', () => {
    const W = 64, H = 64;

    it('flag-OFF render is BYTE-IDENTICAL to the pre-Oklab STF v2 output', () => {
        const noArg = ImageProcessor.float32ToImageDataAutoStretch(makeFrame(W, H), W, H);
        const explicitFalse = ImageProcessor.float32ToImageDataAutoStretch(makeFrame(W, H), W, H, null, null, { oklab: false });
        const nullOpts = ImageProcessor.float32ToImageDataAutoStretch(makeFrame(W, H), W, H, null, null, null);
        expect(fnv1a(noArg.data)).toBe(GOLDEN_FLAG_OFF);
        expect(fnv1a(explicitFalse.data)).toBe(GOLDEN_FLAG_OFF);
        expect(fnv1a(nullOpts.data)).toBe(GOLDEN_FLAG_OFF);
        expect(noArg.data.length).toBe(W * H * 4);
    });

    it('flag-ON produces a distinct, valid render (branch executes)', () => {
        const on = ImageProcessor.float32ToImageDataAutoStretch(makeFrame(W, H), W, H, null, null, { oklab: true });
        expect(on.width).toBe(W);
        expect(on.height).toBe(H);
        expect(on.data.length).toBe(W * H * 4);
        // Different pixels than the flag-off render — the OkLCh path is engaged.
        expect(fnv1a(on.data)).not.toBe(GOLDEN_FLAG_OFF);
        // Every alpha opaque; all channels are valid Uint8 (ClampedArray invariant).
        for (let i = 0; i < on.data.length; i += 4) {
            expect(on.data[i + 3]).toBe(255);
        }
    });
});
