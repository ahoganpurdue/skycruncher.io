/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HINT CENSUS — every headlessly-invocable PRE-SOLVE hinter, per frame, BLIND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npx vitest run -c tools/hinters/hint_census.config.ts
 *
 * Owner directive (2026-07-10): "make sure all of our hinters are tooled up so
 * when we receive the differences we have hints and derived values for
 * everything that matters, in a few different methodologies, to validate
 * against." This census invokes EVERY pre-solve estimator the engine exposes
 * headlessly and records ONE labelled prediction per {quantity, methodology} —
 * INCLUDING explicit nulls where a methodology abstains (honest-or-absent LAW 3:
 * an abstain is data, never zero). NO full plate solve is run (step4 is never
 * reached); the census is arm's-length by construction. TRUTH joins later, in
 * hint_vs_truth.mjs — it is NEVER present here (a blind census cannot see the
 * answer key).
 *
 * TWO PASSES per frame:
 *   PURE  (always) — step1_Load yields HardMetadata (m1 EXIF/FITS reap); the
 *                    pure-metadata hinters (FL ladder, sensor-DB pitch, EXIF
 *                    geometry scale, FITS-header scale) are called directly on
 *                    a SNAPSHOT of that metadata, captured BEFORE any mutating
 *                    stage. Side-effect-free.
 *   SEMI  (default on; HINT_CENSUS_SEMIBLIND=0 to skip) — step2_Extract
 *                    (detection) then (a) an INDEPENDENT forced Tri-Lock
 *                    (MetrologyService.solveScale on the vanguard, regardless of
 *                    which ladder rung would win) and (b) step3_Metrology to
 *                    record the ENGINE's actual ladder lock + its source rung.
 *                    step3 MUTATES metadata.pixel_scale/pitch — which is exactly
 *                    why the PURE snapshot is taken first.
 *
 * UNIT TRAPS honored (see the task inventory):
 *   • FL/scale constant forms: optics lane uses 206.265 (µm→mm fold pre-applied);
 *     the Tri-Lock uses 206265 with FL×1000. Same physics — we never re-fold.
 *   • WIDE_FIELD_FL_PRIOR (14mm) fires ONLY on exif_focal_length===50 + unknown
 *     lens; the Cocoon 60Da set has NO lens EXIF and its FL is NOT 50, so the
 *     prior will NOT fire there (guard is ===50) — captured as an abstain.
 *   • FALLBACK_PITCH_UM (4.3) is an APS-C ASSUMPTION; a full-frame body fed it
 *     mis-scales ~45%. Recorded as source_tier ASSUMED_CONSTANT, never measured.
 *   • pitch key differs: SensorProfile.pixel_size_um vs HardMetadata.pixel_pitch_um.
 *   • ra_hint is HOURS internally — not a census output (pointing hints are a
 *     solve input, recorded as provenance only).
 *
 * LAW 4 tools/ lane: writes ONLY under test_results/. src/ untouched.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver.ts';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import { OpticsManager } from '@/engine/core/optics_manager';
import { queryFocalLengthHintProviders } from '@/engine/core/optics_hint_provider';
import { resolveOpticsFromExif } from '@/engine/pipeline/m2_hardware/optics_resolver';
import { findSensorByCamera } from '@/engine/pipeline/m2_hardware/sensor_db';
import { MetrologyService } from '@/engine/pipeline/m7_astrometry/metrology';
import { deriveRigKey } from '@/engine/pipeline/m2_hardware/workbench_store';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'hinter_census');
const RESULTS = path.join(OUT_DIR, 'census.jsonl');
const SEMI_BLIND = process.env.HINT_CENSUS_SEMIBLIND !== '0';

