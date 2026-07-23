// READ-ONLY odds-bar calibration probe over BANKED w5 fullstack receipts + oracle labels.
// No solver, no photo decode. Extracts per-cluster {odds (clamped), oddsV2 (signed)}, labels
// TRUTH/FALSE by footprint match to the frame's oracle-truth center, reports distributions,
// separation gaps, and runs calibrateOddsBar-equivalent on both metrics.
import fs from 'node:fs';
import path from 'node:path';

const ARMS = [
  'D:/AstroLogic/test_artifacts/w5_ab_2026-07-17/arm_fullstack_uw',
  'D:/AstroLogic/test_artifacts/w5_ab_2026-07-17/arm_fullstack_cocoon',
];
const LABELDIR = 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18';

function angSepDeg(ra1, dec1, ra2, dec2) {
  const d2r = Math.PI / 180;
  const a = Math.sin((dec2 - dec1) * d2r / 2) ** 2 +
    Math.cos(dec1 * d2r) * Math.cos(dec2 * d2r) * Math.sin((ra2 - ra1) * d2r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / d2r;
}
function q(arr, p) { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); }
function stats(arr) { if (!arr.length) return { n: 0 }; return { n: arr.length, min: Math.min(...arr), p10: q(arr, .1), p25: q(arr, .25), med: q(arr, .5), p75: q(arr, .75), p90: q(arr, .9), max: Math.max(...arr) }; }

// calibrateOddsBar port (from quad_gen.ts)
function calibrateOddsBar({ truthOdds, noiseOdds, safetyMultiplier, minFloor = 0 }) {
  const noise = noiseOdds.filter(Number.isFinite), truth = truthOdds.filter(Number.isFinite);
  const maxNoiseOdds = noise.length ? Math.max(...noise) : 0;
  const minTruthOdds = truth.length ? Math.min(...truth) : 0;
  const bar = Math.max(maxNoiseOdds * safetyMultiplier, minFloor);
  const fpSafe = noise.every(v => v < bar);
  const accepting = truth.length > 0 && truth.every(v => v >= bar);
  const separable = fpSafe && accepting && noise.length > 0 && truth.length > 0;
  return { bar, maxNoiseOdds, minTruthOdds, fpSafe, accepting, separable };
}

const clusterOdds = { truth: [], false: [] };      // clamped
const clusterOddsV2 = { truth: [], false: [] };     // signed
const frameTop = [];                                 // per-frame top-anchored cluster
let nFrames = 0, nClusters = 0, nNoLabel = 0;

for (const arm of ARMS) {
  if (!fs.existsSync(arm)) continue;
  for (const fn of fs.readdirSync(arm).filter(f => f.endsWith('.receipt.json'))) {
    const base = fn.replace('.receipt.json', '');
    const labelPath = path.join(LABELDIR, base + '.label.json');
    if (!fs.existsSync(labelPath)) { nNoLabel++; continue; }
    const label = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
    if (!label.solved) continue;
    const truthRaDeg = label.ra_hours * 15, truthDecDeg = label.dec_degrees;
    const truthScale = label.pixel_scale_arcsec;
    const fovDiag = Math.hypot(label.field_w_deg, label.field_h_deg);
    const tolDeg = 0.1 * (fovDiag / 2);
    const rec = JSON.parse(fs.readFileSync(path.join(arm, fn), 'utf8'));
    const clusters = rec.quad_gen?.clusters;
    if (!Array.isArray(clusters)) continue;
    nFrames++;
    let topAnchored = null;
    for (const c of clusters) {
      if (typeof c.odds !== 'number') continue;
      nClusters++;
      const sep = angSepDeg(c.foot_ra_deg, c.foot_dec_deg, truthRaDeg, truthDecDeg);
      const scaleRatio = c.scale / truthScale;
      const isTruth = sep <= tolDeg && scaleRatio >= 0.8 && scaleRatio <= 1.25;
      (isTruth ? clusterOdds.truth : clusterOdds.false).push(c.odds);
      if (typeof c.oddsV2 === 'number') (isTruth ? clusterOddsV2.truth : clusterOddsV2.false).push(c.oddsV2);
      if (!topAnchored || (c.anchored ?? 0) > (topAnchored.anchored ?? 0)) topAnchored = c;
    }
    if (topAnchored) {
      const sep = angSepDeg(topAnchored.foot_ra_deg, topAnchored.foot_dec_deg, truthRaDeg, truthDecDeg);
      const scaleRatio = topAnchored.scale / truthScale;
      const isTruth = sep <= tolDeg && scaleRatio >= 0.8 && scaleRatio <= 1.25;
      frameTop.push({ base, arm: path.basename(arm), odds: topAnchored.odds, oddsV2: topAnchored.oddsV2, anchored: topAnchored.anchored, sepDeg: +sep.toFixed(3), scaleRatio: +scaleRatio.toFixed(3), isTruth });
    }
  }
}

