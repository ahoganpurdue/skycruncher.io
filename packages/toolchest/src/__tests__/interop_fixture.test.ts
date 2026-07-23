import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    arrowBytesToTable,
    tableToArrowFileBytes,
    exportAllTables,
} from '../index';
import { sampleReceipt } from '../testing/sample_receipt';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const read = (name: string) => arrowBytesToTable(new Uint8Array(readFileSync(join(FIX, `${name}.arrow`))));

describe('toolchest Arrow — committed fixture interop', () => {
    it('matched_stars.arrow re-reads with the expected schema + exact values', () => {
        const t = read('matched_stars');
        expect(t.numRows).toBe(3);
        expect(t.numCols).toBe(20);
        // units labelled in field metadata (the cross-language reader sees these)
        expect(t.schema.fields.find((f) => f.name === 'ra_deg')!.metadata.get('units')).toContain('degrees');
        expect(t.schema.metadata.get('law7_boundary')).toBe('binary_layouts#toolchest_arrow_export');
        expect(t.schema.metadata.get('receipt_schema_version')).toBe('2.10.0');
        // exact values
        expect(t.getChild('ra_deg')!.get(0)).toBe(170.11880212758932);
        expect(t.getChild('residual_arcsec')!.get(0)).toBe(0.31);
        expect(t.getChild('dDec_arcsec')!.get(0)).toBe(-0.14);
        expect(t.getChild('gaia_id')!.get(2)).toBe('410903020304050607');
        expect(t.getChild('bv')!.get(1)).toBeNull();
        expect(t.getChild('peak_r')!.get(1)).toBeNull();
        // non-null column → no validity bitmap survived the file
        const raChild = t.getChild('ra_deg')!;
        expect(raChild.nullCount).toBe(0);
        expect((raChild.data[0].nullBitmap?.length ?? 0)).toBe(0);
    });

    it('run_summary.arrow carries the RA-in-HOURS scalar with HOURS units', () => {
        const t = read('run_summary');
        expect(t.numRows).toBe(1);
        expect(t.schema.fields.find((f) => f.name === 'ra_hours')!.metadata.get('units')).toContain('HOURS');
        expect(t.getChild('ra_hours')!.get(0)).toBe(11.341253475172621);
        expect(t.getChild('pixel_scale')!.get(0)).toBe(3.6776147325019153);
        expect(t.getChild('confirm_status')!.get(0)).toBe('CONFIRMED');
        expect(t.getChild('confirmed_count')!.get(0)).toBe(18);
    });

    it('detections.arrow + forced_confirmed.arrow re-read exactly', () => {
        const d = read('detections');
        expect(d.numRows).toBe(3);
        expect(d.getChild('rawX')!.get(0)).toBe(2049.0);
        expect(d.getChild('culling_reason')!.get(2)).toBeNull();
        const f = read('forced_confirmed');
        expect(f.numRows).toBe(2);
        expect(f.getChild('confidence')!.get(0)).toBe(0.997);
        expect(f.getChild('mag')!.get(1)).toBeNull();
    });

    it('committed fixtures are BYTE-IDENTICAL to the live export (regen guard)', () => {
        // If this fails, the export changed — regenerate with `npm -w @skycruncher/toolchest run make-fixtures`.
        const live = exportAllTables(sampleReceipt());
        for (const name of ['matched_stars', 'detections', 'forced_confirmed', 'run_summary'] as const) {
            const onDisk = readFileSync(join(FIX, `${name}.arrow`));
            const fresh = Buffer.from(tableToArrowFileBytes(live[name]));
            expect(fresh.equals(onDisk)).toBe(true);
        }
    });
});
