/**
 * ═══════════════════════════════════════════════════════════════════════════
 * G15U CATALOG — confirm-lane Gaia-only deep-catalog source (COORDINATE ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reads the greenfield quad-index's `stars.arrow` (Gaia DR3 G<15, all-sky —
 * `starplates-2026.07-quadidx-g15u`) for the post-solve forced-photometry
 * harvest + confirmation lane, REPLACING the legacy hybrid Gaia+HYG sector JSON
 * on that lane (owner Gaia-only ruling, 2026-07-22). Flag-gated at the adapter
 * (`VITE_CATALOG_G15U`, default OFF); the browser tier never engages.
 *
 * WHY node/tauri only: `stars.arrow` is a 181 MB local index file. It is read
 * with the Node fs (headless / vitest / api probe) or the Tauri fs plugin
 * (desktop webview). A pure browser has neither and no external fetch fallback,
 * so every failure is fail-soft → the adapter falls back to the hybrid path.
 *
 * UNIT TRAP (CLAUDE.md UNIT/FORMAT TRAPS): `ra_deg` is in DEGREES; the engine's
 * internal catalog convention is HOURS. Converted HERE at the boundary
 * (`ra_hours = ra_deg / 15`). Every g15u row is Gaia G in DEGREES — the hybrid
 * per-row deg/hours discriminant does NOT apply (all rows are one shape).
 *
 * LAW 7 (Memory Boundary Layout): the `stars.arrow` consumption seam is the
 * `g15u_stars_arrow` entry in `src/engine/contracts/binary_layouts.ts`
 * (dtype / stride / endianness / UNITS / version). Any stride/column change
 * updates that entry in the same commit.
 *
 * Reader pattern mirrors the incubator lane `tools/psf/g15u_stars.mjs`
 * (regionStars): whole-table load + cache, cone filter per query. The Arrow IPC
 * is a SINGLE batch, so a windowed sub-table read is not cheaper than the cached
 * full load; either way this retires the `ensureSectorLoaded` full-sector paging
 * class for the flag-ON path.
 */

import { tableFromIPC } from 'apache-arrow';

const D2R = Math.PI / 180;

/**
 * A deep-catalog row shaped for the confirm lane's only consumers
 * (projectCatalogToPixels + the neighbor lane): position + G magnitude + id.
 * Matches the subset of StandardStar those consumers read.
 */
export interface DeepCatalogRow {
    /** RA in decimal HOURS (converted from the arrow's `ra_deg` at this boundary). */
    ra_hours: number;
    /** Dec in decimal DEGREES. */
    dec_degrees: number;
    /** Gaia G magnitude (the arrow's `g_mag`). Band is always GaiaG. */
    magnitude_V: number;
    /** `Gaia_<source_id>` (matches the hybrid adapter's Gaia id shape). */
    gaia_id: string;
    /** Per-row band tag — always GaiaG on g15u (SCHEMA-B honesty; never pool w/ V). */
    band: 'GaiaG';
}

interface G15uCols {
    ra: Float64Array;
    dec: Float64Array;
    g: Float32Array;
    /** Vector<Uint64> — `.get(i)` → BigInt. */
    sid: { get(i: number): bigint | number | null };
    n: number;
}

// Module-level cache: the table is loaded once per process (181 MB), keyed by
// the resolved path so a path change (env/config) reloads honestly.
let _cache: { path: string; cols: G15uCols } | null = null;

/** True when running under Node (headless / vitest / api probe). */
function isNodeRuntime(): boolean {
    try {
        return typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
    } catch {
        return false;
    }
}

/** True when running inside the Tauri desktop webview. */
function isTauriRuntime(): boolean {
    try {
        return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    } catch {
        return false;
    }
}

/** Join `dir` + `stars.arrow` using the directory's own separator style. */
function joinStarsArrow(dir: string): string {
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + 'stars.arrow';
}

/**
 * Resolve the absolute `stars.arrow` path via the SAME ladder the greenfield
 * seam uses for the quad-index dir (src-tauri/src/greenfield_solve.rs
 * ::resolve_quadidx_dir):
 *   1. `SKYCRUNCHER_QUADIDX_DIR` env override (dev/desktop — highest priority)
 *   2. `index_root` from the per-machine storage resolver
 *      (tools/config/storage_paths.mjs headless · src/config/storagePaths.ts app)
 * Returns null when neither yields a path (→ hybrid fallback). Fail-soft.
 */
