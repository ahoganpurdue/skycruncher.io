// tools/community/push_solve.test.mjs
// Gate coverage for the PURE core of the community solve-push: the content-addressed
// key scheme, receipt→quality extraction, the strict v1 quality ordering, the manifest
// merge (append + best pointer + record-level dedup), and the two-level dedup decision
// driven through pushSolve with an in-memory client (no creds, no network).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  objectKey, manifestKey, SOLVES_PREFIX,
  extractQuality, detectProducts,
  isStrictlyBetter, QUALITY_ORDERING,
  mergeManifest, buildRunEntry, MANIFEST_SCHEMA_VERSION,
  contentTypeForExt, sha256Hex,
  pushSolve,
} from './push_solve.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const FRAME_SHA = sha('frame-bytes-A');            // 64 hex
const FRAME12 = FRAME_SHA.slice(0, 12);

// A solved receipt with a rich product set (mirrors package.ts shapes).
function solvedReceipt(over = {}) {
  return {
    version: '2.10.0',
    solution: {
      ra_hours: 17.59, dec_degrees: -23.0, pixel_scale: 63.4, confidence: 0.68,
      stars_matched: 79,
      astrometry: { rms_arcsec: 30, sip: { a_order: 3 }, tps: { control_count: 100 } },
      photometry: [{ m_inst: 12 }],
    },
    confirm_status: { status: 'CONFIRMED', setExcessZ: 35.6, nTargets: 46, confirmed: 18 },
    psf_field: { provenance: 'MEASURED', not_measured: null },
    psf_attribution: { provenance: 'MEASURED', not_measured: null },
    lens_distortion_measured: { provenance: 'MEASURED', not_measured: null },
    spcc: { source: 'GaiaXP' },
    deep_confirmed: { setGatePassed: true, examined: 46, confirmed: 18 },
    ...over,
  };
}
function unsolvedReceipt() {
  return { version: '2.10.0', solution: null, confirm_status: null };
}

// ── in-memory client (same 3-method contract as makeR2Client) ────────────────
function memClient() {
  const store = new Map(); // key -> { body: Buffer, meta }
  return {
    store,
    async head(key) {
      const o = store.get(key);
      return o ? { status: 200, sha256: o.meta.sha256 ?? null } : { status: 404, sha256: null };
    },
    async get(key) {
      const o = store.get(key);
      return o ? { status: 200, body: o.body.toString('utf8') } : { status: 404, body: null };
    },
    async put(key, body, { meta = {} } = {}) {
      store.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), meta });
      return { ok: true, status: 200 };
    },
  };
}
const readManifest = (client) => JSON.parse(client.store.get(manifestKey(FRAME12)).body.toString('utf8'));

describe('key scheme', () => {
  it('object key is solves/<frame12>/<artifactSha>.<ext>', () => {
    expect(objectKey(FRAME12, 'abc123', 'json')).toBe(`${SOLVES_PREFIX}/${FRAME12}/abc123.json`);
    expect(objectKey(FRAME12, 'def', '.PNG')).toBe(`${SOLVES_PREFIX}/${FRAME12}/def.png`);
    expect(manifestKey(FRAME12)).toBe(`${SOLVES_PREFIX}/${FRAME12}/manifest.json`);
  });
  it('content type mapping covers the pipeline artifact kinds', () => {
    expect(contentTypeForExt('json')).toBe('application/json');
    expect(contentTypeForExt('png')).toBe('image/png');
    expect(contentTypeForExt('arrow')).toBe('application/vnd.apache.arrow.file');
    expect(contentTypeForExt('xyz')).toBe('application/octet-stream');
  });
});

describe('quality extraction', () => {
  it('reads solved + stars + confirm + products from a rich receipt', () => {
    const q = extractQuality(solvedReceipt());
    expect(q.solved).toBe(true);
    expect(q.stars_matched).toBe(79);
    expect(q.confidence).toBeCloseTo(0.68);
    expect(q.confirm_status).toBe('CONFIRMED');
    expect(q.confirm_set_excess_z).toBeCloseTo(35.6);
    expect(q.products).toEqual(detectProducts(solvedReceipt()));
    // rich set present
    expect(q.products).toEqual(expect.arrayContaining([
      'psf_field', 'psf_attribution', 'lens_distortion_measured', 'deep_confirmed', 'spcc', 'sip', 'tps', 'photometry',
    ]));
    expect(q.product_count).toBe(q.products.length);
  });
  it('honest failure: unsolved receipt ⇒ solved:false, zero stars, null confirm', () => {
    const q = extractQuality(unsolvedReceipt());
    expect(q).toMatchObject({ solved: false, stars_matched: 0, confidence: null, confirm_status: null, confirm_set_excess_z: null, product_count: 0 });
  });
  it('not_measured product blocks do not count toward richness', () => {
    const r = solvedReceipt({ psf_field: { not_measured: 'coverage too thin' } });
    expect(detectProducts(r)).not.toContain('psf_field');
  });
});

