/**
 * Schema provenance for the toolchest Arrow tables.
 *
 * Every emitted table carries schema-level metadata citing (a) the LAW-7 boundary
 * entry that governs its stride/units — `src/engine/contracts/binary_layouts.ts`
 * name `toolchest_arrow_export`, and (b) the receipt-schema version it was derived
 * from (read at runtime off `receipt.version`, never mirrored). Field-level
 * metadata carries the physical `units` and the receipt `source` path per column
 * so RA-in-HOURS vs RA-in-DEGREES can never be confused downstream.
 */

/** LAW-7 boundary citation key (see binary_layouts.ts, name === this). */
export const LAW7_BOUNDARY = 'binary_layouts#toolchest_arrow_export';

/** Contract version for the toolchest export boundary (matches the binary_layouts entry). */
export const TOOLCHEST_ARROW_VERSION = '0.1.0';

export const PRODUCER = '@skycruncher/toolchest arrow_export';

/** Build the schema-level metadata map common to every emitted table. */
export function schemaMetadata(
    tableName: string,
    sourceField: string,
    receiptVersion: string | undefined,
): Map<string, string> {
    const m = new Map<string, string>();
    m.set('producer', PRODUCER);
    m.set('table', tableName);
    m.set('law7_boundary', LAW7_BOUNDARY);
    m.set('toolchest_arrow_version', TOOLCHEST_ARROW_VERSION);
    m.set('source_field', sourceField);
    // Provenance of the SEMANTICS (field names/units) — the receipt schema version.
    m.set('receipt_schema_version', receiptVersion ?? 'UNKNOWN');
    return m;
}
