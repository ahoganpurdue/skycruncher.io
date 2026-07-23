/**
 * B1 — CR2 ground-truth inspector (ROADMAP Phase B).
 *
 * Dumps the identity-pinning EXIF fields of a Canon CR2 (or any RAW exifr
 * can parse): camera body, lens, focal length, exposure triangle, capture
 * time, GPS, and pixel dimensions. This is the ground truth for the bundled
 * sample — its "M42" label is suspect (June 2019 frame; M42 is a winter
 * target), so nothing downstream may assume the label is honest.
 *
 * Usage:
 *   node tools/dslr/inspect_cr2_exif.mjs                 # bundled sample
 *   node tools/dslr/inspect_cr2_exif.mjs path/to/img.cr2 [more.cr2 ...]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(__dirname, '../../public/demo/sample_observation.cr2');

const targets = process.argv.length > 2 ? process.argv.slice(2) : [DEFAULT_TARGET];

/** Render a value honestly: no fake numbers, `--` for absent data. */
function show(v) {
    if (v === undefined || v === null) return '--';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return String(v);
}

let hadError = false;

for (const target of targets) {
    const abs = path.resolve(target);
    console.log(`\n=== ${abs} ===`);
    try {
        const buffer = await readFile(abs);

        // Full TIFF/EXIF/GPS parse. CR2 is TIFF-based; exifr reads IFD0 +
        // the Exif SubIFD + GPS IFD without decoding the raw mosaic.
        const tags = await exifr.parse(buffer, {
            tiff: true, ifd0: true, exif: true, gps: true,
            translateValues: true, reviveValues: true
        }) ?? {};
        const gps = await exifr.gps(buffer).catch(() => null);

        const exposure = tags.ExposureTime;
        const exposureStr = exposure === undefined ? '--'
            : exposure >= 1 ? `${show(exposure)} s`
            : `1/${Math.round(1 / exposure)} s (${show(exposure)} s)`;

        const rows = [
            ['Make',              show(tags.Make)],
            ['Model',             show(tags.Model)],
            ['LensModel',         show(tags.LensModel)],
            ['FocalLength',       tags.FocalLength !== undefined ? `${show(tags.FocalLength)} mm` : '--'],
            ['FNumber',           tags.FNumber !== undefined ? `f/${show(tags.FNumber)}` : '--'],
            ['ISO',               show(tags.ISO)],
            ['ExposureTime',      exposureStr],
            ['DateTimeOriginal',  show(tags.DateTimeOriginal)],
            ['GPS',               gps && gps.latitude !== undefined
                                      ? `lat ${show(gps.latitude)}, lon ${show(gps.longitude)}`
                                      : '-- (no GPS IFD)'],
            // IFD0 dims on a CR2 describe the embedded preview; the Exif
            // SubIFD PixelX/YDimension carry the full-resolution frame.
            ['ImageWidth (IFD0)',   show(tags.ImageWidth)],
            ['ImageHeight (IFD0)',  show(tags.ImageHeight)],
            ['ExifImageWidth',      show(tags.ExifImageWidth)],
            ['ExifImageHeight',     show(tags.ExifImageHeight)],
        ];

        const pad = Math.max(...rows.map(([k]) => k.length));
        for (const [k, v] of rows) console.log(`  ${k.padEnd(pad)}  ${v}`);
    } catch (err) {
        hadError = true;
        console.error(`  ERROR: ${err?.message ?? err}`);
    }
}

if (hadError) process.exitCode = 1;
