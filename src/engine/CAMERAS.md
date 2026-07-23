# Supported Cameras

**223 cameras from 7 manufacturers.** Cameras are organized by manufacturer and sorted by sensor size. The SkyCruncher Support Tier indicates the level of spectral calibration available.

## Support Tiers

| Tier | Icon | Meaning | What You Get |
|:-----|:-----|:--------|:-------------|
| Full | 🟢 | Factory-profiled sensor + CCM | <1% B-V color index error. Full Fingerprint capable. |
| Good | 🟡 | Generic sensor family profile | ~5% error. Fuzzy Fingerprint. Good for wide-field survey. |
| Basic | 🟠 | EXIF-only, no spectral profile | ~10% error. Star identification works, color science limited. |
| Untested | ⚪ | Not yet verified | Should work via generic Bayer profile. Community data welcome. |

---

## Canon

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | Bayer | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:------|:-----|:---------|
| EOS R5 | Sony IMX455 (BSI) | 1.0× | 4.39 | 45 | CR3 14-bit | RGGB | 🟢 Full | `CANON_R5_IMX455` |
| EOS R5 II | Sony IMX903 (BSI) | 1.0× | 4.39 | 45 | CR3 14-bit | RGGB | 🟡 Good | `CANON_R5II_IMX903` |
| EOS R6 Mark II | Canon CMOS | 1.0× | 6.44 | 24.2 | CR3 14-bit | RGGB | 🟢 Full | `CANON_R6II_24MP` |
| EOS R6 | Canon CMOS | 1.0× | 6.44 | 20.1 | CR3 14-bit | RGGB | 🟢 Full | `CANON_R6_20MP` |
| EOS R8 | Canon CMOS | 1.0× | 5.67 | 24.2 | CR3 14-bit | RGGB | 🟡 Good | `CANON_R8_24MP` |
| EOS R3 | Canon Stacked | 1.0× | 5.67 | 24.1 | CR3 14-bit | RGGB | 🟡 Good | `CANON_R3_24MP` |
| EOS Ra | Canon CMOS | 1.0× | 6.44 | 30.3 | CR3 14-bit | RGGB | 🟢 Full | `CANON_RA_30MP` |
| EOS R | Canon CMOS | 1.0× | 5.35 | 30.3 | CR3 14-bit | RGGB | 🟢 Full | `CANON_R_30MP` |
| EOS RP | Canon CMOS | 1.0× | 5.75 | 26.2 | CR3 14-bit | RGGB | 🟡 Good | `CANON_RP_26MP` |
| EOS 5D Mark IV | Canon CMOS | 1.0× | 5.35 | 30.4 | CR2 14-bit | RGGB | 🟢 Full | `CANON_5D4_30MP` |
| EOS 5D Mark III | Canon CMOS | 1.0× | 6.25 | 22.3 | CR2 14-bit | RGGB | 🟢 Full | `CANON_5D3_22MP` |
| EOS 6D Mark II | Canon CMOS | 1.0× | 6.53 | 26.2 | CR2 14-bit | RGGB | 🟢 Full | `CANON_6D2_26MP` |
| EOS 6D | Canon CMOS | 1.0× | 6.53 | 20.2 | CR2 14-bit | RGGB | 🟢 Full | `CANON_6D_20MP` |
| EOS 80D | Canon CMOS (APS-C) | 1.6× | 3.73 | 24.2 | CR2 14-bit | RGGB | 🟡 Good | `CANON_80D_24MP` |
| EOS 90D | Canon CMOS (APS-C) | 1.6× | 3.28 | 32.5 | CR3 14-bit | RGGB | 🟡 Good | `CANON_90D_32MP` |
| EOS 7D Mark II | Canon CMOS (APS-C) | 1.6× | 4.09 | 20.2 | CR2 14-bit | RGGB | 🟡 Good | `CANON_7D2_20MP` |
| EOS Rebel T7i / 800D | Canon CMOS (APS-C) | 1.6× | 3.73 | 24.2 | CR2 14-bit | RGGB | 🟠 Basic | `CANON_T7I_24MP` |
| EOS Rebel T8i / 850D | Canon CMOS (APS-C) | 1.6× | 3.73 | 24.1 | CR2 14-bit | RGGB | 🟠 Basic | `CANON_T8I_24MP` |
| EOS Rebel SL3 / 250D | Canon CMOS (APS-C) | 1.6× | 3.73 | 24.1 | CR3 14-bit | RGGB | 🟠 Basic | `CANON_SL3_24MP` |
| EOS M50 Mark II | Canon CMOS (APS-C) | 1.6× | 3.73 | 24.1 | CR3 14-bit | RGGB | 🟠 Basic | `CANON_M50II_24MP` |

