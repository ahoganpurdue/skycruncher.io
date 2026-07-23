# Supported Filters

**62 filters from 11 manufacturers.** Filters are organized by type (broadband, narrowband, light pollution, UV/IR) and sorted by passband. The SkyCruncher Support Tier indicates the level of spectral transmission data available in `filter_profiles.ts`.

## Support Tiers

| Tier | Icon | Meaning | What You Get |
|:-----|:-----|:--------|:-------------|
| Full | 🟢 | Lab-measured transmission curve (1nm resolution) | Sub-1% spectral correction. Full Lie Detector validation. |
| Good | 🟡 | Manufacturer-published transmission data (5nm) | ~3% correction. Lie Detector can identify filter family. |
| Basic | 🟠 | Generic passband model | Rough center wavelength + bandwidth only. |
| Untested | ⚪ | No transmission data | Filter compensation skipped. Community data welcome. |

---

## Light Pollution / Broadband Filters

| Model | Type | Passband | Hα | OIII | SII | Tier | filterId |
|:------|:-----|:---------|:---|:-----|:----|:-----|:---------|
| Optolong L-Pro | Multi-Bandpass LP | Broadband RGB + Hα/OIII | ✅ Pass | ✅ Pass | ✅ Pass | 🟢 Full | `OPTO_LPRO` |
| Optolong L-eXtreme | Dual-Narrowband | 7nm Hα + 7nm OIII | ✅ 7nm | ✅ 7nm | ❌ Block | 🟢 Full | `OPTO_LEXTREME` |
| Optolong L-enhance | Tri-Narrowband | Hα + OIII + Hβ | ✅ 10nm | ✅ 12nm | ❌ Block | 🟢 Full | `OPTO_Lenhance` |
| Optolong L-Ultimate | Dual-Narrowband | 3nm Hα + 3nm OIII | ✅ 3nm | ✅ 3nm | ❌ Block | 🟢 Full | `OPTO_LULTIMATE` |
| IDAS NBZ | Dual-Narrowband | Hα + OIII | ✅ 8nm | ✅ 8nm | ❌ Block | 🟡 Good | `IDAS_NBZ` |
| IDAS LPS-D2 | Broadband LP | Blocks Na + Hg lines | Partial | Partial | Partial | 🟡 Good | `IDAS_LPSD2` |
| Astronomik CLS | Broadband LP | Blocks Na + Hg | Partial | ✅ Pass | Partial | 🟢 Full | `ASTMK_CLS` |
| Astronomik CLS-CCD | CCD-Optimized LP | Blocks Na + Hg + IR | Partial | ✅ Pass | Partial | 🟢 Full | `ASTMK_CLSCCD` |
| Astronomik UHC | Semi-Narrowband | Hβ + OIII window | ❌ Block | ✅ 25nm | ❌ Block | 🟢 Full | `ASTMK_UHC` |
| STC Astro Duo-Narrowband | Clip-In Dual NB | Hα + OIII | ✅ 5nm | ✅ 5nm | ❌ Block | 🟡 Good | `STC_DUONB` |
| Radian Triad Ultra | Quad-Narrowband | Hα + OIII + SII + Hβ | ✅ 4nm | ✅ 4nm | ✅ 4nm | 🟡 Good | `RAD_TRIAD` |
| Svbony UV/IR Cut | UV/IR Rejection | 400–700nm pass | ✅ Pass | ✅ Pass | ✅ Pass | 🟠 Basic | `SVBONY_UVIR` |

---

## Narrowband Filters (Dedicated Astronomy)

### Hydrogen-Alpha (Hα — 656.3nm)

| Model | Bandwidth | Peak Transmission | Mount | Tier | filterId |
|:------|:----------|:------------------|:------|:-----|:---------|
| Chroma Hα 3nm | 3nm | >90% | 2" / 36mm | 🟢 Full | `CHROMA_HA3` |
| Chroma Hα 5nm | 5nm | >90% | 2" / 36mm | 🟢 Full | `CHROMA_HA5` |
| Astrodon Hα 3nm | 3nm | >90% | 2" / 31mm | 🟢 Full | `ADON_HA3` |
| Astrodon Hα 5nm | 5nm | >90% | 2" / 31mm | 🟢 Full | `ADON_HA5` |
| Baader Hα 7nm | 7nm | >92% | 2" / 36mm | 🟢 Full | `BAADER_HA7` |
| Baader Hα 35nm | 35nm | >95% | 2" / 36mm | 🟡 Good | `BAADER_HA35` |
| ZWO Hα 7nm | 7nm | >90% | 2" / 31mm / EOS clip | 🟡 Good | `ZWO_HA7` |
| Optolong Hα 7nm | 7nm | >90% | 2" / 36mm / EOS clip | 🟡 Good | `OPTO_HA7` |
| Antlia Hα 3nm Ultra | 3nm | >90% | 2" / 36mm | 🟡 Good | `ANTLIA_HA3` |

