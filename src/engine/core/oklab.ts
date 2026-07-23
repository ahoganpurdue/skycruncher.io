/**
 * OKLAB / OkLCh — RENDER-LAYER perceptual color space (PIXEL ledger).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure, branch-free color transforms after Björn Ottosson (2020, "A perceptual
 * color space for image processing"). Used ONLY by the render layer
 * (`ImageProcessor.float32ToImageDataAutoStretch`, Oklab stretch path). NEVER
 * touches the LINEAR physics upstream of the stretch, WCS, matched_stars, or any
 * receipt/measurement value.
 *
 * Space contract: operates on LINEAR sRGB (D65 display-referred). Oklab L is a
 * perceptual lightness (display-referred cube-root), NOT photometric luminance —
 * any value read off a post-transform pixel is render-only and must carry the
 * APPROXIMATE label (see OKLAB_RESEARCH.md §4.2).
 *
 * DETERMINISM NOTE: `Math.cbrt` is deterministic on a given platform/engine but
 * is NOT guaranteed bit-identical across platforms (libm vs V8 fdlibm). This is
 * the render layer (Uint8 output), so cross-platform sub-ULP drift is acceptable
 * and does not gate. A future WGSL twin that must bit-match would have to pin the
 * cbrt implementation (OKLAB_RESEARCH.md §4.1).
 */

export type Rgb = [number, number, number];
/** Oklab: L (perceptual lightness), a (green↔red), b (blue↔yellow). */
export type Lab = [number, number, number];
/** OkLCh: L (lightness), C (chroma ≥ 0), h (hue, radians). */
export type Lch = [number, number, number];

// ── linear sRGB → Oklab ───────────────────────────────────────────────────
export function linearSrgbToOklab(r: number, g: number, b: number): Lab {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    // cube root preserves sign (Math.cbrt handles negatives from out-of-gamut input).
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    return [
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ];
}

// ── Oklab → linear sRGB ───────────────────────────────────────────────────
export function oklabToLinearSrgb(L: number, a: number, b: number): Rgb {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

// ── Oklab ↔ OkLCh (polar chroma/hue) ──────────────────────────────────────
export function oklabToOklch(L: number, a: number, b: number): Lch {
    return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

export function oklchToOklab(L: number, C: number, h: number): Lab {
    return [L, C * Math.cos(h), C * Math.sin(h)];
}

export function linearSrgbToOklch(r: number, g: number, b: number): Lch {
    const [L, a, bb] = linearSrgbToOklab(r, g, b);
    return oklabToOklch(L, a, bb);
}

export function oklchToLinearSrgb(L: number, C: number, h: number): Rgb {
    const [ll, a, b] = oklchToOklab(L, C, h);
    return oklabToLinearSrgb(ll, a, b);
}

/** True iff every channel lies within the sRGB gamut cube (± eps). */
export function inSrgbGamut(rgb: Rgb, eps = 1e-4): boolean {
    return (
        rgb[0] >= -eps && rgb[0] <= 1 + eps &&
        rgb[1] >= -eps && rgb[1] <= 1 + eps &&
        rgb[2] >= -eps && rgb[2] <= 1 + eps
    );
}

/**
 * HUE-PRESERVING sRGB gamut projection (Ottosson, OKLAB_RESEARCH.md §2.4).
 *
 * Replaces the naive per-channel RGB clamp — which rotates hue at exactly the
 * brightest, most-looked-at pixels — with a projection that holds hue EXACTLY
 * and reduces chroma until the color re-enters the sRGB gamut. Lightness is
 * clamped to [0,1] first (the achromatic axis (L,0,h) is in-gamut for L∈[0,1],
 * so bisection always converges). For a saturated star core this desaturates
 * gracefully toward its lightness-appropriate white instead of clamping pink.
 *
 * Guarantees (both unit-tested):
 *   • hue h is returned UNCHANGED (never rotated);
 *   • output chroma ≤ input chroma (monotone reduction; equals input if already
 *     in gamut and L needed no clamp).
 *
 * Uses chroma bisection (keep-L variant): deterministic, closed-form-free, no
 * cusp-coefficient tables. `iterations` fixes precision (24 ⇒ ~C/2^24 ≈ 6e-8).
 */
export function gamutClipPreserveHue(L: number, C: number, h: number, iterations = 24): Lch {
    const Lc = L < 0 ? 0 : L > 1 ? 1 : L;
    if (inSrgbGamut(oklchToLinearSrgb(Lc, C, h))) {
        return [Lc, C, h];
    }
    // Largest t ∈ [0,1] with (Lc, t·C, h) in gamut. Achromatic (t=0) is always in.
    let lo = 0;
    let hi = C;
    for (let i = 0; i < iterations; i++) {
        const mid = 0.5 * (lo + hi);
        if (inSrgbGamut(oklchToLinearSrgb(Lc, mid, h))) lo = mid;
        else hi = mid;
    }
    return [Lc, lo, h];
}

/** sRGB opto-electronic transfer function (linear [0,1] → display-encoded [0,1]). */
export function encodeSrgb(v: number): number {
    const c = v < 0 ? 0 : v > 1 ? 1 : v;
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
