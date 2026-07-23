/**
 * -----------------------------------------------------------------
 * CHART MATH — pure helpers for the step-6 instrument charts
 * -----------------------------------------------------------------
 * No React, no DOM: testable in vitest. Everything here is presentation
 * geometry for MEASURED values; nothing fabricates data.
 */

/** "Nice" tick positions covering [min, max] (inclusive-ish), 10^n * {1,2,2.5,5}. */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
    if (min === max) { min -= 1; max += 1; }
    if (min > max) [min, max] = [max, min];
    const span = max - min;
    const rawStep = span / Math.max(1, targetCount);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = mag;
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (mag * m >= rawStep) { step = mag * m; break; }
    }
    const first = Math.ceil(min / step) * step;
    const ticks: number[] = [];
    for (let v = first; v <= max + step * 1e-9; v += step) {
        // kill float dust (e.g. 0.30000000000000004)
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
    }
    return ticks.length ? ticks : [min, max];
}

/** Compact honest formatting for coefficients spanning many magnitudes. */
export function fmtCoef(v: number | undefined | null, digits = 3): string {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 0.001 && a < 10000) return v.toPrecision(digits);
    return v.toExponential(Math.max(1, digits - 2));
}

/**
 * Radial Brown-Conrady-style displacement in PIXELS at normalized radius r:
 * the profiler fits r_meas/r_ideal - 1 = k1 r^2 + k2 r^4 + k3 r^6 (r
 * normalized to r_ref), so the pixel displacement is that ratio times the
 * ideal radius in px.
 */
export function distortionShiftPx(r: number, k1: number, k2: number, k3: number, rRefPx: number): number {
    const r2 = r * r;
    return (k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2) * r * rRefPx;
}

/** Vignette relative-illumination model as fitted: I(r) = 1 + v1 r^2. */
export function vignetteGainAt(r: number, v1: number): number {
    return 1 + v1 * r * r;
}

/**
 * Pick a quiver magnification: smallest of {1,2,5}x10^n making the MEDIAN
 * residual arrow ~targetPx long on the plot. Clamped to [1, 500]; 1 means
 * arrows are true-scale.
 */
export function quiverMagnification(medianResidualPx: number, targetPx: number): number {
    if (!(medianResidualPx > 0) || !(targetPx > 0)) return 1;
    const ideal = targetPx / medianResidualPx;
    if (ideal <= 1) return 1;
    let best = 1;
    for (let p = 0; p <= 3; p++) {
        for (const m of [1, 2, 5]) {
            const cand = m * Math.pow(10, p);
            if (cand <= ideal) best = cand;
        }
    }
    return Math.min(500, best);
}
