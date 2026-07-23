/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M11 STACK — dither/drizzle kernel (variable-pixel linear reconstruction)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Science resampling as a MEASURED product (three-layer
 * convention: this is pixel-ledger work with its own evidence gates, never
 * render-plane). The kernel CONSUMES per-frame fitted WCS as coordinate
 * FUNCTIONS through SkyTransform — it never fits, refines or mutates any WCS
 * (COORDINATE ledger untouched). Exactly ONE resample per input frame: the
 * forward drizzle deposit.
 *
 * PORTED from the proven incubator `tools/stack/stack.mjs` (LAW 4):
 *   • drizzleChannel — Fruchter & Hook "turbo" kernel (axis-aligned square
 *     footprint, the STScI fast path): each input pixel is shrunk by
 *     `pixfrac`, forward-mapped through frameWCS→sky→output tangent grid, and
 *     its flux deposited over the overlapped output cells weighted by exact
 *     overlap area × the frame's inverse-variance weight.
 *   • buildNodes/nodeInterp — the mapping node lattice: exact trig on a 32 px
 *     lattice + bilinear interpolation is sub-0.01 px over degree-scale
 *     tangent-to-tangent composites while cutting trig calls ~3 orders.
 *   • output grid convention — tangent plane at the frame-centroid, cd =
 *     [-s, 0, 0, s] (north up, east left), x = crpix0 − ξ/s, y = crpix1 + η/s.
 *
 * DITHER measurement: per-frame sub-pixel registration offsets come FREE from
 * the per-frame fitted WCS (each solve independently registered the frame
 * against the catalog) — v1 uses NO separate registration estimator. The
 * offsets reported are MEASURED values derived from those fitted WCS, not
 * assumptions. (The incubator's cross-frame re-fit against reference-frame
 * star positions — which cancels the shared-catalog error term — is a known
 * v2 refinement, carried in the receipt limitations.)
 *
 * KNOWN v1 LIMITATIONS (carried honestly on every stack receipt):
 *   • PSF mixing — frames combine by inverse-variance weight only; per-frame
 *     PSF widths blend in the output (no PSF-aware weighting). Known v2 item,
 *     carried verbatim from tools/stack.
 *   • Photometric normalization — per-frame median background is subtracted;
 *     flux ratios are 1 (same-rig/same-exposure sub assumption). Cross-rig
 *     star-photometry normalization (the incubator's aperture-ratio pass) is
 *     v2.
 *
 * Citation for the algorithm + parameter names: Fruchter, A.S. & Hook, R.N.
 * 2002, PASP 114, 144 ("Drizzle: A Method for the Linear Reconstruction of
 * Undersampled Images"). `pixfrac` = linear input-pixel shrink factor (0,1];
 * `scaleFactor` = input scale / output scale (output grid is scaleFactor×
 * finer than the reference frame).
 */

import { SkyTransform } from '../../core/SkyTransform';
import type { WCSTransform } from '../../types/Main_types';

// ─── types ────────────────────────────────────────────────────────────────────

/** One solved input frame. `wcs` is the ENGINE-convention fitted WCS:
 *  crval[0] in HOURS, cd in deg/px, crpix 0-based pixel centers, y-down. */
export interface StackFrameInput {
    /** Stable frame identifier (batch frame id / file stem). */
    id: string;
    /** Content identity of the stacked plane (sha256 hex) or null (recorded honestly). */
    frameSha: string | null;
    wcs: WCSTransform;
    width: number;
    height: number;
    /** Luminance science plane, length width*height (native grid — LAW 1). */
    getPlane: () => Float32Array | Promise<Float32Array>;
    /** ISO capture timestamp (correlated-input screening) or null. */
    timestamp: string | null;
    exposureS: number | null;
}

/** Explicit drizzle parameters — no hidden defaults inside the kernel. */
export interface DrizzleParams {
    /** Output grid refinement: outputScale = referenceScale / scaleFactor. */
    scaleFactor: number;
    /** Linear input-pixel shrink factor, (0, 1]. */
    pixfrac: number;
}

/** Documented default parameters (Fruchter & Hook 2002 common practice for
 *  well-dithered stacks; the receipt always records the ACTUAL values used). */
export const DEFAULT_DRIZZLE_PARAMS: DrizzleParams = Object.freeze({ scaleFactor: 2, pixfrac: 0.8 });

/** Constructed output tangent grid (NOT a fitted WCS — SOURCE:'GRID'). */
export interface OutputGrid {
    /** Tangent point: [RA hours, Dec degrees] (engine convention). */
    crval: [number, number];
    /** 0-based pixel-center reference pixel. */
    crpix: [number, number];
    /** Output pixel size in degrees (cd = [-sdeg, 0, 0, sdeg]). */
    sdeg: number;
    width: number;
    height: number;
    scaleArcsec: number;
}

export interface FrameDeposit {
    id: string;
    /** Per-frame median background (subtracted before deposit) — MEASURED. */
    background: number;
    /** Robust (MAD) per-pixel sigma — MEASURED. */
    sigma: number;
    /** Inverse-variance combine weight 1/sigma² (0 ⇒ frame contributed nothing). */
    weight: number;
    /** Input pixels that deposited into the grid. */
    depositedPx: number;
}

export interface DrizzleResult {
    /** Combined plane (acc/wgt); NaN where no frame deposited (footprint mask). */
    plane: Float32Array;
    /** Fruchter-Hook weight map (sum of deposited area×weight per cell). */
    weightMap: Float32Array;
    /** Contributor count per cell (how many frames deposited there). */
    coverage: Uint8Array;
    perFrame: FrameDeposit[];
}

/** Measured dither offset of a frame relative to the reference frame. */
export interface DitherOffset {
    id: string;
    /** Frame-center displacement in REFERENCE-frame pixels (dx, dy). */
    dxPx: number;
    dyPx: number;
    /** Angular displacement of the frame center on the sky, arcsec. */
    arcsec: number;
}

// ─── constants (ported from the incubator, unchanged) ──────────────────────────

/** Mapping node lattice pitch (px) — see tools/stack/stack.mjs buildNodes. */
const NODE_STEP = 32;
/** Output-grid guard: refuse absurd grids instead of OOM-ing the process. */
const MAX_GRID_PIXELS = 220e6;

// ─── coordinate helpers (all trig through SkyTransform — COORDINATE ledger) ────

/** Pixel scale (arcsec/px) of an engine WCS from |det CD|. */
export function pixelScaleArcsec(wcs: WCSTransform): number {
    const cd = wcs.cd;
    return Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) * 3600;
}

/** Sky position (RA hours, Dec deg) of a frame's central pixel. */
function frameCenterSky(f: StackFrameInput): { ra_hours: number; dec_degrees: number } {
    return SkyTransform.pixelToSky((f.width - 1) / 2, (f.height - 1) / 2, f.wcs);
}

/** sky → pixel through an engine WCS (gnomonic about the WCS tangent, then the
 *  inverse CD). The forward trig is SkyTransform's; only the 2×2 inversion is
 *  local (SkyTransform exposes no inverse-projection helper). */
function skyToFramePix(wcs: WCSTransform, raH: number, decD: number): { x: number; y: number } {
    const g = SkyTransform.gnomonicProject(raH, decD, wcs.crval[0], wcs.crval[1]);
    if (!Number.isFinite(g.xi)) return { x: NaN, y: NaN };
    const [[a, b], [c, d]] = wcs.cd;
    const det = a * d - b * c;
    return {
        x: wcs.crpix[0] + (d * g.xi - b * g.eta) / det,
        y: wcs.crpix[1] + (-c * g.xi + a * g.eta) / det,
    };
}

/** grid pixel → sky (grid convention: cd = [-s, 0, 0, s]). */
export function gridPixToSky(grid: OutputGrid, x: number, y: number): { ra_hours: number; dec_degrees: number } {
    const xi = -(x - grid.crpix[0]) * grid.sdeg;
    const eta = (y - grid.crpix[1]) * grid.sdeg;
    return SkyTransform.inverseGnomonic(xi, eta, grid.crval[0], grid.crval[1]);
}

/** sky → grid pixel. */
export function skyToGridPix(grid: OutputGrid, raH: number, decD: number): { x: number; y: number } {
    const g = SkyTransform.gnomonicProject(raH, decD, grid.crval[0], grid.crval[1]);
    return { x: grid.crpix[0] - g.xi / grid.sdeg, y: grid.crpix[1] + g.eta / grid.sdeg };
}

// ─── reference / offsets / grid ─────────────────────────────────────────────────

/** Reference frame: finest pixel scale (within 2%), tie-break input order
 *  (deterministic). Ported rule from the incubator's reference choice. */
export function pickReference(frames: StackFrameInput[]): StackFrameInput {
    const finest = Math.min(...frames.map((f) => pixelScaleArcsec(f.wcs)));
    return frames.find((f) => pixelScaleArcsec(f.wcs) <= finest * 1.02) ?? frames[0];
}

/**
 * MEASURED per-frame dither offsets, derived purely from the fitted WCS:
 * where frame f's central pixel lands in REFERENCE pixel space, minus the
 * reference frame's own central pixel. Sub-pixel registration for free —
 * no separate estimator (v1 by design).
 */
export function measureDitherOffsets(frames: StackFrameInput[], ref: StackFrameInput): DitherOffset[] {
    const refCenter = { x: (ref.width - 1) / 2, y: (ref.height - 1) / 2 };
    const refSky = frameCenterSky(ref);
    return frames.map((f) => {
        const sky = frameCenterSky(f);
        const p = skyToFramePix(ref.wcs, sky.ra_hours, sky.dec_degrees);
        const sepDeg = SkyTransform.calculateAngularSeparation(
            sky.ra_hours, sky.dec_degrees, refSky.ra_hours, refSky.dec_degrees);
        return {
            id: f.id,
            dxPx: p.x - refCenter.x,
            dyPx: p.y - refCenter.y,
            arcsec: sepDeg * 3600,
        };
    });
}

/**
 * Output tangent grid covering every frame footprint. Tangent point = unit-
 * vector mean of the frame centers (RA hours → radians ×15, documented — the
 * repo-wide HOURS-internally convention). Output scale = reference scale /
 * scaleFactor. Throws above MAX_GRID_PIXELS rather than OOM.
 */
export function computeOutputGrid(
    frames: StackFrameInput[],
    ref: StackFrameInput,
    params: DrizzleParams
): OutputGrid {
    // mean sky direction of the frame centers
    let vx = 0, vy = 0, vz = 0;
    for (const f of frames) {
        const c = frameCenterSky(f);
        const a = c.ra_hours * 15 * Math.PI / 180; // HOURS → radians (×15 → deg)
        const d = c.dec_degrees * Math.PI / 180;
        vx += Math.cos(d) * Math.cos(a);
        vy += Math.cos(d) * Math.sin(a);
        vz += Math.sin(d);
    }
    const r = Math.hypot(vx, vy, vz);
    const crval: [number, number] = [
        ((Math.atan2(vy, vx) * 180 / Math.PI / 15) % 24 + 24) % 24,
        Math.asin(vz / r) * 180 / Math.PI,
    ];

    const outScale = pixelScaleArcsec(ref.wcs) / params.scaleFactor;
    const sdeg = outScale / 3600;

    // project every frame's border onto the tangent plane
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    const STEPS = 8;
    for (const f of frames) {
        const pts: Array<[number, number]> = [];
        for (let i = 0; i <= STEPS; i++) {
            const tx = (f.width - 1) * i / STEPS;
            const ty = (f.height - 1) * i / STEPS;
            pts.push([f.width - 1, ty], [0, ty], [tx, 0], [tx, f.height - 1]);
        }
        for (const [px, py] of pts) {
            const sky = SkyTransform.pixelToSky(px, py, f.wcs);
            const g = SkyTransform.gnomonicProject(sky.ra_hours, sky.dec_degrees, crval[0], crval[1]);
            const xr = -g.xi / sdeg, yr = g.eta / sdeg;
            if (xr < xMin) xMin = xr; if (xr > xMax) xMax = xr;
            if (yr < yMin) yMin = yr; if (yr > yMax) yMax = yr;
        }
    }
    const PAD = 4;
    const width = Math.ceil(xMax - xMin) + 2 * PAD + 1;
    const height = Math.ceil(yMax - yMin) + 2 * PAD + 1;
    if (width * height > MAX_GRID_PIXELS) {
        throw new Error(
            `[m11_stack] output grid ${width}x${height} exceeds the ${MAX_GRID_PIXELS / 1e6} MP guard — ` +
            `use a smaller scaleFactor.`
        );
    }
    return { crval, crpix: [PAD - xMin, PAD - yMin], sdeg, width, height, scaleArcsec: outScale };
}

// ─── robust plane statistics (ported planeStats, minus the photometry max) ─────

/** Sampled robust {median, MAD-sigma} over finite samples. */
export function robustPlaneStats(plane: Float32Array, stride = 499): { median: number; sigma: number } {
    const s: number[] = [];
    for (let i = 0; i < plane.length; i += stride) {
        const v = plane[i];
        if (Number.isFinite(v)) s.push(v);
    }
    s.sort((a, b) => a - b);
    const median = s[s.length >> 1] ?? NaN;
    const dev = s.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    return { median, sigma: 1.4826 * (dev[dev.length >> 1] ?? NaN) };
}

// ─── mapping node lattice (ported buildNodes/nodeInterp, unchanged math) ───────

interface NodeLattice {
    nx: number; ny: number;
    fx: Float64Array; fy: Float64Array;
    x0: number; y0: number;
}

function buildNodes(
    mapFn: (x: number, y: number) => { x: number; y: number },
    x0: number, y0: number, wpx: number, hpx: number
): NodeLattice {
    const nx = Math.floor(wpx / NODE_STEP) + 2;
    const ny = Math.floor(hpx / NODE_STEP) + 2;
    const fx = new Float64Array(nx * ny), fy = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const p = mapFn(x0 + i * NODE_STEP, y0 + j * NODE_STEP);
            fx[j * nx + i] = p.x;
            fy[j * nx + i] = p.y;
        }
    }
    return { nx, ny, fx, fy, x0, y0 };
}

