// READ-ONLY early-exit MEDIAN desk study over BANKED w5 fullstack receipts + oracle labels.
// No solver, no photo decode. For each frame with quad_gen.clusters[], reconstruct the judge
// ORDER (descending votes — the order generateAndJudge judges, quad_gen.ts:1554) and compute
// WHERE in that order the signed-odds (oddsV2, V3 flag off) early-exit fires at each candidate
// bar (A=398.45, B=205, C=1080). Reports clusters-judged-with-exit vs actual + ratio dist,
// and the CRITICAL wrong-region correctness check on truth-labeled frames.
import fs from 'node:fs';
import path from 'node:path';

const ARMS = [
  { name: 'cocoon', dir: 'D:/AstroLogic/test_artifacts/w5_ab_2026-07-17/arm_fullstack_cocoon' },
  { name: 'uw', dir: 'D:/AstroLogic/test_artifacts/w5_ab_2026-07-17/arm_fullstack_uw' },
];
const LABELDIR = 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18';
const OUTDIR = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/test_results/earlyexit_desk_2026-07-18';
const BARS = { A: 398.45, B: 205, C: 1080 };

function angSepDeg(ra1, dec1, ra2, dec2) {
  const d2r = Math.PI / 180;
  const a = Math.sin((dec2 - dec1) * d2r / 2) ** 2 +
    Math.cos(dec1 * d2r) * Math.cos(dec2 * d2r) * Math.sin((ra2 - ra1) * d2r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / d2r;
}
function q(arr, p) { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); }
function dist(arr) { if (!arr.length) return { n: 0 }; return { n: arr.length, min: +Math.min(...arr).toFixed(4), median: +q(arr, .5).toFixed(4), p75: +q(arr, .75).toFixed(4), max: +Math.max(...arr).toFixed(4) }; }

// Reconstruct judge order: descending votes. Receipt clusters are stored anchored-desc
// (quad_gen.ts:1614 for non-ACCEPT_ODDS); a stable sort by votes-desc preserves anchored-desc
// among vote-ties. The TRUE clusterByFootprint tie order (insertion order) is NOT recoverable
// from the receipt — a proxy, but vote-ties among low-vote clusters almost never front-run the
// high-vote true pose that clears a high bar. CAVEAT noted in report.
function judgeOrder(clusters) { return clusters.slice().sort((a, b) => b.votes - a.votes); }

const frames = [];
let nNoLabel = 0;

for (const arm of ARMS) {
  if (!fs.existsSync(arm.dir)) continue;
  for (const fn of fs.readdirSync(arm.dir).filter(f => f.endsWith('.receipt.json'))) {
    const base = fn.replace('.receipt.json', '');
    const rec = JSON.parse(fs.readFileSync(path.join(arm.dir, fn), 'utf8'));
    const clusters = rec.quad_gen?.clusters;
    if (!Array.isArray(clusters) || clusters.length === 0) continue;
    const order = judgeOrder(clusters);
    const nActual = clusters.length;                       // clusters judged in the banked run
    const truncated = !!rec.quad_gen?.budget?.truncated;

    // truth label (may be absent — uncovered/noise frames)
    const labelPath = path.join(LABELDIR, base + '.label.json');
    let label = null, truth = null;
    if (fs.existsSync(labelPath)) {
      label = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
      if (label.solved) {
        const fovDiag = Math.hypot(label.field_w_deg, label.field_h_deg);
        truth = { raDeg: label.ra_hours * 15, decDeg: label.dec_degrees, scale: label.pixel_scale_arcsec, tolDeg: 0.1 * (fovDiag / 2) };
      }
    } else nNoLabel++;

    const isTruthCluster = (c) => {
      if (!truth) return null;
      const sep = angSepDeg(c.foot_ra_deg, c.foot_dec_deg, truth.raDeg, truth.decDeg);
      const sr = c.scale / truth.scale;
      return sep <= truth.tolDeg && sr >= 0.8 && sr <= 1.25;
    };
    // does a true cluster exist anywhere in the judged set, and does it clear each bar?
    const trueClusters = truth ? order.filter(isTruthCluster) : [];

    // stage timing: solve fraction of total (judge rung ~= solve)
    const st = rec.stage_timings?.stages || {};
    const total = rec.stage_timings?.total_ms ?? null;
    const solveMs = st.solve ?? null;
    const solveFrac = (total && solveMs != null) ? solveMs / total : null;

    const perBar = {};
    for (const [k, bar] of Object.entries(BARS)) {
      // first-past-the-post: first cluster (desc-votes) with oddsV2 >= bar
      let exitIdx = -1;
      for (let i = 0; i < order.length; i++) {
        const o2 = order[i].oddsV2;
        if (typeof o2 === 'number' && o2 >= bar) { exitIdx = i; break; }
      }
      const fired = exitIdx >= 0;
      const nExit = fired ? exitIdx + 1 : nActual;           // clusters judged w/ early-exit
      const exitCluster = fired ? order[exitIdx] : null;
      const exitIsTruth = fired ? isTruthCluster(exitCluster) : null;
      // would the frame still solve via early-exit? true cluster present AND clears the bar
      const trueClears = truth ? trueClusters.some(c => typeof c.oddsV2 === 'number' && c.oddsV2 >= bar) : null;
      perBar[k] = {
        bar, fired, exitIdx: fired ? exitIdx : null, nExit, nActual,
        ratio: +(nExit / nActual).toFixed(4),
        exitOddsV2: fired ? +exitCluster.oddsV2.toFixed(2) : null,
        exitVotes: fired ? exitCluster.votes : null,
        exitIsTruth, trueClears,
        // WRONG-REGION: exit fired on a cluster that is NOT the true pose
        wrongRegion: fired && truth ? exitIsTruth === false : false,
      };
    }

    frames.push({
      base, arm: arm.name, nActual, truncated,
      hasTruth: !!truth, nTrueClusters: trueClusters.length,
      solveMs, total, solveFrac: solveFrac != null ? +solveFrac.toFixed(4) : null,
      perBar,
    });
  }
}

