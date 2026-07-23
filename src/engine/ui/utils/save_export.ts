/**
 * save_export.ts — the UNIFIED export dispatcher + availability matrix.
 *
 * One surface for every export format. Wraps the three existing thin sinks
 * (receipt JSON / FITS / ASDF) plus the Arrow tabular products, and picks the
 * runtime write path (Tauri native save-dialog + fs.writeFile on desktop; a
 * Blob/anchor download in the browser). The step-7 selector and the desktop
 * AnalysisPanel both call this so there is exactly one place that knows how a
 * format is written.
 *
 * LAW 3 (honest-or-absent): `exportAvailability` returns a DISABLED row + a human
 * reason for any format the current run cannot honestly produce (no fitted WCS,
 * no science frame, nothing run yet). PNG / C2PA are shown as `coming` — declared,
 * disabled, NOT faked.
 *
 * Byte production is NOT re-implemented here: FITS/ASDF bytes come from the shared
 * dependency-free serializers (`pipeline/export/*`), Arrow bytes from the
 * @skycruncher/toolchest producer — this module is only the format registry,
 * availability logic, and the download/save mechanics.
 */

import { serializeReceipt, receiptFileName } from '../../pipeline/stages/receipt_serializer';
import { serializeFits, fitsFileName, type FitsImage } from '../../pipeline/export/fits_writer';
import { serializeAsdf, asdfFileName, type AsdfImage } from '../../pipeline/export/asdf_writer';
import { isTauriRuntime } from '../dashboard/solve_queue/connectors';
import pkg from '../../../../package.json';

export type ExportFormat = 'receipt' | 'fits' | 'asdf' | 'arrow' | 'png' | 'c2pa';

export interface ExportFormatMeta {
    id: ExportFormat;
    label: string;
    /** Canonical file extension (Arrow emits several `${base}_${table}.arrow`). */
    ext: string;
    blurb: string;
    /** Declared-but-not-built (shown disabled, never faked). */
    coming?: boolean;
}

/** The export menu, in display order. PNG/C2PA are declared-coming (not built). */
export const EXPORT_FORMATS: ExportFormatMeta[] = [
    { id: 'receipt', label: 'JSON Receipt',    ext: 'json',  blurb: 'Full measurement receipt (always available post-run).' },
    { id: 'fits',    label: 'FITS',            ext: 'fits',  blurb: 'Science frame + fitted WCS header (astropy-conformant).' },
    { id: 'asdf',    label: 'ASDF',            ext: 'asdf',  blurb: 'Science frame + GWCS (fitted WCS + frame required).' },
    { id: 'arrow',   label: 'Arrow tables',    ext: 'arrow', blurb: 'Tabular products (matched stars · detections · forced · summary).' },
    { id: 'png',     label: 'PNG',             ext: 'png',   blurb: 'Rendered image export — coming (see roadmap).', coming: true },
    { id: 'c2pa',    label: 'C2PA-certified',  ext: 'c2pa',  blurb: 'Provenance-signed export — coming (see roadmap).', coming: true },
];

export interface ExportAvailabilityRow {
    available: boolean;
    /** null when available; a human reason when disabled (LAW 3). */
    reason: string | null;
    /** Declared-but-not-built row (always disabled). */
    coming: boolean;
}

/** A FITTED (star-verified) WCS is the FITS/ASDF export precondition — a
 *  SYNTHESIZED approximation is never written as science (fits_writer refuses). */
export function hasFittedWcs(receipt: any): boolean {
    return receipt?.wcs?.SOURCE === 'FITTED';
}

const NO_RUN = 'Run the pipeline first — no receipt yet.';
const NO_WCS = 'Requires a fitted WCS (no plate solution to write).';
const NO_FRAME = 'Requires the science frame in memory.';
const NO_RENDER = 'No rendered view to export yet.';
const PNG_COMING = 'PNG export — coming (see roadmap).';

/**
 * The availability matrix for the current run. Pure over the receipt + a
 * `hasImage` flag (the science frame lives on the session, not the receipt).
 * receipt/arrow need only a completed run; FITS/ASDF need a fitted WCS AND the
 * science frame; PNG/C2PA are declared-coming.
 */
export function exportAvailability(
    receipt: any,
    opts?: { hasImage?: boolean; hasRender?: boolean },
): Record<ExportFormat, ExportAvailabilityRow> {
    const hasReceipt = receipt != null;
    const fitted = hasFittedWcs(receipt);
    const hasImage = !!opts?.hasImage;
    // A rendered display canvas (the STF-stretched preview shown at the payoff
    // view) makes the render-plane PNG a real, honest export. Absent one, PNG
    // stays declared-coming exactly as before (headless / desktop AnalysisPanel).
    const hasRender = !!opts?.hasRender;
    const row = (available: boolean, reason: string | null, coming = false): ExportAvailabilityRow =>
        ({ available, reason, coming });

    // FITS/ASDF share the same preconditions; the reason surfaces the FIRST
    // unmet one (no run → no WCS → no frame).
    const scienceRow = (): ExportAvailabilityRow =>
        !hasReceipt ? row(false, NO_RUN)
        : !fitted ? row(false, NO_WCS)
        : !hasImage ? row(false, NO_FRAME)
        : row(true, null);

    return {
        receipt: hasReceipt ? row(true, null) : row(false, NO_RUN),
        fits: scienceRow(),
        asdf: scienceRow(),
        arrow: hasReceipt ? row(true, null) : row(false, NO_RUN),
        png: hasRender ? row(true, null, false) : row(false, PNG_COMING, true),
        c2pa: row(false, 'C2PA-certified export — coming (see roadmap).', true),
    };
}

