/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DESKTOP ATLAS LOCAL-DIR TIER — downloaded atlas ahead of embedded (fail-soft)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The desktop webview serves `/atlas/...` from the app's BUNDLED dist (Vite copies
 * `public/atlas` → `dist/atlas`, `frontendDist` in tauri.conf.json — the "embedded"
 * atlas). When the user has DOWNLOADED the atlas release into `atlas_root` (via the
 * StarDataSection atlas row → src-tauri/src/star_data_fetch.rs `kind:"atlas"`), those
 * files should take precedence. This tier resolves an atlasLoader path in order:
 *   DOWNLOADED (atlas_root, Tauri fs plugin) → EMBEDDED (fetch) → ABSENT.
 *
 * PROVABLY INERT off-desktop (byte-identity of both sacreds, by construction):
 *   • Node headless (api smoke) + browser (e2e): `isTauri()` is false, so this
 *     returns the plain `baseFetch(path)` UNCHANGED. No Tauri plugin is even
 *     imported (the check is synchronous and first).
 *   • Desktop with NO download: atlas_root has no matching file → fall through to
 *     `baseFetch(path)` (embedded) — byte-identical to the current desktop.
 * Only a desktop WITH a download changes behaviour (the intended new tier).
 *
 * CSP: the desktop CSP is `connect-src 'self' ipc:` (tauri.conf.json) — it does
 * NOT allow the `asset:` protocol for fetch, so the local read MUST go through the
 * Tauri fs plugin (`readFile`), never a synthesized asset URL. Same discipline as
 * g15u_catalog.ts::readArrowBytes.
 *
 * binarySourceEnabled interaction (StarCatalogAdapter tries `<sector>.arrow` before
 * `<sector>.json`): the atlas download is JSON-live only (arrow twins are dormant).
 * So when a download exists we must NOT let the EMBEDDED `.arrow` win over the
 * DOWNLOADED `.json`: for an `.arrow` request whose local `.arrow` is absent but
 * whose local `.json` twin IS present, this tier returns a synthetic 404 — the
 * adapter then falls to `.json`, which this tier serves from the download. When no
 * download exists (no local twin), the `.arrow` request falls through to embedded
 * exactly as before (byte-identical).
 *
 * LAW 3 / two-ledger: transport-only. No COORDINATE/PIXEL math; the bytes are
 * returned opaque. The confirm-lane atlas source itself is unchanged.
 */

/** A plain fetch-shaped loader (the embedded-asset default). */
export type FetchFn = (path: string) => Promise<Response>;

/** Injected side-effects, so the routing core is pure + unit-testable. */
export interface AtlasLocalTierDeps {
    /** True inside the Tauri desktop webview (false in Node / a plain browser). */
    isTauri: () => boolean;
    /** Resolve the machine's atlas_root, or null when unavailable (→ embedded). */
    resolveAtlasRoot: () => Promise<string | null>;
    /** Tauri fs `exists`. */
    fsExists: (absPath: string) => Promise<boolean>;
    /** Tauri fs `readFile` → raw bytes. */
    fsReadFile: (absPath: string) => Promise<Uint8Array>;
    /** Embedded-asset fallback (plain `fetch`). */
    baseFetch: FetchFn;
}

/** `/atlas/<rest>` → `<rest>` (e.g. `sectors/level_3_sector_0.json`); null otherwise. */
export function atlasRelPath(path: string): string | null {
    const m = /^\/atlas\/(.+)$/.exec(path);
    return m ? m[1] : null;
}

/** Join `root` (native sep) + a `/`-separated relative atlas path. */
export function joinLocalAtlasPath(root: string, rel: string): string {
    const sep = root.includes('\\') ? '\\' : '/';
    const trimmed = root.replace(/[\\/]+$/, '');
    return [trimmed, ...rel.split('/')].join(sep);
}

function contentTypeFor(rel: string): string {
    if (rel.endsWith('.json')) return 'application/json';
    if (rel.endsWith('.arrow')) return 'application/vnd.apache.arrow.file';
    return 'application/octet-stream';
}

/**
 * Pure routing core (deps injected). Resolves DOWNLOADED → EMBEDDED → 404-force,
 * fail-soft to embedded on any error. See the module header for the invariants.
 */
export async function loadAtlasWithLocalTierCore(
    path: string,
    d: AtlasLocalTierDeps,
): Promise<Response> {
    // Off-desktop: byte-identical passthrough (no Tauri import reached).
    if (!d.isTauri()) return d.baseFetch(path);

    let root: string | null = null;
    try {
        root = await d.resolveAtlasRoot();
    } catch {
        root = null;
    }
    if (!root) return d.baseFetch(path);

    const rel = atlasRelPath(path);
    if (rel == null) return d.baseFetch(path); // not an /atlas/ path — leave it

    const localPath = joinLocalAtlasPath(root, rel);
    try {
        if (await d.fsExists(localPath)) {
            const bytes = await d.fsReadFile(localPath);
            return new Response(bytes as BodyInit, {
                status: 200,
                headers: { 'content-type': contentTypeFor(rel) },
            });
        }
        // Downloaded-json precedence over embedded-arrow (binarySourceEnabled):
        // a missing local `.arrow` whose `.json` twin IS downloaded → force json.
        if (rel.endsWith('.arrow')) {
            const jsonTwin = joinLocalAtlasPath(root, rel.slice(0, -'.arrow'.length) + '.json');
            if (await d.fsExists(jsonTwin)) {
                return new Response(null, { status: 404 });
            }
        }
    } catch {
        /* fail-soft → embedded */
    }
    return d.baseFetch(path);
}

/** True inside the Tauri desktop webview (mirrors g15u_catalog / storagePaths). */
function isTauriRuntime(): boolean {
    try {
        return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    } catch {
        return false;
    }
}

/**
 * Production entry: wire the real deps (Tauri detection + storage resolver + fs
 * plugin, all lazily imported so the browser bundle never eager-loads them) and
 * route through the pure core. `baseFetch` is the embedded-asset fallback the
 * adapter passed (plain `fetch`).
 */
export async function loadAtlasWithLocalTier(path: string, baseFetch: FetchFn): Promise<Response> {
    return loadAtlasWithLocalTierCore(path, {
        isTauri: isTauriRuntime,
        resolveAtlasRoot: async () => {
            const sp = await import('../../../config/storagePaths');
            const paths = await sp.resolveStoragePaths();
            return paths?.atlas_root ?? null;
        },
        fsExists: async (p) => {
            const fs = await import('@tauri-apps/plugin-fs');
            return await fs.exists(p);
        },
        fsReadFile: async (p) => {
            const fs = await import('@tauri-apps/plugin-fs');
            return await fs.readFile(p);
        },
        baseFetch,
    });
}
