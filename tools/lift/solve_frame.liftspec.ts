// ═══════════════════════════════════════════════════════════════════════════
// NEBULOSITY LIFT — A/B solve driver (vitest-hosted; driven by run_xt_lifted.mjs)
// ═══════════════════════════════════════════════════════════════════════════
//
// Runs ONE arm of the A/B on ONE frame through the REAL wizard pipeline and banks
// the canonical receipt + a compact summary (mode, detection count, solve outcome,
// matched/σ). A plain .mjs cannot resolve `@/` or boot wasm, so the CLI spawns
// vitest against THIS spec, passing everything via env (same pattern as
// tools/api/run.mjs → solve_to_receipt.runspec.ts). One vitest process = ONE solve
// = one clean process-global config (no leak across arms).
//
// ENV:
//   LIFT_FRAME        absolute path to the RAW frame                         (required)
//   LIFT_RECEIPT_OUT  absolute path for the full canonical receipt JSON      (required)
//   LIFT_SUMMARY_OUT  absolute path for the compact A/B summary JSON         (optional)
//   LIFT_MODE         'baseline' | 'lifted'                                  (required)
//   LIFT_OVERRIDES    JSON Partial<HardMetadata> (scale/FL/observer rungs)   (optional)
//   LIFT_HINT         JSON {ra,dec,label} → CONFIG 15° callerHint            (optional)
//   LIFT_CONFIG       JSON {KEY:value} PIPELINE_CONSTANTS overrides (§11b)   (optional)
//   LIFT_PARAMS       JSON nebulosity-lift options (model/tiles/percentile)  (optional)

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';
import { applyConfigOverrides } from '@/engine/pipeline/constants/pipeline_config';
import type { HardMetadata } from '@/engine/types/Main_types';
import type { CallerTargetHint } from '@/engine/pipeline/stages/solve';
import type { PipelineEvent } from '@/engine/events/pipeline_events';
import { makeNebulosityLiftTransform, type NebulosityLiftOptions } from './nebulosity_lift';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');

// Track the libraw decode Worker(s) headless_driver installs as globalThis.Worker
// (BrowserWorkerOnNode, a node worker_threads Worker): libraw-wasm spawns one to
// decode and NEVER terminates it, so after a no-solve it keeps this process alive
// and hangs vitest teardown until the runner's wall-kill (why no artifact survived).
// Transparent constructor wrapper — construction/behaviour unchanged, we only record
// instances so afterAll can terminate them. Guarded against double-wrap.
const liveWorkers = new Set<any>();
{
    const InstalledWorker = (globalThis as any).Worker;
    if (typeof InstalledWorker === 'function' && !(InstalledWorker as any).__liftTracked) {
        const Wrapped: any = function (this: any, ...args: any[]) {
            const inst = new InstalledWorker(...args);
            liveWorkers.add(inst);
            inst.on?.('exit', () => liveWorkers.delete(inst));
            return inst;
        };
        Wrapped.__liftTracked = true;
        (globalThis as any).Worker = Wrapped;
    }
}

const FRAME = process.env.LIFT_FRAME;
const RECEIPT_OUT = process.env.LIFT_RECEIPT_OUT;
const SUMMARY_OUT = process.env.LIFT_SUMMARY_OUT;
const MODE = (process.env.LIFT_MODE || 'baseline') as 'baseline' | 'lifted';

function parseJsonEnv<T>(name: string): T | null {
    const v = process.env[name];
    if (!v) return null;
    try { return JSON.parse(v) as T; }
    catch (e) { throw new Error(`${name} is not valid JSON: ${(e as Error).message}`); }
}

