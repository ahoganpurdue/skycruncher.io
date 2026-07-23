// ═══════════════════════════════════════════════════════════════════════════
// tools/api stage_replay driver — vitest-hosted half of the replay executor
// ═══════════════════════════════════════════════════════════════════════════
// SEAM_CONTRACT v1 §5 (frozen 2026-07-12). Spawned by
// tools/testkit/lib/executors/stage_replay.mjs as
//     node node_modules/vitest/vitest.mjs run -c tools/api/replay.config.ts
// with env: SEAM_REPLAY_STAGE · SEAM_REPLAY_INPUT_DIR (the frozen post-(N−1)
// capsule = stage N's input) · SEAM_REPLAY_OUT_DIR (where the REPLAYED capsule
// lands). Same pattern as solve_to_receipt.runspec.ts — a plain .mjs cannot
// resolve the engine `@/` alias or boot the compiled wasm.
//
// ONLY JOB: load the input capsule (sha-verified, loud fail), run the REAL
// stage function with the exact orchestrator_session wiring, write the
// replayed state + post-stage buffer shas as a capsule-format directory.
// ALL comparison (IEEE-exact JSON + byte-level buffers) happens in the
// executor (.mjs) so it stays testable without vitest. Data-dumper contract:
// the single assert is "the artifact landed"; verdicts are the executor's job.
//
// v1 replayable stages (contract §1): m7_refine · spcc · psf_field ·
// psf_attribution · bc_measure · psf (optional) · integrate (buildReceipt
// level — depositFromReceipt is deliberately NOT called; pure function only).
//
// HONEST LIMITATIONS (flagged in the builder report):
//  • The session's warn() side-channel on stage-internal catches is not
//    replayed; if a frozen capsule's `warnings` gained an entry inside the
//    stage, the compare surfaces it as an honest mismatch (never hidden).
//  • scienceRgb dims are read from the inline JSON half when present, else
//    disambiguated from the sidecar buffer shape against imageWidth/imageHeight
//    (meta-coherence rule — the 60Da lesson: exact-meta match wins).
//  • integrate consumes the capsule's RECORDED decoder_arm (deterministic),
//    never the live env flag.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// REAL compiled wasm (SAME specifier family the engine uses → one module
// instance under vitest). replay.config.ts empties setupFiles to dodge the base
// suite's wasm MOCK, but that also means NOTHING boots the real module — so the
// stages that reach into it (m7_refine → SkyTransform.gnomonicProject →
// wasm.gnomonic_project; psf_field → refine_stars_lm) get `undefined` fns and
// silently degrade. We initSync it here exactly as the api-harness does
// (headless_driver.bootRealWasm) so the replay runs the REAL numeric path.
import * as wasm from '@/engine/wasm_compute/pkg/wasm_compute';
import { applyAstrometricRefinement } from '@/engine/pipeline/stages/calibrate';
import { ResidualAnalyzer } from '@/engine/pipeline/m7_astrometry/residual_analyzer';
import { runSpcc, surfaceSpccPerStar } from '@/engine/pipeline/stages/science';
import { runPsfCharacterization } from '@/engine/pipeline/stages/psf_characterize';
import { runPsfAttribution } from '@/engine/pipeline/stages/psf_attribution';
import { measureBrownConradyFromSolution } from '@/engine/pipeline/m2_hardware/lens_distortion_refit';
import { runPsfStage } from '@/engine/pipeline/m10_psf/psf_stage';
import { buildReceipt } from '@/engine/pipeline/stages/package';
import { serializeReceipt } from '@/engine/pipeline/stages/receipt_serializer';
// The M8 singleton spcc_calibrator imports (NOT core/PhotometryManager — two
// same-named managers exist); set upstream by metadata_reaper, absent here.
import { PhotometryManager } from '@/engine/pipeline/m8_photometry/photometry_manager';

