/**
 * Round-trip gate for the subset ASDF reader (tools/asdf/asdf_reader.mjs).
 *
 * Proves the reader recovers, from OUR OWN writer's byte stream:
 *   • every receipt tree field we wrote (scalars, nested maps, sequences, quoted
 *     keys, small/large numbers)
 *   • the binary ndarray block (shape + dtype + EXACT pixel bytes)
 *   • the deep native gwcs transform tree (tags preserved, chain walkable) for
 *     the linear, SIP-polynomial and TPS-tabular variants
 *   • honest failure on an unsupported YAML construct (block scalar) — the reader
 *     must THROW, never silently mis-parse.
 *
 * In-memory: buildFixtureAsdf → serializeAsdf (the SHARED writer) → parseAsdf.
 */

import { describe, it, expect } from 'vitest';

import { serializeAsdf } from '../../src/engine/pipeline/export/asdf_writer.ts';
import { buildFixtureAsdf, libraryVersion } from './export_asdf.ts';
import { parseAsdf, isTagged, untag, decodeNdarray, AsdfError } from './asdf_reader.mjs';

function serialize(opts) {
    const { receipt, image } = buildFixtureAsdf(opts);
    const bytes = serializeAsdf(receipt, image, { libraryVersion: libraryVersion() });
    return { bytes: Buffer.from(bytes), receipt, image };
}

/** Walk a (possibly tagged) tree collecting every transform/* tag name. */
function collectTransformTags(node, acc = []) {
    if (isTagged(node)) {
        const t = node.__tag__;
        if (t.includes('transform/') || t.includes('gwcs/')) acc.push(t);
        collectTransformTags(node.__value__, acc);
        return acc;
    }
    if (Array.isArray(node)) { for (const x of node) collectTransformTags(x, acc); return acc; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) collectTransformTags(node[k], acc); return acc; }
    return acc;
}

