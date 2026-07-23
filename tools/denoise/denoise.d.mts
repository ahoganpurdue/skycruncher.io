// Type declarations for the deterministic denoise lane (denoise.mjs). Mirrors
// the runtime exports 1:1 so the .ts fixture test typechecks and the tsc gate
// stays clean (the .mjs remains the single source of behavior). Same proven
// pattern as tools/overnight/rotation.d.mts.

export type Plane = Float32Array | Float64Array | number[];

export const B3_KERNEL: number[];
export const STARLET_NOISE_FACTORS: number[];
export const DENOISE_DEFAULTS: {
  readonly kappa: number;
  readonly scales: number;
  readonly detail: number;
  readonly lowCountThresh: number;
};

export function median(arr: Plane): number;
export function madSigma(arr: Plane): number;

export interface NoiseModel {
  alpha: number;
  sigma: number;
  offset: number;
  gain_e_per_adu: number;
  read_noise_e: number;
  source: 'FITS_META' | 'ESTIMATED';
  approximate: boolean;
  photon_transfer: { tiles: number; bins: number; degenerate: boolean } | null;
}
export function estimateNoiseModel(
  plane: Plane,
  W: number,
  H: number,
  meta?: { gain_e_per_adu?: number; read_noise_e?: number; offset_adu?: number },
): NoiseModel;

export function gat(y: number, alpha: number, sigma: number): number;
export function inverseGatExact(D: number, alpha: number, sigma: number): number;
export function naiveInverseGat(D: number, alpha: number, sigma: number): number;
export function gatImage(plane: Plane, model: NoiseModel): Float64Array;
export function inverseGatImage(D: Plane, model: NoiseModel): Float64Array;

export interface Starlet {
  scales: Float64Array[];
  coarse: Float64Array;
}
export function starletTransform(data: Plane, W: number, H: number, J: number): Starlet;
export function starletReconstruct(s: Starlet): Float64Array;

export interface DenoiseReceipt {
  schema: string;
  method: string;
  noise_model: {
    gain_e_per_adu: number | null;
    read_noise_e: number | null;
    offset_adu: number | null;
    source: 'FITS_META' | 'ESTIMATED';
    label: 'MEASURED' | 'APPROXIMATE';
    photon_transfer: { tiles: number; bins: number; degenerate: boolean } | null;
  };
  vst: { transform: string; alpha: number | null; sigma: number | null; inverse: string };
  mad_sigma_vst_domain: number | null;
  starlet: { scales: number; kernel: string };
  kappa: number;
  thresholds: (number | null)[];
  detail_reinjection: number;
  low_count: { threshold_counts: number; fraction_below: number | null; regime_flag: boolean; note: string };
}
export interface DenoiseOpts {
  kappa?: number;
  scales?: number;
  detail?: number;
  lowCountThresh?: number;
  noiseModel?: NoiseModel;
  meta?: { gain_e_per_adu?: number; read_noise_e?: number; offset_adu?: number };
}
export function denoiseImage(
  plane: Plane,
  W: number,
  H: number,
  opts?: DenoiseOpts,
): { output: Float64Array; receipt: DenoiseReceipt };

export function backgroundMadSigma(plane: Plane, W: number, H: number): number;

export interface DetectedSource { x: number; y: number; v: number }
export function detectTopSources(plane: Plane, W: number, H: number, N: number, margin?: number): DetectedSource[];
export function apertureFluxSum(
  plane: Plane,
  W: number,
  H: number,
  sources: DetectedSource[],
  r?: number,
  rIn?: number,
  rOut?: number,
): number;
export function cropPlane(plane: Plane, W: number, H: number, x0: number, y0: number, W2: number, H2: number): Float32Array;

export function loadFitsPlane(
  file: string,
  planeIdx?: number,
): { plane: Float32Array; W: number; H: number; NP: number; cards: Record<string, string> } | null;
