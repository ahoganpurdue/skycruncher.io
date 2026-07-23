/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NEBULOSITY LIFT — pre-detection diffuse-background subtraction (tools lane)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (reshapes DETECTION-INPUT pixels only; never WCS/photometry).
 * LAW 4 incubator: a tools-lane prototype that plugs into the engine through the
 * `PreDetectTransform` seam (orchestrator_session.ts) — the engine imports NOTHING
 * from here; this hands a hook across.
 *
 * PROBLEM (contrib X-T5 wide RAF): a bright diffuse band (Milky Way) elevates the
 * local background so blob detection FLOODS on scene structure (~1.55M candidates)
 * and the top-30 flux ranking (SOLVER_MAX_DET_STARS) fills with band-blobs, so
 * real stars never reach the solver. Model the smooth diffuse background and
 * subtract it BEFORE detection so real stars sit above a flat floor.
 *
 * MODEL — ONE BACKGROUND BASIS (deg-2 by default):
 *   • poly2       : global degree-2 surface (6 coeffs) fit to robust per-tile
 *                   background estimates. The PROVEN choice (tools/psf/flatness
 *                   lineage); deg-3 once "ate the galactic band" (too flexible —
 *                   subtracted the band's real structure), so we stay at deg-2.
 *   • median_mesh : coarse robust tile grid, bilinear-interpolated — follows a
 *                   curved band ridge a global quadratic cannot. Use only if
 *                   eyes-on shows deg-2 leaves the band flooding detection.
 *   NEVER stack both against the SAME frame: the engine starlet's sky_gradient
 *   layer IS a deg-2 surface (nebulosity_layer.ts), so composing two deg-2
 *   subtractions double-subtracts the background (the deg-3 failure, inverted).
 *
 * Per-channel: the background is modeled on LUMINANCE, then subtracted from each
 * RGB channel scaled by (channel_median / luma_median) — a colour-neutral diffuse
 * lift that keeps the channels self-consistent. Clamp at 0; the u16 value range is
 * preserved (only a smooth offset is removed, nothing is rescaled).
 *
 * FUTURE (engine wiring, not tonight): the engine ALREADY fits a deg-2 low-pass
 * surface every frame (signal_processor.ts bgModeler.fitSurface) but its evaluate()
 * is dead code — the eventual engine-side lift reuses that fit for free; this
 * tools-side fit stands alone until then.
 */

import type { PreDetectTransform } from '@/engine/pipeline/orchestrator_session';

// ─────────────────────────────────────────────────────────────────────────────
// Robust statistics
// ─────────────────────────────────────────────────────────────────────────────

/** In-place-safe percentile of a numeric sample (0..1). Copies + sorts. */
export function percentile(sample: number[] | Float32Array, q: number): number {
    if (sample.length === 0) return 0;
    const a = Array.prototype.slice.call(sample).sort((x: number, y: number) => x - y);
    const idx = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
    return a[idx];
}

/** Median of a subsample of an interleaved channel (stride = channels). */
function channelMedianSampled(rgb: Float32Array, channels: number, ch: number, maxSamples: number): number {
    const nPx = Math.floor(rgb.length / channels);
    const step = Math.max(1, Math.floor(nPx / maxSamples));
    const s: number[] = [];
    for (let i = ch; i < rgb.length; i += channels * step) s.push(rgb[i]);
    return percentile(s, 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Background models — evaluated in NORMALIZED coords xn,yn ∈ [-1, 1]
// ─────────────────────────────────────────────────────────────────────────────

export interface Poly2Model {
    kind: 'poly2';
    /** [c0, cx, cy, cxy, cxx, cyy] over basis [1, xn, yn, xn·yn, xn², yn²]. */
    coeffs: number[];
}

export interface MeshModel {
    kind: 'median_mesh';
    cols: number;
    rows: number;
    /** rows*cols robust tile background estimates, row-major. */
    grid: number[];
}

export type BackgroundModel = Poly2Model | MeshModel;

export interface FitOptions {
    /** 'poly2' (default) or 'median_mesh'. */
    model?: 'poly2' | 'median_mesh';
    /** Tiles across / down for the robust background sampling. */
    tilesX?: number;
    tilesY?: number;
    /** Robust per-tile percentile (0..1) — the diffuse sky level (default 0.5 median). */
    tilePercentile?: number;
    /** Max luma samples per tile for the percentile (subsampled for speed). */
    maxSamplesPerTile?: number;
}

const FIT_DEFAULTS = {
    model: 'poly2' as const,
    tilesX: 48,
    tilesY: 32,
    tilePercentile: 0.5,
    maxSamplesPerTile: 400,
};

/** Per-tile robust background estimate + its normalized-space center. */
interface TileEstimate { xn: number; yn: number; bg: number; }

function sampleTiles(luma: Float32Array, w: number, h: number, o: Required<FitOptions>): TileEstimate[] {
    const est: TileEstimate[] = [];
    const tw = w / o.tilesX;
    const th = h / o.tilesY;
    for (let ty = 0; ty < o.tilesY; ty++) {
        const y0 = Math.floor(ty * th), y1 = Math.min(h, Math.floor((ty + 1) * th));
        for (let tx = 0; tx < o.tilesX; tx++) {
            const x0 = Math.floor(tx * tw), x1 = Math.min(w, Math.floor((tx + 1) * tw));
            const tilePx = (x1 - x0) * (y1 - y0);
            if (tilePx <= 0) continue;
            const stride = Math.max(1, Math.floor(Math.sqrt(tilePx / o.maxSamplesPerTile)));
            const s: number[] = [];
            for (let y = y0; y < y1; y += stride) {
                const row = y * w;
                for (let x = x0; x < x1; x += stride) s.push(luma[row + x]);
            }
            const bg = percentile(s, o.tilePercentile);
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            est.push({ xn: (2 * cx) / w - 1, yn: (2 * cy) / h - 1, bg });
        }
    }
    return est;
}

/** Solve a small symmetric linear system A c = b via Gaussian elimination. */
function solveLinear(A: number[][], b: number[]): number[] {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-12) continue; // singular column — leave coeff 0
        [M[col], M[piv]] = [M[piv], M[col]];
        const d = M[col][col];
        for (let k = col; k <= n; k++) M[col][k] /= d;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
        }
    }
    return M.map((row) => row[n]);
}

