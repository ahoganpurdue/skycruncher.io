// Offline, deterministic tests for the horizon predictor. Synthetic tiles with
// hand-checkable geometry — no network, no cached real tiles.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { predictHorizon, topRidges, horizonToSvg } from './horizon_predict.mjs';
import { clearTileCache } from './dtm_sampler.mjs';

const DIM = 121; // N00E000, 120 intervals/deg
let cacheDir;

// Build a tile with elevation = fn(row, col) metres. row 0 = north edge.
function buildTile(dir, name, fn) {
  const buf = Buffer.alloc(DIM * DIM * 2);
  for (let r = 0; r < DIM; r++) {
    for (let c = 0; c < DIM; c++) buf.writeInt16BE(fn(r, c) | 0, (r * DIM + c) * 2);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.hgt`), buf);
}

beforeAll(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-horizon-'));
  clearTileCache();
});
afterAll(() => {
  clearTileCache();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('predictHorizon — flat plane (curvature dip)', () => {
  it('depresses the whole horizon below level and is isotropic', () => {
    buildTile(cacheDir, 'N00E000', () => 0); // flat sea-level tile
    clearTileCache();
    const r = predictHorizon({ lat: 0.5, lon: 0.5, heightAgl: 10, azStepDeg: 5, maxKm: 30, stepKm: 0.5, cacheDir });
    expect(r.horizon.length).toBe(72);
    const alts = r.horizon.map((p) => p.alt_deg);
    expect(alts.every((a) => a != null && a < 0)).toBe(true); // curvature drop → below horizontal
    // flat → isotropic: spread across azimuths is tiny
    const spread = Math.max(...alts) - Math.min(...alts);
    expect(spread).toBeLessThan(0.05);
  });

  it('stronger refraction lifts the depressed horizon (less negative)', () => {
    buildTile(cacheDir, 'N00E000', () => 0);
    clearTileCache();
    const base = { lat: 0.5, lon: 0.5, heightAgl: 10, azStepDeg: 30, maxKm: 30, stepKm: 0.5, cacheDir };
    const weak = predictHorizon({ ...base, refractionK: 0.0 });
    const strong = predictHorizon({ ...base, refractionK: 0.5 });
    const mean = (r) => r.horizon.reduce((s, p) => s + p.alt_deg, 0) / r.horizon.length;
    expect(mean(strong)).toBeGreaterThan(mean(weak)); // less drop → higher horizon
  });
});

describe('predictHorizon — north wall (ridge detection)', () => {
  it('places the highest horizon to the north with the wall elevation', () => {
    // 2000 m plateau on the northern rows (near lat 1.0), flat elsewhere
    buildTile(cacheDir, 'N00E000', (r) => (r <= 5 ? 2000 : 0));
    clearTileCache();
    const r = predictHorizon({ lat: 0.35, lon: 0.5, heightAgl: 2, azStepDeg: 2, maxKm: 70, stepKm: 0.25, cacheDir });
    const top = topRidges(r, 1)[0];
    // due north = az 0 (or 360-eps); accept within 12°
    expect(Math.min(top.az, 360 - top.az)).toBeLessThan(12);
    expect(top.alt_deg).toBeGreaterThan(0.5); // a real mountain rises above level
    expect(top.ridge_elev_m).toBeGreaterThan(1500); // sampled on/near the 2000 m plateau
    // the southern horizon (away from the wall) is much lower
    const south = r.horizon.find((p) => p.az === 180);
    expect(south.alt_deg).toBeLessThan(top.alt_deg - 1);
  });
});

describe('predictHorizon — contracts', () => {
  it('throws when the observer tile is not cached', () => {
    expect(() => predictHorizon({ lat: 60.5, lon: 5.5, cacheDir })).toThrow(/not cached|void|unavailable/i);
  });

  it('is deterministic (identical inputs → identical output)', () => {
    buildTile(cacheDir, 'N00E000', (r, c) => (r + c) * 5);
    clearTileCache();
    const opts = { lat: 0.5, lon: 0.5, azStepDeg: 10, maxKm: 20, stepKm: 0.5, cacheDir };
    const a = JSON.stringify(predictHorizon(opts));
    const b = JSON.stringify(predictHorizon(opts));
    expect(crypto.createHash('sha256').update(a).digest('hex'))
      .toBe(crypto.createHash('sha256').update(b).digest('hex'));
  });

  it('renders a self-contained SVG', () => {
    buildTile(cacheDir, 'N00E000', (r) => (r <= 5 ? 2000 : 0));
    clearTileCache();
    const r = predictHorizon({ lat: 0.35, lon: 0.5, azStepDeg: 10, maxKm: 40, stepKm: 0.5, cacheDir });
    const svg = horizonToSvg(r);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
    expect(svg).toContain('</svg>');
  });
});
