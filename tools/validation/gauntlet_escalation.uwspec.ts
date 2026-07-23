// ═══════════════════════════════════════════════════════════════════════════
// ENH-2 gauntlet escalation — STEP 2: fire forced-photometry deep-verify
// escalation WITH REAL PIXELS on the [3.0,4.5)σ near-miss frames.
// ═══════════════════════════════════════════════════════════════════════════
// STANDALONE — does NOT touch cr2_binding.{uwspec,config}.ts / run_cr2_sweep.ts.
// Feeds solvePlate the SAME arguments the sweep's anchor#3 arm used (detections,
// scaleLock, planet extraSearchCenters, 90s budget) EXCEPT imageData.data carries
// real browser-faithful luminance (gauntlet_decode.mjs sidecars) instead of the
// empty buffer. That flips solver_entry's `havePixels` guard true, so a
// sub-threshold sweep peak in [SOLVER_UW_ESCALATE_MIN_Z=3, SOLVER_UW_SWEEP_MIN_Z=4.5)
// runs deepVerifyEscalation (catalog-forced photometry at predicted deep-star
// positions vs a scrambled on-frame null). We read the UW_ESCALATION forensic
// (excessZ, predAccepted/nPred, nullAccepted/nNull) and whether it produced
// SUCCESS_UW_ESCALATED (a recovered verified lock). READ-ONLY on all engine code.
//
// Requires SOLVER_UW_ANCHOR_CANDIDATES=3 in the ENV (pipeline_config reads it at
// module load) so the same anchor#3 peaks arise. grid_ok=false sidecars HONEST-SKIP.

import { describe, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { solvePlate } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const ROOT = process.cwd();
const ANCHOR_N = PIPELINE_CONSTANTS.SOLVER_UW_ANCHOR_CANDIDATES;
const BUDGET_MS = process.env.CR2_BUDGET_MS ? parseInt(process.env.CR2_BUDGET_MS, 10) : 90_000;
const LUM_DIR = process.env.LUM_DIR || path.join(ROOT, 'test_results', 'validation', '_enh2_lum');
const OUTDIR = process.env.OUTDIR || path.join(ROOT, 'test_results', 'validation', '_enh2_escalation');
const DETS_DIR = path.join(ROOT, 'test_results', 'cr2_dets');

// The 10 [3.0,4.5)σ near-misses (peakZ = anchor#3 sweep best, for the report).
const FRAMES: { frame: string; peakZ: number; rig: string }[] = [
  { frame: 'IMG_1653', peakZ: 4.32, rig: 'T6/Rokinon-14mm' },
  { frame: 'CSM30803_5DMkIII_iso6400_15s', peakZ: 4.21, rig: '5D3/24mm' },
  { frame: 'IMG_1754', peakZ: 4.15, rig: 'T6' },
  { frame: 'IMG_1816', peakZ: 3.79, rig: 'T6' },
  { frame: 'IMG_1804', peakZ: 3.58, rig: 'T6' },
  { frame: 'IMG_1817', peakZ: 3.51, rig: 'T6' },
  { frame: 'IMG_1753', peakZ: 3.50, rig: 'T6' },
  { frame: 'IMG_1815', peakZ: 3.32, rig: 'T6' },
  { frame: 'IMG_1802', peakZ: 3.18, rig: 'T6' },
  { frame: 'IMG_1814', peakZ: 3.05, rig: 'T6' },
];

// ── atlas fetch shim (identical to cr2_binding.uwspec.ts) ──
let catalogPages = 0;
beforeAll(() => {
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('/atlas/')) {
      if (u.includes('/sectors/')) catalogPages += 1;
      const p = path.join(ROOT, 'public', u);
      if (!fs.existsSync(p)) {
        return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
      }
      const txt = fs.readFileSync(p, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
    }
    if (realFetch) return realFetch(url);
    throw new Error('no fetch shim for ' + u);
  };
});

function expandToRGBA(gray: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i];
    const d = i * 4;
    data[d] = v; data[d + 1] = v; data[d + 2] = v; data[d + 3] = 255;
  }
  return data;
}

