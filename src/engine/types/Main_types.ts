/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * ASTRO TYPES â€” Consolidated Interfaces
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

import { HardMetadata } from './schema';

// Re-export HardMetadata so consumers only need one import
export * from './schema';
 
export type FlatteningStatus = 'UNFLATTENED' | 'GENERIC_FLATTENED' | 'FINAL_FLATTENING';

export interface SegmentationMasks {
    topography: Float32Array; // Channel 0
    manMade: Float32Array;    // Channel 1
    arboreal: Float32Array;   // Channel 2
    dim: number;              // Usually 1024
}
 
export interface Point {
    x: number;
    y: number;
}

export interface DetectedStar {
    x: number;      // Flattened/Rectilinear coordinate
    y: number;      // Flattened/Rectilinear coordinate
    rawX: number;   // Original sensor coordinate
    rawY: number;   // Original sensor coordinate
    flux: number;
    fwhm: number;
    magnitude?: number; // Used for sorting
    mag?: number;       // Used in match objects
    gaia_id?: string;   // For provenance
    peak_adu?: number;  // Peak pixel value
    snr?: number;       // Signal-to-Noise Ratio
    isPlanet?: boolean; // Identified as a planet
    label?: string;     // e.g. "Jupiter"
    theta?: number;     // Angle of elongation (coma rotation)
    flatteningStatus?: FlatteningStatus;
    // Thermal-noise shape statistics (detection_cuts.ts; absent = not measured):
    sharpness?: number;           // peak/flux ratio
    moment_fwhm_px?: number;      // 2nd-moment FWHM (px, detection grid)
    moment_ellipticity?: number;  // 1 - sigma_minor/sigma_major
}

export interface ExtractionEnvelope {
    bufferWidth: number;   // e.g., 3456
    bufferHeight: number;  // e.g., 2304
    nativeWidth: number;   // e.g., 5184 (from EXIF)
    stars: DetectedStar[]; // Coordinates relative to bufferWidth/Height
}

/**
 * [SCHEMA B] The photometric band a catalog `mag`/`magnitude_V` field actually
 * holds, discriminated PER ROW (the hybrid-atlas trap antidote). Single source of
 * truth for the band union — never pool across members: the native VT/BT/Hp mags
 * of the Tycho/Hipparcos bright supplement differ from Gaia G by ~+0.1..+0.4 mag
 * (larger for red stars), so a mislabel would masquerade as scatter (LAW 3).
 *   - GaiaG       : Gaia DR3 G (atlas Gaia rows, g15u, greenfield hydration)
 *   - JohnsonV    : Johnson V (hardcoded bright standards)
 *   - TychoVT     : Tycho-2 V_T (supplement rows, mag_system 'VT')
 *   - TychoBT     : Tycho-2 B_T (supplement rows, mag_system 'BT' — no VT available)
 *   - HipparcosHp : Hipparcos Hp (supplement rows, mag_system 'Hp')
 */
export type CatalogBand = 'GaiaG' | 'JohnsonV' | 'TychoVT' | 'TychoBT' | 'HipparcosHp';

export interface CatalogStar {
    ra: number;
    dec: number;
    mag: number;
    bv?: number;
    ra_hours?: number;
    dec_degrees?: number;
    name?: string;      // Added for provenence
    gaia_id?: string;   // Added for provenence
    magnitude_V?: number; // Optional: detailed V-band magnitude
    /** [SCHEMA B] Photometric band `mag` holds (per row) — never pooled. Absent
     *  when the source band is unknown. See {@link CatalogBand}. */
    band?: CatalogBand;
    spectral_signature?: { r: number; g: number; b: number }; // For planetary verification
}

export interface MatchedStar {
    detected: DetectedStar;
    catalog: CatalogStar;
    residual?: { dx: number, dy: number };
    residual_arcsec: number;
}

export interface WCSTransform {
    crpix: [number, number];
    crval: [number, number]; 
    cd: [[number, number], [number, number]];
}

