// ═══════════════════════════════════════════════════════════════════════════
// FITS REAL-PIPELINE BINDING for the Validation & Graduation Harness
// (candidate: fits_solve — SOLVER_FITS_VALIDATION_ARM 0 OFF / 1 ON identity seam)
// ═══════════════════════════════════════════════════════════════════════════
//
//   FITS_DUMPS="test_results/fits_dets/A.json,..." FITS_OUTDIR=... \
//     SOLVER_FITS_VALIDATION_ARM=0 \
//     npx vitest run -c tools/validation/fits_binding.config.ts
//
// Drives the REAL narrow FITS wizard solve (headless_driver.runWizardPipeline →
// OrchestratorSession step1→step6, real compiled wasm) headlessly for EACH FITS
// detection dump. It reads the dump's `file` field → the source FITS on disk,
// re-runs the FULL pipeline from the raw buffer (NOT from the dump's detections —
// the wizard re-extracts), and distills the FITTED FRAME CENTER.
//
// KEY DIFFERENCE from the CR2 binding: the CR2 anchored sweep records a bright-
// anchor center (~12° off the frame center → truth adjudication honest-absent).
// The FITS wizard records solution.ra_hours/dec_degrees = centerSky = the FITTED
// FRAME CENTER. That is the SAME quantity as the frame-center truth labels
// (OBJECT RA/DEC, e.g. M66 11.3617h) — VERIFIED apples-to-apples: M66 solves to
// 0.36° of its label, inside the 1° tolerance. So this binding sets
// provenance.recorded_center_is_frame = TRUE and truth adjudication goes LIVE for
// FITS (a truth-DISAGREEING lock → new_false_positive in the ledger delta).
//
// `locked` ≡ the calibrated solve produced a solution WITH a fitted WCS (the
// engine sets session.solution only when the narrow verifyWCS gate passed) — the
// calibrated gate stays the sole arbiter; a lock is never invented.
//
// It also collects receipt.psf_attribution (pillar C) into provenance so the
// sweep/driver can adjudicate the tracking inference against the known rig.
//
// SOLVER_FITS_VALIDATION_ARM is an IDENTITY seam today (0 ≡ 1 → byte-identical
// solve); both arms exist to mirror the A/B shape and exercise the seam, and the
// value is the OFF-arm truth verdict, not a lever win. Documented, not hidden.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');
const ARM = PIPELINE_CONSTANTS.SOLVER_FITS_VALIDATION_ARM; // 0 (OFF) or 1 (ON), fixed for this process
const OUTDIR = process.env.FITS_OUTDIR || path.join(ROOT, 'test_results', 'validation', '_fits_raw');
const DUMPS = (process.env.FITS_DUMPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** Frame id = the source FITS basename minus extension (matches truth labels.json). */
function frameIdOfFits(fitsRel: string): string {
  return path.basename(fitsRel).replace(/\.(fit|fits|fts)$/i, '');
}

/** Resolve the source FITS path for a dump path (fits_dets/*.json → its `file`). */
function resolveFitsSource(dumpRel: string): { fitsRel: string; dump: any } {
  const abs = path.join(ROOT, dumpRel);
  // Direct FITS path (someone passed a .fit/.fits straight in).
  if (/\.(fit|fits|fts)$/i.test(dumpRel)) return { fitsRel: dumpRel, dump: {} };
  const dump = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return { fitsRel: dump.file, dump };
}

/** Extract scale robustly: solution.pixel_scale (arcsec/px) else sqrt(|det CD|)·3600. */
function scaleArcsec(solution: any): number | null {
  if (typeof solution?.pixel_scale === 'number' && solution.pixel_scale > 0) return solution.pixel_scale;
  const cd = solution?.wcs?.cd;
  if (Array.isArray(cd) && cd.length === 2) {
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (Number.isFinite(det) && Math.abs(det) > 0) return Math.sqrt(Math.abs(det)) * 3600;
  }
  return null;
}

/** Distill a wizard solve into the raw RunResult extractSolverOutcome consumes. */
function distill(out: any, wallMs: number, dump: any, frame: string) {
  const solution = out?.session?.solution ?? null;
  const receipt = out?.receipt ?? null;
  // locked ≡ the calibrated narrow solve produced a fitted WCS.
  const locked = !!(solution && solution.wcs);
  const psfBlock = receipt?.psf_attribution ?? null;
  // Forced-photometry confirmation SUMMARY (report-only, NON-GATING). The engine
  // already computes solution.deep_confirmed / solution.deep_forced on the headless
  // FITS path; we surface a lean summary (NEVER the ~198-entry confirmed_stars array)
  // so the sweep can report a THIRD column beside solver-lock and oracle-truth.
  // Honest-absent: null when there's no solution / no deep_confirmed (non-locked frames).
  const dc = solution?.deep_confirmed ?? null;
  const df = solution?.deep_forced ?? null;
  const forcedPhotometry = dc
    ? {
        provenance: dc.provenance ?? null,
        examined: dc.examined ?? null,
        confirmed: dc.confirmed ?? null,
        setExcessZ: dc.setExcessZ ?? null,
        setGatePassed: dc.setGatePassed ?? null,
        grid: dc.grid ?? null,
        not_measured: dc.not_measured ?? null,
        harvest: df ? { accepted: df.accepted ?? null, probed: df.probed ?? null } : null,
      }
    : null;
  return {
    // ── RunResult fields consumed by extractSolverOutcome ──
    locked,
    ra: locked && typeof solution.ra_hours === 'number' ? solution.ra_hours : null,
    dec: locked && typeof solution.dec_degrees === 'number' ? solution.dec_degrees : null,
    sigma: locked && typeof solution.confidence === 'number' ? solution.confidence : null,
    matched: locked ? (solution.matched_stars?.length ?? 0) : 0,
    budget_ms: wallMs,
    wall_ms: wallMs,
    // false_positive decided downstream in run_fits_sweep.ts:merge() by the truth
    // layer (resolveTruth → applyTruthToRunResult), never fabricated here.
    false_positive: false,
    // scale/rotation/parity threaded so the truth compare grades ALL axes.
    pixel_scale_arcsec: locked ? scaleArcsec(solution) : null,
    rotation_deg: locked && typeof solution.rotation_deg === 'number' ? solution.rotation_deg : null,
    parity: solution?.parity === 1 || solution?.parity === -1 ? solution.parity : null,
    cost: { centers_tried: 0, sweeps: 0, escalations: 0, catalog_pages: 0 },
    locking_tool: locked ? 'fits_wizard_solve' : 'none',
    provenance: {
      fits_arm: ARM,
      // TRUTH COMPARABILITY: the recorded (ra,dec) is the FITTED FRAME CENTER
      // (centerSky), the SAME quantity as the frame-center truth labels — VERIFIED
      // apples-to-apples (M66 → 0.36° of its OBJECT-RA/DEC label). So truth
      // adjudication is LIVE for this rail (unlike the CR2 anchor-center harness).
      recorded_center_is_frame: true,
      // pillar C: the PSF-attribution block (tracking inference + diffraction floor).
      psf_attribution: psfBlock,
      // rig hints for the driver's psf-attribution adjudication (cohort lives in the manifest).
      rig: {
        instrume: dump?.header?.INSTRUME ?? null,
        focal_mm: dump?.focalLengthMm ?? dump?.header?.FOCALLEN ?? null,
        object: dump?.ground_truth?.object ?? dump?.header?.OBJECT ?? null,
      },
      winning_center: locked ? { ra_h: solution.ra_hours, dec_deg: solution.dec_degrees, matches: solution.matched_stars?.length ?? 0, scale: scaleArcsec(solution) } : null,
      dump_file: dump?.file ?? null,
      // Forced-photometry confirmation summary (report-only signal, NON-GATING).
      forced_photometry: forcedPhotometry,
    },
  };
}

describe(`FITS binding (arm#${ARM})`, () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(OUTDIR, `arm${ARM}`), { recursive: true });
  });

  for (const dumpRel of DUMPS) {
    const { fitsRel } = resolveFitsSource(dumpRel);
    const frame = frameIdOfFits(fitsRel);
    it(`${frame} (arm#${ARM})`, async () => {
      const outFile = path.join(OUTDIR, `arm${ARM}`, `${frame}.json`);
      let raw: any;
      try {
        const { fitsRel: fr, dump } = resolveFitsSource(dumpRel);
        const abs = path.join(ROOT, fr);
        if (!fs.existsSync(abs)) throw new Error(`source FITS missing: ${fr}`);
        const buf = fs.readFileSync(abs);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        const orig = console.log, origWarn = console.warn;
        console.log = () => {}; console.warn = () => {};
        const t0 = Date.now();
        let out: any, threw: any = null;
        try {
          out = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
        } catch (e) {
          threw = e;
        } finally {
          console.log = orig; console.warn = origWarn;
        }
        const wallMs = Date.now() - t0;
        if (threw) throw threw;
        raw = distill(out, wallMs, dump, frame);
        raw.frame = frame;
        raw.image_type = /seestar|imx/i.test(String(dump?.header?.INSTRUME ?? '')) ? 'FITS_SEESTAR' : 'FITS_OTHER';
        raw.threw = null;
      } catch (e: any) {
        // Honest non-lock so the orchestrator still pairs the frame (never a silent drop).
        raw = {
          frame, image_type: 'FITS_OTHER', locked: false, ra: null, dec: null, sigma: null,
          matched: 0, budget_ms: 0, wall_ms: 0, false_positive: false,
          pixel_scale_arcsec: null, rotation_deg: null, parity: null,
          cost: { centers_tried: 0, sweeps: 0, escalations: 0, catalog_pages: 0 },
          locking_tool: 'none', provenance: { fits_arm: ARM, recorded_center_is_frame: true, psf_attribution: null, forced_photometry: null }, threw: String(e?.message || e),
        };
      }
      fs.writeFileSync(outFile, JSON.stringify(raw, null, 2), 'utf8');
      const inf = raw.provenance?.psf_attribution?.tracking?.inference ?? 'n/a';
      const tag = raw.locked ? `LOCKED ${raw.ra?.toFixed?.(4)}h ${raw.matched} matched (track=${inf})` : `no-lock${raw.threw ? ' THREW:' + raw.threw : ''}`;
      console.log(`[FITS-BIND] arm#${ARM} ${frame}: ${tag} (${raw.wall_ms}ms)`);
      // Data-collection binding: assert only that a raw result was produced (a
      // no-lock is a valid OUTCOME graded downstream, never a test failure).
      expect(raw).toBeTruthy();
      expect(raw.frame).toBe(frame);
    }, 400_000);
  }
});
