/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RAWLER DECODE RAIL — decoder-cutover #14 parallel arm (FLAG-SELECTED, DEFAULT ON since the 2026-07-11 cutover)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (decode + demosaic; no coordinate math lives here).
 *
 * The DEFAULT decode arm of the m1 seam since the 2026-07-11 cutover.
 * `extractRawSensorData` branches here whenever `isRawlerDecoderEnabled()` is
 * true — unset/absent = ON. `VITE_DECODER_RAWLER=0` (or 'false') selects the
 * RETAINED libraw-wasm COLD PATH, byte-identical to the pre-cutover pipeline
 * (both pinned reference solves; owner-retained, never deleted). The flag
 * reaches the browser through vite's env exposure and plain
 * Node through process.env — same precedent as VITE_CFA_LUMA_PARITY_FIX
 * (orchestrator_session.ts), except read at CALL time so the A/B harness can
 * toggle per-run.
 *
 * CONTRACT (owner ruling; LAW 7 boundary `rawler_cfa` in
 * src/engine/contracts/binary_layouts.ts — cite that entry for any stride/
 * indexing/units change): FULL sensor frame including optical-black borders +
 * per-channel black levels + white level + WB + active/crop rects + OB mask
 * geometry. `decodeCfaContract` is the format-registry "COMING CFA CONTRACT"
 * decoder entry fn (format_registry.ts header): a deterministic decode
 * returning { CFA, pattern, levels, WB, crop/active } — the shape a Sony ARW
 * entry registers behind.
 *
 * PIPELINE SHAPE (flag ON): full-frame contract → in-crate deterministic
 * integer demosaic over the ACTIVE AREA (phase-correct, OB never bleeds into
 * science pixels) → the same demosaiced-RGB payload shape the libraw mem_image
 * path produces (normalized Float32 interleaved, isDemosaiced: true). Values
 * stay in the raw-ADU domain scaled by 1/65535 — NOT black-subtracted, NOT
 * white-scaled: domain normalization is a CALIBRATION decision that belongs to
 * the cutover recal, not this rail (LAW 2: no threshold-adjacent choices here).
 * EXPECTED and honest: detection counts under the flag will differ wildly from
 * the libraw arm (thresholds were implicitly calibrated to the libraw CFA-
 * luminance artifact — the measured 2227→21,636 effect); that is a MEASUREMENT
 * for tools/rawlab/ab_live.mjs, not a failure.
 *
 * The optical-black harvest (DARK_CALIBRATION_POLICY.md §1 "Reading B") is
 * carried ADDITIVELY on the payload (`rawler.obAreas`, record-only — no engine
 * consumer is wired yet; the OB anchor producer lands with the cutover).
 *
 * WASM: src/engine/wasm_decode (sibling crate to wasm_compute; pkg/ gitignored,
 * built with `wasm-pack build --target web`). Loaded via a NON-analyzable
 * dynamic import so tsc/vite never hard-depend on the gitignored pkg — a box
 * that has not built wasm_decode keeps tsc==baseline and a byte-identical
 * default path; only turning the flag ON requires the build.
 */

import { PhotometryManager } from '../m8_photometry/photometry_manager';
import { ArrowMemory } from '../../core/ArrowMemory';

// ─── flag ────────────────────────────────────────────────────────────────────

/**
 * DEFAULT-ON decoder flag, read at CALL time (never cached at module load so
 * the A/B harness can toggle per-run). Browser: vite env exposure. Node:
 * process.env fallback (plain-Node import.meta.env is absent).
 *
 * CUTOVER 2026-07-11 (owner-ruled: 2/3-rig acceptance, decoder exonerated on
 * the third): rawler is the DEFAULT RAW decode arm. libraw is RETAINED as the
 * COLD PATH — set VITE_DECODER_RAWLER=0 (or 'false') to select it; the cold
 * path is byte-identical to the pre-cutover pipeline. Any env-read error →
 * true: the default arm must be unreachable-failure-proof.
 */
export function isRawlerDecoderEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_DECODER_RAWLER;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_DECODER_RAWLER;
        }
        if (v === '0' || v === 'false') return false;
        return true;
    } catch {
        return true;
    }
}

