// ═══════════════════════════════════════════════════════════════════════════
// HORIZON PREDICT — the sextant rung-1 up-reference generator.
// From an observer (lat, lon, height_above_ground) walk a great-circle ray at
// every azimuth and find the maximum terrain elevation ANGLE, correcting for
// Earth curvature + standard atmospheric refraction. Emits a terrain-horizon
// profile {az, alt_deg, distance_km_of_ridge, …} as JSON + a silhouette SVG.
// This is what a measured horizon (m4_signal_detect/horizon_envelope) is matched
// AGAINST to recover / validate observer orientation & location.
// ═══════════════════════════════════════════════════════════════════════════
//
// Geometry per ray sample at ground distance d (m) with terrain height h_t (m):
//   apparent_drop = (1 - k) · d² / (2R)     [Earth curvature reduced by refraction]
//   Δh            = h_t - eye_elev - apparent_drop
//   alt           = atan2(Δh, d)
// The horizon altitude at an azimuth = max(alt) over the ray; the sample that
// produced it is the "ridge" (its distance + elevation are recorded).
//
// Refraction coefficient k = 0.13 is an INITIAL ENGINEERING VALUE: the standard
// visible-band terrestrial mean (effective radius R_eff = R/(1-k) ≈ 1.15 R). The
// often-quoted "4/3 Earth radius" is the RADIO convention (k ≈ 0.25) and is too
// strong for optical terrain horizons. k is a knob (real refraction varies with
// the low-level temperature gradient) — this is a nominal, not a measurement.
//
// OFFLINE-FIRST: reads only the fetcher's tile cache. A ray leaving cached
// coverage yields null samples (honest-absent), never zero terrain.
//
// USAGE:
//   node tools/dtm/horizon_predict.mjs --lat 34.15 --lon -118.14
//   node tools/dtm/horizon_predict.mjs --lat 34.15 --lon -118.14 --height 2 \
//        --maxkm 100 --azstep 0.5 --step 0.03 --out test_results/dtm
//   node tools/dtm/horizon_predict.mjs --lat 34.15 --lon -118.14 --fetch  # fetch tiles first

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elevationAt, profileAlong, EARTH_R_KM } from './dtm_sampler.mjs';
import { ensureTiles, DEFAULT_CACHE_DIR } from './fetch_dtm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const R_M = EARTH_R_KM * 1000;

/**
 * Compute a terrain-horizon profile. Pure function of (inputs + cached tiles) —
 * no wall-clock enters the result, so identical inputs → byte-identical output.
 * Returns { observer, params, horizon: [{az, alt_deg, distance_km_of_ridge,
 * ridge_elev_m, ridge_lat, ridge_lon}] }. alt_deg is null where a whole ray has
 * no terrain data (honest-absent).
 */
export function predictHorizon(opts = {}) {
  const {
    lat, lon,
    heightAgl = 2,
    azStepDeg = 0.5,
    maxKm = 100,
    stepKm = 0.03,
    refractionK = 0.13,
    cacheDir = DEFAULT_CACHE_DIR,
  } = opts;
  if (lat == null || lon == null) throw new Error('predictHorizon needs lat and lon');

  const groundElev = elevationAt(lat, lon, { cacheDir });
  if (groundElev == null) {
    throw new Error(`observer elevation unavailable at ${lat},${lon} — the covering tile is not cached (fetch it first) or is void`);
  }
  const eyeElev = groundElev + heightAgl;
  const dropK = 1 - refractionK; // apparent-drop factor

  const horizon = [];
  const nAz = Math.round(360 / azStepDeg);
  for (let i = 0; i < nAz; i++) {
    const az = i * azStepDeg;
    const ray = profileAlong(lat, lon, az, maxKm, stepKm, { cacheDir });
    let bestAlt = -Infinity;
    let ridge = null;
    for (const s of ray) {
      if (s.distKm === 0 || s.elev == null) continue;
      const dM = s.distKm * 1000;
      const drop = (dropK * dM * dM) / (2 * R_M);
      const dh = s.elev - eyeElev - drop;
      const alt = Math.atan2(dh, dM) * (180 / Math.PI);
      if (alt > bestAlt) {
        bestAlt = alt;
        ridge = { alt, distKm: s.distKm, elev: s.elev, lat: s.lat, lon: s.lon };
      }
    }
    horizon.push(ridge
      ? {
          az: +az.toFixed(4),
          alt_deg: +ridge.alt.toFixed(4),
          distance_km_of_ridge: +ridge.distKm.toFixed(3),
          ridge_elev_m: +ridge.elev.toFixed(1),
          ridge_lat: +ridge.lat.toFixed(6),
          ridge_lon: +ridge.lon.toFixed(6),
        }
      : { az: +az.toFixed(4), alt_deg: null, distance_km_of_ridge: null, ridge_elev_m: null, ridge_lat: null, ridge_lon: null });
  }

  return {
    observer: {
      lat, lon,
      ground_elev_m: +groundElev.toFixed(1),
      height_agl_m: heightAgl,
      eye_elev_m: +eyeElev.toFixed(1),
    },
    params: {
      az_step_deg: azStepDeg,
      max_km: maxKm,
      step_km: stepKm,
      refraction_k: refractionK,
      refraction_note:
        'apparent curvature drop = (1-k)·d²/(2R); k=0.13 = INITIAL ENGINEERING VALUE ' +
        '(visible-band terrestrial mean, R_eff=R/(1-k)≈1.15R). 4/3-Earth (radio) ≈ k=0.25.',
      earth_radius_m: R_M,
    },
    horizon,
  };
}

