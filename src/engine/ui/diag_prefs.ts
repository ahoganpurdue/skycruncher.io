/**
 * -----------------------------------------------------------------
 * DIAGNOSTIC-VISUAL PREFERENCES (owner performance-gating directive)
 * -----------------------------------------------------------------
 * Expensive visual artifacts (calibration charts, residual quiver, PSF
 * deconvolution strips/tiles) are generated in the MANUAL wizard flow and
 * SKIPPED in AUTO mode — AUTO users want speed and get the cheap text stats
 * only. This persisted preference is the opt-in override for the nerd who
 * wants both: full diagnostics even during AUTO runs.
 *
 * Storage mirrors the AUTO toggle ('skycruncher.wizard.autorun').
 */

export const FULL_DIAG_STORAGE_KEY = 'skycruncher.wizard.fulldiag';

export function getFullDiagPref(): boolean {
    try { return localStorage.getItem(FULL_DIAG_STORAGE_KEY) === '1'; } catch { return false; }
}

export function setFullDiagPref(on: boolean): void {
    try { localStorage.setItem(FULL_DIAG_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/**
 * Should expensive diagnostic visuals be generated right now?
 * Manual flow: yes (lazily, at panel render — never in the pipeline hot path).
 * AUTO flow: only with the persisted full-diagnostics opt-in.
 */
export function diagnosticsVisualsEnabled(autoRun: boolean | undefined): boolean {
    return !autoRun || getFullDiagPref();
}
