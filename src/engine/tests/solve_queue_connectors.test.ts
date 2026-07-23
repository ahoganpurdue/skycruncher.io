import { describe, it, expect } from 'vitest';
import {
    buildConnectors,
    filterSupportedFiles,
    enumerateDirectory,
    makeDirectoryConnector,
    makeRepoDemoConnector,
    makeGoogleDriveStub,
    makeDropboxStub,
    ConnectorStubError,
    isDirectoryPickerAvailable,
    isTauriRuntime,
    openTauriDirectory,
    filesToSourceFiles,
    type SourceFile,
    type DirectoryHandleLike,
    type FileHandleLike,
    type TauriDirDeps,
} from '../ui/dashboard/solve_queue/connectors';

// ── fakes (no DOM / no File System Access API in the node vitest env) ──
function fakeFile(name: string, bytes: number[]): FileHandleLike {
    return {
        kind: 'file',
        name,
        getFile: async () => ({ size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer }),
    };
}
function fakeSubdir(name: string): FileHandleLike {
    return { kind: 'directory', name, getFile: async () => { throw new Error('is a directory'); } };
}
function fakeDirHandle(entries: FileHandleLike[]): DirectoryHandleLike {
    return {
        entries: async function* () {
            for (const e of entries) yield [e.name, e] as [string, FileHandleLike];
        },
    };
}

