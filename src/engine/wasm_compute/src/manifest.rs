use serde::{Deserialize, Serialize};

/**
 * ═════════════════════════════════════════════════════════════════════════
 * DATA PROVENANCE FSM — Rust Implementation
 * ═════════════════════════════════════════════════════════════════════════
 */

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MemoryResidency {
    JsHeap,
    ArrowSharedBuffer,
    WebgpuVram,
    NativeGpuVram,
    RustWasmMemory,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PhotographyData {
    Raw,
    BayerArray,
    Jpeg,
    CompressedJpeg,
    Dng,
    Fits,
    Tiff,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoordinateSystem {
    SensorPixels,
    PixelArray,
    Wcs,
    RaDec,
    Radians,
    Degrees,
    Feet,
    Aus,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StarRepresentation {
    Undetected,
    Centroid,
    GaussianBlur,
    Psf,
    Array,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HardwareProfile {
    #[serde(rename = "AGNOSTIC_BLIND")] AgnosticBlind,
    ExifInferred,
    UserOverridden,
    FullyCalibrated,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TemporalState {
    ExifLocal,
    UtcCorrelated,
    UserCorrected,
    JdValidated,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SegmentationState {
    Unsegmented,
    HorizonMasked,
    SkyIsolated,
    ForeAftIndependent,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerrestrialLocation {
    SeedGps,
    UserInput,
    Validated,
    DemMapped,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanetaryDetection {
    Undetected,
    Hypothesis,
    Confirmed,
    Located,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AstronomicalLocation {
    Blind,
    PlanetTargeted,
    InitialQuadMatched,
    Finalized,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StarCount {
    Undetected,
    FirstPass,
    SecondPass,
    DeepSkyPass,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationState {
    BayerDataDetection,
    CircularityConfirmation,
    BvConfirmed,
    TerrestrialDiscard,
    PixelErrorDiscard,
    SatellitePlaneDiscard,
    AnomalyConfirmation,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SignalState {
    RawSignal,
    GradientModeled,
    LightPollutionSubtracted,
    BackgroundNeutralized,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LocationCorrection {
    Undetected,
    Bounded,
    InitialFlattening,
    CustomFlattening,
    Tps,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ShapeCorrection {
    Undetected,
    ComaCorrected,
    SiderealCorrected,
    Pointified,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ColorCorrection {
    Undetected,
    BvDefined,
    FilterCorrected,
    AtmosphericCorrected,
    PlanckianVerified,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DistortionCorrection {
    Uncorrected,
    StarsOnly,
    EntireCapture,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NormalizationState {
    RawAdu,
    BlackLevelSubtracted,
    FlatFieldCorrected,
    Normalized,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PhotometricSolution {
    Uncalibrated,
    InstrumentalMagnitude,
    CatalogMatchedGaiaDr3,
    ZeroPointValidated,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResamplingKernel {
    None,
    BilinearPreview,
    Lanczos3HighFidelity,
    FluxPreserving,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PipelineManifest {
    pub id: String,
    pub memory_state: MemoryResidency,
    pub data_source: PhotographyData,
    pub coordinate_system: CoordinateSystem,
    pub star_representation: StarRepresentation,
    pub hardware_profile: HardwareProfile,
    pub temporal_state: TemporalState,
    pub segmentation: SegmentationState,
    pub terrestrial_loc: TerrestrialLocation,
    pub planetary_detection: PlanetaryDetection,
    pub astronomical_loc: AstronomicalLocation,
    pub star_count: StarCount,
    pub verification: VerificationState,
    pub signal_state: SignalState,
    pub location_correction: LocationCorrection,
    pub shape_correction: ShapeCorrection,
    pub color_correction: ColorCorrection,
    pub distortion_correction: DistortionCorrection,
    pub normalization_state: NormalizationState,
    pub photometric_solution: PhotometricSolution,
    pub resampling_kernel: ResamplingKernel,
    pub last_updated: String,
}
