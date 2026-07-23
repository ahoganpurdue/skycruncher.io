// Atlas sector RESTORE (revert of the 2026-07-11 gap-fill swap, per LAW:
// pinned-reference break = revert, no exceptions — SeeStar anchors moved).
// Verifies every backup file's sha256 against the swap receipt's pre_live
// hash BEFORE copying; aborts untouched on any mismatch; re-verifies after.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const LIVE = path.join(REPO, 'public', 'atlas', 'sectors');
const BACKUP = 'D:/AstroLogic/atlas_backup_2026-07-11/sectors';
const RECEIPT = path.join(REPO, 'test_results', 'atlas_swap_2026-07-11', 'swap_receipt.json');

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
const fail = (msg) => { console.error('ABORT (live tree untouched):', msg); process.exit(2); };

const plan = [
    ...receipt.sectors.map((r) => ({ name: `level_3_sector_${r.id}.json`, want: r.pre_live })),
    ...receipt.arrow.map((r) => ({ name: `level_3_sector_${r.id}.arrow`, want: r.pre_live })),
];

// pre-flight: every backup file must hash to the receipt's pre-swap value
for (const f of plan) {
    const h = sha256(path.join(BACKUP, f.name));
    if (h !== f.want) fail(`${f.name}: backup hash != receipt pre_live (${h})`);
}
console.log(`pre-flight OK: ${plan.length} backup files match the receipt's pre-swap hashes`);

// restore: per-file tmp + rename
for (const f of plan) {
    const tmp = path.join(LIVE, f.name + '.restoretmp');
    fs.copyFileSync(path.join(BACKUP, f.name), tmp);
    fs.renameSync(tmp, path.join(LIVE, f.name));
}

// post-verify
let bad = 0;
for (const f of plan) {
    if (sha256(path.join(LIVE, f.name)) !== f.want) { bad++; console.error(`POST-MISMATCH ${f.name}`); }
}
if (bad) { console.error(`RESTORE FINISHED WITH ${bad} MISMATCHES — investigate before any solve`); process.exit(2); }
console.log(`RESTORE COMPLETE: ${plan.length} files back to pre-swap bytes (pinned baseline).`);
