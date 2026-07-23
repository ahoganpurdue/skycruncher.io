#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/mcp/smoke.mjs — end-to-end MCP protocol smoke test (the EXIT EVIDENCE)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/mcp/smoke.mjs
//
// Spawns tools/mcp/server.mjs, speaks real MCP over its stdio, and asserts the
// SACRED M66 solve numbers come back THROUGH THE PROTOCOL:
//   initialize → tools/list → solve_fits(bundled M66) → RA=11.341253475172621,
//   matched=272 · then render_widget(color_color_planckian on that receipt) →
//   a non-trivial (>10 KB) PNG returned as MCP image content · clean shutdown.
//
// Exit 0 on PASS, 1 on FAIL. This drives the server exactly as Claude Desktop
// would (newline-delimited JSON-RPC 2.0 over stdin/stdout).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(HERE, 'server.mjs');
const M66 = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');

const EXPECT_RA = 11.341253475172621;
const EXPECT_MATCHED = 272;
const MIN_PNG_BYTES = 10 * 1024;

if (!fs.existsSync(M66)) { console.error(`[smoke] FAIL: bundled M66 FITS not found at ${M66} (provision Sample Files/)`); process.exit(1); }

// Isolate the CSL thesis round-trip in a throwaway registry dir so the smoke
// never pollutes the real test_results/theses/ ledger (the server reads
// THESIS_REGISTRY_DIR from its env). Cleaned up at exit.
const THESIS_DIR = path.join(ROOT, 'test_results', `theses_smoke_${process.pid}`);
try { fs.rmSync(THESIS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, THESIS_REGISTRY_DIR: THESIS_DIR } });
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString()));