// Default proof frames (task deliverable #4): bundled CR2 (lying-50mm EXIF →
// 14mm prior tier), one Cocoon 60Da light (NO lens EXIF → prior abstains),
// one SeeStar M66 FITS (header-scale tier). Override with a comma-separated
// HINT_CENSUS_FRAMES for an arbitrary worklist.
const DEFAULT_FRAMES = [
    path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2'),
    path.join(REPO_ROOT, 'Sample Files', 'corpus', 'cocoon_60da', 'lights', 'L_0020_ISO800_240s__18C.CR2'),
    path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit'),
];
const FRAMES = (process.env.HINT_CENSUS_FRAMES
    ? process.env.HINT_CENSUS_FRAMES.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_FRAMES);

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── helpers ────────────────────────────────────────────────────────────────
const finitePos = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
const baseOf = (fn) => fn.replace(/\.(fit|fits|fts|cr2|arw|nef|dng)$/i, '');
const fmtOf = (fn) => (/\.(fit|fits|fts)$/i.test(fn) ? 'FITS' : /\.(cr2|arw|nef|dng)$/i.test(fn) ? 'RAW' : 'unknown');

/** One labelled prediction. value=null is a first-class ABSTAIN, never zero. */
function est(quantity, methodology, value, units, source_tier, note) {
    return { quantity, methodology, value: value ?? null, units, source_tier, note: note ?? null };
}

/**
 * Compute every PURE (metadata-only) methodology from a SNAPSHOT of HardMetadata.
 * No engine mutation: resolveOpticsFromExif is pure, and we still hand it a clone.
 */
function pureMethodologies(meta) {
    const out = [];
    // ── FOCAL LENGTH (mm) ──
    out.push(est('focal_length_mm', 'USER_HINT_focal_length_hint_mm',
        finitePos(Number(meta.focal_length_hint_mm)), 'mm', 'USER_EVIDENCE',
        'highest-trust rung; taken verbatim when finite & >0 (hint=null in optics_manager)'));
    out.push(est('focal_length_mm', 'EXIF_FL_NOMINAL',
        finitePos(Number(meta.focal_length)), 'mm', 'EXIF_NOMINAL_SEED',
        'raw EXIF focal_length tag — nominal/zoom-quantized; seed-grade, not measured'));
    let priorHint = null;
    try {
        priorHint = queryFocalLengthHintProviders({
            exif_focal_length: meta.focal_length,
            lens_string: (meta.lens_model ?? '').toString().trim(),
            explicit_hint_mm: undefined,
        });
    } catch { priorHint = null; }
    out.push(est('focal_length_mm', 'WIDE_FIELD_FL_PRIOR',
        priorHint ? priorHint.value_mm : null, 'mm', 'ASSUMED_PRIOR',
        priorHint ? priorHint.reason : 'declined: not the exif===50 + unknown-lens signature (honest-absent)'));
    out.push(est('focal_length_mm', 'RESOLVED_EFFECTIVE_FL',
        finitePos(OpticsManager.getEffectiveFocalLength(meta)), 'mm', 'RESOLVED_LADDER',
        'trust-ordered ladder winner (user-hint → provider seam → EXIF FL) — the value the engine seeds'));

    // ── PIXEL PITCH (µm) ──
    let dbProfile = null;
    try { dbProfile = findSensorByCamera((meta.camera_model ?? '').toString()); } catch { dbProfile = null; }
    out.push(est('pixel_pitch_um', 'SENSOR_DB_findSensorByCamera',
        dbProfile ? finitePos(dbProfile.pixel_size_um) : null, 'um', 'MEASURED_SENSOR_DB',
        dbProfile ? `matched sensor ${dbProfile.sensor_model}` : 'no sensor-DB match for camera_model (honest-null over wrong profile)'));
    out.push(est('pixel_pitch_um', 'EXIF_FITS_pixel_pitch',
        finitePos(meta.pixel_pitch_um), 'um', 'HEADER_OR_EXIF',
        'pitch surfaced by FITS/EXIF into HardMetadata.pixel_pitch_um'));
    out.push(est('pixel_pitch_um', 'FALLBACK_PITCH_UM',
        OpticsManager.FALLBACK_PITCH_UM, 'um', 'ASSUMED_CONSTANT',
        'APS-C-cell assumption used by the blind Tri-Lock seed; ~45% mis-scale on full-frame — NOT measured'));

    // ── PIXEL SCALE (arcsec/px) ──
    out.push(est('pixel_scale_arcsec_px', 'FITS_HEADER_scale',
        finitePos(meta.pixel_scale), 'arcsec/px', 'MEASURED_HEADER',
        'metadata.pixel_scale from FITS header optics (XPIXSZ/FOCALLEN) — trust ladder rung 1'));
    let exifOptics = null;
    try { exifOptics = resolveOpticsFromExif({ ...meta }); } catch { exifOptics = null; }
    out.push(est('pixel_scale_arcsec_px', 'EXIF_OPTICS_scale',
        exifOptics ? finitePos(exifOptics.pixel_scale) : null, 'arcsec/px', 'SEED_EXIF_GEOMETRY',
        exifOptics
            ? `206.265 × ${exifOptics.pixel_pitch_um}µm(DB) / effFL; nominal-FL seed-grade${exifOptics.hint ? ' (FL via assumed prior)' : ''}`
            : 'declined: no positive FL, empty camera_model, or no sensor-DB pitch (honest-absent)'));

    // ── PROVENANCE (headlessly-invocable derived values; NOT oracle-scorable — recorded for completeness) ──
    let rig = null;
    try { rig = deriveRigKey(meta); } catch { rig = null; }
    out.push(est('rig_identity', 'deriveRigKey',
        rig ? rig.key : null, 'key', rig ? `PROVENANCE_${rig.quality}` : 'PROVENANCE',
        rig ? `body×lens key, tier ${rig.quality} (no body serial surfaced today → MODEL_ONLY)` : 'no metadata'));

    return { methodologies: out, exifOptics };
}

