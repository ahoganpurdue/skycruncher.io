/**
 * save_packet.ts — download the AstroPacket as a JSON receipt.
 *
 * Per the ROADMAP "Science-layer outputs" decision (owner-set 2026-07-05):
 * the AstroPacket is demoted to an internal result model / JSON receipt.
 * FITS, ASDF and C2PA-certified exports are the real deliverables (Phase D/S);
 * this receipt is the honest interim export.
 *
 * Serialization (typed-array stripping replacer, file naming) lives in the
 * pure module `stages/receipt_serializer.ts` (I0.2) — this file is ONLY the
 * browser Blob/anchor/download mechanics.
 */

import { serializeReceipt, receiptFileName } from '../../pipeline/stages/receipt_serializer';

/**
 * Serialize the packet (minus heavy buffers) and trigger a browser download
 * of `${baseName}_${spatial_hash | timestamp}.json`.
 */
export function savePacket(packet: any, baseName = 'skycruncher_receipt'): void {
    const json = serializeReceipt(packet);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = receiptFileName(packet, baseName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
