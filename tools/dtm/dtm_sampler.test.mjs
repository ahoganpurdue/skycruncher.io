// Offline, deterministic tests for the DTM sampler. Builds a SYNTHETIC skadi
// tile (same binary format, coarser DIM) with a known linear field so bilinear
// interpolation is analytically exact — no network, no cached real tiles, so it
// runs identically in any clone.
//
// Field value(row,col) = row + col + BASE. The +BASE offset matters: it keeps
// every real value non-zero, so a null (honest-absent) result can't masquerade
// as a numeric match (JS coerces null→0 in toBeCloseTo).
//
// Tile-edge convention: tileNameFor FLOORS, so the SOUTH (lat=integer) and WEST
// (lon=integer) edges belong to a tile, while the NORTH/EAST edges belong to the
// neighbour. Tests query interior + owned edges only; only ONE tile is cached.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { elevationAt, profileAlong, destPoint, loadTile, clearTileCache, EARTH_R_KM } from './dtm_sampler.mjs';
import { VOID, tileNameFor, verifyTile } from './fetch_dtm.mjs';

const DIM = 61;            // N00E000, lat[0,1]×lon[0,1], 60 intervals/deg
const BASE = 100;
const VOID_RC = { r: 30, c: 30 }; // planted void at lat 0.5, lon 0.5
let cacheDir;

function buildSyntheticTile(dir) {
  const buf = Buffer.alloc(DIM * DIM * 2);
  for (let r = 0; r < DIM; r++) {
    for (let c = 0; c < DIM; c++) {
      const v = r === VOID_RC.r && c === VOID_RC.c ? VOID : r + c + BASE;
      buf.writeInt16BE(v, (r * DIM + c) * 2);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'N00E000.hgt'), buf);
  return buf;
}

// (row,col) → the (lat,lon) landing exactly on that post.
function nodeLatLon(row, col) {
  const n = DIM - 1;
  return { lat: 1 - row / n, lon: col / n };
}

beforeAll(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-test-'));
  buildSyntheticTile(cacheDir);
  clearTileCache();
});
afterAll(() => {
  clearTileCache();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('fetch_dtm helpers', () => {
  it('names tiles from the SW corner (incl. hemispheres)', () => {
    expect(tileNameFor(34.15, -118.14)).toBe('N34W119');
    expect(tileNameFor(0.5, 0.5)).toBe('N00E000');
    expect(tileNameFor(-1.5, -0.5)).toBe('S02W001');
    expect(tileNameFor(34.0, -118.0)).toBe('N34W118'); // owned SW/interior corner
  });
  it('verifyTile accepts a square grid and rejects a truncated one', () => {
    const good = buildSyntheticTile(fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-verify-')));
    expect(verifyTile(good).ok).toBe(true);
    expect(verifyTile(good.slice(0, good.length - 3)).ok).toBe(false); // odd length
    expect(verifyTile(Buffer.alloc(2 * (DIM * DIM - 1))).ok).toBe(false); // not square
  });
});

describe('elevationAt', () => {
  it('returns the exact stored value at a grid node (interior + owned edges)', () => {
    // rows 1..60 avoid the north edge; cols 0..59 avoid the east edge.
    for (const [r, c] of [[1, 0], [10, 20], [60, 0], [60, 59], [30, 10]]) {
      const { lat, lon } = nodeLatLon(r, c);
      expect(elevationAt(lat, lon, { cacheDir })).toBeCloseTo(r + c + BASE, 5);
    }
  });

  it('bilinearly reproduces the linear field at fractional positions', () => {
    const n = DIM - 1;
    // midpoint of cell (10,20)-(11,21) → row 10.5, col 20.5 → 10.5+20.5+BASE
    const lat = 1 - 10.5 / n;
    const lon = 20.5 / n;
    expect(elevationAt(lat, lon, { cacheDir })).toBeCloseTo(31 + BASE, 5);
  });

  it('encodes orientation: north=low row, west=low col', () => {
    // node (1,30) is northern, (59,30) southern → north value < south value
    const north = elevationAt(nodeLatLon(1, 30).lat, nodeLatLon(1, 30).lon, { cacheDir });
    const south = elevationAt(nodeLatLon(59, 30).lat, nodeLatLon(59, 30).lon, { cacheDir });
    expect(north).toBeCloseTo(1 + 30 + BASE, 5);
    expect(south).toBeCloseTo(59 + 30 + BASE, 5);
    expect(north).toBeLessThan(south);
    // node (30,1) western, (30,59) eastern → west value < east value
    const west = elevationAt(nodeLatLon(30, 1).lat, nodeLatLon(30, 1).lon, { cacheDir });
    const east = elevationAt(nodeLatLon(30, 59).lat, nodeLatLon(30, 59).lon, { cacheDir });
    expect(west).toBeLessThan(east);
  });

  it('returns null (honest-absent) touching a void post', () => {
    const { lat, lon } = nodeLatLon(VOID_RC.r, VOID_RC.c);
    expect(elevationAt(lat, lon, { cacheDir })).toBeNull();
  });

  it('returns null for an uncached tile (never zero-fills)', () => {
    expect(elevationAt(50.5, 8.5, { cacheDir })).toBeNull(); // no N50E008 in cache
  });
});

describe('destPoint (great-circle stepping)', () => {
  it('steps east ~1° per 111.195 km at the equator', () => {
    const oneDeg = (Math.PI / 180) * EARTH_R_KM; // km per degree of arc
    const p = destPoint(0, 0, 90, oneDeg);
    expect(p.lat).toBeCloseTo(0, 3);
    expect(p.lon).toBeCloseTo(1.0, 3);
  });
  it('steps north ~1° per 111.195 km', () => {
    const oneDeg = (Math.PI / 180) * EARTH_R_KM;
    const p = destPoint(0, 0, 0, oneDeg);
    expect(p.lat).toBeCloseTo(1.0, 3);
    expect(p.lon).toBeCloseTo(0, 6);
  });
});

describe('profileAlong', () => {
  it('samples origin-to-maxKm at stepKm, elev present inside the tile', () => {
    // start at (0.2, 0.7) — away from the planted void at (0.5, 0.5) — head north
    const prof = profileAlong(0.2, 0.7, 0, 5, 0.5, { cacheDir });
    expect(prof.length).toBe(11); // 0..5 inclusive
    expect(prof[0].distKm).toBe(0);
    expect(prof[0].lat).toBe(0.2);
    expect(prof[prof.length - 1].distKm).toBeCloseTo(5, 6);
    for (let i = 1; i < prof.length; i++) expect(prof[i].lat).toBeGreaterThan(prof[i - 1].lat);
    expect(prof.every((s) => s.elev != null)).toBe(true);
  });

  it('loadTile infers DIM from file length', () => {
    const t = loadTile('N00E000', cacheDir);
    expect(t.dim).toBe(DIM);
    expect(t.latBase).toBe(0);
    expect(t.lonBase).toBe(0);
  });
});
