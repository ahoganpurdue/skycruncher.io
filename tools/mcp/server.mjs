#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// SKYCRUNCHER — stdio MCP server exposing the headless solve API (tools/ lane)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/mcp/server.mjs           (speaks MCP over stdin/stdout)
//
// A Model Context Protocol server that surfaces the REAL calibrated FITS wizard
// pipeline (runWizardPipeline, via the proven tools/api/run.mjs → vitest loader)
// plus the widget-render layer to any MCP client (Claude Desktop / Claude Code).
// FITS lane ONLY (CR2/RAW is out of scope, per headless_driver). Local-only,
// evidence-only: every solve is a FRESH real solve — there is NO caching that
// could serve a stale receipt as a fresh solve.
//
// ─── DEPENDENCY DECISION: HAND-ROLLED, NOT @modelcontextprotocol/sdk ──────────
// The worktree's node_modules is a JUNCTION onto the owner's shared store, so
// `npm install @modelcontextprotocol/sdk` would (a) require network and (b)
// pollute the owner's main node_modules — a structural side effect outside this
// task's scope. The MCP stdio wire format is small enough to implement directly:
// newline-delimited JSON-RPC 2.0 (one message per line, no embedded newlines),
// methods initialize · notifications/initialized · tools/list · tools/call ·
// resources/list · resources/read · ping. So we hand-roll the framing here with
// ZERO new dependencies (no package.json churn, offline-safe). See tools/mcp/README.md.
//
// ─── STDOUT DISCIPLINE ───────────────────────────────────────────────────────
// stdout carries ONLY framed JSON-RPC. ALL diagnostics go to stderr — a stray
// stdout write corrupts the protocol stream. (log() below is stderr-only.)
//
// ─── WRITE SCOPE ─────────────────────────────────────────────────────────────
// The server writes ONLY under test_results/ (mcp_runs/ receipts, mcp_renders/
// PNGs+HTML, workbench/ deposit hook). It never writes elsewhere.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildVersionManifest } from './instrument_manifest.mjs';
import { lintThesis, THESIS_SCHEMA_VERSION } from '../theses/thesis_lint.mjs';
import * as thesisRegistry from '../theses/registry.mjs';
import { renderViewUrls } from './render_route.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEST_RESULTS = path.join(ROOT, 'test_results');
const MCP_RUNS = path.join(TEST_RESULTS, 'mcp_runs');
const MCP_RENDERS = path.join(TEST_RESULTS, 'mcp_renders');
const WORKBENCH_DIR = path.join(TEST_RESULTS, 'workbench');
const RUN_MJS = path.join(ROOT, 'tools', 'api', 'run.mjs');
const GATES_MD = path.join(ROOT, 'docs', 'GATES.md');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const HELPER_CONFIG = 'tools/mcp/mcp.config.ts';
const M66_RECEIPT_DEFAULT = path.join(TEST_RESULTS, 'api_runs', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json');

const SERVER_NAME = 'skycruncher-solve';
const SERVER_VERSION = (buildVersionManifest().surfaces.find((s) => s.surface === 'mcp_server') || {}).version || 'unknown';
const PROTOCOL_VERSION = '2024-11-05';

// ─── stderr-only logging (never touch stdout) ────────────────────────────────
function log(...args) { process.stderr.write('[mcp] ' + args.join(' ') + '\n'); }

// ─── JSON-RPC framing (newline-delimited) ────────────────────────────────────
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } });
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

const E_PARSE = -32700, E_METHOD = -32601, E_PARAMS = -32602, E_INTERNAL = -32603;

// ─── dot-path projection (identical semantics to tools/api/run.mjs) ──────────
const MISSING = 'MISSING';
function project(root, dotPath) {
  let cur = root;
  for (const key of dotPath.split('.')) {
    if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key];
    else return MISSING;
  }
  return cur;
}

// ─── path-safety: only ever read/write inside test_results/ ──────────────────
function underTestResults(p) {
  const abs = path.resolve(p);
  const root = path.resolve(TEST_RESULTS);
  return abs === root || abs.startsWith(root + path.sep);
}
function relFromRoot(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

// ─── spawn a child, capture stderr, resolve {code, stderr} (never rejects) ───
function spawnCaptured(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, stderr: String(e && e.message || e) }));
    child.on('close', (c) => resolve({ code: c, stderr: errBuf }));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: run the REAL wizard solve on a FITS file → { receiptPath, receipt }
// ═══════════════════════════════════════════════════════════════════════════
// Spawns tools/api/run.mjs (which forks the vitest-hosted real solve). Always a
// fresh solve — the prior receipt is removed first so a silent child failure can
// never surface a stale receipt.
async function runSolve(rawPath, onProgress) {
  const fitsPath = path.resolve(rawPath);
  if (!fs.existsSync(fitsPath)) throw new Error(`FITS input not found: ${fitsPath}`);
  if (!/\.(fit|fits|fts)$/i.test(fitsPath)) {
    throw new Error(`FITS lane only — not a .fit/.fits/.fts file: ${fitsPath} (CR2/RAW is out of scope for the headless driver)`);
  }
  fs.mkdirSync(MCP_RUNS, { recursive: true });
  const base = path.basename(fitsPath).replace(/\.(fit|fits|fts)$/i, '');
  const receiptPath = path.join(MCP_RUNS, `${base}.receipt.json`);
  try { fs.rmSync(receiptPath, { force: true }); } catch { /* ignore */ }

  onProgress?.(0, 'starting real wizard solve (wall-time ~30-120 s for a narrow FITS)');
  let ticks = 0;
  const hb = setInterval(() => { ticks++; onProgress?.(undefined, `solving… (${ticks * 10}s elapsed)`); }, 10_000);
  const { code, stderr } = await spawnCaptured([RUN_MJS, '--out', MCP_RUNS, fitsPath], { WORKBENCH_DIR });
  clearInterval(hb);

  if (!fs.existsSync(receiptPath)) {
    const tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
    throw new Error(`solve produced no receipt (run.mjs exit ${code}). stderr tail:\n${tail}`);
  }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch (e) { throw new Error(`could not parse receipt ${receiptPath}: ${e.message}`); }
  return { receiptPath, receipt };
}