const STAGE = process.env.SEAM_REPLAY_STAGE;
const INPUT_DIR = process.env.SEAM_REPLAY_INPUT_DIR;
const OUT_DIR = process.env.SEAM_REPLAY_OUT_DIR;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_BG_PATH = path.join(REPO_ROOT, 'src', 'engine', 'wasm_compute', 'pkg', 'wasm_compute_bg.wasm');

/**
 * Boot the REAL compiled wasm (idempotent: initSync early-returns once the
 * module singleton exists), then a cheap post-boot sentinel so a botched boot
 * fails HERE, not as a cryptic mid-stage `undefined is not a function`. Mirrors
 * headless_driver.bootRealWasm; inlined (not imported) so the driver stays a
 * near-leaf and never pulls the CR2/Arrow/community graph headless_driver carries.
 */
function bootRealWasm(): void {
    wasm.initSync({ module: fs.readFileSync(WASM_BG_PATH) as any });
    const sep = wasm.calculate_angular_separation(0, 0, 0, Math.PI / 2);
    if (!(Math.abs(sep - Math.PI / 2) < 1e-12)) {
        throw new Error(`[replay driver] wasm post-boot sentinel failed: calculate_angular_separation(0,0,0,π/2)=${sep}, expected π/2`);
    }
}

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

function toTyped(dtype: string, buf: Buffer): Float32Array | Uint16Array | Uint8Array {
    // fresh aligned ArrayBuffer copy (a Buffer's backing store may be offset)
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    if (dtype === 'float32') return new Float32Array(ab);
    if (dtype === 'uint16') return new Uint16Array(ab);
    if (dtype === 'uint8') return new Uint8Array(ab);
    throw new Error(`[replay driver] unsupported buffer dtype "${dtype}"`);
}

function typedBytes(a: Float32Array | Uint16Array | Uint8Array): Uint8Array {
    return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

// deterministic sidecar serialization (contract §2: stable-stringify sorted keys)
function sortDeep(v: any): any {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
        const o: any = {};
        for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
        return o;
    }
    return v;
}

function loadCapsule(dir: string) {
    const sidecarPath = path.join(dir, 'capsule.json');
    if (!fs.existsSync(sidecarPath)) throw new Error(`[replay driver] capsule.json missing at ${dir}`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    const buffers: Record<string, Float32Array | Uint16Array | Uint8Array> = {};
    const bufMeta: Record<string, any> = {};
    for (const b of sidecar.buffers ?? []) {
        bufMeta[b.field] = b;
        if (!b.file) continue;
        if (b.endianness && b.endianness !== 'LE') throw new Error(`[replay driver] buffer ${b.field}: endianness ${b.endianness} unsupported (contract §2: LE)`);
        const bytes = fs.readFileSync(path.join(dir, b.file));
        const got = sha256(bytes);
        if (got !== b.sha256) throw new Error(`[replay driver] buffer ${b.field}: sha256 mismatch on load (${got.slice(0, 12)}… != ${String(b.sha256).slice(0, 12)}…) — refusing partial replay`);
        buffers[b.field] = toTyped(b.dtype, bytes);
    }
    return { sidecar, state: sidecar.state as any, buffers, bufMeta };
}

function need(state: any, keys: string[], stage: string) {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(state, k)) {
            throw new Error(`[replay driver] input capsule missing required state key "${k}" for stage ${stage} — capture slice gap (SEAM_CONTRACT §1)`);
        }
    }
}

// Instrumentation (task fix #3): several stages degrade a THROW to null exactly
// as orchestrator_session does (never fatal). That swallowed throw is the very
// thing needed to localize a null-vs-object replay mismatch — record it on the
// replayed state (extra key; the executor ignores got-only keys, so no NEW
// mismatch, and the divergence dossier surfaces it). Exactly one stage runs per
// replay child, so a single slot is sufficient.
function recordReplayError(state: any, stage: string, e: unknown) {
    state.__replay_stage_error = { stage, message: e instanceof Error ? e.message : String(e) };
}

