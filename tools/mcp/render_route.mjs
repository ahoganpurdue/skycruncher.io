// ═══════════════════════════════════════════════════════════════════════════
// /renders ROUTE — pure, unit-testable logic (zero-dep: node:path + node:url)
// ═══════════════════════════════════════════════════════════════════════════
//
// PURPOSE
//   render_widget writes a self-contained PNG (+ HTML twin) under
//   test_results/mcp_renders/. claude.ai buries MCP-result images in the
//   collapsed tool-Result block, so the user can't view/interact with them. The
//   remote server (tools/mcp/remote_server.mjs) therefore serves that dir at
//   GET /renders/<basename> and every render carries a user-clickable view_url.
//
//   This module holds the PURE decisions the route makes — basename sanitization,
//   the auth-mode mirror, and view-URL construction — SEPARATE from the shebang'd
//   server entry points so they import cleanly under the main vitest battery
//   (exactly like access_jwt.mjs). remote_server.mjs + server.mjs import from here;
//   render_route.test.mjs tests these functions directly. No network, no HTTP.
//
// SECURITY POSTURE (fail closed everywhere)
//   • STRICT single-basename allow-list (^[A-Za-z0-9._-]+\.(png|html)$), decoded
//     first so encoded traversal (%2e%2e / %2f) is caught, then containment-checked
//     against the resolved renders dir. Rejects separators, backslashes, '..',
//     wrong/missing extensions, empties. NEVER lists the directory.
//   • Auth MIRRORS the server's active MCP auth mode (owner ruling 2026-07-16):
//     access mode → static bearer OR a verified Cloudflare Access JWT (the header
//     the edge stamps after login — same trust chain as the MCP endpoint);
//     bearer cold path → static bearer OR a localhost origin.
// ═══════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// The stdio server writes render artifacts here; the route serves them read-only.
export const RENDERS_DIR = path.join(ROOT, 'test_results', 'mcp_renders');
export const RENDER_NAME_RE = /^[A-Za-z0-9._-]+\.(png|html)$/; // single safe basename only

// STRICT basename sanitizer. Returns { name, resolved, ext, mime } for a safe
// .png/.html basename that resolves INSIDE RENDERS_DIR, else null. rendersDir is
// injectable for tests; defaults to the canonical dir.
export function sanitizeRenderName(raw, rendersDir = RENDERS_DIR) {
  if (typeof raw !== 'string' || !raw) return null;
  let name;
  try { name = decodeURIComponent(raw); } catch { return null; } // malformed %-seq → closed
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const m = RENDER_NAME_RE.exec(name);
  if (!m) return null;
  const resolved = path.resolve(rendersDir, name);
  const dirWithSep = rendersDir.endsWith(path.sep) ? rendersDir : rendersDir + path.sep;
  if (!resolved.startsWith(dirWithSep)) return null; // belt-and-suspenders containment
  const ext = m[1].toLowerCase();
  return { name, resolved, ext, mime: ext === 'png' ? 'image/png' : 'text/html; charset=utf-8' };
}

// Pure auth-mode mirror. access → bearer|Access-JWT; bearer cold path →
// bearer|localhost. FAILS CLOSED. (The server computes the four booleans from the
// live request/CFG and calls this.)
export function renderRouteAuthPlan({ authMode, bearerValid, accessValid, isLocalhost }) {
  if (bearerValid) return true;                    // static bearer works in either mode
  if (authMode === 'access') return !!accessValid; // mirror MCP: bearer OR Access JWT
  return !!isLocalhost;                            // bearer cold path: bearer OR localhost
}

// User-clickable, Access-gated HTTPS links to a render's artifacts. Base is
// LAW-6-neutral + env-overridable; read at call time so tests/operators can point
// it at any origin. Trailing slashes stripped.
export function publicRenderBaseUrl() {
  return (process.env.REMOTE_MCP_PUBLIC_URL || 'https://mcp.skycruncher.io').replace(/\/+$/, '');
}
export function renderViewUrls(pngBasename, htmlBasename) {
  const base = publicRenderBaseUrl();
  const out = { view_url: `${base}/renders/${pngBasename}` };
  if (htmlBasename) out.html_view_url = `${base}/renders/${htmlBasename}`;
  return out;
}
