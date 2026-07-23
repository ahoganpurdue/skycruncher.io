#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/manifest.mjs — Manifest Builder v2
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN.md §5 Stage 12 + §6. Generalizes the enumerate/sha/timeout
// guts of tools/corpus/population_timing_run.mjs (the proven runner — behavior
// preserved) and encodes TONIGHT'S TWO EXPENSIVE LESSONS as build-time policy:
//
//  ① CORRELATED-SET SAMPLER. Frames that are sub-exposures of ONE (rig × target ×
//     night) — varying NOTHING but sequence index / capture time / sensor temp —
//     are a correlated set: we deterministically SAMPLE N=3 (sha-ordered) and tag
//     the remainder skipped_correlated_set / stack-lane AT BUILD TIME, never by
//     mid-run surgery. The population run wastefully solved 11 of the 25 Cocoon
//     lights before an owner mid-run kill skipped the other 14; v2 skips 22 up
//     front and solves 3. A set that varies a SCIENCE AXIS (filter band, exposure,
//     mosaic tile, gain, integration) is NOT correlated — it is enumerated FULLY
//     (the r_mosaic lesson: the B/G/H/I/O/R bands straddled a broken gate and
//     exposed it; sampling them would have hidden the bug).
//     HONEST DEFAULT (LAW 3 / visuals-data-decouple): a look-alike cluster with NO
//     positive correlation evidence (bare `IMG_####` counters, no shared exposure/
//     ISO/lights-container) is ENUMERATED, not sampled — we never drop data on a
//     guess. That is why the 18 Canon-T6 challenge frames all run.
//
//  ② SIZE/PATH-SCALED TIMEOUTS keyed by (format × header-WCS-presence × pixel-
//     count). A FITS with a WCS solution already in its header gets the fast
//     budget; a no-WCS FITS routes to BLIND and gets the blind budget (the
//     carina60Da lesson: FITS ultra-wides were killed at the old 120 s FITS wall
//     when a real ultra-wide solve needs ~130 s — a premature kill, not a slow
//     failure). Each row records provenance measured-vs-scaled (LAW 3). The
//     > 2 GiB Node readFileSync ceiling is an explicit skip-with-reason.
//
// Everything policy-shaped (classifySets, assignTimeout, sampleCorrelated,
// tokenize) is PURE and unit-tested on synthetic inputs. The FITS header probe
// is injectable so tests stay hermetic and the retro-validation can reuse the
// already-enumerated population frames (no multi-GB re-sha).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── constants ────────────────────────────────────────────────────────────────
export const SAMPLE_N = 3;                        // correlated-set deterministic sample size
export const MAX_READ = 2147483648;               // 2 GiB — Node readFileSync hard ceiling (runspec reads whole file)
export const EXT_RE = /\.(cr2|fits|fit|fts)$/i;   // science-frame extensions (case-insensitive → Linux-safe)
export const LIGHTS_DIR_RE = /(^|\/)(lights?|subs?|sublights?)(\/|$)/i;   // correlated-container evidence

// Filter-band alphabet for the band-axis merge. LRGB + narrowband (Ha/OIII/SII
// abbreviated H/O/S) + photometric I. Deliberately EXCLUDES m/c/n/y/v/u (Messier/
// Caldwell/name letters) to avoid false merges of distinct targets.
const BAND_ALPHABET = new Set(['l', 'r', 'g', 'b', 'h', 'o', 's', 'i']);

// Evidence-derived timeout table (population_run_2026-07-11, quiet serial, rawler).
export const TIMEOUT_MS = Object.freeze({
  // header-WCS FITS — fast budget. Measured basis: 38/40 solves finished < 15 s
  // (FITS median 6.1 s, fast cluster 1.3–8.6 s); narrow-fast-fails self-terminate
  // 3.9–6 s; NO solve lands near its wall (census: owner-hypothesis-holds). 60 s
  // is ~4× the slowest observed solve — generous without masking a hang.
  FITS_FAST: 60_000,
  // CR2 (always blind) + no-WCS FITS (blind route). Measured basis: the only two
  // solves over 60 s were legit CR2 ultra-wides at 128.5 / 137.7 s — far below
  // 300 s; CR2 ladder-exhaustion self-terminates 135–198 s < 300 s. The blind
  // budget is what a no-WCS FITS ultra-wide needs; the old 120 s FITS wall killed
  // carina60Da prematurely.
  BLIND: 300_000,
});
// Size band the FITS_FAST budget was measured on. The population's header-WCS
// FITS solved at ≤ ~30 Mpix / ≤ ~200 MB; 512 MB gives headroom. A header-WCS FITS
// larger than this is beyond the measured band → the budget is size-SCALED and
// the row says so (provenance: 'size-scaled').
export const FAST_REF_BYTES = 512 * 1024 * 1024;

