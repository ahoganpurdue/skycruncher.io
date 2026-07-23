/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKYWORKSPACE FILE I/O — the platform seam (Tauri desktop · browser fallback)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Desktop-first (task §1). On the Tauri shell, export goes through the native
 * SAVE dialog + `plugin-fs` `writeFile`; import through the native OPEN dialog +
 * `readFile`. Both fs commands (`fs:allow-write-file` / `fs:allow-read-file`) and
 * `dialog:default` (open + save) are already granted, and the dialog pick auto-
 * grants fs scope for the chosen path (mirrors `connectors.ts:openTauriDirectory`).
 * `writeFile` (bytes) is used deliberately — `writeTextFile` needs an ungranted
 * permission (same reasoning as `SolveQueuePane.tsx:163-168`).
 *
 * Browser fallback (trivial, so included): export = an `<a download>` Blob click;
 * import = a hidden `<input type=file>`. No File System Access API needed.
 *
 * This module is a THIN I/O seam only — all envelope logic + validation lives in
 * the pure `workspace_file.ts`. Kept out of that module so the pure logic stays
 * headless-testable. Never throws for a user cancel: returns a `cancelled` shape.
 *
 * Ledger: RENDER PLANE — display-surface persistence only.
 */

import { isTauriRuntime } from '../../dashboard/solve_queue/connectors';
import { SKYWORKSPACE_DEFAULT_FILENAME, SKYWORKSPACE_EXT } from './workspace_file';

export type ExportResult =
    | { status: 'saved'; path?: string }
    | { status: 'cancelled' };

export type ImportResult =
    | { status: 'loaded'; text: string; name: string }
    | { status: 'cancelled' };

const DIALOG_FILTER = { name: 'SkyCruncher workspace', extensions: [SKYWORKSPACE_EXT, 'json'] };

// ─── Export ─────────────────────────────────────────────────────────────────

async function exportViaTauri(text: string, filename: string): Promise<ExportResult> {
    const [{ save }, { writeFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ defaultPath: filename, filters: [DIALOG_FILTER], title: 'Export workspace' });
    if (!path) return { status: 'cancelled' };
    // Bytes, not text — `write_file` is the granted command (write_text_file is not).
    await writeFile(path, new TextEncoder().encode(text));
    return { status: 'saved', path };
}

function exportViaBrowser(text: string, filename: string): ExportResult {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // Revoke on the next tick so the click's navigation has consumed the URL.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return { status: 'saved' };
}

/** Write `text` to a `.skyworkspace.json` the user picks (desktop) / downloads (browser). */
export async function exportWorkspaceFile(
    text: string,
    filename: string = SKYWORKSPACE_DEFAULT_FILENAME,
): Promise<ExportResult> {
    if (isTauriRuntime()) return exportViaTauri(text, filename);
    return exportViaBrowser(text, filename);
}

// ─── Import ─────────────────────────────────────────────────────────────────

async function importViaTauri(): Promise<ImportResult> {
    const [{ open }, { readFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
    ]);
    const picked = await open({ multiple: false, directory: false, filters: [DIALOG_FILTER], title: 'Import workspace' });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return { status: 'cancelled' };
    // The dialog pick grants fs read scope for this exact path (persisted-scope).
    const bytes = await readFile(path);
    const name = path.replace(/^.*[\\/]/, '');
    return { status: 'loaded', text: new TextDecoder().decode(bytes), name };
}

function importViaBrowser(): Promise<ImportResult> {
    return new Promise<ImportResult>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = `.${SKYWORKSPACE_EXT},.json,application/json`;
        // A cancelled file dialog fires no 'change'; 'cancel' (where supported) or a
        // window refocus with no file resolves as cancelled. Keep it simple: resolve
        // cancelled if no file was chosen by the time change fires.
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) { resolve({ status: 'cancelled' }); return; }
            const reader = new FileReader();
            reader.onload = () => resolve({ status: 'loaded', text: String(reader.result ?? ''), name: file.name });
            reader.onerror = () => resolve({ status: 'cancelled' });
            reader.readAsText(file);
        });
        input.addEventListener('cancel', () => resolve({ status: 'cancelled' }));
        input.click();
    });
}

/** Prompt for a `.skyworkspace.json` and return its TEXT (validation is the caller's job). */
export async function importWorkspaceFile(): Promise<ImportResult> {
    if (isTauriRuntime()) return importViaTauri();
    return importViaBrowser();
}