/**
 * CELL ① — DECODE_APPLY_BLACK_LEVEL (DEFAULT OFF, read at CALL time).
 *
 * PIXEL ledger, decode boundary. When ON, `decodeRawlerForPipeline` subtracts
 * the MEASURED per-channel black pedestal (rawler `blacklevel_bayer`, mapped to
 * the R/G/B output channels via the CFA tile) from the demosaiced rgb16 BEFORE
 * the 1/65535 normalization, clamped at 0. DEFAULT OFF ⇒ the exact pre-existing
 * conversion (`rgb[i] = rgb16[i] * inv`) runs unchanged — byte-identical, and no
 * golden vector moves (the LAW-7 `rawler_cfa` golden md5s are on the wasm
 * `cfa_full_le`/`demosaic_luma_full_le` full-frame arms, NOT this TS payload).
 *
 * LAW 7 (`rawler_cfa` boundary, src/engine/contracts/binary_layouts.ts): this is
 * a VALUES-ONLY change — dtype/stride/length/interleave/units are all UNCHANGED
 * (still Float32 interleaved RGB, w·h·3, index = (y·w+x)·3+ch). No schema-entry
 * edit is required. When ON the rgb16 payload's md5 DIVERGES from the banked
 * value_domain='raw_adu_pedestal_over_65535' golden — that flag-ON md5 is a NEW
 * enumerated pin candidate for the cutover recal; the banked manifest is NOT
 * touched here (LAW 2: no calibration decision baked in as a default).
 *
 * Browser: vite env exposure. Node: process.env fallback. Any read error → false
 * (the honest default arm subtracts nothing).
 */
export function isDecodeApplyBlackLevelEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_DECODE_APPLY_BLACK_LEVEL;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_DECODE_APPLY_BLACK_LEVEL;
        }
        return v === '1' || v === 'true';
    } catch {
        return false;
    }
}

/**
 * CELL ① helper — map the per-CFA-POSITION black levels (`blacklevel_bayer`,
 * position-order) to per-OUTPUT-CHANNEL [R,G,B] black by averaging over the tile
 * positions whose CFA color routes to each channel. Mirrors the crate's
 * `scatter_planes` color routing EXACTLY: code 0→R, 1→G, anything else→B (E folds
 * into B). Pure + wasm-free so it is unit-testable. Returns [0,0,0] on a
 * malformed/empty tile (honest no-op).
 */
export function perChannelBlackFromTile(
    tile: readonly number[], blk: readonly number[],
): [number, number, number] {
    const chBlack = (target: 0 | 1 | 2): number => {
        let sum = 0, cnt = 0;
        for (let i = 0; i < tile.length && i < blk.length; i++) {
            const c = tile[i];
            const routes = target === 0 ? c === 0 : target === 1 ? c === 1 : (c !== 0 && c !== 1);
            if (routes && Number.isFinite(blk[i])) { sum += blk[i]; cnt++; }
        }
        return cnt > 0 ? sum / cnt : 0;
    };
    return [chBlack(0), chBlack(1), chBlack(2)];
}

/**
 * CELL ① OB-OVERRIDE helper — reduce the harvested optical-black pixels to the
 * per-CFA-PHASE median (phase index = (y&1)*2 + (x&1) — the SAME 2×2 position
 * ordering `blacklevel_bayer` / `cfa_tile` use), so the result plugs straight
 * into {@link perChannelBlackFromTile} in place of the metadata black tile.
 * Mirrors the recon driver `tools/calib/ob_bias_probe.mjs` `aggregateChannels`
 * EXACTLY (absolute-coord phase from the rect origin, frame-clipped effW/effH,
 * even/odd median) so the wired values reproduce the measured OB medians (T6
 * [2048,2048,2048]; SUMMARY.json, ledger row 544). Pure + wasm-free.
 *
 * Returns a length-4 per-phase median array (an empty phase → NaN, which
 * `perChannelBlackFromTile` skips via Number.isFinite), or null when NO
 * optical-black pixels exist at all — the caller then falls back to the metadata
 * black path (X-Trans / no-OB bodies, `ob_area_count == 0`).
 *
 * SCALAR per channel only: per-row/column OB structure sits at the noise floor
 * (SUMMARY.json), and amp-glow / dark-current 2D structure is a SEPARATE
 * dark-master layer — deliberately out of scope for this bias scalar.
 */
