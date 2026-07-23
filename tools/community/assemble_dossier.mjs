// assemble_dossier.mjs — gather the REAL dispersed per-frame derived artifacts into
// ONE assembled dossier dir + manifest.json (schema "community-dump/1"), ready for
// tools/community/publish_dump.mjs.
// (No shebang on purpose — same reason as publish_dump.mjs: vitest inlines project .mjs
//  through esbuild.transform which does not strip `#!`; invoke via `node`.)
// ============================================================================
// CONTRACT: docs/COMMUNITY_DATABASE_SPEC.md §0 (artifact table, file:line cited) + §5
// OWNER-DECISION #1 (this is the "thin assembler"). The overnight pipeline writes
// per-frame DERIVED artifacts DISPERSED across several test_results/ subdirs keyed by
// frame id; there is no bundled dossier object. This tool gathers only the REAL
// artifacts that exist on disk for a frame (honest-or-absent — absent artifacts are
// OMITTED, never stubbed) and emits the manifest publish_dump.mjs consumes.
//
// STRICTLY OFFLINE: reads test_results/, writes the dossier dir. No network, no creds.
//
// GPS PRIVACY (§5 OWNER-DECISION #3, owner ruling 2026-07-09): --gps-tier selects the
// policy. Default 'raw' — the owner confirmed no frames were taken from a home location,
// so coordinates ship unmodified ("we can always change it later before we invite
// others"). 'rounded-0.1deg' (~11 km) is retained for when the dataplane opens up: it
// value-identity-rounds every gps lat/lon in the dossier COPIES ONLY (sources never
// mutated; echoed copies like metadata.gps_lat are scrubbed too) and a HARD GUARD then
// scans every assembled byte for the raw coordinate substrings — any hit aborts nonzero.
//
// <capture-date> is DATA-DERIVED from the frame's detection-dump timestamp (never
// wall-clock; determinism rule), overridable with --date.
//
// USAGE
//   node tools/community/assemble_dossier.mjs --frame <id> [--date YYYY-MM-DD] [--out <dir>]
//   default out = test_results/community_dossiers/<capture-date>/<frame-id>/  (gitignored)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const TR = path.join(REPO, 'test_results');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const FRAME = opt('frame', null);
const DATE_OVERRIDE = opt('date', null);
const OUT_OVERRIDE = opt('out', null);
// §5 #3 owner ruling 2026-07-09: default raw (no home-location frames); rounding kept
// as the opt-in tier for when others are invited.
const GPS_TIER = opt('gps-tier', 'raw');
if (!['raw', 'rounded-0.1deg'].includes(GPS_TIER)) {
  console.error(`assemble_dossier: --gps-tier must be raw | rounded-0.1deg (got "${GPS_TIER}").`);
  process.exit(1);
}
const ROUND_GPS = GPS_TIER === 'rounded-0.1deg';
if (!FRAME || FRAME === true) {
  console.error('assemble_dossier: --frame <id> is required.');
  process.exit(1);
}
// frame id must be a safe key segment (mirrors publish_dump.safeFrameId).
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(FRAME)) {
  console.error(`assemble_dossier: frame id "${FRAME}" is not a safe key segment ([A-Za-z0-9._-]).`);
  process.exit(1);
}