// scienceRgb session shape (orchestrator_session.ts:150):
// { data: Float32Array; width; height } — data rides as .bin, dims from the
// inline JSON half when captured, else from the sidecar shape (meta-coherent).
function rebuildScienceRgb(state: any, buffers: Record<string, any>, bufMeta: Record<string, any>): { data: Float32Array; width: number; height: number } | null {
    const data = buffers['scienceRgb'] as Float32Array | undefined;
    if (!data) return null;
    const inline = state.scienceRgb;
    if (inline && Number.isFinite(inline.width) && Number.isFinite(inline.height)) {
        return { data, width: inline.width, height: inline.height };
    }
    const shape: number[] | undefined = bufMeta['scienceRgb']?.shape;
    const W = state.imageWidth, H = state.imageHeight;
    if (Array.isArray(shape) && shape.length === 3) {
        if (shape[0] === H && shape[1] === W) return { data, width: W, height: H };   // [h,w,3] row-major
        if (shape[0] === W && shape[1] === H) return { data, width: W, height: H };   // [w,h,3]
    }
    if (Number.isFinite(W) && Number.isFinite(H) && data.length === W * H * 3) {
        return { data, width: W, height: H };                                          // exact-meta match
    }
    throw new Error(`[replay driver] cannot resolve scienceRgb dims (shape=${JSON.stringify(shape)}, imageW/H=${W}/${H}, len=${data.length}) — refusing to guess`);
}

