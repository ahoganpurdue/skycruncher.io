/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN ADAPTIVE — per-image optima + first-look regime correlation (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ties the sandbox together on real SOLVED frames:
 *   FITS lane   — solve→cache→conditions→optimize→separating-power (ground truth).
 *   CR2 lane    — metadata-only EXIF-physics regime (undersampled contrast point;
 *                 TP/FP sweep is browser-gated ⇒ NOT MEASURED, honestly).
 * Writes test_results/adaptive/report.json and prints a summary.
 *
 *   npx vitest run -c tools/adaptive/adaptive.config.ts run_adaptive
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWasm, baselineKnobs, runDetection } from './detect_harness';
import { measureImageConditions, type ImageConditions } from './image_conditions';
import { CatalogProjectedGroundTruth } from './ground_truth';
import { buildGrids, optimizeKnobs, measureSeparatingPower, scoreDetections, type SeparatingPower } from './knob_optimizer';
import { solveAndCache, loadCache, cacheExists, pitchForCamera, type FrameCacheMeta } from './frame_cache';

const WT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_ROOT = path.resolve(WT_ROOT, '..', '..', '..');
const ATLAS_ROOT = path.join(MAIN_ROOT, 'public');           // has atlas/sectors
const CACHE_DIR = path.join(WT_ROOT, 'test_results', 'adaptive');
const CR2_DETS_DIR = path.join(MAIN_ROOT, 'test_results', 'cr2_dets');

