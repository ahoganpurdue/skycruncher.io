// Desktop auto-update hook (Tauri v2 updater channel).
//
// SCOPE: desktop shell only. The web/browser build skips this entirely via the
// isTauriRuntime() guard, so no `@tauri-apps/plugin-updater` / `-process` code
// is reached in the browser (imports are dynamic — kept out of the web chunk).
//
// FLAG: set `VITE_DESKTOP_AUTOUPDATE="0"` at build time to disable the startup
// check (default = enabled under Tauri). Browser is always OFF (guard).
//
// Pipeline (per docs/…/b1_b3_dossier.md §1): check() -> downloadAndInstall()
// -> relaunch(). On Windows the app auto-exits when the NSIS installer runs.

/** True only inside a native Tauri webview. Mirrors demosaic_pipeline.ts:92. */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function autoUpdateEnabled(): boolean {
  try {
    const v = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DESKTOP_AUTOUPDATE;
    return v !== '0' && v !== 'false';
  } catch {
    return true; // no import.meta.env (plain Node) — default ON, but the isTauri guard gates it anyway
  }
}

/**
 * Fire-and-forget startup update check. Safe to call unconditionally from the
 * entry point: it no-ops in the browser and on flag-off. Never throws.
 */
export async function initDesktopAutoUpdate(): Promise<void> {
  if (!isTauriRuntime()) return;   // OFF for browser
  if (!autoUpdateEnabled()) return; // flag-gated off
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      console.info('[updater] no update available');
      return;
    }
    console.info(`[updater] update ${update.version} available; downloading + installing…`);
    await update.downloadAndInstall();
    console.info('[updater] installed; relaunching');
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    // Network errors / unreachable endpoint must never break app startup.
    console.error('[updater] check/install failed:', err);
  }
}
