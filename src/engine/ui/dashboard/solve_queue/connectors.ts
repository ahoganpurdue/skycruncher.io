/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE QUEUE — source connector seam (RE-MAPPABLE ingest sources, R6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The bulk ingestor's source is re-mappable behind ONE interface: drop-files,
 * a local directory handle, the intake lane (fetch_intake's `Sample Files/…`
 * output layout, re-picked in-browser), and the bundled repo/demo picker. Plus
 * STUB Google Drive + Dropbox connectors — the UI card + a clean seam ONLY,
 * visibly marked STUB. Real OAuth lands post-Monday per
 * docs/OAUTH_DRIVE_INTAKE_DESIGN.md (drive.file + Google Picker for Drive; the
 * Dropbox Chooser for Dropbox — never a broad `drive.readonly` scope). The seam
 * here is shaped so wiring the real connector is a `status: 'stub' → 'ready'`
 * swap plus a `pick()` body, with NO change to the queue or the runner.
 *
 * Pure enough to unit-test: the connector registry, the supported-file filter,
 * the STUB rejection contract, and the directory enumerator (against a fake
 * async-iterable handle) all run under the node vitest env with no DOM.
 */

import { isSupportedFilename } from '../../../pipeline/m1_ingestion/format_registry';

/** Which source a connector represents. */
export type ConnectorKind =
    | 'drop'        // files dropped onto the pane
    | 'local-dir'   // a re-mappable local directory handle (File System Access API)
    | 'intake-dir'  // the intake lane (fetch_intake output), re-picked in-browser
    | 'repo-demo'   // bundled demo/sample files shipped in /demo
    | 'gdrive'      // Google Drive — STUB (real OAuth post-Monday)
    | 'dropbox';    // Dropbox — STUB (real Chooser post-Monday)

/**
 * Availability of a connector, honestly surfaced on its card:
 *  - `ready`       usable now.
 *  - `unavailable` the browser lacks the capability (e.g. no File System Access
 *                  API) — honest, not hidden.
 *  - `stub`        a designed seam with no live implementation yet (OAuth pending).
 */
export type ConnectorStatus = 'ready' | 'unavailable' | 'stub';

/** One selectable/ingestable file, with LAZY byte access (read only when it runs). */
export interface SourceFile {
    /** Filename (drives the format-registry classification + display). */
    name: string;
    /** Byte size (honest; 0 when the source cannot report it). */
    sizeBytes: number;
    /** Read the bytes — invoked by the runner exactly when the item runs (never eagerly). */
    read: () => Promise<ArrayBuffer>;
    /**
     * Absolute on-disk path — present ONLY for real local desktop sources (the
     * Tauri-native directory pick). Undefined for browser drop / demo-fetch /
     * File System Access sources, which have no OS path. Drives the live-stack
     * acceptance sidecar (written next to the frame on solve; see SolveQueuePane).
     */
    path?: string;
}

/** Raised by a STUB connector's `pick()` so the pane renders an honest notice. */
export class ConnectorStubError extends Error {
    readonly connectorId: ConnectorKind;
    constructor(connectorId: ConnectorKind, message: string) {
        super(message);
        this.name = 'ConnectorStubError';
        this.connectorId = connectorId;
    }
}

export interface SourceConnector {
    id: ConnectorKind;
    /** Card title. */
    displayName: string;
    /** One-line honest description (what it does / where it points). */
    description: string;
    status: ConnectorStatus;
    /** Honest availability / stub note shown under the card. */
    note: string;
    /**
     * Present the picker (or enumerate) and resolve the chosen files. STUB
     * connectors REJECT with a ConnectorStubError (never a fabricated file).
     */
    pick: () => Promise<SourceFile[]>;
}

/** Keep only files the ingestion format registry knows (by extension). */
export function filterSupportedFiles(files: readonly SourceFile[]): SourceFile[] {
    return files.filter((f) => isSupportedFilename(f.name));
}

// ─────────────────────────────────────────────────────────────────────────────
// File System Access API — feature detection + directory enumeration
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal structural shape of a FileSystemDirectoryHandle we depend on. */
export interface DirectoryHandleLike {
    /** Async-iterate [name, handle] entries (the FS Access API contract). */
    entries: () => AsyncIterable<[string, FileHandleLike]>;
}
export interface FileHandleLike {
    kind: 'file' | 'directory';
    name: string;
    getFile: () => Promise<{ size: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
    /** Absolute on-disk path when known (Tauri-native pick); undefined in the browser. */
    path?: string;
}

/** True when the browser exposes `showDirectoryPicker` (Chromium-family). */
export function isDirectoryPickerAvailable(): boolean {
    return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Enumerate a directory handle's immediate file children into SourceFiles
 * (non-recursive — the intake/local lanes are flat capture folders). PURE
 * w.r.t. the DOM: it only walks the provided handle, so a fake async-iterable
 * exercises it in tests. Directories among the entries are skipped.
 */
export async function enumerateDirectory(handle: DirectoryHandleLike): Promise<SourceFile[]> {
    const out: SourceFile[] = [];
    for await (const [, entry] of handle.entries()) {
        if (entry.kind !== 'file') continue;
        out.push({
            name: entry.name,
            sizeBytes: 0, // filled lazily on read when the File is materialized
            read: async () => {
                const file = await entry.getFile();
                return file.arrayBuffer();
            },
            path: entry.path, // undefined in the browser; set for Tauri-native picks
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri desktop — dialog-granted directory access (owner ruling 2026-07-10)
// ─────────────────────────────────────────────────────────────────────────────

/** True only inside the Tauri desktop shell (mirrors src/desktop/updater.ts). */
export function isTauriRuntime(): boolean {
    return typeof globalThis !== 'undefined'
        && !!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Injectable seams for the Tauri-native directory pick (node-testable). */
export interface TauriDirDeps {
    /** plugin-dialog `open({ directory: true })` — picked dir path, or null on cancel. */
    openDialog: (opts: { directory: true; multiple: false; title?: string }) => Promise<string | string[] | null>;
    /** plugin-fs `readDir` — immediate children of the granted directory. */
    readDir: (dir: string) => Promise<{ name: string; isFile: boolean }[]>;
    /** plugin-fs `readFile` — bytes of one file under the granted directory. */
    readFile: (path: string) => Promise<Uint8Array>;
    /** `@tauri-apps/api/path` join (OS-correct separator). */
    join: (...parts: string[]) => Promise<string>;
}

async function loadTauriDirDeps(): Promise<TauriDirDeps> {
    const [dialog, fs, path] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
        import('@tauri-apps/api/path'),
    ]);
    return { openDialog: dialog.open, readDir: fs.readDir, readFile: fs.readFile, join: path.join };
}

/**
 * Present the NATIVE folder picker and adapt the granted directory to
 * `DirectoryHandleLike`, so `enumerateDirectory` and the whole connector seam
 * stay identical between the browser (File System Access API) and desktop paths.
 *
 * SECURITY MODEL (owner ruling 2026-07-10): the capability file configures NO
 * fs scope — this pick IS the grant. tauri-plugin-dialog adds the chosen
 * directory to the fs scope at pick time (non-recursive: the folder + its
 * immediate children — exactly what the flat-capture-folder enumerator reads)
 * and tauri-plugin-persisted-scope carries the grant across restarts. Picking
 * more folders accumulates more grants; nothing else is readable.
 *
 * Cancel rejects AbortError-shaped (the pane already silences that name).
 */
export async function openTauriDirectory(deps?: TauriDirDeps): Promise<DirectoryHandleLike> {
    const d = deps ?? (await loadTauriDirDeps());
    const picked = await d.openDialog({ directory: true, multiple: false, title: 'Pick an input folder' });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) {
        const abort = new Error('folder pick cancelled');
        abort.name = 'AbortError';
        throw abort;
    }
    return {
        entries: async function* () {
            for (const entry of await d.readDir(dir)) {
                if (!entry.isFile) continue;
                // Absolute path under the dialog-GRANTED directory — carried onto
                // the handle so a solved queue item can write its live-stack
                // acceptance sidecar next to this exact frame (desktop only).
                const fullPath = await d.join(dir, entry.name);
                const handle: FileHandleLike = {
                    kind: 'file',
                    name: entry.name,
                    path: fullPath,
                    getFile: async () => {
                        const bytes = await d.readFile(fullPath);
                        return {
                            size: bytes.byteLength,
                            arrayBuffer: async () =>
                                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
                        };
                    },
                };
                yield [entry.name, handle] as [string, FileHandleLike];
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Real connectors
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap dropped `File`s as a connector-shaped result (used by the drop zone). */
export function filesToSourceFiles(files: readonly { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }[]): SourceFile[] {
    return files.map((f) => ({ name: f.name, sizeBytes: f.size, read: () => f.arrayBuffer() }));
}

/**
 * A re-mappable local-directory connector. `label`/`description` let the same
 * factory serve both the generic "Local Folder" card and the "Intake Folder"
 * preset (which points the user at fetch_intake's `Sample Files/…` lane). The
 * directory picker is injectable so the connector is testable without a browser.
 *
 * Picker resolution order: injected (tests) → Tauri-native dialog (desktop —
 * the pick doubles as the fs scope GRANT, see `openTauriDirectory`) → the
 * File System Access API (browser). The desktop shell is checked FIRST because
 * only the native dialog produces the persisted scope grant the hardened
 * capability model requires (its webview may also expose `showDirectoryPicker`,
 * but that path would yield handles without any Tauri fs grant semantics).
 */
export function makeDirectoryConnector(opts: {
    id: 'local-dir' | 'intake-dir';
    displayName: string;
    description: string;
    note: string;
    /** Injectable picker (defaults to Tauri dialog, then the File System Access API). */
    openPicker?: () => Promise<DirectoryHandleLike>;
}): SourceConnector {
    const tauri = isTauriRuntime();
    const available = opts.openPicker != null || tauri || isDirectoryPickerAvailable();
    const openPicker =
        opts.openPicker ??
        (tauri
            ? () => openTauriDirectory()
            : async () => {
                const g = globalThis as { showDirectoryPicker?: () => Promise<DirectoryHandleLike> };
                if (!g.showDirectoryPicker) throw new Error('Directory picker unavailable in this browser');
                return g.showDirectoryPicker();
            });
    return {
        id: opts.id,
        displayName: opts.displayName,
        description: opts.description,
        status: available ? 'ready' : 'unavailable',
        note: available ? opts.note : 'This browser has no File System Access API — use drag-and-drop instead.',
        pick: async () => {
            const handle = await openPicker();
            return filterSupportedFiles(await enumerateDirectory(handle));
        },
    };
}

/**
 * The bundled repo/demo connector: the sample frames shipped in `/demo` (the
 * same fetch the single-file "Load Sample" button uses). `fetchFn` is injectable
 * for tests; the demo manifest is static (the two pinned reference frames).
 */
export function makeRepoDemoConnector(opts?: {
    fetchFn?: (url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>;
    manifest?: { name: string; url: string }[];
}): SourceConnector {
    const fetchFn =
        opts?.fetchFn ??
        ((url: string) => (globalThis as { fetch: (u: string) => Promise<Response> }).fetch(url));
    const manifest = opts?.manifest ?? [
        { name: 'seestar_m66_sample.fit', url: '/demo/seestar_m66_sample.fit' },
        { name: 'sample_observation.cr2', url: '/demo/sample_observation.cr2' },
    ];
    return {
        id: 'repo-demo',
        displayName: 'Bundled Demo Frames',
        description: 'The pinned reference captures shipped with the app (SeeStar FITS + Canon CR2).',
        status: 'ready',
        note: `${manifest.length} bundled frame${manifest.length === 1 ? '' : 's'} from /demo.`,
        pick: async () => {
            const out: SourceFile[] = [];
            for (const { name, url } of manifest) {
                out.push({
                    name,
                    sizeBytes: 0,
                    read: async () => {
                        const res = await fetchFn(url);
                        if (!res.ok) throw new Error(`Bundled demo fetch failed: ${url}`);
                        return res.arrayBuffer();
                    },
                });
            }
            return filterSupportedFiles(out);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// STUB connectors (UI + seam only — real OAuth per OAUTH_DRIVE_INTAKE_DESIGN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Google Drive — STUB. Real connector is `drive.file` + the Google Picker
 * (never `drive.readonly`): the user picks a folder in a Google-rendered picker
 * and we enumerate its children under that grant. Wiring it = swap `status` to
 * `ready` and implement `pick()` to return the picked files as SourceFiles;
 * nothing else in the queue/runner changes.
 */
export function makeGoogleDriveStub(): SourceConnector {
    return {
        id: 'gdrive',
        displayName: 'Google Drive',
        description: 'Pick a Drive folder (drive.file + Google Picker) and ingest its captures.',
        status: 'stub',
        note: 'STUB — OAuth not wired yet (post-Monday, drive.file scope only). See OAUTH_DRIVE_INTAKE_DESIGN.',
        pick: async () => {
            throw new ConnectorStubError('gdrive', 'Google Drive connector is a stub — real OAuth lands post-Monday.');
        },
    };
}

/**
 * Dropbox — STUB. Real connector is the Dropbox Chooser (the user picks
 * files/a folder in Dropbox's own UI; no broad-scope grant). Same swap shape as
 * the Drive stub.
 */
export function makeDropboxStub(): SourceConnector {
    return {
        id: 'dropbox',
        displayName: 'Dropbox',
        description: 'Pick files or a folder via the Dropbox Chooser and ingest them.',
        status: 'stub',
        note: 'STUB — Dropbox Chooser not wired yet (post-Monday). Same seam as Google Drive.',
        pick: async () => {
            throw new ConnectorStubError('dropbox', 'Dropbox connector is a stub — real Chooser lands post-Monday.');
        },
    };
}

/**
 * The connector registry the pane renders as source cards. Order = display
 * order: the ready local/intake/demo sources first, the STUB cloud connectors
 * last. `drop` is not a card (it is the always-on drop zone) so it is omitted.
 */
export function buildConnectors(): SourceConnector[] {
    return [
        makeDirectoryConnector({
            id: 'local-dir',
            displayName: 'Local Folder',
            description: 'Pick any folder on this machine; every supported frame in it is queued.',
            note: 'Re-mappable — pick a different folder any time.',
        }),
        makeDirectoryConnector({
            id: 'intake-dir',
            displayName: 'Intake Folder',
            description: 'Point at the fetch_intake lane (e.g. "Sample Files/rotating") to queue harvested captures.',
            note: 'Re-mappable intake lane (fetch_intake output layout).',
        }),
        makeRepoDemoConnector(),
        makeGoogleDriveStub(),
        makeDropboxStub(),
    ];
}
