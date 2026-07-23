import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partsManifestKey, reassembleChunked } from './fetch_index.mjs';

const tmp = [];
function td() {
    const d = mkdtempSync(join(tmpdir(), 'skc-fetch-'));
    tmp.push(d);
    return d;
}
afterEach(() => {
    while (tmp.length) {
        try {
            rmSync(tmp.pop(), { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

describe('fetch_index — chunked-object reassembly (skycruncher.r2.chunked-object/1)', () => {
    it('partsManifestKey maps target → parts manifest key', () => {
        expect(partsManifestKey('band_0.arrow')).toBe('band_0.parts.json');
        expect(partsManifestKey('band_12.arrow')).toBe('band_12.parts.json');
        expect(partsManifestKey('stars.arrow')).toBe('stars.parts.json');
        expect(partsManifestKey('foo')).toBe('foo.parts.json');
    });

    it('reassembles parts in ascending order and verifies the whole sha256', async () => {
        const p0 = Buffer.from('AAAAAA');
        const p1 = Buffer.from('BBBB');
        const p2 = Buffer.from('CC');
        const whole = Buffer.concat([p0, p1, p2]);
        const byKey = { 'x/p0': p0, 'x/p1': p1, 'x/p2': p2 };
        const fetchFn = async (url) => new Response(byKey[url.split('/pref/')[1]]);
        const pm = {
            schema: 'skycruncher.r2.chunked-object/1',
            target: 'band_0.arrow',
            whole: { bytes: whole.length, sha256: sha256(whole) },
            // deliberately out of order — reassembly must sort by `order`.
            parts: [
                { order: 2, key: 'p2', bytes: p2.length },
                { order: 0, key: 'p0', bytes: p0.length },
                { order: 1, key: 'p1', bytes: p1.length },
            ],
        };
        const dest = join(td(), 'band_0.arrow');
        const r = await reassembleChunked({ fetchFn, base: 'http://r2', prefix: 'pref/x', pm, dest });
        expect(r.ok).toBe(true);
        expect(existsSync(dest)).toBe(true);
        expect(readFileSync(dest).equals(whole)).toBe(true);
        expect(existsSync(`${dest}.part`)).toBe(false); // renamed on success
    });

    it('rejects a whole-sha mismatch (no dest written)', async () => {
        const p0 = Buffer.from('AAAA');
        const byKey = { 'x/p0': p0 };
        const fetchFn = async (url) => new Response(byKey[url.split('/pref/')[1]]);
        const pm = {
            schema: 'skycruncher.r2.chunked-object/1',
            whole: { bytes: 4, sha256: 'deadbeef'.repeat(8) },
            parts: [{ order: 0, key: 'p0', bytes: 4 }],
        };
        const dest = join(td(), 'band_0.arrow');
        const r = await reassembleChunked({ fetchFn, base: 'http://r2', prefix: 'pref/x', pm, dest });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/sha mismatch/);
        expect(existsSync(dest)).toBe(false);
    });

    it('rejects a byte-count mismatch (truncated part)', async () => {
        const p0 = Buffer.from('AAAA');
        const fetchFn = async () => new Response(p0);
        const pm = {
            schema: 'skycruncher.r2.chunked-object/1',
            whole: { bytes: 999, sha256: sha256(p0) },
            parts: [{ order: 0, key: 'p0', bytes: 999 }],
        };
        const dest = join(td(), 'band_0.arrow');
        const r = await reassembleChunked({ fetchFn, base: 'http://r2', prefix: 'pref/x', pm, dest });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/≠ whole/);
    });

    it('rejects an unexpected chunk schema', async () => {
        const r = await reassembleChunked({
            fetchFn: async () => new Response(Buffer.from('x')),
            base: 'http://r2',
            prefix: 'p',
            pm: { schema: 'something.else/9', parts: [{ order: 0, key: 'p0' }] },
            dest: join(td(), 'x.arrow'),
        });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/unexpected chunk schema/);
    });
});
