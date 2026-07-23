import { describe, it, expect, vi } from 'vitest';
import {
    atlasRelPath,
    joinLocalAtlasPath,
    loadAtlasWithLocalTierCore,
    type AtlasLocalTierDeps,
} from './atlas_local_tier';

const EMBEDDED = '__embedded__';

/** Deps with sane defaults (desktop, atlas_root set, nothing on disk). */
function mkDeps(over: Partial<AtlasLocalTierDeps> = {}): AtlasLocalTierDeps {
    return {
        isTauri: () => true,
        resolveAtlasRoot: async () => 'D:/AstroLogic/data/atlas',
        fsExists: async () => false,
        fsReadFile: async () => new Uint8Array([1, 2, 3]),
        baseFetch: async (_p: string) => new Response(EMBEDDED, { status: 200 }),
        ...over,
    };
}

describe('atlasRelPath', () => {
    it('strips the /atlas/ prefix, null for non-atlas paths', () => {
        expect(atlasRelPath('/atlas/sectors/level_3_sector_0.json')).toBe('sectors/level_3_sector_0.json');
        expect(atlasRelPath('/atlas/level_1_anchors.json')).toBe('level_1_anchors.json');
        expect(atlasRelPath('/other/x.json')).toBeNull();
        expect(atlasRelPath('/atlas/')).toBeNull();
    });
});

describe('joinLocalAtlasPath', () => {
    it('joins with the root separator style', () => {
        expect(joinLocalAtlasPath('X:\\atlas', 'sectors/level_3_sector_0.json')).toBe(
            'X:\\atlas\\sectors\\level_3_sector_0.json',
        );
        expect(joinLocalAtlasPath('/data/atlas/', 'sectors/level_3_sector_1.json')).toBe(
            '/data/atlas/sectors/level_3_sector_1.json',
        );
    });
});

describe('loadAtlasWithLocalTierCore', () => {
    it('off-desktop: byte-identical passthrough to baseFetch (no resolve/fs touched)', async () => {
        const resolveAtlasRoot = vi.fn(async () => 'D:/atlas');
        const fsExists = vi.fn(async () => true);
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ isTauri: () => false, resolveAtlasRoot, fsExists, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.json', d);
        expect(await r.text()).toBe(EMBEDDED);
        expect(baseFetch).toHaveBeenCalledWith('/atlas/sectors/level_3_sector_0.json');
        expect(resolveAtlasRoot).not.toHaveBeenCalled();
        expect(fsExists).not.toHaveBeenCalled();
    });

    it('desktop, no atlas_root → embedded fallback', async () => {
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ resolveAtlasRoot: async () => null, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.json', d);
        expect(await r.text()).toBe(EMBEDDED);
        expect(baseFetch).toHaveBeenCalledOnce();
    });

    it('desktop, downloaded json present → served locally (downloaded wins)', async () => {
        const bytes = new TextEncoder().encode('LOCAL_JSON');
        const fsExists = vi.fn(async (p: string) => p.endsWith('level_3_sector_0.json'));
        const fsReadFile = vi.fn(async () => bytes);
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ resolveAtlasRoot: async () => 'D:/atlas', fsExists, fsReadFile, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.json', d);
        expect(r.status).toBe(200);
        expect(await r.text()).toBe('LOCAL_JSON');
        expect(fsReadFile).toHaveBeenCalledWith('D:/atlas/sectors/level_3_sector_0.json');
        expect(baseFetch).not.toHaveBeenCalled();
    });

    it('desktop, local absent → embedded fallback (byte-identical no-download)', async () => {
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ fsExists: async () => false, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.json', d);
        expect(await r.text()).toBe(EMBEDDED);
        expect(baseFetch).toHaveBeenCalledOnce();
    });

    it('desktop, .arrow requested but only .json twin downloaded → synthetic 404 (force json)', async () => {
        const fsExists = vi.fn(async (p: string) => p.endsWith('.json')); // arrow absent, json present
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ fsExists, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.arrow', d);
        expect(r.status).toBe(404);
        expect(baseFetch).not.toHaveBeenCalled(); // did NOT serve embedded arrow
    });

    it('desktop, .arrow requested and no json twin → embedded fallback', async () => {
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({ fsExists: async () => false, baseFetch });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.arrow', d);
        expect(await r.text()).toBe(EMBEDDED);
        expect(baseFetch).toHaveBeenCalledOnce();
    });

    it('fail-soft: fs throws → embedded fallback', async () => {
        const baseFetch = vi.fn(async () => new Response(EMBEDDED, { status: 200 }));
        const d = mkDeps({
            fsExists: async () => {
                throw new Error('fs boom');
            },
            baseFetch,
        });
        const r = await loadAtlasWithLocalTierCore('/atlas/sectors/level_3_sector_0.json', d);
        expect(await r.text()).toBe(EMBEDDED);
        expect(baseFetch).toHaveBeenCalledOnce();
    });
});
