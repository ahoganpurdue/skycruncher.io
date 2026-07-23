#!/usr/bin/env node
// tools/intake/alpaca/alpaca_watcher.mjs
// ─────────────────────────────────────────────────────────────────────────────
// LIVE-SESSION FRAME WATCHER for a ZWO Seestar over ASCOM Alpaca (LAN, Station
// mode). Connects the telephoto Camera device, then repeatedly acquires frames
// during an observing session, writing each as a FITS into the D:\AstroLogic\intake
// layout, appending an idempotent per-session JOURNAL (JSONL), and — with
// --enqueue — dropping each frame into the Solve Queue's Intake Folder lane so the
// queue solves them one at a time.
//
// TWO ACQUISITION MODES:
//   drive (default) — the watcher IS the controller: startexposure → poll
//                     imageready → download → repeat. Single-controller safe
//                     (do NOT run the Seestar phone app concurrently).
//   --watch         — passive: never commands an exposure, just polls imageready
//                     and downloads each NEW frame as it appears (device driven
//                     elsewhere). Deduplicates on the frame's ServerTransactionID.
//
// GUARANTEES:
//   • IDEMPOTENT   — re-running the same --session-id resumes the sequence, never
//                    re-downloads a known frame id, never clobbers an existing file.
//   • RESILIENT    — a device that vanishes mid-session (dropped WiFi, powered off)
//                    is retried with bounded backoff; the watcher LOGS and keeps
//                    going, never crashes, records honest failed-frame rows.
//   • HONEST       — pointing/exposure metadata is emitted only when the device
//                    actually returns it; unmeasured fields are simply absent (LAW 3).
//   • STORAGE LAW  — writes ONLY under D:\AstroLogic\intake by default (never K:).
//
// Reuses the vetted Alpaca client (tools/seestar/lib.mjs), the FITS writer
// (tools/stack/fits_io.mjs), and the image codec (./alpaca_image.mjs).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  alpacaApi, alpacaValue, alpacaDiscover, retryWithBackoff, isTransientError,
} from '../../seestar/lib.mjs';
import { parseImageBytes, parseImageArray } from './alpaca_image.mjs';
import { writeFitsPlanar } from '../../stack/fits_io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_OUT_DIR = 'D:\\AstroLogic\\intake';               // STORAGE LAW: never K:
const DEFAULT_ENQUEUE_DIR = path.join(REPO_ROOT, 'Sample Files', 'rotating'); // queue's default Intake Folder lane
const TELE_CAM = 0;                                             // telephoto camera/0 only (never camera/1 wide)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Binary GET (imagebytes). lib.mjs only exposes a text client, so the watcher
// carries its own binary fetch; never throws → { ok, status, contentType, buf, error }.
function httpGetBinary(ip, port, pth, headers, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: pth, timeout: timeoutMs, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, contentType: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

// Discover a device, or take an explicit host. Returns ip | null (honest absence).
export async function resolveHost({ host, timeoutMs = 1200, log = console } = {}) {
  if (host) return host;
  const hits = await alpacaDiscover(timeoutMs);
  if (hits.length) { log.error?.(`(discovered ${hits[0].address} via Alpaca UDP)`); return hits[0].address; }
  return null;
}

/**
 * Run the watcher. Returns a summary object once maxFrames / durationS / a stop
 * signal is reached. Never throws on device transport failure (resilience is the
 * whole point) — only argument/programmer errors throw.
 */
export async function runWatcher(opts = {}) {
  const {
    host, alpacaPort = 32323, camera = TELE_CAM,
    outDir = DEFAULT_OUT_DIR,
    sessionId = `alpaca_${new Date().toISOString().replace(/[:.]/g, '-')}`,
    exposureS = 10, intervalS = 0, maxFrames = Infinity, durationS = Infinity,
    watch = false,                    // passive mode (do not command exposures)
    enqueue = false, enqueueDir = DEFAULT_ENQUEUE_DIR,
    pollMs = 1000, readyTimeoutS = null,
    retries = 5, retryBaseMs = 500,
    dryRun = false, log = console, stopSignal = null, onFrame = null,
  } = opts;

  if (!host) throw new Error('runWatcher: host is required (call resolveHost first, or pass --host)');

  const sessionDir = path.join(outDir, sessionId);
  const journalPath = path.join(sessionDir, 'session.jsonl');
  const summary = {
    session_id: sessionId, host, alpaca_port: alpacaPort, camera, mode: watch ? 'watch' : 'drive',
    out_dir: sessionDir, journal: journalPath, enqueue: !!enqueue, enqueue_dir: enqueue ? enqueueDir : null,
    frames: 0, duplicates: 0, failures: 0, transient_retries: 0, started_utc: new Date().toISOString(),
  };

  // ── Idempotent resume: recover the sequence counter + already-downloaded ids ──
  const seen = new Set();
  let seq = 0;
  if (fs.existsSync(journalPath)) {
    for (const line of fs.readFileSync(journalPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.event === 'frame' && row.status === 'ok') {
        if (row.frame_id != null) seen.add(String(row.frame_id));
        if (Number.isInteger(row.seq)) seq = Math.max(seq, row.seq + 1);
      }
    }
    if (seen.size) log.error?.(`(resume: ${seen.size} frame(s) already journaled in ${sessionId}; sequence continues at ${seq})`);
  }

  if (dryRun) {
    log.log?.(`DRY-RUN — would ${watch ? 'watch' : 'drive'} camera/${camera} @ ${host}:${alpacaPort}, write FITS → ${sessionDir}` +
      (enqueue ? `, enqueue → ${enqueueDir}` : '') + `, exposure ${exposureS}s, maxFrames ${maxFrames}`);
    summary.dry_run = true; summary.ended_utc = new Date().toISOString();
    return summary;
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  if (enqueue) fs.mkdirSync(enqueueDir, { recursive: true });
  appendJournal(journalPath, { event: 'session_start', ...pick(summary, ['session_id', 'host', 'alpaca_port', 'camera', 'mode']), ts: new Date().toISOString() });

  // Retry wrappers (transient-only; device ASCOM errors surface immediately).
  const retryCfg = {
    retries, baseMs: retryBaseMs, factor: 2, maxMs: 8000,
    isRetryable: (r) => { const v = alpacaValue(r); return v.error != null && isTransientError(v.error); },
    onRetry: (n, delay, e) => { summary.transient_retries++; log.error?.(`  [retry ${n}/${retries}] transient (${errStr(e)}); backoff ${delay}ms …`); },
  };
  const camGet = async (m, p = {}) => alpacaValue(await retryWithBackoff(() => alpacaApi(host, alpacaPort, 'GET', 'camera', camera, m, p), retryCfg));
  const camPut = async (m, p = {}) => alpacaValue(await retryWithBackoff(() => alpacaApi(host, alpacaPort, 'PUT', 'camera', camera, m, p), retryCfg));
  const teleGet = async (m) => alpacaValue(await alpacaApi(host, alpacaPort, 'GET', 'telescope', 0, m)); // best-effort, no retry (metadata only)

  // Connect the camera (best-effort; a transient blip retries).
  const conn = await camPut('connected', { Connected: true });
  if (conn.error) log.error?.(`camera/${camera} connect warn: ${conn.error} (will retry per-frame)`);

  // ── SCALE CARDS (once per session) ──────────────────────────────────────────
  // The plate-scale trio FOCALLEN/XPIXSZ/YPIXSZ is what the downstream stacker
  // registration (tools/stack/stack.mjs: 206.265·XPIXSZ/FOCALLEN) and the headless
  // solve's metrology stage (XPIXSZ/FOCALLEN → pixel_scale) read to avoid a slow
  // per-frame BLIND scale sweep. Without them a landed frame goes scale-blind.
  // HONESTY LADDER (LAW 3): pixel size is DEVICE-REPORTED when the Alpaca camera
  // surface exposes pixelsizex/y (microns); else the Seestar S30 Pro rig-profile
  // constant. Focal length is not an ASCOM property → always the rig-profile
  // constant (== demo FITS FOCALLEN=160 + sensor_db IMX585 body). Every card
  // carries a provenance comment; nothing is a bare fabricated number.
  const S30PRO_FOCALLEN_MM = 160;   // ZWO Seestar S30 Pro (rig profile; tools/synth/rig_profiles.mjs narrow_seestar)
  const S30PRO_PIXEL_UM = 2.9;      // Sony IMX585 pitch (src/…/sensor_db.ts IMX585.pixel_size_um)
  const pxxV = await camGet('pixelsizex'), pxyV = await camGet('pixelsizey');
  const pxxRep = finite(pxxV.value) && pxxV.value > 0, pxyRep = finite(pxyV.value) && pxyV.value > 0;
  const xpixsz = pxxRep ? pxxV.value : S30PRO_PIXEL_UM, ypixsz = pxyRep ? pxyV.value : S30PRO_PIXEL_UM;
  const scaleCards = [
    ['FOCALLEN', S30PRO_FOCALLEN_MM, 'mm (Seestar S30 Pro profile)'],
    ['XPIXSZ', xpixsz, pxxRep ? 'um (alpaca pixelsizex)' : 'um (S30 Pro profile)'],
    ['YPIXSZ', ypixsz, pxyRep ? 'um (alpaca pixelsizey)' : 'um (S30 Pro profile)'],
  ];
  log.error?.(`(scale cards: FOCALLEN=${S30PRO_FOCALLEN_MM}mm[profile] XPIXSZ=${xpixsz}um[${pxxRep ? 'alpaca' : 'profile'}] → ~${(206.265 * xpixsz / S30PRO_FOCALLEN_MM).toFixed(3)}"/px header prior)`);

  const deadline = Number.isFinite(durationS) ? Date.now() + durationS * 1000 : Infinity;
  const readyMs = (readyTimeoutS != null ? readyTimeoutS : Math.max(30, exposureS * 3)) * 1000;
  let consecutiveFailures = 0;

  while (summary.frames < maxFrames && Date.now() < deadline && !(stopSignal && stopSignal.stopped)) {
    // DRIVE mode commands the exposure; WATCH mode waits for one to appear.
    if (!watch) {
      const se = await camPut('startexposure', { Duration: exposureS, Light: true });
      if (se.error) { if (await handleFailure(`startexposure failed: ${se.error}`)) break; continue; }
    }

    // Wait for imageready (bounded); a persistent transport error ends this attempt.
    const readyBy = watch ? (Date.now() + pollMs * 3) : (Date.now() + readyMs);
    let ready = false, readyErr = null;
    while (Date.now() < readyBy && !(stopSignal && stopSignal.stopped)) {
      const r = await camGet('imageready');
      if (r.error) { readyErr = r.error; break; }
      if (r.value === true) { ready = true; break; }
      await sleep(pollMs);
    }
    if (!ready) {
      if (watch) { await sleep(pollMs); continue; }             // no frame yet — keep watching, not a failure
      if (await handleFailure(readyErr ? `imageready error: ${readyErr}` : 'imageready timeout')) break; continue;
    }

    // Fetch the frame: prefer binary imagebytes, fall back to imagearray JSON.
    let decoded = null, fetchErr = null;
    const qs = new URLSearchParams({ ClientID: '77', ClientTransactionID: String(Date.now() % 1e6) }).toString();
    const bin = await httpGetBinary(host, alpacaPort, `/api/v1/camera/${camera}/imagebytes?${qs}`, { Accept: 'application/imagebytes' });
    if (bin.ok && bin.buf && bin.buf.length > 44 && !/json/i.test(bin.contentType)) {
      try { decoded = parseImageBytes(bin.buf); } catch (e) { log.error?.(`imagebytes parse failed (${e.message}); trying imagearray`); }
    } else if (bin.error && isTransientError(bin.error)) {
      fetchErr = bin.error;                                     // transient — treated as a device blip below
    }
    if (!decoded && !fetchErr) {
      const arr = await alpacaApi(host, alpacaPort, 'GET', 'camera', camera, 'imagearray', {}, 180000);
      const v = alpacaValue(arr);
      if (v.error) fetchErr = v.error;
      else { try { decoded = parseImageArray(arr); } catch (e) { fetchErr = `imagearray parse: ${e.message}`; } }
    }
    if (!decoded) { if (await handleFailure(`frame fetch failed: ${fetchErr || 'unknown'}`)) break; continue; }

    const frameId = String(decoded.serverTxnId || `${sessionId}-${summary.frames}`);
    if (seen.has(frameId)) {
      summary.duplicates++;
      log.error?.(`  (duplicate frame id ${frameId} — already downloaded, skipping)`);
      if (watch) { await sleep(pollMs); continue; }             // watch mode: same frame lingers, keep polling
      // drive mode: a duplicate id means no genuinely new frame; avoid a hot loop
      await sleep(Math.max(pollMs, 250)); continue;
    }

    // Best-effort pointing/exposure metadata (honest-or-absent).
    const raV = await teleGet('rightascension'), decV = await teleGet('declination');
    const altV = await teleGet('altitude'), azV = await teleGet('azimuth');
    const dateObs = new Date().toISOString();

    // Never clobber an existing file: advance seq past any on-disk collision.
    let file, dest;
    do { file = `frame_${String(seq).padStart(4, '0')}.fits`; dest = path.join(sessionDir, file); if (fs.existsSync(dest)) seq++; } while (fs.existsSync(dest));

    const cards = [
      ['DATE-OBS', dateObs, 'UTC download time (frame ready)'],
      ['EXPTIME', exposureS, 'commanded exposure seconds'],
      ['INSTRUME', 'Seestar S30 Pro tele', `camera/${camera} telephoto`],
      ['TELESCOP', 'ZWO Seestar S30 Pro'],
      ['FRAMESRC', 'alpaca-watcher', 'ingest lane'],
      ['ALPSESS', sessionId, 'watcher session id'],
      ['ALPSEQ', seq, 'session frame sequence'],
      ['ALPFRAME', frameId, 'alpaca ServerTransactionID (frame identity)'],
      ['ELEMTYPE', decoded.elementType, 'alpaca image element type'],
      ...scaleCards,   // FOCALLEN/XPIXSZ/YPIXSZ — un-blind stacker + headless solve (see above)
    ];
    // Pointing: OBJCTRA/OBJCTDEC keep the device's native units (RA hours), AND a
    // GOTO pointing HINT as RA/DEC in DEGREES — the units both the stacker
    // (tools/stack/stack.mjs +cards.RA/15) and the headless engine
    // (m1_ingestion/fits_decoder.ts num('RA')/15) read to seed solveAtHint. Without
    // this hint the solve blind-sweeps the whole sky at the (now-known) scale and
    // stalls. RA-IN-HOURS TRAP: device rightascension is HOURS → ×15 for the deg card.
    if (finite(raV.value)) {
      cards.push(['OBJCTRA', raV.value, 'device RA hours']);
      cards.push(['RA', raV.value * 15, 'deg (GOTO pointing hint; solver reads deg)']);
    }
    if (finite(decV.value)) {
      cards.push(['OBJCTDEC', decV.value, 'device Dec deg']);
      cards.push(['DEC', decV.value, 'deg (GOTO pointing hint)']);
    }
    if (finite(altV.value)) cards.push(['ALT_OBS', altV.value, 'device altitude deg']);
    if (finite(azV.value)) cards.push(['AZ_OBS', azV.value, 'device azimuth deg']);

    try { writeFitsPlanar(dest, decoded.planes, decoded.W, decoded.H, cards); }
    catch (e) { if (await handleFailure(`FITS write failed: ${e.message}`)) break; continue; }

    const bytes = fs.statSync(dest).size;
    const sha = sha256File(dest);
    let enqueued = null;
    if (enqueue) enqueued = enqueueFrame({ dest, file, enqueueDir, sessionId, seq, frameId, bytes, sha, host, alpacaPort, camera, dateObs, log });

    const row = {
      event: 'frame', status: 'ok', session_id: sessionId, seq, frame_id: frameId,
      file, path: dest, ts: dateObs, exposure_s: exposureS,
      W: decoded.W, H: decoded.H, NP: decoded.NP, element_type: decoded.elementType,
      bytes, sha256: sha,
      pointing: {
        ra_h: finite(raV.value) ? raV.value : null, dec: finite(decV.value) ? decV.value : null,
        alt: finite(altV.value) ? altV.value : null, az: finite(azV.value) ? azV.value : null,
      },
      enqueued,
    };
    appendJournal(journalPath, row);
    seen.add(frameId); seq++; summary.frames++; consecutiveFailures = 0;
    log.log?.(`[frame ${summary.frames}] ${decoded.W}x${decoded.H}x${decoded.NP} ${decoded.elementType} id=${frameId} → ${file}` + (enqueued ? `  ⇒ queued` : ''));
    if (onFrame) { try { await onFrame(row); } catch { /* test hook, non-fatal */ } }
    if (intervalS > 0) await sleep(intervalS * 1000);
  }

  summary.ended_utc = new Date().toISOString();
  appendJournal(journalPath, { event: 'session_end', ...pick(summary, ['frames', 'duplicates', 'failures', 'transient_retries']), ts: summary.ended_utc });
  log.log?.(`SESSION DONE: ${summary.frames} frame(s), ${summary.duplicates} dup, ${summary.failures} failed, ${summary.transient_retries} transient retr(ies). Journal: ${journalPath}`);
  return summary;

  // ── inner helper (closes over summary/log/journalPath/deadline) ─────────────
  // Records an honest failed-frame row, backs off (async), and reports whether the
  // loop should break. Never crashes the session — a vanished device just keeps
  // retrying until the frame/duration bound is hit.
  async function handleFailure(reason) {
    summary.failures++; consecutiveFailures++;
    log.error?.(`  ⚠ frame FAILED (device blip?): ${reason} — logged, continuing (not fatal)`);
    appendJournal(journalPath, { event: 'frame', status: 'failed', session_id: sessionId, reason, ts: new Date().toISOString() });
    if (consecutiveFailures % 5 === 0) log.error?.(`  (…${consecutiveFailures} consecutive failures — device may be offline; still retrying)`);
    await sleep(Math.min(5000, Math.max(pollMs, 250 * consecutiveFailures)));
    return Date.now() >= deadline;
  }
}

function enqueueFrame({ dest, file, enqueueDir, sessionId, seq, frameId, bytes, sha, host, alpacaPort, camera, dateObs, log }) {
  try {
    const qDest = path.join(enqueueDir, file);
    fs.copyFileSync(dest, qDest);
    // Optional provenance sidecar (fetch_intake schema shape — read-only metadata,
    // not required by the queue but keeps the source auditable in the queue UI).
    const prov = {
      schema: 'skycruncher.intake.provenance/1',
      filename: file, image_kind: 'FITS',
      source: { type: 'alpaca', host, alpaca_port: alpacaPort, camera, session_id: sessionId, seq, frame_id: frameId },
      resolved_url: `alpaca://${host}:${alpacaPort}/api/v1/camera/${camera}#${frameId}`,
      http_status: 200, content_type: 'application/fits', bytes, sha256: sha, fetched_at: dateObs,
    };
    fs.writeFileSync(`${qDest}.provenance.json`, JSON.stringify(prov, null, 2));
    return { dir: enqueueDir, file };
  } catch (e) { log.error?.(`  enqueue warn: ${e.message} (frame kept in session dir)`); return null; }
}

function appendJournal(p, row) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(row) + '\n'); } catch { /* best-effort */ } }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }
const errStr = (e) => (e == null ? '' : typeof e === 'string' ? e : (e.error || e.code || e.message || String(e)));

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    host: null, alpacaPort: 32323, camera: TELE_CAM, outDir: DEFAULT_OUT_DIR, sessionId: null,
    exposureS: 10, intervalS: 0, maxFrames: Infinity, durationS: Infinity, watch: false,
    enqueue: false, enqueueDir: DEFAULT_ENQUEUE_DIR, pollMs: 1000, dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--host': a.host = argv[++i]; break;
      case '--alpaca-port': a.alpacaPort = Number(argv[++i]); break;
      case '--camera': a.camera = Number(argv[++i]); break;
      case '--out-dir': a.outDir = argv[++i]; break;
      case '--session-id': a.sessionId = argv[++i]; break;
      case '--exposure': a.exposureS = Number(argv[++i]); break;
      case '--interval': a.intervalS = Number(argv[++i]); break;
      case '--max-frames': a.maxFrames = Number(argv[++i]); break;
      case '--duration': a.durationS = Number(argv[++i]); break;
      case '--watch': a.watch = true; break;
      case '--enqueue': a.enqueue = true; break;
      case '--enqueue-dir': a.enqueueDir = argv[++i]; break;
      case '--poll-ms': a.pollMs = Number(argv[++i]); break;
      case '--dry-run': a.dryRun = true; break;
      case '-h': case '--help': a.help = true; break;
      default: console.error(`unknown arg: ${t}`); process.exit(2);
    }
  }
  return a;
}

