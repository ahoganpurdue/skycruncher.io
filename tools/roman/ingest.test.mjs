/**
 * Gate for the ingest normalizer (tools/roman/ingest_roman.mjs), DETERMINISTIC
 * portion only: dialect detection + honest-or-absent field extraction + the
 * dialect-independent gwcs transform inventory, with the Python WCS-eval bridge
 * DISABLED (evalWcs:false). The bridge itself (WSL isolated venv) is proven by
 * the pasted cross-dialect CLI evidence in the handoff, not by this gate — a
 * WSL/venv dependency has no place in the sacred `npx vitest run`.
 *
 * The SKYCRUNCHER fixture is built in-process by the SHARED writer, so no
 * local-only asset (M66 FITS / atlas / Roman venv) is required here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serializeAsdf } from '../../src/engine/pipeline/export/asdf_writer.ts';
import { buildFixtureAsdf, libraryVersion } from '../asdf/export_asdf.ts';
import { ingestAsdf, toWslPath } from './ingest_roman.mjs';

function writeFixture(opts) {
    const { receipt, image } = buildFixtureAsdf(opts);
    const bytes = serializeAsdf(receipt, image, { libraryVersion: libraryVersion() });
    const p = path.join(os.tmpdir(), `skycruncher_ingest_${opts._tag ?? 'lin'}_${process.pid}.asdf`);
    fs.writeFileSync(p, Buffer.from(bytes));
    return p;
}

describe('ingest_roman — SKYCRUNCHER dialect normalization (bridge disabled)', () => {
    it('detects the SKYCRUNCHER dialect and extracts honest meta + data', () => {
        const p = writeFixture({});
        try {
            const m = ingestAsdf(p, { evalWcs: false });
            expect(m.source_dialect).toBe('SKYCRUNCHER');
            expect(m.asdf.standard_version).toBe('1.6.0');
            expect(m.asdf.block_count).toBe(1);
            expect(m.meta.receipt_version).toBe('2.2.0');
            expect(m.meta.spatial_hash).toBe('fixture0001');
            expect(m.meta.stars_matched).toBe(2);
            expect(m.meta.ra_hours).toBeCloseTo(11.341253475172621, 12);
            expect(m.data.shape).toEqual([6, 8]);
            expect(m.data.dtype).toBe('uint16');
            expect(m.data.decodable).toBe(true);
        } finally { fs.unlinkSync(p); }
    });

    it('inventories the native gwcs transform chain from the tree (no Python)', () => {
        const p = writeFixture({ withSip: true, _tag: 'sip' });
        try {
            const m = ingestAsdf(p, { evalWcs: false });
            expect(m.wcs.present).toBe(true);
            expect(m.wcs.type).toBe('gwcs');
            expect(m.wcs.key_path).toBe('wcs');
            const inv = m.wcs.transform_inventory;
            expect(inv.transforms.shift).toBeGreaterThanOrEqual(2);
            expect(inv.transforms.gnomonic).toBe(1);
            expect(inv.transforms.rotate3d).toBe(1);
            expect(inv.has_sip_polynomial).toBe(true);      // withSip → polynomial node
            expect(inv.has_tabular_distortion).toBe(false);
            expect(inv.frames).toContain('frame2d');
            expect(inv.frames).toContain('celestial_frame');
            expect(inv.coordinate_frames).toContain('icrs');
            // bridge disabled → evaluation is honestly marked, no fabricated coord
            expect(m.wcs.evaluation.evaluated).toBe(false);
            expect(m.wcs_center).toBeNull();
        } finally { fs.unlinkSync(p); }
    });

    it('inventories the TPS tabular distortion node when present', () => {
        const p = writeFixture({ withTps: true, _tag: 'tps' });
        try {
            const m = ingestAsdf(p, { evalWcs: false });
            expect(m.wcs.transform_inventory.has_tabular_distortion).toBe(true);
        } finally { fs.unlinkSync(p); }
    });

    it('toWslPath converts drive-letter Windows paths', () => {
        expect(toWslPath('K:\\a\\b c\\f.asdf')).toBe('/mnt/k/a/b c/f.asdf');
        expect(toWslPath('/already/posix')).toBe('/already/posix');
    });
});