### Oxygen-III (OIII — 500.7nm)

| Model | Bandwidth | Peak Transmission | Mount | Tier | filterId |
|:------|:----------|:------------------|:------|:-----|:---------|
| Chroma OIII 3nm | 3nm | >90% | 2" / 36mm | 🟢 Full | `CHROMA_O3_3` |
| Astrodon OIII 3nm | 3nm | >90% | 2" / 31mm | 🟢 Full | `ADON_O3_3` |
| Baader OIII 8.5nm | 8.5nm | >90% | 2" / 36mm | 🟢 Full | `BAADER_O3_8` |
| ZWO OIII 7nm | 7nm | >90% | 2" / 31mm / EOS clip | 🟡 Good | `ZWO_O3_7` |
| Optolong OIII 6.5nm | 6.5nm | >90% | 2" / 36mm | 🟡 Good | `OPTO_O3_6` |

### Sulfur-II (SII — 672.4nm)

| Model | Bandwidth | Peak Transmission | Mount | Tier | filterId |
|:------|:----------|:------------------|:------|:-----|:---------|
| Chroma SII 3nm | 3nm | >85% | 2" / 36mm | 🟢 Full | `CHROMA_S2_3` |
| Astrodon SII 3nm | 3nm | >85% | 2" / 31mm | 🟢 Full | `ADON_S2_3` |
| Baader SII 8nm | 8nm | >90% | 2" / 36mm | 🟡 Good | `BAADER_S2_8` |
| ZWO SII 7nm | 7nm | >85% | 2" / 31mm | 🟡 Good | `ZWO_S2_7` |
| Optolong SII 6.5nm | 6.5nm | >85% | 2" / 36mm | 🟡 Good | `OPTO_S2_6` |

---

## Photometric Standard Filters

| Model | System | Bands | Tier | filterId |
|:------|:-------|:------|:-----|:---------|
| Astrodon Photometrics UBVRI | Johnson-Cousins | U, B, V, R, I | 🟢 Full | `ADON_UBVRI` |
| Chroma Johnson-Cousins BVRI | Johnson-Cousins | B, V, R, I | 🟢 Full | `CHROMA_BVRI` |
| Baader Johnson B | Johnson | B (440nm) | 🟢 Full | `BAADER_JB` |
| Baader Johnson V | Johnson | V (550nm) | 🟢 Full | `BAADER_JV` |
| Sloan g' / r' / i' (Chroma) | SDSS | g', r', i' | 🟡 Good | `CHROMA_SLOAN` |

> [!IMPORTANT]
> Photometric standard filters are used for **absolute color calibration**. If you own Johnson B and V filters, shooting the same star field through both produces a direct B-V measurement that bypasses all RGB-to-BV estimation. This is the gold standard for validating the SkyCruncher's `computeColorIndex()` function against ground truth.

---

## UV/IR Cut & Clear Filters

| Model | Passband | Purpose | Tier | filterId |
|:------|:---------|:--------|:-----|:---------|
| Baader UV/IR Cut L | 400–685nm | Standard luminance window | 🟢 Full | `BAADER_UVIR_L` |
| ZWO UV/IR Cut | 400–700nm | General imaging | 🟡 Good | `ZWO_UVIR` |
| Astronomik L-2 UV/IR Block | 400–700nm | CCD luminance | 🟡 Good | `ASTMK_L2` |
| Optolong UV/IR Cut | 400–700nm | General imaging | 🟠 Basic | `OPTO_UVIR` |
| Astronomik ProPlanet 642 | >642nm IR pass | Planetary imaging | 🟡 Good | `ASTMK_PP642` |

---

## The Lie Detector & Filters

The SkyCruncher's **Lie Detector** (in `m2_hardware/hardware_adapter.ts`; formerly in the deleted `orchestrator.ts` auto path) compares the expected spectral signature from the declared filter against the actual RGB channel ratios in the image. Known filter signatures are stored in `FILTER_SIGNATURES`:

| Declared → Detected | Spectral Clue | Action |
|:---------------------|:--------------|:-------|
| None → CLS | Strong green deficit (~15%) | Auto-apply CLS compensation |
| None → Dual NB | Red/teal bias, green void | Auto-apply narrowband compensation |
| CLS → UHC | Blue shift vs expected CLS | Warn user, switch to UHC profile |
| None → UV/IR Cut | Minimal spectral shift | Silent pass (common default) |

### Contributing a New Filter Profile

1. **Shoot a known A0V reference star** (e.g. Vega) through the filter with RAW → provides empirical transmission curve
2. **Upload manufacturer transmission CSV** → we digitize 1nm or 5nm resolution curves
3. **Shoot comparison frames** (with filter / without filter, same star field) → measures throughput loss per channel