describe('solve queue — connector seam', () => {
    it('registry lists ready local/intake/demo sources + STUB cloud connectors', () => {
        const cs = buildConnectors();
        const byId = Object.fromEntries(cs.map((c) => [c.id, c]));
        expect(Object.keys(byId).sort()).toEqual(['dropbox', 'gdrive', 'intake-dir', 'local-dir', 'repo-demo']);
        // Cloud connectors are honestly marked STUB (not hidden, not faked).
        expect(byId['gdrive'].status).toBe('stub');
        expect(byId['dropbox'].status).toBe('stub');
        expect(byId['repo-demo'].status).toBe('ready');
        // The stub note references the post-Monday OAuth plan.
        expect(byId['gdrive'].note).toMatch(/stub/i);
    });

    it('STUB connectors reject with a marked ConnectorStubError (never a fabricated file)', async () => {
        await expect(makeGoogleDriveStub().pick()).rejects.toBeInstanceOf(ConnectorStubError);
        await expect(makeDropboxStub().pick()).rejects.toBeInstanceOf(ConnectorStubError);
        try {
            await makeGoogleDriveStub().pick();
        } catch (e) {
            expect((e as ConnectorStubError).connectorId).toBe('gdrive');
        }
    });

    it('filterSupportedFiles keeps only ingestable formats', () => {
        const files: SourceFile[] = [
            { name: 'a.fits', sizeBytes: 1, read: async () => new ArrayBuffer(0) },
            { name: 'b.cr2', sizeBytes: 1, read: async () => new ArrayBuffer(0) },
            { name: 'c.png', sizeBytes: 1, read: async () => new ArrayBuffer(0) },  // unsupported (JPEG/TIFF now demo-tier)
            { name: 'readme.txt', sizeBytes: 1, read: async () => new ArrayBuffer(0) },
        ];
        expect(filterSupportedFiles(files).map((f) => f.name)).toEqual(['a.fits', 'b.cr2']);
    });

    it('enumerateDirectory yields file children and skips subdirectories', async () => {
        const handle = fakeDirHandle([
            fakeFile('one.fits', [1, 2, 3]),
            fakeSubdir('calibration'),
            fakeFile('two.cr2', [4, 5]),
        ]);
        const files = await enumerateDirectory(handle);
        expect(files.map((f) => f.name)).toEqual(['one.fits', 'two.cr2']);
        // Lazy read materializes the bytes only when invoked.
        const buf = await files[0].read();
        expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('directory connector with injected picker enumerates + filters', async () => {
        const conn = makeDirectoryConnector({
            id: 'local-dir',
            displayName: 'Local Folder',
            description: 'x',
            note: 'y',
            openPicker: async () =>
                fakeDirHandle([fakeFile('m66.fits', [0]), fakeFile('thumb.png', [0]), fakeFile('IMG.cr2', [0])]),
        });
        expect(conn.status).toBe('ready'); // injected picker ⇒ available
        const picked = await conn.pick();
        expect(picked.map((f) => f.name)).toEqual(['m66.fits', 'IMG.cr2']); // .png filtered out
    });

    it('directory connector is honestly "unavailable" when no picker exists (node env)', () => {
        // node has no showDirectoryPicker, and no injected picker ⇒ unavailable.
        expect(isDirectoryPickerAvailable()).toBe(false);
        const conn = makeDirectoryConnector({ id: 'intake-dir', displayName: 'Intake', description: 'x', note: 'y' });
        expect(conn.status).toBe('unavailable');
        expect(conn.note).toMatch(/File System Access API/);
    });

    it('repo-demo connector reads via the injected fetch', async () => {
        const seen: string[] = [];
        const conn = makeRepoDemoConnector({
            manifest: [{ name: 'demo.fits', url: '/demo/demo.fits' }],
            fetchFn: async (url) => {
                seen.push(url);
                return { ok: true, arrayBuffer: async () => new Uint8Array([9, 9]).buffer };
            },
        });
        expect(conn.status).toBe('ready');
        const files = await conn.pick();
        expect(files).toHaveLength(1);
        const buf = await files[0].read();
        expect(seen).toEqual(['/demo/demo.fits']);
        expect(new Uint8Array(buf)).toEqual(new Uint8Array([9, 9]));
    });

    it('filesToSourceFiles wraps dropped Files with lazy read', async () => {
        const dropped = [
            { name: 'x.fits', size: 3, arrayBuffer: async () => new Uint8Array([7, 7, 7]).buffer },
        ];
        const src = filesToSourceFiles(dropped);
        expect(src[0].sizeBytes).toBe(3);
        expect(new Uint8Array(await src[0].read())).toEqual(new Uint8Array([7, 7, 7]));
    });
});

// ── Tauri desktop path (dialog-granted, persisted fs scope — owner ruling 2026-07-10) ──
function fakeTauriDeps(
    files: Record<string, number[]>,
    opts?: { cancel?: boolean; subdirs?: string[] },
): { deps: TauriDirDeps; reads: string[] } {
    const reads: string[] = [];
    const deps: TauriDirDeps = {
        openDialog: async () => (opts?.cancel ? null : 'C:/captures/session1'),
        readDir: async () => [
            ...Object.keys(files).map((name) => ({ name, isFile: true })),
            ...(opts?.subdirs ?? []).map((name) => ({ name, isFile: false })),
        ],
        readFile: async (p) => {
            reads.push(p);
            return new Uint8Array(files[p.split('/').pop() as string]);
        },
        join: async (...parts) => parts.join('/'),
    };
    return { deps, reads };
}

describe('solve queue — Tauri desktop directory connector (dialog-granted scope)', () => {
    it('adapts the dialog-picked folder to the same seam: enumerate, filter, LAZY read under the granted dir only', async () => {
        const { deps, reads } = fakeTauriDeps(
            { 'm66.fits': [1, 2], 'notes.txt': [3], 'IMG.cr2': [4, 5, 6] },
            { subdirs: ['calibration'] },
        );
        const conn = makeDirectoryConnector({
            id: 'local-dir',
            displayName: 'Local Folder',
            description: 'x',
            note: 'y',
            openPicker: () => openTauriDirectory(deps),
        });
        const picked = await conn.pick();
        // .txt filtered by the format registry; the subdirectory entry skipped.
        expect(picked.map((f) => f.name)).toEqual(['m66.fits', 'IMG.cr2']);
        // LAZY: picking grants + enumerates but reads NOTHING.
        expect(reads).toEqual([]);
        const buf = await (picked.find((f) => f.name === 'IMG.cr2') as SourceFile).read();
        expect(new Uint8Array(buf)).toEqual(new Uint8Array([4, 5, 6]));
        // Every read path is joined under the dialog-GRANTED directory.
        expect(reads).toEqual(['C:/captures/session1/IMG.cr2']);
        // Each Tauri-picked SourceFile carries its absolute on-disk path — the
        // live-stack acceptance sidecar is written next to exactly this frame.
        expect(picked.map((f) => f.path)).toEqual([
            'C:/captures/session1/m66.fits',
            'C:/captures/session1/IMG.cr2',
        ]);
    });

    it('cancel rejects AbortError-shaped (the pane silences that name — no fake notice)', async () => {
        const { deps } = fakeTauriDeps({}, { cancel: true });
        await expect(openTauriDirectory(deps)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('isTauriRuntime is false in node — browser builds keep the File System Access path', () => {
        expect(isTauriRuntime()).toBe(false);
    });
});
