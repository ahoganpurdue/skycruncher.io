// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT PIPELINE — nova.astrometry.net CLOUD TRUTH rung (community solve)
// (sibling of the LOCAL install-gated oracle tools/overnight/astrometry_truth.mjs)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT: builds the CLOUD truth testbed by pushing "no ground truth" frames through
// nova.astrometry.net's public API. It emits the SAME TruthLabel record shape as the
// local oracle (source:'astrometry_net', via the canonical adapter in
// tools/validation/truth/schema.ts) so downstream consumers are SOURCE-AGNOSTIC —
// the only difference is a `nova` provenance block distinguishing the solver:
//   { solver:'nova-api', submission_id, job_id, solved_at, submitted_path, … }
//
// TWO MODES:
//   (default, OFFLINE, no key) INVENTORY — scan the corpus manifest + overnight
//     checkpoint + truth labels for frames LACKING oracle-grade (GOLD) truth; list
//     them with paths + why-no-truth + which submit path would be used. This run is
//     the answer to "which frames need the cloud".
//   (--push, gated on ASTROMETRY_NET_API_KEY) PUSH — submit each needs-cloud frame
//     to nova, STRICTLY SEQUENTIAL (one at a time — donated community compute),
//     poll politely, and on success write a GOLD TruthLabel back to labels.json.
//     NO-OP with a clear message (never a crash) when the key is absent.
//
// SUBMISSION PATH (owner amendment 2026-07-09):
//   DEFAULT = XYLIST. We submit our OWN detections as a FITS xylist (x,y flux-sorted,
//   capped at the top ~300 by flux — nova's own recommendation for junk-heavy frames),
//   with the image dims in the submission args. Image upload is the FALLBACK, used only
//   when a frame has no usable detection dump.
//   ALWAYS pass hints we hold (they cut a blind multi-minute solve to seconds, sparing
//   donated compute): scale_units='arcsecperpix' + a generous ±30% scale band, and
//   center_ra/center_dec + radius when a prior pointing/solve exists. Every hint value
//   AND the submit path are recorded in the truth-record provenance, so a HINTED cloud
//   solve is never mistaken for a BLIND confirmation.
//
// ETHOS: a hint only ACCELERATES nova's search — its own quad-hash verification stays
// the SOLE arbiter, so a wrong/absent hint can only slow or fail a solve, NEVER
// fabricate one (identical principle to the local oracle's scale hint).
//
// CACHE: content-hash keyed. A frame whose truth record already exists (matching
// frame_id nova-api label, or matching submitted-bytes sha256) is NEVER resubmitted.
//
// PRIVACY: every submission carries publicly_visible='n', allow_modifications='n',
// allow_commercial_use='n'.
//
// USAGE:
//   node tools/overnight/nova_truth.mjs                 # INVENTORY (offline, no key)
//   node tools/overnight/nova_truth.mjs --json          # inventory as JSON
//   node tools/overnight/nova_truth.mjs --push          # PUSH (needs the key; NO-OP without)
//   node tools/overnight/nova_truth.mjs --push --dry-run # build+print the submission PLAN, no network
//   node tools/overnight/nova_truth.mjs --push --frame IMG_1266 --limit 3
//   flags: --frame <id>  --limit N  --top N (xylist cap, default 300)
//          --scale-tol T (band ±T, default 0.30)  --out <labels.json>  --json
//   env:   ASTROMETRY_NET_API_KEY   (required for a real push; falls back to the
//                                    gitignored repo-root .env.nova key file)
//          ASTROMETRY_NET_API_URL   (default https://nova.astrometry.net/api)
//
// Every request carries `Referer: https://nova.astrometry.net/api/login` — nova's
// stated requirement for programmatic access (anti-scraper guard, owner-relayed
// 2026-07-09 from their signup flow).
//
// EXIT: 0 = inventory / plan / NO-OP / push completed (per-frame outcomes are DATA).
//       1 = usage / fatal error.
//
// No engine edits. Provenance/user-agent may carry the app name (CLAUDE.md LAW 6
// data-pull exception); all other identifiers are brand-neutral.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { frameIdOf } from '../batch/batch_plan.mjs';
import { fromAstrometryNetCalibration } from '../validation/truth/schema.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(ROOT, 'test_results', 'corpus_manifest.json');
const CHECKPOINT = path.join(ROOT, 'test_results', 'overnight', 'checkpoint.json');
const DEFAULT_LABELS = path.join(ROOT, 'tools', 'validation', 'truth', 'labels.json');
const DETS_DIR = path.join(ROOT, 'test_results', 'cr2_dets'); // legacy CR2 dump convention

