// tools/intake/alpaca/alpaca_cycle.test.mjs
// End-to-end gate for the Alpaca intake lane: the watcher driven against the mock
// Seestar (detect → download → FITS → journal → intake layout), idempotency,
// device-vanish resilience, enqueue, the image codec round-trip, and the probe verdict.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockSeestar } from './mock_seestar.mjs';
import { runWatcher } from './alpaca_watcher.mjs';
import { probeHost } from './alpaca_probe.mjs';
import {
  buildImageBytes, parseImageBytes, buildImageArrayJson, parseImageArray, syntheticStarFrame,
} from './alpaca_image.mjs';

const QUIET = { log: () => {}, error: () => {} };
const _mocks = [];
async function mock(opts) { const m = await startMockSeestar(opts); _mocks.push(m); return m; }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-test-')); }
const readJournal = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const isFits = (p) => fs.readFileSync(p).slice(0, 6).toString('ascii') === 'SIMPLE';

afterEach(async () => { while (_mocks.length) { try { await _mocks.pop().stop(); } catch { /* already closed */ } } });

const fast = { exposureS: 0.02, pollMs: 8, retryBaseMs: 8, retries: 8, log: QUIET };

describe('alpaca_image codec — encode/decode round-trip', () => {
  it('imagebytes: planes → buffer → planes is exact (UInt16, transpose-correct)', () => {
    const src = syntheticStarFrame({ W: 12, H: 9, seed: 7 });
    const buf = buildImageBytes({ planes: src.planes, W: 12, H: 9, elementType: 'UInt16', serverTxnId: 55 });
    const got = parseImageBytes(buf);
    expect(got.W).toBe(12); expect(got.H).toBe(9); expect(got.NP).toBe(1);
    expect(got.serverTxnId).toBe(55);
    for (let i = 0; i < 12 * 9; i++) expect(got.planes[0][i]).toBe(Math.round(src.planes[0][i]));
  });

  it('imagearray: rank-2 JSON round-trips [x][y] ordering', () => {
    const src = syntheticStarFrame({ W: 10, H: 6, seed: 3 });
    const env = buildImageArrayJson({ planes: src.planes, W: 10, H: 6, elementType: 'UInt16', serverTxnId: 9 });
    expect(env.Rank).toBe(2); expect(env.Value.length).toBe(10); expect(env.Value[0].length).toBe(6);
    const got = parseImageArray(env);
    for (let i = 0; i < 10 * 6; i++) expect(got.planes[0][i]).toBe(Math.round(src.planes[0][i]));
  });

  it('parseImageBytes throws on a non-zero ErrorNumber (honest failure)', () => {
    const buf = buildImageBytes({ planes: [new Float32Array(4)], W: 2, H: 2 });
    new DataView(buf.buffer).setInt32(4, 1035, true);   // inject ErrorNumber
    expect(() => parseImageBytes(buf)).toThrow(/ErrorNumber/);
  });
});

describe('watcher × mock — full acquisition cycle', () => {
  it('drives 3 exposures → 3 FITS in the session dir + a complete journal', async () => {
    const m = await mock({ W: 40, H: 24 });
    const outDir = tmp();
    const s = await runWatcher({ host: '127.0.0.1', alpacaPort: m.port, outDir, sessionId: 'sess_a', maxFrames: 3, ...fast });

    expect(s.frames).toBe(3);
    expect(s.failures).toBe(0);
    const sessionDir = path.join(outDir, 'sess_a');
    const fits = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.fits')).sort();
    expect(fits).toEqual(['frame_0000.fits', 'frame_0001.fits', 'frame_0002.fits']);
    for (const f of fits) expect(isFits(path.join(sessionDir, f))).toBe(true);

    const j = readJournal(path.join(sessionDir, 'session.jsonl'));
    expect(j[0].event).toBe('session_start');
    expect(j.filter((r) => r.event === 'frame' && r.status === 'ok')).toHaveLength(3);
    expect(j.at(-1).event).toBe('session_end');
    // Each ok row carries geometry + a distinct frame identity.
    const ids = new Set(j.filter((r) => r.status === 'ok').map((r) => r.frame_id));
    expect(ids.size).toBe(3);
    expect(j.find((r) => r.status === 'ok').W).toBe(40);
  });
});

