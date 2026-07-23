// ═══════════════════════════════════════════════════════════════════════════
// DEEPCAT — fresh-receipt emitter (M66 FITS + bundled CR2) for the geometry study
// ═══════════════════════════════════════════════════════════════════════════
//
// The depth study needs receipts at the CURRENT schema carrying the fitted
// distortion blocks (solution.astrometry.sip AND .tps — the TPS producer landed
// after the archived 2.2.0 api_runs receipt). This spec runs the REAL wizard on
// both frames and writes the canonical receipt bytes (shared serializeReceipt,
// byte-identical to the browser download) to test_results/deep_cones/.
//
// It NEVER touches the solve — same runWizardPipeline the sacred CR2/SeeStar gates
// drive; writing a receipt to disk is inert. Collected ONLY by emit.config.ts
// (*.runspec.ts + dedicated include), so it pollutes no standing gate count.
//
// Run: npx vitest run -c tools/deepcat/emit.config.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'test_results', 'deep_cones');

const FRAMES = [
    { label: 'm66', input: path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit') },
    { label: 'cr2', input: path.join(ROOT, 'public', 'demo', 'sample_observation.cr2') },
];

describe('deepcat — emit fresh geometry-study receipts', () => {
    for (const f of FRAMES) {
        it(`solves ${f.label} and writes a current-schema receipt with distortion blocks`, async () => {
            expect(fs.existsSync(f.input), `input missing (local-only): ${f.input}`).toBe(true);
            const buf = fs.readFileSync(f.input);
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

            const { receipt } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

            fs.mkdirSync(OUT_DIR, { recursive: true });
            const out = path.join(OUT_DIR, `${f.label}.receipt.json`);
            fs.writeFileSync(out, serializeReceipt(receipt), 'utf8');

            const a = receipt.solution?.astrometry;
            // eslint-disable-next-line no-console
            console.log(`[emit:${f.label}] schema=${receipt.version} matched=${receipt.solution?.stars_matched}`
                + ` rms=${a?.rms_arcsec?.toFixed?.(2)} sip=${a?.sip ? 'yes' : 'no'}`
                + ` tps=${a?.tps ? `yes(rms ${a.tps.rms_before_arcsec?.toFixed?.(2)}->${a.tps.rms_after_arcsec?.toFixed?.(2)}" n=${a.tps.control_count})` : 'no'}`
                + ` -> ${path.relative(ROOT, out)}`);

            expect(fs.existsSync(out)).toBe(true);
        });
    }
});
