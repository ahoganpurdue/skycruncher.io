/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: PACKAGE — receipt assembly (C1 consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure serialization — reads both ledgers, mutates none).
 *
 * The receipt's contract version is `RECEIPT_SCHEMA_VERSION` (schema_versions.ts,
 * the single source of truth — see that file's changelog for the additive-block
 * history); this module emits it as `version` and never hand-pins a number here.
 *
 * The wizard receipt in ONE place:
 *
 *   - `generateReceiptWcs`: emits the FITTED WCS — the crpix/crval/CD matrix
 *     that actually verified the matched stars — never a re-synthesized
 *     approximation (the synthesized branch survives only as an explicit
 *     SOURCE:'SYNTHESIZED' fallback when no fitted matrix exists).
 *   - `buildReceipt`: solution summary with sentinel-filtered residuals,
 *     REAL mean FWHM (not the solver's residual proxy), matched-star list
 *     with peeked per-channel samples, planets (ephemeris handshake), spcc
 *     block (divergence #6), warnings[] + timestamp_trusted provenance.
 *
 * Notes:
 *   - The Float32Array stripping replacer lives in the pure module
 *     `stages/receipt_serializer.ts` (serializeReceipt — I0.2 extraction;
 *     `ui/utils/save_packet.ts` delegates to it for the browser download).
 *     It strips typed arrays at JSON.stringify time; the receipt built here
 *     still carries live refs.
 *   - The auto path's science packet (AstroSciencePacket, <100KB) is a
 *     DIFFERENT product and already has one home:
 *     `m9_export/serializer.buildAstroPacket`. No duplication to collapse.
 */

import type {
    CatalogBand,
    ForensicMetrics,
    HardMetadata,
    HardwareProfile,
    PlateSolution,
    SignalPacket,
    SignalPoint,
    SolarBody,
    SolveDiagnostics
} from '../../types/Main_types';
import type { StageTimingSummary } from '../../events/stage_timing_summary';
import type { SpccBlock } from '../m9_export/serializer';
import type { SpccPerStar } from './science';
import type { PsfFieldReport } from '../m10_psf/psf_field';
import { serializePsfFieldBlock } from './psf_characterize';
import type { PsfAttributionReport } from './psf_attribution';
import { serializePsfAttributionBlock } from './psf_attribution';
import type { FinalAstrometryReport } from './final_astrometry';
import { serializeFinalAstrometryBlock } from './final_astrometry';
import type { MeasuredDistortion } from '../m2_hardware/lens_distortion_refit';
import { serializeMeasuredDistortionBlock, measureBrownConradyFromSolution } from '../m2_hardware/lens_distortion_refit';
import type { OpticsHint } from '../../core/optics_hint_provider';
import { RECEIPT_SCHEMA_VERSION } from './schema_versions';
import { getActiveConfigOverrides, PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { classifyConfirmStatus } from '../m6_plate_solve/confirm_status';
import { buildSolveProvenance, type HintProvenanceSource, type SolveFailedAttempt } from './solve_provenance';
import type { UserAnnotations } from './user_annotations';
import { buildUserTargetHint } from './user_target_hint';
import type { CallerTargetHint } from './solve';
import { buildNebulosityLayerReceipt, type NebulosityDecomposition } from '../m10_psf/nebulosity_layer';
import type { ComputeRouteStamp } from '../m3_gpu_preprocess/compute_routes';
import { BINARY_LAYOUTS } from '../../contracts/binary_layouts';

// ——— FITTED WCS EMISSION —————————————————————————————————————————————————————

/**
 * Prefer the REAL fitted WCS — the crpix/crval/CD matrix that actually
 * verified the matched stars — over re-synthesizing an approximation from
 * the scalar scale/rotation summary (the old path fabricated CRPIX at the
 * image center and a hand-rolled CD that ignored the fit).
 * Engine conventions: crval[0] is HOURS (FITS CRVAL1 is degrees), CD is
 * deg/px, pixel origin 0-based y-down image space (a true FITS writer with
 * 1-based/flipped conventions is the Phase D deliverable).
 */
export function generateReceiptWcs(
    solution: PlateSolution | null,
    imageWidth: number,
    imageHeight: number
): Record<string, any> | null {
    if (!solution) return null;

    const sol = solution;
    const fitted = sol.wcs;
    if (fitted?.crpix && fitted?.crval && fitted?.cd) {
        return {
            CTYPE1: 'RA---TAN',
            CTYPE2: 'DEC--TAN',
            CRPIX1: fitted.crpix[0],
            CRPIX2: fitted.crpix[1],
            CRVAL1: fitted.crval[0] * 15,
            CRVAL2: fitted.crval[1],
            CD1_1: fitted.cd[0][0],
            CD1_2: fitted.cd[0][1],
            CD2_1: fitted.cd[1][0],
            CD2_2: fitted.cd[1][1],
            EQUINOX: 2000.0,
            RADESYS: 'ICRS',
            SOURCE: 'FITTED',
            COMMENT: 'SkyCruncher fitted WCS - engine pixel convention (0-based, y-down)'
        };
    }

    // Fallback: synthesized approximation (no fitted matrix available).
    const scaleDeg = sol.pixel_scale / 3600;
    const rotRad = (sol.rotation_deg || 0) * Math.PI / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);

    return {
        CTYPE1: 'RA---TAN',
        CTYPE2: 'DEC--TAN',
        CRPIX1: imageWidth / 2,
        CRPIX2: imageHeight / 2,
        CRVAL1: sol.ra_hours * 15,
        CRVAL2: sol.dec_degrees,
        CD1_1: -scaleDeg * cosR,
        CD1_2:  scaleDeg * sinR,
        CD2_1:  scaleDeg * sinR,
        CD2_2:  scaleDeg * cosR,
        EQUINOX: 2000.0,
        RADESYS: 'ICRS',
        SOURCE: 'SYNTHESIZED'
    };
}

// ——— PER-STAR PHOTOMETRY (SCHEMA B) ——————————————————————————————————————————

/** Raw instrumental magnitude −2.5·log10(flux); null for non-positive/absent flux. */
function instMag(flux: number | null | undefined): number | null {
    return typeof flux === 'number' && Number.isFinite(flux) && flux > 0 ? -2.5 * Math.log10(flux) : null;
}

/**
 * [SCHEMA B · ATMOSPHERE_SEXTANT_SPEC inc 4] Consolidated per-star photometry
 * block — PURE SURFACING of computation already in the solution/SPCC, tagged with
 * the catalog band per row (never pooled). Provenances: MATCHED (blind detections
 * that verified), CATALOG_FORCED (deep_verify aperture photometry at predicted
 * positions), SPCC (per-channel aperture photometry on the FITS science frame).
 * Every record carries the SAME key set (null where a field does not apply —
 * honest-absent, never zero-filled). alt/X are null here: no observer/location is
 * in the receipt-assembly scope; the tools/atmosphere lane computes per-star alt/X.
 * Returns null when no per-star photometry exists (null-on-absence, psf_field pattern).
 */
function buildPhotometryBlock(
    sol: PlateSolution | null,
    spccStars: SpccPerStar[] | undefined,
): any | null {
    if (!sol) return null;
    const stars: any[] = [];

    const rec = (r: {
        gaia_id: string | null; x: number; y: number;
        provenance: 'MATCHED' | 'CATALOG_FORCED' | 'SPCC';
        flux: number | null; flux_rgb?: { r: number; g: number; b: number } | null;
        flux_rgb_kind?: 'APERTURE_RGB' | 'PEAK_RGB' | null;
        m_inst: number | null; snr?: number | null; flux_err?: number | null;
        inst_color?: number | null; cat_mag: number | null;
        cat_band: CatalogBand | null; cat_bp_rp?: number | null;
        measured_bv?: number | null;
    }) => ({
        gaia_id: r.gaia_id, x: r.x, y: r.y, provenance: r.provenance,
        flux: r.flux, flux_rgb: r.flux_rgb ?? null, flux_rgb_kind: r.flux_rgb_kind ?? null,
        m_inst: r.m_inst, snr: r.snr ?? null, flux_err: r.flux_err ?? null,
        inst_color: r.inst_color ?? null, cat_mag: r.cat_mag, cat_band: r.cat_band,
        cat_bp_rp: r.cat_bp_rp ?? null, measured_bv: r.measured_bv ?? null,
        // honest-absent: per-star alt/airmass need an observer/location not in scope here.
        alt_deg: null, airmass: null,
    });

    // MATCHED — scalar detected flux + per-channel PEAK (labeled, NOT aperture flux).
    for (const m of (sol.matched_stars ?? [])) {
        const d = m.detected as unknown as SignalPoint;
        const flux = m.detected.flux ?? null;
        stars.push(rec({
            gaia_id: m.catalog.gaia_id ?? null, x: m.detected.x, y: m.detected.y,
            provenance: 'MATCHED', flux, m_inst: instMag(flux),
            flux_rgb: d.peak_rgb ? { r: d.peak_rgb[0], g: d.peak_rgb[1], b: d.peak_rgb[2] } : null,
            flux_rgb_kind: d.peak_rgb ? 'PEAK_RGB' : null,
            cat_mag: Number.isFinite(m.catalog.mag) ? m.catalog.mag : null,
            cat_band: m.catalog.band ?? null, cat_bp_rp: m.catalog.bv ?? null,
            measured_bv: d.measured_bv ?? null,
        }));
    }

    // CATALOG_FORCED — deep_verify aperture photometry (luminance) at predicted
    // positions. flux_err recovered from the forcedMeasure noise (flux/snr). The
    // catalog band is not carried onto deep_forced.stars → honest-absent.
    for (const f of (sol.deep_forced?.stars ?? [])) {
        stars.push(rec({
            gaia_id: f.gaia_id ?? null, x: f.x, y: f.y, provenance: 'CATALOG_FORCED',
            flux: f.flux, m_inst: instMag(f.flux), snr: f.snr,
            flux_err: f.snr && f.snr !== 0 ? f.flux / f.snr : null,
            cat_mag: f.mag, cat_band: null,
        }));
    }

    // SPCC — per-channel aperture photometry on the FITS science frame (FITS lane).
    // cat_band is the star's ACTUAL per-row band (never pooled) — SPCC assumes Gaia G
    // in its fit, but a HYG-matched star is Johnson V and is labeled honestly here.
    for (const s of (spccStars ?? [])) {
        stars.push(rec({
            gaia_id: s.gaia_id, x: s.x, y: s.y, provenance: 'SPCC',
            flux: s.flux_g,
            flux_rgb: (s.flux_r != null && s.flux_g != null && s.flux_b != null)
                ? { r: s.flux_r, g: s.flux_g, b: s.flux_b } : null,
            flux_rgb_kind: (s.flux_r != null) ? 'APERTURE_RGB' : null,
            m_inst: s.m_inst, inst_color: s.inst_color,
            cat_mag: s.cat_g, cat_band: s.cat_band, cat_bp_rp: s.cat_bp_rp,
        }));
    }

    if (stars.length === 0) return null; // null-on-absence

    return {
        note: 'Per-star instrumental photometry surfaced from existing computation '
            + '(ATMOSPHERE_SEXTANT_SPEC inc 4). m_inst = -2.5·log10(flux) for MATCHED/'
            + 'CATALOG_FORCED (raw instrumental); SPCC m_inst is the gain-LUT instrumental '
            + 'magnitude. Catalog band is per row (Gaia G vs Johnson V) — never pooled. '
            + 'alt_deg/airmass are NOT MEASURED here (no observer/location in scope).',
        provenance_counts: {
            matched: (sol.matched_stars ?? []).length,
            catalog_forced: (sol.deep_forced?.stars ?? []).length,
            spcc: (spccStars ?? []).length,
        },
        stars,
    };
}

// ——— RECEIPT ASSEMBLY ————————————————————————————————————————————————————————

export interface ReceiptInputs {
    metadata: HardMetadata | null;
    signal: SignalPacket | null;
    solution: PlateSolution | null;
    /** Ephemeris handshake output ([] when no guests were in the field). */
    planets: SolarBody[];
    hardware: HardwareProfile | null;
    forensics: ForensicMetrics | null;
    /** ScaleManager frontend export (already-serializable scalars). */
    scales: any;
    /** Honest degradation notices accumulated during the run. */
    warnings: string[];
    /** False when the capture timestamp is a wall-clock fallback / unset clock. */
    timestampTrusted: boolean;
    /** SPCC block (divergence #6) — absent/undefined => null in the receipt. */
    spcc: SpccBlock | undefined;
    /** [SCHEMA B] SPCC per-star photometry (undefined when SPCC did not run). */
    spccStars?: SpccPerStar[] | undefined;
    /** M10 PSF-field characterization (null when the stage didn't run / no solve). */
    psfField?: PsfFieldReport | null;
    /** M10 PSF-attribution decomposition (null when the stage didn't run / no solve). */
    psfAttribution?: PsfAttributionReport | null;
    /** M2 MEASURED per-capture Brown-Conrady (null when no solve / no WCS). Always-on observation. */
    bcMeasured?: MeasuredDistortion | null;
    /** [schema 2.20.0] Step-6 TERMINAL astrometric refit — a SECOND provenance-
     *  tagged WCS (PSF centroids + differential refraction + SNR weighting). A
     *  PRODUCT; never overwrites the solve WCS. null when the terminal pass did
     *  not run / honest-absent (no solve / no fitted WCS / no PSF field / <20 matches). */
    finalAstrometry?: FinalAstrometryReport | null;
    /** Labelled focal-length ASSUMPTIONS that seeded the scale lock (untrusted-FL
     *  hint-provider seam). Empty/absent ⇒ null block (honest-absent). Never measured. */
    opticsHints?: OpticsHint[] | undefined;
    /** [PROVENANCE §7] The wizard hint-resolution rung that seeded the winning
     *  search (WizardHintResolution['source']). Maps to solve_provenance.solved_via.
     *  Undefined/null ⇒ solve_provenance is null (honest-absent — never a guessed
     *  'blind'). */
    hintSource?: HintProvenanceSource | null;
    /** [PROVENANCE §7] Earlier attempts that failed before recovery (richer-on-
     *  failure). Absent/empty on a clean solve. No producer in the Monday slice
     *  (no escalation loop yet) — the shape is forward-compatible. */
    solveFailedAttempts?: SolveFailedAttempt[];
    /** [TESTIMONY] Observer-supplied free-text annotations (user_annotations.ts).
     *  String-only, NEVER parsed into the solve — structurally separate from the
     *  solve-feeding SoftMetadata. null when the observer supplied nothing
     *  (honest-or-absent); null on both pinned reference solves (they never set it),
     *  so the receipt stays byte-identical apart from the additive block. */
    userAnnotations?: UserAnnotations | null;
    /** [PROVENANCE · schema 2.13.0] The RAW decoder arm that ACTUALLY produced this
     *  frame's sensor pixels: 'rawler' (default arm) | 'libraw' (VITE_DECODER_RAWLER=0
     *  cold path) | null when NO raw decode occurred (FITS-native → pure-TS FITS
     *  decoder; already-rendered demo-tier JPEG/TIFF → browser decode). The caller
     *  (session) supplies the honest value from its source-format + the flag read —
     *  NEVER guessed from the flag alone (a FITS frame under the default flag did NOT
     *  run rawler). Undefined/absent ⇒ null in the receipt (honest-or-absent, LAW 3). */
    decoderArm?: 'rawler' | 'libraw' | null;
    /** [HINT · schema 2.14.0] The explicit caller target hint supplied on upload
     *  (CallerTargetHint). Surfaced as `user_target_hint` ONLY when it seeded the
     *  winning search (hintSource==='CONFIG' ⟺ solve_provenance.solved_via=
     *  'assisted:user'). Undefined/null ⇒ null block (blind solve / no hint). */
    callerHint?: CallerTargetHint | null;
    /** [RENDER · schema 2.14.0] Multiscale nebulosity decomposition
     *  (m10_psf/nebulosity_layer.ts, decomposeNebulosityLayers). A DEFAULT-OFF render
     *  producer with NO stage wired into the solve path today, so this is always
     *  absent ⇒ `nebulosity_layer: null` (honest producer-gap; the widget shows
     *  DECOMPOSITION NOT RUN). When a render stage runs it, the block lights up. */
    nebulosityDecomposition?: NebulosityDecomposition | null;
    /** [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Honest stamps of which compute
     *  path each GPU-capable seam (demosaic / preview) ACTUALLY took this run. The
     *  session accumulates them (demosaic stamp from ingest + the preview-seam choice)
     *  and passes them here. Undefined/empty ⇒ `compute_routes: null` (honest-or-absent:
     *  old receipts, or a path that never reached a seam). Pure diagnostic — never a
     *  measurement or a gate input, so both pinned reference solves stay byte-identical. */
    computeRoutes?: ComputeRouteStamp[];
    imageWidth: number;
    imageHeight: number;
}

// ——— PIPELINE PROVENANCE (schema 2.13.0) ————————————————————————————————————————

/** DDIA population-gate provenance: which RAW DECODER ARM produced the frame pixels +
 *  which ATLAS the solve matched against. Honest-or-absent (LAW 3) throughout. */
export interface PipelineProvenance {
    /** Raw decoder arm that ACTUALLY decoded this frame; null = no raw decode (FITS / demo-tier). */
    decoder_arm: 'rawler' | 'libraw' | null;
    /** Committed LAW-7 golden fingerprint (md5) of the shipped atlas; null if none recorded on-box. */
    atlas_id: string | null;
    /** Honest origin of atlas_id (or why it is null). Explicit that atlas_id is a
     *  BUILD-TIME manifest md5, not a runtime hash of the loaded sectors. */
    atlas_version_source: string;
}

/** Build the {@link PipelineProvenance} block (pure).
 *
 *  Atlas CONTENT identity is read from the SINGLE engine-side source of truth: the
 *  LAW-7 binary-layout contract for the `atlas_rows` boundary. Its `goldenVector.md5`
 *  is the committed aggregate fingerprint of the shipped deep catalog (2 anchors + 36
 *  sectors), pointing at `tools/atlas/atlas_repro_manifest.json`. That md5 is what
 *  CHANGES on a deliberate atlas rebaseline — exactly the denominator a populated DB
 *  needs to interpret records across atlas versions. It is a BUILD-TIME manifest md5,
 *  NOT a runtime hash of the loaded sectors (the adapter does not hash what it fetches);
 *  `atlas_version_source` states this so no consumer over-reads it as a load-time
 *  integrity proof. null (with an honest source string) when no golden vector exists —
 *  never a fabricated version string. */
export function buildPipelineProvenance(
    decoderArm: 'rawler' | 'libraw' | null | undefined,
): PipelineProvenance {
    const atlasRows = BINARY_LAYOUTS.find(b => b.name === 'atlas_rows');
    const golden = atlasRows?.goldenVector ?? null;
    return {
        decoder_arm: decoderArm ?? null,
        atlas_id: golden?.md5 ?? null,
        atlas_version_source: golden
            ? `binary_layouts#atlas_rows goldenVector — committed LAW-7 golden fingerprint (${golden.manifestPath}); ` +
              'BUILD-TIME manifest md5, NOT a runtime hash of the loaded sectors'
            : 'NOT MEASURED — no goldenVector recorded on binary_layouts#atlas_rows (no atlas content fingerprint on-box)',
    };
}

// ——— COMPUTE ROUTES (schema 2.16.0) ——————————————————————————————————————————————

/** [COMPUTE-ROUTE OBSERVABILITY] Assemble the honest-or-absent `compute_routes`
 *  block from the seam stamps the run accumulated. Returns the stamps verbatim
 *  (a shallow copy — pure diagnostic data), or null when none were recorded
 *  (old receipts / a path that never reached a GPU-capable seam). LAW 3:
 *  honest-or-absent, never fabricated. */
export function buildComputeRoutesBlock(
    routes: ComputeRouteStamp[] | undefined,
): ComputeRouteStamp[] | null {
    return routes && routes.length > 0 ? routes.map(r => ({ ...r })) : null;
}

// ——— NO-SOLVE FAILURE RECEIPT ————————————————————————————————————————————————
//
// The analytics flywheel needs a frame that produced NO geometric lock to still
// bank an honest record instead of vanishing. This is a SEPARATE product from the
// solved receipt (`buildReceipt` above is UNTOUCHED, so the pinned reference solves
// stay byte-identical by construction): it carries `kind:'no_solve'` +
// `solution:null` so a consumer (batch engine `solutionOf` / run.mjs
// `receipt.solution != null`) reads it as a no-solve, never a fabricated success.
//
// HONEST-OR-ABSENT (LAW 3): every field is either a MEASURED value the run already
// produced (detection counts + culling tally from the signal packet; the solve
// ladder's own diagnostics incl. branch_timing quad/uw_sweep/uw_escalation attempts;
// per-stage wall-ms from the event fold) or an explicit null. Nothing is invented —
// in particular the heavy signal typed-arrays are reduced to COUNTS (not embedded),
// and every block a solved receipt would carry (wcs/psf/spcc/…) is null here.
// Ledger: NEITHER (pure serialization of already-computed state).

export interface FailureReceiptInputs {
    /** Ingest metadata reached before the solve failed (null if step1/2 never set it). */
    metadata: HardMetadata | null;
    /** Detected signal packet — the source of the detection + culling counts. null when
     *  extraction never produced one. Reduced to counts here (typed arrays are NOT banked). */
    signal: SignalPacket | null;
    /** The solve ladder's OWN diagnostics (quads/matches/rejection_reasons/branch_timing).
     *  Retained existing stage output — NOT new instrumentation. null when the solve
     *  produced none (e.g. it threw before diagnostics were assembled). */
    solveDiagnostics: SolveDiagnostics | null;
    /** Per-stage wall-ms folded from the run's event stream (summarizeStageTimings), or
     *  null when no fold is available. Honest partial-run summary (ok=false / null). */
    stageTimings: StageTimingSummary | null;
    /** Last stage that ran to completion before the failure (e.g. 'solve'). */
    stageReached: string;
    /** The stage where the run stopped (e.g. 'solve' for a no-geometric-lock). */
    stageOfDeath: string;
    /** Human-readable reason (the session's terminal status string), or null. */
    failReason: string | null;
    /** Content SHA-256 of the source frame (dedup / integrity key). null when unhashed. */
    frameSha256: string | null;
    /** Magic-byte source format ('FITS' / 'CR2' / …). */
    sourceFormat: string | null;
    /** Honest degradation notices accumulated during the run. */
    warnings: string[];
    /** False when the capture timestamp was a wall-clock fallback / unset clock. */
    timestampTrusted: boolean;
    /** RAW decoder arm that ACTUALLY decoded the frame ('rawler'/'libraw'), or null when
     *  no raw decode ran (FITS-native / demo-tier). Same honesty as the solved receipt. */
    decoderArm: 'rawler' | 'libraw' | null;
    /** Non-null ONLY when a stage THREW (vs a clean no-geometric-lock) — the error message. */
    errorMessage?: string | null;
    /** [SOLVE_FAILURE_DIAGNOSTICS · default OFF] Precomputed measured-diagnostic block
     *  (buildFailureDiagnosticsBlock) — the closest the refused solve came, incl. a
     *  MEASURED bc_measure on any verified-but-dropped near-miss's real matched pairs.
     *  null when the flag is OFF or nothing near-missed. Additive; never re-enters a solve. */
    failureDiagnostics?: any | null;
    /** [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Honest seam route stamps the run
     *  accumulated before it failed (a frame that demosaic-skipped or CPU-fell-back
     *  still banks the route). Undefined/empty ⇒ `compute_routes: null`. */
    computeRoutes?: ComputeRouteStamp[];
    imageWidth: number;
    imageHeight: number;
}

/**
 * [SOLVE_FAILURE_DIAGNOSTICS · default OFF] Build the honest measured-diagnostic block
 * from the solve ladder's RETAINED diagnostics — a record of the CLOSEST a refused
 * solve came, so every refusal becomes a learning artifact. PURE; reads diagnostics,
 * mutates nothing; NEVER re-enters the solve.
 *
 * Two honest, independent parts (either may be null):
 *   • `best_sweep_sigma` — the max sub-threshold anchored-sweep σ across the retained
 *     per-candidate forensics (UW_SWEEP_PEAK / UW_ESCALATION): "how close did any
 *     orientation come" + its sky center. Pure extraction — no new instrumentation.
 *   • `near_miss` — the best VERIFIED-BUT-DROPPED candidate (confidence_floor_drop,
 *     retained in diagnostics.best_near_miss). Because it carries REAL provisional
 *     matched pairs, bc_measure runs on it → MEASURED k1/k2 (labeled MEASURED, or an
 *     honest not_measured reason when coverage is too thin). Its WCS is summarized.
 *
 * Returns null when neither part exists (honest-absent). The heavy near-miss solution
 * is NEVER embedded — only the derived scalars are banked.
 */
export function buildFailureDiagnosticsBlock(
    d: SolveDiagnostics | null,
    width: number,
    height: number,
): any | null {
    if (!d) return null;

    // (1) Best sub-threshold anchored-sweep σ from the retained forensics.
    let bestSweepSigma: number | null = null;
    let bestSweepSource: string | null = null;
    let bestSweepCenter: { ra_hours: number; dec_deg: number } | null = null;
    for (const f of (Array.isArray(d.forensics) ? d.forensics : [])) {
        let z: number | null = null;
        let ra0: number | null = null;
        let dec0: number | null = null;
        if (f?.uw_peak && Number.isFinite(f.uw_peak.z)) {
            z = f.uw_peak.z; ra0 = f.uw_peak.ra0 ?? null; dec0 = f.uw_peak.dec0 ?? null;
        } else if (f?.uw_escalation && Number.isFinite(f.uw_escalation.sweepZ)) {
            z = f.uw_escalation.sweepZ; ra0 = f.uw_escalation.ra0 ?? null; dec0 = f.uw_escalation.dec0 ?? null;
        }
        if (z != null && (bestSweepSigma == null || z > bestSweepSigma)) {
            bestSweepSigma = z;
            bestSweepSource = String(f?.status ?? 'UW_SWEEP');
            bestSweepCenter = (ra0 != null && dec0 != null) ? { ra_hours: ra0, dec_deg: dec0 } : null;
        }
    }

    // (2) Best verified-but-dropped near-miss → MEASURED bc_measure on real pairs.
    let nearMiss: any = null;
    const nm = d.best_near_miss;
    if (nm && nm.solution) {
        const bc = measureBrownConradyFromSolution(nm.solution, width, height);
        const wcs: any = nm.solution.wcs;
        const wcsSummary = (wcs && wcs.crval && wcs.crpix && wcs.cd) ? {
            ra_hours: wcs.crval[0], dec_deg: wcs.crval[1], crpix: wcs.crpix, cd: wcs.cd,
        } : null;
        const bcMeasured = !!bc && !bc.not_measured;
        nearMiss = {
            confidence: nm.confidence ?? null,
            matched: nm.matched,
            wcs_summary: wcsSummary,
            bc_measured: bcMeasured ? {
                provenance: bc!.provenance,
                k1: bc!.k1, k2: bc!.k2,
                n_pairs: bc!.n_pairs, n_used: bc!.n_used,
                rms_2d_px: bc!.rms_2d_px, baseline_rms_2d_px: bc!.baseline_rms_2d_px,
                terms: bc!.terms,
            } : null,
            // Honest reason when bc could not fit (coverage too thin, or no WCS/pairs).
            bc_not_measured: bcMeasured ? null : (bc?.not_measured ?? 'no provisional matched pairs to fit'),
        };
    }

    if (bestSweepSigma == null && nearMiss == null) return null; // honest-absent

    return {
        note: 'DIAGNOSTIC ONLY (SOLVE_FAILURE_DIAGNOSTICS) — a MEASURED record of the '
            + 'closest a refused solve came. best_sweep_sigma is the top sub-threshold '
            + 'anchored-sweep σ; near_miss is a verified-but-dropped candidate with '
            + 'bc_measure fitted from its REAL matched pairs. NEVER re-enters the solve.',
        best_sweep_sigma: bestSweepSigma,
        best_sweep_source: bestSweepSource,
        best_sweep_center: bestSweepCenter,
        near_miss: nearMiss,
    };
}

/** Assemble the honest NO-SOLVE failure receipt (pure — no session reach-back).
 *  Discriminated from a solved receipt by `kind:'no_solve'` + `solution:null`. */
export function buildFailureReceipt(i: FailureReceiptInputs): any {
    const sig = i.signal;
    // Detection + culling COUNTS (culling_stats) — never the heavy typed-array buffers.
    const detection = sig ? {
        clean_stars: sig.clean_stars?.length ?? 0,
        anomalies: sig.anomalies?.length ?? 0,
        planet_candidates: sig.planet_candidates?.length ?? 0,
        culling_tally: sig.culling_tally ?? null,
        background_level: Number.isFinite(sig.background_level) ? sig.background_level : null,
        noise_floor: Number.isFinite(sig.noise_floor) ? sig.noise_floor : null,
    } : null;

    // What the solve ladder ATTEMPTED — retained existing SolveDiagnostics. branch_timing
    // is keyed solve.quad_wasm / solve.uw_sweep / solve.uw_escalation ({ms, attempts}); a
    // branch never tried is ABSENT (honest NOT MEASURED), never a fake 0.
    const d = i.solveDiagnostics;
    const solve_attempts = d ? {
        solve_time_ms: Number.isFinite(d.solve_time_ms) ? d.solve_time_ms : null,
        quads_detected: d.quads_detected ?? null,
        quads_catalog: d.quads_catalog ?? null,
        matches_found: d.matches_found ?? null,
        verified_clusters: d.verified_clusters ?? null,
        peak_background_ratio: Number.isFinite(d.peak_background_ratio) ? d.peak_background_ratio : null,
        reflection_detected: d.reflection_detected ?? null,
        center_lock_verified: d.center_lock_verified ?? null,
        rejection_reasons: Array.isArray(d.rejection_reasons) ? d.rejection_reasons : [],
        branch_timing: d.branch_timing ?? null,
    } : null;

    return {
        version: RECEIPT_SCHEMA_VERSION,
        // DISCRIMINATOR: solved receipts carry no `kind`; consumers also key on
        // `solution === null`. Both identify this as a no-solve record.
        kind: 'no_solve',
        failure: {
            stage_reached: i.stageReached,
            stage_of_death: i.stageOfDeath,
            reason: i.failReason,
            // Non-null ONLY when a stage threw (vs a clean no-geometric-lock).
            error: i.errorMessage ?? null,
        },
        frame_sha256: i.frameSha256,
        source_format: i.sourceFormat,
        image_width: i.imageWidth,
        image_height: i.imageHeight,
        metadata: i.metadata,
        detection,
        solve_attempts,
        // Per-stage wall-ms up to the failure (partial-run fold; ok=false/null).
        stage_timings: i.stageTimings,
        // [SOLVE_FAILURE_DIAGNOSTICS · default OFF] Measured record of the closest the
        // refused solve came (best sub-threshold sweep σ + a verified-but-dropped
        // near-miss with bc_measure on its real pairs). null when the flag is OFF or
        // nothing near-missed. Additive; a diagnostic, NEVER a solve input.
        failure_diagnostics: i.failureDiagnostics ?? null,
        // Same DDIA population-gate provenance as a solved receipt (decoder arm + atlas id).
        pipeline_provenance: buildPipelineProvenance(i.decoderArm),
        // [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Same honest seam route stamps
        // as a solved receipt — a failed frame still banks which compute path each
        // GPU-capable seam took (or null when none reached). Honest-or-absent.
        compute_routes: buildComputeRoutesBlock(i.computeRoutes),
        // ── Honest nulls: every block a SOLVED receipt would carry is absent here. ──
        solution: null,
        wcs: null,
        planets: [],
        spcc: null,
        psf_field: null,
        psf_attribution: null,
        // [schema 2.20.0] no solve ⇒ no terminal refit (honest-absent).
        final_astrometry: null,
        lens_distortion_measured: null,
        optics_hints: null,
        deep_confirmed: null,
        confirm_status: null,
        source_provenance: i.metadata?.source_provenance ?? null,
        solve_provenance: null,
        user_annotations: null,
        // [schema 2.14.0] rawler_calibration rides HardMetadata, so a frame that
        // rawler-decoded before the solve failed still banks its honest calibration;
        // null on the libraw/FITS/demo-tier arms. user_target_hint is null (the block
        // is the value companion to a SUCCESSFUL assisted:user solve — there is none
        // here). nebulosity_layer is null (no producer / no solve).
        rawler_calibration: i.metadata?.rawler_calibration ?? null,
        user_target_hint: null,
        nebulosity_layer: null,
        hardware: null,
        forensics: null,
        warnings: i.warnings,
        timestamp_trusted: i.timestampTrusted,
        export_date: new Date().toISOString(),
    };
}

/** Assemble the wizard receipt (version = RECEIPT_SCHEMA_VERSION, schema_versions.ts).
 *  Pure — no session reach-back. */
export function buildReceipt(i: ReceiptInputs): any {
    const sol = i.solution;

    // Sentinel-filtered matches (planetary-verification flags — 9999 /
    // +1000 penalties — are not astrometric measurements).
    const measured = (sol?.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) &&
        m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_')
    );
    const meanResidualArcsec = measured.length > 0
        ? measured.reduce((s, m) => s + m.residual_arcsec, 0) / measured.length
        : null;
    // REAL mean FWHM of the matched stars. The old `fwhm` field forwarded
    // diagnostics.avg_fwhm, which the solver documents as a RESIDUAL proxy
    // — an arcsec residual masquerading as a PSF width.
    const fwhmSamples = measured
        .map(m => m.detected.fwhm)
        .filter((f): f is number => typeof f === 'number' && f > 0);
    const meanFwhmPx = fwhmSamples.length > 0
        ? fwhmSamples.reduce((s, f) => s + f, 0) / fwhmSamples.length
        : (i.forensics?.mean_fwhm || null);

    // [§11b] Experimental config-override stamp (null on a calibrated run).
    const configOverrides = getActiveConfigOverrides();

    // [SCHEMA A · COORDINATE ledger] Per-star 2D residual vectors. The fitted CD
    // (deg/px) maps the pixel residual (det − predicted) into a tangent-plane sky
    // residual; parity/rotation ride the CD signs and are NEVER asserted here.
    // rig_correction_applied documents whether these residuals are post-BC (the
    // measured Brown-Conrady rematch was APPLIED); SIP is fit-but-not-applied to
    // the linear verify residuals, so it does not flip this flag.
    const fittedCd = (sol?.wcs?.cd as [[number, number], [number, number]] | undefined) ?? null;
    const rigCorrectionApplied = !!(sol?.bc_rematch?.applied);

    return {
        version: RECEIPT_SCHEMA_VERSION,
        metadata: i.metadata,
        signal: i.signal,
        solution: sol ? {
            ra_hours: sol.ra_hours,
            dec_degrees: sol.dec_degrees,
            pixel_scale: sol.pixel_scale,
            roll_degrees: sol.rotation_deg || 0,
            parity: sol.parity,
            confidence: sol.confidence,
            fov_width_deg: sol.fov_width_deg,
            fov_height_deg: sol.fov_height_deg,
            spatial_hash: sol.spatial_hash,
            mean_fwhm_px: meanFwhmPx,
            mean_residual_arcsec: meanResidualArcsec,
            stars_matched: sol.matched_stars?.length ?? sol.diagnostics?.stars_matched ?? 0,
            solve_time_ms: sol.diagnostics?.solve_time_ms ?? null,
            // M7 residual analysis + SIP fit (null when never computed)
            astrometry: sol.astrometry ?? null,
            // [M2 · COORDINATE ledger] PRIMARY BC rematch record (edge-star
            // densification driven by the measured Brown-Conrady). On KEPT_ORIGINAL
            // the solve above is byte-identical; on APPLIED the densified match set
            // + refit SIP are already reflected in stars_matched/astrometry. null
            // when the pass did not run (no measured BC / no solve).
            bc_rematch: sol.bc_rematch ?? null,
            // [SCHEMA A] True when the residual vectors below are post-BC (the
            // measured Brown-Conrady rematch was APPLIED to the final match set).
            rig_correction_applied: rigCorrectionApplied,
            // The per-star science: catalog identity + detected position +
            // per-channel peak samples (peeked from the linear RGB frame).
            matched_stars: (sol.matched_stars ?? []).map(m => {
                const d = m.detected as unknown as SignalPoint;
                // [SCHEMA A] real 2D residual vector (px, det − predicted) captured
                // at verify time; tangent-plane sky residual derived through the
                // fitted CD (parity included). null-on-absence (legacy/no-CD).
                const rv = m.residual;
                const dRaArcsec = rv && fittedCd ? (fittedCd[0][0] * rv.dx + fittedCd[0][1] * rv.dy) * 3600 : null;
                const dDecArcsec = rv && fittedCd ? (fittedCd[1][0] * rv.dx + fittedCd[1][1] * rv.dy) * 3600 : null;
                return {
                    gaia_id: m.catalog.gaia_id ?? null,
                    name: m.catalog.name ?? null,
                    ra_deg: m.catalog.ra,
                    dec_deg: m.catalog.dec,
                    mag: m.catalog.mag,
                    bv: m.catalog.bv ?? null,
                    // [SCHEMA B] catalog band `mag` is in (Gaia G vs Johnson V), per row.
                    cat_band: m.catalog.band ?? null,
                    x: m.detected.x,
                    y: m.detected.y,
                    flux: m.detected.flux ?? null,
                    fwhm: m.detected.fwhm ?? null,
                    residual_arcsec: m.residual_arcsec,
                    dx_px: rv ? rv.dx : null,
                    dy_px: rv ? rv.dy : null,
                    dRA_arcsec: dRaArcsec,
                    dDec_arcsec: dDecArcsec,
                    peak_rgb: d.peak_rgb ?? null,
                    measured_bv: d.measured_bv ?? null
                };
            }),
            // [SCHEMA B · ATMOSPHERE_SEXTANT_SPEC inc 4] Consolidated per-star
            // instrumental photometry (MATCHED + CATALOG_FORCED + SPCC), band-tagged
            // per row. Pure surfacing; null-on-absence. The extinction/Langley
            // verticals read m_inst + cat_band + flux from here.
            photometry: buildPhotometryBlock(sol, i.spccStars),
        } : null,
        // Ephemeris handshake output (projected solar-system bodies with
        // per-body residuals/locks); [] when no guests were in the field.
        planets: i.planets,
        wcs: generateReceiptWcs(i.solution, i.imageWidth, i.imageHeight),
        // [SPCC] Spectrophotometric color calibration (FITS wizard runs;
        // null = did not run). C1 divergence-#6 fix — visible, not silent.
        spcc: i.spcc ?? null,
        // [M10] Spatially-varying PSF field at the solved positions (PIXEL
        // ledger; null = characterization did not run / no solve). Additive.
        psf_field: i.psfField ? serializePsfFieldBlock(i.psfField) : null,
        // [M10] PSF ATTRIBUTION — physics decomposition of the measured PSF into
        // {sidereal drift / diffraction / seeing / differential refraction / coma}
        // + residual (PIXEL ledger; null = attribution did not run / no solve).
        // Physics INFORMS, never OVERRIDES — additive, psf_field stays the arbiter.
        psf_attribution: i.psfAttribution ? serializePsfAttributionBlock(i.psfAttribution) : null,
        // [FINAL ASTROMETRY · schema 2.20.0 · COORDINATE ledger] The step-6 TERMINAL
        // data-fidelity refit — a SECOND, provenance-tagged WCS re-fit on the
        // evidence-gated matched set with PSF-fit centroids + differential refraction
        // (gated) + SNR-honest weighting. A PRODUCT: never overwrites solution.wcs/
        // astrometry, never mutates matched_stars, never feeds solve/confirm — so both
        // pinned reference solves stay byte-identical (the block is additive). null when
        // the terminal pass honest-skipped (no solve / no fitted WCS / no PSF field / <20 matches).
        final_astrometry: i.finalAstrometry ? serializeFinalAstrometryBlock(i.finalAstrometry) : null,
        // [M2 · COORDINATE ledger] MEASURED per-capture Brown-Conrady, fitted from
        // THIS capture's solver-verified matched pairs. Labeled provenance:'MEASURED'
        // — structurally distinct from the APPROXIMATE library prior (lens_distortion.ts).
        // Pure observation: never mutates the WCS/matched_stars/confidence, so the
        // sacred solve stays byte-identical. null = no solve / no WCS (honest-absent);
        // a report with `not_measured` set = WCS present but coverage too thin to fit.
        lens_distortion_measured: i.bcMeasured ? serializeMeasuredDistortionBlock(i.bcMeasured) : null,
        // [OPTICS · untrusted-FL hint-provider seam] Labelled focal-length
        // ASSUMPTIONS that seeded the scale lock (e.g. the wide-field 14mm prior on
        // the electronics-less 50mm CR2 signature). Makes the historically-silent
        // assumption receipt-visible: each carries assumed:true + a human reason and
        // is NEVER a measurement (LAW 3). null-on-absence (psf_field pattern) — null
        // on a trusted-FL / FITS-header lock (e.g. SeeStar). Additive; the fired hint
        // only SEEDS the search — the verify gate stays the sole arbiter, so the
        // sacred solves are byte-identical whether or not this block is present.
        optics_hints: (i.opticsHints && i.opticsHints.length > 0)
            ? i.opticsHints.map(h => ({
                value_mm: h.value_mm,
                source: h.source,
                assumed: h.assumed,
                reason: h.reason,
            }))
            : null,
        // [FP wave C6] Confirmed forced stars — its OWN block, provenance
        // CATALOG_FORCED_CONFIRMED, structurally distinct from matched_stars and
        // blind detections (never laundered). Honest-or-absent: null when the
        // confirmation pass did not run (no science buffer / no solve). Additive.
        deep_confirmed: i.solution?.deep_confirmed ?? null,
        // [SAFETY CATCHER · schema 2.10.0] DERIVED four-state confirmation verdict
        // over the ALREADY-COMPUTED deep_confirmed block, so a REFUSED / too-few-
        // targets solve is never shown as a plain "solved" (no false confidence).
        // Pure classification — NO gate math, NO calibrated constant changed; the
        // set-gate Z threshold is CITED from SOLVER_CONFIRM_SET_EXCESS_Z. null when
        // there is NO solve (nothing to confirm); an explicit NOT_RUN when a solve
        // exists but the confirmation pass did not run (that absence is now visible,
        // not silent). Byte-identical solve — this reads outputs, computes nothing new.
        confirm_status: sol
            ? classifyConfirmStatus(sol.deep_confirmed, PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z)
            : null,
        // [PROVENANCE] Where the frame's BYTES came from (Google Drive / URL /
        // local-drop), matched at ingest against the intake fetcher's content-sha
        // ledger and carried on HardMetadata. null when the origin is unknown
        // (honest-or-absent, LAW 3 — NEVER fabricated). Additive; the pinned
        // reference solves are bundled sample frames (not intake-fetched), so this
        // is null on both the browser and the headless path — byte-identical.
        source_provenance: i.metadata?.source_provenance ?? null,
        // [PROVENANCE · Escalation Controller spec §7 Monday slice] LEAN solve
        // provenance: ONE field on success (solved_via — the CATEGORY of search
        // prior active when the solve locked) + richer-on-failure failed_attempts
        // (absent on a clean solve; no producer in the Monday slice — there is no
        // escalation loop yet). Pure classification of the already-resolved hint
        // source; the solver / WCS / matched_stars are untouched, so BOTH pinned
        // reference solves stay byte-identical (they assert SOLVE numbers). null
        // when there is NO solve, or when the hint source is not honestly known
        // (never a guessed 'blind' — honest-or-absent, LAW 3). NO wall-clock value
        // enters this block (determinism, spec §6).
        solve_provenance: sol && i.hintSource
            ? buildSolveProvenance(i.hintSource, i.solveFailedAttempts)
            : null,
        // [TESTIMONY · schema 2.12.0] Observer-supplied free-text annotations
        // (description / location / sky / rig / issues + provenance + captured_at).
        // STRING-ONLY testimony — NEVER parsed into the solve, structurally separate
        // from the solve-feeding SoftMetadata. Honest-or-absent: null when the
        // observer supplied nothing (both pinned reference solves never set it, so
        // their receipts carry `user_annotations: null` and the SOLVE stays
        // byte-identical — only the additive block + the version string change).
        user_annotations: i.userAnnotations ?? null,
        // [PROVENANCE · schema 2.13.0 · DDIA population-gate] Which RAW DECODER ARM
        // produced this frame's pixels (rawler default / libraw cold path / null when
        // no raw decode ran — FITS-native, demo-tier) + which ATLAS the solve matched
        // against (committed LAW-7 golden fingerprint). Without these a populated DB
        // record is un-interpretable across decoder-arm flips and atlas rebaselines.
        // Honest-or-absent (LAW 3): decoder_arm from the session's real format+flag,
        // never a flag-only guess; atlas_id is a build-time manifest md5 (atlas_version_
        // source says so), null if none on-box. Pure surfacing — no SOLVE field changes,
        // so BOTH pinned reference solves stay byte-identical.
        pipeline_provenance: buildPipelineProvenance(i.decoderArm),
        // [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Which compute path each
        // GPU-capable seam (demosaic / preview) ACTUALLY took this run — the loud
        // signal that kills silent CPU degrades and invisible seam-skips (memory:
        // gpu-test-coverage-gap; ledger row 448). Each stamp is {seam, route, reason};
        // route ∈ {native_wgpu | webgpu | cpu | skipped}. Pure diagnostic — it reads
        // what already ran, computes NO solve/WCS/gate value, so BOTH pinned reference
        // solves stay byte-identical (they assert SOLVE numbers). Honest-or-absent:
        // null when no seam recorded a route (old receipts / no GPU-capable seam
        // reached). On the headless sacred lanes generatePreviews:false → the preview
        // seam stamps skipped/previews_disabled, and the already-demosaic payloads
        // stamp demosaic/skipped — the invisible skips are now visible.
        compute_routes: buildComputeRoutesBlock(i.computeRoutes),
        // [PROVENANCE · schema 2.14.0] LEAN per-frame RAW calibration the rawler
        // decode arm MEASURED (WB / black+white levels / CFA pattern / optical-black
        // stats), persisted onto HardMetadata at ingest and surfaced here. Present
        // ONLY on the rawler arm; null on the libraw cold path, FITS, and demo-tier
        // (honest-or-absent, LAW 3). Pure surfacing — no calibration is APPLIED (the
        // rail leaves pixels in the raw-ADU domain; value_domain says so). The heavy
        // raw optical-black pixel buffers are already dropped (stats only) by the
        // session's summarizeRawlerCalibration reduction.
        rawler_calibration: i.metadata?.rawler_calibration ?? null,
        // [HINT · schema 2.14.0 · HINT_TAXONOMY §3] The user target hint VALUE behind
        // an assisted:user solve (label + RA/Dec as supplied, assumed:true) — the value
        // companion to solve_provenance.solved_via='assisted:user'. null on a blind
        // solve (hintSource ≠ CONFIG) or when no hint was supplied. A search prior,
        // NEVER a measurement (acceptance consults the verify σ gate alone), so BOTH
        // pinned reference solves (blind CR2 / FITS-GOTO SeeStar) carry null here.
        user_target_hint: sol ? buildUserTargetHint(i.hintSource, i.callerHint) : null,
        // [RENDER · schema 2.14.0] Multiscale starlet nebulosity decomposition block.
        // The producer (decomposeNebulosityLayers) is a DEFAULT-OFF render tool with NO
        // stage wired into the solve path today, so this is null on every real receipt
        // (honest producer-gap — the NebulosityLayersWidget shows DECOMPOSITION NOT RUN).
        // buildNebulosityLayerReceipt(null) ⇒ null; wiring a producer stage lights it up.
        nebulosity_layer: buildNebulosityLayerReceipt(i.nebulosityDecomposition ?? null),
        hardware: i.hardware,
        forensics: i.forensics,
        scales: i.scales,
        // Honest provenance: degradation notices + whether the timestamp
        // came from the file (vs processing wall-clock fallback).
        warnings: i.warnings,
        timestamp_trusted: i.timestampTrusted,
        // [§11b] Experimental knob overrides threaded at runtime via
        // applyConfigOverrides (config-as-argument seam). GUARDRAIL: `experimental`
        // is true and `config_overrides` carries the applied {key:value} map ONLY
        // when a knob was overridden — so an experimental run can NEVER be mistaken
        // for a calibrated one. Honest-or-absent: null / false on a calibrated run
        // (the default, byte-identical when no override is applied).
        config_overrides: configOverrides,
        experimental: configOverrides != null,
        export_date: new Date().toISOString()
    };
}