// ── knobs ────────────────────────────────────────────────────────────────────
const NOVA_BASE = process.env.ASTROMETRY_NET_API_URL ?? 'https://nova.astrometry.net/api';
// LAW 6 exception: outbound provenance/user-agent MAY carry the app name.
const USER_AGENT = process.env.NOVA_USER_AGENT ?? 'SkyCruncher-nova-truth/1.0 (+https://astrometry.net community solve)';
const XYLIST_TOP_N = 300;            // nova's recommended cap for junk-heavy frames
const SCALE_HINT_TOL = 0.30;         // ±30% band around our approximate scale
const HINT_RADIUS_DEG = 15;          // generous search radius around a goto/prior center
const POLL_INTERVAL_MS = 15_000;     // polite (>= 10s per nova etiquette)
const FRAME_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per frame
// Formats nova accepts as an IMAGE upload (source-extraction done cloud-side). RAW
// (CR2/NEF/…) is NOT accepted — such a frame needs a render, so honest-skip it (the
// xylist path covers every RAW frame that has a dump anyway).
const IMAGE_UPLOAD_CONTAINERS = new Set(['FITS', 'PNG', 'JPEG', 'JPG', 'TIFF']);
// Ceiling on a direct image upload — a multi-GB stack must NOT be slurped into memory
// (and nova would reject it); such a frame needs a detection dump (xylist) or a
// downsized render. Env-overridable via NOVA_IMAGE_MAX_MB.
const IMAGE_UPLOAD_MAX_BYTES = (Number(process.env.NOVA_IMAGE_MAX_MB) || 200) * 1024 * 1024;
const PRIVACY = { publicly_visible: 'n', allow_modifications: 'n', allow_commercial_use: 'n' };
// nova's anti-scraper guard: programmatic requests must carry this Referer.
const NOVA_REFERER = process.env.NOVA_REFERER ?? 'https://nova.astrometry.net/api/login';

// Key file fallback: repo-root .env.nova (gitignored via the .env.* rule) with
// KEY=value lines. Real env vars always win; absence is fine (inventory mode).
(function loadNovaEnvFile() {
  const p = path.join(ROOT, '.env.nova');
  let text; try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

// ── tiny utils ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ── FITS xylist (BINTABLE) writer ────────────────────────────────────────────
// A minimal single-BINTABLE FITS holding X,Y float32 columns (flux-sorted order).
// The engine FITS writer (tools/fits/export_fits.ts) only writes IMAGE HDUs, so this
// is a genuinely distinct artifact (not code-in-two-places). nova reads the default
// 'X'/'Y' columns and uses image_width/image_height (passed in the submission args).
function fcard(key, value) {
  const k = String(key).padEnd(8).slice(0, 8);
  let body;
  if (typeof value === 'boolean') body = `= ${(value ? 'T' : 'F').padStart(20)}`;
  else if (typeof value === 'number') body = `= ${String(value).padStart(20)}`;
  else body = `= '${String(value).padEnd(8)}'`;   // string value, quoted
  return (k + body).padEnd(80).slice(0, 80);
}
function padTo2880(buf) {
  const rem = buf.length % 2880;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(2880 - rem, 0)]);
}
function padHeaderTo2880(str, fill = ' ') {
  const rem = str.length % 2880;
  return rem === 0 ? str : str + fill.repeat(2880 - rem);
}
/** Build a FITS xylist Buffer from flux-sorted [{x,y}] detections. */
export function writeXylsFits(dets) {
  const n = dets.length;
  const primary = padHeaderTo2880(
    [fcard('SIMPLE', true), fcard('BITPIX', 8), fcard('NAXIS', 0),
     fcard('EXTEND', true), 'END'.padEnd(80)].join(''),
  );
  const ext = padHeaderTo2880(
    [fcard('XTENSION', 'BINTABLE'), fcard('BITPIX', 8), fcard('NAXIS', 2),
     fcard('NAXIS1', 8), fcard('NAXIS2', n), fcard('PCOUNT', 0), fcard('GCOUNT', 1),
     fcard('TFIELDS', 2),
     fcard('TTYPE1', 'X'), fcard('TFORM1', '1E'),
     fcard('TTYPE2', 'Y'), fcard('TFORM2', '1E'),
     'END'.padEnd(80)].join(''),
  );
  const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    data.writeFloatBE(dets[i].x, i * 8);        // big-endian per FITS
    data.writeFloatBE(dets[i].y, i * 8 + 4);
  }
  return Buffer.concat([Buffer.from(primary, 'latin1'), Buffer.from(ext, 'latin1'), padTo2880(data)]);
}

