# Supported Mounts

**48 mounts from 8 manufacturers.** Mounts are organized by type (equatorial, alt-az, star trackers) and sorted by payload capacity. The SkyCruncher Support Tier indicates the level of tracking characterization available for exposure time estimation and field rotation compensation.

## Support Tiers

| Tier | Icon | Meaning | What You Get |
|:-----|:-----|:--------|:-------------|
| Full | 🟢 | Characterized PE curve + autoguide data | Optimal exposure calculation, field rotation model, PE-aware stacking |
| Good | 🟡 | Generic PE model for mount class | Reasonable exposure limits, tracking mode detection |
| Basic | 🟠 | Mount type only (EQ / Alt-Az / Tripod) | Basic field rotation correction. No PE data. |
| None | ⚪ | Fixed tripod / unknown | Treated as untracked. Max exposure from "500 Rule." |

---

## German Equatorial Mounts (GEM)

| Model | Payload (kg) | PE (arcsec, ±) | GoTo | Encoder | Tier | mountId |
|:------|:-------------|:----------------|:-----|:--------|:-----|:--------|
| Astro-Physics Mach2GTO | 29 | ±3.5 | ✅ | Absolute | 🟢 Full | `AP_MACH2GTO` |
| Astro-Physics 1100GTO | 50 | ±3.5 | ✅ | Absolute | 🟢 Full | `AP_1100GTO` |
| Software Bisque Paramount MX+ | 45 | ±2.5 | ✅ | Absolute | 🟢 Full | `BISQUE_PMX+` |
| Software Bisque Paramount MyT | 22 | ±3.0 | ✅ | Absolute | 🟢 Full | `BISQUE_PMYT` |
| iOptron CEM70G | 31 | ±3.5 | ✅ | Absolute | 🟢 Full | `IOPT_CEM70G` |
| iOptron CEM40G | 18 | ±4.0 | ✅ | Absolute | 🟢 Full | `IOPT_CEM40G` |
| iOptron CEM26 | 12 | ±5.0 | ✅ | Absolute | 🟡 Good | `IOPT_CEM26` |
| iOptron GEM45G | 20 | ±3.5 | ✅ | Absolute | 🟡 Good | `IOPT_GEM45G` |
| iOptron GEM28G | 12.7 | ±5.0 | ✅ | Absolute | 🟡 Good | `IOPT_GEM28G` |
| Sky-Watcher EQ6-R Pro | 20 | ±6 | ✅ | — | 🟢 Full | `SW_EQ6R` |
| Sky-Watcher EQ8-R Pro | 50 | ±4 | ✅ | — | 🟡 Good | `SW_EQ8R` |
| Sky-Watcher EQ5 Pro | 10 | ±10 | ✅ | — | 🟡 Good | `SW_EQ5PRO` |
| Sky-Watcher HEQ5 Pro | 13 | ±8 | ✅ | — | 🟢 Full | `SW_HEQ5` |
| Sky-Watcher AZ-EQ6 GT | 20 | ±6 | ✅ | — | 🟡 Good | `SW_AZEQ6` |
| Sky-Watcher Star Adventurer GTi | 5 | ±12 | ✅ | — | 🟡 Good | `SW_SAGTI` |
| Losmandy GM811G | 27 | ±5 | ✅ | — | 🟡 Good | `LOS_GM811G` |
| Losmandy G11 | 27 | ±6 | ✅ | — | 🟡 Good | `LOS_G11` |
| Celestron CGX | 25 | ±6 | ✅ | — | 🟡 Good | `CEL_CGX` |
| Celestron CGX-L | 34 | ±5 | ✅ | — | 🟡 Good | `CEL_CGXL` |
| Celestron AVX | 13.6 | ±12 | ✅ | — | 🟡 Good | `CEL_AVX` |
| Celestron advanced VX | 13.6 | ±14 | ✅ | — | 🟠 Basic | `CEL_AVX_OLD` |
| Orion Atlas Pro | 18 | ±8 | ✅ | — | 🟡 Good | `ORION_ATLAS` |
| Meade LX85 | 15 | ±10 | ✅ | — | 🟠 Basic | `MEADE_LX85` |
| ZWO AM5 | 13 | ±4 | ✅ | Absolute | 🟢 Full | `ZWO_AM5` |
| ZWO AM3 | 8 | ±5 | ✅ | Absolute | 🟡 Good | `ZWO_AM3` |
| Rainbow Astro RST-135E | 13 | ±4 | ✅ | Absolute | 🟡 Good | `RAIN_RST135` |
| Rainbow Astro RST-300 | 27 | ±3 | ✅ | Absolute | 🟡 Good | `RAIN_RST300` |

---

## Alt-Azimuth Mounts

