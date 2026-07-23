// Desktop startup window fit (Tauri v2).
//
// The desktop window is created at a FIXED 1400×900 (tauri.conf.json). On small
// laptop screens (1366×768, or 1920×1080 @150% ⇒ 1280×720 logical) that default
// is larger than the usable work area, so the window hangs off-screen — a live
// defect that read to the owner as an "off-center upload button". This clamps the
// window down to the current monitor's WORK AREA (taskbar excluded) at startup,
// then centers it.
//
// SCOPE: desktop shell only. The web/browser build skips this entirely via the
// isTauriRuntime() guard, and the `@tauri-apps/api/*` imports are DYNAMIC — no
// Tauri code enters the web chunk and the browser lane stays byte-identical.

import { isTauriRuntime } from './updater';

/** The tauri.conf.json default window size (logical px) — kept in sync by hand. */
const DEFAULT_W = 1400;
const DEFAULT_H = 900;
/** Matches tauri.conf.json minWidth/minHeight — never clamp below a usable size. */
const MIN_W = 1000;
const MIN_H = 640;
/** Fraction of the work area to occupy when clamping (leaves a small margin). */
const FIT = 0.95;

/**
 * Fire-and-forget startup window fit. Safe to call unconditionally from the
 * entry point: it no-ops in the browser (guard) and never throws.
 *
 * If the monitor's work area is smaller than the 1400×900 default in either
 * dimension, resize to ~95% of the work area (clamped to the MIN floor) so the
 * window fits with a margin; otherwise keep 1400×900. Always re-centers.
 */
export async function initDesktopWindowFit(): Promise<void> {
  if (!isTauriRuntime()) return; // OFF for browser — the web lane is byte-identical
  try {
    const { getCurrentWindow, currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWindow();

    // currentMonitor() can be null when the window is (mis)positioned off-screen —
    // the exact failure this fixes — so fall back to the primary monitor.
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (monitor) {
      const sf = monitor.scaleFactor || 1;
      // workArea excludes the OS taskbar/dock — the true usable region. Physical
      // pixels ÷ scaleFactor ⇒ the logical (CSS) size the window is measured in.
      const workW = Math.floor(monitor.workArea.size.width / sf);
      const workH = Math.floor(monitor.workArea.size.height / sf);

      if (workW < DEFAULT_W || workH < DEFAULT_H) {
        const targetW = Math.max(MIN_W, Math.min(DEFAULT_W, Math.floor(workW * FIT)));
        const targetH = Math.max(MIN_H, Math.min(DEFAULT_H, Math.floor(workH * FIT)));
        await win.setSize(new LogicalSize(targetW, targetH));
        console.info(`[window_fit] work area ${workW}×${workH} < ${DEFAULT_W}×${DEFAULT_H}; resized to ${targetW}×${targetH}`);
      }
    }
    // Center regardless — a 1400×900 window on a barely-large-enough screen, or a
    // freshly clamped one, should sit in the middle rather than at a stale offset.
    await win.center();
  } catch (err) {
    // A window-fit failure must never break app startup.
    console.error('[window_fit] failed:', err);
  }
}