export function obMedianPerPhase(
    obAreas: readonly RawlerObArea[],
    fullWidth: number,
    fullHeight: number,
): number[] | null {
    const phase: number[][] = [[], [], [], []];
    let total = 0;
    for (const area of obAreas) {
        const { x, y, w, h } = area.rect;
        const px = area.pixels;
        const effW = Math.min(x + w, fullWidth) - x;
        const effH = Math.min(y + h, fullHeight) - y;
        if (effW <= 0 || effH <= 0) continue;
        for (let r = 0; r < effH; r++) {
            const ay = y + r;
            for (let c = 0; c < effW; c++) {
                const idx = r * effW + c;
                if (idx >= px.length) break;
                const ax = x + c;
                const p = ((ay & 1) << 1) | (ax & 1);
                phase[p].push(px[idx]);
                total++;
            }
        }
    }
    if (total === 0) return null;
    const median = (a: number[]): number => {
        if (a.length === 0) return NaN;
        const s = Float64Array.from(a).sort();
        const m = s.length >> 1;
        return (s.length & 1) ? s[m] : 0.5 * (s[m - 1] + s[m]);
    };
    return phase.map(median);
}

// ─── contract types ──────────────────────────────────────────────────────────

export interface RawlerRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** One optical-black mask area: geometry + raw pixels + first-look stats. */
export interface RawlerObArea {
    rect: RawlerRect;
    /** Raw CFA ADU inside the rect, row-major within the rect (record-only). */
    pixels: Uint16Array;
    mean: number;
    /** Population std (read-noise + FPN proxy). */
    std: number;
    min: number;
    max: number;
    n: number;
}

/**
 * Additive record carried on the pipeline payload when the rail is ON
 * (honest-or-absent: the field simply does not exist on the libraw path).
 */
export interface RawlerCfaRecord {
    decoder: 'rawler-0.7.2';
    demosaic: 'integer-bilinear-v1';
    /** FULL decoded frame dims (includes OB borders). */
    fullWidth: number;
    fullHeight: number;
    /** CFA pattern at full-frame origin (e.g. 'GBRG'). */
    pattern: string;
    /** CFA pattern read at the active-area origin (phase-shifted view). */
    patternActive: string;
    /** Per-channel levels: black = bayer [R,G,B,E] tile; white = rawler whitelevel. */
    levels: { black: number[]; white: number[] };
    /** WB multipliers (RGBE); NaN channels arrive as null (schema-draft rule). */
    wb: Array<number | null>;
    activeArea: RawlerRect | null;
    cropArea: RawlerRect | null;
    /** OB harvest — DARK_CALIBRATION_POLICY §1 Reading B (record-only). */
    obAreas: RawlerObArea[];
    /**
     * Honest value-domain label for the demosaiced payload.
     * `raw_adu_pedestal_over_65535` = the default rail (pedestal INCLUDED, LAW 2).
     * `raw_adu_black_subtracted_over_65535` = CELL ① flag ON: the per-channel
     * black pedestal was subtracted (see `blackLevelApplied`).
     */
    valueDomain: 'raw_adu_pedestal_over_65535' | 'raw_adu_black_subtracted_over_65535';
    /**
     * CELL ① — per-output-channel [R,G,B] black levels actually subtracted from
     * the rgb16 payload (native raw-ADU domain), or null when DECODE_APPLY_BLACK_
     * LEVEL was OFF (the default rail). Honest-or-absent: null ⇒ nothing applied.
     */
    blackLevelApplied?: number[] | null;
    /**
     * CELL ① — provenance of the black actually subtracted (ledger row 544):
     *   'ob_measured' = per-frame per-channel OB-pixel median (≥1 optical-black
     *      area present; OVERRIDES metadata blacklevel_bayer, which was measured
     *      1–3 ADU off — test_results/ob_bias_2026-07-22/SUMMARY.json),
     *   'metadata'    = metadata blacklevel_bayer routed per channel (0 OB areas —
     *      X-Trans / no-OB bodies), the pre-existing path UNCHANGED,
     *   null          = CELL ① was OFF (the default rail; nothing applied).
     * IN-MEMORY PAYLOAD ONLY — deliberately NOT surfaced into the receipt's
     * `rawler_calibration` block yet: that surfacing + its schema-version bump
     * ride the future default-flip rebaseline train, keeping the flag-OFF receipt
     * byte-identical (both SACRED pins hold version 2.18.0).
     */
    blackLevelSource?: 'ob_measured' | 'metadata' | null;
}

