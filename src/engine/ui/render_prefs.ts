/**
 * -----------------------------------------------------------------
 * RENDER-LAYER PREFERENCES (PIXEL ledger, DEFAULT-OFF flags)
 * -----------------------------------------------------------------
 * Opt-in render toggles that change ONLY the preview rendering, never physics,
 * WCS, matched_stars, or any receipt/measurement value. Storage mirrors the
 * `diag_prefs` / widget-dock persistence pattern (localStorage, boolean).
 *
 * OKLAB stretch (candidate, owner render wave 2026-07-11): routes the STF v2
 * color-preserving stretch through OkLCh — perceptually-uniform background-desat
 * guard + hue-preserving gamut projection replacing the two ad-hoc RGB guards
 * and the naive clamp (OKLAB_RESEARCH.md). DEFAULT OFF: with the flag off the
 * render path is byte-identical to the pre-Oklab STF v2 output.
 */

export const OKLAB_RENDER_STORAGE_KEY = 'skycruncher.render.oklab';

export function getOklabRenderPref(): boolean {
    try { return localStorage.getItem(OKLAB_RENDER_STORAGE_KEY) === '1'; } catch { return false; }
}

export function setOklabRenderPref(on: boolean): void {
    try { localStorage.setItem(OKLAB_RENDER_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/**
 * CORRECTED VIEW (candidate, render wave 2026-07-11): re-displays the wizard
 * preview through the frame's FITTED distortion solution (SIP inverse warp) so
 * the measured distortion is visually removed. RENDER PLANE ONLY — consumes the
 * coordinate + pixel ledgers and feeds NEITHER (never touches the solve, WCS,
 * matched stars, or any receipt/measurement). DEFAULT OFF: with the flag off the
 * render path is byte-identical (the OFF path never allocates the warp) and the
 * honest disabled state renders when no fitted distortion exists for the frame.
 */
export const CORRECTED_VIEW_STORAGE_KEY = 'skycruncher.render.corrected_view';

export function getCorrectedViewPref(): boolean {
    try { return localStorage.getItem(CORRECTED_VIEW_STORAGE_KEY) === '1'; } catch { return false; }
}

export function setCorrectedViewPref(on: boolean): void {
    try { localStorage.setItem(CORRECTED_VIEW_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}