// ── scale hint (bounded PRIOR, never a truth fabricator) ─────────────────────
export function scaleBand(scaleArcsec, tol = SCALE_HINT_TOL) {
  const s = num(scaleArcsec);
  if (s == null || s <= 0) return null;
  let t = num(tol); if (t == null || t < 0) t = SCALE_HINT_TOL;
  return { scale_units: 'arcsecperpix', scale_type: 'ul', scale_lower: s * (1 - t), scale_upper: s * (1 + t), scale_est: s, tol: t };
}

// ── corpus / truth state ─────────────────────────────────────────────────────
/** Existing nova-api labels in the output labels file (for the content-hash cache). */
function loadExistingLabels(outPath) {
  const doc = loadJson(outPath);
  if (!doc) return [];
  const labels = Array.isArray(doc) ? doc : (Array.isArray(doc.labels) ? doc.labels : []);
  return labels;
}
/** Case-tolerant checkpoint lookup (checkpoint keys are frameIdOf, maps lowercased elsewhere). */
function checkpointEntry(checkpoint, frameId) {
  const frames = checkpoint?.frames ?? {};
  if (frames[frameId]) return frames[frameId];
  const lc = frameId.toLowerCase();
  for (const k of Object.keys(frames)) if (k.toLowerCase() === lc) return frames[k];
  return null;
}
/**
 * Resolve a frame's detection dump absolute path — SAME order as run_pipeline's
 * resolveDump (manifest dump_available/dump_path first, then the legacy
 * cr2_dets/<id>.app.json fallback), so CR2 frames absent from the manifest's
 * enriched dump fields still route to the xylist path. null ⇒ no dump.
 */
function resolveDumpPath(frameId, im) {
  if (im.dump_available && im.dump_path) {
    const abs = path.join(ROOT, im.dump_path);
    if (fs.existsSync(abs)) return abs;
  }
  const legacy = path.join(DETS_DIR, `${frameId}.app.json`);
  return fs.existsSync(legacy) ? legacy : null;
}

/** A frame already carries a GOLD (oracle-grade) truth? */
function hasGoldTruth(frameId, cpEntry, labels) {
  const lc = frameId.toLowerCase();
  for (const l of labels) {
    if (l.frame_id?.toLowerCase() !== lc) continue;
    // astrometry_net / bundled_known resolve to GOLD (schema.ts tierOf); explicit GOLD too.
    if (l.tier === 'GOLD' || l.source === 'astrometry_net' || l.source === 'bundled_known') return true;
  }
  if (cpEntry?.truth_tier === 'GOLD') return true;
  return false;
}

/**
 * Enumerate every manifest frame LACKING GOLD truth → a "needs cloud" record with
 * paths, why-no-truth, and the submit path that WOULD be used. Pure/offline.
 */
