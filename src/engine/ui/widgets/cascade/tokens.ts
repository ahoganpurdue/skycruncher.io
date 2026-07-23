/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CASCADE TOKENS — read the design-system CSS variables into numeric RGB for
 * WebGL, live (theme-aware: re-reading picks up a light/dark theme swap).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The surface colour ramp is the phase-1 SEQUENTIAL scale (--chart-seq-1…5);
 * axis/text/background pull from the shared palette. No hardcoded hex — every
 * colour resolves from a token so the widget matches the app in either theme.
 * Falls back to the documented dark values when no DOM is present (tests/SSR).
 */

export type RGB = [number, number, number];

/** Documented dark-theme fallbacks (index.css @theme) — used when no DOM. */
const FALLBACK: Record<string, string> = {
  '--chart-seq-1': '#0b2942',
  '--chart-seq-2': '#0e4a6e',
  '--chart-seq-3': '#0e7fb0',
  '--chart-seq-4': '#38bdf8',
  '--chart-seq-5': '#bae6fd',
  '--color-space-900': '#0a0c12',
  '--color-space-850': '#0e1118',
  '--color-line': '#2a3245',
  '--color-line-strong': '#3d4763',
  '--color-text-muted': '#6a7792',
  '--color-data': '#c7d5f0',
  '--color-solve': '#34d399',
  '--color-warn': '#fbbf24',
  '--chart-cat-4': '#a78bfa',
};

/** Parse a #rgb / #rrggbb string to a 0..1 RGB triple. */
export function hexToRgb(hex: string): RGB {
  let h = (hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6) || '000000', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Resolve one CSS custom property to a hex string (live, with fallback). */
function readVar(name: string): string {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    }
  } catch {
    /* no DOM */
  }
  return FALLBACK[name] ?? '#888888';
}

/** The resolved palette a WebGL surface needs. */
export interface CascadePalette {
  /** 5-stop sequential ramp, low→high displacement. */
  ramp: RGB[];
  background: RGB;
  grid: RGB;
  gridStrong: RGB;
  muted: RGB;
  data: RGB;
  solve: RGB;
  warn: RGB;
  accentAlt: RGB;
}

/** Read the full palette from live CSS vars (theme-aware). */
export function readPalette(): CascadePalette {
  return {
    ramp: [
      hexToRgb(readVar('--chart-seq-1')),
      hexToRgb(readVar('--chart-seq-2')),
      hexToRgb(readVar('--chart-seq-3')),
      hexToRgb(readVar('--chart-seq-4')),
      hexToRgb(readVar('--chart-seq-5')),
    ],
    background: hexToRgb(readVar('--color-space-900')),
    grid: hexToRgb(readVar('--color-line')),
    gridStrong: hexToRgb(readVar('--color-line-strong')),
    muted: hexToRgb(readVar('--color-text-muted')),
    data: hexToRgb(readVar('--color-data')),
    solve: hexToRgb(readVar('--color-solve')),
    warn: hexToRgb(readVar('--color-warn')),
    accentAlt: hexToRgb(readVar('--chart-cat-4')),
  };
}

/** Sample a 5-stop ramp at t∈[0,1] with linear interpolation. */
export function sampleRamp(ramp: RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.floor(c);
  const f = c - i;
  const a = ramp[i];
  const b = ramp[Math.min(ramp.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
