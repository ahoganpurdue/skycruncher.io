/**
 * Low-level Arrow column builders with EXPLICIT nullability control.
 *
 * ARROW CARRIER PROGRAM DEBT (owner-named): a nullable Arrow column carries a
 * per-column validity BITMAP. On a 272-star SeeStar solve that bitmap tax was the
 * named 6.44 MB regression. Rule here: build NON-NULLABLE buffers (no bitmap)
 * wherever the receipt field is structurally guaranteed present; only fields the
 * receipt itself types `| null` get a nullable column, and even those SKIP the
 * bitmap when the actual data has zero nulls. `makeData` allocates a nullBitmap
 * only when `nullCount > 0`.
 */
import {
    type Data,
    Field,
    Float64,
    Int32,
    Utf8,
    Struct,
    Schema,
    RecordBatch,
    Table,
    makeData,
} from 'apache-arrow';

/** Field-level metadata map (units are first-class per CLAUDE.md unit traps). */
export function fieldMeta(units: string, source: string, note?: string): Map<string, string> {
    const m = new Map<string, string>();
    m.set('units', units);
    m.set('source', source);
    if (note) m.set('note', note);
    return m;
}

/** Non-nullable Float64 column — NO validity bitmap. Use for guaranteed-present fields. */
export function f64(values: readonly number[]): Data<Float64> {
    return makeData({ type: new Float64(), length: values.length, data: Float64Array.from(values) });
}

/**
 * Nullable Float64 column. `null`/`undefined` → validity bit 0 (data slot NaN);
 * a genuine numeric NaN in the input is PRESERVED as a present value (IEEE-honest).
 * When the input has zero nulls, no bitmap is allocated (non-null in practice).
 */
export function f64Nullable(values: readonly (number | null | undefined)[]): Data<Float64> {
    const n = values.length;
    const data = new Float64Array(n);
    const bitmap = new Uint8Array((n + 7) >> 3);
    let nullCount = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        if (v === null || v === undefined) {
            nullCount++;
            data[i] = NaN;
        } else {
            data[i] = v;
            bitmap[i >> 3] |= 1 << (i & 7);
        }
    }
    return makeData({
        type: new Float64(),
        length: n,
        nullCount,
        nullBitmap: nullCount > 0 ? bitmap : undefined,
        data,
    });
}

/** Non-nullable Int32 column — NO validity bitmap. */
export function i32(values: readonly number[]): Data<Int32> {
    return makeData({ type: new Int32(), length: values.length, data: Int32Array.from(values, (v) => v | 0) });
}

/**
 * Utf8 column, built by hand for deterministic control over nulls and n=0
 * (avoids vectorFromArray's chunk/empty ambiguity). `null`/`undefined` → null;
 * numbers are stringified (used for gaia_id to dodge the 2^53 id-rounding trap).
 * No bitmap when the input has zero nulls.
 */
export function utf8(values: readonly (string | number | null | undefined)[]): Data<Utf8> {
    const n = values.length;
    const offsets = new Int32Array(n + 1);
    const bitmap = new Uint8Array((n + 7) >> 3);
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let nullCount = 0;
    let off = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        if (v === null || v === undefined) {
            nullCount++;
            offsets[i + 1] = off;
        } else {
            const bytes = enc.encode(String(v));
            chunks.push(bytes);
            off += bytes.length;
            offsets[i + 1] = off;
            bitmap[i >> 3] |= 1 << (i & 7);
        }
    }
    const data = new Uint8Array(off);
    let p = 0;
    for (const c of chunks) {
        data.set(c, p);
        p += c.length;
    }
    return makeData({
        type: new Utf8(),
        length: n,
        nullCount,
        nullBitmap: nullCount > 0 ? bitmap : undefined,
        valueOffsets: offsets,
        data,
    });
}

/** A named column: its Field (name/type/nullable/metadata) + its built Data. */
export interface Column {
    field: Field;
    data: Data;
}

/** Assemble columns into a single-RecordBatch Arrow Table with schema metadata. */
export function assembleTable(columns: readonly Column[], schemaMetadata: Map<string, string>): Table {
    const fields = columns.map((c) => c.field);
    const length = columns.length > 0 ? columns[0].data.length : 0;
    const schema = new Schema(fields, schemaMetadata);
    const structData = makeData({
        type: new Struct(fields),
        length,
        children: columns.map((c) => c.data),
    });
    return new Table(schema, new RecordBatch(schema, structData));
}