describe('v1 quality ordering (strict; ties keep incumbent)', () => {
  const base = { solved: true, stars_matched: 50, confirm_set_excess_z: 10, product_count: 3 };
  it('solved beats unsolved', () => {
    expect(isStrictlyBetter({ ...base, solved: true }, { ...base, solved: false })).toBe(true);
    expect(isStrictlyBetter({ ...base, solved: false }, { ...base, solved: true })).toBe(false);
  });
  it('more matched stars wins before confirm/products', () => {
    expect(isStrictlyBetter({ ...base, stars_matched: 60 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, stars_matched: 40 }, base)).toBe(false);
  });
  it('higher confirm excess-Z wins; null sorts as -Infinity', () => {
    expect(isStrictlyBetter({ ...base, confirm_set_excess_z: 20 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, confirm_set_excess_z: null }, base)).toBe(false);
    expect(isStrictlyBetter(base, { ...base, confirm_set_excess_z: null })).toBe(true);
  });
  it('richer product set is the final tiebreak', () => {
    expect(isStrictlyBetter({ ...base, product_count: 5 }, base)).toBe(true);
  });
  it('a full tie is NOT strictly better (incumbent stands)', () => {
    expect(isStrictlyBetter({ ...base }, { ...base })).toBe(false);
  });
  it('QUALITY_ORDERING documents the four keys in order', () => {
    expect(QUALITY_ORDERING).toEqual(['solved', 'stars_matched', 'confirm_set_excess_z', 'product_count']);
  });
});

