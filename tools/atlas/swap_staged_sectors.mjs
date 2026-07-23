// Atlas sector swap ceremony (orchestrator-driven): staged gap-filled sectors -> live.
// Refuses to touch the live tree unless EVERY pre-condition verifies:
//   1. backup dir exists with the full sector inventory
//   2. every live json matches the manifest's shipped_sha256 (live still pristine)
//   3. every staged json matches the manifest's staged_sha256
// Copy is per-file tmp+rename; post-swap every live json must hash to staged_sha256.
// Arrow twins ride along (hash recorded staged-side pre-copy, verified post-copy).
// Receipt -> test_results/atlas_swap_2026-07-11/swap_receipt.json
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const LIVE = path.join(REPO, 'public', 'atlas', 'sectors');
const STAGED_ROOT = 'D:/AstroLogic/atlas_staged_gaia_2026-07-11';
const STAGED = path.join(STAGED_ROOT, 'sectors');
const BACKUP = 'D:/AstroLogic/atlas_backup_2026-07-11/sectors';
const OUT_DIR = path.join(REPO, 'test_results', 'atlas_swap_2026-07-11');
const DRY = process.argv.includes('--dry-run');

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(STAGED_ROOT, 'staged_manifest.json'), 'utf8'));

const fail = (msg) => { console.error('ABORT (live tree untouched):', msg); process.exit(2); };

// ── pre-condition 1: backup inventory ────────────────────────────────────────
if (!fs.existsSync(BACKUP)) fail(`backup missing: ${BACKUP}`);
const backupN = fs.readdirSync(BACKUP).filter((f) => f.includes('level_3_sector_')).length;
if (backupN < 72) fail(`backup has ${backupN} sector files, expected >= 72`);

// ── pre-conditions 2+3: hash every live + staged file before any write ──────
const receipt = { ts: new Date().toISOString(), dry_run: DRY, sectors: [], arrow: [] };
for (const s of manifest.sectors) {
    const name = `level_3_sector_${s.id}.json`;
    const liveP = path.join(LIVE, name);
    const stagedP = path.join(STAGED, name);
    const liveHash = sha256(liveP);
    const stagedHash = sha256(stagedP);
    if (liveHash !== s.shipped_sha256) fail(`${name}: live != manifest shipped (live drifted?) ${liveHash}`);
    if (stagedHash !== s.staged_sha256) fail(`${name}: staged != manifest staged (staging corrupted?) ${stagedHash}`);
    receipt.sectors.push({ id: s.id, pre_live: liveHash, staged: stagedHash });
}
for (const s of manifest.sectors) {
    const name = `level_3_sector_${s.id}.arrow`;
    const stagedP = path.join(STAGED, name);
    if (!fs.existsSync(stagedP)) fail(`staged arrow twin missing: ${name}`);
    receipt.arrow.push({ id: s.id, pre_live: sha256(path.join(LIVE, name)), staged: sha256(stagedP) });
}
console.log(`pre-flight OK: ${receipt.sectors.length} json + ${receipt.arrow.length} arrow verified; backup ${backupN} files`);
if (DRY) { console.log('dry-run: stopping before copy'); process.exit(0); }

// ── swap: per-file tmp + rename ──────────────────────────────────────────────
const allFiles = [
    ...manifest.sectors.map((s) => `level_3_sector_${s.id}.json`),
    ...manifest.sectors.map((s) => `level_3_sector_${s.id}.arrow`),
];
for (const name of allFiles) {
    const tmp = path.join(LIVE, name + '.swaptmp');
    fs.copyFileSync(path.join(STAGED, name), tmp);
    fs.renameSync(tmp, path.join(LIVE, name));
}

// ── post-swap verify ─────────────────────────────────────────────────────────
let bad = 0;
for (const r of receipt.sectors) {
    const h = sha256(path.join(LIVE, `level_3_sector_${r.id}.json`));
    r.post_live = h;
    if (h !== r.staged) { bad++; console.error(`POST-MISMATCH json sector ${r.id}`); }
}
for (const r of receipt.arrow) {
    const h = sha256(path.join(LIVE, `level_3_sector_${r.id}.arrow`));
    r.post_live = h;
    if (h !== r.staged) { bad++; console.error(`POST-MISMATCH arrow sector ${r.id}`); }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'swap_receipt.json'), JSON.stringify(receipt, null, 2));
if (bad) { console.error(`SWAP COMPLETED WITH ${bad} MISMATCHES — restore from ${BACKUP}`); process.exit(2); }
console.log(`SWAP COMPLETE: ${allFiles.length} files live, all post-hashes match staged. Receipt: swap_receipt.json`);
console.log(`totals: shipped ${manifest.totals.shipped_rows} -> staged ${manifest.totals.staged_rows} rows (+${manifest.totals.new_gaia_rows} Gaia)`);