// ─── download / save mechanics ─────────────────────────────────────────────────

/** Science frame for FITS/ASDF — the getExportImage() shape (compatible with both
 *  writers' image types). */
export type ExportImage = FitsImage & AsdfImage;

export interface SaveExportPayload {
    receipt: any;
    /** The measured science frame (session.getExportImage()); null when absent. */
    image?: ExportImage | null;
    /** Encoded bytes of the rendered display canvas (RENDER PLANE — a screenshot of
     *  exactly what is shown). Required for the 'png' format; null/absent otherwise. */
    renderPng?: Uint8Array | null;
    /** File-name stem (default per-format). */
    baseName?: string;
}

/**
 * Encode a display canvas to PNG bytes (RENDER PLANE). The canvas is a screenshot
 * of the STF-stretched preview shown at the payoff view — display-only, never a
 * science product. Rejects when the browser cannot produce a blob.
 */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('Canvas PNG encode failed.'))),
            'image/png',
        );
    });
    return new Uint8Array(await blob.arrayBuffer());
}

/** Trigger a browser download of `bytes` as `filename`. */
function browserDownload(bytes: Uint8Array | string, filename: string, mime: string): void {
    const part: BlobPart = typeof bytes === 'string'
        ? bytes
        : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const blob = new Blob([part], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** Native save dialog + fs.writeFile on the Tauri desktop shell (dynamic import
 *  so the browser bundle never loads the tauri plugins). Returns false when the
 *  user cancelled the dialog. */
async function tauriSave(bytes: Uint8Array | string, defaultName: string, ext: string): Promise<boolean> {
    const [dialog, fs] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
    ]);
    const filepath = await dialog.save({
        defaultPath: defaultName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!filepath) return false;
    const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    await fs.writeFile(filepath, payload);
    return true;
}

/** Write one artifact through the runtime-appropriate sink. */
async function writeArtifact(bytes: Uint8Array | string, filename: string, ext: string, mime: string): Promise<void> {
    if (isTauriRuntime()) {
        await tauriSave(bytes, filename, ext);
        return;
    }
    browserDownload(bytes, filename, mime);
}

/**
 * Export the current run in `format`. Throws with a human message when the format
 * is unavailable for this run (mirror the `exportAvailability` reasons) or when a
 * declared-coming format is requested.
 */
export async function saveExport(format: ExportFormat, payload: SaveExportPayload): Promise<void> {
    const { receipt, image, baseName, renderPng } = payload;

    // RENDER PLANE: the display PNG is a screenshot of what is shown. It consumes
    // no receipt/WCS, so it is written before the receipt guard the science
    // formats require (a preview can be saved even before final bundling).
    if (format === 'png') {
        if (!renderPng) throw new Error(`PNG export unavailable: ${NO_RENDER}`);
        const hash = receipt?.solution?.spatial_hash;
        const tag = typeof hash === 'string' && hash.length > 0 ? `_${hash}` : '';
        await writeArtifact(renderPng, `${baseName ?? 'skycruncher_view'}${tag}.png`, 'png', 'image/png');
        return;
    }

    if (receipt == null) throw new Error(NO_RUN);

    switch (format) {
        case 'receipt': {
            const json = serializeReceipt(receipt);
            await writeArtifact(json, receiptFileName(receipt, baseName ?? 'skycruncher_receipt'), 'json', 'application/json');
            return;
        }
        case 'fits': {
            if (!image) throw new Error(`FITS export unavailable: ${NO_FRAME}`);
            const bytes = serializeFits(receipt, image, { libraryVersion: pkg.version });
            await writeArtifact(bytes, fitsFileName(receipt, baseName ?? 'skycruncher'), 'fits', 'application/octet-stream');
            return;
        }
        case 'asdf': {
            if (!image) throw new Error(`ASDF export unavailable: ${NO_FRAME}`);
            const bytes = serializeAsdf(receipt, image, { libraryVersion: pkg.version });
            await writeArtifact(bytes, asdfFileName(receipt, baseName ?? 'skycruncher'), 'asdf', 'application/octet-stream');
            return;
        }
        case 'arrow': {
            // The @skycruncher/toolchest Arrow producer + apache-arrow IPC pull a
            // heavy dep — lazy-load it so it never bloats the base bundle. One
            // `.arrow` file per tabular product (keep-simple: sequential writes,
            // no zip dependency).
            const { exportAllTables, tableToArrowFileBytes } =
                await import('../../../../packages/toolchest/src/index');
            const stem = baseName ?? 'skycruncher';
            const hash = receipt?.solution?.spatial_hash;
            const tag = typeof hash === 'string' && hash.length > 0 ? hash : 'export';
            const tables = exportAllTables(receipt);
            for (const [name, table] of Object.entries(tables)) {
                const bytes = tableToArrowFileBytes(table);
                await writeArtifact(bytes, `${stem}_${tag}_${name}.arrow`, 'arrow', 'application/vnd.apache.arrow.file');
            }
            return;
        }
        case 'c2pa':
            throw new Error(`${format.toUpperCase()} export is not available yet (coming — see roadmap).`);
        default: {
            // Exhaustiveness guard.
            const _never: never = format;
            throw new Error(`unknown export format: ${_never}`);
        }
    }
}
