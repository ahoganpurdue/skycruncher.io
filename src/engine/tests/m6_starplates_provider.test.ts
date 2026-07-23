import { describe, it, expect, afterEach, vi } from 'vitest';
import { Table, Schema, RecordBatch, makeVector, tableToIPC } from 'apache-arrow';
import {
    decodeStarplatesResponse,
    toStandardStars,
    partialCoverageWarning,
    type StarplatesResponseMeta,
} from '../pipeline/m6_plate_solve/starplates_provider';
import { StarCatalogAdapter } from '../pipeline/m6_plate_solve/star_catalog_adapter';
import type { StandardStar } from '../pipeline/m6_plate_solve/standard_stars';

/**
 * STARPLATES provider tests — the TS side of the docs/STARPLATES_SPEC.md §5.2
 * FROZEN response contract (Arrow IPC stream, 7 exact columns, custom
 * metadata) + the §1 flag seams in StarCatalogAdapter.
 *
 * FIXTURE NOTE (spec §9.4): the normative golden fixture is forge-generated
 * bytes committed under src/engine/tests/fixtures/ and SHA-pinned. The forge
 * (WP-A) had not landed when this suite was written, so the fixture bytes are
 * built in-test with apache-arrow to the exact §5.2 wire layout (verified:
 * stream format, single batch, exact column types incl. Uint64, metadata).
 * This pins the DECODER + MAPPING behavior; byte-layout conformance of the
 * native writer is pinned Rust-side. When the forge fixture lands, add a
 * second decode pass over those bytes (same assertions).
 */

// ─── fixture builder (exact §5.2 wire layout) ───────────────────────────────

interface FixtureRow {
    ra_deg: number; dec_deg: number;
    pm_ra_masyr: number; pm_dec_masyr: number;
    g_mag: number; bp_rp: number;
    source_id: bigint;
}

const DEFAULT_META: Record<string, string> = {
    'skycruncher.release': 'starplates-2026.07-gdr3',
    'skycruncher.epoch_jd': '2461237.769',
    'skycruncher.positions': 'propagated',
    'skycruncher.tier_depth': 't1',
    'skycruncher.cells_served': '5:2417,5:2418',
    'skycruncher.cell_shas': 'a'.repeat(64) + ',' + 'b'.repeat(64),
    'skycruncher.cells_absent_release': '0',
    'skycruncher.cells_absent_local': '0',
};

function buildResponseBytes(rows: FixtureRow[], meta: Record<string, string> = DEFAULT_META): Uint8Array {
    const t0 = new Table({
        ra_deg: makeVector(Float64Array.from(rows.map(r => r.ra_deg))),
        dec_deg: makeVector(Float64Array.from(rows.map(r => r.dec_deg))),
        pm_ra_masyr: makeVector(Float32Array.from(rows.map(r => r.pm_ra_masyr))),
        pm_dec_masyr: makeVector(Float32Array.from(rows.map(r => r.pm_dec_masyr))),
        g_mag: makeVector(Float32Array.from(rows.map(r => r.g_mag))),
        bp_rp: makeVector(Float32Array.from(rows.map(r => r.bp_rp))),
        source_id: makeVector(BigUint64Array.from(rows.map(r => r.source_id))),
    });
    const schema = new Schema(t0.schema.fields, new Map(Object.entries(meta)));
    const t = new Table(schema, t0.batches.map(b => new RecordBatch(schema, (b as any).data)));
    return tableToIPC(t, 'stream');
}

// g_mag-ascending rows (wire sort contract), incl. a source_id beyond
// Number.MAX_SAFE_INTEGER — the §3.1 BigInt tooling trap.
const ROWS: FixtureRow[] = [
    { ra_deg: 170.0620, dec_deg: 12.9915, pm_ra_masyr: -3.25, pm_dec_masyr: 1.5, g_mag: 4.875, bp_rp: 0.625, source_id: 3675921887240192n },
    { ra_deg: 169.9000, dec_deg: 13.1000, pm_ra_masyr: 10.0, pm_dec_masyr: -20.0, g_mag: 9.125, bp_rp: 1.25, source_id: 3990036706534208512n },
    { ra_deg: 170.2500, dec_deg: 12.8000, pm_ra_masyr: 0.0, pm_dec_masyr: 0.0, g_mag: 12.5, bp_rp: -0.125, source_id: 18446744073709551615n },
];