// ── aggregate ──
function ratiosFor(barKey, filter = () => true) { return frames.filter(filter).map(f => f.perBar[barKey].ratio); }
function agg(barKey) {
  const all = ratiosFor(barKey);
  const cocoon = ratiosFor(barKey, f => f.arm === 'cocoon');
  const uw = ratiosFor(barKey, f => f.arm === 'uw');
  const firedFrames = frames.filter(f => f.perBar[barKey].fired);
  const firedRatios = firedFrames.map(f => f.perBar[barKey].ratio);
  // correctness on truth-labeled frames
  const truthFrames = frames.filter(f => f.hasTruth);
  const wrongRegionFrames = truthFrames.filter(f => f.perBar[barKey].wrongRegion).map(f => f.base + '/' + f.arm);
  const truthFiredCorrect = truthFrames.filter(f => f.perBar[barKey].fired && f.perBar[barKey].exitIsTruth === true).map(f => f.base);
  const truthSolveViaExit = truthFrames.filter(f => f.perBar[barKey].trueClears).length;
  return {
    bar: BARS[barKey],
    pooled: dist(all),
    cocoon: dist(cocoon),
    uw: dist(uw),
    firedFrames: firedFrames.length, totalFrames: frames.length,
    firedOnly_ratio: dist(firedRatios),
    correctness: {
      truthFrames: truthFrames.length,
      wrongRegionCount: wrongRegionFrames.length,
      wrongRegionFrames,
      exitFiredOnTruthCorrect: truthFiredCorrect.length,
      truthWouldSolveViaExit: truthSolveViaExit,
    },
  };
}

const solveFracs = frames.map(f => f.solveFrac).filter(x => x != null);
const out = {
  meta: {
    generated: new Date().toISOString(),
    note: 'READ-ONLY banked-data desk study. Judge order = descending votes; early-exit gates on signed oddsV2 (V3 flag off), fires at FIRST cluster with oddsV2>=bar (inclusive). nActual=clusters judged in banked run. Ratio = nExit/nActual (1.0 = never fires, no savings).',
    bars: BARS,
    nFrames: frames.length, nNoLabel,
    arms: { cocoon: frames.filter(f => f.arm === 'cocoon').length, uw: frames.filter(f => f.arm === 'uw').length },
    truthFrames: frames.filter(f => f.hasTruth).length,
    truncatedFrames: frames.filter(f => f.truncated).length,
    solveFrac_of_total: dist(solveFracs),
  },
  perBar: { A: agg('A'), B: agg('B'), C: agg('C') },
  frames,
};

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, 'earlyexit_desk.json'), JSON.stringify(out, null, 2));

// ── console summary ──
console.log('=== COVERAGE ===');
console.log(JSON.stringify(out.meta, null, 1));
for (const k of ['A', 'B', 'C']) {
  const a = out.perBar[k];
  console.log(`\n=== BAR ${k} (${a.bar}) ===`);
  console.log(`pooled ratio: ${JSON.stringify(a.pooled)}`);
  console.log(`  cocoon:     ${JSON.stringify(a.cocoon)}`);
  console.log(`  uw:         ${JSON.stringify(a.uw)}`);
  console.log(`fired: ${a.firedFrames}/${a.totalFrames} frames; fired-only ratio: ${JSON.stringify(a.firedOnly_ratio)}`);
  console.log(`CORRECTNESS: truthFrames=${a.correctness.truthFrames} wrongRegion=${a.correctness.wrongRegionCount} ${a.correctness.wrongRegionCount ? '*** ' + JSON.stringify(a.correctness.wrongRegionFrames) : '(none)'} | exitFiredOnTruth=${a.correctness.exitFiredOnTruthCorrect} | trueWouldSolveViaExit=${a.correctness.truthWouldSolveViaExit}`);
}
console.log('\nJSON:', path.join(OUTDIR, 'earlyexit_desk.json'));