// ---- small utils ------------------------------------------------------------
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
// sanitize an arbitrary filename stem the way test_results detection dumps are keyed.
const sanitizeStem = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function captureDateFrom(ts) {
  const m = String(ts ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---- GPS privacy: collect raw observer coords + value-identity round ----------
// Keys (case-insensitive, anchored) that hold observer lat/lon. Celestial fields
// (ra_hours, dec_degrees, altitude, azimuth) deliberately DO NOT match.
const GPS_KEY_RE = /^(gps|gps_lat|gps_lon|gps_latitude|gps_longitude|latitude|longitude|lat|lon)$/i;
const round01 = (v) => Math.round(v * 10) / 10;

// Deep-collect every raw observer coordinate value (from gps-keyed fields) into a Set.
function collectRawCoords(node, key, acc) {
  if (node == null) return;
  if (Array.isArray(node)) {
    if (key && GPS_KEY_RE.test(key)) {
      for (const el of node) if (typeof el === 'number' && Number.isFinite(el)) acc.add(el);
    }
    for (const el of node) collectRawCoords(el, undefined, acc);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number' && Number.isFinite(v) && GPS_KEY_RE.test(k)) acc.add(v);
      collectRawCoords(v, k, acc);
    }
  }
}

// Deep-clone rounding any numeric leaf whose exact value is a known raw observer coord.
function deepRoundByValue(node, rawSet) {
  if (typeof node === 'number') return rawSet.has(node) ? round01(node) : node;
  if (Array.isArray(node)) return node.map((el) => deepRoundByValue(el, rawSet));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepRoundByValue(v, rawSet);
    return out;
  }
  return node;
}

// ---- locate the frame's real artifacts (CR2 or FITS) -------------------------
// Each entry: { name (dossier filename), kind, src (abs path) | jsonExtract (object), binary }
function findArtifacts(frame) {
  const arts = [];
  let detectionTimestamp = null;
  let frameType = null;
  // Frame-byte ORIGIN, carried on the detection dump when the frame came through
  // the intake fetcher (content-sha ledger match). null = unknown (honest-or-absent).
  let sourceProvenance = null;

  const cr2Det = path.join(TR, 'cr2_dets', `${frame}.app.json`);
  const fitsDet = path.join(TR, 'fits_dets', `${frame}.json`);

  if (exists(cr2Det)) {
    frameType = 'cr2';
    const det = readJson(cr2Det);
    detectionTimestamp = det.timestamp ?? null;
    sourceProvenance = det.source_provenance ?? null;
    arts.push({ name: 'cr2_dets.app.json', kind: 'detection_dump', src: cr2Det });
    for (const [dir, dossierName] of [['anchor1', 'cr2_solve_anchor1.json'], ['anchor3', 'cr2_solve_anchor3.json']]) {
      const p = path.join(TR, 'validation', '_cr2_raw', dir, `${frame}.json`);
      if (exists(p)) arts.push({ name: dossierName, kind: 'solve_arm', src: p });
    }
  } else if (exists(fitsDet)) {
    frameType = 'fits';
    const det = readJson(fitsDet);
    detectionTimestamp = det.timestamp ?? null;
    sourceProvenance = det.source_provenance ?? null;
    arts.push({ name: 'fits_dets.json', kind: 'detection_dump', src: fitsDet });
    for (const [dir, dossierName] of [['arm0', 'fits_arm0.json'], ['arm1', 'fits_arm1.json']]) {
      const p = matchInDir(path.join(TR, 'validation', '_fits_raw', dir), frame);
      if (p) arts.push({ name: dossierName, kind: 'solve_arm', src: p });
    }
  } else {
    console.error(`assemble_dossier: no detection dump for frame "${frame}" `
      + `(looked for cr2_dets/${frame}.app.json and fits_dets/${frame}.json).`);
    process.exit(1);
  }

  // renders: visuals/<frame>__<variant>.png (any variant that exists)
  const visDir = path.join(TR, 'validation', 'visuals');
  if (exists(visDir)) {
    for (const f of fs.readdirSync(visDir)) {
      const m = f.match(/__([A-Za-z0-9]+)\.png$/);
      if (m && sanitizeStem(f.slice(0, f.indexOf('__'))) === sanitizeStem(frame)) {
        arts.push({ name: `render__${m[1]}.png`, kind: 'render', src: path.join(visDir, f), binary: true });
      }
    }
  }

  // checkpoint entry: overnight/checkpoint.json -> frames[frame] (extracted object)
  const ckPath = path.join(TR, 'overnight', 'checkpoint.json');
  let checkpoint = null;
  if (exists(ckPath)) {
    checkpoint = readJson(ckPath);
    if (checkpoint.frames && checkpoint.frames[frame]) {
      arts.push({ name: 'checkpoint_entry.json', kind: 'checkpoint_entry', jsonExtract: checkpoint.frames[frame] });
    }
  }

  return { arts, detectionTimestamp, frameType, checkpoint, sourceProvenance };
}

