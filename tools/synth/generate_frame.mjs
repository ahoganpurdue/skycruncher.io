// ═══════════════════════════════════════════════════════════════════════════
// SYNTH LANE — REVERSE PIPELINE v0 : the synthetic frame generator
// ═══════════════════════════════════════════════════════════════════════════
// location + time + pointing  →  REAL star field (atlas)  →  MEASURED rig
// transforms RUN FORWARD (linear WCS → Brown-Conrady distortion → elliptical
// PSF → sky+vignette+noise)  →  a FITS the engine ingests TODAY + a TRUTH
// SIDECAR that lets any solver/estimator be SCORED against ground truth.
//
// This is the inverse of the plate-solver: instead of image → WCS, it runs
// WCS → image, so every acceptance number downstream can be measured against a
// KNOWN answer. All coordinate math is REUSED from the live tools/ primitives
// (loadCatalog/projectStars/cdFrom, makeBrownConrady) — nothing geometric is
// reimplemented (CLAUDE.md LAW 4). Same seed ⇒ byte-identical frame.
//
//   node tools/synth/generate_frame.mjs --rig narrow_seestar --out <dir> [opts]
//   node tools/synth/generate_frame.mjs --selftest        # determinism proof
//
// TWO-LEDGER NOTE: the COORDINATE half (sky → distorted native pixel positions)
// and the PIXEL half (PSF/sky/noise onto a plane) are separate stages, composed
// only at the final "place PSF at solved position" seam — the same law the live
// render loop obeys.
//
// v0 SCOPE / HONESTY (see README for the full table):
//   • geometry / plate scale        REAL
//   • Brown-Conrady k1/k2           MEASURED (pooled Rokinon) or NOMINAL
//   • PSF shape, sky, noise         SYNTHETIC-ENGINEERING (plausible, not measured)
//   • extinction k                  APPROXIMATE (measured-k slot documented)
//   • FITS container                BITPIX=-32 3-plane (the Siril/community form
//                                   the wizard ingests); CR2/CFA container = v0.5.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, cdFrom, cdMetrics, rng, isMain } from '../solverkit/common.mjs';
import { projectStars } from '../psf/forced_detect.mjs';
import { makeBrownConrady, makeIdentityCoordFn } from '../psf/corrections.mjs';
import { writeFitsPlanar } from '../stack/fits_io.mjs';
import { resolveRig, scaleFromOptics, focalLenForScale } from './rig_profiles.mjs';
import { magToFlux, placeStar, addSkyVignetteNoise } from './render.mjs';
import { altAzToRaDec, raDecToAltDeg, airmassKastenYoung, D2R } from './astro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── SYNTHETIC-ENGINEERING defaults (every one is a plausible knob, not measured)
export const DEFAULT_PHOTOMETRY = Object.freeze({
  magRef: 13.0,          // reference magnitude for the flux zero-point
  fluxRef: 1400.0,       // total counts for a magRef star (sets SNR at the faint end)
  background: 220.0,     // sky level (counts) before vignette
  readNoise: 8.0,        // read-noise σ (counts)
  saturation: 60000.0,   // per-pixel well depth (bright cores clip — realistic bloom)
  magLimit: 13.0,        // catalog depth injected (honest: atlas floors near mag ~12.5)
});

// APPROXIMATE differential-extinction coefficient (mag/airmass). The MEASURED-k
// slot: when the atmosphere lane lands a real k, it drops in here.
export const DEFAULT_EXTINCTION_K = 0.15;

const R2H = 1 / 15; // degrees → hours

/**
 * Generate one synthetic frame + truth sidecar.
 * @returns { fitsPath, truthPath, truth } (paths null when write:false)
 */
