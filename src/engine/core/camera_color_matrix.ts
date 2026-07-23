/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMERA-RGB → LINEAR-sRGB FORWARD COLOR MATRIX (engine home)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL (render layer). COORDINATE math (WCS/solve) is never touched.
 *
 * Tier-1 §3.1 of docs/COLOR_MATH_PROGRAM.md — "THE foundational gap": every
 * color transform in the tree assumed the science RGB was already sRGB
 * (`colormath.ts:srgbToXYZ`), but a scientific camera has its OWN spectral
 * primaries. This module holds the per-body forward matrix so the render can
 * project camera-native RGB into linear sRGB before the STF stretch.
 *
 * PORTED from the verified incubator `tools/color/camera_matrices.mjs`
 * (f4dbca9 — before/after renders on T6/1300D + 60Da confirmed the matrix is
 * distinct and correct). That .mjs stays as the thin CLI driver; this TS module
 * is the engine seam consumed by the render lane. The two must stay in sync —
 * both carry the SAME dcraw/LibRaw `adobe_coeff[]` ColorMatrix2 constants.
 *
 * PROVENANCE (allowed brand names in DATA per CLAUDE.md LAW 6): the public-
 * domain dcraw `adobe_coeff[]` table (Dave Coffin), mirrored by Adobe DNG /
 * LibRaw / RawTherapee. `verified:true` = grep-confirmed against LibRaw
 * `src/tables/colordata.cpp` this session.
 *
 * HONEST-OR-ABSENT (LAW 3): `resolveColorTransform` returns `null` when no
 * published matrix exists for the body (SeeStar / IMX462, and every non-DNG
 * astro-cam). The render then falls back to the empirical luminance/white-
 * balance path — NEVER a fabricated matrix.
 */

/** dcraw's linear-sRGB → XYZ(D65) matrix, paired with adobe_coeff. */
export const XYZ_RGB: readonly (readonly number[])[] = [
    [0.412453, 0.357580, 0.180423],
    [0.212671, 0.715160, 0.072169],
    [0.019334, 0.119193, 0.950227],
];

export interface CameraMatrixEntry {
    /** ColorMatrix2 (XYZ D65 → camera raw, ×10000), 3×3 row-major. */
    colorMatrix2: number[];
    provenance: string;
    /** true = live citation grep-confirmed this session; false = do NOT report as authoritative. */
    verified: boolean;
}

const LIBRAW_SRC = 'https://raw.githubusercontent.com/LibRaw/LibRaw/master/src/tables/colordata.cpp';

/** Per-body ColorMatrix2 (dcraw adobe_coeff = LibRaw colordata.cpp). */
export const CAMERA_MATRICES: Record<string, CameraMatrixEntry> = {
    'Canon EOS 5D Mark III': {
        colorMatrix2: [6722, -635, -963, -4287, 12460, 2028, -908, 2162, 5668],
        provenance: `LibRaw colordata.cpp (=dcraw adobe_coeff) ColorMatrix2 D65; cross-confirmed darktable. ${LIBRAW_SRC}`,
        verified: true,
    },
    'Canon EOS 60D': {
        colorMatrix2: [6719, -994, -925, -4408, 12426, 2211, -887, 2129, 6051],
        provenance: `LibRaw colordata.cpp (=dcraw adobe_coeff) ColorMatrix2 D65. ${LIBRAW_SRC}`,
        verified: true,
    },
    'Canon EOS 60Da': {
        // DISTINCT entry (LibRaw line 101) — NOT a 60D fallback. The large red
        // coeffs (17492,-7240) encode the Hα-extended astro modification; using
        // the 60D matrix here would MIS-project deep-red nebula color.
        colorMatrix2: [17492, -7240, -2023, -1791, 10323, 1701, -186, 1329, 5406],
        provenance: `LibRaw colordata.cpp DISTINCT 60Da entry (Hα-mod red response). ${LIBRAW_SRC}`,
        verified: true,
    },
    'Canon EOS 1300D': {
        colorMatrix2: [6939, -1016, -866, -4428, 12473, 2177, -1175, 2178, 6162],
        provenance: `LibRaw colordata.cpp "Canon EOS 1300D" (aka Rebel T6 / Kiss X80) ColorMatrix2 D65. ${LIBRAW_SRC}`,
        verified: true,
    },
    'Canon EOS 1500D': {
        colorMatrix2: [8300, -2110, -1120, -4917, 12694, 2482, -938, 2141, 5666],
        provenance: `LibRaw colordata.cpp "Canon EOS 1500D" (v.2); 2000D/T7/Kiss X90 rebadge twin uses this. ${LIBRAW_SRC}`,
        verified: true,
    },
};

