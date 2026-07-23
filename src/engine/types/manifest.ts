import { Table } from 'apache-arrow';

/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * DATA PROVENANCE FSM â€” The 17-Point Scientific Manifest
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * This file defines the "Master Contract" for the SkyCruncher pipeline.
 * It tracks the lifecycle of every measurement across JS, Rust, and WebGPU.
 */

export enum MemoryResidency {
    JsHeap = "JS_HEAP",
    ArrowShared = "ARROW_SHARED_BUFFER",
    WebGpuVram = "WEBGPU_VRAM",
    NativeGpuVram = "NATIVE_GPU_VRAM",
    WasmMemory = "RUST_WASM_MEMORY"
}

export enum PhotographyData {
    Raw = "RAW",
    BayerArray = "BAYER_ARRAY",
    Jpeg = "JPEG",
    CompressedJpeg = "COMPRESSED_JPEG",
    Dng = "DNG",
    Fits = "FITS",
    Tiff = "TIFF"
}

export enum CoordinateSystem {
    SensorPixels = "SENSOR_PIXELS",
    PixelArray = "PIXEL_ARRAY",
    Wcs = "WCS",
    RaDec = "RA_DEC",
    Radians = "RADIANS",
    Degrees = "DEGREES",
    Feet = "FEET",
    Aus = "AUS"
}

export enum StarRepresentation {
    Undetected = "UNDETECTED",
    Centroid = "CENTROID",
    GaussianBlur = "GAUSSIAN_BLUR",
    Psf = "PSF",
    Array = "ARRAY"
}

export enum HardwareProfileState {
    Agnostic = "AGNOSTIC_BLIND",
    ExifInferred = "EXIF_INFERRED",
    UserOverridden = "USER_OVERRIDDEN",
    FullyCalibrated = "FULLY_CALIBRATED"
}

export enum TemporalState {
    ExifLocal = "EXIF_LOCAL",
    UtcCorrelated = "UTC_CORRELATED",
    UserCorrected = "USER_CORRECTED",
    JdValidated = "JD_VALIDATED"
}

export enum SegmentationState {
    Unsegmented = "UNSEGMENTED",
    HorizonMasked = "HORIZON_MASKED",
    SkyIsolated = "SKY_ISOLATED",
    ForeAftIndependent = "FORE_AFT_INDEPENDENT"
}

export enum TerrestrialLocation {
    SeedGps = "SEED_GPS",
    UserInput = "USER_INPUT",
    Validated = "VALIDATED",
    DemMapped = "DEM_MAPPED"
}

export enum PlanetaryDetection {
    Undetected = "UNDETECTED",
    Hypothesis = "HYPOTHESIS",
    Confirmed = "CONFIRMED",
    Located = "LOCATED"
}

export enum AstronomicalLocation {
    Blind = "BLIND",
    PlanetTargeted = "PLANET_TARGETED",
    InitialQuadMatched = "INITIAL_QUAD_MATCHED",
    Finalized = "FINALIZED"
}

export enum StarCount {
    Undetected = "UNDETECTED",
    FirstPass = "FIRST_PASS",
    SecondPass = "SECOND_PASS",
    DeepSkyPass = "DEEP_SKY_PASS"
}

export enum VerificationState {
    BayerDataDetection = "BAYER_DATA_DETECTION",
    CircularityConfirmation = "CIRCULARITY_CONFIRMATION",
    GaiaPhotometryVerified = "GAIA_PHOTOMETRY_VERIFIED",
    TerrestrialDiscard = "TERRESTRIAL_DISCARD",
    PixelErrorDiscard = "PIXEL_ERROR_DISCARD",
    SatellitePlaneDiscard = "SATELLITE_PLANE_DISCARD",
    AnomalyConfirmation = "ANOMALY_CONFIRMATION"
}

export enum SignalState {
    RawSignal = "RAW_SIGNAL",
    GradientModeled = "GRADIENT_MODELED",
    LightPollutionSubtracted = "LIGHT_POLLUTION_SUBTRACTED",
    BackgroundNeutralized = "BACKGROUND_NEUTRALIZED"
}

export enum LocationCorrection {
    Undetected = "UNDETECTED",
    Bounded = "BOUNDED",
    InitialFlattening = "INITIAL_FLATTENING",
    CustomFlattening = "CUSTOM_FLATTENING",
    Tps = "TPS"
}

export enum ShapeCorrection {
    Undetected = "UNDETECTED",
    ComaCorrected = "COMA_CORRECTED",
    SiderealCorrected = "SIDEREAL_CORRECTED",
    Pointified = "POINTIFIED"
}

export enum ColorCorrection {
    Undetected = "UNDETECTED",
    BpRpDefined = "BP_RP_DEFINED",
    FilterCorrected = "FILTER_CORRECTED",
    AtmosphericCorrected = "ATMOSPHERIC_CORRECTED",
    PlanckianVerified = "PLANCKIAN_VERIFIED"
}

export enum DistortionCorrection {
    Uncorrected = "UNCORRECTED",
    StarsOnly = "STARS_ONLY",
    EntireCapture = "ENTIRE_CAPTURE"
}

export enum NormalizationState {
    RawAdu = "RAW_ADU",
    BlackLevelSubtracted = "BLACK_LEVEL_SUBTRACTED",
    FlatFieldCorrected = "FLAT_FIELD_CORRECTED",
    Normalized = "NORMALIZED"
}

