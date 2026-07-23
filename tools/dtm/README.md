<!-- REFERENCE · tools/dtm — DTM/DEM terrain tiles: fetch, sample, predict horizons -->
# tools/dtm — Digital Terrain Model (elevation) infrastructure

Fetch elevation tiles from the web, cache them, sample elevation anywhere, and
predict the **terrain horizon** for an observer. Headless `tools/` lane (Incubator
pattern, LAW-4): zero `src/` coupling, offline-first, honest-or-absent.

Three files, one direction of dependency (`horizon → sampler → fetcher`):

| File | Role |
|---|---|
| `fetch_dtm.mjs` | download + verify + cache tiles, write provenance sidecars |
| `dtm_sampler.mjs` | `elevationAt(lat,lon)` (bilinear) · `profileAlong(...)` (great-circle ray) |
| `horizon_predict.mjs` | per-azimuth terrain horizon (curvature+refraction) → JSON + SVG |

## Source, URL scheme (verified), license

**Primary: AWS Open Data Terrain Tiles — "skadi" format.** Verified empirically
against the live bucket 2026-07-09 (HEAD + full-tile decode) before this lane was
built around it:

```
https://s3.amazonaws.com/elevation-tiles-prod/skadi/{N|S}{lat}/{N|S}{lat}{E|W}{lon}.hgt.gz
  e.g.  https://s3.amazonaws.com/elevation-tiles-prod/skadi/N34/N34W119.hgt.gz
```

- 1°×1° tiles, **gzipped raw big-endian int16, row-major**. No auth.
- SRTM1-style **3601×3601** samples (1 arcsec). `N34W119.hgt.gz` = 11.73 MB gz →
  **25,934,402 bytes raw == 3601²×2 exactly** (confirmed). Void sentinel `-32768`.
- Tile **name = the SW (floored) corner**; data starts at the **NW corner**
  (row 0 = north edge, col 0 = west edge). Adjacent tiles duplicate their shared
  edge row/col.
- **Bathymetry:** Terrain Tiles merges GEBCO/ETOPO ocean depth with SRTM land, so
  coastal/ocean tiles legitimately reach deep negatives (LA basins ≈ −1900 m). The
  integrity guard is "gunzips to a perfect-square int16 grid + Mariana–Everest
  range", *not* a land-only floor.
- Bucket layout documented in the mapzen/tilezen **`joerd`** repo. The sampler is
  DIM-agnostic (`DIM = √(bytes/2)`), so SRTM3 **1201²** tiles also work if a source
  serves them.

**License / attribution:** underlying elevation is public domain (NASA/USGS SRTM &
contributors), redistributed as AWS Terrain Tiles (Mapzen/Tilezen). Recorded in
every sidecar. Attribute as: *"Elevation: USGS/NASA SRTM via AWS Terrain Tiles."*

**Fallback (not implemented):** Copernicus GLO-30 AWS bucket (GeoTIFF — heavier
decode). Only needed if the skadi scheme ever changes. If the network is blocked,
the whole lane runs against a synthetic procedural tile of the same binary format
(see the `.test.mjs` fixtures) — the fetch is enrichment, never a hard dependency.

## Cache policy

- Tiles + sidecars cache to **`test_results/dtm/tiles/`** (gitignored, local-only),
  keyed `N34W119.hgt` + `N34W119.hgt.provenance.json`.
- **Idempotent / offline-first:** a cached tile that passes verification is never
  re-fetched (`--force` overrides). Every downstream consumer reads the cache; a
  missing tile yields `null` samples (honest-absent), never zero terrain.
- Footprint ≈ **25.9 MB per 1° tile** (decompressed). A 100 km disk ≈ 9 tiles
  ≈ 234 MB. The Pasadena 100 km set used for validation = 9 tiles.
- Sidecar fields: source URL, dataset+version, `sha256` (gz **and** raw), byte
  lengths, format spec, elevation range + void count, fetch time, agent identity,
  license. Fetches carry a named, contactable `User-Agent` (mirrors
  `tools/overnight/fetch_intake.mjs` discipline — no anonymous scraping).

## Usage

