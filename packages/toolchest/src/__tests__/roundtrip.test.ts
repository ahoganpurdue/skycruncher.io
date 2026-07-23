import { describe, it, expect } from 'vitest';
import type { Table } from 'apache-arrow';
import {
    exportAllTables,
    matchedStarsTable,
    tableToArrowFileBytes,
    arrowBytesToTable,
} from '../index';
import { sampleReceipt, emptyReceipt } from '../testing/sample_receipt';

/** Round-trip a table through Arrow IPC file bytes and return the re-read copy. */
function roundtrip(t: Table): Table {
    return arrowBytesToTable(tableToArrowFileBytes(t));
}

/** True iff the (single-chunk) column carries NO validity bitmap. */
function noValidityBitmap(t: Table, col: string): boolean {
    const child = t.getChild(col)!;
    const bm = child.data[0].nullBitmap;
    return child.nullCount === 0 && (bm == null || bm.length === 0);
}

describe('toolchest Arrow export — round-trip', () => {
    it('emits the four tabular products with honest row counts', () => {
        const t = exportAllTables(sampleReceipt());
        expect(t.matched_stars.numRows).toBe(3);
        expect(t.detections.numRows).toBe(3);
        expect(t.forced_confirmed.numRows).toBe(2);
        expect(t.run_summary.numRows).toBe(1);
    });

    it('matched_stars survives IPC with IEEE-exact float values', () => {
        const src = sampleReceipt();
        const rows = src.solution!.matched_stars!;
        const rt = roundtrip(matchedStarsTable(src));

        const ra = rt.getChild('ra_deg')!;
        const dec = rt.getChild('dec_deg')!;
        const resid = rt.getChild('residual_arcsec')!;
        const dDec = rt.getChild('dDec_arcsec')!;
        for (let i = 0; i < rows.length; i++) {
            expect(ra.get(i)).toBe(rows[i].ra_deg); // bit-exact
            expect(dec.get(i)).toBe(rows[i].dec_deg);
            expect(resid.get(i)).toBe(rows[i].residual_arcsec);
        }
        // Genuine negative residual component preserved.
        expect(dDec.get(0)).toBe(-0.14);
    });

    it('carries Gaia ids as strings — exact for string ids, honest about pre-lossy number ids', () => {
        const rt = roundtrip(matchedStarsTable(sampleReceipt()));
        // A NUMERIC gaia_id > 2^53 is already rounded by JS at PARSE time, BEFORE the
        // toolchest sees it — stringifying preserves what remains, it cannot recover
        // precision the number literal already lost (the fix must be upstream: emit
        // gaia_id as a string from the catalog/receipt).
        expect(rt.getChild('gaia_id')!.get(0)).toBe(String(2321974934842921472));
        expect(rt.getChild('gaia_id')!.get(1)).toBeNull();
        // A STRING gaia_id round-trips BYTE-EXACT — the carrier does its job.
        expect(rt.getChild('gaia_id')!.get(2)).toBe('410903020304050607');
    });

    it('preserves nulls in nullable columns after IPC', () => {
        const rt = roundtrip(matchedStarsTable(sampleReceipt()));
        // row 1 is the all-null-optionals star
        expect(rt.getChild('bv')!.get(1)).toBeNull();
        expect(rt.getChild('flux')!.get(1)).toBeNull();
        expect(rt.getChild('peak_r')!.get(1)).toBeNull();
        expect(rt.getChild('peak_g')!.get(1)).toBeNull();
        expect(rt.getChild('dx_px')!.get(1)).toBeNull();
        // present neighbours unaffected
        expect(rt.getChild('bv')!.get(0)).toBe(0.65);
        expect(rt.getChild('peak_r')!.get(0)).toBe(60000);
    });

    it('NON-NULLABLE columns carry NO validity bitmap (the 6.44MB debt guard)', () => {
        const rt = roundtrip(matchedStarsTable(sampleReceipt()));
        // Structurally-present fields → no bitmap.
        for (const c of ['ra_deg', 'dec_deg', 'mag', 'x', 'y', 'residual_arcsec']) {
            expect(noValidityBitmap(rt, c)).toBe(true);
        }
        // Field nullable flag reflects the receipt contract.
        expect(rt.schema.fields.find((f) => f.name === 'ra_deg')!.nullable).toBe(false);
        expect(rt.schema.fields.find((f) => f.name === 'bv')!.nullable).toBe(true);
    });

    it('labels UNITS explicitly — RA hours vs RA degrees never confusable', () => {
        const ms = roundtrip(matchedStarsTable(sampleReceipt()));
        const rs = roundtrip(exportAllTables(sampleReceipt()).run_summary);
        const raDeg = ms.schema.fields.find((f) => f.name === 'ra_deg')!;
        const raHours = rs.schema.fields.find((f) => f.name === 'ra_hours')!;
        expect(raDeg.metadata.get('units')).toContain('degrees');
        expect(raHours.metadata.get('units')).toContain('HOURS');
        // provenance on both fields
        expect(raDeg.metadata.get('source')).toBe('receipt.solution.matched_stars[].ra_deg');
        expect(raHours.metadata.get('source')).toBe('receipt.solution.ra_hours');
    });

    it('run_summary carries the HOURS scalar and confirm verdict exactly', () => {
        const rt = roundtrip(exportAllTables(sampleReceipt()).run_summary);
        expect(rt.getChild('ra_hours')!.get(0)).toBe(11.341253475172621);
        expect(rt.getChild('dec_degrees')!.get(0)).toBe(41.269);
        expect(rt.getChild('parity')!.get(0)).toBe('1');
        expect(rt.getChild('confirm_status')!.get(0)).toBe('CONFIRMED');
        expect(rt.getChild('confirm_n_targets')!.get(0)).toBe(46);
        expect(rt.getChild('receipt_schema_version')!.get(0)).toBe('2.10.0');
    });

    it('stamps schema-level provenance metadata', () => {
        const rt = roundtrip(matchedStarsTable(sampleReceipt()));
        expect(rt.schema.metadata.get('law7_boundary')).toBe('binary_layouts#toolchest_arrow_export');
        expect(rt.schema.metadata.get('receipt_schema_version')).toBe('2.10.0');
        expect(rt.schema.metadata.get('table')).toBe('matched_stars');
        expect(rt.schema.metadata.get('source_field')).toBe('receipt.solution.matched_stars');
    });

    it('detections & forced_confirmed round-trip exactly', () => {
        const t = exportAllTables(sampleReceipt());
        const det = roundtrip(t.detections);
        expect(det.getChild('rawX')!.get(0)).toBe(2049.0);
        expect(det.getChild('theta')!.get(2)).toBe(1.57);
        expect(det.getChild('culling_reason')!.get(2)).toBeNull(); // absent → null
        const fc = roundtrip(t.forced_confirmed);
        expect(fc.getChild('confidence')!.get(0)).toBe(0.997);
        expect(fc.getChild('mag')!.get(1)).toBeNull();
        expect(fc.getChild('gaia_id')!.get(0)).toBe('2321974934842921472');
    });

    it('honest-or-absent: a no-solve receipt yields 0-row tables with full schema', () => {
        const t = exportAllTables(emptyReceipt());
        expect(t.matched_stars.numRows).toBe(0);
        expect(t.run_summary.numRows).toBe(0);
        // schema (column set) is intact even at 0 rows
        expect(t.matched_stars.schema.fields.length).toBeGreaterThan(15);
        const rt = roundtrip(t.matched_stars);
        expect(rt.numRows).toBe(0);
        expect(rt.schema.fields.find((f) => f.name === 'ra_deg')).toBeDefined();
    });

    it('IPC serialization is deterministic (byte-stable across builds)', () => {
        const a = tableToArrowFileBytes(matchedStarsTable(sampleReceipt()));
        const b = tableToArrowFileBytes(matchedStarsTable(sampleReceipt()));
        expect(a.length).toBe(b.length);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });
});
