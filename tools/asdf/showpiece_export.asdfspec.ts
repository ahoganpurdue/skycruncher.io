/**
 * Env-gated single-run showpiece export: ONE real wizard solve → the canonical
 * receipt AND the ASDF container from the SAME run (receipt + arrays share one
 * provenance, per the demonstration-package requirement — never two solves
 * stitched together).
 *
 *   SHOWPIECE_INPUT=<frame (.fit/.fits/.cr2)> \
 *   SHOWPIECE_RECEIPT_OUT=<receipt.json> \
 *   SHOWPIECE_ASDF_OUT=<out.asdf> \
 *   npx vitest run -c tools/asdf/asdf_harness.config.ts tools/asdf/showpiece_export.asdfspec.ts
 *
 * Without SHOWPIECE_INPUT the spec SKIPS (env-gated, same pattern as the
 * arrow_sink/nasa apispecs) so the asdf harness lane stays clean. Works for
 * FITS and CR2/RAW alike — headless_driver runs both engine decode arms.
 *
 * Honest-or-absent: if the session yields no export image, NO ASDF is written
 * (reported as a gap), never a fabricated container. The receipt is always
 * written via the shared serializeReceipt (byte-identical to the browser
 * download). Assertions here are data-dumper contract only (artifacts landed);
 * pin verification is the caller's job against docs/GATES.md.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWizardPipeline } from '../api/headless_driver';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';
import { configureWorkbench } from '@/engine/pipeline/stages/workbench_deposit';
import { makeNodeJsonlStorage } from '../workbench/node_storage';
import { writeAsdfFile } from './export_asdf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');

const INPUT = process.env.SHOWPIECE_INPUT;
const RECEIPT_OUT = process.env.SHOWPIECE_RECEIPT_OUT;
const ASDF_OUT = process.env.SHOWPIECE_ASDF_OUT;
// [Optical Workbench] headless deposit sink — same never-fatal injection as
// tools/api/solve_to_receipt.runspec.ts, so this lane's receipt path mirrors
// the canonical run.mjs lane exactly.
const WORKBENCH_DIR = process.env.WORKBENCH_DIR || path.join(ROOT, 'test_results', 'workbench');

describe('showpiece export — one real solve → receipt + ASDF from the SAME run', () => {
    it.skipIf(!INPUT)('runs the real wizard once and writes the canonical receipt + ASDF container', async () => {
        if (!INPUT || !RECEIPT_OUT || !ASDF_OUT) {
            throw new Error('SHOWPIECE_INPUT, SHOWPIECE_RECEIPT_OUT and SHOWPIECE_ASDF_OUT env vars are all required');
        }
        if (!fs.existsSync(INPUT)) throw new Error(`showpiece input not found: ${INPUT}`);

        const buf = fs.readFileSync(INPUT);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        configureWorkbench({ storage: makeNodeJsonlStorage(WORKBENCH_DIR) });

        const { receipt, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

        fs.mkdirSync(path.dirname(RECEIPT_OUT), { recursive: true });
        fs.writeFileSync(RECEIPT_OUT, serializeReceipt(receipt), 'utf8');

        const image = session.getExportImage();
        if (image) {
            fs.mkdirSync(path.dirname(ASDF_OUT), { recursive: true });
            writeAsdfFile(receipt, image, ASDF_OUT);
            // eslint-disable-next-line no-console
            console.log(`[showpiece] receipt → ${RECEIPT_OUT}\n[showpiece] asdf    → ${ASDF_OUT} (${fs.statSync(ASDF_OUT).size} B)`);
        } else {
            // eslint-disable-next-line no-console
            console.warn('[showpiece] session produced NO export image — ASDF honestly ABSENT (gap reported, never fabricated)');
        }

        // Data-dumper contract: the receipt landed; solve quality is graded by
        // the caller against the pinned reference numbers, never loosened here.
        expect(fs.existsSync(RECEIPT_OUT)).toBe(true);
    });
});
