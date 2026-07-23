# Atlas tooling — READ BEFORE TOUCHING `public/atlas/`

## The one thing you must know

The **live** deep-catalog layout is `public/atlas/sectors/level_3_sector_0..35.json`
(~338 MB, **gitignored — the on-disk copy is the only copy**). Its bucketing scheme
must match `star_catalog_adapter.getSectorId()` exactly:

```
raIndex  = floor(ra_hours / 4)          // 0..5  (ra stored in DEGREES in the JSON; adapter converts)
decIndex = floor((dec + 90) / 30)       // 0..5
id       = decIndex * 6 + raIndex       // 0..35
```

Star record format (Gaia-derived): `{ id: 0, ra (DEGREES), dec, mag_g, bp_rp, pm_ra, pm_dec, source_id }`.
Note `id` is always 0 and `ra` is degrees — the ingest layer (`star_catalog_adapter.ingestStars`)
handles both quirks; do not "fix" the data to match older assumptions.

## History (why this exists)

2026-07-04: the numeric sector files on disk mixed **three inconsistent generations**
of bucketing schemes (M66's stars lived in files 18/19/23 while the adapter fetched 20
— silently wrong region for every hinted solve). `rebucket_sectors.mjs` re-bucketed all
2.68 M stars into the adapter's exact scheme. A separate one-off pass merged ~107 k
**mag > 6.8** stars from the named HYG sector files, appended after the Gaia block per
sector. NOTE (corrected 2026-07-11): that HYG faint end reaches **mag ≈ 21** (measured
global max), NOT the "6.7→10.0 / 6.8–10" range this file used to claim — the merge fills
the whole mag>6.8 tail. That one-off is now committed as **`merge_hyg_sectors.mjs`** and
the entire chain is byte-proved by **`verify_atlas_repro.mjs`** (38/38 exact vs the live
data). Originals were parked in `public/atlas/sectors/_legacy_mismatched/`.

## Scripts

- `rebucket_sectors.mjs` — reads `level_3_sector_*.json` from the sectors dir and
  writes a `_rebuilt/` subdir with the correct 6×6 bucketing. Deduplicates by
  `source_id`, drops non-finite rows. To use: run, spot-check counts, then swap
  `_rebuilt/` contents into place.

## ⚠️ `../generate_star_atlas.ts` is STALE

The generator's Level-3 bucketing was fixed 2026-07-11 (line-90 `/15` degrees→hours;
`ATLAS_LEGACY_BUCKETING=1` restores the pre-fix shard for byte-repro). It still does NOT
run the HYG gap-fill itself, and shipping its shards WITHOUT rebucket is still unsafe.
Full regenerate: run the generator, then `rebucket_sectors.mjs`, then
**`merge_hyg_sectors.mjs`** (HYG mag > 6.8, faint end ≈ 21), then confirm with
**`verify_atlas_repro.mjs`** (byte-exact vs the live artifact) and in-frame coverage for a
known target (M66 region ≈ 251 stars, mag 4.9–12.5 continuous). ⚠️ A regen with the FIXED
default bucketing is content-identical but byte-DIFFERENT from the frozen artifact (order
is shard-load-bearing — see `verify_atlas_repro.mjs`) → needs an owner rebaseline.

## Before deleting anything under `public/atlas/sectors/`

Back up the live 36 numeric files first (they are gitignored and irreplaceable without
re-running the full Gaia pipeline). `_legacy_mismatched/` (~319 MB) is the pre-rebucket
originals — archive before removal.
