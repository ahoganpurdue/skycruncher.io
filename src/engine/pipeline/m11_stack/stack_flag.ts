/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M11 STACK FLAG — the single switch for the dither/drizzle stacking lane
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DEFAULT OFF. `VITE_STACK_ENABLED=1` (or 'true') turns the multi-frame
 * stacking step on at the batch seam (tools/batch/batch_engine.ts). Read at
 * CALL time (never cached at module load) so a harness can toggle per-run —
 * same seam discipline as `isRawlerDecoderEnabled` (m1_ingestion/
 * rawler_decoder.ts), with the OPPOSITE failure posture: any env-read error
 * → false, because the OFF arm is the byte-identical default and must be
 * unreachable-failure-proof.
 *
 * INERTNESS CONTRACT: this module has ZERO imports and the flag consumer
 * (batch_engine) loads the actual stacking machinery via a LAZY dynamic
 * import inside the flag branch — flag off ⇒ no m11 stacking module is even
 * loaded, no new code path executes, the batch ledger/receipts are
 * byte-identical by construction.
 *
 * Browser: vite env exposure (import.meta.env). Node: process.env fallback.
 */
export function isStackingEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_STACK_ENABLED;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_STACK_ENABLED;
        }
        return v === '1' || v === 'true';
    } catch {
        return false;
    }
}