export interface StarMeasurement {
    x: number;
    y: number;
    flux: number;
    fwhm: number;
    flux_r?: number; 
    flux_g?: number; 
    flux_b?: number; 
    measured_bv?: number;
    catalog_bv?: number;  
    circularity?: number; 
    theta?: number;
}

export interface SolveDiagnostics {
    solve_time_ms: number;
    quads_detected: number;
    quads_catalog: number;
    matches_found: number;
    verified_clusters: number;
    /**
     * Peak/background ratio from the background model. A path that runs no
     * background model (greenfield Rust core) omits it — ABSENT (honest NOT
     * MEASURED), never a fake 0. The receipt boundary maps non-finite → null.
     */
    peak_background_ratio?: number;
    rejection_reasons: string[];
    reflection_detected?: boolean;
    center_lock_verified?: boolean;
    forensics?: any[]; // Track candidate detail for debugging
    /**
     * Per-branch solve timing (A3 flowchart honesty). Keyed by the branch stage
     * id (`solve.quad_wasm` / `solve.uw_sweep` / `solve.uw_escalation`). Sums the
     * ALREADY-MEASURED wall-ms (wasmTimeMs / sweepMs / escMs) and attempt count
     * across EVERY center/anchor tried, so LOSING branches carry real ms — not
     * winner-only. Pure observation: no solve logic reads it (byte-identical).
     * A branch never attempted is ABSENT (honest NOT MEASURED), never a fake 0.
     */
    branch_timing?: Record<string, { ms: number; attempts: number }>;
    /**
     * Best VERIFIED-BUT-DROPPED candidate observed during the solve — one whose WCS
     * passed verifyWCS but was dropped below the confidence / match-count floor
     * (`confidence_floor_drop`). Retained (most-matches wins) so a NO-SOLVE run can
     * run a MEASURED diagnostic (bc_measure) on its REAL provisional matched pairs
     * (SOLVE_FAILURE_DIAGNOSTICS, default OFF). PURELY DIAGNOSTIC: `buildReceipt` (the
     * SOLVED product) never reads any SolveDiagnostics field, so capturing this — even
     * on a run that ultimately locks at a later center — is byte-identical for the
     * pinned reference solves. Absent when no verified candidate was ever dropped.
     */
    best_near_miss?: {
        /** Confidence the dropped candidate scored (its "how close" figure). */
        confidence: number | null;
        /** # verified matched stars the dropped candidate carried. */
        matched: number;
        /** The dropped candidate's full solution (wcs + matched_stars) — diagnostic only. */
        solution: PlateSolution;
    };
}

export interface SolveResult {
    success: boolean;
    solution?: PlateSolution;
    diagnostics: SolveDiagnostics;
}

export interface PlateSolution {
    ra: number;          
    dec: number;         
    ra_hours: number;    
    dec_degrees: number; 
    pixel_scale: number; 
    rotation: number;    
    rotation_deg?: number;
    fov_width_deg: number; 
    fov_height_deg: number;
    parity: number;      
    spatial_hash: string;
    
    // Quality Metrics
    // (`odds` removed 2026-07-10, owner-ruled: it was a synthetic
    // confidence*1e9 rescale with zero readers — solver_entry.ts has the note.)
    confidence: number;
    num_stars: number;
    matched_stars?: MatchedStar[];

    // WCS Headers
    wcs?: any;
    search_debug?: any;

    /**
     * ADDITIVE — greenfield-solver provenance (flag-gated desktop seam only). Absent on
     * every legacy solve, so the pinned reference solves stay byte-identical. `solved_via`
     * marks the native Rust core; `greenfield_receipt` carries the full SolveReceipt
     * (plain JSON, Float32Array-free); `greenfield_log_odds` surfaces the receipt's final
     * verify log-odds (the confidence's Bayesian source). See stages/greenfield_seam.ts.
     */
    solved_via?: 'greenfield_rust';
    greenfield_receipt?: unknown;
    greenfield_log_odds?: number;