export function generateFrame(opts) {
  const {
    rig: rigKey = 'narrow_seestar',
    seed = 20260709,
    // pointing: either {raDeg,decDeg} OR {altDeg,azDeg} + {lat,lon,utc}
    raDeg = null, decDeg = null, altDeg = null, azDeg = null,
    lat = 46.2184, lon = -84.068, utc = '2026-05-16T03:54:45Z',
    rotationDeg = 0, parity = 1,
    gotoOffsetDeg = 0.1,   // realistic telescope goto error baked into the FITS hint
    extinctionK = DEFAULT_EXTINCTION_K,
    photometry: photoOverride = {},
    outDir = path.join(REPO_ROOT, 'test_results', 'synth'),
    name = null,
    write = true,
    root = REPO_ROOT,
  } = opts || {};

  const rig = resolveRig(rigKey);
  // a rig may pin a brighter magLimit (e.g. ultra-wide bright subset); explicit
  // photometry override still wins over both.
  const photo = { ...DEFAULT_PHOTOMETRY, ...(rig.magLimit != null ? { magLimit: rig.magLimit } : {}), ...photoOverride };
  const w = rig.width, h = rig.height;

  // ── 1) POINTING → RA/Dec center (deg) ──────────────────────────────────────
  const date = new Date(utc);
  let cRaDeg, cDecDeg, pointingMode;
  if (raDeg != null && decDeg != null) {
    cRaDeg = raDeg; cDecDeg = decDeg; pointingMode = 'radec';
  } else if (altDeg != null && azDeg != null) {
    const s = altAzToRaDec(altDeg, azDeg, lat, lon, date);
    cRaDeg = s.raDeg; cDecDeg = s.decDeg; pointingMode = 'altaz';
  } else {
    throw new Error('pointing required: pass {raDeg,decDeg} or {altDeg,azDeg}+{lat,lon,utc}');
  }

  // ── 2) plate scale (REAL, from the rig optics — the metrology identity) ─────
  const scaleArcsec = scaleFromOptics(rig.focalLenMm, rig.pixelPitchUm);

  // ── 3) linear WCS (solverkit convention: crval DEG, crpix px, cd deg/px) ────
  const trueWcs = {
    crval: [cRaDeg, cDecDeg],
    crpix: [(w - 1) / 2, (h - 1) / 2],
    cd: cdFrom(scaleArcsec, rotationDeg, parity),
  };

  // ── 4) atlas field (mag-limited honestly at the atlas depth) ────────────────
  const radiusDeg = (Math.hypot(w, h) / 2) * scaleArcsec / 3600 + 0.5;
  const { stars, sectorsLoaded } = loadCatalog({
    raDeg: cRaDeg, decDeg: cDecDeg, radiusDeg, magLimit: photo.magLimit,
  });

  // ── 5) forward distortion — project through linear WCS then BC toNative ─────
  // projectStars applies coordFn.toNative(x,y) internally: the exact forward of
  // the solver's un-distort inverse (same k1/k2 ⇒ solver recovers this linear WCS).
  const coordFn = rig.bc
    ? makeBrownConrady(rig.bc.k1, rig.bc.k2, w, h)
    : makeIdentityCoordFn(w, h);
  const inFrame = projectStars({ stars, wcs: trueWcs, coordFn, w, h, margin: 2 });

  // measure the max corner distortion actually applied (evidence, not asserted)
  let maxShiftPx = 0;
  if (rig.bc) {
    const pt = [0, 0];
    for (const s of inFrame) {
      // s.x,s.y are ALREADY native; recover the ideal by toCorrected to measure shift
      coordFn.toCorrected(s.x, s.y, pt);
      const d = Math.hypot(s.x - pt[0], s.y - pt[1]);
      if (d > maxShiftPx) maxShiftPx = d;
    }
  }

  // ── 6) extinction gradient (APPROXIMATE k) — per-star airmass dimming ────────
  // Relative to the field-center airmass so the CENTER is unchanged and only the
  // differential (edge-to-edge) gradient shows — the honest observable effect.
  const centerAlt = raDecToAltDeg(cRaDeg, cDecDeg, lat, lon, date);
  const centerX = airmassKastenYoung(centerAlt);
  const applyExt = extinctionK > 0 && Number.isFinite(centerX);

  // ── 7) render PIXELS (PSF placement + extinction, then sky/vignette/noise) ──
  const rand = rng(seed >>> 0);
  const lum = new Float32Array(w * h);
  const psfMajor = rig.psf.fwhmPx;
  const psfMinor = rig.psf.fwhmPx * (1 - (rig.psf.ellipticity ?? 0));
  const sigMajor = psfMajor / 2.354820045, sigMinor = psfMinor / 2.354820045;
  const theta = (rig.psf.thetaDeg ?? 0) * D2R;
  const injected = [];
  for (const s of inFrame) {
    let flux = photo.fluxRef * Math.pow(10, -0.4 * (s.mag - photo.magRef));
    if (applyExt) {
      const alt = raDecToAltDeg(s.ra_deg, s.dec_deg, lat, lon, date);
      const X = airmassKastenYoung(alt);
      if (Number.isFinite(X)) flux *= Math.pow(10, -0.4 * extinctionK * (X - centerX));
    }
    placeStar(lum, w, h, s.x, s.y, flux, sigMajor, sigMinor, theta);
    injected.push({
      ra_deg: +s.ra_deg.toFixed(6), dec_deg: +s.dec_deg.toFixed(6), mag: +s.mag.toFixed(3),
      x: +s.x.toFixed(3), y: +s.y.toFixed(3), flux: +flux.toFixed(2),
      gaia_id: s.gaia_id ?? null,
    });
  }
  addSkyVignetteNoise(lum, w, h, {
    background: photo.background, readNoise: photo.readNoise, vignette: rig.vignette, rand,
  });
  // sensor saturation (bright cores clip flat — realistic + bounds dynamic range)
  for (let i = 0; i < lum.length; i++) if (lum[i] > photo.saturation) lum[i] = photo.saturation;

  // ── 8) FITS header hints (mirror the SeeStar cards the wizard reads) ────────
  // NO WCS is written (no CRVAL/CD) — the solve stays blind. FOCALLEN+XPIXSZ give
  // the metrology SCALE prior; RA/DEC = a COARSE goto hint offset from truth by
  // gotoOffsetDeg (a real mount's pointing error) so a recovered-center == truth
  // proves the solver refined, never echoed the header.
  const gotoRaDeg = ((cRaDeg + gotoOffsetDeg) % 360 + 360) % 360;
  const gotoDecDeg = Math.max(-90, Math.min(90, cDecDeg + gotoOffsetDeg));
  const cards = [
    ['FOCALLEN', rig.focalLenMm, 'mm (metrology scale prior)'],
    ['XPIXSZ', rig.pixelPitchUm, 'micron pixel pitch'],
    ['YPIXSZ', rig.pixelPitchUm, 'micron pixel pitch'],
    ['GAIN', 200, 'synthetic gain setting'],
    ['EXPTIME', 60.0, 's (synthetic)'],
    ['EXPOSURE', 60.0, 's (synthetic)'],
    ['DATE-OBS', new Date(utc).toISOString().replace('Z', ''), 'UTC (synthetic)'],
    ['SITELAT', +lat.toFixed(6), 'deg'],
    ['SITELONG', +lon.toFixed(6), 'deg'],
    ['RA', +gotoRaDeg.toFixed(6), 'deg COARSE goto hint (NOT truth)'],
    ['DEC', +gotoDecDeg.toFixed(6), 'deg COARSE goto hint (NOT truth)'],
    ['INSTRUME', rig.instrume, 'synthetic camera'],
    ['TELESCOP', rig.telescop, 'synthetic optics'],
    ['CREATOR', 'SkyCruncher tools/synth v0', 'reverse-pipeline generator'],
    ['OBJECT', 'SYNTHETIC', 'not a real observation'],
    ['IMAGETYP', 'Light', 'synthetic light frame'],
    ['SYNTHGEN', 'tools/synth/generate_frame.mjs', 'PROVENANCE: synthetic frame'],
    ['SYNTHSED', seed, 'PRNG seed (determinism)'],
  ];

  // ── 9) truth sidecar — EVERYTHING needed to score any solver/estimator ──────
  const m = cdMetrics(trueWcs.cd);
  const baseName = name || `synth_${rig.label}_${seed}`;
  const truth = {
    schema: 'skycruncher.synth.truth/0',
    tool: 'tools/synth/generate_frame.mjs',
    deterministic: true, generatedAtUnix: null,
    note: 'generatedAtUnix intentionally null — a timestamp would break byte-reproducibility (honest-or-absent).',
    seed,
    frame: { width: w, height: h, planes: 3, bitpix: -32 },
    wcs_truth: {
      convention: 'crval in DEGREES ([RA_deg, Dec_deg]); crpix 0-based pixel center; cd in deg/px',
      crval_deg: [+cRaDeg.toFixed(9), +cDecDeg.toFixed(9)],
      ra_hours: +(cRaDeg * R2H).toFixed(9),
      dec_degrees: +cDecDeg.toFixed(9),
      crpix: trueWcs.crpix.map((v) => +v.toFixed(3)),
      cd: trueWcs.cd,
      pixel_scale_arcsec: +scaleArcsec.toFixed(9),
      rotation_deg: +m.rotation.toFixed(6), parity: m.parity,
    },
    pointing: {
      mode: pointingMode, lat, lon, utc,
      alt_deg: altDeg, az_deg: azDeg,
      center_altitude_deg: +centerAlt.toFixed(4), center_airmass: +centerX.toFixed(4),
      goto_hint_deg: [+gotoRaDeg.toFixed(6), +gotoDecDeg.toFixed(6)], goto_offset_deg: gotoOffsetDeg,
    },
    rig: {
      label: rig.label, note: rig.note,
      focal_length_mm: rig.focalLenMm, pixel_pitch_um: rig.pixelPitchUm,
      psf: rig.psf, vignette: rig.vignette,
    },
    distortion: rig.bc
      ? { model: 'brown-conrady', k1: rig.bc.k1, k2: rig.bc.k2, provenance: rig.bc.provenance, max_corner_shift_px: +maxShiftPx.toFixed(3) }
      : { model: 'identity', provenance: 'no distortion (negligible for this rig)' },
    extinction: applyExt
      ? { coefficient_k_mag_per_airmass: extinctionK, provenance: 'APPROXIMATE (measured-k slot documented)', center_airmass: +centerX.toFixed(4) }
      : { applied: false, provenance: 'off or center below horizon' },
    photometry: {
      note: 'SYNTHETIC-ENGINEERING flux/noise model (plausible, not measured)',
      mag_ref: photo.magRef, flux_ref: photo.fluxRef, background: photo.background,
      read_noise: photo.readNoise, saturation: photo.saturation, mag_law: 'flux=fluxRef*10^(-0.4*(mag-magRef))',
    },
    catalog: {
      source: 'public/atlas (HYBRID Gaia deg / HYG hours — normalized to ra_deg by loadAtlasRegion)',
      mag_limit: photo.magLimit, sectors_loaded: sectorsLoaded,
      in_frame_count: injected.length, loaded_count: stars.length,
    },
    injected_stars: injected,
    honesty: {
      geometry: 'REAL', plate_scale: 'REAL', brown_conrady: rig.bc ? rig.bc.provenance : 'N/A (identity)',
      psf: 'SYNTHETIC-ENGINEERING', sky_background: 'SYNTHETIC-ENGINEERING', noise: 'SYNTHETIC-ENGINEERING (Poisson≈Gaussian shot + Gaussian read)',
      extinction_k: 'APPROXIMATE', fits_container: 'BITPIX=-32 3-plane (wizard-ingestible); CR2/CFA = v0.5',
      alt_az_math: 'standard Meeus (engine TimeService parity = v1 slot)',
    },
  };

  let fitsPath = null, truthPath = null;
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fitsPath = path.join(outDir, `${baseName}.fits`);
    truthPath = path.join(outDir, `${baseName}.truth.json`);
    writeFitsPlanar(fitsPath, [lum, lum, lum], w, h, cards);
    fs.writeFileSync(truthPath, JSON.stringify(truth, null, 2));
  }
  return { fitsPath, truthPath, truth, lum, width: w, height: h };
}

