/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * FILTER TRANSMISSION PROFILES â€” Optical Filter Spectral Data
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * Defines the spectral transmission curves for astrophotography filters.
 * When a filter is used, it selectively blocks certain wavelengths.
 * To recover the "true" star color, we must divide by the filter's
 * transmission â€” effectively "undoing" the filter in software.
 *
 * The engine uses this to apply the Inverse Matrix (subtract color bias).
 */

import { FilterType } from '../../types/schema';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TransmissionPoint {
  /** Wavelength in nanometers */
  nm: number;
  /** Transmission (0.0 = fully blocked, 1.0 = fully transparent) */
  pass: number;
}

export interface FilterProfile {
  /** Filter type enum value */
  type: FilterType;
  /** Human-readable name */
  label: string;
  /** Manufacturer / model if specific */
  model: string;
  /** Transmission curve */
  transmission: TransmissionPoint[];
  /** Brief description of what the filter does */
  description: string;
}

// â”€â”€â”€ FILTER DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const FILTER_PROFILES: Record<FilterType, FilterProfile> = {

  [FilterType.NONE]: {
    type: FilterType.NONE,
    label: 'No Filter',
    model: 'N/A',
    description: 'No optical filter. Full spectrum passes through to the sensor.',
    transmission: [
      { nm: 350, pass: 1.0 },
      { nm: 400, pass: 1.0 },
      { nm: 500, pass: 1.0 },
      { nm: 600, pass: 1.0 },
      { nm: 700, pass: 1.0 },
      { nm: 800, pass: 1.0 },
    ],
  },

  // â”€â”€ CLS (City Light Suppression) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Blocks sodium and mercury vapor emission lines (common streetlight pollution).
  // Passes HÎ± (656nm), OIII (500nm), HÎ² (486nm), SII (672nm).
  [FilterType.CLS]: {
    type: FilterType.CLS,
    label: 'City Light Suppression',
    model: 'Astronomik CLS (Generic)',
    description: 'Blocks Na (589nm) and Hg (546nm) emission lines from light pollution.',
    transmission: [
      { nm: 350, pass: 0.05 },
      { nm: 380, pass: 0.10 },
      { nm: 400, pass: 0.60 },
      { nm: 440, pass: 0.85 },
      { nm: 470, pass: 0.90 },
      { nm: 486, pass: 0.92 },  // HÎ² passband
      { nm: 500, pass: 0.90 },  // OIII passband
      { nm: 520, pass: 0.50 },
      { nm: 546, pass: 0.05 },  // Hg block
      { nm: 560, pass: 0.15 },
      { nm: 580, pass: 0.10 },
      { nm: 589, pass: 0.02 },  // Na block
      { nm: 600, pass: 0.15 },
      { nm: 630, pass: 0.60 },
      { nm: 650, pass: 0.85 },
      { nm: 656, pass: 0.90 },  // HÎ± passband
      { nm: 672, pass: 0.88 },  // SII passband
      { nm: 700, pass: 0.80 },
      { nm: 750, pass: 0.50 },
      { nm: 800, pass: 0.10 },
    ],
  },

  // â”€â”€ Dual Narrowband (HÎ± + OIII) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Extreme light pollution filter. Only passes two narrow windows:
  // HÎ± (656nm, ~7nm FWHM) and OIII (496-501nm, ~7nm FWHM).
  [FilterType.DUAL_NB]: {
    type: FilterType.DUAL_NB,
    label: 'Dual Narrowband (HÎ± + OIII)',
    model: 'Optolong L-eXtreme (Generic)',
    description: 'Passes only HÎ± (656nm) and OIII (500nm) with ~7nm bandwidth each.',
    transmission: [
      { nm: 350, pass: 0.00 },
      { nm: 400, pass: 0.00 },
      { nm: 450, pass: 0.00 },
      { nm: 490, pass: 0.02 },
      { nm: 496, pass: 0.85 },  // OIII start
      { nm: 500, pass: 0.95 },  // OIII peak
      { nm: 504, pass: 0.85 },  // OIII end
      { nm: 510, pass: 0.02 },
      { nm: 550, pass: 0.00 },
      { nm: 600, pass: 0.00 },
      { nm: 649, pass: 0.02 },
      { nm: 653, pass: 0.85 },  // HÎ± start
      { nm: 656, pass: 0.95 },  // HÎ± peak
      { nm: 660, pass: 0.85 },  // HÎ± end
      { nm: 665, pass: 0.02 },
      { nm: 700, pass: 0.00 },
      { nm: 800, pass: 0.00 },
    ],
  },

  // â”€â”€ UHC (Ultra High Contrast) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Wider passband than dual narrowband. Good for visual and photo.
  [FilterType.UHC]: {
    type: FilterType.UHC,
    label: 'Ultra High Contrast',
    model: 'Astronomik UHC (Generic)',
    description: 'Passes OIII + HÎ² window and HÎ± + SII window. Blocks LP broadly.',
    transmission: [
      { nm: 350, pass: 0.00 },
      { nm: 400, pass: 0.02 },
      { nm: 450, pass: 0.05 },
      { nm: 475, pass: 0.50 },
      { nm: 486, pass: 0.88 },  // HÎ²
      { nm: 496, pass: 0.90 },
      { nm: 500, pass: 0.92 },  // OIII
      { nm: 510, pass: 0.85 },
      { nm: 520, pass: 0.40 },
      { nm: 540, pass: 0.05 },
      { nm: 560, pass: 0.02 },
      { nm: 580, pass: 0.02 },
      { nm: 620, pass: 0.10 },
      { nm: 645, pass: 0.60 },
      { nm: 656, pass: 0.90 },  // HÎ±
      { nm: 672, pass: 0.85 },  // SII
      { nm: 690, pass: 0.50 },
      { nm: 710, pass: 0.10 },
      { nm: 750, pass: 0.02 },
      { nm: 800, pass: 0.00 },
    ],
  },

  // â”€â”€ UV/IR Cut â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Blocks UV and IR, passing only visible light.
  // Standard on most consumer cameras. Used explicitly on modded/astro cams.
  [FilterType.UV_IR]: {
    type: FilterType.UV_IR,
    label: 'UV/IR Cut',
    model: 'ZWO UV/IR Cut (Generic)',
    description: 'Passes visible light (400-700nm), blocks UV and IR.',
    transmission: [
      { nm: 300, pass: 0.00 },
      { nm: 350, pass: 0.01 },
      { nm: 380, pass: 0.10 },
      { nm: 400, pass: 0.85 },
      { nm: 450, pass: 0.95 },
      { nm: 500, pass: 0.97 },
      { nm: 550, pass: 0.98 },
      { nm: 600, pass: 0.97 },
      { nm: 650, pass: 0.95 },
      { nm: 680, pass: 0.85 },
      { nm: 700, pass: 0.40 },
      { nm: 720, pass: 0.05 },
      { nm: 750, pass: 0.01 },
      { nm: 800, pass: 0.00 },
    ],
  },
};

