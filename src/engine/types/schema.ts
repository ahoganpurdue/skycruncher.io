/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SKYCRUNCHER â€” DATA SCHEMA
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE DATA CONTRACT FOR THE DISTRIBUTED OBSERVATORY
 * --------------------------------------------------
 * This file defines the canonical schema for astrophotography metadata
 * ingested by the SKYCRUNCHER pipeline (Track 2 of the SkyCruncher Roadmap).
 *
 * The schema is divided into three tiers:
 *   1. HARD METADATA â€” Extracted automatically from EXIF/FITS headers.
 *   2. SOFT METADATA â€” Provided by the user through a submission form.
 *   3. DERIVED METADATA â€” Computed by the pipeline (Zenith Normalizer, etc.).
 *
 * These feed into the 5-STRING COMPOSITE INDEX, extending the Core Engine's
 * StateKey system for celestial coordinate space.
 *
 * DESIGN PRINCIPLE:
 * Every field has a documented SkyCruncher mapping â€” the bridge between raw camera
 * data and the Physics Engine's force model.
 */

// â”€â”€â”€ ENUMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { ForensicMetrics } from './Main_types';
import { DistortionProfile, VignetteProfile } from '../core/optics_manager';
import type { SourceProvenance } from '../pipeline/m1_ingestion/source_provenance';
import type { RawlerCalibration } from '../pipeline/m1_ingestion/rawler_decoder';

export type { SourceProvenance };
export type { RawlerCalibration };

/** Tracking mount type. Determines "Mass" (signal anchoring) in the engine. */
export enum TrackingMount {
  NONE         = 'NONE',
  STAR_TRACKER = 'STAR_TRACKER',
  GOTO_MOUNT   = 'GOTO_MOUNT',
}

/** Optical filter type. Applies an Inverse Matrix to subtract color bias. */
export enum FilterType {
  NONE    = 'NONE',
  CLS     = 'CLS',       // City Light Suppression
  DUAL_NB = 'DUAL_NB',   // Dual Narrowband (Ha/OIII)
  UHC     = 'UHC',       // Ultra High Contrast
  UV_IR   = 'UV_IR',     // UV/IR Cut
}

export enum TimeValidationStatus {
  VALID = 'VALID',
  SUSPICIOUS_DAYLIGHT = 'SUSPICIOUS_DAYLIGHT',
  IMPOSSIBLE_BELOW_HORIZON = 'IMPOSSIBLE_BELOW_HORIZON',
  JUNK_DATE_DETECTED = 'JUNK_DATE_DETECTED'
}

/** Calibration frame types used in stacking. */
export enum CalibrationFrame {
  DARKS = 'DARKS',
  FLATS = 'FLATS',
  BIAS  = 'BIAS',
}

/**
 * â”€â”€â”€ FINGERPRINT TIERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 * The SkyCruncher's "Trust Ledger" for photometric data. Determines the
 * scientific weight ("Particle Mass") of an observation in the
 * physics engine.
 *
 * FUZZY  â€” Model-level: generic 3Ã—3 CCM + standard QE curve from sensor_db.
 *          Good for wide-field discovery (bright supernovae, meteor tracking).
 *          Precision: ~5â€“10% photometric error.
 *          Station class: Sentry (Tier 1)
 *
 * FULL   â€” Unit-level: complete forensic map of that specific piece of silicon.
 *          Requires dark frames (hot pixel map) + flat frames (vignette/dust).
 *          Enables exoplanet transit detection, small-magnitude variable stars.
 *          Precision: <1% photometric error.
 *          Station class: Sniper (Tier 3)
 */
export enum FingerprintTier {
  /** Per camera model â€” generic specCode lookup in sensor_db */
  FUZZY = 'FUZZY',
  /** Per serial number â€” unique fingerprint_id from calibration frames */
  FULL  = 'FULL',
}

// â”€â”€â”€ HARD METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Extracted automatically from EXIF/FITS headers by the Metadata Reaper.

export interface HardMetadata {
  /** Camera model identifier (e.g. "Canon EOS R5", "ZWO ASI2600MM Pro").
   *  Maps to CSI_INDEX â†’ Sensor Quantum Efficiency (QE) Curve. */
  camera_model: string;