export enum PhotometricSolution {
    Uncalibrated = "UNCALIBRATED",
    InstrumentalMagnitude = "INSTRUMENTAL_MAGNITUDE",
    CatalogMatched = "CATALOG_MATCHED_GAIA_DR3",
    ZeroPointValidated = "ZERO_POINT_VALIDATED"
}

export enum ResamplingKernel {
    None = "NONE",
    BilinearPreview = "BILINEAR_PREVIEW",
    Lanczos3HighFidelity = "LANCZOS_3_HIGH_FIDELITY",
    FluxPreserving = "FLUX_PRESERVING"
}

export interface GwcsMetadata {
    width: number;
    height: number;
    row_pitch?: number; // Optional wgpu alignment padding
    crpix: [number, number];
    crval: [number, number];
    cd_matrix: [number, number, number, number];
    
    // Phase 5: Calibration Metadata Encoding
    calibration_manifest?: {
        polynomial_sip?: number[];      // Brown-Conrady or SIP
        tps_weights?: number[];         // Thin Plate Spline vectors
        photometric_zp?: number;        // Zero-Point
        photometric_method?: string;    // e.g. "Levenberg-Marquardt"
        skyglow_model?: number[];       // B-spline SPATIAL coeffs. Reserved — no stage
                                        // currently emits this. Never pack a scalar chroma
                                        // (e.g. sky_color_index) here; that misrepresents a
                                        // point value as a spatial model (LAW-3).
        extinction_model_tps?: number[]; // Multiplicative TPS weights
        timestamp_source?: string;      // e.g. "astrometric_inversion"
    };
}

/**
 * The single source of truth for the pipeline state.
 */
export interface PipelineManifest {
    id: string; // Unique session/observation ID
    memoryState: MemoryResidency;
    dataSource: PhotographyData;
    coordinateSystem: CoordinateSystem;
    starRepresentation: StarRepresentation;
    hardwareProfile: HardwareProfileState;
    temporalState: TemporalState;
    segmentation: SegmentationState;
    terrestrialLoc: TerrestrialLocation;
    planetaryDetection: PlanetaryDetection;
    astronomicalLoc: AstronomicalLocation;
    starCount: StarCount;
    verification: VerificationState;
    signalState: SignalState;
    locationCorrection: LocationCorrection;
    shapeCorrection: ShapeCorrection;
    colorCorrection: ColorCorrection;
    distortionCorrection: DistortionCorrection;
    normalizationState: NormalizationState;
    photometricSolution: PhotometricSolution;
    resamplingKernel: ResamplingKernel;
    lastUpdated: string; // ISO timestamp
}

export interface StarPhotometry {
    x: number;
    y: number;
    flux: number;
    fwhm: number;
    snr: number;
    
    // Modern Gaia DR3/DR4 block
    catalog_match?: {
        id: string;                 
        mag_g: number;              
        bp_rp_index: number;        
        parallax_mas: number;       
        pm_ra: number;              
        pm_dec: number;             
        ref_epoch: number;          // e.g., 2016.0
        separation_arcsec: number;  // Astrometric residual delta after TPS/SIP
    };
}

export interface HardwareMetadata {
    timestamp_source: "exif" | "astrometric_inversion";
    horizon_method: "ai_vision_dem_ref" | "manual" | "none";
    inference_model?: "mobile_sam_v1";
    elevation_model?: "SRTM_30m_v3";
}

export interface QualityMetrics {
    computed_jd: number;
    exif_drift_seconds: number;
    horizon_confidence?: number;
    computed_aod?: number; // Aerosol Optical Depth
}

/**
 * The AstroPacket wraps the heavy data buffer with its scientific provenance.
 */
export interface AstroPacket {
    version: "1.1";
    data: Table | null; // The Arrow Shared Buffer (or null if not in Arrow memory)
    manifest: PipelineManifest;
    provenance: HardwareMetadata;
    wcs: GwcsMetadata;
    stars: Array<StarPhotometry>;
    environment: QualityMetrics;
}

/**
 * Creates a "Blank" manifest for a new pipeline run.
 */
export function createBlankManifest(id: string): PipelineManifest {
    return {
        id,
        memoryState: MemoryResidency.JsHeap,
        dataSource: PhotographyData.Raw,
        coordinateSystem: CoordinateSystem.SensorPixels,
        starRepresentation: StarRepresentation.Undetected,
        hardwareProfile: HardwareProfileState.Agnostic,
        temporalState: TemporalState.ExifLocal,
        segmentation: SegmentationState.Unsegmented,
        terrestrialLoc: TerrestrialLocation.SeedGps,
        planetaryDetection: PlanetaryDetection.Undetected,
        astronomicalLoc: AstronomicalLocation.Blind,
        starCount: StarCount.Undetected,
        verification: VerificationState.BayerDataDetection,
        signalState: SignalState.RawSignal,
        locationCorrection: LocationCorrection.Undetected,
        shapeCorrection: ShapeCorrection.Undetected,
        colorCorrection: ColorCorrection.Undetected,
        distortionCorrection: DistortionCorrection.Uncorrected,
        normalizationState: NormalizationState.RawAdu,
        photometricSolution: PhotometricSolution.Uncalibrated,
        resamplingKernel: ResamplingKernel.None,
        lastUpdated: new Date().toISOString()
    };
}
