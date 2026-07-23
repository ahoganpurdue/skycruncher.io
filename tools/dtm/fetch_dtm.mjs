// ═══════════════════════════════════════════════════════════════════════════
// DTM FETCHER — pull elevation tiles (AWS Terrain Tiles, "skadi" format) from
// the web, verify, gunzip, cache, and write a signed-style provenance sidecar.
// Companion to dtm_sampler.mjs (reads the cache) + horizon_predict.mjs.
// ═══════════════════════════════════════════════════════════════════════════
//
// SOURCE (verified empirically 2026-07-09, HEAD + full-tile decode):
//   https://s3.amazonaws.com/elevation-tiles-prod/skadi/{N|S}{lat}/{N|S}{lat}{E|W}{lon}.hgt.gz
//   • 1°×1° tiles, gzipped raw BIG-ENDIAN int16, row-major.
//   • SRTM1-style: 3601×3601 samples (1 arcsec). Void sentinel = -32768.
//   • No auth. Content-Type application/x-gzip. N34W119.hgt.gz = 11.73 MB gz
//     → 25,934,402 bytes raw == 3601²×2 exactly (confirmed).
//   • Tile NAME = the SOUTHWEST corner (lat/lon floored). Data starts at the
//     NORTHWEST corner (row 0 = north edge, col 0 = west edge).
//   The bucket is documented in the mapzen/tilezen `joerd` repo. This scheme
//   was verified against the live bucket before this file was built around it.
//
// DISCIPLINE (mirrors tools/overnight/fetch_intake.mjs):
//   • Named, contactable User-Agent — no anonymous scraping.
//   • Per-tile `<tile>.hgt.provenance.json` sidecar: source URL, dataset+version,
//     fetch time, sha256 (gz AND decoded), byte lengths, elevation range,
//     format spec, and a public-domain license/attribution note.
//   • Idempotent + OFFLINE-FIRST: a cached tile that passes verification is
//     never re-fetched. The fetch is ENRICHMENT — everything downstream
//     (sampler, horizon) works purely from the cache.
//   • Magic/length verification: byte length must equal DIM²×2 for an integer
//     DIM (3601 SRTM1 / 1201 SRTM3), and the non-void elevation range must be
//     physically plausible — a truncated download or HTML error page is rejected
//     and never written as a .hgt.
//
// USAGE:
//   node tools/dtm/fetch_dtm.mjs --lat 34.15 --lon -118.14 --radius 100
//   node tools/dtm/fetch_dtm.mjs --lat 34.15 --lon -118.14 --radius 100 --dry-run
//   node tools/dtm/fetch_dtm.mjs --tile N34W119            # a single explicit tile
//   node tools/dtm/fetch_dtm.mjs --lat 34.15 --lon -118.14 --radius 25 --force

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_CACHE_DIR = path.join(ROOT, 'test_results', 'dtm', 'tiles');

const BUCKET = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
export const VOID = -32768;

const AGENT = {
  name: 'SkyCruncher-DTMBot',
  version: '1.0',
  info: 'https://github.com/ahoganpurdue/skycruncher',
};
function userAgentHeaders(operator) {
  const op = operator || process.env.DTM_OPERATOR || 'unknown-operator';
  return {
    'User-Agent': `${AGENT.name}/${AGENT.version} (+${AGENT.info}; operator=${op}; purpose=terrain-horizon reference)`,
    'From': op,
    'X-SkyCruncher-Agent': `${AGENT.name}/${AGENT.version}`,
    'X-SkyCruncher-Purpose': 'DTM/DEM terrain-horizon reference (sextant rung-1)',
  };
}

// ── tile geometry (pure; shared with the sampler) ────────────────────────────

/** Skadi tile name for a coordinate — named after the SW (floored) corner. */
export function tileNameFor(lat, lon) {
  const latBase = Math.floor(lat);
  const lonBase = Math.floor(lon);
  const ns = latBase < 0 ? 'S' : 'N';
  const ew = lonBase < 0 ? 'W' : 'E';
  return `${ns}${String(Math.abs(latBase)).padStart(2, '0')}${ew}${String(Math.abs(lonBase)).padStart(3, '0')}`;
}

/** Inverse of tileNameFor → the SW-corner integer lat/lon of the tile. */
export function parseTileName(name) {
  const m = /^([NS])(\d{2})([EW])(\d{3})$/.exec(name);
  if (!m) throw new Error(`bad tile name "${name}" (expected e.g. N34W119)`);
  const latBase = (m[1] === 'S' ? -1 : 1) * parseInt(m[2], 10);
  const lonBase = (m[3] === 'W' ? -1 : 1) * parseInt(m[4], 10);
  return { latBase, lonBase };
}