  /** Lens or telescope model (e.g. "Canon RF 15-35mm f/2.8L", "Unknown").
   *  Maps to Lens Correction Profile (vignetting, distortion). */
  lens_model: string;

  /** Focal length in millimeters (e.g. 400).
   *  Critical for Plate Solving scale (arcsec/pixel). */
  focal_length: number;

  /** User-supplied focal length (mm) — the highest-trust rung of
   *  OpticsManager.getEffectiveFocalLength. Present when a human tells us their
   *  lens (electronics-less/manual glass, where EXIF FL is the factory-default
   *  50 mm). Turns the pre-solve scale search into a lookup; the verify gate
   *  remains the arbiter, so a wrong hint can only fail to verify. Absent by
   *  default — never fabricated (honest-or-absent). */
  focal_length_hint_mm?: number;

  /** Aperture f-number (e.g. 2.8).
   *  Determines light gathering power. */
  aperture: number;

  /** Physical pixel size in microns (e.g. 4.3).
   *  Used for sensor physics and focal length inference. */
  pixel_pitch_um?: number;

  /** ISO sensitivity or camera gain integer (e.g. 1600, or Gain 120).
   *  Defines the Noise Floor baseline for signal extraction. */
  iso_gain: number;

  /** Exposure time in seconds (e.g. 30.0).
   *  Determines "Particle Mass" (Signal-to-Noise Ratio). */
  exposure_time: number;

  /** Capture timestamp in ISO 8601 UTC (e.g. "2026-10-24T03:22:15Z").
   *  Used for transitionId (Session grouping) and solar position calc.
   *  EMPTY STRING = absent/unmeasured (honest-or-absent, owner ruling
   *  2026-07-10) — never a fabricated wall-clock "now". Consumers must treat
   *  '' as no-timestamp (the ephemeris trust gate does: falsy ⇒ untrusted). */
  timestamp: string;

  /** GPS latitude in decimal degrees (e.g. 34.0522).
   *  Used for Air Mass calculation (observer â†’ zenith angle).
   *  NULL = observer location is absent/unmeasured (no fabricated default —
   *  honest-or-absent LAW 3). Consumers must guard on null / gps_source. */
  gps_lat: number | null;

  /** GPS longitude in decimal degrees (e.g. -118.2437).
   *  Used for Air Mass calculation. NULL = absent/unmeasured (see gps_lat). */
  gps_lon: number | null;

  /** Source of the capture timestamp. 'DERIVED' (additive, owner ruling
   *  2026-07-10) = the primary EXIF field was corrupt and the time was
   *  honestly derived from a secondary EXIF date field — HINT tier: like
   *  'DEFAULT', it must never pass the ephemeris/planet trust gate. */
  timestamp_source?: 'EXIF' | 'FITS' | 'DEFAULT' | 'USER' | 'DERIVED';
  /** Source of the GPS coordinates. */
  gps_source?: 'EXIF' | 'FITS' | 'DEFAULT' | 'USER';

  /** Plate Solver Hints - Approximate RA (hours) */
  ra_hint?: number;
  /** Plate Solver Hints - Approximate Dec (degrees) */
  dec_hint?: number;
  /** Plate Solver Hints - Approximate Pixel Scale (arcsec/px) */
  pixel_scale?: number;

  /** Physical sensor width (active area) */
  width?: number;
  /** Physical sensor height (active area) */
  height?: number;

  /** EXIF Orientation tag (1-8).
   *  Used for downstream display rotation while processing stays in native sensor space. */
  orientation?: number;

  /** Origin of the frame's BYTES (Google Drive / URL / local-drop), matched at
   *  ingest against the intake fetcher's content-sha ledger. Absent (undefined)
   *  when the origin is unknown — honest-or-absent, NEVER fabricated. Surfaced as
   *  the receipt's `source_provenance` block. See m1_ingestion/source_provenance.ts. */
  source_provenance?: SourceProvenance | null;

  /** LEAN per-frame RAW calibration MEASURED by the rawler decode arm (WB, black/
   *  white levels, CFA pattern, optical-black stats). Persisted here at ingest so it
   *  survives the raw-buffer release and reaches the receipt's `rawler_calibration`
   *  block. Present ONLY on the rawler arm — absent (undefined) on the libraw cold
   *  path, FITS, and demo-tier (honest-or-absent, NEVER fabricated). See
   *  m1_ingestion/rawler_decoder.summarizeRawlerCalibration. */
  rawler_calibration?: RawlerCalibration | null;
}

