// ═══════════════════════════════════════════════════════════════════════════
// INTAKE FETCHER — pull external frames (Google Drive / HTTP) into the rotating
// lane, SIGNED and with a provenance ledger. (companion to run_pipeline.mjs)
// ═══════════════════════════════════════════════════════════════════════════
//
// The overnight rig has no image-fetch of its own — ingestion was always a
// manual local-drop into `Sample Files/rotating/`. This closes that gap for
// links that have been shared WITH PERMISSION, with two kinds of "signing":
//
//   1. OUTBOUND IDENTITY (so the source owner isn't spooked) — every request
//      carries a named, contactable User-Agent + `From:` + `X-SkyCruncher-*`
//      headers announcing WHO is pulling, WHY, and under what authorization.
//      Anyone reading the Drive/server access log sees an identified bot, not
//      an anonymous scraper. Nothing is disguised.
//
//   2. INBOUND PROVENANCE (so WE have an audit trail) — each downloaded file
//      gets a `<file>.provenance.json` sidecar AND an append-only ledger row
//      (test_results/overnight/intake_ledger.jsonl) recording source, resolved
//      URL, SHA-256, bytes, content-type, HTTP status, timestamp, the identity
//      block, and an HMAC-SHA256 signature over that record (tamper-evident;
//      key at tools/overnight/intake_signing.key, gitignored, auto-created).
//
// It does NOT decode/detect/ingest — after files land it prints the exact
// next-step commands (dump → manifest regen → run_pipeline). Fetch stays a
// clean, auditable seam.
//
// SAFETY:
//   • Magic-byte validation — a Drive "virus scan" / error HTML page is NEVER
//     saved as a .fits/.cr2 (rejected, logged, no partial file left behind).
//   • Idempotent — a file already present with a matching SHA-256 is skipped.
//   • ≤ 25 pulls per run by default (CORPUS_INTAKE.md rotating budget).
//   • Honors each source's terms — caller asserts authorization in the config.
//
// USAGE:
//   node tools/overnight/fetch_intake.mjs --dry-run        # resolve + plan, no download
//   node tools/overnight/fetch_intake.mjs                  # fetch per intake_sources.json
//   node tools/overnight/fetch_intake.mjs --config path.json
//   node tools/overnight/fetch_intake.mjs --max 10 --dest "Sample Files/rotating"
//
// CONFIG (tools/overnight/intake_sources.json — gitignored, you provide it;
//   copy intake_sources.example.json):
//   {
//     "identity": { "operator": "adam@structurize.io",
//                   "purpose": "authorized processing test",
//                   "authorization": "links shared with explicit permission to use freely" },
//     "dest": "Sample Files/rotating",
//     "sources": [
//       { "label": "seestar_m51", "type": "gdrive_file",   "id": "<FILE_ID>", "filename": "m51.fits" },
//       { "label": "dslr_batch",  "type": "gdrive_folder", "id": "<FOLDER_ID>", "apiKey": "<KEY>" },
//       { "label": "direct",      "type": "http",          "url": "https://host/frame.CR2" }
//     ]
//   }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(HERE, 'intake_sources.json');
const SIGNING_KEY_FILE = path.join(HERE, 'intake_signing.key');
const LEDGER_FILE = path.join(ROOT, 'test_results', 'overnight', 'intake_ledger.jsonl');
const DEAD_LINKS_FILE = path.join(ROOT, 'test_results', 'overnight', 'dead_links.jsonl');

/** Dead-link keys (url or drive id) recorded by prior failed runs. */
function loadDeadLinkKeys() {
  try {
    return new Set(fs.readFileSync(DEAD_LINKS_FILE, 'utf8').split(/\r?\n/)
      .filter(Boolean).map((l) => { try { return JSON.parse(l).key; } catch { return null; } })
      .filter(Boolean));
  } catch { return new Set(); }
}

const AGENT_NAME = 'SkyCruncher-IngestBot';
const AGENT_VERSION = '1.0';
// Public repo/contact so a source owner watching their logs can identify + reach us.
const AGENT_INFO_URL = 'https://github.com/ahoganpurdue/skycruncher';

