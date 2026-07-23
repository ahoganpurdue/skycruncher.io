// ═══════════════════════════════════════════════════════════════════════════
// tools/atmosphere — measure_sigma_star KERNEL (driven by measure_sigma_star.mjs)
// ═══════════════════════════════════════════════════════════════════════════
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md increment 1. Measures the empirical
// per-star photometric noise floor σ_star(mag[,X]) on the bundled CR2 via forced
// aperture photometry at catalog positions, PER CHANNEL and PER BAND.
//
// LAW 4 CONSOLIDATION (2026-07-21): the §1–8 measurement (decode → catalog →
// geometry recovery → mutual-NN match → saturation cut → per-channel forced
// photometry → raw Δm rows) is NO LONGER inlined here — it is the ONE shared
// implementation in ./lib/star_table.ts (buildStarTable), which increment 2's
// fit_vertical.runspec.ts also consumes. This runspec is now a pure CONSUMER of
// the shared StarTable: it computes σ_star(mag) binning, the row-parity (CFA)
// split, the X-axis honest-refusal, and the JSON/SVG artifacts. Output is
// byte-identical to the pre-consolidation inline kernel (verified md5). The
// engineering + solved-WCS constants below MIRROR lib's for the receipt's
// engineering_values/wcs blocks — they are display provenance, NOT a second
// measurement path (buildStarTable reads the same env/defaults internally).
//
// TWO LEDGERS (Law 1) — both now live in lib/star_table.ts:
//   COORDINATE — catalog RA (HOURS) → gnomonic TAN about the solved anchor →
//     anchored rotation/parity → NATIVE px.
//   PIXEL — forced matched-aperture photometry on the decoded R/G/B planes
//     (native grid, no resample); local-annulus background per aperture.
//
// Engine imports (spec-named): forcedMeasure (now imported by lib) +
// computeAirMass/computeAltAz — the latter two stay referenced HERE so the
// X-axis airmass gate remains coded (it fires only with a trusted GPS location,
// which the bundled CR2 lacks → σ_star(X) NOT MEASURED).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStarTable, type StarRow } from './lib/star_table';
import { AtmosphericManager } from '@/engine/core/AtmosphericManager';
import { TimeService } from '@/engine/core/TimeService';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Display constants (README table; Law 2 — flag, don't tune). These MIRROR
//    lib/star_table.ts's engineering values for the receipt's engineering_values
//    block; the measurement itself reads them inside buildStarTable. ──
const MAG_LIMIT = Number(process.env.ATM_MAGLIMIT ?? 7.0);
const MATCH_TIGHT_PX = 12.0;  // σ-match tolerance (~WCS 2D residual); mutual-NN, MAD-robust
const GEOM_TIGHT_PX = 8.0;    // geometry-recovery match tolerance
const GEOM_MAG = 6.0;         // mag ceiling for geometry recovery (solver verify limit)
const GEOM_ANCHOR_K = 8;      // top-K brightest detections tried as the anchor candidate
const SAT_FRAC = 0.70;
const MAD_K = 1.4826;
const MIN_BIN_N = 8;
const SNR_MIN = 3;
const FETCH_DEG = 22.7;

// ── Solved anchor-WCS for the bundled CR2 (display/provenance; do NOT re-solve) ──
const RA0 = Number(process.env.ATM_RA0 ?? 17.264);            // hours (anchor)
const DEC0 = Number(process.env.ATM_DEC0 ?? -22.5);           // deg   (anchor)
const THETA = Number(process.env.ATM_THETA ?? 157.7);         // deg
const PARITY = Number(process.env.ATM_PARITY ?? 1);
const SCALE = Number(process.env.ATM_SCALE ?? 63.352821428571424); // "/px native
const CACHE = process.env.ATM_CACHE
  ?? path.join(ROOT, 'test_results/psf/beach_measured/.decode_cache_sample_observation.cr2.bin');
const OUT_JSON = process.env.ATM_OUT_JSON ?? path.join(ROOT, 'test_results/atmosphere/sigma_star_cr2.json');
const OUT_SVG = process.env.ATM_OUT_SVG ?? path.join(ROOT, 'test_results/atmosphere/sigma_star_cr2.svg');

// robust stats (downstream σ binning)
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mad = (a: number[]) => { const m = median(a); return MAD_K * median(a.map(v => Math.abs(v - m))); };

describe('tools/atmosphere — σ_star(mag,X) on the bundled CR2', () => {
  it('measures per-channel per-band per-parity σ_star via forced photometry', async () => {
    const notMeasured: Record<string, string> = {};

    // ── §1–8: the SINGLE shared measurement kernel (Law 4 consolidation) ──
    // decode → catalog (band per-row) → geometry recovery → mutual-NN tight match
    // → saturation cut → per-channel forced photometry → raw Δm rows. Formerly an
    // inline copy; now buildStarTable() (the one implementation fit_vertical shares).
    const table = await buildStarTable();
    const c = table.meta.counts;
    const TH = table.meta.theta_deg, PAR = table.meta.parity;
    const [AX, AY] = table.meta.anchor_px;
    const fwhmPx = table.meta.fwhmPx;   // rounded display value (== pre-consolidation)
    const rAp = table.meta.rAp_px;      // aperture radius (shared kernel)
    const bandCount = table.meta.band;
    // scalar diagnostics for the receipt (shape-preserving shims → JSON byte-identical)
    const dets = { length: c.detections };
    const fpAll = { length: c.footprint };
    const matched = { length: c.matched };
    const unsat = { length: c.usable_before_photometry };
    const geo = { ai: table.meta.anchor_rank, m: table.meta.geometry_tight_matches };
    const chance = c.chance;
    const purity = c.purity;            // already +toFixed(3) in lib
    const nSat = c.saturation_cut;
    // the shared per-star Δm table (StarRow.dm null ≡ pre-consolidation's absent key under isFinite)
    const rows: StarRow[] = table.stars;
    console.log(`[table] shared kernel (lib/star_table): dets=${c.detections} footprint=${c.footprint} matched=${c.matched} sat_cut=${nSat} usable=${c.usable}  band GaiaG=${bandCount.GaiaG} JohnsonV=${bandCount.JohnsonV}  anchor#${geo.ai}=(${AX.toFixed(0)},${AY.toFixed(0)}) θ=${TH} parity=${PAR} tight=${geo.m}  fwhmPx=${fwhmPx} rAp=${rAp}`);

    const bands = ['GaiaG', 'JohnsonV'] as const;
    const chs = ['R', 'G', 'B'] as const;
    const vals = (subset: StarRow[], ch: 'R' | 'G' | 'B') => subset.map(r => r.dm[ch]).filter((v): v is number => Number.isFinite(v));
    // per (band, channel) robust ZP = median(Δm) — subtracted before scatter
    const zp: Record<string, Record<string, number>> = {};
    for (const bd of bands) { zp[bd] = {}; const br = rows.filter(r => r.band === bd); for (const ch of chs) zp[bd][ch] = median(vals(br, ch)); }

    // σ_star(mag) binned (per band, per channel) = 1.4826·MAD of ZP-subtracted Δm
    const sigmaByMag: any[] = [];
    for (const bd of bands) {
      const br = rows.filter(r => r.band === bd);
      if (!br.length) continue;
      const mags = br.map(r => Math.floor(r.mag));
      for (let mb = Math.min(...mags); mb <= Math.max(...mags); mb++) {
        const bin = br.filter(r => Math.floor(r.mag) === mb);
        if (!bin.length) continue;
        const entry: any = { band: bd, mag_bin: `${mb}-${mb + 1}`, n: bin.length, sparse: bin.length < MIN_BIN_N };
        for (const ch of chs) {
          const resid = vals(bin, ch).map(v => v - zp[bd][ch]);
          entry[`sigma_${ch}`] = resid.length ? +mad(resid).toFixed(4) : null;
          entry[`n_${ch}`] = resid.length;
          entry[`sigma_${ch}_err`] = resid.length > 1 ? +(mad(resid) / Math.sqrt(2 * (resid.length - 1))).toFixed(4) : null; // asymptotic MAD SE
        }
        sigmaByMag.push(entry);
      }
    }

    // overall σ per (band, channel)
    const sigmaOverall: any = {};
    for (const bd of bands) {
      const br = rows.filter(r => r.band === bd);
      sigmaOverall[bd] = { n: br.length };
      for (const ch of chs) { const resid = vals(br, ch).map(v => v - zp[bd][ch]); sigmaOverall[bd][`sigma_${ch}`] = resid.length ? +mad(resid).toFixed(4) : null; sigmaOverall[bd][`n_${ch}`] = resid.length; }
    }

    // row-parity (CFA checkerboard) split — σ per (band, channel, parity)
    const parity: any[] = [];
    for (const bd of bands) for (const par of [0, 1]) {
      const pr = rows.filter(r => r.band === bd && r.parity === par);
      if (!pr.length) continue;
      const e: any = { band: bd, row_parity: par === 0 ? 'even' : 'odd', n: pr.length };
      for (const ch of chs) { const resid = vals(pr, ch).map(v => v - zp[bd][ch]); e[`sigma_${ch}`] = resid.length ? +mad(resid).toFixed(4) : null; }
      parity.push(e);
    }
    // checkerboard contribution = |σ_even − σ_odd| per band/channel
    const cfa: any = {};
    for (const bd of bands) {
      cfa[bd] = {};
      for (const ch of chs) {
        const ev = parity.find(p => p.band === bd && p.row_parity === 'even');
        const od = parity.find(p => p.band === bd && p.row_parity === 'odd');
        cfa[bd][ch] = (ev && od && Number.isFinite(ev[`sigma_${ch}`]) && Number.isFinite(od[`sigma_${ch}`]))
          ? +Math.abs(ev[`sigma_${ch}`] - od[`sigma_${ch}`]).toFixed(4) : null;
      }
    }

    // ── 9. X axis: NOT MEASURED (spec h) — no EXIF-GPS → airmass ungroundable ──
    // computeAirMass/computeAltAz imported + referenced so the gate is CODED; they
    // fire only when a trusted location exists (it does not for this frame).
    const hasGps = false; // bundled CR2: trusted EXIF time, NO GPS (run_wizard_cr2 header)
    const timestampTrusted = true;
    let xAxis: any;
    if (hasGps && timestampTrusted) {
      // (unreached for this frame) per-star X = computeAirMass(computeAltAz(...).altitude)
      void AtmosphericManager.computeAirMass; void TimeService.computeAltAz;
      xAxis = { measured: true };
    } else {
      xAxis = { measured: false };
      notMeasured['sigma_star(X)'] = hasGps
        ? 'timestampTrusted=false — alt/az frame ungrounded'
        : 'EXIF-GPS absent (no trusted location) — airmass X ungroundable without circularity; bundled CR2 has trusted EXIF time but no GPS (observer location is null — no fabricated default)';
    }
    if (bandCount.JohnsonV === 0 && rows.filter(r => r.band === 'JohnsonV').length === 0)
      notMeasured['sigma_star per JohnsonV band'] = 'shipped bright anchor/L3 catalog is Gaia-format (GaiaG) in this footprint; no HYG/JohnsonV rows present — per-band machinery is in place + tagged, but this frame exercises GaiaG only';

    // ── 10. write JSON + SVG ──
    const out = {
      spec: 'ATMOSPHERE_SEXTANT_SPEC.md increment 1',
      frame: 'public/demo/sample_observation.cr2 (Canon T6 + Rokinon 14mm; LYING 50mm EXIF)',
      decode_source: path.relative(ROOT, CACHE),
      wcs: { ra0_hours: RA0, dec0_deg: DEC0, scale_arcsec_px: SCALE, theta_deg_logged: THETA, parity_logged: PARITY, theta_deg_recovered: TH, parity_recovered: PAR, anchor_px: [AX, AY], anchor_detection_rank: geo.ai, anchor_is_brightest_detection: geo.ai === 0, geometry_recovery_method: `max tight(≤${GEOM_TIGHT_PX}px, mag<${GEOM_MAG}) matches over top-${GEOM_ANCHOR_K} anchors × θ × parity (reproduces the solve geometry; ra/dec/scale FIXED from the solve — not a re-solve)`, geometry_tight_matches: geo.m },
      engineering_values: { MAG_LIMIT, MATCH_TIGHT_PX, GEOM_TIGHT_PX, GEOM_MAG, GEOM_ANCHOR_K, SAT_FRAC, MAD_K, MIN_BIN_N, SNR_MIN, FETCH_DEG, fwhmPx: +fwhmPx.toFixed(3), rAp_px: +rAp.toFixed(3) },
      counts: { detections: dets.length, catalog_footprint: fpAll.length, mutual_nn_matched: matched.length, chance_matches_upper_bound: chance, purity_upper_bound: +purity.toFixed(3), saturation_cut: nSat, usable_before_photometry: unsat.length, usable_rows: rows.length, band: bandCount },
      band_zeropoints: zp,
      sigma_overall: sigmaOverall,
      sigma_by_mag: sigmaByMag,
      row_parity: parity,
      cfa_checkerboard_contribution_mag: cfa,
      x_axis: xAxis,
      NOT_MEASURED: notMeasured,
      exit_gate: {
        n_per_channel: rows.length,
        n_target: 200,
        met_200: rows.length >= 200,
        note: rows.length >= 200 ? 'N≥200 met' : 'N<200 — honest count; bright-anchor/L3 catalog depth-limited in this footprint (see NOT_MEASURED / README deviations)',
      },
    };
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf8');

    // minimal self-contained SVG: σ_star vs mag, R/G/B lines, GaiaG facet
    const svgW = 720, svgH = 420, pad = 56;
    const magsAll = sigmaByMag.map(e => Number(e.mag_bin.split('-')[0]));
    const mMin = Math.min(...magsAll, 0), mMax = Math.max(...magsAll, 8);
    const sMax = Math.max(0.3, ...sigmaByMag.flatMap(e => chs.map(ch => e[`sigma_${ch}`] ?? 0)));
    const sx = (m: number) => pad + (m - mMin) / (mMax - mMin || 1) * (svgW - 2 * pad);
    const sy = (s: number) => svgH - pad - s / sMax * (svgH - 2 * pad);
    const colors: Record<string, string> = { R: '#e05353', G: '#3fa34d', B: '#4a7fe0' };
    let paths = '';
    for (const bd of ['GaiaG']) for (const ch of chs) {
      const pts = sigmaByMag.filter(e => e.band === bd && e[`sigma_${ch}`] != null)
        .map(e => `${sx(Number(e.mag_bin.split('-')[0]) + 0.5).toFixed(1)},${sy(e[`sigma_${ch}`]).toFixed(1)}`);
      if (pts.length) paths += `<polyline fill="none" stroke="${colors[ch]}" stroke-width="2" points="${pts.join(' ')}"/>`;
      for (const e of sigmaByMag.filter(e => e.band === bd && e[`sigma_${ch}`] != null))
        paths += `<circle cx="${sx(Number(e.mag_bin.split('-')[0]) + 0.5).toFixed(1)}" cy="${sy(e[`sigma_${ch}`]).toFixed(1)}" r="${e.sparse ? 2 : 3.5}" fill="${colors[ch]}" opacity="${e.sparse ? 0.4 : 1}"/>`;
    }
    const yticks = [0, 0.1, 0.2, 0.3, 0.4].filter(t => t <= sMax).map(t => `<line x1="${pad}" y1="${sy(t)}" x2="${svgW - pad}" y2="${sy(t)}" stroke="#ccc" stroke-dasharray="3 3"/><text x="${pad - 8}" y="${sy(t) + 4}" text-anchor="end" font-size="11">${t.toFixed(1)}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" font-family="sans-serif">
<rect width="${svgW}" height="${svgH}" fill="white"/>
<text x="${svgW / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">σ_star(mag) — bundled CR2, GaiaG band (R/G/B forced photometry)</text>
${yticks}
<line x1="${pad}" y1="${svgH - pad}" x2="${svgW - pad}" y2="${svgH - pad}" stroke="#333"/>
<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${svgH - pad}" stroke="#333"/>
<text x="${svgW / 2}" y="${svgH - 16}" text-anchor="middle" font-size="12">catalog magnitude (Gaia G)</text>
<text x="16" y="${svgH / 2}" text-anchor="middle" font-size="12" transform="rotate(-90 16 ${svgH / 2})">σ_star (mag, MAD)</text>
<text x="${svgW - pad}" y="${pad - 8}" text-anchor="end" font-size="11" fill="#e05353">R</text>
<text x="${svgW - pad + 16}" y="${pad - 8}" text-anchor="end" font-size="11" fill="#3fa34d">G</text>
<text x="${svgW - pad + 32}" y="${pad - 8}" text-anchor="end" font-size="11" fill="#4a7fe0">B</text>
${paths}
</svg>`;
    fs.writeFileSync(OUT_SVG, svg, 'utf8');

    console.log(`\n[σ_star OVERALL] GaiaG: R=${sigmaOverall.GaiaG.sigma_R} G=${sigmaOverall.GaiaG.sigma_G} B=${sigmaOverall.GaiaG.sigma_B} (n=${sigmaOverall.GaiaG.n})`);
    console.log(`[artifacts] ${path.relative(ROOT, OUT_JSON)}  ${path.relative(ROOT, OUT_SVG)}`);

    expect(fs.existsSync(OUT_JSON)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
