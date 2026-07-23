// ═══════════════════════════════════════════════════════════════════════════
// CR2 REAL-PIPELINE BINDING for the Validation & Graduation Harness
// (candidate: uw_anchor_topN — SOLVER_UW_ANCHOR_CANDIDATES 1 OFF / 3 ON)
// ═══════════════════════════════════════════════════════════════════════════
//
//   CR2_DUMPS="a.app.json,b.app.json" CR2_OUTDIR=... CR2_BUDGET_MS=90000 \
//     SOLVER_UW_ANCHOR_CANDIDATES=1 \
//     npx vitest run -c tools/validation/cr2_binding.config.ts
//
// Drives the REAL solver_entry ultra-wide path (anchored rotation sweep →
// verifyWCS) headlessly, at test speed, for EACH CR2 detection dump — the same
// setup pattern as tools/dslr/uw_solve.uwspec.ts (atlas fetch shim, planets as
// extraSearchCenters, scale-locked). This is the calibrated-path A/B ARM the
// validation harness runner cannot do in-process: SOLVER_UW_ANCHOR_CANDIDATES is
// read by pipeline_config at MODULE-LOAD time, so each arm (OFF=1 / ON=3) MUST
// be a fresh process with the env set before import. The parent orchestrator
// (run_cr2_sweep.ts) spawns this twice and pairs the raw results into trials.
//
// `locked` ≡ passed the REAL calibrated verifyWCS gate (Poisson excess + sun
// veto → forensic UW_VERIFY_PASS). result.success additionally needs WCS
// finalization via a wasm fn the headless mock lacks, so it is recorded but is
// NOT the lock arbiter here (it is ~always false in this harness). Never invents
// a lock: the calibrated gate is the sole arbiter.
//
// Forced-photometry ESCALATION is inert here by design: it needs a native pixel
// buffer (imageData.data is empty in the headless harness), so the solver
// honestly skips it. This binding therefore grades the ANCHORED SWEEP + verify
// only; escalations cost is 0. Documented, not hidden.

