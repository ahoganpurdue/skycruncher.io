#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/residuals.mjs — the edge-residual instrument.
//
// The owner's standing directive, made permanent: "solid matches in the center,
// fail on the edges, by this amount — tells us a hell of a lot." This tool reads
// the matched_stars of every blind-solved frame in the corpus and measures HOW
// the astrometric residual grows from the optical center toward the frame edge.
//
// Per frame it emits, over the core's center-normalized radius (0 at the optical
// center, ~1.0 at a corner):
//   · a residual-vs-radius BINNED PROFILE (median/mean/p90 per bin),
//   · a SLOPE (arcsec of residual per unit normalized radius) via least squares,
//   · a CENTER/EDGE SPLIT and the EDGE EXCESS (edge median − center median, the
//     owner's "by this amount"),
//   · a rig-fair PIXEL twin (residual_arcsec / pixel_scale) so rigs at wildly
//     different plate scales are comparable,
//   · a DISTORTION-SIGNATURE flag that fires only on genuine radial GROWTH
//     (slope AND edge-excess both beyond thresholds STATED IN THE SPEC — never
//     hardcoded silently), and
//   · a REFIT-CANDIDATE ranking (frames whose residual field justifies the
//     measured-BC / SIP refit lane, ranked by measured edge excess).
// It then aggregates slope + edge-excess PER RIG and PER SCALE bucket.
//
// HOUSE LAWS embodied here:
//   · LAW 3 (honest-or-absent): a frame with no matched_stars (no-solve /
//     assisted / dims absent) is a MEASURED:false row carrying an explicit
//     "NOT MEASURED — <reason>". A bin with too few stars gets null stats, not a
//     fabricated zero. Every threshold is READ from the resolved spec.
//   · Deterministic: same corpus + same spec → byte-identical result JSON. The
//     ONLY wall-clock value is provenance.generated_at (from emitResult). Frames
//     arrive pre-sorted by key from the core; every aggregation is emitted as an
//     ORDERED array (rig sorted, scale by bin index, profile by bin index).
//   · Spec-as-receipt: the CLI resolves a spec (defaults ← --spec file ← flags),
//     emits { spec, provenance, data } so any figure re-derives bit-for-bit.
//   · Tools lane only. No src/ touch. Imports the query core; never mutates it.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCorpus, loadManifest, resolvePath,
  matchedStars, summarize, groupBy,
  emitResult, stableStringify, corpusProvenance,
  CORPUS_CORE_VERSION, REPO_ROOT, DEFAULT_MANIFEST_PATH,
} from './lib/corpus.mjs';

export const RESIDUALS_TOOL_VERSION = '1.0.0';

// ── the DEFAULT spec (every value is overridable; all are emitted) ────────────
// Thresholds are DEFAULTS, not law — the owner tunes them at the flag or in a
// --spec file, and whatever was actually used is echoed in the result.
export const DEFAULT_SPEC = Object.freeze({
  // profile
  radius_bins: 5,               // equal-width bins over normalized radius [0,1]
  center_edge_split: 0.5,       // radius_norm boundary: center < split ≤ edge
  residual_field: 'residual_arcsec', // the per-star residual field profiled
  // honesty floors
  min_stars: 20,                // usable stars below this → frame NOT MEASURED
  min_stars_per_bin: 4,         // stars in a bin below this → bin stats null
  // distortion signature (radial GROWTH, baseline-independent)
  distortion_slope_threshold_arcsec_per_radius: 3.0, // residual rise center→corner
  distortion_edge_excess_threshold_arcsec: 2.0,      // edge median − center median
  signature_rule: 'slope>=slope_threshold AND edge_excess>=edge_excess_threshold',
  // grouping
  rig_key_fields: ['camera_model', 'lens_model'], // receipt.metadata fields joined
  scale_bin_edges_arcsec_per_px: [0.5, 1, 2, 4, 8, 16], // inner cut points (asc)
});