/** The raw metadata snapshot recorded for provenance (descriptive, not a hint). */
function metaSnapshot(meta) {
    return {
        camera_model: meta.camera_model ?? null,
        lens_model: meta.lens_model ?? null,
        focal_length: meta.focal_length ?? null,
        focal_length_hint_mm: meta.focal_length_hint_mm ?? null,
        aperture: meta.aperture ?? null,
        exposure_time: meta.exposure_time ?? null,
        iso_gain: meta.iso_gain ?? null,
        pixel_scale_header: meta.pixel_scale ?? null,
        pixel_pitch_um: meta.pixel_pitch_um ?? null,
        ra_hint_hours: meta.ra_hint ?? null,
        dec_hint_deg: meta.dec_hint ?? null,
        timestamp: meta.timestamp || null,
        timestamp_source: meta.timestamp_source ?? null,
        gps_source: meta.gps_source ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
    };
}

async function censusOne(filePath) {
    const filename = path.basename(filePath);
    const base = baseOf(filename);
    const format = fmtOf(filename);
    const t0 = Date.now();

    bootRealWasm();
    StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
    let session = null;
    const errors = [];
    try {
        const buf = fs.readFileSync(filePath);
        const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        session = new OrchestratorSession(buffer, { generatePreviews: false });
        // Tap the bus so we can record WHICH ladder rung the engine locked from
        // (scale_locked finding carries {arcsecPerPx, source}).
        let lockSource = null;
        session.events?.subscribe?.((e) => {
            if (e?.kind === 'finding' && e.finding?.kind === 'scale_locked') lockSource = e.finding.source;
        });

        // ── PURE pass: step1 reap → snapshot BEFORE any mutating stage ──
        await session.step1_Load();
        const meta = session.metadata ?? {};
        const snapshot = metaSnapshot(meta);
        const { methodologies } = pureMethodologies(meta);
        // Snapshot the seeds the forced Tri-Lock will use (pre-mutation).
        const seedFL = OpticsManager.getEffectiveFocalLength(meta);
        const seedPitch = finitePos(meta.pixel_pitch_um);

        // ── SEMI pass ──
        let detections = null;
        let triLock = null;         // independent forced Tri-Lock
        let engineLock = null;      // engine ladder lock + rung
        if (SEMI_BLIND) {
            try {
                await session.step2_Extract();
                detections = session?.signal?.clean_stars?.length ?? null;

                // (a) INDEPENDENT forced Tri-Lock — runs the WASM triangle match on
                //     the vanguard no matter which ladder rung would win, so the
                //     blind-triangulation prediction is captured even when a header
                //     or EXIF rung short-circuits it in the live pipeline.
                try {
                    const vanguard = (session?.signal?.clean_stars ?? []).slice(0, 10);
                    triLock = await MetrologyService.solveScale(vanguard, seedFL, seedPitch ?? undefined);
                } catch (e) { errors.push('trilock:' + (e?.message ?? String(e)).slice(0, 160)); triLock = null; }

                // (b) ENGINE ladder lock (step3 MUTATES meta.pixel_scale/pitch —
                //     safe now: the PURE snapshot was already taken).
                try {
                    const lockScale = await session.step3_Metrology();
                    engineLock = {
                        scale: finitePos(lockScale),
                        source: lockSource, // captured from the scale_locked finding
                        optics_hints: (session.opticsHints ?? []).map((h) => ({ source: h.source, value_mm: h.value_mm, assumed: h.assumed })),
                    };
                } catch (e) { errors.push('metrology:' + (e?.message ?? String(e)).slice(0, 160)); engineLock = null; }
            } catch (e) { errors.push('extract:' + (e?.message ?? String(e)).slice(0, 200)); }
        }

        // Append the SEMI methodologies (still pre-solve; still no truth).
        methodologies.push(est('pixel_scale_arcsec_px', 'TRIANGULATED_TriLock',
            triLock ?? null, 'arcsec/px', 'SEMI_BLIND_TRILOCK',
            SEMI_BLIND
                ? 'wasm side-ratio triangle match on the vanguard (independent of the winning ladder rung); null = no lock or <3 vanguard stars'
                : 'skipped (HINT_CENSUS_SEMIBLIND=0)'));
        methodologies.push(est('pixel_scale_arcsec_px', 'ENGINE_LADDER_LOCK',
            engineLock?.scale ?? null, 'arcsec/px',
            engineLock?.source ? `ENGINE_LADDER_${engineLock.source}` : 'ENGINE_LADDER',
            SEMI_BLIND
                ? `what step3_Metrology actually locks pre-solve (FITS_HEADER → EXIF_OPTICS → TRIANGULATED); winning rung=${engineLock?.source ?? 'none'}`
                : 'skipped (HINT_CENSUS_SEMIBLIND=0)'));

        return {
            frame: filename, base, path: filePath, format,
            semi_blind: SEMI_BLIND, detections,
            metadata: snapshot,
            engine_optics_hints: engineLock?.optics_hints ?? [],
            methodologies,
            wall_ms: Date.now() - t0,
            errors: errors.length ? errors : null,
        };
    } catch (e) {
        return {
            frame: filename, base, path: filePath, format,
            semi_blind: SEMI_BLIND, detections: null, metadata: null,
            engine_optics_hints: [], methodologies: [],
            wall_ms: Date.now() - t0,
            errors: [...errors, 'fatal:' + (e?.message ?? String(e)).slice(0, 300)],
        };
    } finally {
        StarCatalogAdapter.setAtlasLoader(null);
    }
}

