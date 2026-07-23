import { PhotometryManager } from "../m8_photometry/photometry_manager";
import * as wasm from '../../wasm_compute/pkg/wasm_compute';
import type { DemosaicParams } from './demosaic_pipeline';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import type { CFAClass, CFAVerdict } from '../../types/Main_types';

/**
 * DemosaicEngine
 * Handles low-level Bayer demosaicing calculations.
 */
export class DemosaicEngine {
    /**
     * Classify a raw (un-demosaiced) frame as std-Bayer / mono / quad-Bayer,
     * BEFORE any 2x2 luminance binning, so the caller can route honestly:
     * `binBayerToluminance` hard-assumes a standard 2x2 CFA, so a mono FITS or a
     * quad-Bayer (2x2 same-colour super-cells) sensor would otherwise be silently
     * mis-binned.
     *
     * PATTERN-AGNOSTIC statistical test (no RGGB/BGGR assumption): it measures
     * how the four 2x2-phase positions SEPARATE in mean level, not which phase is
     * which colour.
     *   - phaseSpreadL0: normalised range of the four pixel-level 2x2-phase means.
     *     A real colour CFA prints a systematic per-phase offset (dye transmission
     *     differs by colour) => L0 large. Mono has one response => L0 ~ 0. Quad,
     *     AT THE 2x2 SCALE, averages all colours into every phase => L0 ~ 0 too.
     *   - phaseSpreadL1: the same range recomputed on the 2x2-BINNED image. For
     *     quad-Bayer the binned image is ITSELF a half-res Bayer mosaic => L1
     *     large; for std-Bayer / mono the binned image is smooth luminance => ~0.
     *     This is what separates quad-Bayer from mono.
     *
     * Decision: L0>=L0_THR -> std-bayer; else L1>=L1_THR -> quad-bayer; else mono.
     * Thresholds live in PIPELINE_CONSTANTS (calibrated on real Carina 60Da).
     *
     * Cost: one full pass over the frame (runs once per ingest) — deterministic;
     * no subsampling (a strided sample can alias the 2x2 parity and corrupt L1).
     *
     * @param raw          Raw single-channel sensor buffer (u16 or f32).
     * @param width        Active width in pixels.
     * @param height       Active height in pixels.
     * @param stride       Memory stride of the raw buffer.
     * @param blackLevel   Pedestal used only to normalise spread by signal-above-
     *                     black; a rough value is fine (relative metric).
     */
    static classifyCFA(
        raw: Uint16Array | Float32Array,
        width: number,
        height: number,
        stride: number,
        blackLevel: number
    ): CFAVerdict {
        const T_L0 = PIPELINE_CONSTANTS.CFA_CLASSIFY_L0_THRESHOLD;
        const T_L1 = PIPELINE_CONSTANTS.CFA_CLASSIFY_L1_THRESHOLD;
        const EPS = 1e-6;

        const bw = Math.floor(width / 2);
        const bh = Math.floor(height / 2);

        // Degenerate frames can't be classified — report mono (the safe default:
        // routes to a plain box-average bin) rather than fabricate a verdict.
        if (bw < 1 || bh < 1) {
            return {
                klass: 'mono', supported: true,
                phaseSpreadL0: 0, phaseSpreadL1: 0, blocksSampled: 0,
                reason: 'frame too small to classify (< one full 2x2 block) — defaulting to mono',
            };
        }

        // Pixel-level phase sums (m0..m3) + super-phase sums of the binned image
        // (indexed by the BLOCK's own parity => the original 4x4 phase). FULL scan.
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
        const sp = [0, 0, 0, 0];
        const spn = [0, 0, 0, 0];
        for (let by = 0; by < bh; by++) {
            const row0 = (2 * by) * stride;
            const row1 = row0 + stride;
            const spBase = (by & 1) * 2;
            for (let bx = 0; bx < bw; bx++) {
                const c0 = row0 + 2 * bx;
                const p0 = raw[c0], p1 = raw[c0 + 1], p2 = raw[row1 + 2 * bx], p3 = raw[row1 + 2 * bx + 1];
                s0 += p0; s1 += p1; s2 += p2; s3 += p3; n++;
                const blockMean = (p0 + p1 + p2 + p3) * 0.25;
                const spi = spBase + (bx & 1);
                sp[spi] += blockMean; spn[spi]++;
            }
        }

        const m0 = s0 / n, m1 = s1 / n, m2 = s2 / n, m3 = s3 / n;
        const mu = (m0 + m1 + m2 + m3) * 0.25;
        const denom0 = Math.max(mu - blackLevel, EPS);
        const phaseSpreadL0 = (Math.max(m0, m1, m2, m3) - Math.min(m0, m1, m2, m3)) / denom0;

        const bm0 = spn[0] > 0 ? sp[0] / spn[0] : mu;
        const bm1 = spn[1] > 0 ? sp[1] / spn[1] : mu;
        const bm2 = spn[2] > 0 ? sp[2] / spn[2] : mu;
        const bm3 = spn[3] > 0 ? sp[3] / spn[3] : mu;
        const bmu = (bm0 + bm1 + bm2 + bm3) * 0.25;
        const denom1 = Math.max(bmu - blackLevel, EPS);
        const phaseSpreadL1 = (Math.max(bm0, bm1, bm2, bm3) - Math.min(bm0, bm1, bm2, bm3)) / denom1;

        let klass: CFAClass;
        let supported: boolean;
        let reason: string;
        if (phaseSpreadL0 >= T_L0) {
            klass = 'std-bayer'; supported = true;
            reason = `2x2 colour separation L0=${phaseSpreadL0.toFixed(4)} >= ${T_L0} (standard CFA)`;
        } else if (phaseSpreadL1 >= T_L1) {
            klass = 'quad-bayer'; supported = false;
            reason = `flat 2x2 blocks (L0=${phaseSpreadL0.toFixed(4)} < ${T_L0}) but binned image is colour-separated (L1=${phaseSpreadL1.toFixed(4)} >= ${T_L1}) — quad-Bayer super-cells`;
        } else {
            klass = 'mono'; supported = true;
            reason = `no phase separation at 2x2 (L0=${phaseSpreadL0.toFixed(4)}) or 4x4 (L1=${phaseSpreadL1.toFixed(4)}) — monochrome`;
        }

        return { klass, supported, phaseSpreadL0, phaseSpreadL1, blocksSampled: n, reason };
    }