    // Ephemeris Handshake
    planetary_matches?: SolarBody[];
    handshake_rms?: number;
    flatteningStatus?: FlatteningStatus;

    /**
     * POST-SOLVE DEEP HARVEST (M6 deep_verify, NEXT_MOVES §7·5b): catalog-
     * forced photometry at deep-catalog predicted positions after a confirmed
     * lock. Provenance CATALOG_FORCED — aperture measurements at predicted
     * positions, NEVER blind discoveries; kept on this separate field so they
     * can never be silently mixed into detections or matched_stars.
     */
    deep_forced?: {
        provenance: 'CATALOG_FORCED';
        probed: number;
        accepted: number;
        structured: number;
        rApPx: number;
        fwhmPx: number;
        snrThreshold: number;
        /** Accepted forced measurements (x/y predicted pixel, catalog mag/id). */
        stars: { x: number; y: number; mag: number | null; gaia_id: string | null; snr: number; flux: number }[];
        /**
         * Honest-skip reason (§8/B1). Set (with stars=[]) when the harvest was
         * DELIBERATELY not run — e.g. an active lens-distortion prior would make
         * forced photometry sample undistorted-space coords on native pixels
         * (needs toNative re-projection, deferred). Absent on a real measurement.
         */
        not_measured?: string;
        /**
         * True when the flux was measured on the 8-bit RGBA luminance (raw
         * released after ingest) rather than a native/science float buffer —
         * ~4-7% cross-channel leak + quantization; faint SNR is APPROXIMATE
         * (B2 / owner honesty rule). Absent/false when a native buffer survived.
         */
        approximate?: boolean;
        /**
         * Measurement basis (honest provenance for B2). NATIVE_FLOAT_LUMINANCE =
         * the full-res Float32 science luminance (native-grade, but a luminance
         * COMBINATION — NOT a single/dominant channel; on CFA sources it carries
         * a demosaic/CFA-weighted texture). RGBA_LUMINANCE_8BIT = the quantized
         * 8-bit solve buffer (cross-leak + quantization).
         */
        grid?: 'NATIVE_FLOAT_LUMINANCE' | 'RGBA_LUMINANCE_8BIT';
    };