// FITS frames to attempt (solvable, diverse). Non-solving frames are skipped honestly.
const FITS_FRAMES: { frame: string; file: string }[] = [
    { frame: 'M66_seestar', file: path.join(WT_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit') },
];
// Optional extra FITS (added if present).
const EXTRA_FITS: { frame: string; file: string }[] = [
    { frame: 'M51_ircut', file: path.join(WT_ROOT, 'Sample Files', 'corpus', 'M51', 'M51 IRCUT 150h.fit') },
];
// Frames ATTEMPTED that do NOT solve headless (verified this session) ⇒ no
// catalog ground truth. Recorded honestly rather than re-ground the slow blind
// solve each run. The 5D3 is thermal-noise-limited (NEXT_MOVES §7); the Carina
// 60Da blind-solve exhausts its candidate search. These are exactly the junky/
// undersampled frames the forced-photometry oracle would unblock.
const NON_SOLVING: { frame: string; reason: string }[] = [
    { frame: 'carina_60Da', reason: 'blind solve exhausted all WASM candidates (verification failed) — no WCS, no ground truth' },
    { frame: '5D3_iso6400_15s', reason: 'thermal-noise-limited DSLR; does not solve (NEXT_MOVES §7). CR2 decode also browser-gated' },
];

const SHAPE_KNOBS = ['fwhmFloorPx', 'sharpnessMax', 'ellipticityMax'] as const;

interface FrameReport {
    frame: string;
    solved: boolean;
    conditions: ImageConditions;
    matchRadiusPx?: number;
    truthNote?: string;
    baseline?: { precision: number; recall: number; f1: number; tp: number; confidentFP: number; ambiguousFP: number; expectedTruth: number; nDet: number };
    optimum?: { precision: number; recall: number; f1: number; knobs: any; evaluations: number; deltaF1: number };
    separatingPower?: Record<string, number>;
    separatingDetail?: SeparatingPower[];
    /** junk-injection probe: same frame with synthetic 2px clumps added at
     *  positions far from any catalog star — isolates regime-discriminability
     *  from the frame's native (near-zero) junk abundance. */
    injectedJunkSepPower?: number;
    injectedJunkNoCutPrecision?: number;
    injectedJunkSepByKnob?: Record<string, number>;
    note?: string;
}

/** Inject K deterministic 2px "thermal" clumps ≥ minDistPx from any truth star. */
function injectJunk(lum: Float32Array, w: number, h: number, truth: { x: number; y: number }[], k: number, minDistPx: number): Float32Array {
    const out = lum.slice();
    // Bright, star-level spikes so they read as CONFIDENT false positives (not
    // ambiguous faint noise): use a high percentile of the frame as the amplitude.
    const sample: number[] = [];
    for (let i = 0; i < out.length; i += 101) sample.push(out[i]);
    sample.sort((a, b) => a - b);
    const p50 = sample[sample.length >> 1] ?? 0;
    const pMax = sample[sample.length - 1] ?? p50;
    // STAR-BRIGHT amplitude (~40% of the brightest pixel above sky) so the junk
    // is unambiguously brighter than the catalog limiting mag ⇒ CONFIDENT false
    // positives (not faint-ambiguous). This is what makes the probe a fair test
    // of the shape cut's ability to separate bright compact junk from real stars.
    const amp = Math.max((pMax - p50) * 0.4, 5 * (p50 || 1e-3));
    let placed = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let guard = 0;
    // fwhm≈2px point source (DETECTABLE by the wasm kernel, small momentFwhm) —
    // the realistic thermal-junk model; a 2px clump is too small to extract.
    const sg = 2.0 / 2.355;
    while (placed < k && guard++ < k * 200) {
        const cx = 20 + Math.floor(rnd() * (w - 40)), cy = 20 + Math.floor(rnd() * (h - 40));
        if (truth.some(t => Math.hypot(t.x - cx, t.y - cy) < minDistPx)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            out[y * w + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
        }
        placed++;
    }
    return out;
}

function condProvSummary(c: ImageConditions): string {
    const measured = Object.entries(c.provenance).filter(([, p]) => p === 'MEASURED').length;
    const notMeasured = Object.entries(c.provenance).filter(([, p]) => p === 'NOT_MEASURED').map(([k]) => k);
    return `${measured} measured; NOT MEASURED: ${notMeasured.join(', ') || 'none'}`;
}

describe('adaptive per-image optimizer on solved frames (increment 4)', () => {
    it('runs the full program on available solved frames + first-look regime correlation', async () => {
        bootWasm();
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const reports: FrameReport[] = [];

        const frames = [...FITS_FRAMES];
        for (const f of EXTRA_FITS) if (fs.existsSync(f.file)) frames.push(f);

        // ── FITS lane ────────────────────────────────────────────────────────
        for (const { frame, file } of frames) {
            if (!fs.existsSync(file)) { console.log(`[run] ${frame}: file missing, skip`); continue; }
            let meta: FrameCacheMeta | null = null;
            if (cacheExists(CACHE_DIR, frame)) {
                console.log(`[run] ${frame}: using cache`);
                meta = loadCache(CACHE_DIR, frame).meta;
            } else {
                console.log(`[run] ${frame}: solving (one-time)…`);
                try { meta = await solveAndCache({ filePath: file, frame, atlasRoot: ATLAS_ROOT, cacheDir: CACHE_DIR }); }
                catch (e) { console.warn(`[run] ${frame}: solve threw — ${(e as Error).message}`); meta = null; }
            }
            if (!meta) {
                reports.push({ frame, solved: false, conditions: {} as ImageConditions, note: 'did not solve — no ground truth (honest skip)' });
                continue;
            }
            const { lum } = loadCache(CACHE_DIR, frame);
            const w = meta.width, h = meta.height;

            // conditions (baseline detection reused for crowding + empirical FWHM)
            const baseRun = runDetection(lum, w, h, baselineKnobs(meta.focal_length));
            const conditions = measureImageConditions({
                frame, lum, width: w, height: h,
                meta: { ...meta, pixel_pitch_um: meta.pixel_pitch_um },
                solved: { ra_hours: meta.ra_hours, dec_degrees: meta.dec_degrees, pixel_scale: meta.pixel_scale },
                detections: baseRun.detections,
            });

            // ground truth
            const gt = await new CatalogProjectedGroundTruth(meta.catalog, meta.wcs, w, h).build();
            const matchRadiusPx = Math.max(2.5, 1.5 * (conditions.measuredMedianFwhmPx ?? 2));
            const baseScore = scoreDetections(baseRun.detections, gt, matchRadiusPx);

            // optimize
            const grids = buildGrids(conditions.predictedFwhmPx, conditions.measuredMedianFwhmPx);
            const opt = optimizeKnobs({ lum, width: w, height: h, truth: gt, matchRadiusPx, focalLengthMm: meta.focal_length, grids });

            // separating power per shape knob (THE headline instrument)
            const sepDetail: SeparatingPower[] = [];
            const sepMap: Record<string, number> = {};
            for (const knob of SHAPE_KNOBS) {
                const values = knob === 'fwhmFloorPx' ? grids.fwhmFloorPx : knob === 'sharpnessMax' ? grids.sharpnessMax : grids.ellipticityMax;
                const sp = measureSeparatingPower({ lum, width: w, height: h, truth: gt, matchRadiusPx, focalLengthMm: meta.focal_length, knob, values });
                sepDetail.push(sp); sepMap[knob] = sp.power;
            }

            // JUNK-INJECTION PROBE: add synthetic 2px clumps far from catalog
            // stars, then measure EACH shape cut's separating power. Isolates
            // regime discriminability from this frame's (near-zero) native junk.
            const junkLum = injectJunk(lum, w, h, gt.stars, Math.max(50, Math.round(conditions.megapixels * 40)), matchRadiusPx + 2);
            const junkSepByKnob: Record<string, number> = {};
            let junkNoCutP = 1;
            for (const knob of SHAPE_KNOBS) {
                const values = knob === 'fwhmFloorPx' ? grids.fwhmFloorPx : knob === 'sharpnessMax' ? grids.sharpnessMax : grids.ellipticityMax;
                const sp = measureSeparatingPower({ lum: junkLum, width: w, height: h, truth: gt, matchRadiusPx, focalLengthMm: meta.focal_length, knob, values });
                junkSepByKnob[knob] = sp.power; junkNoCutP = sp.noCutPrecision;
            }
            const junkSepMax = Math.max(...Object.values(junkSepByKnob));

            reports.push({
                frame, solved: true, conditions, matchRadiusPx: +matchRadiusPx.toFixed(2), truthNote: gt.note,
                baseline: { precision: baseScore.precision, recall: baseScore.recall, f1: baseScore.f1, tp: baseScore.tp, confidentFP: baseScore.confidentFP, ambiguousFP: baseScore.ambiguousFP, expectedTruth: baseScore.expectedTruth, nDet: baseScore.nDetections },
                optimum: { precision: opt.best.score.precision, recall: opt.best.score.recall, f1: opt.best.score.f1, knobs: opt.best.knobs, evaluations: opt.evaluations, deltaF1: +(opt.best.score.f1 - opt.baseline.score.f1).toFixed(4) },
                separatingPower: sepMap, separatingDetail: sepDetail,
                injectedJunkSepPower: junkSepMax, injectedJunkNoCutPrecision: junkNoCutP,
                injectedJunkSepByKnob: junkSepByKnob,
            });
            console.log(`[run] ${frame}: regime=${conditions.samplingRegime}(${conditions.samplingRegimeSource}) empFWHM=${conditions.measuredMedianFwhmPx}px baselineF1=${baseScore.f1} optF1=${opt.best.score.f1} nativeShapeSep=${JSON.stringify(sepMap)} injectedJunkSep=max${junkSepMax.toFixed(3)}(noCutP=${junkNoCutP.toFixed(3)}) byKnob=${JSON.stringify(junkSepByKnob)}`);
        }

        // ── record attempted-but-non-solving frames (honest, no ground truth) ─
        for (const ns of NON_SOLVING) {
            reports.push({ frame: ns.frame, solved: false, conditions: {} as ImageConditions, note: `NOT SOLVED (attempted): ${ns.reason}` });
        }

        // ── CR2 lane (metadata-only EXIF physics; TP/FP browser-gated) ─────────
        const cr2AppJson = path.join(CR2_DETS_DIR, 'sample_observation.app.json');
        if (fs.existsSync(cr2AppJson)) {
            const app = JSON.parse(fs.readFileSync(cr2AppJson, 'utf8'));
            const m = app.metadata ?? {};
            const pitch = m.pixel_pitch_um ?? pitchForCamera(m.camera_model);
            // real Rokinon 14mm is f/2.8 (aperture absent from EXIF for manual glass) — used as a labelled assumption
            const aperture = m.aperture ?? 2.8;
            // conditions WITHOUT a science buffer: synth a tiny flat buffer so the
            // measured-background fields read NOT-informative; the PHYSICS fields
            // (the point of this lane) come purely from metadata.
            const stub = new Float32Array(64 * 64).fill(0.1);
            const cond = measureImageConditions({
                frame: 'CR2_sample_observation', lum: stub, width: 64, height: 64,
                meta: { camera_model: m.camera_model, focal_length: m.focal_length, aperture, pixel_pitch_um: pitch ?? undefined, timestamp: m.timestamp, timestamp_source: 'EXIF', gps_lat: m.gps_lat, gps_lon: m.gps_lon, gps_source: 'DEFAULT' },
                solved: { pixel_scale: app.scaleArcsecPerPx },
                detections: [],
            });
            // empirical FWHM cross-check from the REAL app detections (baseline knobs)
            const appFwhms = (app.detections ?? []).map((d: any) => d.fwhm).filter((v: any) => typeof v === 'number' && v > 0).sort((a: number, b: number) => a - b);
            const appMedFwhm = appFwhms.length ? appFwhms[appFwhms.length >> 1] : null;
            reports.push({
                frame: 'CR2_sample_observation', solved: false, conditions: cond,
                note: `EXIF-physics regime lane (undersampled contrast). aperture f/${aperture} ASSUMED (14mm manual glass, no EXIF). TP/FP sweep browser-gated (CR2 decode needs libraw-wasm in a browser) ⇒ NOT MEASURED. Real-app baseline detections: n=${app.detections?.length ?? 0}, median WASM fwhm≈${appMedFwhm?.toFixed(2) ?? 'n/a'}px @ ${app.scaleArcsecPerPx?.toFixed(1)}"/px.`,
            });
            console.log(`[run] CR2: regime=${cond.samplingRegime}(${cond.samplingRegimeSource}) predCore=${cond.predictedCorePx}px scale=${cond.pixelScaleArcsecPerPx}"/px — undersampled contrast point.`);
        }

        // ── first-look regime correlation (headline) ──────────────────────────
        const solvedReports = reports.filter(r => r.solved && r.separatingPower);
        const correlation = solvedReports.map(r => ({
            frame: r.frame,
            regime: r.conditions.samplingRegime,
            source: r.conditions.samplingRegimeSource,
            measuredFwhmPx: r.conditions.measuredMedianFwhmPx,
            predictedCorePx: r.conditions.predictedCorePx,
            hotPixDensityPerMP: r.conditions.hotPixelDensityPerMP,
            detDensityPerMP: r.conditions.detectionDensityPerMP,
            nativeMaxShapeSepPower: Math.max(...Object.values(r.separatingPower!)),
            injectedJunkSepPower: r.injectedJunkSepPower ?? null,
            injectedJunkNoCutPrecision: r.injectedJunkNoCutPrecision ?? null,
            injectedJunkSepByKnob: r.injectedJunkSepByKnob ?? null,
            shapeSepPower: r.separatingPower,
        }));

        const report = {
            generatedAt: new Date().toISOString(),
            note: 'SANDBOX measurement artifact (tools/adaptive). Detection-knob optima vs ground truth — RECOMMENDER only, never auto-applied (ML=hint-recommender-only). Small-N: SUGGESTS, does not ESTABLISH.',
            frames: reports,
            regimeCorrelation: correlation,
        };
        fs.writeFileSync(path.join(CACHE_DIR, 'report.json'), JSON.stringify(report, null, 1));
        console.log('\n════════ ADAPTIVE REPORT (see test_results/adaptive/report.json) ════════');
        console.log(JSON.stringify(correlation, null, 1));

        // at least the guaranteed FITS frame must have produced a scored optimum
        const anySolved = reports.some(r => r.solved && r.baseline);
        expect(anySolved).toBe(true);
    });
});