// â”€â”€â”€ SOFT METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// User-provided context. Affects the Physics Engine's force model.

export interface SoftMetadata {
  /** Did the user combine (stack) multiple frames?
   *  Increases Density â†’ High confidence signal. */
  is_stacked: boolean;

  /** Number of sub-frames used in the stack (e.g. 120).
   *  Only relevant when is_stacked = true.
   *  Higher frame count â†’ stronger signal â†’ higher effective "Mass". */
  stack_frame_count: number | null;

  /** Tracking mount type.
   *  Increases Mass. "Anchors" the particle in coordinate space. */
  tracking_mount: TrackingMount;

  /** Optical filter in use.
   *  Applies Inverse Matrix â†’ Subtracts the filter's color bias from input. */
  filter_type: FilterType;

  /** Calibration frames applied during processing.
   *  Reduces variance â†’ Removes sensor artifacts (hot pixels, vignetting). */
  calibration_frames: CalibrationFrame[];

  /** Bortle Dark-Sky Scale (1 = pristine dark, 9 = inner city).
   *  Adjusts Threshold â†’ Sets background light pollution repulsor strength. */
  bortle_class: number;

  /** Opt-in to contribute this observation to the Retroactive Discovery archive.
   *  Historical RAW data can be re-analyzed when new detection algorithms ship.
   *  Grants a "Scientific Contributor" badge on Astro-Postcard exports. */
  contribute_to_archive: boolean;

  /** Hints for the Plate Solver (e.g. "I was looking South-West") */
  processing_hints?: ProcessingHints;

  /** Manual Location Override (from City Search) */
  location?: {
      lat: number;
      lon: number;
      name: string;
  };
}

export interface ProcessingHints {
    /** Approximate Right Ascension (hours) */
    ra?: number;
    /** Approximate Declination (degrees) */
    dec?: number;
    /** Cardinal direction (N, NE, E, SE, S, SW, W, NW) */
    cardinal_direction?: string;
    /** Approximate Azimuth (0-360) */
    azimuth?: number;
}

// â”€â”€â”€ DERIVED METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Computed by the pipeline. Not user-editable.

/** Spectral shift vector: deviation from the Planckian Locus. */
export interface SpectralShift {
  /** Red channel deviation (e.g. -0.05) */
  r: number;
  /** Green channel deviation (e.g. +0.02) */
  g: number;
  /** Blue channel deviation (e.g. -0.01) */
  b: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface DerivedMetadata {
  /** Atmospheric thickness factor (X = sec(z)).
   *  Calculated from GPS + timestamp + target altitude. */
  air_mass: number;

  /** Rayleigh scattering coefficient for the blue channel.
   *  Derived from air_mass. Used by the Zenith Normalizer. */
  rayleigh_coeff: number;

  /** Plate center in J2000 equatorial coordinates (RA/Dec string).
   *  Output of astrometry.net WASM plate solver (e.g. "12h 30m 49.4s +41Â° 54' 14"). */
  plate_center: string;

  /** Image scale in arcseconds per pixel.
   *  Derived from focal_length + sensor pixel size. */
  pixel_scale: number;

  /** Phase 1 + 2 Pipeline generated weights for Zonal Photometric Calibration */
  tps_weights?: number[];
  extinction_model_tps?: number[];

  /** Computed lens distortion profile (k1, k2, k3, p1, p2) */
  distortionProfile?: DistortionProfile;

  /** Computed vignette profile */
  vignetteProfile?: VignetteProfile;

  /** Deviation of the measured star color from the Planckian Locus.
   *  The "Standard Candle" comparison. Used for photometric calibration. */
  spectral_shift: SpectralShift;

  /** "Lie Detector" result: does the spectral fingerprint match the declared hardware?
   *  If false, a filter or modification may be present that the user didn't declare. */
  fingerprint_match: boolean;

  /** Auto-detected filter type based on spectral signature analysis.
   *  Non-null when the Lie Detector detects an undeclared filter.
   *  Example: User says FilterType.NONE but spectral shift matches CLS profile. */
  auto_detected_filter: FilterType | null;
  /** Result of the "Cronos Check" time validation */
  time_validation: {
    status: TimeValidationStatus;
    error_margin_minutes?: number;
    sunrise_sunset?: string;
    message?: string;
  } | null;

  /**
   * Phase 15: Celestial Context (Ephemeris)
   * Position of Sun/Moon to separate natural skyglow from artificial.
   */
  ephemeris?: EphemerisContext | null;

  /** advanced forensic metrics */
  forensics?: ForensicMetrics | null;

  /** Identified solar system bodies */
  planetary_matches?: import('./Main_types').SolarBody[];
}

// â”€â”€â”€ ENVIRONMENTAL FORENSICS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EphemerisContext {
    /** Is the sun above the horizon? */
    is_daylight: boolean;
    /** Is the sun between -18 and 0 degrees? */
    is_twilight: boolean;
    /** Moon phase (0.0 = New, 1.0 = Full) */
    moon_phase: number;
    /** Moon altitude in degrees */
    moon_altitude: number;
    /** Moon illumination intensity (0.0 - 1.0) accounting for phase + altitude */
    moon_intensity: number;
}

