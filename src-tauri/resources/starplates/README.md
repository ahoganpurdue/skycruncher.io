# Bundled starplates release (docs/STARPLATES_SPEC.md §8)

This directory ships inside the installer via `tauri.conf.json`
`"resources": ["resources/starplates/**"]` and seeds the local store
(`%LOCALAPPDATA%\io.skycruncher.app\starplates`, override
`SKYCRUNCHER_STARPLATES_DIR`) on first `starplates_init`.

Expected content — exactly ONE pinned release folder, produced by the forge:

```
resources/starplates/
  starplates-2026.07-gdr3/
    manifest.json          # §2.3 manifest (SHA-256 of this file becomes the pin)
    t0/allsky.arrow        # bright bootstrap tier (~6–9 MB). T1 cells are NOT bundled.
```

The bundle is read-only seed material. `starplates_init` copies the manifest
into `releases/<id>/`, ingests every bundled blob into `cas/` (SHA-verified
against the manifest), and writes `pinned.json` last. If this directory is
empty, `starplates_init` reports `E_STORE_MISSING` honestly. (The legacy
vanguard.bin path was RETIRED — owner ruling 2026-07-10, see docs/STARPLATES_SPEC.md
retirement notice — so the JSON/starplates path is the only one either way.)
