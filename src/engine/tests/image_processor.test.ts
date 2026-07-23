import { describe, it, expect, beforeAll } from 'vitest';
import { ImageProcessor } from '../core/ImageProcessor';

// Node has no ImageData global; stub the constructor shape the engine relies on.
beforeAll(() => {
    if (typeof globalThis.ImageData === 'undefined') {
        (globalThis as any).ImageData = class ImageData {
            data: Uint8ClampedArray;
            width: number;
            height: number;
            constructor(data: Uint8ClampedArray, width: number, height: number) {
                this.data = data;
                this.width = width;
                this.height = height;
            }
        };
    }
});

const gamma = (v: number) => Math.min(255, Math.pow(v, 1 / 2.2) * 255);

describe('ImageProcessor.float32ToImageData', () => {
    it('converts a 3-channel interleaved RGB buffer', () => {
        const w = 2, h = 2;
        const rgb = new Float32Array([
            1.0, 0.0, 0.5,   0.2, 0.4, 0.6,
            0.0, 0.0, 0.0,   1.0, 1.0, 1.0,
        ]);
        const img = ImageProcessor.float32ToImageData(rgb, w, h);

        expect(img.width).toBe(w);
        expect(img.height).toBe(h);
        expect(img.data[0]).toBe(255);                       // R of px0
        expect(img.data[1]).toBe(0);                         // G of px0
        expect(img.data[2]).toBe(Math.round(gamma(0.5)));    // B of px0
        expect(img.data[3]).toBe(255);                       // alpha
        expect(img.data[12]).toBe(255);                      // px3 white
        expect(img.data[13]).toBe(255);
        expect(img.data[14]).toBe(255);
    });

    it('converts a 1-channel luminance buffer (science buffer) to gray pixels', () => {
        const w = 3, h = 3;
        const lum = new Float32Array(w * h).fill(0.5);
        const img = ImageProcessor.float32ToImageData(lum, w, h);
        const expected = Math.round(gamma(0.5));

        for (let i = 0; i < w * h; i++) {
            expect(img.data[i * 4]).toBe(expected);
            expect(img.data[i * 4 + 1]).toBe(expected);
            expect(img.data[i * 4 + 2]).toBe(expected);
            expect(img.data[i * 4 + 3]).toBe(255);
        }
    });

    it('does not black out the lower rows of a luminance buffer (M66 solver regression)', () => {
        // Reading a w*h luminance buffer with the RGB stride runs out of bounds
        // after the first third of pixels, leaving the rest of the raster black.
        const w = 4, h = 9;
        const lum = new Float32Array(w * h).fill(1.0);
        const img = ImageProcessor.float32ToImageData(lum, w, h);

        const lastPixel = (w * h - 1) * 4;
        expect(img.data[lastPixel]).toBe(255);
        const twoThirds = Math.floor((w * h * 2) / 3) * 4;
        expect(img.data[twoThirds]).toBe(255);
    });

    it('maps NaN samples to black instead of poisoning the output', () => {
        const w = 2, h = 1;
        const lum = new Float32Array([NaN, 1.0]);
        const img = ImageProcessor.float32ToImageData(lum, w, h);

        expect(img.data[0]).toBe(0);
        expect(img.data[4]).toBe(255);
    });
});

describe('science buffer -> solver ImageData -> star extraction (M66 mechanism)', () => {
    it('recovers seeded stars across the whole raster, not just the top third', async () => {
        const { SourceExtractor } = await import('../pipeline/m4_signal_detect/source_extractor');

        const w = 96, h = 96;
        const lum = new Float32Array(w * h);

        // Deterministic low-amplitude background noise so sigma-clipping
        // yields a finite threshold (a perfectly flat field gives sigma=0).
        for (let i = 0; i < w * h; i++) {
            lum[i] = 0.02 + 0.005 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
        }

        // Gaussian PSFs in the top, middle, and bottom of the frame. The
        // middle and bottom ones sit past the w*h/3 boundary where the old
        // RGB-stride read ran out of bounds and produced black pixels.
        const seeded = [
            { x: 20, y: 15 },
            { x: 70, y: 48 },
            { x: 25, y: 80 },
        ];
        for (const s of seeded) {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const idx = (s.y + dy) * w + (s.x + dx);
                    lum[idx] += 0.8 * Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5));
                }
            }
        }

        const img = ImageProcessor.float32ToImageData(lum, w, h);

        // Mechanism check at the solver boundary: the production
        // ImageData -> luminance conversion must still see the seeded peaks
        // across the WHOLE raster. Under the old RGB-stride read, every
        // pixel past w*h/3 came back black (0).
        const roundTrip = SourceExtractor.imageDataToluminance(img);
        for (const s of seeded) {
            expect(
                roundTrip[s.y * w + s.x],
                `luminance peak at (${s.x},${s.y}) should survive the ImageData round-trip`
            ).toBeGreaterThan(0.5);
        }

        // Detection check: sources must EXIST below the top third. In the
        // Node test env the WASM blob extractor is mocked away, so the crude
        // JS fallback emits several detections per star and the trail/cluster
        // heuristics may reclassify some clusters as anomalies — the union of
        // buckets is what the converter bug controls (black pixels produce no
        // detection in ANY bucket), so assert on the union.
        const res = await SourceExtractor.extractStars(img, 3.0);
        const detections = [...res.stars, ...(res.anomalies ?? []), ...(res.planets ?? [])];

        for (const s of seeded) {
            const hit = detections.find(st => Math.hypot(st.x - s.x, st.y - s.y) < 3);
            expect(hit, `star seeded at (${s.x},${s.y}) should be detected`).toBeDefined();
        }
    });
});
