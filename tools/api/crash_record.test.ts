// Unit test for the crash-record builder (tools/api/crash_record.mjs).
//
// Pure function, no wasm / no `@/` alias — collected by the SACRED `npx vitest
// run` gate (default *.test.ts include). Guards the LAW-3 invariant: an infra
// crash artifact must be structurally impossible to mistake for a scientific
// solve verdict (no `solution`, no `solved`, `kind` never 'no_solve'/'solved').

import { describe, it, expect } from 'vitest';
import {
  buildCrashRecord,
  boundedTail,
  CRASH_RECORD_KIND,
} from './crash_record.mjs';

const FIXED = new Date('2026-07-16T12:00:00.000Z');

describe('buildCrashRecord', () => {
  it('captures a SIGKILL/OOM-style kill (null status, signal set)', () => {
    const rec = buildCrashRecord({
      inputPath: '/frames/M50.fit',
      receiptPath: '/out/M50.receipt.json',
      res: { status: null, signal: 'SIGKILL', error: null, stderr: 'oom killed' },
      now: FIXED,
    });
    expect(rec.kind).toBe('crash_record');
    expect(rec.status).toBeNull();
    expect(rec.signal).toBe('SIGKILL');
    expect(rec.error_code).toBeNull();
    expect(rec.timed_out).toBe(false);
    expect(rec.input).toBe('/frames/M50.fit');
    expect(rec.receipt_expected).toBe('/out/M50.receipt.json');
    expect(rec.timestamp).toBe('2026-07-16T12:00:00.000Z');
  });

  it('flags spawnSync ETIMEDOUT as timed_out', () => {
    const rec = buildCrashRecord({
      inputPath: '/frames/M51.fit',
      receiptPath: '/out/M51.receipt.json',
      res: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: '' },
      now: FIXED,
    });
    expect(rec.error_code).toBe('ETIMEDOUT');
    expect(rec.timed_out).toBe(true);
    expect(rec.signal).toBe('SIGTERM');
  });

  it('captures a non-zero vitest exit (spec throw) without a signal', () => {
    const rec = buildCrashRecord({
      inputPath: '/frames/M66.fit',
      receiptPath: '/out/M66.receipt.json',
      res: { status: 1, signal: null, error: null, stderr: 'Error: FITS input not found' },
      now: FIXED,
    });
    expect(rec.status).toBe(1);
    expect(rec.signal).toBeNull();
    expect(rec.timed_out).toBe(false);
    expect(rec.stderr_tail).toContain('FITS input not found');
  });

  // LAW 3: a crash record can NEVER be read as a solve verdict.
  it('is structurally distinct from a solve receipt (no solved/no_solve semantics)', () => {
    const rec = buildCrashRecord({
      inputPath: '/frames/x.fit',
      receiptPath: '/out/x.receipt.json',
      res: { status: null, signal: 'SIGKILL' },
      now: FIXED,
    });
    // The discriminator is never a solve/no-solve verdict string.
    expect(rec.kind).toBe(CRASH_RECORD_KIND);
    expect(rec.kind).not.toBe('no_solve');
    expect(rec.kind).not.toBe('solved');
    // None of the receipt's verdict-bearing fields exist on a crash record, so a
    // consumer keying on them cannot mistake a crash for a result.
    expect(rec).not.toHaveProperty('solution');
    expect(rec).not.toHaveProperty('solved');
    expect(rec).not.toHaveProperty('deep_confirmed');
    expect(Object.prototype.hasOwnProperty.call(rec, 'kind')).toBe(true);
  });

  it('tolerates a bare/empty spawnSync result', () => {
    const rec = buildCrashRecord({ inputPath: null, receiptPath: null, res: {}, now: FIXED });
    expect(rec.kind).toBe('crash_record');
    expect(rec.status).toBeNull();
    expect(rec.signal).toBeNull();
    expect(rec.error_code).toBeNull();
    expect(rec.timed_out).toBe(false);
    expect(rec.stderr_tail).toBe('');
    expect(rec.input).toBeNull();
  });
});

describe('boundedTail', () => {
  it('returns short strings unchanged', () => {
    expect(boundedTail('hello', 2048)).toBe('hello');
    expect(boundedTail('', 2048)).toBe('');
    expect(boundedTail(null, 2048)).toBe('');
    expect(boundedTail(undefined, 2048)).toBe('');
  });

  it('keeps only the LAST maxBytes and marks the elision', () => {
    const big = 'A'.repeat(5000) + 'TAILMARKER';
    const tail = boundedTail(big, 2048);
    const bytes = Buffer.from(tail, 'utf8').length;
    // marker prefix adds a little, but the retained payload is bounded to 2048.
    expect(bytes).toBeLessThanOrEqual(2048 + 64);
    expect(tail).toContain('TAILMARKER');   // the END is preserved
    expect(tail).toContain('truncated');     // elision is announced
    expect(tail.startsWith('A')).toBe(false); // the head is dropped
  });
});
