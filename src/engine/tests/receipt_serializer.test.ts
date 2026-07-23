/**
 * receipt_serializer.test.ts — I0.2 extraction guard.
 *
 * The serializer moved from ui/utils/save_packet.ts (inline replacer) to the
 * pure module stages/receipt_serializer.ts. These tests pin BOTH properties
 * the extraction must preserve:
 *   1. the heavy typed-array keys are stripped wherever they appear, and
 *   2. the output string is BYTE-IDENTICAL to the old inlined implementation
 *      (JSON.stringify(packet, inlineReplacer, 2)) — the receipt is an API
 *      contract; its bytes may not drift through a refactor.
 */
import { describe, it, expect } from 'vitest';
import {
    DROPPED_KEYS,
    receiptReplacer,
    serializeReceipt,
    receiptFileName,
} from '../pipeline/stages/receipt_serializer';

// ─── The OLD implementation, verbatim (save_packet.ts pre-I0.2) ─────────────
// Kept here as the reference the extraction is asserted against.
const OLD_DROPPED_KEYS = new Set([
    'scienceBuffer',
    'segmentationMasks',
    'horizonVector',
    'anomaly_grid',
]);
function oldInlineSerialize(packet: any): string {
    return JSON.stringify(
        packet,
        (key, value) => (OLD_DROPPED_KEYS.has(key) ? undefined : value),
        2
    );
}

// ─── Deliberate additions since the I0.2 extraction ──────────────────────────
// The extraction-fidelity guard below pins DROPPED_KEYS as EXACTLY the old
// inlined set PLUS the entries enumerated here — nothing may enter the set
// without being listed (and dated/justified) in this ledger. This keeps the
// original I0.2 guarantee (no silent drift through the refactor) while allowing
// reviewed, additive growth.
const ADDED_KEYS = [
    // 2026-07-10 (ultracode G6): SignalPacket.scattering_profile — a Float32Array
    // reachable via package.ts but never populated by any stage today, so the
    // addition is byte-neutral for every existing receipt (proven by the
    // byte-identity test below, whose fixture predates the key).
    'scattering_profile',
];

/** Fixture receipt: realistic shape with heavy typed arrays at several depths. */
function makeFixtureReceipt(): any {
    return {
        version: '2.2.0',
        metadata: { camera: 'SeeStar S50', width: 1080, height: 1920 },
        signal: {
            clean_stars: [
                { x: 12.5, y: 88.25, flux: 1043.5, fwhm: 3.2 },
                { x: 640.0, y: 512.75, flux: 220.125, fwhm: 2.9 },
            ],
            scienceBuffer: new Float32Array([0.1, 0.2, 0.3, 0.4]),
            segmentationMasks: new Uint16Array([1, 0, 1, 0]),
            anomaly_grid: new Float32Array([9.9, 8.8]),
        },
        solution: {
            ra_hours: 11.341253475172621,
            dec_degrees: 13.048392248246461,
            pixel_scale: 3.6776147325019153,
            spatial_hash: 'RA11h_D+13',
            matched_stars: [
                { gaia_id: 'Gaia_123', x: 1.5, y: 2.5, residual_arcsec: 0.42 },
            ],
        },
        forensics: {
            nested: {
                horizonVector: new Float32Array([0.5, 0.6, 0.7]),
                keep_me: 'present',
            },
        },
        warnings: [],
        timestamp_trusted: true,
        export_date: '2026-07-06T00:00:00.000Z',
    };
}

describe('receipt_serializer (I0.2 extraction)', () => {
    it('DROPPED_KEYS = the old inlined set plus exactly the enumerated additions', () => {
        // Superset-plus-exact-additions pin: proves the extraction lost nothing
        // (every OLD key present) AND that no key sneaks in unreviewed (the set
        // equals old ∪ ADDED_KEYS, nothing else).
        expect(DROPPED_KEYS).toEqual(new Set([...OLD_DROPPED_KEYS, ...ADDED_KEYS]));
    });

    it('strips scattering_profile (2026-07-10 addition) wherever it appears', () => {
        const parsed = JSON.parse(serializeReceipt({
            signal: { scattering_profile: new Float32Array([1.5, 2.5]), keep_me: 1 },
            nested: { deep: { scattering_profile: new Float32Array([9]) } },
        }));
        expect(parsed.signal.scattering_profile).toBeUndefined();
        expect(parsed.nested.deep.scattering_profile).toBeUndefined();
        expect(parsed.signal.keep_me).toBe(1);
    });

    it('strips heavy typed-array keys wherever they appear (top-level and nested)', () => {
        const parsed = JSON.parse(serializeReceipt(makeFixtureReceipt()));
        expect(parsed.signal.scienceBuffer).toBeUndefined();
        expect(parsed.signal.segmentationMasks).toBeUndefined();
        expect(parsed.signal.anomaly_grid).toBeUndefined();
        expect(parsed.forensics.nested.horizonVector).toBeUndefined();
        // Neighbors survive: stripping is key-targeted, not subtree-wide.
        expect(parsed.forensics.nested.keep_me).toBe('present');
        expect(parsed.signal.clean_stars).toHaveLength(2);
        expect(parsed.solution.spatial_hash).toBe('RA11h_D+13');
    });

    it('produces EXACTLY the old inlined implementation string (byte-identical)', () => {
        // NOTE: the fixture deliberately contains NO ADDED_KEYS fields — the pinned
        // property is that any packet the OLD implementation could see serializes
        // byte-identically. Do not add post-I0.2 keys to makeFixtureReceipt(); the
        // added keys get their own targeted stripping test above.
        const fixture = makeFixtureReceipt();
        expect(serializeReceipt(fixture)).toBe(oldInlineSerialize(fixture));
    });

    it('receiptReplacer passes non-dropped values through untouched', () => {
        expect(receiptReplacer('ra_hours', 11.34)).toBe(11.34);
        expect(receiptReplacer('scienceBuffer', new Float32Array([1]))).toBeUndefined();
    });

    it('receiptFileName uses spatial_hash when present, Date.now() fallback otherwise', () => {
        expect(receiptFileName({ solution: { spatial_hash: 'RA11h_D+13' } }))
            .toBe('skycruncher_receipt_RA11h_D+13.json');
        expect(receiptFileName({ solution: { spatial_hash: 'X' } }, 'custom_base'))
            .toBe('custom_base_X.json');
        const before = Date.now();
        const name = receiptFileName({});
        const after = Date.now();
        const stamp = Number(name.match(/^skycruncher_receipt_(\d+)\.json$/)?.[1]);
        expect(stamp).toBeGreaterThanOrEqual(before);
        expect(stamp).toBeLessThanOrEqual(after);
    });
});
