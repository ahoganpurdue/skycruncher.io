import { describe, it, expect } from 'vitest';
import {
    sniffFormatId,
    getFormatTier,
    isDemoTierFormat,
    isSupportedFilename,
    getDescriptor,
} from '../pipeline/m1_ingestion/format_registry';
import { parseExif } from '../pipeline/m1_ingestion/metadata_reaper';
import {
    reduceToLuminance,
    LUMA_REC709,
    period2ParityAmplitude,
} from '../pipeline/m4_signal_detect/luminance_reduce';

/**
 * DEMO-TIER INGEST SMOKE (2026-07-11) — feeds a phone-style JPEG through the
 * headless ingestion front door and proves the demo-tier PIXEL representation
 * is detection-ready. HONEST boundary: the browser-native decode is unavailable
 * in Node (no createImageBitmap), so the descriptor decode returns null here —
 * the in-browser wizard supplies the real pixels (stages/ingest →
 * ImageProcessor.decodeFullResImage). Detection-READINESS is exercised on a
 * synthetic demo-tier frame with the REAL luminance reduction (the full
 * wasm-backed SignalProcessor runs in the pipeline + the main battery, which
 * wire the wasm module this isolated smoke does not mock).
 */
describe('demo-tier ingest smoke (headless)', () => {
    // Minimal JPEG magic (SOI + APP0/JFIF marker) — enough for the sniff path.
    const jpegBytes = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
        0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    ]).buffer;

    it('front door: a JPEG is accepted at DEMO tier (not hard-rejected)', () => {
        expect(sniffFormatId(jpegBytes)).toBe('JPEG');
        expect(getFormatTier('JPEG')).toBe('demo');
        expect(isDemoTierFormat('JPEG')).toBe(true);
        expect(isSupportedFilename('astronomy_on_tap_phone.jpg')).toBe(true);
    });

    it('reaper: reads JPEG as non-raw with honest-absent time/GPS (untrusted)', async () => {
        const exif = await parseExif(jpegBytes);
        expect(exif.format).toBe('JPEG');
        expect(exif.isRaw).toBe(false);
        // No EXIF survived the stripped-header stub → honest-absent, never faked.
        expect(exif.hard.timestamp).toBe('');
        expect(exif.hard.timestamp_source).toBe('DEFAULT');
        expect(exif.hard.gps_lat).toBeNull();
    });

    it('honest headless boundary: browser decode returns null in Node', async () => {
        const decoded = await getDescriptor('JPEG').decode(jpegBytes);
        // No createImageBitmap in Node — honest null, never fabricated pixels.
        expect(typeof (globalThis as any).createImageBitmap).toBe('undefined');
        expect(decoded).toBeNull();
    });

    it('detection-ready: REC709 luma of a demo-tier frame preserves star peaks', () => {
        const W = 128, H = 128;
        const rgb = new Float32Array(W * H * 3);
        // Dim background with faint noise (already-rendered 8-bit sRGB, 0..1).
        for (let i = 0; i < W * H; i++) {
            const bg = 0.04 + (((i * 2654435761) >>> 0) % 5) / 1000; // deterministic ~[0.04,0.045)
            rgb[i * 3] = bg; rgb[i * 3 + 1] = bg; rgb[i * 3 + 2] = bg;
        }
        // Inject Gaussian "stars" (bright, well-separated).
        const stars: Array<[number, number]> = [[24, 24], [96, 30], [40, 88], [100, 100], [64, 60], [20, 108]];
        const sigma = 1.6, peak = 0.85;
        for (const [cx, cy] of stars) {
            for (let dy = -5; dy <= 5; dy++) {
                for (let dx = -5; dx <= 5; dx++) {
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    const g = peak * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
                    const idx = (y * W + x) * 3;
                    rgb[idx] = Math.min(1, rgb[idx] + g);
                    rgb[idx + 1] = Math.min(1, rgb[idx + 1] + g);
                    rgb[idx + 2] = Math.min(1, rgb[idx + 2] + g);
                }
            }
        }
        // REC709 is the correct reduction for a genuinely demosaiced RGB frame.
        const lum = reduceToLuminance(rgb, LUMA_REC709);
        expect(lum.length).toBe(W * H);

        // Background stats from a star-free corner region.
        let s = 0, s2 = 0, n = 0;
        for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) {
            const v = lum[y * W + x]; s += v; s2 += v * v; n++;
        }
        const bgMean = s / n;
        const bgStd = Math.sqrt(Math.max(0, s2 / n - bgMean * bgMean));
        const threshold = bgMean + 6 * bgStd + 0.05; // robust well above background

        // Count injected stars recovered as a strict local-max above threshold.
        let recovered = 0;
        for (const [cx, cy] of stars) {
            let best = -1;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                best = Math.max(best, lum[(cy + dy) * W + (cx + dx)]);
            }
            if (best > threshold) recovered++;
        }
        const parity = period2ParityAmplitude(lum, W, H);
        console.log(`[demo-smoke] injected=${stars.length} recovered=${recovered} bgMean=${bgMean.toFixed(4)} thr=${threshold.toFixed(4)} period2Parity=${parity.toFixed(4)}`);

        // The demo-tier representation carries detectable stars (solve runs for real)…
        expect(recovered).toBe(stars.length);
        // …and is a SMOOTH field — REC709 on genuinely demosaiced RGB shows no
        // CFA period-2 checkerboard (that pathology is the LibRaw-mosaic case).
        expect(parity).toBeLessThan(0.1);
    });
});
