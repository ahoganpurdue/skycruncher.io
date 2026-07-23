import { makeTable, Uint16, Table, Vector } from 'apache-arrow';

/**
 * ===============================================================================
 * ARROW MEMORY - image-buffer Arrow-Table wrappers (m1/m3 ingest+preprocess)
 * ===============================================================================
 *
 * Wraps large image buffers into self-describing Apache Arrow Tables so a
 * pixels column and a small {width,height,stride} meta column travel together.
 * makeTable() wraps the supplied TypedArrays zero-copy (no serialization); the
 * validity bitmap Arrow adds is ~N/8 bytes, not a second full-frame copy
 * (MEASURED: 6.44 MB per 18 MP RGB frame — test_results/arrow_serialization_walls_2026-07-11).
 *
 * LAW 7: the Arrow columnar layout is the enumerated `arrow_seam` boundary in
 * src/engine/contracts/binary_layouts.ts. The producers below are unchanged;
 * this file changes only the readback surface (no stride/schema change).
 *
 * READBACK-SURFACE NOTE (2026-07-11): the live path CREATES these tables but
 * never READS them back — createRgbBuffer/createRawBuffer output is carried as
 * an unread `arrowTable` field (consumers hold the raw typed array instead).
 * The zero-caller getters `getFloat32Array`/`getMeta` were DELETED (dead code;
 * NEXT_MOVES §14b, EFFICIENCY_REVIEW candidate I4). `getUint16Array` is retained
 * only for its compile-time caller in demosaic_pipeline.ts (a runtime-dead
 * `rawSource instanceof Table` branch) and is corrected below.
 */

export class ArrowMemory {

    /**
     * Wrap a raw Bayer 16-bit integer array into an Apache Arrow Table.
     * Includes width, height, and stride as metadata columns for self-describing buffers.
     */
    public static createRawBuffer(buffer: Uint16Array, width: number, height: number, stride?: number): Table {
        return makeTable({
            pixels: buffer,
            meta: new Int32Array([width, height, stride ?? width])
        });
    }

    /**
     * Wrap a demosaiced/linear RGB 32-bit float array into an Apache Arrow Table.
     * This establishes the memory continuity for the WebGPU -> JS handoff.
     */
    public static createRgbBuffer(buffer: Float32Array, width: number, height: number): Table {
        return makeTable({
            pixels: buffer,
            meta: new Int32Array([width, height, width])
        });
    }

    /**
     * Materialize the full `pixels` column from an Arrow Table as a Uint16Array.
     *
     * WARNING - NOT zero-copy as the tables are currently built. createRawBuffer
     * passes mismatched-length columns (pixels=N, meta=3), so Arrow splits the
     * pixels vector into >1 record batch (data[0].length=3, data[1]=rest). Reading
     * `vector.data[0].values` directly would TRUNCATE the frame to 3 pixels
     * (MEASURED on apache-arrow 21.1.0 — the latent bug in EFFICIENCY_REVIEW I4).
     * `toArray()` concatenates across chunks and returns the correct N-length
     * array (a copy when chunked). This getter is called only from a runtime-dead
     * branch; correctness-if-revived is the goal, not throughput. A true zero-copy
     * readback needs the producer to emit a single-column table + a plain
     * {width,height,stride} sidecar (NEXT_MOVES §14b) — a seam change, out of scope here.
     */
    public static getUint16Array(table: Table): Uint16Array {
        const vector = table.getChild('pixels') as Vector<Uint16> | null;
        if (!vector) {
            throw new Error('[ArrowMemory] Table missing "pixels" column. Was it created with createRawBuffer/createRgbBuffer?');
        }
        return vector.toArray() as Uint16Array;
    }
}
