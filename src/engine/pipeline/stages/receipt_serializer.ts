/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RECEIPT SERIALIZER — pure JSON serialization of the wizard receipt
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure serialization — no DOM, no session reach-back).
 *
 * Extracted from `src/engine/ui/utils/save_packet.ts` (I0.2, Toolchest API
 * wave) so headless consumers (tools/api drivers, future npm package) can
 * produce the EXACT bytes the browser download produces, without importing
 * Blob/anchor mechanics. `save_packet.ts` delegates here — one
 * implementation, two callers.
 */

/**
 * Heavy / non-JSON-safe fields dropped wherever they appear in the packet.
 * These are typed arrays (Float32Array / Uint16Array / etc.) which
 * JSON.stringify would expand into hundreds of MB of index-keyed objects.
 */
export const DROPPED_KEYS = new Set([
    'scienceBuffer',
    'segmentationMasks',
    'horizonVector',
    'anomaly_grid',
    // 2026-07-10 (ultracode G6): SignalPacket.scattering_profile (Float32Array,
    // Main_types.ts) is reachable via package.ts but never populated by any stage
    // today — adding it here is byte-neutral for every existing receipt, and
    // guards against a future producer exploding the JSON into index-keyed MBs.
    'scattering_profile',
]);

/** JSON.stringify replacer: strips the heavy typed-array keys above. */
export function receiptReplacer(key: string, value: any): any {
    return DROPPED_KEYS.has(key) ? undefined : value;
}

/** Serialize the receipt (minus heavy buffers) — the canonical receipt bytes. */
export function serializeReceipt(packet: any): string {
    return JSON.stringify(packet, receiptReplacer, 2);
}

/** Canonical receipt file name: `${baseName}_${spatial_hash | timestamp}.json`. */
export function receiptFileName(packet: any, baseName = 'skycruncher_receipt'): string {
    return `${baseName}_${packet?.solution?.spatial_hash ?? Date.now()}.json`;
}
