import { ScaleManager } from '../pipeline/m2_hardware/scale_manager';
import type { ColorTransform } from './camera_color_matrix';
import { linearSrgbToOklab, oklabToOklch, gamutClipPreserveHue, oklchToLinearSrgb, encodeSrgb } from './oklab';

/**
 * RENDER-PLANE warp descriptor — a single ARBITRATED distortion model (SELECTION,
 * never composition; see ui/corrected_view.selectRenderWarp). Consumed by
 * {@link ImageProcessor.applyRenderWarp}. All coordinate quantities are in the
 * SOLVE buffer's pixel space (the render maps solve→preview via coordScale).
 */
export type RenderWarp =
    | { kind: 'sip'; sip: { a: number[][]; b: number[][] } }
    | {
          kind: 'tps';
          /** Control points in NORMALIZED offset space (un[i], vn[i]) — the columns
           *  of TpsModel.control_points. */
          un: number[];
          vn: number[];
          weightsX: number[];
          weightsY: number[];
          affineX: [number, number, number];
          affineY: [number, number, number];
          /** Normalization scale s (solve px): p̃ = (solve px − crpix)/s. */
          tpsScale: number;
      }
    | { kind: 'bc'; k1: number; k2: number; solveW: number; solveH: number };

/** Machine-readable render-admission reason (why a selected warp does/doesn't render). */
export type RenderAdmissionReason =
    | 'ADMITTED'
    | 'NO_SUPPORT'          // < 4 matched stars / no frame dims — cannot judge validity
    | 'RMS_CEILING'         // per-star residual above the pathology ceiling
    | 'HULL_COVERAGE'       // fit support covers too little of the frame (extrapolation)
    | 'CORNER_EXTRAPOLATION'; // corner displacement dwarfs the in-hull displacement

/** Verdict + measured metrics of the render admission gate (user-visible, never silent). */
export interface RenderAdmission {
    admitted: boolean;
    reason: RenderAdmissionReason;
    metrics: {
        rms_px: number;
        hull_coverage: number;
        corner_ratio: number;
        max_corner_px: number;
        in_hull_p95_px: number;
    };
}

/**
 * IMAGE PROCESSOR â€” Core Graphics & Decoding Utility
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralizes image decoding, cropping, and UI conversion logic.
 * Primarily handles browser-native decoding and coordinate-aware cropping.
 */
export class ImageProcessor {

    /**
     * Decodes a JPEG/TIFF buffer at FULL resolution using browser APIs.
     * Essential for non-RAW files where LibRaw might only return thumbnails.
     */
    public static async decodeFullResImage(buffer: ArrayBuffer): Promise<{ data: Float32Array; width: number; height: number; stride: number; isDemosaiced: boolean } | null> {
        if (typeof createImageBitmap === 'undefined') {
            console.error("[ImageProcessor] decodeFullResImage: createImageBitmap not available.");
            return null; 
        }

        try {
            const blob = new Blob([buffer]);
            const bitmap = await createImageBitmap(blob);
            const w = bitmap.width;
            const h = bitmap.height;

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            
            if (!ctx) throw new Error("Could not create 2D context for decoding.");
            
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            bitmap.close();

            // Convert RGBA8 to RGB Float32 (0.0 - 1.0)
            const rgb = new Float32Array(w * h * 3);
            for (let i = 0; i < w * h; i++) {
                rgb[i * 3]     = imageData.data[i * 4] / 255;
                rgb[i * 3 + 1] = imageData.data[i * 4 + 1] / 255;
                rgb[i * 3 + 2] = imageData.data[i * 4 + 2] / 255;
            }

            return {
                data: rgb,
                width: w,
                height: h,
                stride: w,
                isDemosaiced: true
            };
        } catch (err) {
            console.error("[ImageProcessor] decodeFullResImage Error:", err);
            return null;
        }
    }

