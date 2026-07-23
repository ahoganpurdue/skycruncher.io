// Shared driver for SkyCruncher wizard E2E scenarios (raw Playwright library).
// Usage: import { createRun } from './lib.mjs' — see run_wizard_seestar.mjs.
//
// Design notes:
// - Server policy (see serverAction / mayKillPort below): REUSES a dev server
//   already listening on the target port; otherwise spawns `npx vite --port
//   <PORT> --strictPort` and taskkills that spawned tree on exit (Windows).
//   EXCEPTION — port 3005 is the OWNER'S reserved manual instance (CLAUDE.md
//   e2e trap; the prewarm hook warms it with killPolicy 'never'): the harness
//   may ATTACH to a listening 3005 but will NEVER spawn a server on it and
//   NEVER taskkill it. Agents set E2E_PORT=3199 (shared prewarmed) or a fresh
//   dedicated port.
// - Launches system Chrome (channel:'chrome') — Playwright-managed browsers
//   are not installed in this environment. Override: E2E_BROWSER_CHANNEL.
// - Hermetic: every http(s) request to a host other than the dev-server origin
//   (127.0.0.1/localhost/[::1]:<PORT>) is aborted and logged. The FITS flow
//   needs no network (SITELAT/SITELONG in header; atlas/WASM are same-origin).
// - Artifacts: test_results/e2e/<timestamp>/ (gitignored) — console log,
//   per-step screenshots, summary.json.

import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// E2E_PORT lets scenarios (and concurrent agents) run on separate dev servers
// instead of knife-fighting over one port ("just open other ports" — owner).
// When unset it defaults to 3005, the owner's reserved manual instance — which
// is safe ONLY because we attach-never-spawn/kill it (the prewarm hook keeps it
// warm). Agents should set E2E_PORT=3199 for a dedicated server.
export const RESERVED_OWNER_PORT = 3005; // owner's manual vite: bind-NEVER, kill-NEVER for agents
const PORT_EXPLICIT = process.env.E2E_PORT != null && process.env.E2E_PORT !== '';
const PORT = parseInt(process.env.E2E_PORT ?? String(RESERVED_OWNER_PORT), 10);
// 127.0.0.1 EXPLICITLY: Node's fetch resolves `localhost` IPv6-first on this
// box while our spawned vite binds IPv4-only — probing `localhost` declared
// two perfectly healthy servers dead (90s timeout each). Chromium is equally
// happy with the literal address.
const BASE = `http://127.0.0.1:${PORT}`;

// --- Server policy (pure, unit-tested in port_guard.test.mjs) ---------------
// Decide what to do about the dev server from the resolved port, whether
// E2E_PORT was set explicitly, and whether something is already listening.
// The owner's reserved port 3005 is attach-OK but spawn-NEVER / kill-NEVER
// (CLAUDE.md e2e trap). Pure + injectable so the guard is testable without
// binding or spawning the real reserved port.
export function serverAction({ port, explicit, listening }) {
    const reserved = port === RESERVED_OWNER_PORT;
    if (listening) {
        // Attaching to an already-live server is always safe — including the
        // owner's 3005 (the prewarm hook warms it FOR us). Warn loudly when we
        // landed there only because E2E_PORT was left unset (silent default).
        return { action: 'reuse', reserved, silentDefault: reserved && !explicit };
    }
    if (reserved) {
        // Nothing listening on the owner's reserved port — REFUSE to spawn one.
        return {
            action: 'refuse',
            reserved,
            reason:
                `refusing to spawn a dev server on port ${RESERVED_OWNER_PORT}: it is the ` +
                `owner's reserved manual instance (bind-NEVER / kill-NEVER for agents). ` +
                `Set E2E_PORT=3199 (shared prewarmed) or a fresh dedicated port, then retry. ` +
                `If 3005 should be warm, start it via the prewarm hook, not this harness.`,
        };
    }
    return { action: 'spawn', reserved };
}

// The owner's reserved port must never be taskkilled by an agent harness.
export function mayKillPort(port) {
    return port !== RESERVED_OWNER_PORT;
}

// --- Per-stage timing sidecar (efficiency review I1/I2) ---------------------
// The browser session's CaptureRecorder mirrors per-stage envelopes to
// `window.__SKYCRUNCHER_CAPTURE__[runId]` on run_finished. We read that mirror
// and project it to the SAME line shape the headless driver writes (canonical
// fold: src/engine/events/stage_timing_summary.ts — this is a thin projection
// over the ALREADY-PAIRED envelopes, not a re-implementation of that fold).
// Best-effort + fully guarded: a timing hiccup never fails the sacred e2e.
function e2eDecoderArm() {
    const v = process.env.VITE_DECODER_RAWLER;
    return (v === '0' || v === 'false') ? 'libraw' : 'rawler';   // mirrors isRawlerDecoderEnabled()
}