    /**
     * Performs a simple bilinear demosaicing on a raw sensor buffer.
     * 
     * @param raw The raw sensor data (single-channel Bayer).
     * @param width The visible width of the image.
     * @param height The visible height of the image.
     * @param stride The memory stride (total width including padding).
     * @param params Optional CFA/calibration params. Defaults reproduce the
     *               legacy hardcoded behavior (RGGB, Canon 14-bit levels) exactly.
     * @returns A packed RGB Float32Array (3 channels per pixel).
     */
    static demosaicBilinear(
        raw: Float32Array | Uint16Array,
        width: number,
        height: number,
        stride: number,
        params?: DemosaicParams
    ): Float32Array {
        // Output is RGB (3 floats per pixel) packed tightly by width
        const output = new Float32Array(width * height * 3);

        // CFA parity offsets — RGGB(0,0), GRBG(1,0), GBRG(0,1), BGGR(1,1)
        const offX = params?.cfaOffsetX ?? 0;
        const offY = params?.cfaOffsetY ?? 0;

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                // Input index uses stride to navigate the raw sensor buffer
                const i = y * stride + x;

                // Output index uses width to pack the pixels tightly for the viewer
                const outIdx = (y * width + x) * 3;

                // Determine Bayer pixel type based on parity-shifted coordinates
                const isEvenRow = (y + offY) % 2 === 0;
                const isEvenCol = (x + offX) % 2 === 0;

                if (isEvenRow && isEvenCol) {
                    // RED Pixel: Sample neighbors for G and B
                    output[outIdx] = raw[i]; // R
                    output[outIdx + 1] = (raw[i - 1] + raw[i + 1] + raw[i - stride] + raw[i + stride]) / 4; // G
                    output[outIdx + 2] = (raw[i - stride - 1] + raw[i - stride + 1] + raw[i + stride - 1] + raw[i + stride + 1]) / 4; // B
                } else if (!isEvenRow && !isEvenCol) {
                    // BLUE Pixel: Sample neighbors for R and G
                    output[outIdx] = (raw[i - stride - 1] + raw[i - stride + 1] + raw[i + stride - 1] + raw[i + stride + 1]) / 4; // R
                    output[outIdx + 1] = (raw[i - 1] + raw[i + 1] + raw[i - stride] + raw[i + stride]) / 4; // G
                    output[outIdx + 2] = raw[i]; // B
                } else {
                    // GREEN Pixel: Sample neighbors for R and B
                    output[outIdx + 1] = raw[i]; // G
                    if (isEvenRow) { // Green on Red row
                        output[outIdx] = (raw[i - 1] + raw[i + 1]) / 2; // R
                        output[outIdx + 2] = (raw[i - stride] + raw[i + stride]) / 2; // B
                    } else { // Green on Blue row
                        output[outIdx] = (raw[i - stride] + raw[i + stride]) / 2; // R
                        output[outIdx + 2] = (raw[i - 1] + raw[i + 1]) / 2; // B
                    }
                }
            }
        }

        // [CALIBRATION PARITY] Match WebGPU Shader logic
        const BLACK_LEVEL = params?.blackLevel ?? 2048.0;
        const WHITE_LEVEL = params?.whiteLevel ?? 16383.0; // 14-bit
        const WB_R = params?.wbR ?? 2.1;
        const WB_G = params?.wbG ?? 1.0;
        const WB_B = params?.wbB ?? 1.4;
        const normScale = 1.0 / (WHITE_LEVEL - BLACK_LEVEL);

        for (let i = 0; i < output.length; i += 3) {
            output[i]     = Math.max(0, (output[i]     - BLACK_LEVEL) * normScale * WB_R); // R
            output[i + 1] = Math.max(0, (output[i + 1] - BLACK_LEVEL) * normScale * WB_G); // G
            output[i + 2] = Math.max(0, (output[i + 2] - BLACK_LEVEL) * normScale * WB_B); // B
        }

        return output;
    }

    /**
     * Collapses a Bayer CFA (RGGB) into a monochrome luminance map via 2x2 binning.
     * Fixes Sigma inflation caused by adjacent pixel sensitivity differences.
     * Handles stride correction and subtracts black level pedestal.
     * 
     * @param cfa The raw Bayer data.
     * @param stride The memory stride of the input buffer.
     * @param activeWidth The width of the active pixel area.
     * @param activeHeight The height of the active pixel area.
     * @param blackLevel The sensor black level (pedestal).
     * @param whiteLevel The sensor white level (saturation).
     */
    static async binBayerToluminance(
        cfa: Uint16Array,
        stride: number,
        activeWidth: number,
        activeHeight: number,
        blackLevelOverride?: number,
        whiteLevelOverride?: number
    ): Promise<{ data: Float32Array; width: number; height: number }> {
        const profile = PhotometryManager.getProfile();
        const blackLevel = blackLevelOverride ?? profile.black_level;
        const whiteLevel = whiteLevelOverride ?? profile.white_level;

        const w = Math.floor(activeWidth / 2);
        const h = Math.floor(activeHeight / 2);

        // [WASM INIT — ROOT FIX] The wasm-pack *web-target* glue binds its
        // exports only after the default init runs; calling get_cfa_input_ptr /
        // bin_bayer_to_luma before that throws "Cannot read properties of
        // undefined (reading 'get_cfa_input_ptr')". The native-Bayer detection
        // lane (analyzeBayerNative) reaches this method as its FIRST WASM touch
        // — before SignalProcessor.extractBlobs self-inits — so we must init
        // here too, exactly as extractBlobs/source_extractor do. The init's
        // RESOLVED value IS the exports object, which carries `memory` (the web
        // glue does NOT re-export it as a namespace binding, so `wasm.memory`
        // alone is undefined). __wbg_init short-circuits once initialized, so
        // this is cheap on every subsequent call.
        const wasmMod = wasm as any;
        const exports = typeof wasmMod.default === 'function' ? await wasmMod.default() : null;
        const mem: WebAssembly.Memory = exports?.memory ?? wasmMod.memory;

        // Ensure WASM buffer is large enough
        const ptr = wasmMod.get_cfa_input_ptr(cfa.length);
        const buffer = new Uint16Array(mem.buffer, ptr as number, cfa.length);
        buffer.set(cfa);

        const outPtr = wasmMod.bin_bayer_to_luma(ptr, activeWidth, activeHeight, stride, blackLevel, whiteLevel);
        const outSize = w * h;
        const outData = new Float32Array(mem.buffer, outPtr as number, outSize);

        // Copy to JS heap so WASM buffer can be reused later
        return {
            data: outData.slice(),
            width: w,
            height: h
        };
    }
}