function nodeInterp(n: NodeLattice, x: number, y: number, out: { x: number; y: number }): void {
    const u = (x - n.x0) / NODE_STEP, v = (y - n.y0) / NODE_STEP;
    const i = Math.min(n.nx - 2, Math.max(0, Math.floor(u)));
    const j = Math.min(n.ny - 2, Math.max(0, Math.floor(v)));
    const du = u - i, dv = v - j;
    const o = j * n.nx + i;
    const w00 = (1 - du) * (1 - dv), w10 = du * (1 - dv), w01 = (1 - du) * dv, w11 = du * dv;
    out.x = n.fx[o] * w00 + n.fx[o + 1] * w10 + n.fx[o + n.nx] * w01 + n.fx[o + n.nx + 1] * w11;
    out.y = n.fy[o] * w00 + n.fy[o + 1] * w10 + n.fy[o + n.nx] * w01 + n.fy[o + n.nx + 1] * w11;
}

// ─── the drizzle kernel ─────────────────────────────────────────────────────────

/**
 * Forward-drizzle every frame onto the output grid (Fruchter-Hook turbo
 * kernel). Sequential and allocation-deterministic: identical inputs produce
 * bit-identical outputs (no wall clock, no randomness, no parallel races).
 *
 * Per frame: robust background is subtracted (MEASURED, recorded), the
 * frame's inverse-variance weight 1/σ² scales every deposit, each input
 * pixel's footprint is shrunk by `pixfrac` and its flux spread over the
 * overlapped output cells by exact overlap area. Output = acc/wgt; cells no
 * frame touched are NaN (honest footprint mask, the export NaN convention).
 */