async function appendStageTimings(page, source, sourceFormat, ok) {
    try {
        const mirror = await page.evaluate(() => window.__SKYCRUNCHER_CAPTURE__ || null);
        if (!mirror) return;   // run never finished in-browser ⇒ nothing mirrored (honest-absent)
        const out = path.join(ROOT, 'test_results', 'perf', 'stage_timings.jsonl');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const decoderArm = e2eDecoderArm();
        for (const [runId, envs] of Object.entries(mirror)) {
            if (!Array.isArray(envs) || envs.length === 0) continue;
            const stages = {};
            let minStart = Infinity, maxEnd = -Infinity, n = 0, frameSha = null;
            for (const env of envs) {
                if (env.frame_sha != null) frameSha = env.frame_sha;   // last non-null wins
                if (!(env.stage_id in stages)) n++;
                stages[env.stage_id] = env.ms;
                if (env.t_start < minStart) minStart = env.t_start;
                if (env.t_end > maxEnd) maxEnd = env.t_end;
            }
            const total_ms = (n > 0 && isFinite(minStart) && isFinite(maxEnd)) ? maxEnd - minStart : null;
            const line = {
                ts: new Date().toISOString(), source,
                v: 1, run_id: runId, frame_sha: frameSha,
                source_format: sourceFormat ?? null, decoder_arm: decoderArm,
                ok: ok ?? null, n_stages: n, total_ms, stages,
            };
            fs.appendFileSync(out, JSON.stringify(line) + '\n');
        }
    } catch { /* instrumentation must never fail the run */ }
}

async function probe(url, ms = 2000) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        const res = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        return res.ok;
    } catch { return false; }
}

async function ensureServer(log) {
    // Probe both address families — an externally-started vite may listen
    // on ::1 only while a harness-spawned one is pinned to 127.0.0.1.
    // NOTE: page.goto uses BASE (127.0.0.1) — an ::1-only server is reusable
    // by Chromium only via localhost, so route BASE accordingly.
    const listenFamily = (await probe(BASE)) ? 'v4'
        : (await probe(`http://[::1]:${PORT}/`)) ? 'v6'
            : null;
    const decision = serverAction({ port: PORT, explicit: PORT_EXPLICIT, listening: !!listenFamily });

    if (decision.action === 'reuse') {
        if (decision.silentDefault) {
            // Unmissable: an agent forgot E2E_PORT and landed on the owner's port.
            process.stderr.write(
                `\n[server] WARNING: E2E_PORT unset — attaching to the OWNER'S reserved port ` +
                `${RESERVED_OWNER_PORT}. This server is bind-NEVER/kill-NEVER for agents; the harness ` +
                `will NOT spawn or kill it. Set E2E_PORT=3199 for a dedicated agent server.\n\n`);
        } else if (decision.reserved) {
            log(`[server] note: reusing the owner's reserved port ${RESERVED_OWNER_PORT} — will not spawn or kill it`);
        }
        if (listenFamily === 'v6') {
            log(`[server] reusing IPv6-bound dev server on :${PORT}`);
            return { proc: null, ipv6Only: true };
        }
        log(`[server] reusing dev server on 127.0.0.1:${PORT}`);
        return { proc: null };
    }

    if (decision.action === 'refuse') {
        throw new Error(`[server] ${decision.reason}`);
    }

    // action === 'spawn' — a non-reserved port with nothing listening.
    // --host 127.0.0.1: vite's plain-`localhost` binding is family-flaky on
    // Windows (sometimes IPv6-only), which makes probes/goto nondeterministic.
    log(`[server] spawning: npx vite --port ${PORT} --strictPort --host 127.0.0.1`);
    const out = fs.createWriteStream(path.join(ROOT, 'test_results', 'e2e', 'vite_server.log'), { flags: 'a' });
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
        cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(out); proc.stderr.pipe(out);
    for (let i = 0; i < 90; i++) {
        if (await probe(BASE, 1000)) { log(`[server] up after ~${i + 1}s`); return { proc }; }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`dev server did not come up on :${PORT} within 90s (see vite_server.log)`);
}

function killServer(proc, log) {
    if (!proc) return;
    // Defensive belt-and-suspenders: we never spawn on the reserved owner port
    // (ensureServer refuses), so `proc` is always null on that path — but never
    // taskkill it even if a future edit regresses that guarantee.
    if (!mayKillPort(PORT)) {
        log(`[server] refusing to taskkill on reserved owner port ${PORT} (kill-NEVER)`);
        return;
    }
    try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        log('[server] spawned dev server killed');
    } catch (e) { log(`[server] taskkill failed: ${e.message}`); }
}

