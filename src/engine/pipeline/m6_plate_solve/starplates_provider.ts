import { tableFromIPC } from 'apache-arrow';
import type { StandardStar } from './standard_stars';

/**
 * STARPLATES PROVIDER — flag-gated TS consumer of the native `query_catalog_v2`
 * binary protocol (docs/STARPLATES_SPEC.md §5, FROZEN).
 * ============================================================================
 * This module is only ever pulled in via dynamic import from
 * `star_catalog_adapter.tryQueryStarplates` when `VITE_STARPLATES` /
 * `StarCatalogAdapter.setStarplatesSource(true)` is ON — mirroring the
 * `VITE_ATLAS_BINARY` / atlas_arrow_codec seam. Flag OFF ⇒ zero bundle and
 * zero solve-path impact (the sacred e2e stays byte-identical by construction).
 *
 * Wire contract it decodes (§5.2): Arrow IPC **stream** bytes, uncompressed,
 * exactly one record batch, no validity buffers, columns in exact order:
 *
 *   ra_deg:f64  dec_deg:f64  pm_ra_masyr:f32  pm_dec_masyr:f32
 *   g_mag:f32   bp_rp:f32    source_id:u64
 *
 * Positions arrive ALREADY PROPAGATED to the requested `epoch_jd` (the native
 * command replicates v1's PM formula bit-for-bit — §5.3); rows arrive sorted
 * g_mag asc, ties source_id asc. Schema custom_metadata carries provenance
 * (release, cells_served, cell SHAs) and the coverage-honesty counters
 * (`cells_absent_release` / `cells_absent_local`), which MUST be surfaced as
 * a warning when > 0 (§5.2 — absent = absent, report and continue).
 *
 * Two consumption shapes are exported:
 *   (a) `toStandardStars` — drop-in `StandardStar[]` materialization, the
 *       zero-risk parity path (same mapping convention as the v1 native
 *       branch: pmra/pmdec = 0 because positions are already propagated),
 *       EXCEPT gaia_id now carries the FULL u64 source_id via BigInt — v1
 *       printed the u32-truncated id (spec §0.6; correctness fix behind the
 *       flag).
 *   (b) `decodeStarplatesResponse().columns` — zero-copy TypedArray column
 *       handles (Float64Array ra/dec, Float32Array pm/mag/bp_rp,
 *       BigUint64Array source_id) for the NEXT_MOVES §9 SoA experiments.
 *       Zero-copy is guaranteed by the format: uncompressed fixed-width
 *       single-chunk no-null columns (§3.2 / skeptic-verified constraint).
 *
 * TOOLING TRAP (normative, §3.1): source_id exceeds Number.MAX_SAFE_INTEGER.
 * It stays BigInt end-to-end here; the only stringification is `Gaia_${id}`.
 */

// ─── Response decoding ──────────────────────────────────────────────────────

/** Exact expected column set, in wire order (§5.2). Drift fails loudly. */
const RESPONSE_COLUMNS: ReadonlyArray<{ name: string; ctor: Function }> = [
    { name: 'ra_deg', ctor: Float64Array },
    { name: 'dec_deg', ctor: Float64Array },
    { name: 'pm_ra_masyr', ctor: Float32Array },
    { name: 'pm_dec_masyr', ctor: Float32Array },
    { name: 'g_mag', ctor: Float32Array },
    { name: 'bp_rp', ctor: Float32Array },
    { name: 'source_id', ctor: BigUint64Array },
];

/** Zero-copy column handles over the response bytes (shape (b) — SoA lane). */
export interface StarplatesColumns {
    numRows: number;
    ra_deg: Float64Array;       // propagated to epoch_jd (§5.2)
    dec_deg: Float64Array;      // propagated to epoch_jd
    pm_ra_masyr: Float32Array;  // original Gaia μ_α* — informational, already applied
    pm_dec_masyr: Float32Array; // original Gaia μ_δ — informational, already applied
    g_mag: Float32Array;
    bp_rp: Float32Array;
    source_id: BigUint64Array;  // full u64
}