export async function drizzleFrames(
    frames: StackFrameInput[],
    grid: OutputGrid,
    params: DrizzleParams
): Promise<DrizzleResult> {
    const gridW = grid.width, gridH = grid.height, gridN = gridW * gridH;
    const acc = new Float64Array(gridN);
    const wgt = new Float64Array(gridN);
    const coverage = new Uint8Array(gridN);
    const seen = new Uint8Array(gridN);
    const perFrame: FrameDeposit[] = [];

    for (const f of frames) {
        const plane = await f.getPlane();
        if (plane.length !== f.width * f.height) {
            throw new Error(
                `[m11_stack] frame ${f.id}: plane length ${plane.length} != ${f.width}x${f.height}`
            );
        }
        const stats = robustPlaneStats(plane);
        const weight = Number.isFinite(stats.sigma) && stats.sigma > 0 ? 1 / (stats.sigma * stats.sigma) : 0;
        const deposit: FrameDeposit = {
            id: f.id, background: stats.median, sigma: stats.sigma, weight, depositedPx: 0,
        };
        perFrame.push(deposit);
        if (weight <= 0) continue; // honest: recorded with weight 0, contributes nothing

        seen.fill(0);
        // forward mapping lattice over the INPUT frame: frame px → sky → grid px
        const nodes = buildNodes((px, py) => {
            const sky = SkyTransform.pixelToSky(px, py, f.wcs);
            return skyToGridPix(grid, sky.ra_hours, sky.dec_degrees);
        }, 0, 0, f.width, f.height);

        const inScale = pixelScaleArcsec(f.wcs);
        const side = params.pixfrac * inScale / grid.scaleArcsec; // shrunken footprint, output px
        const half = side / 2, area = side * side;
        const bg = stats.median;
        const p = { x: 0, y: 0 };

        for (let y = 0; y < f.height; y++) {
            for (let x = 0; x < f.width; x++) {
                const v = plane[y * f.width + x];
                if (!Number.isFinite(v)) continue;
                nodeInterp(nodes, x, y, p);
                const x0 = p.x - half, x1 = p.x + half, y0 = p.y - half, y1 = p.y + half;
                if (x1 < -0.5 || y1 < -0.5 || x0 > gridW - 0.5 || y0 > gridH - 0.5) continue;
                const vn = v - bg; // ratio = 1 (v1 photometric normalization — see header)
                const cxA = Math.max(0, Math.round(x0)), cxB = Math.min(gridW - 1, Math.round(x1));
                const cyA = Math.max(0, Math.round(y0)), cyB = Math.min(gridH - 1, Math.round(y1));
                let deposited = false;
                for (let cy = cyA; cy <= cyB; cy++) {
                    const oy0 = Math.max(y0, cy - 0.5), oy1 = Math.min(y1, cy + 0.5);
                    if (oy1 <= oy0) continue;
                    for (let cx = cxA; cx <= cxB; cx++) {
                        const ox0 = Math.max(x0, cx - 0.5), ox1 = Math.min(x1, cx + 0.5);
                        if (ox1 <= ox0) continue;
                        const a = (ox1 - ox0) * (oy1 - oy0) / area * weight;
                        const o = cy * gridW + cx;
                        acc[o] += vn * a;
                        wgt[o] += a;
                        seen[o] = 1;
                        deposited = true;
                    }
                }
                if (deposited) deposit.depositedPx++;
            }
        }
        for (let i = 0; i < gridN; i++) if (seen[i] && coverage[i] < 255) coverage[i]++;
    }

    // Honest refusal: if NO frame carried a positive inverse-variance weight
    // (e.g. constant/degenerate planes → MAD sigma 0), an "empty stack" must
    // never be returned as a product (LAW 3 — no fabricated output).
    if (!perFrame.some((d) => d.weight > 0)) {
        throw new Error(
            '[m11_stack] every frame measured zero inverse-variance weight (degenerate/constant planes) — refusing to emit an empty stack.'
        );
    }

    let wMax = 0;
    for (let i = 0; i < gridN; i++) if (wgt[i] > wMax) wMax = wgt[i];
    const wEps = wMax * 1e-6;
    const plane = new Float32Array(gridN);
    const weightMap = new Float32Array(gridN);
    for (let i = 0; i < gridN; i++) {
        plane[i] = wgt[i] > wEps ? acc[i] / wgt[i] : NaN; // NaN = out-of-footprint (honest mask)
        weightMap[i] = wgt[i];
    }
    return { plane, weightMap, coverage, perFrame };
}

