// DESKTOP TEST RAIL v0 — Node runner (branch rail/desktop-v0, NEVER merges).
//
// Drives the REAL Tauri app headless-ish: spawns `tauri dev` with a dedicated
// config variant (tauri.testrail.conf.json → window boots at #/testrail on a
// private vite port), waits for the self-driving webview host (webview/TestRailHost
// .tsx) to run BOTH legs and stream results as `RAIL|` lines to tauri-dev stdout,
// reassembles the chunked payloads, writes REPORT + verdicts, and kills every child
// process by PID on exit.
//
//   LEG 1 app-solve : solveViaGreenfield on banked M66 → solved_via=greenfield_rust
//                     + pinned decision core (scale 3.679184978895153, matches 265).
//   LEG 2 native-gpu: invoke('demosaic_native') on RGGB fixtures → ULP parity vs CPU
//                     + browser-WebGPU (same methodology as tools/gpu_parity).
//
// Rerun (one command, given a built app; cold build ~10-15 min the first time):
//   node tools/desktop_rail/run_rail.mjs
// The runner captures the MSVC dev environment itself (cargo/link.exe), so it does
// NOT need to be launched from a VS developer shell.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');            // worktree root
const FIX_DIR = path.join(HERE, 'fixtures');
const OUT_DIR = path.join(ROOT, 'test_results', 'desktop_rail_2026-07-21');
const TMP_PUBLIC = path.join(ROOT, 'public', '__testrail_tmp');
const CONFIG = path.join(ROOT, 'src-tauri', 'tauri.testrail.conf.json');
const RUN_LOG = path.join(OUT_DIR, 'tauri_dev.log');

const M66_DETECTIONS = 'D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_DSO_Stacked_738_M_66_60.0s_20260516_064736.fit_31500.json';
const QUADIDX_DIR = process.env.SKYCRUNCHER_QUADIDX_DIR || 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u';
const VCVARS = 'C:/Program Files/Microsoft Visual Studio/18/Insiders/VC/Auxiliary/Build/vcvars64.bat';
const CARGO_BIN = 'C:/Users/ahoga/.cargo/bin';
const PORT = 3260;
const OVERALL_TIMEOUT_MS = 20 * 60 * 1000; // absorbs a cold Rust build on a fresh target/

const log = (m) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── MSVC dev environment (LIB/INCLUDE/PATH for cargo + link.exe) ────────────────
function getMsvcEnv() {
    if (!fs.existsSync(VCVARS)) { log(`[env] WARN vcvars64 not found at ${VCVARS}; using inherited env`); return { ...process.env }; }
    log('[env] capturing MSVC dev environment via vcvars64…');
    // Proven pattern (mirrors the warm-build .cmd): a generated batch that sources
    // vcvars64 then dumps `set`, run via cmd. Avoids nested-quote fragility of an
    // inline `execSync(..., {shell:'cmd.exe'})` compound command.
    const capCmd = path.join(os.tmpdir(), `testrail_envcap_${process.pid}.cmd`);
    fs.writeFileSync(capCmd, `@echo off\r\ncall "${VCVARS.replace(/\//g, '\\')}" >nul 2>&1\r\nset\r\n`);
    let out = '';
    try {
        out = execSync(`"${capCmd}"`, { shell: true, encoding: 'utf8', maxBuffer: 1 << 24 });
    } finally {
        try { fs.rmSync(capCmd, { force: true }); } catch { /* ignore */ }
    }
    const env = {};
    for (const line of out.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!env.LIB || !env.INCLUDE) log('[env] WARN LIB/INCLUDE not captured — cargo link may fail');
    return env;
}

