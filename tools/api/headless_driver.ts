/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TOOLCHEST API — headless wizard driver (I2.1 incubator, LAW 4: tools/ lane)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs the REAL wizard pipeline (OrchestratorSession step1→step6) in Node:
 * real compiled wasm, real atlas (fs-backed loader through the I1.1 seam),
 * no browser artifacts (I1.2 generatePreviews:false), structural ImageData
 * (I1.3 makeImageData). The receipt it returns must be value-identical to
 * the browser wizard's export — that is the whole point (LAW 2: the sacred
 * SeeStar numbers are asserted EXACTLY in solve_seestar.apispec.ts).
 *
 * Scope: FITS **and** CR2/RAW. Both lanes run the SAME engine decode path
 * (m1_ingestion/metadata_reaper): FITS short-circuits to the pure-TS decoder;
 * CR2/RAW runs LibRaw-wasm in Node through the repo's Node Worker bridge
 * (src/engine/core/worker_shim.js — see the polyfill block below). VERIFIED
 * (increment 1): the bundled Canon T6 CR2 (public/demo/sample_observation.cr2)
 * through runWizardPipeline reproduces the browser blind-solve SACRED numbers
 * byte-identically — asserted in tools/api/solve_cr2.apispec.ts. The bridge
 * itself is proven under vitest by tools/psf/decode_cr2.mjs (decodes the same
 * CR2 in the sacred suite) and in plain Node by tools/dslr/decode_cr2_smoke.mjs
 * (libraw_loads_in_node=true).
 *
 * NOT in this increment: the tools/psf/decode_cr2.mjs decode-FORK still carries
 * its own demosaic (≠ this engine path); retiring/aligning it is increment 2.
 *
 * LICENSING: LibRaw is dual-licensed LGPL-2.1 / CDDL-1.0 — we elect CDDL-1.0 and
 * carry its notice; the `libraw-wasm` wrapper is ISC. Both permit headless
 * (server-side) use; the wasm binding triggers no static-linking obligation.
 *
 * Run under the API harness config (real wasm, no mocks):
 *   npx vitest run -c tools/api/api_harness.config.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

import { OrchestratorSession, type PreDetectTransform } from '@/engine/pipeline/orchestrator_session';
import type { SearchPriorModel } from '@/engine/pipeline/m6_plate_solve/search_priors';
import type { CallerTargetHint } from '@/engine/pipeline/stages/solve';
import { StarCatalogAdapter, type AtlasLoader } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import type { PipelineEvent } from '@/engine/events/pipeline_events';
import { summarizeStageTimings } from '@/engine/events/stage_timing_summary';
import { isRawlerDecoderEnabled } from '@/engine/pipeline/m1_ingestion/rawler_decoder';
import type { HardMetadata } from '@/engine/types/Main_types';
// CRITICAL: import the wasm module via the SAME specifier family the engine
// uses (all of '@/engine/wasm_compute/pkg/wasm_compute', the relative
// '../wasm_compute/pkg/wasm_compute', and the '.js'-suffixed dynamic imports
// resolve to ONE module instance under vite/vitest). initSync fills that
// instance's singleton; the engine's later `await wasm.default()` calls
// (solver_entry) then early-return on `wasm !== undefined` — no-ops.
import * as wasm from '@/engine/wasm_compute/pkg/wasm_compute';
// ARROW CARRIER program, Phase 1 consumer (packages/toolchest). This tools/ lane
// is the export's FIRST production touchpoint: turn a finished run's receipt into
// the four TABULAR Arrow products. Imported by RELATIVE path — the package is not
// npm-workspace-linked and there is no `@skycruncher/*` tsconfig alias, so the
// package name would not resolve here. Decoupled by structural typing: this driver
// hands the receipt across; toolchest never imports the engine.
import { exportAllTables, writeArrowFile } from '../../packages/toolchest/src/index';
// Community solve-push (env-gated sink; tools-lane network I/O, mirrors the Arrow
// sink discipline). Imported as an untyped .mjs (bundler resolution) — the engine
// never imports this; the driver hands the finished receipt across.
import { pushSolveFromReceipt } from '../community/push_solve.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_BG_PATH = path.join(REPO_ROOT, 'src', 'engine', 'wasm_compute', 'pkg', 'wasm_compute_bg.wasm');

