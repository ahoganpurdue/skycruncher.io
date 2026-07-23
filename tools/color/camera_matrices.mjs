// ═══════════════════════════════════════════════════════════════════════════
// COLOR INCUBATOR — CAMERA-RGB → XYZ FORWARD MATRICES (data + provenance)
// ═══════════════════════════════════════════════════════════════════════════
// Tier-1 §3.1 of docs/COLOR_MATH_PROGRAM.md — "THE foundational gap": every
// color transform in the tree assumes the science RGB is sRGB (colormath.ts:14
// srgbToXYZ), but a camera has its OWN spectral primaries. This file holds the
// per-body ColorMatrix2 (maps XYZ_D65 -> camera-raw RGB, ×10000) — the public-
// domain dcraw adobe_coeff[] constants (Dave Coffin), which Adobe DNG / libraw /
// RawTherapee all mirror. Brand names appear ONLY in DATA provenance (allowed by
// CLAUDE.md LAW 6); code identifiers stay neutral.
//
// Convention (dcraw cam_xyz_coeff):
//   cam_xyz = colorMatrix2 / 10000            (3x3, XYZ_D65 -> cam)
//   cam_rgb = cam_xyz · xyz_rgb               (linear sRGB -> cam)   [xyz_rgb below]
//   pre_mul[i] = 1 / rowsum(cam_rgb[i])       (D65 white balance implied by matrix)
//   rgb_cam = inverse( rownormalize(cam_rgb) )  (cam -> linear sRGB)
//
// EVIDENCE-ONLY: `provenance` cites the source of every array. `verified` flags
// whether a live citation was confirmed this session (researcher fetch); false =
// value carried from dcraw memory, DO NOT report as authoritative.
// ═══════════════════════════════════════════════════════════════════════════

/** dcraw's sRGB(linear)→XYZ D65 matrix, paired with adobe_coeff. */
export const XYZ_RGB = [
    [0.412453, 0.357580, 0.180423],
    [0.212671, 0.715160, 0.072169],
    [0.019334, 0.119193, 0.950227],
];

// ColorMatrix2 (XYZ D65 -> camera raw, ×10000), 3x3 row-major.
// All values grep-verified against LibRaw src/tables/colordata.cpp (master) =
// dcraw adobe_coeff[] table; 5D III cross-confirmed via darktable dump.
// See test_results/color_incubator/matrix_provenance.json for cited URLs.
const LIBRAW_SRC = 'https://raw.githubusercontent.com/LibRaw/LibRaw/master/src/tables/colordata.cpp';
export const CAMERA_MATRICES = {
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
        // Rebel T7 / EOS 2000D is the market rebadge of the 1500D (identical body/
        // sensor) and is ABSENT from the table — it resolves here via alias.
        provenance: `LibRaw colordata.cpp "Canon EOS 1500D" (v.2); 2000D/T7/Kiss X90 ABSENT -> rebadge twin, uses this. ${LIBRAW_SRC}`,
        verified: true,
    },
};

// SeeStar S50 / Sony IMX462: NO published camera-RGB->XYZ matrix exists (dcraw
// keys on camera model; ZWO ASI462MC / SeeStar are not DNG-profiled). The only
// route is an SPCC-derived projection (COLOR_MATH_PROGRAM §3.1 source (c)).
export const NO_MATRIX_BODIES = {
    'IMX462': 'NOT AVAILABLE — no dcraw/DNG matrix for IMX462; SPCC-derived is the only route (SeeStar S50)',
};

/** Model-string aliases → canonical key in CAMERA_MATRICES. */
export const MODEL_ALIASES = {
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

/** Resolve a make/model pair to a matrix entry (or null). */
export function resolveMatrix(make, model) {
    const raw = `${make || ''} ${model || ''}`.trim();
    const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    // direct key
    for (const k of Object.keys(CAMERA_MATRICES)) if (k.toLowerCase() === norm) return { key: k, ...CAMERA_MATRICES[k] };
    // alias
    if (MODEL_ALIASES[norm]) { const k = MODEL_ALIASES[norm]; return { key: k, ...CAMERA_MATRICES[k] }; }
    // model-only fallback (strip "Canon " make duplication)
    const mnorm = `canon eos ${String(model || '').toLowerCase().replace(/canon|eos/g, '').trim()}`.replace(/\s+/g, ' ');
    if (MODEL_ALIASES[mnorm]) { const k = MODEL_ALIASES[mnorm]; return { key: k, ...CAMERA_MATRICES[k] }; }
    for (const k of Object.keys(CAMERA_MATRICES)) if (k.toLowerCase() === mnorm) return { key: k, ...CAMERA_MATRICES[k] };
    return null;
}

// ─── matrix algebra ──────────────────────────────────────────────────────────
export function matmul3(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]; C[i][j] = s;
    }
    return C;
}

export function inv3(M) {
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

/**
 * From a ColorMatrix2 (9 ints ×10000), build:
 *   cam2srgb : camera raw RGB -> linear sRGB (D65)     [the "AFTER" matrix]
 *   preMul   : per-channel D65 white balance implied by the matrix
 *   cam2xyz  : camera raw RGB -> XYZ D65               [for XYZ reporting]
 * Follows dcraw cam_xyz_coeff exactly.
 */
export function buildTransforms(colorMatrix2) {
    const camXyz = [
        [colorMatrix2[0] / 1e4, colorMatrix2[1] / 1e4, colorMatrix2[2] / 1e4],
        [colorMatrix2[3] / 1e4, colorMatrix2[4] / 1e4, colorMatrix2[5] / 1e4],
        [colorMatrix2[6] / 1e4, colorMatrix2[7] / 1e4, colorMatrix2[8] / 1e4],
    ];
    // cam_rgb = cam_xyz · xyz_rgb  (linear sRGB -> cam)
    const camRgb = matmul3(camXyz, XYZ_RGB);
    // row-normalize so cam_rgb·(1,1,1)=(1,1,1); pre_mul = 1/rowsum
    const preMul = [0, 0, 0];
    const camRgbN = camRgb.map((row, i) => {
        const sum = row[0] + row[1] + row[2];
        preMul[i] = 1 / sum;
        return row.map(v => v / sum);
    });
    const cam2srgb = inv3(camRgbN);            // cam -> linear sRGB
    const cam2xyz = inv3(camXyz);              // cam -> XYZ D65 (unnormalized primaries)
    return { camXyz, camRgb, camRgbN, preMul, cam2srgb, cam2xyz };
}