    /**
     * PER-STAR CONFIRMATION (forced_confirm.ts, FP wave C): CATALOG_FORCED
     * candidates (deep_forced) that additionally cleared the MORE-sensitive
     * AND MORE-stringent confirmation conjunction — local scrambled null +
     * frame-PSF shape consistency + neighbor-clean + structured guard — AND a
     * SET-LEVEL family-wise excess gate (the whole set must beat its own
     * scrambled-null confirmed rate, or it collapses to zero). Its OWN field
     * with its OWN provenance so a CONFIRMED forced star is structurally
     * un-mixable with candidates (deep_forced), blind detections, or
     * matched_stars. One-directional promotion (candidate → confirmed); never
     * written back into matched_stars or the reported star count.
     */
    deep_confirmed?: {
        provenance: 'CATALOG_FORCED_CONFIRMED';
        /** Candidates examined by the confirmation pass. */
        examined: number;
        /** Confirmed count (0 when the set failed the family-wise gate). */
        confirmed: number;
        /** Set-level excess of confirmed count over the scrambled-null confirmed
         *  rate under the SAME strict predicate (the family-wise gate reads this). */
        setExcessZ: number | null;
        /** True when the set-level gate passed and the confirmed[] list is live. */
        setGatePassed: boolean;
        /** 2.19.0 (F3, row 547): the FULL probed family size — every catalog
         *  target measured (accepted or not); the FDR step-up runs over this. */
        probed?: number;
        /** 2.19.0 (F3): projected targets excluded as WCS fit-anchors (matched
         *  stars — coordinate-coincidence exclusion, never ID-only). */
        matched_excluded?: number;
        /** 2.19.0 (F2): probe-projection provenance, e.g. 'LINEAR+SIP+BC_MEASURED'. */
        projection?: string;
        /** True when flux was measured on 8-bit luminance (APPROXIMATE); color
         *  test is forced to NOT_MEASURED and faint promotions are barred. */
        approximate: boolean;
        grid: 'NATIVE_FLOAT_LUMINANCE' | 'RGBA_LUMINANCE_8BIT';
        /** Frame-PSF reference used for the shape test (null → shape NOT_MEASURED). */
        framePsf: { fwhmPx: number | null; ellipticity: number | null; source: string } | null;
        /** Confirmed stars, each carrying its per-test verdicts + a confidence. */
        confirmed_stars: {
            x: number; y: number; mag: number | null; gaia_id: string | null;
            snr: number; flux: number; confidence: number;
            tests: {
                snr: 'PASS' | 'FAIL';
                localNull: 'PASS' | 'FAIL' | 'NOT_MEASURED';
                shape: 'PASS' | 'FAIL' | 'NOT_MEASURED';
                neighbor: 'PASS' | 'FAIL';
                color: 'PASS' | 'FAIL' | 'NOT_MEASURED';
            };
        }[];
        /** Set when the pass was skipped wholesale (headless/no buffer/lens prior). */
        not_measured?: string;
        /** PHASE-1 FDR SHADOW (owner ruling 2026-07-12; env CONFIRM_FDR_SHADOW).
         *  Present ONLY when the shadow flag is on — the N-invariant FDR statistic
         *  computed ALONGSIDE the live set-excess gate above (which is unchanged).
         *  Absent by default ⇒ flag-off receipts are byte-identical. Never gates. */
        /** PHASE-2 LIVE (schema 2.17.0): the FDR set-decision block — always present
         *  on a confirmation pass; null on the N<10 floor (honest absence). */
        fdr?: import('../pipeline/m6_plate_solve/fdr_confirm').FdrShadowResult | null;
    };

    // Solver Diagnostics (Attached for telemetry)
    diagnostics?: {
        avg_fwhm?: number;
        stars_matched?: number;
        solve_time_ms?: number;
    };

    /**
     * M7 post-solve residual analysis (ResidualAnalyzer), attached by the
     * orchestrators after a successful solve. `sip` is the fitted SIP
     * polynomial (structural mirror of m7 SIPCoefficients — kept inline to
     * avoid a types->pipeline import cycle); absent when the field showed no
     * significant distortion or had too few matches to fit.
     */
    astrometry?: {
        rms_arcsec: number;
        distortion_detected: boolean;
        sip?: {
            a_order: number;
            b_order: number;
            a: number[][];
            b: number[][];
        };
        /**
         * M6 thin-plate-spline distortion fit (tps_fitter.ts) — a non-polynomial
         * companion to `sip`, fitted from the same matched-star residual field but
         * carried into ASDF/GWCS as a tabular lookup transform (a spline has no
         * polynomial nodes). EMISSION-GATED (fitTpsGated): explicit `null` when the
         * out-of-sample gate REFUSED the spline (an interpolating spline whose in-
         * sample rms_after is laundered — see `tps_gate` for why). All plain number
         * arrays (typed arrays are stripped from receipts by the save_packet
         * replacer). Coordinates are NORMALIZED: p̃ = (pixel − crpix)/scale.
         * `scale` doubles as the extrapolation hull radius (px) — refuse eval beyond.
         */
        tps?: {
            lambda: number;
            scale: number;
            crpix: [number, number];
            control_points: number[][];
            weights_x: number[];
            weights_y: number[];
            affine: { dx: [number, number, number]; dy: [number, number, number] };
            rms_before_arcsec: number;
            rms_after_arcsec: number;
            control_count: number;
        } | null;
        /**
         * M6 TPS out-of-sample EMISSION-GATE verdict (tps_fitter.ts, TpsGateVerdict)
         * — recorded whenever the TPS fire gate fired, regardless of admit/refuse, so
         * the presence-or-absence of `tps` is explained honestly, not silently. When
         * `admitted` is false, `tps` above is null and the numbers here say why
         * (rms_oos vs rms_insample vs the linear residual; the GCV λ grid; the
         * physics ceiling). Structural mirror of TpsGateVerdict (inlined to avoid a
         * types→pipeline import cycle). Absent only when the fire gate never fired.
         */
        tps_gate?: {
            admitted: boolean;
            reason: 'ADMITTED' | 'COVERAGE' | 'SINGULAR' | 'OOS_OVERFIT' | 'OOS_WORSE_THAN_LINEAR' | 'PHYSICS_CEILING';
            cv_folds: number;
            control_count: number;
            rms_insample_arcsec: number | null;
            rms_oos_arcsec: number | null;
            oos_threshold_arcsec: number | null;
            rms_linear_arcsec: number | null;
            lambda_selected: number | null;
            lambda_grid: { lambda: number; gcv: number }[];
            effective_dof: number | null;
            hull_radius_px: number | null;
            out_of_hull_fraction: number | null;
            displacement_amplitude_arcsec: number | null;
            physics_ceiling_arcsec: number | null;
            field_span_deg: number | null;
        };
    };

