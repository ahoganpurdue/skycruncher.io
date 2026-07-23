import { describe, it, expect } from 'vitest';
import {
    subRootDefaults,
    withDefaults,
    resolvePathsFromConfig,
    buildStorageConfig,
    defaultDataRoot,
    joinPath,
    isTauriRuntime,
    STORAGE_CONFIG_VERSION,
} from './storagePaths';

describe('storagePaths (app-side pure helpers, mirror of tools/config)', () => {
    it('joinPath preserves the base separator style', () => {
        expect(joinPath('C:\\a\\b', 'c', 'd')).toBe('C:\\a\\b\\c\\d');
        expect(joinPath('C:\\a\\b\\', 'c')).toBe('C:\\a\\b\\c'); // trailing sep trimmed
        expect(joinPath('/home/x', 'y')).toBe('/home/x/y');
    });

    it('fresh machine → all sub-roots under data_root', () => {
        const appLocal = 'C:\\Users\\me\\AppData\\Local\\io.skycruncher.app';
        const dataRoot = defaultDataRoot(appLocal);
        expect(dataRoot).toBe('C:\\Users\\me\\AppData\\Local\\io.skycruncher.app\\data');
        const { source, roots } = resolvePathsFromConfig(null, appLocal);
        expect(source).toBe('localappdata-default');
        expect(roots.index_root).toBe(joinPath(dataRoot, 'index'));
        expect(roots.intake_root).toBe(joinPath(dataRoot, 'intake'));
        expect(roots.capture_root).toBe(joinPath(dataRoot, 'capture'));
        expect(roots.atlas_root).toBe(joinPath(dataRoot, 'atlas'));
        expect(roots.export_root).toBe(joinPath(dataRoot, 'exports'));
    });

    it('config present → its values win, missing keys filled', () => {
        const appLocal = 'C:\\Users\\me\\AppData\\Local\\io.skycruncher.app';
        const { source, roots } = resolvePathsFromConfig(
            { data_root: 'E:\\sky', index_root: 'F:\\big\\g15u', version: 1 },
            appLocal,
        );
        expect(source).toBe('config');
        expect(roots.data_root).toBe('E:\\sky');
        expect(roots.index_root).toBe('F:\\big\\g15u'); // explicit override
        expect(roots.capture_root).toBe(joinPath('E:\\sky', 'capture')); // filled default
    });

    it('withDefaults fills only the missing keys (remap of one root)', () => {
        const roots = withDefaults('D:\\data', { index_root: 'X:\\remapped' });
        expect(roots.index_root).toBe('X:\\remapped');
        expect(roots.intake_root).toBe(joinPath('D:\\data', 'intake'));
    });

    it('buildStorageConfig round-trips through resolvePathsFromConfig', () => {
        const appLocal = 'C:\\app';
        const roots = withDefaults(defaultDataRoot(appLocal));
        const cfg = buildStorageConfig(roots);
        expect(cfg.version).toBe(STORAGE_CONFIG_VERSION);
        const back = resolvePathsFromConfig(cfg, appLocal);
        expect(back.source).toBe('config');
        expect(back.roots).toEqual(roots);
    });

    it('isTauriRuntime is false under vitest/node (no Tauri window)', () => {
        expect(isTauriRuntime()).toBe(false);
    });
});
