#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant — mount_rotation_fit.mjs
//   Digital-sextant vertical #4: recover observer (lat, lon) from an alt-az
//   tracked session's field-rotation-vs-time history. The mount's leveling is the
//   plumb line; NO atmosphere needed (complements the atmosphere verticals, which
//   fail on narrow fields where this one works). Spec: docs/ATMOSPHERE_SEXTANT_SPEC
//   ADDENDUM "mount-geometry nav family (verticals 4-5)".
//
// USAGE
//   node tools/sextant/mount_rotation_fit.mjs --series <file.json> --target <raH,decDeg> [--out <dir>]
//   node tools/sextant/mount_rotation_fit.mjs --sweep [--out <dir>]      # synthetic characterization
//
//   <file.json> = either  [{t_utc, rotation_deg, sigma?}, ...]
//                 or       {series:[...], target:{ra_hours, dec_deg}}
//   t_utc = epoch-ms UTC or ISO-8601 string.
//
// Pure JS (no engine import) so it runs standalone in the overnight loop; its
// GMST/alt-az primitives (lib/astro.mjs) are cross-checked against the engine's
// TimeService by mount_rotation_fit.runspec.ts. Outputs JSON + an SVG diagnostic
// to test_results/sextant/ (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitMountGeometry, PREDICATE_DEFAULTS } from './fit_core.mjs';
import { generateSeries, startForTransitMidpoint } from './synth.mjs';
import { renderFitSvg } from './chart.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const a = { mode: null, series: null, target: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--sweep') a.mode = 'sweep';
    else if (t === '--series') { a.mode = 'series'; a.series = argv[++i]; }
    else if (t === '--target') a.target = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else { process.stderr.write(`[sextant] unknown arg: ${t}\n`); process.exit(1); }
  }
  return a;
}

function outDir(a) {
  const d = a.out ? path.resolve(a.out) : path.join(ROOT, 'test_results', 'sextant');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── real / provided-series fit ──────────────────────────────────────────────
function runSeries(a) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(a.series), 'utf8'));
  let series, target;
  if (Array.isArray(raw)) {
    series = raw;
    if (!a.target) { process.stderr.write('[sextant] --target raH,decDeg required for a bare-array series\n'); process.exit(1); }
    const [rh, dd] = a.target.split(',').map(Number);
    target = { ra_hours: rh, dec_deg: dd };
  } else {
    series = raw.series; target = raw.target || (a.target ? { ra_hours: +a.target.split(',')[0], dec_deg: +a.target.split(',')[1] } : null);
  }
  if (!target) { process.stderr.write('[sextant] no target (RA,Dec) supplied\n'); process.exit(1); }
  const res = fitMountGeometry({ series, target });
  const dir = outDir(a);
  const jsonPath = path.join(dir, 'mount_fit.json');
  const svgPath = path.join(dir, 'mount_fit.svg');
  fs.writeFileSync(jsonPath, JSON.stringify(res, null, 2));
  fs.writeFileSync(svgPath, renderFitSvg(res, { title: `mount fit · target RA ${target.ra_hours}h Dec ${target.dec_deg}°` }));
  const s = summarize(res);
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  process.stderr.write(`[artifacts] ${path.relative(ROOT, jsonPath)} · ${path.relative(ROOT, svgPath)}\n`);
}

function summarize(res) {
  return {
    status: res.status,
    failed_predicate: res.failed_predicate || null,
    detail: res.detail || null,
    fit: res.fit ? {
      lat_deg: round(res.fit.lat_deg, 4), lon_deg: round(res.fit.lon_deg, 4),
      sigma_lat_deg: round(res.fit.sigma_lat_deg, 4), sigma_lon_deg: round(res.fit.sigma_lon_deg, 4),
      parity: res.fit.parity, q0_deg: round(res.fit.q0_deg, 3),
    } : null,
    predicates: res.predicates,
  };
}
function round(x, n) { const f = 10 ** n; return isFinite(x) ? Math.round(x * f) / f : x; }

// ── synthetic characterization sweep ────────────────────────────────────────
const SWEEP = {
  lats: [{ name: 'equator', v: 0 }, { name: 'mid', v: 40 }, { name: 'high', v: 65 }],
  decs: [-20, 30, 70],
  lengths: [{ min: 10, cad: 30 }, { min: 60, cad: 60 }, { min: 180, cad: 120 }],
  noises: [0.01, 0.05, 0.2],
  // transit = SYMMETRIC about the meridian (parity-degenerate, honest refusal);
  // cross_asym = ASYMMETRIC meridian crossing (best geometry: curvature + parity fixed);
  // offmeridian = monotonic descending arc, no transit.
  regimes: ['transit', 'cross_asym', 'offmeridian'],
};