describe('seam-replay driver — run one REAL stage over a frozen input capsule', () => {
    it('replays the stage and writes the replayed capsule', async () => {
        if (!STAGE || !INPUT_DIR || !OUT_DIR) {
            throw new Error('SEAM_REPLAY_STAGE, SEAM_REPLAY_INPUT_DIR and SEAM_REPLAY_OUT_DIR env vars are required (run via tools/testkit stage_replay executor)');
        }
        bootRealWasm();   // real numeric path for m7_refine (gnomonic_project) + psf_field (refine_stars_lm)
        const { sidecar, state, buffers, bufMeta } = loadCapsule(INPUT_DIR);

        // Restore the captured MODULE-GLOBAL sensor profile (spcc's zeropoint reads
        // PhotometryManager's static singleton, set upstream by metrology/hardware —
        // absent in this isolated child, which would otherwise use DEFAULT_PROFILE).
        // A faithful reproduction of the pipeline's global state (SEAM_CONTRACT
        // hidden-global-state fix), NOT a mask.
        if (sidecar.photometry_profile) PhotometryManager.setProfile(sidecar.photometry_profile);

        // ── run the REAL stage fn with the exact orchestrator_session wiring ──
        switch (STAGE) {
            case 'm7_refine': {
                // OS:1085-1092 — applyAstrometricRefinement mutates solution.astrometry
                // in place (calibrate.ts:48-55); the mutated solution IS the output.
                need(state, ['solution'], STAGE);
                if (state.solution) {
                    applyAstrometricRefinement(state.solution);
                    // Instrumentation (task fix #3-class): applyAstrometricRefinement
                    // swallows a ResidualAnalyzer failure in its own non-fatal catch
                    // (calibrate.ts:78). If it left no astrometry, re-run the analyzer
                    // in a DIAGNOSTIC try to surface the actual throw (localization) —
                    // output-neutral (the replayed capsule is already written from state).
                    if (state.solution && !state.solution.astrometry) {
                        try {
                            ResidualAnalyzer.analyze(state.solution);
                            recordReplayError(state, STAGE, new Error('applyAstrometricRefinement produced no solution.astrometry, yet a diagnostic ResidualAnalyzer.analyze re-ran cleanly — inspect the assignment/TPS path in calibrate.ts'));
                        } catch (e) { recordReplayError(state, STAGE, e); }
                    }
                }
                break;
            }
            case 'spcc': {
                // OS:1147-1166 — runSpcc(matched, scienceRgb, scales=null, exposure,
                // isFits, airMass=1.0) then surfaceSpccPerStar; lands spccBlock/spccStars.
                need(state, ['solution', 'sourceFormat'], STAGE);
                const rgb = rebuildScienceRgb(state, buffers, bufMeta);
                const matched = state.solution?.matched_stars ?? [];
                const out = runSpcc(
                    matched,
                    rgb,
                    null,
                    state.metadata?.exposure_time || 1,
                    state.sourceFormat === 'FITS',
                    1.0,
                    (msg: string) => console.log(`[replay] ${msg}`),
                );
                state.spccBlock = out.block;
                state.spccStars = out.cal ? surfaceSpccPerStar(out.cal, matched) : undefined;
                break;
            }
            case 'psf_field': {
                // OS:1206-1219 — NATIVE dims passed; grid disambiguation happens inside
                // runPsfCharacterization. OS catch degrades to null (never fatal).
                need(state, ['solution', 'imageWidth', 'imageHeight'], STAGE);
                try {
                    state.psfField = runPsfCharacterization({
                        scienceBuffer: (buffers['scienceBuffer'] as Float32Array) ?? null,
                        width: state.imageWidth,
                        height: state.imageHeight,
                        solution: state.solution,
                    });
                } catch (e) { state.psfField = null; recordReplayError(state, STAGE, e); }
                break;
            }
            case 'psf_attribution': {
                // OS:1228-1244 — pure sync decomposition; catch degrades to null.
                need(state, ['solution', 'metadata', 'imageWidth', 'imageHeight', 'timestampTrusted'], STAGE);
                try {
                    state.psfAttribution = runPsfAttribution({
                        psfField: state.psfField ?? null,
                        solution: state.solution,
                        metadata: state.metadata,
                        imageWidth: state.imageWidth,
                        imageHeight: state.imageHeight,
                        timestampTrusted: state.timestampTrusted,
                    });
                } catch (e) { state.psfAttribution = null; recordReplayError(state, STAGE, e); }
                break;
            }
            case 'bc_measure': {
                // OS:1257-1274 — measured Brown-Conrady observation; catch → null.
                need(state, ['solution', 'imageWidth', 'imageHeight'], STAGE);
                try {
                    state.bcMeasured = measureBrownConradyFromSolution(state.solution, state.imageWidth, state.imageHeight);
                } catch (e) { state.bcMeasured = null; recordReplayError(state, STAGE, e); }
                break;
            }
            case 'psf': {
                // OS:1420-1439 — grid disambiguation (native vs 2×-binned) replicated
                // exactly, then runPsfStage; report.grid stamped by the caller.
                need(state, ['imageWidth', 'imageHeight'], STAGE);
                const lum = buffers['scienceBuffer'] as Float32Array | undefined;
                if (!lum) throw new Error('[replay driver] psf stage needs a scienceBuffer buffer in the input capsule');
                const isBinned = lum.length === (Math.floor(state.imageWidth / 2) * Math.floor(state.imageHeight / 2))
                    && lum.length !== state.imageWidth * state.imageHeight;
                const bw = isBinned ? Math.floor(state.imageWidth / 2) : state.imageWidth;
                const bh = isBinned ? Math.floor(state.imageHeight / 2) : state.imageHeight;
                if (lum.length !== bw * bh) throw new Error(`[replay driver] psf: buffer length ${lum.length} matches neither native nor binned dims`);
                const report: any = await runPsfStage({ lum, width: bw, height: bh });
                report.grid = isBinned ? 'SCIENCE_BINNED2X' : 'SCIENCE_NATIVE';
                state.psfReport = report;
                break;
            }
            case 'integrate': {
                // OS:1483-1509 — buildReceipt(ReceiptInputs), a pure function of the
                // session slice. depositFromReceipt (side-channel) deliberately NOT
                // called. decoderArm = the capsule's RECORDED arm (deterministic).
                // The replayed receipt goes through serializeReceipt (the canonical
                // byte path — Float32Array-stripping replacer) then re-parses, so the
                // JSON compare sees exactly what a receipt consumer would.
                need(state, ['metadata', 'signal', 'solution', 'warnings', 'timestampTrusted', 'imageWidth', 'imageHeight'], STAGE);
                const scalesExport = (state as any).scalesExport ?? (state as any).scales;
                if (scalesExport === undefined) console.warn('[replay driver] integrate: no scalesExport/scales key in capsule state — passing undefined (divergence, if any, will surface in the compare)');
                const packet = buildReceipt({
                    metadata: state.metadata,
                    signal: state.signal,
                    solution: state.solution,
                    planets: state.planets ?? [],
                    hardware: state.hardwareProfile ?? state.hardware ?? null,
                    forensics: state.forensics ?? null,
                    scales: scalesExport,
                    warnings: state.warnings ?? [],
                    timestampTrusted: !!state.timestampTrusted,
                    spcc: state.spccBlock ?? undefined,
                    spccStars: state.spccStars ?? undefined,
                    psfField: state.psfField ?? null,
                    psfAttribution: state.psfAttribution ?? null,
                    bcMeasured: state.bcMeasured ?? null,
                    opticsHints: state.opticsHints ?? undefined,
                    hintSource: state.hintSource ?? null,
                    userAnnotations: state.userAnnotations ?? null,
                    // FAITHFUL to orchestrator_session.ts:1524 — the receipt's
                    // pipeline_provenance.decoder_arm is the arm ACTUALLY USED: null
                    // unless a raw sensor decode happened (FITS/demo → null; CR2 →
                    // the env arm). The capsule's sidecar.decoder_arm is env-derived
                    // (rawler default), so gate it on the captured rawSensorDecode —
                    // otherwise a FITS replay fabricates 'rawler' where the real
                    // receipt recorded null (task fix #1 follow-on divergence).
                    decoderArm: state.rawSensorDecode ? (sidecar.decoder_arm ?? null) : null,
                    imageWidth: state.imageWidth,
                    imageHeight: state.imageHeight,
                } as any);
                state.receipt = JSON.parse(serializeReceipt(packet));
                break;
            }
            default:
                throw new Error(`[replay driver] stage "${STAGE}" is not in the v1 replayable set — the executor should have skipped it (skip_not_replayable)`);
        }

        // ── write the REPLAYED capsule (same format; tmp→rename) ──────────────
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const outBuffers: any[] = [];
        for (const [field, meta] of Object.entries(bufMeta)) {
            const arr = buffers[field];
            if (!arr) { outBuffers.push({ ...(meta as any) }); continue; }         // sha-only entry passes through
            const bytes = typedBytes(arr);
            const postSha = sha256(bytes);
            const changed = postSha !== (meta as any).sha256;
            let file: string | null = null;
            if (changed) {                                                          // mutated in place → bank bytes for byte-level diff
                file = `${field}.bin`;
                fs.writeFileSync(path.join(OUT_DIR, file), bytes);
            }
            outBuffers.push({
                ...(meta as any),
                sha256: postSha,
                byte_length: bytes.byteLength,
                file: changed ? file : null,                                        // unchanged → sha-only (executor compares shas)
                unchanged_from_input: !changed,
            });
        }
        const outSidecar = {
            capsule_schema_version: sidecar.capsule_schema_version,
            stage: STAGE,
            seq: sidecar.seq ?? null,
            frame_sha: sidecar.frame_sha ?? null,
            receipt_schema_version: sidecar.receipt_schema_version ?? null,
            binary_layouts_version: sidecar.binary_layouts_version ?? null,
            engine_commit: process.env.SEAM_ENGINE_COMMIT ?? null,
            decoder_arm: sidecar.decoder_arm ?? null,
            replayed: true,
            buffers: outBuffers,
            state,
        };
        const tmp = path.join(OUT_DIR, 'capsule.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(sortDeep(outSidecar)), 'utf8');
        fs.renameSync(tmp, path.join(OUT_DIR, 'capsule.json'));

        expect(fs.existsSync(path.join(OUT_DIR, 'capsule.json'))).toBe(true);
    });
});