    /**
     * Grabs a 1:1 crop from the science Buffer (luminance).
     * Used for the "Magnifying Glass" UI.
     */
    public static getCrop(
        scienceBuffer: Float32Array, 
        imageWidth: number, 
        imageHeight: number, 
        centerX: number, 
        centerY: number, 
        size: number = 512,
        scales?: ScaleManager
    ): ImageData | null {
        if (!scienceBuffer) return null;
        
        // Coordinates are in NATIVE sensor space, convert to science if binned
        let sx = centerX;
        let sy = centerY;

        if (scales && scienceBuffer.length === scales.scienceW * scales.scienceH) {
            const sci = scales.nativeToscience(centerX, centerY);
            sx = sci.x;
            sy = sci.y;
        }

        const half = Math.floor(size / 2);
        const w = (scales && scienceBuffer.length === scales.scienceW * scales.scienceH) ? scales.scienceW : imageWidth;
        const h = (scales && scienceBuffer.length === scales.scienceW * scales.scienceH) ? scales.scienceH : imageHeight;

        const startX = Math.floor(Math.max(0, Math.min(w - size, sx - half)));
        const startY = Math.floor(Math.max(0, Math.min(h - size, sy - half)));

        const cropData = new Uint8ClampedArray(size * size * 4);

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const srcIdx = (startY + y) * w + (startX + x);
                const destIdx = (y * size + x) * 4;
                const val = Math.min(255, (scienceBuffer[srcIdx] || 0) * 255);
                
                cropData[destIdx] = val;
                cropData[destIdx + 1] = val;
                cropData[destIdx + 2] = val;
                cropData[destIdx + 3] = 255;
            }
        }

        return new ImageData(cropData, size, size);
    }

    /**
     * STF AUTO-STRETCH v2 (PixInsight/Siril-style midtones transfer function).
     * Plain gamma is useless for calibrated deep-sky stacks: a frame with
     * median 0.004 maps to ~21/255 — near-black. The STF makes the actual
     * image visible with honest, standard math:
     *   1. Two-part color calibration: subtractive background neutralization
     *      to a common pedestal, then highlight white balance from the
     *      bright-star ensemble (or SPCC catalog gains — §3.2 below).
     *   2. Robust stats from the CALIBRATED LUMINANCE (median m, normalized
     *      MAD); shadows clip c0 = clamp(m - 2.8·1.4826·MAD, 0, 1).
     *   3. Midtone parameter M solved so the median lands at target B=0.15
     *      (0.25 read washed-gray):
     *      MTF(x, M) = ((M-1)·x) / ((2M-1)·x - M); MTF(0)=0, MTF(1)=1,
     *      M=0.5 is identity. Solving MTF(mnorm, M) = B gives
     *      M = mnorm·(B-1) / (2·B·mnorm - B - mnorm).
     *   4. COLOR-PRESERVING stretch (supersedes the v1 linked stretch that
     *      pushed each of R,G,B through the same c0/M): LUMINANCE is
     *      stretched through the MTF, chroma scaled by Ls/L
     *      (hue-exact), then two perceptual guards — background
     *      desaturation below ~2.2× the stretched sky level, and a
     *      highlight rolloff that clips saturated star cores toward white.
     *
     * COLOR_MATH_PROGRAM §3.2 — SPCC-GROUNDED WHITE BALANCE (PIXEL ledger): when
     * `spccWb.applied` is true, the catalog-derived TLS gains REPLACE the star-
     * ensemble-white heuristic below. COMPOSITION ORDER: gains apply AFTER the
     * camera-matrix rotation — they act on `src` (the matrix-projected linear
     * signal), so where BOTH a body matrix and SPCC gains exist the matrix rotates
     * cam-RGB→linear-sRGB first and the SPCC gains are the definitive residual WB
     * in that output space. (Today they never co-occur: SPCC is FITS-only and the
     * only SPCC body — SeeStar/IMX462 — has NO matrix; matrix bodies are CR2/DSLR
     * where SPCC does not run. The order is a documented forward design decision.)
     * Honest fallback: without applied gains the empirical heuristic stands and the
     * render is byte-identical to the pre-gains path.
     */
    public static float32ToImageDataAutoStretch(
        float32: Float32Array, w: number, h: number,
        colorTransform?: ColorTransform | null,
        spccWb?: { gains: [number, number, number]; applied: boolean } | null,
        renderOpts?: { oklab?: boolean } | null,
    ): ImageData {
        // DERIVED camera-matrix color (COLOR_MATH_PROGRAM 3.1): when a per-body
        // forward matrix is supplied, project camera-native RGB into linear sRGB
        // (implied D65 white balance folded in) BEFORE the STF calibration/stretch.
        // Honest-or-absent: with no transform, `src` aliases the input and every
        // downstream read is byte-identical to the pre-color render.
        const src = colorTransform ? this.applyColorMatrixLinear(float32, w, h, colorTransform.matrix) : float32;
        const n = w * h;
        // Per-channel background medians on a pixel subsample (~80k samples;
        // the +1 keeps the stride coprime-ish with row width vs aliasing).
        const chan: number[][] = [[], [], []];
        let pixStride = Math.max(1, Math.floor(n / 80_000));
        if (pixStride > 1 && w % pixStride === 0) pixStride += 1;
        for (let p = 0; p < n; p += pixStride) {
            const sIdx = p * 3;
            for (let c = 0; c < 3; c++) {
                const v = src[sIdx + c];
                if (Number.isFinite(v)) chan[c].push(v);
            }
        }
        if (chan[0].length < 100) return this.float32ToImageData(src, w, h);

        // TWO-PART COLOR CALIBRATION (v2 — the pure-gain v1 neutralized the
        // sky correctly but over-boosted blue in HIGHLIGHTS, tinting the
        // galaxy and star halos violet; owner-observed on the M51 in-app):
        //   1. SUBTRACTIVE background neutralization: per-channel background
        //      median shifted to a common pedestal — sky becomes achromatic
        //      by construction, signal color ratios untouched.
        //   2. HIGHLIGHT white balance: channel gains set so the bright-STAR
        //      ensemble (98th-percentile signal span, saturation-excluded)
        //      equalizes — an ensemble of stars is statistically near-white,
        //      the physics reference every frame carries. Applied to the
        //      background-subtracted SIGNAL only.
        // (stats from sorted COPIES — chan arrays stay pixel-aligned)
        const sorted = chan.map(a => [...a].sort((x, y) => x - y));
        const med = sorted.map(s => s[Math.floor(s.length / 2)]);
        const pedestal = Math.min(med[0], med[1], med[2]);
        const hi = sorted.map(s => {
            // 98th percentile of the sub-saturation population
            let end = s.length - 1;
            while (end > 0 && s[end] >= 0.95) end--;
            return s[Math.floor(end * 0.98)];
        });
        const span = hi.map((h, c) => Math.max(1e-6, h - med[c]));
        const spanRef = Math.max(span[0], span[1], span[2]);
        const empiricalGain = span.map(s => Math.min(8, Math.max(0.25, spanRef / s)));
        // §3.2: SPCC catalog-derived WB REPLACES the star-ensemble-white heuristic
        // when applied (same [0.25,8] safety clamp; gains are green-anchored, the
        // sky pedestal is untouched so background stays neutral). Byte-identical
        // fallback: with no applied gains, `gain` === the empirical array exactly.
        const gain = (spccWb && spccWb.applied)
            ? spccWb.gains.map(g => Math.min(8, Math.max(0.25, g)))
            : empiricalGain;
        // Per-channel transform: neutral sky pedestal + (SPCC or star-white) signal.
        const cal = (v: number, c: number): number => pedestal + (v - med[c]) * gain[c];

        // Robust luminance stats AFTER calibration drive the stretch.
        const samples: number[] = [];
        for (let i = 0; i < chan[0].length; i++) {
            samples.push(0.2126 * cal(chan[0][i], 0) + 0.7152 * cal(chan[1][i], 1) + 0.0722 * cal(chan[2][i], 2));
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        const absDev = samples.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const madn = 1.4826 * absDev[Math.floor(absDev.length / 2)];

        const c0 = Math.min(Math.max(median - 2.8 * madn, 0), 1);
        const range = 1 - c0;
        const mnorm = range > 1e-9 ? (median - c0) / range : 0;

        // Degenerate frames (flat, saturated, or already bright) → plain gamma.
        if (!(mnorm > 1e-6) || mnorm > 0.45) return this.float32ToImageData(src, w, h);

        // COLOR-PRESERVING STRETCH (A/B-verified on the Hungary M51 corpus
        // file — per-channel MTF rendered olive soup; this renders an
        // astrophoto): stretch the LUMINANCE through the MTF, scale chroma
        // by Ls/L (hue-exact), then two perceptual guards:
        //   background desaturation — below ~2.2x the stretched sky level,
        //     "color" is chroma noise; fade to neutral (black sky, not
        //     rainbow speckle);
        //   highlight rolloff — saturated star cores clip toward white.
        const B = 0.15; // target background (0.25 read washed-gray)
        const M = (mnorm * (B - 1)) / (2 * B * mnorm - B - mnorm);
        const mtf = (x: number): number => {
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            return ((M - 1) * x) / ((2 * M - 1) * x - M);
        };
        const smoothstep = (a: number, b: number, x: number): number => {
            const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
        };

        // OkLCh stretch path (candidate, render flag DEFAULT-OFF). Branches AFTER
        // all shared LINEAR calibration + degenerate guards, so the flag-off path
        // below is byte-identical to the pre-Oklab STF v2 render. Render-only.
        if (renderOpts?.oklab) {
            return this.renderOklabStretch(src, n, w, h, cal, chan);
        }

        const data = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) {
            const sIdx = i * 3;
            const dIdx = i * 4;
            const r = Math.max(0, cal(src[sIdx] || 0, 0));
            const g = Math.max(0, cal(src[sIdx + 1] || 0, 1));
            const b = Math.max(0, cal(src[sIdx + 2] || 0, 2));
            const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const Ls = mtf((L - c0) / range);
            const ratio = L > 1e-9 ? Ls / L : 0;
            const wSat = smoothstep(B * 0.85, B * 2.2, Ls);   // background desat
            const wHi = smoothstep(0.85, 1.0, Ls);            // highlight rolloff
            let or_ = Ls + wSat * (r * ratio - Ls);
            let og = Ls + wSat * (g * ratio - Ls);
            let ob = Ls + wSat * (b * ratio - Ls);
            or_ += wHi * (Ls - or_); og += wHi * (Ls - og); ob += wHi * (Ls - ob);
            data[dIdx] = or_ * 255;
            data[dIdx + 1] = og * 255;
            data[dIdx + 2] = ob * 255;
            data[dIdx + 3] = 255;
        }
        return new ImageData(data, w, h);
    }

    /**
     * OkLCh COLOR-PRESERVING STRETCH (PIXEL ledger, render flag `renderOpts.oklab`).
     * ─────────────────────────────────────────────────────────────────────────
     * Principled replacement for the STF v2 tail (two ad-hoc RGB guards + naive
     * clamp), per OKLAB_RESEARCH.md. Consumes the SAME LINEAR calibrated signal
     * (`cal`) as the default path — nothing upstream of the stretch changes; this
     * is render-only and touches no WCS / matched_stars / receipt value.
     *   • stretch re-solved in Oklab-L (Oklab L ≠ photometric luminance);
     *   • hue h UNTOUCHED by construction → hue preservation is provable code;
     *   • background-desat guard expressed in CHROMA (perceptually uniform);
     *   • hue-preserving gamut projection replaces the naive clamp (no pink cores).
     * All post-stretch pixel readouts are render-only → APPROXIMATE (never measured).
     * DETERMINISM: Math.cbrt (via oklab.ts) is per-platform deterministic, not
     * cross-platform bit-identical — acceptable at the render layer (Uint8 out).
     */
    private static renderOklabStretch(
        src: Float32Array, n: number, w: number, h: number,
        cal: (v: number, c: number) => number,
        chan: number[][],
    ): ImageData {
        // Re-solve stretch stats in Oklab-L space from the calibrated sample pop.
        const Lsamp: number[] = [];
        for (let i = 0; i < chan[0].length; i++) {
            const r = Math.max(0, cal(chan[0][i], 0));
            const g = Math.max(0, cal(chan[1][i], 1));
            const b = Math.max(0, cal(chan[2][i], 2));
            Lsamp.push(linearSrgbToOklab(r, g, b)[0]);
        }
        Lsamp.sort((a, b) => a - b);
        const median = Lsamp[Math.floor(Lsamp.length / 2)];
        const absDev = Lsamp.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const madn = 1.4826 * absDev[Math.floor(absDev.length / 2)];
        const c0 = Math.min(Math.max(median - 2.8 * madn, 0), 1);
        const range = 1 - c0;
        const mnorm = range > 1e-9 ? (median - c0) / range : 0;

        // Degenerate in L-space → plain gamma (honest fallback, mirrors luma path).
        if (!(mnorm > 1e-6) || mnorm > 0.45) return this.float32ToImageData(src, w, h);

        // Target background LIGHTNESS in Oklab-L. B ≈ 0.27 renders the stretched
        // sky at ≈ the STF v2 background gray (linear 0.15 ⇒ Oklab-L 0.27) — an
        // APPROXIMATE, render-only tunable, NOT a measurement (OKLAB_RESEARCH §4.2).
        const B = 0.27;
        const M = (mnorm * (B - 1)) / (2 * B * mnorm - B - mnorm);
        const mtf = (x: number): number => {
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            return ((M - 1) * x) / ((2 * M - 1) * x - M);
        };
        const smoothstep = (a: number, b: number, x: number): number => {
            const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
        };

        const data = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) {
            const sIdx = i * 3;
            const dIdx = i * 4;
            const r = Math.max(0, cal(src[sIdx] || 0, 0));
            const g = Math.max(0, cal(src[sIdx + 1] || 0, 1));
            const b = Math.max(0, cal(src[sIdx + 2] || 0, 2));
            const [L, aa, bb] = linearSrgbToOklab(r, g, b);
            const [, C, hue] = oklabToOklch(L, aa, bb);
            // Lightness-only stretch: hue is untouched by construction.
            const Ls = mtf((L - c0) / range);
            // Background-desat guard in CHROMA (uniform across hues, unlike wSat).
            const Cs = C * smoothstep(B * 0.85, B * 2.2, Ls);
            // Hue-preserving gamut projection (holds hue, desaturates to white
            // above the sRGB cusp) — replaces the naive per-channel clamp.
            const [Lc, Cc, hc] = gamutClipPreserveHue(Ls, Cs, hue);
            const [lr, lg, lb] = oklchToLinearSrgb(Lc, Cc, hc);
            data[dIdx]     = encodeSrgb(lr) * 255;
            data[dIdx + 1] = encodeSrgb(lg) * 255;
            data[dIdx + 2] = encodeSrgb(lb) * 255;
            data[dIdx + 3] = 255;
        }
        return new ImageData(data, w, h);
    }

    /**
     * DERIVED camera-matrix color projection (PIXEL ledger, COLOR_MATH_PROGRAM 3.1).
     * Applies the folded cam-raw-RGB -> linear-sRGB matrix per pixel, clamping
     * out-of-gamut negatives (deep-red/blue rotations) to 0. Returns a NEW buffer
     * fed to the STF stretch. Never invoked when no body matrix resolves, so the
     * pre-color render path stays byte-identical.
     */
    private static applyColorMatrixLinear(float32: Float32Array, w: number, h: number, M: number[][]): Float32Array {
        const out = new Float32Array(float32.length);
        const m00 = M[0][0], m01 = M[0][1], m02 = M[0][2];
        const m10 = M[1][0], m11 = M[1][1], m12 = M[1][2];
        const m20 = M[2][0], m21 = M[2][1], m22 = M[2][2];
        const n = w * h;
        for (let i = 0; i < n; i++) {
            const s = i * 3;
            const r = float32[s] || 0, g = float32[s + 1] || 0, b = float32[s + 2] || 0;
            out[s] = Math.max(0, m00 * r + m01 * g + m02 * b);
            out[s + 1] = Math.max(0, m10 * r + m11 * g + m12 * b);
            out[s + 2] = Math.max(0, m20 * r + m21 * g + m22 * b);
        }
        return out;
    }

    /**
     * Converts a Float32 buffer to 8-bit ImageData with Gamma correction.
     * Accepts either 3-channel interleaved RGB (length w*h*3) or 1-channel
     * luminance (length w*h, e.g. the science buffer); the layout is detected
     * from the buffer length. Reading a luminance buffer with the RGB stride
     * would scramble the top third of the raster and leave the rest black.
     */
    public static float32ToImageData(float32: Float32Array, w: number, h: number): ImageData {
        const data = new Uint8ClampedArray(w * h * 4);
        if (float32.length === w * h) {
            for (let i = 0; i < w * h; i++) {
                const dIdx = i * 4;
                const val = Math.min(255, Math.pow(float32[i] || 0, 1/2.2) * 255);
                data[dIdx]   = val;
                data[dIdx+1] = val;
                data[dIdx+2] = val;
                data[dIdx+3] = 255;
            }
        } else {
            for (let i = 0; i < w * h; i++) {
                const sIdx = i * 3;
                const dIdx = i * 4;
                data[dIdx]   = Math.min(255, Math.pow(float32[sIdx] || 0,   1/2.2) * 255);
                data[dIdx+1] = Math.min(255, Math.pow(float32[sIdx+1] || 0, 1/2.2) * 255);
                data[dIdx+2] = Math.min(255, Math.pow(float32[sIdx+2] || 0, 1/2.2) * 255);
                data[dIdx+3] = 255;
            }
        }
        return new ImageData(data, w, h);
    }

    /**
     * SIP UNDISTORT WARP (PIXEL ledger — render-only, the ONE warp per LAW 1).
     * ────────────────────────────────────────────────────────────────────────
     * Applies the fitted `solution.astrometry.sip` polynomial to an interleaved
     * RGB Float32 buffer (w*h*3), producing a rectilinear (linear-WCS-consistent)
     * image. This closes the previously-open render loop: SIP was fit + stored +
     * badged but APPLIED TO NOTHING.
     *
     * CONVENTION (matches ResidualAnalyzer.performSIPFit):
     *   The fit models dx = detected.x - expX ≈ A(u,v), dy ≈ B(u,v), where
     *   u = detected.x - crpix[0], v = detected.y - crpix[1] and expX/expY are the
     *   LINEAR-WCS (ideal, undistorted) pixel positions. So the distortion pushes a
     *   star from its ideal position to observed = ideal + (A,B). To render the
     *   UNDISTORTED image we inverse-warp: for each output (ideal) pixel we SAMPLE
     *   the source (observed) buffer at observed = ideal + (A,B), bilinearly.
     *
     * SCALE (solve→buffer): SIP coefficients live in SOLVE-buffer pixel units, but
     * the preview buffer is a downscaled copy. `crpixX/crpixY` are given in THIS
     * buffer's pixel space; `coordScale` = (this-buffer px) / (solve px) so a
     * solve-space displacement A maps to `coordScale * A` buffer pixels. coordScale
     * = 1 for a native-resolution buffer.
     *
     * PROVABLE NO-OP: if `sip` is null/undefined the SAME input array reference is
     * returned untouched — no allocation, no resample. Honest-or-absent: without a
     * fitted SIP the render is exactly what it was.
     */
    public static applySipUndistort(
        float32: Float32Array,
        w: number,
        h: number,
        sip: { a: number[][]; b: number[][] } | null | undefined,
        crpixX: number,
        crpixY: number,
        coordScale: number = 1
    ): Float32Array {
        if (!sip || !sip.a || !sip.b) return float32; // provable no-op

        const s = coordScale > 0 ? coordScale : 1;

        // PERF (render lane, PIXEL ledger — 2026-07-10): the previous evaluator
        // called Math.pow(u,p) per row AND Math.pow(v,q) per term, PER PIXEL —
        // the color audit (`git show 0afe8c9`) clocked this at ~2.35 s @ 9.8 MP
        // on the CR2 preview, the worst main-thread render stall. Replace the
        // transcendental Math.pow with per-pixel power TABLES built by repeated
        // multiplication (u^p = u^(p-1)·u), so the inner sum is pure mul/add.
        //
        // NUMERICS: repeated multiplication is epsilon-equal (not bit-equal) to
        // Math.pow for integer exponents — last-ulp differences only. The render
        // output is NOT bit-gated; the COORDINATE-ledger SIP evaluators
        // (m7_astrometry/residual_analyzer, m2_hardware/lens_distortion_rematch)
        // are a SEPARATE, private, unchanged code path — LAW 1 intact. Proven
        // ≤1e-12 relative vs the Math.pow reference in sip_render_warp.test.ts.
        const degU = Math.max(sip.a.length, sip.b.length);
        let degV = 0;
        for (const row of sip.a) if (row && row.length > degV) degV = row.length;
        for (const row of sip.b) if (row && row.length > degV) degV = row.length;
        const upow = new Float64Array(Math.max(1, degU)); // u^0 … u^(degU-1)
        const vpow = new Float64Array(Math.max(1, degV)); // v^0 … v^(degV-1)
        const poly = (coeff: number[][]): number => {
            // Σ coeff[p][q] · upow[p] · vpow[q] — power tables filled per pixel.
            let acc = 0;
            for (let p = 0; p < coeff.length; p++) {
                const row = coeff[p];
                if (!row) continue;
                const up = upow[p];
                for (let q = 0; q < row.length; q++) {
                    const c = row[q];
                    if (c) acc += c * up * vpow[q];
                }
            }
            return acc;
        };

        const out = new Float32Array(w * h * 3);
        for (let yo = 0; yo < h; yo++) {
            for (let xo = 0; xo < w; xo++) {
                // Ideal (output) coords → solve-space offsets from crpix.
                const us = (xo - crpixX) / s;
                const vs = (yo - crpixY) / s;
                // Per-pixel power tables (shared by the a and b polynomials).
                upow[0] = 1;
                for (let p = 1; p < upow.length; p++) upow[p] = upow[p - 1] * us;
                vpow[0] = 1;
                for (let q = 1; q < vpow.length; q++) vpow[q] = vpow[q - 1] * vs;
                // Solve-space displacement → buffer-space displacement.
                const srcX = xo + s * poly(sip.a);
                const srcY = yo + s * poly(sip.b);

                const dIdx = (yo * w + xo) * 3;
                // Bilinear sample of the source (observed) buffer; edge-clamped.
                const x0 = Math.floor(srcX);
                const y0 = Math.floor(srcY);
                const fx = srcX - x0;
                const fy = srcY - y0;
                const cx0 = Math.min(Math.max(x0, 0), w - 1);
                const cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
                const cy0 = Math.min(Math.max(y0, 0), h - 1);
                const cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
                for (let c = 0; c < 3; c++) {
                    const p00 = float32[(cy0 * w + cx0) * 3 + c] || 0;
                    const p10 = float32[(cy0 * w + cx1) * 3 + c] || 0;
                    const p01 = float32[(cy1 * w + cx0) * 3 + c] || 0;
                    const p11 = float32[(cy1 * w + cx1) * 3 + c] || 0;
                    const top = p00 + (p10 - p00) * fx;
                    const bot = p01 + (p11 - p01) * fx;
                    out[dIdx + c] = top + (bot - top) * fy;
                }
            }
        }
        return out;
    }

    /**
     * GENERALIZED RENDER WARP (PIXEL ledger — render-only, the ONE warp per LAW 1).
     * ────────────────────────────────────────────────────────────────────────
     * Dispatches to the arbitrated distortion model (SIP | TPS | measured BC; see
     * ui/corrected_view.selectRenderWarp for the SELECTION ladder). Exactly one
     * geometric resample runs. `warp` null / unknown ⇒ provable no-op (same input
     * reference returned). Consumes ENGINE-INTERNAL convention directly — NEVER the
     * FITS-convention negation at export/sip_convention.ts (that would double-warp).
     *
     * `crpixX/crpixY` are in THIS (preview) buffer's pixel space; `coordScale` =
     * (preview px)/(solve px). Ignored for the BC model (frame-center radial).
     */
    public static applyRenderWarp(
        float32: Float32Array,
        w: number,
        h: number,
        warp: RenderWarp | null | undefined,
        crpixX: number,
        crpixY: number,
        coordScale: number = 1,
    ): Float32Array {
        if (!warp) return float32; // provable no-op
        if (warp.kind === 'sip') {
            // Delegate to the byte-identical SIP path (unchanged, gated by
            // sip_render_warp.test.ts) so the historical render stays bit-exact.
            return ImageProcessor.applySipUndistort(float32, w, h, warp.sip, crpixX, crpixY, coordScale);
        }
        if (warp.kind === 'tps') {
            return ImageProcessor.applyTpsUndistort(float32, w, h, warp, crpixX, crpixY, coordScale);
        }
        if (warp.kind === 'bc') {
            return ImageProcessor.applyBcUndistort(float32, w, h, warp, coordScale);
        }
        return float32;
    }

    /**
     * TPS UNDISTORT WARP (render-only). Mirrors {@link applySipUndistort}: for each
     * output (ideal) pixel we evaluate the fitted displacement field at the ideal
     * position (the field is smooth; SIP does the same first-order approximation)
     * and inverse-sample the source (observed) buffer at ideal + displacement,
     * bilinearly, edge-clamped. The TPS models the SAME quantity as SIP (detected −
     * linear-WCS-predicted displacement, in pixels) so the convention is identical.
     * Extrapolation beyond the control hull is bounded by the edge-clamped sampler.
     */
    private static applyTpsUndistort(
        float32: Float32Array,
        w: number,
        h: number,
        warp: Extract<RenderWarp, { kind: 'tps' }>,
        crpixX: number,
        crpixY: number,
        coordScale: number,
    ): Float32Array {
        const s = coordScale > 0 ? coordScale : 1;
        const { un, vn, weightsX, weightsY, affineX, affineY, tpsScale } = warp;
        const invScale = tpsScale > 0 ? 1 / tpsScale : 0;
        const out = new Float32Array(w * h * 3);
        for (let yo = 0; yo < h; yo++) {
            for (let xo = 0; xo < w; xo++) {
                // Ideal (output) coords → solve-space offsets from crpix → normalized.
                const un_q = ((xo - crpixX) / s) * invScale;
                const vn_q = ((yo - crpixY) / s) * invScale;
                // Field displacement in SOLVE px → buffer-space displacement (× s).
                const dx = ImageProcessor.evalTpsField(un_q, vn_q, un, vn, weightsX, affineX);
                const dy = ImageProcessor.evalTpsField(un_q, vn_q, un, vn, weightsY, affineY);
                const srcX = xo + s * dx;
                const srcY = yo + s * dy;
                ImageProcessor.bilinearSample(float32, out, w, h, xo, yo, srcX, srcY);
            }
        }
        return out;
    }

    /**
     * MEASURED BROWN-CONRADY UNDISTORT WARP (render-only). Radial k1/k2 about the
     * frame CENTER (matches m2_hardware/lens_distortion.makeBrownConradyDistortion —
     * a render-lane inline copy of the 4-line forward, like applySipUndistort's SIP
     * poly copy, to keep `core` free of the LENS_DB dependency). For each output
     * (undistorted/ideal) pixel we compute the native (observed) position and
     * inverse-sample there. crpix is unused (the model is frame-center anchored).
     */
    private static applyBcUndistort(
        float32: Float32Array,
        w: number,
        h: number,
        warp: Extract<RenderWarp, { kind: 'bc' }>,
        coordScale: number,
    ): Float32Array {
        const s = coordScale > 0 ? coordScale : 1;
        const { k1, k2, solveW, solveH } = warp;
        const cx = (solveW - 1) / 2;
        const cy = (solveH - 1) / 2;
        const hd = Math.hypot(cx, cy);
        const invHd = hd > 0 ? 1 / hd : 0;
        const out = new Float32Array(w * h * 3);
        for (let yo = 0; yo < h; yo++) {
            for (let xo = 0; xo < w; xo++) {
                // Output (undistorted/ideal) preview px → solve px.
                const xs = xo / s;
                const ys = yo / s;
                const nx = (xs - cx) * invHd;
                const ny = (ys - cy) * invHd;
                const r2 = nx * nx + ny * ny;
                const f = 1 + k1 * r2 + k2 * r2 * r2; // corrected → native radial scale
                // Native (observed) solve px → preview px (× s).
                const srcX = (cx + nx * f * hd) * s;
                const srcY = (cy + ny * f * hd) * s;
                ImageProcessor.bilinearSample(float32, out, w, h, xo, yo, srcX, srcY);
            }
        }
        return out;
    }

    /**
     * TPS forward field evaluation — f(u,v) = a0 + a1·u + a2·v + Σ w_i·U(‖p−p_i‖),
     * U(r)=r²·ln r, on NORMALIZED coords. A deliberate RENDER-LANE inline mirror of
     * the canonical evaluator `pipeline/m6_plate_solve/tps_eval.evalTpsField` (the
     * single source of truth for the COORDINATE-ledger fit + ASDF writer) — inlined
     * here for the exact reason applySipUndistort inlines the SIP poly: `core` must
     * not take a compile-edge onto the m6 solver graph for a render-plane copy. Bit
     * arithmetic is identical to the canonical form; the render output is not
     * bit-gated. Keep this in lockstep with tps_eval.ts if that formula ever changes.
     */
    private static evalTpsField(
        u: number, v: number,
        un: number[], vn: number[], w: number[], affine: [number, number, number],
    ): number {
        let s = affine[0] + affine[1] * u + affine[2] * v;
        for (let i = 0; i < un.length; i++) {
            const du = u - un[i], dv = v - vn[i];
            const r2 = du * du + dv * dv;
            if (r2 > 0) s += w[i] * (0.5 * r2 * Math.log(r2)); // r²·ln r ≡ ½ r²·ln r²
        }
        return s;
    }

    /** Bilinear, edge-clamped sample of interleaved RGB `src` at (srcX,srcY) into
     *  `out` at (xo,yo). Shared by the TPS/BC render warps (identical arithmetic to
     *  applySipUndistort's inner sampler — one implementation). */
    private static bilinearSample(
        src: Float32Array,
        out: Float32Array,
        w: number,
        h: number,
        xo: number,
        yo: number,
        srcX: number,
        srcY: number,
    ): void {
        const dIdx = (yo * w + xo) * 3;
        const x0 = Math.floor(srcX);
        const y0 = Math.floor(srcY);
        const fx = srcX - x0;
        const fy = srcY - y0;
        const cx0 = Math.min(Math.max(x0, 0), w - 1);
        const cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
        const cy0 = Math.min(Math.max(y0, 0), h - 1);
        const cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
        for (let c = 0; c < 3; c++) {
            const p00 = src[(cy0 * w + cx0) * 3 + c] || 0;
            const p10 = src[(cy0 * w + cx1) * 3 + c] || 0;
            const p01 = src[(cy1 * w + cx0) * 3 + c] || 0;
            const p11 = src[(cy1 * w + cx1) * 3 + c] || 0;
            const top = p00 + (p10 - p00) * fx;
            const bot = p01 + (p11 - p01) * fx;
            out[dIdx + c] = top + (bot - top) * fy;
        }
    }

    // ── RENDER ADMISSION GATE (render-plane; mirrors the TPS-gate philosophy: a
    //    model renders ONLY where it is valid across the frame). Thresholds are
    //    RENDER-plane admission values (NOT science-gate constants), derived from
    //    two measured frames — SeeStar M66 (admits) and the beach CR2 (refuses,
    //    owner-rejected "curves completely to the right"). Each carries its
    //    derivation; none is hand-tuned to the midpoint between the two frames.

    /** rms-in-PIXELS pathology ceiling. NOT the M66/beach discriminator (both sit
     *  at ~8–10 px: M66 8.26, beach 9.94) — a guard against a catastrophically bad
     *  global fit (>15 px per-star residual ≈ >4 FWHM of gross misfit is not a usable
     *  display model regardless of coverage). The hull + corner gates below are the
     *  beach discriminators. */
    public static readonly RENDER_ADMIT_RMS_CEIL_PX = 15.0;
    /** Match-hull frame-coverage floor. A global polynomial extrapolates unboundedly
     *  OUTSIDE the convex hull of its fit support; requiring the hull to cover a
     *  MAJORITY (≥60%) of the frame area bounds extrapolation to a minority fringe.
     *  M66 covers 93.0% (33-pt margin), beach only 21.5% (38-pt margin) — a
     *  "majority of frame" principle, not a midpoint split. */
    public static readonly RENDER_ADMIT_HULL_COVER_MIN = 0.60;
    /** Corner-vs-interior extrapolation ratio ceiling: max corner |Δ| ≤ 4× the
     *  in-hull p95 |Δ|. A smooth low-order model should not behave wildly differently
     *  at the corners than where it was measured. M66 ratio 1.8× (admits), beach 15.6×
     *  (refuses). "few×" principle, comfortably above M66. */
    public static readonly RENDER_ADMIT_CORNER_RATIO_MAX = 4.0;
    /** Absolute floor below which the corner-ratio gate does NOT bite: a near-identity
     *  warp (tiny displacement everywhere) can show a large RATIO while every corner
     *  moves only a pixel or two — that is harmless and must not be refused. Beach
     *  corners move 1512 px (far above), M66 7 px (below) so this never affects the two
     *  reference frames; it only prevents false refusals of benign small warps. */
    public static readonly RENDER_ADMIT_CORNER_ABS_FLOOR_PX = 20.0;

    /** Solve-px displacement (dx,dy) the render warp applies AT an output point
     *  (xSolve,ySolve). Same per-source math as the buffer warps above (SIP poly /
     *  TPS field / BC radial), evaluated at one point for the admission gate. crpix
     *  is in SOLVE px (ignored for the frame-center BC model). */
    public static renderWarpDisplacement(
        warp: RenderWarp, xSolve: number, ySolve: number, crpixX: number, crpixY: number,
    ): [number, number] {
        if (warp.kind === 'sip') {
            const u = xSolve - crpixX, v = ySolve - crpixY;
            return [ImageProcessor.polyAt(warp.sip.a, u, v), ImageProcessor.polyAt(warp.sip.b, u, v)];
        }
        if (warp.kind === 'tps') {
            const inv = warp.tpsScale > 0 ? 1 / warp.tpsScale : 0;
            const u = (xSolve - crpixX) * inv, v = (ySolve - crpixY) * inv;
            return [
                ImageProcessor.evalTpsField(u, v, warp.un, warp.vn, warp.weightsX, warp.affineX),
                ImageProcessor.evalTpsField(u, v, warp.un, warp.vn, warp.weightsY, warp.affineY),
            ];
        }
        // BC radial (frame-center): native − corrected.
        const cx = (warp.solveW - 1) / 2, cy = (warp.solveH - 1) / 2;
        const hd = Math.hypot(cx, cy), invHd = hd > 0 ? 1 / hd : 0;
        const nx = (xSolve - cx) * invHd, ny = (ySolve - cy) * invHd;
        const r2 = nx * nx + ny * ny, f = 1 + warp.k1 * r2 + warp.k2 * r2 * r2;
        return [(cx + nx * f * hd) - xSolve, (cy + ny * f * hd) - ySolve];
    }

    /** Single-point 2-D polynomial Σ coeff[p][q]·u^p·v^q (render-lane poly eval). */
    private static polyAt(coeff: number[][], u: number, v: number): number {
        let acc = 0;
        for (let p = 0; p < coeff.length; p++) {
            const row = coeff[p]; if (!row) continue;
            let up = 1; for (let k = 0; k < p; k++) up *= u;
            for (let q = 0; q < row.length; q++) { const c = row[q]; if (!c) continue; let vq = 1; for (let k = 0; k < q; k++) vq *= v; acc += c * up * vq; }
        }
        return acc;
    }

    /** Convex-hull area (Andrew monotone chain) of pixel points; 0 if < 3 points. */
    private static convexHullArea(pts: [number, number][]): number {
        if (pts.length < 3) return 0;
        const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
            (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo: [number, number][] = [];
        for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
        const hi: [number, number][] = [];
        for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
        const h = lo.slice(0, -1).concat(hi.slice(0, -1));
        let a = 0;
        for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
        return Math.abs(a) / 2;
    }

    /**
     * RENDER ADMISSION GATE — decide whether the selected warp is valid to apply
     * ACROSS the whole frame, or whether it would extrapolate into garbage outside
     * its fit support (the beach failure). Refused ⇒ the render shows the ORIGINAL.
     * All geometry in SOLVE px. Pure. Returns the verdict + the measured metrics
     * (user-visible, never silent). `matchedXY` = the fit's support points (detected
     * star positions); `fitRmsPx` = the model's per-star residual in pixels.
     */
    public static admitRenderWarp(
        warp: RenderWarp,
        matchedXY: { x: number; y: number }[],
        crpixX: number,
        crpixY: number,
        solveW: number,
        solveH: number,
        fitRmsPx: number,
    ): RenderAdmission {
        const nul = { hull_coverage: 0, corner_ratio: 0, max_corner_px: 0, in_hull_p95_px: 0, rms_px: fitRmsPx };
        if (matchedXY.length < 4 || !(solveW > 0) || !(solveH > 0)) {
            return { admitted: false, reason: 'NO_SUPPORT', metrics: nul };
        }
        // Hull coverage of the fit support over the frame.
        const hullPts = matchedXY.map(m => [m.x, m.y] as [number, number]);
        const hull_coverage = ImageProcessor.convexHullArea(hullPts) / (solveW * solveH);
        // In-hull displacement magnitudes (at the support points) → p95.
        const inHull = matchedXY
            .map(m => { const [dx, dy] = ImageProcessor.renderWarpDisplacement(warp, m.x, m.y, crpixX, crpixY); return Math.hypot(dx, dy); })
            .sort((a, b) => a - b);
        const in_hull_p95_px = inHull[Math.min(inHull.length - 1, Math.floor(inHull.length * 0.95))];
        // Corner displacements (the visible bend).
        const corners: [number, number][] = [[0, 0], [solveW - 1, 0], [0, solveH - 1], [solveW - 1, solveH - 1]];
        const max_corner_px = Math.max(...corners.map(([x, y]) => { const [dx, dy] = ImageProcessor.renderWarpDisplacement(warp, x, y, crpixX, crpixY); return Math.hypot(dx, dy); }));
        const corner_ratio = max_corner_px / Math.max(in_hull_p95_px, 1e-6);
        const metrics = { hull_coverage, corner_ratio, max_corner_px, in_hull_p95_px, rms_px: fitRmsPx };

        if (fitRmsPx > ImageProcessor.RENDER_ADMIT_RMS_CEIL_PX) return { admitted: false, reason: 'RMS_CEILING', metrics };
        if (hull_coverage < ImageProcessor.RENDER_ADMIT_HULL_COVER_MIN) return { admitted: false, reason: 'HULL_COVERAGE', metrics };
        if (corner_ratio > ImageProcessor.RENDER_ADMIT_CORNER_RATIO_MAX && max_corner_px > ImageProcessor.RENDER_ADMIT_CORNER_ABS_FLOOR_PX) {
            return { admitted: false, reason: 'CORNER_EXTRAPOLATION', metrics };
        }
        return { admitted: true, reason: 'ADMITTED', metrics };
    }

    /**
     * Creates a standard data URL from ImageData.
     */
    public static createPreviewUrl(data: ImageData): string {
        const canvas = document.createElement('canvas');
        canvas.width = data.width;
        canvas.height = data.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.putImageData(data, 0, 0);
            return canvas.toDataURL('image/jpeg', 0.8);
        }
        return '';
    }
}

