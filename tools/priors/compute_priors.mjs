#!/usr/bin/env node
// tools/priors/compute_priors.mjs
//
// CLI for the deterministic search-prior triage lane (TASK #20 incubator).
//
//   node tools/priors/compute_priors.mjs <file-or-manifest> [--history <dir>] [--lat <deg>] [--lon <deg>] [--read-headers]
//
// * <file>      — a single .fit/.fits/.cr2 (cheap header-only parse) or any file
//                 (filename-only). Prints one { frame, priors } object.
// * <manifest>  — a JSON file with a `frames` array (population manifest shape).
//                 Prints { context, count, ordering, summary, frames:[...] }.
//                 Manifest entries are used as-is (no decode) unless --read-headers
//                 is passed, in which case each frame's header is parsed cheaply.
// * --lat/--lon — observer latitude/longitude override (basis reported as 'locale').
// * --history   — a receipts directory; harvests observer latitude (if present) and
//                 a dec/RA distribution used to bias the queue ordering.
// * --read-headers — parse real FITS/CR2 headers for manifest frames (still no decode).
//
// Pure priors live in priors_core.mjs; this file is the IO shell + ordering/summary.

import fs from 'node:fs';
import path from 'node:path';
import { computePriors } from './priors_core.mjs';
import { buildDescriptor } from './header_read.mjs';

function parseArgs(argv) {
  const args = { _: [], history: null, lat: null, lon: null, readHeaders: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') args.history = argv[++i];
    else if (a === '--lat') args.lat = Number(argv[++i]);
    else if (a === '--lon') args.lon = Number(argv[++i]);
    else if (a === '--read-headers') args.readHeaders = true;
    else args._.push(a);
  }
  return args;
}

// Harvest observer latitude + dec/RA distribution from a receipts dir (best-effort).
function loadHistory(dir) {
  const out = { count: 0, lat_deg: null, decs: [], ras: [] };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const sol = j.solution || j.receipt?.solution || j;
    const dec = num(sol?.center?.dec_deg ?? sol?.dec_deg ?? sol?.crval?.[1] ?? sol?.dec);
    const ra = num(sol?.center?.ra_deg ?? sol?.ra_deg ?? sol?.crval?.[0] ?? sol?.ra);
    const lat = num(j.site_lat ?? sol?.site_lat ?? j.observer?.lat);
    if (dec != null) out.decs.push(dec);
    if (ra != null) out.ras.push(ra);
    if (lat != null && out.lat_deg == null) out.lat_deg = lat;
    out.count++;
  }
  return out;
}

// Fallback metadata carried in the filename itself (labeled as inferred, low trust).
function enrichFromFilename(desc) {
  const s = (desc.rel || desc.filename || desc.path || '');
  if (desc.exposure_s == null) {
    const m = s.match(/(?<![\d.])(\d+(?:\.\d+)?)\s*s(?![a-z])/i); // "60.0s", "240s", "15s"
    if (m) { desc.exposure_s = Number(m[1]); desc.exposure_source = 'filename_token'; }
  }
  if (desc.iso == null) {
    const m = s.match(/iso\s*_?(\d{2,6})/i);
    if (m) { desc.iso = Number(m[1]); desc.iso_source = 'filename_token'; }
  }
  return desc;
}

function buildContext(args, history) {
  const ctx = {};
  if (Number.isFinite(args.lat)) { ctx.lat_deg = args.lat; ctx.lon_deg = Number.isFinite(args.lon) ? args.lon : null; ctx.lat_source = 'locale'; }
  else if (history && history.lat_deg != null) { ctx.lat_deg = history.lat_deg; ctx.lat_source = 'history'; }
  ctx.history = history || null;
  return ctx;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length === 0) {
    process.stderr.write('usage: compute_priors.mjs <file-or-manifest> [--history <dir>] [--lat <deg>] [--lon <deg>] [--read-headers]\n');
    process.exit(2);
  }
  const target = args._[0];
  const history = args.history ? loadHistory(args.history) : null;
  const ctx = buildContext(args, history);

  let manifest = null;
  try { const j = JSON.parse(fs.readFileSync(target, 'utf8')); if (Array.isArray(j.frames)) manifest = j; } catch { /* not a manifest */ }

  if (!manifest) {
    // single file
    const desc = enrichFromFilename(buildDescriptor(target));
    process.stdout.write(JSON.stringify({ context: ctxOut(ctx), ...computePriors(desc, ctx) }, null, 2) + '\n');
    return;
  }

  // manifest sweep
  const rows = [];
  for (const f of manifest.frames) {
    let desc = { path: f.abs || f.rel, rel: f.rel, filename: path.basename(f.rel || f.id || ''), format: f.format };
    if (args.readHeaders && f.abs) { try { desc = { ...buildDescriptor(f.abs), rel: f.rel }; } catch { /* keep light desc */ } }
    desc = enrichFromFilename(desc);
    const p = computePriors(desc, ctx);
    rows.push({ id: f.id, rel: f.rel, ...p });
  }
  // ordering = queue_score desc (stable by original index for ties)
  const ordering = rows.map((r, i) => ({ i, id: r.id, score: r.priors.queue_score.value }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const summary = {
    n_frames: rows.length,
    name_hints_found: rows.filter((r) => r.priors.name_hint.value).length,
    visibility_flags_raised: rows.filter((r) => r.priors.visibility_cut.value?.provenance_mismatch).length,
    route_narrow_fast: rows.filter((r) => r.priors.header_wcs_route.value === 'narrow_fast').length,
    route_blind: rows.filter((r) => r.priors.header_wcs_route.value === 'blind').length,
    regime_breakdown: tally(rows.map((r) => r.priors.regime.value)),
    top10_queue: ordering.slice(0, 10).map((o) => o.id),
  };

  process.stdout.write(JSON.stringify({ context: ctxOut(ctx), count: rows.length, summary, ordering, frames: rows }, null, 2) + '\n');
}

function ctxOut(ctx) { return { lat_deg: ctx.lat_deg ?? null, lon_deg: ctx.lon_deg ?? null, lat_source: ctx.lat_source ?? 'absent', history_count: ctx.history?.count ?? 0 }; }
function tally(arr) { const t = {}; for (const x of arr) t[x] = (t[x] || 0) + 1; return t; }
function num(v) { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; }

run();
