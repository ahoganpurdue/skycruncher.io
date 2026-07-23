/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEAM CAPTURE — env-gated per-stage session-state capsule writer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stage-modular test environment wave (frozen SEAM_CONTRACT v1, 2026-07-12).
 * After every withStage completion (orchestrator_session.ts, single guarded
 * line), this module writes a self-contained "capsule" of the post-stage
 * session state to disk:
 *
 *   <SEAM_CAPTURE_ROOT>/<frame_sha>/<seq>_<stage>/capsule.json   (sidecar)
 *   <SEAM_CAPTURE_ROOT>/<frame_sha>/<seq>_<stage>/<field>.bin    (per typed array)
 *
 * The capsule written after stage N is the INPUT of stage N+1: replay of
 * stage N loads the post-(N-1) capsule, runs the real stage function, and
 * compares against the post-N capsule (contract §1 capture semantics).
 *
 * LEDGER SPLIT (LAW 1, contract §2): COORDINATE payloads (WCS, matched
 * stars, reports) ride the sidecar's `state` JSON inline; PIXEL payloads
 * (scienceBuffer, scienceRgb) are raw little-endian `.bin` files with a
 * sha256 in the sidecar, verified on load by the replay executor.
 *
 * LAW 7: the on-disk byte layout is the enumerated `seam_capsule` boundary in
 * src/engine/contracts/binary_layouts.ts — this writer IMPORTS that module's
 * version const (generative, never mirrored).
 *
 * ── INERTNESS BY CONSTRUCTION (capture-OFF byte-identity argument) ──────────
 * SEAM_CAPTURE_ENABLED is a module-level const boolean computed ONCE at
 * import time. In the browser (`process` undefined) and in Node without
 * CAPTURE_SEAMS=1 it is `false`. The single hook in withStage is
 * `if (SEAM_CAPTURE_ENABLED) await captureSeam(...)` — with the const false
 * that branch is dead: zero awaits, zero allocations, zero reads of session
 * state are added to any pipeline run. Nothing else in this module executes
 * (node:fs / node:crypto are lazily imported INSIDE the enabled path only).
 * Therefore receipts and both pinned reference solves are byte-identical
 * with capture off — not measured-identical, identical because no new code
 * runs. The vitest inertness proof (src/engine/tests/seam_capture.test.ts)
 * pins the const-false half of this argument.
 *
 * ── FAILURE DISCIPLINE (LAW 3, honest-or-absent) ────────────────────────────
 * captureSeam NEVER throws into the pipeline: the whole body is guarded, a
 * failure produces one stderr warning and an absent/partial capsule (a
 * partial capsule still carries every field that snapshotted cleanly; a
 * missing field is honest absence, never a fabricated value).
 */

import { RECEIPT_SCHEMA_VERSION } from './stages/schema_versions';
import { BINARY_LAYOUTS_VERSION } from '../contracts/binary_layouts';
// The CANONICAL receipt serializer (a zero-import pure function). The integrate
// overlay serializes the receipt through THIS — the exact byte path a receipt
// consumer and the integrate replay both use — so heavy typed-array fields
// (anomaly_grid, scienceBuffer, …) are dropped IDENTICALLY on both sides. Using
// the generic jsonSnapshot instead emits {__seam_stripped} markers those two
// paths don't, i.e. a false replay divergence. Keeps seam_capture near-leaf.
import { serializeReceipt } from './stages/receipt_serializer';
// MODULE-GLOBAL state a stage reads but does NOT receive as an input: the spcc
// zeropoint reads the M8 PhotometryManager's STATIC sensor profile (gain LUT),
// set upstream by metadata_reaper (step-1, from ISO/sensor). An isolated replay
// child never runs that upstream, so it would fall back to the default profile →
// a systematic zeropoint offset on byte-identical pixels. Snapshot it into every
// capsule (a zero-import class) so the replay driver can RESTORE it — a faithful
// reproduction of the pipeline's global state, not a fuzz. NOTE: this is the M8
// singleton (m8_photometry/photometry_manager, the one spcc_calibrator imports),
// NOT core/PhotometryManager — two same-named managers exist. (Hidden-global fix.)
import { PhotometryManager } from './m8_photometry/photometry_manager';

