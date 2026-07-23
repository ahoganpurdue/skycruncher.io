/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SENSOR DATABASE (CSI_INDEX) â€” Camera Quantum Efficiency Profiles
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * Each sensor has a Quantum Efficiency (QE) curve describing how
 * efficiently it converts photons to electrons at each wavelength.
 * Two cameras looking at the same star will disagree on its color
 * unless we normalize them through these profiles.
 *
 * The color_matrix (3Ã—3) transforms the sensor's native RGB into
 * CIE XYZ, effectively "translating" from the sensor's language
 * to the universal standard.
 */

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { matchByBody, type BodyRegistryEntry } from './identifier_matcher';

export interface QEPoint {
  /** Wavelength in nanometers */
  nm: number;
  /** Quantum efficiency (0.0 â€“ 1.0) */
  efficiency: number;
}

export interface SensorProfile {
  /** Sensor chip model (e.g. "Sony IMX571") */
  sensor_model: string;
  /** Camera bodies using this sensor */
  camera_bodies: string[];
  /** Pixel pitch in micrometers (needed for pixel_scale calculation) */
  pixel_size_um: number;
  /** Sensor resolution */
  resolution: { width: number; height: number };
  /** Bayer pattern type. 'XTRANS' = Fujifilm's 6×6 non-Bayer CFA — the honest
   *  label (never mislabel X-Trans as 'RGGB'). X-Trans RAW is decoded via
   *  libraw document-mode into an RGB16 mem_image, so no 2×2 Bayer demosaic
   *  reads this field for those bodies (it is descriptive, not a demosaic key). */
  bayer_pattern: 'RGGB' | 'GRBG' | 'GBRG' | 'BGGR' | 'MONO' | 'XTRANS';
  /** Quantum Efficiency curve (wavelength â†’ efficiency) */
  qe_curve: QEPoint[];
  /** TRUE when qe_curve is APPROXIMATE — a datasheet-generic curve borrowed from
   *  a same-family sensor or a placeholder, NOT a per-copy measurement (the
   *  distinction the per-body header comments already draw). Machine-readable so
   *  the CELL ④ QE-throughput divide-out (m8_photometry/qe_throughput) can carry
   *  the APPROXIMATE label to any reported product (LAW 3). Absent/undefined ⇒
   *  the curve is treated as vendor-datasheet-grounded. NOT a calibrated value. */
  qe_approximate?: boolean;
  /** 3Ã—3 color correction matrix to XYZ (row-major) */
  color_matrix: [
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
  /** Read noise in electrons at unity gain */
  read_noise_e: number;
  /** Full well capacity in electrons */
  full_well_e: number;
  /** Typical dark current (e-/pixel/sec at 20Â°C) */
  dark_current: number;
  /** Vendor gain SETTING (ZWO UI number, NOT ISO) -> native e-/ADU calibration points.
   *  Interpolate with getGainForSetting(); never feed the setting to getGainForISO. */
  gain_curve?: { setting: number; e_adu_native: number }[];
  /** Left bit-shift applied when native ADC counts are expanded to 16-bit ADU
   *  (e.g. 12-bit ADC -> shift 4 -> effective e-/ADU divides by 16). */
  adu_bit_shift?: number;
}

// â”€â”€â”€ SENSOR DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const SENSOR_DB: Record<string, SensorProfile> = {