describe('starplates_provider — §5.2 response decode (zero-copy column handles)', () => {
    it('decodes the exact column set to the exact TypedArray types', () => {
        const { columns } = decodeStarplatesResponse(buildResponseBytes(ROWS));
        expect(columns.numRows).toBe(3);
        // NOTE: instanceof asserted via boolean — this vitest version's typings
        // lack toBeInstanceOf on TypedArray assertions (see the pre-existing
        // m1_* baseline errors); boolean form keeps tsc at the 8-line baseline.
        expect(columns.ra_deg instanceof Float64Array).toBe(true);
        expect(columns.dec_deg instanceof Float64Array).toBe(true);
        expect(columns.pm_ra_masyr instanceof Float32Array).toBe(true);
        expect(columns.pm_dec_masyr instanceof Float32Array).toBe(true);
        expect(columns.g_mag instanceof Float32Array).toBe(true);
        expect(columns.bp_rp instanceof Float32Array).toBe(true);
        expect(columns.source_id instanceof BigUint64Array).toBe(true);

        expect(columns.ra_deg[0]).toBe(170.0620);
        expect(columns.dec_deg[2]).toBe(12.8000);
        expect(columns.g_mag[1]).toBeCloseTo(9.125, 6);   // f32-exact value
        expect(columns.bp_rp[2]).toBeCloseTo(-0.125, 6);
    });

    it('round-trips u64 source_id as BigInt with full precision (§3.1 trap)', () => {
        const { columns } = decodeStarplatesResponse(buildResponseBytes(ROWS));
        expect(columns.source_id[0]).toBe(3675921887240192n);
        expect(columns.source_id[1]).toBe(3990036706534208512n); // > MAX_SAFE_INTEGER
        expect(columns.source_id[2]).toBe(18446744073709551615n); // u64::MAX
    });

    it('parses the §5.2 provenance metadata; absent keys decode to null, never defaults', () => {
        const { meta } = decodeStarplatesResponse(buildResponseBytes(ROWS));
        expect(meta.release).toBe('starplates-2026.07-gdr3');
        expect(meta.positions).toBe('propagated');
        expect(meta.tier_depth).toBe('t1');
        expect(meta.cells_served).toEqual(['5:2417', '5:2418']);
        expect(meta.cell_shas).toHaveLength(2);
        expect(meta.cells_absent_release).toBe(0);
        expect(meta.cells_absent_local).toBe(0);

        // Honest-or-null: strip all metadata.
        const bare = decodeStarplatesResponse(buildResponseBytes(ROWS, {}));
        expect(bare.meta.release).toBeNull();
        expect(bare.meta.cells_absent_release).toBeNull();
        expect(bare.meta.cells_absent_local).toBeNull();
        expect(bare.meta.cells_served).toEqual([]);
    });

    it('decodes an empty (0-row) response', () => {
        const { columns } = decodeStarplatesResponse(buildResponseBytes([]));
        expect(columns.numRows).toBe(0);
        expect(columns.ra_deg.length).toBe(0);
        expect(columns.source_id.length).toBe(0);
    });

    it('fails LOUDLY on schema drift: missing column', () => {
        const t = new Table({
            ra_deg: makeVector(Float64Array.from([170])),
            dec_deg: makeVector(Float64Array.from([13])),
        });
        expect(() => decodeStarplatesResponse(tableToIPC(t, 'stream')))
            .toThrow(/missing column/);
    });

    it('fails LOUDLY on schema drift: wrong physical type', () => {
        // source_id as Float64 (the old lossy convention) must be rejected.
        const t = new Table({
            ra_deg: makeVector(Float64Array.from([170])),
            dec_deg: makeVector(Float64Array.from([13])),
            pm_ra_masyr: makeVector(Float32Array.from([0])),
            pm_dec_masyr: makeVector(Float32Array.from([0])),
            g_mag: makeVector(Float32Array.from([9])),
            bp_rp: makeVector(Float32Array.from([1])),
            source_id: makeVector(Float64Array.from([123])),
        });
        expect(() => decodeStarplatesResponse(tableToIPC(t, 'stream')))
            .toThrow(/source_id/);
    });
});

describe('starplates_provider — StandardStar materialization (drop-in parity shape)', () => {
    it('maps rows with the v1 native-branch convention + full-u64 gaia_id', () => {
        const stars = toStandardStars(decodeStarplatesResponse(buildResponseBytes(ROWS)));
        expect(stars).toHaveLength(3);

        const s0 = stars[0];
        expect(s0.gaia_id).toBe('Gaia_3675921887240192');
        expect(s0.name).toBe('Gaia_3675921887240192');
        expect(s0.ra_hours).toBeCloseTo(170.0620 / 15.0, 12);
        expect(s0.dec_degrees).toBe(12.9915);
        expect(s0.magnitude_V).toBeCloseTo(4.875, 6);
        expect(s0.color_index_BV).toBeCloseTo(0.625, 6);
        // Positions arrive propagated ⇒ PM zeroed (v1 convention, §5.3).
        expect(s0.pmra).toBe(0);
        expect(s0.pmdec).toBe(0);
        expect(s0.spectral_type).toBe('Unknown');

        // Full u64 id survives — v1 would have printed the truncated u32.
        expect(stars[1].gaia_id).toBe('Gaia_3990036706534208512');
        expect(stars[2].gaia_id).toBe('Gaia_18446744073709551615');
    });

    it('returns magnitude-ascending order (stable even if wire order drifted)', () => {
        const shuffled = [ROWS[2], ROWS[0], ROWS[1]];
        const stars = toStandardStars(decodeStarplatesResponse(buildResponseBytes(shuffled)));
        expect(stars.map(s => s.magnitude_V)).toEqual(
            [...stars.map(s => s.magnitude_V)].sort((a, b) => a - b)
        );
        expect(stars[0].gaia_id).toBe('Gaia_3675921887240192');
    });
});

