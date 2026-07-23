
import exifr from 'exifr';
import fs from 'fs/promises';
import path from 'path';

async function diagnose() {
    const rawPath = '<path-to-a-local-CR2>';
    console.log(`Diagnostic for: ${rawPath}`);

    try {
        const buffer = await fs.readFile(rawPath);
        console.log(`File size: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

        // 1. Get Metadata
        const metadata = await exifr.parse(buffer);
        console.log('--- EXIF Metadata ---');
        console.log(`Make: ${metadata.Make}`);
        console.log(`Model: ${metadata.Model}`);
        console.log(`Focal Length: ${metadata.FocalLength}mm`);
        console.log(`Exposure Time: ${metadata.ExposureTime}s`);
        console.log(`ISO: ${metadata.ISO}`);
        console.log(`Timestamp: ${metadata.DateTimeOriginal}`);

        // 2. Try Thumbnail
        const thumb = await exifr.thumbnail(buffer);
        if (thumb) {
            console.log('--- Thumbnail Detected ---');
            console.log(`Thumbnail size: ${(thumb.byteLength / 1024).toFixed(2)} KB`);
        } else {
            console.log('--- No Thumbnail Found ---');
        }

    } catch (err) {
        console.error('Diagnostic error:', err);
    }
}

diagnose();

