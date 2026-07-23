/** Pure JSONL parse / validate tests for the ★ Replay Dashboard run loader. */
import { describe, it, expect } from 'vitest';
import { parseRunJsonl, isCaptureEnvelope, runIdOf, labelFor } from './runs_source';

const GOOD = JSON.stringify({
    run_id: 'r1', frame_sha: 'abc', stage_id: 'load', seq: 3,
    t_start: 1000, t_end: 1005, ms: 5, ok: true, verdict: null,
    counts: {}, warnings: [], payload_ref: null,
});
const GOOD2 = JSON.stringify({
    run_id: 'r1', frame_sha: 'abc', stage_id: 'solve', seq: 21,
    t_start: 1005, t_end: 3000, ms: 1995, ok: true, verdict: 'PASS',
    counts: { matched: 272 }, warnings: [], payload_ref: 'solution',
});

describe('isCaptureEnvelope', () => {
    it('accepts a full envelope', () => {
        expect(isCaptureEnvelope(JSON.parse(GOOD))).toBe(true);
    });
    it('rejects a row missing a required key', () => {
        const o = JSON.parse(GOOD);
        delete o.counts;
        expect(isCaptureEnvelope(o)).toBe(false);
    });
    it('rejects wrong-typed fields and non-objects', () => {
        const o = JSON.parse(GOOD);
        o.seq = 'three';
        expect(isCaptureEnvelope(o)).toBe(false);
        expect(isCaptureEnvelope(null)).toBe(false);
        expect(isCaptureEnvelope('nope')).toBe(false);
        expect(isCaptureEnvelope(42)).toBe(false);
    });
});

describe('parseRunJsonl', () => {
    it('parses a clean 2-row record', () => {
        const { envelopes, errors } = parseRunJsonl(`${GOOD}\n${GOOD2}\n`);
        expect(envelopes.map(e => e.stage_id)).toEqual(['load', 'solve']);
        expect(errors).toEqual([]);
    });
    it('skips blank lines without error', () => {
        const { envelopes, errors } = parseRunJsonl(`\n${GOOD}\n\n`);
        expect(envelopes.length).toBe(1);
        expect(errors).toEqual([]);
    });
    it('collects malformed lines as honest errors, keeps the good rows (never throws)', () => {
        const { envelopes, errors } = parseRunJsonl(`${GOOD}\n{not json\n${GOOD2}`);
        expect(envelopes.length).toBe(2);
        expect(errors).toEqual([{ line: 2, reason: 'invalid JSON' }]);
    });
    it('rejects a valid-JSON but non-envelope line', () => {
        const { envelopes, errors } = parseRunJsonl(`${GOOD}\n{"hello":"world"}`);
        expect(envelopes.length).toBe(1);
        expect(errors[0].reason).toBe('not a capture envelope');
    });
    it('handles CRLF line endings', () => {
        const { envelopes } = parseRunJsonl(`${GOOD}\r\n${GOOD2}\r\n`);
        expect(envelopes.length).toBe(2);
    });
    it('empty input ⇒ empty record', () => {
        expect(parseRunJsonl('')).toEqual({ envelopes: [], errors: [] });
    });
});

describe('runIdOf / labelFor', () => {
    it('returns the first stamped run id', () => {
        const { envelopes } = parseRunJsonl(`${GOOD}\n${GOOD2}`);
        expect(runIdOf(envelopes, 'fallback')).toBe('r1');
    });
    it('falls back when no run id is stamped', () => {
        expect(runIdOf([], 'fallback')).toBe('fallback');
    });
    it('labels with stage count and duration', () => {
        const { envelopes } = parseRunJsonl(`${GOOD}\n${GOOD2}`);
        expect(labelFor('r1', envelopes)).toBe('r1 · 2 stages · 2.00s');
    });
    it('labels a bare id when empty', () => {
        expect(labelFor('r1', [])).toBe('r1');
    });
});
