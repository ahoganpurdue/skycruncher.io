/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASDF LANE — real wizard-pipeline → ASDF sink (tools/api headless_driver)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The "port to headless" step (item 6): run the REAL wizard pipeline in Node
 * via `runWizardPipeline`, then emit its receipt + measured science frame as
 * ASDF using the SAME shared serializer (through `writeAsdfFile`). The ASDF
 * container is byte-identical to the browser / desktop export — one serializer,
 * one `session.getExportImage()`.
 *
 * This file imports the engine (and therefore the compiled wasm), so — like
 * `tools/api/headless_driver.ts` — it must run under the vitest harness
 * (real wasm + vite plugins), NOT plain tsx, and needs the local-only assets
 * (Sample Files / public/atlas/sectors / wasm pkg). FITS lane only (CR2/RAW
 * headless is out of scope, per headless_driver).
 */

import { runWizardPipeline, type RunWizardOptions } from '../api/headless_driver';
import type { HardMetadata } from '@/engine/types/Main_types';
import { writeAsdfFile } from './export_asdf';

export interface AsdfPipelineExportOptions {
    atlasRoot: string;
    outPath: string;
    overrides?: Partial<HardMetadata>;
    wasmBytes?: BufferSource;
}

/**
 * Run the full headless wizard on a FITS buffer, then write its receipt +
 * science frame to `outPath` as ASDF. Returns the output path + the receipt.
 */
export async function runAsdfExport(
    buffer: ArrayBuffer,
    opts: AsdfPipelineExportOptions
): Promise<{ outPath: string; receipt: any }> {
    const runOpts: RunWizardOptions = {
        atlasRoot: opts.atlasRoot,
        overrides: opts.overrides,
        wasmBytes: opts.wasmBytes,
    };
    const { receipt, session } = await runWizardPipeline(buffer, runOpts);
    const image = session.getExportImage();
    if (!image) throw new Error('ASDF export: the pipeline produced no science frame.');
    writeAsdfFile(receipt, image, opts.outPath);
    return { outPath: opts.outPath, receipt };
}