/** Capsule sidecar schema version (contract §2). */
export const CAPSULE_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Capture root. Storage law (owner 2026-07-10): K: is a thin virtual disk —
 * large binaries live on D:. Env override SEAM_CAPTURE_ROOT lets tests point
 * at a temp dir (orchestrator-approved addition to the frozen contract).
 */
const DEFAULT_CAPTURE_ROOT = 'D:/AstroLogic/test_artifacts/seams';

/**
 * Module-level const, computed once at import (contract §3 verbatim).
 * Browser-safe: `process` is undefined in the vite build → false.
 */
export const SEAM_CAPTURE_ENABLED = (() => {
    try {
        return typeof process !== 'undefined' && !!process.env && process.env.CAPTURE_SEAMS === '1';
    } catch {
        return false;
    }
})();

/**
 * Read-only structural view over OrchestratorSession (contract §3 field list;
 * the withStage hook passes `this as unknown as SeamSessionView`, which
 * legally bypasses TS `private` at compile time — the session itself is
 * untouched). Types are deliberately loose (`unknown`) so this module stays a
 * near-leaf: its only imports are the two zero-import version constants.
 *
 * FLAGGED DEVIATIONS from the frozen §3 list (report-flagged, not silent):
 *  - `rawSensorDecode` is in the §3 list but NO such property exists on the
 *    session today (the decode record is a step-2 local) — it is kept here
 *    optional and will be honest-absent in every capsule.
 *  - `hardware`, `hintSource`, `spccStars`, `scales` are ADDED: contract §1
 *    row 16 names them as buildReceipt inputs (OS:1377-1399) and §2 mandates
 *    capturing `scales.getFrontendExport()`; without them the integrate
 *    replay cannot reconstruct its ReceiptInputs slice.
 *  - `receipt` is ADDED as a state key for the integrate capsule only (the
 *    receipt lives in the stage's return value, never on the session — with
 *    no compare target the integrate replay would be vacuous).
 */
export interface SeamSessionView {
    // ── contract §3 field list ──
    readonly metadata: unknown;
    readonly signal: unknown;
    readonly solution: unknown;
    readonly planets: unknown;
    readonly hardwareProfile: unknown;
    readonly forensics: unknown;
    readonly warnings: unknown;
    readonly timestampTrusted: unknown;
    readonly spccBlock: unknown;
    readonly psfField: unknown;
    readonly psfAttribution: unknown;
    readonly bcMeasured: unknown;
    readonly bcRematch: unknown;
    readonly opticsHints: unknown;
    readonly userAnnotations: unknown;
    readonly imageWidth: number;
    readonly imageHeight: number;
    readonly solveW: number;
    readonly solveH: number;
    readonly scaleLock: unknown;
    readonly guestList: unknown;
    readonly timestamp: unknown;
    readonly location: unknown;
    readonly sourceFormat: unknown;
    readonly rawSensorDecode?: unknown; // FLAGGED: no such session property today (honest-absent)
    // ── flagged additions (ReceiptInputs completeness, OS:1377-1399 + §2 scales rule) ──
    readonly hardware?: unknown;
    readonly hintSource?: unknown;
    readonly spccStars?: unknown;
    readonly scales?: { getFrontendExport(): unknown } | null;
    readonly receipt?: unknown; // integrate-only, filled from the stage output overlay
    // ── PIXEL-ledger typed arrays (raw .bin, never inline JSON) ──
    readonly scienceBuffer: Float32Array | null;
    readonly scienceRgb: { data: Float32Array; width: number; height: number } | null;
}

