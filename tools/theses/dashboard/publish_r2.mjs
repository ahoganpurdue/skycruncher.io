#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/publish_r2.mjs — STUB for the future domain-hosted
// CSL thesis dashboard (R2/S3-compatible upload).
// ============================================================================
// STATUS: STUB — ZERO remote writes. Owner Cloudflare auth for a dashboard
// bucket is PENDING; until the owner rules + provides creds this tool only
// (a) parses args and (b) with --dry-run enumerates exactly what a real run
// WOULD upload. It never opens a network connection.
//
// FUTURE implementation pattern (do not reinvent): copy the SigV4 signer +
// put-object flow from tools/release/publish_app_release.mjs (itself copied
// from tools/starplates/publish_r2.mjs §7) — node:crypto only, no deps.
// Credentials via --env-file (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, optional R2_ENDPOINT) — values NEVER printed.
//
// LAYOUT (brand-neutral per LAW 6 — "theses"/"csl" naming, never app brands):
//   bucket:  $R2_BUCKET_THESES_DASHBOARD  (default "theses-dashboard")
//   keys:    csl/ui/<file>                       — the dashboard front-end
//            csl/data/thesis_dashboard_data.json — the snapshot (MUTABLE, no-cache)
//            csl/data/<other>.json               — other dashboard data files
//
// USAGE
//   node tools/theses/dashboard/publish_r2.mjs --dry-run
//   node tools/theses/dashboard/publish_r2.mjs [--bucket <name>] [--env-file <path>]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const UI_DIR = path.join(HERE, 'ui');
const DATA_DIR = path.join(ROOT, 'test_results', 'theses', 'dashboard');

// ---- args (same opt() idiom as tools/release/publish_app_release.mjs) -------
const argv = process.argv.slice(2);
function opt(name, def) {
    const i = argv.indexOf('--' + name);
    if (i === -1) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}
const DRY_RUN = argv.includes('--dry-run');
const BUCKET = String(opt('bucket', process.env.R2_BUCKET_THESES_DASHBOARD || 'theses-dashboard'));
const ENV_FILE = String(opt('env-file', 'src/engine/ui/dashboard/.env.r2'));

function walk(dir, base = dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(abs, base));
        else out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
    }
    return out;
}

function enumerateUploads() {
    const uploads = [];
    for (const f of walk(UI_DIR)) uploads.push({ key: `csl/ui/${f.rel}`, src: f.abs });
    for (const f of walk(DATA_DIR).filter((x) => x.rel.endsWith('.json'))) {
        uploads.push({ key: `csl/data/${f.rel}`, src: f.abs });
    }
    return uploads;
}

if (DRY_RUN) {
    const uploads = enumerateUploads();
    console.log(`[publish-stub] DRY RUN — would upload ${uploads.length} object(s) to bucket "${BUCKET}" (NO remote writes performed):`);
    let total = 0;
    for (const u of uploads) {
        const size = fs.statSync(u.src).size;
        total += size;
        console.log(`  PUT ${BUCKET}/${u.key}  <-  ${path.relative(ROOT, u.src)}  (${size.toLocaleString()} B)`);
    }
    if (uploads.length === 0) {
        console.log('  (nothing to upload yet: ui/ not built and/or no snapshot generated — run snapshot.mjs first)');
    }
    console.log(`[publish-stub] total ${total.toLocaleString()} B · env-file would be ${ENV_FILE} (not read in dry-run)`);
    console.log('[publish-stub] real uploads remain BLOCKED: owner Cloudflare auth pending.');
    process.exit(0);
}

console.error('[publish-stub] NOT IMPLEMENTED: owner Cloudflare auth pending for the theses-dashboard bucket.');
console.error('[publish-stub] This stub performs ZERO remote writes. Use --dry-run to preview what a real run would upload.');
console.error('[publish-stub] When authorized: implement via the SigV4 pattern in tools/release/publish_app_release.mjs.');
process.exit(2);