// â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Get the filter profile for a given filter type. */
export function getFilterProfile(type: FilterType): FilterProfile {
  return FILTER_PROFILES[type];
}

/** Interpolate filter transmission at a specific wavelength. */
export function interpolateTransmission(
  profile: FilterProfile,
  wavelengthNm: number
): number {
  const curve = profile.transmission;
  if (wavelengthNm <= curve[0].nm) return curve[0].pass;
  if (wavelengthNm >= curve[curve.length - 1].nm) return curve[curve.length - 1].pass;

  for (let i = 0; i < curve.length - 1; i++) {
    if (wavelengthNm >= curve[i].nm && wavelengthNm <= curve[i + 1].nm) {
      const t = (wavelengthNm - curve[i].nm) / (curve[i + 1].nm - curve[i].nm);
      return curve[i].pass + t * (curve[i + 1].pass - curve[i].pass);
    }
  }
  return 0;
}

/**
 * Compute the "inverse filter" correction factors for R, G, B channels.
 * Multiply observed RGB by these to recover pre-filter color.
 * Representative wavelengths: R=620nm, G=530nm, B=450nm.
 */
export function computeFilterInverse(profile: FilterProfile): { r: number; g: number; b: number } {
  const rPass = interpolateTransmission(profile, 620);
  const gPass = interpolateTransmission(profile, 530);
  const bPass = interpolateTransmission(profile, 450);

  return {
    r: rPass > 0.01 ? 1.0 / rPass : 1.0,
    g: gPass > 0.01 ? 1.0 / gPass : 1.0,
    b: bPass > 0.01 ? 1.0 / bPass : 1.0,
  };
}