// â”€â”€â”€ PIPELINE RESULT TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returned by the orchestrator after running the full pipeline.

/** Result of a single pipeline stage. */
export interface PipelineStageResult<T = unknown> {
  /** Stage identifier (e.g. 'exif', 'zenith', 'plate_solve') */
  stage: string;
  /** Execution status */
  status: 'OK' | 'SKIPPED' | 'FAILED';
  /** Stage output data (null if failed/skipped) */
  data: T | null;
  /** Error message if status is FAILED */
  error?: string;
  /** Warning message (e.g. Lie Detector auto-correction) */
  warning?: string;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
}

/** Overlay workflow state machine. */
export type OverlayState = 'EMPTY' | 'RAW_UPLOADED' | 'SOLVED' | 'JPEG_PAIRED' | 'FAILED';

/** Metadata regarding the scaling factors used in the pipeline. */
export interface ScaleMetadata {
  sensor_width: number;
  sensor_height: number;
  preview_width: number;
  preview_height: number;
  ui_scale_factor: number;
}

/** Complete result of running the full SKYCRUNCHER pipeline. */
export interface ProcessingResult {
  /** Session UUID */
  uuid: string;
  /** Final Status */
  status: 'COMPLETE' | 'FAILED';
  /** Extracted EXIF metadata */
  hard: HardMetadata;
  /** User-provided metadata */
  soft: SoftMetadata;
  /** Computed atmospheric/hardware metadata (null if zenith stage failed) */
  derived: DerivedMetadata | null;
  /** Plate solution (null if solver failed or not enough stars) */
  solution: import('./Main_types').PlateSolution | null;
  /** Serialized science data packet (null if critical stages failed) */
  packet: import('../pipeline/m9_export/serializer').AstroSciencePacket | null;
  /** Data Provenance FSM Manifest */
  manifest: import('./manifest').PipelineManifest;
  /** Detailed list of pipeline stages run */
  stages: PipelineStageResult[];
  /** Total processing duration in ms */
  total_duration_ms: number;
  /** Current overlay state (determines what UI features are available) */
  overlay_state: OverlayState;
  /** Data URL for the image preview (especially for RAW files) */
  preview_url?: string;
  /** Markdown-formatted Telemetry Report for AI Analysis */
  telemetry_report?: string;
  /** advanced forensic telemetry */
  forensics?: ForensicMetrics | null;
  /** Identified planets */
  planets?: import('./Main_types').SolarBody[];
  /** Search debug info */
  search_debug?: any;
  /** Centralized scale metadata */
  scales?: ScaleMetadata;
}

// â”€â”€â”€ 5-STRING COMPOSITE INDEX â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Extension of the Core Engine's StateKey for celestial coordinate space.
//
// Format mirrors engine.ts StateKey but with astro-specific semantics:
//   spatialHash  â†’ GRID_{RA_SECTOR}_{DEC_SECTOR}
//   entityId     â†’ GAIA_{SOURCE_ID}
//   transitionId â†’ SESSION_{YYYYMMDD}_{USER_ID}
//   varianceKey  â†’ VAR_{AIRMASS}_{FINGERPRINT}
//   specCode     â†’ {CAMERA}_{FILTER}_{MOUNT}

