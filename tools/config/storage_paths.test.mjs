import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    resolveStoragePaths,
    writeStorageConfig,
    ensureStorageConfig,
    buildStorageConfig,
    subRootDefaults,
    storageConfigPath,
    LEGACY_INDEX_DIR,
    STORAGE_CONFIG_VERSION,
} from './storage_paths.mjs';

const tmpRoots = [];
function tmpEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'skc-storage-'));
    tmpRoots.push(dir);
    return { LOCALAPPDATA: dir };
}
afterEach(() => {
    while (tmpRoots.length) {
        try {
            rmSync(tmpRoots.pop(), { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }
});

describe('storage_paths (Node/tools resolver)', () => {
    it('fresh machine → LOCALAPPDATA defaults, all roots under data_root', () => {
        const env = tmpEnv();
        const r = resolveStoragePaths({ env, exists: () => false });
        expect(r.source).toBe('localappdata-default');
        expect(r.data_root).toBe(join(env.LOCALAPPDATA, 'io.skycruncher.app', 'data'));
        expect(r.index_root).toBe(join(r.data_root, 'index'));
        expect(r.intake_root).toBe(join(r.data_root, 'intake'));
        expect(r.capture_root).toBe(join(r.data_root, 'capture'));
        expect(r.atlas_root).toBe(join(r.data_root, 'atlas'));
        expect(r.export_root).toBe(join(r.data_root, 'exports'));
    });

    it('legacy desktop detect → D:\\AstroLogic layout, index at the real g15u dir', () => {
        const env = tmpEnv();
        // exists: true for the legacy root + its test_artifacts tell-tale; false for storage.json.
        const exists = (p) =>
            p === 'D:\\AstroLogic' || p === join('D:\\AstroLogic', 'test_artifacts');
        const r = resolveStoragePaths({ env, exists });
        expect(r.source).toBe('legacy-desktop');
        expect(r.data_root).toBe('D:\\AstroLogic');
        expect(r.index_root).toBe(LEGACY_INDEX_DIR);
    });

    it('does NOT misdetect a bare D:\\AstroLogic with no dev tell-tale', () => {
        const env = tmpEnv();
        const exists = (p) => p === 'D:\\AstroLogic'; // exists but no SampleFiles/test_artifacts
        const r = resolveStoragePaths({ env, exists });
        expect(r.source).toBe('localappdata-default');
    });

    it('config present → its values win, missing keys filled from data_root', () => {
        const env = tmpEnv();
        const readConfig = () => ({ data_root: 'E:\\sky', index_root: 'F:\\bigindex\\g15u' });
        const r = resolveStoragePaths({ env, exists: () => true, readConfig });
        expect(r.source).toBe('config');
        expect(r.data_root).toBe('E:\\sky');
        expect(r.index_root).toBe('F:\\bigindex\\g15u'); // explicit override honored
        expect(r.intake_root).toBe(join('E:\\sky', 'intake')); // missing key filled
    });

    it('remap round-trip: write a remapped index_root, read it back', () => {
        const env = tmpEnv();
        const fresh = resolveStoragePaths({ env, exists: () => false });
        const remapped = { ...fresh, index_root: 'G:\\my quads\\g15u' };
        const written = writeStorageConfig(remapped, { env });
        expect(written).toBe(storageConfigPath(env));
        expect(existsSync(written)).toBe(true);
        const onDisk = JSON.parse(readFileSync(written, 'utf8'));
        expect(onDisk.version).toBe(STORAGE_CONFIG_VERSION);
        expect(onDisk.index_root).toBe('G:\\my quads\\g15u');
        // Resolve again from disk (no readConfig injection) → source config, remap survives.
        const reread = resolveStoragePaths({ env });
        expect(reread.source).toBe('config');
        expect(reread.index_root).toBe('G:\\my quads\\g15u');
    });

    it('ensureStorageConfig materializes defaults on a fresh machine only', () => {
        const env = tmpEnv();
        // Simulate a laptop: no dev root on D:. (This suite may run on the desktop
        // box where D:\AstroLogic really exists, so block that path explicitly and
        // delegate everything else — incl. the config file we write — to real fs.)
        const exists = (p) => (String(p).startsWith('D:\\AstroLogic') ? false : existsSync(p));
        const res = ensureStorageConfig({ env, exists });
        expect(res.created).toBe(true);
        expect(existsSync(storageConfigPath(env))).toBe(true);
        // Idempotent second call → not re-created.
        const res2 = ensureStorageConfig({ env, exists });
        expect(res2.created).toBe(false);
    });

    it('buildStorageConfig / subRootDefaults are self-consistent', () => {
        const defs = subRootDefaults('C:\\d');
        const cfg = buildStorageConfig({ data_root: 'C:\\d', ...defs });
        expect(cfg.version).toBe(STORAGE_CONFIG_VERSION);
        expect(cfg.index_root).toBe(join('C:\\d', 'index'));
    });
});