// ── determinism self-test: same seed ⇒ byte-identical plane + sidecar ─────────
function selftest() {
  const a = generateFrame({ rig: 'narrow_seestar', seed: 4242, raDeg: 170.425, decDeg: 12.842, write: false });
  const b = generateFrame({ rig: 'narrow_seestar', seed: 4242, raDeg: 170.425, decDeg: 12.842, write: false });
  let identical = a.lum.length === b.lum.length;
  for (let i = 0; identical && i < a.lum.length; i++) if (a.lum[i] !== b.lum[i]) identical = false;
  const truthSame = JSON.stringify(a.truth) === JSON.stringify(b.truth);
  const c = generateFrame({ rig: 'narrow_seestar', seed: 4243, raDeg: 170.425, decDeg: 12.842, write: false });
  let differs = false;
  for (let i = 0; i < a.lum.length; i++) if (a.lum[i] !== c.lum[i]) { differs = true; break; }
  console.log(`[synth selftest] plane byte-identical (same seed): ${identical}`);
  console.log(`[synth selftest] truth sidecar identical (same seed): ${truthSame}`);
  console.log(`[synth selftest] different seed ⇒ different plane: ${differs}`);
  console.log(`[synth selftest] in-frame stars: ${a.truth.catalog.in_frame_count}`);
  const pass = identical && truthSame && differs;
  console.log(`[synth selftest] RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { a[key] = true; }
    else { a[key] = next; i++; }
  }
  return a;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { process.exit(selftest() ? 0 : 1); }
  const opts = {
    rig: args.rig || 'narrow_seestar',
    seed: args.seed != null ? +args.seed : 20260709,
    raDeg: args.ra != null ? +args.ra : null,
    decDeg: args.dec != null ? +args.dec : null,
    altDeg: args.alt != null ? +args.alt : null,
    azDeg: args.az != null ? +args.az : null,
    lat: args.lat != null ? +args.lat : undefined,
    lon: args.lon != null ? +args.lon : undefined,
    utc: args.utc || undefined,
    rotationDeg: args.rot != null ? +args.rot : 0,
    gotoOffsetDeg: args.goto != null ? +args.goto : 0.1,
    outDir: args.out || undefined,
    name: args.name || null,
  };
  // default pointing for each rig if none given (M66 field, well-populated)
  if (opts.raDeg == null && opts.altDeg == null) { opts.raDeg = 170.425; opts.decDeg = 12.842; }
  const { fitsPath, truthPath, truth } = generateFrame(opts);
  console.log(`[synth] rig=${truth.rig.label} seed=${truth.seed} ${truth.frame.width}x${truth.frame.height}`);
  console.log(`[synth] center RA=${truth.wcs_truth.ra_hours}h Dec=${truth.wcs_truth.dec_degrees}° scale=${truth.wcs_truth.pixel_scale_arcsec}"/px rot=${truth.wcs_truth.rotation_deg}°`);
  console.log(`[synth] in-frame stars=${truth.catalog.in_frame_count} distortion=${truth.distortion.model}${truth.distortion.max_corner_shift_px != null ? ` (max shift ${truth.distortion.max_corner_shift_px}px)` : ''}`);
  console.log(`[synth] FITS  → ${fitsPath}`);
  console.log(`[synth] truth → ${truthPath}`);
}
