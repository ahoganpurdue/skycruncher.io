#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/stage_replay.mjs — REAL stage-replay executor
// ═══════════════════════════════════════════════════════════════════════════
// SEAM_CONTRACT v1 §5 (frozen 2026-07-12). Replays ONE pipeline stage against a
// frozen seam-capsule pair: load the post-(N−1) capsule (the stage's input),
// run the REAL stage function, compare against the frozen post-N capsule —
// IEEE-exact. JSON side: deep-equal on parsed values with Object.is per number
// (catches −0). Binary side: sha256 first, then byte-equal with the first
// divergence offset. This is the LAW-2 inner-loop lever: one stage re-verified
// without re-decoding or re-solving. Full battery still runs at checkpoints.
//
// CAPSULE FORMAT (contract §2): <seams_root>/<frame_sha>/<seq>_<stage>/ holding
// capsule.json (sidecar: schema version, stage, seq, frame_sha, buffers[] with
// per-buffer sha256, JSON-safe `state`) + one <field>.bin per typed array
// (raw little-endian, NO header — the sidecar is the sole layout authority).
// Buffers are sha256-verified on load: LOUD fail (capsule_invalid, RED), never
// a silent partial replay.
//
// TS EXECUTION (contract §5 last bullet): the stage functions are .ts and can
// only run under the vitest harness (same constraint as solve_to_receipt.mjs —
// headless_driver docstring: "must run under the vitest harness, NOT plain
// tsx"). This executor therefore spawns
//     node node_modules/vitest/vitest.mjs run -c tools/api/replay.config.ts
// which hosts tools/api/stage_replay.replayspec.ts (the replay driver), with
// the stage + capsule dirs threaded via env vars. The driver loads the input
// capsule, runs the real stage fn, and writes a REPLAYED capsule (same format);
// all comparison happens HERE in plain Node so it is testable without vitest.
//
// OUTCOMES (contract §5):
//   pass                 IEEE-exact match on every expected state leaf + buffer  (not red)
//   mismatch             any divergence (first_divergence recorded)              (RED)
//   capsule_invalid      sha/schema/missing-file failure loading a capsule       (RED, infra)
//   skip_not_replayable  stage is NOT-YET-REPLAYABLE v1 (named blocker)          (honest, NOT red)
//   error_driver         replay child crashed / timed out / wrote no capsule     (RED, infra)
//                        [addition beyond the contract's four — a child-crash
//                        lane necessarily exists; safest is RED, never a
//                        fabricated verdict. FLAGGED in the builder report.]
//
// integrate env-sensitivity (contract risk #4): the driver consumes the
// capsule's RECORDED decoder_arm for the ReceiptInputs field, and this executor
// additionally pins VITE_DECODER_RAWLER to that arm on the child. A receipt-
// schema-version bump legitimately diverges frozen integrate capsules — that
// surfaces as an honest mismatch (first_divergence path 'receipt.version');
// re-freezing is an enumerated rebaseline decision, never automatic.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runToCompletion } from '../child.mjs';
import { depositRow, tail } from './common.mjs';

export const NAME = 'stage_replay';
export const iterates = 'capsules';
export const CHILD_TIMEOUT_MS = 300_000;      // vitest boot + wasm init + one stage
export const CAPSULE_SCHEMA_MAJOR = '1.';     // accepted capsule_schema_version prefix

// ── the v1 replay set (contract §1, VERDICT column) ───────────────────────────
// forced_confirm resolved NOT-YET by the mandated grep (builder-2, 2026-07-12):
// runPostSolveConfirmation (m6_plate_solve/solver_entry.ts:2471) calls
// StarCatalogAdapter.getinstance() at :2506, ensureSectorLoaded at :2508 and
// findStarsInField at :2510 — catalog/atlas-dependent (338MB local-only
// singleton), same blocker class as solve/bc_rematch.
export const REPLAYABLE_STAGES = Object.freeze([
  'm7_refine', 'spcc', 'psf_field', 'psf_attribution', 'bc_measure', 'psf', 'integrate',
]);

