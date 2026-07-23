// Unit tests for the live_stack follower's PURE logic (no wasm, no atlas, no
// stacker child process). Exercises the two bound input contracts — the watcher
// journal (JSONL) and the Solve-Queue solve sidecar — plus primary-cluster pick.
//
//   npx vitest run tools/stack/live_stack.test.mjs
//
// (This lane lives outside the default vitest workspace, which only collects
// src/engine/tests/**/*.test.ts — so it is run by explicit path, like the alpaca
// lane's alpaca_cycle.test.mjs.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, acceptedSolve, primaryResult } from './live_stack.mjs';

let TMP;
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'livestack-test-')); });
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('readJournal (watcher journal contract)', () => {
  it('parses ok frames, dedups, honours session_start/end', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'sess-'));
    const f0 = path.join(dir, 'frame_0000.fits');
    const f1 = path.join(dir, 'frame_0001.fits');
    fs.writeFileSync(f0, 'x'); fs.writeFileSync(f1, 'x');
    const rows = [
      { event: 'session_start', session_id: 'S1', mode: 'drive' },
      { event: 'frame', status: 'ok', file: 'frame_0000.fits', path: f0, seq: 0, exposure_s: 10, frame_id: 'a' },
      { event: 'frame', status: 'failed', reason: 'device blip' },
      { event: 'frame', status: 'ok', file: 'frame_0001.fits', path: f1, seq: 1, exposure_s: 10, frame_id: 'b' },
      { event: 'frame', status: 'ok', file: 'frame_0001.fits', path: f1, seq: 1 }, // duplicate row → ignored
      { event: 'session_end', frames: 2 },
    ];
    fs.writeFileSync(path.join(dir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const j = readJournal(dir);
    expect(j.sessionId).toBe('S1');
    expect(j.ended).toBe(true);
    expect(j.frames.map((f) => f.file)).toEqual(['frame_0000.fits', 'frame_0001.fits']);
    expect(j.frames[0].exposureS).toBe(10);
  });

  it('resolves frame path into the session dir when the journalled path is absent', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'sess2-'));
    fs.writeFileSync(path.join(dir, 'frame_0000.fits'), 'x');
    const row = { event: 'frame', status: 'ok', file: 'frame_0000.fits', path: 'Z:/gone/frame_0000.fits', seq: 0 };
    fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify(row) + '\n');
    const j = readJournal(dir);
    expect(j.frames).toHaveLength(1);
    expect(j.frames[0].path).toBe(path.join(dir, 'frame_0000.fits'));
  });

  it('returns an empty set when there is no journal', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'sess3-'));
    const j = readJournal(dir);
    expect(j.frames).toEqual([]);
    expect(j.ended).toBe(false);
  });
});

describe('acceptedSolve (Solve-Queue sidecar gate)', () => {
  it('accepts only when the sidecar exists with accepted:true', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'solve-'));
    fs.writeFileSync(path.join(dir, 'frame_0000.fits.solve.json'), JSON.stringify({ accepted: true, raHours: 11.3, matched: 200 }));
    fs.writeFileSync(path.join(dir, 'frame_0001.fits.solve.json'), JSON.stringify({ accepted: false, error: 'no lock' }));
    expect(acceptedSolve(dir, 'frame_0000.fits')?.matched).toBe(200);
    expect(acceptedSolve(dir, 'frame_0001.fits')).toBeNull();  // present but not accepted
    expect(acceptedSolve(dir, 'frame_0002.fits')).toBeNull();  // absent → not yet solved
  });

  it('also matches the base-name sidecar form', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'solve2-'));
    fs.writeFileSync(path.join(dir, 'frame_0000.solve.json'), JSON.stringify({ accepted: true }));
    expect(acceptedSolve(dir, 'frame_0000.fits')).toBeTruthy();
  });
});

describe('primaryResult (stacker report contract)', () => {
  it('picks the produced cluster with the most members', () => {
    const report = {
      results: [
        { cluster: 0, members: [{ file: 'a' }], outputs: { fits: 'a.fits' } },
        { cluster: 1, members: [{ file: 'b' }, { file: 'c' }, { file: 'd' }], outputs: { fits: 'big.fits' } },
        { cluster: 2, members: [{ file: 'e' }, { file: 'f' }], outputs: null }, // no output → ignored
      ],
    };
    expect(primaryResult(report).cluster).toBe(1);
  });

  it('returns null when nothing produced a stacked output (honest no-deepen)', () => {
    expect(primaryResult({ results: [{ cluster: 0, members: [{ file: 'a' }], outputs: null }] })).toBeNull();
    expect(primaryResult({ results: [] })).toBeNull();
  });
});
