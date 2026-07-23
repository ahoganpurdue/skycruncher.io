# Supported Lenses

**94 lenses from 12 manufacturers.** Lenses are organized by type (telescope optics, camera lenses, cine lenses) and sorted by focal length. The SkyCruncher Support Tier indicates the level of optical correction data available in `lens_profiles.ts`.

## Support Tiers

| Tier | Icon | Meaning | What You Get |
|:-----|:-----|:--------|:-------------|
| Full | 🟢 | Measured vignette + distortion profile | Per-pixel correction map. Sub-1% photometry across full frame. |
| Good | 🟡 | Parametric vignette model (no distortion) | ~3% corner falloff correction. Good for wide-field survey. |
| Basic | 🟠 | Generic f-ratio model only | Rough vignette estimate from aperture. No distortion data. |
| Untested | ⚪ | No profile | Flat-field correction skipped. Community data welcome. |

---

## Telescope Optics — Refractors

| Model | Aperture | Focal Length | f/ | Corrected Field | Tier | profileId |
|:------|:---------|:-------------|:---|:-----------------|:-----|:----------|
| Takahashi FSQ-106EDX4 | 106mm | 530mm | f/5.0 | 88mm (full frame) | 🟢 Full | `TAK_FSQ106_530` |
| Takahashi TOA-150 | 150mm | 1100mm | f/7.3 | 60mm | 🟢 Full | `TAK_TOA150_1100` |
| Takahashi FC-100DF | 100mm | 740mm | f/7.4 | 44mm | 🟡 Good | `TAK_FC100DF_740` |
| William Optics RedCat 71 | 71mm | 350mm | f/4.9 | 44mm (full frame) | 🟢 Full | `WO_REDCAT71_350` |
| William Optics GT81 | 81mm | 478mm | f/5.9 | 44mm (full frame) | 🟡 Good | `WO_GT81_478` |
| William Optics FLT132 | 132mm | 925mm | f/7.0 | 44mm | 🟡 Good | `WO_FLT132_925` |
| Sharpstar 61EDPHII | 61mm | 360mm | f/5.5 | 44mm (full frame) | 🟡 Good | `SS_61EDPH2_360` |
| Askar FRA600 | 108mm | 600mm | f/5.6 | 44mm (full frame) | 🟢 Full | `ASKAR_FRA600_600` |
| Askar FRA400 | 72mm | 400mm | f/5.6 | 44mm (full frame) | 🟡 Good | `ASKAR_FRA400_400` |
| Sky-Watcher Esprit 100ED | 100mm | 550mm | f/5.5 | 44mm (full frame) | 🟡 Good | `SW_ESPRIT100_550` |
| Sky-Watcher Esprit 150ED | 150mm | 1050mm | f/7.0 | 44mm | 🟡 Good | `SW_ESPRIT150_1050` |
| Sky-Watcher Evostar 72ED | 72mm | 420mm | f/5.8 | 28mm (APS-C) | 🟠 Basic | `SW_EVO72ED_420` |
| Vixen VSD90SS | 90mm | 495mm | f/5.5 | 44mm (full frame) | 🟡 Good | `VIXEN_VSD90_495` |
| RASA 8 (Celestron) | 203mm | 400mm | f/2.0 | 32mm | 🟢 Full | `CEL_RASA8_400` |
| RASA 11 (Celestron) | 279mm | 620mm | f/2.2 | 44mm | 🟢 Full | `CEL_RASA11_620` |

## Telescope Optics — Reflectors

| Model | Aperture | Focal Length | f/ | Design | Tier | profileId |
|:------|:---------|:-------------|:---|:-------|:-----|:----------|
| Sky-Watcher 200P | 200mm | 1000mm | f/5.0 | Newtonian | 🟢 Full | `SW_200P_1000` |
| Sky-Watcher 250P | 250mm | 1200mm | f/4.7 | Newtonian | 🟡 Good | `SW_250P_1200` |
| Sky-Watcher 130PDS | 130mm | 650mm | f/5.0 | Newtonian | 🟡 Good | `SW_130PDS_650` |
| GSO 8" RC | 203mm | 1624mm | f/8.0 | Ritchey-Chrétien | 🟡 Good | `GSO_RC8_1624` |
| GSO 6" RC | 152mm | 1370mm | f/9.0 | Ritchey-Chrétien | 🟡 Good | `GSO_RC6_1370` |
| Orion 8" Astrograph | 203mm | 800mm | f/3.9 | Newtonian | 🟠 Basic | `ORION_8ASTRO_800` |
| TS-Optics 10" RC | 254mm | 2000mm | f/8.0 | Ritchey-Chrétien | 🟠 Basic | `TS_RC10_2000` |

