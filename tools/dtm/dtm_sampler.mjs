// ═══════════════════════════════════════════════════════════════════════════
// DTM SAMPLER — read cached skadi .hgt tiles and sample elevation.
//   • elevationAt(lat, lon)         → bilinear-interpolated metres, or null (void/absent)
//   • profileAlong(lat, lon, az, …) → elevation samples along a great-circle ray
// Pure reader over the fetcher's cache (tools/dtm/fetch_dtm.mjs). No network I/O:
// a tile that isn't cached yields null (HONEST-ABSENT — never zero-filled).
// ═══════════════════════════════════════════════════════════════════════════
//
// Tile geometry (see fetch_dtm.mjs): a tile named for its SW corner covers
// [latBase, latBase+1] × [lonBase, lonBase+1]. The grid has DIM samples per
// side (DIM inferred from file length: 3601 SRTM1 / 1201 SRTM3), so (DIM-1)
// intervals span exactly 1°. Row 0 = NORTH edge (lat = latBase+1), col 0 = WEST
// edge (lon = lonBase). Adjacent tiles DUPLICATE their shared edge row/col, so
// clamping an index to the tile edge is correct at boundaries.

import fs from 'node:fs';
import { DEFAULT_CACHE_DIR, VOID, tileNameFor, parseTileName, tilePaths } from './fetch_dtm.mjs';

const EARTH_R_KM = 6371.0088; // IUGG mean radius

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ── tile cache (module-level; keyed by absolute .hgt path) ────────────────────
const _tiles = new Map();
const _warnedMissing = new Set();

/** Clear the in-memory tile cache (tests / long-running processes). */
export function clearTileCache() { _tiles.clear(); _warnedMissing.clear(); }

/**
 * Load a tile into memory (cached). Returns { name, dim, buf, latBase, lonBase }
 * or null if the .hgt isn't in the cache (honest-absent; the sampler never fetches).
 */
export function loadTile(name, cacheDir = DEFAULT_CACHE_DIR) {
  const { hgt } = tilePaths(name, cacheDir);
  if (_tiles.has(hgt)) return _tiles.get(hgt);
  if (!fs.existsSync(hgt)) {
    if (!_warnedMissing.has(hgt)) {
      _warnedMissing.add(hgt);
      process.stderr.write(`[dtm_sampler] tile ${name} not cached (${hgt}) — samples there return null. Fetch it: node tools/dtm/fetch_dtm.mjs --tile ${name}\n`);
    }
    _tiles.set(hgt, null);
    return null;
  }
  const buf = fs.readFileSync(hgt);
  const samples = buf.length / 2;
  const dim = Math.round(Math.sqrt(samples));
  if (dim * dim !== samples) throw new Error(`tile ${name}: ${buf.length} bytes is not a square int16 grid`);
  const { latBase, lonBase } = parseTileName(name);
  const tile = { name, dim, buf, latBase, lonBase };
  _tiles.set(hgt, tile);
  return tile;
}

/** Raw int16 sample at integer (row, col); VOID sentinel passes through. */
function rawSample(tile, row, col) {
  return tile.buf.readInt16BE((row * tile.dim + col) * 2);
}

/**
 * Bilinearly-interpolated elevation in metres at (lat, lon), or null if the
 * covering tile is absent OR any of the four surrounding posts is a void
 * (conservative honest-absent — we never interpolate across a data gap).
 */
export function elevationAt(lat, lon, opts = {}) {
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const tile = loadTile(tileNameFor(lat, lon), cacheDir);
  if (!tile) return null;
  const { dim, latBase, lonBase } = tile;
  const n = dim - 1;

  // Fractional grid position. row grows southward, col grows eastward.
  let row = (latBase + 1 - lat) * n;
  let col = (lon - lonBase) * n;
  // Guard tiny FP excursions outside [0, n].
  row = Math.min(n, Math.max(0, row));
  col = Math.min(n, Math.max(0, col));

  // Anchor cell, clamped so (r0+1, c0+1) stay in-grid (edge posts are shared
  // with the neighbour tile, so clamping there is exact).
  const r0 = Math.min(n - 1, Math.floor(row));
  const c0 = Math.min(n - 1, Math.floor(col));
  const fr = row - r0;
  const fc = col - c0;

  const v00 = rawSample(tile, r0, c0);
  const v01 = rawSample(tile, r0, c0 + 1);
  const v10 = rawSample(tile, r0 + 1, c0);
  const v11 = rawSample(tile, r0 + 1, c0 + 1);
  if (v00 === VOID || v01 === VOID || v10 === VOID || v11 === VOID) return null;

  const top = v00 * (1 - fc) + v01 * fc;
  const bot = v10 * (1 - fc) + v11 * fc;
  return top * (1 - fr) + bot * fr;
}

// ── great-circle stepping ────────────────────────────────────────────────────

/**
 * Destination point a distance `distKm` from (lat, lon) along initial bearing
 * `azimuthDeg` (0=N, 90=E), on a sphere. Fine at terrestrial horizon scales.
 */
export function destPoint(lat, lon, azimuthDeg, distKm) {
  const dr = distKm / EARTH_R_KM; // angular distance
  const phi1 = lat * D2R;
  const lam1 = lon * D2R;
  const th = azimuthDeg * D2R;
  const sinPhi2 = Math.sin(phi1) * Math.cos(dr) + Math.cos(phi1) * Math.sin(dr) * Math.cos(th);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const lam2 = lam1 + Math.atan2(
    Math.sin(th) * Math.sin(dr) * Math.cos(phi1),
    Math.cos(dr) - Math.sin(phi1) * sinPhi2,
  );
  let lonOut = lam2 * R2D;
  lonOut = ((lonOut + 540) % 360) - 180; // normalize to [-180, 180)
  return { lat: phi2 * R2D, lon: lonOut };
}

/**
 * Elevation samples along a great-circle ray from (lat, lon) toward azimuthDeg.
 * Returns [{ distKm, lat, lon, elev|null }] from distKm=0 to maxKm inclusive,
 * spaced stepKm. Voids / uncached tiles surface as elev:null (honest-absent).
 */
export function profileAlong(lat, lon, azimuthDeg, maxKm, stepKm = 0.03, opts = {}) {
  if (!(stepKm > 0)) throw new Error('stepKm must be > 0');
  const out = [];
  const nSteps = Math.floor(maxKm / stepKm + 1e-9);
  for (let i = 0; i <= nSteps; i++) {
    const d = i * stepKm;
    const p = d === 0 ? { lat, lon } : destPoint(lat, lon, azimuthDeg, d);
    out.push({ distKm: d, lat: p.lat, lon: p.lon, elev: elevationAt(p.lat, p.lon, opts) });
  }
  return out;
}

export { EARTH_R_KM };