// ── asset staging (vite serves public/__testrail_tmp/ to the webview) ───────────
function ensureFixtures() {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'manifest.json'), 'utf8'));
    let missing = false;
    for (const f of manifest.fixtures) if (!fs.existsSync(path.join(FIX_DIR, f.file))) missing = true;
    if (missing) {
        log('[fixtures] regenerating (deterministic seed 0x5C0FFEE1)…');
        execSync(`node "${path.join(FIX_DIR, 'gen_fixtures.mjs')}"`, { cwd: ROOT, stdio: 'inherit' });
    }
    return manifest;
}
function stageAssets(manifest) {
    fs.rmSync(TMP_PUBLIC, { recursive: true, force: true });
    fs.mkdirSync(TMP_PUBLIC, { recursive: true });
    for (const f of manifest.fixtures) fs.copyFileSync(path.join(FIX_DIR, f.file), path.join(TMP_PUBLIC, f.file));
    if (!fs.existsSync(M66_DETECTIONS)) throw new Error(`banked M66 detections absent: ${M66_DETECTIONS}`);
    fs.copyFileSync(M66_DETECTIONS, path.join(TMP_PUBLIC, 'M66_detections.json'));
    log(`[stage] fixtures + M66 detections -> ${TMP_PUBLIC}`);
}
function cleanupAssets() {
    try { fs.rmSync(TMP_PUBLIC, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── process teardown ────────────────────────────────────────────────────────────
function killTree(pid) {
    if (!pid) return;
    try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); log(`[kill] taskkill tree pid ${pid}`); }
    catch (e) { log(`[kill] taskkill pid ${pid} failed: ${e.message}`); }
}
function killByPort(port) {
    try {
        const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
        const pids = new Set();
        for (const line of out.split(/\r?\n/)) {
            if (line.includes(`:${port} `) && /LISTENING/.test(line)) {
                const m = line.trim().split(/\s+/); const pid = m[m.length - 1];
                if (/^\d+$/.test(pid)) pids.add(pid);
            }
        }
        for (const pid of pids) { try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); log(`[kill] port ${port} pid ${pid}`); } catch { /* ignore */ } }
    } catch { /* ignore */ }
}

// ── payload reassembly (P|kind|i|n|b64) ─────────────────────────────────────────
const chunks = new Map(); // kind -> { n, parts: [] }
const payloads = {};
const sentinels = [];
function ingestRailLine(rest) {
    // rest = everything after "RAIL|"
    if (rest.startsWith('P|')) {
        const firstBar = rest.indexOf('|', 2);
        const secondBar = rest.indexOf('|', firstBar + 1);
        const thirdBar = rest.indexOf('|', secondBar + 1);
        if (firstBar < 0 || secondBar < 0 || thirdBar < 0) return;
        const kind = rest.slice(2, firstBar);
        const i = parseInt(rest.slice(firstBar + 1, secondBar), 10);
        const n = parseInt(rest.slice(secondBar + 1, thirdBar), 10);
        const b64 = rest.slice(thirdBar + 1);
        let rec = chunks.get(kind);
        if (!rec) { rec = { n, parts: new Array(n).fill(null) }; chunks.set(kind, rec); }
        rec.parts[i] = b64;
        if (rec.parts.every((p) => p !== null)) {
            try { payloads[kind] = JSON.parse(Buffer.from(rec.parts.join(''), 'base64').toString('utf8')); }
            catch (e) { log(`[parse] payload ${kind} decode failed: ${e.message}`); }
        }
    } else {
        sentinels.push(rest);
        log(`[rail] ${rest}`);
    }
}