// ─── receipt calibration surface (lean, honest-or-absent) ──────────────────────

/**
 * One optical-black area's calibration STATS. The heavy raw `pixels` buffer of
 * {@link RawlerObArea} is DROPPED here — only geometry + first-look stats survive
 * (the same counts-not-buffers discipline the failure receipt uses for signal).
 */
export interface RawlerObAreaStat {
    rect: RawlerRect;
    mean: number;
    /** Population std (read-noise + FPN proxy). */
    std: number;
    min: number;
    max: number;
    n: number;
}

/**
 * LEAN per-frame rawler decode calibration, surfaced into the receipt as the
 * `rawler_calibration` block (schema 2.14.0). A pure reduction of
 * {@link RawlerCfaRecord} that DROPS the heavy raw OB `pixels` buffers (kept as
 * mean/std/min/max/n stats). Honest-or-absent (LAW 3): produced ONLY on the
 * rawler decode arm — the libraw cold path, FITS, and demo-tier carry null.
 * Nothing here is a calibration DECISION: this rail applies NO black-subtract /
 * white-scale (LAW 2), so `value_domain` labels the raw-ADU pedestal domain the
 * levels/wb describe — the values are MEASURED, recorded, never applied.
 */
export interface RawlerCalibration {
    decoder: string;
    demosaic: string;
    /** FULL decoded frame dims (includes OB borders). */
    full_width: number;
    full_height: number;
    /** CFA pattern at full-frame origin (e.g. 'GBRG'). */
    pattern: string;
    /** CFA pattern read at the active-area origin (phase-shifted view). */
    pattern_active: string;
    /** Per-channel black levels (bayer [R,G,B,E] tile). */
    black_levels: number[];
    /** White (saturation) level(s). */
    white_levels: number[];
    /** WB multipliers (RGBE); NaN channels arrive as null (schema-draft rule). */
    wb: Array<number | null>;
    active_area: RawlerRect | null;
    crop_area: RawlerRect | null;
    /** OB harvest STATS (raw pixels dropped) — DARK_CALIBRATION_POLICY §1 Reading B. */
    ob_areas: RawlerObAreaStat[];
    /** Honest value-domain label for the demosaiced payload the levels describe. */
    value_domain: RawlerCfaRecord['valueDomain'];
    /** CELL ① — per-channel [R,G,B] black actually subtracted, or null (default OFF). */
    black_level_applied: number[] | null;
}

/**
 * Reduce the full {@link RawlerCfaRecord} to the lean receipt calibration block,
 * dropping the heavy raw OB pixel buffers (stats only). Pure and null-safe:
 * a null/undefined record (libraw cold path, FITS, demo-tier) returns null.
 */
export function summarizeRawlerCalibration(
    rec: RawlerCfaRecord | null | undefined,
): RawlerCalibration | null {
    if (!rec) return null;
    return {
        decoder: rec.decoder,
        demosaic: rec.demosaic,
        full_width: rec.fullWidth,
        full_height: rec.fullHeight,
        pattern: rec.pattern,
        pattern_active: rec.patternActive,
        black_levels: Array.isArray(rec.levels?.black) ? [...rec.levels.black] : [],
        white_levels: Array.isArray(rec.levels?.white) ? [...rec.levels.white] : [],
        wb: Array.isArray(rec.wb) ? [...rec.wb] : [],
        active_area: rec.activeArea ?? null,
        crop_area: rec.cropArea ?? null,
        ob_areas: (rec.obAreas ?? []).map(a => ({
            rect: a.rect, mean: a.mean, std: a.std, min: a.min, max: a.max, n: a.n,
        })),
        value_domain: rec.valueDomain,
        black_level_applied: Array.isArray(rec.blackLevelApplied) ? [...rec.blackLevelApplied] : null,
    };
}