// ─── measurement helper (same measure for sub AND stack — apples-to-apples) ────

/**
 * Local moment-FWHM at a claimed star position: window background from the
 * border ring median, flux-weighted centroid, second moments → FWHM =
 * 2.3548·sqrt((mxx+myy)/2). PIXEL-ledger measurement on the plane's OWN grid
 * (LAW 1: never resample before measurement). Returns null when the window
 * leaves the plane or carries no positive flux.
 */
export function measureMomentFwhm(
    plane: Float32Array, W: number, H: number,
    x: number, y: number, half = 8
): { cx: number; cy: number; fwhmPx: number } | null {
    let cx = x, cy = y;
    let fwhm = NaN;
    for (let pass = 0; pass < 2; pass++) {
        const x0 = Math.round(cx), y0 = Math.round(cy);
        if (x0 - half < 0 || y0 - half < 0 || x0 + half >= W || y0 + half >= H) return null;
        const border: number[] = [];
        for (let j = -half; j <= half; j++) {
            for (let i = -half; i <= half; i++) {
                if (Math.abs(i) === half || Math.abs(j) === half) {
                    const v = plane[(y0 + j) * W + x0 + i];
                    if (Number.isFinite(v)) border.push(v);
                }
            }
        }
        if (border.length < 8) return null;
        border.sort((a, b) => a - b);
        const bg = border[border.length >> 1];
        let sw = 0, sx = 0, sy = 0;
        for (let j = -half; j <= half; j++) {
            for (let i = -half; i <= half; i++) {
                const v = plane[(y0 + j) * W + x0 + i];
                if (!Number.isFinite(v)) continue;
                const w = Math.max(0, v - bg);
                sw += w; sx += w * (x0 + i); sy += w * (y0 + j);
            }
        }
        if (sw <= 0) return null;
        cx = sx / sw; cy = sy / sw;
        let mxx = 0, myy = 0;
        for (let j = -half; j <= half; j++) {
            for (let i = -half; i <= half; i++) {
                const v = plane[(y0 + j) * W + x0 + i];
                if (!Number.isFinite(v)) continue;
                const w = Math.max(0, v - bg);
                mxx += w * (x0 + i - cx) * (x0 + i - cx);
                myy += w * (y0 + j - cy) * (y0 + j - cy);
            }
        }
        fwhm = 2.3548 * Math.sqrt(Math.max(0, (mxx + myy) / (2 * sw)));
    }
    return Number.isFinite(fwhm) && fwhm > 0 ? { cx, cy, fwhmPx: fwhm } : null;
}