export async function resolveG15uStarsPath(): Promise<string | null> {
    // 1. env override (Node only — a webview has no process.env).
    if (isNodeRuntime()) {
        try {
            const dir = process.env?.SKYCRUNCHER_QUADIDX_DIR?.trim();
            if (dir) return joinStarsArrow(dir);
        } catch { /* fall through to the config resolver */ }
    }

    // 2. index_root via the storage resolver (mirrors the Rust ladder step 2/3).
    try {
        if (isTauriRuntime()) {
            const sp = await import('../../../config/storagePaths');
            const paths = await sp.resolveStoragePaths();
            if (paths?.index_root) return joinStarsArrow(paths.index_root);
        } else if (isNodeRuntime()) {
            // Node-tools resolver (.mjs, outside the tsc `src` program → variable
            // specifier keeps tsc from resolving it; Vite/Node resolve it at run).
            const spec = '../../../../tools/config/storage_paths.mjs';
            const sp = await import(/* @vite-ignore */ spec);
            const paths = sp.resolveStoragePaths?.();
            if (paths?.index_root) return joinStarsArrow(paths.index_root);
        }
    } catch { /* honest fall-through — resolver unavailable */ }

    return null;
}

/** Read the arrow bytes (Node fs / Tauri fs plugin), or null (fail-soft). */
async function readArrowBytes(path: string): Promise<Uint8Array | null> {
    try {
        if (isTauriRuntime()) {
            const fs = await import('@tauri-apps/plugin-fs');
            if (!(await fs.exists(path))) return null;
            return await fs.readFile(path);
        }
        if (isNodeRuntime()) {
            const fs = await import('node:fs');
            if (!fs.existsSync(path)) return null;
            return fs.readFileSync(path);
        }
    } catch { /* fail-soft */ }
    return null;
}

/** Decode arrow bytes into cached typed-array columns. */
function ingest(path: string, buf: Uint8Array): G15uCols {
    const table = tableFromIPC(buf);
    const cols: G15uCols = {
        ra: table.getChild('ra_deg')!.toArray() as Float64Array,
        dec: table.getChild('dec_deg')!.toArray() as Float64Array,
        g: table.getChild('g_mag')!.toArray() as Float32Array,
        sid: table.getChild('source_id') as unknown as G15uCols['sid'],
        n: table.numRows,
    };
    _cache = { path, cols };
    return cols;
}

/** Load (+ cache) the g15u columns for the resolved path, or null (fail-soft). */
async function loadG15uColumns(): Promise<G15uCols | null> {
    const path = await resolveG15uStarsPath();
    if (!path) return null;
    if (_cache && _cache.path === path) return _cache.cols;
    const buf = await readArrowBytes(path);
    if (!buf) return null;
    try {
        return ingest(path, buf);
    } catch {
        return null;
    }
}

/**
 * Every g15u star within `radiusDeg` of (`raHours`,`decDeg`) with
 * `magMin < g_mag <= magLimit`, returned MAG-SORTED (brightest first) and shaped
 * for the confirm lane. Great-circle cone test on a cheap dec pre-filter (the
 * `regionStars` reader pattern). RA converted deg→hours at this boundary.
 * Returns null on any resolution/read failure (→ hybrid fallback).
 */
export async function queryG15uCatalog(args: {
    raHours: number;
    decDeg: number;
    radiusDeg: number;
    magLimit?: number;
    magMin?: number;
}): Promise<DeepCatalogRow[] | null> {
    const cols = await loadG15uColumns();
    if (!cols) return null;

    const { raHours, decDeg, radiusDeg } = args;
    const magLimit = args.magLimit ?? Infinity;
    const magMin = args.magMin ?? -Infinity;
    const raDeg0 = raHours * 15;
    const a0 = raDeg0 * D2R;
    const cosd0 = Math.cos(decDeg * D2R);
    const sind0 = Math.sin(decDeg * D2R);
    const decLo = decDeg - radiusDeg;
    const decHi = decDeg + radiusDeg;
    const cosR = Math.cos(Math.min(180, radiusDeg) * D2R);

    const out: DeepCatalogRow[] = [];
    for (let i = 0; i < cols.n; i++) {
        const gm = cols.g[i];
        if (gm > magLimit || gm <= magMin) continue;
        const dd = cols.dec[i];
        if (dd < decLo || dd > decHi) continue;
        const ddr = dd * D2R;
        const c = sind0 * Math.sin(ddr) + cosd0 * Math.cos(ddr) * Math.cos(cols.ra[i] * D2R - a0);
        if (c < cosR) continue; // outside the cone (cos decreasing in angle)
        out.push({
            ra_hours: cols.ra[i] / 15,
            dec_degrees: dd,
            magnitude_V: gm,
            gaia_id: 'Gaia_' + String(cols.sid.get(i)),
            band: 'GaiaG',
        });
    }
    out.sort((x, y) => x.magnitude_V - y.magnitude_V);
    return out;
}

/** @internal Test seam: clear the module-level table cache. */
export function __resetG15uCache(): void {
    _cache = null;
}