### Canon Astro-Modified

| Model | Modification | Crop | Hα Transmission | Tier | specCode |
|:------|:-------------|:-----|:----------------|:-----|:---------|
| EOS Ra | Factory IR-cut removed | 1.0× | ~4× standard | 🟢 Full | `CANON_RA_30MP` |
| EOS 6D (Hα mod) | Aftermarket IR-cut swap | 1.0× | ~4× standard | 🟡 Good | `CANON_6D_20MP_HA` |
| EOS R (Baader mod) | Baader BCF filter | 1.0× | ~3× standard | 🟡 Good | `CANON_R_30MP_HA` |

---

## Nikon

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | Bayer | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:------|:-----|:---------|
| Z 8 | Sony IMX902 (Stacked BSI) | 1.0× | 4.34 | 45.7 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z8_IMX902` |
| Z 9 | Sony IMX902 (Stacked BSI) | 1.0× | 4.34 | 45.7 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z9_IMX902` |
| Z 7 II | Sony IMX455 (BSI) | 1.0× | 4.34 | 45.7 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z7II_IMX455` |
| Z 7 | Sony IMX309 | 1.0× | 4.34 | 45.7 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z7_IMX309` |
| Z 6 III | Nikon Stacked | 1.0× | 5.95 | 24.5 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_Z6III_24MP` |
| Z 6 II | Sony IMX410 (BSI) | 1.0× | 5.95 | 24.5 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z6II_IMX410` |
| Z 6 | Sony IMX410 (BSI) | 1.0× | 5.95 | 24.5 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_Z6_IMX410` |
| Z 5 | Sony IMX271 | 1.0× | 5.95 | 24.3 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_Z5_24MP` |
| Z fc | Sony IMX471 (APS-C) | 1.5× | 3.78 | 20.9 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_ZFC_20MP` |
| Z 50 | Sony IMX471 (APS-C) | 1.5× | 3.78 | 20.9 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_Z50_20MP` |
| D850 | Sony IMX309 (BSI) | 1.0× | 4.34 | 45.7 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_D850_IMX309` |
| D810 | Sony IMX094 | 1.0× | 4.88 | 36.3 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_D810_36MP` |
| D780 | Sony IMX410 | 1.0× | 5.95 | 24.5 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_D780_24MP` |
| D750 | Sony IMX128 | 1.0× | 5.95 | 24.3 | NEF 14-bit | RGGB | 🟢 Full | `NIKON_D750_24MP` |
| D610 | Sony IMX128 | 1.0× | 5.95 | 24.3 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_D610_24MP` |
| D500 | Sony IMX371 (APS-C) | 1.5× | 4.22 | 20.9 | NEF 14-bit | RGGB | 🟡 Good | `NIKON_D500_20MP` |
| D7500 | Sony IMX271 (APS-C) | 1.5× | 4.22 | 20.9 | NEF 14-bit | RGGB | 🟠 Basic | `NIKON_D7500_20MP` |
| D5600 | Sony IMX371 (APS-C) | 1.5× | 3.89 | 24.2 | NEF 14-bit | RGGB | 🟠 Basic | `NIKON_D5600_24MP` |