export async function createRun(scenarioName) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(ROOT, 'test_results', 'e2e', `${scenarioName}_${stamp}`);
    fs.mkdirSync(dir, { recursive: true });

    const consolePath = path.join(dir, 'console.log.txt');
    const consoleStream = fs.createWriteStream(consolePath);
    const summary = { scenario: scenarioName, started: new Date().toISOString(), steps: [], pageErrors: [], blockedRequests: [], pass: false };

    const log = (line) => {
        const msg = `${new Date().toISOString().slice(11, 23)} ${line}`;
        console.log(msg);
        consoleStream.write(msg + '\n');
    };

    const { proc, ipv6Only } = await ensureServer(log);
    // Chromium resolves `localhost` across both families; use it only when
    // forced to (reusing an ::1-bound external server).
    const GOTO_BASE = ipv6Only ? `http://localhost:${PORT}` : BASE;
    const sameOrigin = (url) => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}/`).test(url + '/');

    const browser = await chromium.launch({
        channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
        headless: process.env.E2E_HEADED ? false : true,
    });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });

    await context.route('**/*', (route) => {
        const url = route.request().url();
        if (sameOrigin(url) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        summary.blockedRequests.push(url);
        log(`[net] BLOCKED ${url}`);
        return route.abort();
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
        const line = `[browser:${msg.type()}] ${msg.text()}`;
        consoleStream.write(line + '\n');
        if (msg.type() === 'error' || msg.type() === 'warning') console.log(line);
    });
    page.on('pageerror', (err) => {
        summary.pageErrors.push(String(err));
        log(`[pageerror] ${err}`);
    });
    page.on('crash', () => { log('[FATAL] page crashed'); finish(false, 'page crash').then(() => process.exit(1)); });

    const shot = async (name) => {
        try { await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false }); }
        catch (e) { log(`[shot] failed ${name}: ${e.message}`); }
    };

    // Run fn with a wall-clock budget; record outcome in summary.steps.
    const step = async (name, budgetMs, fn) => {
        const t0 = Date.now();
        log(`[step] ${name} (budget ${budgetMs / 1000}s)`);
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`step budget ${budgetMs}ms exceeded`)), budgetMs)),
            ]);
            const ms = Date.now() - t0;
            summary.steps.push({ name, ok: true, ms });
            log(`[step] ${name} OK in ${(ms / 1000).toFixed(1)}s`);
            await shot(name.replace(/[^\w]+/g, '_'));
            return result;
        } catch (e) {
            const ms = Date.now() - t0;
            summary.steps.push({ name, ok: false, ms, error: String(e && e.message || e) });
            log(`[step] ${name} FAILED after ${(ms / 1000).toFixed(1)}s: ${e && e.message || e}`);
            await shot(`FAIL_${name.replace(/[^\w]+/g, '_')}`);
            throw e;
        }
    };

    // Scalar-only snapshot of the dev-exposed OrchestratorSession.
    const sessionSnapshot = () => page.evaluate(() => {
        const s = window.__astroSession;
        if (!s) return null;
        const sol = s.solution ? {
            ra: s.solution.ra, dec: s.solution.dec,
            ra_hours: s.solution.ra_hours, dec_degrees: s.solution.dec_degrees,
            pixel_scale: s.solution.pixel_scale, rotation: s.solution.rotation,
            parity: s.solution.parity, confidence: s.solution.confidence,
            num_stars: s.solution.num_stars,
            matched: s.solution.matched_stars ? s.solution.matched_stars.length : null,
            spatial_hash: s.solution.spatial_hash,
        } : null;
        return {
            status: s.status, state: s.state, sourceFormat: s.sourceFormat,
            scaleLock: s.scaleLock,
            metadata: s.metadata ? {
                camera_model: s.metadata.camera_model, focal_length: s.metadata.focal_length,
                pixel_scale: s.metadata.pixel_scale, ra_hint: s.metadata.ra_hint,
                dec_hint: s.metadata.dec_hint, gps_source: s.metadata.gps_source,
                gps_lat: s.metadata.gps_lat, gps_lon: s.metadata.gps_lon,
            } : null,
            signalStars: s.signal && s.signal.clean_stars ? s.signal.clean_stars.length : null,
            computed_jd: s.environment ? s.environment.computed_jd : undefined,
            solution: sol,
        };
    });

    const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };
    const assertRange = (val, lo, hi, label) => {
        assert(typeof val === 'number' && isFinite(val) && val >= lo && val <= hi,
            `${label}=${val} not in [${lo}, ${hi}]`);
        log(`[assert] ${label}=${val} in [${lo}, ${hi}] OK`);
    };

    async function finish(pass, note) {
        summary.pass = pass;
        summary.finished = new Date().toISOString();
        if (note) summary.note = note;
        try { summary.finalSession = await sessionSnapshot(); } catch { /* page may be gone */ }
        // Per-stage timing sidecar (I1/I2) — read the browser capture mirror
        // while the page is still open; guarded so it never flips the verdict.
        await appendStageTimings(page, `e2e:${scenarioName}`, summary.finalSession?.sourceFormat, pass);
        fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
        log(`[run] ${pass ? 'PASS' : 'FAIL'} — artifacts: ${dir}`);
        consoleStream.end();
        try { await browser.close(); } catch { }
        killServer(proc, (m) => console.log(m));
        return dir;
    }

    return { page, context, log, step, shot, sessionSnapshot, assert, assertRange, finish, summary, dir, BASE: GOTO_BASE };
}
