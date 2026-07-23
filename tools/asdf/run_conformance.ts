/**
 * ASDF conformance gate — one-command runner (DEV/CI oracle).
 *
 * Emits the asset-free fixture via the SHARED serializer, then round-trips it
 * through the STScI reference `asdf` library (conformance_check.py). A green run
 * is the ONLY thing that licenses calling the output "CONFORMANT".
 *
 *   npx tsx tools/asdf/run_conformance.ts
 *
 * Python resolution (the `asdf` lib is a DEV oracle, NOT a repo dependency —
 * install it OUTSIDE the tree, e.g. `pip install --user asdf`):
 *   - $ASDF_PYTHON set        → that interpreter, directly
 *   - win32 (no $ASDF_PYTHON) → WSL `python3` (paths translated to /mnt/<drive>)
 *   - otherwise               → `python3` on PATH
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFixture } from './export_asdf';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_PY = path.join(HERE, 'conformance_check.py');

/** Translate an absolute Windows path (`K:\a b`) to a WSL mount (`/mnt/k/a b`). */
function toWslPath(p: string): string {
    const abs = path.resolve(p).replace(/\\/g, '/');
    return abs.replace(/^([A-Za-z]):/, (_m: string, d: string) => `/mnt/${d.toLowerCase()}`);
}

/** Round-trip one fixture through the Python conformance + fidelity gate. */
function runGate(outPath: string, meta: { shape: number[]; datatype: string }): string {
    const shapeArg = meta.shape.join(',');
    if (process.platform === 'win32' && !process.env.ASDF_PYTHON) {
        const cmd = `python3 '${toWslPath(CHECK_PY)}' '${toWslPath(outPath)}' --shape ${shapeArg} --datatype ${meta.datatype}`;
        return execFileSync('wsl', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' });
    }
    const py = process.env.ASDF_PYTHON || 'python3';
    return execFileSync(py, [CHECK_PY, outPath, '--shape', shapeArg, '--datatype', meta.datatype], { encoding: 'utf8' });
}

function main(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asdf-gate-'));
    // Two fixtures: LINEAR-TAN (no SIP) and LINEAR+SIP — each proves the native
    // gwcs `wcs` reproduces an independent astropy.wcs pixel→world to sub-arcsec.
    const cases: Array<{ label: string; file: string; opts: { withSip?: boolean; withTps?: boolean } }> = [
        { label: 'LINEAR', file: path.join(dir, 'fixture_linear.asdf'), opts: {} },
        { label: 'LINEAR+SIP', file: path.join(dir, 'fixture_sip.asdf'), opts: { withSip: true } },
        { label: 'LINEAR+TPS', file: path.join(dir, 'fixture_tps.asdf'), opts: { withTps: true } },
    ];
    try {
        for (const c of cases) {
            const meta = writeFixture(c.file, c.opts);
            console.log(`\n[gate] ── ${c.label} ── emitted ${c.file}  shape=[${meta.shape.join(',')}]  datatype=${meta.datatype}`);
            process.stdout.write(runGate(c.file, meta));
        }
        console.log('\n[gate] RESULT: CONFORMANT ✓ (linear + SIP + TPS fidelity-proven)');
    } catch (e: any) {
        process.stdout.write(e?.stdout?.toString?.() ?? '');
        process.stderr.write(e?.stderr?.toString?.() ?? String(e?.message ?? e));
        console.error('\n[gate] RESULT: FAILED / python unavailable — treat output as "ASDF-shaped (unverified)" until this is green.');
        process.exit(1);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

main();