  // â”€â”€ Sony IMX571 (Popular APS-C Astro Sensor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Used in ZWO ASI2600MC/MM, QHY268C, and similar astro cameras.
  // Peak QE ~91% at 530nm (mono version).
  'IMX571': {
    sensor_model: 'Sony IMX571',
    camera_bodies: ['ZWO ASI2600MC Pro', 'ZWO ASI2600MM Pro', 'QHY268C'],
    pixel_size_um: 3.76,
    resolution: { width: 6248, height: 4176 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.15 },
      { nm: 400, efficiency: 0.45 },
      { nm: 450, efficiency: 0.72 },
      { nm: 500, efficiency: 0.85 },
      { nm: 530, efficiency: 0.91 },
      { nm: 550, efficiency: 0.88 },
      { nm: 600, efficiency: 0.80 },
      { nm: 650, efficiency: 0.65 },
      { nm: 700, efficiency: 0.45 },
      { nm: 750, efficiency: 0.25 },
      { nm: 800, efficiency: 0.10 },
      { nm: 850, efficiency: 0.03 },
    ],
    color_matrix: [
      [ 1.8467, -0.7168, -0.1299],
      [-0.3416,  1.5523,  -0.2107],
      [ 0.0518, -0.3654,  1.3136],
    ],
    read_noise_e: 1.2,
    full_well_e: 50000,
    dark_current: 0.0022,
  },

  // â”€â”€ Canon CMOS (EOS R5 / Ra family) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Full-frame BSI CMOS. The Ra variant has modified IR cut filter
  // for enhanced HÎ± sensitivity.
  'CANON_FF_BSI': {
    sensor_model: 'Canon Full-Frame BSI CMOS',
    camera_bodies: ['Canon EOS R5', 'Canon EOS Ra', 'Canon EOS R6 II'],
    pixel_size_um: 4.39,
    resolution: { width: 8192, height: 5464 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.08 },
      { nm: 400, efficiency: 0.35 },
      { nm: 450, efficiency: 0.58 },
      { nm: 500, efficiency: 0.68 },
      { nm: 530, efficiency: 0.72 },
      { nm: 550, efficiency: 0.70 },
      { nm: 600, efficiency: 0.62 },
      { nm: 656, efficiency: 0.25 },  // HÎ± â€” heavily cut by IR filter (Ra: ~0.55)
      { nm: 700, efficiency: 0.15 },
      { nm: 750, efficiency: 0.05 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.7256, -0.6206, -0.1050],
      [-0.2910,  1.4680,  -0.1770],
      [ 0.0420, -0.3120,  1.2700],
    ],
    read_noise_e: 2.1,
    full_well_e: 63800,
    dark_current: 0.015,
  },

  // -- Canon full-frame DSLR CMOS (5D Mk III / 6D / 5D Mk II) --------
  // 36x24mm full-frame DSLRs — the classic astro-modified bodies. These are
  // DISTINCT sensors from CANON_FF_BSI (the R5/Ra mirrorless, 4.39um): the
  // older DSLRs have MUCH larger pixels (6.25-6.58um). Each body is its own
  // entry because pitch differs per body — lumping would lie about resolution.
  // WHY THIS EXISTS: a full-frame body silently defaulting to the APS-C 4.30um
  // pitch yields a ~45% scale error that pins an anchored sweep off the sky
  // (5D Mk III diagnosis, 2026-07-06; ROADMAP standing ledger).
  // qe_curve/color_matrix are APPROXIMATE — copied from the same-era Canon DSLR
  // CMOS family (CANON_APS_C_18MP, stock IR cut); refined by SPCC downstream.
  // Solve-critical fields (pixel_size_um, resolution, bayer_pattern) are exact.
  'CANON_5D_MK_III': {
    qe_approximate: true,  // APPROXIMATE — copied from CANON_APS_C_18MP family (header)
    sensor_model: 'Canon 22MP Full-Frame CMOS',
    camera_bodies: ['Canon EOS 5D Mark III', 'Canon EOS 5D Mark III (astro)'],
    pixel_size_um: 6.25,  // 36.0mm / 5760px = 6.25um/px
    resolution: { width: 5760, height: 3840 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.05 },
      { nm: 400, efficiency: 0.28 },
      { nm: 450, efficiency: 0.50 },
      { nm: 500, efficiency: 0.62 },
      { nm: 530, efficiency: 0.66 },
      { nm: 550, efficiency: 0.64 },
      { nm: 600, efficiency: 0.58 },
      { nm: 656, efficiency: 0.18 },  // HÎ± â€” heavily attenuated by stock IR cut
      { nm: 700, efficiency: 0.10 },
      { nm: 750, efficiency: 0.03 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.6800, -0.5900, -0.0900],
      [-0.2700,  1.4200,  -0.1500],
      [ 0.0350, -0.2800,  1.2450],
    ],
    read_noise_e: 2.9,
    full_well_e: 67500,
    dark_current: 0.02,
  },

  'CANON_6D': {
    qe_approximate: true,  // APPROXIMATE — copied from CANON_APS_C_18MP family (header)
    sensor_model: 'Canon 20MP Full-Frame CMOS',
    camera_bodies: ['Canon EOS 6D', 'Canon EOS 6D (astro)'],
    pixel_size_um: 6.55,  // 36.0mm / 5472px = 6.58um (6.55 cited)
    resolution: { width: 5472, height: 3648 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.05 },
      { nm: 400, efficiency: 0.28 },
      { nm: 450, efficiency: 0.50 },
      { nm: 500, efficiency: 0.62 },
      { nm: 530, efficiency: 0.66 },
      { nm: 550, efficiency: 0.64 },
      { nm: 600, efficiency: 0.58 },
      { nm: 656, efficiency: 0.18 },  // HÎ± â€” heavily attenuated by stock IR cut
      { nm: 700, efficiency: 0.10 },
      { nm: 750, efficiency: 0.03 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.6800, -0.5900, -0.0900],
      [-0.2700,  1.4200,  -0.1500],
      [ 0.0350, -0.2800,  1.2450],
    ],
    read_noise_e: 2.7,
    full_well_e: 68000,
    dark_current: 0.02,
  },

  'CANON_5D_MK_II': {
    qe_approximate: true,  // APPROXIMATE — copied from CANON_APS_C_18MP family (header)
    sensor_model: 'Canon 21MP Full-Frame CMOS',
    camera_bodies: ['Canon EOS 5D Mark II', 'Canon EOS 5D Mark II (astro)'],
    pixel_size_um: 6.41,  // 36.0mm / 5616px = 6.41um/px
    resolution: { width: 5616, height: 3744 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.04 },
      { nm: 400, efficiency: 0.26 },
      { nm: 450, efficiency: 0.48 },
      { nm: 500, efficiency: 0.60 },
      { nm: 530, efficiency: 0.64 },
      { nm: 550, efficiency: 0.62 },
      { nm: 600, efficiency: 0.56 },
      { nm: 656, efficiency: 0.16 },  // HÎ± â€” heavily attenuated by stock IR cut
      { nm: 700, efficiency: 0.09 },
      { nm: 750, efficiency: 0.03 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.6800, -0.5900, -0.0900],
      [-0.2700,  1.4200,  -0.1500],
      [ 0.0350, -0.2800,  1.2450],
    ],
    read_noise_e: 3.8,
    full_well_e: 66000,
    dark_current: 0.03,
  },

  // â”€â”€ Sony IMX455 (Full-Frame Astro Sensor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Used in ZWO ASI6200, QHY600. 61.2MP full-frame BSI.
  'IMX455': {
    sensor_model: 'Sony IMX455',
    camera_bodies: ['ZWO ASI6200MC Pro', 'ZWO ASI6200MM Pro', 'QHY600M'],
    pixel_size_um: 3.76,
    resolution: { width: 9576, height: 6388 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.18 },
      { nm: 400, efficiency: 0.52 },
      { nm: 450, efficiency: 0.78 },
      { nm: 500, efficiency: 0.88 },
      { nm: 530, efficiency: 0.92 },
      { nm: 550, efficiency: 0.90 },
      { nm: 600, efficiency: 0.82 },
      { nm: 656, efficiency: 0.72 },  // HÎ± â€” no IR cut (astro cam)
      { nm: 700, efficiency: 0.50 },
      { nm: 750, efficiency: 0.28 },
      { nm: 800, efficiency: 0.12 },
      { nm: 850, efficiency: 0.04 },
    ],
    color_matrix: [
      [ 1.8100, -0.6900, -0.1200],
      [-0.3200,  1.5200,  -0.2000],
      [ 0.0500, -0.3500,  1.3000],
    ],
    read_noise_e: 1.0,
    full_well_e: 51000,
    dark_current: 0.0018,
  },

  // â”€â”€ Nikon Z-Mount CMOS (Z6 III / Z8) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'NIKON_FF_STACKED': {
    sensor_model: 'Nikon Stacked CMOS',
    camera_bodies: ['Nikon Z6 III', 'Nikon Z8', 'Nikon Z9'],
    pixel_size_um: 5.94,
    resolution: { width: 6048, height: 4032 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.06 },
      { nm: 400, efficiency: 0.32 },
      { nm: 450, efficiency: 0.55 },
      { nm: 500, efficiency: 0.65 },
      { nm: 530, efficiency: 0.70 },
      { nm: 550, efficiency: 0.68 },
      { nm: 600, efficiency: 0.60 },
      { nm: 656, efficiency: 0.22 },
      { nm: 700, efficiency: 0.12 },
      { nm: 750, efficiency: 0.04 },
    ],
    color_matrix: [
      [ 1.6900, -0.5800, -0.1100],
      [-0.2700,  1.4300,  -0.1600],
      [ 0.0380, -0.2900,  1.2520],
    ],
    read_noise_e: 1.5,
    full_well_e: 68000,
    dark_current: 0.008,
  },

  // â”€â”€ Sony A7 III / A7C (Popular Entry Astro Body) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'IMX410': {
    sensor_model: 'Sony IMX410',
    camera_bodies: ['Sony A7 III', 'Sony A7C', 'Sony A7C II'],
    pixel_size_um: 5.93,
    resolution: { width: 6000, height: 4000 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.07 },
      { nm: 400, efficiency: 0.33 },
      { nm: 450, efficiency: 0.56 },
      { nm: 500, efficiency: 0.66 },
      { nm: 530, efficiency: 0.70 },
      { nm: 550, efficiency: 0.68 },
      { nm: 600, efficiency: 0.61 },
      { nm: 656, efficiency: 0.23 },
      { nm: 700, efficiency: 0.13 },
      { nm: 750, efficiency: 0.04 },
    ],
    color_matrix: [
      [ 1.7100, -0.6000, -0.1100],
      [-0.2800,  1.4500,  -0.1700],
      [ 0.0400, -0.3000,  1.2600],
    ],
    read_noise_e: 1.6,
    full_well_e: 50400,
    dark_current: 0.006,
  },

  // â”€â”€ Canon APS-C CMOS (EOS Rebel T6 / T7 / T5i family) â”€â”€â”€â”€â”€
  // 18MP APS-C sensor (22.3 x 14.9mm). Pixel pitch: 4.30Âµm.
  // Used in: T6 (1300D), T7 (2000D), T5i (700D), T6i (750D), T6s (760D).
  // IR cut filter heavily attenuates HÎ± (656nm) â€” typical for stock DSLRs.
  'CANON_APS_C_18MP': {
    sensor_model: 'Canon 18MP APS-C CMOS',
    camera_bodies: [
      'Canon EOS Rebel T6',
      'Canon EOS 1300D',
      'Canon EOS Rebel T7',
      'Canon EOS 2000D',
      'Canon EOS Rebel T5i',
      'Canon EOS 700D',
      'Canon EOS Rebel T6i',
      'Canon EOS 750D',
      'Canon EOS Rebel T6s',
      'Canon EOS 760D',
      'Canon EOS Rebel T5',
      'Canon EOS 1200D',
    ],
    pixel_size_um: 4.30,  // 22.3mm / 5184px = 4.30Âµm/px
    resolution: { width: 5184, height: 3456 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.05 },
      { nm: 400, efficiency: 0.28 },
      { nm: 450, efficiency: 0.50 },
      { nm: 500, efficiency: 0.62 },
      { nm: 530, efficiency: 0.66 },
      { nm: 550, efficiency: 0.64 },
      { nm: 600, efficiency: 0.58 },
      { nm: 656, efficiency: 0.18 },  // HÎ± â€” heavily attenuated by stock IR cut
      { nm: 700, efficiency: 0.10 },
      { nm: 750, efficiency: 0.03 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.6800, -0.5900, -0.0900],
      [-0.2700,  1.4200,  -0.1500],
      [ 0.0350, -0.2800,  1.2450],
    ],
    read_noise_e: 3.8,
    full_well_e: 34000,
    dark_current: 0.025,
  },

  // -- Canon 60D / 60Da (18MP APS-C DSLR — Cocoon astro rig) -----------
  // WHY THIS EXISTS (owner-approved 2026-07-12): the Cocoon 60Da light frames
  // (Sample Files/corpus/cocoon_60da/lights, WO Zenithstar 73 @ 430mm, IC 5146)
  // had NO sensor profile, so the EXIF_OPTICS scale rung (optics_resolver ->
  // findSensorByCamera) returned null and the DSLR frame fell through to the
  // blind Tri-Lock, which phantomed to a ~126deg field. With this entry the
  // DSLR path locks scale from geometry (206.265 x 4.30um / FL) on the
  // EXIF_OPTICS rung instead of a flaky blind triangulation.
  //
  // MODEL-STRING NOTE (VERIFIED 2026-07-12 via exifr on L_0020..L_0030): the CR2
  // TIFF Model tag exifr reads — the string metadata_reaper feeds
  // findSensorByCamera — is "Canon EOS 60D", NOT "60Da". LibRaw's separate color
  // path (camera_color_matrix.ts) reports "Canon EOS 60Da" from the Canon model
  // ID (Halpha-mod red response). Both strings are listed so either decoder's
  // body string resolves this profile. The bundled CR2 e2e frame is a DIFFERENT
  // body (5D-family) — untouched by these strings.
  //
  // Solve-critical fields (pixel_size_um, resolution, bayer_pattern) are EXACT:
  // Canon official 22.3x14.9mm APS-C, 5184x3456 (matches the verified EXIF dims),
  // 22.3mm/5184px = 4.30um/px, RGGB. qe_curve/color_matrix/noise are APPROXIMATE
  // — copied from the same 18MP APS-C Canon DSLR family (CANON_APS_C_18MP, stock
  // IR cut) and refined by SPCC downstream. The 60Da astro variant has ELEVATED
  // Halpha (~656nm; the stock 0.18 here understates it, cf. the Ra ~0.55) — a
  // photometry detail, not solve-critical, and Cocoon CR2 does not run the SPCC
  // gains path (FITS-only).
  'CANON_60D': {
    qe_approximate: true,  // APPROXIMATE — copied from CANON_APS_C_18MP family (header)
    sensor_model: 'Canon 18MP APS-C CMOS',
    camera_bodies: [
      'Canon EOS 60D',
      'Canon EOS 60Da',
      'Canon EOS 60D (astro)',
      'Canon EOS 60Da (astro)',
    ],
    pixel_size_um: 4.30,  // 22.3mm / 5184px = 4.30um/px
    resolution: { width: 5184, height: 3456 },
    bayer_pattern: 'RGGB',
    qe_curve: [
      { nm: 350, efficiency: 0.05 },
      { nm: 400, efficiency: 0.28 },
      { nm: 450, efficiency: 0.50 },
      { nm: 500, efficiency: 0.62 },
      { nm: 530, efficiency: 0.66 },
      { nm: 550, efficiency: 0.64 },
      { nm: 600, efficiency: 0.58 },
      { nm: 656, efficiency: 0.18 },  // Halpha — stock IR cut (60Da astro variant ~0.55)
      { nm: 700, efficiency: 0.10 },
      { nm: 750, efficiency: 0.03 },
      { nm: 800, efficiency: 0.01 },
    ],
    color_matrix: [
      [ 1.6800, -0.5900, -0.0900],
      [-0.2700,  1.4200,  -0.1500],
      [ 0.0350, -0.2800,  1.2450],
    ],
    read_noise_e: 3.8,
    full_well_e: 34000,
    dark_current: 0.025,
  },

  // ── Fujifilm X-Trans CMOS 5 HR (BSI, 40.2MP APS-C) ───────────────
  // Fujifilm X-T5 (and the X-H2, which shares this sensor). X-Trans is a 6×6
  // non-Bayer CFA (labeled 'XTRANS'); our RAW path decodes RAF via libraw
  // document-mode into an RGB16 mem_image (verified on DSCF4954.RAF: active
  // 7752×5178, u16 count == w·h·3), so no 2×2 Bayer demosaic runs.
  //   Sources: Fujifilm X-T5 spec sheet (40.2MP, 23.5×15.6mm APS-C, 7728×5152
  //   max still) — pixel pitch 23.5mm / 7728px = 3.04µm.
  // HONESTY (LAW 3): pixel_size_um, resolution, bayer_pattern are EXACT/cited.
  // qe_curve, color_matrix, read_noise_e, full_well_e, dark_current below are
  // APPROXIMATE generic BSI-CMOS values — NOT per-body measured; SPCC /
  // calibrated-photometry claims for this body are NOT VALIDATED (solve +
  // geometry are honest on the native RAW; radiometry is approximate).
  'FUJIFILM_XTRANS5_HR': {
    qe_approximate: true,  // APPROXIMATE — generic modern BSI APS-C, not per-body measured (header)
    sensor_model: 'Fujifilm X-Trans CMOS 5 HR (BSI)',
    camera_bodies: ['X-T5', 'Fujifilm X-T5', 'X-H2', 'Fujifilm X-H2'],
    pixel_size_um: 3.04,  // 23.5mm / 7728px = 3.04µm (cited)
    resolution: { width: 7728, height: 5152 },
    bayer_pattern: 'XTRANS',
    qe_curve: [  // APPROXIMATE — generic modern BSI APS-C, not per-body measured
      { nm: 350, efficiency: 0.10 },
      { nm: 400, efficiency: 0.45 },
      { nm: 450, efficiency: 0.68 },
      { nm: 500, efficiency: 0.78 },
      { nm: 530, efficiency: 0.80 },
      { nm: 550, efficiency: 0.78 },
      { nm: 600, efficiency: 0.68 },
      { nm: 656, efficiency: 0.30 },  // Hα attenuated by stock IR-cut filter
      { nm: 700, efficiency: 0.18 },
      { nm: 750, efficiency: 0.07 },
      { nm: 800, efficiency: 0.02 },
    ],
    color_matrix: [  // APPROXIMATE generic sRGB→XYZ-style matrix — NOT measured
      [ 1.7200, -0.6200, -0.1000],
      [-0.3000,  1.4800,  -0.1800],
      [ 0.0400, -0.3000,  1.2800],
    ],
    read_noise_e: 1.6,    // APPROXIMATE (X-Trans 5 HR base ISO, generic)
    full_well_e: 22000,   // APPROXIMATE (small 3.04µm pixel)
    dark_current: 0.02,   // APPROXIMATE
  },

  // ── Fujifilm X-Trans CMOS 4 (BSI, 26.1MP APS-C) ──────────────────
  // Fujifilm X-T4 (shared with X-T3 / X-Pro3 / X-S10 / X-E4). X-Trans 6×6 CFA.
  //   Sources: Fujifilm X-T4 spec sheet (26.1MP, 23.5×15.6mm APS-C, 6240×4160
  //   max still) — pixel pitch 23.5mm / 6240px = 3.76µm.
  // HONESTY (LAW 3): solve-critical fields exact/cited; photometry fields below
  // are APPROXIMATE generic BSI-CMOS — NOT per-body measured, SPCC NOT VALIDATED.
  'FUJIFILM_XTRANS4': {
    qe_approximate: true,  // APPROXIMATE — generic modern BSI APS-C, not per-body measured (header)
    sensor_model: 'Fujifilm X-Trans CMOS 4 (BSI)',
    camera_bodies: ['X-T4', 'Fujifilm X-T4', 'X-T3', 'Fujifilm X-T3'],
    pixel_size_um: 3.76,  // 23.5mm / 6240px = 3.76µm (cited)
    resolution: { width: 6240, height: 4160 },
    bayer_pattern: 'XTRANS',
    qe_curve: [  // APPROXIMATE — generic modern BSI APS-C, not per-body measured
      { nm: 350, efficiency: 0.09 },
      { nm: 400, efficiency: 0.43 },
      { nm: 450, efficiency: 0.66 },
      { nm: 500, efficiency: 0.76 },
      { nm: 530, efficiency: 0.78 },
      { nm: 550, efficiency: 0.76 },
      { nm: 600, efficiency: 0.66 },
      { nm: 656, efficiency: 0.28 },  // Hα attenuated by stock IR-cut filter
      { nm: 700, efficiency: 0.16 },
      { nm: 750, efficiency: 0.06 },
      { nm: 800, efficiency: 0.02 },
    ],
    color_matrix: [  // APPROXIMATE generic sRGB→XYZ-style matrix — NOT measured
      [ 1.7200, -0.6200, -0.1000],
      [-0.3000,  1.4800,  -0.1800],
      [ 0.0400, -0.3000,  1.2800],
    ],
    read_noise_e: 1.6,    // APPROXIMATE (X-Trans 4 base ISO, generic)
    full_well_e: 32000,   // APPROXIMATE (3.76µm pixel)
    dark_current: 0.02,   // APPROXIMATE
  },

  // -- Sony IMX585 (STARVIS 2, 1/1.2" 8.3MP) -----------------------
  // Used in the ZWO Seestar S30 Pro smart telescope and ASI585MC.
  // 12-bit ADC expanded to 16-bit in FITS output (adu_bit_shift: 4).
  'IMX585': {
    qe_approximate: true,  // APPROXIMATE — placeholder copied from IMX455 (header)
    sensor_model: 'Sony IMX585',
    camera_bodies: ['ZWO Seestar S30 Pro', 'Seestar S30 Pro', 'ZWO ASI585MC', 'imx585'],
    pixel_size_um: 2.9,
    resolution: { width: 3840, height: 2160 },
    bayer_pattern: 'GRBG',
    // qe_curve/color_matrix: placeholder - refined by SPCC (copied from the
    // closest Sony BSI astro sensor, IMX455)
    qe_curve: [
      { nm: 350, efficiency: 0.18 },
      { nm: 400, efficiency: 0.52 },
      { nm: 450, efficiency: 0.78 },
      { nm: 500, efficiency: 0.88 },
      { nm: 530, efficiency: 0.92 },
      { nm: 550, efficiency: 0.90 },
      { nm: 600, efficiency: 0.82 },
      { nm: 656, efficiency: 0.72 },
      { nm: 700, efficiency: 0.50 },
      { nm: 750, efficiency: 0.28 },
      { nm: 800, efficiency: 0.12 },
      { nm: 850, efficiency: 0.04 },
    ],
    color_matrix: [
      [ 1.8100, -0.6900, -0.1200],
      [-0.3200,  1.5200,  -0.2000],
      [ 0.0500, -0.3500,  1.3000],
    ],
    read_noise_e: 1.0,
    full_well_e: 40000,
    dark_current: 0.003,
    // ZWO ASI585 published gain chart (native e-/ADU at the 12-bit ADC)
    gain_curve: [
      { setting: 0,   e_adu_native: 6.55 },
      { setting: 100, e_adu_native: 2.0  },
      { setting: 200, e_adu_native: 0.65 },
      { setting: 252, e_adu_native: 0.55 },
      { setting: 300, e_adu_native: 0.31 },
    ],
    adu_bit_shift: 4,
  },

  // -- Sony IMX462 (STARVIS, 1/2.8" 2.1MP) --------------------------
  // ZWO Seestar S50 smart telescope (FL 250mm f/5). Same 2.9um pitch
  // family as the S30 Pro. Geometry (pixel scale, dims, CFA) is header-
  // driven; this entry exists so gain/QE stop falling back to the
  // uncalibrated 0.05 e-/ADU default.
  // APPROXIMATE PHOTOMETRY: gain_curve/qe_curve/color_matrix borrowed
  // from the IMX585 profile (same Sony STARVIS 2.9um family) until a
  // per-device calibration chart is sourced. Flagged, not fabricated-
  // as-exact: expect ~20-30% gain-scale uncertainty vs a real chart.
  'IMX462': {
    qe_approximate: true,  // APPROXIMATE — borrowed from IMX585 STARVIS family (header)
    sensor_model: 'Sony IMX462',
    camera_bodies: ['ZWO Seestar S50', 'Seestar S50', 'ZWO ASI462MC', 'imx462'],
    pixel_size_um: 2.9,
    resolution: { width: 1920, height: 1080 },
    bayer_pattern: 'GRBG',
    qe_curve: [
      { nm: 350, efficiency: 0.18 }, { nm: 400, efficiency: 0.52 },
      { nm: 450, efficiency: 0.78 }, { nm: 500, efficiency: 0.88 },
      { nm: 530, efficiency: 0.92 }, { nm: 550, efficiency: 0.90 },
      { nm: 600, efficiency: 0.82 }, { nm: 656, efficiency: 0.78 },
      { nm: 700, efficiency: 0.60 }, { nm: 750, efficiency: 0.40 },
      { nm: 800, efficiency: 0.22 }, { nm: 850, efficiency: 0.10 },
    ],
    color_matrix: [
      [ 1.8100, -0.6900, -0.1200],
      [-0.3200,  1.5200,  -0.2000],
      [ 0.0500, -0.3500,  1.3000],
    ],
    read_noise_e: 1.2,
    full_well_e: 12000,
    dark_current: 0.005,
    gain_curve: [
      { setting: 0,   e_adu_native: 6.55 },
      { setting: 100, e_adu_native: 2.0  },
      { setting: 200, e_adu_native: 0.65 },
      { setting: 252, e_adu_native: 0.55 },
      { setting: 300, e_adu_native: 0.31 },
    ],
    adu_bit_shift: 4,
  },

  // -- Sony IMX662 (STARVIS 2, 1/2.8" 2.1MP) ------------------------
  // ZWO Seestar S30 (non-Pro; FL 150mm f/5). Same caveats as IMX462:
  // geometry is header-driven; photometry approximate (IMX585-family
  // values) until a per-device chart is sourced.
  'IMX662': {
    qe_approximate: true,  // APPROXIMATE — IMX585-family values (header)
    sensor_model: 'Sony IMX662',
    camera_bodies: ['ZWO Seestar S30', 'Seestar S30', 'ZWO ASI662MC', 'imx662'],
    pixel_size_um: 2.9,
    resolution: { width: 1920, height: 1080 },
    bayer_pattern: 'GRBG',
    qe_curve: [
      { nm: 350, efficiency: 0.18 }, { nm: 400, efficiency: 0.52 },
      { nm: 450, efficiency: 0.78 }, { nm: 500, efficiency: 0.88 },
      { nm: 530, efficiency: 0.92 }, { nm: 550, efficiency: 0.90 },
      { nm: 600, efficiency: 0.82 }, { nm: 656, efficiency: 0.75 },
      { nm: 700, efficiency: 0.55 }, { nm: 750, efficiency: 0.35 },
      { nm: 800, efficiency: 0.18 }, { nm: 850, efficiency: 0.08 },
    ],
    color_matrix: [
      [ 1.8100, -0.6900, -0.1200],
      [-0.3200,  1.5200,  -0.2000],
      [ 0.0500, -0.3500,  1.3000],
    ],
    read_noise_e: 1.0,
    full_well_e: 38000,
    dark_current: 0.003,
    gain_curve: [
      { setting: 0,   e_adu_native: 6.55 },
      { setting: 100, e_adu_native: 2.0  },
      { setting: 200, e_adu_native: 0.65 },
      { setting: 252, e_adu_native: 0.55 },
      { setting: 300, e_adu_native: 0.31 },
    ],
    adu_bit_shift: 4,
  },
};

