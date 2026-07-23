/**
 * sexagesimal.ts — display-only sexagesimal coordinate formatting.
 *
 * TWO-LEDGER LAW: pure display formatting. Never feeds a measurement,
 * receipt, solver, or WCS path — callers pass already-measured values.
 * UNIT TRAP: RA is HOURS internally everywhere in the engine; Dec is degrees.
 *
 * Style (owner spec): compact "17ʰ35ᵐ" / "−33°46′" in UI copy, with the
 * decimal originals available on hover via `coordHoverTitle`.
 */

function carrySplit(mag: number, withSeconds: boolean): { a: number; b: number; c: number } {
    // Round at the smallest displayed unit FIRST so 59.9′ carries to the next
    // whole unit instead of printing 60′.
    if (withSeconds) {
        const totalSec = Math.round(mag * 3600);
        return { a: Math.floor(totalSec / 3600), b: Math.floor(totalSec / 60) % 60, c: totalSec % 60 };
    }
    const totalMin = Math.round(mag * 60);
    return { a: Math.floor(totalMin / 60), b: totalMin % 60, c: 0 };
}

/** RA in internal HOURS → "17ʰ35ᵐ" (default) or "17ʰ35ᵐ42ˢ". Non-finite → "NOT MEASURED". */
export function formatRaSexagesimal(raHours: number, opts: { seconds?: boolean } = {}): string {
    if (!Number.isFinite(raHours)) return 'NOT MEASURED';
    const norm = ((raHours % 24) + 24) % 24;
    const { a, b, c } = carrySplit(norm, !!opts.seconds);
    const h = a % 24; // 23ʰ59.7ᵐ rounds up to 24ʰ00ᵐ → wrap to 0ʰ00ᵐ
    const mm = String(b).padStart(2, '0');
    return opts.seconds
        ? `${h}ʰ${mm}ᵐ${String(c).padStart(2, '0')}ˢ`
        : `${h}ʰ${mm}ᵐ`;
}

/** Dec in DEGREES → "−33°46′" (default) or "−33°46′07″". Non-finite → "NOT MEASURED". */
export function formatDecSexagesimal(decDeg: number, opts: { seconds?: boolean } = {}): string {
    if (!Number.isFinite(decDeg)) return 'NOT MEASURED';
    const sign = decDeg < 0 ? '−' : '+';
    const { a, b, c } = carrySplit(Math.abs(decDeg), !!opts.seconds);
    const mm = String(b).padStart(2, '0');
    return opts.seconds
        ? `${sign}${a}°${mm}′${String(c).padStart(2, '0')}″`
        : `${sign}${a}°${mm}′`;
}

/** Hover title with the decimal originals. Non-finite → "NOT MEASURED". */
export function coordHoverTitle(raHours: number, decDeg: number): string {
    if (!Number.isFinite(raHours) || !Number.isFinite(decDeg)) return 'NOT MEASURED';
    return `RA ${raHours.toFixed(6)}h · Dec ${decDeg.toFixed(6)}°`;
}
