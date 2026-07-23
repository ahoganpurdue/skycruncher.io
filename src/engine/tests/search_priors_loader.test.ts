import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearchPriorModel, loadSearchPriorModel } from '../pipeline/m6_plate_solve/search_priors_loader';

// ─────────────────────────────────────────────────────────────────────────────
// Search-prior model loader (task #20 — lane ① population plumbing).
// Contract: NEVER fatal — every bad input yields null (the reorder seam's
// identity input). Validates both the derive-tool ENVELOPE and a BARE model.
// ─────────────────────────────────────────────────────────────────────────────

// The exact shape tools/adaptive/derive_search_priors.mjs emits.
const ENVELOPE = {
    spec: { tool: 'derive_search_priors', lane: 'search-priors (lane ①, reorder-only)', merge_deg: 4, radius_deg: 8 },
    provenance: { receipts_dir: '/x', receipts_scanned: 40, receipts_solved: 12, locks_used: 12, clusters: 2, generated_at: '2026-07-12T00:00:00Z' },
    model: {
        source: 'banked-receipts:population_run',
        regions: [
            { ra: 17.5956, dec: 35.64, weight: 3, radius_deg: 8, label: '3-lock cluster' },
            { ra: 11.3412, dec: 22.1, weight: 1, radius_deg: 8, label: 'seestar.json' },
        ],
    },
};

describe('parseSearchPriorModel (pure, browser-safe)', () => {
    it('returns null for non-object inputs (never throws)', () => {
        expect(parseSearchPriorModel(null)).toBeNull();
        expect(parseSearchPriorModel(undefined)).toBeNull();
        expect(parseSearchPriorModel(42)).toBeNull();
        expect(parseSearchPriorModel('nope')).toBeNull();
        expect(parseSearchPriorModel([])).toBeNull();
    });

    it('unwraps the derive-tool ENVELOPE (.model) into a SearchPriorModel', () => {
        const m = parseSearchPriorModel(ENVELOPE);
        expect(m).not.toBeNull();
        expect(m!.source).toBe('banked-receipts:population_run');
        expect(m!.regions).toHaveLength(2);
        expect(m!.regions[0]).toMatchObject({ ra: 17.5956, dec: 35.64, weight: 3, radius_deg: 8, label: '3-lock cluster' });
    });

    it('accepts a BARE model ({ regions })', () => {
        const m = parseSearchPriorModel({ source: 'bare', regions: [{ ra: 5, dec: -10, weight: 2 }] });
        expect(m).not.toBeNull();
        expect(m!.source).toBe('bare');
        expect(m!.regions).toEqual([{ ra: 5, dec: -10, weight: 2 }]);
    });

    it('drops regions missing a finite ra/dec or a positive weight', () => {
        const m = parseSearchPriorModel({
            regions: [
                { ra: 1, dec: 2, weight: 5 },            // keep
                { ra: 'x', dec: 2, weight: 5 },          // drop (bad ra)
                { ra: 1, dec: null, weight: 5 },         // drop (bad dec)
                { ra: 1, dec: 2, weight: 0 },            // drop (weight <= 0)
                { ra: 1, dec: 2, weight: -3 },           // drop (negative weight)
                { ra: 1, dec: 2 },                       // drop (no weight)
                { ra: Infinity, dec: 2, weight: 5 },     // drop (non-finite)
            ],
        });
        expect(m).not.toBeNull();
        expect(m!.regions).toHaveLength(1);
        expect(m!.regions[0]).toEqual({ ra: 1, dec: 2, weight: 5 });
    });

    it('omits an invalid radius_deg but keeps the region', () => {
        const m = parseSearchPriorModel({ regions: [{ ra: 1, dec: 2, weight: 5, radius_deg: -1 }] });
        expect(m!.regions[0]).toEqual({ ra: 1, dec: 2, weight: 5 });
        expect(m!.regions[0].radius_deg).toBeUndefined();
    });

    it('returns null when regions is absent or not an array', () => {
        expect(parseSearchPriorModel({ model: {} })).toBeNull();
        expect(parseSearchPriorModel({ regions: 'nope' })).toBeNull();
        expect(parseSearchPriorModel({})).toBeNull();
    });

    it('returns null when no region survives validation', () => {
        expect(parseSearchPriorModel({ regions: [{ ra: 'a', dec: 'b', weight: 'c' }] })).toBeNull();
    });

    it('falls back to the provenance arg when the model omits a source', () => {
        const m = parseSearchPriorModel({ regions: [{ ra: 1, dec: 2, weight: 1 }] }, '/models/x.json');
        expect(m!.source).toBe('/models/x.json');
    });
});

describe('loadSearchPriorModel (Node fs, never fatal)', () => {
    let dir: string;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'searchpriors-'));
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterAll(() => {
        warnSpy.mockRestore();
        logSpy.mockRestore();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('ABSENT: flag OFF ⇒ null (no fs touch)', async () => {
        const good = join(dir, 'good.json');
        writeFileSync(good, JSON.stringify(ENVELOPE));
        expect(await loadSearchPriorModel(false, good)).toBeNull();
    });

    it('ABSENT: empty / nullish path ⇒ null', async () => {
        expect(await loadSearchPriorModel(true, '')).toBeNull();
        expect(await loadSearchPriorModel(true, undefined)).toBeNull();
        expect(await loadSearchPriorModel(true, null)).toBeNull();
    });

    it('HAPPY: flag ON + valid envelope file ⇒ model', async () => {
        const good = join(dir, 'good.json');
        writeFileSync(good, JSON.stringify(ENVELOPE));
        const m = await loadSearchPriorModel(true, good);
        expect(m).not.toBeNull();
        expect(m!.regions).toHaveLength(2);
        expect(m!.source).toBe('banked-receipts:population_run');
    });

    it('HAPPY: a bare-model file also loads', async () => {
        const bare = join(dir, 'bare.json');
        writeFileSync(bare, JSON.stringify({ source: 'bare', regions: [{ ra: 1, dec: 2, weight: 4 }] }));
        const m = await loadSearchPriorModel(true, bare);
        expect(m!.regions).toHaveLength(1);
    });

    it('CORRUPT: unparseable JSON ⇒ null (logged, not thrown)', async () => {
        const bad = join(dir, 'corrupt.json');
        writeFileSync(bad, '{ this is not: json,,, ');
        await expect(loadSearchPriorModel(true, bad)).resolves.toBeNull();
    });

    it('CORRUPT: valid JSON but no usable region ⇒ null', async () => {
        const empty = join(dir, 'empty.json');
        writeFileSync(empty, JSON.stringify({ model: { source: 's', regions: [] } }));
        await expect(loadSearchPriorModel(true, empty)).resolves.toBeNull();
    });

    it('MISSING: nonexistent path ⇒ null (fs throw swallowed)', async () => {
        await expect(loadSearchPriorModel(true, join(dir, 'does-not-exist.json'))).resolves.toBeNull();
    });
});