describe('watcher idempotency', () => {
  it('re-running the same session resumes the sequence and never clobbers existing files', async () => {
    const outDir = tmp();
    const m1 = await mock({ W: 32, H: 20 });
    await runWatcher({ host: '127.0.0.1', alpacaPort: m1.port, outDir, sessionId: 'sess_r', maxFrames: 2, ...fast });
    const sessionDir = path.join(outDir, 'sess_r');
    const before = fs.readFileSync(path.join(sessionDir, 'frame_0000.fits'));

    const m2 = await mock({ W: 32, H: 20 });
    const s2 = await runWatcher({ host: '127.0.0.1', alpacaPort: m2.port, outDir, sessionId: 'sess_r', maxFrames: 2, ...fast });

    expect(s2.frames).toBe(2);
    const fits = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.fits')).sort();
    expect(fits).toEqual(['frame_0000.fits', 'frame_0001.fits', 'frame_0002.fits', 'frame_0003.fits']);
    // Original frame bytes untouched by the second run.
    expect(fs.readFileSync(path.join(sessionDir, 'frame_0000.fits')).equals(before)).toBe(true);
  });

  it('watch mode deduplicates a lingering frame id (re-poll never re-downloads)', async () => {
    const m = await mock({ W: 24, H: 16 });
    // Stage exactly one ready frame (no exposure driven).
    m.state.imageready = true; m.state.exposing = false; m.state.frameCounter = 42;
    const outDir = tmp();
    const s = await runWatcher({ host: '127.0.0.1', alpacaPort: m.port, outDir, sessionId: 'sess_w', watch: true, maxFrames: 5, durationS: 0.4, ...fast });

    expect(s.frames).toBe(1);              // the single frame, downloaded once
    expect(s.duplicates).toBeGreaterThanOrEqual(1); // subsequent polls saw the same id and skipped
    const sessionDir = path.join(outDir, 'sess_w');
    expect(fs.readdirSync(sessionDir).filter((f) => f.endsWith('.fits'))).toHaveLength(1);
  });
});

describe('watcher resilience — device vanishes mid-session', () => {
  it('retries transient transport failures with backoff and still produces the frame (never crashes)', async () => {
    const m = await mock({ W: 20, H: 12 });
    m.setOutage(3);                         // next 3 requests fail 503 (simulated dropped WiFi)
    const outDir = tmp();
    const s = await runWatcher({ host: '127.0.0.1', alpacaPort: m.port, outDir, sessionId: 'sess_v', maxFrames: 1, ...fast });

    expect(s.frames).toBe(1);
    expect(s.transient_retries).toBeGreaterThanOrEqual(3);
    expect(isFits(path.join(outDir, 'sess_v', 'frame_0000.fits'))).toBe(true);
  });
});

describe('watcher --enqueue → Solve Queue Intake Folder lane', () => {
  it('drops each frame flat into the enqueue dir with a provenance sidecar', async () => {
    const m = await mock({ W: 28, H: 18 });
    const outDir = tmp(), enqueueDir = tmp();
    const s = await runWatcher({ host: '127.0.0.1', alpacaPort: m.port, outDir, enqueueDir, enqueue: true, sessionId: 'sess_q', maxFrames: 2, ...fast });

    expect(s.frames).toBe(2);
    const queued = fs.readdirSync(enqueueDir);
    expect(queued.filter((f) => f.endsWith('.fits')).sort()).toEqual(['frame_0000.fits', 'frame_0001.fits']);
    expect(queued.filter((f) => f.endsWith('.provenance.json'))).toHaveLength(2);
    const prov = JSON.parse(fs.readFileSync(path.join(enqueueDir, 'frame_0000.fits.provenance.json'), 'utf8'));
    expect(prov.image_kind).toBe('FITS');
    expect(prov.source.type).toBe('alpaca');
    expect(isFits(path.join(enqueueDir, 'frame_0000.fits'))).toBe(true);
  });
});

describe('probe × mock — capability verdict', () => {
  it('reports NATIVE_GOTO when the firmware lists a Telescope device that can slew', async () => {
    const m = await mock({});
    const r = await probeHost({ host: '127.0.0.1', port: m.port, log: QUIET });
    expect(r.verdict.reachable).toBe(true);
    expect(r.verdict.has_telescope).toBe(true);
    expect(r.verdict.has_camera).toBe(true);
    expect(r.verdict.telescope_can_slew).toBe(true);
    expect(r.verdict.control_surface).toBe('NATIVE_GOTO');
    const cam = r.devices.find((d) => d.device_type === 'Camera');
    expect(cam.capabilities.cameraxsize.value).toBeGreaterThan(0);
  });

  it('reports CAMERA_ONLY when no Telescope device is listed', async () => {
    const m = await mock({ includeTelescope: false });
    const r = await probeHost({ host: '127.0.0.1', port: m.port, log: QUIET });
    expect(r.verdict.has_telescope).toBe(false);
    expect(r.verdict.has_camera).toBe(true);
    expect(r.verdict.control_surface).toBe('CAMERA_ONLY');
  });

  it('honest verdict on an unreachable host (no throw)', async () => {
    const r = await probeHost({ host: '127.0.0.1', port: 1, log: QUIET });
    expect(r.verdict.reachable).toBe(false);
  });
});
