// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/lib/env.mjs — resolve the fetched c2patool binary + DEV signing certs
// ═══════════════════════════════════════════════════════════════════════════
//
// The c2patool reference CLI and its bundled DEV test-signing certs are fetched
// (never committed — see tools/c2pa/.gitignore). Every c2pa lane script resolves
// them through here so there is exactly one place that knows the layout.
//
// The certs under bin/c2patool/sample/ (es256_certs.pem + es256_private.key) are
// the Content Authenticity Initiative's PUBLIC dev certs. They are NOT on any
// production C2PA trust list — a manifest signed with them is valid-and-parseable
// but flags as an untrusted signer. Everything this lane produces is DEV-CERT.
// The production-certificate story is a build-time decision (see README §Production).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LANE = path.resolve(HERE, '..');            // tools/c2pa
export const BIN = path.join(LANE, 'bin');
export const REPO_ROOT = path.resolve(LANE, '..', '..'); // worktree/repo root

// The Windows release extracts to bin/c2patool/c2patool.exe; other platforms drop
// a bare `c2patool`. Probe both so the same lib works cross-platform.
const CANDIDATES = [
  path.join(BIN, 'c2patool', 'c2patool.exe'),
  path.join(BIN, 'c2patool', 'c2patool'),
  path.join(BIN, 'c2patool.exe'),
  path.join(BIN, 'c2patool'),
];

const CERT_DIR = path.join(BIN, 'c2patool', 'sample');
export const DEV_SIGN_CERT = path.join(CERT_DIR, 'es256_certs.pem');
export const DEV_PRIVATE_KEY = path.join(CERT_DIR, 'es256_private.key');
export const DEV_SIGN_ALG = 'es256';

/** Absolute path to the c2patool executable, or null if not fetched yet. */
export function findC2paTool() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

/** True when both the tool and its DEV certs are present. */
export function toolchainReady() {
  return !!findC2paTool() && fs.existsSync(DEV_SIGN_CERT) && fs.existsSync(DEV_PRIVATE_KEY);
}

/** Loud, actionable failure when a script needs the tool but it is absent. */
export function requireC2paTool() {
  const tool = findC2paTool();
  if (!tool) {
    process.stderr.write(
      '[c2pa] c2patool not found under tools/c2pa/bin/.\n' +
      '       Fetch it first:  node tools/c2pa/fetch_c2patool.mjs\n' +
      '       (SIGNING-BLOCKED without it — manifest construction still works.)\n',
    );
    process.exit(3);
  }
  return tool;
}
