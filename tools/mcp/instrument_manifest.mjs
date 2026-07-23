// ═══════════════════════════════════════════════════════════════════════════
// tools/mcp/instrument_manifest.mjs — the NODE view of the unified version manifest
// ═══════════════════════════════════════════════════════════════════════════
//
// A plain .mjs cannot import the TS view (src/engine/versions/manifest.ts), so
// the dep-free MCP server (server.mjs) reads the SAME single-source seam here:
//   • structure + manifest-owned numbers ← src/engine/versions/surfaces.json
//   • receipt_schema version             ← RECEIPT_SCHEMA_VERSION (schema_versions.ts, regex read of the real home)
//   • desktop_app version                ← package.json "version"
// The TS manifest resolves receipt/desktop from the IDENTICAL homes, so the two
// views are the same object by construction (asserted in the test suites).
//
// ZERO dependencies (fs/path/url only) so `node tools/mcp/server.mjs` stays
// offline-safe and Node-only. Honest-or-absent: an unreadable seam yields an
// empty manifest with a note, never a crash and never a fabricated number.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SURFACES_JSON = path.join(ROOT, 'src', 'engine', 'versions', 'surfaces.json');
const SCHEMA_VERSIONS_TS = path.join(ROOT, 'src', 'engine', 'pipeline', 'stages', 'schema_versions.ts');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const UNRESOLVED = 'UNRESOLVED';

/** Read RECEIPT_SCHEMA_VERSION from its real home (the single source), by regex. */
function readReceiptVersion() {
  try {
    const txt = fs.readFileSync(SCHEMA_VERSIONS_TS, 'utf8');
    const m = txt.match(/RECEIPT_SCHEMA_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : UNRESOLVED;
  } catch {
    return UNRESOLVED;
  }
}

/** Read the desktop app version from package.json (the real home). */
function readPkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version ?? UNRESOLVED;
  } catch {
    return UNRESOLVED;
  }
}

function resolveRef(ref) {
  switch (ref) {
    case 'schema_versions:RECEIPT_SCHEMA_VERSION': return readReceiptVersion();
    case 'package.json:version': return readPkgVersion();
    default: return UNRESOLVED;
  }
}

/**
 * Build the resolved version manifest: { surfaces: [{surface, version,
 * changelogAnchor, schemaTag?}], mcpTools: {name: version} }. Deterministic;
 * honest-or-absent when the seam is missing.
 */
export function buildVersionManifest() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SURFACES_JSON, 'utf8'));
  } catch {
    return { surfaces: [], mcpTools: {}, note: `version manifest unavailable — could not read ${path.relative(ROOT, SURFACES_JSON)}` };
  }
  const surfaces = (data.surfaces || []).map((s) => {
    const version = (s.version !== undefined && s.version !== null) ? s.version : resolveRef(s.ref);
    const entry = { surface: s.surface, version, changelogAnchor: s.changelogAnchor };
    if (s.schemaTag) entry.schemaTag = s.schemaTag;
    return entry;
  });
  return { surfaces, mcpTools: { ...(data.mcpTools || {}) } };
}

/** Convenience: look up one surface's resolved version (or null). */
export function getSurfaceVersion(name) {
  return buildVersionManifest().surfaces.find((s) => s.surface === name)?.version ?? null;
}
