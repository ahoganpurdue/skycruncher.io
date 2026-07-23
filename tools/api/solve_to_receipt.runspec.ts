// ═══════════════════════════════════════════════════════════════════════════
// tools/api run.mjs — full-receipt dumper (driven by run.config.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
// The vitest-hosted half of the `run.mjs` CLI: a plain .mjs cannot resolve the
// engine's `@/` alias + boot the compiled wasm (see headless_driver.ts docstring
// — "must run under the vitest harness, NOT plain tsx"), so run.mjs spawns vitest
// against THIS spec, passing the FITS input + output path via env vars, exactly
// as the overnight driver spawns the fits_binding rail.
//
// It runs the REAL calibrated wizard on the FITS buffer and writes the CANONICAL
// receipt bytes (via the shared serializeReceipt — byte-identical to the browser
// download) to API_RUN_RECEIPT_OUT. Projection + exit code are run.mjs's job; this
// spec's ONLY job is "real solve → full receipt on disk". FITS lane only.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from './headless_driver';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';
import { applyConfigOverrides } from '@/engine/pipeline/constants/pipeline_config';
import { configureWorkbench } from '@/engine/pipeline/stages/workbench_deposit';
import { makeNodeJsonlStorage } from '../workbench/node_storage';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');

const FITS = process.env.API_RUN_FITS;             // absolute path to the FITS input
const OUT = process.env.API_RUN_RECEIPT_OUT;       // absolute path for the full receipt JSON
const CONFIG = process.env.API_RUN_CONFIG;         // optional JSON {KEY:value} knob overrides (§11b)
// [Optical Workbench] headless deposit sink (default-on collection). Local-only,
// gitignored dir; overridable for isolated evidence runs via WORKBENCH_DIR.
const WORKBENCH_DIR = process.env.WORKBENCH_DIR || path.join(ROOT, 'test_results', 'workbench');

describe('tools/api run.mjs — full-receipt dump', () => {
  it('runs the real wizard on the FITS input and writes the canonical receipt', async () => {
    if (!FITS || !OUT) throw new Error('API_RUN_FITS and API_RUN_RECEIPT_OUT env vars are required (run via tools/api/run.mjs)');
    if (!fs.existsSync(FITS)) throw new Error(`FITS input not found: ${FITS}`);

    const buf = fs.readFileSync(FITS);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

    // §11b config-as-argument seam: thread runtime PIPELINE_CONSTANTS overrides
    // BEFORE the solve (consumers read the constants live at call-time, so an
    // Object.assign here reaches every stage). Absent env ⇒ strict no-op ⇒ a
    // byte-identical calibrated solve. This vitest process solves exactly ONCE
    // (run.mjs forks per solve), so the process-global mutation never leaks.
    if (CONFIG) {
      const overrides = JSON.parse(CONFIG) as Record<string, number | string | boolean>;
      const { applied, rejected } = applyConfigOverrides(overrides);
      console.warn(`[run.mjs] config overrides applied: [${applied.join(', ') || 'none'}]; rejected: [${rejected.join(', ') || 'none'}]`);
    }

    // Inject the headless JSON-lines workbench store so the always-on post-package
    // deposit hook (fired inside exportPacket) persists a per-rig row. Synchronous,
    // so the deposit completes before the receipt is returned. Never-fatal by
    // construction — a storage failure cannot perturb the receipt below.
    configureWorkbench({ storage: makeNodeJsonlStorage(WORKBENCH_DIR) });

    const { receipt } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, serializeReceipt(receipt), 'utf8');

    // Data-dumper contract: assert only that the artifact landed. A no-solve
    // (receipt.solution === null) is a valid OUTCOME graded by run.mjs's exit
    // code, never a test failure here.
    expect(fs.existsSync(OUT)).toBe(true);
  });
});
