/**
 * CELL ① — DECODE_APPLY_BLACK_LEVEL (per-channel black-level subtraction at the
 * rawler decode boundary). Unit coverage for the PURE, wasm-free pieces:
 *   • isDecodeApplyBlackLevelEnabled() — call-time env read, DEFAULT OFF.
 *   • perChannelBlackFromTile() — CFA-tile → [R,G,B] black mapping that mirrors
 *     the crate's scatter_planes color routing (0=R, 1=G, else→B).
 *   • summarizeRawlerCalibration() — additive black_level_applied field.
 *
 * The full decode (decodeRawlerForPipeline) needs the gitignored wasm_decode pkg
 * + a real CR2, so byte-domain conformance is a tools-lane demo (spcc_cr2_approx),
 * not a unit test. DEFAULT-OFF inertness is asserted by m1_rawler_rail.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    isDecodeApplyBlackLevelEnabled,
    perChannelBlackFromTile,
    obMedianPerPhase,
    summarizeRawlerCalibration,
    type RawlerCfaRecord,
    type RawlerObArea,
} from '../pipeline/m1_ingestion/rawler_decoder';

afterEach(() => { vi.unstubAllEnvs(); });

describe('isDecodeApplyBlackLevelEnabled — call-time flag read, DEFAULT OFF', () => {
    it('is FALSE by default (unset env — cell ① inert by construction)', () => {
        expect(isDecodeApplyBlackLevelEnabled()).toBe(false);
    });
    it("is TRUE only for the explicit opt-in values '1' and 'true'", () => {
        vi.stubEnv('VITE_DECODE_APPLY_BLACK_LEVEL', '1');
        expect(isDecodeApplyBlackLevelEnabled()).toBe(true);
        vi.stubEnv('VITE_DECODE_APPLY_BLACK_LEVEL', 'true');
        expect(isDecodeApplyBlackLevelEnabled()).toBe(true);
        vi.stubEnv('VITE_DECODE_APPLY_BLACK_LEVEL', '0');
        expect(isDecodeApplyBlackLevelEnabled()).toBe(false);
        vi.stubEnv('VITE_DECODE_APPLY_BLACK_LEVEL', 'false');
        expect(isDecodeApplyBlackLevelEnabled()).toBe(false);
        vi.stubEnv('VITE_DECODE_APPLY_BLACK_LEVEL', 'yes');
        expect(isDecodeApplyBlackLevelEnabled()).toBe(false);
    });
});

describe('perChannelBlackFromTile — CFA color routing (mirrors scatter_planes)', () => {
    it('maps an RGGB tile [0,1,1,2] to per-channel black (G averages both greens)', () => {
        // positions: R=2045, G1=2049, G2=2051, B=2047
        const [r, g, b] = perChannelBlackFromTile([0, 1, 1, 2], [2045, 2049, 2051, 2047]);
        expect(r).toBe(2045);
        expect(g).toBe((2049 + 2051) / 2);
        expect(b).toBe(2047);
    });

    it('maps a GBRG tile [1,2,0,1] — color-ordered, not position-ordered', () => {
        // pos0 G=100, pos1 B=200, pos2 R=300, pos3 G=140
        const [r, g, b] = perChannelBlackFromTile([1, 2, 0, 1], [100, 200, 300, 140]);
        expect(r).toBe(300);            // the single R position
        expect(g).toBe((100 + 140) / 2); // both G positions
        expect(b).toBe(200);            // the single B position
    });

    it('folds a 4th color code (E) into B, exactly like the crate _ => b arm', () => {
        // RGBE-ish tile: R,G,B,E(=3) with E routed to B alongside code 2.
        const [r, g, b] = perChannelBlackFromTile([0, 1, 2, 3], [10, 20, 30, 34]);
        expect(r).toBe(10);
        expect(g).toBe(20);
        expect(b).toBe((30 + 34) / 2);  // code 2 AND code 3 both → B
    });

    it('returns [0,0,0] on malformed/empty input (honest no-op)', () => {
        expect(perChannelBlackFromTile([], [])).toEqual([0, 0, 0]);
        expect(perChannelBlackFromTile([0, 1, 2, 3], [])).toEqual([0, 0, 0]);
        // NaN black is skipped, leaving no contributors for that channel → 0
        expect(perChannelBlackFromTile([0, 1, 1, 2], [NaN, 2049, 2051, 2047]))
            .toEqual([0, (2049 + 2051) / 2, 2047]);
    });
});

describe('summarizeRawlerCalibration — additive black_level_applied (honest-or-absent)', () => {
    const baseRec: RawlerCfaRecord = {
        decoder: 'rawler-0.7.2',
        demosaic: 'integer-bilinear-v1',
        fullWidth: 10, fullHeight: 8,
        pattern: 'GBRG', patternActive: 'RGGB',
        levels: { black: [2045, 2049, 2049, 2047], white: [15094] },
        wb: [1.8, 1, 1.66, null],
        activeArea: { x: 2, y: 1, w: 6, h: 4 }, cropArea: null,
        obAreas: [],
        valueDomain: 'raw_adu_pedestal_over_65535',
        blackLevelApplied: null,
    };

    it('is null when black-level was NOT applied (default rail)', () => {
        const cal = summarizeRawlerCalibration(baseRec)!;
        expect(cal.value_domain).toBe('raw_adu_pedestal_over_65535');
        expect(cal.black_level_applied).toBeNull();
    });

    it('carries the applied [R,G,B] black + the subtracted value-domain label when applied', () => {
        const rec: RawlerCfaRecord = {
            ...baseRec,
            valueDomain: 'raw_adu_black_subtracted_over_65535',
            blackLevelApplied: [2045, 2049, 2047],
        };
        const cal = summarizeRawlerCalibration(rec)!;
        expect(cal.value_domain).toBe('raw_adu_black_subtracted_over_65535');
        expect(cal.black_level_applied).toEqual([2045, 2049, 2047]);
    });

    it('returns null for a null record (libraw cold path / FITS / demo-tier)', () => {
        expect(summarizeRawlerCalibration(null)).toBeNull();
    });
});

// ── CELL ① OB-MEASURED OVERRIDE (ledger row 544) — pure selection pieces ──────

/** Build a RawlerObArea; only rect + pixels are read by obMedianPerPhase. */
function obArea(rect: RawlerObArea['rect'], pixels: number[]): RawlerObArea {
    return { rect, pixels: Uint16Array.from(pixels), mean: 0, std: 0, min: 0, max: 0, n: pixels.length };
}