// ── streaming sha (from the proven runner; handles > 2 GiB, bytes never buffered)
export function sha256Stream(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', rej); s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex')));
  });
}

// ── FITS header-WCS probe (cheap, header-only — never ingests pixel data) ─────
// Reads 2880-byte FITS blocks (36 × 80-char cards) until END or a cap. Extracts
// WCS presence + NAXIS1/2 (pixel count). Returns { probed:false } on any error →
// honest absence, callers fall back to a conservative blind budget.
const FITS_WCS_CARD = /^(CTYPE1|CRVAL1|CD1_1|PC1_1|CDELT1|CRPIX1|A_ORDER|WCSAXES)\s*=/;
export function probeFitsHeader(absPath, maxBlocks = 30) {
  let fd;
  try { fd = fs.openSync(absPath, 'r'); } catch { return { probed: false }; }
  try {
    const BLK = 2880, buf = Buffer.alloc(BLK);
    let wcs = false, n1 = null, n2 = null, ended = false, blocks = 0;
    while (blocks < maxBlocks && !ended) {
      const read = fs.readSync(fd, buf, 0, BLK, blocks * BLK);
      if (read < BLK) break;
      for (let i = 0; i < 36; i++) {
        const card = buf.toString('latin1', i * 80, i * 80 + 80);
        if (card.startsWith('END ') || card.trimEnd() === 'END') { ended = true; break; }
        if (FITS_WCS_CARD.test(card)) wcs = true;
        const m1 = card.match(/^NAXIS1\s*=\s*(\d+)/); if (m1) n1 = +m1[1];
        const m2 = card.match(/^NAXIS2\s*=\s*(\d+)/); if (m2) n2 = +m2[1];
      }
      blocks++;
    }
    return { probed: true, wcs_present: wcs, naxis1: n1, naxis2: n2, pixel_count: (n1 && n2) ? n1 * n2 : null };
  } catch { return { probed: false }; }
  finally { try { fs.closeSync(fd); } catch {} }
}

// ── tokenizer: split a frame basename into acquisition tokens + a residual stem ─
// The residual stem clusters same-target frames; the token categories drive the
// correlated-vs-axis decision. NOTHING axes (seq/timestamp/temp) may vary within
// a correlated set; SCIENCE axes (band/exposure/iso/gain/binning/mosaic/
// integration) varying => not correlated => enumerate.
export function tokenize(basename) {
  const noExt = basename.replace(EXT_RE, '').toLowerCase();
  const t = { timestamp: [], exposure: [], iso: [], gain: [], binning: [], integration: [], mosaic: [], temp: [], seq: [], band: null };
  let s = ` ${noExt} `;
  const eat = (re, cat) => { s = s.replace(re, (m, g) => { t[cat].push((g ?? m).trim()); return ' '; }); };
  // order matters: most specific first
  eat(/(\d{8}[_-]\d{6})/g, 'timestamp');                    // 20260516_064736
  eat(/(\d{8})(?=[_\-. ])/g, 'timestamp');                  // bare 8-digit date
  eat(/[_\- ](\d+(?:\.\d+)?)s(?:ec)?(?=[_\-. ])/g, 'exposure'); // 240s 60.0s 30sec
  eat(/iso[_ ]?(\d+)/g, 'iso');                             // iso800 iso100
  eat(/gain[_ ]?(\d+)/g, 'gain');
  eat(/[_\- ](bin[_ ]?\d|\dx\d)(?=[_\-. ])/g, 'binning');   // bin2 2x2
  eat(/[_\- ](\d+(?:\.\d+)?)h(?=[_\-. ])/g, 'integration'); // 6h 11h 12h
  eat(/[_\- ](r\d+c\d+)(?=[_\-. ])/g, 'mosaic');            // r0c0 r1c2 (row/col tile)
  eat(/[_\- ](-?\d+)c(?=[_\-. ])/g, 'temp');                // 18c -10c (sensor temp)
  eat(/[_\- ](\d{2,})(?=[_\-. ])/g, 'seq');                 // 0020 001 331 (sequence counter, len≥2)
  // residual stem = leftover word tokens joined by underscore
  const stem = s.trim().split(/[^a-z0-9]+/).filter(Boolean).join('_');
  // trailing single-letter band token (delimited) — the r_mosaic band lives here
  const parts = stem.split('_');
  let band = null, stemNoBand = stem;
  if (parts.length && parts[parts.length - 1].length === 1 && BAND_ALPHABET.has(parts[parts.length - 1])) {
    band = parts[parts.length - 1];
    stemNoBand = parts.slice(0, -1).join('_');
  }
  t.band = band;
  return { ...t, stem, stemNoBand };
}