export interface AstroStateKey {
  /** Celestial grid reference: RA sector + Dec sector.
   *  Example: "RA12h_D+45" */
  spatialHash: string;

  /** Gaia DR3 source identifier for the target object.
   *  Example: "Gaia_4658291" */
  entityId: string;

  /** Observation session grouping key.
   *  Example: "SESSION_20261024_USER88" */
  transitionId: string;

  /** Atmospheric + hardware variance fingerprint.
   *  Example: "AIRMASS_1.4_BIAS_RED" */
  varianceKey: string;

  /** Optical train specification code.
   *  Example: "CANON_R5_CLS_TRACKED" */
  specCode: string;
}

// â”€â”€â”€ FULL OBSERVATION RECORD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The complete document stored per image submission.

export interface AstroObservation {
  /** Auto-generated UUID for this observation. */
  id: string;

  /** Hard metadata extracted from image headers. */
  hard: HardMetadata;

  /** Soft metadata provided by the user at upload time. */
  soft: SoftMetadata;

  /** Derived metadata computed by the pipeline.
   *  Null until the Zenith Normalizer has processed the image. */
  derived: DerivedMetadata | null;

  /** 5-String Composite Index for this observation.
   *  Null until plate solving is complete. */
  stateKey: AstroStateKey | null;

  /** advanced forensic metrics */
  forensics: ForensicMetrics | null;

  /** Plate solution result */
  solution: import('./Main_types').PlateSolution | null;

  /** Proof of work: stages executed and their status */
  stages?: any[];
  /** Scientific Manifest (17-point FSM) */
  manifest?: import('./manifest').PipelineManifest;
  /** Final Preview URL */
  preview_url: string | null;
}

// â”€â”€â”€ BUILDERS / HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


// â”€â”€â”€ BUILDERS / HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Generate the spatialHash from equatorial coordinates. */
export function buildSpatialHash(
  raHours: number,
  decDegrees: number
): string {
  const raSector = `RA${Math.floor(raHours)}h`;
  const decSign = decDegrees >= 0 ? '+' : '-';
  const decSector = `D${decSign}${Math.abs(Math.floor(decDegrees))}`;
  return `${raSector}_${decSector}`;
}

/**
 * Generates the full 5-String Composite Index for a solved observation.
 */
export function generateAstroStateKey(
    raHours: number,
    decDegrees: number,
    entityId: string,
    timestamp: string,
    userId: string,
    airmass: number,
    fingerprint: string,
    specCode: string
): AstroStateKey {
    // 1. Spatial Hash
    const spatialHash = buildSpatialHash(raHours, decDegrees);

    // 2. Transition ID (Session)
    // Format: SESSION_{YYYYMMDD}_{USER_ID}
    const dateStr = timestamp.split('T')[0].replace(/-/g, '');
    const transitionId = `SESSION_${dateStr}_${userId}`;

    // 3. variance Key
    // Format: VAR_{AIRMASS}_{FINGERPRINT}
    // Round airmass to 1 decimal place to group similar conditions
    const am = airmass.toFixed(1);
    const varianceKey = `VAR_AM${am}_${fingerprint}`;

    return {
        spatialHash,
        entityId: `GAIA_${entityId}`, // Prefix for clarity
        transitionId,
        varianceKey,
        specCode
    };
}




// â”€â”€â”€ STAMPING (PHASE 0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface Stamp {
    /** Unique ID for this stamp (e.g., "STAMP_001") */
    id: string;
    /** X coordinate of the centroid (unflattened, raw sensor space) */
    x: number;
    /** Y coordinate of the centroid (unflattened, raw sensor space) */
    y: number;
    /** Bounding Box: [min_x, max_x, min_y, max_y] */
    bbox: [number, number, number, number];
    /** Raw pixel data (Float32Array) normalized 0.0-1.0 */
    data: Float32Array;
    /** Width of the stamp in pixels */
    width: number;
    /** Height of the stamp in pixels */
    height: number;
    /** Peak value in the stamp */
    peak: number;
    /** Classification Label (e.g. 'Jupiter', 'Hot Pixel') */
    label?: string;
    /** Whether this stamp is confirmed as a planet */
    isPlanet?: boolean;
}