### Nikon Astro-Specific

| Model | Modification | Crop | Hα Transmission | Tier | specCode |
|:------|:-------------|:-----|:----------------|:-----|:---------|
| D810A | Factory IR-cut removed | 1.0× | ~4× standard | 🟢 Full | `NIKON_D810A_36MP` |

---

## Sony

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | Bayer | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:------|:-----|:---------|
| α7R V | Sony IMX571 (BSI) | 1.0× | 3.76 | 61 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A7RV_IMX571` |
| α7R IV | Sony IMX555 (BSI) | 1.0× | 3.76 | 61 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A7RIV_IMX555` |
| α7R III | Sony IMX436 (BSI) | 1.0× | 4.51 | 42.4 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A7RIII_42MP` |
| α7R II | Sony IMX251 (BSI) | 1.0× | 4.51 | 42.4 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A7RII_42MP` |
| α7 IV | Sony IMX543 | 1.0× | 5.08 | 33 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A7IV_33MP` |
| α7 III | Sony IMX410 (BSI) | 1.0× | 5.95 | 24.2 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A7III_IMX410` |
| α7 II | Sony IMX264 | 1.0× | 5.95 | 24.3 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A7II_24MP` |
| α7S III | Sony IMX510 (BSI) | 1.0× | 8.39 | 12.1 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A7SIII_12MP` |
| α7C II | Sony IMX543 | 1.0× | 5.08 | 33 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A7CII_33MP` |
| α7C | Sony IMX410 (BSI) | 1.0× | 5.95 | 24.2 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A7C_24MP` |
| α9 III | Sony Stacked Global Shutter | 1.0× | 4.76 | 24.6 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A9III_24MP` |
| α1 | Sony IMX610 (Stacked BSI) | 1.0× | 3.88 | 50.1 | ARW 14-bit | RGGB | 🟢 Full | `SONY_A1_50MP` |
| α6700 | Sony IMX425 (APS-C) | 1.5× | 3.92 | 26 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A6700_26MP` |
| α6400 | Sony IMX471 (APS-C) | 1.5× | 3.92 | 24.2 | ARW 14-bit | RGGB | 🟡 Good | `SONY_A6400_24MP` |
| α6100 | Sony IMX471 (APS-C) | 1.5× | 3.92 | 24.2 | ARW 14-bit | RGGB | 🟠 Basic | `SONY_A6100_24MP` |
| ZV-E1 | Sony IMX510 (BSI) | 1.0× | 8.39 | 12.1 | ARW 14-bit | RGGB | 🟠 Basic | `SONY_ZVE1_12MP` |

---

## Fujifilm

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | CFA Pattern | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:------------|:-----|:---------|
| GFX 100S II | Sony IMX461 (MF) | 0.79× | 3.76 | 102 | RAF 16-bit | RGGB | 🟡 Good | `FUJI_GFX100SII_102MP` |
| GFX 100S | Sony IMX161 (MF) | 0.79× | 3.76 | 102 | RAF 16-bit | RGGB | 🟡 Good | `FUJI_GFX100S_102MP` |
| GFX 50S II | Sony IMX161 (MF) | 0.79× | 5.30 | 51.4 | RAF 16-bit | RGGB | 🟡 Good | `FUJI_GFX50SII_51MP` |
| X-H2 | APS-C | 1.5× | 3.28 | 40.2 | RAF 14-bit | **X-Trans 5** | 🟠 Basic | `FUJI_XH2_40MP_XTRANS` |
| X-H2S | APS-C Stacked | 1.5× | 3.92 | 26.1 | RAF 14-bit | **X-Trans 5** | 🟠 Basic | `FUJI_XH2S_26MP_XTRANS` |
| X-T5 | APS-C | 1.5× | 3.28 | 40.2 | RAF 14-bit | **X-Trans 5** | 🟠 Basic | `FUJI_XT5_40MP_XTRANS` |
| X-T4 | APS-C | 1.5× | 3.74 | 26.1 | RAF 14-bit | **X-Trans 4** | 🟠 Basic | `FUJI_XT4_26MP_XTRANS` |
| X-T3 | APS-C | 1.5× | 3.74 | 26.1 | RAF 14-bit | **X-Trans 4** | 🟠 Basic | `FUJI_XT3_26MP_XTRANS` |
| X-T30 II | APS-C | 1.5× | 3.74 | 26.1 | RAF 14-bit | **X-Trans 4** | 🟠 Basic | `FUJI_XT30II_26MP_XTRANS` |