/** Bodies with NO published camera-RGB→XYZ matrix (SPCC-derived is the only route). */
export const NO_MATRIX_BODIES: Record<string, string> = {
    'IMX462': 'NOT AVAILABLE — no dcraw/DNG matrix for IMX462; SPCC-derived is the only route (SeeStar S50)',
    'SEESTAR': 'NOT AVAILABLE — SeeStar (IMX462/IMX585) has no DNG color profile; SPCC-derived only',
};

/** Model-string aliases → canonical key in CAMERA_MATRICES. */
export const MODEL_ALIASES: Record<string, string> = {
    'canon eos rebel t6': 'Canon EOS 1300D',
    'canon eos kiss x80': 'Canon EOS 1300D',
    'canon eos 1300d': 'Canon EOS 1300D',
    'canon eos rebel t7': 'Canon EOS 1500D',
    'canon eos 1500d': 'Canon EOS 1500D',
    'canon eos kiss x90': 'Canon EOS 1500D',
    'canon eos 2000d': 'Canon EOS 1500D',
    'canon eos 5d mark iii': 'Canon EOS 5D Mark III',
    'canon eos 60da': 'Canon EOS 60Da',
    'canon eos 60d': 'Canon EOS 60D',
};

export interface ResolvedMatrix extends CameraMatrixEntry {
    key: string;
}

/** Resolve a make/model pair to a matrix entry (or null). */
export function resolveMatrix(make: string | null | undefined, model: string | null | undefined): ResolvedMatrix | null {
    const raw = `${make || ''} ${model || ''}`.trim();
    const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const k of Object.keys(CAMERA_MATRICES)) if (k.toLowerCase() === norm) return { key: k, ...CAMERA_MATRICES[k] };
    if (MODEL_ALIASES[norm]) { const k = MODEL_ALIASES[norm]; return { key: k, ...CAMERA_MATRICES[k] }; }
    const mnorm = `canon eos ${String(model || '').toLowerCase().replace(/canon|eos/g, '').trim()}`.replace(/\s+/g, ' ');
    if (MODEL_ALIASES[mnorm]) { const k = MODEL_ALIASES[mnorm]; return { key: k, ...CAMERA_MATRICES[k] }; }
    for (const k of Object.keys(CAMERA_MATRICES)) if (k.toLowerCase() === mnorm) return { key: k, ...CAMERA_MATRICES[k] };
    return null;
}

// ─── 3×3 matrix algebra ────────────────────────────────────────────────────
export function matmul3(A: number[][], B: readonly (readonly number[])[]): number[][] {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]; C[i][j] = s;
    }
    return C;
}

