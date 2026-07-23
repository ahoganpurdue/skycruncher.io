/**
 * save_fits.ts — browser Blob/anchor download for the FITS science export.
 *
 * Mirror of `save_asdf.ts`: the byte production lives in the shared,
 * dependency-free serializer `pipeline/export/fits_writer.ts`; this file is ONLY
 * the browser Blob/anchor/download mechanics. The Tauri desktop app uses a native
 * save dialog + fs.writeFile with the SAME serializer (see AnalysisPanel), and the
 * headless Node lane uses fs.writeFileSync — one implementation, three thin sinks.
 */

import { serializeFits, fitsFileName, type FitsImage } from '../../pipeline/export/fits_writer';
import pkg from '../../../../package.json';

/**
 * Serialize `receipt` + `image` to FITS bytes and trigger a browser download of
 * `${baseName}_${spatial_hash | timestamp}.fits`. Throws (no download) when the
 * receipt has no FITTED WCS — export law, surfaced by the serializer.
 */
export function saveFits(receipt: any, image: FitsImage, baseName = 'skycruncher'): void {
    const bytes = serializeFits(receipt, image, { libraryVersion: pkg.version });
    // serializeFits returns a fresh, exact-sized Uint8Array (offset 0), so its
    // backing ArrayBuffer IS the payload. (`.buffer` sidesteps the TS 5.7
    // Uint8Array<ArrayBufferLike> ↔ BlobPart generic mismatch.)
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fitsFileName(receipt, baseName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
