#!/usr/bin/env node
// make_latest_json.mjs — author a Tauri v2 static updater manifest (latest.json).
// ============================================================================
// Required keys (v2 static/S3-friendly): version, platforms.<target>.{url,signature}.
// The signature is the VERBATIM contents of the `<installer>.sig` emitted by
// `createUpdaterArtifacts:true`. `url` is where the installer is served from.
//
// USAGE
//   node tools/release/make_latest_json.mjs \
//        --version 1.0.1 --setup <setup.exe> --sig <setup.exe.sig> \
//        --base-url https://host[/prefix] --out <latest.json> [--notes "..."]
// The installer URL is:  <base-url>/releases/<version>/<basename(setup)>
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const version = opt('version', null);
const setup = opt('setup', null);
const sig = opt('sig', null);
const baseUrl = opt('base-url', null);
const out = opt('out', null);
const notes = opt('notes', `SkyCruncher ${version}`);
const target = opt('target', 'windows-x86_64');

for (const [k, v] of Object.entries({ version, setup, sig, baseUrl, out })) {
  if (!v || v === true) { console.error(`make_latest_json: --${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} is required`); process.exit(1); }
}
if (!fs.existsSync(sig)) { console.error(`make_latest_json: sig not found: ${sig}`); process.exit(1); }
const signature = fs.readFileSync(sig, 'utf8').trim();
const setupName = path.basename(setup);
const url = `${baseUrl.replace(/\/$/, '')}/releases/${version}/${setupName}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: { [target]: { signature, url } },
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[latest.json] wrote ${out}: version ${version} -> ${url}`);