export function inv3(M: number[][]): number[][] {
    const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
    const id = 1 / det;
    return [
        [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
        [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
        [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id],
    ];
}

export interface MatrixTransforms {
    camXyz: number[][];
    camRgb: number[][];
    camRgbN: number[][];
    preMul: number[];
    cam2srgb: number[][];
    cam2xyz: number[][];
}

/**
 * From a ColorMatrix2 (9 ints ×10000), build the dcraw cam_xyz_coeff transforms:
 *   cam2srgb : camera raw RGB → linear sRGB (D65)   [the applied chromatic rotation]
 *   preMul   : per-channel D65 white balance implied by the matrix
 *   cam2xyz  : camera raw RGB → XYZ D65
 */
export function buildTransforms(colorMatrix2: number[]): MatrixTransforms {
    const camXyz = [
        [colorMatrix2[0] / 1e4, colorMatrix2[1] / 1e4, colorMatrix2[2] / 1e4],
        [colorMatrix2[3] / 1e4, colorMatrix2[4] / 1e4, colorMatrix2[5] / 1e4],
        [colorMatrix2[6] / 1e4, colorMatrix2[7] / 1e4, colorMatrix2[8] / 1e4],
    ];
    const camRgb = matmul3(camXyz, XYZ_RGB);
    const preMul = [0, 0, 0];
    const camRgbN = camRgb.map((row, i) => {
        const sum = row[0] + row[1] + row[2];
        preMul[i] = 1 / sum;
        return row.map(v => v / sum);
    });
    const cam2srgb = inv3(camRgbN);
    const cam2xyz = inv3(camXyz);
    return { camXyz, camRgb, camRgbN, preMul, cam2srgb, cam2xyz };
}

/**
 * Render-ready color transform (PIXEL ledger). `matrix` folds the implied D65
 * white balance (preMul) into the cam→linear-sRGB rotation so the render lane
 * applies ONE 3×3 per pixel: srgb_i = Σ_j matrix[i][j]·camRGB[j].
 *
 * COMPOSITION with SPCC gains (COLOR_MATH_PROGRAM §3.2): this chromatic rotation
 * runs FIRST in ImageProcessor.float32ToImageDataAutoStretch; the SPCC-derived
 * per-channel white-balance gains (spcc.gains, TLS-fit) then apply AFTER it, as a
 * diagonal residual WB in the rotated output space. (They never co-occur today:
 * SPCC is FITS-only and its only body — SeeStar/IMX462 — has no matrix; matrix
 * bodies are CR2/DSLR where SPCC does not run. Documented forward ordering.)
 */
export interface ColorTransform {
    /** cam-raw RGB → linear sRGB, with D65 preMul folded into columns (render applies this). */
    matrix: number[][];
    /** the un-folded cam→linear-sRGB rotation (for the receipt / audit). */
    cam2srgb: number[][];
    /** per-channel D65 white balance implied by the matrix. */
    preMul: number[];
    /** canonical body key. */
    body: string;
    /** DERIVED representation tag (per COLOR_MATH_PROGRAM §4.2 labeling law). */
    tag: 'DERIVED_CAMERA_MATRIX';
    /** honest short label for UI/receipt surfaces. */
    label: string;
    provenance: string;
    verified: boolean;
}

/**
 * Resolve a camera model string to a render-ready ColorTransform, or `null`
 * when no published matrix exists for the body (honest fallback — the caller
 * renders the empirical luminance/WB path and labels it as such).
 *
 * @param model camera model string (HardMetadata.camera_model), e.g. "Canon EOS 60Da".
 */
export function resolveColorTransform(model: string | null | undefined): ColorTransform | null {
    const mx = resolveMatrix('', model);
    if (!mx) return null;
    const t = buildTransforms(mx.colorMatrix2);
    // fold preMul (column-wise) into cam2srgb so one 3×3 does WB + rotation.
    const matrix = t.cam2srgb.map(row => [row[0] * t.preMul[0], row[1] * t.preMul[1], row[2] * t.preMul[2]]);
    return {
        matrix,
        cam2srgb: t.cam2srgb,
        preMul: t.preMul,
        body: mx.key,
        tag: 'DERIVED_CAMERA_MATRIX',
        label: `COLOR: matrix sRGB (${mx.key})`,
        provenance: mx.provenance,
        verified: mx.verified,
    };
}

/**
 * Honest label for the color-render MODE of a given body — whether or not a
 * matrix exists. Used by UI/report surfaces so the transform always carries a
 * tag (COLOR_MATH_PROGRAM labeling law), never a silent/implied claim.
 */
export function describeColorMode(model: string | null | undefined): { mode: 'MATRIX' | 'LUMINANCE'; label: string; body: string | null } {
    const t = resolveColorTransform(model);
    if (t) return { mode: 'MATRIX', label: t.label, body: t.body };
    return { mode: 'LUMINANCE', label: 'LUMINANCE (empirical WB — no body color matrix)', body: null };
}