// â”€â”€â”€ LOOKUP HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Find a sensor profile by camera body name (case-insensitive) —
 * EXACT-FIRST, then bounded substring; ambiguity → null (honest UNKNOWN).
 *
 * WHY THIS SHAPE (ultracode HELD #1, owner ruling 2026-07-10): the previous
 * scorer used the matched DB body's LENGTH as specificity under a
 * BIDIRECTIONAL substring test, so a longer wrong entry that merely
 * prefix-contains the search term outranked an exact hit:
 * 'Canon EOS 5D Mark II' scored 'Canon EOS 5D Mark III (astro)' at 29 vs the
 * exact 5D2 body at 20 → the Mk III profile won (6.25µm/5760px instead of
 * 6.41µm/5616px, a silent ~2.56% scale error — the exact full-frame trap this
 * file's own header warns about). 'ZWO Seestar S30' was likewise routed to
 * the S30 Pro profile (IMX585 instead of IMX662).
 *
 * Ladder:
 *   1. EXACT body match wins outright. Distinct profiles both claiming the
 *      exact string would be a DB defect → null, never a coin flip.
 *   2. Substring match (either direction) scored by OVERLAP length
 *      = min(len(body), len(search)) — a body can no longer outrank an
 *      equal-overlap rival by its OWN length. Best overlap claimed by >1
 *      DISTINCT profile → null (honest UNKNOWN over a wrong profile: e.g.
 *      bare '5d mark ii' ties 5D2/5D3 at tier 2 — refuse rather than guess;
 *      full EXIF Model strings resolve at tier 1). */
export function findSensorByCamera(cameraModel: string): SensorProfile | null {
  // Thin wrapper over the canonical `matchByBody` ladder (identifier_matcher.ts).
  // Preserves the @005a91a tier-1 exact / tier-2 overlap / ambiguity→null
  // semantics EXACTLY, and INHERITS the rule-3 residual-token guard that closes
  // the absent-sibling residual (`Canon EOS R6` → the `R6 II` sensor; the
  // `optics_resolver` #5 case). Every sensor lookup — metadata_reaper,
  // hardware_adapter, optics_resolver — routes through here.
  return matchByBody(cameraModel, sensorBodyRegistry());
}

/** SENSOR_DB → body-keyed registry view for the shared matcher. */
function sensorBodyRegistry(): BodyRegistryEntry<SensorProfile>[] {
  return Object.values(SENSOR_DB).map((profile) => ({ entry: profile, bodies: profile.camera_bodies }));
}

/** Interpolate QE at a specific wavelength from the curve. */
export function interpolateQE(curve: QEPoint[], wavelengthNm: number): number {
  if (wavelengthNm <= curve[0].nm) return curve[0].efficiency;
  if (wavelengthNm >= curve[curve.length - 1].nm) return curve[curve.length - 1].efficiency;

  for (let i = 0; i < curve.length - 1; i++) {
    if (wavelengthNm >= curve[i].nm && wavelengthNm <= curve[i + 1].nm) {
      const t = (wavelengthNm - curve[i].nm) / (curve[i + 1].nm - curve[i].nm);
      return curve[i].efficiency + t * (curve[i + 1].efficiency - curve[i].efficiency);
    }
  }
  return 0;
}

/**
 * Resolve a vendor gain SETTING (e.g. ZWO "GAIN=200") to e-/ADU in the
 * delivered bit depth: piecewise-linear interpolation over gain_curve
 * (clamped to the endpoints), divided by 2^adu_bit_shift to account for
 * ADC-to-16-bit expansion. Returns null when the profile has no gain curve.
 */
export function getGainForSetting(profile: SensorProfile, setting: number): number | null {
  const curve = profile.gain_curve;
  if (!curve || curve.length === 0) return null;

  const shiftDivisor = 2 ** (profile.adu_bit_shift ?? 0);

  if (setting <= curve[0].setting) return curve[0].e_adu_native / shiftDivisor;
  const last = curve[curve.length - 1];
  if (setting >= last.setting) return last.e_adu_native / shiftDivisor;

  for (let i = 0; i < curve.length - 1; i++) {
    if (setting >= curve[i].setting && setting <= curve[i + 1].setting) {
      const t = (setting - curve[i].setting) / (curve[i + 1].setting - curve[i].setting);
      const native = curve[i].e_adu_native + t * (curve[i + 1].e_adu_native - curve[i].e_adu_native);
      return native / shiftDivisor;
    }
  }
  return null;
}

