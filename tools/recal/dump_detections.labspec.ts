/**
 * Paired threshold-recal — DECODE-mode per-detection DUMP producer (rail #14).
 * Spawned per frame by tools/recal/dump_detections.mjs with env:
 *   RECAL_DUMP_FILE  — RAW frame to decode + detect (required)
 *   RECAL_DUMP_OUT   — REQUIRED absolute path for the per-detection dump JSON
 *   RECAL_DUMP_ARM   — 'rawler' (default; the cutover target) | 'libraw' (control)
 *                      → sets VITE_DECODER_RAWLER so extractRawSensorData routes
 *                        through decodeRawlerForPipeline (rawler wasm) or libraw.
 *   RECAL_DUMP_SIGMAS— comma list, RECORDED in meta only (the engine sigma is a
 *                      source literal, NOT injectable from tools/ — see below).
 *
 * This is the recal's DECODE mode (RECAL_DESIGN.md §4 step 2): it runs the REAL
 * m4 detection on the decoded grid ONCE (step1_Load + step2_Extract — detection
 * completes in step2 at orchestrator_session.ts:492; the heavy blind solve is
 * NOT run) and emits every clean detection with its per-blob {x,y,snr,fwhm,
 * sharpness,ellipticity}. It does NOT fork a second decode: it reuses the exact
 * headless_driver + OrchestratorSession + VITE_DECODER_RAWLER seam that
 * tools/rawlab/ab_live.mjs and tools/api/headless_driver drive.
 *
 * HONEST SIGMA NOTE (RECAL_DESIGN §5): the primary sigma (`sigFactor`/vanguard
 * base) is a COMPILED SOURCE LITERAL in signal_processor.ts — it cannot be
 * injected from a tools/ lane without an engine edit (out of this lane's scope).
 * So the dump captures the FULL detection set at the engine's NATIVE sigma (the
 * most permissive achievable), each detection carrying its own per-blob SNR.
 * Candidate sigmas ABOVE native are realized DOWNSTREAM in sweep_thresholds as
 * per-detection SNR-floor re-thresholds on this set — a POST-HOC approximation
 * of a true pixel-level sigma re-run, labeled NOT MEASURED as a true re-run.
 *
 * The ONLY assertion here is that the dump was written; there are NO verdicts and
 * NO thresholds changed. Collected by NO standing gate (*.labspec.ts suffix).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Importing headless_driver installs the Node Worker bridge the decode needs.
import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
// ── calibrated-grid A/B (cutover #14): reuse the REAL m4 detect stage ──────────
// The calibrated arm cannot re-enter the wasm to demosaic, so it demosaics JS-side
// (tools/calib/demosaic, BIT-VERIFIED vs wasm rgb16_active) and runs the SAME
// shared `detectSignal` stage OrchestratorSession itself calls — NOT a second
// detector. Both arms share the identical harness so the delta isolates ONLY the
// calibration.
import { detectSignal } from '@/engine/pipeline/stages/detect';
import { ScaleManager } from '@/engine/pipeline/m2_hardware/scale_manager';
import { TelemetryLogger } from '@/engine/diagnostics/telemetry_logger';
import { reduceToLuminance, LUMA_REC709 } from '@/engine/pipeline/m4_signal_detect/luminance_reduce';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';
import { decodeCfa } from '../calib/decode_util.mjs';
import { demosaicActiveRGB } from '../calib/demosaic.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.RECAL_DUMP_FILE ?? '';
const OUT = process.env.RECAL_DUMP_OUT ?? '';
const ARM = process.env.RECAL_DUMP_ARM === 'libraw' ? 'libraw' : 'rawler';
const SIGMAS = (process.env.RECAL_DUMP_SIGMAS ?? '')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

// Calibrated-grid A/B mode — set by dump_detections.mjs --calibrated:
const CALIB_LIGHT = process.env.RECAL_CALIB_LIGHT ?? '';
const CALIB_BIN = process.env.RECAL_CALIB_BIN ?? '';          // full-calibrated CFA .bin
const CALIB_OUT = process.env.RECAL_CALIB_OUT ?? '';
const CALIB_DARK_MAN = process.env.RECAL_CALIB_DARK_MANIFEST ?? '';
const CALIB_MODE = !!CALIB_BIN;

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

describe(`recal dump — ${ARM} arm`, () => {
    it.skipIf(CALIB_MODE)(`decodes ${path.basename(FILE)} and dumps per-detection m4 output`, async () => {
        expect(FILE, 'RECAL_DUMP_FILE is required (set by dump_detections.mjs)').toBeTruthy();
        expect(OUT, 'RECAL_DUMP_OUT is required (set by dump_detections.mjs)').toBeTruthy();
        expect(fs.existsSync(FILE), `input file missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const session = new OrchestratorSession(ab, { generatePreviews: false });
        const steps: Record<string, { ok: boolean; ms: number; error?: string }> = {};
        let halted: string | null = null;

        const runStep = async (name: string, fn: () => Promise<unknown>) => {
            if (halted) return undefined;
            const t0 = Date.now();
            try {
                const out = await fn();
                steps[name] = { ok: true, ms: Date.now() - t0 };
                return out;
            } catch (err) {
                steps[name] = { ok: false, ms: Date.now() - t0, error: String((err as Error)?.message ?? err) };
                halted = name;
                return undefined;
            }
        };

        // Detection completes in step2_Extract — stop there (no metrology/solve).
        await runStep('step1_Load', () => session.step1_Load());
        await runStep('step2_Extract', () => session.step2_Extract());

        const sig = session.signal as any;
        const clean: any[] = sig?.clean_stars ?? [];

        // Per-detection dump — RECAL_DESIGN §1 schema: {x,y,snr,fwhm,sharpness,
        // ellipticity}. UNITS TRAP (load-bearing): the engine's shape gates
        // (m4/detection_cuts.ts evaluateBlobCuts:159-167) compare DETECT_FWHM_FLOOR_PX
        // against `momentFwhmPx`, DETECT_SHARPNESS_MAX against `sharpness`, and
        // DETECT_ELLIPTICITY_MAX against `momentEllipticity`. So the dump's
        // gate-relevant top-level fields carry those EXACT quantities — NOT the
        // native-scaled `fwhm` (~arcsec-ish, ~100) nor the `1−circularity`
        // ellipticity proxy — so sweep_thresholds' re-threshold reproduces the
        // engine cut faithfully. The native-scaled/proxy values are kept under
        // `extra` (labeled), never mixed into a gate. mag is ABSENT at m4 (no
        // catalog cross-match) → null (sweep treats null-mag survivors as
        // AMBIGUOUS, never a confident FP).
        //
        // NOTE — dump = POST-CULL survivors (session.signal.clean_stars are what
        // m4 kept). DUMP-mode shape-gate candidates can therefore only reproduce
        // the engine at-or-TIGHTER than the native cull; a LOOSER (recall-ceiling)
        // candidate cannot recover already-culled blobs from this dump — that
        // needs a pre-cull blob tap (engine-side, out of the tools/ lane). The
        // sweep labels the looser candidate accordingly.
        const detections = clean.map((s) => ({
            x: num(s?.x),
            y: num(s?.y),
            snr: num(s?.snr),
            fwhm: num(s?.moment_fwhm_px),          // detection-grid px — the DETECT_FWHM_FLOOR_PX gate quantity
            sharpness: num(s?.sharpness),          // the DETECT_SHARPNESS_MAX gate quantity
            ellipticity: num(s?.moment_ellipticity), // the DETECT_ELLIPTICITY_MAX gate quantity
            mag: null as number | null,
            extra: {
                flux: num(s?.flux),
                fwhm_native_scaled: num(s?.fwhm),  // native-restored FWHM (NOT the gate quantity — units trap)
                circularity: num(s?.circularity),
                ellipticity_from_circularity: num(s?.ellipticity), // 1−circularity proxy (NOT the gate quantity)
                peak: num(s?.peak ?? s?.peak_value),
            },
        }));

        const meta = {
            producer: 'tools/recal/dump_detections.labspec.ts',
            decoder: ARM === 'rawler' ? 'rawler (VITE_DECODER_RAWLER=1)' : 'libraw (control)',
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            file: FILE,
            file_basename: path.basename(FILE),
            file_bytes: buf.byteLength,
            // frame geometry / pattern from the session metadata (post-decode).
            pattern: (session as any).metadata?.bayerPattern
                ?? (session as any).metadata?.sensorData?.bayerPattern ?? null,
            dims: {
                width: (session as any).imageWidth ?? null,
                height: (session as any).imageHeight ?? null,
            },
            focal_length: (session as any).metadata?.focal_length ?? null,
            // The engine's native primary sigma is a compiled literal — recorded as
            // the sigma this dump's detection set was produced AT. Candidate sigmas
            // are applied downstream as SNR floors (see header + RECAL_DESIGN §5).
            // increment-3 hook: the primary sigmas are now injectable via the
            // TEST-ONLY engine overrides RECAL_SIGFACTOR / RECAL_SIGMA_BASE
            // (signal_processor.ts recalSigma). This dump was produced at the
            // sigma below (null ⇒ compiled defaults 2.0 / 3.0, byte-identical).
            sigma_native_note: 'engine primary sigma (signal_processor.ts sigFactor=2.0 / vanguard base=3.0 FL-scaled). Now injectable via RECAL_SIGFACTOR / RECAL_SIGMA_BASE for a TRUE pixel-level sigma re-run (dump_detections.mjs --sigfactor/--sigma-base).',
            recal_sigfactor: process.env.RECAL_SIGFACTOR ?? null,
            recal_sigma_base: process.env.RECAL_SIGMA_BASE ?? null,
            requested_candidate_sigmas: SIGMAS,
            candidate_sigma_realization: 'per-detection SNR floor applied by sweep_thresholds (DUMP mode) in the blob-SNR metric units (SignalPoint.snr, measured median ~0.1–0.4) — NOT the engine pixel-sigma scale, NOT a true pixel-level sigma re-run',
            dump_is_post_cull: 'session.signal.clean_stars = m4 POST-cull survivors; DUMP-mode shape-gate candidates can only reproduce the native cut or tighten it, never recover already-culled blobs (that needs a pre-cull tap, engine-side)',
            culling_tally: sig?.culling_tally ?? sig?.cullingTally ?? null,
            steps,
            halted_at: halted,
            detection_count: detections.length,
            schema: 'recal.dump.v1',
            produced_at: new Date().toISOString(),
        };

        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify({ meta, detections }, null, 2));

        // The one real assertion: the dump exists on disk.
        expect(fs.existsSync(OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// CALIBRATED-GRID A/B (cutover #14): real m4 on uncalibrated vs full-calibrated
// ═══════════════════════════════════════════════════════════════════════════
// Both arms run through ONE shared harness that reuses the engine's real
// `detectSignal` stage (the same call OrchestratorSession makes). The ONLY
// difference between arms is the CFA that enters: the raw decoded grid vs the
// (light − dark)/flat grid produced by tools/calib/calibrate_light. The JS
// demosaic is bit-verified against wasm rgb16_active, so the uncalibrated arm
// equals the real rawler decode. previewFloat32 + luminance are constructed
// exactly as OrchestratorSession.step2 does (nearest-neighbour preview,
// reduceToLuminance REC709 over the /65535 domain).

function sigmaClippedStd(lum: Float32Array): { mean: number; sigma: number } {
    const step = Math.max(1, Math.floor(lum.length / 2_000_000));
    const samp: number[] = [];
    for (let i = 0; i < lum.length; i += step) { const v = lum[i]; if (Number.isFinite(v)) samp.push(v); }
    let m = samp.reduce((a, b) => a + b, 0) / samp.length;
    let s = Math.sqrt(samp.reduce((a, b) => a + (b - m) * (b - m), 0) / samp.length);
    for (let it = 0; it < 3; it++) {
        const lo = m - 3 * s, hi = m + 3 * s; let sm = 0, sc = 0;
        for (const v of samp) if (v >= lo && v <= hi) { sm += v; sc++; }
        if (!sc) break; m = sm / sc; let sv = 0;
        for (const v of samp) if (v >= lo && v <= hi) sv += (v - m) * (v - m);
        s = Math.sqrt(sv / sc);
    }
    return { mean: m, sigma: s };
}

/** Nearest-neighbour RGB downsample — identical to OrchestratorSession.generatePreviewFloat32. */
function previewFloat32Of(rgb: Float32Array, srcW: number, srcH: number, destW: number, destH: number): Float32Array {
    const data = new Float32Array(destW * destH * 3);
    const scaleX = srcW / destW, scaleY = srcH / destH;
    for (let dy = 0; dy < destH; dy++) for (let dx = 0; dx < destW; dx++) {
        const sx = Math.floor(dx * scaleX), sy = Math.floor(dy * scaleY);
        const sIdx = (sy * srcW + sx) * 3, dIdx = (dy * destW + dx) * 3;
        data[dIdx] = rgb[sIdx]; data[dIdx + 1] = rgb[sIdx + 1]; data[dIdx + 2] = rgb[sIdx + 2];
    }
    return data;
}