/** Top-N ridge points by altitude (skips null azimuths). */
export function topRidges(result, n = 5) {
  return result.horizon
    .filter((p) => p.alt_deg != null)
    .slice()
    .sort((a, b) => b.alt_deg - a.alt_deg)
    .slice(0, n);
}

/** Render the horizon profile as a self-contained silhouette-strip SVG. */
export function horizonToSvg(result, { width = 1000, height = 340 } = {}) {
  const pts = result.horizon;
  const alts = pts.filter((p) => p.alt_deg != null).map((p) => p.alt_deg);
  const aMin = Math.min(-1, Math.floor(Math.min(...alts)));
  const aMax = Math.max(2, Math.ceil(Math.max(...alts)));
  const M = { l: 48, r: 16, t: 40, b: 34 };
  const W = width - M.l - M.r;
  const H = height - M.t - M.b;
  const x = (az) => M.l + (az / 360) * W;
  const y = (alt) => M.t + (1 - (alt - aMin) / (aMax - aMin)) * H;

  // filled silhouette (terrain below the horizon line); break the path at gaps
  let d = '';
  let open = false;
  for (const p of pts) {
    if (p.alt_deg == null) { open = false; continue; }
    d += `${open ? 'L' : 'M'}${x(p.az).toFixed(1)},${y(p.alt_deg).toFixed(1)} `;
    open = true;
  }

  // cardinal gridlines
  const cards = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N']];
  let vlines = '';
  for (const [az, lbl] of cards) {
    vlines += `<line x1="${x(az).toFixed(1)}" y1="${M.t}" x2="${x(az).toFixed(1)}" y2="${M.t + H}" stroke="#c9d1d9" stroke-width="0.7"/>`;
    vlines += `<text x="${x(az).toFixed(1)}" y="${M.t + H + 20}" font-size="12" text-anchor="middle" fill="#57606a">${lbl}</text>`;
  }
  // altitude gridlines
  let hlines = '';
  for (let a = aMin; a <= aMax; a++) {
    hlines += `<line x1="${M.l}" y1="${y(a).toFixed(1)}" x2="${M.l + W}" y2="${y(a).toFixed(1)}" stroke="${a === 0 ? '#8b949e' : '#eaeef2'}" stroke-width="${a === 0 ? 1 : 0.6}"/>`;
    hlines += `<text x="${M.l - 6}" y="${(y(a) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#57606a">${a}°</text>`;
  }
  const o = result.observer;
  const title = `Terrain horizon — obs ${o.lat}, ${o.lon} · eye ${o.eye_elev_m} m · max ${result.params.max_km} km · k=${result.params.refraction_k}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="system-ui,sans-serif">
<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
<text x="${M.l}" y="24" font-size="14" fill="#24292f">${title}</text>
${hlines}${vlines}
<path d="${d.trim()} L${x(360).toFixed(1)},${(M.t + H).toFixed(1)} L${x(0).toFixed(1)},${(M.t + H).toFixed(1)} Z" fill="#8fbf8f" fill-opacity="0.55" stroke="none"/>
<path d="${d.trim()}" fill="none" stroke="#2f6b2f" stroke-width="1.3"/>
</svg>`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['fetch']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); if (flags.has(k)) a[k] = true; else a[k] = argv[++i]; }
    else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.lat == null || args.lon == null) {
    console.error('usage: --lat <deg> --lon <deg> [--height 2] [--maxkm 100] [--azstep 0.5] [--step 0.03] [--out dir] [--fetch]');
    process.exit(1);
  }
  const lat = parseFloat(args.lat);
  const lon = parseFloat(args.lon);
  const maxKm = args.maxkm != null ? parseFloat(args.maxkm) : 100;
  const cacheDir = args.cache ? path.resolve(args.cache) : DEFAULT_CACHE_DIR;
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'test_results', 'dtm');

  if (args.fetch) {
    console.log(`fetching tiles for ${maxKm} km disk around ${lat},${lon} …`);
    const res = await ensureTiles(lat, lon, maxKm, { cacheDir });
    for (const r of res) console.log(`  ${r.status.padEnd(8)} ${r.name}${r.error ? '  ' + r.error : ''}`);
  }

  const result = predictHorizon({
    lat, lon,
    heightAgl: args.height != null ? parseFloat(args.height) : 2,
    azStepDeg: args.azstep != null ? parseFloat(args.azstep) : 0.5,
    maxKm,
    stepKm: args.step != null ? parseFloat(args.step) : 0.03,
    refractionK: args.k != null ? parseFloat(args.k) : 0.13,
    cacheDir,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'horizon_profile.json');
  const svgPath = path.join(outDir, 'horizon_profile.svg');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(svgPath, horizonToSvg(result));

  const valid = result.horizon.filter((p) => p.alt_deg != null);
  console.log(`\nobserver eye elevation: ${result.observer.eye_elev_m} m (ground ${result.observer.ground_elev_m} + ${result.observer.height_agl_m} AGL)`);
  console.log(`azimuths: ${result.horizon.length} · with terrain: ${valid.length} · null: ${result.horizon.length - valid.length}`);
  console.log('\ntop-5 ridges (highest horizon altitude):');
  console.log('  az°   alt°   dist_km   elev_m   at (lat, lon)');
  for (const p of topRidges(result, 5)) {
    console.log(`  ${String(p.az).padStart(5)} ${String(p.alt_deg).padStart(6)} ${String(p.distance_km_of_ridge).padStart(8)} ${String(p.ridge_elev_m).padStart(8)}   ${p.ridge_lat}, ${p.ridge_lon}`);
  }
  console.log(`\nwrote ${path.relative(ROOT, jsonPath)}  +  ${path.relative(ROOT, svgPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
