/**
 * -----------------------------------------------------------------------------
 * SKYCRUNCHER — Public API
 * -----------------------------------------------------------------------------
 *
 * Barrel file that re-exports the clean public interface.
 * Import everything from 'engine' instead of individual files.
 */

// -- Schema & Types -----------------------------------------
export * from './types/Main_types';
export * from './types/fsm_enums';
export type { ProcessingResult, ImageDimensions, AstroObservation } from './types/schema';

// -- Constants ----------------------------------------------
export { SENSOR_DB, findSensorByCamera, interpolateQE } from './pipeline/m2_hardware/sensor_db';
export type { SensorProfile, QEPoint } from './pipeline/m2_hardware/sensor_db';

export { FILTER_PROFILES, getFilterProfile, computeFilterInverse } from './pipeline/m2_hardware/filter_profiles';
export type { FilterProfile, TransmissionPoint } from './pipeline/m2_hardware/filter_profiles';

export { STANDARD_STARS, findStarByName, findNearestStar, findStarsInField } from './pipeline/m6_plate_solve/standard_stars';
export type { StandardStar } from './pipeline/m6_plate_solve/standard_stars';

export { LENS_DB, findLensByModel, interpolateVignette, vignetteCorrection } from './pipeline/m2_hardware/lens_profiles';
export type { LensProfile, VignetteCoeffs, DistortionCoeffs } from './pipeline/m2_hardware/lens_profiles';

// -- Pipeline -----------------------------------------------
export {
  computeAltAz,
  computeAirMass,
  rayleighCoefficient,
  rayleighExtinction,
  toJulianDate,
  computeGMST,
  computeLST,
} from './pipeline/m5_coordinate_flatten/zenith';

export {
  applySensorCorrection,
  applyFilterCompensation,
  computeFingerprint,
} from './pipeline/m2_hardware/hardware_adapter';

export {
  computeVignetteMap,
  computeDistortionMap,
  computeCorrectionMap,
  applyVignetteCorrection,
  applyDistortionCorrection,
  estimateVignetteFromFlats,
} from './pipeline/m5_coordinate_flatten/coordinate_flattener';
export type { CorrectionMap } from './pipeline/m5_coordinate_flatten/coordinate_flattener';

export { demosaicWebGPU } from './pipeline/m3_gpu_preprocess/demosaic_pipeline';
export type { DemosaicResult } from './pipeline/m3_gpu_preprocess/demosaic_pipeline';

export { serializePacket, compressPacket, buildAstroPacket } from './pipeline/m9_export/serializer';
export type { AstroSciencePacket, StarMeasurement, SkyMetrics } from './pipeline/m9_export/serializer';

export { solvePlate } from './pipeline/m6_plate_solve/solver_entry';
export { pixelToSkyCoords, plateSolutionToSpatialHash } from './pipeline/m6_plate_solve/solution_utils';

// -- Analysis -----------------------------------------------
export {
  computeColorIndex,
  compareToStandard,
  autoCompare,
  bpRpToTemperature,
  temperatureToSpectralType,
} from './pipeline/m8_photometry/color_index';
export type { ColorIndexResult, ComparisonResult } from './pipeline/m8_photometry/color_index';

export {
  classifyAnomaly,
  computePriorityScore,
  computeRValue,
  rankTopHits,
  shouldAutoReport,
  generateTNSReport,
  generateLabReport,
  recommendAction,
} from './pipeline/m8_photometry/top_hits';
export type { AnomalyReport, TopHit, Measurement, TNSReport, AnomalyClassification } from './pipeline/m8_photometry/top_hits';

// -- Tools --------------------------------------------------
export { analyzeEditDelta, computeHistogram } from './tools/preset_developer';
export type { ImageAnalysis, PresetResult } from './tools/preset_developer';

export { generateXMP, createDefaultRecipe } from './tools/preset_schema';
export type { EditRecipe, ToneCurvePoint, HSLChannel } from './tools/preset_schema';