describe('manifest merge', () => {
  const mkRun = (id, quality) => buildRunEntry({
    receiptSha: id, receiptKey: `${SOLVES_PREFIX}/${FRAME12}/${id}.json`,
    receiptSchemaVersion: '2.10.0', engineRef: 'abc1234', quality,
    artifacts: [{ role: 'receipt', key: `${SOLVES_PREFIX}/${FRAME12}/${id}.json`, sha256: id, bytes: 1, content_type: 'application/json' }],
    ts: '2026-07-11T00:00:00.000Z',
  });
  const q = (over) => ({ solved: true, stars_matched: 50, confirm_set_excess_z: 10, product_count: 3, ...over });

  it('first run seeds the manifest and becomes best', () => {
    const { manifest, addedRun, bestRunId } = mergeManifest(null, mkRun('run1', q()), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T0' });
    expect(manifest.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.frame_sha12).toBe(FRAME12);
    expect(manifest.runs).toHaveLength(1);
    expect(addedRun).toBe(true);
    expect(bestRunId).toBe('run1');
    expect(manifest.best.run_id).toBe('run1');
  });
  it('a strictly-better run updates best; the prior run stays as lineage', () => {
    const first = mergeManifest(null, mkRun('run1', q({ stars_matched: 50 })), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T0' }).manifest;
    const { manifest, bestRunId } = mergeManifest(first, mkRun('run2', q({ stars_matched: 80 })), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T1' });
    expect(manifest.runs.map((r) => r.run_id)).toEqual(['run1', 'run2']);
    expect(bestRunId).toBe('run2');
    expect(manifest.best.quality.stars_matched).toBe(80);
  });
  it('a WORSE run is appended but best is unchanged (ties/worse keep incumbent)', () => {
    const first = mergeManifest(null, mkRun('run1', q({ stars_matched: 80 })), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T0' }).manifest;
    const { manifest, bestRunId } = mergeManifest(first, mkRun('run2', q({ stars_matched: 50 })), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T1' });
    expect(manifest.runs).toHaveLength(2);
    expect(bestRunId).toBe('run1');
  });
  it('re-pushing an IDENTICAL run_id does not duplicate the entry', () => {
    const first = mergeManifest(null, mkRun('run1', q()), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T0' }).manifest;
    const { manifest, addedRun } = mergeManifest(first, mkRun('run1', q()), { frameSha: FRAME_SHA, frameSha12: FRAME12, now: 'T1' });
    expect(manifest.runs).toHaveLength(1);
    expect(addedRun).toBe(false);
  });
});

describe('pushSolve end-to-end (in-memory client — two-level dedup)', () => {
  const receiptBytes = Buffer.from(JSON.stringify(solvedReceipt()));

  it('uploads content-addressed objects + manifest, sets best, carries metadata', async () => {
    const client = memClient();
    const res = await pushSolve({ receiptBytes, frameSha: FRAME_SHA, engineRef: 'eng1234', client, now: 'T0' });
    expect(res.uploaded).toBe(1);          // just the receipt
    expect(res.skipped).toBe(0);
    expect(res.becameBest).toBe(true);
    // receipt object at solves/<f12>/<receiptSha>.json with sha + frame + solved meta
    const receiptSha = sha256Hex(receiptBytes);
    const key = objectKey(FRAME12, receiptSha, 'json');
    const stored = client.store.get(key);
    expect(stored).toBeTruthy();
    expect(stored.meta.sha256).toBe(receiptSha);
    expect(stored.meta['frame-sha']).toBe(FRAME_SHA);
    expect(stored.meta.solved).toBe('true');
    expect(stored.meta['engine-ref']).toBe('eng1234');
    // manifest present, one run, best pointer set
    const man = readManifest(client);
    expect(man.runs).toHaveLength(1);
    expect(man.best.run_id).toBe(receiptSha);
    expect(man.quality_ordering).toEqual(QUALITY_ORDERING);
  });

  it('LEVEL-1 dedup: re-pushing the identical receipt skips the object and does not duplicate the run', async () => {
    const client = memClient();
    await pushSolve({ receiptBytes, frameSha: FRAME_SHA, engineRef: 'eng1234', client, now: 'T0' });
    const res2 = await pushSolve({ receiptBytes, frameSha: FRAME_SHA, engineRef: 'eng1234', client, now: 'T1' });
    expect(res2.uploaded).toBe(0);
    expect(res2.skipped).toBe(1);          // receipt object already present
    expect(res2.manifestRuns).toBe(1);     // record-level dedup on run_id
  });

  it('LEVEL-2: a richer solve of the SAME frame updates best; the weaker run remains', async () => {
    const client = memClient();
    // weaker first (fewer stars)
    const weak = Buffer.from(JSON.stringify(solvedReceipt({ solution: { ra_hours: 17.5, stars_matched: 40, confidence: 0.5 } })));
    await pushSolve({ receiptBytes: weak, frameSha: FRAME_SHA, engineRef: 'e1', client, now: 'T0' });
    // richer second (more stars)
    const strong = receiptBytes;
    const res = await pushSolve({ receiptBytes: strong, frameSha: FRAME_SHA, engineRef: 'e2', client, now: 'T1' });
    const man = readManifest(client);
    expect(man.runs).toHaveLength(2);
    expect(res.becameBest).toBe(true);
    expect(man.best.run_id).toBe(sha256Hex(strong));
    expect(man.best.quality.stars_matched).toBe(79);
  });

  it('honest failure: an unsolved receipt still uploads and is recorded (solved:false)', async () => {
    const client = memClient();
    const bytes = Buffer.from(JSON.stringify(unsolvedReceipt()));
    const res = await pushSolve({ receiptBytes: bytes, frameSha: FRAME_SHA, engineRef: 'e', client, now: 'T0' });
    expect(res.uploaded).toBe(1);
    const key = objectKey(FRAME12, sha256Hex(bytes), 'json');
    expect(client.store.get(key).meta.solved).toBe('false');
    expect(readManifest(client).runs[0].quality.solved).toBe(false);
  });

  it('extras (e.g. a render PNG) upload under their own content-addressed key + role', async () => {
    const client = memClient();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const res = await pushSolve({
      receiptBytes, frameSha: FRAME_SHA, engineRef: 'e', client, now: 'T0',
      extras: [{ bytes: png, ext: 'png', role: 'render' }],
    });
    expect(res.uploaded).toBe(2);
    const pngKey = objectKey(FRAME12, sha256Hex(png), 'png');
    expect(client.store.get(pngKey)).toBeTruthy();
    expect(client.store.get(pngKey).meta['content-type'] ?? 'n/a').toBeDefined();
    const man = readManifest(client);
    expect(man.runs[0].artifacts.map((a) => a.role)).toEqual(expect.arrayContaining(['receipt', 'render']));
  });

  it('dry-run touches no client (no HEAD/GET/PUT)', async () => {
    let touched = 0;
    const spy = { head: async () => { touched++; return { status: 404 }; }, get: async () => { touched++; return { status: 404 }; }, put: async () => { touched++; return { ok: true, status: 200 }; } };
    const res = await pushSolve({ receiptBytes, frameSha: FRAME_SHA, client: spy, dryRun: true, now: 'T0' });
    expect(touched).toBe(0);
    expect(res.dryRun).toBe(true);
  });

  it('rejects a frameSha that is not 64-hex', async () => {
    await expect(pushSolve({ receiptBytes, frameSha: 'nothex', client: memClient() })).rejects.toThrow(/frameSha/);
  });
});