describe(`nebulosity lift — A/B solve (${MODE})`, () => {
    it('solves one frame/arm and banks receipt + summary', async () => {
        if (!FRAME || !RECEIPT_OUT) throw new Error('LIFT_FRAME and LIFT_RECEIPT_OUT env vars are required');
        if (!fs.existsSync(FRAME)) throw new Error(`frame not found: ${FRAME}`);

        const overrides = parseJsonEnv<Partial<HardMetadata>>('LIFT_OVERRIDES') ?? undefined;
        const hint = parseJsonEnv<CallerTargetHint>('LIFT_HINT');
        const config = parseJsonEnv<Record<string, number | string | boolean>>('LIFT_CONFIG');
        const liftParams = parseJsonEnv<NebulosityLiftOptions>('LIFT_PARAMS') ?? {};

        // §11b experimental config overrides (e.g. the UW anchor-candidate bump). This
        // process solves ONCE so the process-global mutation never leaks between arms.
        if (config) {
            const { applied, rejected } = applyConfigOverrides(config);
            console.warn(`[lift/${MODE}] config overrides applied: [${applied.join(', ') || 'none'}]; rejected: [${rejected.join(', ') || 'none'}]`);
        }

        const buf = fs.readFileSync(FRAME);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        // Capture the detection count from the bus (stars_detected finding).
        let detections = 0, anomalies = 0;
        const onEvent = (e: PipelineEvent) => {
            const anyE = e as any;
            if (anyE?.kind === 'finding' && anyE.finding?.kind === 'stars_detected') {
                detections = anyE.finding.count ?? detections;
                anomalies = anyE.finding.anomalies ?? anomalies;
            }
        };

        const preDetectTransform = MODE === 'lifted' ? makeNebulosityLiftTransform(liftParams) : null;

        // FAIL-FAST (lift lane only; engine untouched). Decode/solve can THROW when
        // the container yields no usable science frame (truncated/corrupt RAW: the
        // decode boundary returns null → decodeScienceFrame throws "Failed to decode
        // sensor data."). Unguarded, that threw here with NO artifact banked and the
        // A/B runner ground on to its 900s wrapper kill. The data-dumper contract
        // (below) is that this spec ALWAYS banks an artifact and a no-solve — now
        // including a decode failure — is a valid OUTCOME the runner grades, never a
        // hard test failure. Zero change when runWizardPipeline returns normally.
        let receipt: any = null;
        let pipelineError: string | null = null;
        try {
            ({ receipt } = await runWizardPipeline(ab, {
                atlasRoot: ATLAS_ROOT,
                overrides,
                callerHint: hint,
                preDetectTransform,
                onEvent,
            }));
        } catch (e) {
            pipelineError = (e as Error)?.message ?? String(e);
            console.error(`[lift/${MODE}] pipeline threw before a receipt was built: ${pipelineError}`);
        }

        // PERSIST-ON-EVERY-OUTCOME (owner: a refused solve is first-class campaign
        // evidence, banked like any solve). Receipt + summary are written
        // UNCONDITIONALLY here — solved, refused (failure-packet receipt, no throw),
        // or threw. serializeReceipt is guarded on its own: an unguarded serialize
        // throw on the no-solve failure packet previously banked NOTHING; it now
        // falls back to a marker AND the summary still writes.
        fs.mkdirSync(path.dirname(RECEIPT_OUT), { recursive: true });
        let receiptSerializeError: string | null = null;
        let receiptWritten = false;
        if (receipt) {
            try {
                fs.writeFileSync(RECEIPT_OUT, serializeReceipt(receipt), 'utf8');
                receiptWritten = true;
            } catch (e) {
                receiptSerializeError = (e as Error)?.message ?? String(e);
                console.error(`[lift/${MODE}] serializeReceipt failed: ${receiptSerializeError}`);
            }
        }
        if (!receiptWritten) {
            fs.writeFileSync(RECEIPT_OUT, JSON.stringify({
                frame: path.basename(FRAME),
                mode: MODE,
                solved: false,
                error: pipelineError ?? receiptSerializeError,
                note: receipt
                    ? 'receipt produced but serializeReceipt failed — see error.'
                    : 'no receipt — pipeline threw before step6_Integrate (see error).',
            }, null, 2), 'utf8');
        }

        const sol = receipt ? (receipt as any).solution : null;
        const confirm = receipt ? ((receipt as any).confirm_status ?? null) : null;
        const summary = {
            frame: path.basename(FRAME),
            mode: MODE,
            solved: sol != null,
            error: pipelineError ?? receiptSerializeError,
            detections,
            anomalies,
            // Assisted-rung provenance (honest): the hint / metadata overrides that
            // drove this arm, so an assisted solve is never read as unassisted.
            hint_used: hint ?? null,
            overrides_used: overrides ?? null,
            solved_via: receipt ? ((receipt as any).solve_provenance?.solved_via ?? null) : null,
            ra_hours: sol?.ra_hours ?? null,
            dec_degrees: sol?.dec_degrees ?? null,
            pixel_scale: sol?.pixel_scale ?? null,
            stars_matched: sol?.stars_matched ?? null,
            confidence: sol?.confidence ?? null,
            confirm_status: confirm?.status ?? (typeof confirm === 'string' ? confirm : null),
            confirm_sigma: confirm?.excess_sigma ?? confirm?.sigma ?? null,
            experimental: receipt ? ((receipt as any).experimental ?? false) : false,
            config_overrides: receipt && (receipt as any).config_overrides ? Object.keys((receipt as any).config_overrides) : null,
            receipt_out: path.relative(ROOT, RECEIPT_OUT),
        };
        if (SUMMARY_OUT) {
            fs.mkdirSync(path.dirname(SUMMARY_OUT), { recursive: true });
            fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2));
        }
        console.log(`[lift/${MODE}] SUMMARY ${JSON.stringify(summary)}`);

        // Data-dumper contract: assert only that the artifact landed. A no-solve OR a
        // decode failure is a valid OUTCOME (graded by the runner), never a test
        // failure here.
        expect(fs.existsSync(RECEIPT_OUT)).toBe(true);
    });

    // TEARDOWN: terminate any lingering libraw decode worker (see the tracking
    // wrapper above). Spec-side dispose only — the engine and decode path are
    // untouched. No process.exit hacks; a clean terminate lets vitest exit.
    afterAll(async () => {
        if (liveWorkers.size > 0) {
            // Compact the active-handle census to type→count (raw list is hundreds of
            // the worker's own SimpleWriteWrap pipes — noise).
            const info: string[] = (process as any).getActiveResourcesInfo?.() ?? [];
            const byType: Record<string, number> = {};
            for (const r of info) byType[r] = (byType[r] ?? 0) + 1;
            console.warn(`[lift/${MODE}] afterAll: terminating ${liveWorkers.size} lingering decode worker(s); active resource types: ${JSON.stringify(byType)}`);
        }
        for (const w of liveWorkers) {
            try { await w.terminate?.(); } catch { /* best-effort teardown */ }
        }
        liveWorkers.clear();
    });
});
