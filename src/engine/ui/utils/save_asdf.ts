/**
 * save_asdf.ts — browser Blob/anchor download for the ASDF science export.
 *
 * Mirror of `save_packet.ts` (JSON receipt): the byte production lives in the
 * shared, dependency-free serializer `pipeline/export/asdf_writer.ts`; this file
 * is ONLY the browser Blob/anchor/download mechanics. The Tauri desktop app
 * uses a native save dialog + fs.writeFile with the SAME serializer (see
 * AnalysisPanel), and the headless Node lane uses fs.writeFileSync — one
 * implementation, three thin sinks.
 */

import { serializeAsdf, asdfFileName, type AsdfImage } from '../../pipeline/export/asdf_writer';
import pkg from '../../../../package.json';

/**
 * Serialize `receipt` + `image` to ASDF bytes and trigger a browser download of
 * `${baseName}_${spatial_hash | timestamp}.asdf`.
 */
export function saveAsdf(receipt: any, image: AsdfImage, baseName = 'skycruncher'): void {
    const bytes = serializeAsdf(receipt, image, { libraryVersion: pkg.version });
    // serializeAsdf returns a fresh, exact-sized Uint8Array (offset 0), so its
    // backing ArrayBuffer IS the payload. (`.buffer` sidesteps the TS 5.7
    // Uint8Array<ArrayBufferLike> ↔ BlobPart generic mismatch.)
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = asdfFileName(receipt, baseName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