// ── report writers ──────────────────────────────────────────────────────────────
function fmt(n) { return n === null || n === undefined ? 'NOT MEASURED' : (typeof n === 'number' ? n : String(n)); }
function writeReports(manifest, meta) {
    // results.json — every reassembled payload + run metadata.
    const results = { generated_utc: new Date().toISOString(), ...meta, payloads };
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

    // Full M66 receipt (banked).
    if (payloads.receipt) fs.writeFileSync(path.join(OUT_DIR, 'receipt_M66.json'), JSON.stringify(payloads.receipt, null, 2));

    // ── verdicts ──
    const app = payloads.appsolve ?? { pass: false, error: 'no appsolve payload (rail did not reach LEG1 completion)' };
    fs.writeFileSync(path.join(OUT_DIR, 'verdict_app_solve.json'), JSON.stringify(app, null, 2));

    const nativeFixtures = manifest.fixtures.map((f) => payloads[`native.${f.name}`]).filter(Boolean);
    const nativeVerdict = {
        leg: 'native_gpu',
        adapter: payloads.adapter ?? null,
        note: 'Native wgpu demosaic (demosaic_bayer_param.wgsl with Canon-RGGB DEFAULT params — the SAME shader the browser path runs) vs CPU (demosaicBilinear) and browser-WebGPU. First parity evidence for the native shader.',
        fixtures: nativeFixtures.map((fx) => ({
            name: fx.name,
            native_compared: fx.native_compared === true,
            native_error: fx.native_error ?? null,
            native_raw_stats: fx.native_raw_stats ?? null,
            native_looks_usable: fx.native_looks_usable ?? null,
            browser_gpu_used: fx.browser_gpu_used ?? null,
            native_vs_cpu: fx.native_vs_cpu ? summarizeCmp(fx.native_vs_cpu) : null,
            native_vs_browsergpu: fx.native_vs_browsergpu ? summarizeCmp(fx.native_vs_browsergpu) : null,
            browsergpu_vs_cpu_crosscheck: fx.browsergpu_vs_cpu ? summarizeCmp(fx.browsergpu_vs_cpu) : null,
        })),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'verdict_native_gpu.json'), JSON.stringify(nativeVerdict, null, 2));

    // ── REPORT.md ──
    const L = [];
    L.push('# Desktop Test Rail v0 — REPORT');
    L.push('');
    L.push(`- generated: ${new Date().toISOString()}`);
    L.push(`- branch: rail/desktop-v0 · base main @${meta.base_commit ?? '?'}`);
    L.push(`- config: src-tauri/tauri.testrail.conf.json (vite :${PORT}, window #/testrail)`);
    L.push(`- quad index: ${QUADIDX_DIR}`);
    L.push(`- adapter: ${JSON.stringify(payloads.adapter ?? 'NOT MEASURED')}`);
    L.push('');
    L.push('## LEG 1 — app-solve (real webview → Rust greenfield seam)');
    L.push('');
    L.push(`VERDICT: **${app.pass ? 'PASS' : 'FAIL'}**`);
    if (app.observed) {
        const o = app.observed, e = app.expected;
        L.push('');
        L.push('| field | observed | expected |');
        L.push('|---|---|---|');
        L.push(`| solved_via | ${fmt(o.solved_via)} | ${e.solved_via} |`);
        L.push(`| state | ${fmt(o.state)} | ${e.state} |`);
        L.push(`| scale (arcsec/px) | ${fmt(o.scale)} | ${e.scale} |`);
        L.push(`| matches | ${fmt(o.matches)} | ${e.matches} |`);
        L.push(`| ra_deg | ${fmt(o.ra_deg)} | ${e.ra_deg} |`);
        L.push(`| dec_deg | ${fmt(o.dec_deg)} | ${e.dec_deg} |`);
        L.push(`| receipt wall_ms | ${fmt(o.receipt_wall_ms)} | — |`);
        L.push('');
        L.push(`- detections submitted: ${fmt(app.n_detections_submitted)}`);
        L.push(`- decision_digest: ${fmt(app.decision_digest)}`);
        L.push(`- checks: ${JSON.stringify(app.checks)}`);
    } else if (app.error) {
        L.push('');
        L.push('```');
        L.push(String(app.error).slice(0, 2000));
        L.push('```');
    }
    L.push('');
    L.push('## LEG 2 — native GPU demosaic parity (first evidence for the native shader)');
    L.push('');
    L.push('Native = `demosaic_bayer_param.wgsl` with Canon-RGGB DEFAULT params (the SAME shader the browser path runs), invoked via `demosaic_native`.');
    L.push('CPU = `DemosaicEngine.demosaicBilinear` (f64 intermediate). Browser-GPU = `demosaic_bayer_param.wgsl` via `demosaicWebGPU` (f32).');
    L.push('Native output is interleaved RGB (w·h·3) — same shape as CPU/browser-GPU; compared directly (no alpha drop) with the tools/gpu_parity ULP methodology.');
    L.push('');
    for (const fx of nativeVerdict.fixtures) {
        L.push(`### ${fx.name}`);
        L.push(`- native invoke: ${fx.native_error ? `**ERRORED** — ${fx.native_error}` : (fx.native_compared ? 'returned data' : 'no comparable data')}`);
        if (fx.native_raw_stats) L.push(`- native raw f32: len=${fx.native_raw_stats.len} finite=${fx.native_raw_stats.finite} zero=${fx.native_raw_stats.zero} nan=${fx.native_raw_stats.nan} min=${fmt(fx.native_raw_stats.min)} max=${fmt(fx.native_raw_stats.max)}`);
        L.push(`- browser WebGPU dispatched: ${fmt(fx.browser_gpu_used)}`);
        if (fx.native_vs_cpu) L.push(`- **native vs CPU**: maxUlp=${fx.native_vs_cpu.max_ulp} maxUlp(small)=${fx.native_vs_cpu.max_ulp_small_region} differ%=${fx.native_vs_cpu.interior_pct_differ_any} ulp1%=${fx.native_vs_cpu.interior_pct_ulp_eq_1} maxAbs=${fx.native_vs_cpu.max_abs_diff}`);
        if (fx.native_vs_browsergpu) L.push(`- **native vs browser-GPU**: maxUlp=${fx.native_vs_browsergpu.max_ulp} maxUlp(small)=${fx.native_vs_browsergpu.max_ulp_small_region} differ%=${fx.native_vs_browsergpu.interior_pct_differ_any} ulp1%=${fx.native_vs_browsergpu.interior_pct_ulp_eq_1} maxAbs=${fx.native_vs_browsergpu.max_abs_diff}`);
        if (fx.browsergpu_vs_cpu_crosscheck) L.push(`- browser-GPU vs CPU (cross-check vs banked): differ%=${fx.browsergpu_vs_cpu_crosscheck.interior_pct_differ_any} ulp1%=${fx.browsergpu_vs_cpu_crosscheck.interior_pct_ulp_eq_1} maxUlp(small)=${fx.browsergpu_vs_cpu_crosscheck.max_ulp_small_region}`);
        L.push('');
    }
    L.push('## Files');
    L.push('- results.json — all reassembled payloads + run metadata');
    L.push('- verdict_app_solve.json / verdict_native_gpu.json — machine-readable verdicts');
    L.push('- receipt_M66.json — full greenfield receipt from the app-solve leg');
    L.push('- tauri_dev.log — raw tauri-dev stdout/stderr');
    fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), L.join('\n'));
    log(`[out] REPORT.md + verdicts + results.json -> ${OUT_DIR}`);
}
function summarizeCmp(c) {
    return {
        max_ulp: c.max_ulp, max_ulp_small_region: c.max_ulp_small_region, max_abs_diff: c.max_abs_diff,
        interior_pct_differ_any: c.interior_pct_differ_any, interior_pct_ulp_eq_1: c.interior_pct_ulp_eq_1,
        interior_pct_pixels_differ: c.interior_pct_pixels_differ, nan_count: c.nan_count,
        ulp_histogram_interior_all: c.ulp_histogram_interior?.all,
    };
}