describe('starplates_provider — coverage honesty (§5.2: cells_absent_* MUST warn)', () => {
    const base: StarplatesResponseMeta = {
        release: 'starplates-2026.07-gdr3', epoch_jd: '2461237.769', positions: 'propagated',
        tier_depth: 't1', cells_served: [], cell_shas: [],
        cells_absent_release: 0, cells_absent_local: 0,
    };

    it('is silent on full coverage (and on honest-null metadata)', () => {
        expect(partialCoverageWarning(base)).toBeNull();
        expect(partialCoverageWarning({ ...base, cells_absent_release: null, cells_absent_local: null })).toBeNull();
    });

    it('warns on cells absent from the release (missing-sky region)', () => {
        const w = partialCoverageWarning({ ...base, cells_absent_release: 2 });
        expect(w).toMatch(/2 cone cell\(s\) absent from release/);
        expect(w).toMatch(/solve proceeds/);
    });

    it('warns on cells not yet synced locally', () => {
        const w = partialCoverageWarning({ ...base, cells_absent_local: 3 });
        expect(w).toMatch(/3 cone cell\(s\) not yet synced/);
    });
});

describe('StarCatalogAdapter — starplates flag seams (§1: default OFF, inert)', () => {
    const adapter = StarCatalogAdapter.getinstance();

    afterEach(() => {
        StarCatalogAdapter.setStarplatesSource(false);
        StarCatalogAdapter.setStarplatesSync(false);
        StarCatalogAdapter.setStarplatesQuery(null);
        (adapter as any).isNative = false;
        (adapter as any).isLoaded = false;
    });

    it('both flags default OFF (VITE_STARPLATES / VITE_STARPLATES_SYNC unset)', () => {
        expect(StarCatalogAdapter.isStarplatesSourceEnabled()).toBe(false);
        expect(StarCatalogAdapter.isStarplatesSyncEnabled()).toBe(false);
    });

    it('setters round-trip', () => {
        StarCatalogAdapter.setStarplatesSource(true);
        expect(StarCatalogAdapter.isStarplatesSourceEnabled()).toBe(true);
        StarCatalogAdapter.setStarplatesSync(true);
        expect(StarCatalogAdapter.isStarplatesSyncEnabled()).toBe(true);
    });

    it('flag OFF ⇒ the v2 query seam is NEVER invoked on the native path (inertness)', async () => {
        const spy = vi.fn(async () => [] as StandardStar[]);
        StarCatalogAdapter.setStarplatesQuery(spy);
        (adapter as any).isLoaded = true;
        (adapter as any).isNative = true;

        // Flag OFF (default): native v1 invoke fails in Node → JS-band fallback → [].
        const res = await adapter.findStarsInField(11.337, 12.99, 2.3, 2461237.769);
        expect(spy).not.toHaveBeenCalled();
        expect(Array.isArray(res)).toBe(true);
    });

    it('flag ON + native ⇒ routes to the v2 query with adapter units and returns its stars', async () => {
        const marker: StandardStar[] = toStandardStars(decodeStarplatesResponse(buildResponseBytes(ROWS)));
        const spy = vi.fn(async () => marker);
        StarCatalogAdapter.setStarplatesQuery(spy);
        StarCatalogAdapter.setStarplatesSource(true);
        (adapter as any).isLoaded = true;
        (adapter as any).isNative = true;

        const res = await adapter.findStarsInField(11.337, 12.99, 2.3, 2461237.769);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(11.337, 12.99, 2.3, 2461237.769);
        expect(res).toBe(marker);
    });

    it('flag ON but v2 returns null ⇒ falls back to the v1 path without throwing', async () => {
        const spy = vi.fn(async () => null);
        StarCatalogAdapter.setStarplatesQuery(spy);
        StarCatalogAdapter.setStarplatesSource(true);
        (adapter as any).isLoaded = true;
        (adapter as any).isNative = true;

        // v1 native invoke fails in Node (no Tauri) → JS-band fallback → array.
        const res = await adapter.findStarsInField(11.337, 12.99, 2.3, 2461237.769);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(Array.isArray(res)).toBe(true);
    });

    it('flag ON + non-native ⇒ v2 seam not consulted (starplates is native-store-backed)', async () => {
        const spy = vi.fn(async () => [] as StandardStar[]);
        StarCatalogAdapter.setStarplatesQuery(spy);
        StarCatalogAdapter.setStarplatesSource(true);
        (adapter as any).isLoaded = true;
        (adapter as any).isNative = false;

        await adapter.findStarsInField(11.337, 12.99, 2.3, 2461237.769);
        expect(spy).not.toHaveBeenCalled();
    });
});
