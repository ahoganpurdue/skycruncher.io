/**
 * ITERATIVE-BC lane — LEG 2 capture: ONE live headless M66 solve.
 *
 * Runs the REAL wizard pipeline in Node (real wasm, real atlas) ONCE, asserts
 * the SACRED SeeStar M66 numbers byte-identically (LAW 2 — any deviation FAILS
 * this spec; the loop must never run on a non-sacred solve, and we never
 * rerun-to-pass), then dumps the export Float32 buffer + WCS + matched set to D:
 * so the pure-.mjs iterative loop (loop_runner.mjs) can iterate deterministically
 * on the banked buffer. This is the single live/heavy step of the whole lane.
 *
 * Wall time is LOAD-CONFOUNDED (parallel builds on the box); byte-identity is
 * load-immune. Run: npx vitest run -c tools/iterbc/iterbc.config.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21';

// Sacred SeeStar M66 pins (docs/GATES.md). Byte-identity is the gate.
const SACRED = {
  ra_hours: 11.341253475172621,
  pixel_scale: 3.6776147325019153,
  matched: 272,
} as const;

describe('iterbc LEG-2 capture — live M66 solve (sacred, exact) + buffer dump', () => {
  it('reproduces the sacred M66 solve and dumps the export buffer', async () => {
    expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH}`).toBe(true);
    const buf = fs.readFileSync(FIT_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

    const { receipt, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
    const sol = receipt.solution as any;

    // ── SACRED GATE (STOP-if-deviate; never rerun-to-pass) ──
    expect(sol.ra_hours).toBe(SACRED.ra_hours);
    expect(sol.pixel_scale).toBe(SACRED.pixel_scale);
    expect((sol.matched_stars || []).length).toBe(SACRED.matched);

    // ── export buffer (the pixels the forced-harvest measures on) ──
    const img = (session as any).getExportImage?.();
    expect(img, 'session.getExportImage() returned null — buffer not reachable').toBeTruthy();
    const data: Float32Array = img.data;
    expect(data.length).toBe(img.width * img.height * (img.channels ?? 1));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    // Raw little-endian Float32 planar buffer.
    fs.writeFileSync(
      path.join(OUT_DIR, 'm66_buffer.f32'),
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );

    const ld = (receipt as any).lens_distortion_measured || {};
    const meta = {
      schema: 'iterbc.capture.v0',
      frame: 'M66',
      source: 'live runWizardPipeline (sacred, byte-identical)',
      buffer_file: 'm66_buffer.f32',
      dtype: 'float32-le',
      width: img.width,
      height: img.height,
      channels: img.channels ?? 1,
      // The export grid may be native OR 2x2-binned vs the solve's native pixel
      // grid; matched_stars x/y and the WCS are on the NATIVE grid. The loop
      // scales positions by (width/native_width) to land on this buffer.
      native_width: (receipt.metadata as any)?.width ?? null,
      native_height: (receipt.metadata as any)?.height ?? null,
      sacred: { ra_hours: sol.ra_hours, pixel_scale: sol.pixel_scale, matched: (sol.matched_stars || []).length },
      wcs: (receipt as any).wcs,
      mean_fwhm_px: sol.mean_fwhm_px ?? null,
      bc_measured: { k1: ld.k1 ?? null, k2: ld.k2 ?? null },
      matched_stars: (sol.matched_stars || []).map((s: any) => ({
        gaia_id: s.gaia_id, ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag,
        x: s.x, y: s.y, fwhm: s.fwhm,
      })),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'm66_capture_meta.json'), JSON.stringify(meta, null, 2));

    // eslint-disable-next-line no-console
    console.log(`[iterbc/capture] sacred OK · buffer ${img.width}x${img.height}x${img.channels ?? 1} (native ${meta.native_width}x${meta.native_height}) -> ${OUT_DIR}`);
    expect(fs.existsSync(path.join(OUT_DIR, 'm66_buffer.f32'))).toBe(true);
  });
});