// ── main ────────────────────────────────────────────────────────────────────────
let child = null;
let finished = false;
const logStream = fs.createWriteStream(RUN_LOG, { flags: 'w' });

function finalizeAndExit(code, manifest, meta) {
    if (finished) return;
    finished = true;
    try { writeReports(manifest, meta); } catch (e) { log(`[report] FAILED: ${e.stack || e}`); }
    try { logStream.end(); } catch { /* ignore */ }
    if (child) killTree(child.pid);
    killByPort(PORT);
    cleanupAssets();
    const appPass = payloads.appsolve?.pass === true;
    const nativeReached = manifest.fixtures.every((f) => payloads[`native.${f.name}`]);
    log(`[done] app_solve=${appPass ? 'PASS' : 'FAIL'} native_leg_reached=${nativeReached} sentinelDONE=${sentinels.includes('DONE')}`);
    process.exit(code);
}

async function main() {
    let baseCommit = '?';
    try { baseCommit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* ignore */ }
    const meta = { base_commit: baseCommit, port: PORT, quadidx_dir: QUADIDX_DIR };

    const manifest = ensureFixtures();
    stageAssets(manifest);

    const env = getMsvcEnv();
    // Normalize PATH: Windows may present it as 'Path'; setting a second 'PATH' key
    // leaves two conflicting entries (undefined which wins). Collapse to one 'Path'.
    let existingPath = '';
    for (const k of Object.keys(env)) { if (k.toLowerCase() === 'path') { existingPath = env[k]; delete env[k]; } }
    env.Path = `${CARGO_BIN};${existingPath}`;
    env.SKYCRUNCHER_QUADIDX_DIR = QUADIDX_DIR;
    env.RUST_BACKTRACE = '1';
    // Force greenfield seam ON (desktop default) and rawler decoder default; explicit for clarity.
    delete env.VITE_SOLVER_GREENFIELD;

    log(`[spawn] npm run tauri -- dev -c ${CONFIG} (cold Rust build may take 10-15 min the first time)`);
    // npm run (not npx) resolves the local tauri binary deterministically with no
    // install prompt. shell:true → cmd is the child; taskkill /T on its pid cascades
    // to tauri, cargo, the app binary + WebView2, and vite.
    child = spawn('npm', ['run', 'tauri', '--', 'dev', '-c', CONFIG], { cwd: ROOT, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });

    // Line-buffer: a single stdout 'data' event can split a base64 chunk line, which
    // would corrupt payload reassembly. Accumulate and only process complete lines.
    let stdoutBuf = '';
    const processLine = (rawline) => {
        const idx = rawline.indexOf('RAIL|');
        if (idx >= 0) {
            const rest = rawline.slice(idx + 5);
            ingestRailLine(rest);
            if (rest.trim() === 'DONE') {
                log('[rail] DONE sentinel — finalizing');
                setTimeout(() => finalizeAndExit(0, manifest, meta), 800); // let trailing chunks flush
            }
        } else if (/panicked|error\[|link\.exe.*failed|E_INDEX|E_SOLVE|E_QUADIDX/i.test(rawline)) {
            log(`[tauri] ${rawline.trim().slice(0, 300)}`);
        }
    };
    const onData = (buf) => {
        const text = buf.toString();
        logStream.write(text);
        stdoutBuf += text;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) processLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
        log(`[tauri] process exited code=${code}`);
        if (!finished) setTimeout(() => finalizeAndExit(code ?? 1, manifest, meta), 1000);
    });

    setTimeout(() => { if (!finished) { log('[timeout] overall timeout reached'); finalizeAndExit(2, manifest, meta); } }, OVERALL_TIMEOUT_MS);
    process.on('SIGINT', () => finalizeAndExit(130, manifest, meta));
    process.on('SIGTERM', () => finalizeAndExit(143, manifest, meta));
}

main().catch((e) => { log(`[FATAL] ${e.stack || e}`); if (child) killTree(child.pid); killByPort(PORT); cleanupAssets(); process.exit(1); });
