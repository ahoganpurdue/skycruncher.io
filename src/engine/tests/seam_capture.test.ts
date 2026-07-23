/**
 * SEAM CAPTURE — inertness proof + capture correctness
 * (stage-modular test environment wave, frozen SEAM_CONTRACT v1 §3)
 *
 * The load-bearing halves:
 *  1. INERTNESS: with CAPTURE_SEAMS unset, SEAM_CAPTURE_ENABLED is a
 *     module-const false ⇒ the single withStage guard is a dead branch ⇒
 *     zero awaits/allocations added ⇒ receipts byte-identical with capture
 *     off (the by-construction argument in pipeline/seam_capture.ts).
 *  2. SYNC SNAPSHOT (contract risk §7.1): successor stages mutate
 *     solution/scienceBuffer in place, so the capsule must hold the bytes as
 *     they were AT the seam — copied synchronously before any await.
 *
 * Env control: SEAM_CAPTURE_ENABLED is computed at import time, so every
 * test that needs a specific flag state does vi.resetModules() + a fresh
 * dynamic import with the env already arranged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SeamModule = typeof import('../pipeline/seam_capture');
type SeamView = import('../pipeline/seam_capture').SeamSessionView;

const ENV_KEYS = ['CAPTURE_SEAMS', 'SEAM_FRAME_ID', 'SEAM_CAPTURE_ROOT', 'SEAM_ENGINE_COMMIT', 'VITE_DECODER_RAWLER'] as const;
let savedEnv: Record<string, string | undefined>;
let tempDirs: string[];

beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    tempDirs = [];
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    for (const d of tempDirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
    vi.resetModules();
});

/** Fresh module instance with the CURRENT process.env (const computed at import). */
async function importFresh(): Promise<SeamModule> {
    vi.resetModules();
    return await import('../pipeline/seam_capture');
}