// find a file in `dir` whose sanitized stem equals the sanitized frame id (FITS arms
// keep original spaced filenames; detection dumps/checkpoint use sanitized stems).
function matchInDir(dir, frame) {
  if (!exists(dir)) return null;
  const want = sanitizeStem(frame);
  // fast path: exact <frame>.json
  const direct = path.join(dir, `${frame}.json`);
  if (exists(direct)) return direct;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (sanitizeStem(f.replace(/\.json$/, '')) === want) return path.join(dir, f);
  }
  return null;
}

// best-effort wizard-receipt lookup (test_results/api_runs/<frame>*.receipt.json).
function findReceiptSha(frame) {
  const dir = path.join(TR, 'api_runs');
  if (!exists(dir)) return null;
  const want = sanitizeStem(frame);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.receipt\.json$/i.test(f)) continue;
    const stem = sanitizeStem(f.replace(/\.receipt\.json$/i, ''));
    if (stem === want || stem.startsWith(want + '_') || stem.startsWith(want)) {
      return sha256Buf(fs.readFileSync(path.join(dir, f)));
    }
  }
  return null;
}

// ---- main -------------------------------------------------------------------
function main() {
  const { arts, detectionTimestamp, frameType, checkpoint, sourceProvenance } = findArtifacts(FRAME);

  // capture date: --date override, else data-derived from the detection timestamp.
  const captureDate = (DATE_OVERRIDE && DATE_OVERRIDE !== true)
    ? String(DATE_OVERRIDE)
    : captureDateFrom(detectionTimestamp);
  if (!captureDate || !/^\d{4}-\d{2}-\d{2}$/.test(captureDate)) {
    console.error(`assemble_dossier: could not derive capture_date `
      + `(detection timestamp="${detectionTimestamp}"). Pass --date YYYY-MM-DD.`);
    process.exit(1);
  }

  // out dir (gitignored under test_results/) — cleared for a fresh, deterministic assembly.
  const outDir = (OUT_OVERRIDE && OUT_OVERRIDE !== true)
    ? path.resolve(String(OUT_OVERRIDE))
    : path.join(TR, 'community_dossiers', captureDate, sanitizeStem(FRAME));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1) load every source artifact as a JS value (JSON) or Buffer (binary).
  const loaded = arts.map((a) => {
    if (a.binary) return { ...a, buf: fs.readFileSync(a.src) };
    if (a.jsonExtract !== undefined) return { ...a, obj: a.jsonExtract };
    return { ...a, obj: readJson(a.src) };
  });

  // 2) GLOBAL raw-coord set across ALL json artifacts (union) — drives rounding + guard.
  const rawSet = new Set();
  for (const a of loaded) if (a.obj !== undefined) collectRawCoords(a.obj, undefined, rawSet);

  // guard substrings: raw coord serializations that actually CHANGE when rounded
  // (signed form + unsigned-digits form, to catch any sign representation).
  const guardSubs = new Set();
  let roundedCount = 0;
  if (ROUND_GPS) {
    for (const v of rawSet) {
      const rounded = round01(v);
      if (JSON.stringify(rounded) === JSON.stringify(v)) continue; // already at 0.1deg — no leak
      roundedCount++;
      guardSubs.add(JSON.stringify(v));            // e.g. "34.0380426" / "-118.874663"
      guardSubs.add(String(Math.abs(v)));          // e.g. "118.874663" (unsigned digits)
    }
  }

  // 3) write dossier copies (rounded for json; verbatim bytes for binary).
  const manifestArtifacts = [];
  for (const a of loaded) {
    const dest = path.join(outDir, a.name);
    let bytes;
    if (a.buf) {
      fs.writeFileSync(dest, a.buf);
      bytes = a.buf;
    } else {
      const outObj = ROUND_GPS ? deepRoundByValue(a.obj, rawSet) : a.obj;
      bytes = Buffer.from(JSON.stringify(outObj, null, 2) + '\n');
      fs.writeFileSync(dest, bytes);
    }
    manifestArtifacts.push({ path: a.name, sha256: sha256Buf(bytes), bytes: bytes.length, kind: a.kind });
  }

  // 4) manifest (schema community-dump/1).
  const manifest = {
    schema: 'community-dump/1',
    capture_date: captureDate,
    frame_id: FRAME,
    provenance: {
      receipt_sha256: findReceiptSha(FRAME),               // null when no receipt (honest-or-absent)
      pipeline_run_index: (checkpoint && typeof checkpoint.run_index === 'number') ? checkpoint.run_index : null,
      config_hash: (checkpoint && checkpoint.frames && checkpoint.frames[FRAME]?.config_hash) || null,
      frame_type: frameType,
      capture_date_source: (DATE_OVERRIDE && DATE_OVERRIDE !== true) ? 'override' : 'detection_timestamp',
      gps_privacy: GPS_TIER,                                // policy applied at assembly (§5 #3)
      gps_fields_rounded: ROUND_GPS ? roundedCount : null,  // honest: null when tier is raw
      // frame-byte ORIGIN passthrough from the detection dump (intake content-sha
      // ledger match). null when unknown / not intake-fetched (honest-or-absent).
      source_provenance: sourceProvenance ?? null,
    },
    artifacts: manifestArtifacts,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestBuf);

  // 5) HARD GPS GUARD — scan EVERY assembled byte for any raw coord substring.
  const files = fs.readdirSync(outDir);
  let scannedBytes = 0;
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(outDir, f));
    scannedBytes += buf.length;
    const hay = buf.toString('latin1');
    for (const sub of guardSubs) {
      if (hay.includes(sub)) hits.push({ file: f, sub });
    }
  }
  console.log('--- GPS PRIVACY GUARD ---');
  if (!ROUND_GPS) {
    console.log(`gps tier: raw (owner ruling 2026-07-09 — no home-location frames; `
      + `revisit before public access). Coordinates ship unmodified.`);
  } else {
    console.log(`guard substrings (raw coords that changed under 0.1deg rounding): `
      + `${guardSubs.size ? [...guardSubs].map((s) => JSON.stringify(s)).join(', ') : '(none — no gps present)'}`);
    console.log(`scanned ${files.length} files (${scannedBytes} bytes)`);
    if (hits.length) {
      console.error(`GPS GUARD FAILED — raw coordinate substring(s) survived in the dossier:`);
      for (const h of hits) console.error(`  ${h.file}: contains ${JSON.stringify(h.sub)}`);
      process.exit(2);
    }
    console.log(`GPS GUARD CLEAN — no raw coordinate substring present. `
      + `(${roundedCount} gps field-value(s) rounded to 0.1deg in copies; sources untouched.)`);
  }

  // 6) summary.
  const total = manifestArtifacts.reduce((s, a) => s + a.bytes, 0) + manifestBuf.length;
  console.log('--- DOSSIER ASSEMBLED ---');
  console.log(`frame=${FRAME}  type=${frameType}  capture_date=${captureDate}`);
  console.log(`artifacts (${manifestArtifacts.length} + manifest, ${total} B):`);
  for (const a of manifestArtifacts) console.log(`  ${a.path.padEnd(26)} ${String(a.bytes).padStart(9)} B  ${a.kind}  ${a.sha256.slice(0, 12)}`);
  console.log(`dossier dir: ${outDir}`);
  console.log(`next: node tools/community/publish_dump.mjs --dry-run --dir "${outDir}"`);
}

main();