export function inventoryNeedsCloud({ manifest, checkpoint, labels }) {
  const rows = [];
  for (const im of manifest?.images ?? []) {
    const frameId = frameIdOf(im.path);
    const cpEntry = checkpointEntry(checkpoint, frameId);
    if (hasGoldTruth(frameId, cpEntry, labels)) continue;   // already oracle-grade

    // why-no-truth (honest, additive)
    const why = [];
    const gtSrc = im.ground_truth?.source ?? null;
    if (gtSrc) why.push(`goto-only(${gtSrc}=COARSE)`);
    if (cpEntry?.truth_verdict === 'NO_SOLVE') why.push('local-oracle NO_SOLVE');
    if (cpEntry?.truth_tier === 'COARSE') why.push('checkpoint tier=COARSE');
    if (!cpEntry) why.push('not-yet-truth-processed');
    if (why.length === 0) why.push('no GOLD label');

    // submit path
    const dumpAbs = resolveDumpPath(frameId, im);
    const hasDump = !!dumpAbs;
    const container = String(im.container ?? '').toUpperCase();
    let submitPath;
    if (hasDump) submitPath = 'xylist-top300+scale-hint';
    else if (IMAGE_UPLOAD_CONTAINERS.has(container)) submitPath = 'image';
    else submitPath = 'image-fallback-needs-render(RAW)';

    const approxScale = num(im.pixel_scale) ?? num(im.header_scale_arcsec_px)
      ?? (dumpAbs ? num(loadJson(dumpAbs)?.scaleArcsecPerPx) : null);

    rows.push({
      frame_id: frameId,
      path: im.path,
      image_type: im.image_type ?? 'UNKNOWN',
      container,
      dims: im.dims ?? null,
      megapixels: num(im.megapixels),
      has_dump: hasDump,
      dump_path: dumpAbs ? path.relative(ROOT, dumpAbs) : null,
      dump_abs: dumpAbs,
      approx_scale_arcsec: approxScale,
      goto: im.ground_truth ? { ra_h: num(im.ground_truth.ra_h), dec: num(im.ground_truth.dec), object: im.ground_truth.object ?? null } : null,
      why_no_truth: why.join('; '),
      submit_path: submitPath,
      oom_risk: (im.risk_flags ?? []).some((f) => /OOM/i.test(f)),
    });
  }
  return rows;
}

/**
 * Build the OFFLINE submission plan for one needs-cloud row: the exact bytes + args
 * + hints + sha256 that a push WOULD send. Returns { skip } when unsubmittable.
 */
export function buildPlan(row, opts = {}) {
  const topN = opts.topN ?? XYLIST_TOP_N;
  const tol = opts.tol ?? SCALE_HINT_TOL;

  // hints (always attach what we hold)
  const band = scaleBand(row.approx_scale_arcsec, tol);
  const hints = {};
  if (band) Object.assign(hints, {
    scale_units: band.scale_units, scale_type: band.scale_type,
    scale_lower: band.scale_lower, scale_upper: band.scale_upper, scale_est: band.scale_est,
  });
  let centerSource = null;
  if (row.goto && row.goto.ra_h != null && row.goto.dec != null) {
    hints.center_ra = row.goto.ra_h * 15;   // hours → degrees at the API boundary
    hints.center_dec = row.goto.dec;
    hints.radius = HINT_RADIUS_DEG;
    centerSource = 'goto';
  }

  if (row.submit_path.startsWith('xylist')) {
    const dump = loadJson(row.dump_abs);
    if (!dump || !Array.isArray(dump.detections) || dump.detections.length === 0) {
      return { skip: true, reason: `dump unreadable/empty: ${row.dump_path}` };
    }
    const dets = dump.detections
      .filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y))
      .sort((a, b) => (b.flux ?? 0) - (a.flux ?? 0))
      .slice(0, topN);
    if (dets.length === 0) return { skip: true, reason: 'no finite detections' };
    const width = num(dump.width), height = num(dump.height);
    if (width == null || height == null) return { skip: true, reason: 'dump missing width/height' };
    const bytes = writeXylsFits(dets);
    const args = { ...PRIVACY, ...hints, image_width: width, image_height: height };
    return {
      submitted_path: `xylist-top${dets.length}+${band ? 'scale-hint' : 'no-scale'}`,
      filename: `${row.frame_id}.xyls`,
      bytes, args, hints, center_source: centerSource,
      submitted_sha256: sha256(bytes),
      submitted_desc: `FITS xylist (${dets.length} of ${dump.detections.length} detections, flux-sorted) ${bytes.length}B`,
    };
  }

  if (row.submit_path === 'image') {
    const abs = path.join(ROOT, row.path);
    if (!fs.existsSync(abs)) return { skip: true, reason: `image file missing: ${row.path}` };
    const size = fs.statSync(abs).size;
    if (size > IMAGE_UPLOAD_MAX_BYTES) {
      return { skip: true, reason: `image ${(size / 1e6).toFixed(0)}MB exceeds the ${(IMAGE_UPLOAD_MAX_BYTES / 1e6).toFixed(0)}MB upload ceiling — needs a detection dump (xylist path) or a downsized render` };
    }
    const bytes = fs.readFileSync(abs);
    const args = { ...PRIVACY, ...hints, downsample_factor: 2 };
    return {
      submitted_path: `image+${band ? 'scale-hint' : 'no-scale'}`,
      filename: path.basename(row.path),
      bytes, args, hints, center_source: centerSource,
      submitted_sha256: sha256(bytes),
      submitted_desc: `original ${row.container} image ${bytes.length}B`,
    };
  }

  // RAW without a dump → needs a render step first (honest-absent; not auto-rendered).
  return {
    skip: true,
    reason: 'RAW image-fallback needs a 16-bit render (decode via tools/dslr or tools/psf → PNG/FITS) before nova will accept it; xylist path covers RAW frames that have a dump',
  };
}

