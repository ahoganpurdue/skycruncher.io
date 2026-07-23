/**
 * M1 decoder rail (decoder-cutover #14) — flag semantics at the m1 seam.
 *
 * The load-bearing assertion is FLAG-OFF INERTNESS: with VITE_DECODER_RAWLER
 * unset, extractRawSensorData must take the EXACT existing libraw-wasm path and
 * the rawler arm must never be consulted (both pinned reference solves ride on
 * this). Flag ON must route to the rawler arm WITHOUT constructing LibRaw.
 * The rawler decode itself is mocked here (the wasm pkg is a gitignored local
 * build; real-decode conformance is measured by tools/rawlab/ab_live.mjs
 * against the committed golden manifest).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractRawSensorData } from '../pipeline/m1_ingestion/metadata_reaper';
import { decodeRawlerForPipeline, isRawlerDecoderEnabled } from '../pipeline/m1_ingestion/rawler_decoder';

const mock = vi.hoisted(() => ({
    meta: {} as Record<string, unknown>,
    payload: new Uint16Array(0),
    librawConstructed: 0,
    rawlerPayload: null as unknown,
}));

vi.mock('libraw-wasm', () => ({
    default: class MockLibRaw {
        constructor() { mock.librawConstructed++; }
        async open(_buf: Uint8Array, _opts: unknown): Promise<void> { /* no-op */ }
        async metadata(): Promise<Record<string, unknown>> { return mock.meta; }
        async imageData(): Promise<Uint16Array> { return mock.payload; }
    },
}));

// Spy-wrap ONLY decodeRawlerForPipeline; everything else (incl. the call-time
// flag read isRawlerDecoderEnabled) stays the real implementation.
vi.mock('../pipeline/m1_ingestion/rawler_decoder', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../pipeline/m1_ingestion/rawler_decoder')>();
    return {
        ...orig,
        decodeRawlerForPipeline: vi.fn(async () => mock.rawlerPayload),
    };
});

/** Minimal non-FITS buffer with CR2 magic (II + "CR" at offset 8). */
function fakeCr2Buffer(): ArrayBuffer {
    const b = new Uint8Array(16);
    b[0] = 0x49; b[1] = 0x49; b[2] = 0x2a; b[3] = 0x00;
    b[8] = 0x43; b[9] = 0x52; // "CR"
    return b.buffer;
}

const W = 6, H = 4;

afterEach(() => {
    vi.unstubAllEnvs();
    mock.librawConstructed = 0;
    vi.mocked(decodeRawlerForPipeline).mockClear();
});

describe('isRawlerDecoderEnabled — call-time flag read', () => {
    it('is TRUE by default (unset env — rawler = default arm since the 2026-07-11 cutover)', () => {
        expect(isRawlerDecoderEnabled()).toBe(true);
    });
    it("is FALSE only for the explicit cold-path values '0' and 'false'", () => {
        vi.stubEnv('VITE_DECODER_RAWLER', '1');
        expect(isRawlerDecoderEnabled()).toBe(true);
        vi.stubEnv('VITE_DECODER_RAWLER', 'true');
        expect(isRawlerDecoderEnabled()).toBe(true);
        vi.stubEnv('VITE_DECODER_RAWLER', '0');
        expect(isRawlerDecoderEnabled()).toBe(false);
        vi.stubEnv('VITE_DECODER_RAWLER', 'false');
        expect(isRawlerDecoderEnabled()).toBe(false);
        vi.stubEnv('VITE_DECODER_RAWLER', 'yes');
        expect(isRawlerDecoderEnabled()).toBe(true);
    });
});

describe('M1 decoder rail — COLD-PATH inertness (libraw retained, owner cold-path ruling)', () => {
    it('routes to libraw and NEVER consults the rawler arm when the cold path is selected', async () => {
        vi.stubEnv('VITE_DECODER_RAWLER', '0');
        mock.meta = { width: W, height: H, raw_width: W + 2, raw_height: H + 1 };
        const mem = new Uint16Array(W * H * 3);
        for (let p = 0; p < W * H; p++) mem[p * 3 + (p % 3)] = 6553 * ((p % 5) + 1);
        mock.payload = mem;

        const out = await extractRawSensorData(fakeCr2Buffer());
        expect(out).not.toBeNull();
        // The libraw mem_image path ran (unchanged behavior)…
        expect(mock.librawConstructed).toBe(1);
        expect(out!.isDemosaiced).toBe(true);
        expect(out!.width).toBe(W);
        expect(out!.data).toBeInstanceOf(Float32Array);
        // …and the additive rawler record is honestly ABSENT.
        expect(out!.rawler).toBeUndefined();
        // The rawler arm was never consulted.
        expect(decodeRawlerForPipeline).not.toHaveBeenCalled();
    });
});

describe('M1 decoder rail — flag ON routing', () => {
    it('routes to the rawler arm and never constructs LibRaw', async () => {
        vi.stubEnv('VITE_DECODER_RAWLER', '1');
        const rgb = new Float32Array(W * H * 3).fill(0.25);
        mock.rawlerPayload = {
            data: rgb,
            width: W,
            height: H,
            stride: W,
            isDemosaiced: true,
            selectedIfdIndex: 0,
            rawler: {
                decoder: 'rawler-0.7.2',
                demosaic: 'integer-bilinear-v1',
                fullWidth: W + 2,
                fullHeight: H + 1,
                pattern: 'GBRG',
                patternActive: 'RGGB',
                levels: { black: [2046, 2046, 2049, 2049], white: [15094] },
                wb: [1.8, 1, 1.66, null],
                activeArea: { x: 2, y: 1, w: W, h: H },
                cropArea: null,
                obAreas: [],
                valueDomain: 'raw_adu_pedestal_over_65535',
            },
        };

        const out = await extractRawSensorData(fakeCr2Buffer());
        expect(decodeRawlerForPipeline).toHaveBeenCalledTimes(1);
        expect(mock.librawConstructed).toBe(0); // libraw fully bypassed
        expect(out).toBe(mock.rawlerPayload);   // payload passed through untouched
        expect(out!.rawler?.decoder).toBe('rawler-0.7.2');
        expect(out!.rawler?.valueDomain).toBe('raw_adu_pedestal_over_65535');
    });

    it('FITS still short-circuits to the pure-TS decoder even with the flag ON', async () => {
        vi.stubEnv('VITE_DECODER_RAWLER', '1');
        // "SIMPLE" magic → FITS route; an invalid header decodes to null, but the
        // point is that NEITHER decoder arm is consulted for FITS.
        const b = new Uint8Array(16);
        const simple = 'SIMPLE';
        for (let i = 0; i < simple.length; i++) b[i] = simple.charCodeAt(i);
        await extractRawSensorData(b.buffer);
        expect(decodeRawlerForPipeline).not.toHaveBeenCalled();
        expect(mock.librawConstructed).toBe(0);
    });
});