// ─── minimal MCP client: correlate responses by id, log progress notes ───────
const pending = new Map();
let rbuf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  rbuf += chunk;
  let nl;
  while ((nl = rbuf.indexOf('\n')) >= 0) {
    const line = rbuf.slice(0, nl).trim();
    rbuf = rbuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('[smoke] non-JSON on stdout:', line); continue; }
    if (msg.method === 'notifications/progress') { process.stderr.write(`[progress] ${msg.params?.message ?? ''}\n`); continue; }
    if (msg.id != null && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 300_000) {
  const id = nextId++;
  const req = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  child.stdin.write(JSON.stringify(req) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method} (id ${id})`)); }, timeoutMs);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
function notifyServer(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n'); }
function toolJson(resp) {
  if (resp.result?.structuredContent) return resp.result.structuredContent;
  const t = (resp.result?.content || []).find((c) => c.type === 'text');
  return t ? JSON.parse(t.text) : null;
}

const checks = [];
function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail }); console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); }

async function main() {
  // 1. initialize
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } }, 15_000);
  check('initialize → serverInfo.name', init.result?.serverInfo?.name === 'skycruncher-solve', init.result?.serverInfo?.name);
  notifyServer('notifications/initialized');

  // 2. tools/list
  const list = await rpc('tools/list', {}, 15_000);
  const names = (list.result?.tools || []).map((t) => t.name);
  check('tools/list exposes all 6 solve/widget tools', ['solve_fits', 'inspect_receipt', 'rig_profiles', 'instrument_status', 'list_widgets', 'render_widget'].every((n) => names.includes(n)), names.join(','));
  check('tools/list exposes all 4 CSL thesis tools', ['thesis_submit', 'thesis_list', 'thesis_get', 'thesis_stamp'].every((n) => names.includes(n)), names.join(','));

  // 2b. instrument_status -> the WHOLE unified version manifest (B5)
  const statusResp = await rpc('tools/call', { name: 'instrument_status', arguments: {} }, 20_000);
  const st = toolJson(statusResp);
  const vmSurfaces = (st && st.version_manifest && st.version_manifest.surfaces) || [];
  check('instrument_status returns the version manifest', Array.isArray(vmSurfaces) && vmSurfaces.length >= 8, `${vmSurfaces.length} surfaces`);
  const receiptSurface = vmSurfaces.find((s) => s.surface === 'receipt_schema');
  check('manifest receipt_schema resolved (not duplicated)', !!(receiptSurface && receiptSurface.version && receiptSurface.version !== 'UNRESOLVED'), receiptSurface && receiptSurface.version);
  // 3. solve_fits on the bundled M66 (with a progress token) — SACRED numbers
  console.log('[smoke] solving bundled M66 (real pipeline; ~30-120 s)…');
  const solve = await rpc('tools/call', { name: 'solve_fits', arguments: { path: M66 }, _meta: { progressToken: 'smoke-solve' } }, 300_000);
  const s = toolJson(solve);
  check('solve_fits not isError', solve.result?.isError === false, solve.result?.isError);
  check('solve_fits solved', s?.solved === true);
  check(`solve_fits RA === ${EXPECT_RA}`, s?.ra_hours === EXPECT_RA, String(s?.ra_hours));
  check(`solve_fits matched === ${EXPECT_MATCHED}`, s?.stars_matched === EXPECT_MATCHED, String(s?.stars_matched));
  check('solve_fits cached === false', s?.cached === false);
  console.log(`[smoke]   RA=${s?.ra_hours}h scale=${s?.pixel_scale_arcsec_per_px}"/px matched=${s?.stars_matched} conf=${s?.confidence} schema=${s?.receipt_schema_version}`);

  // 4. render_widget(color_color_planckian) on that receipt → non-trivial PNG through the protocol
  const receiptPath = s?.receipt_path;
  check('solve_fits returned a receipt_path', typeof receiptPath === 'string', receiptPath);
  console.log('[smoke] rendering color_color_planckian widget → PNG…');
  const render = await rpc('tools/call', { name: 'render_widget', arguments: { receipt_path: receiptPath, widget_id: 'color_color_planckian', width: 900, return_image: true }, _meta: { progressToken: 'smoke-render' } }, 120_000);
  check('render_widget not isError', render.result?.isError === false, render.result?.isError ? JSON.stringify(render.result?.content) : 'ok');
  const img = (render.result?.content || []).find((c) => c.type === 'image');
  const bytes = img ? Buffer.from(img.data, 'base64').length : 0;
  check(`render_widget PNG > ${MIN_PNG_BYTES} bytes through protocol`, bytes > MIN_PNG_BYTES, `${bytes} bytes`);
  check('render_widget image mimeType', img?.mimeType === 'image/png', img?.mimeType);

  // ─── 5. CSL thesis front door: submit → get → stamp round-trip + a REJECT ────
  console.log('[smoke] CSL thesis round-trip (submit → get → stamp) + lint-REJECT…');
  const FIXTURE_ID = `SMOKE-THESIS-${process.pid}`;
  const goodThesis = {
    schema_version: '0.1.0',
    id: FIXTURE_ID,
    title: 'Smoke fixture — a well-formed, frozen, testable thesis',
    submitter: 'mcp-smoke',
    stage: 'instrument-internal',
    hypothesis: 'Restricting the match pool to a bright subset raises the true-orientation sweep peak significance.',
    reasoning_mechanism: 'A smaller pool lowers the accidental-coincidence null, so the true peak z-score rises.',
    equations_variables: [
      { name: 'K', definition: 'top-K detections by flux', units: 'count', frozen: false },
      { name: 'SOLVER_UW_SWEEP_MIN_Z', definition: 'sweep acceptance gate', units: 'σ', frozen: true },
    ],
    prior_art: [
      { source: 'file', ref: 'docs/GATES.md', claim: 'pinned reference solves + gate baselines' },
      { source: 'card-absent', ref: 'no reference card covers the UW sweep null distribution', claim: 'explicit CARD-ABSENT disclosure' },
    ],
    base_rates_domain: {
      strata: ['libraw-UW (~2.2k dets)', 'rawler-UW (~3.4k dets)'],
      domain_of_validity: 'rawler-UW arm only; narrow-field quad path out of domain',
      cross_stratum_reconciliation: 'the null-inflation dropoff is quantified by faint-detection fraction; the fix is a paired recalibration, not a universal claim',
    },
    pass_criteria: [
      { id: 'P1', description: 'sweep peak at true theta', measurable: 'peakZ >= 4.5', frozen: true },
      { id: 'P2', description: 'libraw arm byte-identical', measurable: 'api_smoke == 13/13 bit-exact', frozen: true },
    ],
    derivative_predictions: ['the restriction works by LOWERING the null (junk best-Z stays < 4.5σ), not by inflating the peak'],
    predictions_on_record: 'PASS on both criteria; predicted peakZ recovers to >= +6σ',
    kill_clause: 'any criterion fails => thesis FAILS; the honest failure record is the deliverable',
    deviations_log: [],
    status: 'PRE-REGISTERED',
    verdict_stamps: [],
    links: { arxiv: [], researchgate: [], orcid: [], institutions: [] },
  };
  const sub = await rpc('tools/call', { name: 'thesis_submit', arguments: { thesis: goodThesis } }, 20_000);
  const subj = toolJson(sub);
  check('thesis_submit ACCEPT registers', sub.result?.isError === false && subj?.verdict === 'ACCEPT' && subj?.registered === true, `${subj?.verdict}/${subj?.registered}`);
  check('thesis_submit returns a sha256', typeof subj?.sha256 === 'string' && subj.sha256.length === 64, subj?.sha256);
  check('thesis_submit status is PRE-REGISTERED', subj?.status === 'PRE-REGISTERED', subj?.status);

  const got = await rpc('tools/call', { name: 'thesis_get', arguments: { id: FIXTURE_ID } }, 15_000);
  const gj = toolJson(got);
  check('thesis_get finds the registered thesis', gj?.found === true && gj?.id === FIXTURE_ID, `found=${gj?.found}`);
  check('thesis_get integrity ok (unmodified since registration)', gj?.integrity?.ok === true, gj?.integrity?.note);
  check('thesis_get sha256 matches submit', gj?.sha256 === subj?.sha256, `${gj?.sha256}`);

  const stamped = await rpc('tools/call', { name: 'thesis_stamp', arguments: { id: FIXTURE_ID, status: 'PASS', by: 'smoke', evidence_pointer: 'smoke-run' } }, 15_000);
  const stj = toolJson(stamped);
  check('thesis_stamp appends a PASS transition', stamped.result?.isError === false && stj?.status === 'PASS' && (stj?.stamps?.length ?? 0) === 1, `status=${stj?.status} stamps=${stj?.stamps?.length}`);
  check('thesis_stamp chain records integrity_ok', stj?.stamps?.[0]?.integrity_ok === true, String(stj?.stamps?.[0]?.integrity_ok));

  // stamp with an illegal status (PRE-REGISTERED cannot be re-stamped) → isError
  const badStamp = await rpc('tools/call', { name: 'thesis_stamp', arguments: { id: FIXTURE_ID, status: 'PRE-REGISTERED' } }, 15_000);
  check('thesis_stamp refuses PRE-REGISTERED (isError)', badStamp.result?.isError === true);

  // lint-REJECT: a thesis missing frozen criteria / kill clause / derivatives / strata / prior-art → never registers
  const badThesis = { ...goodThesis, id: `${FIXTURE_ID}-BAD`, pass_criteria: [{ id: 'P1', description: 'it works', measurable: 'works', frozen: false }], kill_clause: '', derivative_predictions: [], prior_art: [], base_rates_domain: { strata: [], domain_of_validity: '', cross_stratum_reconciliation: '' } };
  const rej = await rpc('tools/call', { name: 'thesis_submit', arguments: { thesis: badThesis } }, 15_000);
  const rejj = toolJson(rej);
  check('thesis_submit REJECT does not register', rejj?.verdict === 'REJECT' && rejj?.registered === false, `${rejj?.verdict}/${rejj?.registered}`);
  check('thesis_submit REJECT cites >= 5 reasons', Array.isArray(rejj?.reasons) && rejj.reasons.length >= 5, `${rejj?.reasons?.length} reasons`);
  const rejGet = await rpc('tools/call', { name: 'thesis_get', arguments: { id: `${FIXTURE_ID}-BAD` } }, 15_000);
  check('rejected thesis is absent from the registry', toolJson(rejGet)?.found === false);

  const tl = await rpc('tools/call', { name: 'thesis_list', arguments: {} }, 15_000);
  const tlj = toolJson(tl);
  check('thesis_list shows exactly the one accepted thesis', tlj?.count === 1 && tlj?.theses?.[0]?.id === FIXTURE_ID, `count=${tlj?.count}`);

  // clean shutdown
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  try { fs.rmSync(THESIS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[smoke] ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.error('[smoke] RESULT: FAIL —', failed.map((c) => c.name).join('; ')); process.exit(1); }
  console.log('[smoke] RESULT: PASS — sacred M66 numbers + a >10KB widget PNG both round-tripped through MCP');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke] ERROR:', e && e.message ? e.message : e); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