import { describe, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { solvePlate } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const ROOT = process.cwd();
const ANCHOR_N = PIPELINE_CONSTANTS.SOLVER_UW_ANCHOR_CANDIDATES; // 1 (OFF) or 3 (ON), fixed for this process
const BUDGET_MS = process.env.CR2_BUDGET_MS ? parseInt(process.env.CR2_BUDGET_MS, 10) : 90_000;
const OUTDIR = process.env.CR2_OUTDIR || path.join(ROOT, 'test_results', 'validation', '_cr2_raw');
const DUMPS = (process.env.CR2_DUMPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// ── atlas fetch shim + per-solve catalog-page counter ──
// StarCatalogAdapter fetches /atlas/*.json in the browser; serve from disk and
// count sector pages so the harness can report a real catalog_pages cost proxy.
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

/** Distill a solve into the raw RunResult the harness's extractSolverOutcome consumes. */
function distill(result: any, wallMs: number, dump: any, sweepsBefore: number) {
  const forensics: any[] = result?.diagnostics?.forensics ?? [];
  const sweepPeaks = forensics.filter((f) => f?.status === 'UW_SWEEP_PEAK' && f.uw_peak);
  const verifyPasses = forensics
    .filter((f) => f?.status === 'UW_VERIFY_PASS' && f.uw_verify)
    .map((f) => f.uw_verify)
    .sort((a: any, b: any) => b.sigma - a.sigma);
  const escalations = forensics.filter((f) => f?.status === 'UW_ESCALATION').length;
  const sunVetoes = forensics.filter((f) => f?.status === 'UW_SUN_VETO').length;

  // locked ≡ passed the calibrated verifyWCS gate at ≥1 center.
  const best = verifyPasses[0] || null;
  const locked = best !== null;

  // distinct swept centers (cost proxy) vs total sweep operations (anchor-inflated).
  const centerKeys = new Set(sweepPeaks.map((f) => `${f.uw_peak.ra0}|${f.uw_peak.dec0}`));
  const bestPeakZ = sweepPeaks.length
    ? Math.max(...sweepPeaks.map((f) => f.uw_peak.z))
    : null;

  // WCS finalization (result.success) — recorded for transparency, NOT the arbiter.
  const finalized = !!(result?.success && result?.solution);

  return {
    // ── RunResult fields consumed by extractSolverOutcome ──
    locked,
    ra: best ? best.ra0 : null,
    dec: best ? best.dec0 : null,
    sigma: best ? best.sigma : null,
    matched: best ? best.matches : 0,
    budget_ms: wallMs,
    wall_ms: wallMs,
    // false_positive left UNSET (false) HERE: it is decided downstream in
    // run_cr2_sweep.ts:merge() by the truth-adjudication layer (resolveTruth →
    // applyTruthToRunResult), never fabricated. See `recorded_center_is_frame`
    // below — this harness records the verify ANCHOR center, so a frame-center
    // truth is NOT compared against it (honest-absent), and merge keeps it false.
    false_positive: false,
    // ── efficiency cost proxies ──
    cost: {
      centers_tried: centerKeys.size,
      sweeps: sweepPeaks.length,
      escalations, // 0 in headless (no pixel buffer → forced photometry skipped)
      catalog_pages: catalogPages - sweepsBefore,
    },
    locking_tool: locked ? 'uw_anchored_sweep' : 'none',
    // ── extra provenance (sidecar for the visual generator; not in SolverOutcome) ──
    provenance: {
      anchor_n: ANCHOR_N,
      finalized_wcs: finalized,
      // TRUTH COMPARABILITY: raw.ra/dec = best.ra0 = the VERIFY ANCHOR center (a
      // bright in-field star/planet), NOT the finalized frame center — wide-field
      // these differ by many degrees. So a frame-center truth label must NOT be
      // center-compared against this result (would flag a correct solve). Always
      // false in this anchored-sweep harness; the FITS/narrow-field rail that
      // records/finalizes a frame center is what sets this true. See
      // truth/harness_hook.ts:recordedCenterIsFrameCenter.
      recorded_center_is_frame: false,
      best_peak_z: bestPeakZ,
      sweep_gate: PIPELINE_CONSTANTS.SOLVER_UW_SWEEP_MIN_Z,
      verify_passes: verifyPasses.length,
      sun_vetoes: sunVetoes,
      // winning geometry the visual generator can re-project catalog stars through:
      winning_center: best ? { ra_h: best.ra0, dec_deg: best.dec0, matches: best.matches, unique: best.unique, sigma: best.sigma } : null,
      dump_file: dump.file ?? null,
      dets: Array.isArray(dump.detections) ? dump.detections.length : 0,
      scale_arcsec_px: dump.scaleArcsecPerPx,
      planets: (dump.planets ?? []).map((p: any) => ({ name: p.name, ra_h: p.ra_hours, dec_deg: p.dec_degrees })),
    },
  };
}

describe(`CR2 binding (anchor#${ANCHOR_N})`, () => {
  fs.mkdirSync(path.join(OUTDIR, `anchor${ANCHOR_N}`), { recursive: true });

  for (const dumpRel of DUMPS) {
    const frame = path.basename(dumpRel).replace(/\.(app\.)?json$/i, '');
    it(`${frame} (anchor#${ANCHOR_N})`, async () => {
      const outFile = path.join(OUTDIR, `anchor${ANCHOR_N}`, `${frame}.json`);
      let raw: any;
      try {
        const dump = JSON.parse(fs.readFileSync(path.join(ROOT, dumpRel), 'utf8'));
        const { width, height, scaleArcsecPerPx, detections, planets = [] } = dump;
        const detectedStars = detections.map((d: any) => ({ x: d.x, y: d.y, flux: +d.flux, fwhm: d.fwhm }));
        // Empty pixel buffer (detections-only) — same as uw_solve.uwspec. This is
        // WHY forced-photometry escalation self-skips (honest, documented above).
        const imageData = { width, height, data: new Uint8ClampedArray(0), colorSpace: 'srgb' } as any;
        const extra = planets.map((p: any) => ({ ra: p.ra_hours, dec: p.dec_degrees, name: p.name }));

        catalogPages = 0;
        const pagesBefore = 0;
        // silence solver console spam (keep the run readable)
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
        raw = distill(result, wallMs, dump, pagesBefore);
        raw.frame = frame;
        raw.image_type = 'CR2_DSLR';
        raw.threw = threw ? String(threw?.message || threw) : null;
      } catch (e: any) {
        // Ingest/parse failure — record an honest non-lock so the orchestrator
        // still pairs the frame (never a silent drop).
        raw = {
          frame, image_type: 'CR2_DSLR', locked: false, ra: null, dec: null, sigma: null,
          matched: 0, budget_ms: 0, wall_ms: 0, false_positive: false,
          cost: { centers_tried: 0, sweeps: 0, escalations: 0, catalog_pages: 0 },
          locking_tool: 'none', provenance: { anchor_n: ANCHOR_N }, threw: String(e?.message || e),
        };
      }
      fs.writeFileSync(outFile, JSON.stringify(raw, null, 2), 'utf8');
      const tag = raw.locked ? `LOCKED +${raw.sigma}σ` : `no-lock peakZ=${raw.provenance?.best_peak_z ?? 'n/a'}`;
      // one concise progress line to stdout (console.log restored)
      console.log(`[CR2-BIND] anchor#${ANCHOR_N} ${frame}: ${tag} (${raw.wall_ms}ms, ${raw.cost.sweeps} sweeps)`);
    }, Math.max(BUDGET_MS + 120_000, 240_000));
  }
});