/**
 * JSON state fields captured at EVERY seam (self-contained capsules: replay
 * of stage N+1 loads only the post-N capsule, so each capsule carries the
 * full JSON view — it is small next to the buffers). Keys are SeamSessionView
 * property names EXACTLY (contract §2). `undefined` values are omitted
 * (honest-absent), so e.g. `rawSensorDecode` never fabricates.
 */
const JSON_STATE_FIELDS = [
    'metadata', 'signal', 'solution', 'planets', 'hardwareProfile', 'hardware',
    'forensics', 'warnings', 'timestampTrusted', 'spccBlock', 'spccStars',
    'psfField', 'psfAttribution', 'bcMeasured', 'bcRematch', 'opticsHints',
    'userAnnotations', 'hintSource', 'imageWidth', 'imageHeight', 'solveW',
    'solveH', 'scaleLock', 'guestList', 'timestamp', 'location', 'sourceFormat',
    'rawSensorDecode', 'scales',
] as const;

type BufferField = 'scienceBuffer' | 'scienceRgb';

/**
 * PER-STAGE SLICE MAP (contract §3: lives HERE, not in the session).
 * JSON state = JSON_STATE_FIELDS at every seam. Buffers are per-stage:
 * a buffer is captured where it is BORN (compare target of the producing
 * stage), where the NEXT stage in the chain consumes it (replay input), and
 * where a stage could plausibly have touched it (mutation tripwire).
 *
 *  - scienceBuffer (f32 luminance, native or 2x-binned grid): born at
 *    extract; consumed by solve (via post-metrology), psf_field (via
 *    post-spcc_render_gains), bc_rematch (via post-bc_measure),
 *    forced_confirm (via post-bc_rematch), psf (ad-hoc).
 *  - scienceRgb (f32 w·h·3, FITS science path only — null → honest-absent):
 *    born at extract; consumed by spcc (via post-render_apply_sip);
 *    post-spcc capture is the LAW-1 "SPCC left the pixels untouched" tripwire.
 *  - calibrate closes AFTER its nine children (contract §7.2/§7.3 — seq
 *    disambiguates); its capsule is the full enclosing snapshot and the only
 *    one carrying hardwareProfile/forensics born inside it.
 *  - load: the §3 view excludes rawBuffer, so the load capsule is JSON-only
 *    (extract replay stays NOT-YET-REPLAYABLE, matching its §1 verdict).
 */
const SLICE_MAP: Readonly<Record<string, readonly BufferField[]>> = {
    load: [],
    extract: ['scienceBuffer', 'scienceRgb'],
    metrology: ['scienceBuffer'],
    solve: [],
    calibrate: ['scienceBuffer', 'scienceRgb'],
    m7_refine: [],
    render_apply_sip: ['scienceRgb'],
    spcc: ['scienceRgb'],
    spcc_render_gains: ['scienceBuffer'],
    psf_field: ['scienceBuffer'],
    // psf_attribution does not touch scienceBuffer, but bc_measure (its successor)
    // captures it as a mutation tripwire — so it must ride THROUGH here, else
    // bc_measure's replay input (this capsule) lacks the buffer and the tripwire
    // reports a false "missing buffer". Carried unchanged (sha passes through).
    psf_attribution: ['scienceBuffer'],
    bc_measure: ['scienceBuffer'],
    bc_rematch: ['scienceBuffer'],
    forced_confirm: ['scienceBuffer'],
    psf: ['scienceBuffer'],
    integrate: [],
};
/** Unknown/future stage id → JSON-only capsule (honest default, never guess buffers). */
const DEFAULT_SLICE: readonly BufferField[] = [];

