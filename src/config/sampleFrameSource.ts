/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SAMPLE-FRAME SOURCE — the "Load Sample" frame the landing screen offers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SINGLE app-side config point for the sample frame. Historically MainUpload
 * fetched a hardcoded '/demo/seestar_m66_sample.fit' literal; this module owns
 * that path so there are no brand/URL literals in the component (LAW-6 spirit)
 * and so the THIN client (which ships WITHOUT the bundled /demo frame) can be
 * pointed at a configurable remote sample.
 *
 * RESOLUTION (honest-or-absent):
 *   - VITE_SAMPLE_FRAME_URL set   -> fetch that remote frame (no target hint;
 *                                    the frame identity is unknown, so we solve
 *                                    it blind rather than assert a wrong hint).
 *   - VITE_SAMPLE_FRAME_URL unset -> the bundled SeeStar M66 FITS at
 *                                    BUNDLED_SAMPLE_PATH, WITH the M66 hint.
 *   The unset case is the DEFAULT and is byte-identical to the pre-seam
 *   behavior (fat build, all gates, e2e).
 *
 * ⚠ DESKTOP CAVEAT (owner follow-up, LAW-5): the Tauri webview CSP is
 *   `connect-src 'self' ipc: http://ipc.localhost` (src-tauri/tauri.conf.json)
 *   — a direct remote fetch from the webview is CSP-blocked in the shipped
 *   desktop app. Serving a remote sample to the thin desktop client therefore
 *   needs either a CSP connect-src allowance for the sample host OR routing the
 *   fetch through a Rust download command (same class as the in-app star-data
 *   download; needs owner sign-off). Until then the remote URL works in the
 *   browser build only. The OWNER must (a) upload a sample frame and set
 *   VITE_SAMPLE_FRAME_URL, and (b) decide the desktop fetch transport.
 */

export interface SampleFrameHint {
  ra: number; // HOURS (hint contract)
  dec: number; // degrees
  label: string;
}

export interface SampleFrameSource {
  /** Fetch URL — a same-origin bundled path or a remote URL. */
  url: string;
  /** Filename to stamp onto the constructed File (extension drives format sniff). */
  name: string;
  /** MIME for the constructed File (may be '' for a remote frame; format is sniffed). */
  mime: string;
  /** Target hint, or undefined to solve blind (remote frames of unknown identity). */
  hint?: SampleFrameHint;
  /** True when the source is the configured remote URL rather than the bundle. */
  isRemote: boolean;
}

/** Bundled demo frame — staged into public/demo -> dist/demo by prep_demo_assets.mjs. */
export const BUNDLED_SAMPLE_PATH = '/demo/seestar_m66_sample.fit';
export const BUNDLED_SAMPLE_NAME = 'seestar_m66_sample.fit';
export const BUNDLED_SAMPLE_MIME = 'application/fits';

/** The bundled frame IS the SeeStar M66 stack — its catalog target hint. */
export const BUNDLED_SAMPLE_HINT: SampleFrameHint = {
  ra: 11.338, // M66 catalog RA (11h 20m 15s), HOURS
  dec: 12.992, // M66 catalog Dec (+12deg 59' 30")
  label: 'M66 (Sample)',
};

/** Configured remote sample URL, or null when unset (honest absence). */
export function sampleFrameUrl(): string | null {
  const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_SAMPLE_FRAME_URL;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Resolve the sample frame to load. Remote (configured) wins; otherwise the
 * bundled M66 frame. Default (unset) === pre-seam behavior.
 */
export function resolveSampleFrame(): SampleFrameSource {
  const remote = sampleFrameUrl();
  if (remote) {
    const name = remote.split('/').pop()?.split('?')[0] || BUNDLED_SAMPLE_NAME;
    return { url: remote, name, mime: '', hint: undefined, isRemote: true };
  }
  return {
    url: BUNDLED_SAMPLE_PATH,
    name: BUNDLED_SAMPLE_NAME,
    mime: BUNDLED_SAMPLE_MIME,
    hint: BUNDLED_SAMPLE_HINT,
    isRemote: false,
  };
}