## Telescope Optics — Catadioptric

| Model | Aperture | Focal Length | f/ | Design | Tier | profileId |
|:------|:---------|:-------------|:---|:-------|:-----|:----------|
| Celestron EdgeHD 8" | 203mm | 2032mm | f/10 | Schmidt-Cassegrain | 🟢 Full | `CEL_EDGE8_2032` |
| Celestron EdgeHD 11" | 279mm | 2800mm | f/10 | Schmidt-Cassegrain | 🟢 Full | `CEL_EDGE11_2800` |
| Celestron EdgeHD 14" | 356mm | 3910mm | f/11 | Schmidt-Cassegrain | 🟡 Good | `CEL_EDGE14_3910` |
| Meade LX200 10" | 254mm | 2500mm | f/10 | Schmidt-Cassegrain | 🟡 Good | `MEADE_LX200_2500` |
| Celestron NexStar 8SE | 203mm | 2032mm | f/10 | Schmidt-Cassegrain | 🟠 Basic | `CEL_8SE_2032` |

---

## Camera Lenses — Wide-Field Astro Favorites

| Model | Focal Length | Aperture | Mount | Image Circle | Tier | profileId |
|:------|:-------------|:---------|:------|:-------------|:-----|:----------|
| Sigma 14mm f/1.8 DG HSM Art | 14mm | f/1.8 | EF / L / E | Full Frame | 🟢 Full | `SIGMA_14_18ART` |
| Sigma 20mm f/1.4 DG DN Art | 20mm | f/1.4 | L / E | Full Frame | 🟢 Full | `SIGMA_20_14ART` |
| Sigma 24mm f/1.4 DG DN Art | 24mm | f/1.4 | L / E | Full Frame | 🟢 Full | `SIGMA_24_14ART` |
| Sigma 35mm f/1.4 DG DN Art | 35mm | f/1.4 | L / E | Full Frame | 🟡 Good | `SIGMA_35_14ART` |
| Sigma 50mm f/1.4 DG DN Art | 50mm | f/1.4 | L / E | Full Frame | 🟡 Good | `SIGMA_50_14ART` |
| Sigma 105mm f/1.4 DG HSM Art | 105mm | f/1.4 | EF / L / E | Full Frame | 🟡 Good | `SIGMA_105_14ART` |
| Sigma 135mm f/1.8 DG HSM Art | 135mm | f/1.8 | EF / L / E | Full Frame | 🟢 Full | `SIGMA_135_18ART` |
| Rokinon/Samyang 14mm f/2.8 | 14mm | f/2.8 | EF / F / E | Full Frame | 🟡 Good | `ROKI_14_28` |
| Rokinon/Samyang 24mm f/1.4 | 24mm | f/1.4 | EF / F / E | Full Frame | 🟡 Good | `ROKI_24_14` |
| Rokinon/Samyang 135mm f/2.0 | 135mm | f/2.0 | EF / F / E | Full Frame | 🟢 Full | `ROKI_135_20` |
| Canon RF 15-35mm f/2.8L IS | 15-35mm | f/2.8 | RF | Full Frame | 🟡 Good | `CANON_RF1535_28L` |
| Canon RF 28-70mm f/2L | 28-70mm | f/2.0 | RF | Full Frame | 🟡 Good | `CANON_RF2870_20L` |
| Canon EF 200mm f/2.8L II | 200mm | f/2.8 | EF | Full Frame | 🟢 Full | `CANON_EF200_28L` |
| Canon EF 85mm f/1.4L IS | 85mm | f/1.4 | EF | Full Frame | 🟡 Good | `CANON_EF85_14L` |
| Nikon Z 14-24mm f/2.8 S | 14-24mm | f/2.8 | Z | Full Frame | 🟡 Good | `NIKON_Z1424_28S` |
| Nikon Z 50mm f/1.2 S | 50mm | f/1.2 | Z | Full Frame | 🟡 Good | `NIKON_Z50_12S` |
| Sony FE 14mm f/1.8 GM | 14mm | f/1.8 | E | Full Frame | 🟢 Full | `SONY_FE14_18GM` |
| Sony FE 20mm f/1.8 G | 20mm | f/1.8 | E | Full Frame | 🟡 Good | `SONY_FE20_18G` |
| Sony FE 24mm f/1.4 GM | 24mm | f/1.4 | E | Full Frame | 🟡 Good | `SONY_FE24_14GM` |
| Sony FE 35mm f/1.4 GM | 35mm | f/1.4 | E | Full Frame | 🟡 Good | `SONY_FE35_14GM` |
| Sony FE 135mm f/1.8 GM | 135mm | f/1.8 | E | Full Frame | 🟡 Good | `SONY_FE135_18GM` |
| Irix 15mm f/2.4 Blackstone | 15mm | f/2.4 | EF / F | Full Frame | 🟡 Good | `IRIX_15_24` |
| Tokina 11-16mm f/2.8 AT-X | 11-16mm | f/2.8 | EF / F | APS-C | 🟠 Basic | `TOKINA_1116_28` |
| Tokina Opera 16-28mm f/2.8 | 16-28mm | f/2.8 | EF / F | Full Frame | 🟠 Basic | `TOKINA_1628_28` |
| Viltrox 13mm f/1.4 | 13mm | f/1.4 | E / X / Z | APS-C | 🟠 Basic | `VILTROX_13_14` |

