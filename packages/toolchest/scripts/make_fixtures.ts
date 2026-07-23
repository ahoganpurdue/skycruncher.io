/**
 * Deterministic committed-fixture generator. Regenerate with:
 *   node --import tsx packages/toolchest/scripts/make_fixtures.ts
 * (run from the repo root; tsx resolves the repo's extensionless TS imports).
 *
 * Writes the four tabular products of the deterministic sampleReceipt() to
 * packages/toolchest/fixtures/*.arrow. These committed files are the INTEROP
 * PROOF surface: interop_fixture.test.ts re-reads them (schema + exact values),
 * and any Arrow-capable reader (pyarrow/pandas) can consume them cross-language.
 * Regenerating must be BYTE-IDENTICAL — the export is deterministic.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { exportAllTables, tableToArrowFileBytes } from '../src/index.ts';
import { sampleReceipt } from '../src/testing/sample_receipt.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');
mkdirSync(outDir, { recursive: true });

const tables = exportAllTables(sampleReceipt());
for (const [name, table] of Object.entries(tables)) {
    const bytes = tableToArrowFileBytes(table);
    const path = join(outDir, `${name}.arrow`);
    writeFileSync(path, bytes);
    // eslint-disable-next-line no-console
    console.log(`wrote ${name}.arrow  rows=${table.numRows} cols=${table.numCols} bytes=${bytes.length}`);
}