// Accepted science-image magic signatures — anything else (esp. text/html) is junk.
const MAGIC = [
  { ext: 'fits', label: 'FITS', test: (b) => b.slice(0, 6).toString('ascii') === 'SIMPLE' },
  // CR2 / most RAW are TIFF-container: 'II*\0' (little-endian) or 'MM\0*' (big-endian).
  { ext: 'cr2', label: 'TIFF/RAW', test: (b) => {
      const s = b.slice(0, 4);
      return (s[0] === 0x49 && s[1] === 0x49 && s[2] === 0x2a && s[3] === 0x00) ||
             (s[0] === 0x4d && s[1] === 0x4d && s[2] === 0x00 && s[3] === 0x2a);
    } },
  // Fujifilm RAF — magic 'FUJIFILMCCD-RAW' (proprietary container, X-Trans or
  // Bayer CFA). Saved with provenance + honestly labeled — decoder support is
  // decided downstream (first samples: friend-intake 2026-07-12).
  { ext: 'raf', label: 'RAF', test: (b) => b.slice(0, 15).toString('ascii') === 'FUJIFILMCCD-RAW' },
  // XISF (PixInsight) — magic 'XISF0100'. Saved with provenance so the data is
  // preserved, but flagged: the pipeline has no XISF decoder yet → won't solve.
  { ext: 'xisf', label: 'XISF', test: (b) => b.slice(0, 8).toString('ascii') === 'XISF0100' },
  // Consumer formats (event-funnel era, 2026-07-09 late): attendee/community
  // submissions arrive as JPEG/PNG. Preserved with provenance + honestly
  // labeled — demo-tier processing decides downstream what they support.
  { ext: 'jpg', label: 'JPEG', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', label: 'PNG', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
];
function looksLikeHtmlOrError(buf) {
  // FITS/CR2 are binary and never start with markup; a leading '<' means Google
  // handed back an HTML interstitial / error page instead of the file.
  const head = buf.slice(0, 512).toString('ascii').toLowerCase().trimStart();
  return head.startsWith('<');
}
function classifyBytes(buf) {
  for (const m of MAGIC) if (m.test(buf)) return m.label;
  return null;
}

// ── archive (zip) handling ────────────────────────────────────────────────────
// A shared source (last night's DSW pull) arrived as a 1.5 GB zip wrapping 5
// nested zips of calibrated masters. Rather than unpack by hand, detect a zip by
// magic and route every extracted member through the SAME classifier/provenance
// path as a directly-fetched file, carrying archive lineage (source → inner path).
const ARCHIVE_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // 'PK\x03\x04' (504b0304)
const ARCHIVE_MAX_BYTES = 4 * 1024 * 1024 * 1024;                // 4 GiB size guard
const ARCHIVE_MAX_NEST_DEPTH = 1;                                // handle ONE level of zip-in-zip
function looksLikeZip(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ARCHIVE_ZIP_MAGIC);
}
// Read only the first N bytes of a file (magic peek) without slurping the whole
// thing — lets a >4 GB archive hit the size guard before we ever allocate a Buffer.
function readHead(absPath, n) {
  const fd = fs.openSync(absPath, 'r');
  try { const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, r); }
  finally { fs.closeSync(fd); }
}
// Zip extraction needs a libarchive `tar` (bsdtar). GNU tar CANNOT read zips, so
// we probe for a zip-capable binary and verify it via --version. On Win11 the
// system bsdtar lives at %SystemRoot%\System32\tar.exe; on macOS/BSD the PATH
// `tar` is already libarchive. If none is found the archive is kept and members
// are NOT extracted (honest failure, logged) rather than silently dropped.
let _zipTarCache;
function resolveZipTar() {
  if (_zipTarCache !== undefined) return _zipTarCache;
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), 'bsdtar', 'tar']
    : ['bsdtar', 'tar'];
  for (const bin of candidates) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/bsdtar|libarchive/i.test(v)) { _zipTarCache = bin; return bin; }
    } catch { /* try next candidate */ }
  }
  _zipTarCache = null;
  return null;
}
function walkFilesRec(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFilesRec(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
// Extract `archivePath` into a temp tree and return descriptors for every leaf
// member: { path (on the temp tree), nested (inner-archive names between the
// source archive and this member), inner_path (member path within its immediate
// container), depth }. A nested zip within ARCHIVE_MAX_NEST_DEPTH is unpacked one
// more level; a zip found DEEPER is left as a leaf (it classifier-rejects honestly).
function expandArchive(archivePath, tarBin, tmpRoot, nested = [], depth = 0) {
  const outDir = fs.mkdtempSync(path.join(tmpRoot, 'unzip-'));
  execFileSync(tarBin, ['-xf', archivePath, '-C', outDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  const members = [];
  for (const filePath of walkFilesRec(outDir)) {
    const innerPath = path.relative(outDir, filePath).replace(/\\/g, '/');
    let head; try { head = readHead(filePath, 4); } catch { head = Buffer.alloc(0); }
    if (looksLikeZip(head) && depth < ARCHIVE_MAX_NEST_DEPTH) {
      members.push(...expandArchive(filePath, tarBin, tmpRoot, [...nested, innerPath], depth + 1));
    } else {
      members.push({ path: filePath, nested, inner_path: innerPath, depth });
    }
  }
  return members;
}

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['dry-run', 'force', 'retry-dead', 'ingest-in-place']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      if (flags.has(k)) a[k] = true; else a[k] = argv[++i];
    } else a._.push(t);
  }
  return a;
}

// ── signing key (tamper-evidence for the provenance ledger) ───────────────────
// Symmetric HMAC key, created once and reused so signatures are verifiable across
// runs. We NEVER record the key itself — only its SHA-256 fingerprint, so the
// signing identity is auditable without leaking the secret.
function loadOrCreateKey() {
  if (process.env.INTAKE_SIGNING_KEY) {
    const key = Buffer.from(process.env.INTAKE_SIGNING_KEY, 'utf8');
    return { key, source: 'env' };
  }
  if (fs.existsSync(SIGNING_KEY_FILE)) {
    return { key: fs.readFileSync(SIGNING_KEY_FILE), source: 'file' };
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SIGNING_KEY_FILE, key, { mode: 0o600 });
  return { key, source: 'created' };
}
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
// Deterministic canonical JSON (sorted keys) so the HMAC is reproducible.
function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}
function sign(record, key) {
  return crypto.createHmac('sha256', key).update(canonical(record)).digest('hex');
}