describe('obMedianPerPhase — per-CFA-phase OB median (mirrors ob_bias_probe aggregateChannels)', () => {
    it('returns null when there are NO optical-black areas (⇒ caller falls back to metadata)', () => {
        expect(obMedianPerPhase([], 100, 100)).toBeNull();
    });

    it('reduces a 4×4 OB patch to the per-phase [p0,p1,p2,p3] median; the wire routes it to [R,G,B]', () => {
        // Row-major within the rect (index = r*4 + c). Phase p = (y&1)*2 + (x&1):
        //   p0 = even row/even col, p1 = even/odd, p2 = odd/even, p3 = odd/odd.
        // Fill so median(p0)=100, median(p1)=200, median(p2)=210, median(p3)=300.
        const px = [
            100, 200, 100, 200,   // row0: p0 p1 p0 p1
            210, 300, 210, 300,   // row1: p2 p3 p2 p3
            100, 200, 100, 200,   // row2
            210, 300, 210, 300,   // row3
        ];
        const perPhase = obMedianPerPhase([obArea({ x: 0, y: 0, w: 4, h: 4 }, px)], 100, 100)!;
        expect(perPhase).toEqual([100, 200, 210, 300]);
        // The wire feeds the per-phase medians straight into perChannelBlackFromTile,
        // exactly like blacklevel_bayer. RGGB tile [0,1,1,2]: R=p0, G=avg(p1,p2), B=p3.
        expect(perChannelBlackFromTile([0, 1, 1, 2], perPhase)).toEqual([100, (200 + 210) / 2, 300]);
    });

    it('T6 pedestal (row 544): an all-2048 OB patch ⇒ [2048,2048,2048] after routing', () => {
        const px = new Array(16).fill(2048);
        const perPhase = obMedianPerPhase([obArea({ x: 0, y: 0, w: 4, h: 4 }, px)], 100, 100)!;
        expect(perChannelBlackFromTile([0, 1, 1, 2], perPhase)).toEqual([2048, 2048, 2048]);
    });

    it('even-length median averages the two middles (60D green half-integer, e.g. 2047.5)', () => {
        // p0 collects (0,0)=2047 and (0,2)=2048 ⇒ median 2047.5 (60D green half-int).
        const px = [
            2047, 2000, 2048, 2000, // row0: p0 p1 p0 p1
            3000, 3000, 3000, 3000, // row1: p2 p3 p2 p3
        ];
        const perPhase = obMedianPerPhase([obArea({ x: 0, y: 0, w: 4, h: 2 }, px)], 100, 100)!;
        expect(perPhase[0]).toBe(2047.5);
    });

    it('clips the rect to the frame bounds (mirrors the probe) without reading past the buffer', () => {
        // h=3 but fullHeight=2 ⇒ effH clips to 2; only the first 2 rows (8 px) are read.
        const px = [
            10, 10, 10, 10,   // row0
            20, 20, 20, 20,   // row1
        ];
        const perPhase = obMedianPerPhase([obArea({ x: 0, y: 0, w: 4, h: 3 }, px)], 100, 2)!;
        expect(perPhase).toEqual([10, 10, 20, 20]); // no NaN, no OOB
    });
});