// ── which SCIENCE axes actually VARY across a cluster's members ────────────────
function varyingScienceAxes(members) {
  const cats = ['exposure', 'iso', 'gain', 'binning', 'integration', 'mosaic'];
  const varying = [];
  for (const c of cats) {
    const vals = new Set(members.map((m) => (m.tok[c] || []).join(',')));
    if (vals.size > 1) varying.push(c);
  }
  // band varies when ≥2 distinct band values appear among members
  const bands = new Set(members.map((m) => m.tok.band).filter(Boolean));
  if (bands.size > 1) varying.push('filter_band');
  return varying;
}

// positive (rig × target × night) correlation evidence: a shared acquisition
// signature. Without it we do NOT sample (honest default — keep the data).
function hasCorrelationSignature(members, dir) {
  if (LIGHTS_DIR_RE.test(dir)) return { ok: true, why: 'lights-container dir' };
  const sameNonNull = (cat) => {
    const vals = members.map((m) => (m.tok[cat] || []).join(','));
    return vals.every((v) => v && v === vals[0]);
  };
  if (sameNonNull('exposure')) return { ok: true, why: 'shared exposure token' };
  if (sameNonNull('iso')) return { ok: true, why: 'shared ISO token' };
  return { ok: false, why: 'no shared exposure/ISO/lights-container' };
}

// ── correlated-set sampler: deterministic sha-ordered pick of N ───────────────
export function sampleCorrelated(members, n = SAMPLE_N) {
  const ordered = [...members].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : (a.id < b.id ? -1 : 1)));
  const sampled = ordered.slice(0, n);
  const skipped = ordered.slice(n);
  return { sampled, skipped };
}

