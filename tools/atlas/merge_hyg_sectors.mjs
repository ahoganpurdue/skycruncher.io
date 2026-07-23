// tools/atlas/merge_hyg_sectors.mjs
// ═══════════════════════════════════════════════════════════════════════════
// HYG GAP-FILL MERGE — the missing chain link (step 1, atlas reproduce-first)
// ═══════════════════════════════════════════════════════════════════════════
//
// The shipped deep-catalog sectors (public/atlas/sectors/level_3_sector_0..35.json)
// are Gaia rows (mag >= 10, produced by generate_star_atlas.ts -> rebucket_sectors.mjs)
// with a block of HYG stars (mag > 6.8) APPENDED after the Gaia block, per sector.
// That HYG-merge step was a one-off that was NEVER committed (glob tools/**/*hyg*
// was empty). This file reconstructs it to the rule TRANSCRIBED + byte-VERIFIED in
// test_results/atlas_rebuild_2026-07-11/LAYOUT_TRANSCRIPTION.md sections 1b/1c/4.
//
// THE RULE (all clauses byte-verified against the shipped sectors, 36/36):
//   - Source: the 36 NAMED HYG cell files sector_RA{a}-{b}_DEC{lo}_to_{hi}.json
//     (full HYG per 6x6 cell; ra in HOURS; keys id,[proper],ra,dec,mag,[spect]).
//   - Cell -> numeric sector: raIndex = a/4 (a in {0,4,8,12,16,20}),
//     decIndex = (lo+90)/30 (lo in {-90,-60,-30,0,30,60}), sectorId = decIndex*6 + raIndex.
//   - Filter: STRICT mag > 6.8 (min observed in-file that survives = 6.81; the faint
//     end reaches mag ~= 21 globally -- FAR deeper than tools/atlas/README's stale
//     "6.8-10" claim). No dedup vs Gaia; HYG rows are appended WHOLESALE.
//   - Order: HYG rows keep their NAMED-FILE order (which is already mag-ascending);
//     they are appended CONTIGUOUSLY after all Gaia rows.
//   - Serialization: minified, one object per line --
//     '[' + [...gaiaRowStrings, ...hygRowStrings].join(',\n') + ']'  (LF, no outer
//     newline after '[' or before ']'). Each HYG row = JSON.stringify(namedRow)
//     AS-IS (presence-preserving: proper/spect omitted when absent; no re-key, no
//     rounding). This is the EXACT byte format of the shipped minified sectors.
//
// SCOPE: this tool ONLY appends HYG rows. It never removes/retires HYG or Gaia rows
// (gap-fill program is ADDITIVE -- LAYOUT_TRANSCRIPTION section 3). It never writes
// over the live public/atlas/sectors (caller supplies an out dir).
//
// Usage (CLI, disk->disk):
//   node tools/atlas/merge_hyg_sectors.mjs --rebuilt <gaiaOnlySectorsDir> \
//        --named <namedHygCellsDir> --out <outDir> [--threshold 6.8]
// Usage (library): import { namedFileForSector, filterHygRows, serializeSector,
//   mergeHygIntoSectors } -- used by tools/atlas/verify_atlas_repro.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HYG_MAG_THRESHOLD = 6.8; // STRICT >; see rule above.
export const SECTOR_COUNT = 36;

/**
 * Numeric sector id (0..35) -> the named HYG cell filename that feeds it.
 * Inverse of getSectorId: raIndex = id % 6, decIndex = floor(id / 6).
 */
export function namedFileForSector(id) {
    const raIndex = id % 6;
    const decIndex = (id - raIndex) / 6;
    const a = raIndex * 4;
    const b = a + 4;
    const lo = decIndex * 30 - 90;
    const hi = lo + 30;
    return `sector_RA${a}-${b}_DEC${lo}_to_${hi}.json`;
}

/** Rows of a named cell with STRICT mag > threshold, preserving file order. */
export function filterHygRows(rows, threshold = HYG_MAG_THRESHOLD) {
    return rows.filter((r) => r.mag > threshold);
}

/**
 * Assemble the exact shipped-sector byte text from already-serialized Gaia row
 * strings + HYG row objects (HYG stringified AS-IS, appended contiguously).
 */
export function serializeSector(gaiaRowStrings, hygRows) {
    const hygStrings = hygRows.map((r) => JSON.stringify(r));
    return '[' + gaiaRowStrings.concat(hygStrings).join(',\n') + ']';
}

/** Load + filter the HYG rows for one sector from a named-cells dir (missing -> []). */
export function hygRowsForSector(namedDir, id, threshold = HYG_MAG_THRESHOLD) {
    const p = path.join(namedDir, namedFileForSector(id));
    if (!fs.existsSync(p)) return [];
    return filterHygRows(JSON.parse(fs.readFileSync(p, 'utf8')), threshold);
}

/**
 * Disk->disk merge: for each sector, read the Gaia-only rebuilt file, append the
 * matching HYG cell's mag>threshold rows, write the merged sector to outDir.
 * Returns a per-sector count summary.
 */
export function mergeHygIntoSectors({ rebuiltDir, namedDir, outDir, threshold = HYG_MAG_THRESHOLD }) {
    fs.mkdirSync(outDir, { recursive: true });
    const summary = [];
    for (let id = 0; id < SECTOR_COUNT; id++) {
        const gaiaPath = path.join(rebuiltDir, `level_3_sector_${id}.json`);
        // rebucket_sectors.mjs emits Gaia-only sectors; re-serialize each row so the
        // byte text is canonical regardless of the source file's whitespace.
        const gaiaRows = JSON.parse(fs.readFileSync(gaiaPath, 'utf8'));
        const gaiaRowStrings = gaiaRows.map((r) => JSON.stringify(r));
        const hygRows = hygRowsForSector(namedDir, id, threshold);
        fs.writeFileSync(path.join(outDir, `level_3_sector_${id}.json`), serializeSector(gaiaRowStrings, hygRows));
        summary.push({ id, gaia: gaiaRowStrings.length, hyg: hygRows.length, total: gaiaRowStrings.length + hygRows.length });
    }
    return summary;
}

// ─── CLI ──────────────────────────────────────────────────────────────────
function main() {
    const argv = process.argv.slice(2);
    const val = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : null;
    };
    const rebuiltDir = val('--rebuilt');
    const namedDir = val('--named');
    const outDir = val('--out');
    const threshold = val('--threshold') ? Number(val('--threshold')) : HYG_MAG_THRESHOLD;
    if (!rebuiltDir || !namedDir || !outDir) {
        console.error('usage: node merge_hyg_sectors.mjs --rebuilt <dir> --named <dir> --out <dir> [--threshold 6.8]');
        process.exit(2);
    }
    const summary = mergeHygIntoSectors({ rebuiltDir, namedDir, outDir, threshold });
    let g = 0, h = 0;
    for (const s of summary) { g += s.gaia; h += s.hyg; console.log(`sector ${s.id}: gaia=${s.gaia} hyg=${s.hyg} total=${s.total}`); }
    console.log(`Done. threshold>${threshold}  total gaia=${g} hyg=${h} grand=${g + h}`);
}

// Run as CLI only when invoked directly (never when imported by the harness).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