/**
 * GLUE-INPUT BACKFILL MAP (task fix #2 — m7_refine STRUCTURAL).
 *
 * A few session fields are born from calibrate-START GLUE — `hardwareProfile`
 * and its alias `hardware` are set by generateHardwareProfile at
 * orchestrator_session.ts:1092-1094, which runs AFTER the pre-calibrate `solve`
 * seam and BEFORE the first calibrate child (`m7_refine`). No withStage wraps
 * that glue, so m7_refine's replay INPUT — the predecessor (solve) capsule — is
 * captured before the glue exists and carries them null. m7_refine does not
 * touch these fields, so recording them into that input capsule reflects
 * m7_refine's TRUE input (the frozen-contract intent: "capture the stage input
 * after the stage's glue runs"). Keyed by the CHILD stage whose predecessor
 * pre-dates the glue; this is the ONLY such seam (every later calibrate child
 * already chains from a post-glue capsule). The backfill is ADD-ONLY (never
 * clobbers a non-null predecessor value) — see captureSeam.
 */
const CALIBRATE_GLUE_INPUT: Readonly<Record<string, readonly string[]>> = {
    m7_refine: ['hardware', 'hardwareProfile'],
};

// ─── internals ────────────────────────────────────────────────────────────────

/** Per-frame capture counter (capture order; nested calibrate closes after its children). */
const seqByFrame = new Map<string, number>();

/** One stderr warning per category — capture noise must never flood a run. */
const warned = new Set<string>();
function warnOnce(category: string, message: string): void {
    if (warned.has(category)) return;
    warned.add(category);
    // stderr on purpose (contract §3: one warning, honest-absent, never a throw).
    console.error(`[seam_capture] ${message}`);
}