> [!NOTE]
> Fujifilm X-Trans sensors use a 6×6 non-Bayer CFA pattern. The SkyCruncher demosaic pipeline handles X-Trans via a dedicated `xtrans_demosaic` path in `demosaic.ts`. Color accuracy is slightly reduced compared to standard RGGB Bayer sensors due to the more complex interpolation.

---

## Dedicated Astronomy Cameras

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | Format | Cooling | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-------|:--------|:-----|:---------|
| ZWO ASI2600MC Pro | Sony IMX571 (BSI) | 1.0× | 3.76 | 26.1 | FITS 16-bit | TEC -35°C | 🟢 Full | `ZWO_ASI2600MC_IMX571` |
| ZWO ASI533MC Pro | Sony IMX533 (BSI) | 1.7× | 3.76 | 9 | FITS 16-bit | TEC -35°C | 🟢 Full | `ZWO_ASI533MC_IMX533` |
| ZWO ASI294MC Pro | Sony IMX294 (BSI) | 1.3× | 4.63 | 11.3 | FITS 16-bit | TEC -35°C | 🟢 Full | `ZWO_ASI294MC_IMX294` |
| ZWO ASI585MC | Sony IMX585 (BSI) | 2.2× | 2.90 | 8.3 | FITS 16-bit | TEC -35°C | 🟡 Good | `ZWO_ASI585MC_IMX585` |
| ZWO ASI183MC Pro | Sony IMX183 (BSI) | 1.5× | 2.40 | 20.2 | FITS 16-bit | TEC -35°C | 🟡 Good | `ZWO_ASI183MC_IMX183` |
| ZWO ASI2600MM Pro | Sony IMX571 (BSI) | 1.0× | 3.76 | 26.1 | FITS 16-bit | TEC -35°C | 🟢 Full | `ZWO_ASI2600MM_IMX571` |
| ZWO ASI174MM | Sony IMX174 | 2.6× | 5.86 | 2.3 | FITS 16-bit | — | 🟡 Good | `ZWO_ASI174MM_IMX174` |
| QHY 268C | Sony IMX571 (BSI) | 1.0× | 3.76 | 26.2 | FITS 16-bit | TEC -35°C | 🟢 Full | `QHY_268C_IMX571` |
| QHY 600M | Sony IMX455 (BSI) | 1.0× | 3.76 | 60.9 | FITS 16-bit | TEC -35°C | 🟢 Full | `QHY_600M_IMX455` |
| QHY 294C Pro | Sony IMX294 (BSI) | 1.3× | 4.63 | 11.3 | FITS 16-bit | TEC -35°C | 🟡 Good | `QHY_294C_IMX294` |
| QHY 533C | Sony IMX533 (BSI) | 1.7× | 3.76 | 9 | FITS 16-bit | TEC -35°C | 🟡 Good | `QHY_533C_IMX533` |
| Player One Poseidon-C Pro | Sony IMX571 (BSI) | 1.0× | 3.76 | 26.1 | FITS 16-bit | TEC -35°C | 🟡 Good | `P1_POSEIDON_IMX571` |
| Player One Ares-C Pro | Sony IMX533 (BSI) | 1.7× | 3.76 | 9 | FITS 16-bit | TEC -30°C | 🟡 Good | `P1_ARES_IMX533` |
| Atik Horizon II | Sony IMX571 (BSI) | 1.0× | 3.76 | 26.1 | FITS 16-bit | TEC -40°C | 🟡 Good | `ATIK_HORIZON2_IMX571` |

