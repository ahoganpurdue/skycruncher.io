import { describe, it, expect } from 'vitest';
import { contentFingerprint, bayerCacheKey } from '../pipeline/stages/ingest';

// ─────────────────────────────────────────────────────────────────────────────
// Decode-cache key collision guard (ultracode HELD #17): the old key was
// `bayer_${byteLength}_${timestamp||'unknown'}` — two different frames with
// equal length and absent timestamps collided, and the second frame was handed
// the FIRST frame's cached pixels. The key now carries a bounded FNV-1a
// content fingerprint (head + tail + strided middle + length).
// ─────────────────────────────────────────────────────────────────────────────

function buf(size: number, fill: (i: number) => number): ArrayBuffer {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = fill(i) & 0xff;
    return b.buffer;
}

describe('contentFingerprint — bounded FNV-1a discriminator', () => {
    it('is deterministic for identical content', () => {
        const a = buf(100_000, i => i * 7 + 3);
        const b = buf(100_000, i => i * 7 + 3);
        expect(contentFingerprint(a)).toBe(contentFingerprint(b));
        expect(contentFingerprint(a)).toMatch(/^[0-9a-f]{8}$/);
    });

    it('separates same-length buffers with different content (the collision case)', () => {
        const a = buf(100_000, () => 0xaa);
        const b = buf(100_000, () => 0xbb);
        expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
    });

    it('separates buffers differing only in the head', () => {
        const a = buf(50_000, i => i);
        const b = buf(50_000, i => (i < 16 ? i + 1 : i));
        expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
    });

    it('separates buffers differing only in the tail', () => {
        const a = buf(50_000, i => i);
        const c = buf(50_000, i => (i >= 50_000 - 16 ? i + 1 : i));
        expect(contentFingerprint(a)).not.toBe(contentFingerprint(c));
    });

    it('separates different lengths even with identical sampled bytes', () => {
        const a = buf(4096, () => 0x11); // entire buffer sampled (edge-only path)
        const b = buf(4097, () => 0x11);
        expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
    });

    it('handles tiny buffers without throwing', () => {
        expect(contentFingerprint(new ArrayBuffer(0))).toMatch(/^[0-9a-f]{8}$/);
        expect(contentFingerprint(buf(3, i => i))).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('bayerCacheKey — no cross-frame collision on byteLength+timestamp', () => {
    it('two distinct frames with equal length + absent timestamps get distinct keys', () => {
        const frameA = buf(65_536, i => (i * 31) & 0xff);
        const frameB = buf(65_536, i => (i * 37) & 0xff);
        const keyA = bayerCacheKey(frameA, undefined);
        const keyB = bayerCacheKey(frameB, undefined);
        expect(keyA).not.toBe(keyB); // the old key format made these EQUAL
        expect(keyA).toContain('bayer_65536_');
        expect(keyA.endsWith('_unknown')).toBe(true);
    });

    it('the same frame keeps a stable key (cache still hits)', () => {
        const frame = buf(65_536, i => (i * 31) & 0xff);
        expect(bayerCacheKey(frame, '2024-06-15T04:12:33.000Z'))
            .toBe(bayerCacheKey(frame, '2024-06-15T04:12:33.000Z'));
    });

    it('timestamp still participates in the key', () => {
        const frame = buf(1024, i => i);
        expect(bayerCacheKey(frame, '2024-01-01T00:00:00Z'))
            .not.toBe(bayerCacheKey(frame, '2024-01-02T00:00:00Z'));
    });
});