describe('Hint census — every pre-solve hinter, blind, per frame', () => {
    // Fresh results file per pass (the census is small + deterministic; a
    // truncate keeps the jsonl aligned to THIS run's frame worklist).
    fs.writeFileSync(RESULTS, '');
    // eslint-disable-next-line no-console
    console.log(`[census] ${FRAMES.length} frame(s); semi_blind=${SEMI_BLIND}`);

    for (const fp of FRAMES) {
        it(path.basename(fp), async () => {
            const row = await censusOne(fp);
            fs.appendFileSync(RESULTS, JSON.stringify(row) + '\n');
            fs.writeFileSync(path.join(OUT_DIR, `${row.base}.census.json`), JSON.stringify(row, null, 2));
            const scale = row.methodologies.find((m) => m.methodology === 'ENGINE_LADDER_LOCK')?.value;
            const effFL = row.methodologies.find((m) => m.methodology === 'RESOLVED_EFFECTIVE_FL')?.value;
            const prior = row.methodologies.find((m) => m.methodology === 'WIDE_FIELD_FL_PRIOR')?.value;
            // eslint-disable-next-line no-console
            console.log(`[census] ${row.frame} :: fmt=${row.format} det=${row.detections} effFL=${effFL} prior=${prior} engineScale=${scale} (${row.wall_ms}ms)${row.errors ? ' ERR=' + row.errors.join('|') : ''}`);
        });
    }
});