// Named blockers for every NOT-YET stage (contract §1) — deposited verbatim in
// the honest skip row so a skip is never an unexplained absence.
export const NOT_YET_BLOCKERS = Object.freeze({
  load: 'private step1_LoadInner over the live session; no upstream seam to skip (contract §1 #1)',
  extract: 'decoder Worker/wasm + cache + WebGPU + ScaleManager instance (contract §1 #2)',
  metrology: 'PARTIAL — resolveScaleLock blind Tri-Lock rung unverified (contract §1 #3)',
  solve: 'StarCatalogAdapter singleton + atlas + wasm + wall-clock blindBudgetMs; ephemeris handshake mutates solution inside the same seam (contract §1 #4)',
  calibrate: 'composite enclosing wrapper — replay its children instead (contract §1 #5)',
  render_apply_sip: 'render plane; headless path is {applied:false} (contract §1 #7)',
  spcc_render_gains: 'render closure (contract §1 #9)',
  bc_rematch: 'StarCatalogAdapter/atlas 338MB singleton; v2 promotable with catalog bootstrap (contract §1 #13)',
  forced_confirm: 'catalog-dependent: StarCatalogAdapter.getinstance()/ensureSectorLoaded/findStarsInField at solver_entry.ts:2506-2510 (grep-resolved NOT-YET v1 per contract §1 #14 contingency)',
});

// ── helpers ───────────────────────────────────────────────────────────────────
export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Honest formatter for divergence reporting: JSON.stringify erases −0, so print
// it explicitly (the whole point of the Object.is compare).
function fmt(v) {
  if (typeof v === 'number' && Object.is(v, -0)) return '-0';
  if (v === undefined) return '(absent)';
  try { const s = JSON.stringify(v); return s.length > 200 ? s.slice(0, 200) + '…' : s; } catch { return String(v); }
}

class CapsuleError extends Error { }

/**
 * Load + validate one capsule dir per contract §2. Returns
 * { sidecar, dir, binPaths } — buffer BYTES are sha-verified here (loud fail)
 * but not retained in memory (byte-level diff re-reads on demand).
 * Throws CapsuleError on any schema/sha/missing-file problem.
 */
export function loadCapsule(dir, { verifyBuffers = true } = {}) {
  const sidecarPath = path.join(dir, 'capsule.json');
  if (!fs.existsSync(sidecarPath)) throw new CapsuleError(`capsule.json missing at ${dir}`);
  let sidecar;
  try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); }
  catch (e) { throw new CapsuleError(`capsule.json unparseable at ${dir}: ${e.message}`); }
  const v = sidecar.capsule_schema_version;
  if (typeof v !== 'string' || !v.startsWith(CAPSULE_SCHEMA_MAJOR)) {
    throw new CapsuleError(`capsule_schema_version "${v}" not accepted (want ${CAPSULE_SCHEMA_MAJOR}x) at ${dir}`);
  }
  if (typeof sidecar.stage !== 'string' || sidecar.state == null || typeof sidecar.state !== 'object') {
    throw new CapsuleError(`sidecar missing stage/state at ${dir}`);
  }
  const buffers = Array.isArray(sidecar.buffers) ? sidecar.buffers : [];
  const binPaths = {};
  for (const b of buffers) {
    if (!b.file) { binPaths[b.field] = null; continue; }   // recorded-sha-only entry (unchanged pass-through)
    const p = path.join(dir, b.file);
    if (!fs.existsSync(p)) throw new CapsuleError(`buffer file ${b.file} (field ${b.field}) missing at ${dir}`);
    if (verifyBuffers) {
      const bytes = fs.readFileSync(p);
      if (b.byte_length != null && bytes.length !== b.byte_length) {
        throw new CapsuleError(`buffer ${b.field}: byte_length ${bytes.length} != sidecar ${b.byte_length} at ${dir}`);
      }
      const got = sha256Hex(bytes);
      if (got !== b.sha256) {
        throw new CapsuleError(`buffer ${b.field}: sha256 ${got.slice(0, 12)}… != sidecar ${String(b.sha256).slice(0, 12)}… at ${dir} — refusing partial replay`);
      }
    }
    binPaths[b.field] = p;
  }
  return { sidecar, dir, binPaths };
}