describe('CELL ① OB-override SELECTION — the exact branch the wire takes', () => {
    // The wire: useOb = obAreas.length>=1 && obMed!==null; black = useOb
    //   ? perChannelBlackFromTile(tile, obMed) : perChannelBlackFromTile(tile, blk).
    const select = (tile: number[], blk: number[], obAreas: RawlerObArea[], W: number, H: number) => {
        const obMed = obMedianPerPhase(obAreas, W, H);
        const useOb = obAreas.length >= 1 && obMed !== null;
        return {
            source: useOb ? 'ob_measured' : 'metadata',
            black: useOb ? perChannelBlackFromTile(tile, obMed!) : perChannelBlackFromTile(tile, blk),
        };
    };

    it('OB present ⇒ ob_measured medians OVERRIDE metadata blacklevel_bayer', () => {
        // metadata says [2049,2047,2045]; OB says all 2048 → ob_measured wins.
        const obAreas = [obArea({ x: 0, y: 0, w: 4, h: 4 }, new Array(16).fill(2048))];
        const r = select([0, 1, 1, 2], [2049, 2047, 2047, 2045], obAreas, 100, 100);
        expect(r.source).toBe('ob_measured');
        expect(r.black).toEqual([2048, 2048, 2048]);
    });

    it('0 OB areas ⇒ metadata path, byte-for-byte the pre-existing perChannelBlackFromTile', () => {
        const r = select([0, 1, 1, 2], [2049, 2047, 2047, 2045], [], 100, 100);
        expect(r.source).toBe('metadata');
        expect(r.black).toEqual(perChannelBlackFromTile([0, 1, 1, 2], [2049, 2047, 2047, 2045]));
        expect(r.black).toEqual([2049, (2047 + 2047) / 2, 2045]);
    });

    it('X-Trans degenerate GGGG (0 OB areas) ⇒ metadata routing preserved EXACTLY ([0,1022,0])', () => {
        // SUMMARY.json: X-T5 exposes 0 OB areas + a degenerate GGGG tile [1,1,1,1];
        // the OB approach is unavailable, so the unchanged metadata path runs.
        const r = select([1, 1, 1, 1], [1022, 1022, 1022, 1022], [], 100, 100);
        expect(r.source).toBe('metadata');
        // All positions route to G; R and B have no contributors → 0 (existing behavior).
        expect(r.black).toEqual([0, 1022, 0]);
    });
});
