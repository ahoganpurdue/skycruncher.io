/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAR-DATA SOURCE — the public R2 base URL + release prefix (app / webview side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MIRROR of `tools/config/star_data_source.mjs` (Node-tools side). The Tauri
 * webview cannot import a Node `.mjs` cleanly, so these values are duplicated
 * deliberately and kept in lock-step — the same discipline as
 * `src/config/storagePaths.ts` <-> `tools/config/storage_paths.mjs`.
 *
 * This is the SINGLE app-side config point for the R2 star-data endpoint. The
 * in-app star-data download (StorageSettingsModal → StarDataSection) reads these
 * constants and passes them across the Tauri IPC boundary to the desktop Rust
 * download command (`star_data_download`), which therefore never hardcodes the
 * endpoint itself (brand-neutral-endpoints law — CLAUDE.md LAW 6).
 *
 * Contract: docs/R2_STARDATA_LAYOUT.md (verified live 2026-07-21).
 */

/** Public R2 bucket base URL (bucket `starplates`; immutable, long-cache objects). */
export const STAR_DATA_BASE_URL = 'https://pub-19850926b2c64818900201eb0c1c98b7.r2.dev';

/** Greenfield g15u quad-index release prefix (band files + stars.arrow + manifest). */
export const QUAD_INDEX_PREFIX = 'starplates-2026.07-quadidx-g15u';

/**
 * Star-atlas release prefix (confirm/display catalog — the sectors the browser/
 * legacy lane reads). Mirror of `ATLAS_PREFIX` in `tools/config/star_data_source.mjs`
 * (Gaia-pure since 2026-07-22; owner-uploaded 36 sectors + manifest, ~340 MB). The
 * R2 layout is `<prefix>/manifest.json` + `<prefix>/sectors/level_3_sector_*.json`
 * (docs/R2_STARDATA_LAYOUT.md §2).
 *
 * The desktop download command (`star_data_download`, src-tauri/src/star_data_fetch.rs)
 * provisions this release into `atlas_root` via `kind: "atlas"` (atlas-aggregate/1
 * manifest parse + dest-kind routing, owner LAW-5 sign-off 2026-07-22). The
 * StarDataSection atlas row passes this prefix across the IPC boundary.
 */
export const ATLAS_PREFIX = 'atlas-2026.07-gaiapure-legacydepth';
