import { tableFromIPC } from 'apache-arrow';

/**
 * ATLAS ARROW CODEC — decoder for the flag-gated binary atlas-sector format.
 * ============================================================================
 * Mirrors, 1:1, the ENCODE contract in tools/atlas/atlas_to_arrow.mjs. That CLI
 * writes each JSON sector to Apache Arrow columnar IPC; this module decodes the
 * bytes back into raw row objects that are VALUE-EQUIVALENT (byte-identical on
 * JSON.stringify) to the objects `JSON.parse` yields today — so ingestStars()
 * cannot tell the two sources apart.
 *
 * Column contract (see the CLI header for the authoritative description):
 *   fmt Uint8 (0=Gaia,1=HYG) · id Int32 · ra/dec/mag Float64
 *   bp_rp/pm_ra/pm_dec/source_id Float64?(Gaia) · spect/proper Utf8?(HYG)
 *
 * HYBRID PRESERVATION: `fmt` is the explicit Gaia/HYG discriminator. Gaia rows
 * carry ra in DEGREES + mag_g + source_id; HYG rows carry ra in HOURS + mag +
 * optional spect/proper. The reconstructed key set + order matches the original
 * exactly (Gaia: id,ra,dec,mag_g,bp_rp,pm_ra,pm_dec,source_id — HYG: id,[proper],
 * ra,dec,mag,[spect]) so no downstream heuristic sees a difference.
 *
 * This decode still MATERIALIZES per-row objects (the honest drop-in path): its
 * win over JSON.parse is ~2x parse + ~44% smaller transfer, NOT the 60-900x that
 * column-native ingestion could reach. Realising that ceiling means teaching
 * ingestStars to read the typed-array columns directly — a separate, larger change.
 */
export function decodeArrowSector(ipcBytes: Uint8Array): any[] {
    const t = tableFromIPC(ipcBytes);

    // Zero-copy typed-array handles for the always-present columns.
    const fmt = (t.getChild('fmt') as any).data[0].values as Uint8Array;
    const id = (t.getChild('id') as any).data[0].values as Int32Array;
    const ra = (t.getChild('ra') as any).data[0].values as Float64Array;
    const dec = (t.getChild('dec') as any).data[0].values as Float64Array;
    const mag = (t.getChild('mag') as any).data[0].values as Float64Array;

    // Nullable columns — access element-wise via Vector.get (null-aware).
    const bp_rp = t.getChild('bp_rp')!;
    const pm_ra = t.getChild('pm_ra')!;
    const pm_dec = t.getChild('pm_dec')!;
    const source_id = t.getChild('source_id')!;
    const spect = t.getChild('spect')!;
    const proper = t.getChild('proper')!;

    const n = t.numRows;
    const out: any[] = new Array(n);
    for (let i = 0; i < n; i++) {
        if (fmt[i] === 0) {
            // Gaia — key order matches the shipped JSON exactly.
            out[i] = {
                id: id[i],
                ra: ra[i],
                dec: dec[i],
                mag_g: mag[i],
                bp_rp: bp_rp.get(i),
                pm_ra: pm_ra.get(i),
                pm_dec: pm_dec.get(i),
                source_id: source_id.get(i),
            };
        } else {
            // HYG — proper (if present) precedes ra; spect (if present) is last.
            const row: any = { id: id[i] };
            const p = proper.get(i);
            if (p !== null) row.proper = p;
            row.ra = ra[i];
            row.dec = dec[i];
            row.mag = mag[i];
            const s = spect.get(i);
            if (s !== null) row.spect = s;
            out[i] = row;
        }
    }
    return out;
}
