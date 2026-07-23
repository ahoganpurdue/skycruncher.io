// Desktop test rail — float32 demosaic parity math (webview side).
//
// PORTED VERBATIM from tools/gpu_parity/run_parity.mjs's compare()/decisionProbe()
// so the native-vs-CPU / native-vs-browserGPU numbers are computed by the SAME
// methodology the banked browser-GPU-vs-CPU numbers were (wt-gpuparity
// test_results/gpu_parity_2026-07-21/results.json). The ONLY difference from the
// gpu_parity runner is WHERE it runs (inside the real Tauri webview, so the native
// wgpu output is reachable via invoke) — the arithmetic is identical.
//
// Units: all demosaic outputs are >= 0 (Math.max(0,…) on every path), so the raw
// uint32 bit pattern is monotonic in value and |u_a - u_b| is the ULP distance.

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
export function ulpOf(a: number, b: number): number {
    _f32[0] = a;
    const ua = _u32[0];
    _f32[0] = b;
    const ub = _u32[0];
    return Math.abs(ua - ub);
}

export interface Buckets {
    '0': number; '1': number; '2': number; '3': number;
    '4-8': number; '9-16': number; '17-64': number; '65-1024': number; '>1024': number;
}
const mkBuckets = (): Buckets => ({ '0': 0, '1': 0, '2': 0, '3': 0, '4-8': 0, '9-16': 0, '17-64': 0, '65-1024': 0, '>1024': 0 });
function bump(b: Buckets, ulp: number): void {
    if (ulp === 0) b['0']++;
    else if (ulp === 1) b['1']++;
    else if (ulp === 2) b['2']++;
    else if (ulp === 3) b['3']++;
    else if (ulp <= 8) b['4-8']++;
    else if (ulp <= 16) b['9-16']++;
    else if (ulp <= 64) b['17-64']++;
    else if (ulp <= 1024) b['65-1024']++;
    else b['>1024']++;
}

export interface Comparison {
    width: number;
    height: number;
    interior_elements: number;
    border_elements: number;
    interior_pixels: number;
    nan_count: number;
    max_ulp: number;
    max_ulp_small_region: number;
    max_abs_diff: number;
    interior_pct_differ_any: number | null;
    interior_pct_ulp_eq_1: number | null;
    interior_pct_pixels_differ: number | null;
    ulp_histogram_interior: { all: Buckets; R: Buckets; G: Buckets; B: Buckets };
    ulp_histogram_border: Buckets;
}

/** Interleaved-RGB (3 channels/pixel) ULP comparison, interior (1px border excluded). */
export function compare(a: Float32Array, b: Float32Array, width: number, height: number): Comparison {
    const nEl = width * height * 3;
    if (a.length !== nEl || b.length !== nEl) {
        throw new Error(`length mismatch: a=${a.length} b=${b.length} expected=${nEl}`);
    }
    const chNames = ['R', 'G', 'B'] as const;
    const interior = { all: mkBuckets(), R: mkBuckets(), G: mkBuckets(), B: mkBuckets() };
    const border = { all: mkBuckets() };
    let interiorEl = 0, borderEl = 0;
    let maxUlp = 0, maxAbs = 0, maxUlpSmallRegion = 0;
    let interiorDifferEl = 0, interiorUlp1El = 0;
    let interiorPixels = 0, interiorPixelsDiffer = 0;
    let nanCount = 0;

    for (let y = 0; y < height; y++) {
        const isBorderRow = (y === 0 || y === height - 1);
        for (let x = 0; x < width; x++) {
            const isBorder = isBorderRow || x === 0 || x === width - 1;
            const base = (y * width + x) * 3;
            let pixelDiffers = false;
            for (let c = 0; c < 3; c++) {
                const va = a[base + c], vb = b[base + c];
                if (Number.isNaN(va) || Number.isNaN(vb)) { nanCount++; continue; }
                const ulp = ulpOf(va, vb);
                const abs = Math.abs(va - vb);
                if (isBorder) {
                    borderEl++;
                    bump(border.all, ulp);
                } else {
                    interiorEl++;
                    bump(interior.all, ulp);
                    bump(interior[chNames[c]], ulp);
                    if (abs > 0) { interiorDifferEl++; pixelDiffers = true; }
                    if (ulp === 1) interiorUlp1El++;
                    if (ulp > maxUlp) maxUlp = ulp;
                    if (abs > maxAbs) maxAbs = abs;
                    if (ulp <= 64 && ulp > maxUlpSmallRegion) maxUlpSmallRegion = ulp;
                }
            }
            if (!isBorder) { interiorPixels++; if (pixelDiffers) interiorPixelsDiffer++; }
        }
    }
    const pct = (n: number, d: number): number | null => d > 0 ? +(100 * n / d).toFixed(4) : null;
    return {
        width, height,
        interior_elements: interiorEl,
        border_elements: borderEl,
        interior_pixels: interiorPixels,
        nan_count: nanCount,
        max_ulp: maxUlp,
        max_ulp_small_region: maxUlpSmallRegion,
        max_abs_diff: maxAbs,
        interior_pct_differ_any: pct(interiorDifferEl, interiorEl),
        interior_pct_ulp_eq_1: pct(interiorUlp1El, interiorEl),
        interior_pct_pixels_differ: pct(interiorPixelsDiffer, interiorPixels),
        ulp_histogram_interior: interior,
        ulp_histogram_border: border.all,
    };
}

