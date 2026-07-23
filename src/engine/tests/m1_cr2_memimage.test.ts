/**
 * M1 CR2 mem_image contract — extractRawSensorData against the payload
 * libraw-wasm 1.1.x ACTUALLY returns (verified on the bundled Canon T6 CR2
 * by tools/dslr/decode_cr2_smoke.mjs): ACTIVE-AREA 3-channel interleaved
 * Uint16 from dcraw_make_mem_image, one-hot per pixel in noInterpolation
 * document mode, black-subtracted and scaled to 16-bit. NOT a raw_width-
 * strided CFA mosaic (meta.raw_pitch does not exist in this binding).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractRawSensorData } from '../pipeline/m1_ingestion/metadata_reaper';

const mock = vi.hoisted(() => ({
    meta: {} as Record<string, unknown>,
    payload: new Uint16Array(0),
}));

vi.mock('libraw-wasm', () => ({
    default: class MockLibRaw {
        async open(_buf: Uint8Array, _opts: unknown): Promise<void> { /* no-op */ }
        async metadata(): Promise<Record<string, unknown>> { return mock.meta; }
        async imageData(): Promise<Uint16Array> { return mock.payload; }
    },
}));

/** Minimal non-FITS buffer with CR2 magic (II + "CR" at offset 8). */
function fakeCr2Buffer(): ArrayBuffer {
    const b = new Uint8Array(16);
    b[0] = 0x49; b[1] = 0x49; b[2] = 0x2a; b[3] = 0x00;
    b[8] = 0x43; b[9] = 0x52; // "CR"
    return b.buffer;
}

const W = 6, H = 4;

describe('M1 extractRawSensorData - libraw-wasm mem_image layouts', () => {
    // COLD-PATH CONTRACT (2026-07-11 cutover): rawler is the default arm, so the
    // libraw mem_image layouts under test here are only reachable with the cold
    // path explicitly selected. The contract itself is unchanged and RETAINED
    // per the owner's cold-path ruling — never delete these.
    beforeEach(() => { vi.stubEnv('VITE_DECODER_RAWLER', '0'); });
    afterEach(() => { vi.unstubAllEnvs(); });
    it('document-mode one-hot RGB16 becomes normalized gray Float32 RGB (demosaic skipped downstream)', async () => {
        mock.meta = { width: W, height: H, raw_width: W + 2, raw_height: H + 1 }; // no raw_pitch (1.1.x)
        const mem = new Uint16Array(W * H * 3);
        for (let p = 0; p < W * H; p++) {
            mem[p * 3 + (p % 3)] = 6553 * ((p % 5) + 1); // one lit channel per pixel
        }
        mock.payload = mem;

        const out = await extractRawSensorData(fakeCr2Buffer());
        expect(out).not.toBeNull();
        expect(out!.isDemosaiced).toBe(true);
        expect(out!.width).toBe(W);
        expect(out!.height).toBe(H);
        expect(out!.stride).toBe(W); // active-area packed, NOT raw_width
        expect(out!.calibrationStrip).toBeUndefined(); // no optical-black margins in mem_image
        expect(out!.data).toBeInstanceOf(Float32Array);
        expect(out!.data.length).toBe(W * H * 3);

        // Gray triplet = site value / 65535 on all three channels (no CFA
        // checkerboard in the luminance downstream).
        for (let p = 0; p < W * H; p++) {
            const v = (6553 * ((p % 5) + 1)) / 65535;
            expect(out!.data[p * 3 + 0]).toBeCloseTo(v, 5);
            expect(out!.data[p * 3 + 1]).toBeCloseTo(v, 5);
            expect(out!.data[p * 3 + 2]).toBeCloseTo(v, 5);
        }
    });

    it('fully-populated RGB16 keeps per-channel color, normalized to [0,1]', async () => {
        mock.meta = { width: W, height: H, raw_width: W, raw_height: H };
        const mem = new Uint16Array(W * H * 3);
        for (let i = 0; i < mem.length; i++) mem[i] = 1000 + i; // all channels lit
        mock.payload = mem;

        const out = await extractRawSensorData(fakeCr2Buffer());
        expect(out).not.toBeNull();
        expect(out!.isDemosaiced).toBe(true);
        expect(out!.data[0]).toBeCloseTo(1000 / 65535, 6);
        expect(out!.data[1]).toBeCloseTo(1001 / 65535, 6);
        expect(out!.data[2]).toBeCloseTo(1002 / 65535, 6);
    });

    it('legacy CFA mosaic payload (raw_pitch binding) keeps the Bayer branch: stride + optical-black strip', async () => {
        const rawWidth = W + 2;
        mock.meta = { width: W, height: H, raw_width: rawWidth, raw_height: H, raw_pitch: rawWidth * 2 };
        const mem = new Uint16Array(rawWidth * H);
        for (let i = 0; i < mem.length; i++) mem[i] = 2048 + i;
        mock.payload = mem;

        const out = await extractRawSensorData(fakeCr2Buffer());
        expect(out).not.toBeNull();
        expect(out!.isDemosaiced).toBe(false);
        expect(out!.data).toBeInstanceOf(Uint16Array);
        expect(out!.stride).toBe(rawWidth);
        // 2px right margin harvested as the calibration strip
        expect(out!.calibrationStrip).toBeInstanceOf(Uint16Array);
        expect(out!.calibrationStrip!.length).toBe((rawWidth - W) * H);
        expect(out!.calibrationStrip![0]).toBe(mem[W]); // row 0, first margin px
    });
});