/**
 * The format-registry "COMING CFA CONTRACT" result (format_registry.ts:42-50):
 * deterministic full-frame Bayer decode, parameterized per format.
 */
export interface CfaContractResult {
    /** FULL-frame u16 mosaic (cpp=1, index = y*width + x) incl. OB borders. */
    CFA: Uint16Array;
    /** CFA pattern at full-frame origin. */
    pattern: string;
    /** Per-channel levels (black = bayer RGBE tile; white = saturation). */
    levels: { black: number[]; white: number[] };
    /** WB multipliers (RGBE); absent channel = null. */
    WB: Array<number | null>;
    fullDims: { width: number; height: number };
    activeArea: RawlerRect | null;
    cropArea: RawlerRect | null;
    /** Optical-black mask geometry (per-frame dark anchor source). */
    obAreas: RawlerRect[];
}

// ─── wasm module loading (non-analyzable: pkg/ is gitignored) ────────────────

interface WasmDecodedRawHandle {
    readonly width: number;
    readonly height: number;
    readonly active_x: number;
    readonly active_y: number;
    readonly active_w: number;
    readonly active_h: number;
    meta_json(): string;
    cfa_full(): Uint16Array;
    rgb16_active(): Uint16Array;
    demosaic_luma_full_le(): Uint8Array;
    cfa_full_le(): Uint8Array;
    ob_area_count(): number;
    ob_pixels(idx: number): Uint16Array;
    free(): void;
}

interface WasmDecodeModule {
    default?: (input?: unknown) => Promise<unknown>;
    initSync: (opts: { module: BufferSource }) => unknown;
    decode_raw(bytes: Uint8Array): WasmDecodedRawHandle;
}

interface RawlerMetaJson {
    decoder: string;
    make: string;
    model: string;
    clean_make: string;
    clean_model: string;
    width: number;
    height: number;
    cpp: number;
    bps: number;
    cfa_pattern_full: string;
    cfa_pattern_active: string;
    cfa_tile: number[];
    blacklevel: number[];
    blacklevel_bayer: number[];
    whitelevel: number[];
    wb_coeffs: Array<number | null>;
    active_area: RawlerRect | null;
    crop_area: RawlerRect | null;
    black_areas: RawlerRect[];
    data_is_integer: boolean;
}

let wasmModPromise: Promise<WasmDecodeModule> | null = null;

/**
 * Load + init the wasm_decode pkg exactly once. Node (headless lane): read the
 * pkg from disk next to this module and boot with initSync — the wasm_compute
 * headless pattern (tools/api/headless_driver.ts bootRealWasm). Browser: a
 * vite-served dynamic import; init() fetches wasm_decode_bg.wasm relative to
 * the module URL. Both specifiers are deliberately NON-analyzable (@vite-ignore
 * / runtime-built file URL) so no build step ever hard-requires the gitignored
 * pkg while the flag is OFF.
 */
async function loadWasmDecode(): Promise<WasmDecodeModule> {
    if (!wasmModPromise) {
        wasmModPromise = (async () => {
            const isNode =
                typeof process !== 'undefined' &&
                !!(process as { versions?: { node?: string } }).versions?.node &&
                typeof window === 'undefined';
            if (isNode) {
                const { pathToFileURL, fileURLToPath } = await import('node:url');
                const path = await import('node:path');
                const fs = await import('node:fs');
                const here = path.dirname(fileURLToPath(import.meta.url));
                // src/engine/pipeline/m1_ingestion → src/engine/wasm_decode/pkg
                const pkgDir = path.resolve(here, '..', '..', 'wasm_decode', 'pkg');
                const jsUrl = pathToFileURL(path.join(pkgDir, 'wasm_decode.js')).href;
                const mod = (await import(/* @vite-ignore */ jsUrl)) as unknown as WasmDecodeModule;
                mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'wasm_decode_bg.wasm')) });
                return mod;
            }
            // Runtime-built specifier: tsc/vite must NOT resolve this at build
            // time (the pkg is a gitignored local build; flag OFF never gets here).
            const browserSpecifier = ['', 'src', 'engine', 'wasm_decode', 'pkg', 'wasm_decode.js'].join('/');
            const mod = (await import(/* @vite-ignore */ browserSpecifier)) as unknown as WasmDecodeModule;
            await mod.default!();
            return mod;
        })().catch((err) => {
            // Reset so a transient failure (pkg not built yet) can retry later.
            wasmModPromise = null;
            throw err;
        });
    }
    return wasmModPromise;
}

