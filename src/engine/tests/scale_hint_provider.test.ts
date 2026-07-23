/**
 * PER-IMAGE SCALE HINT-PROVIDER SEAM (core/scale_hint_provider.ts) — a measured
 * plate scale, bound to a frame's content SHA-256, seeded into the scale search as
 * a labelled ASSUMPTION. Sibling of the optics FL hint seam.
 *
 * Pins: (a) BLIND BY DEFAULT — the built-in provider list is empty, so every query
 * declines until a caller opts in (integrity constraint: blind gauntlet lanes stay
 * blind); (b) the content-hash provider fires ONLY on an exact per-IMAGE byte match
 * and never leaks a scale to a different image/lens; (c) every hint is assumed:true
 * with source + reason (LAW 3); (d) buildMeasuredScaleEntries honestly drops labels
 * lacking a hash or a finite positive scale; (e) a throwing provider never breaks
 * the ladder.
 *
 * The 5D3 constants mirror the GOLD truth label in tools/validation/truth/labels.json
 * (frame_id CSM30803_5DMkIII_iso6400_15s) so the test stays hermetic (no disk read,
 * no race against concurrent label writes).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    queryScaleHintProviders,
    registerScaleHintProvider,
    clearScaleHintProviders,
    contentHashScaleHintProvider,
    buildMeasuredScaleEntries,
    type MeasuredScaleEntry,
} from '../core/scale_hint_provider';

const FIVE_D3_SHA = '6610645abac70d82ec5eb77a120704149a065f8bba518938ecd95f3abc5c2e6c';
const FIVE_D3_SCALE = 52.74;           // oracle-measured; the EXIF/nominal-FL prior was 41.97 (25.7% low)
const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

beforeEach(() => clearScaleHintProviders());
afterEach(() => clearScaleHintProviders());

describe('scale hint seam — blind by default (integrity)', () => {
    it('no providers registered ⇒ every query declines (blind default preserved)', () => {
        expect(queryScaleHintProviders({ content_sha256: FIVE_D3_SHA })).toBeNull();
        expect(queryScaleHintProviders({ content_sha256: OTHER_SHA })).toBeNull();
        expect(queryScaleHintProviders({})).toBeNull();
    });
});

describe('contentHashScaleHintProvider — per-IMAGE keyed labelled assumption', () => {
    const entries: MeasuredScaleEntry[] = [
        {
            content_sha256: FIVE_D3_SHA,
            pixel_scale_arcsec: FIVE_D3_SCALE,
            frame_id: 'CSM30803_5DMkIII_iso6400_15s',
            provenance: 'astrometry.net oracle',
        },
    ];

    it('fires on the exact 5D3 content hash → 52.74"/px, assumed:true, source + reason', () => {
        registerScaleHintProvider(contentHashScaleHintProvider(entries));
        const h = queryScaleHintProviders({ content_sha256: FIVE_D3_SHA });
        expect(h).not.toBeNull();
        expect(h!.value_arcsec_per_px).toBe(52.74);
        expect(h!.source).toBe('MEASURED_SCALE_CONTENT_HASH');
        expect(h!.assumed).toBe(true); // LAW 3 — a seed from a measurement made elsewhere, not this solve
        expect(typeof h!.reason).toBe('string');
        expect(h!.reason).toContain('Per-IMAGE');
    });

    it('case-insensitive hex match (sha digests differ only in case)', () => {
        registerScaleHintProvider(contentHashScaleHintProvider(entries));
        expect(
            queryScaleHintProviders({ content_sha256: FIVE_D3_SHA.toUpperCase() })!.value_arcsec_per_px
        ).toBe(52.74);
    });

    it('declines a non-matching / absent hash (honest-absent, no cross-image leak)', () => {
        registerScaleHintProvider(contentHashScaleHintProvider(entries));
        expect(queryScaleHintProviders({ content_sha256: OTHER_SHA })).toBeNull();
        expect(queryScaleHintProviders({ content_sha256: null })).toBeNull();
        expect(queryScaleHintProviders({})).toBeNull();
    });

    it('a throwing provider is skipped, never breaks the ladder', () => {
        registerScaleHintProvider(() => {
            throw new Error('boom');
        });
        registerScaleHintProvider(contentHashScaleHintProvider(entries));
        expect(queryScaleHintProviders({ content_sha256: FIVE_D3_SHA })!.value_arcsec_per_px).toBe(52.74);
    });
});

describe('buildMeasuredScaleEntries — honest distillation of truth labels', () => {
    it('keeps ONLY labels carrying both a content_sha256 and a finite positive scale', () => {
        const labels = [
            { frame_id: 'gold_5d3', content_sha256: FIVE_D3_SHA, pixel_scale_arcsec: 52.74, provenance_note: 'oracle' },
            { frame_id: 'center_only', content_sha256: 'abc', pixel_scale_arcsec: null }, // no scale → drop
            { frame_id: 'no_hash', pixel_scale_arcsec: 3.7 },                             // no hash → drop
            { frame_id: 'bad_scale', content_sha256: 'def', pixel_scale_arcsec: -1 },     // non-positive → drop
        ];
        const out = buildMeasuredScaleEntries(labels as any);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            content_sha256: FIVE_D3_SHA,
            pixel_scale_arcsec: 52.74,
            frame_id: 'gold_5d3',
            provenance: 'oracle',
        });
    });

    it('end-to-end: distilled 5D3 label → registered provider → measured scale seeds the 5D3 frame', () => {
        const labels = [
            {
                frame_id: 'CSM30803_5DMkIII_iso6400_15s',
                content_sha256: FIVE_D3_SHA,
                pixel_scale_arcsec: 52.74,
                provenance_note: 'astrometry.net oracle 52.74"/px',
            },
        ];
        registerScaleHintProvider(contentHashScaleHintProvider(buildMeasuredScaleEntries(labels as any)));
        const h = queryScaleHintProviders({ content_sha256: FIVE_D3_SHA });
        expect(h!.value_arcsec_per_px).toBe(52.74);
        // the wrong EXIF/nominal-FL prior (41.97) is NOT what gets seeded — the measured value wins
        expect(h!.value_arcsec_per_px).not.toBe(41.97);
    });

    it('non-array input ⇒ empty table (defensive)', () => {
        expect(buildMeasuredScaleEntries(null as any)).toEqual([]);
    });
});