// ── identity headers (the OUTBOUND "signature") ───────────────────────────────
function buildIdentity(cfgIdentity) {
  const operator = cfgIdentity?.operator || 'unknown-operator';
  const purpose = cfgIdentity?.purpose || 'processing test';
  const authorization = cfgIdentity?.authorization || 'operator-asserted authorization';
  return { agent: AGENT_NAME, version: AGENT_VERSION, info: AGENT_INFO_URL, operator, purpose, authorization };
}
function identityHeaders(identity) {
  // User-Agent + From are the standard, log-visible identity fields; the X-
  // headers spell out intent so a cautious owner sees this is deliberate + benign.
  return {
    'User-Agent': `${identity.agent}/${identity.version} (+${identity.info}; operator=${identity.operator}; purpose=${identity.purpose})`,
    'From': identity.operator,
    'X-SkyCruncher-Agent': `${identity.agent}/${identity.version}`,
    'X-SkyCruncher-Operator': identity.operator,
    'X-SkyCruncher-Purpose': identity.purpose,
    'X-SkyCruncher-Authorization': identity.authorization,
  };
}

// ── source URL resolution ─────────────────────────────────────────────────────
// Accepts a full share URL OR a bare id in `id`; extracts the id if a URL slipped in.
function extractDriveId(s) {
  if (!s) return null;
  let m = s.match(/\/folders\/([A-Za-z0-9_-]{20,})/); if (m) return m[1]; // folder share URL
  m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/); if (m) return m[1];           // file share URL
  m = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/); if (m) return m[1];          // uc?id= form
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;                            // bare id
  return null;
}

// Keyless enumeration of a PUBLIC Drive folder by scraping its share page.
// Google embeds each entry as ["<fileId>",["<parentId>"],"<name>","<mime>",...
// so we pair every filename token with the nearest preceding id token. Fragile
// by nature (undocumented layout) — used only when no apiKey is supplied; the
// API path (listDriveFolder) is preferred when a key is available.
async function listDriveFolderKeyless(folderId, headers) {
  const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, { headers });
  if (!res.ok) return { error: `folder page fetch failed: ${res.status} ${res.statusText}` };
  const html = await res.text();
  const nameRe = /"([^"]+\.(?:fits|fit|cr2|nef|arw|dng|tif|tiff|xisf))"/gi;
  const idRe = /"([A-Za-z0-9_-]{25,44})"/g;
  const ids = []; let m;
  while ((m = idRe.exec(html))) ids.push({ pos: m.index, id: m[1] });
  const files = []; const seen = new Set(); let n;
  while ((n = nameRe.exec(html))) {
    if (seen.has(n[1])) continue;
    let best = null;
    for (const it of ids) { if (it.pos < n.index) { if (!best || it.pos > best.pos) best = it; } else break; }
    if (best) { files.push({ id: best.id, name: n[1] }); seen.add(n[1]); }
  }
  if (!files.length) return { error: 'no files parsed from folder page (private folder, or Drive changed its layout — supply an apiKey to use the Drive API instead)' };
  return { files };
}

async function listDriveFolder(folderId, apiKey, headers) {
  // Keyless scrape when no API key; otherwise the documented Drive API v3 path.
  if (!apiKey) return listDriveFolderKeyless(folderId, headers);
  const files = [];
  let pageToken = null;
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${folderId}' in parents and trashed=false`);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size)');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers });
    if (!res.ok) return { error: `Drive API list failed: ${res.status} ${res.statusText}` };
    const body = await res.json();
    for (const f of body.files || []) files.push(f);
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return { files };
}

// Fetch bytes from a Google Drive file id, handling the large-file confirm gate.
async function fetchDriveFile(id, headers) {
  // drive.usercontent is the current direct-serve host; confirm=t clears the
  // small-file path. Cookies are threaded in case a confirm interstitial appears.
  const jar = {};
  const withCookies = (h) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    return cookie ? { ...h, Cookie: cookie } : h;
  };
  const absorbCookies = (res) => {
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const line of sc) { const [kv] = line.split(';'); const [k, v] = kv.split('='); if (k) jar[k.trim()] = v; }
  };
  let url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  let res = await fetch(url, { headers: withCookies(headers), redirect: 'follow' });
  absorbCookies(res);
  let buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';

  // If Google handed back an HTML interstitial, parse its form and re-request.
  if (ctype.includes('text/html') && looksLikeHtmlOrError(buf)) {
    const html = buf.toString('utf8');
    const action = (html.match(/action="([^"]+)"/) || [])[1];
    if (action) {
      const form = new URL(action.replace(/&amp;/g, '&'));
      for (const m of html.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)) {
        form.searchParams.set(m[1], m[2].replace(/&amp;/g, '&'));
      }
      res = await fetch(form, { headers: withCookies(headers), redirect: 'follow' });
      absorbCookies(res);
      buf = Buffer.from(await res.arrayBuffer());
    }
  }
  return { buf, status: res.status, contentType: res.headers.get('content-type') || '', finalUrl: res.url || url };
}

// Enumerate an archive.org item via its documented metadata API (no scraping).
// Download URL for each file is https://archive.org/download/<id>/<name>.
async function listArchiveOrg(identifier, headers) {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { headers });
  if (!res.ok) return { error: `archive.org metadata failed: ${res.status} ${res.statusText}` };
  const body = await res.json();
  const exts = /\.(fits|fit|cr2|nef|arw|dng|tif|tiff|xisf)$/i;
  const files = (body.files || [])
    .filter((f) => f.name && exts.test(f.name))
    .map((f) => ({ name: f.name, url: `https://archive.org/download/${encodeURIComponent(identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`, size: f.size }));
  if (!files.length) return { error: `no science-image files (${exts}) in archive.org item "${identifier}"` };
  return { files };
}