| Model | Payload (kg) | GoTo | Field Rotation | Tier | mountId |
|:------|:-------------|:-----|:---------------|:-----|:--------|
| Celestron NexStar Evolution 8 | 6 (OTA) | ✅ | ⚠️ Yes (no derotator) | 🟡 Good | `CEL_NEXEVO8` |
| Sky-Watcher AZ-GTi | 5 | ✅ | ⚠️ Yes | 🟡 Good | `SW_AZGTI` |
| Sky-Watcher Virtuoso GTi 150P | 5 | ✅ | ⚠️ Yes | 🟠 Basic | `SW_VIRT150` |
| Unistellar eVscope 2 | — (integrated) | ✅ | Software-corrected | 🟠 Basic | `UNI_EVSCOPE2` |
| Vaonis Stellina | — (integrated) | ✅ | Software-corrected | 🟠 Basic | `VAONIS_STELL` |

> [!WARNING]
> Alt-azimuth mounts introduce **field rotation** during long exposures. Stars at the edges of the frame trace arcs instead of points. The SkyCruncher compensates for this with `computeFieldRotation()` in `zenith.ts`, but exposures are limited to ~30 seconds at typical focal lengths before derotation artifacts appear. For longer exposures, use an equatorial mount or a wedge adapter.

---

## Star Trackers & Portable Mounts

| Model | Payload (kg) | Max Exposure | Battery | Tier | mountId |
|:------|:-------------|:-------------|:--------|:-----|:--------|
| Sky-Watcher Star Adventurer 2i Pro | 5 | ~2 min (200mm) | AA / USB | 🟡 Good | `SW_SA2I` |
| Sky-Watcher Star Adventurer GTi | 5 | ~3 min (200mm) | USB-C | 🟡 Good | `SW_SAGTI` |
| iOptron SkyGuider Pro | 4.5 | ~3 min (200mm) | USB | 🟡 Good | `IOPT_SKYGPRO` |
| iOptron SkyTracker Pro | 3 | ~1 min (200mm) | AA | 🟠 Basic | `IOPT_SKYTPRO` |
| Move Shoot Move Rotator | 3 | ~2 min (200mm) | USB-C | 🟠 Basic | `MSM_ROTATOR` |
| Benro Polaris | 3.5 | ~3 min (200mm) | Built-in | 🟠 Basic | `BENRO_POLARIS` |
| Vixen Polarie Star Tracker | 3.5 | ~2 min (200mm) | AA | 🟠 Basic | `VIXEN_POLARIE` |
| Omegon Mini Track LX3 | 2 | ~1 min (135mm) | Clockwork | 🟠 Basic | `OMEGA_LX3` |

---

## Fixed Tripod (Untracked)

| Mode | Max Exposure Formula | Use Case | Tier | mountId |
|:-----|:---------------------|:---------|:-----|:--------|
| Fixed tripod | `500 / (focal_length × crop_factor)` seconds | Meteor watch, constellation shots, satellite trails | ⚪ None | `FIXED_TRIPOD` |
| Fixed (NPF Rule) | `(35 × aperture + 30 × pixel_pitch) / focal_length` seconds | More accurate limit for modern sensors | ⚪ None | `FIXED_NPF` |

> [!NOTE]
> Even fixed-tripod images are valuable to the SKYCRUNCHER network! Short untracked exposures still plate-solve successfully and can detect bright transients (supernovae, nova, fireballs). The SkyCruncher automatically applies the NPF Rule to estimate the maximum "trail-free" exposure for your hardware configuration.

---

## Tracking Mode Detection

The SkyCruncher automatically detects the tracking mode from metadata and image analysis:

| Hint | Method | confidence |
|:-----|:-------|:-----------|
| EXIF `Lens` = "Sky-Watcher..." | Direct model match | High |
| Exposure > 30s + no star trails | Inferred tracked | Medium |
| Star FWHM elongation analysis | Trail detection algorithm | High |
| User-declared via upload form | Explicit `tracking_mount` field | Definitive |

### Why Tracking Matters

The `tracking_mount` field in `SoftMetadata` directly affects:

1. **Exposure Time Limits** — Determines maximum single-frame exposure before trailing
2. **Stacking Strategy** — Tracked frames align differently than dithered untracked frames
3. **Periodic Error Correction** — With Full-profiled mounts, PE can be subtracted from star centroids
4. **Field Rotation** — Alt-az and untracked frames must be derotated before stacking
5. **Station Tier** — Tracked mounts with autoguiding qualify for higher contribution tiers (Hunter/Sniper)

### Contributing Mount Data

1. **Record a PE curve** (10-minute unguided log at sidereal rate) → captures periodic error waveform
2. **Submit autoguide logs** (PHD2 or similar) → measures real-world RMS tracking accuracy
3. **Upload test frames** at rated payload → validates exposure limits under realistic conditions

