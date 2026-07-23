/**
 * Arrow IPC (.arrow / Feather v2 file format) serialization. Pure byte helpers
 * plus optional Node fs sinks. The browser/desktop hosts use the byte helpers and
 * hand the Uint8Array to their own writeFile (the thin-sink pattern, mirroring the
 * FITS/ASDF serializers).
 */
import { tableToIPC, tableFromIPC, type Table } from 'apache-arrow';

/** Serialize a Table to Arrow IPC FILE bytes (random-access; the `.arrow`/feather format). */
export function tableToArrowFileBytes(table: Table): Uint8Array {
    return tableToIPC(table, 'file');
}

/** Read Arrow IPC bytes (file OR stream framing) back into a Table. */
export function arrowBytesToTable(bytes: Uint8Array): Table {
    return tableFromIPC(bytes);
}

/**
 * Node-only sink: write a Table to a `.arrow` file. Dynamically imports node:fs so
 * this module stays import-safe in the browser (which never calls it).
 */
export async function writeArrowFile(table: Table, path: string): Promise<void> {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, tableToArrowFileBytes(table));
}

/** Node-only source: read a `.arrow` file back into a Table. */
export async function readArrowFile(path: string): Promise<Table> {
    const { readFileSync } = await import('node:fs');
    return arrowBytesToTable(new Uint8Array(readFileSync(path)));
}