    /**
     * PRIMARY BC REMATCH (m2_hardware/lens_distortion_rematch_pass): the two-pass
     * edge-star densification driven by the MEASURED per-capture Brown-Conrady.
     * Additive record of the attempt; on `applied` the densified matched_stars +
     * refit SIP are already landed above, on KEPT_ORIGINAL the solution is
     * byte-identical (structural never-worse guard held it). Structural mirror of
     * BcRematchReceipt (kept inline to avoid a types->pipeline import cycle).
     */
    bc_rematch?: {
        attempted: boolean;
        applied: boolean;
        guard: 'APPLIED' | 'KEPT_ORIGINAL';
        chain_stage: 'FINAL';
        matched_before: number;
        matched_after: number;
        edge_before: number;
        edge_after: number;
        rms_before_arcsec: number | null;
        rms_after_arcsec: number | null;
        recovered_confirmed: number;
        recovered_rejected: number;
        false_guard_passes: boolean;
        net_px: number;
        photometry: 'NATIVE_FLOAT_LUMINANCE' | 'NOT_MEASURED';
        recovered_stars: {
            gaia_id: string; ra_hours: number; dec_degrees: number; mag: number | null;
            x: number; y: number; final_residual_arcsec: number;
            kept: boolean; reject_reason: 'RESIDUAL_ENVELOPE' | 'NO_FLUX' | null; snr: number | null;
        }[];
        not_measured?: string;
    };
}

// â”€â”€â”€ SIGNAL PROCESSOR TYPES â”€â”€â”€

export type CullingReason =
    | 'LIGHT_POLLUTION'
    | 'SATELLITE'
    | 'TOPOGRAPHY'
    | 'PLANET'
    | 'DEDUPLICATION'
    | 'CIRCULARITY'
    | 'COLOR_SNR'
    | 'LOW_SNR'
    | 'HIGH_DENSITY'
    // Thermal-noise per-blob cuts (detection_cuts.ts — NEXT_MOVES §7):
    | 'FWHM_FLOOR'   // moment-FWHM below the sub-pixel-spike floor
    | 'SHARPNESS'    // peak/flux above the lone-hot-pixel ceiling
    | 'ELLIPTICITY'  // 2nd-moment axis ratio above the round-PSF ceiling
    | 'NONE';

export interface SignalPoint {
    id: number;
    x: number; 
    y: number;
    rawX: number;       // [NEW] Original sensor coordinate (science-space)
    rawY: number;       // [NEW] Original sensor coordinate (science-space)
    flux: number;        // Total brightness
    peak: number;        // Max pixel value
    peak_value: number;  // Alias for compatibility
    
    // SPECTRAL PEEKING (The 2.5 Buffer LUT)
    peak_rgb?: [number, number, number]; // Actual sensor values [R, G, B]
    measured_bv?: number;                // Calculated B-V Index
    