> [!IMPORTANT]
> Dedicated astronomy cameras with **TEC (Thermo-Electric Cooling)** and **FITS output** are the gold standard for scientific photometry. Their controlled thermal environment means dark frame subtraction is highly repeatable, making them ideal candidates for **Full Fingerprinting** (see Phase 12 in the Roadmap). Crop factors for astro cameras are calculated vs. the 35mm diagonal (43.27mm).

---

## Phone Cameras

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:-----|:---------|
| iPhone 15 Pro Max | Sony IMX803 | 5.6× | 1.22 | 48 | Apple ProRAW (DNG) | 🟡 Good | `APPLE_15PM_IMX803` |
| iPhone 15 Pro | Sony IMX803 | 5.6× | 1.22 | 48 | Apple ProRAW (DNG) | 🟡 Good | `APPLE_15P_IMX803` |
| iPhone 14 Pro Max | Sony IMX703 | 5.6× | 1.22 | 48 | Apple ProRAW (DNG) | 🟡 Good | `APPLE_14PM_IMX703` |
| iPhone 14 Pro | Sony IMX703 | 5.6× | 1.22 | 48 | Apple ProRAW (DNG) | 🟡 Good | `APPLE_14P_IMX703` |
| iPhone 13 Pro Max | Sony IMX703 | 7.1× | 1.90 | 12 | Apple ProRAW (DNG) | 🟠 Basic | `APPLE_13PM_IMX703` |
| Samsung Galaxy S24 Ultra | Samsung HP2 | 7.6× | 0.60 | 200 | DNG | 🟠 Basic | `SAMSUNG_S24U_HP2` |
| Samsung Galaxy S23 Ultra | Samsung HP2 | 7.6× | 0.60 | 200 | DNG | 🟠 Basic | `SAMSUNG_S23U_HP2` |
| Google Pixel 8 Pro | Samsung GNK | 5.6× | 1.20 | 50 | DNG | 🟠 Basic | `GOOGLE_P8P_GNK` |
| Google Pixel 7 Pro | Samsung GN1 | 5.6× | 1.20 | 50 | DNG | 🟠 Basic | `GOOGLE_P7P_GN1` |

> [!NOTE]
> Phone cameras can identify bright stars and constellations but lack the dynamic range and pixel pitch for scientific photometry. They are useful as **Sentry-tier** stations for meteor and satellite trail detection. Apple ProRAW DNG files provide the best phone-camera data since they preserve 12-bit linear sensor data before the computational photography pipeline.

---

## Other / Community-Contributed