/** Provenance + coverage-honesty metadata (§5.2). Honest-or-null: a key the
 *  wire did not carry decodes to null, never a fabricated default. */
export interface StarplatesResponseMeta {
    release: string | null;
    epoch_jd: string | null;
    positions: string | null;
    tier_depth: string | null;
    /** "order:cell" entries, ascending (e.g. "5:2417"). Empty if not carried. */
    cells_served: string[];
    /** SHA-256 hex per served cell, same order — solve provenance. */
    cell_shas: string[];
    /** Cone cells in the release's missing-coverage region; null if not carried. */
    cells_absent_release: number | null;
    /** Cone cells in the release but not yet synced locally; null if not carried. */
    cells_absent_local: number | null;
}

export interface StarplatesResponse {
    columns: StarplatesColumns;
    meta: StarplatesResponseMeta;
}

function metaString(m: Map<string, string>, key: string): string | null {
    const v = m.get(key);
    return v === undefined ? null : v;
}

function metaCount(m: Map<string, string>, key: string): number | null {
    const v = m.get(key);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function metaList(m: Map<string, string>, key: string): string[] {
    const v = m.get(key);
    if (v === undefined || v === '') return [];
    return v.split(',');
}

/**
 * Decode `query_catalog_v2` response bytes (Arrow IPC stream) — or a
 * starplates CELL file (§3.2; same column family, ARROW1 file format) — into
 * zero-copy column handles + parsed metadata. Throws (never misparses
 * silently) on schema drift: wrong/missing columns, wrong physical types, or
 * a chunked (≠1 batch) body, all of which the frozen contract forbids.
 */
export function decodeStarplatesResponse(ipcBytes: Uint8Array | ArrayBuffer): StarplatesResponse {
    const bytes = ipcBytes instanceof Uint8Array ? ipcBytes : new Uint8Array(ipcBytes);
    const t = tableFromIPC(bytes);

    if (t.batches.length > 1) {
        // §3.2/§5.2: exactly one record batch — multi-chunk would silently
        // break the zero-copy single-buffer guarantee, so it is an error.
        throw new Error(`[starplates] contract violation: expected 1 record batch, got ${t.batches.length}`);
    }

    const cols: any = { numRows: t.numRows };
    for (const { name, ctor } of RESPONSE_COLUMNS) {
        const child = t.getChild(name) as any;
        if (!child) {
            throw new Error(`[starplates] contract violation: missing column '${name}'`);
        }
        // Empty result set ⇒ zero data chunks; synthesize an empty view.
        const values = child.data.length === 0 ? new (ctor as any)(0) : child.data[0].values;
        if (!(values instanceof (ctor as any))) {
            throw new Error(
                `[starplates] contract violation: column '${name}' decoded to ` +
                `${values?.constructor?.name ?? typeof values}, expected ${(ctor as any).name}`
            );
        }
        cols[name] = values;
    }

    const m = t.schema.metadata as Map<string, string>;
    const meta: StarplatesResponseMeta = {
        release: metaString(m, 'skycruncher.release'),
        epoch_jd: metaString(m, 'skycruncher.epoch_jd'),
        positions: metaString(m, 'skycruncher.positions'),
        tier_depth: metaString(m, 'skycruncher.tier_depth'),
        cells_served: metaList(m, 'skycruncher.cells_served'),
        cell_shas: metaList(m, 'skycruncher.cell_shas'),
        cells_absent_release: metaCount(m, 'skycruncher.cells_absent_release'),
        cells_absent_local: metaCount(m, 'skycruncher.cells_absent_local'),
    };

    return { columns: cols as StarplatesColumns, meta };
}

// ─── Coverage honesty (§5.2: cells_absent_* > 0 MUST be logged) ─────────────

/**
 * Build the honest partial-coverage warning, or null when coverage is
 * complete. Split out from the query path so vitest can pin the honesty rule
 * without a native round trip.
 */
export function partialCoverageWarning(meta: StarplatesResponseMeta): string | null {
    const rel = meta.cells_absent_release ?? 0;
    const loc = meta.cells_absent_local ?? 0;
    if (rel <= 0 && loc <= 0) return null;
    const parts: string[] = [];
    if (rel > 0) parts.push(`${rel} cone cell(s) absent from release (missing-sky region)`);
    if (loc > 0) parts.push(`${loc} cone cell(s) not yet synced locally`);
    return `[starplates] partial catalog coverage: ${parts.join('; ')} — solve proceeds on available cells (release ${meta.release ?? '--'}).`;
}

// ─── StandardStar materialization (shape (a): drop-in parity path) ──────────

/**
 * Materialize the response as `StandardStar[]` — the drop-in replacement for
 * the v1 `query_catalog` mapping in `star_catalog_adapter.findStarsInField`.
 * Convention identical to the v1 native branch (positions already propagated
 * ⇒ pmra/pmdec = 0; magnitude_V = g_mag; color_index_BV = bp_rp), except
 * gaia_id carries the FULL u64 source_id (v1 printed the u32-truncated id).
 * Rows arrive g_mag-ascending per the wire contract; the defensive sort is a
 * stable no-op that preserves v1's explicit mag sort behavior.
 */
export function toStandardStars(resp: StarplatesResponse): StandardStar[] {
    const c = resp.columns;
    const n = c.numRows;
    const out: StandardStar[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const gaiaId = `Gaia_${c.source_id[i]}`; // BigInt → full-precision decimal string
        out[i] = {
            name: gaiaId,
            ra_hours: c.ra_deg[i] / 15.0,
            dec_degrees: c.dec_deg[i],
            magnitude_V: c.g_mag[i],
            color_index_BV: c.bp_rp[i],
            spectral_type: 'Unknown',
            gaia_id: gaiaId,
            pmra: 0, // already propagated by the native command (§5.3)
            pmdec: 0,
            rv_kms: 0,
            temperature_K: 0,
            expected_xy: { x: 0.33, y: 0.33 },
            constellation: ''
        } as StandardStar;
    }
    return out.sort((a, b) => a.magnitude_V - b.magnitude_V);
}

// ─── Native query entry (adapter-facing) ────────────────────────────────────

/**
 * Invoke `query_catalog_v2` (§5.1) and return raw Arrow IPC stream bytes.
 * Tauri v2's `tauri::ipc::Response` path delivers an ArrayBuffer — no JSON
 * serialization anywhere (retires §0 defect #3).
 */
export async function queryCatalogV2Raw(
    raDeg: number, decDeg: number, radiusDeg: number, tier: string, epochJd: number
): Promise<ArrayBuffer> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ArrayBuffer>('query_catalog_v2', { raDeg, decDeg, radiusDeg, tier, epochJd });
}

/**
 * The adapter's v2 query: cone query in the adapter's own units (RA in HOURS,
 * matching `findStarsInField`), returning mag-sorted `StandardStar[]`, or
 * null on ANY failure — the caller then falls back to the untouched v1 path
 * (`query_catalog`), so v2 can never make a solve worse than v1.
 */
export async function queryStarsV2(
    raCenterHours: number,
    decCenterDeg: number,
    radiusDeg: number,
    obsJd: number,
    tier: string = 't1'
): Promise<StandardStar[] | null> {
    try {
        const bytes = await queryCatalogV2Raw(raCenterHours * 15.0, decCenterDeg, radiusDeg, tier, obsJd);
        const resp = decodeStarplatesResponse(bytes);
        const warning = partialCoverageWarning(resp.meta);
        if (warning) console.warn(warning);
        return toStandardStars(resp);
    } catch (e) {
        console.warn('[starplates] query_catalog_v2 failed — falling back to v1 query_catalog.', e);
        return null;
    }
}
