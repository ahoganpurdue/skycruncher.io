// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/chart.mjs — dependency-free SVG diagnostics for a mount-fit result
// ═══════════════════════════════════════════════════════════════════════════
// Three stacked panels: (1) rotation vs time with the fitted model overlaid,
// (2) residuals vs time (±σ band), (3) the (lat,lon) covariance ellipse.
// No external deps; matches the step-6-chart honesty style (±1σ printed).

import { wrap180 } from './lib/astro.mjs';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function renderFitSvg(result, { title } = {}) {
  const W = 820, H = 720, mL = 64, mR = 24;
  const per = result.diagnostics.per_point;
  const model = result.diagnostics.model_curve;
  const t0 = Date.parse(per[0].t_utc);
  const tN = Date.parse(per[per.length - 1].t_utc);
  const span = Math.max(1, tN - t0);
  const xOf = (iso) => mL + (Date.parse(iso) - t0) / span * (W - mL - mR);

  // panel 1: rotation vs time
  const p1y = 40, p1h = 220;
  const rotVals = per.map((p) => p.rotation_deg).concat(model.map((m) => m.model_deg));
  let rmin = Math.min(...rotVals), rmax = Math.max(...rotVals);
  if (rmax - rmin < 1) { rmax += 1; rmin -= 1; }
  const y1 = (v) => p1y + p1h - (v - rmin) / (rmax - rmin) * p1h;

  // panel 2: residuals
  const p2y = 320, p2h = 160;
  const res = per.map((p) => p.residual_deg);
  let amax = Math.max(0.001, ...res.map((r) => Math.abs(r))) * 1.2;
  const y2 = (v) => p2y + p2h / 2 - v / amax * (p2h / 2);

  // panel 3: covariance ellipse
  const p3y = 540, p3h = 150, cx = W / 2, cyE = p3y + p3h / 2;
  const el = result.fit.covariance_ellipse;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,monospace" font-size="12">`;
  s += `<rect width="${W}" height="${H}" fill="#0b0e14"/>`;
  const status = result.status;
  const statusColor = status === 'MEASURED' ? '#5bd18a' : '#e0a458';
  s += `<text x="${mL}" y="22" fill="#e6e6e6" font-size="14">${esc(title || 'mount rotation fit')}</text>`;
  s += `<text x="${W - mR}" y="22" fill="${statusColor}" font-size="14" text-anchor="end">${esc(status)}${result.failed_predicate ? ' · ' + esc(result.failed_predicate) : ''}</text>`;

  // ── panel 1
  s += `<rect x="${mL}" y="${p1y}" width="${W - mL - mR}" height="${p1h}" fill="none" stroke="#2a3040"/>`;
  s += `<text x="8" y="${p1y + p1h / 2}" fill="#9aa4b2" transform="rotate(-90 12 ${p1y + p1h / 2})" text-anchor="middle">rotation (deg)</text>`;
  // model line
  let path = '';
  model.forEach((m, i) => { path += `${i ? 'L' : 'M'}${xOf(m.t_utc).toFixed(1)},${y1(m.model_deg).toFixed(1)}`; });
  s += `<path d="${path}" fill="none" stroke="#4c8dff" stroke-width="1.5" opacity="0.9"/>`;
  // data points
  for (const p of per) s += `<circle cx="${xOf(p.t_utc).toFixed(1)}" cy="${y1(p.rotation_deg).toFixed(1)}" r="1.6" fill="#e0a458"/>`;
  s += `<text x="${W - mR}" y="${p1y + 14}" fill="#9aa4b2" text-anchor="end">● data  <tspan fill="#4c8dff">— model</tspan></text>`;

  // ── panel 2
  s += `<rect x="${mL}" y="${p2y}" width="${W - mL - mR}" height="${p2h}" fill="none" stroke="#2a3040"/>`;
  s += `<line x1="${mL}" y1="${y2(0).toFixed(1)}" x2="${W - mR}" y2="${y2(0).toFixed(1)}" stroke="#3a4050"/>`;
  const sig = result.diagnostics.residual_rms_deg;
  s += `<rect x="${mL}" y="${y2(sig).toFixed(1)}" width="${W - mL - mR}" height="${(y2(-sig) - y2(sig)).toFixed(1)}" fill="#4c8dff" opacity="0.08"/>`;
  for (const p of per) s += `<circle cx="${xOf(p.t_utc).toFixed(1)}" cy="${y2(p.residual_deg).toFixed(1)}" r="1.5" fill="#7aa2f7"/>`;
  s += `<text x="8" y="${p2y + p2h / 2}" fill="#9aa4b2" transform="rotate(-90 12 ${p2y + p2h / 2})" text-anchor="middle">residual (deg)</text>`;
  s += `<text x="${W - mR}" y="${p2y + 14}" fill="#9aa4b2" text-anchor="end">RMS ${sig.toFixed(3)}°</text>`;

  // ── panel 3 covariance ellipse
  s += `<text x="${mL}" y="${p3y - 6}" fill="#9aa4b2">(lat, lon) covariance — 1σ ellipse</text>`;
  if (el && isFinite(el.semi_major_deg)) {
    const scaleDeg = Math.max(el.semi_major_deg, 1e-6);
    const rpx = 60 / scaleDeg; // px per deg so major axis ≈ 60px
    const a = el.semi_major_deg * rpx, b = el.semi_minor_deg * rpx;
    s += `<g transform="translate(${cx},${cyE}) rotate(${(-el.orientation_deg).toFixed(2)})">`;
    s += `<ellipse rx="${a.toFixed(1)}" ry="${b.toFixed(1)}" fill="#4c8dff" opacity="0.18" stroke="#4c8dff"/></g>`;
    s += `<text x="${cx + 90}" y="${cyE - 8}" fill="#9aa4b2">σlat ${result.fit.sigma_lat_deg.toFixed(3)}°</text>`;
    s += `<text x="${cx + 90}" y="${cyE + 8}" fill="#9aa4b2">σlon ${result.fit.sigma_lon_deg.toFixed(3)}°</text>`;
    s += `<text x="${cx + 90}" y="${cyE + 24}" fill="#9aa4b2">ρ ${result.fit.correlation.toFixed(3)}</text>`;
  } else {
    s += `<text x="${cx}" y="${cyE}" fill="#e0a458" text-anchor="middle">covariance NOT MEASURED</text>`;
  }
  const f = result.fit;
  s += `<text x="${mL}" y="${H - 12}" fill="#e6e6e6">lat ${f.lat_deg.toFixed(3)}° ± ${f.sigma_lat_deg.toFixed(3)}   lon ${f.lon_deg.toFixed(3)}° ± ${f.sigma_lon_deg.toFixed(3)}   parity ${f.parity}   q0 ${f.q0_deg.toFixed(2)}°</text>`;
  s += `</svg>`;
  return s;
}