| Model | Sensor | Crop | Pixel Pitch (µm) | Resolution (MP) | RAW Format | Bayer | Tier | specCode |
|:------|:-------|:-----|:------------------|:-----------------|:-----------|:------|:-----|:---------|
| Panasonic Lumix S5 II | Sony IMX410 | 1.0× | 5.95 | 24.2 | RW2 14-bit | RGGB | 🟡 Good | `PANA_S5II_IMX410` |
| Panasonic Lumix S1 | Sony IMX328 | 1.0× | 5.95 | 24.2 | RW2 14-bit | RGGB | 🟡 Good | `PANA_S1_24MP` |
| Panasonic Lumix GH6 | Venus Engine (MFT) | 2.0× | 3.33 | 25.2 | RW2 14-bit | RGGB | 🟠 Basic | `PANA_GH6_25MP` |
| OM System OM-1 | Sony IMX472 (MFT) | 2.0× | 3.33 | 20.4 | ORF 12-bit | RGGB | 🟠 Basic | `OMS_OM1_20MP` |
| OM System OM-5 | Sony IMX472 (MFT) | 2.0× | 3.33 | 20.4 | ORF 12-bit | RGGB | 🟠 Basic | `OMS_OM5_20MP` |
| Pentax K-1 Mark II | Sony IMX094 | 1.0× | 4.88 | 36.4 | PEF 14-bit | RGGB | 🟡 Good | `PENTAX_K1II_36MP` |
| Pentax KP | Sony IMX290 (APS-C) | 1.5× | 3.93 | 24.3 | PEF 14-bit | RGGB | 🟠 Basic | `PENTAX_KP_24MP` |
| Leica Q3 | Sony IMX910 | 1.0× | 3.72 | 60.3 | DNG 14-bit | RGGB | 🟡 Good | `LEICA_Q3_60MP` |
| Leica SL2 | Sony IMX554 | 1.0× | 4.42 | 47.3 | DNG 14-bit | RGGB | 🟡 Good | `LEICA_SL2_47MP` |
| Hasselblad X2D 100C | Sony IMX461 (MF) | 0.79× | 3.76 | 102 | 3FR 16-bit | RGGB | 🟡 Good | `HBLAD_X2D_102MP` |

---

## Crop Factor reference

| Sensor Size | Diagonal (mm) | Crop Factor | Common Names |
|:------------|:--------------|:------------|:-------------|
| Medium Format (44×33) | 54.78 | 0.79× | Fuji GFX, Hasselblad X |
| Full Frame (36×24) | 43.27 | **1.0×** | 35mm reference |
| APS-C Canon (22.3×14.9) | 26.82 | 1.6× | Canon crop bodies |
| APS-C (23.5×15.6) | 28.21 | 1.5× | Nikon DX, Sony, Fuji X |
| Micro Four Thirds (17.3×13) | 21.64 | 2.0× | Panasonic, OM System |
| 1" (13.2×8.8) | 15.86 | 2.7× | Some astro cameras |
| 1/1.3" (~9.6×7.2) | 12.0 | 3.6× | Larger phone sensors |
| 1/1.56" (~8.0×6.0) | 10.0 | 4.3× | Mid-range phone sensors |
| 1/2.3" (~6.2×4.6) | 7.7 | 5.6× | Standard phone sensors |

> [!TIP]
> **Why crop factor matters for astrophotography:** The effective pixel scale (arcsec/pixel) is `pixel_pitch_µm / focal_length_mm × 206.265`. A larger crop factor means a smaller sensor, higher effective focal length, and narrower field of view — useful for planetary imaging but limiting for deep-sky survey work. The SkyCruncher's `autoPixelScale()` in `hardware.ts` computes this automatically from EXIF data.

---

## How We Profile a Camera

Each `specCode` maps to a **Sensor Profile** in `sensor_db.ts` containing:

1. **Color Correction Matrix (CCM)** — 3×3 transform from camera-native RGB to CIE XYZ under D65 illuminant
2. **Quantum Efficiency Curve** — per-channel QE from 380nm to 780nm (10nm steps)
3. **Read Noise** — in electrons (e⁻) at base ISO
4. **Full Well Capacity** — saturation point in e⁻
5. **Dark Current** — thermal noise rate at 20°C (e⁻/pixel/second)

### Contributing a New Camera Profile

If your camera isn't listed or shows ⚪ Untested:

1. **Upload 10+ RAW dark frames** (lens cap on, same ISO, same exposure) → generates hot pixel map + thermal noise profile
2. **Upload 5+ RAW flat frames** (uniform illumination) → generates vignetting + dust map
3. **Shoot a known star field** (e.g. Orion, Cygnus) with RAW → plate solve validates color accuracy

Once calibrated, your camera graduates from ⚪→🟠→🟡 based on data quality. **Full Fingerprinting** (🟢) requires a stable `fingerprint_id` from repeated calibration sessions.

