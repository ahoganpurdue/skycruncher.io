/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAR-DATA SOURCE — the public R2 base URL + release prefixes (Node-tools side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SINGLE config point for the R2 star-data endpoint. Both the Node fetcher
 * (`tools/setup/fetch_index.mjs`) AND the app import their base URL/prefix from
 * here rather than hardcoding the literal in a code path (brand-neutral-endpoints
 * law — CLAUDE.md LAW 6). The Tauri webview cannot import a Node `.mjs` cleanly,
 * so `src/config/starDataSource.ts` is the app-side MIRROR of these values, kept
 * in lock-step (same discipline as tools/config/storage_paths.mjs <->
 * src/config/storagePaths.ts). The desktop Rust download command never hardcodes
 * either — the UI reads these constants and passes them across the IPC boundary.
 *
 * Contract: docs/R2_STARDATA_LAYOUT.md (verified live 2026-07-21).
 */

/** Public R2 bucket base URL (bucket `starplates`; immutable, long-cache objects). */
export const STAR_DATA_BASE_URL = 'https://pub-19850926b2c64818900201eb0c1c98b7.r2.dev';

/** Greenfield g15u quad-index release prefix (band files + stars.arrow + manifest). */
export const QUAD_INDEX_PREFIX = 'starplates-2026.07-quadidx-g15u';

/** Legacy hybrid deep-catalog atlas release prefix (headless-tools lane). */
export const ATLAS_PREFIX = 'atlas-2026.07-gaiapure-legacydepth'; // Gaia-pure since 2026-07-22 (rows 531-549; HYG dead) — owner-uploaded 36 sectors + manifest, 340MB; fetcher appends /sectors per objKey;
