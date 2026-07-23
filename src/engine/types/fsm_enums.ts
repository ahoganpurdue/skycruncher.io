/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SKYCRUNCHER â€” FSM Provenance Enum Index
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * Single import point for all 17 Data Provenance FSM enum domains.
 * Import from here instead of hunting through manifest.ts or schema.ts.
 *
 * Usage:
 *   import { CoordinateSystem, SignalState, DistortionCorrection } from '../types/fsm_enums';
 *
 * [Module: Cross-Cutting]
 * [Domain: All 17 Provenance Domains]
 */

// â”€â”€ I. Data & Coordinates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export {
  MemoryResidency,
  PhotographyData,
  NormalizationState,
  CoordinateSystem,
  StarRepresentation,
  StarCount,
} from './manifest';

// â”€â”€ II. Environment & Hardware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export {
  HardwareProfileState,
  TemporalState,
  SegmentationState,
  TerrestrialLocation,
  PlanetaryDetection,
  AstronomicalLocation,
  PhotometricSolution,
} from './manifest';

// â”€â”€ III. Calibration & Correction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export {
  VerificationState,
  SignalState,
  LocationCorrection,
  ShapeCorrection,
  ColorCorrection,
  DistortionCorrection,
  ResamplingKernel,
} from './manifest';

// â”€â”€ IV. Schema-Level Enums â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export {
  TrackingMount,
  FilterType,
  TimeValidationStatus,
  CalibrationFrame,
  FingerprintTier,
} from './schema';