interface HarnessResult { count: number; bg: { mean: number; sigma: number }; detections: any[]; }

async function harnessDetect(
    cfa: Uint16Array | Float32Array, fullW: number, fullH: number,
    activeArea: { x: number; y: number; w: number; h: number },
    pattern: string, metadata: any, focalLength: number | undefined,
    logger: TelemetryLogger,
): Promise<HarnessResult> {
    const { rgb, width, height } = demosaicActiveRGB(cfa, fullW, fullH, activeArea, pattern);
    // Scale into the /65535 domain the rawler pipeline uses (decodeRawlerForPipeline).
    const inv = 1 / 65535;
    for (let i = 0; i < rgb.length; i++) rgb[i] *= inv;
    const lum = reduceToLuminance(rgb, LUMA_REC709);
    const scales = new ScaleManager(width, height, PIPELINE_CONSTANTS.PREVIEW_MAX_DIM);
    const preview = previewFloat32Of(rgb, width, height, scales.previewW, scales.previewH);
    // rawSensor=null → detectSignal takes the luminance (analyzeWithMasking) branch,
    // the DSLR/demosaiced route (isNativeBayer(null) === false).
    const signal = await detectSignal({
        rawSensor: null, scienceBuffer: lum, previewFloat32: preview,
        width, height, logger, scales, focalLength, metadata,
    });
    const clean: any[] = (signal as any)?.clean_stars ?? [];
    const detections = clean.map((s) => ({
        x: s?.x ?? null, y: s?.y ?? null, snr: s?.snr ?? null,
        fwhm: s?.moment_fwhm_px ?? null, sharpness: s?.sharpness ?? null,
        ellipticity: s?.moment_ellipticity ?? null, flux: s?.flux ?? null,
    }));
    return { count: clean.length, bg: sigmaClippedStd(lum), detections };
}