```bash
# fetch every 1° tile covering a (lat,lon,radius_km) disk
node tools/dtm/fetch_dtm.mjs --lat 34.15 --lon -118.14 --radius 100
node tools/dtm/fetch_dtm.mjs --tile N34W119            # one explicit tile
node tools/dtm/fetch_dtm.mjs --lat 34.15 --lon -118.14 --radius 25 --dry-run

# predict the terrain horizon (auto-fetch tiles first with --fetch)
node tools/dtm/horizon_predict.mjs --lat 34.15 --lon -118.14 --height 2 \
     --maxkm 100 --azstep 0.5 --step 0.03 --fetch
# → test_results/dtm/horizon_profile.json  +  horizon_profile.svg  + top-5 ridges
```

Programmatic:

```js
import { ensureTiles } from './tools/dtm/fetch_dtm.mjs';
import { elevationAt, profileAlong } from './tools/dtm/dtm_sampler.mjs';
import { predictHorizon } from './tools/dtm/horizon_predict.mjs';

await ensureTiles(34.15, -118.14, 100);          // cache the disk
elevationAt(34.2257, -118.0577);                  // → ~1727 m (null if void/absent)
predictHorizon({ lat: 34.15, lon: -118.14 });     // → {observer, params, horizon[]}
```

## Validation (Pasadena landmark set, 34.15, −118.14 — a fixed DTM validation site, not an app default)

- **Landmarks** (±30 m SRTM1 tolerance; sharp summits compared on a local-peak
  basis since a point sample can sit off the true summit post):

  | landmark | measured | published | Δ |
  |---|---|---|---|
  | Downtown Pasadena (point) | 263.1 m | 263 m | **+0.1 m** |
  | Mt Wilson summit (local peak) | 1739.1 m | 1740 m | **−0.9 m** |
  | Mt San Antonio "Baldy" summit (local peak) | 3067.0 m | 3068 m | **−1.0 m** |

- **Horizon sanity:** the San Gabriels dominate the north — top ridges cluster at
  **az ≈ 18.5–20.5° (NNE), alt ≈ 8.3–8.5°, ~9.6 km, ~1700 m**; N-half max alt 8.48°
  vs S-half max 0.30° (S-sector mean −0.41°: the LA basin/ocean descends below the
  observer's horizontal — correct for a 264 m eye). Deterministic (sha256-identical
  reruns).

## The three consumers (why this exists)

1. **Sextant rung-1 (up-reference).** `horizon_predict` emits the predicted terrain
   horizon; the plate-solved frame's **measured** horizon (`m4_signal_detect/
   horizon_envelope.ts` → `computeHorizonEnvelope`) is matched against it to
   recover/validate observer azimuth & location (celestial-nav skyline fix). DTM is
   the strongest up-reference tier (terrain skyline) per the sextant design.
2. **Atmosphere core.** `elevationAt(observer)` → station pressure → Rayleigh
   optical depth / refraction. Feeds the airmass + extinction physics (SPCC / CCD
   SNR), replacing any assumed sea-level pressure with the observer's real altitude.
3. **Peak labels on photos.** With a solved WCS + the observer fix, ridge points in
   the horizon profile (`ridge_lat/lon/elev`) project onto the frame to label
   skyline peaks. A named-peak database (**GeoNames** `mountain`/`peak` features) is
   the documented FUTURE input for the names themselves — not yet wired.

## Input contract — sextant coarse-fix → tile selection

The sextant supplies a **coarse observer fix** (from a rough goto / capture header /
prior); this lane turns it into cached tiles + a predicted horizon:

```
coarse (lat, lon [, radius_km≈100])
  → tilesForRadius(lat, lon, radius_km)   # 1° tiles covering the disk
  → ensureTiles(...)                      # fetch/verify/cache (idempotent)
  → predictHorizon({lat, lon, heightAgl}) # {az, alt_deg, distance_km_of_ridge}[]
  → match vs measured horizon_envelope → refined (az0, lat, lon)
```

`radius_km` should exceed the farthest ridge the frame can see (~100 km covers the
San Gabriels + beyond for a basin observer). `heightAgl` defaults to 2 m (eye
height); refraction `k` defaults to 0.13 (INITIAL ENGINEERING VALUE — a knob, not a
measurement; real low-level refraction varies with the temperature gradient).

## Honest gaps / not-yet

- Refraction `k` is a nominal constant, not fitted to the frame's conditions.
- No named-peak DB (GeoNames) wired — ridge geometry only, no labels.
- Single-source (AWS skadi); GLO-30 GeoTIFF fallback unimplemented.
- Bilinear voids are conservative (any of 4 posts void → null); no void infill.
- Not wired into `src/` — this is the incubator lane; port behind a module seam
  once the sextant consumes it.