---

## Coma Correctors & Flatteners

| Model | Compatible With | Back Focus | Correction | Tier | profileId |
|:------|:----------------|:-----------|:-----------|:-----|:----------|
| TeleVue Paracorr Type II | f/3–f/6 Newtonians | 55mm | Coma | 🟢 Full | `TV_PARACORR2` |
| Baader MPCC Mark III | f/4–f/6 Newtonians | 55mm | Coma | 🟢 Full | `BAADER_MPCC3` |
| Starizona Nexus 0.75× | f/10 SCTs | 105mm | Field flattener + reducer | 🟡 Good | `SZONA_NEXUS75` |
| Starizona HyperStar | Celestron SCTs | — | f/2 conversion | 🟡 Good | `SZONA_HYPERSTAR` |
| ASA 0.73× Reducer | Ritchey-Chrétien | Variable | Reducer + Flattener | 🟠 Basic | `ASA_073X` |

> [!TIP]
> Coma correctors are critical for Newtonian reflectors used in astrophotography. Without one, stars in the corners of the frame appear as comet-shaped smears ("coma"), which degrades both plate solving accuracy and photometric measurements. The SkyCruncher's `flattener.ts` can model residual coma even with a corrector installed.

---

## How We Profile a Lens

Each `profileId` maps to a **Lens Profile** in `lens_profiles.ts` containing:

1. **Vignette Coefficients** — Radial falloff model: `I(r) = 1 - k₁r² - k₂r⁴` per focal length step
2. **Distortion Coefficients** — Brown-Conrady model: `k1, k2, p1, p2` (barrel/pincushion + tangential)
3. **Focal Length Range** — For zoom lenses, profiles are interpolated between measured focal lengths
4. **Designed Image Circle** — Determines whether APS-C or full-frame vignetting model applies
5. **Chromatic Aberration** — Lateral CA shift per channel (R, G, B) at field edges

### Contributing a New Lens Profile

1. **Shoot flat frames** at multiple focal lengths (zooms) or at prime focal length → generates vignetting map
2. **Shoot a dense star field** near the celestial equator → plate solve extracts distortion coefficients
3. **Shoot a bright star at field edges** → measures lateral chromatic aberration shift