/**
 * IEEE-exact deep compare of two parsed-JSON states, driven by the EXPECTED
 * side (contract §2 determinism rules). Every key present in `expected` must
 * exist and match in `got`; numbers compare with Object.is (bit-exact incl.
 * −0; NaN never survives JSON so nulls compare as nulls). Keys present only in
 * `got` are ignored (the replay driver may carry extra bookkeeping) — the
 * expected capsule is the truth being defended.
 *
 * VOLATILE-FIELD MASK (contract §2 determinism carve-out): `mask` is an EXPLICIT,
 * DECLARED whitelist of dotted state paths (e.g. `receipt.export_date`, a
 * wall-clock stamp) that legitimately differ across runs on otherwise-identical
 * inputs. A masked path is skipped (never recursed) and RECORDED in `masked` so
 * the run logs exactly what it fuzzed — this is a per-suite declaration, NEVER a
 * silent global tolerance. A mask entry that never matched a real leaf is still
 * reported (declared-but-unhit) so a stale mask surfaces instead of hiding.
 * Returns { equal, json_leaves, first_divergence, masked, masked_declared }.
 */
export function compareJsonStates(expected, got, { mask = [] } = {}) {
  const maskSet = new Set(Array.isArray(mask) ? mask : []);
  const maskedHit = new Set();
  let leaves = 0;
  let first = null;
  const walk = (e, g, p) => {
    if (first) return;
    if (p && maskSet.has(p)) { maskedHit.add(p); return; }   // declared-volatile: skip, record
    if (e === null || typeof e !== 'object') {
      leaves++;
      const same = (typeof e === 'number' && typeof g === 'number') ? Object.is(e, g) : Object.is(e, g);
      if (!same) first = { path: p, got: fmt(g), want: fmt(e) };
      return;
    }
    if (Array.isArray(e)) {
      if (!Array.isArray(g)) { leaves++; first = { path: p, got: fmt(g), want: `array(len ${e.length})` }; return; }
      if (g.length !== e.length) { leaves++; first = { path: `${p}.length`, got: g.length, want: e.length }; return; }
      for (let i = 0; i < e.length; i++) { walk(e[i], g[i], `${p}[${i}]`); if (first) return; }
      return;
    }
    if (g === null || typeof g !== 'object' || Array.isArray(g)) { leaves++; first = { path: p, got: fmt(g), want: 'object' }; return; }
    for (const k of Object.keys(e)) {
      const kp = p ? `${p}.${k}` : k;
      if (maskSet.has(kp)) { maskedHit.add(kp); continue; }   // declared-volatile key: skip before the missing-key check
      if (!Object.prototype.hasOwnProperty.call(g, k)) { leaves++; first = { path: kp, got: '(missing key)', want: fmt(e[k]) }; return; }
      walk(e[k], g[k], kp);
      if (first) return;
    }
  };
  walk(expected, got, '');
  return {
    equal: !first,
    json_leaves: leaves,
    first_divergence: first,
    masked: [...maskedHit],
    masked_declared: [...maskSet],
  };
}

/** First byte offset where two Buffers differ, or -1 (also differ at min length if lengths differ). */
export function firstByteDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Compare the expected capsule's buffers against the replayed capsule's.
 * Match by field name; sha256 first; on sha mismatch byte-scan both .bin files
 * for the first divergence offset (when both files exist — a replayed entry
 * may be recorded-sha-only when the stage left the buffer untouched).
 */