// ── classification: assign every frame a disposition (PURE) ───────────────────
// Input frames: { id, rel, sha, format, oversize }. Returns per-frame records +
// a groups roll-up. Deterministic given the same inputs.
export function classifySets(frames, opts = {}) {
  const sampleN = opts.sample_n ?? SAMPLE_N;
  // annotate with tokens + dir
  const ann = frames.map((f) => {
    const base = f.rel.split('/').pop();
    const dir = f.rel.split('/').slice(0, -1).join('/');
    return { ...f, base, dir, tok: tokenize(base) };
  });
  // group key = dir | stemNoBand (band stripped so B/G/…/R cluster into one set)
  const groups = new Map();
  for (const f of ann) {
    if (f.oversize) continue;                    // oversize handled as its own disposition
    const key = `${f.dir}|${f.tok.stemNoBand}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(f);
  }
  const records = new Map();                     // id → disposition record
  const groupRoll = [];
  for (const f of ann) if (f.oversize) {
    records.set(f.id, { id: f.id, lane: 'skip', disposition: 'skipped_too_large', reason: 'oversize_readfilesync_ceiling', set_id: null, set_size: 1, sampled: false });
  }
  let gi = 0;
  for (const [key, members] of [...groups.entries()].sort()) {
    const setId = `set${String(gi++).padStart(3, '0')}`;
    const dir = members[0].dir;
    const size = members.length;
    const roll = { set_id: setId, key, dir, size, kind: null, axis: null, sampled_ids: [], skipped_ids: [] };
    const putEnum = (reason, axis = null) => {
      roll.kind = reason; roll.axis = axis;
      for (const m of members) records.set(m.id, { id: m.id, lane: 'solve', disposition: 'enumerated', reason, set_id: setId, set_size: size, set_axis: axis, sampled: true });
    };
    if (size <= sampleN) { putEnum(size === 1 ? 'singleton' : 'small_set'); groupRoll.push(roll); continue; }
    const axes = varyingScienceAxes(members);
    if (axes.length) { putEnum('axis_varying', axes.join(',')); groupRoll.push(roll); continue; }
    // only nothing-axes vary → sample IFF we have positive correlation evidence
    const sig = hasCorrelationSignature(members, dir);
    if (!sig.ok) { putEnum('unconfirmed_set'); roll.note = sig.why; groupRoll.push(roll); continue; }
    const { sampled, skipped } = sampleCorrelated(members, sampleN);
    roll.kind = 'correlated_set'; roll.signature = sig.why;
    for (const m of sampled) { records.set(m.id, { id: m.id, lane: 'solve', disposition: 'sampled', reason: 'correlated_set_sample', set_id: setId, set_size: size, sampled: true }); roll.sampled_ids.push(m.id); }
    for (const m of skipped) { records.set(m.id, { id: m.id, lane: 'stack', disposition: 'skipped_correlated_set', reason: 'correlated_set_remainder', set_id: setId, set_size: size, sampled: false }); roll.skipped_ids.push(m.id); }
    groupRoll.push(roll);
  }
  return { records, groups: groupRoll };
}

// ── timeout assignment (PURE), keyed by (format × header-WCS × pixel/size) ─────
// probe = { wcs_present, pixel_count } for FITS (null/undefined → unknown).
export function assignTimeout(frame, probe) {
  if (frame.oversize) {
    return { timeout_ms: null, budget_class: 'skip', provenance: 'n/a', basis: `oversize ${(frame.size_bytes / 1e9).toFixed(2)}GB ≥ 2GiB readFileSync ceiling — skipped, not budgeted` };
  }
  if (frame.format === 'CR2') {
    return { timeout_ms: TIMEOUT_MS.BLIND, budget_class: 'blind', provenance: 'measured', basis: 'CR2 always blind; UW CR2 solves 128.5/137.7s < 300s; ladder self-terminates 135–198s' };
  }
  // FITS
  const wcs = probe ? probe.wcs_present : undefined;
  if (wcs === true) {
    const base = TIMEOUT_MS.FITS_FAST;
    if (frame.size_bytes != null && frame.size_bytes > FAST_REF_BYTES) {
      const mult = Math.ceil(frame.size_bytes / FAST_REF_BYTES);
      const scaled = Math.min(TIMEOUT_MS.BLIND, base * mult);
      return { timeout_ms: scaled, budget_class: 'fast', provenance: 'size-scaled', basis: `header-WCS FITS ${(frame.size_bytes / 1e9).toFixed(2)}GB beyond ${(FAST_REF_BYTES / 1e6)}MB measured band → base ${base}ms ×${mult} (cap ${TIMEOUT_MS.BLIND}ms)` };
    }
    return { timeout_ms: base, budget_class: 'fast', provenance: 'measured', basis: 'header-WCS FITS; solves < 15s, no solve near wall' };
  }
  if (wcs === false) {
    return { timeout_ms: TIMEOUT_MS.BLIND, budget_class: 'blind', provenance: 'measured', basis: 'no-WCS FITS → blind route; carina60Da UW-kill lesson (old 120s FITS wall killed a real UW solve prematurely)' };
  }
  // wcs unknown (probe unavailable) → conservative blind, honestly flagged
  return { timeout_ms: TIMEOUT_MS.BLIND, budget_class: 'blind', provenance: 'scaled:probe-unavailable', basis: 'FITS header probe unavailable → conservative blind budget' };
}

// ── enumeration (generalizes the runner's walk; deeper default subsumes the
//    cocoon-lights depth-4 special-case; case-insensitive ext = Linux-safe) ────
export function walk(dir, depth, maxDepth, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1, maxDepth, acc); }
    else if (EXT_RE.test(e.name)) acc.push(full);
  }
}
export async function enumerateFrames(samplesRoot, opts = {}) {
  const maxDepth = opts.maxDepth ?? 6;             // deep enough to reach corpus/<set>/lights/*
  const acc = [];
  walk(samplesRoot, 1, maxDepth, acc);
  const seen = new Set(), frames = [];
  for (const abs of acc.sort()) {
    const norm = abs.replace(/\\/g, '/');
    if (seen.has(norm)) continue; seen.add(norm);
    const rel = path.relative(samplesRoot, abs).replace(/\\/g, '/');
    const ext = path.extname(abs).toLowerCase();
    const format = ext === '.cr2' ? 'CR2' : 'FITS';
    const size = fs.statSync(abs).size;
    const sha = await sha256Stream(abs);          // streaming — >2GiB safe; bytes never enter context
    frames.push({ id: rel.replace(/[^A-Za-z0-9._-]/g, '_'), rel, abs: norm, format, ext, size_bytes: size, oversize: size >= MAX_READ, sha });
  }
  return frames;
}

// ── buildManifest: enumerate-or-reuse → classify → probe → timeout → emit ─────
// `frames` may be supplied pre-enumerated (retro-validation feeds the shipped
// population frames — no multi-GB re-sha). `probe` is injectable (default: real
// FITS header probe against frame.abs); tests pass a synthetic probe.
export async function buildManifest(cfg) {
  const label = cfg.label;
  const sampleN = cfg.sample_n ?? SAMPLE_N;
  const probe = cfg.probe ?? ((f) => f.format === 'FITS' && f.abs ? probeFitsHeader(f.abs) : undefined);
  let frames = cfg.frames;
  if (!frames) {
    if (!cfg.samples) throw new Error('buildManifest: supply either cfg.frames or cfg.samples (root to enumerate)');
    frames = await enumerateFrames(cfg.samples, cfg);
  }
  const { records, groups } = classifySets(frames, { sample_n: sampleN });
  const rows = frames.map((f) => {
    const disp = records.get(f.id);
    const pr = disp.disposition === 'skipped_too_large' ? undefined : probe(f);
    const budget = assignTimeout(f, pr);
    return {
      id: f.id, rel: f.rel, abs: f.abs, sha: f.sha, size_bytes: f.size_bytes, format: f.format,
      lane: disp.lane, disposition: disp.disposition, reason: disp.reason,
      set_id: disp.set_id, set_size: disp.set_size, set_axis: disp.set_axis ?? null, sampled: disp.sampled,
      header_wcs: pr && pr.probed ? !!pr.wcs_present : null,
      pixel_count: pr && pr.probed ? (pr.pixel_count ?? null) : null,
      timeout_ms: budget.timeout_ms, timeout_class: budget.budget_class,
      timeout_provenance: budget.provenance, timeout_basis: budget.basis,
    };
  });
  const dist = distribution(rows);
  return {
    schema: 'testkit.manifest.v2',
    label: label ?? null,
    generated: cfg.now ?? new Date().toISOString(),
    sample_n: sampleN,
    n_frames: rows.length,
    distribution: dist,
    groups,
    frames: rows,
  };
}

// distribution roll-up used by the retro-validation + summary
export function distribution(rows) {
  const c = (pred) => rows.filter(pred).length;
  return {
    solve_lane: c((r) => r.lane === 'solve'),
    stack_lane: c((r) => r.lane === 'stack'),
    skip_lane: c((r) => r.lane === 'skip'),
    sampled: c((r) => r.disposition === 'sampled'),
    enumerated: c((r) => r.disposition === 'enumerated'),
    skipped_correlated_set: c((r) => r.disposition === 'skipped_correlated_set'),
    skipped_too_large: c((r) => r.disposition === 'skipped_too_large'),
    timeout_fast: c((r) => r.timeout_class === 'fast'),
    timeout_blind: c((r) => r.timeout_class === 'blind'),
    timeout_measured: c((r) => r.timeout_provenance === 'measured'),
    timeout_scaled: c((r) => String(r.timeout_provenance).includes('scaled')),
  };
}