function makeTempRoot(): string {
    const d = mkdtempSync(join(tmpdir(), 'seam-capture-test-'));
    tempDirs.push(d);
    return d;
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Minimal well-formed session view (fields beyond these are honest-absent). */
function makeView(overrides: Partial<Record<string, unknown>> = {}): SeamView {
    return {
        metadata: { camera: 'TESTCAM', exposure_time: 30 },
        signal: { clean_stars: [{ x: 1, y: 2, flux: 10 }], noise_floor: 0.01 },
        solution: { wcs: { crval: [11.34, 45.6], crpix: [100, 200] }, matched_stars: [] },
        planets: [],
        hardwareProfile: null,
        forensics: null,
        warnings: ['w1'],
        timestampTrusted: true,
        spccBlock: undefined,
        psfField: null,
        psfAttribution: null,
        bcMeasured: null,
        bcRematch: null,
        opticsHints: [],
        userAnnotations: null,
        imageWidth: 3,
        imageHeight: 1,
        solveW: 3,
        solveH: 1,
        scaleLock: 3.6776,
        guestList: [],
        timestamp: new Date('2026-07-12T00:00:00.000Z'),
        location: null,
        sourceFormat: 'FITS',
        scienceBuffer: new Float32Array([1, 2, 3]),
        scienceRgb: null,
        ...overrides,
    } as unknown as SeamView;
}

describe('seam_capture — inertness proof (contract §3 by-construction argument)', () => {
    it('(a) CAPTURE_SEAMS unset at import ⇒ SEAM_CAPTURE_ENABLED === false (dead-branch guard)', async () => {
        delete process.env.CAPTURE_SEAMS;
        const mod = await importFresh();
        expect(mod.SEAM_CAPTURE_ENABLED).toBe(false);
    });

    it("(a+) any value other than exactly '1' stays disabled; '1' enables (positive control)", async () => {
        process.env.CAPTURE_SEAMS = 'true'; // only the exact string '1' arms capture
        expect((await importFresh()).SEAM_CAPTURE_ENABLED).toBe(false);
        process.env.CAPTURE_SEAMS = '1';
        expect((await importFresh()).SEAM_CAPTURE_ENABLED).toBe(true);
    });

    it('(a++) disabled captureSeam is a no-op: no files written even with frame id + root set', async () => {
        delete process.env.CAPTURE_SEAMS;
        const root = makeTempRoot();
        process.env.SEAM_FRAME_ID = 'deadbeef';
        process.env.SEAM_CAPTURE_ROOT = root;
        const mod = await importFresh();
        await mod.captureSeam('extract', null, makeView());
        expect(readdirSync(root)).toHaveLength(0);
    });
});

describe('seam_capture — never-throws discipline (LAW 3 honest-or-absent)', () => {
    it('(b) resolves without throwing on a poisoned view (every getter throws)', async () => {
        const root = makeTempRoot();
        process.env.CAPTURE_SEAMS = '1';
        process.env.SEAM_FRAME_ID = 'poison01';
        process.env.SEAM_CAPTURE_ROOT = root;
        const mod = await importFresh();

        const poisoned: Record<string, unknown> = {};
        const fields = ['metadata', 'signal', 'solution', 'warnings', 'imageWidth', 'imageHeight',
            'scienceBuffer', 'scienceRgb', 'scales', 'timestamp', 'sourceFormat'];
        for (const f of fields) {
            Object.defineProperty(poisoned, f, {
                get() { throw new Error(`poisoned getter: ${f}`); },
                enumerable: true,
            });
        }
        await expect(
            mod.captureSeam('extract', null, poisoned as unknown as SeamView)
        ).resolves.toBeUndefined();
    });

    it('(e) SEAM_FRAME_ID absent while enabled ⇒ no files written, no throw (an id is never invented)', async () => {
        const root = makeTempRoot();
        process.env.CAPTURE_SEAMS = '1';
        delete process.env.SEAM_FRAME_ID;
        process.env.SEAM_CAPTURE_ROOT = root;
        const mod = await importFresh();
        await expect(mod.captureSeam('extract', null, makeView())).resolves.toBeUndefined();
        expect(readdirSync(root)).toHaveLength(0);
    });
});

describe('seam_capture — capsule correctness (contract §2 format)', () => {
    it('(c) writes capsule.json + .bin with matching sha256, exact state keys, deterministic bytes', async () => {
        const frame = 'aa11bb22cc33';
        process.env.CAPTURE_SEAMS = '1';
        process.env.SEAM_FRAME_ID = frame;
        process.env.SEAM_ENGINE_COMMIT = 'testcommit0';

        const view = makeView({
            scienceRgb: { data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), width: 1, height: 2 },
        });
        const originalLumBytes = new Uint8Array(
            (view.scienceBuffer as Float32Array).slice().buffer
        );

        // Two captures of IDENTICAL state through two FRESH module instances
        // (per-frame seq counters reset with the module) into two roots —
        // capsule.json must be byte-identical (stable-stringify sorted keys).
        const rootA = makeTempRoot();
        process.env.SEAM_CAPTURE_ROOT = rootA;
        await (await importFresh()).captureSeam('extract', null, view);
        const rootB = makeTempRoot();
        process.env.SEAM_CAPTURE_ROOT = rootB;
        await (await importFresh()).captureSeam('extract', null, view);

        const dirA = join(rootA, frame, '01_extract');
        expect(existsSync(join(dirA, 'capsule.json'))).toBe(true);
        expect(existsSync(join(dirA, 'scienceBuffer.bin'))).toBe(true);
        expect(existsSync(join(dirA, 'scienceRgb.bin'))).toBe(true);

        const rawA = readFileSync(join(dirA, 'capsule.json'));
        const rawB = readFileSync(join(rootB, frame, '01_extract', 'capsule.json'));
        expect(Buffer.compare(rawA, rawB)).toBe(0); // deterministic sidecar bytes

        const capsule = JSON.parse(rawA.toString('utf8'));
        expect(capsule.capsule_schema_version).toBe('1.0.0');
        expect(capsule.stage).toBe('extract');
        expect(capsule.seq).toBe('01');
        expect(capsule.frame_sha).toBe(frame);
        expect(capsule.engine_commit).toBe('testcommit0');
        expect(typeof capsule.receipt_schema_version).toBe('string'); // imported const, never hand-copied
        expect(typeof capsule.binary_layouts_version).toBe('string');
        expect(['rawler', 'libraw']).toContain(capsule.decoder_arm);

        // State keys = SeamSessionView property names EXACTLY (contract §2).
        const viewPropNames = new Set(Object.keys(view as unknown as Record<string, unknown>));
        for (const key of Object.keys(capsule.state)) {
            expect(viewPropNames.has(key), `state key '${key}' must be a view property name`).toBe(true);
        }
        expect(capsule.state.metadata).toEqual({ camera: 'TESTCAM', exposure_time: 30 });
        expect(capsule.state.timestamp).toBe('2026-07-12T00:00:00.000Z'); // Date → ISO via JSON round-trip
        expect(capsule.state.spccBlock).toBeUndefined(); // undefined view field = honest-absent

        // Buffer sidecar entries: sha256 matches the .bin bytes AND the
        // original pre-capture buffer bytes; shape/dtype/endianness honest.
        const lum = capsule.buffers.find((b: { field: string }) => b.field === 'scienceBuffer');
        expect(lum).toBeDefined();
        expect(lum.dtype).toBe('float32');
        expect(lum.endianness).toBe('LE');
        expect(lum.shape).toEqual([1, 3]); // h=1, w=3 native grid
        expect(lum.byte_length).toBe(12);
        expect(lum.units.length).toBeGreaterThan(0); // LAW 7: units mandatory
        const lumBin = readFileSync(join(dirA, 'scienceBuffer.bin'));
        expect(sha256Hex(lumBin)).toBe(lum.sha256);
        expect(sha256Hex(originalLumBytes)).toBe(lum.sha256);

        const rgb = capsule.buffers.find((b: { field: string }) => b.field === 'scienceRgb');
        expect(rgb).toBeDefined();
        expect(rgb.shape).toEqual([2, 1, 3]); // [h, w, 3]
        expect(sha256Hex(readFileSync(join(dirA, 'scienceRgb.bin')))).toBe(rgb.sha256);
    });

    it('(c+) seq increments in capture order and zero-pads (nested calibrate closes after children)', async () => {
        const root = makeTempRoot();
        process.env.CAPTURE_SEAMS = '1';
        process.env.SEAM_FRAME_ID = 'seqframe';
        process.env.SEAM_CAPTURE_ROOT = root;
        const mod = await importFresh();
        const view = makeView();
        await mod.captureSeam('m7_refine', null, view);
        await mod.captureSeam('spcc', { block: { n_stars: 5 } }, view);
        await mod.captureSeam('calibrate', null, view);
        const dirs = readdirSync(join(root, 'seqframe')).sort();
        expect(dirs).toEqual(['01_m7_refine', '02_spcc', '03_calibrate']);
        // spcc out-overlay mirrors OS `this.spccBlock = spcc.block` (assigned post-hook)
        const spccCapsule = JSON.parse(readFileSync(join(root, 'seqframe', '02_spcc', 'capsule.json'), 'utf8'));
        expect(spccCapsule.state.spccBlock).toEqual({ n_stars: 5 });
    });

    it('(d) SYNC-SNAPSHOT: mutation immediately after the call, BEFORE awaiting, cannot contaminate the capsule (risk §7.1)', async () => {
        const root = makeTempRoot();
        process.env.CAPTURE_SEAMS = '1';
        process.env.SEAM_FRAME_ID = 'mutframe';
        process.env.SEAM_CAPTURE_ROOT = root;
        const mod = await importFresh();

        const buf = new Float32Array([1, 2, 3]);
        const solution: Record<string, unknown> = { wcs: { crval: [1, 2] }, matched_stars: [] };
        const view = makeView({ scienceBuffer: buf, solution });

        const pending = mod.captureSeam('psf_field', null, view); // slice includes scienceBuffer
        // Successor-stage-style in-place mutation on the VERY next lines:
        buf[0] = 999;
        buf[2] = -1;
        (solution.wcs as Record<string, unknown>).crval = [777, 888];
        await pending;

        const dir = join(root, 'mutframe', '01_psf_field');
        const got = new Float32Array(new Uint8Array(readFileSync(join(dir, 'scienceBuffer.bin'))).buffer);
        expect(Array.from(got)).toEqual([1, 2, 3]); // PRE-mutation bytes
        const capsule = JSON.parse(readFileSync(join(dir, 'capsule.json'), 'utf8'));
        expect((capsule.state.solution as { wcs: { crval: number[] } }).wcs.crval).toEqual([1, 2]); // JSON side too
        // sha256 binds the frozen bytes, not the mutated ones
        const lum = capsule.buffers.find((b: { field: string }) => b.field === 'scienceBuffer');
        expect(lum.sha256).toBe(sha256Hex(new Uint8Array(new Float32Array([1, 2, 3]).buffer)));
    });
});