// ─── decode entries ──────────────────────────────────────────────────────────

function obAreasFrom(handle: WasmDecodedRawHandle, rects: RawlerRect[]): RawlerObArea[] {
    const out: RawlerObArea[] = [];
    for (let i = 0; i < rects.length; i++) {
        const pixels = handle.ob_pixels(i);
        let min = 65535;
        let max = 0;
        let sum = 0;
        for (let k = 0; k < pixels.length; k++) {
            const v = pixels[k];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }
        const n = pixels.length;
        const mean = n > 0 ? sum / n : 0;
        let varAcc = 0;
        for (let k = 0; k < n; k++) {
            const d = pixels[k] - mean;
            varAcc += d * d;
        }
        out.push({
            rect: rects[i],
            pixels,
            mean,
            std: n > 0 ? Math.sqrt(varAcc / n) : 0,
            min: n > 0 ? min : 0,
            max,
            n,
        });
    }
    return out;
}

/**
 * The CFA-contract decoder entry fn (format-registry "COMING CFA CONTRACT"):
 * full RAW buffer → deterministic full-frame Bayer contract. Null on failure
 * (the m1 decode contract). Never consulted by the default (flag-OFF) path.
 */
export async function decodeCfaContract(buffer: ArrayBuffer): Promise<CfaContractResult | null> {
    let handle: WasmDecodedRawHandle | null = null;
    try {
        const mod = await loadWasmDecode();
        handle = mod.decode_raw(new Uint8Array(buffer));
        const meta = JSON.parse(handle.meta_json()) as RawlerMetaJson;
        return {
            CFA: handle.cfa_full(),
            pattern: meta.cfa_pattern_full,
            levels: { black: meta.blacklevel_bayer, white: meta.whitelevel },
            WB: meta.wb_coeffs,
            fullDims: { width: meta.width, height: meta.height },
            activeArea: meta.active_area,
            cropArea: meta.crop_area,
            obAreas: meta.black_areas,
        };
    } catch (err) {
        console.error('[RawlerDecoder] decodeCfaContract error:', err);
        return null;
    } finally {
        handle?.free();
    }
}

/**
 * Flag-ON m1 payload: full-frame contract → integer demosaic (active area) →
 * the pipeline's demosaiced-RGB shape + the additive `rawler` record.
 * Structurally compatible with `extractRawSensorData`'s return contract.
 */