describe(`ENH-2 gauntlet escalation (anchor#${ANCHOR_N}, real pixels)`, () => {
  fs.mkdirSync(OUTDIR, { recursive: true });

  for (const { frame, peakZ, rig } of FRAMES) {
    it(`${frame} (peakZ=${peakZ})`, async () => {
      const outFile = path.join(OUTDIR, `${frame}.json`);
      const sidePath = path.join(LUM_DIR, `${frame}.decode.json`);
      const lumPath = path.join(LUM_DIR, `${frame}.lum8`);
      const dumpPath = path.join(DETS_DIR, `${frame}.app.json`);

      const base: any = { frame, rig, expected_peak_z: peakZ };

      // ── grid-consistency guard: honest-skip on missing/misaligned decode ──
      if (!fs.existsSync(sidePath) || !fs.existsSync(lumPath)) {
        base.verdict = 'SKIPPED'; base.skip_reason = 'no decode sidecar (decode failed/absent)';
        fs.writeFileSync(outFile, JSON.stringify(base, null, 2)); console.log(`[ENH2] ${frame}: SKIPPED (no decode)`); return;
      }
      const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
      base.decode = { orientation: side.orientation, chosenW: side.chosenW, chosenH: side.chosenH, dumpW: side.dumpW, dumpH: side.dumpH, alignment: side.alignment, grid_ok: side.grid_ok };
      if (!side.grid_ok) {
        base.verdict = 'SKIPPED'; base.skip_reason = `grid guard failed (dimsMatch=${side.dimsMatch} alignOk=${side.alignOk} detZ=${side.alignment?.detZ} nullZ=${side.alignment?.nullZ})`;
        fs.writeFileSync(outFile, JSON.stringify(base, null, 2)); console.log(`[ENH2] ${frame}: SKIPPED (${base.skip_reason})`); return;
      }

      const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
      const { scaleArcsecPerPx, detections, planets = [] } = dump;
      const w = side.chosenW, h = side.chosenH;
      if (w !== dump.width || h !== dump.height) {
        base.verdict = 'SKIPPED'; base.skip_reason = `chosen dims ${w}x${h} != dump ${dump.width}x${dump.height}`;
        fs.writeFileSync(outFile, JSON.stringify(base, null, 2)); console.log(`[ENH2] ${frame}: SKIPPED (${base.skip_reason})`); return;
      }

      const grayBuf = fs.readFileSync(lumPath);
      if (grayBuf.byteLength !== w * h) {
        base.verdict = 'SKIPPED'; base.skip_reason = `lum8 length ${grayBuf.byteLength} != ${w}*${h}`;
        fs.writeFileSync(outFile, JSON.stringify(base, null, 2)); console.log(`[ENH2] ${frame}: SKIPPED (${base.skip_reason})`); return;
      }
      const gray = new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength);
      const rgba = expandToRGBA(gray, w, h);
      const imageData = { width: w, height: h, data: rgba, colorSpace: 'srgb' } as any;

      const detectedStars = detections.map((d: any) => ({ x: d.x, y: d.y, flux: +d.flux, fwhm: d.fwhm }));
      const extra = planets.map((p: any) => ({ ra: p.ra_hours, dec: p.dec_degrees, name: p.name }));

      catalogPages = 0;
      const orig = console.log, origWarn = console.warn;
      console.log = () => {}; console.warn = () => {};
      const t0 = Date.now();
      let result: any, threw: any = null;
      try {
        result = await solvePlate(imageData, scaleArcsecPerPx, undefined, undefined, {
          detectedStars,
          scaleLock: scaleArcsecPerPx,
          blindBudgetMs: BUDGET_MS,
          extraSearchCenters: extra,
        });
      } catch (e) {
        threw = e;
      } finally {
        console.log = orig; console.warn = origWarn;
      }
      const wallMs = Date.now() - t0;

      const forensics: any[] = result?.diagnostics?.forensics ?? [];
      const sweepPeaks = forensics.filter((f) => f?.status === 'UW_SWEEP_PEAK' && f.uw_peak);
      const bestPeakZ = sweepPeaks.length ? Math.max(...sweepPeaks.map((f) => f.uw_peak.z)) : null;
      const escalations = forensics.filter((f) => f?.status === 'UW_ESCALATION').map((f) => f.uw_escalation);
      const escMeasured = escalations.filter((e: any) => e && typeof e.excessZ === 'number');
      const bestEsc = escMeasured.length ? escMeasured.slice().sort((a: any, b: any) => b.excessZ - a.excessZ)[0] : null;
      const verifyPasses = forensics.filter((f) => f?.status === 'UW_VERIFY_PASS').length;
      const escalatedLock = forensics.some((f) => f?.status === 'SUCCESS_UW_ESCALATED');
      const sweepLock = forensics.some((f) => f?.status === 'SUCCESS_UW_SWEEP');
      const sunVetoes = forensics.filter((f) => f?.status === 'UW_SUN_VETO').length;
      const locked = verifyPasses > 0 || escalatedLock || sweepLock;

      base.verdict = escalatedLock ? 'POSITIVE' : 'NEGATIVE';
      base.result = {
        wall_ms: wallMs,
        best_peak_z: bestPeakZ,
        n_escalations_fired: escalations.length,
        n_escalations_measured: escMeasured.length,
        best_escalation: bestEsc, // {sweepZ, excessZ, predAccepted, nPred, nullAccepted, nNull, predFrac, nullFrac, probesInPatch, ...}
        all_escalations: escMeasured.map((e: any) => ({ sweepZ: e.sweepZ, excessZ: e.excessZ, predAccepted: e.predAccepted, nPred: e.nPred, nullAccepted: e.nullAccepted, nNull: e.nNull, probesInPatch: e.probesInPatch })),
        insufficient_probe_escalations: escalations.length - escMeasured.length,
        escalated_lock: escalatedLock,
        sweep_lock: sweepLock,
        verify_passes: verifyPasses,
        sun_vetoes: sunVetoes,
        locked,
        catalog_pages: catalogPages,
        threw: threw ? String(threw?.message || threw) : null,
      };
      fs.writeFileSync(outFile, JSON.stringify(base, null, 2), 'utf8');
      const escTag = bestEsc ? `excessZ=${bestEsc.excessZ} (${bestEsc.predAccepted}/${bestEsc.nPred} pred vs ${bestEsc.nullAccepted}/${bestEsc.nNull} null)` : (escalations.length ? `${escalations.length} fired, 0 measured (insufficient probes)` : 'none fired');
      console.log(`[ENH2] ${frame}: ${base.verdict} peakZ=${bestPeakZ} esc=[${escTag}] lock=${locked} (${wallMs}ms, ${escMeasured.length}/${escalations.length} esc, ${catalogPages} pages)`);
    }, Math.max(BUDGET_MS + 120_000, 240_000));
  }
});