// ─────────────────────────────────────────────────────────────────────────────
// CR2/RAW lane — Node Worker bridge for LibRaw-wasm.
//
// libraw-wasm decodes inside a browser Worker (`new Worker(url,{type:'module'})`);
// the vitest `node` environment has no browser Worker, so we bridge Node's
// worker_threads → the browser Worker API via the repo's worker_shim.js
// (shims self/window/fetch(file://), then imports the real worker script). This
// is the SAME mechanism proven under vitest by tools/psf/decode_cr2.mjs and in
// plain Node by tools/dslr/decode_cr2_smoke.mjs (libraw_loads_in_node=true).
//
// Installed at module load so it is in place before any runWizardPipeline() call
// reaches metadata_reaper's dynamic `import('libraw-wasm')` (which fires during
// step1_Load). FITS runs never spawn a Worker (metadata_reaper short-circuits to
// the pure-TS FITS decoder), so the existing SeeStar smoke is unaffected.
//
// PATH ASSUMPTIONS (verified present under node_modules at increment time):
//   • bridge shim  : src/engine/core/worker_shim.js
//   • libraw worker: node_modules/libraw-wasm/dist/worker.js
//   • libraw wasm  : node_modules/libraw-wasm/dist/libraw.wasm
// The shim resolves the worker's relative fetch()es against the worker's own
// dir (fetch→readFileSync), so worker.js + libraw.wasm co-locating in dist/ is
// what makes the wasm load succeed.
const WORKER_SHIM_PATH = path.join(REPO_ROOT, 'src', 'engine', 'core', 'worker_shim.js');

class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    constructor(url: string | URL, _options?: unknown) {
        super(WORKER_SHIM_PATH, { workerData: { url: url.toString() } });
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); });
    }
    addEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener as (...a: unknown[]) => void);
    }
    removeEventListener(): void { /* no-op: workers are torn down at pool/process exit */ }
}

// Unconditional install (mirrors the proven decode_cr2.mjs reference): this
// module is Node-only, and LibRaw REQUIRES the shim-backed Worker — deferring to
// any pre-existing global Worker (e.g. a Node web-standard Worker) would bypass
// the file:// fetch + self/window shims and fail mid-decode.
(globalThis as { Worker?: unknown }).Worker = BrowserWorkerOnNode;

/**
 * Boot the REAL compiled wasm synchronously (idempotent: initSync
 * early-returns once the module singleton exists), then sanity-call a cheap
 * pure function as a post-boot sentinel — a botched boot must fail HERE,
 * not as a cryptic mid-solve panic.
 */
export function bootRealWasm(wasmBytes?: BufferSource): void {
    wasm.initSync({ module: (wasmBytes ?? fs.readFileSync(WASM_BG_PATH)) as any });
    // Sentinel: haversine separation of (0,0)→(0,π/2) is exactly π/2 rad.
    const sep = wasm.calculate_angular_separation(0, 0, 0, Math.PI / 2);
    if (!(Math.abs(sep - Math.PI / 2) < 1e-12)) {
        throw new Error(`[api] wasm post-boot sentinel failed: calculate_angular_separation(0,0,0,π/2) = ${sep}, expected π/2`);
    }
}

/**
 * fs-backed AtlasLoader for the I1.1 seam: resolves the browser's atlas URL
 * strings (`/atlas/...`) against a local root (typically `<repo>/public`).
 * Missing files → 404 Response, preserving the adapter's missing-sector
 * semantics (warn + continue), NOT a throw.
 */