/** Degree-2 basis for normalized coords: [1, xn, yn, xn·yn, xn², yn²]. */
function basis2(xn: number, yn: number): number[] {
    return [1, xn, yn, xn * yn, xn * xn, yn * yn];
}

export function evalModel(m: BackgroundModel, xn: number, yn: number): number {
    if (m.kind === 'poly2') {
        const b = basis2(xn, yn);
        let v = 0;
        for (let i = 0; i < 6; i++) v += m.coeffs[i] * b[i];
        return v;
    }
    // median_mesh: bilinear over the tile-center grid (clamped edges)
    const fx = ((xn + 1) / 2) * (m.cols - 1);
    const fy = ((yn + 1) / 2) * (m.rows - 1);
    const x0 = Math.max(0, Math.min(m.cols - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(m.rows - 1, Math.floor(fy)));
    const x1 = Math.min(m.cols - 1, x0 + 1), y1 = Math.min(m.rows - 1, y0 + 1);
    const dx = fx - x0, dy = fy - y0;
    const g = (r: number, c: number) => m.grid[r * m.cols + c];
    const top = g(y0, x0) * (1 - dx) + g(y0, x1) * dx;
    const bot = g(y1, x0) * (1 - dx) + g(y1, x1) * dx;
    return top * (1 - dy) + bot * dy;
}

/** Fit the chosen background model to the luminance buffer. */
export function fitBackground(luma: Float32Array, w: number, h: number, opts: FitOptions = {}): BackgroundModel {
    const o: Required<FitOptions> = { ...FIT_DEFAULTS, ...opts };
    const tiles = sampleTiles(luma, w, h, o);
    if (o.model === 'median_mesh') {
        return { kind: 'median_mesh', cols: o.tilesX, rows: o.tilesY, grid: tiles.map((t) => t.bg) };
    }
    // poly2 normal equations: (BᵀB) c = Bᵀ bg over the tile estimates.
    const ATA: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const ATb: number[] = new Array(6).fill(0);
    for (const t of tiles) {
        const bs = basis2(t.xn, t.yn);
        for (let i = 0; i < 6; i++) {
            ATb[i] += bs[i] * t.bg;
            for (let j = 0; j < 6; j++) ATA[i][j] += bs[i] * bs[j];
        }
    }
    return { kind: 'poly2', coeffs: solveLinear(ATA, ATb) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subtraction (clamp ≥ 0, u16 range preserved)
// ─────────────────────────────────────────────────────────────────────────────

/** Lift a single-channel luminance buffer: out = max(0, luma − background). */
export function liftLuma(luma: Float32Array, w: number, h: number, m: BackgroundModel): Float32Array {
    const out = new Float32Array(luma.length);
    for (let y = 0; y < h; y++) {
        const yn = (2 * y) / h - 1;
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const xn = (2 * x) / w - 1;
            const v = luma[row + x] - evalModel(m, xn, yn);
            out[row + x] = v > 0 ? v : 0;
        }
    }
    return out;
}

/**
 * Lift an interleaved RGB buffer per-channel: for each channel c,
 * out_c = max(0, in_c − background · (median_c / median_luma)). The luma-modeled
 * background is scaled into each channel by its own median so the diffuse lift is
 * colour-neutral. Works at ANY resolution (model is in normalized coords), so the
 * downsampled preview reuses the full-res fit.
 */
export function liftRgbInterleaved(
    rgb: Float32Array,
    w: number,
    h: number,
    m: BackgroundModel,
    channelScales: number[],
    channels = 3,
): Float32Array {
    const out = new Float32Array(rgb.length);
    for (let y = 0; y < h; y++) {
        const yn = (2 * y) / h - 1;
        for (let x = 0; x < w; x++) {
            const xn = (2 * x) / w - 1;
            const bg = evalModel(m, xn, yn);
            const base = (y * w + x) * channels;
            for (let c = 0; c < channels; c++) {
                const v = rgb[base + c] - bg * channelScales[c];
                out[base + c] = v > 0 ? v : 0;
            }
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PreDetectTransform hook
// ─────────────────────────────────────────────────────────────────────────────

export interface NebulosityLiftOptions extends FitOptions {
    /** Also lift the preview RGB (masking input). Default true. */
    liftPreview?: boolean;
}

/**
 * Build a `PreDetectTransform` that fits the diffuse background on the frame's
 * luminance and subtracts it from the DETECTION buffers (science luma + preview
 * RGB). Returns a `nebulosity_lift` marker so the receipt stamps the run
 * experimental (config_overrides.nebulosity_lift = {model, params}).
 */
export function makeNebulosityLiftTransform(opts: NebulosityLiftOptions = {}): PreDetectTransform {
    const liftPreview = opts.liftPreview !== false;
    return (frame) => {
        const { scienceBuffer, previewFloat32, fullRGB, width, height, previewWidth, previewHeight } = frame;

        const model = fitBackground(scienceBuffer, width, height, opts);

        // Channel scales from the FULL-RES RGB (the science pixels), relative to the
        // luma median — so the per-channel subtraction matches the luma-fit magnitude.
        const lumaMedian = percentile(subsample(scienceBuffer, 40000), 0.5) || 1;
        const channelScales = [0, 1, 2].map((c) => channelMedianSampled(fullRGB, 3, c, 40000) / lumaMedian);

        const liftedScience = liftLuma(scienceBuffer, width, height, model);

        let liftedPreview: Float32Array | undefined;
        if (liftPreview && previewFloat32 && previewFloat32.length === previewWidth * previewHeight * 3) {
            liftedPreview = liftRgbInterleaved(previewFloat32, previewWidth, previewHeight, model, channelScales, 3);
        }

        // Peak subtracted magnitude (diagnostic) — max background over the corners+center.
        const probes: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]];
        const bgProbe = probes.map(([xn, yn]) => evalModel(model, xn, yn));

        const descriptor: Record<string, unknown> = {
            model: model.kind,
            tilesX: opts.tilesX ?? FIT_DEFAULTS.tilesX,
            tilesY: opts.tilesY ?? FIT_DEFAULTS.tilesY,
            tile_percentile: opts.tilePercentile ?? FIT_DEFAULTS.tilePercentile,
            luma_median: lumaMedian,
            channel_scales: channelScales,
            background_probe_corners_center: bgProbe,
            ...(model.kind === 'poly2' ? { coeffs: model.coeffs } : { mesh_cols: model.cols, mesh_rows: model.rows }),
        };

        return {
            scienceBuffer: liftedScience,
            previewFloat32: liftedPreview,
            marker: { name: 'nebulosity_lift', descriptor },
        };
    };
}

/** Even subsample of a Float32Array down to at most n elements (for medians). */
function subsample(a: Float32Array, n: number): Float32Array {
    if (a.length <= n) return a;
    const step = Math.floor(a.length / n);
    const out = new Float32Array(Math.ceil(a.length / step));
    for (let i = 0, j = 0; i < a.length; i += step, j++) out[j] = a[i];
    return out;
}
