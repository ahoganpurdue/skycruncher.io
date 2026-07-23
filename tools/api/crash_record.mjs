// ═══════════════════════════════════════════════════════════════════════════
// TOOLCHEST API — crash_record.mjs : infra-failure artifact (LAW 3 honest-or-absent)
// ═══════════════════════════════════════════════════════════════════════════
//
// When the spawned solve is KILLED (OOM signal, spawnSync ETIMEDOUT, a hard
// crash) it exits with a null status and writes NOTHING to disk — so a harvest
// loop silently drops the frame with no trace of WHY. An honest scientific
// no-solve (receipt.solution === null, exit 2) is a real result and is banked
// as a normal receipt; a PROCESS crash is not a scientific outcome and must
// never be mistaken for one.
//
// This module builds a DISTINCT crash-record artifact (`<base>.crash.json`,
// never a `.receipt.json`) whose top-level `kind:'crash_record'` discriminator
// can never be read as a solve verdict. It captures the failure class (exit
// status, kill signal, error code, ETIMEDOUT flag) plus a bounded stderr tail
// so the crash is diagnosable from disk alone.
//
// Pure + side-effect-free `buildCrashRecord` (unit-tested); `writeCrashRecord`
// is the thin fs wrapper run.mjs calls in its failure branch.

import fs from 'node:fs';

export const CRASH_RECORD_KIND = 'crash_record';
export const CRASH_RECORD_SCHEMA = 'crash_record/1';

// Return the last `maxBytes` bytes of `s` (utf8-bounded), prefixed with an
// elision marker when truncated. Never throws on null/undefined input.
export function boundedTail(s, maxBytes = 2048) {
  if (s == null) return '';
  const buf = Buffer.from(String(s), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  return '…[truncated ' + (buf.length - maxBytes) + ' earlier bytes]…\n' +
    buf.subarray(buf.length - maxBytes).toString('utf8');
}

// Build the crash-record object from a node:child_process spawnSync result.
// Pure: no fs, no clock read unless `now` is omitted. `res` is the spawnSync
// return (may carry .status, .signal, .error, .stdout, .stderr). The shape is
// deliberately NON-OVERLAPPING with a solve receipt: it has no `solution`, no
// `deep_confirmed`, and a `kind` that is never 'no_solve'/'solved'.
export function buildCrashRecord({ inputPath, receiptPath, res = {}, now = new Date() }) {
  const errorCode = res.error && res.error.code != null ? res.error.code : null;
  return {
    kind: CRASH_RECORD_KIND,          // discriminator — NEVER 'no_solve'/'solved'
    schema: CRASH_RECORD_SCHEMA,
    input: inputPath != null ? String(inputPath) : null,
    // The receipt that was expected but never landed (a crash writes no receipt).
    receipt_expected: receiptPath != null ? String(receiptPath) : null,
    status: res.status != null ? res.status : null,   // exit code; null when killed by signal
    signal: res.signal != null ? res.signal : null,   // e.g. 'SIGKILL' / 'SIGTERM'
    error_code: errorCode,                             // e.g. 'ETIMEDOUT' / 'ENOMEM'
    timed_out: errorCode === 'ETIMEDOUT',              // spawnSync timeout kill
    stderr_tail: boundedTail(res.stderr, 2048),
    timestamp: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

// Write `<base>.crash.json` for a failed run. Returns the path written. The
// caller owns exit-code semantics; this only lands the artifact.
export function writeCrashRecord({ crashPath, inputPath, receiptPath, res, now }) {
  const record = buildCrashRecord({ inputPath, receiptPath, res, now });
  fs.writeFileSync(crashPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return crashPath;
}