export function compareBuffers(expectedCap, replayedCap) {
  const expList = expectedCap.sidecar.buffers ?? [];
  const repByField = new Map((replayedCap.sidecar.buffers ?? []).map((b) => [b.field, b]));
  let bytes = 0;
  let first = null;
  for (const eb of expList) {
    bytes += eb.byte_length ?? 0;
    const rb = repByField.get(eb.field);
    if (!rb) { first = { path: `buffers.${eb.field}`, got: '(missing buffer)', want: `sha256 ${String(eb.sha256).slice(0, 12)}…` }; break; }
    if (rb.sha256 === eb.sha256) continue;
    // sha divergence — byte-scan when both sides have real bytes on disk
    const ep = expectedCap.binPaths[eb.field];
    const rp = replayedCap.binPaths[eb.field];
    if (ep && rp) {
      const off = firstByteDivergence(fs.readFileSync(ep), fs.readFileSync(rp));
      first = { path: `buffers.${eb.field}@byte:${off}`, got: `sha256 ${String(rb.sha256).slice(0, 12)}…`, want: `sha256 ${String(eb.sha256).slice(0, 12)}…` };
    } else {
      first = { path: `buffers.${eb.field}`, got: `sha256 ${String(rb.sha256).slice(0, 12)}…`, want: `sha256 ${String(eb.sha256).slice(0, 12)}…` };
    }
    break;
  }
  return { equal: !first, buffers: expList.length, bytes, first_divergence: first };
}

// ── divergence instrumentation (contract §5 / task fix #3) ────────────────────
// A mismatch is deposited with the first_divergence path already; these helpers
// additionally DUMP the localized "first-divergence point" — the input capsule's
// buffer shapes + state keys, the divergent top-level state block from BOTH sides,
// and any driver-recorded swallowed stage error — so a real divergence is
// LOCALIZED (never masked green). The full dossier is written to logsDir; a
// compact form rides the ledger row.
export const DIVERGENCE_HINTS = Object.freeze({
  spcc: 'zeropoint reads the M8 PhotometryManager.calculateInstrumentalMagnitude, which uses the STATIC currentProfile (src/engine/pipeline/m8_photometry/photometry_manager.ts) set upstream by metadata_reaper (step-1, from ISO/sensor). The isolated replay child never runs that → default profile → systematic zeropoint offset on byte-identical pixels (everything else in the block matches). HIDDEN MODULE-GLOBAL STATE (not an input). FIXED by the capture-contract hook: sidecar.photometry_profile = getProfile() at capture, restored via setProfile() in the driver before the stage runs. NB: the M8 singleton, NOT core/PhotometryManager (two same-named managers).',
  psf_field: 'psfField.approximate diverges: characterizePsfField runs the wasm LM refit (refine_stars_lm); a warm-vs-cold wasm/module path or a non-input global shifts how many stars fall back to the moment (approximate) branch. Localize via the dumped n_fit/n_lm/n_moment + approximate arrays.',
  bc_measure: 'measureBrownConradyFromSolution produced null where the real run built an object. A THROW is surfaced as replay_stage_error below (driver catch); a null RETURN is honest-absent (insufficient pairs / degenerate fit). Compare the pair budget vs the real run.',
  m7_refine: 'hardware/hardwareProfile are calibrate-start GLUE (orchestrator_session.ts:1092-1094), born after the solve seam and before m7_refine — the input capsule pre-dates them. Fixed at the capture boundary (glue-input backfill, seam_capture.ts).',
  integrate: 'receipt.export_date is a wall-clock stamp — declare it in the suite volatile_fields mask.',
});

