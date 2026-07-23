// Re-bucket the deep Gaia Level-3 sector files so their numeric ids match
// star_catalog_adapter.getSectorId(): raIndex = floor(ra_hours/4) (0-5),
// decIndex = floor((dec+90)/30) (0-5), id = decIndex*6 + raIndex.
// The existing numeric files mix at least three inconsistent generations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', 'public/atlas/sectors');
const outDir = path.join(dir, '_rebuilt');
fs.mkdirSync(outDir, { recursive: true });

const buckets = Array.from({ length: 36 }, () => []);
const seen = Array.from({ length: 36 }, () => new Set());
let total = 0, dupes = 0, skipped = 0;

const files = fs.readdirSync(dir).filter(f => /^level_3_sector_\d+\.json$/.test(f));
console.log(`Reading ${files.length} numeric sector files...`);

for (const f of files) {
    const stars = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const s of stars) {
        // Gaia format: ra in DEGREES
        if (!Number.isFinite(s.ra) || !Number.isFinite(s.dec) || !Number.isFinite(s.mag_g)) { skipped++; continue; }
        const raH = ((s.ra / 15) % 24 + 24) % 24;
        const raIndex = Math.min(5, Math.floor(raH / 4));
        const decIndex = Math.min(5, Math.floor((Math.max(-90, Math.min(90, s.dec)) + 90) / 30));
        const id = decIndex * 6 + raIndex;
        const key = s.source_id ?? `${s.ra},${s.dec}`;
        if (seen[id].has(key)) { dupes++; continue; }
        seen[id].add(key);
        buckets[id].push(JSON.stringify(s));
        total++;
    }
    console.log(`  ${f}: cumulative ${total} stars`);
}

for (let id = 0; id < 36; id++) {
    const p = path.join(outDir, `level_3_sector_${id}.json`);
    fs.writeFileSync(p, '[\n' + buckets[id].join(',\n') + '\n]');
    console.log(`sector ${id}: ${buckets[id].length} stars`);
}
console.log(`Done. total=${total} dupes=${dupes} skipped=${skipped}`);