    fwhm: number;        // Full Width Half Max (Size)
    circularity: number; // 0.0 (Line) -> 1.0 (Circle)
    ellipticity: number; // 0.0 (Circle) -> 1.0 (Line)
    theta: number;       // Angle of elongation
    snr: number;         // Signal-to-Noise Ratio
    culling_reason?: CullingReason;

    // Atmospheric Awareness
    mie_index?: number;
    /**
     * Frame-level vertical brightness gradient (top-vs-bottom background mean),
     * UNATTRIBUTED — not proof of Rayleigh scattering (LP/vignette/altitude
     * produce the same slope). Name kept for compatibility; do not display as a
     * scattering-mechanism measurement.
     */
    rayleigh_index?: number;

    // Thermal-noise shape statistics (detection_cuts.ts, measured TS-side on
    // the detection grid; absent = not measured, never invented):
    sharpness?: number;           // peak/flux ratio
    moment_fwhm_px?: number;      // 2nd-moment FWHM (px, detection grid)
    moment_ellipticity?: number;  // 1 - sigma_minor/sigma_major
}

/**
 * Sensor mosaic classification of a raw (un-demosaiced) frame, decided BEFORE
 * 2x2 luminance binning by a statistical 2x2-block-uniformity test. Emitted
 * honest-or-absent: present only when a raw frame was actually classified.
 *   - 'std-bayer' : standard 2x2 RGGB/BGGR/... CFA — the 2x2 bin IS luminance.
 *   - 'mono'      : no colour mosaic (e.g. ASI1600MM) — the 2x2 bin is a plain
 *                   box-average luminance downsample (correct, not CFA-weighted).
 *   - 'quad-bayer': 2x2 same-colour super-cells (Quad/Tetracell) — a naive 2x2
 *                   bin produces a half-res COLOUR mosaic, NOT luminance.
 *                   `supported=false`; detection proceeds flagged-unreliable.
 */
export type CFAClass = 'std-bayer' | 'mono' | 'quad-bayer';

export interface CFAVerdict {
    klass: CFAClass;
    /** false => the 2x2 bin is NOT a valid luminance map (quad-bayer). */
    supported: boolean;
    /** Normalised spread of the 4 pixel-level 2x2-phase means (colour CFA => large). */
    phaseSpreadL0: number;
    /** Normalised spread of the 4 phase means of the 2x2-binned image (quad-bayer => large). */
    phaseSpreadL1: number;
    /** Number of complete 2x2 blocks measured. */
    blocksSampled: number;
    /** Human-readable evidence string for the manifest / event bus. */
    reason: string;
}

export interface SignalPacket {
    clean_stars: SignalPoint[];
    anomalies: SignalPoint[];   // Satellites, Hot Pixels, Rays
    planet_candidates?: SignalPoint[];
    /**
     * TRUE per-reason culling tally, counted at assignment time in m4.
     * Includes candidates hard-REJECTED (dropped from every list) and
     * planet-routed stars — the anomalies[] array alone under-reports both,
     * which is why the step-3 counters read 0 (owner-reported trust bug).
     */
    culling_tally?: Partial<Record<CullingReason, number>>;
    background_level: number;
    background_level_top?: number; // For Graduated Filter detection
    background_level_bottom?: number;
    noise_floor: number;
    sky_polygon?: Point[]; // The "Sky Mask" boundary
    anomaly_grid?: Uint32Array; // 2D grid of anomaly counts
    milky_way?: { x: number, y: number }[];
    milky_way_contour?: Point[];
    milky_way_ellipses?: { x: number, y: number, rx: number, ry: number, theta: number }[];
    milky_way_centerline?: Point[];
    light_pollution_contour?: Point[];
    grid_w?: number;
    grid_h?: number;
    cell_size?: number;
    /** Mapping factor: Preview_Dim / science_Dim. Used for UI plotting. */
    viewScale?: number;
    /** High-fidelity binned luminance buffer (science Layer) */
    scienceBuffer?: Float32Array;
    /** Sensor mosaic verdict (present only when a raw frame was classified). */
    cfa_verdict?: CFAVerdict;
    