function percentiles(sorted: number[], ps: number[]): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const p of ps) {
        if (sorted.length === 0) { out['p' + p] = null; continue; }
        const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
        out['p' + p] = sorted[idx];
    }
    return out;
}
function luminance(rgb: Float32Array, width: number, height: number): Float32Array {
    const L = new Float32Array(width * height);
    for (let i = 0, p = 0; i < rgb.length; i += 3, p++) L[p] = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
    return L;
}
function starCandidates(L: Float32Array, width: number, height: number, thresh: number): Set<number> {
    const set = new Set<number>();
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            const v = L[p];
            if (v <= thresh) continue;
            let isMax = true;
            for (let dy = -1; dy <= 1 && isMax; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    if (L[(y + dy) * width + (x + dx)] > v) { isMax = false; break; }
                }
            if (isMax) set.add(p);
        }
    }
    return set;
}
export interface DecisionProbe {
    luminance_percentiles_a: Record<string, number | null>;
    luminance_percentiles_b: Record<string, number | null>;
    luminance_p99_abs_delta: number;
    luminance_max_abs_delta: number;
    star_candidate_threshold: number | null;
    star_candidates_a: number;
    star_candidates_b: number;
    star_candidates_only_in_a: number;
    star_candidates_only_in_b: number;
    star_candidate_set_identical: boolean;
}
/** `a` supplies the shared p99 threshold (matches run_parity: CPU is the reference). */
export function decisionProbe(a: Float32Array, b: Float32Array, width: number, height: number): DecisionProbe {
    const La = luminance(a, width, height);
    const Lb = luminance(b, width, height);
    const collect = (L: Float32Array): number[] => {
        const arr: number[] = [];
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) arr.push(L[y * width + x]);
        arr.sort((m, n) => m - n);
        return arr;
    };
    const sa = collect(La), sb = collect(Lb);
    const pa = percentiles(sa, [50, 90, 99, 100]);
    const pb = percentiles(sb, [50, 90, 99, 100]);
    const thresh = pa.p99;
    const candA = starCandidates(La, width, height, thresh ?? Infinity);
    const candB = starCandidates(Lb, width, height, thresh ?? Infinity);
    let onlyA = 0, onlyB = 0;
    for (const p of candA) if (!candB.has(p)) onlyA++;
    for (const p of candB) if (!candA.has(p)) onlyB++;
    return {
        luminance_percentiles_a: pa,
        luminance_percentiles_b: pb,
        luminance_p99_abs_delta: Math.abs((pa.p99 ?? 0) - (pb.p99 ?? 0)),
        luminance_max_abs_delta: Math.abs((pa.p100 ?? 0) - (pb.p100 ?? 0)),
        star_candidate_threshold: thresh,
        star_candidates_a: candA.size,
        star_candidates_b: candB.size,
        star_candidates_only_in_a: onlyA,
        star_candidates_only_in_b: onlyB,
        star_candidate_set_identical: onlyA === 0 && onlyB === 0,
    };
}

/** Extract interleaved RGB (w*h*3) from a native RGBA f32 frame (w*h*4). */
export function rgbaToRgb(rgba: Float32Array, width: number, height: number): Float32Array {
    const out = new Float32Array(width * height * 3);
    for (let p = 0; p < width * height; p++) {
        out[p * 3] = rgba[p * 4];
        out[p * 3 + 1] = rgba[p * 4 + 1];
        out[p * 3 + 2] = rgba[p * 4 + 2];
    }
    return out;
}

/** Cheap descriptive stats over a raw float array (finite/zero/nan counts, min/max). */
export function rawStats(arr: Float32Array): { len: number; nan: number; zero: number; finite: number; min: number; max: number } {
    let nan = 0, zero = 0, finite = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isNaN(v)) { nan++; continue; }
        if (v === 0) zero++;
        if (Number.isFinite(v)) { finite++; if (v < min) min = v; if (v > max) max = v; }
    }
    return { len: arr.length, nan, zero, finite, min: finite ? min : NaN, max: finite ? max : NaN };
}
