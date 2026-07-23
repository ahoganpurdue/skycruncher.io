// ═══════════════════════════════════════════════════════════════════════════
// Fixture test — dense "bubble-tile" tagged-PNG generator (RENDER-LAYER only)
// ═══════════════════════════════════════════════════════════════════════════
// Proves the shared overlay renderer (tools/validation/visual/bubble_tiles.mjs)
// that both tagged-PNG lanes consume:
//   (a) renders a VALID PNG that is comfortably ≤ 5 MB (owner budget),
//   (b) surfaces a tile for every present test block (solve / truth / psf_field /
//       psf_attribution / distortion / atmospheric / detection / metadata),
//   (c) is HONEST-OR-ABSENT — a receipt missing a block renders NO tile for it
//       (and never fabricates a placeholder number).
//
// test_results/ is gitignored/local, so the fixture builds a receipt-shaped
// object + a synthetic luminance plane in-memory (no on-disk corpus needed).
import { describe, it, expect } from 'vitest';
import {
  buildGroups, stretch, grayToCanvas, composite, encodePng, PASS,
} from '../../../tools/validation/visual/bubble_tiles.mjs';

// ── a rich, M66-like FITS receipt (solve + truth + PSF field + attribution) ──
const RICH = {
  solution: {
    ra_hours: 11.341253, dec_degrees: 12.9915, pixel_scale_arcsec: 3.6776, stars_matched: 272,
    confidence: 0.83108, roll_degrees: 41.7, parity: 1, locking_tool: 'fits_wizard_solve',
    deep_confirmed: true, best_peak_z: 18.4, locked: true,
  },
  truth: { verdict: 'TRUE_POSITIVE', comparison: { center_sep_deg: 0.0021, scale_err_frac: 0.004, rotation_err_deg: 0.12 } },
  psf_field: { method: 'WASM_LM_GAUSSIAN', fwhm_median_maj_px: 4.62, ellipticity_median: 0.11, orientation_median_deg: 63.2, n_fit: 188 },
  psf_attribution: {
    drift: { presence: 'NOT_CONFIRMED', calculatedPx: 0.4, tier: 'CALCULATED' },
    tracking: { inference: 'TRACKED', tier: 'INFERRED' },
    diffraction: { floorArcsec: { r: 1.9, g: 1.6, b: 1.4 }, rayleighArcsecG: 1.6, tier: 'CALCULATED' },
    seeing: { arcsec: 2.4, airmass: 1.18, tier: 'APPROXIMATE' },
    coma: { tier: 'FITTED', fit: { patternConsistent: true } },
  },
  astrometry: { sip_fitted: true, sip_order: 3, residual_rms_arcsec: 0.42 },
  detection: { count: 512, culled: 44 },
  metadata: { rig: 'SEESTAR S50', exposure_time: 10, focal_length: 250, timestamp_source: 'EXIF', gps_source: 'EXIF' },
};

/** synthesize a small star-on-noise luminance plane (deterministic). */
function synthLum(W: number, H: number, seed = 7): Float32Array {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const lum = new Float32Array(W * H);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.02 + rnd() * 0.02;
  for (let n = 0; n < 60; n++) {
    const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H);
    if (cx < W && cy < H) lum[cy * W + cx] += 0.6 + rnd() * 0.4;
  }
  return lum;
}

function titles(groups: { title: string }[]): string[] { return groups.map((g) => g.title); }
function tileLabels(groups: { title: string; tiles: { label: string; value: string }[] }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of groups) for (const t of g.tiles) out[`${g.title}/${t.label}`] = t.value;
  return out;
}

// ── PNG sanity via raw bytes (no extra decode dep) ────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngDims(buf: Buffer): { w: number; h: number } {
  // IHDR width/height are big-endian u32 at byte offsets 16 and 20.
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('bubble-tile tagged PNG (dense, modern, honest-or-absent)', () => {
  it('renders a valid PNG comfortably within the 5 MB budget', () => {
    const W = 480, H = 320;
    const gray = stretch(synthLum(W, H));
    const c = grayToCanvas(gray, W, H);
    const groups = buildGroups(RICH);
    composite(c, {
      header: { frame: 'M 66', imageType: 'FITS SEESTAR', rig: 'SEESTAR S50', statusText: 'TRUE POSITIVE', statusColor: PASS },
      groups,
    });
    const buf = encodePng(c);
    // (a) valid PNG
    expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
    const { w, h } = pngDims(buf);
    expect(w).toBe(W);
    expect(h).toBe(H);
    // ≤ 5 MB owner budget (with headroom), and non-empty
    expect(buf.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(buf.length).toBeGreaterThan(200);
  });

  it('surfaces a tile-group for every present test block', () => {
    const groups = buildGroups(RICH);
    const t = titles(groups);
    for (const expected of ['SOLVE', 'TRUTH', 'PSF FIELD', 'PSF ATTRIBUTION', 'DISTORTION', 'ATMOSPHERIC', 'DETECTION', 'METADATA']) {
      expect(t).toContain(expected);
    }
    const labels = tileLabels(groups);
    // spot-check the ACTUAL values flow through honestly (no fabrication)
    expect(labels['SOLVE/SCALE']).toContain('3.678');
    expect(labels['SOLVE/MATCHED']).toBe('272');
    expect(labels['TRUTH/VERDICT']).toBe('TRUE POSITIVE');
    expect(labels['PSF FIELD/FWHM MED']).toContain('4.62');
    expect(labels['PSF ATTRIBUTION/TRACKING']).toBe('TRACKED');
    expect(labels['DISTORTION/SIP FIT']).toContain('FITTED');
  });

  it('is HONEST-OR-ABSENT: a receipt missing a block renders no tile for it', () => {
    // Only a solve + detection present; everything else absent.
    const sparse = {
      solution: { ra_hours: 17.5858, dec_degrees: -25.1, pixel_scale_arcsec: 63.2, stars_matched: 55, locked: true },
      detection: { count: 120 },
      psf_field: null, psf_attribution: null, truth: null, astrometry: null, metadata: null,
    };
    const t = titles(buildGroups(sparse));
    expect(t).toContain('SOLVE');
    expect(t).toContain('DETECTION');
    for (const absent of ['TRUTH', 'PSF FIELD', 'PSF ATTRIBUTION', 'DISTORTION', 'ATMOSPHERIC', 'METADATA']) {
      expect(t).not.toContain(absent);
    }
    // a fully-absent receipt → no groups at all (never a placeholder panel)
    expect(buildGroups({}).length).toBe(0);
    // a solution whose optional fields are all null → no fabricated RA/DEC/scale tiles
    const g = buildGroups({ solution: { locked: false } });
    const labels = tileLabels(g);
    expect(labels['SOLVE/PLATE SOLVE']).toBe('NO-LOCK');
    expect(labels['SOLVE/RA']).toBeUndefined();
    expect(labels['SOLVE/SCALE']).toBeUndefined();
  });

  it('reads tracking inference (TRACKED / UNTRACKED) and drops NOT_MEASURED', () => {
    const mk = (inf: string) => buildGroups({ psf_attribution: { tracking: { inference: inf } } });
    const lab = (inf: string) => tileLabels(mk(inf))['PSF ATTRIBUTION/TRACKING'];
    expect(lab('TRACKED')).toBe('TRACKED');
    expect(lab('UNTRACKED')).toBe('UNTRACKED');
    // NOT_MEASURED must not produce a tracking tile (honest-absent)
    expect(mk('NOT_MEASURED').length).toBe(0);
  });
});