    // ATMOSPHERIC ENRICHMENT
    horizonVector?: Uint16Array;    // [NEW] 1D Horizon from MobileSAM
    scattering_profile?: Float32Array; // 2D map of scattering density
    zodiacal_light?: boolean;          // Flag if zodiacal light is detected
    /**
     * Honest-or-absent: set ONLY when a scattering mechanism is actually
     * attributed from evidence. No stage currently attributes one, so this is
     * left undefined rather than emitting a hardcoded assumption.
     */
    scattering_type?: 'RAYLEIGH' | 'MIE' | 'TERRESTRIAL' | 'NONE';
    segmentationMasks?: SegmentationMasks; // [NEW] Multi-class terrestrial data
}

// â”€â”€â”€ PHYSICAL TYPES â”€â”€â”€

export type CelestialCategory = 'STAR' | 'PLANET' | 'MOON' | 'DWARF_PLANET' | 'ASTEROID' | 'COMET';

export interface SolarBody {
    id: string;
    name: string;
    type: CelestialCategory;
    parent?: string;
    ra: number;          // Decimal Hours
    dec: number;         // Decimal Degrees
    mag: number;         // Visual Magnitude
    radius_arcsec: number; 
    radius_km?: number;  // Physical Radius
    mass_kg?: number;    // Physical Mass
    dist_au?: number;    // AU
    phase?: number;      // 0.0 - 1.0 (Illuminated fraction)
    color?: string;      // Visual color hex
    altitude?: number;   // Computed Alt
    azimuth?: number;    // Computed Az
    children?: SolarBody[];

    // Handshake Verification
    pixel_x?: number;        // Projected X
    pixel_y?: number;        // Projected Y
    residual_pixels?: number; // distance to nearest star
    locked?: boolean;        // Confirmed match?
}

export interface HardwareProfile {
    inferred_lens: string;       
    distortion_profile: { k1: number, k2: number, k3: number, p1: number, p2: number };
    chromatic_aberration?: { r_shift: number, b_shift: number }; 
    sensor_response?: { r_bias: number, g_bias: number, b_bias: number };
    gps_drift_km?: number;
    timestamp_error_sec?: number;
    detected_modifications?: string[]; // e.g. ["Astro-Modified Sensor", "Diffusion Filter"]
    spectral_bias?: string;            // e.g. "Heavy Red Bias (H-alpha)"
    vignette_v1?: number;              // Radial shading coefficient
    optical_center?: { x: number, y: number }; // Measured optical axis
    /**
     * Regression diagnostics for the distortion/vignette fits — MEASURED, not
     * decorative. Absent when the fit did not run (<10 matched residuals).
     * Standard errors are textbook OLS sigma*sqrt((XtX)^-1_ii) over the
     * RANSAC inliers; absent when the normal matrix is singular / n too low.
     */
    fit_stats?: {
        n_matches: number;      // sentinel-filtered matched stars fed to the fit
        n_inliers: number;      // RANSAC survivors used in the regression
        r_ref_px: number;       // radius normalization (max ideal radius, px)
        rms_error_px: number;   // radial distortion-model residual RMS (all matches)
        k1_se?: number;         // 1-sigma standard error on k1
        k2_se?: number;         // 1-sigma standard error on k2
        v1_se?: number;         // 1-sigma standard error on vignette v1
    };
}

export interface ForensicMetrics {
    star_anomaly_ratio: number;
    interference_flag: boolean; // "High Terrestrial interference"
    global_bv_mean: number;
    mean_fwhm: number;
    rms_truth_score: number;
    snr_noise_floor: number;
    optical_center_offset: { dx: number, dy: number };
    extinction_gradient: number; // Flux loss top-to-bottom
    anomaly_counts: {
        satellites: number;
        hot_pixels: number;
        terrestrial: number;
    };
}

