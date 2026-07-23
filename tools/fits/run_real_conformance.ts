/**
 * REAL-ENGINE SIP/TPS SIGN conformance — one-command standing gate (DEV oracle).
 *
 * Closes the "synthetic-only blindness": the m66_linear/m66_sip fixtures are built
 * with a self-constructed FITS-convention SIP and so cannot catch the engine's own
 * fit-sign convention. This runner exports the REAL engine SIP (order-3) + TPS and
 * asserts, via astropy/gwcs applied to the CATALOG cross-match, that the distortion
 * IMPROVES the residual (moves stars TOWARD the catalog) — the only check that
 * adjudicates the export SIGN (src/engine/pipeline/export/sip_convention.ts).
 *
 *   npx tsx tools/fits/run_real_conformance.ts
 *
 * Requires a solved M66 receipt (local-only). Honest-absent: if the receipt is
 * missing it prints how to produce one and exits 0 (SKIPPED) rather than fail —
 * the CI oracle can't fabricate the local capture. Python resolution mirrors
 * tools/asdf/run_conformance.ts (win32 → WSL python3; else $CONFORMANCE_PYTHON
 * or python3 on PATH).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRealFixture, DEFAULT_RECEIPT } from './build_real_fixture';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RECEIPT = process.env.FITS_RECEIPT ?? DEFAULT_RECEIPT;
const OUT_DIR = path.join(ROOT, 'test_results', 'conformance_real');
const FITS_PY = path.join(ROOT, 'tools', 'fits', 'conformance_check.py');
const ASDF_PY = path.join(ROOT, 'tools', 'asdf', 'conformance_check.py');

function toWslPath(p: string): string {
    const abs = path.resolve(p).replace(/\\/g, '/');
    return abs.replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`);
}

/** Run one python conformance-check invocation, streaming its output. */
function runPy(script: string, file: string, truth: string): string {
    const args = [file, '--catalog-truth', truth];
    if (process.platform === 'win32' && !process.env.CONFORMANCE_PYTHON) {
        const q = (s: string) => `'${toWslPath(s)}'`;
        const cmd = `python3 ${q(script)} ${q(file)} --catalog-truth ${q(truth)}`;
        return execFileSync('wsl', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' });
    }
    const py = process.env.CONFORMANCE_PYTHON || 'python3';
    return execFileSync(py, [script, ...args], { encoding: 'utf8' });
}

function main(): void {
    if (!fs.existsSync(RECEIPT)) {
        console.log(`[real-conformance] SKIPPED (honest-absent): no receipt at\n  ${path.relative(ROOT, RECEIPT)}`);
        console.log('  produce one:  node tools/api/run.mjs "Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit"');
        process.exit(0);
    }
    // Build the real fixture in-process (pure — catalog truth, no wasm).
    const { fitsOut: fitsFile, asdfOut: asdfFile, truthOut: truth } = buildRealFixture(RECEIPT, OUT_DIR);
    try {
        console.log('\n[real-conformance] ── FITS SIP sign ──');
        process.stdout.write(runPy(FITS_PY, fitsFile, truth));
        console.log('\n[real-conformance] ── ASDF/GWCS TPS sign ──');
        process.stdout.write(runPy(ASDF_PY, asdfFile, truth));
        console.log('\n[real-conformance] RESULT: SIGN OK ✓ (SIP + TPS export improves the astropy-applied catalog residual)');
    } catch (e: any) {
        process.stdout.write(e?.stdout?.toString?.() ?? '');
        process.stderr.write(e?.stderr?.toString?.() ?? String(e?.message ?? e));
        console.error('\n[real-conformance] RESULT: FAILED (wrong-sign export or python unavailable)');
        process.exit(1);
    }
}

main();
