// tools/atlas/setup_staged_public.mjs
// Build a staged `public/` tree so the headless driver's makeFsAtlasLoader can
// resolve `/atlas/...` against it: anchors copied UNCHANGED (gap-fill touches
// only sectors), sectors JUNCTIONED to the staged gap-filled json (NO .arrow
// twins -> forces the JSON read path). Live repo untouched.
import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const liveAtlas = path.join(repoRoot, 'public', 'atlas');
const stagedRoot = 'D:/AstroLogic/atlas_staged_gaia_2026-07-11';
const pubAtlas = path.join(stagedRoot, 'public', 'atlas');
fs.mkdirSync(pubAtlas, { recursive: true });

for (const f of ['level_1_anchors.json', 'level_2_pattern.json']) {
    fs.copyFileSync(path.join(liveAtlas, f), path.join(pubAtlas, f));
    console.log('copied', f, fs.statSync(path.join(pubAtlas, f)).size + 'B');
}

const link = path.join(pubAtlas, 'sectors');
const target = path.join(stagedRoot, 'sectors');
if (fs.existsSync(link)) {
    try { cp.execSync(`cmd /c rmdir "${link.replace(/\//g, '\\')}"`); } catch { /* not a junction */ }
}
cp.execSync(`cmd /c mklink /J "${link.replace(/\//g, '\\')}" "${target.replace(/\//g, '\\')}"`);
console.log('junction:', link, '->', target);

const s0 = path.join(link, 'level_3_sector_0.json');
console.log('sector0 via junction:', fs.existsSync(s0) ? fs.statSync(s0).size + 'B' : 'MISSING');
console.log('sector0 .arrow present (must be false):', fs.existsSync(path.join(link, 'level_3_sector_0.arrow')));
console.log('STAGED atlasRoot =', path.join(stagedRoot, 'public'));
