// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — build a mesh capture_meta.json for a greenfield-solved frame from
//   banked artifacts (coarse linear WCS + banked detections + g15u catalog).
// ═══════════════════════════════════════════════════════════════════════════
// Anchors = BRIGHT g15u (mag<=magAnchor; sparse, ~86px spacing so matching is
// unambiguous even on confused fields) matched to the nearest banked bright
// DETECTION within tolPx through the coarse linear WCS. The detection supplies
// the measured (x,y). This seed is INDEPENDENT of the a.net grading oracle
// (built only from the greenfield receipt), so the oracle stays a clean grader.
// Center-biased BY DESIGN (the coarse linear WCS misses the distorted corners) —
// which is exactly the outward-crawl test the mesh is meant to pass.
//
//   node tools/mesh/make_capture.mjs --astrometry <a.json> --detections <d.json>
//     --dims <dims.json> --out <capture_meta.json> [--mag-anchor 9] [--tol 10]
//     [--fwhm auto] [--stars stars.arrow]
import fs from 'node:fs';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, projectStars } from '../psf/forced_detect.mjs';

const args = process.argv.slice(2);
const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D2R = Math.PI / 180;

const astro = JSON.parse(fs.readFileSync(A('--astrometry'), 'utf8'));
const wcsA = astro.wcs; // { crpix:[..], crval:[deg], cd:[[..]] }
const dimsRaw = JSON.parse(fs.readFileSync(A('--dims'), 'utf8'));
const W = dimsRaw.width, H = dimsRaw.height;
const detRaw = JSON.parse(fs.readFileSync(A('--detections'), 'utf8'));
const dets = (Array.isArray(detRaw) ? detRaw : (detRaw.detections || detRaw.dets || [])).filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
const MAG_ANCHOR = Number(A('--mag-anchor', 9));
const TOL = Number(A('--tol', 10));
const STARS = A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');

// mean fwhm from detections (moment_fwhm_px preferred)
const fwhms = dets.map((d) => d.moment_fwhm_px || d.fwhm).filter((v) => Number.isFinite(v) && v > 1 && v < 30).sort((a, b) => a - b);
const meanFwhm = A('--fwhm', 'auto') === 'auto' ? (fwhms.length ? +fwhms[fwhms.length >> 1].toFixed(2) : 7) : Number(A('--fwhm'));

// field cone from crval
const cd = wcsA.cd;
const scaleDeg = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]));
const coneR = Math.min(89, Math.atan(Math.hypot(W / 2, H / 2) * scaleDeg * D2R) / D2R + 2);
const bright = regionStars({ starsArrowPath: STARS, raDeg: wcsA.crval[0], decDeg: wcsA.crval[1], radiusDeg: coneR, magLimit: MAG_ANCHOR });
const proj = projectStars({ stars: bright.map((s) => ({ ...s, ra_deg: s.ra_deg, dec_deg: s.dec_deg })), wcs: wcsA, w: W, h: H, margin: -30 });

// grid the detections for fast nearest lookup
const CELL = 32; const dmap = new Map();
dets.forEach((d, i) => { const k = Math.floor(d.x / CELL) * 100003 + Math.floor(d.y / CELL); let a = dmap.get(k); if (!a) { a = []; dmap.set(k, a); } a.push(i); });
const nearestDet = (x, y) => { const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); let best = -1, bd = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = dmap.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const d = Math.hypot(dets[i].x - x, dets[i].y - y); if (d < bd) { bd = d; best = i; } } } return { idx: best, d: bd }; };

// greedy unique: brightest catalog first, claim nearest unused detection <= TOL
proj.sort((a, b) => a.mag - b.mag);
const usedDet = new Set(); const anchors = []; const seps = [];
for (const s of proj) {
  const nn = nearestDet(s.x, s.y);
  if (nn.idx < 0 || nn.d > TOL || usedDet.has(nn.idx)) continue;
  usedDet.add(nn.idx);
  const d = dets[nn.idx];
  anchors.push({ gaia_id: s.gaia_id, ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag, x: d.x, y: d.y });
  seps.push(nn.d);
}
seps.sort((a, b) => a - b);
const meta = {
  frame: A('--frame', 'frame'), source: 'tools/mesh/make_capture.mjs (greenfield coarse-linear WCS + banked detections + g15u bright anchors)',
  width: W, height: H,
  wcs: { CRVAL1: wcsA.crval[0], CRVAL2: wcsA.crval[1], CRPIX1: wcsA.crpix[0], CRPIX2: wcsA.crpix[1], CD1_1: cd[0][0], CD1_2: cd[0][1], CD2_1: cd[1][0], CD2_2: cd[1][1] },
  matched_stars: anchors,
  mean_fwhm_px: meanFwhm,
  anchor_build: { mag_anchor_limit: MAG_ANCHOR, tol_px: TOL, bright_catalog_in_cone: bright.length, bright_projected_in_frame: proj.length, anchors: anchors.length, median_match_sep_px: seps.length ? +seps[seps.length >> 1].toFixed(2) : null, note: 'center-biased by design (coarse linear WCS misses distorted corners)' },
};
fs.writeFileSync(A('--out'), JSON.stringify(meta, null, 2));
console.log(`anchors ${anchors.length} (bright cone ${bright.length}, in-frame ${proj.length}), median sep ${meta.anchor_build.median_match_sep_px}px, fwhm ${meanFwhm}, ${W}x${H} scale ${(scaleDeg * 3600).toFixed(2)}"/px`);