console.log('=== COVERAGE ===');
console.log(JSON.stringify({ nFrames, nClusters, nNoLabel, clusterTruth: clusterOdds.truth.length, clusterFalse: clusterOdds.false.length }));

console.log('\n=== PER-CLUSTER CLAMPED odds ===');
console.log('TRUTH', JSON.stringify(stats(clusterOdds.truth)));
console.log('FALSE', JSON.stringify(stats(clusterOdds.false)));

console.log('\n=== PER-CLUSTER SIGNED oddsV2 ===');
console.log('TRUTH', JSON.stringify(stats(clusterOddsV2.truth)));
console.log('FALSE', JSON.stringify(stats(clusterOddsV2.false)));
const tMinV2 = clusterOddsV2.truth.length ? Math.min(...clusterOddsV2.truth) : null;
const fMaxV2 = clusterOddsV2.false.length ? Math.max(...clusterOddsV2.false) : null;
console.log('SIGNED gap: minTruth', tMinV2, '- maxFalse', fMaxV2, '=', tMinV2 != null && fMaxV2 != null ? (tMinV2 - fMaxV2).toFixed(2) : 'n/a');
const tMinO = clusterOdds.truth.length ? Math.min(...clusterOdds.truth) : null;
const fMaxO = clusterOdds.false.length ? Math.max(...clusterOdds.false) : null;
console.log('CLAMPED gap: minTruth', tMinO, '- maxFalse', fMaxO, '=', tMinO != null && fMaxO != null ? (tMinO - fMaxO).toFixed(2) : 'n/a');

console.log('\n=== FRAME-LEVEL top-anchored cluster (label + odds) ===');
for (const r of frameTop.sort((a, b) => (a.isTruth === b.isTruth ? 0 : a.isTruth ? -1 : 1) || b.odds - a.odds)) console.log(JSON.stringify(r));

const frTruthOdds = frameTop.filter(r => r.isTruth).map(r => r.odds);
const frFalseOdds = frameTop.filter(r => !r.isTruth).map(r => r.odds);
const frTruthV2 = frameTop.filter(r => r.isTruth).map(r => r.oddsV2).filter(Number.isFinite);
const frFalseV2 = frameTop.filter(r => !r.isTruth).map(r => r.oddsV2).filter(Number.isFinite);

console.log('\n=== calibrateOddsBar — PER-CLUSTER CLAMPED (safety 2.0) ===');
console.log(JSON.stringify(calibrateOddsBar({ truthOdds: clusterOdds.truth, noiseOdds: clusterOdds.false, safetyMultiplier: 2.0 })));
console.log('=== calibrateOddsBar — PER-CLUSTER SIGNED oddsV2 (safety 2.0, minFloor 0) ===');
console.log(JSON.stringify(calibrateOddsBar({ truthOdds: clusterOddsV2.truth, noiseOdds: clusterOddsV2.false, safetyMultiplier: 2.0, minFloor: 0 })));
console.log('=== calibrateOddsBar — FRAME-TOP CLAMPED (safety 2.0) ===');
console.log(JSON.stringify(calibrateOddsBar({ truthOdds: frTruthOdds, noiseOdds: frFalseOdds, safetyMultiplier: 2.0 })));
console.log('=== calibrateOddsBar — FRAME-TOP SIGNED (safety 2.0, minFloor 0) ===');
console.log(JSON.stringify(calibrateOddsBar({ truthOdds: frTruthV2, noiseOdds: frFalseV2, safetyMultiplier: 2.0, minFloor: 0 })));

// candidate bars for signed metric
console.log('\n=== CANDIDATE BARS (signed oddsV2, per-cluster) ===');
for (const m of [1.0, 2.0]) {
  const r = calibrateOddsBar({ truthOdds: clusterOddsV2.truth, noiseOdds: clusterOddsV2.false, safetyMultiplier: m, minFloor: 0 });
  console.log(`mult=${m} bar=${r.bar.toFixed(2)} fpSafe=${r.fpSafe} accepting=${r.accepting} separable=${r.separable}`);
}