async function fetchHttp(url, headers) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, status: res.status, contentType: res.headers.get('content-type') || '', finalUrl: res.url || url };
}

// Streaming SHA-256 of a file — hashes a big archive (1.5 GB DSW zip) without
// ever holding it in memory (the file path, not its bytes, drives extraction).
function sha256File(absPath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let r; while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, r));
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

// ── classify + persist one image (shared by the direct-fetch and archive paths)─
// Returns { rejected } when the bytes aren't a science image, { status:'skip_existing' }
// on an idempotent hit, or { status:'fetched' } after writing file + signed
// provenance sidecar + ledger row. `archiveLineage` (when present) records where
// the bytes came from inside a container; the record is otherwise byte-identical
// to the pre-archive shape (no `archive` key on directly-fetched files).
function writeClassifiedImage(opts) {
  const { buf, label, filenameHint, sourceRecord, citation, archiveLineage, fetchMeta,
          identity, keyFp, key, destDir, force, stampIso, disambiguateOnConflict } = opts;
  const kind = classifyBytes(buf);
  if (!kind) {
    const hint = looksLikeHtmlOrError(buf)
      ? 'got an HTML page (Drive login/permission/quota wall?) — check the link is world-readable'
      : `unrecognized magic (content-type ${fetchMeta?.contentType || 'n/a'})`;
    return { rejected: true, hint };
  }
  let filename = filenameHint || `${label.replace(/[^\w.-]+/g, '_')}`;
  if (!/\.[A-Za-z0-9]+$/.test(filename)) {
    filename += '.' + (MAGIC.find((m) => m.label === kind)?.ext ?? 'bin');
  }
  let destPath = path.join(destDir, filename);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // Idempotent: identical file already present → skip. On a name clash with a
  // DIFFERENT file, the direct path preserves the historical overwrite behavior;
  // archive members (disambiguateOnConflict) get a sha-tagged name so two members
  // sharing a basename across nested zips never silently clobber each other.
  if (fs.existsSync(destPath) && !force) {
    const existing = crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');
    if (existing === sha256) return { status: 'skip_existing', filename, sha256, kind };
    if (disambiguateOnConflict) {
      const ext = path.extname(filename);
      filename = `${filename.slice(0, filename.length - ext.length)}.${sha256.slice(0, 8)}${ext}`;
      destPath = path.join(destDir, filename);
      if (fs.existsSync(destPath)) {
        const dup = crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');
        if (dup === sha256) return { status: 'skip_existing', filename, sha256, kind };
      }
    }
  }

  const record = {
    schema: 'skycruncher.intake.provenance/1',
    label,
    filename,
    image_kind: kind,
    source: sourceRecord,
    citation: citation ?? null,
    resolved_url: fetchMeta?.finalUrl ?? null,
    http_status: fetchMeta?.status ?? null,
    content_type: fetchMeta?.contentType ?? '',
    bytes: buf.length,
    sha256,
    fetched_at: stampIso,
    agent: identity,
    signing_key_fingerprint: keyFp,
  };
  if (archiveLineage) record.archive = archiveLineage;
  record.signature = { alg: 'HMAC-SHA256', key_fp: keyFp, value: sign(record, key) };

  fs.writeFileSync(destPath, buf);
  fs.writeFileSync(`${destPath}.provenance.json`, JSON.stringify(record, null, 2));
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(record) + '\n');
  return { status: 'fetched', filename, sha256, kind, bytes: buf.length };
}

// Honest, NON-dead-link ledger note for an archive we couldn't/wouldn't process
// (oversize guard, or no zip-capable tar). The original archive is never touched.
function appendArchiveNote(note) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.appendFileSync(LEDGER_FILE, JSON.stringify({ schema: 'skycruncher.intake.archive_note/1', ...note }) + '\n');
  } catch { /* best-effort */ }
}