export async function decodeRawlerForPipeline(buffer: ArrayBuffer): Promise<{
    data: Float32Array;
    width: number;
    height: number;
    stride: number;
    isDemosaiced: boolean;
    selectedIfdIndex: number;
    sensorHints?: unknown;
    arrowTable?: ReturnType<typeof ArrowMemory.createRgbBuffer>;
    calibrationStrip?: Uint16Array;
    rawler?: RawlerCfaRecord;
} | null> {
    let handle: WasmDecodedRawHandle | null = null;
    try {
        console.log(`[RawlerDecoder] Starting rawler wasm decode (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)...`);
        const mod = await loadWasmDecode();
        handle = mod.decode_raw(new Uint8Array(buffer));
        const meta = JSON.parse(handle.meta_json()) as RawlerMetaJson;

        const width = handle.active_w;
        const height = handle.active_h;
        const rgb16 = handle.rgb16_active();
        if (rgb16.length !== width * height * 3) {
            throw new Error(`rgb16_active length ${rgb16.length} != ${width}x${height}x3`);
        }

        // Normalized Float32 interleaved RGB — same shape the libraw mem_image
        // path emits. Raw-ADU domain over 65535 (pedestal included; honest label
        // in rawler.valueDomain — NO black-sub/white-scale in this rail).
        //
        // CELL ① — per-channel black-level subtraction, DEFAULT OFF. When OFF the
        // loop is EXACTLY `rgb[i] = rgb16[i] * inv` (byte-identical). When ON we
        // subtract the MEASURED per-output-channel black pedestal (mapped R/G/B
        // via the CFA tile, mirroring the crate's scatter_planes color routing:
        // 0=R, 1=G, else→B) in the native raw-ADU domain, clamped at 0, BEFORE
        // the 1/65535 normalize. PIXEL ledger; LAW 7 values-only (no layout move).
        // OB harvest computed once (record-only on the default path; also the
        // CELL ① OB-override source). Hoisted above CELL ① — same call/result the
        // record used inline, so the flag-OFF payload is byte-identical.
        const obAreas = obAreasFrom(handle, meta.black_areas);
        const applyBlack = isDecodeApplyBlackLevelEnabled();
        let blackApplied: number[] | null = null;
        let blackSource: 'ob_measured' | 'metadata' | null = null;
        const rgb = new Float32Array(rgb16.length);
        const inv = 1 / 65535;
        if (applyBlack) {
            const tile = Array.isArray(meta.cfa_tile) ? meta.cfa_tile : [];
            const blk = Array.isArray(meta.blacklevel_bayer) ? meta.blacklevel_bayer : [];
            // OB-MEASURED OVERRIDE (ledger row 544): with ≥1 optical-black area,
            // the per-channel black = the per-frame OB per-phase median routed
            // through the SAME CFA-tile mapping — this OVERRIDES metadata
            // blacklevel_bayer (metadata was measured 1–3 ADU off; SUMMARY.json).
            // 0 OB areas (X-Trans / no-OB bodies) ⇒ the pre-existing metadata path,
            // UNCHANGED. Scalar per channel only (row/col structure is at the noise
            // floor; amp-glow / dark-current are a separate dark-master layer).
            const obMed = obMedianPerPhase(obAreas, meta.width, meta.height);
            const useOb = obAreas.length >= 1 && obMed !== null;
            const [blackR, blackG, blackB] = useOb
                ? perChannelBlackFromTile(tile, obMed!)
                : perChannelBlackFromTile(tile, blk);
            blackSource = useOb ? 'ob_measured' : 'metadata';
            blackApplied = [blackR, blackG, blackB];
            for (let i = 0; i < rgb16.length; i++) {
                const c = i % 3; // interleaved R,G,B
                const black = c === 0 ? blackR : c === 1 ? blackG : blackB;
                const v = rgb16[i] - black;
                rgb[i] = (v > 0 ? v : 0) * inv;
            }
            console.log(
                `[RawlerDecoder] CELL① black-level applied (${blackSource}) per channel ` +
                `R=${blackR.toFixed(1)} G=${blackG.toFixed(1)} B=${blackB.toFixed(1)} (native ADU, clamped ≥0).`
            );
        } else {
            for (let i = 0; i < rgb16.length; i++) rgb[i] = rgb16[i] * inv;
        }

        const record: RawlerCfaRecord = {
            decoder: 'rawler-0.7.2',
            demosaic: 'integer-bilinear-v1',
            fullWidth: meta.width,
            fullHeight: meta.height,
            pattern: meta.cfa_pattern_full,
            patternActive: meta.cfa_pattern_active,
            levels: { black: meta.blacklevel_bayer, white: meta.whitelevel },
            wb: meta.wb_coeffs,
            activeArea: meta.active_area,
            cropArea: meta.crop_area,
            obAreas,
            valueDomain: applyBlack ? 'raw_adu_black_subtracted_over_65535' : 'raw_adu_pedestal_over_65535',
            blackLevelApplied: blackApplied,
            blackLevelSource: blackSource,
        };

        console.log(
            `[RawlerDecoder] rawler payload: full ${meta.width}x${meta.height} (${meta.cfa_pattern_full}) → ` +
            `active ${width}x${height}x3 integer-demosaic RGB (raw-ADU domain). ` +
            `OB areas recorded: ${record.obAreas.length} (record-only).`
        );

        return {
            data: rgb,
            width,
            height,
            stride: width,
            isDemosaiced: true,
            selectedIfdIndex: 0,
            sensorHints: PhotometryManager.getProfile(),
            arrowTable: ArrowMemory.createRgbBuffer(rgb, width, height),
            calibrationStrip: undefined,
            rawler: record,
        };
    } catch (err) {
        console.error('[RawlerDecoder] decodeRawlerForPipeline error:', err);
        return null;
    } finally {
        handle?.free();
    }
}
