/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STORAGE PATHS — per-machine storage config resolver (app / Tauri-webview side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MIRROR of `tools/config/storage_paths.mjs` (Node-tools side). Two runtimes —
 * Node tools vs the Tauri webview — cannot share one import cleanly, so the
 * default rules are duplicated deliberately and kept in lock-step; the schema in
 * that file's header is the contract both obey. The greenfield Rust solver has a
 * THIRD reader of the same `storage.json` (`index_root` only), in
 * `src-tauri/src/greenfield_solve.rs::index_root_from_storage_config`.
 *
 * Config file (per-machine, NOT in git):
 *   %LOCALAPPDATA%\io.skycruncher.app\storage.json  (= appLocalDataDir()/storage.json)
 *
 * The pure helpers (subRootDefaults / withDefaults / buildStorageConfig /
 * resolvePathsFromConfig) are Tauri-free and unit-tested. The async wrappers
 * lazily import the Tauri plugins (so the browser bundle never eager-loads
 * them — same discipline as save_export.ts / solve_queue/connectors.ts).
 */

export const APP_IDENTIFIER = 'io.skycruncher.app';
export const STORAGE_CONFIG_VERSION = 1 as const;

export const SUB_ROOT_KEYS = [
    'intake_root',
    'capture_root',
    'index_root',
    'atlas_root',
    'export_root',
] as const;

export type SubRootKey = (typeof SUB_ROOT_KEYS)[number];

export interface StorageRoots {
    data_root: string;
    intake_root: string;
    capture_root: string;
    index_root: string;
    atlas_root: string;
    export_root: string;
}

export type StorageSource = 'config' | 'localappdata-default';

export interface ResolvedStoragePaths extends StorageRoots {
    source: StorageSource;
    config_path: string;
}

export interface StorageConfigFile extends StorageRoots {
    version: number;
}

/** Separator inferred from a base path (Windows app paths use backslash). */
function sepOf(p: string): string {
    return p.includes('\\') ? '\\' : '/';
}

/** Join path parts using the base's separator style. */
export function joinPath(base: string, ...parts: string[]): string {
    const sep = sepOf(base);
    const trimmed = base.replace(/[\\/]+$/, '');
    return [trimmed, ...parts].join(sep);
}

/** The five sub-roots derived from a data root (MIRROR of the .mjs). */
export function subRootDefaults(dataRoot: string): Omit<StorageRoots, 'data_root'> {
    return {
        intake_root: joinPath(dataRoot, 'intake'),
        capture_root: joinPath(dataRoot, 'capture'),
        index_root: joinPath(dataRoot, 'index'),
        atlas_root: joinPath(dataRoot, 'atlas'),
        export_root: joinPath(dataRoot, 'exports'),
    };
}

/** Fill any missing sub-root from data_root; always returns all six keys. */
export function withDefaults(dataRoot: string, partial: Partial<StorageRoots> = {}): StorageRoots {
    const defs = subRootDefaults(dataRoot);
    return {
        data_root: dataRoot,
        intake_root: partial.intake_root || defs.intake_root,
        capture_root: partial.capture_root || defs.capture_root,
        index_root: partial.index_root || defs.index_root,
        atlas_root: partial.atlas_root || defs.atlas_root,
        export_root: partial.export_root || defs.export_root,
    };
}

/** Fresh-machine default data root, given the Tauri app-local data dir. */
export function defaultDataRoot(appLocalData: string): string {
    return joinPath(appLocalData, 'data');
}

/** Resolve full roots from a (possibly partial/absent) parsed config object. */
export function resolvePathsFromConfig(
    cfg: Partial<StorageConfigFile> | null | undefined,
    appLocalData: string,
): { source: StorageSource; roots: StorageRoots } {
    if (cfg && typeof cfg === 'object') {
        const dataRoot = cfg.data_root || defaultDataRoot(appLocalData);
        return { source: 'config', roots: withDefaults(dataRoot, cfg) };
    }
    return { source: 'localappdata-default', roots: withDefaults(defaultDataRoot(appLocalData)) };
}

/** Canonical storage.json object from a roots shape. */
export function buildStorageConfig(roots: StorageRoots): StorageConfigFile {
    return {
        version: STORAGE_CONFIG_VERSION,
        data_root: roots.data_root,
        intake_root: roots.intake_root,
        capture_root: roots.capture_root,
        index_root: roots.index_root,
        atlas_root: roots.atlas_root,
        export_root: roots.export_root,
    };
}

// ─── Tauri runtime wrappers (lazy imports; browser-safe) ───────────────────────

/** True when running inside the Tauri desktop shell. */
export function isTauriRuntime(): boolean {
    try {
        return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    } catch {
        return false;
    }
}

async function appLocalDataDir(): Promise<string> {
    const path = await import('@tauri-apps/api/path');
    return path.appLocalDataDir();
}

function storageConfigPathFrom(appLocalData: string): string {
    return joinPath(appLocalData, 'storage.json');
}

/** Read + parse storage.json via the Tauri fs plugin (null if absent/corrupt). */
export async function readStorageConfig(appLocalData: string): Promise<StorageConfigFile | null> {
    try {
        const fs = await import('@tauri-apps/plugin-fs');
        const p = storageConfigPathFrom(appLocalData);
        if (!(await fs.exists(p))) return null;
        const text = await fs.readTextFile(p);
        return JSON.parse(text) as StorageConfigFile;
    } catch {
        return null; // honest fall-through — never crash the UI on a bad config
    }
}

/**
 * Resolve the storage paths for this machine (desktop app). Reads storage.json
 * if present, else fresh-machine LOCALAPPDATA defaults. (Legacy-desktop detection
 * lives on the Node-tools side, which is the surface that runs on the desktop
 * box; the packaged app resolves via storage.json / defaults.)
 */
export async function resolveStoragePaths(): Promise<ResolvedStoragePaths> {
    const appLocalData = await appLocalDataDir();
    const cfg = await readStorageConfig(appLocalData);
    const { source, roots } = resolvePathsFromConfig(cfg, appLocalData);
    return { source, config_path: storageConfigPathFrom(appLocalData), ...roots };
}

/** Persist storage.json via the Tauri fs plugin. Returns the written path. */
export async function writeStorageConfig(roots: StorageRoots): Promise<string> {
    const fs = await import('@tauri-apps/plugin-fs');
    const appLocalData = await appLocalDataDir();
    const p = storageConfigPathFrom(appLocalData);
    // Ensure the app-local data dir exists (mkdir -p), then write.
    try {
        await fs.mkdir(appLocalData, { recursive: true });
    } catch {
        /* dir already exists — fine */
    }
    await fs.writeTextFile(p, JSON.stringify(buildStorageConfig(roots), null, 2) + '\n');
    return p;
}