// ── small numeric helpers (finite-only, honest) ───────────────────────────────
function fin(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

// least-squares slope of y on x. Needs ≥2 points AND ≥2 distinct x. Returns
// {slope,intercept,r2,n} or null-filled honest result when undetermined.
function linreg(pts) {
  const xs = [], ys = [];
  for (const p of pts) { if (fin(p.x) !== null && fin(p.y) !== null) { xs.push(p.x); ys.push(p.y); } }
  const n = xs.length;
  if (n < 2) return { slope: null, intercept: null, r2: null, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0) return { slope: null, intercept: null, r2: null, n }; // no x spread
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? null : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

// binned profile over radius_norm ∈ [0,1]. samples: [{r, y}]. Bins with
// count < minPerBin get null stats (NOT MEASURED) but keep their n.
function binProfile(samples, nbins, minPerBin) {
  const bins = [];
  for (let i = 0; i < nbins; i++) {
    const lo = i / nbins, hi = (i + 1) / nbins;
    bins.push({ bin_index: i, r_lo: lo, r_hi: hi, r_mid: (lo + hi) / 2, _vals: [] });
  }
  for (const s of samples) {
    const r = fin(s.r); if (r === null) continue;
    // clamp to last bin so radius exactly 1.0 lands in bin nbins-1 (not overflow)
    let idx = Math.floor(r * nbins);
    if (idx >= nbins) idx = nbins - 1;
    if (idx < 0) idx = 0;
    const y = fin(s.y); if (y !== null) bins[idx]._vals.push(y);
  }
  return bins.map((b) => {
    const enough = b._vals.length >= minPerBin;
    const st = enough ? summarize(b._vals) : null;
    return {
      bin_index: b.bin_index, r_lo: b.r_lo, r_hi: b.r_hi, r_mid: b.r_mid,
      n: b._vals.length,
      median: st ? st.median : null,
      mean: st ? st.mean : null,
      p90: st ? st.p90 : null,
    };
  });
}

// center/edge split stats for one numeric sample set.
function splitStats(samples, split) {
  const center = [], edge = [];
  for (const s of samples) {
    const r = fin(s.r), y = fin(s.y);
    if (r === null || y === null) continue;
    (r < split ? center : edge).push(y);
  }
  const cs = summarize(center), es = summarize(edge);
  const excess = (cs.median !== null && es.median !== null) ? es.median - cs.median : null;
  return {
    center: { n: cs.n, median: cs.median, mean: cs.mean, p90: cs.p90 },
    edge: { n: es.n, median: es.median, mean: es.mean, p90: es.p90 },
    excess,
  };
}

// ── rig / scale keying (READ from metadata; missing → honest marker) ──────────
function rigOf(frame, spec) {
  const md = frame.receipt && frame.receipt.metadata;
  if (!md || typeof md !== 'object') return null;
  const parts = spec.rig_key_fields.map((k) => {
    const v = md[k];
    return (v === null || v === undefined || v === '') ? '?' : String(v);
  });
  return parts.join(' | ');
}
function pixelScaleOf(frame) {
  const sol = frame.receipt && frame.receipt.solution;
  const md = frame.receipt && frame.receipt.metadata;
  return fin(sol && sol.pixel_scale) ?? fin(md && md.pixel_scale) ?? null;
}
// bucket a plate scale by inner cut points (ascending). Ordered index for sort.
function scaleBinOf(scale, edges) {
  if (scale === null) return { index: -1, label: 'NOT MEASURED', lo: null, hi: null };
  let i = 0;
  while (i < edges.length && scale >= edges[i]) i++; // count edges ≤ scale
  const lo = i === 0 ? null : edges[i - 1];
  const hi = i === edges.length ? null : edges[i];
  const label = lo === null ? `<${hi}` : (hi === null ? `>=${lo}` : `${lo}-${hi}`);
  return { index: i, label, lo, hi };
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-frame analysis. Returns a measured row or an honest NOT-MEASURED row.
// ═══════════════════════════════════════════════════════════════════════════
export function analyzeFrame(frame, spec) {
  const rig = rigOf(frame, spec);
  const pixel_scale = pixelScaleOf(frame);
  const sb = scaleBinOf(pixel_scale, spec.scale_bin_edges_arcsec_per_px);
  const base = {
    key: frame.key, id: frame.id, sha: frame.sha,
    kind: frame.kind, rig, pixel_scale,
    scale_bin_index: sb.index, scale_bin_label: sb.label,
  };

  const stars = matchedStars(frame); // [] when no solution / no matched_stars
  if (!stars.length) {
    return { ...base, measured: false, reason: `NOT MEASURED — no matched_stars (kind=${frame.kind})`, n_stars_total: 0 };
  }
  if (!frame.dims) {
    return { ...base, measured: false, reason: 'NOT MEASURED — frame dims absent (cannot normalize radius)', n_stars_total: stars.length };
  }

  const field = spec.residual_field;
  // usable = has a normalized radius AND a finite residual in the chosen field.
  const samplesArc = [];
  const samplesPx = [];
  for (const s of stars) {
    const r = fin(s.radius_norm);
    const yArc = fin(s[field]);
    if (r === null || yArc === null) continue;
    samplesArc.push({ r, y: yArc });
    if (pixel_scale && pixel_scale > 0) samplesPx.push({ r, y: yArc / pixel_scale });
  }
  const nUsed = samplesArc.length;
  if (nUsed < spec.min_stars) {
    return {
      ...base, measured: false,
      reason: `NOT MEASURED — only ${nUsed} usable matched stars (< min_stars ${spec.min_stars})`,
      n_stars_total: stars.length, n_stars_used: nUsed,
    };
  }

  const regArc = linreg(samplesArc.map((s) => ({ x: s.r, y: s.y })));
  const regPx = samplesPx.length >= 2 ? linreg(samplesPx.map((s) => ({ x: s.r, y: s.y }))) : { slope: null, intercept: null, r2: null, n: samplesPx.length };
  const profile = binProfile(samplesArc, spec.radius_bins, spec.min_stars_per_bin);
  const splitArc = splitStats(samplesArc, spec.center_edge_split);
  const splitPx = splitStats(samplesPx, spec.center_edge_split);

  const slope = regArc.slope;
  const edgeExcess = splitArc.excess;
  const slopeHit = slope !== null && slope >= spec.distortion_slope_threshold_arcsec_per_radius;
  const excessHit = edgeExcess !== null && edgeExcess >= spec.distortion_edge_excess_threshold_arcsec;
  const flagged = slopeHit && excessHit;

  return {
    ...base,
    measured: true,
    n_stars_total: stars.length,
    n_stars_used: nUsed,
    // center/edge (arcsec) — the owner's "by this amount"
    center_median_arcsec: splitArc.center.median,
    edge_median_arcsec: splitArc.edge.median,
    edge_excess_arcsec: edgeExcess,
    center: splitArc.center,
    edge: splitArc.edge,
    // slope (arcsec of residual per unit normalized radius)
    slope_arcsec_per_radius: slope,
    intercept_arcsec: regArc.intercept,
    r2: regArc.r2,
    slope_n: regArc.n,
    // rig-fair pixel twin
    slope_px_per_radius: regPx.slope,
    edge_excess_px: splitPx.excess,
    center_median_px: splitPx.center.median,
    edge_median_px: splitPx.edge.median,
    // the binned profile (ordered array)
    profile,
    // distortion signature (radial growth)
    distortion_signature: {
      flagged,
      slope_hit: slopeHit,
      edge_excess_hit: excessHit,
      rule: spec.signature_rule,
      thresholds: {
        slope_arcsec_per_radius: spec.distortion_slope_threshold_arcsec_per_radius,
        edge_excess_arcsec: spec.distortion_edge_excess_threshold_arcsec,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Corpus-level analysis: per-frame rows + refit ranking + per-rig/scale rollups.
// ═══════════════════════════════════════════════════════════════════════════
export function analyzeResiduals(frames, spec) {
  const per_frame = frames.map((f) => analyzeFrame(f, spec)); // frames pre-sorted by key
  const measured = per_frame.filter((r) => r.measured);

  // ── refit candidates: frames whose residual field justifies a refit, i.e.
  // genuine radial growth (edge_excess_arcsec > 0), ranked by that excess desc.
  const refitPool = measured.filter((r) => r.edge_excess_arcsec !== null && r.edge_excess_arcsec > 0);
  refitPool.sort((a, b) => {
    if (b.edge_excess_arcsec !== a.edge_excess_arcsec) return b.edge_excess_arcsec - a.edge_excess_arcsec;
    const sa = a.slope_arcsec_per_radius ?? -Infinity, sb = b.slope_arcsec_per_radius ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const refit_candidates = refitPool.map((r, i) => ({
    rank: i + 1,
    key: r.key, id: r.id, rig: r.rig,
    pixel_scale: r.pixel_scale, scale_bin_label: r.scale_bin_label,
    edge_excess_arcsec: r.edge_excess_arcsec,
    edge_excess_px: r.edge_excess_px,
    slope_arcsec_per_radius: r.slope_arcsec_per_radius,
    center_median_arcsec: r.center_median_arcsec,
    edge_median_arcsec: r.edge_median_arcsec,
    n_stars_used: r.n_stars_used,
    distortion_flagged: r.distortion_signature.flagged,
  }));

  // ── per-rig aggregation (ordered by rig key) ────────────────────────────────
  const byRig = groupBy(measured, (r) => r.rig ?? 'NOT MEASURED');
  const per_rig = [];
  for (const [rig, rows] of byRig) {
    per_rig.push({
      rig,
      n_frames: rows.length,
      n_flagged: rows.filter((r) => r.distortion_signature.flagged).length,
      slope_arcsec_per_radius: summarize(rows.map((r) => r.slope_arcsec_per_radius)),
      edge_excess_arcsec: summarize(rows.map((r) => r.edge_excess_arcsec)),
      slope_px_per_radius: summarize(rows.map((r) => r.slope_px_per_radius)),
    });
  }

  // ── per-scale aggregation (ordered by bin index) ────────────────────────────
  const byScale = groupBy(measured, (r) => String(r.scale_bin_index).padStart(3, '0'));
  const per_scale = [];
  for (const [, rows] of byScale) {
    const any = rows[0];
    per_scale.push({
      bin_index: any.scale_bin_index,
      label: any.scale_bin_label,
      n_frames: rows.length,
      n_flagged: rows.filter((r) => r.distortion_signature.flagged).length,
      slope_arcsec_per_radius: summarize(rows.map((r) => r.slope_arcsec_per_radius)),
      edge_excess_arcsec: summarize(rows.map((r) => r.edge_excess_arcsec)),
      slope_px_per_radius: summarize(rows.map((r) => r.slope_px_per_radius)),
    });
  }
  per_scale.sort((a, b) => a.bin_index - b.bin_index);

  // ── summary tallies ─────────────────────────────────────────────────────────
  const not_measured = per_frame.filter((r) => !r.measured);
  const by_reason = {};
  for (const r of not_measured) {
    // collapse the numeric tail so reasons bucket by CLASS, not by exact count
    const cls = r.reason.replace(/only \d+ usable matched stars \(< min_stars \d+\)/, 'below min_stars');
    by_reason[cls] = (by_reason[cls] || 0) + 1;
  }
  const summary = {
    frames_total: per_frame.length,
    frames_measured: measured.length,
    frames_not_measured: not_measured.length,
    frames_flagged: measured.filter((r) => r.distortion_signature.flagged).length,
    refit_candidate_count: refit_candidates.length,
    matched_stars_used: measured.reduce((a, r) => a + (r.n_stars_used || 0), 0),
    not_measured_by_reason: by_reason,
  };

  return { summary, per_frame, refit_candidates, per_rig, per_scale };
}

// ═══════════════════════════════════════════════════════════════════════════
// Spec resolution (defaults ← --spec file ← flags). Every field validated;
// unknown-shape inputs fall back to the default (honest, never a silent NaN).
// ═══════════════════════════════════════════════════════════════════════════
export function resolveSpec(overrides = {}) {
  const s = { ...DEFAULT_SPEC, ...overrides };
  // coerce/validate numerics; keep arrays as arrays of finite numbers/strings.
  const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  const num01 = (v, d) => (typeof v === 'number' && v > 0 && v < 1 ? v : d);
  const nonNegNum = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  s.radius_bins = posInt(s.radius_bins, DEFAULT_SPEC.radius_bins);
  s.center_edge_split = num01(s.center_edge_split, DEFAULT_SPEC.center_edge_split);
  s.min_stars = posInt(s.min_stars, DEFAULT_SPEC.min_stars);
  s.min_stars_per_bin = posInt(s.min_stars_per_bin, DEFAULT_SPEC.min_stars_per_bin);
  s.distortion_slope_threshold_arcsec_per_radius = nonNegNum(s.distortion_slope_threshold_arcsec_per_radius, DEFAULT_SPEC.distortion_slope_threshold_arcsec_per_radius);
  s.distortion_edge_excess_threshold_arcsec = nonNegNum(s.distortion_edge_excess_threshold_arcsec, DEFAULT_SPEC.distortion_edge_excess_threshold_arcsec);
  if (typeof s.residual_field !== 'string' || !s.residual_field) s.residual_field = DEFAULT_SPEC.residual_field;
  if (!Array.isArray(s.rig_key_fields) || !s.rig_key_fields.length) s.rig_key_fields = [...DEFAULT_SPEC.rig_key_fields];
  if (!Array.isArray(s.scale_bin_edges_arcsec_per_px) || !s.scale_bin_edges_arcsec_per_px.every((e) => typeof e === 'number' && Number.isFinite(e))) {
    s.scale_bin_edges_arcsec_per_px = [...DEFAULT_SPEC.scale_bin_edges_arcsec_per_px];
  } else {
    s.scale_bin_edges_arcsec_per_px = s.scale_bin_edges_arcsec_per_px.slice().sort((a, b) => a - b);
  }
  if (typeof s.signature_rule !== 'string' || !s.signature_rule) s.signature_rule = DEFAULT_SPEC.signature_rule;
  return s;
}

// ── run over a loaded corpus, produce the { spec, provenance, data } result ────
export function runResiduals(loaded, spec, provExtras = {}) {
  const data = analyzeResiduals(loaded.frames, spec);
  const provenance = {
    tool: 'tools/analytics/residuals.mjs',
    tool_version: RESIDUALS_TOOL_VERSION,
    corpus_core_version: CORPUS_CORE_VERSION,
    ...corpusProvenance(loaded, loaded.root || REPO_ROOT),
    ...provExtras,
  };
  return emitResult(spec, data, provenance);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════
const HELP = `residuals.mjs — edge-residual field analysis over the analytics corpus.

Usage:
  node tools/analytics/residuals.mjs [flags] [> out.json]

Corpus:
  --manifest <path>          corpus manifest (default: tools/analytics/corpus.default.json)

Spec (defaults <- --spec file <- flags):
  --spec <path>              JSON file of spec overrides
  --radius-bins <int>        equal-width radius bins            (default 5)
  --center-edge-split <f>    center/edge boundary in (0,1)      (default 0.5)
  --min-stars <int>          usable-star floor per frame        (default 20)
  --min-stars-per-bin <int>  star floor per profile bin         (default 4)
  --residual-field <name>    per-star residual field            (default residual_arcsec)
  --slope-threshold <f>      distortion slope threshold arcsec/radius (default 3.0)
  --edge-excess-threshold <f> distortion edge-excess threshold arcsec  (default 2.0)
  --rig-fields <a,b>         metadata fields joined into a rig  (default camera_model,lens_model)
  --scale-bins <a,b,c>       plate-scale inner cut points asc   (default 0.5,1,2,4,8,16)

Output:
  --out <path>               write JSON here (default: stdout)
  --top <int>                headline: show top-N refit candidates on stderr (default 10)
  --help

Emits { spec, provenance, data } (spec-as-receipt). Deterministic: same corpus +
same spec -> byte-identical JSON (only provenance.generated_at is wall-clock).`;

function parseArgs(argv) {
  const out = { spec: {}, _flags: {} };
  const next = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': out.help = true; break;
      case '--manifest': out.manifest = next(i); i++; break;
      case '--spec': out.specFile = next(i); i++; break;
      case '--out': out.outFile = next(i); i++; break;
      case '--top': out.top = parseInt(next(i), 10); i++; break;
      case '--radius-bins': out.spec.radius_bins = parseInt(next(i), 10); i++; break;
      case '--center-edge-split': out.spec.center_edge_split = parseFloat(next(i)); i++; break;
      case '--min-stars': out.spec.min_stars = parseInt(next(i), 10); i++; break;
      case '--min-stars-per-bin': out.spec.min_stars_per_bin = parseInt(next(i), 10); i++; break;
      case '--residual-field': out.spec.residual_field = next(i); i++; break;
      case '--slope-threshold': out.spec.distortion_slope_threshold_arcsec_per_radius = parseFloat(next(i)); i++; break;
      case '--edge-excess-threshold': out.spec.distortion_edge_excess_threshold_arcsec = parseFloat(next(i)); i++; break;
      case '--rig-fields': out.spec.rig_key_fields = String(next(i)).split(',').map((x) => x.trim()).filter(Boolean); i++; break;
      case '--scale-bins': out.spec.scale_bin_edges_arcsec_per_px = String(next(i)).split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x)); i++; break;
      default:
        if (a.startsWith('--')) { process.stderr.write(`residuals: unknown flag ${a}\n`); process.exit(2); }
    }
  }
  return out;
}

function headline(result, top) {
  const d = result.data;
  const L = [];
  L.push(`residuals: ${d.summary.frames_measured}/${d.summary.frames_total} frames measured, `
    + `${d.summary.frames_flagged} radial-growth flagged, ${d.summary.refit_candidate_count} refit candidates`);
  const cands = d.refit_candidates.slice(0, Math.max(0, top || 10));
  if (cands.length) {
    L.push(`top ${cands.length} refit candidates (edge_excess arcsec | slope arcsec/radius | rig):`);
    for (const c of cands) {
      const flag = c.distortion_flagged ? ' [FLAGGED]' : '';
      const sl = c.slope_arcsec_per_radius === null ? 'n/a' : c.slope_arcsec_per_radius.toFixed(2);
      L.push(`  #${c.rank} +${c.edge_excess_arcsec.toFixed(2)}"  slope ${sl}  ${c.rig}${flag}  (${c.id})`);
    }
  }
  return L.join('\n') + '\n';
}

function fileToPosix(p) {
  // repo-relative when under the repo, else absolute — both forward-slashed.
  const rel = path.relative(REPO_ROOT, p);
  const use = (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : p;
  return String(use).replace(/\\/g, '/');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP + '\n'); return; }

  // resolve spec: defaults ← --spec file ← flags
  let fileSpec = {};
  if (args.specFile) {
    const p = path.resolve(args.specFile);
    fileSpec = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const spec = resolveSpec({ ...fileSpec, ...args.spec });

  // load corpus (default manifest or --manifest)
  const manifestPath = args.manifest ? path.resolve(args.manifest) : DEFAULT_MANIFEST_PATH;
  const manifest = loadManifest(manifestPath);
  const loaded = loadCorpus({
    receiptDirs: manifest.receiptDirs || [],
    ledgers: manifest.ledgers || [],
    dossierDir: manifest.dossierDir,
    dossierDirs: manifest.dossierDirs,
    envelopeLedgers: manifest.envelopeLedgers || [],
    root: manifest.root ? resolvePath(manifest.root) : REPO_ROOT,
  });

  const result = runResiduals(loaded, spec, {
    corpus_manifest: fileToPosix(manifestPath),
  });
  const json = stableStringify(result);

  if (args.outFile) {
    fs.writeFileSync(path.resolve(args.outFile), json + '\n');
    process.stderr.write(`residuals: wrote ${path.resolve(args.outFile)}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.stderr.write(headline(result, args.top));
}

const __isMain = (() => {
  try { return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();
if (__isMain) main();