export function makeFsAtlasLoader(atlasRoot: string): AtlasLoader {
    return async (p: string) => {
        try {
            const data = fs.readFileSync(path.join(atlasRoot, p));
            return new Response(new Uint8Array(data));
        } catch {
            return new Response(null, { status: 404, statusText: 'Not Found (fs atlas loader)' });
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-STAGE TIMING SIDECAR (efficiency review I1/I2)
//
// Persist ONE line per headless run to test_results/perf/stage_timings.jsonl so
// every future perf claim is measurable against a clocked substrate instead of
// the INFERRED/structural numbers the review flagged. The receipt is untouched
// (byte-identical gate holds) — this is a pure SIDECAR. Fully guarded: a
// read-only / racy FS degrades to a no-op, never a thrown run.
// ─────────────────────────────────────────────────────────────────────────────

/** Default sidecar path; overridable via env for redirect (e.g. an aggregate). */
export function stageTimingsPath(): string {
    return process.env.SKYCRUNCHER_PERF_TIMINGS_PATH
        ?? path.join(REPO_ROOT, 'test_results', 'perf', 'stage_timings.jsonl');
}

/**
 * Fold a finished run's events into a timing summary and APPEND it as one JSONL
 * line (summary + writer context `ts`/`source`). Non-fatal by contract.
 */
export function persistStageTimings(events: readonly PipelineEvent[], source = 'headless'): void {
    try {
        const summary = summarizeStageTimings(events, {
            decoderArm: isRawlerDecoderEnabled() ? 'rawler' : 'libraw',
        });
        const line = JSON.stringify({ ts: new Date().toISOString(), source, ...summary }) + '\n';
        const out = stageTimingsPath();
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.appendFileSync(out, line);   // single-syscall append (JSONL-safe under light concurrency)
    } catch {
        /* instrumentation must NEVER break a run (LAW 3 honest-absent) */
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW TABLE SINK (Arrow Carrier program, followup #4 — first production consumer)
//
// When SKYCRUNCHER_ARROW_SINK names a directory, write the run's four TABULAR
// products (matched_stars, detections, forced_confirmed, run_summary) as `.arrow`
// files, so every headless run can emit Arrow alongside its receipt. Mirrors the
// per-stage timing sidecar above: env-gated (env UNSET ⇒ zero behaviour, the
// receipt is byte-identical by construction), fires AFTER the receipt is built,
// and is fully guarded (a read-only / racy FS degrades to a no-op, never a thrown
// run). Tables ride Arrow; rasters ride typed arrays — never mixed. LAW 7: this is
// a pure CONSUMER of the existing `binary_layouts#toolchest_arrow_export` boundary
// (exportAllTables owns the schema/strides) — no layout is defined or changed here.
// ─────────────────────────────────────────────────────────────────────────────

/** Base dir for the Arrow table sink; unset ⇒ sink DISABLED (default OFF). */
export function arrowSinkBaseDir(): string | null {
    return process.env.SKYCRUNCHER_ARROW_SINK ?? null;
}

/**
 * Write the four tabular Arrow products of a finished run into a per-run subdir
 * `<SKYCRUNCHER_ARROW_SINK>/<runId>__<frameSha12>/`. The run id mirrors the timing
 * sidecar's scheme (an ISO timestamp, FS-sanitised); the frame sha ties the dir to
 * the exact input bytes and disambiguates same-instant repeats. A small
 * `manifest.json` records ts/source/frame-sha/receipt-version (the writer-context
 * the sidecar keeps inline). Returns the subdir written, or null (disabled/error).
 * Non-fatal by contract — the receipt is already built and returned unchanged.
 *
 * Takes the frame's PRECOMPUTED sha256 hex (not the raw bytes): the libraw decode
 * arm hands the source ArrayBuffer to its worker via a postMessage TRANSFER, which
 * DETACHES it — so the caller hashes the bytes up front (while still attached) and
 * passes the hex id here. The 12-hex content id is just the first 12 of that sha.
 */
export async function persistArrowTables(
    receipt: unknown,
    frameSha256: string,
    source = 'headless',
): Promise<string | null> {
    const base = arrowSinkBaseDir();
    if (!base) return null;
    try {
        const sha = frameSha256.slice(0, 12);
        const runId = new Date().toISOString().replace(/[:.]/g, '-');
        const dir = path.join(base, `${runId}__${sha}`);
        fs.mkdirSync(dir, { recursive: true });
        const tables = exportAllTables(receipt as Parameters<typeof exportAllTables>[0]);
        for (const [name, table] of Object.entries(tables)) {
            await writeArrowFile(table, path.join(dir, `${name}.arrow`));
        }
        const manifest = {
            ts: new Date().toISOString(),
            source,
            frame_sha256_12: sha,
            receipt_schema_version: (receipt as { version?: string })?.version ?? null,
            tables: Object.keys(tables),
        };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        return dir;
    } catch {
        /* the sink must NEVER break a run (LAW 3 honest-absent) */
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMUNITY SOLVE-PUSH SINK (env-gated, default OFF) — pushes a FINISHED solve's
// receipt to the community R2 store, content-addressed by frame+artifact sha with
// two-level dedup (see tools/community/push_solve.mjs). SAME discipline as the Arrow
// sink above: env UNSET (SKYCRUNCHER_COMMUNITY_PUSH) ⇒ zero behaviour, receipt
// byte-identical by construction; fires AFTER the receipt is built; fully guarded
// (creds-absent OR any error ⇒ silent no-op, never a thrown run). Network I/O is a
// tools-lane concern — the engine never does it. This is the Headless-lane wiring;
// the Batch/overnight FITS rail rides the SAME funnel (it drives runWizardPipeline),
// and the Desktop shell can call pushSolveFromReceipt directly (named follow-up).
//
// FLAG: this file took a merge today (2026-07-11 rawler cutover). The addition is the
// smallest possible — one guarded await mirroring persistArrowTables — and changes
// NOTHING about the receipt or the four Arrow products.
// ─────────────────────────────────────────────────────────────────────────────

/** Base gate for the community solve-push sink; unset ⇒ DISABLED (default OFF). */
export function communityPushEnabled(): boolean {
    return !!process.env.SKYCRUNCHER_COMMUNITY_PUSH;
}

/**
 * Push the finished run's receipt (and, when the caller supplies them, extras) to the
 * community R2 store. Returns the frame's 12-hex content id, or null (disabled / no
 * creds / any error). Non-fatal by contract — the receipt is already built and
 * returned unchanged. `source` tags the origin lane for the (future) desktop seam.
 */
export async function pushCommunitySolve(
    receipt: unknown,
    frameSha256: string,
    source = 'headless',
): Promise<string | null> {
    if (!communityPushEnabled()) return null;
    try {
        const receiptBytes = Buffer.from(JSON.stringify(receipt));
        const frameSha = frameSha256;
        const res = await pushSolveFromReceipt({
            receiptBytes,
            frameSha,
            // env override wins; otherwise the module derives the git short sha.
            engineRef: process.env.SKYCRUNCHER_ENGINE_REF ?? undefined,
            log: (m: string) => console.log(`[community:${source}] ${m}`),
        });
        return res && 'frameSha12' in res ? res.frameSha12 : null;
    } catch {
        /* the sink must NEVER break a run (LAW 3 honest-absent) */
        return null;
    }
}

export interface RunWizardOptions {
    /** Directory the browser's `/atlas/...` URLs resolve against (e.g. `<repo>/public`). */
    atlasRoot: string;
    /** Pre-loaded wasm bytes; defaults to reading the gitignored pkg artifact. */
    wasmBytes?: BufferSource;
    /** step2 metadata overrides (the wizard's observation-details form). */
    overrides?: Partial<HardMetadata>;
    /**
     * Explicit user target hint (upload-surface TargetHintInput) forwarded to the
     * CONFIG rung of the solve hint resolver — a forgiving ~15° search PRIOR, never
     * a measurement. Unreachable before this seam (the session ctor accepts it but
     * runWizardPipeline had no field). For by-eye field centers (±12-20°) this rung
     * is the honest fit where the 4°-tight overrides.ra_hint rung may exclude truth.
     * Receipt provenance rides engine-side (hintSource=CONFIG + user_target_hint).
     * null/absent ⇒ the default FITS-header→zenith→blind ladder, byte-identical.
     */
    callerHint?: CallerTargetHint | null;
    /** Live event tap (in addition to the returned `events` array). */
    onEvent?: (e: PipelineEvent) => void;
    /** Append a per-run line to the stage-timings sidecar (default: true). */
    persistTimings?: boolean;
    /**
     * SEARCH-ORDER PRIORS model (task #20 — lane ① search priors ONLY). Optional
     * caller-injected model, forwarded verbatim to the session (mirrors the
     * browser's `new OrchestratorSession(buffer, { searchPriors })`). When omitted
     * (the default), the session falls back to the env-path load
     * (SOLVER_SEARCH_PRIORS + SOLVER_SEARCH_PRIORS_MODEL_PATH). Null/absent ⇒ the
     * reorder seam is identity ⇒ the pinned headless solve is byte-identical.
     */
    searchPriors?: SearchPriorModel | null;
    /**
     * OPTIONAL pre-detection pixel transform (PIXEL-ledger seam). Applied in step2
     * after decode + luminance/preview derivation and BEFORE detectSignal — e.g. a
     * nebulosity/background LIFT (tools/lift). Absent ⇒ dead code, byte-identical
     * solve (the CR2/SeeStar gates never set it). A returned `marker` stamps the run
     * experimental in the receipt (config_overrides.<name>). See PreDetectTransform.
     */
    preDetectTransform?: PreDetectTransform | null;
}

export interface RunWizardResult {
    /** The v2.2.x wizard receipt (step6_Integrate's exportPacket output). */
    receipt: any;
    /** Every bus event emitted during the run, in emission order. */
    events: PipelineEvent[];
    /** The finished session (solution, signal, forensics — for inspection). */
    session: OrchestratorSession;
    /**
     * The per-run subdir the Arrow tables were written to, or null when the sink
     * was disabled (SKYCRUNCHER_ARROW_SINK unset) or a write failed. Additive and
     * OPTIONAL so existing structural mocks of this result (e.g. the batch-engine
     * BatchSolveFn stand-ins) keep type-checking without change; runWizardPipeline
     * always populates it (string | null). The receipt is unchanged either way.
     */
    arrowDir?: string | null;
}

/**
 * Run the full wizard pipeline headless: step1_Load → step2_Extract →
 * step3_Metrology → step4_Solve → step5_Calibrate → step6_Integrate.
 * Always restores the default (fetch) atlas loader on exit.
 */
export async function runWizardPipeline(buffer: ArrayBuffer, opts: RunWizardOptions): Promise<RunWizardResult> {
    bootRealWasm(opts.wasmBytes);
    StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(opts.atlasRoot));
    // ── FRAME IDENTITY, HASHED BEFORE DECODE (buffer-detach safety) ───────────
    // The libraw decode arm (RAF unconditionally, CR2 cold path) hands `buffer`
    // to its decode Worker via a postMessage TRANSFER, which DETACHES the source
    // ArrayBuffer. Any LATER re-read — the no-solve frame-sha, the Arrow/community
    // sinks — then throws "Cannot perform Construct on a detached ArrayBuffer"
    // (observed on the X-T5 RAF: solve NOT reached ⇒ the no-solve branch hit the
    // detached buffer). The rawler arm copies into wasm linear memory and never
    // detaches, and the rawler-default CR2 gate always solves, which is why this
    // never surfaced there. Hash the exact source bytes ONCE here, while the buffer
    // is guaranteed attached, and thread the hex id downstream — no post-decode read.
    const frameSha256 = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
    try {
        const session = new OrchestratorSession(buffer, {
            generatePreviews: false,
            searchPriors: opts.searchPriors,
            preDetectTransform: opts.preDetectTransform ?? null,
            callerHint: opts.callerHint ?? null,
        });
        const events: PipelineEvent[] = [];
        session.events.subscribe((e) => {
            events.push(e);
            opts.onEvent?.(e);
        });

        await session.step1_Load();
        await session.step2_Extract(opts.overrides);
        await session.step3_Metrology();
        await session.step4_Solve();

        // ── GRACEFUL NO-SOLVE (analytics flywheel, task #16) ─────────────────────
        // A frame that produced NO geometric lock must still bank an honest FAILURE
        // receipt instead of throwing at the step5 calibrate guard (orchestrator_
        // session.ts: `if (!this.solution) throw`). HEADLESS-ENTRY-SCOPED: the guard
        // and the browser wizard path are UNCHANGED — this branch fires ONLY when
        // there is no solution, so the SOLVED path (both pinned reference solves +
        // the .apispec gates) is byte-identical by construction. The batch engine's
        // `no_solve` verdict + run.mjs's `solution===null` exit-2 were built for this
        // receipt but were unreachable while the entry threw first.
        if (!session.solution) {
            // Symmetry with step6's run_finished{ok:true}: mark the run finished-failed
            // so the timing fold + sidecar record ok=false (honest partial run).
            session.events.emit({ kind: 'run_finished', ok: false });
            const decoderArm = isRawlerDecoderEnabled() ? 'rawler' : 'libraw';
            const stageTimings = summarizeStageTimings(events, { decoderArm });
            // `frameSha256` was hashed at entry, BEFORE step1_Load could detach the
            // source buffer (libraw arm) — re-reading `buffer` here would throw.
            const receipt = session.exportFailurePacket({
                stageReached: 'solve',
                stageOfDeath: 'solve',
                stageTimings,
                frameSha256,
            });
            if (opts.persistTimings !== false) persistStageTimings(events);
            // arrowDir/community-push are SOLVE products (need matched_stars) — skipped.
            return { receipt, events, session, arrowDir: null };
        }

        await session.step5_Calibrate();
        // step6_Integrate builds and returns the receipt (exportPacket) and
        // emits run_finished — use its return value directly rather than
        // assembling a second, export_date-skewed copy.
        const receipt = await session.step6_Integrate();

        // Per-stage timing sidecar (I1/I2) — AFTER the receipt is built, so a
        // sidecar-write hiccup can never perturb the byte-identical receipt.
        if (opts.persistTimings !== false) persistStageTimings(events);

        // Arrow table sink — same discipline: env-gated (default OFF), post-receipt,
        // fully guarded. `frameSha256` is the pre-decode hash of the source bytes
        // (the buffer may be detached here on the libraw arm — never re-read it).
        const arrowDir = await persistArrowTables(receipt, frameSha256);

        // Community solve-push sink — SAME discipline (env-gated default OFF,
        // post-receipt, fully guarded, creds-absent no-op). Content-addressed by the
        // pre-decode frame sha; the receipt is unchanged either way.
        await pushCommunitySolve(receipt, frameSha256);

        return { receipt, events, session, arrowDir };
    } finally {
        StarCatalogAdapter.setAtlasLoader(null);
    }
}
