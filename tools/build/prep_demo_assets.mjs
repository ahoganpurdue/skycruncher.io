#!/usr/bin/env node
/**
 * prep_demo_assets.mjs — pre-build demo-asset stager (PURE-D mechanism).
 *
 * WHAT / WHY
 *   The booth demo ("Load Sample") fetches bundled binaries from /demo/*. Those
 *   binaries are gitignored (large: ~47.5MB FIT + ~21.6MB CR2) and never enter
 *   git. This script copies the PINNED demo assets from canonical D:\ storage
 *   into public/demo/ BEFORE a build so vite (public/ -> dist/) and tauri
 *   (frontendDist bundles dist/) ship them into the offline desktop app.
 *   Adjudicated: test_results/owner_proxy_2026-07-10_late/ADJUDICATION_PACKAGE.md
 *   Decision 2 -> "PURE D FOR THE v1.0.1 BOOTH BUILD" (R2 asset plane = post-event).
 *
 * HOW TO RUN
 *   npm run prep:demo         # standalone
 *   npm run build             # runs prep:demo first (chained), so:
 *   npm run tauri:build       # tauri beforeBuildCommand -> npm run build -> prep:demo
 *
 * IMPORTANT
 *   - public/demo/ STAYS gitignored. The copies written here are TRANSIENT BUILD
 *     INPUT (vite copies them to dist/demo; tauri bundles dist via frontendDist).
 *     The committed artifact is THIS script; the binaries never enter git.
 *   - Sources resolve THROUGH the repo's "Sample Files" junction, which chains to
 *     D:\AstroLogic\SampleFiles (storage law: K: is a thin VHD, canonical binaries
 *     live on D:). Never store new large binaries on K: outside this build step.
 *   - Idempotent: an asset already present at its destination with a matching hash
 *     is left untouched (no copy).
 *   - Fails LOUD if a source is missing or a post-copy hash mismatches. The build
 *     must NOT silently produce a demo-less (or wrong-asset) bundle (honest-or-absent).
 *
 * The SHA-256 constants below PIN THE DEMO ASSETS ONLY. They are content
 * fingerprints for demo binaries — NOT a calibrated solver gate, sigma, or any
 * value in docs/GATES.md. Updating them only re-pins which demo file ships.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const JUNCTION = join(REPO_ROOT, 'Sample Files'); // -> D:\AstroLogic\SampleFiles
const DEMO_DIR = join(REPO_ROOT, 'public', 'demo');

/**
 * Pinned demo assets. `src` is relative to the "Sample Files" junction; `dest`
 * is relative to public/demo/. `sha256` pins the DEMO binary (not a gate).
 */
const ASSETS = [
  {
    label: 'SeeStar M66 stack (FITS)',
    src: 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit',
    dest: 'seestar_m66_sample.fit',
    sha256: '85aaed5d3df268f83a427909a8b160e872c05447102d65424bc90308a8e54e32',
    bytes: 49772160,
  },
  {
    label: 'Beach first-light frame (CR2)',
    src: 'sample_observation.cr2',
    dest: 'sample_observation.cr2',
    sha256: 'bb3222e797258a7ecc971fb62961edd2bc2e886cc34f67dea7849e70f18e77b0',
    bytes: 22672099,
  },
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function die(msg) {
  console.error(`\n[prep:demo] FATAL: ${msg}\n`);
  process.exit(1);
}

console.log('[prep:demo] staging demo assets -> public/demo/');
console.log(`[prep:demo] source junction: ${JUNCTION}`);

if (!existsSync(JUNCTION)) {
  die(`"Sample Files" junction not found at ${JUNCTION}. It must chain to `
    + `D:\\SkyCruncher\\SampleFiles (storage law). Restore the junction before building.`);
}

mkdirSync(DEMO_DIR, { recursive: true });

let copied = 0;
let skipped = 0;
for (const a of ASSETS) {
  const srcPath = join(JUNCTION, a.src);
  const destPath = join(DEMO_DIR, a.dest);

  // Idempotent: already staged with the pinned hash -> leave it.
  if (existsSync(destPath) && sha256(destPath) === a.sha256) {
    console.log(`[prep:demo] OK (present, hash-matched): ${a.dest}`);
    skipped++;
    continue;
  }

  if (!existsSync(srcPath)) {
    die(`source missing for ${a.label}: ${srcPath}\n`
      + `       Expected the pinned demo asset in canonical D:\\ storage via the `
      + `"Sample Files" junction. The build cannot ship a demo-less bundle.`);
  }

  const srcBytes = statSync(srcPath).size;
  if (srcBytes !== a.bytes) {
    die(`size mismatch for ${a.label}: ${srcPath}\n`
      + `       expected ${a.bytes} bytes, source is ${srcBytes}. Wrong/updated asset — `
      + `re-pin sha256+bytes deliberately if this is intended.`);
  }

  copyFileSync(srcPath, destPath);
  const got = sha256(destPath);
  if (got !== a.sha256) {
    die(`hash mismatch AFTER copy for ${a.label}: ${a.dest}\n`
      + `       expected ${a.sha256}\n       got      ${got}`);
  }
  console.log(`[prep:demo] copied + verified: ${a.src} -> ${a.dest} (${a.bytes} bytes)`);
  copied++;
}

console.log(`[prep:demo] done — ${copied} copied, ${skipped} already present.`);
