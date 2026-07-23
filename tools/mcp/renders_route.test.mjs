// Tests for the /renders route logic (user-clickable render view URLs) + the
// view_url shape emitted by render_widget. Mirrors the tools/mcp vitest pattern
// (access_jwt.test.mjs): pure, offline, node-only, under the main vitest battery.
//
// The route's decisions live in the shebang-less render_route.mjs (server.mjs /
// remote_server.mjs carry a `#!/usr/bin/env node` shebang and are run as process
// entry points, never import-transformed by vitest). remote_server.mjs wires
// these into GET /renders: sanitizeRenderName()===null → 404, rendersAuthorized()
// (renderRouteAuthPlan) false → 401. render_widget spreads renderViewUrls() into
// its result stats (both return_image modes).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeRenderName,
  renderRouteAuthPlan,
  renderViewUrls,
  publicRenderBaseUrl,
  RENDERS_DIR,
} from './render_route.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── STRICT basename allow-list (a null return is what the route turns into 404) ──
describe('sanitizeRenderName — STRICT basename allow-list (→ 404 on null)', () => {
  it('accepts a plain .png basename (image/png) and resolves inside RENDERS_DIR', () => {
    const p = sanitizeRenderName('widget_star-labels.png');
    expect(p).toBeTruthy();
    expect(p.mime).toBe('image/png');
    expect(p.resolved.startsWith(RENDERS_DIR + path.sep)).toBe(true);
    expect(path.basename(p.resolved)).toBe('widget_star-labels.png');
  });

  it('accepts a plain .html basename (text/html)', () => {
    const h = sanitizeRenderName('flowchart.html');
    expect(h).toBeTruthy();
    expect(h.mime).toBe('text/html; charset=utf-8');
  });

  it('rejects traversal, separators, backslashes, and encoded variants', () => {
    for (const bad of [
      '../secret.png', '..%2f..%2fpackage.json', 'a/b.png', 'a%2fb.png',
      'a\\b.png', '..\\x.png', 'foo..bar.png', '%2e%2e%2fx.html', '%2e%2e/y.png',
    ]) {
      expect(sanitizeRenderName(bad)).toBeNull();
    }
  });

  it('rejects wrong / missing extensions and empties', () => {
    for (const bad of ['evil.txt', 'evil.js', 'evil.svg', 'noext', '', undefined, null, 'foo.png.txt']) {
      expect(sanitizeRenderName(bad)).toBeNull();
    }
  });

  it('rejects malformed percent-encoding (fails closed)', () => {
    expect(sanitizeRenderName('%zz.png')).toBeNull();
  });
});

// ── auth mirrors the active MCP mode (false is what the route turns into 401) ──
describe('renderRouteAuthPlan — auth mirrors the active MCP mode (→ 401 on false)', () => {
  it('access mode: bearer OR Access-JWT, NEVER localhost', () => {
    expect(renderRouteAuthPlan({ authMode: 'access', bearerValid: true, accessValid: false, isLocalhost: false })).toBe(true);
    expect(renderRouteAuthPlan({ authMode: 'access', bearerValid: false, accessValid: true, isLocalhost: false })).toBe(true);
    // localhost must NOT bypass in access mode — it mirrors the MCP endpoint exactly
    expect(renderRouteAuthPlan({ authMode: 'access', bearerValid: false, accessValid: false, isLocalhost: true })).toBe(false);
    expect(renderRouteAuthPlan({ authMode: 'access', bearerValid: false, accessValid: false, isLocalhost: false })).toBe(false);
  });

  it('bearer cold path: bearer OR localhost, Access-JWT is ignored', () => {
    expect(renderRouteAuthPlan({ authMode: 'bearer', bearerValid: true, accessValid: false, isLocalhost: false })).toBe(true);
    expect(renderRouteAuthPlan({ authMode: 'bearer', bearerValid: false, accessValid: false, isLocalhost: true })).toBe(true);
    // a would-be Access assertion does NOT count in the bearer cold path
    expect(renderRouteAuthPlan({ authMode: 'bearer', bearerValid: false, accessValid: true, isLocalhost: false })).toBe(false);
    expect(renderRouteAuthPlan({ authMode: 'bearer', bearerValid: false, accessValid: false, isLocalhost: false })).toBe(false);
  });
});

// ── view_url shape emitted into the render_widget result stats ──
describe('render_widget view_url shape + tool description', () => {
  const saved = process.env.REMOTE_MCP_PUBLIC_URL;
  const restore = () => { if (saved === undefined) delete process.env.REMOTE_MCP_PUBLIC_URL; else process.env.REMOTE_MCP_PUBLIC_URL = saved; };

  it('builds Access-gated https view URLs off the default base', () => {
    delete process.env.REMOTE_MCP_PUBLIC_URL;
    expect(publicRenderBaseUrl()).toBe('https://mcp.skycruncher.io');
    const u = renderViewUrls('star_labels.png', 'star_labels.html');
    expect(u.view_url).toBe('https://mcp.skycruncher.io/renders/star_labels.png');
    expect(u.html_view_url).toBe('https://mcp.skycruncher.io/renders/star_labels.html');
    restore();
  });

  it('omits html_view_url when there is no html twin', () => {
    delete process.env.REMOTE_MCP_PUBLIC_URL;
    const u = renderViewUrls('star_labels.png', null);
    expect(u.view_url).toBe('https://mcp.skycruncher.io/renders/star_labels.png');
    expect(u).not.toHaveProperty('html_view_url');
    restore();
  });

  it('honours REMOTE_MCP_PUBLIC_URL and strips a trailing slash', () => {
    process.env.REMOTE_MCP_PUBLIC_URL = 'https://renders.example.org/';
    const u = renderViewUrls('x.png', 'x.html');
    expect(u.view_url).toBe('https://renders.example.org/renders/x.png');
    expect(u.html_view_url).toBe('https://renders.example.org/renders/x.html');
    restore();
  });

  it('render_widget tool description advertises the user-clickable view_url', () => {
    // server.mjs is a shebang entry point (not import-transformable under vitest),
    // so guard the description text at the source level.
    const src = fs.readFileSync(path.join(HERE, 'server.mjs'), 'utf8');
    expect(src).toMatch(/view_url \(and html_view_url/);
    expect(src).toMatch(/user-clickable/);
  });
});

// ── the route is wired into remote_server.mjs (source-level regression guard) ──
describe('remote_server /renders wiring', () => {
  it('handle() gates /renders on rendersAuthorized + sanitizeRenderName with 401/404', () => {
    const src = fs.readFileSync(path.join(HERE, 'remote_server.mjs'), 'utf8');
    expect(src).toMatch(/url\.pathname\.startsWith\('\/renders\/'\)/);
    expect(src).toMatch(/await rendersAuthorized\(req\)/);
    expect(src).toMatch(/sanitizeRenderName\(url\.pathname\.slice/);
    expect(src).toMatch(/401/);
    expect(src).toMatch(/404/);
  });
});