function help() {
  console.log(`alpaca_watcher.mjs — live-session Seestar frame watcher (ASCOM Alpaca)

  node tools/intake/alpaca/alpaca_watcher.mjs --host <ip> [flags]

MODE
  (default)          DRIVE: command exposures + download each (single-controller — no phone app)
  --watch            PASSIVE: download frames as the device produces them (dedup on frame id)

FLAGS
  --host <ip>        device IP (Station mode); omit to try Alpaca UDP discovery
  --alpaca-port <n>  default 32323          --camera <n>  telephoto=0 (default)
  --exposure <s>     per-frame exposure seconds (default 10)
  --interval <s>     gap between frames (default 0)
  --max-frames <n>   stop after N frames    --duration <s>  stop after N seconds
  --out-dir <path>   default ${DEFAULT_OUT_DIR} (STORAGE LAW: never K:)
  --session-id <id>  resume/target a named session (idempotent)
  --enqueue          also drop each frame into the Solve Queue's Intake Folder lane
  --enqueue-dir <p>  default ${DEFAULT_ENQUEUE_DIR}
  --poll-ms <n>      imageready poll cadence (default 1000)
  --dry-run          print the plan, connect nothing

Frames land flat in <out-dir>/<session-id>/ with a session.jsonl journal. Point the
queue's "Intake Folder" card at that directory, OR use --enqueue for the default lane.`);
}

async function mainCli() {
  const a = parseArgs(process.argv);
  if (a.help) { help(); return; }
  const host = await resolveHost({ host: a.host });
  if (!host) { console.error('No Seestar found. Pass --host <ip>, or confirm the scope is in Station mode on this /24.'); process.exit(1); }
  const sessionId = a.sessionId || `alpaca_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  await runWatcher({ ...a, host, sessionId });
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return false; } })();
if (isMain) mainCli().catch((e) => { console.error('watcher fatal:', e); process.exit(1); });