function topStateKey(path) {
  if (!path || path.startsWith('buffers.')) return null;      // buffer divergence → buffer metas tell the story
  const m = /^([^.[]+)/.exec(path);
  return m ? m[1] : null;
}
function bufMetaSummary(sidecar) {
  return (sidecar?.buffers ?? []).map((b) => ({
    field: b.field, dtype: b.dtype, shape: b.shape ?? null, byte_length: b.byte_length ?? null,
    sha256: b.sha256 ? String(b.sha256).slice(0, 12) : null, file: b.file ?? null,
  }));
}
function capJson(v) {
  try { const s = JSON.stringify(v); return s && s.length > 4000 ? { __truncated_len: s.length, head: s.slice(0, 4000) } : v; }
  catch { return String(v); }
}
export function buildDivergenceDossier(row, input, expected, replayed, first) {
  const key = topStateKey(first?.path);
  const est = expected?.sidecar?.state ?? {};
  const rst = replayed?.sidecar?.state ?? {};
  return {
    id: row.id, stage: row.stage, seq: row.seq ?? null,
    first_divergence: first,
    diagnosis: DIVERGENCE_HINTS[row.stage] ?? '(no canned hint — see block dumps)',
    input_capsule: {
      dir: row.input_capsule_dir ?? null,
      stage: input?.sidecar?.stage ?? null,
      decoder_arm: input?.sidecar?.decoder_arm ?? null,
      buffers: bufMetaSummary(input?.sidecar),
      state_keys: Object.keys(input?.sidecar?.state ?? {}).sort(),
    },
    expected_buffers: bufMetaSummary(expected?.sidecar),
    replayed_buffers: bufMetaSummary(replayed?.sidecar),
    divergent_block: key ? { key, expected: capJson(est[key]), replayed: capJson(rst[key]) } : null,
    replay_stage_error: rst.__replay_stage_error ?? null,
  };
}

// ── row planning (contract §5 row shape) ──────────────────────────────────────
// Enumerate <seams_root>/<frame_sha>/<seq>_<stage>/ capsule dirs. The input of
// stage N is the capsule with the PREVIOUS seq in the same frame's chain
// (capture semantics §1: post-(N−1) state = input of N; seq disambiguates the
// nested-calibrate ordering). Deterministic: frames + seqs sorted.
export function planReplayRows(seamsRoot, { stages = null, frames = null } = {}) {
  if (!seamsRoot || !fs.existsSync(seamsRoot)) return [];
  const rows = [];
  const frameDirs = fs.readdirSync(seamsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const frameSha of frameDirs) {
    if (frames && !frames.some((f) => frameSha === f || frameSha.startsWith(f))) continue;
    const frameRoot = path.join(seamsRoot, frameSha);
    const caps = fs.readdirSync(frameRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const m = /^(\d+)_(.+)$/.exec(d.name);
        return m ? { seq: +m[1], stage: m[2], dir: path.join(frameRoot, d.name) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i];
      if (stages && !stages.includes(c.stage)) continue;
      rows.push({
        id: `${frameSha.slice(0, 8)}_${String(c.seq).padStart(2, '0')}_${c.stage}`,
        frame_sha: frameSha,
        stage: c.stage,
        seq: c.seq,
        capsule_dir: c.dir,
        // predecessor in the FULL seq chain (never filtered by `stages`)
        input_capsule_dir: i > 0 ? caps[i - 1].dir : null,
      });
    }
  }
  return rows;
}

// ── the replay driver child (TS execution — solve_to_receipt pattern) ─────────
function driverSpec(row, env, replayedDir, expectedSidecar, deps) {
  const vitest = path.join(env.root, 'node_modules', 'vitest', 'vitest.mjs');
  const childEnv = {
    ...process.env,
    ...(deps.childEnv ?? {}),
    SEAM_REPLAY_STAGE: row.stage,
    SEAM_REPLAY_INPUT_DIR: row.input_capsule_dir,
    SEAM_REPLAY_OUT_DIR: replayedDir,
  };
  // contract §5/§1 #16: pin the decoder arm env to the capsule's recorded arm
  // (belt-and-braces — the driver also consumes the recorded arm directly).
  if (expectedSidecar.decoder_arm === 'libraw') childEnv.VITE_DECODER_RAWLER = '0';
  else if (expectedSidecar.decoder_arm === 'rawler') childEnv.VITE_DECODER_RAWLER = '1';
  return {
    command: deps.command ?? process.execPath,
    args: deps.args ?? [vitest, 'run', '-c', 'tools/api/replay.config.ts'],
    cwd: env.root,
    env: childEnv,
    timeoutMs: deps.timeoutMs ?? CHILD_TIMEOUT_MS,
  };
}

// ── executor run: (row, env, paths, deps) → { envelope, red, outcome, summary }
// EXACTLY ONE depositRow per row (common.mjs — paths.label REQUIRED).
// deps (injectable, golden_vector pattern): { invokeDriver(row, env, replayedDir),
// runToCompletion, command, args, childEnv, timeoutMs }.
export async function run(row, env, paths, deps = {}) {
  const t0 = Date.now();
  const base = { executor: NAME, stage: row.stage, seq: row.seq ?? null, capsule_dir: row.capsule_dir ?? null };

  const deposit = (outcome, fields) => depositRow(paths, {
    frameSha: row.frame_sha ?? null,
    outcome,
    fields: { ...base, verdict: outcome, wall_ms: Date.now() - t0, ...fields },
  });

  // 1) honest skip for every NOT-YET stage (contract: named blocker, NOT red)
  if (!REPLAYABLE_STAGES.includes(row.stage)) {
    const blocker = NOT_YET_BLOCKERS[row.stage]
      ?? `stage "${row.stage}" is not in the 16-stage seam map (contract §1) — possible capture/contract drift, skipping honestly`;
    const envelope = deposit('skip_not_replayable', { capsule_schema_version: null, blocker });
    return { envelope, red: false, outcome: 'skip_not_replayable', summary: `${row.id ?? row.stage} skip_not_replayable (${row.stage})` };
  }

  // 2) load the frozen pair — sha-verified, loud fail
  let expected, input;
  try {
    expected = loadCapsule(row.capsule_dir);
    if (!row.input_capsule_dir) throw new CapsuleError(`no input capsule: seq predecessor missing for ${row.stage} (seq ${row.seq})`);
    input = loadCapsule(row.input_capsule_dir);
  } catch (e) {
    if (!(e instanceof CapsuleError)) throw e;
    const envelope = deposit('capsule_invalid', {
      capsule_schema_version: expected?.sidecar?.capsule_schema_version ?? null,
      reason: e.message,
    });
    return { envelope, red: true, outcome: 'capsule_invalid', summary: `${row.id ?? row.stage} capsule_invalid: ${e.message}` };
  }

  // 3) run the REAL stage code via the replay driver (vitest-hosted TS)
  const replayedDir = path.join(paths.logsDir ?? paths.receiptsDir, `${row.id}_replayed`);
  fs.rmSync(replayedDir, { recursive: true, force: true });
  fs.mkdirSync(replayedDir, { recursive: true });
  let child = null;
  try {
    if (deps.invokeDriver) {
      await deps.invokeDriver(row, env, replayedDir, { input, expected });
    } else {
      const runChild = deps.runToCompletion ?? runToCompletion;
      child = await runChild(driverSpec(row, env, replayedDir, expected.sidecar, deps), deps.childOpts);
    }
  } catch (e) {
    const envelope = deposit('error_driver', { capsule_schema_version: expected.sidecar.capsule_schema_version, reason: String(e && e.message || e) });
    return { envelope, red: true, outcome: 'error_driver', summary: `${row.id} error_driver: ${String(e && e.message || e)}` };
  }
  const replayedSidecar = path.join(replayedDir, 'capsule.json');
  if ((child && (child.timedOut || child.code !== 0)) || !fs.existsSync(replayedSidecar)) {
    const reason = child?.timedOut ? `driver timed out (${CHILD_TIMEOUT_MS}ms)`
      : child && child.code !== 0 ? `driver exit ${child.code}`
        : 'driver wrote no replayed capsule';
    const envelope = deposit('error_driver', {
      capsule_schema_version: expected.sidecar.capsule_schema_version,
      reason, child_exit: child?.code ?? null, timed_out: child?.timedOut ?? false,
      child_pid: child?.pid ?? null, output_tail: child ? tail(child.stdout + '\n' + child.stderr) : null,
    });
    return { envelope, red: true, outcome: 'error_driver', summary: `${row.id} error_driver: ${reason}` };
  }

  // 4) compare replayed vs frozen expected — IEEE-exact
  let replayed;
  try { replayed = loadCapsule(replayedDir); }
  catch (e) {
    const envelope = deposit('error_driver', { capsule_schema_version: expected.sidecar.capsule_schema_version, reason: `replayed capsule invalid: ${e.message}` });
    return { envelope, red: true, outcome: 'error_driver', summary: `${row.id} error_driver: replayed capsule invalid` };
  }
  // Volatile-field mask: an EXPLICIT per-suite whitelist, threaded onto the row
  // by the planner (index.mjs) from suite.volatile_fields. Logged when hit —
  // never a silent global fuzz (contract §2 determinism carve-out).
  const mask = Array.isArray(row.volatile_fields) ? row.volatile_fields : [];
  const jsonCmp = compareJsonStates(expected.sidecar.state, replayed.sidecar.state, { mask });
  const bufCmp = compareBuffers(expected, replayed);
  const equal = jsonCmp.equal && bufCmp.equal;
  const first = jsonCmp.first_divergence ?? bufCmp.first_divergence ?? null;
  const outcome = equal ? 'pass' : 'mismatch';

  // Instrument every mismatch: write the localized first-divergence dossier so a
  // real divergence is LOCALIZED, never masked green (task fix #3).
  let dossierPath = null;
  if (!equal) {
    try {
      const dossier = buildDivergenceDossier(row, input, expected, replayed, first);
      const dir = paths.logsDir ?? paths.receiptsDir;
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        dossierPath = path.join(dir, `${row.id}_divergence.json`);
        fs.writeFileSync(dossierPath, JSON.stringify(dossier, null, 2));
      }
    } catch { dossierPath = null; }   // instrumentation is never allowed to red a run
  }

  const envelope = deposit(outcome, {
    capsule_schema_version: expected.sidecar.capsule_schema_version,
    receipt_schema_version: expected.sidecar.receipt_schema_version ?? null,
    decoder_arm_pinned: expected.sidecar.decoder_arm ?? null,
    compared: { json_leaves: jsonCmp.json_leaves, buffers: bufCmp.buffers, bytes: bufCmp.bytes },
    masked_volatile: jsonCmp.masked,           // paths actually skipped (declared + hit)
    masked_declared: jsonCmp.masked_declared,  // full declared whitelist (stale-mask tripwire)
    first_divergence: first,
    divergence_dossier: dossierPath ? path.relative(env.root, dossierPath).replace(/\\/g, '/') : null,
    replay_stage_error: replayed.sidecar.state?.__replay_stage_error ?? null,
    child_exit: child?.code ?? null, child_pid: child?.pid ?? null,
  });
  const maskNote = jsonCmp.masked.length ? ` [masked volatile: ${jsonCmp.masked.join(', ')}]` : '';
  const summary = equal
    ? `${row.id} pass (${jsonCmp.json_leaves} leaves · ${bufCmp.buffers} buffers IEEE-exact)${maskNote}`
    : `${row.id} MISMATCH at ${first?.path} (got ${first?.got}, want ${first?.want})${maskNote} → dossier ${dossierPath ? path.basename(dossierPath) : '(unwritten)'}`;
  return { envelope, red: !equal, outcome, summary };
}