/** Full skadi download URL for a tile. */
export function skadiUrl(name) {
  const latDir = name.slice(0, 3); // e.g. "N34"
  return `${BUCKET}/${latDir}/${name}.hgt.gz`;
}

/** Approx km per degree of latitude (mean) — good enough for tile enumeration. */
const KM_PER_DEG_LAT = 111.0;

/**
 * All 1° tiles whose extent intersects a (lat, lon, radius_km) disk's bounding
 * box. Over-covers slightly at the corners (box, not disk) — safe, never misses.
 */
export function tilesForRadius(lat, lon, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180)); // guard near poles
  const dLon = radiusKm / (KM_PER_DEG_LAT * cos);
  const latLo = Math.floor(lat - dLat);
  const latHi = Math.floor(lat + dLat);
  const lonLo = Math.floor(lon - dLon);
  const lonHi = Math.floor(lon + dLon);
  const names = [];
  for (let la = latLo; la <= latHi; la++) {
    for (let lo = lonLo; lo <= lonHi; lo++) {
      // build from integer corner → tileNameFor with a mid-cell sample
      names.push(tileNameFor(la + 0.5, lo + 0.5));
    }
  }
  return names;
}

/** On-disk paths for a tile in the cache. */
export function tilePaths(name, cacheDir = DEFAULT_CACHE_DIR) {
  return {
    hgt: path.join(cacheDir, `${name}.hgt`),
    sidecar: path.join(cacheDir, `${name}.hgt.provenance.json`),
  };
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Validate a decoded .hgt buffer. Returns { ok, dim, min, max, voidCount, reason }.
 * A truncated download or non-square sample count is rejected; the non-void
 * elevation range must be physically plausible (Dead Sea shore ≈ -430 m to
 * Everest ≈ 8849 m, with margin).
 */
export function verifyTile(buf) {
  if (!buf || buf.length < 2 || buf.length % 2 !== 0) {
    return { ok: false, reason: `byte length ${buf?.length} not a positive even number` };
  }
  const samples = buf.length / 2;
  const dim = Math.round(Math.sqrt(samples));
  if (dim * dim !== samples) {
    return { ok: false, reason: `sample count ${samples} is not a perfect square (expected 3601² SRTM1 or 1201² SRTM3)` };
  }
  let min = Infinity;
  let max = -Infinity;
  let voidCount = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const v = buf.readInt16BE(i);
    if (v === VOID) { voidCount++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const allVoid = voidCount === samples;
  // Plausibility floor is BATHYMETRIC, not land-only: AWS Terrain Tiles merges
  // ocean depth (GEBCO/ETOPO) with SRTM land, so a coastal/ocean tile legitimately
  // reaches deep negatives (e.g. the San Pedro/Santa Cruz basins off LA ≈ -1900 m).
  // The real integrity guard is "gunzips to a perfect-square int16 grid"; this range
  // check only rejects gross garbage (HTML/corrupt), so bound it at Mariana-to-Everest.
  if (!allVoid && (min < -11000 || max > 9000)) {
    return { ok: false, dim, min, max, voidCount, reason: `implausible elevation range [${min}, ${max}] m — likely corrupt/HTML` };
  }
  return { ok: true, dim, min: allVoid ? null : min, max: allVoid ? null : max, voidCount, allVoid };
}

// ── fetch one tile ────────────────────────────────────────────────────────────

/**
 * Ensure a single tile is cached. Returns a result record. Offline-first: if a
 * valid cached .hgt exists and !force, does NO network I/O.
 */
export async function fetchTile(name, opts = {}) {
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const { hgt, sidecar } = tilePaths(name, cacheDir);
  const url = skadiUrl(name);

  // Idempotent / offline-first: valid cached tile → skip.
  if (!opts.force && fs.existsSync(hgt)) {
    const buf = fs.readFileSync(hgt);
    const v = verifyTile(buf);
    if (v.ok) return { name, status: 'cached', dim: v.dim, bytes_raw: buf.length, min: v.min, max: v.max, voidCount: v.voidCount, path: hgt };
    // corrupt cache → fall through and re-fetch
  }

  if (opts.dryRun) return { name, status: 'planned', url };

  fs.mkdirSync(cacheDir, { recursive: true });
  const headers = userAgentHeaders(opts.operator);
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    return { name, status: 'error', url, http_status: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  }
  const gz = Buffer.from(await res.arrayBuffer());
  // Guard: an S3/HTML error body will not gunzip to a valid square tile.
  let raw;
  try {
    raw = zlib.gunzipSync(gz);
  } catch (e) {
    return { name, status: 'error', url, error: `gunzip failed: ${e.message} (not a gzip tile?)` };
  }
  const v = verifyTile(raw);
  if (!v.ok) return { name, status: 'error', url, error: `verification failed: ${v.reason}` };

  const sha256_gz = crypto.createHash('sha256').update(gz).digest('hex');
  const sha256_raw = crypto.createHash('sha256').update(raw).digest('hex');
  const { latBase, lonBase } = parseTileName(name);

  const record = {
    schema: 'skycruncher.dtm.tile.provenance/1',
    tile: name,
    sw_corner: { lat: latBase, lon: lonBase },
    coverage: { lat: [latBase, latBase + 1], lon: [lonBase, lonBase + 1] },
    dataset: 'AWS Open Data Terrain Tiles (skadi) — SRTMGL1-family raw .hgt',
    dataset_version: 'elevation-tiles-prod/skadi',
    source_url: url,
    http_status: res.status,
    content_type: res.headers.get('content-type') || '',
    format: {
      encoding: 'raw big-endian int16, row-major',
      samples_per_side: v.dim,
      arcsec_per_sample: v.dim === 3601 ? 1 : v.dim === 1201 ? 3 : Math.round(3600 / (v.dim - 1)),
      origin: 'NW corner (row 0 = north edge, col 0 = west edge)',
      void_value: VOID,
    },
    bytes_gz: gz.length,
    bytes_raw: raw.length,
    sha256_gz,
    sha256_raw,
    elevation_range_m: { min: v.min, max: v.max, void_count: v.voidCount, all_void: !!v.allVoid },
    fetched_at: new Date().toISOString(),
    agent: { ...AGENT, operator: opts.operator || process.env.DTM_OPERATOR || null },
    license:
      'Public domain elevation (NASA/USGS SRTM & contributors) redistributed as AWS Terrain Tiles ' +
      '(Mapzen/Tilezen joerd). Attribution: "Elevation: USGS/NASA SRTM via AWS Terrain Tiles."',
  };

  fs.writeFileSync(hgt, raw);
  fs.writeFileSync(sidecar, JSON.stringify(record, null, 2));
  return { name, status: 'fetched', dim: v.dim, bytes_gz: gz.length, bytes_raw: raw.length, min: v.min, max: v.max, voidCount: v.voidCount, path: hgt, sha256_raw };
}

/** Ensure every tile covering (lat, lon, radiusKm) is cached. */
export async function ensureTiles(lat, lon, radiusKm, opts = {}) {
  const names = tilesForRadius(lat, lon, radiusKm);
  const results = [];
  for (const name of names) results.push(await fetchTile(name, opts));
  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['dry-run', 'force']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      if (flags.has(k)) a[k] = true;
      else a[k] = argv[++i];
    } else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    cacheDir: args.cache ? path.resolve(args.cache) : DEFAULT_CACHE_DIR,
    force: !!args.force,
    dryRun: !!args['dry-run'],
    operator: args.operator,
  };

  let names;
  if (args.tile) {
    names = String(args.tile).split(',').map((s) => s.trim());
  } else if (args.lat != null && args.lon != null) {
    const lat = parseFloat(args.lat);
    const lon = parseFloat(args.lon);
    const radius = args.radius != null ? parseFloat(args.radius) : 50;
    names = tilesForRadius(lat, lon, radius);
    console.log(`═══ DTM FETCH ═══  (lat ${lat}, lon ${lon}, radius ${radius} km)`);
  } else {
    console.error('usage: --lat <deg> --lon <deg> [--radius km]  |  --tile N34W119[,N34W118]');
    process.exit(1);
  }

  console.log(`  cache : ${path.relative(ROOT, opts.cacheDir)}`);
  console.log(`  tiles : ${names.length} → ${names.join(' ')}`);
  if (opts.dryRun) console.log('  [--dry-run] planning only; nothing downloaded.');

  const results = [];
  for (const name of names) results.push(await fetchTile(name, opts));

  let bytes = 0;
  for (const r of results) {
    if (r.status === 'fetched') {
      bytes += r.bytes_raw;
      console.log(`  ✓ ${r.name}  ${(r.bytes_raw / 1e6).toFixed(1)} MB  dim ${r.dim}  elev [${r.min}, ${r.max}] m  voids ${r.voidCount}`);
    } else if (r.status === 'cached') {
      bytes += r.bytes_raw;
      console.log(`  ↺ ${r.name}  cached (dim ${r.dim}, elev [${r.min}, ${r.max}] m)`);
    } else if (r.status === 'planned') {
      console.log(`  · ${r.name}  → ${r.url}`);
    } else {
      console.error(`  ✗ ${r.name}  ${r.error}`);
    }
  }
  const ok = results.filter((r) => r.status === 'fetched' || r.status === 'cached').length;
  console.log(`\n  ${ok}/${results.length} tiles available · cache footprint ${(bytes / 1e6).toFixed(1)} MB`);
}

// Run only when invoked directly (safe to import for the pure helpers above).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
