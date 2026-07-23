/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STORAGE PATHS — per-machine storage config resolver (Node / tools side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for WHERE the app's data lives on THIS machine, for
 * every Node-side consumer (tools/setup/fetch_index.mjs, the future Alpaca
 * intake watcher, any lane that needs the index / intake / capture / atlas /
 * export root). The browser/app side has a byte-for-byte MIRROR of the default
 * rules in `src/config/storagePaths.ts` (two runtimes — Node-tools vs the
 * Tauri webview — cannot share one import cleanly; the schema below is the
 * contract both obey; keep the two in lock-step). The greenfield Rust solver
 * has a THIRD reader of the same `storage.json` (`index_root` only) in
 * `src-tauri/src/greenfield_solve.rs::index_root_from_storage_config`.
 *
 * CONFIG FILE (per-machine, NOT in git):
 *   %LOCALAPPDATA%\io.skycruncher.app\storage.json
 *   {
 *     "version": 1,
 *     "data_root":    "...\\io.skycruncher.app\\data",
 *     "intake_root":  "<data_root>\\intake",     // raw frame deliveries (Alpaca watcher out)
 *     "capture_root": "<data_root>\\capture",    // live capture session output
 *     "index_root":   "<data_root>\\index",      // g15u quad index (manifest.json + stars.arrow + band_*.arrow)
 *     "atlas_root":   "<data_root>\\atlas",       // legacy hybrid catalog for HEADLESS tools (see note)
 *     "export_root":  "<data_root>\\exports"      // save/export default dir
 *   }
 *
 * RESOLUTION ORDER (resolveStoragePaths):
 *   1. storage.json present  → its values (missing keys filled from data_root). source='config'
 *   2. legacy desktop        → D:\AstroLogic layout, when D:\AstroLogic looks like the dev root
 *                              AND no storage.json. source='legacy-desktop' (desktop stays UNCHANGED —
 *                              never written to disk, so the desktop never grows a storage.json).
 *   3. fresh machine         → %LOCALAPPDATA%\io.skycruncher.app\data defaults. source='localappdata-default'
 *
 * ATLAS NOTE (LAW 3, honest scope): the LEGACY IN-APP browser catalog
 * (`public/atlas`, read by star_catalog_adapter.ts via fetch('/atlas/...'))
 * is EMBEDDED in the installer's app.exe at build time and has NO external-path
 * fallback — `atlas_root` does NOT relocate the in-app browser lane. It is the
 * location HEADLESS tools (which accept an injected atlas loader) read from, and
 * the provisioning target if/when the atlas is published for external fetch.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const APP_IDENTIFIER = 'io.skycruncher.app';
export const STORAGE_CONFIG_VERSION = 1;

/** Legacy desktop root (owner storage law: canonical image/data root on the box). */
export const LEGACY_DESKTOP_ROOT = 'D:\\AstroLogic';
/** The actual g15u index location on the desktop today (the greenfield reference index). */
export const LEGACY_INDEX_DIR =
    'D:\\AstroLogic\\test_artifacts\\mag15_build_2026-07-19\\starplates-2026.07-quadidx-g15u';

/** Ordered sub-root keys (all default under data_root). */
export const SUB_ROOT_KEYS = /** @type {const} */ ([
    'intake_root',
    'capture_root',
    'index_root',
    'atlas_root',
    'export_root',
]);

/** `%LOCALAPPDATA%\io.skycruncher.app` (falls back sensibly off-Windows for tests). */
export function appLocalDataDir(env = process.env) {
    const base =
        env.LOCALAPPDATA ||
        (env.APPDATA ? join(env.APPDATA, '..', 'Local') : null) ||
        join(homedir(), 'AppData', 'Local');
    return join(base, APP_IDENTIFIER);
}

/** Per-machine config path: `<appLocalDataDir>/storage.json`. */
export function storageConfigPath(env = process.env) {
    return join(appLocalDataDir(env), 'storage.json');
}

/** Fresh-machine default data root: `<appLocalDataDir>/data`. */
export function defaultDataRoot(env = process.env) {
    return join(appLocalDataDir(env), 'data');
}

/** The five sub-roots derived from a data root. */
export function subRootDefaults(dataRoot) {
    return {
        intake_root: join(dataRoot, 'intake'),
        capture_root: join(dataRoot, 'capture'),
        index_root: join(dataRoot, 'index'),
        atlas_root: join(dataRoot, 'atlas'),
        export_root: join(dataRoot, 'exports'),
    };
}

/** Legacy desktop layout (index_root points at the real g15u dir on the box). */
export function legacyDesktopPaths() {
    return {
        data_root: LEGACY_DESKTOP_ROOT,
        intake_root: join(LEGACY_DESKTOP_ROOT, 'intake'),
        capture_root: join(LEGACY_DESKTOP_ROOT, 'capture'),
        index_root: LEGACY_INDEX_DIR,
        atlas_root: join(LEGACY_DESKTOP_ROOT, 'atlas'),
        export_root: join(LEGACY_DESKTOP_ROOT, 'exports'),
    };
}

/**
 * Is this box the legacy desktop? D:\AstroLogic exists AND carries a tell-tale
 * dev subdir (SampleFiles or test_artifacts) — so a laptop that merely has a
 * D: drive with an unrelated \AstroLogic folder is NOT misdetected.
 */
export function isLegacyDesktop(exists = existsSync) {
    return (
        exists(LEGACY_DESKTOP_ROOT) &&
        (exists(join(LEGACY_DESKTOP_ROOT, 'SampleFiles')) ||
            exists(join(LEGACY_DESKTOP_ROOT, 'test_artifacts')))
    );
}

/** Fill any missing sub-root from data_root; always returns all five keys. */
function withDefaults(dataRoot, partial = {}) {
    const defs = subRootDefaults(dataRoot);
    const out = { data_root: dataRoot };
    for (const k of SUB_ROOT_KEYS) out[k] = partial[k] || defs[k];
    return out;
}

/**
 * Resolve the storage paths for this machine.
 * Injectables (for tests): `env`, `exists`, `readConfig` (returns parsed config
 * object or null, bypassing the filesystem read).
 * @returns {{source:string, config_path:string, data_root:string,
 *   intake_root:string, capture_root:string, index_root:string,
 *   atlas_root:string, export_root:string}}
 */
export function resolveStoragePaths({ env = process.env, exists = existsSync, readConfig } = {}) {
    const config_path = storageConfigPath(env);

    let cfg = null;
    if (typeof readConfig === 'function') {
        cfg = readConfig();
    } else if (exists(config_path)) {
        try {
            cfg = JSON.parse(readFileSync(config_path, 'utf8'));
        } catch {
            cfg = null; // corrupt config → fall through honestly (never crash a tool)
        }
    }

    if (cfg && typeof cfg === 'object') {
        const dataRoot = cfg.data_root || defaultDataRoot(env);
        return { source: 'config', config_path, ...withDefaults(dataRoot, cfg) };
    }

    if (isLegacyDesktop(exists)) {
        return { source: 'legacy-desktop', config_path, ...legacyDesktopPaths() };
    }

    const dataRoot = defaultDataRoot(env);
    return { source: 'localappdata-default', config_path, ...withDefaults(dataRoot) };
}

/** Canonical storage.json object from a resolved-paths shape. */
export function buildStorageConfig(paths) {
    return {
        version: STORAGE_CONFIG_VERSION,
        data_root: paths.data_root,
        intake_root: paths.intake_root,
        capture_root: paths.capture_root,
        index_root: paths.index_root,
        atlas_root: paths.atlas_root,
        export_root: paths.export_root,
    };
}

/** Write storage.json (EXPLICIT — resolution never writes; keeps the desktop clean). */
export function writeStorageConfig(paths, { env = process.env } = {}) {
    const config_path = storageConfigPath(env);
    mkdirSync(dirname(config_path), { recursive: true });
    writeFileSync(config_path, JSON.stringify(buildStorageConfig(paths), null, 2) + '\n', 'utf8');
    return config_path;
}

/**
 * Materialize storage.json with fresh-machine defaults IF absent — but NEVER on
 * the legacy desktop (there it stays absent so the desktop keeps its current
 * behavior). Returns the resolved paths plus `created:boolean`.
 * Used by the provisioner / settings UI so the Rust solver and the tools agree
 * on `index_root` on a fresh machine.
 */
export function ensureStorageConfig({ env = process.env, exists = existsSync } = {}) {
    const resolved = resolveStoragePaths({ env, exists });
    if (resolved.source === 'config' || resolved.source === 'legacy-desktop') {
        return { created: false, ...resolved };
    }
    writeStorageConfig(resolved, { env });
    return { created: true, ...resolveStoragePaths({ env, exists }) };
}