describe('asdf_reader — round-trip of our own ASDF export', () => {
    it('recovers header, standard version and the block inventory', () => {
        const { bytes } = serialize({});
        const asdf = parseAsdf(bytes, 'lin');
        expect(asdf.comments[0]).toBe('#ASDF 1.0.0');
        expect(asdf.standardVersion).toBe('1.6.0');
        expect(asdf.directives).toContain('%YAML 1.1');
        expect(asdf.blocks.length).toBe(1);
        expect(asdf.blocks[0].compression).toBe('none');
    });

    it('recovers the receipt tree fields we wrote', () => {
        const { bytes, receipt } = serialize({});
        const { tree } = parseAsdf(bytes, 'lin');

        expect(tree.version).toBe('2.2.0');
        expect(tree.solution.spatial_hash).toBe('fixture0001');
        expect(tree.solution.stars_matched).toBe(2);
        expect(tree.solution.ra_hours).toBeCloseTo(receipt.solution.ra_hours, 12);
        expect(tree.solution.pixel_scale).toBeCloseTo(receipt.solution.pixel_scale, 12);
        expect(tree.timestamp_trusted).toBe(false);
        expect(tree.psf_field).toBeNull();
        expect(tree.deep_confirmed).toBeNull();
        expect(Array.isArray(tree.planets)).toBe(true);
        expect(tree.planets.length).toBe(0);
        expect(tree.warnings).toEqual(['fixture: synthetic — no real capture']);

        // matched_stars: a block sequence of compact mappings incl. a QUOTED key ("y")
        expect(tree.solution.matched_stars.length).toBe(2);
        const s0 = tree.solution.matched_stars[0];
        expect(s0.gaia_id).toBe('G1');
        expect(s0.x).toBeCloseTo(1.5, 12);
        expect(s0.y).toBeCloseTo(2.5, 12);
        expect(s0.ra_deg).toBeCloseTo(170.1, 10);
        // the second star's fwhm was the integer 2 — recovered as a number
        expect(tree.solution.matched_stars[1].fwhm).toBe(2);
    });

    it('recovers the wcs_fits FITS-keyword block with exact CD values', () => {
        const { bytes, receipt } = serialize({});
        const { tree } = parseAsdf(bytes, 'lin');
        const w = tree.wcs_fits;
        expect(w.CTYPE1).toBe('RA---TAN');
        expect(w.CRPIX1).toBe(4);
        expect(w.CRVAL1).toBeCloseTo(170.1188, 10);
        expect(w.CD1_1).toBeCloseTo(receipt.wcs.CD1_1, 15);
        expect(w.CD1_2).toBeCloseTo(receipt.wcs.CD1_2, 15);
        expect(w.RADESYS).toBe('ICRS');
    });

    it('recovers the binary ndarray block: shape, dtype and EXACT pixel bytes', () => {
        const { bytes, image } = serialize({});
        const asdf = parseAsdf(bytes, 'lin');
        // `data` is a tagged !core/ndarray node → source references block 0.
        const nd = asdf.readNdarray(asdf.tree.data);
        expect(nd.shape).toEqual([6, 8]);
        expect(nd.dtype).toBe('uint16');
        const px = decodeNdarray(nd);
        expect(px.length).toBe(image.data.length);
        // the fixture ramp is value = (i*257) & 0xffff
        for (let i = 0; i < px.length; i++) expect(px[i]).toBe((i * 257) & 0xffff);
    });

    it('recovers the native LINEAR gwcs transform chain (tags preserved)', () => {
        const { bytes } = serialize({});
        const { tree } = parseAsdf(bytes, 'lin');
        expect(isTagged(tree.wcs)).toBe(true);
        expect(tree.wcs.__tag__).toContain('gwcs/wcs-1.4.0');
        const wcsBody = untag(tree.wcs);
        expect(Array.isArray(wcsBody.steps)).toBe(true);
        expect(wcsBody.steps.length).toBe(2);
        const tags = collectTransformTags(tree.wcs);
        // linear chain: compose/concatenate/shift/affine/gnomonic/rotate3d present
        expect(tags.some(t => t.includes('shift'))).toBe(true);
        expect(tags.some(t => t.includes('affine'))).toBe(true);
        expect(tags.some(t => t.includes('gnomonic'))).toBe(true);
        expect(tags.some(t => t.includes('rotate3d'))).toBe(true);
        expect(tags.some(t => t.includes('polynomial'))).toBe(false); // no SIP
        expect(tags.some(t => t.includes('tabular'))).toBe(false);     // no TPS
    });

    it('recovers the SIP polynomial node in the gwcs chain', () => {
        const { bytes } = serialize({ withSip: true });
        const { tree } = parseAsdf(bytes, 'sip');
        const tags = collectTransformTags(tree.wcs);
        expect(tags.some(t => t.includes('polynomial'))).toBe(true);
        expect(tags.some(t => t.includes('remap_axes'))).toBe(true);
        // FITS SIP keywords ride the wcs_fits fallback too
        expect(tree.wcs_fits.CTYPE1).toBe('RA---TAN-SIP');
        expect(tree.wcs_fits.A_ORDER).toBe(2);
    });

    it('recovers the TPS tabular lookup node in the gwcs chain', () => {
        const { bytes } = serialize({ withTps: true });
        const { tree } = parseAsdf(bytes, 'tps');
        const tags = collectTransformTags(tree.wcs);
        expect(tags.some(t => t.includes('tabular'))).toBe(true);
        // inline lookup-table ndarray is a nested tagged node with inline data
        const tabularNode = findFirstTag(tree.wcs, 'tabular');
        expect(tabularNode).not.toBeNull();
        const body = untag(tabularNode);
        expect(Array.isArray(body.lookup_table.__value__.data ?? untag(body.lookup_table).data)).toBe(true);
    });

    it('recovers a small inline float ndarray (gwcs affine matrix) with tiny-exp values intact', () => {
        const { bytes } = serialize({ withSip: true });
        const { tree } = parseAsdf(bytes, 'sip');
        const affine = findFirstTag(tree.wcs, 'affine');
        const matrixNode = untag(affine).matrix;
        const m = untag(matrixNode);
        expect(m.shape).toEqual([2, 2]);
        expect(Array.isArray(m.data)).toBe(true);
        expect(m.data[0].length).toBe(2);
        // values are finite floats (the 1.0e-8 exponent-rewrite trap is handled)
        for (const row of m.data) for (const v of row) expect(Number.isFinite(v)).toBe(true);
    });

    it('FAILS HONESTLY on an unsupported YAML construct (block scalar)', () => {
        // hand-craft an ASDF header with a `|` block scalar — outside the subset.
        const bad = [
            '#ASDF 1.0.0',
            '#ASDF_STANDARD 1.6.0',
            '%YAML 1.1',
            '--- !core/asdf-1.1.0',
            'note: |',
            '  a block scalar line',
            '...',
            '',
        ].join('\n');
        expect(() => parseAsdf(Buffer.from(bad, 'utf8'), 'bad')).toThrow(AsdfError);
    });

    it('FAILS HONESTLY on a non-ASDF buffer', () => {
        expect(() => parseAsdf(Buffer.from('not asdf at all', 'utf8'), 'bad')).toThrow(/not an ASDF file/);
    });
});

/** DFS for the first tagged node whose tag contains `needle`. */
function findFirstTag(node, needle) {
    if (isTagged(node)) {
        if (node.__tag__.includes(needle)) return node;
        return findFirstTag(node.__value__, needle);
    }
    if (Array.isArray(node)) { for (const x of node) { const r = findFirstTag(x, needle); if (r) return r; } return null; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) { const r = findFirstTag(node[k], needle); if (r) return r; } return null; }
    return null;
}