// Unpack `archiveOnDisk` (already a durable file — NEVER deleted here) and emit
// every member through writeClassifiedImage with archive lineage. A member that
// isn't a science image is skipped and logged but does NOT hit the dead-link
// ledger (same exclusion as a directly-fetched non-image).
function extractAndEmitMembers(ctx) {
  const { archiveOnDisk, archiveDisplayName, archiveSha256, sourceRecord, citation, fetchMeta,
          label, identity, keyFp, key, destDir, force, stampIso } = ctx;
  const tarBin = resolveZipTar();
  if (!tarBin) {
    console.error(`  ✗ [${label}] no zip-capable tar (bsdtar/libarchive) found — archive kept, NOT extracted`);
    appendArchiveNote({ label, reason: 'no_bsdtar', archive: archiveDisplayName, ts: stampIso });
    return [{ label, status: 'archive_no_tar' }];
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-arc-'));
  const out = [];
  try {
    const members = expandArchive(archiveOnDisk, tarBin, tmpRoot, [], 0);
    for (const m of members) {
      const buf = fs.readFileSync(m.path);
      const archiveLineage = {
        schema: 'skycruncher.intake.archive_lineage/1',
        source_archive: archiveDisplayName,
        archive_sha256: archiveSha256,
        nested_archives: m.nested,
        inner_path: m.inner_path,
        member_depth: m.depth,
      };
      const memberLabel = `${label}::${[...m.nested, m.inner_path].join('/')}`;
      const r = writeClassifiedImage({
        buf, label: memberLabel, filenameHint: path.basename(m.inner_path),
        sourceRecord, citation, archiveLineage, fetchMeta,
        identity, keyFp, key, destDir, force, stampIso, disambiguateOnConflict: true,
      });
      if (r.rejected) {
        console.log(`  ⊘ [${memberLabel}] not a science image (${r.hint}) — skipped (NOT dead-linked)`);
        out.push({ label: memberLabel, status: 'member_rejected', reason: r.hint });
      } else if (r.status === 'skip_existing') {
        console.log(`  ↺ [${memberLabel}] already present (sha match) → skip`);
        out.push({ label: memberLabel, filename: r.filename, status: 'skip_existing', sha256: r.sha256, kind: r.kind });
      } else {
        console.log(`  ✓ [${memberLabel}] ${r.kind} ${(r.bytes / 1e6).toFixed(1)} MB → ${r.filename}  (sha ${r.sha256.slice(0, 12)})`);
        out.push({ label: memberLabel, filename: r.filename, status: 'fetched', kind: r.kind, bytes: r.bytes, sha256: r.sha256 });
      }
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
  const nWritten = out.filter((r) => r.status === 'fetched').length;
  console.log(`  📦 [${label}] archive → ${out.length} members (${nWritten} classified+written), original kept: ${archiveDisplayName}`);
  return out;
}

// ── INGEST-IN-PLACE (no-copy) ───────────────────────────────────────────────
// For archives too large to route through the copy-based archive path (the 4 GiB
// guard), the overnight rig extracts members DIRECTLY to their final on-disk home
// with a throttled bsdtar driver, then registers each member WHERE IT LIES — no
// second copy, no 40 GB duplication. This mode reads only the magic head (classify)
// + streams a SHA-256 (part of the record schema), writes the signed provenance
// sidecar + append-only ledger row, and never moves the bytes. `ingest_mode:'in_place'`
// marks the record honestly (no fetch, no copy). Archive lineage (source_archive +
// inner_path) is carried so the member's origin container is auditable.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function registerInPlace(o) {
  const { abs, rel, sourceArchive, archiveSha, citation, identity, keyFp, key, force, stampIso } = o;
  if (!fs.existsSync(abs)) return { rel, status: 'missing' };
  const st = fs.statSync(abs);
  let head; try { head = readHead(abs, 16); } catch { head = Buffer.alloc(0); }
  const kind = classifyBytes(head);
  const sha256 = sha256File(abs);                 // streaming — never slurps the file
  const provPath = `${abs}.provenance.json`;
  if (!kind) return { rel, status: 'member_rejected', bytes: st.size, sha256 };
  if (fs.existsSync(provPath) && !force) {
    try { const prev = JSON.parse(fs.readFileSync(provPath, 'utf8'));
      if (prev.sha256 === sha256) return { rel, status: 'skip_existing', kind, bytes: st.size, sha256 }; } catch { /* re-register */ }
  }
  const record = {
    schema: 'skycruncher.intake.provenance/1',
    label: sourceArchive ? `${sourceArchive}::${rel}` : rel,
    filename: path.basename(rel),
    image_kind: kind,
    source: { type: 'file', path: rel },
    citation: citation ?? null,
    resolved_url: `file://${abs.replace(/\\/g, '/')}`,
    http_status: 200,
    content_type: kind === 'FITS' ? 'application/fits' : kind === 'XISF' ? 'application/xisf' : 'application/octet-stream',
    bytes: st.size,
    sha256,
    fetched_at: stampIso,
    agent: identity,
    signing_key_fingerprint: keyFp,
    ingest_mode: 'in_place',                       // honest: registered where it lies, no copy
  };
  if (sourceArchive) record.archive = {
    schema: 'skycruncher.intake.archive_lineage/1',
    source_archive: sourceArchive, archive_sha256: archiveSha ?? null,
    nested_archives: [], inner_path: rel, member_depth: 0,
  };
  record.signature = { alg: 'HMAC-SHA256', key_fp: keyFp, value: sign(record, key) };
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.writeFileSync(provPath, JSON.stringify(record, null, 2));
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(record) + '\n');
  return { rel, status: 'fetched', kind, bytes: st.size, sha256 };
}

async function ingestInPlace(args) {
  const baseDir = path.resolve(args['base-dir'] || '.');
  if (!fs.existsSync(baseDir)) { console.error(`✗ ingest-in-place base-dir not found: ${baseDir}`); process.exit(1); }
  const citation = args['citation-file'] ? JSON.parse(fs.readFileSync(path.resolve(args['citation-file']), 'utf8')) : null;
  const sourceArchive = args['source-archive'] || null;
  const archiveSha = args['archive-sha256'] || null;
  const throttleMs = args['throttle-ms'] ? parseInt(args['throttle-ms'], 10) : 0;
  const throttleEvery = args['throttle-every'] ? parseInt(args['throttle-every'], 10) : 0;
  const { key, source: keySource } = loadOrCreateKey();
  const keyFp = keyFingerprint(key);
  const identity = buildIdentity(args.operator
    ? { operator: args.operator, purpose: args.purpose, authorization: args.authorization }
    : { operator: 'overnight-rig@on-disk',
        purpose: 'on-disk archive ingest (no network)',
        authorization: 'operator-asserted on-disk-only guardrail' });

  let members;
  if (args['members-file']) {
    members = fs.readFileSync(path.resolve(args['members-file']), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else {
    members = walkFilesRec(baseDir).filter((p) => !p.endsWith('.provenance.json'))
      .map((p) => path.relative(baseDir, p).replace(/\\/g, '/'));
  }

  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  console.log('═══ INTAKE INGEST-IN-PLACE (no-copy) ═══');
  console.log(`  base dir     : ${baseDir}`);
  console.log(`  source archive: ${sourceArchive ?? '(none)'}`);
  console.log(`  signing key  : ${keySource} (fp ${keyFp})`);
  console.log(`  members      : ${members.length}${throttleEvery && throttleMs ? `  (throttle ${throttleMs}ms every ${throttleEvery})` : ''}`);
  if (args['dry-run']) { console.log('  [--dry-run] plan only; nothing registered.'); return; }

  const results = [];
  let i = 0;
  for (const rel of members) {
    const abs = path.join(baseDir, rel);
    const stampIso = new Date().toISOString();
    const r = registerInPlace({ abs, rel, sourceArchive, archiveSha, citation, identity, keyFp, key, force: !!args.force, stampIso });
    results.push(r);
    if (r.status === 'fetched') console.log(`  ✓ [${rel}] ${r.kind} ${(r.bytes / 1e6).toFixed(1)} MB registered (sha ${r.sha256.slice(0, 12)})`);
    else if (r.status === 'skip_existing') console.log(`  ↺ [${rel}] already registered (sha match) → skip`);
    else if (r.status === 'member_rejected') console.log(`  ⊘ [${rel}] not a science image → skipped (NOT dead-linked)`);
    else console.log(`  ✗ [${rel}] ${r.status}`);
    i++;
    if (throttleEvery && throttleMs && i % throttleEvery === 0 && i < members.length) await sleep(throttleMs);
  }
  const ok = results.filter((r) => r.status === 'fetched');
  const byKind = (k) => ok.filter((r) => r.kind === k).length;
  console.log(`\n  registered ${ok.length} (${byKind('FITS')} FITS, ${byKind('XISF')} XISF, ${byKind('TIFF/RAW')} RAW), ` +
    `${results.filter((r) => r.status === 'skip_existing').length} skip, ` +
    `${results.filter((r) => r.status === 'member_rejected').length} rejected, ` +
    `${results.filter((r) => r.status === 'missing').length} missing`);
  console.log(`  ledger → ${path.relative(ROOT, LEDGER_FILE)}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.slice(2).includes('--ingest-in-place')) {
    return ingestInPlace(parseArgs(process.argv.slice(2)));
  }
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ? path.resolve(args.config) : DEFAULT_CONFIG;
  const dryRun = !!args['dry-run'];
  const maxPulls = args.max ? parseInt(args.max, 10) : 25;

  if (!fs.existsSync(configPath)) {
    console.error(`✗ no intake config at ${configPath}`);
    console.error(`  copy tools/overnight/intake_sources.example.json → intake_sources.json and add your links.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const destRel = args.dest || cfg.dest || 'Sample Files/rotating';
  const destDir = path.isAbsolute(destRel) ? destRel : path.join(ROOT, destRel);
  const identity = buildIdentity(cfg.identity);
  const headers = identityHeaders(identity);
  const { key, source: keySource } = loadOrCreateKey();
  const keyFp = keyFingerprint(key);

  // Expand sources → a flat work list of concrete files.
  const work = [];
  for (const src of cfg.sources || []) {
    // Optional citation (per-source, falling back to a config-wide one): carried
    // verbatim into the signed ledger record so downstream source_provenance can
    // credit the ORIGINAL publisher (site/author/terms), not just the fetch URL.
    const citation = src.citation ?? cfg.citation ?? null;
    if (src.type === 'file' || src.type === 'local' ||
        (src.type === 'http' && /^file:\/\//i.test(src.url || ''))) {
      // Local path (or file:// URL) — the overnight rig points here for archives
      // already sitting on disk (e.g. D:/AstroLogic/intake/*.zip). Never over the wire.
      let p = src.path || src.url || src.id;
      if (p && /^file:\/\//i.test(p)) p = fileURLToPath(p);
      if (!p) { console.error(`✗ [${src.label}] file source needs a "path" (or file:// url)`); continue; }
      const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
      work.push({ label: src.label, kind: 'file', path: abs, pathRel: p, filename: src.filename || path.basename(abs), citation });
    } else if (src.type === 'http') {
      work.push({ label: src.label, kind: 'http', url: src.url, filename: src.filename || path.basename(new URL(src.url).pathname), citation });
    } else if (src.type === 'gdrive_file') {
      const id = extractDriveId(src.id || src.url);
      if (!id) { console.error(`✗ [${src.label}] could not extract a Drive file id`); continue; }
      work.push({ label: src.label, kind: 'gdrive_file', id, filename: src.filename || null, citation });
    } else if (src.type === 'gdrive_folder') {
      const id = extractDriveId(src.id || src.url);
      if (!id) { console.error(`✗ [${src.label}] could not extract a Drive folder id`); continue; }
      const listing = await listDriveFolder(id, src.apiKey, headers);
      if (listing.error) { console.error(`✗ [${src.label}] ${listing.error}`); continue; }
      for (const f of listing.files) work.push({ label: `${src.label}/${f.name}`, kind: 'gdrive_file', id: f.id, filename: f.name, citation });
    } else if (src.type === 'archive_org') {
      // Accept a bare identifier OR a details/download URL.
      const idm = (src.id || src.url || '').match(/archive\.org\/(?:details|download|metadata)\/([^/?#]+)/);
      const identifier = idm ? decodeURIComponent(idm[1]) : (src.id || '').trim();
      if (!identifier) { console.error(`✗ [${src.label}] could not extract an archive.org identifier`); continue; }
      const listing = await listArchiveOrg(identifier, headers);
      if (listing.error) { console.error(`✗ [${src.label}] ${listing.error}`); continue; }
      for (const f of listing.files) work.push({ label: `${src.label}/${f.name}`, kind: 'http', url: f.url, filename: path.basename(f.name) });
    } else {
      console.error(`✗ [${src.label}] unknown source type "${src.type}"`);
    }
  }

  console.log('═══ INTAKE FETCH ═══');
  console.log(`  identity     : ${headers['User-Agent']}`);
  console.log(`  authorization: ${identity.authorization}`);
  console.log(`  signing key  : ${keySource} (fp ${keyFp})`);
  console.log(`  dest lane    : ${destRel}`);
  console.log(`  planned pulls: ${work.length}${work.length > maxPulls ? ` (capped to ${maxPulls})` : ''}`);
  for (const w of work.slice(0, maxPulls)) console.log(`    • [${w.label}] ${w.kind}${w.filename ? ` → ${w.filename}` : ''}`);

  if (dryRun) { console.log('\n  [--dry-run] plan only; nothing downloaded.'); return; }

  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });

  const deadKeys = args['retry-dead'] ? new Set() : loadDeadLinkKeys();
  const results = [];
  for (const w of work.slice(0, maxPulls)) {
    const stampIso = new Date().toISOString();
    const wKey = w.kind === 'http' ? w.url : w.kind === 'file' ? w.path : w.id;
    if (deadKeys.has(wKey)) {
      console.log(`  ⊘ [${w.label}] on the dead-link ledger — skipping (--retry-dead to override)`);
      results.push({ label: w.label, status: 'skip_dead' });
      continue;
    }
    try {
      const sourceRecord = w.kind === 'http' ? { type: 'http', url: w.url }
        : w.kind === 'file' ? { type: 'file', path: w.pathRel }
        : { type: 'gdrive_file', id: w.id };

      // ── LOCAL FILE: peek + stat BEFORE reading, so a >4 GB archive never gets
      //    slurped into a Buffer; zips extract straight off the durable original.
      if (w.kind === 'file') {
        if (!fs.existsSync(w.path)) throw new Error(`local file not found: ${w.pathRel}`);
        const st = fs.statSync(w.path);
        const isZip = looksLikeZip(readHead(w.path, 4));
        if (isZip && st.size > ARCHIVE_MAX_BYTES) {
          console.log(`  ⚠ [${w.label}] archive ${(st.size / 1e9).toFixed(1)} GB > ${(ARCHIVE_MAX_BYTES / 1e9).toFixed(0)} GB guard — skipped (not extracted); original kept`);
          appendArchiveNote({ label: w.label, reason: 'oversize', bytes: st.size, archive: path.basename(w.path), source: sourceRecord, ts: stampIso });
          results.push({ label: w.label, status: 'archive_skip_oversize', bytes: st.size });
          continue;
        }
        if (isZip) {
          const archRes = extractAndEmitMembers({
            archiveOnDisk: w.path, archiveDisplayName: path.basename(w.path), archiveSha256: sha256File(w.path),
            sourceRecord, citation: w.citation,
            fetchMeta: { finalUrl: `file://${w.path}`, status: 200, contentType: 'application/zip' },
            label: w.label, identity, keyFp, key, destDir, force: args.force, stampIso,
          });
          results.push(...archRes);
          continue;
        }
        const buf = fs.readFileSync(w.path);
        const r = writeClassifiedImage({ buf, label: w.label, filenameHint: w.filename, sourceRecord, citation: w.citation, archiveLineage: null, fetchMeta: { finalUrl: `file://${w.path}`, status: 200, contentType: '' }, identity, keyFp, key, destDir, force: args.force, stampIso });
        if (r.rejected) throw new Error(`not a science image: ${r.hint}`);
        if (r.status === 'skip_existing') { console.log(`  ↺ [${w.label}] already present (sha match) → skip`); results.push({ label: w.label, filename: r.filename, status: 'skip_existing', sha256: r.sha256 }); continue; }
        console.log(`  ✓ [${w.label}] ${r.kind} ${(r.bytes / 1e6).toFixed(1)} MB → ${r.filename}  (sha ${r.sha256.slice(0, 12)})`);
        results.push({ label: w.label, filename: r.filename, status: 'fetched', kind: r.kind, bytes: r.bytes, sha256: r.sha256 });
        continue;
      }

      // ── REMOTE (http / gdrive) ──────────────────────────────────────────────
      const got = w.kind === 'http' ? await fetchHttp(w.url, headers) : await fetchDriveFile(w.id, headers);
      if (got.status >= 400) throw new Error(`HTTP ${got.status}`);
      const fetchMeta = { finalUrl: got.finalUrl, status: got.status, contentType: got.contentType };

      // Archive over the wire: size-guard, persist a durable original + signed
      // container record to the dest lane (NEVER deleted), then extract members.
      if (looksLikeZip(got.buf)) {
        if (got.buf.length > ARCHIVE_MAX_BYTES) {
          console.log(`  ⚠ [${w.label}] archive ${(got.buf.length / 1e9).toFixed(1)} GB > ${(ARCHIVE_MAX_BYTES / 1e9).toFixed(0)} GB guard — skipped (not extracted)`);
          appendArchiveNote({ label: w.label, reason: 'oversize', bytes: got.buf.length, source: sourceRecord, ts: stampIso });
          results.push({ label: w.label, status: 'archive_skip_oversize', bytes: got.buf.length });
          continue;
        }
        const archiveName = w.filename && /\.zip$/i.test(w.filename)
          ? w.filename : `${(w.filename || w.label).replace(/[^\w.-]+/g, '_')}.zip`;
        const archivePath = path.join(destDir, archiveName);
        const archiveSha = crypto.createHash('sha256').update(got.buf).digest('hex');
        fs.writeFileSync(archivePath, got.buf);
        const containerRec = {
          schema: 'skycruncher.intake.archive/1', label: w.label, filename: archiveName,
          source: sourceRecord, citation: w.citation ?? null, resolved_url: got.finalUrl,
          http_status: got.status, content_type: got.contentType, bytes: got.buf.length,
          sha256: archiveSha, fetched_at: stampIso, agent: identity, signing_key_fingerprint: keyFp,
        };
        containerRec.signature = { alg: 'HMAC-SHA256', key_fp: keyFp, value: sign(containerRec, key) };
        fs.writeFileSync(`${archivePath}.provenance.json`, JSON.stringify(containerRec, null, 2));
        fs.appendFileSync(LEDGER_FILE, JSON.stringify(containerRec) + '\n');
        console.log(`  📦 [${w.label}] archive ${(got.buf.length / 1e6).toFixed(1)} MB saved → ${archiveName}  (sha ${archiveSha.slice(0, 12)}); extracting…`);
        const archRes = extractAndEmitMembers({
          archiveOnDisk: archivePath, archiveDisplayName: archiveName, archiveSha256: archiveSha,
          sourceRecord, citation: w.citation, fetchMeta, label: w.label, identity, keyFp, key, destDir, force: args.force, stampIso,
        });
        results.push(...archRes);
        continue;
      }

      // ── direct single image ─────────────────────────────────────────────────
      const r = writeClassifiedImage({ buf: got.buf, label: w.label, filenameHint: w.filename, sourceRecord, citation: w.citation, archiveLineage: null, fetchMeta, identity, keyFp, key, destDir, force: args.force, stampIso });
      if (r.rejected) throw new Error(`not a science image: ${r.hint}`);
      if (r.status === 'skip_existing') { console.log(`  ↺ [${w.label}] already present (sha match) → skip`); results.push({ label: w.label, filename: r.filename, status: 'skip_existing', sha256: r.sha256 }); continue; }
      console.log(`  ✓ [${w.label}] ${r.kind} ${(r.bytes / 1e6).toFixed(1)} MB → ${r.filename}  (sha ${r.sha256.slice(0, 12)})`);
      results.push({ label: w.label, filename: r.filename, status: 'fetched', kind: r.kind, bytes: r.bytes, sha256: r.sha256 });
    } catch (err) {
      console.error(`  ✗ [${w.label}] ${err.message}`);
      results.push({ label: w.label, status: 'error', error: err.message });
      // Dead-link ledger (owner protocol 2026-07-09 #5): record failures so
      // future runs never retry them. --retry-dead overrides. A CLASSIFIER
      // rejection is NOT a dead link (the fetch/extract succeeded) — only
      // network/HTTP failures go on the ledger.
      if (!/not a science image/.test(err.message)) {
        fs.mkdirSync(path.dirname(DEAD_LINKS_FILE), { recursive: true });
        fs.appendFileSync(DEAD_LINKS_FILE, JSON.stringify({
          key: wKey, label: w.label, error: err.message, ts: stampIso,
        }) + '\n');
      }
    }
  }

  const ok = results.filter((r) => r.status === 'fetched');
  const fits = ok.filter((r) => r.kind === 'FITS').length;
  const raw = ok.filter((r) => r.kind === 'TIFF/RAW').length;
  const memberRej = results.filter((r) => r.status === 'member_rejected').length;
  const arcSkip = results.filter((r) => r.status === 'archive_skip_oversize' || r.status === 'archive_no_tar').length;
  console.log(`\n  fetched ${ok.length} (${fits} FITS, ${raw} CR2/RAW), ${results.filter((r) => r.status === 'skip_existing').length} skipped, ${results.filter((r) => r.status === 'error').length} errors` +
    (memberRej ? `, ${memberRej} archive members rejected (non-image)` : '') +
    (arcSkip ? `, ${arcSkip} archives not extracted` : ''));
  console.log(`  ledger → ${path.relative(ROOT, LEDGER_FILE)}`);
  if (ok.length) {
    console.log('\n  NEXT — make the new frames eligible, then run the session:');
    console.log('    # CR2 dumps (per file):  CR2_FILE="Sample Files/rotating/<f>.CR2" node tools/dslr/capture_cr2_dets.mjs');
    console.log('    # FITS dumps (per file): node tools/corpus/dump_fits_frame.mjs --file "Sample Files/rotating/<f>.fits"');
    console.log('    node test_results/tmp_inventory.mjs            # regenerate manifest');
    console.log('    node tools/overnight/run_pipeline.mjs --force  # graded pass over the new set');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