function readEnv(name: string): string | undefined {
    try {
        return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Decoder arm as the receipt would record it. Mirrors the authoritative rule
 * in m1_ingestion/rawler_decoder.ts isRawlerDecoderEnabled() ('0'/'false' →
 * libraw cold path, anything else → rawler default arm since the 2026-07-11
 * cutover). Inlined (3 lines) instead of imported because that module pulls
 * the photometry/Arrow graph at module load — too heavy for a capture leaf.
 * FLAGGED deviation: rule duplication, drift-checked by the citation above.
 */
function resolveDecoderArm(): string | null {
    const v = readEnv('VITE_DECODER_RAWLER');
    if (v === '0' || v === 'false') return 'libraw';
    return 'rawler';
}

/** Host-endianness probe: capsules are declared little-endian (contract §2). */
function hostIsLittleEndian(): boolean {
    return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/**
 * JSON snapshot replacer: typed arrays / ArrayBuffers nested inside state
 * objects are replaced with a deterministic marker (same discipline as the
 * receipt path's Float32Array-stripping replacer — PIXEL payloads never ride
 * JSON inline; the enumerated buffers travel as .bin instead).
 */
function stripBinaryReplacer(_key: string, value: unknown): unknown {
    if (ArrayBuffer.isView(value)) {
        return {
            __seam_stripped: value.constructor.name,
            length: (value as unknown as { length?: number }).length ?? value.byteLength,
        };
    }
    if (value instanceof ArrayBuffer) {
        return { __seam_stripped: 'ArrayBuffer', byteLength: value.byteLength };
    }
    return value;
}

/**
 * Synchronous deep JSON snapshot (JSON round-trip, matching the receipt
 * path's number semantics: NaN/±Inf → null, Date → ISO string, undefined →
 * omitted). Returns undefined for non-serializable roots (caller omits).
 */
function jsonSnapshot(v: unknown): unknown {
    const s = JSON.stringify(v, stripBinaryReplacer);
    return s === undefined ? undefined : JSON.parse(s);
}

/**
 * The capsule is defined as POST-stage session state, but several stages are
 * invoked as `this.X = await this.withStage(...)` — the session property is
 * assigned only AFTER the hook fires. Each overlay below is an exact one-line
 * mirror of the caller's own assignment (OS line cited), applied to the
 * SNAPSHOT only (the live session is never touched from here).
 */
function applyOutOverlay(stage: string, out: unknown, state: Record<string, unknown>): void {
    switch (stage) {
        case 'spcc': { // mirrors OS:1063 `this.spccBlock = spcc.block`
            const block = (out as { block?: unknown } | null | undefined)?.block;
            const snap = jsonSnapshot(block ?? null);
            if (snap !== undefined) state.spccBlock = snap;
            break;
        }
        case 'psf_field': // mirrors OS:1108 `this.psfField = await this.withStage(...)`
            state.psfField = jsonSnapshot(out ?? null);
            break;
        case 'psf_attribution': // mirrors OS:1130 `this.psfAttribution = await this.withStage(...)`
            state.psfAttribution = jsonSnapshot(out ?? null);
            break;
        case 'bc_measure': // mirrors OS:1159 `this.bcMeasured = await this.withStage(...)`
            state.bcMeasured = jsonSnapshot(out ?? null);
            break;
        case 'bc_rematch': { // mirrors OS:1196 assignment + OS:1206 `if (this.bcRematch) this.solution.bc_rematch = this.bcRematch`
            const snap = jsonSnapshot(out ?? null);
            state.bcRematch = snap;
            if (out && state.solution && typeof state.solution === 'object') {
                (state.solution as Record<string, unknown>).bc_rematch = snap;
            }
            break;
        }
        case 'forced_confirm': { // mirrors OS:1244 `if (confirmed) this.solution.deep_confirmed = confirmed`
            if (out && state.solution && typeof state.solution === 'object') {
                (state.solution as Record<string, unknown>).deep_confirmed = jsonSnapshot(out);
            }
            break;
        }
        case 'integrate': { // the receipt/packet exists ONLY as the stage output (OS:1345)
            // Serialize through the CANONICAL receipt path (serializeReceipt) — NOT
            // jsonSnapshot — so heavy typed-array fields (e.g. signal.anomaly_grid
            // Uint32Array) are DROPPED exactly as the integrate replay's
            // JSON.parse(serializeReceipt(packet)) drops them, instead of becoming
            // {__seam_stripped} markers the replay can't reproduce.
            // A serialize failure throws to captureSeam's applyOutOverlay guard
            // (recorded as '<out-overlay>', honest-absent) — never fabricates.
            if (out != null) state.receipt = JSON.parse(serializeReceipt(out));
            break;
        }
        default:
            break; // inner-method stages (load/extract/metrology/solve/calibrate/m7_refine) assign session state themselves
    }
}

/** Deterministic sidecar serialization: recursive key sort, then stringify. */
function canonicalize(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            out[k] = canonicalize((v as Record<string, unknown>)[k]);
        }
        return out;
    }
    return v;
}

interface SnappedBuffer {
    field: string;
    dtype: 'float32' | 'uint16' | 'uint8';
    shape: number[];
    byte_length: number;
    units: string;
    bytes: Uint8Array; // the synchronous copy — sole owner after .slice()
}

/**
 * Grid shape for the luminance buffer: native or 2x-binned — the SAME
 * discriminant as OS getExportImage / the forced_confirm predicate
 * (OS:1225-1228). Unresolvable length → flat [len] (honest, never guessed).
 */
function luminanceShape(len: number, w: number, h: number): number[] {
    if (w > 0 && h > 0 && len === w * h) return [h, w];
    const bw = Math.floor(w / 2), bh = Math.floor(h / 2);
    if (bw > 0 && bh > 0 && len === bw * bh) return [bh, bw];
    return [len];
}

/**
 * Capture one seam. NEVER throws into the pipeline (whole body guarded; one
 * stderr warning per failure category). CRITICAL ORDERING (contract §7.1):
 * every read of the view — typed-array .slice() copies AND the JSON
 * round-trip snapshots — happens SYNCHRONOUSLY before the first await, so
 * in-place mutation by successor stages can never contaminate a capsule.
 */
export async function captureSeam(stage: string, out: unknown, view: SeamSessionView): Promise<void> {
    try {
        if (!SEAM_CAPTURE_ENABLED) return;
        const frameId = readEnv('SEAM_FRAME_ID');
        if (!frameId) {
            warnOnce('no-frame-id', 'SEAM_FRAME_ID not set — seam capture skipped (an id is never invented)');
            return;
        }
        if (!hostIsLittleEndian()) {
            warnOnce('big-endian', 'host is not little-endian — capsules are declared LE, capture skipped (honest-absent)');
            return;
        }
        const root = readEnv('SEAM_CAPTURE_ROOT') || DEFAULT_CAPTURE_ROOT;

        // ── SYNCHRONOUS SNAPSHOT SECTION — no await above this line touches the view ──
        const failures: string[] = [];
        const state: Record<string, unknown> = {};
        for (const key of JSON_STATE_FIELDS) {
            try {
                let v: unknown;
                if (key === 'scales') {
                    // Never capture the ScaleManager instance — only its frontend export (contract §2).
                    v = view.scales ? view.scales.getFrontendExport() : view.scales;
                } else {
                    v = (view as unknown as Record<string, unknown>)[key];
                }
                if (v === undefined) continue; // honest-absent
                const snap = jsonSnapshot(v);
                if (snap !== undefined) state[key] = snap;
            } catch {
                failures.push(key);
            }
        }
        try {
            applyOutOverlay(stage, out, state);
        } catch {
            failures.push('<out-overlay>');
        }

        const buffers: SnappedBuffer[] = [];
        for (const bkey of SLICE_MAP[stage] ?? DEFAULT_SLICE) {
            try {
                if (bkey === 'scienceBuffer') {
                    const src = view.scienceBuffer;
                    if (!src) continue; // honest-absent (e.g. pre-extract)
                    const copy = src.slice(); // SYNCHRONOUS deep copy — successor stages mutate in place
                    buffers.push({
                        field: 'scienceBuffer',
                        dtype: 'float32',
                        shape: luminanceShape(copy.length, view.imageWidth, view.imageHeight),
                        byte_length: copy.byteLength,
                        units: 'linear luminance, engine PIXEL-ledger grid (native or 2x-binned), domain as produced by stages/ingest computeluminance — NOT calibrated ADU',
                        bytes: new Uint8Array(copy.buffer, 0, copy.byteLength),
                    });
                } else if (bkey === 'scienceRgb') {
                    const src = view.scienceRgb;
                    if (!src || !src.data) continue; // honest-absent (non-FITS paths)
                    const copy = src.data.slice();
                    const shaped = copy.length === src.width * src.height * 3;
                    buffers.push({
                        field: 'scienceRgb',
                        dtype: 'float32',
                        shape: shaped ? [src.height, src.width, 3] : [copy.length],
                        byte_length: copy.byteLength,
                        units: 'linear interleaved RGB channel intensity (FITS science path), engine PIXEL-ledger native grid',
                        bytes: new Uint8Array(copy.buffer, 0, copy.byteLength),
                    });
                }
            } catch {
                failures.push(bkey);
            }
        }
        const seq = (seqByFrame.get(frameId) ?? 0) + 1;
        seqByFrame.set(frameId, seq);
        // ── END SYNCHRONOUS SECTION — everything below operates on the copies only ──

        // Lazy node-only imports inside the enabled path (contract §3: no
        // top-level node:fs — import failure is a warn-once no-op). Same
        // in-src precedent as m1_ingestion/rawler_decoder.ts:213-215.
        let fs: typeof import('node:fs/promises');
        let crypto: typeof import('node:crypto');
        let path: typeof import('node:path');
        try {
            fs = await import('node:fs/promises');
            crypto = await import('node:crypto');
            path = await import('node:path');
        } catch (err) {
            warnOnce('node-imports', `node module import failed (${err instanceof Error ? err.message : String(err)}) — capture is a no-op in this runtime`);
            return;
        }

        const seqStr = String(seq).padStart(2, '0');
        const dir = path.join(root, frameId, `${seqStr}_${stage}`);
        await fs.mkdir(dir, { recursive: true });

        const bufferEntries = [];
        for (const b of buffers) {
            const file = `${b.field}.bin`;
            await fs.writeFile(path.join(dir, file), b.bytes);
            bufferEntries.push({
                field: b.field,
                dtype: b.dtype,
                shape: b.shape,
                byte_length: b.byte_length,
                endianness: 'LE',
                units: b.units,
                sha256: crypto.createHash('sha256').update(b.bytes).digest('hex'),
                file,
            });
        }

        const sidecar = {
            capsule_schema_version: CAPSULE_SCHEMA_VERSION,
            stage,
            seq: seqStr,
            frame_sha: frameId,
            receipt_schema_version: RECEIPT_SCHEMA_VERSION,
            binary_layouts_version: BINARY_LAYOUTS_VERSION,
            engine_commit: readEnv('SEAM_ENGINE_COMMIT') ?? null,
            decoder_arm: resolveDecoderArm() ?? null,
            // Captured MODULE-GLOBAL state (not a session field) — the singleton
            // sensor profile spcc's zeropoint depends on. The replay driver restores
            // it before running the stage. Guarded: never fails the capture.
            photometry_profile: (() => { try { return PhotometryManager.getProfile(); } catch { return null; } })(),
            buffers: bufferEntries,
            state,
        };
        // Deterministic bytes (sorted keys) + tmp→rename so a torn write can
        // never be mistaken for a complete capsule (the sidecar is the commit
        // marker; .bin files are written first).
        const json = JSON.stringify(canonicalize(sidecar), null, 2) + '\n';
        const finalPath = path.join(dir, 'capsule.json');
        const tmpPath = `${finalPath}.tmp`;
        await fs.writeFile(tmpPath, json, 'utf8');
        await fs.rename(tmpPath, finalPath);

        // ── glue-input backfill (task fix #2) ────────────────────────────────
        // For a stage whose replay INPUT (its predecessor capsule) pre-dates a
        // calibrate-start glue product it needs, ADD the glue fields (unchanged
        // by this stage) into that predecessor capsule so the input reflects the
        // stage's true pre-conditions. Add-only, deterministic re-emit, guarded.
        const glueFields = CALIBRATE_GLUE_INPUT[stage];
        if (glueFields && seq > 1) {
            try {
                const predSeqStr = String(seq - 1).padStart(2, '0');
                const frameDir = path.join(root, frameId);
                const predName = (await fs.readdir(frameDir)).find((n) => n.startsWith(`${predSeqStr}_`));
                if (!predName) {
                    warnOnce(`glue-backfill:${stage}`, `stage '${stage}': predecessor capsule (seq ${predSeqStr}) not found — glue-input backfill skipped (honest-absent)`);
                } else {
                    const predPath = path.join(frameDir, predName, 'capsule.json');
                    const predSidecar = JSON.parse(await fs.readFile(predPath, 'utf8'));
                    if (!predSidecar.state || typeof predSidecar.state !== 'object') predSidecar.state = {};
                    const predState = predSidecar.state as Record<string, unknown>;
                    let changed = false;
                    for (const f of glueFields) {
                        const cur = state[f];
                        if (cur != null && predState[f] == null) { predState[f] = cur; changed = true; }
                    }
                    if (changed) {
                        const predJson = JSON.stringify(canonicalize(predSidecar), null, 2) + '\n';
                        const predTmp = `${predPath}.tmp`;
                        await fs.writeFile(predTmp, predJson, 'utf8');
                        await fs.rename(predTmp, predPath);
                    }
                }
            } catch (err) {
                warnOnce(`glue-backfill:${stage}`, `stage '${stage}': glue-input backfill failed (${err instanceof Error ? err.message : String(err)}) — replay input may lack calibrate-glue fields`);
            }
        }

        if (failures.length > 0) {
            warnOnce(`fields:${stage}`, `stage '${stage}': field(s) [${failures.join(', ')}] failed to snapshot — recorded honest-absent`);
        }
    } catch (err) {
        warnOnce('capture-failure', `capture failed (${err instanceof Error ? err.message : String(err)}) — pipeline unaffected (honest-absent capsule)`);
    }
}