// ── truth-record write (SAME shape as the local oracle + nova provenance) ────
export function labelFromNova(cal, frameId, plan, ids) {
  const label = fromAstrometryNetCalibration(cal, frameId, {
    provenance_note:
      `nova.astrometry.net community solve (${plan.submitted_path}; submission ${ids.submission_id} job ${ids.job_id})`,
    generated_at: ids.solved_at,
  });
  // Distinguishing provenance block (downstream reads the canonical fields; this
  // records WHAT the oracle was told, so a hinted solve is never read as blind).
  label.nova = {
    solver: 'nova-api',
    submission_id: ids.submission_id,
    job_id: ids.job_id,
    solved_at: ids.solved_at,
    submitted_path: plan.submitted_path,
    submitted_sha256: plan.submitted_sha256,
    submitted_bytes: plan.submitted_desc,
    hints: plan.hints,
    center_source: plan.center_source,
    calibration: cal,
    wcs_url: `${NOVA_BASE.replace(/\/api\/?$/, '')}/wcs_file/${ids.job_id}`,
  };
  return label;
}
/** Merge a label into the labels.json (dedup on frame_id + nova-api provenance). */
function mergeLabel(outPath, label) {
  let doc = { schema: 'validation-truth/1', labels: [] };
  if (fs.existsSync(outPath)) {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    doc = Array.isArray(parsed) ? { schema: 'validation-truth/1', labels: parsed } : parsed;
    if (!Array.isArray(doc.labels)) doc.labels = [];
  }
  doc.labels = doc.labels.filter((l) => !(l.frame_id === label.frame_id && l.nova?.solver === 'nova-api'));
  doc.labels.push(label);
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

// ── nova API client (built-in fetch/FormData/Blob; no deps) ──────────────────
async function novaFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, 'Referer': NOVA_REFERER, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function novaLogin(apiKey) {
  const body = 'request-json=' + encodeURIComponent(JSON.stringify({ apikey: apiKey }));
  const r = await novaFetch(`${NOVA_BASE}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (r.json?.status !== 'success' || !r.json?.session) {
    throw new Error(`nova login failed (${r.status}): ${r.json?.errormessage ?? r.text?.slice(0, 200)}`);
  }
  return r.json.session;
}
async function novaUpload(session, plan) {
  const fd = new FormData();
  fd.append('request-json', JSON.stringify({ session, ...plan.args }));
  fd.append('file', new Blob([plan.bytes], { type: 'application/octet-stream' }), plan.filename);
  const r = await novaFetch(`${NOVA_BASE}/upload`, { method: 'POST', body: fd });
  if (r.json?.status !== 'success' || r.json?.subid == null) {
    throw new Error(`nova upload failed (${r.status}): ${r.json?.errormessage ?? r.text?.slice(0, 200)}`);
  }
  return r.json.subid;
}
/** Poll submission → first job id (or null on timeout). */
async function pollSubmission(subid, deadline) {
  while (Date.now() < deadline) {
    const r = await novaFetch(`${NOVA_BASE}/submissions/${subid}`);
    const jobs = r.json?.jobs ?? [];
    const jobId = jobs.find((j) => j != null);
    if (jobId != null) return jobId;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}
/** Poll job status → 'success' | 'failure' | 'timeout'. */
async function pollJob(jobId, deadline) {
  while (Date.now() < deadline) {
    const r = await novaFetch(`${NOVA_BASE}/jobs/${jobId}`);
    const s = r.json?.status;
    if (s === 'success' || s === 'failure') return s;
    await sleep(POLL_INTERVAL_MS);
  }
  return 'timeout';
}
async function novaCalibration(jobId) {
  const r = await novaFetch(`${NOVA_BASE}/jobs/${jobId}/calibration/`);
  if (!r.json || r.json.ra == null) throw new Error(`nova calibration unavailable for job ${jobId}`);
  return r.json;
}

// ── PUSH driver (strictly sequential) ────────────────────────────────────────
async function runPush(rows, opts) {
  const outPath = opts.outPath;
  const existing = loadExistingLabels(outPath);
  const cachedFrames = new Set(existing.filter((l) => l.nova?.solver === 'nova-api').map((l) => l.frame_id));
  const cachedHashes = new Set(existing.map((l) => l.nova?.submitted_sha256).filter(Boolean));

  // Build plans FIRST (offline) so the plan is inspectable before any network I/O.
  const plans = [];
  for (const row of rows) {
    const plan = buildPlan(row, opts);
    plans.push({ row, plan });
  }

  console.log(`\n── nova push plan (${plans.length} frame${plans.length === 1 ? '' : 's'} selected) ──`);
  for (const { row, plan } of plans) {
    if (plan.skip) { console.log(`  SKIP  ${row.frame_id.padEnd(22)} ${plan.reason}`); continue; }
    const h = plan.hints;
    const scaleStr = h.scale_lower != null ? `scale[${h.scale_lower.toFixed(3)},${h.scale_upper.toFixed(3)}]"/px` : 'scale:none';
    const ctrStr = h.center_ra != null ? `center(${(h.center_ra / 15).toFixed(4)}h,${h.center_dec.toFixed(3)}°,r${h.radius}°:${plan.center_source})` : 'center:none';
    console.log(`  PLAN  ${row.frame_id.padEnd(22)} ${plan.submitted_path}  ${scaleStr}  ${ctrStr}  sha256=${plan.submitted_sha256.slice(0, 12)}`);
  }

  const apiKey = process.env.ASTROMETRY_NET_API_KEY;
  if (!apiKey) {
    console.log(`\nASTROMETRY_NET_API_KEY not set — stopping at the login gate (NO-OP, no network).`);
    console.log(`The PLAN above is exactly what a real push would submit. Set the key to run it.`);
    return { submitted: 0, solved: 0, failed: 0, timeout: 0, skipped: plans.filter((p) => p.plan.skip).length, noop: true };
  }
  if (opts.dryRun) {
    console.log(`\n--dry-run: PLAN built, no network I/O performed.`);
    return { submitted: 0, solved: 0, failed: 0, timeout: 0, skipped: plans.filter((p) => p.plan.skip).length, dry: true };
  }

  console.log(`\n── nova push (SEQUENTIAL — donated community compute) ──`);
  const session = await novaLogin(apiKey);
  const summary = { submitted: 0, solved: 0, failed: 0, timeout: 0, skipped: 0, results: [] };

  for (const { row, plan } of plans) {
    if (plan.skip) { summary.skipped++; continue; }
    if (cachedFrames.has(row.frame_id) || cachedHashes.has(plan.submitted_sha256)) {
      console.log(`  CACHED ${row.frame_id} — truth record already exists, not resubmitting.`);
      summary.skipped++; continue;
    }
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    try {
      const subid = await novaUpload(session, plan);
      summary.submitted++;
      console.log(`  → ${row.frame_id}: submission ${subid} (${plan.submitted_path}); polling…`);
      const jobId = await pollSubmission(subid, deadline);
      if (jobId == null) { summary.timeout++; summary.results.push({ frame_id: row.frame_id, outcome: 'timeout', submission_id: subid }); console.log(`    TIMEOUT (no job) after ${(FRAME_TIMEOUT_MS / 60000)}min`); continue; }
      const status = await pollJob(jobId, deadline);
      if (status === 'success') {
        const cal = await novaCalibration(jobId);
        const solved_at = new Date().toISOString();
        const label = labelFromNova(cal, row.frame_id, plan, { submission_id: subid, job_id: jobId, solved_at });
        mergeLabel(outPath, label);
        summary.solved++;
        summary.results.push({ frame_id: row.frame_id, outcome: 'solved', submission_id: subid, job_id: jobId });
        console.log(`    SOLVED job ${jobId} → RA=${label.ra_hours.toFixed(6)}h Dec=${label.dec_degrees.toFixed(4)}° scale=${(label.pixel_scale_arcsec ?? NaN).toFixed(4)}"/px → ${outPath}`);
      } else {
        summary[status === 'timeout' ? 'timeout' : 'failed']++;
        summary.results.push({ frame_id: row.frame_id, outcome: status, submission_id: subid, job_id: jobId });
        console.log(`    ${status.toUpperCase()} job ${jobId}`);
      }
    } catch (e) {
      summary.failed++;
      summary.results.push({ frame_id: row.frame_id, outcome: 'error', error: String(e?.message ?? e) });
      console.log(`    ERROR ${row.frame_id}: ${e?.message ?? e}`);
    }
  }
  return summary;
}

// ── inventory printer ────────────────────────────────────────────────────────
function printInventory(rows, asJson) {
  if (asJson) { console.log(JSON.stringify({ needs_cloud_count: rows.length, frames: rows }, null, 2)); return; }
  console.log(`── nova cloud-truth INVENTORY: ${rows.length} frame(s) lacking GOLD (oracle-grade) truth ──\n`);
  if (rows.length === 0) { console.log('  (every manifest frame already carries oracle-grade truth)'); return; }
  const byPath = {};
  for (const r of rows) {
    const scale = r.approx_scale_arcsec != null ? `${r.approx_scale_arcsec.toFixed(2)}"/px` : 'scale:NOT MEASURED';
    const goto = r.goto && r.goto.ra_h != null ? `goto ${r.goto.ra_h.toFixed(3)}h/${r.goto.dec.toFixed(2)}°` : 'goto:none';
    console.log(`  ${r.frame_id.padEnd(24)} ${String(r.image_type).padEnd(12)} dump=${r.has_dump ? 'Y' : 'N'}  ${scale.padEnd(18)} ${goto.padEnd(22)}`);
    console.log(`      ${r.path}`);
    console.log(`      why: ${r.why_no_truth}   → submit: ${r.submit_path}${r.oom_risk ? '  [OOM-risk]' : ''}`);
    byPath[r.submit_path] = (byPath[r.submit_path] ?? 0) + 1;
  }
  console.log(`\n  submit-path tally: ${Object.entries(byPath).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  → these are the frames that NEED the cloud rung.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['push', 'dry-run', 'json']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); if (flags.has(k)) a[k] = true; else a[k] = argv[++i]; }
    else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const manifest = loadJson(MANIFEST);
  if (!manifest) { console.error(`corpus manifest not found: ${MANIFEST}\n(run the corpus inventory regen first — see docs/OVERNIGHT_PIPELINE.md)`); process.exit(1); }
  const checkpoint = loadJson(CHECKPOINT) ?? { frames: {} };
  const outPath = a.out ? path.resolve(a.out) : DEFAULT_LABELS;
  const labels = loadExistingLabels(outPath);

  let rows = inventoryNeedsCloud({ manifest, checkpoint, labels });

  if (a.frame) { const lc = String(a.frame).toLowerCase(); rows = rows.filter((r) => r.frame_id.toLowerCase() === lc); }
  if (a.limit != null) rows = rows.slice(0, Math.max(0, Number(a.limit)));

  if (!a.push) { printInventory(rows, a.json); process.exit(0); }

  const opts = {
    outPath, dryRun: !!a['dry-run'],
    topN: a.top != null ? Number(a.top) : XYLIST_TOP_N,
    tol: a['scale-tol'] != null ? Number(a['scale-tol']) : SCALE_HINT_TOL,
  };
  const summary = await runPush(rows, opts);
  console.log(`\n── summary ──`);
  console.log(`  submitted=${summary.submitted}  solved=${summary.solved}  failed=${summary.failed}  timeout=${summary.timeout}  skipped=${summary.skipped}` +
              `${summary.noop ? '  (NO-OP: no key)' : ''}${summary.dry ? '  (dry-run)' : ''}`);
  if (a.json) console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// Run only when invoked directly (pure helpers stay importable for unit tests;
// argv[1] is absent under `node -e`, so guard the comparison).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
}
