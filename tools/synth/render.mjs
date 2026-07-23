// ═══════════════════════════════════════════════════════════════════════════
// SYNTH LANE — PIXEL RENDERER  (PIXEL ledger: star/background/noise → a plane)
// ═══════════════════════════════════════════════════════════════════════════
// Renders elliptical-Gaussian stars at their (already distorted) native pixel
// positions onto a Float32 luminance plane, then lays sky + vignette + shot/read
// noise on top. EVERY numeric knob here is SYNTHETIC-ENGINEERING (a plausible
// sensor model, NOT a measured one) EXCEPT the vignette polynomial shape, which
// reuses corrections.mjs::vignetteGain (the same evaluator the flatness lane
// fits). All randomness comes from the shared seeded mulberry32 (common.mjs rng)
// via Box-Muller — same seed ⇒ byte-identical plane.
//
// mag→flux is the synthetic_inject.mjs calibration (anchored to the bundled-CR2
// dynamic range) so a synth frame sits in the same flux regime the detector was
// tuned on.

import { vignetteGain } from '../psf/corrections.mjs';

const FWHM_TO_SIGMA = 1 / 2.354820045; // 2*sqrt(2 ln 2)

// ── mag → synthetic flux (total counts) ──────────────────────────────────────
// flux = F0 · 10^(−0.4·(mag−MAG0)) — matches synthetic_inject.mjs (MAG0=6, F0=10).
const MAG0 = 6.0, FLUX_AT_MAG0 = 10.0;
export function magToFlux(mag) { return FLUX_AT_MAG0 * Math.pow(10, -0.4 * (mag - MAG0)); }

/** Deterministic standard-normal from the shared uniform PRNG (Box-Muller). */
export function gaussianFrom(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Accumulate one elliptical-Gaussian star of total `flux` at (cx,cy).
 * sigmaMajor/sigmaMinor in px, thetaRad = major-axis position angle.
 * Only a ±windowSigma·σ box is touched (the Gaussian tail is negligible beyond).
 */
export function placeStar(buf, w, h, cx, cy, flux, sigmaMajor, sigmaMinor, thetaRad, windowSigma = 4.5) {
  const ct = Math.cos(thetaRad), st = Math.sin(thetaRad);
  const amp = flux / (2 * Math.PI * sigmaMajor * sigmaMinor); // peak so the 2D integral = flux
  const inv2a = 1 / (2 * sigmaMajor * sigmaMajor);
  const inv2b = 1 / (2 * sigmaMinor * sigmaMinor);
  const rad = Math.ceil(windowSigma * sigmaMajor);
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const xp = dx * ct + dy * st;    // rotate into the PSF frame
      const yp = -dx * st + dy * ct;
      const g = amp * Math.exp(-(xp * xp * inv2a + yp * yp * inv2b));
      buf[y * w + x] += g;
    }
  }
}

/**
 * Lay sky background + vignette throughput + shot(Poisson≈Gaussian) + read noise
 * over the accumulated star-signal plane, in-place, in raster order (fixed draw
 * order ⇒ deterministic). Returns the plane.
 * @param p.background  sky level (counts) BEFORE vignette
 * @param p.readNoise   read-noise σ (counts)
 * @param p.vignette    { a2, a4 } radial gain polynomial (corrections.mjs shape)
 * @param p.rand        shared seeded uniform PRNG
 */
export function addSkyVignetteNoise(buf, w, h, { background, readNoise, vignette, rand }) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const invHd2 = 1 / (cx * cx + cy * cy);
  const gain = vignetteGain(vignette?.a2 ?? 0, vignette?.a4 ?? 0);
  for (let y = 0; y < h; y++) {
    const dy2 = (y - cy) * (y - cy);
    for (let x = 0; x < w; x++) {
      const r2 = ((x - cx) * (x - cx) + dy2) * invHd2; // normalized radius²
      const g = gain(r2);                              // optical throughput ≤ 1 at edges
      const collected = (buf[y * w + x] + background) * g;
      // shot noise on the vignetted photon count (Poisson approximated by its
      // Gaussian limit — labeled SYNTHETIC-ENGINEERING), then additive read noise.
      const shot = Math.sqrt(Math.max(collected, 0)) * gaussianFrom(rand);
      const read = readNoise * gaussianFrom(rand);
      let v = collected + shot + read;
      if (v < 0) v = 0;
      buf[y * w + x] = v;
    }
  }
  return buf;
}