function runSweep(a) {
  const baseDate = Date.UTC(2024, 2, 21, 0, 0, 0);
  const q0True = 42.0, parity = -1;
  const rows = [];
  let representative = null; // a MEASURED transit case for the sample chart
  for (const regime of SWEEP.regimes) {
    for (const lat of SWEEP.lats) {
      for (const dec of SWEEP.decs) {
        const target = { ra_hours: 8.0, dec_deg: dec };
        const lonTrue = -71.0;
        const transitStart = startForTransitMidpoint({ target, phiTrue: lat.v, lambdaTrue: lonTrue, dateUtcMs: baseDate, durationMin: 180 });
        for (const len of SWEEP.lengths) {
          for (const noise of SWEEP.noises) {
            // transit: session centered on transit (symmetric); cross_asym: 75% before
            // / 25% after transit (asymmetric crossing); offmeridian: 2.5 h after transit
            const symStart = startForTransitMidpoint({ target, phiTrue: lat.v, lambdaTrue: lonTrue, dateUtcMs: baseDate, durationMin: len.min });
            const transitMid = symStart + (len.min / 2) * 60000;
            const start = regime === 'transit'
              ? symStart
              : regime === 'cross_asym'
                ? transitMid - 0.75 * len.min * 60000
                : transitStart + 2.5 * 3600 * 1000;
            const gen = generateSeries({
              phiTrue: lat.v, lambdaTrue: lonTrue, q0True, parity, target,
              startUtcMs: start, durationMin: len.min, cadenceSec: len.cad, noiseDeg: noise, seed: 100 + rows.length,
            });
            const res = fitMountGeometry({ series: gen.series, target });
            const row = {
              regime, lat: lat.name, lat_true: lat.v, dec, len_min: len.min, noise_deg: noise,
              n: gen.series.length, below_horizon: gen.belowHorizon,
              status: res.status, failed: res.failed_predicate || null,
              lat_err: res.fit ? round(res.fit.lat_deg - lat.v, 3) : null,
              lon_err: res.fit ? round(res.fit.lon_deg - lonTrue, 3) : null,
              sig_lat: res.fit ? round(res.fit.sigma_lat_deg, 3) : null,
              sig_lon: res.fit ? round(res.fit.sigma_lon_deg, 3) : null,
              curv_snr: res.predicates.rate_curvature ? round(res.predicates.rate_curvature.snr, 2) : null,
              parity_ok: res.fit ? (res.fit.parity === parity) : null,
            };
            rows.push(row);
            if (!representative && regime === 'cross_asym' && res.status === 'MEASURED' && len.min === 180 && noise === 0.05) {
              representative = { res, label: `synthetic ${lat.name} lat ${lat.v}° · dec ${dec}° · 3h asym meridian crossing · noise 0.05°` };
            }
          }
        }
      }
    }
  }
  const dir = outDir(a);
  const jsonPath = path.join(dir, 'sweep_recovery.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ thresholds: PREDICATE_DEFAULTS, sweep_axes: SWEEP, truth: { lon_deg: -71.0, q0_deg: q0True, parity }, rows }, null, 2));
  let svgRel = null;
  if (representative) {
    const svgPath = path.join(dir, 'sweep_sample_fit.svg');
    fs.writeFileSync(svgPath, renderFitSvg(representative.res, { title: representative.label }));
    svgRel = path.relative(ROOT, svgPath);
  }
  printTable(rows);
  const measured = rows.filter((r) => r.status === 'MEASURED');
  const refused = rows.filter((r) => r.status === 'NOT_MEASURED');
  const parityErr = measured.filter((r) => r.parity_ok === false).length;
  process.stderr.write(`\n[summary] ${rows.length} configs · MEASURED ${measured.length} · NOT_MEASURED ${refused.length} · parity-wrong ${parityErr}\n`);
  process.stderr.write(`[artifacts] ${path.relative(ROOT, jsonPath)}${svgRel ? ' · ' + svgRel : ''}\n`);
}

function printTable(rows) {
  const hdr = ['regime', 'lat', 'φtrue', 'dec', 'len', 'noise', 'N', 'status', 'failed/Δlat,Δlon', 'σlat', 'σlon', 'curvSNR'];
  const fmt = (r) => {
    const outcome = r.status === 'MEASURED'
      ? `Δ${(r.lat_err ?? 0).toFixed(2)},${(r.lon_err ?? 0).toFixed(2)}`
      : (r.failed || '—');
    return [
      r.regime.slice(0, 8), r.lat, String(r.lat_true), String(r.dec), `${r.len_min}m`,
      String(r.noise_deg), String(r.n), r.status === 'MEASURED' ? 'OK' : 'REFUSE',
      outcome, r.sig_lat == null ? '—' : String(r.sig_lat), r.sig_lon == null ? '—' : String(r.sig_lon),
      r.curv_snr == null ? '—' : String(r.curv_snr),
    ];
  };
  const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r)[i].length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  process.stdout.write(line(hdr) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const r of rows) process.stdout.write(line(fmt(r)) + '\n');
}

// ── main ────────────────────────────────────────────────────────────────────
const a = parseArgs(process.argv.slice(2));
if (a.mode === 'sweep') runSweep(a);
else if (a.mode === 'series') runSeries(a);
else { process.stderr.write('[sextant] specify --sweep or --series <file.json> --target raH,decDeg\n'); process.exit(1); }
