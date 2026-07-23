// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — confusion/density metric for a candidate frame (gate-③ pre-check)
// ═══════════════════════════════════════════════════════════════════════════
// The graduation campaign (ledger 512/513) routes frames by CATALOG STARS/BEAM:
// sparse → mesh-safe; dense/galactic → confusion-limited (beach 64% false even
// inner). This computes that metric so a gate-③ candidate is ACCEPTED or
// REJECTED on measurement, not vibe. Banked-data-first: needs only a coarse WCS
// (json {crpix,crval,cd} or {wcs:{...}} / {CRVAL1..}), dims, FWHM, g15u catalog.
//
//   node tools/mesh/density_metric.mjs --wcs <wcs.json> --w 5202 --h 3465 \
//     --fwhm 7.3 --frame IMG_1757 [--mag 15] [--stars stars.arrow]
import fs from 'node:fs';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward } from '../psf/forced_detect.mjs';

const A = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
const W = +A('--w'), H = +A('--h'), FWHM = +A('--fwhm', '7.3'), MAG = +A('--mag', '15');
const D2R = Math.PI / 180;

const raw = JSON.parse(fs.readFileSync(A('--wcs'), 'utf8'));
const wcs = raw.wcs || raw;
const crval = wcs.crval || [wcs.CRVAL1, wcs.CRVAL2];
const crpix = wcs.crpix || [wcs.CRPIX1, wcs.CRPIX2];
const cd = wcs.cd || [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
const scaleDeg = Math.sqrt(Math.abs(det));
const hd = Math.hypot((W - 1) / 2, (H - 1) / 2);
const coneR = Math.min(89, Math.atan(hd * scaleDeg * D2R) / D2R + 2);

const g = regionStars({ starsArrowPath: STARS, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit: MAG });
const inFrameAll = [];
for (const s of g) {
  const p = tanForward(s.ra_deg, s.dec_deg, crval[0], crval[1]); if (!p) continue;
  const x = crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det;
  const y = crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det;
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  inFrameAll.push({ x, y, mag: s.mag });
}
const frameArea = W * H;
const beamArea = Math.PI * (FWHM / 2) ** 2;
const apert = 2 * FWHM;

function metricsFor(inFrame) {
  const N = inFrame.length;
  const starsPerBeam = N * beamArea / frameArea;
  const CELL = 64, map = new Map();
  inFrame.forEach((s, i) => { const k = Math.floor(s.x / CELL) * 100003 + Math.floor(s.y / CELL); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); });
  const nn = [];
  for (let i = 0; i < N; i++) {
    const s = inFrame[i]; const gx = Math.floor(s.x / CELL), gy = Math.floor(s.y / CELL); let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const j of a) { if (j === i) continue; const d = Math.hypot(inFrame[j].x - s.x, inFrame[j].y - s.y); if (d < best) best = d; } }
    if (Number.isFinite(best)) nn.push(best);
  }
  nn.sort((a, b) => a - b);
  return {
    N, stars_per_beam: +starsPerBeam.toFixed(4),
    median_nn_sep_px: nn.length ? +nn[nn.length >> 1].toFixed(1) : null,
    p10_nn_sep_px: nn.length ? +nn[Math.floor(nn.length * 0.1)].toFixed(1) : null,
    frac_nn_within_aperture: nn.length ? +(nn.filter((d) => d < apert).length / nn.length).toFixed(3) : null,
    verdict: starsPerBeam > 0.5 ? 'CONFUSION-LIMITED' : starsPerBeam > 0.1 ? 'MODERATE' : 'SPARSE',
  };
}

const sweep = A('--mag-sweep', null);
const magList = sweep ? sweep.split(',').map(Number) : [MAG];
const rows = magList.map((m) => ({ mag_limit: m, ...metricsFor(inFrameAll.filter((s) => s.mag <= m)) }));

console.log(JSON.stringify({
  frame: A('--frame', 'frame'), W, H, fwhm_px: FWHM,
  scale_arcsec_px: +(scaleDeg * 3600).toFixed(2), cone_radius_deg: +coneR.toFixed(1),
  beam_area_px2: +beamArea.toFixed(1), aperture_px_2fwhm: +apert.toFixed(1),
  loaded_to_mag: MAG, catalog_loaded_in_frame: inFrameAll.length,
  by_mag_limit: rows,
}, null, 2));