/** hot-pixel-class survivors: detections landing within 1px of a master-dark hot pixel. */
function hotSurvivors(detections: any[], hotSet: Set<number> | null, fullW: number, activeX: number, activeY: number): number {
    if (!hotSet) return -1;
    let c = 0;
    for (const s of detections) {
        if (s.x == null || s.y == null) continue;
        const fx = Math.round(s.x) + activeX, fy = Math.round(s.y) + activeY;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (hotSet.has((fy + dy) * fullW + (fx + dx))) { hit = true; break; }
        }
        if (hit) c++;
    }
    return c;
}

describe.skipIf(!CALIB_MODE)('recal calibrated A/B — uncalibrated vs full-calibrated', () => {
    it(`runs real m4 on ${path.basename(CALIB_LIGHT)} in BOTH states`, async () => {
        expect(CALIB_LIGHT && fs.existsSync(CALIB_LIGHT), `RECAL_CALIB_LIGHT missing: ${CALIB_LIGHT}`).toBe(true);
        expect(CALIB_BIN && fs.existsSync(CALIB_BIN), `RECAL_CALIB_BIN missing: ${CALIB_BIN}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        // Real metadata path (focal length + optics ladder) via step1_Load only —
        // NO step2 decode here, so OrchestratorSession's rawler loader never inits
        // (avoids a double wasm-decode init; decode_util owns the pixel decode).
        const buf = fs.readFileSync(CALIB_LIGHT);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        const session = new OrchestratorSession(ab, { generatePreviews: false });
        const meta: any = await session.step1_Load();
        const focalLength: number | undefined = meta?.focal_length ?? (session as any).metadata?.focal_length ?? undefined;
        const logger = new TelemetryLogger('recal_calib', { vanguardSigma: 3.0, deepScanSigma: 5.0, maxFwhm: 10, minCircularity: 0.5, planetarytolerancePx: 30 });

        // Decode the raw light on the full CFA grid (uncalibrated arm input).
        const dec = await decodeCfa(CALIB_LIGHT);
        const aa = dec.activeArea ?? { x: 0, y: 0, w: dec.width, h: dec.height };

        // Load the calibrated CFA (full-calibrated arm input) — same full-frame grid.
        const cbuf = fs.readFileSync(CALIB_BIN);
        const calCfa = new Float32Array(cbuf.buffer, cbuf.byteOffset, cbuf.byteLength / 4);
        expect(calCfa.length, 'calibrated grid length != light grid').toBe(dec.width * dec.height);

        // Hot-pixel set from the master dark (full-frame indices > 6σ census threshold).
        let hotSet: Set<number> | null = null; let hotThresh: number | null = null;
        if (CALIB_DARK_MAN && fs.existsSync(CALIB_DARK_MAN)) {
            const dman = JSON.parse(fs.readFileSync(CALIB_DARK_MAN, 'utf8'));
            const dbin = dman.bin_path && fs.existsSync(dman.bin_path) ? dman.bin_path : path.join(path.dirname(CALIB_DARK_MAN), dman.file);
            const dbuf = fs.readFileSync(dbin);
            const dark = new Float32Array(dbuf.buffer, dbuf.byteOffset, dbuf.byteLength / 4);
            hotThresh = dman.validation?.hot_pixel_census?.threshold_adu_6sigma ?? null;
            if (hotThresh != null) { hotSet = new Set(); for (let i = 0; i < dark.length; i++) if (dark[i] > hotThresh) hotSet.add(i); }
        }

        const uncal = await harnessDetect(dec.cfa, dec.width, dec.height, aa, dec.pattern, meta, focalLength, logger);
        const cal = await harnessDetect(calCfa, dec.width, dec.height, aa, dec.pattern, meta, focalLength, logger);

        const uncalHot = hotSurvivors(uncal.detections, hotSet, dec.width, aa.x, aa.y);
        const calHot = hotSurvivors(cal.detections, hotSet, dec.width, aa.x, aa.y);

        const out = {
            meta: {
                producer: 'tools/recal/dump_detections.labspec.ts (calibrated A/B)',
                light: path.basename(CALIB_LIGHT), calibrated_bin: CALIB_BIN,
                dims: { fullWidth: dec.width, fullHeight: dec.height, active: aa },
                pattern: dec.pattern, focal_length: focalLength ?? null,
                harness: 'shared detectSignal stage; JS demosaic bit-verified vs wasm rgb16_active; both arms identical except the CFA calibration',
                hot_census: { source: CALIB_DARK_MAN || null, threshold_adu_6sigma: hotThresh, hot_pixels: hotSet ? hotSet.size : null },
                produced_at: new Date().toISOString(),
            },
            uncalibrated: { detection_count: uncal.count, bg_mean: +uncal.bg.mean.toFixed(6), bg_sigma: +uncal.bg.sigma.toFixed(6), hot_class_survivors: uncalHot },
            calibrated: { detection_count: cal.count, bg_mean: +cal.bg.mean.toFixed(6), bg_sigma: +cal.bg.sigma.toFixed(6), hot_class_survivors: calHot },
            delta: {
                detection_count: cal.count - uncal.count,
                bg_sigma: +(cal.bg.sigma - uncal.bg.sigma).toFixed(6),
                bg_sigma_pct: uncal.bg.sigma ? +(100 * (cal.bg.sigma - uncal.bg.sigma) / uncal.bg.sigma).toFixed(2) : null,
                hot_class_survivors: (uncalHot >= 0 && calHot >= 0) ? calHot - uncalHot : null,
            },
            detections: { uncalibrated: uncal.detections, calibrated: cal.detections },
        };
        fs.mkdirSync(path.dirname(CALIB_OUT), { recursive: true });
        fs.writeFileSync(CALIB_OUT, JSON.stringify(out, null, 2));
        console.log(`[calib_ab] ${path.basename(CALIB_LIGHT)}: uncal=${uncal.count} cal=${cal.count} (Δ${out.delta.detection_count}) · bgσ ${uncal.bg.sigma.toExponential(3)}→${cal.bg.sigma.toExponential(3)} (${out.delta.bg_sigma_pct}%) · hotSurv ${uncalHot}→${calHot}`);
        expect(fs.existsSync(CALIB_OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});
