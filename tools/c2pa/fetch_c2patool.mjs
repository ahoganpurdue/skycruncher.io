#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/fetch_c2patool.mjs — provision the C2PA reference CLI (gitignored)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/fetch_c2patool.mjs
//
// Downloads the Content Authenticity Initiative's official c2patool release for
// the current platform into tools/c2pa/bin/ and extracts it. The binary AND its
// bundled DEV test-signing certs (bin/c2patool/sample/) are gitignored — this
// script is the committed, reproducible way to restore them.
//
// The tool ships PUBLIC dev certs (es256_certs.pem + es256_private.key) that are
// NOT on any production trust list. Everything this lane signs with them is
// explicitly DEV-CERT (see README §Production for the real-cert story).
//
// Acquisition record (this repo, 2026-07-09): PATH? no · GitHub release binary?
// YES (path used) · WSL cargo install? not needed · build-only fallback? n/a.
// Pinned version below; bump deliberately.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BIN, findC2paTool } from './lib/env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 'v0.9.12';
const BASE = `https://github.com/contentauth/c2patool/releases/download/${VERSION}`;

// Platform → release asset. The CAI publishes per-target archives; we pick by
// process.platform/arch and unpack with the OS's native archiver.
function assetForPlatform() {
  const p = process.platform;
  if (p === 'win32') return { name: `c2patool-${VERSION}-x86_64-pc-windows-msvc.zip`, kind: 'zip' };
  if (p === 'darwin') return { name: `c2patool-${VERSION}-universal-apple-darwin.zip`, kind: 'zip' };
  if (p === 'linux') return { name: `c2patool-${VERSION}-x86_64-unknown-linux-gnu.tar.gz`, kind: 'tar' };
  throw new Error(`unsupported platform: ${p}`);
}

function download(url, dest) {
  // curl is present on Windows (git-bash / system), macOS, and Linux. Use it
  // rather than fetch() so redirects + TLS are handled the same everywhere.
  const r = spawnSync('curl', ['-sL', '--max-time', '180', '-o', dest, url], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    throw new Error(`download failed for ${url} (curl exit ${r.status})`);
  }
}

function extract(archive, kind, into) {
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${archive}' -DestinationPath '${into}' -Force`], { encoding: 'utf8' });
      if (ps.status !== 0) throw new Error(`Expand-Archive failed: ${ps.stderr}`);
    } else {
      const r = spawnSync('unzip', ['-o', archive, '-d', into], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr}`);
    }
  } else {
    const r = spawnSync('tar', ['-xzf', archive, '-C', into], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  }
}

function main() {
  if (findC2paTool()) {
    process.stdout.write(`[c2pa] already present: ${findC2paTool()}\n`);
    return;
  }
  fs.mkdirSync(BIN, { recursive: true });
  const asset = assetForPlatform();
  const url = `${BASE}/${asset.name}`;
  const archive = path.join(BIN, asset.name);
  process.stdout.write(`[c2pa] fetching ${asset.name} …\n`);
  download(url, archive);
  process.stdout.write('[c2pa] extracting …\n');
  extract(archive, asset.kind, BIN);
  const tool = findC2paTool();
  if (!tool) throw new Error('extracted, but c2patool binary not found — layout changed?');
  const v = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  process.stdout.write(`[c2pa] ready: ${tool}\n[c2pa] ${(v.stdout || v.stderr || '').trim()}\n`);
}

try { main(); }
catch (e) { process.stderr.write(`[c2pa] fetch failed: ${e.message}\n`); process.exit(1); }