function compactSolve(receipt, receiptPath) {
  const rel = relFromRoot(receiptPath);
  const sol = receipt.solution;
  if (sol == null) {
    return { solved: false, reason: 'pipeline returned no solution (NO_SOLVE) for this FITS frame', receipt_path: rel, cached: false };
  }
  const dc = receipt.deep_confirmed;
  const rm = sol.bc_rematch;
  const astro = sol.astrometry || {};
  return {
    solved: true, cached: false,
    ra_hours: sol.ra_hours,
    dec_degrees: sol.dec_degrees,
    pixel_scale_arcsec_per_px: sol.pixel_scale,
    stars_matched: sol.stars_matched,
    confidence: sol.confidence,
    roll_degrees: sol.roll_degrees ?? null,
    parity: sol.parity ?? null,
    fov_width_deg: sol.fov_width_deg ?? null,
    fov_height_deg: sol.fov_height_deg ?? null,
    receipt_schema_version: receipt.version ?? null,
    deep_confirmed: dc
      ? { provenance: dc.provenance ?? null, setGatePassed: dc.setGatePassed ?? null, setExcessZ: dc.setExcessZ ?? null, confirmed: dc.confirmed ?? null, examined: dc.examined ?? null }
      : null,
    bc_rematch: rm
      ? { guard: rm.guard ?? null, applied: rm.applied ?? null, matched_before: rm.matched_before ?? null, matched_after: rm.matched_after ?? null, edge_before: rm.edge_before ?? null, edge_after: rm.edge_after ?? null }
      : null,
    distortion: {
      sip: { present: !!astro.sip, a_order: astro.sip?.a_order ?? null, b_order: astro.sip?.b_order ?? null, rms_arcsec: astro.rms_arcsec ?? null },
      tps: { present: !!astro.tps, control_count: astro.tps?.control_count ?? null, rms_after_arcsec: astro.tps?.rms_after_arcsec ?? null },
    },
    lens_distortion_measured: receipt.lens_distortion_measured ? true : false,
    receipt_path: rel,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: solve_fits
// ═══════════════════════════════════════════════════════════════════════════
async function solveFits(args, onProgress) {
  const rawPath = args && typeof args.path === 'string' ? args.path : null;
  if (!rawPath) throw new Error('solve_fits requires { path: "<fits-file>" }');
  const { receiptPath, receipt } = await runSolve(rawPath, onProgress);
  onProgress?.(100, receipt.solution ? 'solved' : 'no solution (honest no-solve)');
  return compactSolve(receipt, receiptPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: inspect_receipt — --select projection over a saved receipt JSON
// ═══════════════════════════════════════════════════════════════════════════
function inspectReceipt(args) {
  const rp = args && typeof args.receipt_path === 'string' ? args.receipt_path : null;
  if (!rp) throw new Error('inspect_receipt requires { receipt_path, selector }');
  const abs = path.isAbsolute(rp) ? rp : path.resolve(ROOT, rp);
  if (!fs.existsSync(abs)) throw new Error(`receipt not found: ${abs}`);
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { throw new Error(`could not parse receipt ${abs}: ${e.message}`); }

  const selector = args && typeof args.selector === 'string' ? args.selector : '';
  const paths = selector.split(',').map((s) => s.trim()).filter(Boolean);
  const out = { receipt_path: relFromRoot(abs), solved: receipt.solution != null };
  if (paths.length === 0) {
    out.top_level_keys = Object.keys(receipt);
    out.note = 'no selector given — returning top-level keys; pass a comma-separated dot-path selector (e.g. "solution.ra_hours,deep_confirmed.setGatePassed")';
    return out;
  }
  out.selected = {};
  for (const p of paths) out.selected[p] = project(receipt, p); // MISSING sentinel for absent paths, never fabricated
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: draft_annotation — structure observer prose into a user_annotations DRAFT
// ═══════════════════════════════════════════════════════════════════════════
// TESTIMONY, never a measurement. Returns a structured user_annotations PROPOSAL
// (provenance:'mcp_assisted') for the UI to confirm. This tool NEVER writes a
// session and NEVER persists — the step-7 "Confirm & attach" action is the sole
// gate that promotes a draft. The receipt block it targets is string-only and is
// NEVER parsed into the solve (structurally separate from the solve-feeding soft
// metadata). Mirrors stages/user_annotations.buildUserAnnotations (honest-absent).
function annText(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()); }
function draftAnnotation(args) {
  const a = args || {};
  const prose = annText(a.prose);
  // Slot explicit structured fields; the free `prose` falls back into description.
  const fields = {
    description: annText(a.description) || prose,
    location_text: annText(a.location_text),
    sky_bortle_text: annText(a.sky_bortle_text),
    rig_notes: annText(a.rig_notes),
    session_issues: annText(a.session_issues),
  };
  const anyContent = Object.values(fields).some((v) => v.length > 0);
  if (!anyContent) {
    return {
      proposal: null,
      requires_user_confirmation: true,
      note: 'No annotation content supplied — provide `prose` and/or the structured fields '
        + '(description, location_text, sky_bortle_text, rig_notes, session_issues). '
        + 'Testimony only (free-text), NEVER parsed into the solve.',
    };
  }
  const proposal = {
    ...fields,
    provenance: 'mcp_assisted',
    captured_at: new Date().toISOString(),
  };
  return {
    proposal,
    requires_user_confirmation: true,
    note: 'DRAFT ONLY — NOT written to any session and NOT persisted. Present this to the user; '
      + 'only an explicit UI confirm (step-7 "Confirm & attach") applies it to the receipt\'s '
      + 'user_annotations block. String-only testimony, provenance:mcp_assisted — never a '
      + 'measurement, never fed to the solve.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: rig_profiles — pooled per-rig Optical Workbench profiles + counts
// ═══════════════════════════════════════════════════════════════════════════
async function rigProfiles() {
  const jsonl = path.join(WORKBENCH_DIR, 'deposits.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim().length); }
  catch { /* missing file → empty */ }
  if (lines.length === 0) {
    return { present: false, note: 'workbench store empty or absent (no solves have deposited yet) — NOT MEASURED', store: relFromRoot(jsonl), rigs: [] };
  }
  const outFile = path.join(MCP_RUNS, 'workbench_profiles.json');
  fs.mkdirSync(MCP_RUNS, { recursive: true });
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  const { code, stderr } = await spawnCaptured([VITEST_BIN, 'run', '-c', HELPER_CONFIG], { WORKBENCH_DIR, MCP_HELPER_OP: 'profiles', MCP_PROFILES_OUT: outFile });
  if (!fs.existsSync(outFile)) {
    const tail = stderr.split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`rig_profiles helper produced no output (vitest exit ${code}). stderr tail:\n${tail}`);
  }
  const profiles = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return { present: true, store: relFromRoot(jsonl), total_deposits: lines.length, rig_count: Array.isArray(profiles) ? profiles.length : 0, rigs: profiles };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: instrument_status — GATES.md canonical numbers + last-solve info
// ═══════════════════════════════════════════════════════════════════════════
function firstMatch(text, re, dflt = 'NOT PARSED') { const m = text.match(re); return m ? m[1] : dflt; }
function newestReceipt() {
  const roots = [MCP_RUNS, path.join(TEST_RESULTS, 'api_runs')];
  let best = null;
  for (const dir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.receipt.json')) continue;
      const fp = path.join(dir, e);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { fp, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}
function instrumentStatus() {
  let gates = 'NOT PARSED';
  try { gates = fs.readFileSync(GATES_MD, 'utf8'); } catch { /* absent */ }
  const parsed = gates !== 'NOT PARSED';
  const seestar = parsed && gates.match(/RA = `([\d.]+)` h · scale = `([\d.]+)` "\/px · matched = `(\d+)`/);
  const gateNumbers = {
    tsc_lines: parsed ? firstMatch(gates, /npx tsc --noEmit[^|]*\|\s*wc -l`\s*\|\s*\*\*(\d+)\*\*/) : 'NOT PARSED',
    vitest: parsed ? firstMatch(gates, /\*\*(\d+ passed \/ \d+ skipped)\*\*/) : 'NOT PARSED',
    e2e_seestar: seestar ? `RA=${seestar[1]}h scale=${seestar[2]}"/px matched=${seestar[3]}` : 'NOT PARSED',
    e2e_cr2: parsed && gates.includes('blindOutcome') ? 'blindOutcome=solved (RA 17.5858h, 63.211"/px, 55 matched)' : 'NOT PARSED',
    api_smoke: parsed ? firstMatch(gates, /API smoke.*?\*\*(\d+ passed \/ \d+ skipped)\*\*/s) : 'NOT PARSED',
    source: 'docs/GATES.md (single source of truth)',
  };
  const best = newestReceipt();
  let lastSolve = { present: false, note: 'no receipt found under test_results/ — NOT MEASURED' };
  if (best) {
    try {
      const r = JSON.parse(fs.readFileSync(best.fp, 'utf8'));
      lastSolve = r.solution != null
        ? { present: true, receipt_path: relFromRoot(best.fp), solved_at: new Date(best.mtimeMs).toISOString(), ra_hours: r.solution.ra_hours, dec_degrees: r.solution.dec_degrees, pixel_scale_arcsec_per_px: r.solution.pixel_scale, stars_matched: r.solution.stars_matched, confidence: r.solution.confidence, receipt_schema_version: r.version ?? null }
        : { present: true, receipt_path: relFromRoot(best.fp), solved_at: new Date(best.mtimeMs).toISOString(), solved: false, note: 'last receipt was a NO_SOLVE' };
    } catch { lastSolve = { present: false, note: 'newest receipt unreadable' }; }
  }
  return { instrument: `${SERVER_NAME} v${SERVER_VERSION}`, lane: 'FITS-only; all solves run locally on the owner instrument box. Remote access (when connected via mcp.skycruncher.io) rides the owner\'s Cloudflare-Access-gated tunnel — render view_url/html_view_url links are SAME-ORIGIN with this MCP endpoint, behind the same Access login, not public hosting.', version_manifest: buildVersionManifest(), gates: gateNumbers, last_solve: lastSolve };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: list_widgets — the registry inventory (LIVE vs SCAFFOLD + data probe)
// ═══════════════════════════════════════════════════════════════════════════
async function listWidgets() {
  const outFile = path.join(MCP_RENDERS, 'widget_inventory.json');
  fs.mkdirSync(MCP_RENDERS, { recursive: true });
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  const env = { MCP_HELPER_OP: 'list_widgets', MCP_WIDGETS_OUT: outFile };
  if (fs.existsSync(M66_RECEIPT_DEFAULT)) env.MCP_LIST_RECEIPT = M66_RECEIPT_DEFAULT;
  const { code, stderr } = await spawnCaptured([VITEST_BIN, 'run', '-c', HELPER_CONFIG], env);
  if (!fs.existsSync(outFile)) {
    const tail = stderr.split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`list_widgets helper produced no output (vitest exit ${code}). stderr tail:\n${tail}`);
  }
  const inv = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const widgets = inv.widgets || [];
  return {
    total: widgets.length,
    live: widgets.filter((w) => w.status === 'LIVE').length,
    scaffold: widgets.filter((w) => w.status === 'SCAFFOLD').length,
    data_probe_receipt: inv.probe_receipt,
    widgets,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: render_widget — SSR a registry widget with REAL data → PNG
// ═══════════════════════════════════════════════════════════════════════════
// Playwright launch mirrors tools/widgets/capture_cascade.mjs EXACTLY (channel
// 'chrome' + swiftshader/webgl args) — a naive chromium.launch() hit a missing
// headless-shell binary on this box; the system-Chrome channel is the fix.
async function screenshotHtml(htmlPath, pngPath, width) {
  let chromiumMod;
  try { chromiumMod = (await import('playwright')).chromium; }
  catch (e) { throw new Error(`playwright is not importable (${e && e.message ? e.message : e}). Fix: run \`npx playwright install chromium\` (or install Google Chrome for the 'chrome' channel).`); }

  let browser;
  try {
    browser = await chromiumMod.launch({
      channel: process.env.CAPTURE_BROWSER_CHANNEL || 'chrome',
      headless: true,
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
    });
  } catch (eChrome) {
    // Fall back to the bundled chromium if the system Chrome channel is absent.
    try {
      browser = await chromiumMod.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
    } catch (eBundled) {
      throw new Error(`could not launch a browser — Chrome channel: ${eChrome && eChrome.message}; bundled chromium: ${eBundled && eBundled.message}. Fix: \`npx playwright install chromium\` or install Google Chrome. (Never returns a blank image.)`);
    }
  }
  try {
    const ctx = await browser.newContext({ viewport: { width: width + 48, height: 1400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
    await page.waitForSelector('#capture', { timeout: 15000 });
    await page.waitForTimeout(350); // let fonts + SVG layout settle
    await page.locator('#capture').screenshot({ path: pngPath });
    return { consoleErrors };
  } finally {
    await browser.close();
  }
}

async function renderWidget(args, onProgress) {
  const widgetId = args && typeof args.widget_id === 'string' ? args.widget_id : null;
  if (!widgetId) throw new Error('render_widget requires { widget_id, and one of fits_path | receipt_path }');
  const fitsPath = args && typeof args.fits_path === 'string' ? args.fits_path : null;
  const receiptArg = args && typeof args.receipt_path === 'string' ? args.receipt_path : null;
  if (!fitsPath && !receiptArg) throw new Error('render_widget requires exactly one of { fits_path } or { receipt_path }');
  if (fitsPath && receiptArg) throw new Error('render_widget: pass exactly one of fits_path OR receipt_path, not both');
  const width = Math.max(240, Math.min(2000, Number.isFinite(args?.width) ? Math.round(args.width) : 900));
  const returnImage = args && typeof args.return_image === 'boolean' ? args.return_image : true; // token-economics: default inline

  // 1. resolve the receipt (fresh solve for fits_path; use as-is for receipt_path)
  let receiptAbs, solveSummary = null;
  if (fitsPath) {
    onProgress?.(0, 'solving FITS before render');
    const { receiptPath, receipt } = await runSolve(fitsPath, onProgress);
    receiptAbs = receiptPath;
    solveSummary = { solved: receipt.solution != null, ra_hours: receipt.solution?.ra_hours ?? null, stars_matched: receipt.solution?.stars_matched ?? null };
  } else {
    receiptAbs = path.isAbsolute(receiptArg) ? receiptArg : path.resolve(ROOT, receiptArg);
    if (!fs.existsSync(receiptAbs)) throw new Error(`receipt not found: ${receiptAbs}`);
  }

  // 2. SSR the single widget → self-contained HTML + meta (via the helper spec)
  fs.mkdirSync(MCP_RENDERS, { recursive: true });
  const safeId = widgetId.replace(/[^a-z0-9_-]/gi, '_');
  const htmlOut = path.join(MCP_RENDERS, `${safeId}.html`);
  const metaOut = path.join(MCP_RENDERS, `${safeId}.meta.json`);
  const pngOut = path.join(MCP_RENDERS, `${safeId}.png`);
  for (const f of [htmlOut, metaOut, pngOut]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

  onProgress?.(undefined, `rendering widget "${widgetId}"`);
  const { code, stderr } = await spawnCaptured([VITEST_BIN, 'run', '-c', HELPER_CONFIG], {
    MCP_HELPER_OP: 'render_widget', MCP_RENDER_RECEIPT: receiptAbs, MCP_RENDER_WIDGET_ID: widgetId,
    MCP_RENDER_WIDTH: String(width), MCP_RENDER_HTML_OUT: htmlOut, MCP_RENDER_META_OUT: metaOut,
  });
  if (!fs.existsSync(metaOut)) {
    const tail = stderr.split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`widget render helper produced no meta (vitest exit ${code}). stderr tail:\n${tail}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaOut, 'utf8'));
  if (!meta.ok) {
    throw new Error(`${meta.reason}. Known widget ids: ${(meta.known_ids || []).join(', ')} (call list_widgets).`);
  }

  // 3. screenshot → PNG (honest-or-absent: an ABSENT widget renders its NOT
  //    MEASURED state as the PNG — that IS the correct output, never an error).
  onProgress?.(undefined, 'screenshotting widget');
  const { consoleErrors } = await screenshotHtml(htmlOut, pngOut, width);
  if (!fs.existsSync(pngOut)) throw new Error('screenshot did not produce a PNG (no blank image returned)');
  const png = fs.readFileSync(pngOut);

  const htmlTwinExists = fs.existsSync(htmlOut);
  const viewUrls = renderViewUrls(path.basename(pngOut), htmlTwinExists ? path.basename(htmlOut) : null);

  const stats = {
    widget_id: meta.id, title: meta.title, weight_tier: meta.weightTier, status: meta.status, // REAL | ABSENT (NOT MEASURED render)
    is_scaffold: meta.is_scaffold, width_px: width, png_bytes: png.length,
    png_path: relFromRoot(pngOut), html_path: relFromRoot(htmlOut),
    // user-clickable, Access-gated links (served by /renders on the remote server) —
    // present in BOTH return_image modes so a client that hides MCP images can link out.
    ...viewUrls,
    receipt: relFromRoot(receiptAbs), solve: solveSummary,
    console_errors: consoleErrors.length ? consoleErrors.slice(0, 5) : null,
    return_image: returnImage,
  };

  // return_image controls token economics (owner design):
  //   true  → inline PNG image content (owner calling direct; wants it in-context)
  //   false → path + one-line stats only (agent/orchestrator; bytes never enter an LLM context)
  return returnImage
    ? { __content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(stats, null, 2) },
      ] }
    : { __content: [
        { type: 'text', text: `${stats.status} · ${meta.id} (${meta.weightTier}) → ${stats.png_path} · ${png.length} bytes · ${width}px${solveSummary ? ` · solve matched=${solveSummary.stars_matched}` : ''}\n${JSON.stringify(stats)}` },
      ] };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCES: saved receipts under test_results/ as receipt:// URIs
// ═══════════════════════════════════════════════════════════════════════════
function walkReceipts(dir, acc, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkReceipts(fp, acc, depth + 1);
    else if (e.isFile() && e.name.endsWith('.receipt.json')) acc.push(fp);
  }
}
function listResources() {
  const files = [];
  walkReceipts(TEST_RESULTS, files);
  return files.map((fp) => {
    const rel = path.relative(TEST_RESULTS, fp).split(path.sep).join('/');
    return { uri: `receipt://${rel}`, name: path.basename(fp), mimeType: 'application/json', description: `saved solve receipt (${rel})` };
  });
}
function readResource(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('receipt://')) throw new Error(`unsupported resource uri (expected receipt://…): ${uri}`);
  const rel = uri.slice('receipt://'.length);
  const abs = path.resolve(TEST_RESULTS, rel);
  if (!underTestResults(abs)) throw new Error('resource path escapes test_results/ (refused)');
  if (!fs.existsSync(abs)) throw new Error(`resource not found: ${uri}`);
  return { contents: [{ uri, mimeType: 'application/json', text: fs.readFileSync(abs, 'utf8') }] };
}

// ═══════════════════════════════════════════════════════════════════════════
// CSL THESIS TOOLS — the Community Science Laboratory thesis front door
// ═══════════════════════════════════════════════════════════════════════════
// Design source: docs/COMMUNITY_SCIENCE_LAB.md. The MCP is the CONVERSATIONAL
// submission surface for the internal protocol: prior-art card check → base-rate
// / stratum framing → derivative enumeration → FROZEN measurable criteria →
// mechanical lint (thesis_lint.mjs — "the declarative schema IS the gate") →
// append-only registry (registry.mjs — pre-registration integrity via content
// hash). Lint + registry are ADVISORY-STRUCTURAL: they enforce that the claim is
// HONEST and TESTABLE. The deterministic harness remains the sole arbiter of
// whether the physics is RIGHT (the ML-boundary law applied to LLMs — the
// interlocutor shapes the question, never answers it).

// thesis_submit — lint, and ONLY on ACCEPT register (REJECT never registers).
function thesisSubmit(args) {
  const thesis = args && typeof args.thesis === 'object' && args.thesis !== null && !Array.isArray(args.thesis) ? args.thesis : null;
  if (!thesis) throw new Error('thesis_submit requires { thesis: <thesis JSON object> } — see the thesis schema (id/title/submitter/stage/hypothesis/reasoning_mechanism/equations_variables/prior_art/base_rates_domain/pass_criteria/derivative_predictions/predictions_on_record/kill_clause/status)');
  const lint = lintThesis(thesis);
  if (lint.verdict !== 'ACCEPT') {
    // REJECT never registers — the cited reasons ARE the deliverable (what makes it untestable).
    return { verdict: 'REJECT', registered: false, reasons: lint.reasons, warnings: lint.warnings, schema_version: THESIS_SCHEMA_VERSION };
  }
  // A NEW submission pre-registers: criteria freeze BEFORE any large-data access.
  const entry = thesisRegistry.register(thesis, { status: 'PRE-REGISTERED' });
  return { verdict: 'ACCEPT', registered: true, id: entry.id, sha256: entry.sha256, status: entry.status, schema_version: entry.schema_version, file: entry.file, warnings: lint.warnings };
}

// thesis_list — the registry inventory (folded, with per-entry integrity).
function thesisList() {
  const entries = thesisRegistry.list();
  return {
    count: entries.length,
    theses: entries.map((e) => ({ id: e.id, title: e.title, status: e.status, schema_version: e.schema_version, sha256: e.sha256, stamps: e.stamps.length, integrity_ok: e.integrity.ok, ts: e.ts })),
  };
}

// thesis_get — one entry with its stamp chain + a LIVE integrity re-hash.
function thesisGet(args) {
  const id = args && typeof args.id === 'string' ? args.id : null;
  if (!id) throw new Error('thesis_get requires { id }');
  const entry = thesisRegistry.get(id);
  if (!entry) return { found: false, id, note: `no registered thesis with id "${id}" — call thesis_list` };
  return { found: true, ...entry };
}

// thesis_stamp — append-only status transition (RUNNING/PASS/FAIL/PARTIAL only).
function thesisStamp(args) {
  const id = args && typeof args.id === 'string' ? args.id : null;
  const status = args && typeof args.status === 'string' ? args.status : null;
  if (!id || !status) throw new Error('thesis_stamp requires { id, status } — status ∈ RUNNING/PASS/FAIL/PARTIAL (PRE-REGISTERED is registration-only and cannot be re-stamped)');
  const entry = thesisRegistry.stamp({ id, status, by: typeof args.by === 'string' && args.by.length ? args.by : 'mcp-client', evidence_pointer: typeof args.evidence_pointer === 'string' ? args.evidence_pointer : '' });
  return { stamped: true, id: entry.id, status: entry.status, stamps: entry.stamps, integrity: entry.integrity };
}

// librarian_query — card-catalog doc retrieval (tools/librarian lane). Spawned
// as a child process (not imported): the lane carries its own node_modules with
// a NATIVE module (@lancedb/lancedb) — process isolation keeps a native fault
// from taking the MCP server down, and keeps this file zero-new-imports.
const LIBRARIAN_QUERY = path.join(ROOT, 'tools', 'librarian', 'query.mjs');

// query_results — the read-only DuckDB-over-parquet results query surface. Spawned
// as a child (not imported) for the SAME reason as the librarian: the tools/results
// lane carries its own node_modules with a NATIVE module (@duckdb/node-api). The
// child enforces its own SELECT-only rail + row-cap + timeout; this layer just
// marshals args and relays the child's honest stdout/stderr.
const QUERY_RESULTS_MJS = path.join(ROOT, 'tools', 'results', 'query_results.mjs');
const QUERY_RESULTS_CANNED = ['odds-separation', 'verdicts-by-frame', 'gap-classes', 'frames-summary', 'tables'];
function librarianQuery(args) {
  const q = args && typeof args.query === 'string' ? args.query.trim() : '';
  if (!q) throw new Error('librarian_query requires { query } — a natural-language question about the repo docs');
  const argv = [LIBRARIAN_QUERY];
  if (args && Number.isFinite(args.k)) argv.push('-k', String(Math.max(1, Math.min(20, Math.trunc(args.k)))));
  if (args && Number.isFinite(args.threshold)) argv.push('--threshold', String(args.threshold));
  // Optional corpus selector (additive; default docs preserves every caller).
  // 'code' = the comment-prose code catalog; 'reports' = frozen one-shot
  // test_results/**/*.md docs (three fs roots, no git history); 'both' = ALL
  // THREE, each labeled.
  const corpus = args && typeof args.corpus === 'string' ? args.corpus.toLowerCase() : '';
  if (corpus === 'code' || corpus === 'reports' || corpus === 'both') argv.push('--corpus', corpus);
  argv.push(q);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } reject(new Error('librarian_query timed out (20 s)')); }, 20_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`librarian query.mjs exited ${code}: ${err.slice(0, 400)}`));
      // query.mjs emits JSON lines: ONE refusal object, or one object per result.
      const rows = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
      if (rows.length === 1 && rows[0] && rows[0].refused) return resolve(rows[0]);
      resolve({ refused: false, query: q, results: rows });
    });
  });
}

// query_results — spawn the read-only DuckDB CLI (--json), relay its structured
// result. TEST/DEV, schema-unlocked (the child banners this on stderr). Same rails
// as the CLI: the child rejects any non-SELECT and reports honest NOT-MEASURED for
// absent tables. Pass EXACTLY ONE of { canned, sql }.
function queryResults(args) {
  args = args || {};
  const canned = typeof args.canned === 'string' ? args.canned.trim() : '';
  const sql = typeof args.sql === 'string' ? args.sql.trim() : '';
  if (canned && sql) throw new Error('query_results: pass EITHER canned OR sql, not both');
  if (!canned && !sql) throw new Error('query_results: requires one of { canned, sql }');
  if (canned && !QUERY_RESULTS_CANNED.includes(canned)) {
    throw new Error(`query_results: unknown canned query "${canned}" — one of ${QUERY_RESULTS_CANNED.join(', ')}`);
  }
  const argv = [QUERY_RESULTS_MJS, '--json'];
  if (canned) argv.push(canned);
  else argv.push('--sql', sql);
  if (args.r2 === true) argv.push('--r2');
  if (Number.isFinite(args.limit)) argv.push('--limit', String(Math.max(1, Math.trunc(args.limit))));
  if (typeof args.labels === 'string' && args.labels.trim()) argv.push('--labels', args.labels.trim());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } reject(new Error('query_results timed out (90 s)')); }, 90_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // The CLI prints the v0-testdev banner + any honest NOT-MEASURED / rail
      // rejection to stderr; a non-zero exit is a real failure — relay it verbatim.
      if (code !== 0) return reject(new Error(`query_results exited ${code}: ${(err || out).trim().slice(0, 500)}`));
      const trimmed = out.trim();
      try { return resolve(JSON.parse(trimmed)); }
      catch { return resolve({ tier: 'v0-testdev', raw: trimmed.slice(0, 4000), note: 'non-JSON output' }); }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
const TOOLS = [
  {
    name: 'solve_fits',
    description: 'Run the REAL calibrated FITS wizard pipeline (runWizardPipeline) on a .fit/.fits/.fts file and return a compact solve summary (solved?, ra_hours, dec, pixel scale, matched, confidence, receipt schema version, deep_confirmed, bc_rematch, SIP/TPS presence+RMS). Always a fresh real solve (no caching). Wall-time ~30-120 s. FITS lane only (CR2/RAW out of scope).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'absolute or repo-relative path to a .fit/.fits/.fts file' } }, required: ['path'] },
  },
  {
    name: 'inspect_receipt',
    description: 'Apply --select dot-path projection over an already-saved receipt JSON (no re-solve). Absent paths return the MISSING sentinel, never a fabricated value. Omit the selector to list top-level keys.',
    inputSchema: { type: 'object', properties: { receipt_path: { type: 'string', description: 'path to a saved *.receipt.json' }, selector: { type: 'string', description: 'comma-separated dot-paths, e.g. "solution.ra_hours,deep_confirmed.setGatePassed"' } }, required: ['receipt_path'] },
  },
  {
    name: 'draft_annotation',
    description: 'Structure observer prose into a user_annotations DRAFT (schema 2.12.0) — TESTIMONY, never a measurement. Returns a {proposal, requires_user_confirmation:true, note} where proposal carries the five free-text fields (description/location_text/sky_bortle_text/rig_notes/session_issues) + provenance:"mcp_assisted" + captured_at. This tool NEVER writes a session and NEVER persists: the step-7 "Confirm & attach" UI action is the ONLY gate that promotes a draft onto the receipt. The block is string-only and is NEVER parsed into the solve (kept separate from the solve-feeding soft metadata). Pass `prose` (free text, falls back into description) and/or any explicit structured field.',
    inputSchema: { type: 'object', properties: { prose: { type: 'string', description: 'free-text observer notes (falls into `description` if no explicit description)' }, description: { type: 'string', description: 'target/intent' }, location_text: { type: 'string', description: 'human location text (NOT parsed into GPS)' }, sky_bortle_text: { type: 'string', description: 'sky quality as described (NOT parsed into numeric bortle_class)' }, rig_notes: { type: 'string', description: 'rig/optical-train notes' }, session_issues: { type: 'string', description: 'anything that went wrong (clouds/wind/focus)' } } },
  },
  {
    name: 'rig_profiles',
    description: 'Read the Optical Workbench store (test_results/workbench/) and return per-rig pooled profiles + deposit counts. Honest-absent when the store is empty. Pooling reuses the engine recomputeRigProfile (no duplicated math).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'instrument_status',
    description: 'Cheap read: the canonical regression gate numbers from docs/GATES.md (tsc, vitest, sacred e2e, api smoke) plus the most recent solve summary found under test_results/. Honest-absent when unmeasured.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_widgets',
    description: 'List the widget registry inventory: id, title, intent, weightTier, LIVE-vs-SCAFFOLD status, and a REAL/ABSENT data probe against the bundled M66 receipt. Discover what render_widget can draw.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render_widget',
    description: 'Render a registry widget with REAL data to a PNG. Pass a widget_id (see list_widgets) and EXACTLY ONE of fits_path (runs a fresh real solve first) or receipt_path (skips the solve). A widget whose selector returns null renders its NOT-MEASURED state as the PNG — that is the correct output, never an error. width defaults to 900px. return_image (default true) = inline PNG image content; false = write PNG to disk and return only the path + stats (bytes never enter an LLM context). The result also carries view_url (and html_view_url for the HTML twin): a user-clickable, Cloudflare Access-gated HTTPS link to the rendered artifact — clients that do NOT surface MCP image content to the user should present view_url so the user can open the render.',
    inputSchema: {
      type: 'object',
      properties: {
        widget_id: { type: 'string', description: 'a registry widget id (call list_widgets to enumerate)' },
        fits_path: { type: 'string', description: 'a .fit/.fits/.fts file to solve first, then render from its receipt' },
        receipt_path: { type: 'string', description: 'a saved *.receipt.json to render from (skips the solve)' },
        width: { type: 'number', description: 'render width in px (default 900)' },
        return_image: { type: 'boolean', description: 'true (default) = inline PNG; false = path + stats only (token-light for agents)' },
      },
      required: ['widget_id'],
    },
  },
  {
    name: 'thesis_submit',
    description: 'Submit a Community Science Laboratory thesis (docs/COMMUNITY_SCIENCE_LAB.md). The thesis JSON is mechanically LINTED ("the declarative schema IS the gate"); on ACCEPT it is registered (content-hashed, pre-registered) and you get {id, sha256}; on REJECT it is NEVER registered and you get the specific reasons. INTERLOCUTOR GUIDANCE — develop the thesis with the submitter BEFORE calling: (1) PRIOR-ART: cite the relevant docs/reference/CARD_*.md (and any file/URL) in prior_art, or add an explicit source:"card-absent" entry — an empty prior_art is refused. (2) BASE RATES: base_rates_domain.strata + domain_of_validity are MANDATORY (a claim is evaluated WITHIN hardware/sky strata, never blind-pooled — Bernoulli discipline); a multi-stratum claim must reconcile the cross-stratum variation. (3) FREEZE: every pass_criterion must be frozen:true and measurable (carry a number/comparator) — criteria freeze BEFORE any data access (anti-p-hacking). (4) DERIVATIVES: >= 1 derivative_prediction ("for this to hold, what else must be true?"). (5) KILL CLAUSE required. (6) SCHEMA 0.2.0: submitter_class (AI-RESEARCHER|HUMAN|HYBRID-INTERLOCUTOR) and time_budget ({est_wall_minutes>0, lane:inline|overnight}) are REQUIRED — AI-RESEARCHER submissions never pool with HUMAN (base-rate integrity). A legacy schema_version:"0.1.0" thesis with neither field still validates. An honest NULL / FAIL is a VALID, citable CSL outcome — do not shade a thesis toward passing.',
    inputSchema: { type: 'object', properties: { thesis: { type: 'object', description: 'a full thesis object per tools/theses/thesis_schema.ts (schema_version, id, title, submitter, stage, submitter_class[0.2.0], time_budget[0.2.0], hypothesis, reasoning_mechanism, equations_variables[], prior_art[], base_rates_domain{strata[],domain_of_validity,cross_stratum_reconciliation}, pass_criteria[{id,description,measurable,frozen:true}], derivative_predictions[], predictions_on_record, kill_clause, deviations_log[], status, verdict_stamps[], links). New 0.2.0 fields pass through the registry unchanged.' } }, required: ['thesis'] },
  },
  {
    name: 'thesis_list',
    description: 'List the CSL thesis registry: id, title, status (PRE-REGISTERED/RUNNING/PASS/FAIL/PARTIAL), schema_version, registration sha256, stamp count, and a live integrity flag (is the frozen thesis still unmodified since registration?). Honest-absent when the registry is empty.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'thesis_get',
    description: 'Fetch one registered thesis by id: the folded entry with its full append-only stamp chain AND a LIVE integrity re-hash (re-reads the on-disk thesis and compares to the registration hash — a post-registration edit of the frozen content surfaces as integrity.ok=false). Pre-registration integrity is the anti-gaming guarantee.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the thesis id (call thesis_list to enumerate)' } }, required: ['id'] },
  },
  {
    name: 'thesis_stamp',
    description: 'Append a status transition to a registered thesis (RUNNING when the frozen test starts; PASS/FAIL/PARTIAL when it resolves). Append-only — a stamp NEVER edits a prior record and chains to the registration hash. PRE-REGISTERED is a registration-only status and CANNOT be re-stamped. An honest FAIL/NULL is a valid outcome and the recorded failure IS the deliverable — record it truthfully. Provide an evidence_pointer (commit/receipt/path) backing the verdict.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the thesis id' }, status: { type: 'string', enum: ['RUNNING', 'PASS', 'FAIL', 'PARTIAL'], description: 'the transition (PRE-REGISTERED not allowed)' }, by: { type: 'string', description: 'who applied the stamp (agent id / person / harness)' }, evidence_pointer: { type: 'string', description: 'pointer to the backing evidence (commit hash / receipt path / URL)' } }, required: ['id', 'status'] },
  },
  {
    name: 'librarian_query',
    description: 'Librarian — a CARD CATALOG over the repo (tools/librarian, LanceDB-backed BM25+coverage retrieval). THREE corpora: `docs` (default — tracked docs), `code` (the PROSE that lives in the code: comment banners, JSDoc, section headers over src/**+tools/**, for concept-phrased code questions grep cannot reach, e.g. "where do we correct star flux for vignette"), and `reports` (frozen one-shot docs/research that live GITIGNORED next to their run artifacts under test_results/**/*.md, across THREE filesystem roots: this checkout, the rest-integration checkout, and D:/AstroLogic/test_artifacts — these carry no git history, so results are timestamped with `mtime`+`root_id` instead of `last_commit`). Returns POINTERS (path + heading + line range + authority class + last-commit/mtime), NEVER content as an answer: always read the primary source at the returned lines. Below a calibrated threshold it REFUSES ("no indexed source") rather than emit nearest-neighbour garbage — a refusal is an honest, correct result. Each corpus has its OWN threshold (docs 5.0, code 5.0, reports 3.4 — each on its own scale); `corpus:"both"` runs all three, each labeled (never a unified score). Docs/code index liveness is git-hook-driven on the canonical checkout; reports liveness is MANUAL (`node index_reports.mjs` — the three roots are gitignored/outside-repo, so no commit event exists to hook). Cheap (<1 s).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'natural-language question, e.g. "where do receipt schema versions live" (docs), "how is the hybrid atlas row format discriminated" (code), or "seestar control alpaca native" (reports)' },
        k: { type: 'number', description: 'top-k pointers to return (default 5, max 20)' },
        threshold: { type: 'number', description: 'override the calibrated refusal cutoff (docs 5.0, code 5.0, reports 3.4 — lower it only when a refusal seems wrong, and say so)' },
        corpus: { type: 'string', enum: ['docs', 'code', 'reports', 'both'], description: 'which catalog to query (default "docs"). "code" = comment-prose over the source tree; "reports" = frozen one-shot test_results/**/*.md research (3 fs roots, no git history); "both" = all three corpora, each labeled with its own score/threshold.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_results',
    description: 'Read-only DuckDB query surface over the banked results parquet (the ruled DuckDB-over-parquet results surface, owner 2026-07-16). TIER: TEST/DEV — the schema is UNLOCKED and results are NON-CITABLE until the post-recal schema lock. Six views: frames, stars, detections, crashes, quad_verdicts, quad_clusters (the last two = the 2026-07-18 quad_gen drain: per-frame verdicts + per-cluster odds/oddsV2/oddsV3 shadows). SOURCES: local D: results_etl_* parquet by default (newest root wins per receipt, no double-count); R2 via r2:true (tables not yet uploaded — e.g. the quad_gen backfill — report an honest NOT-MEASURED, never a silent empty). RAILS: SELECT-only (any INSERT/UPDATE/DELETE/COPY/ATTACH/PRAGMA/CREATE/DROP/multi-statement is rejected before execution — this is a read surface), row-cap (limit, default 1000, with truncation notice), query timeout. Pass EXACTLY ONE of {canned, sql}. UNITS TRAP: catalog/foot RA is DEGREES in quad_clusters (foot_ra_deg, crval_ra_deg), but acceptance_verify_ra_hours in quad_verdicts is HOURS; parity is a raw ±1 (sign not asserted).',
    inputSchema: {
      type: 'object',
      properties: {
        canned: { type: 'string', enum: QUERY_RESULTS_CANNED, description: 'a named canned query. odds-separation = truth/false signed-oddsV2 separation over the two arm_fullstack_* arms (reproduces the drain sanity: false max 199.22359881965082, truth min 1959.6022951183534, 23 truth / 1231 false; needs the local oracle-label glob). verdicts-by-frame = per-frame quad-gen verdict summary. gap-classes = failure-stage/reason distribution over unsolved frames. frames-summary = solved/unsolved rollup by rig. tables = registered views + resolved source + row count.' },
        sql: { type: 'string', description: 'an arbitrary read-only SELECT / WITH…SELECT over the six views (mutually exclusive with canned). The SELECT-only rail is enforced by the query engine.' },
        r2: { type: 'boolean', description: 'query the R2 parquet instead of the local D: roots (default false)' },
        limit: { type: 'number', description: 'row cap (default 1000)' },
        labels: { type: 'string', description: 'override the oracle-label glob used by odds-separation (default the w5 labels dir)' },
      },
    },
  },
];

async function callTool(name, args, onProgress) {
  switch (name) {
    case 'solve_fits': return solveFits(args, onProgress);
    case 'inspect_receipt': return inspectReceipt(args);
    case 'draft_annotation': return draftAnnotation(args);
    case 'rig_profiles': return rigProfiles();
    case 'instrument_status': return instrumentStatus();
    case 'list_widgets': return listWidgets();
    case 'render_widget': return renderWidget(args, onProgress);
    case 'thesis_submit': return thesisSubmit(args);
    case 'thesis_list': return thesisList();
    case 'thesis_get': return thesisGet(args);
    case 'thesis_stamp': return thesisStamp(args);
    case 'librarian_query': return librarianQuery(args);
    case 'query_results': return queryResults(args);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH
// ═══════════════════════════════════════════════════════════════════════════
let initialized = false;

async function handleMessage(msg) {
  if (msg.id === undefined || msg.id === null) { // notification — never reply
    if (msg.method === 'notifications/initialized') initialized = true;
    return;
  }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize': {
        const clientProto = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        reply(id, { protocolVersion: clientProto, capabilities: { tools: {}, resources: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
        return;
      }
      case 'ping': reply(id, {}); return;
      case 'tools/list': reply(id, { tools: TOOLS }); return;
      case 'resources/list': reply(id, { resources: listResources() }); return;
      case 'resources/read': {
        if (!params || typeof params.uri !== 'string') { replyError(id, E_PARAMS, 'resources/read requires { uri }'); return; }
        reply(id, readResource(params.uri));
        return;
      }
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') { replyError(id, E_PARAMS, 'tools/call requires { name, arguments }'); return; }
        const progressToken = params._meta && params._meta.progressToken;
        const onProgress = progressToken !== undefined
          ? (progress, message) => notify('notifications/progress', { progressToken, ...(progress !== undefined ? { progress } : {}), ...(message ? { message } : {}) })
          : undefined;
        try {
          const result = await callTool(params.name, params.arguments || {}, onProgress);
          // A tool may return { __content } to supply its own content blocks (e.g.
          // an image); otherwise we wrap the JSON result as a text block.
          if (result && result.__content) reply(id, { content: result.__content, isError: false });
          else reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          reply(id, { content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }], isError: true });
        }
        return;
      }
      default: replyError(id, E_METHOD, `method not found: ${method}`);
    }
  } catch (e) {
    replyError(id, E_INTERNAL, e && e.message ? e.message : String(e));
  }
}

// ─── ADDITIVE (2026-07-11): expose the transport-agnostic core so an alternate
//     transport (tools/mcp/remote_server.mjs, streamable HTTP) can reuse the SAME
//     registry + dispatch WITHOUT duplicating tool logic. The stdio runtime below
//     is guarded behind IS_MAIN so `import`ing this module never hijacks stdin or
//     emits the ready line — running `node tools/mcp/server.mjs` is UNCHANGED.
const IS_MAIN = !!(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

export { TOOLS, callTool, listResources, readResource, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION };

if (IS_MAIN) {
  // ─── stdin line reader (newline-delimited JSON-RPC) ────────────────────────
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: E_PARSE, message: 'parse error' } }); continue; }
      handleMessage(msg).catch((e) => log('handler crash:', e && e.message ? e.message : String(e)));
    }
  });
  process.stdin.on('end', () => process.exit(0));

  log(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio JSON-RPC, hand-rolled; FITS-only, local-only; 10 tools incl. CSL thesis front door)`);
}
